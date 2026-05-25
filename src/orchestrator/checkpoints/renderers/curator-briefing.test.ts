/**
 * Colocated unit tests for the curator-briefing artifact renderer.
 *
 * Placed at src/orchestrator/checkpoints/renderers/curator-briefing.test.ts per the
 * COLOCATION HARD CONSTRAINT established in Sprints 8/9/10 — NOT in tests/orchestrator/.
 *
 * Sprint 11: s11-c10 (curator-briefing renderer).
 */

import { describe, it, expect } from "vitest";
import { renderCuratorBriefing } from "./curator-briefing.js";

const SAMPLE_BRIEFING = `# Sprint Briefing: Disk-marker blocking checkpoint

**Contract:** \`sprint-spec-20260524-bober-vision-9\`
**Generated:** 2026-05-24T10:00:00Z
**Tier:** 2

---

## 0. Sprint Summary

Build the DiskCheckpointMechanism with write, poll, and timeout flows.
It should handle both approved and rejected markers correctly.
This includes cleanup of stale markers from prior runs.

## 1. Target Files

See \`src/orchestrator/checkpoints/mechanisms/disk.ts\` for the main file.
Also \`.bober/contracts/sprint-spec-9.json\` for the contract.

## 2. Patterns to Follow

Follow the pattern established in \`src/orchestrator/checkpoints/mechanisms/cli.ts\`.

## 3. Testing Patterns

Tests go in \`src/orchestrator/checkpoints/mechanisms/disk.test.ts\`.
`;

describe("renderCuratorBriefing", () => {
  it("extracts title from H1", () => {
    const out = renderCuratorBriefing({ type: "curator-briefing", content: SAMPLE_BRIEFING });
    expect(out).toContain("## Curator Briefing: Sprint Briefing: Disk-marker blocking checkpoint");
  });

  it("extracts contract id", () => {
    const out = renderCuratorBriefing({ type: "curator-briefing", content: SAMPLE_BRIEFING });
    expect(out).toContain("`sprint-spec-20260524-bober-vision-9`");
  });

  it("counts H2 sections", () => {
    const out = renderCuratorBriefing({ type: "curator-briefing", content: SAMPLE_BRIEFING });
    // 4 H2 sections: 0, 1, 2, 3
    expect(out).toContain("**Sections:** 4");
  });

  it("shows first 3 lines of sprint summary section", () => {
    const out = renderCuratorBriefing({ type: "curator-briefing", content: SAMPLE_BRIEFING });
    expect(out).toContain("### Sprint summary (first 3 lines)");
    expect(out).toContain("Build the DiskCheckpointMechanism");
  });

  it("counts file path citations", () => {
    const out = renderCuratorBriefing({ type: "curator-briefing", content: SAMPLE_BRIEFING });
    // Should find src/ and .bober paths
    expect(out).toContain("**File paths cited:**");
    // 3 paths referenced: disk.ts, sprint-spec-9.json, cli.ts, disk.test.ts = 4
    const match = /\*\*File paths cited:\*\* (\d+)/.exec(out);
    expect(match).not.toBeNull();
    const count = parseInt(match![1], 10);
    expect(count).toBeGreaterThan(0);
  });

  it("returns markdown (not JSON, not plain text)", () => {
    const out = renderCuratorBriefing({ type: "curator-briefing", content: SAMPLE_BRIEFING });
    expect(out).toMatch(/^##\s/m);
    expect(out).not.toMatch(/^\s*\{/);
  });

  it("handles empty content gracefully", () => {
    const out = renderCuratorBriefing({ type: "curator-briefing", content: "" });
    expect(out).toContain("## Curator Briefing: (untitled briefing)");
    expect(typeof out).toBe("string");
  });

  it("output never exceeds 300 lines regardless of input size", () => {
    // Renderer extracts only header fields + first 3 summary lines, so output is always small.
    const huge = SAMPLE_BRIEFING + "\nline\n".repeat(400);
    const out = renderCuratorBriefing({ type: "curator-briefing", content: huge, path: "/briefing.md" });
    const lineCount = out.split("\n").length;
    expect(lineCount).toBeLessThanOrEqual(300);
  });
});
