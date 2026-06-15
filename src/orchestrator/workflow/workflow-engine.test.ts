// ── workflow-engine.test.ts ─────────────────────────────────────────
//
// Unit tests for WorkflowEngine.
// Uses real mkdtemp/.bober/ fixtures (no mock fs — house style).
// NO real TsPipelineEngine.run or runPipeline calls — constructor-injected fake.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../utils/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
  },
}));

// Force eligibility TRUE for the eligible-path tests.
// Tests that need ineligible (default) behaviour unmock or clear this mock locally.
vi.mock("./eligibility.js", () => ({
  isWorkflowEligible: vi.fn(() => true),
}));

import { logger } from "../../utils/logger.js";
import { isWorkflowEligible } from "./eligibility.js";
import { WorkflowEngine } from "./workflow-engine.js";
import { selectPipelineEngine } from "./selector.js";
import { TsPipelineEngine } from "./ts-engine.js";
import { listContracts } from "../../state/sprint-state.js";
import { createDefaultConfig } from "../../config/schema.js";
import type { PipelineEngine } from "./engine.js";
import type { PipelineResult } from "../pipeline.js";
import type { PlanSpec } from "../../contracts/spec.js";
import type { BoberConfig } from "../../config/schema.js";

// ── Helpers ────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<BoberConfig["pipeline"]>): BoberConfig {
  return {
    ...createDefaultConfig("test-project", "brownfield"),
    // Include codeReview so ArgsPayloadBuilder.build does not throw MissingKnobError
    // on the eligible path (when isWorkflowEligible returns true in tests).
    codeReview: { enabled: true, model: "sonnet", maxTurns: 15, timeoutMs: 300_000 },
    pipeline: {
      maxIterations: 20,
      maxCheckpointIterations: 3,
      requireApproval: false,
      contextReset: "always",
      researchPhase: true,
      architectPhase: false,
      mode: "autopilot",
      checkpointOverrides: {},
      approvalTimeoutMs: 86_400_000,
      prPollMs: 30_000,
      allowAutopilotRiskyActions: false,
      eventQueueBound: 1000,
      worktreeRoot: ".bober/worktrees",
      cleanupWorktreeOnSuccess: true,
      engine: "workflow",
      ...(overrides ?? {}),
    },
  } as BoberConfig;
}

function makeSentinelSpec(): PlanSpec {
  const now = new Date().toISOString();
  return {
    specId: "sentinel-spec",
    version: 1,
    title: "Sentinel Spec",
    description: "Sentinel spec for WorkflowEngine unit tests.",
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

function makeSentinelResult(): PipelineResult {
  return {
    success: true,
    spec: makeSentinelSpec(),
    completedSprints: [],
    failedSprints: [],
    duration: 0,
  };
}

// ── Temp dir setup ─────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-wf-engine-test-"));
  vi.clearAllMocks();
  // Default: eligible=true (set for most tests; C2/C4 tests override to false)
  vi.mocked(isWorkflowEligible).mockReturnValue(true);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── C1: WorkflowEngine eligible+invoke→WorkflowUnavailableError → TS re-dispatch ──

describe("WorkflowEngine (C1 — eligible path, invoke dormant)", () => {
  it("re-dispatches TS engine when invoke throws WorkflowUnavailableError (inject fake TS)", async () => {
    const sentinel = makeSentinelResult();
    const fakeTsRun = vi.fn(async () => sentinel);
    const fakeTs: PipelineEngine = { name: "ts", run: fakeTsRun };
    const engine = new WorkflowEngine(() => fakeTs);
    const config = makeConfig();

    const result = await engine.run("build a feature", tmpDir, config);

    // Returns the sentinel from the injected fake TS engine
    expect(result).toBe(sentinel);
    expect(fakeTsRun).toHaveBeenCalledTimes(1);
    expect(fakeTsRun).toHaveBeenCalledWith("build a feature", tmpDir, config, undefined);
  });

  it("emits exactly one info log line on WorkflowUnavailableError re-dispatch", async () => {
    const sentinel = makeSentinelResult();
    const fakeTs: PipelineEngine = { name: "ts", run: vi.fn(async () => sentinel) };
    const engine = new WorkflowEngine(() => fakeTs);
    const config = makeConfig();

    await engine.run("prompt", tmpDir, config);

    // Exactly one logger.info call with the re-dispatch message
    expect(vi.mocked(logger.info)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      "workflow runtime unavailable — re-dispatching TS engine",
    );
  });

  it("writes ZERO workflow-owned contracts before re-dispatch (no partial flush)", async () => {
    const sentinel = makeSentinelResult();
    const fakeTs: PipelineEngine = { name: "ts", run: vi.fn(async () => sentinel) };
    const engine = new WorkflowEngine(() => fakeTs);
    const config = makeConfig();

    await engine.run("prompt", tmpDir, config);

    // The temp .bober/ should have no workflow-written contracts
    // (listContracts returns [] when the dir doesn't exist or is empty)
    const contracts = await listContracts(tmpDir);
    expect(contracts).toEqual([]);
  });
});

// ── C1 / C2: WorkflowEngine ineligible path (eligibility=false → early re-dispatch) ──

describe("WorkflowEngine (C1 — ineligible path, early re-dispatch)", () => {
  beforeEach(() => {
    // Force ineligible for this group
    vi.mocked(isWorkflowEligible).mockReturnValue(false);
  });

  it("re-dispatches TS engine immediately when ineligible (before building args)", async () => {
    const sentinel = makeSentinelResult();
    const fakeTsRun = vi.fn(async () => sentinel);
    const fakeTs: PipelineEngine = { name: "ts", run: fakeTsRun };
    const engine = new WorkflowEngine(() => fakeTs);
    const config = makeConfig();

    const result = await engine.run("prompt", tmpDir, config);

    expect(result).toBe(sentinel);
    expect(fakeTsRun).toHaveBeenCalledTimes(1);
  });

  it("emits exactly one info log on ineligible re-dispatch", async () => {
    const sentinel = makeSentinelResult();
    const fakeTs: PipelineEngine = { name: "ts", run: vi.fn(async () => sentinel) };
    const engine = new WorkflowEngine(() => fakeTs);
    const config = makeConfig();

    await engine.run("prompt", tmpDir, config);

    expect(vi.mocked(logger.info)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      "workflow runtime unavailable — re-dispatching TS engine",
    );
  });

  it("writes ZERO workflow-owned contracts on ineligible path (no args built, no flush)", async () => {
    const sentinel = makeSentinelResult();
    const fakeTs: PipelineEngine = { name: "ts", run: vi.fn(async () => sentinel) };
    const engine = new WorkflowEngine(() => fakeTs);
    const config = makeConfig();

    await engine.run("prompt", tmpDir, config);

    const contracts = await listContracts(tmpDir);
    expect(contracts).toEqual([]);
  });
});

// ── C2: selector returns TS engine in default (ineligible) env ────────────────

describe("selectPipelineEngine (C2 — selector cases)", () => {
  beforeEach(() => {
    vi.mocked(isWorkflowEligible).mockReturnValue(false);
  });

  it("engine='ts' resolves to TsPipelineEngine", () => {
    const config = makeConfig({ engine: "ts" });
    const engine = selectPipelineEngine(config);
    expect(engine.name).toBe("ts");
    expect(engine).toBeInstanceOf(TsPipelineEngine);
  });

  it("engine='skill' resolves to TsPipelineEngine (no skill engine this sprint)", () => {
    const config = makeConfig({ engine: "skill" });
    const engine = selectPipelineEngine(config);
    expect(engine.name).toBe("ts");
    expect(engine).toBeInstanceOf(TsPipelineEngine);
  });

  it("engine='workflow' in default ineligible env downgrades to TsPipelineEngine (via resolveEngineName)", () => {
    const config = makeConfig({ engine: "workflow" });
    const engine = selectPipelineEngine(config);
    // resolveEngineName downgrades workflow→ts when ineligible, so we get TsPipelineEngine
    expect(engine.name).toBe("ts");
    expect(engine).toBeInstanceOf(TsPipelineEngine);
  });
});

// ── C4: integration-style assertion — engine='workflow' in default env resolves TS ──
//
// This does NOT run runPipeline live. It asserts that selectPipelineEngine with
// engine='workflow' in the default (ineligible) environment returns TsPipelineEngine,
// proving runPipeline would delegate to TS with zero workflow-written artifacts.

describe("C4 integration assertion — workflow downgrades to TS in default env", () => {
  beforeEach(() => {
    vi.mocked(isWorkflowEligible).mockReturnValue(false);
  });

  it("selectPipelineEngine(engine='workflow') returns TsPipelineEngine in default env", () => {
    const config = makeConfig({ engine: "workflow", mode: "autopilot" });
    const engine = selectPipelineEngine(config);
    expect(engine.name).toBe("ts");
    expect(engine).toBeInstanceOf(TsPipelineEngine);
  });

  it("WorkflowEngine.run with ineligible env returns TS sentinel result with no flush", async () => {
    vi.mocked(isWorkflowEligible).mockReturnValue(false);
    const sentinel = makeSentinelResult();
    const fakeTsRun = vi.fn(async () => sentinel);
    const fakeTs: PipelineEngine = { name: "ts", run: fakeTsRun };
    const engine = new WorkflowEngine(() => fakeTs);
    const config = makeConfig({ engine: "workflow" });

    const result = await engine.run("integration prompt", tmpDir, config);

    // PipelineResult shape matches
    expect(result).toBe(sentinel);
    expect(result.success).toBe(true);
    expect(Array.isArray(result.completedSprints)).toBe(true);
    expect(Array.isArray(result.failedSprints)).toBe(true);
    expect(typeof result.duration).toBe("number");
    // No orphaned workflow-written contracts
    const contracts = await listContracts(tmpDir);
    expect(contracts).toEqual([]);
    // Fake TS engine was called
    expect(fakeTsRun).toHaveBeenCalledTimes(1);
  });
});
