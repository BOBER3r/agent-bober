/**
 * Colocated unit tests for the eval-result artifact renderer.
 *
 * Placed at src/orchestrator/checkpoints/renderers/eval-result.test.ts per the
 * COLOCATION HARD CONSTRAINT established in Sprints 8/9/10 — NOT in tests/orchestrator/.
 *
 * Sprint 11: s11-c7 (eval-result renderer — overallResult, score, failing criteria, strategies, cap).
 */

import { describe, it, expect } from "vitest";
import { renderEvalResult } from "./eval-result.js";

const SAMPLE_EVAL_PASS = {
  type: "eval-result",
  overallResult: "pass",
  score: { criteriaPassed: 9, criteriaFailed: 0, criteriaTotal: 9 },
  strategyResults: [
    { strategy: "typecheck", required: true, result: "pass" },
    { strategy: "lint", required: true, result: "pass" },
    { strategy: "build", required: true, result: "pass" },
    { strategy: "unit-test", required: true, result: "pass" },
  ],
  criteriaResults: [
    { criterionId: "s10-c1", result: "pass", evidence: "PR created correctly" },
    { criterionId: "s10-c2", result: "pass", evidence: "Approve comment works" },
  ],
  summary: "All 9 criteria passed on iteration 1.",
};

const SAMPLE_EVAL_FAIL = {
  type: "eval-result",
  overallResult: "fail",
  score: { criteriaPassed: 7, criteriaFailed: 2, criteriaTotal: 9 },
  strategyResults: [
    { strategy: "typecheck", required: true, result: "pass" },
    { strategy: "unit-test", required: true, result: "fail" },
  ],
  criteriaResults: [
    { criterionId: "s10-c1", result: "pass", evidence: "OK" },
    { criterionId: "s10-c7", result: "fail", feedback: "Missing test for rate-limit backoff" },
    { criterionId: "s10-c8", result: "fail", feedback: "PR body checkbox not updating" },
  ],
  summary: "2 criteria failed.",
};

describe("renderEvalResult (s11-c7)", () => {
  it("shows overallResult in uppercase for pass", () => {
    const out = renderEvalResult(SAMPLE_EVAL_PASS);
    expect(out).toContain("## Eval Result: **PASS**");
  });

  it("shows overallResult in uppercase for fail", () => {
    const out = renderEvalResult(SAMPLE_EVAL_FAIL);
    expect(out).toContain("## Eval Result: **FAIL**");
  });

  it("handles boolean `passed` field (no overallResult)", () => {
    const out = renderEvalResult({ type: "eval-result", passed: true });
    expect(out).toContain("**PASS**");

    const out2 = renderEvalResult({ type: "eval-result", passed: false });
    expect(out2).toContain("**FAIL**");
  });

  it("shows score passed/failed/total", () => {
    const out = renderEvalResult(SAMPLE_EVAL_PASS);
    expect(out).toContain("**Score:** 9/9 (0 failed)");
  });

  it("shows strategy results (exit codes only, no full stdout)", () => {
    const out = renderEvalResult(SAMPLE_EVAL_PASS);
    expect(out).toContain("### Strategies");
    expect(out).toContain("`typecheck`");
    expect(out).toContain("**pass**");
    // Should NOT include any "stdout" field content
    expect(out).not.toContain("stdout");
  });

  it("shows failing criteria count and details", () => {
    const out = renderEvalResult(SAMPLE_EVAL_FAIL);
    expect(out).toContain("### Failing criteria (2)");
    expect(out).toContain("**s10-c7**");
    expect(out).toContain("Missing test for rate-limit backoff");
    expect(out).toContain("**s10-c8**");
    expect(out).toContain("PR body checkbox not updating");
  });

  it("shows 'All criteria passed' when no failures", () => {
    const out = renderEvalResult(SAMPLE_EVAL_PASS);
    expect(out).toContain("### Failing criteria (0)");
    expect(out).toContain("_All criteria passed._");
  });

  it("shows summary section when present", () => {
    const out = renderEvalResult(SAMPLE_EVAL_PASS);
    expect(out).toContain("### Summary");
    expect(out).toContain("All 9 criteria passed on iteration 1.");
  });

  it("returns markdown (not JSON, not plain text)", () => {
    const out = renderEvalResult(SAMPLE_EVAL_PASS);
    expect(out).toMatch(/^##\s/m);
    expect(out).not.toMatch(/^\s*\{/);
  });

  it("handles missing fields gracefully", () => {
    const out = renderEvalResult({ type: "eval-result" });
    expect(out).toContain("## Eval Result: **UNKNOWN**");
    expect(out).toContain("**Score:** 0/0");
  });

  it("caps at 300 lines when output is large", () => {
    const manyCriteria = Array.from({ length: 400 }, (_, i) => ({
      criterionId: `c-${i}`,
      result: "fail",
      feedback: `Criterion ${i} failed because of reason ${i}`,
    }));
    const out = renderEvalResult({ ...SAMPLE_EVAL_FAIL, criteriaResults: manyCriteria });
    const lineCount = out.split("\n").length;
    expect(lineCount).toBeLessThanOrEqual(301);
    expect(out).toMatch(/more lines truncated/);
  });
});
