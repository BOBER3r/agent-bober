/**
 * Medical team shared data types (Phase 6, Sprint 1).
 *
 * Defines the type surface for the medical-sop pipeline.
 * No execution logic lives here — real enforcement lands in S2/S3/S6.
 */

// ── Guardrail verdict ───────────────────────────────────────────────

/** Discriminated union returned by GuardrailSet.evaluate. */
export type GuardrailVerdict =
  | { kind: "allow" }
  | { kind: "short-circuit"; rule: string; cannedResponse: string }
  | { kind: "refuse"; rule: string; reason: string };

// ── Guardrail context + set ─────────────────────────────────────────

/** Context passed to GuardrailSet.evaluate. Real fields land in S3. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface GuardrailContext {
  /* placeholder — real fields land in S3 */
}

/** Interface for a rule set that guards medical prompts before LLM call. */
export interface GuardrailSet {
  evaluate(prompt: string, ctx: GuardrailContext): GuardrailVerdict;
  readonly rulesetVersion: string;
}

// ── Medical answer ──────────────────────────────────────────────────

/** Placeholder for literature citation shape. Real fields land in S7. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Citation {
  /* placeholder for S7 */
}

/** Shape of the medical engine answer. Real population lands in S2/S6. */
export interface MedicalAnswer {
  body: string;
  abstained: boolean;
  citations: Citation[];
  disclaimerFooter: string;
  shortCircuit: boolean;
}
