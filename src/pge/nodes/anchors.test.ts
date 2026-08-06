import { describe, expect, it } from "vitest";

import type { EvalResult } from "../../contracts/eval-result.js";
import type { EvaluationRunResult } from "../../evaluators/registry.js";
import { setUnion } from "../registry/reducers.js";
import {
  ANCHOR_SEPARATOR,
  anchorId,
  anchorsFrom,
  decodeAnchorRegression,
  describeAnchorTrade,
  detectAnchorTrade,
  encodeAnchorRegression,
  failuresFrom,
  mergeAnchors,
  parseAnchorId,
} from "./anchors.js";

/**
 * The test-anchor registry (sc-12-5).
 *
 * What each test here exists to catch:
 *
 *  - a regression check that only ever looks at whether the TARGETED test went green, so an
 *    iteration that fixed one check and broke another reads as a success. The load-bearing
 *    case below constructs the genuine trade — the target fixed AND a previously green
 *    anchor reported failing, IN THE SAME evaluation — and asserts the rejection;
 *  - a check that flags a regression merely because an anchor is ABSENT from the new
 *    evaluation. Selective verification (sc-12-8) legitimately does not re-run everything,
 *    and an absence-is-breakage rule would make the two features mutually exclusive;
 *  - an anchor id that collapses two evaluators reporting the same criterion, which would
 *    let a green agent evaluation mask a red unit test of the same name;
 *  - a union written a second time inside the node layer instead of delegating to the
 *    channel's own reducer, which would only diverge under concurrency.
 *
 * Deliberate mutations this suite was run against and failed on:
 *  1. `regressed: fixed.length === 0`                       -> the genuine-trade test passes the
 *     iteration that broke an anchor;
 *  2. `broken` counting `checks.get(id) !== true`           -> the unobserved-anchor test reports
 *     a regression for a check that simply did not run;
 *  3. `anchorId` returning `criterion` alone                -> the two-evaluator test loses the red
 *     unit test behind the green agent evaluation;
 *  4. `mergeAnchors` returning `[...current, ...additions]` -> the reducer-delegation test finds
 *     duplicates and a non-sorted result;
 *  5. `anchorsFrom` reading `result.passed` instead of the  -> the mixed-detail test reports a
 *     per-detail outcome                                       failing criterion as an anchor.
 */

// ── Fixtures ────────────────────────────────────────────────────────

function evalResult(
  evaluator: string,
  details: Array<{ criterion: string; passed: boolean }>,
): EvalResult {
  return {
    evaluator,
    passed: details.every((detail) => detail.passed),
    score: details.every((detail) => detail.passed) ? 100 : 40,
    details: details.map((detail) => ({
      criterion: detail.criterion,
      passed: detail.passed,
      message: detail.passed ? "ok" : "failed",
      severity: detail.passed ? ("info" as const) : ("error" as const),
    })),
    summary: `${evaluator} summary`,
    feedback: `${evaluator} feedback`,
    timestamp: "2026-08-05T00:00:00.000Z",
  };
}

function evaluation(results: EvalResult[], score = 80): EvaluationRunResult {
  return {
    passed: results.every((result) => result.passed),
    score,
    results,
    summary: "run summary",
    timestamp: "2026-08-05T00:00:00.000Z",
  };
}

// ── Anchor ids ──────────────────────────────────────────────────────

describe("anchor ids", () => {
  it("namespaces a criterion by the evaluator that reported it", () => {
    expect(anchorId("unit-test", "sc-12-5")).toBe(`unit-test${ANCHOR_SEPARATOR}sc-12-5`);
    expect(parseAnchorId(anchorId("unit-test", "sc-12-5"))).toEqual({
      evaluator: "unit-test",
      criterion: "sc-12-5",
    });
  });

  it("keeps two evaluators reporting the same criterion apart", () => {
    const run = evaluation([
      evalResult("agent-evaluation", [{ criterion: "sc-12-5", passed: true }]),
      evalResult("unit-test", [{ criterion: "sc-12-5", passed: false }]),
    ]);
    // Collapsed to the bare criterion id these would be one entry and the green one would
    // win, which is the mask this namespacing exists to prevent.
    expect(anchorsFrom(run)).toEqual(["agent-evaluation::sc-12-5"]);
    expect(failuresFrom(run)).toEqual(["unit-test::sc-12-5"]);
  });

  it("refuses a string that is not an anchor id", () => {
    expect(parseAnchorId("sc-12-5")).toBeNull();
    expect(parseAnchorId("::sc-12-5")).toBeNull();
    expect(parseAnchorId("unit-test::")).toBeNull();
  });
});

// ── Reading a shipped evaluation ────────────────────────────────────

describe("anchorsFrom", () => {
  it("reports the green details, not the evaluator's aggregate verdict", () => {
    const run = evaluation([
      evalResult("unit-test", [
        { criterion: "sc-12-1", passed: true },
        { criterion: "sc-12-2", passed: false },
      ]),
    ]);
    expect(anchorsFrom(run)).toEqual(["unit-test::sc-12-1"]);
    expect(failuresFrom(run)).toEqual(["unit-test::sc-12-2"]);
  });

  it("survives an evaluation whose plugin returned no details", () => {
    const bare = { ...evalResult("build", []), details: [] };
    expect(anchorsFrom(evaluation([bare]))).toEqual([]);
  });
});

// ── Channel merge ───────────────────────────────────────────────────

describe("mergeAnchors", () => {
  it("delegates to the channel's own setUnion reducer", () => {
    const current = ["unit-test::sc-12-2", "unit-test::sc-12-1"];
    const additions = ["unit-test::sc-12-1", "unit-test::sc-12-3"];
    expect(mergeAnchors(current, additions)).toEqual(setUnion.merge(current, [additions]));
    expect(mergeAnchors(current, additions)).toEqual([
      "unit-test::sc-12-1",
      "unit-test::sc-12-2",
      "unit-test::sc-12-3",
    ]);
  });

  it("is idempotent, which is what makes a replayed superstep safe", () => {
    const once = mergeAnchors([], ["a", "b"]);
    expect(mergeAnchors(once, ["a", "b"])).toEqual(once);
  });
});

// ── The trade ───────────────────────────────────────────────────────

describe("detectAnchorTrade", () => {
  it("rejects an iteration that fixes the targeted test AND breaks a green anchor", () => {
    // The genuine trade sc-12-5 names. Iteration N left three anchors green and sc-12-9
    // failing. Iteration N+1 fixes sc-12-9 — and breaks sc-12-2 in the same evaluation.
    const anchors = ["unit-test::sc-12-1", "unit-test::sc-12-2", "unit-test::sc-12-3"];
    const after = evaluation([
      evalResult("unit-test", [
        { criterion: "sc-12-1", passed: true },
        { criterion: "sc-12-2", passed: false },
        { criterion: "sc-12-3", passed: true },
        { criterion: "sc-12-9", passed: true },
      ]),
    ]);

    const trade = detectAnchorTrade(anchors, after);

    // BOTH halves are asserted. An implementation that only noticed the breakage would
    // still pass a test that checked `regressed` alone, and the criterion is about the
    // trade: the target really was fixed, and the iteration is rejected anyway.
    expect(trade.fixed).toEqual(["unit-test::sc-12-9"]);
    expect(trade.broken).toEqual(["unit-test::sc-12-2"]);
    expect(trade.unobserved).toEqual([]);
    expect(trade.regressed).toBe(true);
    expect(describeAnchorTrade(trade)).toContain("unit-test::sc-12-2");
  });

  it("accepts an iteration that fixes the targeted test and breaks nothing", () => {
    const anchors = ["unit-test::sc-12-1", "unit-test::sc-12-2"];
    const after = evaluation([
      evalResult("unit-test", [
        { criterion: "sc-12-1", passed: true },
        { criterion: "sc-12-2", passed: true },
        { criterion: "sc-12-9", passed: true },
      ]),
    ]);

    const trade = detectAnchorTrade(anchors, after);
    expect(trade.fixed).toEqual(["unit-test::sc-12-9"]);
    expect(trade.broken).toEqual([]);
    expect(trade.regressed).toBe(false);
  });

  it("does not call an anchor broken merely because it was not re-run", () => {
    // Selective verification (sc-12-8) legitimately skips checks. Silence is not a red
    // report, and an implementation that treated it as one would make the two features
    // mutually exclusive.
    const anchors = ["unit-test::sc-12-1", "playwright::sc-12-4"];
    const after = evaluation([
      evalResult("unit-test", [{ criterion: "sc-12-1", passed: true }]),
    ]);

    const trade = detectAnchorTrade(anchors, after);
    expect(trade.broken).toEqual([]);
    expect(trade.unobserved).toEqual(["playwright::sc-12-4"]);
    expect(trade.regressed).toBe(false);
  });

  it("reports a regression even when the iteration fixed nothing at all", () => {
    const trade = detectAnchorTrade(
      ["unit-test::sc-12-1"],
      evaluation([evalResult("unit-test", [{ criterion: "sc-12-1", passed: false }])]),
    );
    expect(trade.fixed).toEqual([]);
    expect(trade.broken).toEqual(["unit-test::sc-12-1"]);
    expect(trade.regressed).toBe(true);
  });

  it("treats an empty anchor set as nothing to lose", () => {
    const trade = detectAnchorTrade(
      [],
      evaluation([evalResult("unit-test", [{ criterion: "sc-12-1", passed: false }])]),
    );
    expect(trade.regressed).toBe(false);
    expect(trade.broken).toEqual([]);
  });
});

// ── Carrying the regression across the declared port ────────────────

describe("anchor-regression marker", () => {
  it("round-trips a broken-anchor list through a verdict summary", () => {
    const broken = ["unit-test::sc-12-2", "playwright::sc-12-4"];
    const summary = encodeAnchorRegression(broken, describeAnchorTrade({
      fixed: ["unit-test::sc-12-9"],
      broken,
      unobserved: [],
      regressed: true,
    }));
    // The ids CONTAIN `::`, so a decoder that split on the separator would return halves.
    expect(decodeAnchorRegression(summary)).toEqual([...broken].sort());
    expect(summary).toContain("unit-test::sc-12-9");
  });

  it("encodes nothing when nothing broke, so a clean summary stays clean", () => {
    expect(encodeAnchorRegression([], "all criteria met")).toBe("all criteria met");
    expect(decodeAnchorRegression("all criteria met")).toEqual([]);
  });

  it("ignores a summary that merely mentions the word", () => {
    expect(decodeAnchorRegression("no anchor-regression was detected")).toEqual([]);
  });
});
