/**
 * Four lens adapters for the recommendation judge panel.
 *
 * PURE orchestration over injected fns — NO fs / NO network / NO real provider / NO FactStore.
 *
 * Each lens calls its injected LLMClient and validates the response with a NEVER-THROWING
 * parser that mirrors validateGroundingVerdict (src/medical/retrieval/grounding-critic.ts:40-88).
 *
 * On parse exhaustion a lens verdict is REJECT (fail-closed), inverting the fleet fail-open
 * tail at src/fleet/critic-deep.ts:206 — see getGroundingVerdict at grounding-critic.ts:203-206.
 */
import { z } from "zod";
import type { LLMClient, Message } from "../../providers/types.js";
import { LENS_MAX_LLM_CALLS } from "./types.js";
import type { LensVerdict } from "./types.js";

// ── Constants ─────────────────────────────────────────────────────────

/**
 * Coercion instruction sent when the model's first response is not valid JSON.
 * Mirrors GROUNDING_COERCION_INSTRUCTION (grounding-critic.ts:13-23).
 */
const LENS_COERCION_INSTRUCTION = `Your previous response was not a valid lens verdict.
Output ONLY a single JSON object (no prose, no markdown fences, no tool calls) with EXACTLY this shape:
{
  "verdict": "approve" | "reject",
  "feedback": "<concise feedback; empty string if approving>"
}

For contraindication-checker, also include:
{
  "veto": true | false
}

Rules:
- "verdict" must be exactly "approve" or "reject".
- "feedback" must be a string.
- "veto" (contraindication-checker only) must be a boolean.
- Output the JSON object and nothing else.`;

// ── Zod schema ────────────────────────────────────────────────────────

/**
 * Schema for the raw lens verdict.
 * Mirrors GroundingVerdictSchema (grounding-critic.ts:27-30) with optional veto field.
 * Only the contraindication-checker schema actually validates veto:boolean.
 */
export const LensVerdictSchema = z.object({
  verdict: z.enum(["approve", "reject"]),
  feedback: z.string(),
  veto: z.boolean().optional(),
});

export type ValidateLensResult =
  | { ok: true; verdict: LensVerdict }
  | { ok: false; error: string };

// ── validateLensVerdict (NEVER throws) ───────────────────────────────

/**
 * Four-tier JSON extraction strategy — direct parse → fenced JSON → first { } block → fail.
 * Mirrors validateGroundingVerdict (src/medical/retrieval/grounding-critic.ts:40-88) exactly.
 * NEVER throws.
 */
export function validateLensVerdict(rawText: string): ValidateLensResult {
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

  const result = LensVerdictSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    return { ok: false, error: issues };
  }

  return { ok: true, verdict: result.data };
}

// ── System prompts (one per lens) ────────────────────────────────────

/** Evidence-grader system prompt — assesses whether the recommendation is evidence-based. */
export function buildEvidenceGraderSystemPrompt(question: string, context: string): string {
  return (
    `You are an independent evidence-grader reviewer. Given a patient question and a proposed ` +
    `recommendation, assess whether the recommendation is backed by strong clinical evidence.\n\n` +
    `Approve if: the recommendation is consistent with published clinical guidelines, ` +
    `evidence-based practice, or peer-reviewed research for the presented condition.\n` +
    `Reject if: the recommendation is speculative, unsupported by evidence, or makes ` +
    `unsubstantiated claims.\n\n` +
    `Output ONLY {"verdict":"approve"|"reject","feedback":"..."}\n\n` +
    `Patient question: ${question}\n\nProfile context: ${context}`
  );
}

/** Conservative-clinician system prompt — applies a cautious clinical lens. */
export function buildConservativeCliniciansSystemPrompt(question: string, context: string): string {
  return (
    `You are a conservative clinical reviewer. Given a patient question and a proposed ` +
    `recommendation, assess whether it prioritises patient safety.\n\n` +
    `Approve if: the recommendation is cautious, conservative, and errs on the side of ` +
    `safety; escalates to a healthcare provider when appropriate.\n` +
    `Reject if: the recommendation is aggressive, potentially harmful, or does not ` +
    `recommend professional consultation when the situation warrants it.\n\n` +
    `Output ONLY {"verdict":"approve"|"reject","feedback":"..."}\n\n` +
    `Patient question: ${question}\n\nProfile context: ${context}`
  );
}

/** Optimization-lens system prompt — evaluates practical utility and actionability. */
export function buildOptimizationLensSystemPrompt(question: string, context: string): string {
  return (
    `You are a medical optimization reviewer. Given a patient question and a proposed ` +
    `recommendation, assess whether it is actionable and practically useful.\n\n` +
    `Approve if: the recommendation is clear, specific, actionable, and proportionate ` +
    `to the patient's actual needs as described.\n` +
    `Reject if: the recommendation is vague, generic, impractical, or does not address ` +
    `the patient's specific situation.\n\n` +
    `Output ONLY {"verdict":"approve"|"reject","feedback":"..."}\n\n` +
    `Patient question: ${question}\n\nProfile context: ${context}`
  );
}

/**
 * Contraindication-checker system prompt — evaluates absolute contraindications.
 * CRITICAL: the model MUST emit veto:boolean to indicate absolute contraindications.
 * A veto forces accepted:false regardless of other lens votes — never overridable by majority.
 */
export function buildContraindicationCheckerSystemPrompt(
  question: string,
  context: string,
): string {
  return (
    `You are an independent contraindication-checker reviewer. Given a patient question and ` +
    `a proposed recommendation, identify whether it is absolutely contraindicated based on ` +
    `the patient profile.\n\n` +
    `IMPORTANT: The "veto" field is REQUIRED and ABSOLUTE. Set veto:true if the recommendation ` +
    `would be contraindicated for this patient (e.g. it interacts with a stated medication, ` +
    `conflicts with a known allergy, or is dangerous given a stated medical condition). ` +
    `A veto CANNOT be overridden by other reviewers.\n\n` +
    `Output ONLY {"verdict":"approve"|"reject","veto":true|false,"feedback":"..."}\n\n` +
    `Rules:\n` +
    `- "verdict" must be "approve" or "reject".\n` +
    `- "veto" MUST be a boolean.\n` +
    `- "feedback" must describe the specific contraindication or confirm none found.\n` +
    `- Set veto:true only when you identify an absolute contraindication.\n\n` +
    `Patient question: ${question}\n\nProfile context: ${context}`
  );
}

// ── Internal: one lens call ───────────────────────────────────────────

async function callLens(input: {
  llm: LLMClient;
  model: string;
  systemPrompt: string;
  userContent: string;
  priorText?: string;
  formattedError?: string;
}): Promise<string> {
  const { llm, model, systemPrompt, userContent, priorText, formattedError } = input;

  let messages: Message[];

  if (priorText !== undefined && formattedError !== undefined) {
    // Coercion retry: 3-message shape [user, assistant, user]
    // Mirrors callGroundingCritic (grounding-critic.ts:123-166)
    messages = [
      { role: "user", content: userContent },
      { role: "assistant", content: priorText },
      {
        role: "user",
        content: `${LENS_COERCION_INSTRUCTION}\n\nPrevious validation error:\n${formattedError}`,
      },
    ];
  } else {
    // First turn: single user message
    messages = [{ role: "user", content: userContent }];
  }

  const response = await llm.chat({
    model,
    system: systemPrompt,
    messages,
    jsonObjectMode: true, // mirrors grounding-critic.ts:162 and critic-deep.ts:163
  });

  return response.text;
}

// ── getLensVerdict (FAIL-CLOSED on parse exhaustion) ──────────────────

/**
 * Calls the injected lens client up to LENS_MAX_LLM_CALLS times.
 * On parse exhaustion returns {verdict:'reject', veto:false} — FAIL-CLOSED.
 *
 * FAIL-CLOSED inversion of critic-deep.ts:199-201 (which returns approve on exhaustion).
 * Mirrors the fail-closed tail at grounding-critic.ts:203-206 (which rejects on exhaustion).
 * bober: reject on parse exhaustion; intentional for medical safety.
 */
export async function getLensVerdict(input: {
  llm: LLMClient;
  model: string;
  systemPrompt: string;
  userContent: string;
}): Promise<LensVerdict> {
  const { llm, model, systemPrompt, userContent } = input;
  const maxAttempts = LENS_MAX_LLM_CALLS;

  let lastError = "Unknown error";
  let priorText: string | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const rawText = await callLens({
      llm,
      model,
      systemPrompt,
      userContent,
      priorText: attempt > 0 ? priorText : undefined,
      formattedError: attempt > 0 ? lastError : undefined,
    });

    const validated = validateLensVerdict(rawText);
    if (validated.ok) {
      return validated.verdict;
    }

    lastError = validated.error;
    priorText = rawText;
  }

  // FAIL-CLOSED inversion of critic-deep.ts:199-201 (which returns approve on exhaustion).
  // Mirrors grounding-critic.ts:203-206: reject on parse exhaustion; intentional for medical safety.
  // bober: reject on parse exhaustion; intentional for medical safety.
  return { verdict: "reject", feedback: "<unparseable lens output>", veto: false };
}
