/**
 * Unit tests for the pure (side-effect-free) sprint cycle.
 */

import { describe, it, expect, vi } from "vitest";

import {
  runPureSprint,
  type PureSprintDeps,
  type SprintInput,
  type GenerationResult,
} from "./pure-sprint.js";
import { createContract } from "../../contracts/sprint-contract.js";
import type { EvalResult } from "../../contracts/eval-result.js";
import type { PlanSpec } from "../../contracts/spec.js";

// ── Fixtures ─────────────────────────────────────────────────────────

function makeSpec(): PlanSpec {
  const now = "2026-06-04T12:00:00.000Z";
  return {
    specId: "spec-1",
    version: 1,
    title: "Test Spec",
    description: "desc",
    status: "in-progress",
    mode: "brownfield",
    features: [],
    assumptions: [],
    outOfScope: [],
    clarificationQuestions: [],
    resolvedClarifications: [],
    techStack: [],
    nonFunctionalRequirements: [],
    constraints: [],
    createdAt: now,
    updatedAt: now,
  };
}

function makeInput(maxIterations = 3): SprintInput {
  const contract = createContract(
    "Build it",
    "Builds the thing",
    [{ criterionId: "c1", description: "the feature works end to end as specified", verificationMethod: "agent-evaluation" }],
    { specId: "spec-1", sprintNumber: 1 },
  );
  return { contract, spec: makeSpec(), maxIterations, priorPassed: [] };
}

function verdict(passed: boolean, evaluator = "panel"): EvalResult {
  return {
    evaluator,
    passed,
    details: [],
    summary: passed ? "all good" : "criteria unmet",
    feedback: passed ? "" : "fix the failing criterion",
    timestamp: "2026-06-04T12:00:00.000Z",
  };
}

const okGen: GenerationResult = { blocked: false, summary: "generated code" };

function deps(overrides: Partial<PureSprintDeps>): PureSprintDeps {
  return {
    generate: () => Promise.resolve(okGen),
    evaluate: () => Promise.resolve([verdict(true)]),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("runPureSprint", () => {
  it("passes on the first iteration", async () => {
    const generate = vi.fn(() => Promise.resolve(okGen));
    const out = await runPureSprint(makeInput(), deps({ generate, evaluate: () => Promise.resolve([verdict(true)]) }));
    expect(out.outcome).toBe("passed");
    expect(out.iterationsUsed).toBe(1);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(out.finalVerdict.passed).toBe(true);
  });

  it("retries then passes, threading feedback into the next generation", async () => {
    const generate = vi.fn(() => Promise.resolve(okGen));
    let call = 0;
    const evaluate = vi.fn(() => {
      call += 1;
      return Promise.resolve([verdict(call >= 2)]);
    });
    const out = await runPureSprint(makeInput(), deps({ generate, evaluate }));
    expect(out.outcome).toBe("passed");
    expect(out.iterationsUsed).toBe(2);
    expect(generate).toHaveBeenCalledTimes(2);
    // 2nd generate call receives non-empty feedback (arg index 2).
    const secondFeedback = generate.mock.calls[1]?.[2] as string;
    expect(secondFeedback.length).toBeGreaterThan(0);
  });

  it("returns needs-rework when the iteration budget is exhausted", async () => {
    const out = await runPureSprint(
      makeInput(2),
      deps({ evaluate: () => Promise.resolve([verdict(false)]) }),
    );
    expect(out.outcome).toBe("needs-rework");
    expect(out.iterationsUsed).toBe(2);
    expect(out.finalVerdict.passed).toBe(false);
  });

  it("returns failed when the generator reports a hard blocker", async () => {
    const out = await runPureSprint(
      makeInput(),
      deps({
        generate: () => Promise.resolve({ blocked: true, summary: "missing dependency" }),
        evaluate: () => Promise.resolve([verdict(false)]),
      }),
    );
    expect(out.outcome).toBe("failed");
    expect(out.iterationsUsed).toBe(1);
  });

  it("curates exactly once across all iterations", async () => {
    const curate = vi.fn(() => Promise.resolve("briefing"));
    await runPureSprint(
      makeInput(3),
      deps({ curate, evaluate: () => Promise.resolve([verdict(false)]) }),
    );
    expect(curate).toHaveBeenCalledTimes(1);
  });

  it("uses a single lens verdict directly (no reconcile)", async () => {
    const reconcileSpy = vi.fn(() => verdict(true, "panel"));
    const out = await runPureSprint(
      makeInput(),
      deps({ evaluate: () => Promise.resolve([verdict(true, "correctness")]), reconcile: reconcileSpy }),
    );
    expect(reconcileSpy).not.toHaveBeenCalled();
    expect(out.finalVerdict.evaluator).toBe("correctness");
  });

  it("reconciles a multi-lens panel via the (default) majority vote", async () => {
    // Two passing lenses → majority pass; finalVerdict.evaluator becomes 'panel'.
    const out = await runPureSprint(
      makeInput(),
      deps({ evaluate: () => Promise.resolve([verdict(true), verdict(true)]) }),
    );
    expect(out.outcome).toBe("passed");
    expect(out.lensVerdicts).toHaveLength(2);
    expect(out.finalVerdict.evaluator).toBe("panel");
  });

  it("honors an injected reconcile function for multi-lens panels", async () => {
    const reconcileSpy = vi.fn(() => verdict(true, "custom-panel"));
    const out = await runPureSprint(
      makeInput(),
      deps({
        evaluate: () => Promise.resolve([verdict(false), verdict(true)]),
        reconcile: reconcileSpy,
      }),
    );
    expect(reconcileSpy).toHaveBeenCalledTimes(1);
    expect(out.outcome).toBe("passed");
    expect(out.finalVerdict.evaluator).toBe("custom-panel");
  });
});
