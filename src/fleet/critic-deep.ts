import { z } from "zod";
import type { LLMClient, Message } from "../providers/types.js";
import type { FleetManifest } from "./manifest.js";
import { type Outline, runExpandStage } from "./decomposer-deep.js";
// bober: read budget constants from the dependency-free leaf, NOT from ./decomposer-deep.js.
// These are used at module-evaluation time (DEEP_CRITIQUE_MAX_TOTAL_CALLS below); importing them
// from the leaf avoids the circular-import TDZ that killed the CLI (inc-20260620-cli-tdz-crash).
import {
  DEEP_MAX_TOTAL_CALLS,
  DEEP_EXPAND_MAX_RETRIES,
} from "./decomposer-deep-constants.js";

// ── Constants ────────────────────────────────────────────────────────

export const CRITIQUE_MAX_ROUNDS = 1;
export const CRITIQUE_PARSE_MAX_RETRIES = 1;
// bober: fixed budget = DEEP_MAX_TOTAL_CALLS + CRITIQUE_MAX_ROUNDS*((1+CRITIQUE_PARSE_MAX_RETRIES)+(1+DEEP_EXPAND_MAX_RETRIES)); raise CRITIQUE_MAX_ROUNDS if 1 round proves too few
export const DEEP_CRITIQUE_MAX_TOTAL_CALLS =
  DEEP_MAX_TOTAL_CALLS +
  CRITIQUE_MAX_ROUNDS * ((1 + CRITIQUE_PARSE_MAX_RETRIES) + (1 + DEEP_EXPAND_MAX_RETRIES));

// ── Prompts ──────────────────────────────────────────────────────────

export const CRITIQUE_SYSTEM_PROMPT = `You are an independent tech-lead reviewer evaluating a proposed fleet manifest for adequacy.

A fleet manifest is a list of sub-project children, each with a folder name and a build task.
You did NOT author this manifest — it was produced by another agent. Review it as a third-party critic.

Output ONLY a single JSON object (no prose, no markdown fences, no tool calls) with EXACTLY this shape:
{
  "verdict": "approve" | "reject",
  "feedback": "<concise free-text feedback; empty string if approving>"
}

Rules:
- "verdict" must be exactly "approve" or "reject" (no other values).
- "feedback" must be a string (empty string is fine for an approval).
- Approve if: the manifest has enough children to plausibly cover the outlined areas, each child has a clear folder and self-contained task, and there are no obvious duplicates or missing critical areas.
- Reject if: the manifest is under-expanded (too few children for the number of outlined areas), children are vague or not self-contained, or critical areas from the outline are missing.
- Output the JSON object and nothing else.`;

export const CRITIQUE_COERCION_INSTRUCTION = `Your previous response was not a valid critique verdict.
Output ONLY a single JSON object (no prose, no markdown fences, no tool calls) with EXACTLY this shape:
{
  "verdict": "approve" | "reject",
  "feedback": "<concise free-text feedback; empty string if approving>"
}

Rules:
- "verdict" must be exactly "approve" or "reject".
- "feedback" must be a string.
- Output the JSON object and nothing else.`;

// ── Schema + types ───────────────────────────────────────────────────

export const CritiqueVerdictSchema = z.object({
  verdict: z.enum(["approve", "reject"]),
  feedback: z.string(),
});

export type CritiqueVerdict = z.infer<typeof CritiqueVerdictSchema>;

export type ValidateVerdictResult =
  | { ok: true; verdict: CritiqueVerdict }
  | { ok: false; error: string };

// ── validateVerdict (NEVER throws) ───────────────────────────────────

export function validateVerdict(rawText: string): ValidateVerdictResult {
  let parsed: unknown;

  // Try direct parse first
  try {
    parsed = JSON.parse(rawText.trim());
  } catch {
    // Try extracting JSON from markdown code fences
    const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/.exec(rawText);
    if (fenceMatch) {
      try {
        parsed = JSON.parse(fenceMatch[1].trim());
      } catch {
        // Fall through
      }
    }

    // Try finding the first { ... } block
    if (!parsed) {
      const braceStart = rawText.indexOf("{");
      const braceEnd = rawText.lastIndexOf("}");
      if (braceStart !== -1 && braceEnd > braceStart) {
        try {
          parsed = JSON.parse(rawText.slice(braceStart, braceEnd + 1));
        } catch {
          return {
            ok: false,
            error: `No valid JSON object found in response. Raw: ${rawText.slice(0, 200)}`,
          };
        }
      } else {
        return {
          ok: false,
          error: `No JSON object found in response. Raw: ${rawText.slice(0, 200)}`,
        };
      }
    }
  }

  const result = CritiqueVerdictSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    return { ok: false, error: issues };
  }

  return { ok: true, verdict: result.data };
}

// ── Internal: one CRITIC call ────────────────────────────────────────

export async function callCritic(input: {
  client: LLMClient;
  model: string;
  goal: string;
  outline: Outline;
  candidate: FleetManifest;
  priorText?: string;
  formattedError?: string;
}): Promise<string> {
  const { client, model, goal, outline, candidate, priorText, formattedError } = input;

  // Fresh message array — NEVER extends the EXPAND conversation (LOCK1)
  const firstUserContent =
    `Review this proposed fleet manifest as a third-party critic.\n\n` +
    `Goal: ${goal}\n\n` +
    `Outline:\n${JSON.stringify(outline)}\n\n` +
    `Proposed manifest:\n${JSON.stringify(candidate)}`;

  let messages: Message[];

  if (priorText !== undefined && formattedError !== undefined) {
    // Coercion retry: 3-message shape [user, assistant, user]
    messages = [
      { role: "user", content: firstUserContent },
      { role: "assistant", content: priorText },
      {
        role: "user",
        content: `${CRITIQUE_COERCION_INSTRUCTION}\n\nPrevious validation error:\n${formattedError}`,
      },
    ];
  } else {
    // First turn: single user message
    messages = [{ role: "user", content: firstUserContent }];
  }

  const response = await client.chat({
    model,
    system: CRITIQUE_SYSTEM_PROMPT,
    messages,
    jsonObjectMode: true,
  });

  return response.text;
}

// ── getCriticVerdict (fail-open on parse exhaustion) ─────────────────

export async function getCriticVerdict(input: {
  client: LLMClient;
  model: string;
  goal: string;
  outline: Outline;
  candidate: FleetManifest;
}): Promise<CritiqueVerdict> {
  const { client, model, goal, outline, candidate } = input;
  const maxAttempts = 1 + CRITIQUE_PARSE_MAX_RETRIES;

  let lastError = "Unknown error";
  let priorText: string | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const rawText = await callCritic({
      client,
      model,
      goal,
      outline,
      candidate,
      priorText: attempt > 0 ? priorText : undefined,
      formattedError: attempt > 0 ? lastError : undefined,
    });

    const validated = validateVerdict(rawText);
    if (validated.ok) {
      return validated.verdict;
    }

    lastError = validated.error;
    priorText = rawText;
  }

  // Fail-open: degrade to Phase-3 rather than blocking (ADR-3)
  // bober: approve on parse exhaustion; upgrade path — add structured schema if model drift worsens
  return { verdict: "approve", feedback: "" };
}

// ── runCritiqueLoop (never throws, accept-best on exhaustion) ─────────

export async function runCritiqueLoop(input: {
  client: LLMClient;
  model: string;
  goal: string;
  outline: Outline;
  baseline: FleetManifest;
  expandMaxRetries: number;
}): Promise<FleetManifest> {
  const { client, model, goal, outline, baseline, expandMaxRetries } = input;

  // Track all structurally-valid candidates for accept-best on exhaustion
  const candidates: FleetManifest[] = [baseline];

  let current = baseline;
  // totalCriticRounds = CRITIQUE_MAX_ROUNDS re-expands means CRITIQUE_MAX_ROUNDS+1 critic calls
  let reExpandsLeft = CRITIQUE_MAX_ROUNDS;
  let continueLoop = true;

  while (continueLoop) {
    let verdict: CritiqueVerdict;
    try {
      verdict = await getCriticVerdict({ client, model, goal, outline, candidate: current });
    } catch {
      // Transport failure — accept best, never throw (ADR-1)
      break;
    }

    if (verdict.verdict === "approve") {
      return current;
    }

    // Reject: re-expand with critique feedback if rounds remain
    if (reExpandsLeft <= 0) {
      // Round budget exhausted after critiquing re-expanded manifest — accept best
      break;
    }

    reExpandsLeft -= 1;
    try {
      const reExpanded = await runExpandStage({
        client,
        model,
        outline,
        goal,
        maxRetries: expandMaxRetries,
        critiqueFeedback: verdict.feedback,
      });
      candidates.push(reExpanded);
      current = reExpanded;
    } catch {
      // Expand failure — accept best so far, never throw
      break;
    }
  }

  // Accept best: tiebreak by most children, then first-seen (baseline)
  return candidates.reduce((best, c) =>
    c.children.length > best.children.length ? c : best,
  );
}
