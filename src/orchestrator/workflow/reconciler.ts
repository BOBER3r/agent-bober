import type { EvalResult, EvalDetail } from "../../contracts/eval-result.js";

// ── Reconciler ─────────────────────────────────────────────────────

/**
 * Pure majority-vote reducer over per-lens EvalResult[] (ADR-4).
 * No Date.now / new Date / Math.random / fs — timestamp is a caller arg.
 *
 * Rules:
 *   - empty lensVerdicts → throws
 *   - passed = passCount > failCount (strict majority, fail-closed on tie)
 *   - details = union of all failing details, de-duped by (criterion, message)
 *   - feedback = failing lenses' feedback joined with newlines, or "All lenses passed."
 *   - evaluator = "panel"
 *   - timestamp = the injected timestamp argument (echoed verbatim)
 */
export function reconcile(
  _sprintId: string,
  _round: number,
  lensVerdicts: EvalResult[],
  timestamp: string,
): EvalResult {
  if (lensVerdicts.length === 0) {
    throw new Error("reconcile: lensVerdicts must be non-empty");
  }

  const n = lensVerdicts.length;

  // Count passing lenses
  let passCount = 0;
  for (const lens of lensVerdicts) {
    if (lens.passed === true) {
      passCount = passCount + 1;
    }
  }

  const failCount = n - passCount;

  // Strict majority: passCount must exceed failCount (fail-closed on tie)
  const passed = passCount > failCount;

  // Union failing details, de-duped by criterion + message
  const seenKeys = new Set<string>();
  const details: EvalDetail[] = [];

  for (const lens of lensVerdicts) {
    for (const detail of lens.details) {
      if (detail.passed === false) {
        const key = `${detail.criterion}␟${detail.message}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          details.push(detail);
        }
      }
    }
  }

  // Build summary
  const summary = `Panel verdict: ${passCount}/${n} lenses passed`;

  // Build feedback from failing lenses
  const feedbackParts: string[] = [];
  for (const lens of lensVerdicts) {
    if (!lens.passed && lens.feedback) {
      feedbackParts.push(lens.feedback);
    }
  }
  const feedback = feedbackParts.length > 0 ? feedbackParts.join("\n") : "All lenses passed.";

  // Compute optional score
  const score = Math.round((100 * passCount) / n);

  return {
    evaluator: "panel",
    passed,
    score,
    details,
    summary,
    feedback,
    timestamp,
  };
}
