/**
 * Colocated unit tests for the code-review artifact renderer.
 *
 * Placed at src/orchestrator/checkpoints/renderers/code-review.test.ts per the
 * COLOCATION HARD CONSTRAINT established in Sprints 8/9/10 — NOT in tests/orchestrator/.
 *
 * Sprint 11: s11-c8 (code-review renderer — summary, critical+evidence, counts, approved areas, cap).
 */

import { describe, it, expect } from "vitest";
import { renderCodeReview } from "./code-review.js";

const SAMPLE_REVIEW = {
  type: "code-review",
  reviewId: "review-sprint-10-1",
  contractId: "sprint-spec-20260524-bober-vision-10",
  timestamp: "2026-05-24T12:00:00Z",
  summary: "Overall the PR mechanism is well-implemented with solid test coverage.",
  critical: [
    {
      description: "Rate-limit backoff not tested with real exponential values",
      evidence: [{ path: "src/orchestrator/checkpoints/mechanisms/pr.test.ts", line: 250, snippet: "// TODO" }],
      antiPattern: "Missing test coverage for critical path",
    },
    {
      description: "GhClient interface leaks execa import type",
      evidence: [{ path: "src/orchestrator/checkpoints/mechanisms/pr.ts", line: 30, snippet: "import { execa }" }],
    },
  ],
  important: [
    {
      description: "prReady call could be made outside setTimeout",
      evidence: [{ path: "src/orchestrator/checkpoints/mechanisms/pr.ts", line: 260, snippet: "setTimeout" }],
    },
  ],
  minor: [
    {
      description: "Docstring for renderPrBody could be more detailed",
      evidence: [{ path: "src/orchestrator/checkpoints/mechanisms/pr.ts", line: 343, snippet: "/** Render" }],
    },
  ],
  approvedAreas: ["parseSignals correctness", "GhClient mock injection", "Availability check chain"],
};

describe("renderCodeReview (s11-c8)", () => {
  it("shows the summary", () => {
    const out = renderCodeReview(SAMPLE_REVIEW);
    expect(out).toContain("### Summary");
    expect(out).toContain("Overall the PR mechanism is well-implemented");
  });

  it("shows contractId", () => {
    const out = renderCodeReview(SAMPLE_REVIEW);
    expect(out).toContain("`sprint-spec-20260524-bober-vision-10`");
  });

  it("shows critical count", () => {
    const out = renderCodeReview(SAMPLE_REVIEW);
    expect(out).toContain("**Critical:** 2");
  });

  it("shows important count", () => {
    const out = renderCodeReview(SAMPLE_REVIEW);
    expect(out).toContain("**Important:** 1");
  });

  it("shows minor count", () => {
    const out = renderCodeReview(SAMPLE_REVIEW);
    expect(out).toContain("**Minor:** 1");
  });

  it("shows first 5 critical findings with file:line evidence", () => {
    const out = renderCodeReview(SAMPLE_REVIEW);
    expect(out).toContain("### Critical findings (first 5)");
    // Must cite evidence file:line per AGENTS.md requirement
    expect(out).toContain("pr.test.ts:250");
    expect(out).toContain("pr.ts:30");
    expect(out).toContain("Rate-limit backoff not tested");
  });

  it("shows approved areas", () => {
    const out = renderCodeReview(SAMPLE_REVIEW);
    expect(out).toContain("### Approved areas");
    expect(out).toContain("parseSignals correctness");
    expect(out).toContain("GhClient mock injection");
  });

  it("returns markdown (not JSON, not plain text)", () => {
    const out = renderCodeReview(SAMPLE_REVIEW);
    expect(out).toMatch(/^##\s/m);
    expect(out).not.toMatch(/^\s*\{/);
  });

  it("handles missing fields gracefully", () => {
    const out = renderCodeReview({ type: "code-review" });
    expect(out).toContain("## Code Review");
    expect(out).toContain("**Critical:** 0");
    expect(out).toContain("**Important:** 0");
    expect(out).toContain("**Minor:** 0");
  });

  it("shows at most 5 critical findings even when more exist", () => {
    const manyCritical = Array.from({ length: 10 }, (_, i) => ({
      description: `Critical issue ${i}`,
      evidence: [{ path: `src/file${i}.ts`, line: i + 1, snippet: "code" }],
    }));
    const out = renderCodeReview({ ...SAMPLE_REVIEW, critical: manyCritical });
    // Should show count (10) but only first 5 in detail
    expect(out).toContain("**Critical:** 10");
    expect(out).toContain("Critical issue 4"); // 5th (0-indexed)
    expect(out).not.toContain("Critical issue 5"); // 6th — not shown
  });

  it("caps at 300 lines when output is large", () => {
    const manyAreas = Array.from({ length: 400 }, (_, i) => `Approved area ${i}`);
    const out = renderCodeReview({ ...SAMPLE_REVIEW, approvedAreas: manyAreas });
    const lineCount = out.split("\n").length;
    expect(lineCount).toBeLessThanOrEqual(301);
    expect(out).toMatch(/more lines truncated/);
  });
});
