/**
 * The fail-closed SecurityAuditGate (spec-20260712-security-audit-agent-team,
 * sprint 3, ADR-2).
 *
 * Thin wrapper over runSecurityAudit (sprint 2): the gate owns the
 * Promise.race time-box, the rejection→'audit-error'/'timeout' mapping, the
 * parsed:false→'audit-error' elevation, and the best-effort store guard
 * (sc-3-6). It does NOT re-run or re-derive any auditor logic — the verdict
 * comes straight from `result.verdict` (already computed via deriveVerdict
 * inside runSecurityAudit).
 *
 * evaluateSecurityGate NEVER throws. Every failure mode (timeout, thrown
 * audit error, unparseable output) resolves to `blocked:true` — an
 * incomplete audit is never treated as clean (fail-closed).
 */
import type { BoberConfig } from "../config/schema.js";
import type { SprintContract } from "../contracts/sprint-contract.js";
import type { EvaluationRunResult } from "../evaluators/registry.js";
import type { SecurityAuditResult, SecurityFinding } from "./security-audit-types.js";
import { runSecurityAudit } from "./security-auditor-agent.js";
import { saveSecurityAudit } from "../state/security-audit-state.js";
import { logger } from "../utils/logger.js";

// ── Types ──────────────────────────────────────────────────────────

export interface SecurityGateInput {
  contract: SprintContract;
  evaluation: EvaluationRunResult;
  projectRoot: string;
  config: BoberConfig;
}

export type SecurityGateReason =
  | "critical-finding"
  | "timeout"
  | "audit-error"
  | "clean"
  | "disabled";

export interface SecurityGateVerdict {
  blocked: boolean;
  reason: SecurityGateReason;
  result?: SecurityAuditResult;
}

// Unique sentinel so a race timeout is distinguishable from any other
// rejection (provider/network/budget error) surfaced by runSecurityAudit.
const TIMEOUT_MESSAGE = "security-audit timeout";

// ── Gate ───────────────────────────────────────────────────────────

/**
 * Evaluate the security gate for a sprint that just passed evaluation.
 *
 * Never throws. Resolution mapping:
 * - `config.security` absent or `enabled !== true` → `{blocked:false, reason:'disabled'}`
 *   WITHOUT invoking the audit at all.
 * - `runSecurityAudit` rejects (any error) → `{blocked:true, reason:'audit-error'}`.
 * - The Promise.race timeout (`config.security.timeoutMs`) fires first →
 *   `{blocked:true, reason:'timeout'}`.
 * - `result.parsed === false` (unparseable auditor output) →
 *   `{blocked:true, reason:'audit-error', result}` — checked BEFORE
 *   `result.verdict` so a parse failure is never mistaken for a genuine
 *   critical finding.
 * - `result.verdict === 'blocked'` (a real critical finding) →
 *   `{blocked:true, reason:'critical-finding', result}`.
 * - Otherwise → `{blocked:false, reason:'clean', result}`.
 *
 * A `saveSecurityAudit` persistence failure is caught, logged, and never
 * changes the already-computed verdict in either direction (sc-3-6).
 */
export async function evaluateSecurityGate(
  input: SecurityGateInput,
): Promise<SecurityGateVerdict> {
  const { contract, evaluation, projectRoot, config } = input;

  // Disabled short-circuit — construct nothing, invoke nothing.
  if (config.security?.enabled !== true) {
    return { blocked: false, reason: "disabled" };
  }

  const timeoutMs = config.security.timeoutMs;

  let result: SecurityAuditResult;
  try {
    result = await Promise.race([
      runSecurityAudit(contract, evaluation, projectRoot, config),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(TIMEOUT_MESSAGE)), timeoutMs),
      ),
    ]);
  } catch (err) {
    const timedOut = err instanceof Error && err.message === TIMEOUT_MESSAGE;
    logger.warn(
      `Security audit ${timedOut ? "timed out" : "failed"}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { blocked: true, reason: timedOut ? "timeout" : "audit-error" };
  }

  // Parse-failure elevation MUST be checked before result.verdict: a parse
  // failure already forces verdict:'blocked' inside runSecurityAudit, but the
  // gate reports the distinct reason 'audit-error' (not 'critical-finding')
  // so callers/tests can tell the two failure modes apart.
  if (result.parsed === false) {
    return { blocked: true, reason: "audit-error", result };
  }

  // Best-effort persistence. runSecurityAudit already persisted internally
  // (security-auditor-agent.ts) — this is a deliberate, idempotent re-save
  // guarded independently so a store failure here can never flip the
  // already-computed verdict (sc-3-6).
  try {
    await saveSecurityAudit(projectRoot, contract.contractId, result);
  } catch (err) {
    logger.warn(
      `Security audit persistence failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return result.verdict === "blocked"
    ? { blocked: true, reason: "critical-finding", result }
    : { blocked: false, reason: "clean", result };
}

// ── Feedback rendering ─────────────────────────────────────────────

/** Bound the number of findings rendered/logged per blocked round. */
const MAX_RENDERED_FINDINGS = 20;

/**
 * Render a blocked SecurityGateVerdict into feedback strings for the
 * generator's next retry iteration (ADR-5), phrased for a fixer. Pure
 * function — no side effects, no I/O.
 *
 * Returns `[]` for a non-blocked verdict. Returns a single generic message
 * when there is no `result` to enumerate findings from (a `timeout` or a
 * rejected `audit-error` never resolves a SecurityAuditResult). Otherwise
 * returns a summary line followed by one line per critical finding, capped
 * to MAX_RENDERED_FINDINGS.
 */
export function renderSecurityFeedback(verdict: SecurityGateVerdict): string[] {
  if (!verdict.blocked) return [];

  if (!verdict.result) {
    const reasonText =
      verdict.reason === "timeout"
        ? "the security audit timed out before completing"
        : "the security audit could not be completed";
    return [
      `[SECURITY] Sprint blocked: ${reasonText}. No specific findings are available — investigate the audit failure and retry.`,
    ];
  }

  const { review } = verdict.result;
  // The auditor always constructs `review.critical` from SecurityFinding
  // objects (security-auditor-agent.ts), a superset of the locked
  // ReviewFinding shape — safe to narrow here to read the optional vulnClass.
  const criticalFindings = review.critical as SecurityFinding[];

  const parts: string[] = [
    `[SECURITY] Security audit blocked this sprint (reason: ${verdict.reason}, ${criticalFindings.length} critical finding(s)).`,
  ];

  for (const finding of criticalFindings.slice(0, MAX_RENDERED_FINDINGS)) {
    const evidence = finding.evidence[0];
    const path = evidence?.path ?? "unknown";
    const line = evidence?.line ?? 0;
    const vulnPrefix = finding.vulnClass ? `${finding.vulnClass}: ` : "";
    parts.push(
      `[CRITICAL] ${vulnPrefix}${finding.description} at ${path}:${line} — remediate by fixing the flagged vulnerability before this sprint can pass.`,
    );
  }

  return parts;
}
