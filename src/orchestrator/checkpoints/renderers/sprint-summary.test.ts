/**
 * Colocated unit tests for the sprint-summary artifact renderer.
 *
 * Placed at src/orchestrator/checkpoints/renderers/sprint-summary.test.ts per the
 * COLOCATION HARD CONSTRAINT established in Sprints 8/9/10 — NOT in tests/orchestrator/.
 *
 * Sprint 11: s11-c10 (sprint-summary renderer).
 */

import { describe, it, expect } from "vitest";
import { renderSprintSummary } from "./sprint-summary.js";

const SAMPLE_SPRINT_SUMMARY = {
  type: "sprint-summary",
  contract: {
    contractId: "sprint-spec-20260524-bober-vision-10",
    title: "PR mechanism",
    feature: "GitHub PR-native checkpoint mechanism",
  },
  evaluation: {
    passed: true,
    overallResult: "pass",
    passedOnIteration: 1,
  },
  generatorResult: {
    filesChanged: [
      { path: "src/orchestrator/checkpoints/mechanisms/pr.ts", action: "created" },
      { path: "src/orchestrator/checkpoints/mechanisms/pr.test.ts", action: "created" },
    ],
    commit: "d3264d1",
  },
};

describe("renderSprintSummary", () => {
  it("shows contractId", () => {
    const out = renderSprintSummary(SAMPLE_SPRINT_SUMMARY);
    expect(out).toContain("## Sprint Summary: `sprint-spec-20260524-bober-vision-10`");
  });

  it("shows feature/title", () => {
    const out = renderSprintSummary(SAMPLE_SPRINT_SUMMARY);
    expect(out).toContain("GitHub PR-native checkpoint mechanism");
  });

  it("shows evaluation result", () => {
    const out = renderSprintSummary(SAMPLE_SPRINT_SUMMARY);
    expect(out).toContain("**Result:** **PASS**");
  });

  it("shows passedOnIteration", () => {
    const out = renderSprintSummary(SAMPLE_SPRINT_SUMMARY);
    expect(out).toContain("**Iteration:** 1");
  });

  it("shows commit hash", () => {
    const out = renderSprintSummary(SAMPLE_SPRINT_SUMMARY);
    expect(out).toContain("**Commit:** `d3264d1`");
  });

  it("lists files changed", () => {
    const out = renderSprintSummary(SAMPLE_SPRINT_SUMMARY);
    expect(out).toContain("### Files changed (2)");
    expect(out).toContain("`src/orchestrator/checkpoints/mechanisms/pr.ts`");
  });

  it("returns markdown (not JSON, not plain text)", () => {
    const out = renderSprintSummary(SAMPLE_SPRINT_SUMMARY);
    expect(out).toMatch(/^##\s/m);
    expect(out).not.toMatch(/^\s*\{/);
  });

  it("handles missing fields gracefully", () => {
    const out = renderSprintSummary({ type: "sprint-summary" });
    expect(out).toContain("## Sprint Summary: `unknown`");
    expect(out).toContain("**Result:** **UNKNOWN**");
    expect(out).toContain("### Files changed (0)");
  });

  it("handles failed evaluation", () => {
    const failing = { ...SAMPLE_SPRINT_SUMMARY, evaluation: { passed: false } };
    const out = renderSprintSummary(failing);
    expect(out).toContain("**Result:** **FAIL**");
  });
});
