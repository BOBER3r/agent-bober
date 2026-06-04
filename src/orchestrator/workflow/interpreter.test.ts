/**
 * Unit + integration tests for the workflow interpreter.
 *
 * The agent seams (plan / buildContracts / runSprint) are faked, so these are
 * hermetic. The final test runs a real RunResultFlusher against a temp .bober/
 * to prove the interpreter's WorkflowRunResult is committable (the Sprint-3
 * exit criterion: 2-contract spec → populated result → flush commits it).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { runWorkflow, type WorkflowDeps } from "./interpreter.js";
import type { SprintInput, SprintOutcome } from "./pure-sprint.js";
import type { WorkflowArgs } from "./types.js";
import { createContract } from "../../contracts/sprint-contract.js";
import type { SprintContract } from "../../contracts/sprint-contract.js";
import type { EvalResult } from "../../contracts/eval-result.js";
import type { PlanSpec } from "../../contracts/spec.js";
import { RunResultFlusher } from "./flusher.js";
import { listContracts } from "../../state/sprint-state.js";
import { loadHistory } from "../../state/history.js";
import { createDefaultConfig } from "../../config/schema.js";

// ── Fixtures ─────────────────────────────────────────────────────────

function makeSpec(specId = "spec-1"): PlanSpec {
  const now = "2026-06-04T12:00:00.000Z";
  return {
    specId,
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

function makeContract(sprintNumber: number): SprintContract {
  return createContract(
    `Sprint ${String(sprintNumber)}`,
    "desc",
    [{ criterionId: `c-${String(sprintNumber)}`, description: "the feature works end to end as specified", verificationMethod: "agent-evaluation" }],
    { specId: "spec-1", sprintNumber },
  );
}

function verdict(passed: boolean): EvalResult {
  return {
    evaluator: "panel",
    passed,
    details: [],
    summary: passed ? "ok" : "nope",
    feedback: passed ? "" : "fix it",
    timestamp: "2026-06-04T12:00:00.000Z",
  };
}

function passOutcome(contract: SprintContract): SprintOutcome {
  return { contract, finalVerdict: verdict(true), iterationsUsed: 1, outcome: "passed", lensVerdicts: [verdict(true)] };
}

function reworkOutcome(contract: SprintContract): SprintOutcome {
  return { contract, finalVerdict: verdict(false), iterationsUsed: 3, outcome: "needs-rework", lensVerdicts: [verdict(false)] };
}

function makeArgs(overrides: Partial<WorkflowArgs> = {}): WorkflowArgs {
  return {
    userPrompt: "build a feature",
    knobs: {
      maxIterations: 3,
      maxSprints: 10,
      researchPhase: false,
      architectPhase: false,
      curatorEnabled: false,
      codeReviewEnabled: false,
      requireContracts: false,
    },
    models: { planner: "sonnet", curator: "sonnet", generator: "sonnet", evaluator: "sonnet" },
    evaluatorLenses: ["default"],
    principles: "",
    preloadedContracts: [],
    resumeCursor: { specId: "spec-1", completedSprintNumbers: [], lastObservedSprintNumber: 0 },
    ...overrides,
  };
}

function makeDeps(overrides: Partial<WorkflowDeps> = {}): WorkflowDeps {
  return {
    plan: () => Promise.resolve({ spec: makeSpec(), needsClarification: false }),
    buildContracts: () => [],
    runSprint: (input: SprintInput) => Promise.resolve(passOutcome(input.contract)),
    ...overrides,
  };
}

// ── Interpreter behavior ─────────────────────────────────────────────

describe("runWorkflow", () => {
  it("produces a populated WorkflowRunResult for a 2-contract spec", async () => {
    const contracts = [makeContract(1), makeContract(2)];
    const result = await runWorkflow(
      makeArgs({ preloadedSpec: makeSpec(), preloadedContracts: contracts }),
      "/tmp/unused",
      makeDeps(),
    );

    expect(result.needsClarification).toBe(false);
    expect(result.perSprint).toHaveLength(2);
    expect(result.perSprint.every((p) => p.outcome === "passed")).toBe(true);
    expect(result.perSprint[0]?.contract.sprintNumber).toBe(1);
    expect(result.perSprint[1]?.contract.sprintNumber).toBe(2);
  });

  it("emits timestamp-less pendingHistory the flusher will stamp", async () => {
    const result = await runWorkflow(
      makeArgs({ preloadedSpec: makeSpec(), preloadedContracts: [makeContract(1)] }),
      "/tmp/unused",
      makeDeps(),
    );
    const events = result.pendingHistory.map((h) => h.event);
    expect(events).toContain("workflow-planning-complete");
    expect(events).toContain("workflow-sprint-evaluated");
    expect(events).toContain("workflow-complete");
    // No entry carries a timestamp — that's the flusher's job.
    for (const entry of result.pendingHistory) {
      expect(entry).not.toHaveProperty("timestamp");
    }
  });

  it("short-circuits to needsClarification without running sprints", async () => {
    const runSprint = vi.fn((input: SprintInput) => Promise.resolve(passOutcome(input.contract)));
    const result = await runWorkflow(
      makeArgs(),
      "/tmp/unused",
      makeDeps({
        plan: () => Promise.resolve({ spec: makeSpec(), needsClarification: true }),
        runSprint,
      }),
    );
    expect(result.needsClarification).toBe(true);
    expect(result.perSprint).toEqual([]);
    expect(runSprint).not.toHaveBeenCalled();
    expect(result.pendingHistory.map((h) => h.event)).toContain("planning-needs-clarification");
  });

  it("skips contracts already completed (resume)", async () => {
    const runSprint = vi.fn((input: SprintInput) => Promise.resolve(passOutcome(input.contract)));
    const contracts = [makeContract(1), makeContract(2), makeContract(3)];
    const result = await runWorkflow(
      makeArgs({
        preloadedSpec: makeSpec(),
        preloadedContracts: contracts,
        resumeCursor: { specId: "spec-1", completedSprintNumbers: [1, 2], lastObservedSprintNumber: 2 },
      }),
      "/tmp/unused",
      makeDeps({ runSprint }),
    );
    expect(runSprint).toHaveBeenCalledTimes(1);
    expect(result.perSprint).toHaveLength(1);
    expect(result.perSprint[0]?.contract.sprintNumber).toBe(3);
  });

  it("caps the sprint loop at knobs.maxSprints", async () => {
    const runSprint = vi.fn((input: SprintInput) => Promise.resolve(passOutcome(input.contract)));
    const contracts = [makeContract(1), makeContract(2), makeContract(3)];
    await runWorkflow(
      makeArgs({ preloadedSpec: makeSpec(), preloadedContracts: contracts, knobs: { ...makeArgs().knobs, maxSprints: 2 } }),
      "/tmp/unused",
      makeDeps({ runSprint }),
    );
    expect(runSprint).toHaveBeenCalledTimes(2);
  });

  it("derives contracts via buildContracts when none are preloaded", async () => {
    const buildContracts = vi.fn(() => [makeContract(1)]);
    const runSprint = vi.fn((input: SprintInput) => Promise.resolve(passOutcome(input.contract)));
    const result = await runWorkflow(
      makeArgs({ preloadedSpec: makeSpec() }),
      "/tmp/unused",
      makeDeps({ buildContracts, runSprint }),
    );
    expect(buildContracts).toHaveBeenCalledTimes(1);
    expect(runSprint).toHaveBeenCalledTimes(1);
    expect(result.perSprint).toHaveLength(1);
  });

  it("reuses preloadedSpec without calling plan", async () => {
    const plan = vi.fn(() => Promise.resolve({ spec: makeSpec(), needsClarification: false }));
    await runWorkflow(
      makeArgs({ preloadedSpec: makeSpec(), preloadedContracts: [makeContract(1)] }),
      "/tmp/unused",
      makeDeps({ plan }),
    );
    expect(plan).not.toHaveBeenCalled();
  });
});

// ── Flush integration (Sprint-3 exit criterion) ─────────────────────

describe("runWorkflow → RunResultFlusher.flush", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bober-interp-test-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("commits the interpreter's WorkflowRunResult to .bober/", async () => {
    const c1 = makeContract(1);
    const c2 = makeContract(2);
    const result = await runWorkflow(
      makeArgs({ preloadedSpec: makeSpec(), preloadedContracts: [c1, c2] }),
      tmpDir,
      makeDeps({
        runSprint: (input: SprintInput) =>
          Promise.resolve(
            input.contract.sprintNumber === 1
              ? passOutcome(input.contract)
              : reworkOutcome(input.contract),
          ),
      }),
    );

    const config = createDefaultConfig("test-project", "brownfield");
    const pipelineResult = await new RunResultFlusher().flush(tmpDir, config, result);

    // Two contracts were written with statuses matching their outcomes.
    const contracts = await listContracts(tmpDir);
    expect(contracts).toHaveLength(2);
    const byNumber = new Map(contracts.map((c) => [c.sprintNumber, c.status]));
    expect(byNumber.get(1)).toBe("passed");
    expect(byNumber.get(2)).toBe("needs-rework");

    // History was stamped + appended (timestamps added by the flusher).
    const history = await loadHistory(tmpDir);
    expect(history.length).toBeGreaterThan(0);
    expect(history.every((h) => typeof h.timestamp === "string" && h.timestamp.length > 0)).toBe(true);
    expect(history.map((h) => h.event)).toContain("workflow-complete");

    // One passed + one not-passed → overall not successful.
    expect(pipelineResult.success).toBe(false);
    expect(pipelineResult.completedSprints).toHaveLength(1);
    expect(pipelineResult.failedSprints).toHaveLength(1);
  });
});
