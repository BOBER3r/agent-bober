/**
 * Colocated unit tests for the pipeline-summary artifact renderer.
 *
 * Placed at src/orchestrator/checkpoints/renderers/pipeline-summary.test.ts per the
 * COLOCATION HARD CONSTRAINT established in Sprints 8/9/10 — NOT in tests/orchestrator/.
 *
 * Sprint 11: s11-c10 (pipeline-summary renderer).
 */

import { describe, it, expect } from "vitest";
import { renderPipelineSummary } from "./pipeline-summary.js";

const SAMPLE_PIPELINE = {
  type: "pipeline-summary",
  success: true,
  completedSprints: ["sprint-1", "sprint-2", "sprint-3"],
  failedSprints: [],
  duration: 3 * 60 * 60 * 1000 + 15 * 60 * 1000, // 3h 15m
  spec: {
    title: "Bober Vision: Multi-mode software engineering teammate",
    specId: "spec-20260524-bober-vision",
  },
  currentSprint: "sprint-spec-20260524-bober-vision-11",
  totalIterationsUsed: 14,
};

describe("renderPipelineSummary", () => {
  it("shows spec title", () => {
    const out = renderPipelineSummary(SAMPLE_PIPELINE);
    expect(out).toContain("**Spec:** Bober Vision: Multi-mode software engineering teammate");
  });

  it("shows SUCCESS when success=true", () => {
    const out = renderPipelineSummary(SAMPLE_PIPELINE);
    expect(out).toContain("**Result:** **SUCCESS**");
  });

  it("shows FAILED when success=false", () => {
    const out = renderPipelineSummary({ ...SAMPLE_PIPELINE, success: false });
    expect(out).toContain("**Result:** **FAILED**");
  });

  it("formats duration correctly", () => {
    const out = renderPipelineSummary(SAMPLE_PIPELINE);
    expect(out).toContain("3h 15m 0s");
  });

  it("shows completed and failed sprint counts", () => {
    const out = renderPipelineSummary(SAMPLE_PIPELINE);
    expect(out).toContain("**Completed:** 3");
    expect(out).toContain("**Failed:** 0");
    expect(out).toContain("**Total:** 3");
  });

  it("shows current sprint when present", () => {
    const out = renderPipelineSummary(SAMPLE_PIPELINE);
    expect(out).toContain("**Current sprint:** sprint-spec-20260524-bober-vision-11");
  });

  it("shows total iterations used when present", () => {
    const out = renderPipelineSummary(SAMPLE_PIPELINE);
    expect(out).toContain("**Total iterations used:** 14");
  });

  it("returns markdown (not JSON, not plain text)", () => {
    const out = renderPipelineSummary(SAMPLE_PIPELINE);
    expect(out).toMatch(/^##\s/m);
    expect(out).not.toMatch(/^\s*\{/);
  });

  it("handles missing fields gracefully", () => {
    const out = renderPipelineSummary({ type: "pipeline-summary" });
    expect(out).toContain("## Pipeline Summary");
    expect(out).toContain("**Completed:** 0");
    expect(out).toContain("**Failed:** 0");
  });

  it("handles failed sprints in count", () => {
    const out = renderPipelineSummary({
      ...SAMPLE_PIPELINE,
      completedSprints: ["s1", "s2"],
      failedSprints: ["s3"],
      success: false,
    });
    expect(out).toContain("**Completed:** 2");
    expect(out).toContain("**Failed:** 1");
    expect(out).toContain("**Total:** 3");
  });

  it("formats short duration (seconds only)", () => {
    const out = renderPipelineSummary({ ...SAMPLE_PIPELINE, duration: 45000 }); // 45s
    expect(out).toContain("45s");
  });

  it("formats medium duration (minutes)", () => {
    const out = renderPipelineSummary({ ...SAMPLE_PIPELINE, duration: 3 * 60 * 1000 + 20000 }); // 3m 20s
    expect(out).toContain("3m 20s");
  });
});
