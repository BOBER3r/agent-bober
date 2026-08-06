import type { EvalResult } from "../../contracts/eval-result.js";
import type { EvaluationRunResult } from "../../evaluators/registry.js";
import { setUnion } from "../registry/reducers.js";

/**
 * The test-anchor registry: which checks a branch has already been seen to pass, and what
 * it means when a later iteration stops passing one of them.
 *
 * ── The failure this exists to stop ──
 *
 * A self-healing edit that fixes the test it was asked to fix and quietly breaks one that
 * was already green is a NET LOSS the sprint's own verdict cannot see: the evaluator grades
 * the contract's criteria, and a criterion that regressed is simply reported as failing this
 * time, indistinguishable from one that never passed. An anchor is the memory that makes the
 * difference expressible — "this check was green in an earlier iteration OF THIS BRANCH" —
 * and a trade of one for the other is a rejection rather than a partial success.
 *
 * ── Why this module is pure, and has no graph in it ──
 *
 * Everything here is a function of two string sets and one shipped {@link
 * EvaluationRunResult}. The node bodies in `sprint-evaluate.ts` and the gate in `gates.ts`
 * supply the state and act on the answer; the answer itself is decidable without a run, a
 * temp directory or a sandbox, so it is decided here where a test can drive it directly.
 *
 * ── Why the channel is `setUnion`, and why that is load-bearing ──
 *
 * `testAnchors` is merged by `setUnion` (`src/pge/registry/reducers.ts:316`, bound at
 * `coding.graph.ts:149`), which is associative, commutative and idempotent. Concurrent
 * sprint branches therefore cannot lose an anchor by writing at the same superstep, and a
 * replayed superstep cannot duplicate one — which is exactly the property assumption 3 of
 * the sprint contract relies on. {@link mergeAnchors} DELEGATES to that reducer rather than
 * re-implementing a union, so the in-node view of the channel and the committed value can
 * never disagree.
 *
 * ── An anchor is BROKEN only when something says so ──
 *
 * The distinction {@link detectAnchorTrade} is built around: an anchor missing from the new
 * evaluation was NOT RUN, and "not run" is not evidence of a regression — a selectively
 * verified iteration (sc-12-8) legitimately does not re-run everything. An anchor is broken
 * only when the new evaluation reports that same id FAILING. Treating absence as breakage
 * would make selective verification and anchor regression mutually exclusive.
 */

// ── Anchor ids ──────────────────────────────────────────────────────

/** Separator between the evaluator that reported a check and the check's own id. */
export const ANCHOR_SEPARATOR = "::";

/**
 * The anchor id for one check reported by one evaluator.
 *
 * Namespaced by evaluator because criterion ids are contract-scoped, not evaluator-scoped:
 * `unit-test` and `agent-evaluation` both legitimately report `sc-12-5`, and collapsing
 * them would let a green agent evaluation mask a red unit test.
 */
export function anchorId(evaluator: string, criterion: string): string {
  return `${evaluator}${ANCHOR_SEPARATOR}${criterion}`;
}

/** The `(evaluator, criterion)` pair an anchor id names, or `null` if it is not one. */
export function parseAnchorId(id: string): { evaluator: string; criterion: string } | null {
  const at = id.indexOf(ANCHOR_SEPARATOR);
  if (at <= 0) return null;
  const criterion = id.slice(at + ANCHOR_SEPARATOR.length);
  if (criterion.length === 0) return null;
  return { evaluator: id.slice(0, at), criterion };
}

// ── Reading a shipped evaluation ────────────────────────────────────

/** Every `(evaluator, criterion)` the run reported, with the outcome it reported. */
function reportedChecks(evaluation: EvaluationRunResult): Map<string, boolean> {
  const checks = new Map<string, boolean>();
  for (const result of evaluation.results) {
    for (const detail of detailsOf(result)) {
      checks.set(anchorId(result.evaluator, detail.criterion), detail.passed);
    }
  }
  return checks;
}

/** `EvalResult.details`, defensively — a plugin may return an evaluation with none. */
function detailsOf(result: EvalResult): EvalResult["details"] {
  return Array.isArray(result.details) ? result.details : [];
}

/** The anchor ids this evaluation observed GREEN, sorted. */
export function anchorsFrom(evaluation: EvaluationRunResult): string[] {
  const green: string[] = [];
  for (const [id, passed] of reportedChecks(evaluation)) {
    if (passed) green.push(id);
  }
  return green.sort();
}

/** The anchor ids this evaluation observed RED, sorted. */
export function failuresFrom(evaluation: EvaluationRunResult): string[] {
  const red: string[] = [];
  for (const [id, passed] of reportedChecks(evaluation)) {
    if (!passed) red.push(id);
  }
  return red.sort();
}

// ── Channel merge ───────────────────────────────────────────────────

/**
 * The anchor set after `additions` join `current`, through the CHANNEL'S OWN reducer.
 *
 * Not `[...new Set([...a, ...b])].sort()` written a second time: a node that computed the
 * union differently from the reducer would show one value to its own logic and commit
 * another, and the divergence would only appear under concurrency.
 */
export function mergeAnchors(
  current: readonly string[],
  additions: readonly string[],
): readonly string[] {
  return setUnion.merge(current, [additions]);
}

// ── Regression detection ────────────────────────────────────────────

/**
 * What one iteration did to the branch's anchors.
 *
 * `fixed` and `broken` are the two halves of the TRADE sc-12-5 is about, and both are
 * reported even when the iteration is rejected — a rejection that could not say what the
 * iteration achieved would be indistinguishable from an iteration that achieved nothing.
 */
export interface AnchorTrade {
  /** Anchor ids this iteration observed green that were not anchors before. */
  readonly fixed: readonly string[];
  /** Anchor ids that WERE anchors and that this iteration reports failing. */
  readonly broken: readonly string[];
  /** Anchors this iteration did not report on either way. Not evidence of anything. */
  readonly unobserved: readonly string[];
  /** True when at least one previously green anchor is now reported red. */
  readonly regressed: boolean;
}

/**
 * Compare a branch's recorded anchors against a fresh evaluation.
 *
 * The asymmetry between `broken` and `unobserved` is the whole design; see the module
 * header. `fixed` is computed against the SAME recorded set, so an iteration that fixed the
 * targeted test and broke an anchor reports both — which is what makes the rejection a
 * judgement about a trade rather than a report that something failed.
 */
export function detectAnchorTrade(
  anchors: readonly string[],
  evaluation: EvaluationRunResult,
): AnchorTrade {
  const recorded = new Set(anchors);
  const checks = reportedChecks(evaluation);

  const broken: string[] = [];
  const unobserved: string[] = [];
  for (const id of recorded) {
    const observed = checks.get(id);
    if (observed === undefined) unobserved.push(id);
    else if (!observed) broken.push(id);
  }

  const fixed: string[] = [];
  for (const [id, passed] of checks) {
    if (passed && !recorded.has(id)) fixed.push(id);
  }

  return {
    fixed: fixed.sort(),
    broken: broken.sort(),
    unobserved: unobserved.sort(),
    regressed: broken.length > 0,
  };
}

// ── Carrying a regression across a declared port ────────────────────

/**
 * The marker that carries a regression from `sprint_evaluate` to `gate_anchor_regression`.
 *
 * ── Why a string protocol, reported rather than hidden ──
 *
 * The gate's declared `reads` are `["testAnchors"]` alone (`coding.graph.ts:605`), and
 * `testAnchors` is a `setUnion` channel — a union NEVER REMOVES a member, so an anchor that
 * broke is still in it and the channel cannot express the difference. The one other thing
 * that reaches the gate is the `verdict` port the artifact declares between the two nodes
 * (`coding.graph.ts:591,603`), whose payload is a `SprintVerdict` with a fixed field set and
 * a free-form `summary`.
 *
 * So the broken-anchor list rides in `summary`, in a shape the gate can decode. The
 * alternative — widening `SprintVerdictSchema`, or adding a channel — would change the
 * `evaluations` channel shape and the fifteen-key state budget for a fact that is local to
 * one edge. This is a finding about the artifact, not a design preference; it is written
 * down here so the next artifact revision can give the edge a port that says it.
 */
export const ANCHOR_REGRESSION_MARKER = "[anchor-regression]";

/**
 * What separates the anchor list from the human detail.
 *
 * A pipe rather than a second `::`, because an anchor id CONTAINS {@link ANCHOR_SEPARATOR}
 * and splitting on it would cut every id in half — the exact bug the decode round trip in
 * `anchors.test.ts` exists to catch.
 */
export const ANCHOR_REGRESSION_DETAIL_SEPARATOR = " | ";

/** Encode a broken-anchor list into a verdict summary. */
export function encodeAnchorRegression(broken: readonly string[], detail: string): string {
  if (broken.length === 0) return detail;
  return `${ANCHOR_REGRESSION_MARKER} ${[...broken].sort().join(" ")}${ANCHOR_REGRESSION_DETAIL_SEPARATOR}${detail}`;
}

/** The broken anchors a verdict summary carries, or `[]`. */
export function decodeAnchorRegression(summary: string): string[] {
  if (!summary.startsWith(ANCHOR_REGRESSION_MARKER)) return [];
  const body = summary
    .slice(ANCHOR_REGRESSION_MARKER.length)
    .split(ANCHOR_REGRESSION_DETAIL_SEPARATOR)[0];
  return body
    .split(/\s+/)
    .map((id) => id.trim())
    .filter((id) => id.length > 0 && parseAnchorId(id) !== null)
    .sort();
}

/** A one-line account of a trade, for the correction payload's critique. */
export function describeAnchorTrade(trade: AnchorTrade): string {
  const fixed = trade.fixed.length === 0 ? "nothing" : trade.fixed.join(", ");
  const broken = trade.broken.length === 0 ? "nothing" : trade.broken.join(", ");
  return `this iteration fixed ${fixed} and broke ${broken}; a previously green anchor may not be traded for a targeted fix`;
}
