// ── loop-bounds.test.ts ──────────────────────────────────────────────
//
// sc-4-7: every live cyclic path must exit by a CONFIGURED maximum and must say
// so when it does. The load-bearing test injects an always-failing evaluator and
// proves the loop terminates by its own bound — with the test carrying an
// independent hard ceiling that must never be reached, so a broken bound shows
// up as a failed assertion rather than a hung suite.

import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import type { BoberConfig } from "../config/schema.js";
import type { PlanSpec } from "../contracts/spec.js";
import type { SprintContract } from "../contracts/sprint-contract.js";
import type { EvalResult } from "../contracts/eval-result.js";
import type { ProjectContext } from "./context-handoff.js";

// ── Mock the agent boundary (same set pipeline.test.ts establishes) ───

vi.mock("../graph/pipeline-lifecycle.js", () => ({
  graphPipelineLifecycle: {
    engineHealth: vi.fn().mockReturnValue("disabled"),
    getGraphClient: vi.fn().mockReturnValue(null),
    getGraphDeps: vi.fn().mockReturnValue(null),
  },
}));

vi.mock("../state/index.js", () => ({
  ensureBoberDir: vi.fn().mockResolvedValue(undefined),
  saveContract: vi.fn().mockResolvedValue(undefined),
  updateContract: vi.fn().mockResolvedValue(undefined),
  appendHistory: vi.fn().mockResolvedValue(undefined),
  readDesign: vi.fn().mockRejectedValue(new Error("no design")),
  readOutline: vi.fn().mockRejectedValue(new Error("no outline")),
}));

vi.mock("../utils/git.js", () => ({
  commitAll: vi.fn().mockResolvedValue("abc1234"),
  getCurrentBranch: vi.fn().mockResolvedValue("bober/test"),
  getChangedFiles: vi.fn().mockResolvedValue(["src/orchestrator/loop-bounds.ts"]),
}));

vi.mock("./generator-agent.js", () => ({
  runGenerator: vi.fn(),
}));

vi.mock("./evaluator-agent.js", () => ({
  runEvaluatorAgent: vi.fn(),
}));

import { runSprintCycle } from "./pipeline.js";
import { runGenerator } from "./generator-agent.js";
import { runEvaluatorAgent } from "./evaluator-agent.js";
import { runPureSprint } from "./workflow/pure-sprint.js";
import type { SprintInput, PureSprintDeps } from "./workflow/pure-sprint.js";
import {
  LOOP_IDS,
  LoopBoundExceededError,
  emitLoopBoundExhausted,
} from "./loop-bounds.js";
import { createDefaultConfig } from "../config/schema.js";

// ── Fixtures ─────────────────────────────────────────────────────────

const ISO = "2026-08-05T00:00:00.000Z";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bober-loopbound-"));
  vi.clearAllMocks();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeConfig(maxIterations: number): BoberConfig {
  const base = createDefaultConfig("test", "brownfield");
  return {
    ...base,
    evaluator: { ...base.evaluator, maxIterations },
    curator: { ...base.curator, enabled: false },
    codeReview: { enabled: false },
    documenter: { enabled: false },
    generator: { ...base.generator, autoCommit: false },
    telemetry: { enabled: true },
  } as BoberConfig;
}

function makeSpec(): PlanSpec {
  return {
    specId: "spec-bound-1",
    version: 1,
    title: "Bounded loops",
    description: "Enforce configured maxima on every live cyclic path.",
    status: "in-progress",
    mode: "brownfield",
    features: [
      {
        featureId: "feat-3",
        title: "Loop bounds",
        description: "Bounded exits emit an event.",
        priority: "must-have",
        acceptanceCriteria: ["A bounded exit is observable"],
      },
    ],
    assumptions: [],
    outOfScope: [],
    clarificationQuestions: [],
    resolvedClarifications: [],
    techStack: ["TypeScript"],
    nonFunctionalRequirements: [],
    constraints: [],
    createdAt: ISO,
    updatedAt: ISO,
  };
}

function makeContract(): SprintContract {
  return {
    contractId: "bound-contract-1",
    specId: "spec-bound-1",
    sprintNumber: 1,
    title: "Enforce loop bounds on the live paths",
    description:
      "Read the configured maximum in runSprintCycle and the pure-sprint loop " +
      "and emit a bounded-exit event when the maximum is reached.",
    status: "proposed",
    dependsOn: [],
    features: ["feat-3"],
    successCriteria: [
      {
        criterionId: "sc-4-7",
        description: "An always-failing evaluator terminates by bound.",
        verificationMethod: "unit-test",
        required: true,
      },
    ],
    nonGoals: ["Do not change what a run does."],
    stopConditions: ["Stop when both loops emit a bounded-exit event."],
    definitionOfDone: "Every live cyclic path is bounded by a configured maximum.",
    assumptions: [],
    outOfScope: [],
    ambiguityScore: 2,
    estimatedFiles: ["src/orchestrator/loop-bounds.ts"],
    estimatedDuration: "medium",
    iterationHistory: [],
    createdAt: ISO,
    updatedAt: ISO,
  };
}

const projectContext: ProjectContext = {
  name: "test",
  type: "brownfield",
  techStack: [],
  entryPoints: [],
  currentBranch: "bober/test",
};

async function readTelemetry(dir: string): Promise<Array<Record<string, unknown>>> {
  const telemetryDir = join(dir, ".bober", "telemetry");
  let files: string[];
  try {
    files = await readdir(telemetryDir);
  } catch {
    return [];
  }
  const out: Array<Record<string, unknown>> = [];
  for (const f of files.sort()) {
    const raw = await readFile(join(telemetryDir, f), "utf-8");
    for (const line of raw.split("\n").filter((l) => l.trim().length > 0)) {
      out.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return out;
}

// ── emitLoopBoundExhausted ───────────────────────────────────────────

describe("emitLoopBoundExhausted", () => {
  it("appends exactly one loop-bound-exhausted event with the configured limit", async () => {
    const config = makeConfig(3);
    await emitLoopBoundExhausted(root, config, {
      loopId: "sprint-retry",
      maxIterations: 3,
      iterationsUsed: 3,
      contractId: "c-1",
      runId: "run-1",
    });

    const events = await readTelemetry(root);
    expect(events).toHaveLength(1);
    expect(events[0]!["eventType"]).toBe("loop-bound-exhausted");
    expect(events[0]!["loopId"]).toBe("sprint-retry");
    expect(events[0]!["limit"]).toBe(3);
    expect(events[0]!["iteration"]).toBe(3);
    expect(events[0]!["contractId"]).toBe("c-1");
    expect(events[0]!["runId"]).toBe("run-1");
  });

  it("writes NOTHING when telemetry is disabled (the default)", async () => {
    await emitLoopBoundExhausted(root, createDefaultConfig("test", "brownfield"), {
      loopId: "pure-sprint",
      maxIterations: 2,
      iterationsUsed: 2,
    });
    expect(await readTelemetry(root)).toEqual([]);
  });

  it("never rejects, even when the telemetry directory cannot be created", async () => {
    // A file where the .bober directory should be → mkdir fails inside emit().
    await expect(
      emitLoopBoundExhausted(join(root, "does", "not", "exist"), makeConfig(1), {
        loopId: "sprint-retry",
        maxIterations: 1,
        iterationsUsed: 1,
      }),
    ).resolves.toBeUndefined();
  });

  it("LoopBoundExceededError carries the loop identity and the numbers", () => {
    const err = new LoopBoundExceededError({
      loopId: "pure-sprint",
      maxIterations: 5,
      iterationsUsed: 5,
      contractId: "c-9",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("LoopBoundExceededError");
    expect(err.loopId).toBe("pure-sprint");
    expect(err.maxIterations).toBe(5);
    expect(err.iterationsUsed).toBe(5);
    expect(err.message).toContain("c-9");
    expect(err.message).toContain("5");
  });

  it("LOOP_IDS is the closed set of bounded live paths", () => {
    expect([...LOOP_IDS]).toEqual(["sprint-retry", "pure-sprint"]);
  });
});

// ── sc-4-7: runSprintCycle terminates by bound ───────────────────────

describe("runSprintCycle — bounded by config.evaluator.maxIterations (sc-4-7)", () => {
  /** Independent of the code under test: if this trips, the bound did not hold. */
  const HARD_CEILING = 25;

  it("an always-failing evaluator terminates in exactly maxIterations rounds", async () => {
    const maxIterations = 3;
    let generatorCalls = 0;
    let evaluatorCalls = 0;

    vi.mocked(runGenerator).mockImplementation(async () => {
      generatorCalls += 1;
      if (generatorCalls > HARD_CEILING) {
        throw new Error(`unbounded loop: generator ran ${generatorCalls} times`);
      }
      return {
        success: true,
        notes: "attempt",
        filesChanged: [],
        turnsUsed: 1,
        toolsCalled: [],
      };
    });

    vi.mocked(runEvaluatorAgent).mockImplementation(async () => {
      evaluatorCalls += 1;
      if (evaluatorCalls > HARD_CEILING) {
        throw new Error(`unbounded loop: evaluator ran ${evaluatorCalls} times`);
      }
      return {
        passed: false,
        score: 10,
        results: [],
        summary: "Never passes.",
        timestamp: ISO,
      };
    });

    const result = await runSprintCycle({
      contract: makeContract(),
      spec: makeSpec(),
      completedContracts: [],
      projectRoot: root,
      config: makeConfig(maxIterations),
      projectContext,
      pipelineRunId: "run-bound",
    });

    // Terminated by the CONFIGURED bound, not by the test's ceiling.
    expect(generatorCalls).toBe(maxIterations);
    expect(evaluatorCalls).toBe(maxIterations);
    expect(generatorCalls).toBeLessThan(HARD_CEILING);
    expect(result.contract.status).toBe("needs-rework");
  });

  it("emits exactly one loop-bound-exhausted event naming the configured limit", async () => {
    const maxIterations = 2;
    vi.mocked(runGenerator).mockResolvedValue({
      success: true,
      notes: "attempt",
      filesChanged: [],
      turnsUsed: 1,
      toolsCalled: [],
    });
    vi.mocked(runEvaluatorAgent).mockResolvedValue({
      passed: false,
      score: 0,
      results: [],
      summary: "Never passes.",
      timestamp: ISO,
    });

    await runSprintCycle({
      contract: makeContract(),
      spec: makeSpec(),
      completedContracts: [],
      projectRoot: root,
      config: makeConfig(maxIterations),
      projectContext,
      pipelineRunId: "run-bound-evt",
    });

    const bound = (await readTelemetry(root)).filter(
      (e) => e["eventType"] === "loop-bound-exhausted",
    );
    expect(bound).toHaveLength(1);
    expect(bound[0]!["loopId"]).toBe("sprint-retry");
    expect(bound[0]!["limit"]).toBe(maxIterations);
    expect(bound[0]!["iteration"]).toBe(maxIterations);
    expect(bound[0]!["runId"]).toBe("run-bound-evt");
    expect(bound[0]!["sprintId"]).toBe("bound-contract-1");
  });

  it("emits NO bounded-exit event when the sprint passes before the bound", async () => {
    vi.mocked(runGenerator).mockResolvedValue({
      success: true,
      notes: "attempt",
      filesChanged: [],
      turnsUsed: 1,
      toolsCalled: [],
    });
    vi.mocked(runEvaluatorAgent).mockResolvedValue({
      passed: true,
      score: 100,
      results: [],
      summary: "Passed on round one.",
      timestamp: ISO,
    });

    const result = await runSprintCycle({
      contract: makeContract(),
      spec: makeSpec(),
      completedContracts: [],
      projectRoot: root,
      config: makeConfig(3),
      projectContext,
      pipelineRunId: "run-no-bound",
    });

    expect(result.contract.status).toBe("passed");
    expect(vi.mocked(runGenerator)).toHaveBeenCalledTimes(1);
    expect(
      (await readTelemetry(root)).filter((e) => e["eventType"] === "loop-bound-exhausted"),
    ).toEqual([]);
  });

  it("a generator that never succeeds also exits by the same bound", async () => {
    const maxIterations = 4;
    let calls = 0;
    vi.mocked(runGenerator).mockImplementation(async () => {
      calls += 1;
      if (calls > HARD_CEILING) throw new Error("unbounded generator retry loop");
      return {
        success: false,
        notes: "blocked",
        filesChanged: [],
        turnsUsed: 1,
        toolsCalled: [],
      };
    });

    const result = await runSprintCycle({
      contract: makeContract(),
      spec: makeSpec(),
      completedContracts: [],
      projectRoot: root,
      config: makeConfig(maxIterations),
      projectContext,
      pipelineRunId: "run-gen-bound",
    });

    expect(calls).toBe(maxIterations);
    expect(calls).toBeLessThan(HARD_CEILING);
    expect(result.contract.status).toBe("needs-rework");
    expect(vi.mocked(runEvaluatorAgent)).not.toHaveBeenCalled();

    const bound = (await readTelemetry(root)).filter(
      (e) => e["eventType"] === "loop-bound-exhausted",
    );
    expect(bound).toHaveLength(1);
    expect(bound[0]!["limit"]).toBe(maxIterations);
  });
});

// ── sc-4-7: the pure-sprint loop reports its own bounded exit ─────────

describe("runPureSprint — bounded by input.maxIterations (sc-4-7)", () => {
  const HARD_CEILING = 25;

  function verdict(passed: boolean): EvalResult {
    return {
      evaluator: "panel",
      passed,
      score: passed ? 100 : 0,
      details: [],
      summary: passed ? "pass" : "fail",
      feedback: passed ? "" : "try again",
      timestamp: ISO,
    };
  }

  function makeInput(maxIterations: number): SprintInput {
    return {
      contract: makeContract(),
      spec: makeSpec(),
      maxIterations,
      priorPassed: [],
    };
  }

  it("calls onBoundExhausted exactly once and flags boundExhausted on the outcome", async () => {
    const seen: Array<{ loopId: string; maxIterations: number; iterationsUsed: number }> = [];
    let generateCalls = 0;

    const deps: PureSprintDeps = {
      generate: async () => {
        generateCalls += 1;
        if (generateCalls > HARD_CEILING) throw new Error("unbounded pure-sprint loop");
        return { blocked: false, summary: "attempt" };
      },
      evaluate: () => Promise.resolve([verdict(false)]),
      onBoundExhausted: (info) => {
        seen.push({
          loopId: info.loopId,
          maxIterations: info.maxIterations,
          iterationsUsed: info.iterationsUsed,
        });
      },
    };

    const out = await runPureSprint(makeInput(3), deps);

    expect(generateCalls).toBe(3);
    expect(generateCalls).toBeLessThan(HARD_CEILING);
    expect(out.outcome).toBe("needs-rework");
    expect(out.iterationsUsed).toBe(3);
    expect(out.boundExhausted).toBe(true);
    expect(seen).toEqual([
      { loopId: "pure-sprint", maxIterations: 3, iterationsUsed: 3 },
    ]);
  });

  it("does NOT fire the hook when the sprint passes", async () => {
    const onBoundExhausted = vi.fn();
    const out = await runPureSprint(makeInput(3), {
      generate: () => Promise.resolve({ blocked: false, summary: "" }),
      evaluate: () => Promise.resolve([verdict(true)]),
      onBoundExhausted,
    });
    expect(out.outcome).toBe("passed");
    expect(out.boundExhausted).toBeUndefined();
    expect(onBoundExhausted).not.toHaveBeenCalled();
  });

  it("does NOT fire the hook when the generator reports a hard blocker", async () => {
    const onBoundExhausted = vi.fn();
    const out = await runPureSprint(makeInput(3), {
      generate: () => Promise.resolve({ blocked: true, summary: "hard blocker" }),
      evaluate: () => Promise.resolve([verdict(false)]),
      onBoundExhausted,
    });
    expect(out.outcome).toBe("failed");
    expect(out.boundExhausted).toBeUndefined();
    expect(onBoundExhausted).not.toHaveBeenCalled();
  });

  it("the hook is optional — omitting it still terminates by bound", async () => {
    const out = await runPureSprint(makeInput(2), {
      generate: () => Promise.resolve({ blocked: false, summary: "" }),
      evaluate: () => Promise.resolve([verdict(false)]),
    });
    expect(out.outcome).toBe("needs-rework");
    expect(out.iterationsUsed).toBe(2);
    expect(out.boundExhausted).toBe(true);
  });
});
