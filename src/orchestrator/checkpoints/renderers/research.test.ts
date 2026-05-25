/**
 * Colocated unit tests for the research artifact renderer.
 *
 * Placed at src/orchestrator/checkpoints/renderers/research.test.ts per the
 * COLOCATION HARD CONSTRAINT established in Sprints 8/9/10 — NOT in tests/orchestrator/.
 *
 * Sprint 11: s11-c3 (research renderer — title, counts, executive summary, cap).
 */

import { describe, it, expect } from "vitest";
import { renderResearch } from "./research.js";

const SAMPLE_RESEARCH = `# Research: My Feature Investigation

**Status:** complete
**Files Explored:** 12
**Generated:** 2026-01-01

---

## Architecture Overview

This section covers the main patterns.

## Assumptions

- The codebase uses TypeScript.
- ESM imports throughout.
- Tests are colocated.

## Existing Patterns

- Pattern A
- Pattern B
- Pattern C

## Key Findings

- Finding one
- Finding two
`;

describe("renderResearch (s11-c3)", () => {
  it("extracts title from H1", () => {
    const out = renderResearch({ type: "research", content: SAMPLE_RESEARCH });
    // H1 is "Research: My Feature Investigation" — renderer prefixes "## Research: "
    expect(out).toContain("## Research: Research: My Feature Investigation");
  });

  it("counts assumptions correctly", () => {
    const out = renderResearch({ type: "research", content: SAMPLE_RESEARCH });
    expect(out).toContain("**Assumptions:** 3");
  });

  it("extracts files explored from inline count", () => {
    const out = renderResearch({ type: "research", content: SAMPLE_RESEARCH });
    expect(out).toContain("**Files explored:** 12");
  });

  it("counts key findings", () => {
    const out = renderResearch({ type: "research", content: SAMPLE_RESEARCH });
    // 3 Existing Patterns + 2 Key Findings = 5
    expect(out).toContain("**Key findings:** 5");
  });

  it("shows first 3 lines of executive summary (after first ---)", () => {
    const out = renderResearch({ type: "research", content: SAMPLE_RESEARCH });
    expect(out).toContain("### Executive summary");
    // First non-blank line after --- is "## Architecture Overview"
    expect(out).toContain("Architecture Overview");
  });

  it("returns markdown (not JSON, not plain text)", () => {
    const out = renderResearch({ type: "research", content: "# X\nbody" });
    expect(out).toMatch(/^##\s/m);
    expect(out).not.toMatch(/^\s*\{/);
  });

  it("handles artifact with no content gracefully", () => {
    const out = renderResearch({ type: "research" });
    expect(out).toContain("## Research: (untitled research)");
    expect(typeof out).toBe("string");
  });

  it("handles artifact with text field instead of content", () => {
    const out = renderResearch({ type: "research", text: "# Text Field Title\n\nbody" });
    expect(out).toContain("## Research: Text Field Title");
  });

  it("output never exceeds 500 lines regardless of input size", () => {
    // Large content — renderer extracts only title, counts, 3 summary lines
    // so output is always small. Verifies the cap is not exceeded.
    const huge = "# X\n" + "line\n".repeat(600);
    const out = renderResearch({ type: "research", content: huge, path: "/x.md" });
    const lineCount = out.split("\n").length;
    expect(lineCount).toBeLessThanOrEqual(500);
  });

  it("does not truncate when content is under 500 lines", () => {
    const small = "# Small\n\nbody line 1\nbody line 2\n";
    const out = renderResearch({ type: "research", content: small });
    expect(out).not.toMatch(/more lines truncated/);
  });
});
