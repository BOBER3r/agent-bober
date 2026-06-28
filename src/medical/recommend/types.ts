/**
 * Recommendation judge-panel shared types.
 *
 * PURE orchestration over injected fns — NO fs / NO network / NO real provider / NO FactStore.
 * All execution logic lives in lenses.ts and judge-panel.ts.
 */

import type { LLMClient } from "../../providers/types.js";

// ── Budget constants ──────────────────────────────────────────────────

/** Number of parse-retry attempts per lens call (mirrors GROUNDING_PARSE_MAX_RETRIES). */
export const LENS_PARSE_MAX_RETRIES = 1;

/** Total LLM calls per lens per round: 1 initial + parse retries (mirrors GROUNDING_MAX_LLM_CALLS). */
export const LENS_MAX_LLM_CALLS = 1 + LENS_PARSE_MAX_RETRIES; // = 2

/** Default maximum judge rounds before fail-closed (research §4a:192). */
export const MEDICAL_PANEL_MAX_ROUNDS = 3;

/**
 * Worst-case LLM call budget for the full judge loop.
 * Per round = 1 generateCandidate + 4 lenses × LENS_MAX_LLM_CALLS.
 * Total = MEDICAL_PANEL_MAX_ROUNDS × (1 + 4 × LENS_MAX_LLM_CALLS) = 3 × 9 = 27.
 */
export const MEDICAL_PANEL_MAX_TOTAL_CALLS =
  MEDICAL_PANEL_MAX_ROUNDS * (1 + 4 * LENS_MAX_LLM_CALLS); // = 27

// ── Lens names ────────────────────────────────────────────────────────

/**
 * Four lens names (research §4a:186-191).
 * Only contraindication-checker may carry a veto.
 */
export type LensName =
  | "evidence-grader"
  | "contraindication-checker"
  | "conservative-clinician"
  | "optimization-lens";

// ── Lens verdict ──────────────────────────────────────────────────────

/**
 * Verdict returned by each lens.
 * Only the contraindication-checker populates veto; other lenses always have veto===false.
 */
export interface LensVerdict {
  verdict: "approve" | "reject";
  feedback: string;
  /** True only when contraindication-checker finds an absolute contraindication. */
  veto?: boolean;
}

// ── Per-lens client spec ──────────────────────────────────────────────

/** An injected LLM client + model identifier for a single lens. */
export interface LensSpec {
  client: LLMClient;
  model: string;
}

/** One LensSpec per lens — each may use a different model (sprint 3 wires tier-policy). */
export interface LensClients {
  evidenceGrader: LensSpec;
  contraindicationChecker: LensSpec;
  conservativeClinician: LensSpec;
  optimizationLens: LensSpec;
}

// ── Reconciliation result ─────────────────────────────────────────────

/** Internal reconciliation outcome; not exported as part of the public API. */
export interface PanelDecision {
  accepted: boolean;
  /** Present only when accepted is false. */
  reason?: "contraindication-veto" | "no-consensus";
}

// ── Panel outcomes ────────────────────────────────────────────────────

/**
 * Accepted recommendation: all four lenses approved (strict majority) and no veto was present.
 */
export interface AcceptedOutcome {
  outcome: "accepted";
  accepted: true;
  /** The raw candidate returned by generateCandidate — NOT a Finding (sprint 3 emits Findings). */
  recommendation: string;
  /** Per-lens verdict map for the winning round. */
  verdicts: Record<LensName, LensVerdict>;
  /** Round number in which consensus was reached (1-indexed). */
  rounds: number;
}

/**
 * Rejected after maxRounds — no consensus was reached.
 */
export interface RejectedOutcome {
  outcome: "rejected";
  accepted: false;
  reason: "contraindication-veto" | "no-consensus";
  /** Per-lens feedback strings collected on the final round. */
  dissent: Record<LensName, string>;
  /** Per-lens verdict map from the final round. */
  verdicts: Record<LensName, LensVerdict>;
  /** Number of rounds executed before giving up. */
  rounds: number;
}

/**
 * Guard short-circuited the loop — red-flag matched, emergency escalation required.
 */
export interface ShortCircuitOutcome {
  outcome: "short-circuit";
  rule: string;
  cannedResponse: string;
}

/**
 * Guard refused the request — policy-based refusal (not an emergency).
 */
export interface RefuseOutcome {
  outcome: "refuse";
  rule: string;
  reason: string;
}

/** Discriminated union of all possible outcomes from runJudgeLoop. */
export type PanelOutcome =
  | AcceptedOutcome
  | RejectedOutcome
  | ShortCircuitOutcome
  | RefuseOutcome;
