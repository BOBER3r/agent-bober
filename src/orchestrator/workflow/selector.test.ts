import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../utils/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));

// Mock eligibility so team-aware workflow tests can toggle it per test.
vi.mock("./eligibility.js", () => ({
  isWorkflowEligible: vi.fn(() => false),
}));

import { logger } from "../../utils/logger.js";
import { isWorkflowEligible } from "./eligibility.js";
import { resolveEngineName, selectPipelineEngine, selectPipelineEngineForTeam } from "./selector.js";
import { loadTeam } from "../../teams/registry.js";
import { createDefaultConfig } from "../../config/schema.js";
import { TsPipelineEngine } from "./ts-engine.js";
import { WorkflowEngine } from "./workflow-engine.js";
import type { BoberConfig } from "../../config/schema.js";

// ── Helpers ────────────────────────────────────────────────────────

function makeConfig(pipeline: Partial<BoberConfig["pipeline"]>): BoberConfig {
  return {
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
      engine: "ts",
      ...pipeline,
    },
  } as BoberConfig;
}

// ── resolveEngineName branch tests ────────────────────────────────

describe("resolveEngineName", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 'ts' when engine is 'ts' (default)", () => {
    const config = makeConfig({ engine: "ts" });
    expect(resolveEngineName(config)).toBe("ts");
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("returns 'skill' verbatim when engine is 'skill'", () => {
    const config = makeConfig({ engine: "skill" });
    expect(resolveEngineName(config)).toBe("skill");
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("returns 'ts' (downgrade) when engine='workflow' and probe is ineligible", () => {
    const config = makeConfig({ engine: "workflow", mode: "autopilot" });
    expect(resolveEngineName(config)).toBe("ts");
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it("returns 'ts' (downgrade) when engine='workflow' and mode='careful'", () => {
    // mode='careful' triggers downgrade regardless of eligibility
    const config = makeConfig({ engine: "workflow", mode: "careful" });
    expect(resolveEngineName(config)).toBe("ts");
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it("logs exactly one downgrade line on workflow→ts path (ineligible)", () => {
    const config = makeConfig({ engine: "workflow" });
    resolveEngineName(config);
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it("does not log when engine='ts'", () => {
    const config = makeConfig({ engine: "ts" });
    resolveEngineName(config);
    expect(logger.info).not.toHaveBeenCalled();
  });
});

// ── sc-3-4: programming team equivalence ──────────────────────────

describe("selectPipelineEngineForTeam — programming team (sc-3-4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Keep eligibility false (default) for programming-team tests; 'ts' shape never hits the workflow branch.
    vi.mocked(isWorkflowEligible).mockReturnValue(false);
  });

  it("programming team with engine 'ts' selects TsPipelineEngine (same class as legacy path)", () => {
    const config = createDefaultConfig("test", "greenfield");
    // Load team before clearing mocks — resolveRoleProviders logs info lines during team resolution.
    const team = loadTeam(config); // pipelineShape === resolveEngineName(config) === 'ts'
    vi.clearAllMocks();
    vi.mocked(isWorkflowEligible).mockReturnValue(false);

    const teamEngine = selectPipelineEngineForTeam(team, config);
    const legacyEngine = selectPipelineEngine(config);

    expect(teamEngine).toBeInstanceOf(TsPipelineEngine);
    expect(legacyEngine).toBeInstanceOf(TsPipelineEngine);
    // Both paths select the same engine class — team-aware is equivalent to legacy for programming.
    expect(teamEngine.name).toBe(legacyEngine.name);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("team-aware result and legacy result share the same engine name for the programming team", () => {
    const config = createDefaultConfig("test", "greenfield");
    // Load team before clearing mocks — resolveRoleProviders logs info lines during team resolution.
    const team = loadTeam(config, "programming");
    vi.clearAllMocks();
    vi.mocked(isWorkflowEligible).mockReturnValue(false);

    const teamResult = selectPipelineEngineForTeam(team, config);
    const legacyResult = selectPipelineEngine(config);

    expect(teamResult.name).toBe(legacyResult.name);
    expect(teamResult).toBeInstanceOf(TsPipelineEngine);
  });
});

// ── sc-3-5: declared-team pipelineShape routing + downgrade ───────

describe("selectPipelineEngineForTeam — declared team with pipelineShape 'workflow' (sc-3-5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("selects WorkflowEngine when pipelineShape='workflow' and config is eligible", () => {
    vi.mocked(isWorkflowEligible).mockReturnValue(true);

    const base = createDefaultConfig("test", "greenfield");
    const config: BoberConfig = {
      ...base,
      teams: { ops: { pipelineShape: "workflow" } },
    };
    // Load team before clearing mocks — resolveRoleProviders logs info lines during team resolution.
    const team = loadTeam(config, "ops");
    vi.clearAllMocks();
    vi.mocked(isWorkflowEligible).mockReturnValue(true);

    const engine = selectPipelineEngineForTeam(team, config);

    expect(engine).toBeInstanceOf(WorkflowEngine);
    expect(engine.name).toBe("workflow");
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("downgrades to TsPipelineEngine when pipelineShape='workflow' and config is ineligible", () => {
    vi.mocked(isWorkflowEligible).mockReturnValue(false);

    const base = createDefaultConfig("test", "greenfield");
    const config: BoberConfig = {
      ...base,
      teams: { ops: { pipelineShape: "workflow" } },
    };
    // Load team before clearing mocks — resolveRoleProviders logs info lines during team resolution.
    const team = loadTeam(config, "ops");
    vi.clearAllMocks();
    vi.mocked(isWorkflowEligible).mockReturnValue(false);

    const engine = selectPipelineEngineForTeam(team, config);

    expect(engine).toBeInstanceOf(TsPipelineEngine);
    expect(engine.name).toBe("ts");
    // Exactly one downgrade log line (ineligible branch)
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it("downgrades to TsPipelineEngine when pipelineShape='workflow' and mode='careful' (even if eligible)", () => {
    vi.mocked(isWorkflowEligible).mockReturnValue(true);

    const base = createDefaultConfig("test", "greenfield");
    const config: BoberConfig = {
      ...base,
      pipeline: { ...base.pipeline, engine: "ts", mode: "careful" },
      teams: { ops: { pipelineShape: "workflow" } },
    };
    // Load team before clearing mocks — resolveRoleProviders logs info lines during team resolution.
    const team = loadTeam(config, "ops");
    vi.clearAllMocks();
    vi.mocked(isWorkflowEligible).mockReturnValue(true);

    const engine = selectPipelineEngineForTeam(team, config);

    expect(engine).toBeInstanceOf(TsPipelineEngine);
    expect(engine.name).toBe("ts");
    // Exactly one downgrade log line (mode='careful' branch)
    expect(logger.info).toHaveBeenCalledTimes(1);
  });
});

// ── sc-3-6: runPipeline team-aware wiring (stubbed, no real LLM) ──

describe("runPipeline team-aware wiring (sc-3-6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isWorkflowEligible).mockReturnValue(false);
  });

  it("no-team call resolves to programming team (TsPipelineEngine, same as legacy)", () => {
    const config = createDefaultConfig("test", "greenfield");

    // Assert at the pure selectPipelineEngineForTeam level — no .run() call, no LLM.
    const team = loadTeam(config, undefined); // undefined -> programming team
    expect(team.id).toBe("programming");

    const engine = selectPipelineEngineForTeam(team, config);
    const legacyEngine = selectPipelineEngine(config);

    expect(engine).toBeInstanceOf(TsPipelineEngine);
    expect(engine.name).toBe(legacyEngine.name);
  });

  it("team with pipelineShape 'workflow' (eligible) selects WorkflowEngine, not TsPipelineEngine", () => {
    vi.mocked(isWorkflowEligible).mockReturnValue(true);

    const base = createDefaultConfig("test", "greenfield");
    const config: BoberConfig = {
      ...base,
      teams: { ops: { pipelineShape: "workflow" } },
      defaultTeam: "ops",
    };

    // Simulate what runPipeline does: teamId = opts?.teamId ?? config.defaultTeam
    const teamId = config.defaultTeam; // 'ops'
    const team = loadTeam(config, teamId);

    expect(team.pipelineShape).toBe("workflow");
    const engine = selectPipelineEngineForTeam(team, config);
    expect(engine).toBeInstanceOf(WorkflowEngine);
  });

  it("opts.teamId overrides config.defaultTeam to drive engine selection", () => {
    vi.mocked(isWorkflowEligible).mockReturnValue(true);

    const base = createDefaultConfig("test", "greenfield");
    const config: BoberConfig = {
      ...base,
      teams: {
        ops: { pipelineShape: "workflow" },
      },
      defaultTeam: "programming",
    };

    // opts.teamId='ops' overrides defaultTeam='programming'
    const teamId = "ops";
    const team = loadTeam(config, teamId);

    expect(team.pipelineShape).toBe("workflow");
    const engine = selectPipelineEngineForTeam(team, config);
    expect(engine).toBeInstanceOf(WorkflowEngine);
    expect(engine.name).toBe("workflow");
  });
});
