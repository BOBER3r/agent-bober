/**
 * Colocated unit tests for the renderer registry.
 *
 * Placed at src/orchestrator/checkpoints/renderers/registry.test.ts per the
 * COLOCATION HARD CONSTRAINT established in Sprints 8/9/10 — NOT in tests/orchestrator/.
 *
 * Sprint 11: s11-c2 (registry dispatch + unknown-type fallback).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, renderGeneric, registerRenderer, getRenderer } from "./registry.js";

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Registry dispatch ──────────────────────────────────────────────────────────

describe("render registry (s11-c2)", () => {
  it("dispatches plan-spec type to renderPlanSpec", () => {
    const out = render({
      type: "plan-spec",
      specId: "spec-123",
      title: "My Plan",
      status: "ready",
      features: [],
      assumptions: [],
      outOfScope: [],
    });
    expect(out).toContain("## Plan: My Plan");
  });

  it("dispatches research type to renderResearch", () => {
    const out = render({ type: "research", content: "# My Research\n\nbody text" });
    expect(out).toContain("## Research: My Research");
  });

  it("dispatches sprint-contract type to renderSprintContract", () => {
    const out = render({
      type: "sprint-contract",
      contractId: "sprint-test-1",
      feature: "Test Feature",
      successCriteria: [],
      expectedChanges: [],
      dependsOn: [],
    });
    expect(out).toContain("## Sprint Contract: `sprint-test-1`");
  });

  it("dispatches eval-result type to renderEvalResult", () => {
    const out = render({
      type: "eval-result",
      overallResult: "pass",
      score: { criteriaPassed: 5, criteriaFailed: 0, criteriaTotal: 5 },
      strategyResults: [],
      criteriaResults: [],
    });
    expect(out).toContain("## Eval Result: **PASS**");
  });

  it("dispatches code-review type to renderCodeReview", () => {
    const out = render({
      type: "code-review",
      summary: "Review looks good overall.",
      critical: [],
      important: [],
      minor: [],
      approvedAreas: ["src/utils/"],
    });
    expect(out).toContain("## Code Review");
    expect(out).toContain("Review looks good overall.");
  });

  it("dispatches sprint-summary type to renderSprintSummary", () => {
    const out = render({
      type: "sprint-summary",
      contract: { contractId: "sprint-42", title: "Build X" },
      evaluation: { passed: true },
      generatorResult: { filesChanged: [], commit: "abc123" },
    });
    expect(out).toContain("## Sprint Summary:");
    expect(out).toContain("sprint-42");
  });

  it("dispatches pipeline-summary type to renderPipelineSummary", () => {
    const out = render({
      type: "pipeline-summary",
      success: true,
      completedSprints: ["s1", "s2"],
      failedSprints: [],
      duration: 60000,
      spec: { title: "My Pipeline" },
    });
    expect(out).toContain("## Pipeline Summary");
    expect(out).toContain("My Pipeline");
  });

  it("falls back to generic JSON dump + writes stderr warning for unknown type", () => {
    const warns: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((s) => {
      warns.push(String(s));
      return true as unknown as boolean;
    });

    const out = render({ type: "nonsense-type-xyz", x: 1 });

    expect(out).toContain("```json");
    expect(out).toContain("nonsense-type-xyz");
    expect(warns.join("")).toMatch(/no entry for artifact\.type=/);

    spy.mockRestore();
  });

  it("falls back to generic dump + writes warning when type is null/missing", () => {
    const warns: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((s) => {
      warns.push(String(s));
      return true as unknown as boolean;
    });

    const out = render({ x: 1, y: 2 });
    expect(out).toContain("```json");
    expect(warns.join("")).toMatch(/no entry for artifact\.type=/);

    spy.mockRestore();
  });
});

// ── registerRenderer / getRenderer round-trip ─────────────────────────────────

describe("registerRenderer / getRenderer (s11-c2)", () => {
  it("registers and retrieves a custom renderer", () => {
    const mockRenderer = vi.fn(() => "## Custom Renderer");
    registerRenderer("custom-test-type", mockRenderer);

    const retrieved = getRenderer("custom-test-type");
    expect(retrieved).toBe(mockRenderer);
  });

  it("render() dispatches to a newly registered renderer", () => {
    registerRenderer("custom-dispatch-test", () => "## Dispatched!");
    const out = render({ type: "custom-dispatch-test" });
    expect(out).toBe("## Dispatched!");
  });
});

// ── renderGeneric ─────────────────────────────────────────────────────────────

describe("renderGeneric", () => {
  it("returns a json code block with safe fields only", () => {
    const out = renderGeneric({
      type: "unknown",
      path: "/some/path",
      summary: "brief",
      fullContent: "a".repeat(100_000), // large field — must be dropped
    });
    expect(out).toMatch(/```json/);
    expect(out).toContain("unknown");
    expect(out).toContain("/some/path");
    expect(out).not.toContain("aaaa");
  });

  it("handles null artifact gracefully", () => {
    const out = renderGeneric(null);
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  it("handles non-object artifact gracefully", () => {
    const out = renderGeneric("plain string");
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });
});
