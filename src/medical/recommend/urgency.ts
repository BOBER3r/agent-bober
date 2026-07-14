/**
 * Urgency/severity/confidence assigner — one bounded LLM call with a NEVER-throwing validator.
 *
 * PURE: NO fs / NO FactStore / NO network beyond the injected LLMClient.
 * All timestamps are injected; wall clock is read ONLY at the CLI boundary.
 *
 * By design OUTSIDE the ADR-3 deterministic-numerics boundary:
 * urgency/severity/confidence are INTERPRETATION, not arithmetic (contract assumption 3).
 *
 * Most similar: src/medical/recommend/lenses.ts:65-113 (validateLensVerdict pattern).
 */

import { z } from "zod";
import type { LLMClient } from "../../providers/types.js";

// -- Schema --------------------------------------------------------------

/**
 * Raw schema for the urgency response.
 * Values are parsed as raw numbers; clamping is applied after validation.
 */
const UrgencyResponseSchema = z.object({
  urgency: z.number(),
  severity: z.number(),
  confidence: z.number(),
});

// -- Types ---------------------------------------------------------------

export interface UrgencyResult {
  /** Urgency level 1..5 (5 = most urgent). */
  urgency: number;
  /** Severity level 1..5 (5 = most severe). */
  severity: number;
  /** Confidence in the assessment (0..1). */
  confidence: number;
}

// -- Conservative defaults -----------------------------------------------

/**
 * Conservative default returned on parse failure — never throws.
 * Represents moderate urgency/severity; confidence reflects uncertainty.
 */
const DEFAULT_URGENCY: UrgencyResult = { urgency: 3, severity: 3, confidence: 0.5 };

// -- Clamp helper --------------------------------------------------------

/** Clamp a number to the integer range [1, 5]. */
function clampInt(n: number): number {
  return Math.min(5, Math.max(1, Math.round(n)));
}

// -- validateUrgencyResponse (NEVER throws) ------------------------------

/**
 * Four-tier JSON extraction strategy — mirrors validateLensVerdict (lenses.ts:65-113).
 * Returns null on any failure so the caller can fall back to DEFAULT_URGENCY.
 */
function validateUrgencyResponse(rawText: string): UrgencyResult | null {
  let parsed: unknown;

  // Tier 1: direct parse
  try {
    parsed = JSON.parse(rawText.trim());
  } catch {
    // Tier 2: fenced JSON block
    const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/.exec(rawText);
    if (fenceMatch) {
      try {
        parsed = JSON.parse(fenceMatch[1].trim());
      } catch {
        // Fall through to tier 3
      }
    }

    // Tier 3: first { ... } block
    if (!parsed) {
      const braceStart = rawText.indexOf("{");
      const braceEnd = rawText.lastIndexOf("}");
      if (braceStart !== -1 && braceEnd > braceStart) {
        try {
          parsed = JSON.parse(rawText.slice(braceStart, braceEnd + 1));
        } catch {
          // Tier 4: fail
          return null;
        }
      } else {
        return null;
      }
    }
  }

  const result = UrgencyResponseSchema.safeParse(parsed);
  if (!result.success) {
    return null;
  }

  return {
    urgency: clampInt(result.data.urgency),
    severity: clampInt(result.data.severity),
    confidence: result.data.confidence,
  };
}

// -- System prompt -------------------------------------------------------

const URGENCY_SYSTEM_PROMPT = `You are a medical urgency assessor. Given a candidate recommendation and patient context, assess the urgency, severity, and your confidence in the assessment.

Output ONLY a JSON object with EXACTLY this shape:
{
  "urgency": <integer 1..5>,
  "severity": <integer 1..5>,
  "confidence": <float 0..1>
}

Rules:
- urgency: how soon action is needed (1=routine/months, 5=immediate/today)
- severity: impact on health if not addressed (1=minimal, 5=critical)
- confidence: your confidence in this assessment (0=uncertain, 1=certain)
- Output the JSON object and nothing else.`;

// -- assignUrgencySeverity -----------------------------------------------

/**
 * Assign urgency, severity, and confidence via ONE bounded LLM call.
 * NEVER throws — returns DEFAULT_URGENCY on any error or parse failure.
 */
export async function assignUrgencySeverity(
  llm: LLMClient,
  model: string,
  candidate: string,
  context: string,
): Promise<UrgencyResult> {
  const userContent =
    `Candidate recommendation:\n${candidate}\n\nPatient context:\n${context}`;

  let rawText: string;
  try {
    const response = await llm.chat({
      model,
      system: URGENCY_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
      jsonObjectMode: true,
    });
    rawText = response.text;
  } catch {
    // Transport failure — conservative default
    return DEFAULT_URGENCY;
  }

  const result = validateUrgencyResponse(rawText);
  // bober: fall back to DEFAULT_URGENCY on parse failure; intentional conservative default.
  return result ?? DEFAULT_URGENCY;
}
