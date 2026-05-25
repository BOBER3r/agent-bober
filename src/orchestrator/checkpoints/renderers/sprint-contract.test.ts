/**
 * Colocated unit tests for the sprint-contract artifact renderer.
 *
 * Placed at src/orchestrator/checkpoints/renderers/sprint-contract.test.ts per the
 * COLOCATION HARD CONSTRAINT established in Sprints 8/9/10 — NOT in tests/orchestrator/.
 *
 * Sprint 11: s11-c5 (sprint-contract renderer — contractId, feature, changes, criteria, deps, cap).
 */

import { describe, it, expect } from "vitest";
import { renderSprintContract } from "./sprint-contract.js";

const SAMPLE_CONTRACT = {
  type: "sprint-contract",
  contractId: "sprint-spec-20260524-bober-vision-10",
  feature: "GitHub PR-native checkpoint mechanism",
  title: "PR mechanism sprint",
  expectedChanges: [
    { path: "src/orchestrator/checkpoints/mechanisms/pr.ts", action: "create" },
    { path: "src/orchestrator/checkpoints/mechanisms/pr.test.ts", action: "create" },
    { path: "src/orchestrator/checkpoints/registry.ts", action: "modify" },
  ],
  successCriteria: [
    { criterionId: "s10-c1", description: "PR is created on first request" },
    { criterionId: "s10-c2", description: "Approval via comment works" },
    { criterionId: "s10-c3", description: "Rejection via comment works" },
    { criterionId: "s10-c4", description: "Fallback to disk when gh unavailable" },
    { criterionId: "s10-c5", description: "getCheckpointMechanismFor override" },
    { criterionId: "s10-c6", description: "Edit comment works" },
  ],
  dependsOn: ["sprint-spec-20260524-bober-vision-9"],
};

describe("renderSprintContract (s11-c5)", () => {
  it("shows contractId", () => {
    const out = renderSprintContract(SAMPLE_CONTRACT);
    expect(out).toContain("## Sprint Contract: `sprint-spec-20260524-bober-vision-10`");
  });

  it("shows feature/title", () => {
    const out = renderSprintContract(SAMPLE_CONTRACT);
    expect(out).toContain("GitHub PR-native checkpoint mechanism");
  });

  it("lists expectedChanges paths", () => {
    const out = renderSprintContract(SAMPLE_CONTRACT);
    expect(out).toContain("### Expected changes (3)");
    expect(out).toContain("`src/orchestrator/checkpoints/mechanisms/pr.ts`");
    expect(out).toContain("(create)");
  });

  it("shows successCriteria count and first 5", () => {
    const out = renderSprintContract(SAMPLE_CONTRACT);
    expect(out).toContain("### Success criteria (6, first 5 shown)");
    expect(out).toContain("**s10-c1**");
    expect(out).toContain("**s10-c5**");
    // s10-c6 is the 6th — should NOT appear in output
    expect(out).not.toContain("**s10-c6**");
  });

  it("shows dependsOn", () => {
    const out = renderSprintContract(SAMPLE_CONTRACT);
    expect(out).toContain("### Depends on");
    expect(out).toContain("`sprint-spec-20260524-bober-vision-9`");
  });

  it("returns markdown (not JSON, not plain text)", () => {
    const out = renderSprintContract(SAMPLE_CONTRACT);
    expect(out).toMatch(/^##\s/m);
    expect(out).not.toMatch(/^\s*\{/);
  });

  it("handles missing optional fields gracefully", () => {
    const out = renderSprintContract({ type: "sprint-contract", contractId: "c-minimal" });
    expect(out).toContain("## Sprint Contract: `c-minimal`");
    expect(out).toContain("### Expected changes (0)");
    expect(out).toContain("### Success criteria (0");
  });

  it("caps at 200 lines when output is large (many expectedChanges)", () => {
    // Generate 250 expectedChanges entries — each becomes a list item, triggering the cap
    const manyChanges = Array.from({ length: 250 }, (_, i) => ({
      path: `src/file-${i}.ts`,
      action: "create",
    }));
    const out = renderSprintContract({ ...SAMPLE_CONTRACT, expectedChanges: manyChanges });
    const lineCount = out.split("\n").length;
    expect(lineCount).toBeLessThanOrEqual(201);
    expect(out).toMatch(/more lines truncated/);
  });
});
