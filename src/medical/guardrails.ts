/**
 * MedicalGuardrails — real GuardrailSet wrapping RedFlagDetector (Phase 6, Sprint 3).
 *
 * evaluate(prompt, ctx) runs the red-flag detector first; a match returns a
 * short-circuit verdict with a canned 911/988 escalation. Non-emergency prompts
 * return { kind: "allow" }.
 *
 * bober: refuse branch for non-emergency code-enforced refusals is a documented
 *        placeholder this sprint. Real content-policy refusals (e.g. requests for
 *        treatment plans, prescriptions) land in S6. When added, follow the same
 *        "IDs/enums only in the audit" rule and add a dedicated ruleset.
 *
 * NO network. NO LLM import. No src/providers import.
 */
import type { GuardrailContext, GuardrailSet, GuardrailVerdict } from "./types.js";
import { RedFlagDetector, PATTERNSET_VERSION } from "./red-flag.js";
import type { RedFlagCategory } from "./red-flag.js";

// ── Version constant ─────────────────────────────────────────────────

/** Versioned ruleset identifier recorded in the audit log. */
export const GUARDRAIL_RULESET_VERSION = "guardrail-2026.06.16";

// ── Canned escalation strings (NEVER model-generated) ───────────────

/**
 * Fixed 911 escalation text.
 * Returned verbatim; never passed through an LLM.
 */
const ESCALATION_911 =
  "This may be a medical emergency. Call 911 (or your local emergency number) now.";

/**
 * Fixed 988 escalation text.
 * Returned verbatim; never passed through an LLM.
 */
const ESCALATION_988 =
  "If you are in crisis, call or text 988 (US Suicide & Crisis Lifeline) now, " +
  "or 911 if you are in immediate danger.";

/** Maps a red-flag category to its fixed escalation string. */
function escalationFor(category: RedFlagCategory): string {
  switch (category) {
    case "cardiac":
    case "stroke":
    case "anaphylaxis":
      return ESCALATION_911;
    case "self-harm":
    case "overdose":
      return ESCALATION_988;
    default:
      // Unreachable for 'none'; safe fallback is 911.
      return ESCALATION_911;
  }
}

// ── MedicalGuardrails ────────────────────────────────────────────────

/**
 * Real medical GuardrailSet implementation.
 *
 * Replaces the allow-only stub in team.ts:buildMedicalGuardrails (Sprint 1–2).
 * team.ts now delegates to this class; engine.ts defaults to it.
 */
export class MedicalGuardrails implements GuardrailSet {
  readonly rulesetVersion = GUARDRAIL_RULESET_VERSION;

  /**
   * Expose the detector so the engine can read patternsetVersion for the audit entry.
   * Read-only; tests may introspect but must not replace at runtime.
   */
  readonly detector = new RedFlagDetector();

  /**
   * Evaluate the prompt against the medical guardrail ruleset.
   *
   * @throws {Error} if prompt is empty or whitespace-only (sc-3-8).
   * @returns GuardrailVerdict — short-circuit for red flags, allow for benign prompts.
   */
  evaluate(prompt: string, _ctx: GuardrailContext): GuardrailVerdict {
    if (prompt.trim().length === 0) {
      throw new Error("GuardrailSet.evaluate: prompt must not be empty or whitespace-only");
    }

    const match = this.detector.detect(prompt);
    if (match.category !== "none") {
      return {
        kind: "short-circuit",
        rule: match.ruleId ?? match.category,
        cannedResponse: escalationFor(match.category),
      };
    }

    // bober: refuse branch for non-emergency refusals (treatment plans, prescriptions, etc.)
    //        is a placeholder this sprint; real content-policy rules land in S6.

    return { kind: "allow" };
  }

  /** Expose PATTERNSET_VERSION so callers don't need a separate import. */
  get patternsetVersion(): string {
    return PATTERNSET_VERSION;
  }
}
