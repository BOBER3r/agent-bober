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
import {
  resolveEngineName,
  resolveEngineNameForTeam,
  selectPipelineEngine,
  selectPipelineEngineForTeam,
} from "./selector.js";
import { PIPELINE_ENGINE_NAMES } from "./engine.js";
import type { PipelineEngineName } from "./engine.js";
import { loadTeam } from "../../teams/registry.js";
import { createDefaultConfig, PipelineSectionSchema, TeamConfigSchema } from "../../config/schema.js";
import { TsPipelineEngine } from "./ts-engine.js";
import { WorkflowEngine } from "./workflow-engine.js";
import { PgeEngine } from "../../pge/engine/pge-engine.js";
import type { BoberConfig } from "../../config/schema.js";
import type { Team } from "../../teams/types.js";

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

// ── sc-4-1: one tuple feeds both Zod enums ────────────────────────

describe("PIPELINE_ENGINE_NAMES (sc-4-1)", () => {
  it("is the exact reserved set, including 'pge'", () => {
    expect([...PIPELINE_ENGINE_NAMES]).toEqual([
      "ts",
      "skill",
      "workflow",
      "medical-sop",
      "pge",
    ]);
  });

  it("pipeline.engine accepts every tuple member and rejects anything else", () => {
    for (const name of PIPELINE_ENGINE_NAMES) {
      const parsed = PipelineSectionSchema.parse({ engine: name });
      expect(parsed.engine).toBe(name);
    }
    expect(PipelineSectionSchema.safeParse({ engine: "pgee" }).success).toBe(false);
    expect(PipelineSectionSchema.safeParse({ engine: "" }).success).toBe(false);
  });

  it("teams[].pipelineShape accepts the SAME set — the two enums cannot drift", () => {
    for (const name of PIPELINE_ENGINE_NAMES) {
      const parsed = TeamConfigSchema.parse({ pipelineShape: name });
      expect(parsed.pipelineShape).toBe(name);
    }
    expect(TeamConfigSchema.safeParse({ pipelineShape: "graph" }).success).toBe(false);

    // Behavioural parity: for every candidate the two enums must AGREE, which
    // is the property a single shared tuple buys and two hand-kept literal
    // lists do not. A sixth name added to only one enum fails here.
    const candidates = [
      ...PIPELINE_ENGINE_NAMES,
      "pge2",
      "graph",
      "TS",
      "",
      "medical",
    ];
    for (const candidate of candidates) {
      const engineOk = PipelineSectionSchema.safeParse({ engine: candidate }).success;
      const shapeOk = TeamConfigSchema.safeParse({ pipelineShape: candidate }).success;
      expect(
        { candidate, engineOk },
        `engine and pipelineShape disagree on '${candidate}'`,
      ).toEqual({ candidate, engineOk: shapeOk });
      expect(engineOk).toBe(
        (PIPELINE_ENGINE_NAMES as readonly string[]).includes(candidate),
      );
    }
  });

  it("pipeline.engine still defaults to 'ts' (sc-4-2)", () => {
    expect(PipelineSectionSchema.parse({}).engine).toBe("ts");
    expect(createDefaultConfig("test", "brownfield").pipeline.engine).toBe("ts");
  });
});

// ── sc-13-4 / sc-13-5: 'pge' is a REAL engine, selected verbatim ──
//
// These four cases replace the sprint-4 reserved-name assertions. The downgrade did not
// disappear — it MOVED into `PgeEngine.run`, which is the only place that can know whether
// the committed topology compiles (asserted in src/pge/engine/pge-engine.test.ts). What
// selection must now prove is the opposite of what it proved before: asking for 'pge'
// yields 'pge', silently.

describe("resolveEngineName — 'pge' is a real engine (sc-13-4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves 'pge' verbatim, with no downgrade line and no throw", () => {
    const config = makeConfig({ engine: "pge" });
    expect(() => resolveEngineName(config)).not.toThrow();
    expect(resolveEngineName(config)).toBe("pge");

    vi.clearAllMocks();
    resolveEngineName(config);
    // Selection is silent: the run-time downgrade is PgeEngine.run's, not the selector's.
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("instantiates a PgeEngine — selection no longer lands on TsPipelineEngine", () => {
    const engine = selectPipelineEngine(makeConfig({ engine: "pge" }));
    expect(engine).toBeInstanceOf(PgeEngine);
    expect(engine).not.toBeInstanceOf(TsPipelineEngine);
    expect(engine.name).toBe("pge");
  });

  it("routes a team whose pipelineShape is 'pge' to the same engine", () => {
    const config = makeConfig({ engine: "ts" });
    const team = { pipelineShape: "pge" as PipelineEngineName } as Team;

    expect(resolveEngineNameForTeam(team, config)).toBe("pge");
    const engine = selectPipelineEngineForTeam(team, config);
    expect(engine).toBeInstanceOf(PgeEngine);
    expect(engine.name).toBe("pge");
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("does NOT consult workflow eligibility on the 'pge' path", () => {
    vi.mocked(isWorkflowEligible).mockClear();
    resolveEngineName(makeConfig({ engine: "pge" }));
    expect(isWorkflowEligible).not.toHaveBeenCalled();
  });
});

// ── sc-13-5: the SHIPPED default config still resolves to 'ts' ────
//
// The oracle is `createDefaultConfig` — the same function production uses to create a
// default config — and never a hand-written fixture object: a fixture would only assert
// that this test file agrees with itself, and the claim is about what ships.

describe("default engine (sc-13-5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolveEngineName(createDefaultConfig(...)) is 'ts' in both project modes", () => {
    for (const mode of ["greenfield", "brownfield"] as const) {
      const config = createDefaultConfig("sc-13-5", mode);
      expect(config.pipeline.engine).toBe("ts");
      expect(resolveEngineName(config)).toBe("ts");
    }
  });

  it("the shipped default selects TsPipelineEngine, never PgeEngine", () => {
    const config = createDefaultConfig("sc-13-5", "brownfield");
    vi.clearAllMocks();
    vi.mocked(isWorkflowEligible).mockReturnValue(false);

    const engine = selectPipelineEngine(config);
    expect(engine).toBeInstanceOf(TsPipelineEngine);
    expect(engine).not.toBeInstanceOf(PgeEngine);
    expect(engine.name).toBe("ts");
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("the shipped default with no explicit pipeline section still resolves to 'ts'", () => {
    // The repository's own bober.config.json carries no `pipeline.engine` key at all, so
    // the enum default is what applies. Parsing an empty section is that exact path.
    expect(PipelineSectionSchema.parse({}).engine).toBe("ts");
    const config = {
      ...createDefaultConfig("sc-13-5", "brownfield"),
      pipeline: PipelineSectionSchema.parse({}),
    } as BoberConfig;
    expect(resolveEngineName(config)).toBe("ts");
  });
});

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

// ── Module-graph guard: selecting an engine must stay cheap ──────────
//
// `orchestrator/pipeline.ts` imports this selector, so every module the selector pulls at
// LOAD time is pulled into every pipeline run — including the `'ts'` runs that are the
// default. `src/pge/registry/index.ts` is the node library's composition root and reaches
// the five shipped agents and the `src/state/` writers through `../nodes/effects.js`; when
// PgeEngine imported it statically, four unrelated pipeline suites failed on a partially
// mocked `../state/index.js`. `PgeEngine` therefore imports it INSIDE its registries
// factory, and this test is what keeps that true.

describe("selector module graph (regression guard)", () => {
  /** Every module reachable from `entry` through STATIC, value-carrying imports. */
  async function staticImportClosure(entry: string): Promise<Set<string>> {
    const { readFile } = await import("node:fs/promises");
    const { dirname, resolve } = await import("node:path");

    const seen = new Set<string>();
    const queue: string[] = [entry];

    while (queue.length > 0) {
      const file = queue.shift() as string;
      if (seen.has(file)) continue;
      seen.add(file);

      let source: string;
      try {
        source = await readFile(file, "utf-8");
      } catch {
        continue; // a .d.ts-only or external module: not part of this repo's graph
      }

      for (const line of source.split("\n")) {
        // `import type { … } from` is erased by tsc and creates no runtime edge.
        if (/^\s*import\s+type\b/.test(line)) continue;
        const match = /^\s*(?:import|export)\b[^'"]*from\s+["'](\.[^"']+)["']/.exec(line);
        if (match === null) continue;
        const spec = match[1].replace(/\.js$/, ".ts");
        queue.push(resolve(dirname(file), spec));
      }
    }
    return seen;
  }

  it("never reaches the PGE node library — the 'ts' default keeps its old module graph", async () => {
    const closure = await staticImportClosure(
      new URL("./selector.ts", import.meta.url).pathname,
    );

    // Sanity: the walker actually walked something real.
    expect([...closure].some((f) => f.endsWith("/pge/engine/pge-engine.ts"))).toBe(true);
    expect([...closure].some((f) => f.endsWith("/orchestrator/workflow/ts-engine.ts"))).toBe(true);

    const forbidden = [...closure].filter(
      (f) => f.includes("/src/pge/nodes/") || f.endsWith("/src/pge/registry/index.ts"),
    );
    expect(
      forbidden,
      "the selector must not statically reach the PGE node library — import it lazily inside PgeEngine's registries factory",
    ).toEqual([]);
  });
});
