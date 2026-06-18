/** GroundingCritic — fail-closed faithfulness+completeness judge for medical synthesis output. */
import { z } from "zod";
import type { LLMClient, Message } from "../../providers/types.js";
import type { Passage } from "./medline-source.js";

// ── Constants ────────────────────────────────────────────────────────

export const GROUNDING_PARSE_MAX_RETRIES = 1;
export const GROUNDING_MAX_LLM_CALLS = 1 + GROUNDING_PARSE_MAX_RETRIES;

// ── Prompts ──────────────────────────────────────────────────────────

const GROUNDING_COERCION_INSTRUCTION = `Your previous response was not a valid grounding verdict.
Output ONLY a single JSON object (no prose, no markdown fences, no tool calls) with EXACTLY this shape:
{
  "verdict": "approve" | "reject",
  "feedback": "<concise feedback; empty string if approving>"
}

Rules:
- "verdict" must be exactly "approve" or "reject".
- "feedback" must be a string.
- Output the JSON object and nothing else.`;

// ── Schema + types ───────────────────────────────────────────────────

export const GroundingVerdictSchema = z.object({
  verdict: z.enum(["approve", "reject"]),
  feedback: z.string(),
});

export type GroundingVerdict = z.infer<typeof GroundingVerdictSchema>;

export type ValidateGroundingResult =
  | { ok: true; verdict: GroundingVerdict }
  | { ok: false; error: string };

// ── validateGroundingVerdict (NEVER throws) ──────────────────────────

export function validateGroundingVerdict(rawText: string): ValidateGroundingResult {
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

  const result = GroundingVerdictSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    return { ok: false, error: issues };
  }

  return { ok: true, verdict: result.data };
}

// ── Helpers ──────────────────────────────────────────────────────────

function formatPassageBlock(passages: Passage[]): string {
  return passages
    .map((p, i) => `[${i + 1}] ${p.title}\n${p.text}\nSource: ${p.url}`)
    .join("\n\n");
}

// ── buildGroundingSystemPrompt ────────────────────────────────────────

export function buildGroundingSystemPrompt(
  question: string,
  answerBody: string,
  passages: Passage[],
): string {
  const passageBlock = formatPassageBlock(passages);

  return (
    `You are an independent reviewer. The answer below was produced by another assistant ` +
    `from ONLY the retrieved passages listed here. ` +
    `Approve ONLY if EVERY claim in the answer is directly supported by a cited passage ` +
    `AND the answer addresses the core of the question. ` +
    `Reject if any claim is unsupported (faithfulness) OR the answer omits the central part ` +
    `of the question (completeness). ` +
    `Output ONLY {"verdict":"approve"|"reject","feedback":"..."}\n\n` +
    `Question: ${question}\n\n` +
    `Answer to review:\n${answerBody}\n\n` +
    `Retrieved passages:\n${passageBlock}`
  );
}

// ── Internal: one grounding-critic call ─────────────────────────────

async function callGroundingCritic(input: {
  llm: LLMClient;
  model: string;
  question: string;
  answerBody: string;
  passages: Passage[];
  priorText?: string;
  formattedError?: string;
}): Promise<string> {
  const { llm, model, question, answerBody, passages, priorText, formattedError } = input;

  // Fresh message array — NEVER extends the prior synthesis conversation (LOCK1)
  const firstUserContent =
    `Review this answer as an independent reviewer.\n\n` +
    `Question: ${question}\n\n` +
    `Answer to review:\n${answerBody}\n\n` +
    `Cited passages:\n${formatPassageBlock(passages)}`;

  let messages: Message[];

  if (priorText !== undefined && formattedError !== undefined) {
    // Coercion retry: 3-message shape [user, assistant, user]
    messages = [
      { role: "user", content: firstUserContent },
      { role: "assistant", content: priorText },
      {
        role: "user",
        content: `${GROUNDING_COERCION_INSTRUCTION}\n\nPrevious validation error:\n${formattedError}`,
      },
    ];
  } else {
    // First turn: single user message
    messages = [{ role: "user", content: firstUserContent }];
  }

  const response = await llm.chat({
    model,
    system: buildGroundingSystemPrompt(question, answerBody, passages),
    messages,
    jsonObjectMode: true,
  });

  return response.text;
}

// ── getGroundingVerdict (FAIL-CLOSED on parse exhaustion) ────────────

export async function getGroundingVerdict(input: {
  llm: LLMClient;
  model: string;
  question: string;
  answerBody: string;
  passages: Passage[];
}): Promise<GroundingVerdict> {
  const { llm, model, question, answerBody, passages } = input;
  const maxAttempts = GROUNDING_MAX_LLM_CALLS;

  let lastError = "Unknown error";
  let priorText: string | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const rawText = await callGroundingCritic({
      llm,
      model,
      question,
      answerBody,
      passages,
      priorText: attempt > 0 ? priorText : undefined,
      formattedError: attempt > 0 ? lastError : undefined,
    });

    const validated = validateGroundingVerdict(rawText);
    if (validated.ok) {
      return validated.verdict;
    }

    lastError = validated.error;
    priorText = rawText;
  }

  // FAIL-CLOSED inversion of critic-deep.ts:199-201 (which returns approve on exhaustion).
  // bober: reject on parse exhaustion; this is intentional for medical safety — Sprint 2
  //        maps a reject to re-synthesis / abstain rather than letting an unverified answer through.
  return { verdict: "reject", feedback: "<unparseable critic output>" };
}
