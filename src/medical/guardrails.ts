/**
 * MedicalGuardrails — real GuardrailSet wrapping RedFlagDetector + RefusalDetector
 * (Phase 6, Sprint 3 + Sprint 1 of spec-20260617-medical-whoop-guardrails).
 *
 * evaluate(prompt, ctx) runs the red-flag detector first; a match returns a
 * short-circuit verdict with a canned 911/988 escalation. Then runs the refusal
 * detector; a match returns a refuse verdict with a fixed canned decline message.
 * Non-emergency, non-refusal prompts return { kind: "allow" }.
 *
 * NO network. NO LLM import. No src/providers import.
 */
import type { GuardrailContext, GuardrailSet, GuardrailVerdict } from "./types.js";
import { RedFlagDetector, PATTERNSET_VERSION } from "./red-flag.js";
import type { RedFlagCategory } from "./red-flag.js";
import { RefusalDetector, REFUSAL_PATTERNSET_VERSION, REFUSAL_REASONS } from "./refusal.js";

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
   * Refusal detector for non-emergency content-policy refusals
   * (prescription / specific-dosing / individualized-treatment-plan).
   */
  readonly refusal = new RefusalDetector();

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

    // Gate 2b: Content-policy refusal (prescription / dosing / treatment-plan).
    // Only reached when red-flag is 'none' — emergency precedence is guaranteed by the
    // early return above.
    const r = this.refusal.detect(prompt);
    if (r.category !== "none") {
      return {
        kind: "refuse",
        rule: r.ruleId ?? r.category,
        reason: REFUSAL_REASONS[r.category],
      };
    }

    return { kind: "allow" };
  }

  /** Expose red-flag PATTERNSET_VERSION so callers don't need a separate import. */
  get patternsetVersion(): string {
    return PATTERNSET_VERSION;
  }

  /** Expose refusal REFUSAL_PATTERNSET_VERSION for the engine's refuse audit entry. */
  get refusalPatternsetVersion(): string {
    return REFUSAL_PATTERNSET_VERSION;
  }
}
