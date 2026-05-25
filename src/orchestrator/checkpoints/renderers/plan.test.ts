/**
 * Colocated unit tests for the plan-spec artifact renderer.
 *
 * Placed at src/orchestrator/checkpoints/renderers/plan.test.ts per the
 * COLOCATION HARD CONSTRAINT established in Sprints 8/9/10 — NOT in tests/orchestrator/.
 *
 * Sprint 11: s11-c4 (plan renderer — title, scores, counts, lists, cap).
 */

import { describe, it, expect } from "vitest";
import { renderPlanSpec } from "./plan.js";

const SAMPLE_PLAN = {
  type: "plan-spec",
  specId: "spec-20260524-bober-vision",
  title: "Bober Vision: Multi-mode software engineering teammate",
  status: "in-progress",
  ambiguityScore: 5,
  features: [{ featureId: "feat-1" }, { featureId: "feat-2" }, { featureId: "feat-3" }],
  sprints: [{ sprintNumber: 1 }, { sprintNumber: 2 }],
  assumptions: [
    "The user has Node 20+.",
    "ESM-only codebase.",
    "Vitest for tests.",
  ],
  outOfScope: [
    "No GUI dashboard.",
    "No cloud hosting.",
  ],
};

describe("renderPlanSpec (s11-c4)", () => {
  it("shows the plan title", () => {
    const out = renderPlanSpec(SAMPLE_PLAN);
    expect(out).toContain("## Plan: Bober Vision: Multi-mode software engineering teammate");
  });

  it("shows specId", () => {
    const out = renderPlanSpec(SAMPLE_PLAN);
    expect(out).toContain("spec-20260524-bober-vision");
  });

  it("shows ambiguity score", () => {
    const out = renderPlanSpec(SAMPLE_PLAN);
    expect(out).toContain("**Ambiguity:** 5/10");
  });

  it("shows features count", () => {
    const out = renderPlanSpec(SAMPLE_PLAN);
    expect(out).toContain("**Features:** 3");
  });

  it("shows inline sprints count", () => {
    const out = renderPlanSpec(SAMPLE_PLAN);
    expect(out).toContain("**Sprints (inline):** 2");
  });

  it("shows assumptions list", () => {
    const out = renderPlanSpec(SAMPLE_PLAN);
    expect(out).toContain("### Assumptions (3)");
    expect(out).toContain("- The user has Node 20+.");
  });

  it("shows out-of-scope list", () => {
    const out = renderPlanSpec(SAMPLE_PLAN);
    expect(out).toContain("### Out of scope (2)");
    expect(out).toContain("- No GUI dashboard.");
  });

  it("returns markdown (not JSON, not plain text)", () => {
    const out = renderPlanSpec(SAMPLE_PLAN);
    expect(out).toMatch(/^##\s/m);
    expect(out).not.toMatch(/^\s*\{/);
  });

  it("handles missing optional fields gracefully", () => {
    const out = renderPlanSpec({ type: "plan-spec", title: "Minimal Plan" });
    expect(out).toContain("## Plan: Minimal Plan");
    expect(out).toContain("**Features:** 0");
    expect(out).toContain("**Sprints (inline):** 0");
    expect(out).toContain("### Assumptions (0)");
    expect(out).toContain("### Out of scope (0)");
  });

  it("caps at 300 lines when output is large", () => {
    const manyAssumptions = Array.from({ length: 400 }, (_, i) => `Assumption ${i}`);
    const out = renderPlanSpec({ ...SAMPLE_PLAN, assumptions: manyAssumptions });
    const lineCount = out.split("\n").length;
    expect(lineCount).toBeLessThanOrEqual(301);
    expect(out).toMatch(/more lines truncated/);
  });
});
