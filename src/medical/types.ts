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

// ── Consent record ──────────────────────────────────────────────────

/**
 * Persisted consent record stored at .bober/medical/consent.json.
 * All timestamps are injected ISO 8601 strings — never wall-clock reads.
 */
export interface ConsentRecord {
  consentVersion: string;
  /** ISO 8601; INJECTED parameter — never Date.now(). */
  acceptedAtIso: string;
  rulesetVersion: string;
  disclaimerVersion: string;
}

// ── Audit log ───────────────────────────────────────────────────────

/** Discriminated audit event type. IDs/enums only — no prompt text or health values. */
export type AuditEvent =
  | "consent"
  | "short-circuit"
  | "refuse"
  | "answer"
  | "abstain"
  | "ingest";

/**
 * Audit entry appended to .bober/medical/audit-<date>.jsonl.
 * ONLY IDs/enums allowed — NEVER prompt text or health values.
 */
export interface AuditEntry {
  /** ISO 8601; INJECTED parameter — never Date.now(). */
  tIso: string;
  event: AuditEvent;
  /** Optional ruleset version (populated when a guardrail runs). */
  rulesetVersion?: string;
  /** Optional patternset version (populated in S3 by RedFlagDetector). */
  patternsetVersion?: string;
  /** Optional rule ID triggering the event (IDs only — never text). */
  ruleId?: string;
}
