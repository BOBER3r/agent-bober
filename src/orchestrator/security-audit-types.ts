import type { ReviewResult, ReviewFinding } from "./code-reviewer-agent.js";

// ── Vulnerability taxonomy ────────────────────────────────────────────

/**
 * Coarse vulnerability classification attached to a SecurityFinding.
 * Optional — the auditor may not always be able to classify a finding.
 */
export type VulnClass =
  | "injection"
  | "authn-authz"
  | "secret-handling"
  | "input-validation"
  | "path-traversal"
  | "privilege-escalation";

// ── Wrapper types over the LOCKED ReviewResult/ReviewFinding ──────────

/**
 * A security-specific finding. Extends the locked ReviewFinding shape with
 * an optional vulnClass tag — never redefines ReviewFinding's fields.
 */
export interface SecurityFinding extends ReviewFinding {
  vulnClass?: VulnClass;
}

/**
 * The structured result of a security audit run.
 * Wraps the locked ReviewResult (whose critical[] bucket is the blocking
 * signal) with security-audit-specific metadata.
 */
export interface SecurityAuditResult {
  /** The underlying review — critical[] drives the gate decision. */
  review: ReviewResult;
  /** Detected/declared tech stack the audit ran against (e.g. "node", "solidity"). */
  stack: string;
  /** Whether the opt-in deterministic scanner pre-filter ran before the LLM pass. */
  scannerRan: boolean;
  /** False when the auditor's output could not be parsed into a ReviewResult. */
  parsed: boolean;
  /** Derived verdict — see deriveVerdict. Never set independently of review.critical. */
  verdict: "pass" | "blocked";
}

// ── Pure verdict derivation (reused by core, gate, CLI in later sprints) ──

/**
 * Derive the pass/blocked verdict from a ReviewResult.
 * Pure function: blocked iff there is at least one critical finding.
 * Important-only or minor-only findings never block.
 */
export function deriveVerdict(review: ReviewResult): "pass" | "blocked" {
  return review.critical.length > 0 ? "blocked" : "pass";
}
