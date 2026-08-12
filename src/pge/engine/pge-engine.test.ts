// ── pge-engine.test.ts ──────────────────────────────────────────────
//
// sc-13-4 (the downgrade), plus the engine's own contract: it satisfies the private
// PipelineEngine seam, it finalizes through the sprint-4 single owner, and a budget
// ceiling aborts it with a TYPED error rather than a failure string.
//
// Real temp roots, real `.bober/` writes, the real interpreter and the real commit
// boundary. Only two things are injected, and both through the shipped deps bag:
// `graphId`/`registries` (so a run has a topology that compiles today) and, for the
// downgrade case, nothing at all — the default fallback is the real TsPipelineEngine.

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../utils/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
    phase: vi.fn(),
    sprint: vi.fn(),
    progress: vi.fn(),
  },
}));

// A WHOLE-module factory, not a spread of the original: `pipeline.js` imports the
// selector, which imports this engine, which imports `ts-engine.js`, which imports
// `pipeline.js` — so `importOriginal()` would resolve that cycle against the REAL module
// and leave `ts-engine` bound to the real `runTsPipeline`. `runTsPipeline` is the only
// runtime value anything in this test's module graph takes from `pipeline.js`; every other
// importer takes the `PipelineResult` TYPE, which is erased.
vi.mock("../../orchestrator/pipeline.js", () => ({
  runTsPipeline: vi.fn(),
}));

import { logger } from "../../utils/logger.js";
import { runTsPipeline } from "../../orchestrator/pipeline.js";
import type { PipelineFailure, PipelineResult } from "../../orchestrator/pipeline.js";
import type { PlanSpec } from "../../contracts/spec.js";
import { saveSpec } from "../../state/plan-state.js";
import { TsPipelineEngine } from "../../orchestrator/workflow/ts-engine.js";
import type { PipelineEngine, RunOptions } from "../../orchestrator/workflow/engine.js";
import { createDefaultConfig } from "../../config/schema.js";
import type { BoberConfig } from "../../config/schema.js";
import { PIPELINE_COMPLETE_EVENT, completionMarkerPath } from "../../orchestrator/finalize.js";
import { loadHistory } from "../../state/history.js";
import {
  PGE_DOWNGRADE_LOG_LINE,
  PgeEngine,
  UnboundCollaboratorError,
  modelProfileFromConfig,
  productionRegionBindings,
} from "./pge-engine.js";
import type { PgeRegistriesInput } from "./pge-engine.js";
import { TopologyCompileError } from "../compile/compiler.js";
import type { Registries } from "../compile/compiler.js";
import { createNodeRegistry } from "../registry/nodes.js";
import { createReducerRegistry } from "../registry/reducers.js";
import { createEffectRegistry } from "../registry/effects.js";
import { BudgetExceededError } from "../runtime/ledger.js";
import { createFixedClock } from "../runtime/commit.js";
import { tracePath } from "../runtime/trace.js";
import { FAIL_CLOSED_ERROR_CLASS, LOOP_EXHAUSTED_ERROR_CLASS } from "../runtime/interpreter.js";
import type { GraphInterpreter, GraphRunResult } from "../runtime/interpreter.js";
import type { CodingBindings } from "../registry/index.js";
import {
  GOLDEN_GRAPH_ID,
  goldenContracts,
  goldenRegistries,
  goldenSchemaCatalog,
  goldenSpec,
} from "../runtime/__fixtures__/golden-graph.js";
import {
  CODING_GRAPH_ID as WHOLE_GRAPH_CODING_GRAPH_ID,
  conformanceConfig,
  goldenPlanSpec,
  seedCommittedArtifact,
  wholeGraphBindings,
} from "./__fixtures__/whole-graph.js";

// ── Temp roots ──────────────────────────────────────────────────────

let tmpRoots: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  tmpRoots = [];
});

afterEach(async () => {
  await Promise.all(tmpRoots.map((r) => rm(r, { recursive: true, force: true })));
  tmpRoots = [];
});

async function mkTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bober-pge-engine-"));
  tmpRoots.push(dir);
  return dir;
}

/** A root carrying the GOLDEN artifact, which compiles against the golden registries. */
async function rootWithGoldenArtifact(): Promise<string> {
  const root = await mkTmp();
  await mkdir(join(root, ".bober", "topology"), { recursive: true });
  await writeFile(
    join(root, ".bober", "topology", `${GOLDEN_GRAPH_ID}.json`),
    JSON.stringify(goldenSpec(), null, 2),
    "utf-8",
  );
  return root;
}

function config(): BoberConfig {
  return createDefaultConfig("pge-engine-test", "brownfield");
}

const FIXED_CLOCK_ISO = "2026-08-05T00:00:00.000Z";

// ── Seam conformance ────────────────────────────────────────────────

describe("PgeEngine — the PipelineEngine seam", () => {
  it("declares name 'pge' and satisfies PipelineEngine structurally", () => {
    const engine: PipelineEngine = new PgeEngine();
    expect(engine.name).toBe("pge");
    expect(typeof engine.run).toBe("function");
  });

  it("takes an OPTIONAL deps bag — `new PgeEngine()` is the shipped engine", () => {
    expect(() => new PgeEngine()).not.toThrow();
    expect(() => new PgeEngine({})).not.toThrow();
    expect(new PgeEngine({ graphId: "other" }).name).toBe("pge");
  });
});

// ── sc-13-4: the downgrade ──────────────────────────────────────────

describe("PgeEngine — TopologyCompileError downgrade (sc-13-4)", () => {
  /**
   * `runTsPipeline` is the ONE thing stubbed, and it is stubbed as a pure function of its
   * arguments. That is what makes "indistinguishable from a direct TS run for the same
   * input" a real claim: if the downgrade altered the prompt, the root, the config or the
   * options, the two results would differ.
   */
  function stubTsPipeline(): void {
    vi.mocked(runTsPipeline).mockImplementation(
      (
        userPrompt: string,
        projectRoot: string,
        cfg: BoberConfig,
        opts?: RunOptions,
      ): Promise<PipelineResult> =>
        Promise.resolve({
          success: true,
          spec: {
            specId: `spec-for-${userPrompt}`,
            title: projectRoot,
            description: cfg.project.name,
          },
          completedSprints: [],
          failedSprints: [],
          duration: 7,
          needsClarification: opts?.resume === true,
        } as unknown as PipelineResult),
    );
  }

  it("logs EXACTLY ONE line and re-dispatches TS when the artifact is missing", async () => {
    stubTsPipeline();
    const root = await mkTmp(); // no .bober/topology/ at all

    const result = await new PgeEngine().run("build a thing", root, config(), {
      runId: "run-downgrade-1",
    });

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.info).mock.calls[0]![0]).toBe(PGE_DOWNGRADE_LOG_LINE);
    expect(runTsPipeline).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });

  it("produces a PipelineResult indistinguishable from a DIRECT TsPipelineEngine run", async () => {
    stubTsPipeline();
    const root = await mkTmp();
    const cfg = config();
    const opts: RunOptions = { runId: "run-identical", teamId: "programming", resume: true };

    const viaPge = await new PgeEngine().run("same prompt", root, cfg, opts);
    vi.clearAllMocks();
    const viaTs = await new TsPipelineEngine().run("same prompt", root, cfg, opts);

    expect(viaPge).toEqual(viaTs);
    // …and the arguments the fallback forwarded were the SAME arguments, verbatim.
    expect(runTsPipeline).toHaveBeenCalledWith("same prompt", root, cfg, opts);
  });

  it("downgrades on a REGISTRY failure too, not only on a missing file", async () => {
    stubTsPipeline();
    const root = await rootWithGoldenArtifact();

    // Registries with no node implementations at all: every declared node is
    // UnregisteredNodeImpl, which is a TopologyCompileError from compile() rather than
    // from the artifact read.
    const empty = (): Registries => ({
      nodes: createNodeRegistry(),
      reducers: createReducerRegistry(),
      effects: createEffectRegistry(),
      schemas: goldenSchemaCatalog(),
    });

    const result = await new PgeEngine({ graphId: GOLDEN_GRAPH_ID, registries: empty }).run(
      "build a thing",
      root,
      config(),
      { runId: "run-downgrade-2" },
    );

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.info).mock.calls[0]![0]).toBe(PGE_DOWNGRADE_LOG_LINE);
    expect(result.success).toBe(true);
  });

  it("leaves NO trace file behind — a downgraded run produced no spans", async () => {
    stubTsPipeline();
    const root = await mkTmp();

    await new PgeEngine().run("build a thing", root, config(), { runId: "run-no-trace" });

    await expect(stat(tracePath(root, "run-no-trace"))).rejects.toThrow();
  });

  it("does NOT downgrade on a non-TopologyCompileError — that would hide a real defect", async () => {
    stubTsPipeline();
    const root = await rootWithGoldenArtifact();
    const boom = new Error("registry construction blew up");

    await expect(
      new PgeEngine({
        graphId: GOLDEN_GRAPH_ID,
        registries: () => {
          throw boom;
        },
      }).run("build a thing", root, config(), { runId: "run-not-a-downgrade" }),
    ).rejects.toBe(boom);

    expect(logger.info).not.toHaveBeenCalled();
    expect(runTsPipeline).not.toHaveBeenCalled();
  });

  it("re-dispatches through the INJECTED fallback when one is supplied", async () => {
    const root = await mkTmp();
    const fallbackResult = {
      success: false,
      spec: { specId: "s" },
      completedSprints: [],
      failedSprints: [],
      duration: 1,
    } as unknown as PipelineResult;
    const fallback: PipelineEngine = {
      name: "ts",
      run: vi.fn(() => Promise.resolve(fallbackResult)),
    };

    const result = await new PgeEngine({ fallback: () => fallback }).run(
      "prompt",
      root,
      config(),
      { runId: "run-injected-fallback" },
    );

    expect(result).toBe(fallbackResult);
    expect(fallback.run).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledTimes(1);
  });
});

// ── A real run through the seam ─────────────────────────────────────

describe("PgeEngine — a real graph run finalizes through the single owner", () => {
  it("runs the interpreter and returns the CommitBoundary's PipelineResult", async () => {
    const root = await rootWithGoldenArtifact();
    const contracts = goldenContracts(2);

    const result = await new PgeEngine({
      graphId: GOLDEN_GRAPH_ID,
      registries: () => goldenRegistries({ contracts }),
      clock: createFixedClock(FIXED_CLOCK_ISO),
    }).run("Exercise the superstep interpreter end to end.", root, config(), {
      runId: "run-pge-real",
    });

    expect(result.spec).toBeDefined();
    expect(result.completedSprints.map((c) => c.contractId).sort()).toEqual(
      contracts.map((c) => c.contractId).sort(),
    );
    expect(result.failedSprints).toEqual([]);
    expect(result.success).toBe(true);

    // The completion marker and the pipeline-complete event exist, and neither was
    // written by this engine: `CommitBoundary.finalize` delegates to `finalizePipelineRun`,
    // which is the only writer of both (sc-13-3's owner).
    await expect(stat(completionMarkerPath(root, "run-pge-real"))).resolves.toBeDefined();
    const marker: unknown = JSON.parse(
      await readFile(completionMarkerPath(root, "run-pge-real"), "utf-8"),
    );
    expect((marker as { runId: string }).runId).toBe("run-pge-real");

    const history = await loadHistory(root);
    const complete = history.filter((e) => e.event === PIPELINE_COMPLETE_EVENT);
    expect(complete).toHaveLength(1);
  });

  it("writes its trace under the run's OWN project root and nowhere else", async () => {
    const root = await rootWithGoldenArtifact();

    await new PgeEngine({
      graphId: GOLDEN_GRAPH_ID,
      registries: () => goldenRegistries({ contracts: goldenContracts(1) }),
      clock: createFixedClock(FIXED_CLOCK_ISO),
    }).run("Exercise the superstep interpreter end to end.", root, config(), {
      runId: "run-pge-trace",
    });

    await expect(stat(tracePath(root, "run-pge-trace"))).resolves.toBeDefined();
  });

  it("uses the injected interpreter factory rather than constructing its own", async () => {
    const root = await rootWithGoldenArtifact();
    const inner: GraphInterpreter = {
      run: vi.fn(
        (_graph, init): Promise<GraphRunResult> =>
          Promise.reject(new BudgetExceededError(`stopped at ${init.runId}`, "usd")),
      ),
      resume: vi.fn(),
    };

    await expect(
      new PgeEngine({
        graphId: GOLDEN_GRAPH_ID,
        registries: () => goldenRegistries({ contracts: goldenContracts(1) }),
        interpreterFactory: () => inner,
      }).run("prompt", root, config(), { runId: "run-injected-interpreter" }),
    ).rejects.toBeInstanceOf(BudgetExceededError);

    expect(inner.run).toHaveBeenCalledTimes(1);
  });
});

// ── The error channel (sprint 5 of spec-20260812-pge-real-workload-errors) ──
//
// sc-5-1  PipelineFailure is a 1:1 map of TaskFailure minus `superstep`.
// sc-5-2  the array is layered onto the single owner's result, not inside it.
// sc-5-4  a FAIL_CLOSED refusal of the git-effect `commit` node is reported through it.
// sc-5-5's TS-engine half lives in `src/orchestrator/finalize.e2e.test.ts` — this file's
// whole-module mock of `pipeline.js` (see the header) makes a genuine `TsPipelineEngine`
// assertion impossible here.

describe("PgeEngine — the `errors` channel (sc-5-1, sc-5-2, sc-5-4)", () => {
  it("a FAIL_CLOSED refusal of the git-effect `commit` node populates `errors`, mapped 1:1 from TaskFailure minus `superstep`", async () => {
    const root = await mkTmp();
    await seedCommittedArtifact(root);

    const result = await new PgeEngine({
      graphId: WHOLE_GRAPH_CODING_GRAPH_ID,
      bindings: (input) => wholeGraphBindings(input),
    }).run("Wire the error channel onto the engine.", root, conformanceConfig(), {
      runId: "run-errors",
    });

    // sc-5-2: the array is present on the RETURNED PipelineResult, layered after
    // finalization — not something `finalizePipelineRun` itself ever produces (proven
    // separately by `finalize.test.ts`'s untouched frozen-key-order pin).
    expect("errors" in result).toBe(true);
    const errors = result.errors as readonly PipelineFailure[];
    expect(errors.length).toBeGreaterThan(0);

    const commitFailure = errors.find((failure) => failure.nodeId === "commit");
    expect(commitFailure).toBeDefined();
    expect(commitFailure!.errorClass).toBe(FAIL_CLOSED_ERROR_CLASS);
    // The root-level `commit` node has no branch, measured in the curator's briefing.
    expect(commitFailure!.branchKey).toBeNull();
    expect(typeof commitFailure!.message).toBe("string");
    expect(commitFailure!.message.length).toBeGreaterThan(0);

    // sc-5-1: exactly the four mapped fields — `superstep` did NOT survive the map.
    expect(Object.keys(commitFailure!).sort()).toEqual([
      "branchKey",
      "errorClass",
      "message",
      "nodeId",
    ]);
    expect("superstep" in commitFailure!).toBe(false);

    // Option A (D3): `success` still follows the frozen sprint-split formula and does not
    // flip for a terminal-node refusal that is not a sprint.
    expect(result.success).toBe(true);
  });

  it("does not add an `errors` key to a run with no interpreter failures", async () => {
    const root = await rootWithGoldenArtifact();

    const result = await new PgeEngine({
      graphId: GOLDEN_GRAPH_ID,
      registries: () => goldenRegistries({ contracts: goldenContracts(1) }),
      clock: createFixedClock(FIXED_CLOCK_ISO),
    }).run("Exercise the superstep interpreter end to end.", root, config(), {
      runId: "run-no-errors",
    });

    // Checked with `in`, not `=== undefined`: sc-5-5's twin claim, on the pge side —
    // a clean run's `PipelineResult` keeps exactly the frozen five keys.
    expect("errors" in result).toBe(false);
    expect(Object.keys(result).sort()).toEqual(
      ["completedSprints", "duration", "failedSprints", "spec", "success"].sort(),
    );
  });
});

// ── A plan that never settles (sprint 7 of spec-20260812-pge-real-workload-errors) ──
//
// sc-7-3  commit.finalize falls back to specDraft and RESOLVES instead of throwing
//         FinalizeWithoutSpecError, with success false and needsClarification true.
// sc-7-4  the narrowed FinalizeWithoutSpecError still exists — this file's OTHER branch
//         (neither spec nor specDraft) is proved directly against the boundary in
//         commit.test.ts; this describes the branch a real run actually takes.

describe("PgeEngine — a plan that never settles (sc-7-3)", () => {
  /** The planner asks the SAME open question on every round, and never accepts an answer. */
  function neverSettlingPlannerBindings(input: PgeRegistriesInput): CodingBindings {
    const base = wholeGraphBindings(input);
    return {
      ...base,
      planner: async () => {
        const spec: PlanSpec = {
          ...goldenPlanSpec(),
          status: "needs-clarification",
          clarificationQuestions: [
            {
              questionId: "q-retry-scope",
              category: "scope",
              question: "Should the retry block apply to every provider or only the default one?",
              ambiguityWeight: 5,
            },
          ],
          resolvedClarifications: [],
        };
        // The shipped planner persists whatever draft it produced; a fake that skipped
        // this would leave `.bober/specs/` disagreeing with a real run for a reason that
        // is not a behaviour change.
        await saveSpec(input.projectRoot, spec);
        return { kind: "needs-clarification" as const, spec };
      },
    };
  }

  it("resolves with success false, needsClarification true and a populated errors array, instead of throwing FinalizeWithoutSpecError", async () => {
    const root = await mkTmp();
    await seedCommittedArtifact(root);

    const result = await new PgeEngine({
      graphId: WHOLE_GRAPH_CODING_GRAPH_ID,
      bindings: (input) => neverSettlingPlannerBindings(input),
    }).run(
      "Accept an optional retry block in the pipeline config and validate it.",
      root,
      conformanceConfig(),
      { runId: "run-clarify-exhausted" },
    );

    expect(result.success).toBe(false);
    expect(result.needsClarification).toBe(true);
    expect(result.spec.clarificationQuestions.length).toBeGreaterThan(0);
    expect(result.completedSprints).toEqual([]);
    expect(result.failedSprints).toEqual([]);

    // sc-7-3: the machinery sprint 5 shipped populates `errors` once finalize stops
    // throwing — the interpreter records a LoopExhausted TaskFailure by construction the
    // moment `plan_clarify_check`'s declared bound reroutes to its onExhausted target.
    expect("errors" in result).toBe(true);
    const errors = result.errors as readonly PipelineFailure[];
    expect(errors.length).toBeGreaterThan(0);
    const exhausted = errors.find((failure) => failure.errorClass === LOOP_EXHAUSTED_ERROR_CLASS);
    expect(exhausted).toBeDefined();
    expect(exhausted!.nodeId).toBe("plan_clarify_check");

    // No completion marker: this run never reached a terminal artifact set.
    await expect(stat(completionMarkerPath(root, "run-clarify-exhausted"))).rejects.toThrow();
  });
});

// ── Budget ceiling ──────────────────────────────────────────────────

describe("PgeEngine — a budget ceiling aborts with a TYPED error", () => {
  it("propagates BudgetExceededError unchanged, with its `kind`, and finalizes nothing", async () => {
    const root = await rootWithGoldenArtifact();
    const thrown = new BudgetExceededError("Budget ceiling exceeded: spent $9 of $1.", "usd");
    const interpreter: GraphInterpreter = {
      run: vi.fn((): Promise<GraphRunResult> => Promise.reject(thrown)),
      resume: vi.fn(),
    };

    const promise = new PgeEngine({
      graphId: GOLDEN_GRAPH_ID,
      registries: () => goldenRegistries({ contracts: goldenContracts(1) }),
      interpreterFactory: () => interpreter,
    }).run("prompt", root, config(), { runId: "run-budget" });

    // The CLASS survives the seam — not a string, not a `success: false` result.
    await expect(promise).rejects.toBe(thrown);
    await expect(promise).rejects.toBeInstanceOf(BudgetExceededError);
    await promise.catch((error: unknown) => {
      expect(error).toBeInstanceOf(BudgetExceededError);
      expect((error as BudgetExceededError).kind).toBe("usd");
    });

    // A run that stopped because it ran out of money did not COMPLETE, so no completion
    // marker claims it did.
    await expect(stat(completionMarkerPath(root, "run-budget"))).rejects.toThrow();
  });
});

// ── Production wiring ───────────────────────────────────────────────

describe("PgeEngine — production wiring", () => {
  it("binds the graph's two model tiers off config, never off a module constant", () => {
    const base = config();
    const profile = modelProfileFromConfig(base);
    expect(profile.frontier.modelId).toBe(base.planner.model);
    expect(profile.light.modelId).toBe(base.generator.model);

    const retuned = modelProfileFromConfig({
      ...base,
      planner: { ...base.planner, model: "haiku", provider: "deepseek" },
    } as BoberConfig);
    expect(retuned.frontier).toMatchObject({ modelId: "haiku", provider: "deepseek" });
  });

  it("binds the four unshipped collaborators to throwers, not to silent stubs", async () => {
    const root = await rootWithGoldenArtifact();
    const input = {
      spec: goldenSpec(),
      projectRoot: root,
      runId: "run-bindings",
      config: config(),
      clock: createFixedClock(FIXED_CLOCK_ISO),
      trace: { begin: vi.fn(), path: () => "unused", close: vi.fn() },
      scratch: {},
    } as unknown as PgeRegistriesInput;

    const bindings = await productionRegionBindings(input);
    // Real, and rooted at THIS run.
    expect(bindings.runtime.trace).toBe(input.trace);
    expect(bindings.runtime.scratch).toBe(input.scratch);

    // A stub would return an empty answer and let a run fabricate the evidence the node
    // asked for. These refuse instead, and name themselves while doing it.
    for (const [name, fn] of [
      ["reflect", bindings.reflect],
      ["critique", bindings.critique],
      ["explain", bindings.explain],
      ["mocks", bindings.mocks],
    ] as const) {
      expect(() => (fn as () => unknown)()).toThrow(UnboundCollaboratorError);
      try {
        (fn as () => unknown)();
      } catch (error) {
        expect((error as UnboundCollaboratorError).collaborator).toBe(name);
      }
    }
  });

  it("readValidatedTopologySpec raises TopologyCompileError for a missing artifact", async () => {
    const root = await mkTmp();
    const { readValidatedTopologySpec } = await import("./pge-engine.js");
    await expect(readValidatedTopologySpec(root, "nope")).rejects.toBeInstanceOf(
      TopologyCompileError,
    );
  });
});
