import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import type { BoberConfig } from "../../config/schema.js";
import type { TopologySpec } from "../../contracts/topology.js";
import type { PipelineFailure, PipelineResult } from "../../orchestrator/pipeline.js";
import type {
  PipelineEngine,
  PipelineEngineName,
  RunOptions,
} from "../../orchestrator/workflow/engine.js";
import { Scheduler } from "../../orchestrator/workflow/scheduler.js";
import { TsPipelineEngine } from "../../orchestrator/workflow/ts-engine.js";
import { logger } from "../../utils/logger.js";
import { TopologyCompileError, loadCompiledGraph } from "../compile/compiler.js";
import type { CompiledGraph, Registries } from "../compile/compiler.js";
import { createEffectRegistry } from "../registry/effects.js";
import type { CodingBindings } from "../registry/index.js";
import { createModelBinder } from "../registry/nodes.js";
import type { Clock, ModelProfile, PromptStore } from "../registry/nodes.js";
import { createArchiveWriter } from "../runtime/archive.js";
import { createSemanticCache } from "../runtime/cache.js";
import { createCommitBoundary, createSystemClock } from "../runtime/commit.js";
import { createFrontierPlanner } from "../runtime/frontier.js";
import { DEFAULT_MAX_SUPERSTEPS, createGraphInterpreter } from "../runtime/interpreter.js";
import type { GraphInterpreter, GraphRunResult, RunContext } from "../runtime/interpreter.js";
import { createBudgetLedger } from "../runtime/ledger.js";
import { createScratchStore } from "../runtime/scratch.js";
import type { ScratchStore } from "../runtime/scratch.js";
import { createTraceWriter } from "../runtime/trace.js";
import type { TraceWriter } from "../runtime/trace.js";
import { initialOverallState } from "../state/overall.js";
import { CODING_GRAPH_ID } from "../topology/coding.graph.js";
import { readPromptStore, readTopologyArtifact, topologyArtifactPath } from "../topology/dump.js";
import { validateTopology } from "../topology/validate.js";

/**
 * `PgeEngine` — the graph runtime behind the private {@link PipelineEngine} seam.
 *
 * ── It is opt-in, and a broken artifact cannot brick a run ──
 *
 * `config.pipeline.engine` still defaults to `'ts'` (sc-13-5); reaching this engine takes
 * an explicit `engine: "pge"` or a team whose `pipelineShape` says so. And when the
 * committed topology does not compile — a missing artifact, an artifact that fails
 * validation, a node the registries do not implement — {@link PgeEngine.run} logs ONE
 * line and re-dispatches {@link TsPipelineEngine} with the same arguments, so the run
 * still happens and its result is indistinguishable from a direct TS run (sc-13-4).
 *
 * That downgrade used to live in the SELECTOR, as a reserved-name guard
 * (`workflow/selector.ts`, before this sprint). Moving it here is the whole behavioural
 * change: selection now returns a real `PgeEngine`, and the fallback is a property of
 * running rather than of choosing — which is the only place that can know whether the
 * artifact actually compiles.
 *
 * ── One owner for the terminal side effects ──
 *
 * The pipeline-complete history event and the completion marker are emitted by
 * `finalizePipelineRun` (`orchestrator/finalize.ts`) and by nothing else. This engine
 * reaches it exactly as the runtime fixtures do — through
 * `CommitBoundary.finalize` (`runtime/commit.ts`) — and never emits either itself, so all
 * three engines converge on one emitter and a conformance failure has one interpretation
 * (sc-13-3).
 *
 * ── Everything is per-run ──
 *
 * Every store this engine builds takes `projectRoot` as its first argument and is
 * constructed inside `run()`. No module-level instance exists, which is what lets a
 * worktree run write into the worktree and nowhere else.
 */

// ── Errors ──────────────────────────────────────────────────────────

/**
 * A collaborator the coding topology needs, which this repository does not ship.
 *
 * Four of the graph's bindings — `reflect`, `critique`, `explain`, `mocks` — have no
 * implementation anywhere in agent-bober: nothing here has ever emitted a structured
 * problem reflection, a curator critique, a per-test explanation or a mock manifest.
 *
 * The default production binding is therefore a function that THROWS when invoked, and
 * deliberately not a stub that returns an empty answer. A stub would let a run complete
 * while fabricating the very evidence the graph asked for, and a conformance comparison
 * against that run would compare a fabrication. Throwing at INVOCATION rather than at
 * construction is equally deliberate: the graph still compiles (sc-13-1 is a claim about
 * the artifact and the registries agreeing, not about every collaborator existing), and a
 * caller that supplies its own binding never meets this error.
 */
export class UnboundCollaboratorError extends Error {
  constructor(readonly collaborator: string) {
    super(
      `The coding topology invoked "${collaborator}", which agent-bober does not ship an implementation for. ` +
        `Supply it through PgeEngineDeps.bindings; a silent stub would fabricate the evidence the node asked for.`,
    );
    this.name = "UnboundCollaboratorError";
  }
}

/**
 * The graph run did not reach a terminal state, so there are no run facts to finalize.
 *
 * Typed rather than flattened into a `success: false` result: an INTERRUPTED run is
 * paused at a superstep boundary awaiting a human decision and is not over, and returning
 * a `PipelineResult` for it would claim an outcome the run has not produced.
 */
export class PgeRunNotCompletedError extends Error {
  constructor(
    readonly runId: string,
    readonly status: GraphRunResult["status"],
    detail: string,
  ) {
    super(`pge run ${runId} ended with status '${status}' and produced no final result: ${detail}`);
    this.name = "PgeRunNotCompletedError";
  }
}

/** A `promptRef` the on-disk prompt store does not resolve. */
export class UnknownPromptRefError extends Error {
  constructor(
    readonly ref: string,
    readonly dir: string,
  ) {
    super(`Prompt ref "${ref}" does not resolve under ${dir}.`);
    this.name = "UnknownPromptRefError";
  }
}

// ── Downgrade ───────────────────────────────────────────────────────

/**
 * The ONE line a downgrade logs.
 *
 * A constant so the message is byte-identical on every path and a test can assert on it
 * without transcribing it — the same reason `downgradeReservedEngine` kept its message in
 * one place before this sprint moved the downgrade here.
 */
export const PGE_DOWNGRADE_LOG_LINE =
  "Engine 'pge' selected but the committed topology did not compile; downgrading to 'ts' for this run.";

// ── The superstep ceiling ──────────────────────────────────────────
//
// Sprint 4 of spec-20260812-pge-real-workload-errors diagnosed why `PgeEngine` never
// reached a terminal node over this repository's own committed 29 KB `PlanSpec` and its 14
// real `SprintContract`s, once sprint 3 removed the byte-cap wall: `DEFAULT_MAX_SUPERSTEPS`
// (`../runtime/interpreter.js`, 200) is the INTERPRETER's own conservative baseline for an
// arbitrary graph, and this engine passed no override at all, so every run — including one
// over a real 14-contract fan-out with `defaults.concurrency: 1` — inherited it.
//
// The diagnosis, run at two contract counts against the SAME committed workload
// (`real-workload.test.ts`, sc-4-3/sc-4-4): a 1-contract slice completes in 39 supersteps;
// the real 14-contract fan-out completes in 234, with every one of the 14 branches settling
// `"succeeded"` on its first attempt (no `sprint_correct` retries anywhere) and the ONLY
// recorded `TaskFailure` being the already-documented `commit` `FailClosed` refusal. That is
// INSUFFICIENT CEILING, not non-convergence: node activity keeps advancing through distinct
// contracts, the branch set drains completely, and the cost scales with the declared
// cross-contract `dependsOn` graph (`../runtime/frontier.ts`) under `concurrency: 1` — real
// work, not a stuck loop. See docs/pge-graph.md's "graph engine against a real workload"
// section for the full measurement.
//
// The fix mirrors `capForCorpusMax` (`../golden/workload.ts`, sprint 3): a cap is not a
// number someone picks, it is a deterministic FUNCTION of a measured cost with headroom,
// pinned by a test that recomputes it — never a hand-picked literal.

/** The headroom multiplier over the measured natural completion cost. Same discipline, same factor, as `../golden/workload.ts`'s `CAP_HEADROOM_FACTOR`. */
export const SUPERSTEP_HEADROOM_FACTOR = 2;

/**
 * The supersteps this repository's own committed real workload —
 * `spec-20260805-pge-graph-engineering` and its real 14 `SprintContract`s — takes to reach
 * a terminal node, measured by `real-workload.test.ts` with the ceiling raised far enough to
 * observe the run end to end. Pinned there: a fresh measurement that disagrees fails the
 * test that derives it, exactly as `../golden/workload.ts`'s corpus maxima are pinned
 * against a fresh read of the corpus.
 */
export const MEASURED_REAL_WORKLOAD_SUPERSTEPS = 234;

/**
 * The supersteps ceiling a measured natural cost justifies.
 *
 * Next power of two at or above `SUPERSTEP_HEADROOM_FACTOR * measuredSupersteps`, floored
 * at the interpreter's own {@link DEFAULT_MAX_SUPERSTEPS} so this function can never LOWER
 * the runaway guard below the interpreter's own baseline — it only ever raises it, and only
 * when a measurement justifies the raise.
 */
export function superstepsForMeasuredCost(measuredSupersteps: number): number {
  let cap = 1;
  while (cap < measuredSupersteps * SUPERSTEP_HEADROOM_FACTOR) cap *= 2;
  return Math.max(cap, DEFAULT_MAX_SUPERSTEPS);
}

/**
 * The ceiling `PgeEngine.run` configures for every run, through `ctx.maxSupersteps`.
 *
 * `superstepsForMeasuredCost(234) === 512` — comfortably above the measured 234-superstep
 * natural cost of this repository's own real workload, and still a guard: a graph that
 * genuinely fails to converge trips it just as `SuperstepLimitExceededError` always did,
 * only at 512 instead of 200. `src/pge/golden/executor.ts`'s fixtures are all well under
 * 200 already, so this raise changes nothing about the golden dataset (no `graphVersion`
 * bump follows from it — this is a runtime configuration, not a topology artifact change).
 */
export const PGE_ENGINE_MAX_SUPERSTEPS = superstepsForMeasuredCost(MEASURED_REAL_WORKLOAD_SUPERSTEPS);

// ── Deps ────────────────────────────────────────────────────────────

/** What a registries factory is handed. Everything is already resolved for this run. */
export interface PgeRegistriesInput {
  readonly spec: TopologySpec;
  readonly projectRoot: string;
  readonly runId: string;
  readonly config: BoberConfig;
  readonly clock: Clock;
  readonly trace: TraceWriter;
  readonly scratch: ScratchStore;
}

/**
 * Everything a test may replace, and nothing production wiring has to supply.
 *
 * Every member is OPTIONAL and defaults to the real production collaborator, so
 * `new PgeEngine()` is the shipped engine and `new PgeEngine({ registries })` is a test
 * that swapped one seam. There is no test-only constructor and no parallel engine class:
 * the object a test drives is the object `selectPipelineEngine` returns.
 */
export interface PgeEngineDeps {
  /** Default {@link createGraphInterpreter}. */
  interpreterFactory?: () => GraphInterpreter;
  /** Default {@link productionRegistries}. */
  registries?: PgeRegistriesFactory;
  /** Default {@link CODING_GRAPH_ID}. */
  graphId?: string;
  /** Default {@link createSystemClock}. */
  clock?: Clock;
  /** Where a downgrade re-dispatches. Default a fresh {@link TsPipelineEngine}. */
  fallback?: () => PipelineEngine;
  /** Collaborators to bind on top of the production defaults. */
  bindings?: (input: PgeRegistriesInput) => CodingBindings | Promise<CodingBindings>;
}

/**
 * How a run gets its registries. May be async, and the production default IS.
 *
 * ── Why the production default is lazy ──
 *
 * `selector.ts` imports this module, and `orchestrator/pipeline.ts` imports the selector —
 * so anything this module pulls at LOAD time is pulled into every pipeline run, including
 * every run that never selects `'pge'`. `src/pge/registry/index.ts` is the composition root
 * of the whole node library: through `../nodes/effects.js` it reaches the five shipped
 * agents, the security gate, the git primitive and the `src/state/` writers. Its own header
 * already says it must not enter the `bober pge` command path; the pipeline path is the
 * same hazard one level up.
 *
 * So the barrel is imported INSIDE the factory, when a run has actually chosen this engine.
 * That is a real property, not a micro-optimisation: it is what keeps `'ts'` runs' module
 * graph exactly what it was before this engine existed.
 */
export type PgeRegistriesFactory = (
  input: PgeRegistriesInput,
) => Registries | Promise<Registries>;

// ── Production bindings ─────────────────────────────────────────────

function unbound(collaborator: string): () => never {
  return () => {
    throw new UnboundCollaboratorError(collaborator);
  };
}

/**
 * The bindings a real run uses.
 *
 * `runtime` is REAL: the sandbox is the only process-execution route a node body may
 * reach, and it is rooted at this run's `projectRoot`, `runId` and trace. The four
 * collaborators this repository does not ship are bound to {@link UnboundCollaboratorError}
 * throwers — see that class for why a stub would be worse than a failure.
 */
export async function productionRegionBindings(
  input: PgeRegistriesInput,
): Promise<CodingBindings> {
  // Lazy for the reason {@link PgeRegistriesFactory} gives: `SandboxRunner` is the node
  // library's process spawner, and no `'ts'` run should load it.
  const { createSandboxRunner } = await import("../runtime/sandbox.js");
  return {
    runtime: {
      sandbox: createSandboxRunner(input.projectRoot, input.runId, input.trace),
      scratch: input.scratch,
      trace: input.trace,
    },
    reflect: unbound("reflect"),
    critique: unbound("critique"),
    explain: unbound("explain"),
    mocks: unbound("mocks"),
  };
}

/** The registries a real run compiles the committed artifact against. */
export async function productionRegistries(input: PgeRegistriesInput): Promise<Registries> {
  const { codingRegistries } = await import("../registry/index.js");
  return codingRegistries(input.spec, await productionRegionBindings(input));
}

// ── Model profile ───────────────────────────────────────────────────

/**
 * The two model bindings the graph's declared tiers resolve to, read off config.
 *
 * A topology names a TIER and never a model (`registry/nodes.ts`), so the mapping lives
 * here: `frontier` is the planner's model, `light` is the generator's. Both are read from
 * the config the run was given rather than from a module constant, so a project that
 * changed either changes what its graph binds.
 */
export function modelProfileFromConfig(config: BoberConfig): ModelProfile {
  const planner = config.planner;
  const generator = config.generator;
  return {
    frontier: {
      provider: planner?.provider ?? "anthropic",
      modelId: planner?.model ?? "opus",
      ...(planner?.endpoint == null ? {} : { endpoint: planner.endpoint }),
    },
    light: {
      provider: generator?.provider ?? "anthropic",
      modelId: generator?.model ?? "sonnet",
      ...(generator?.endpoint == null ? {} : { endpoint: generator.endpoint }),
    },
  };
}

// ── Prompt store ────────────────────────────────────────────────────

/**
 * The run's prompt store, backed by `.bober/prompts/`.
 *
 * `has` answers from the ref set the topology layer already derives; `get` reads the file
 * and throws {@link UnknownPromptRefError} for a ref that does not resolve, rather than
 * returning empty text — an LLM node handed an empty prompt would produce output that
 * looks like a model failure instead of a missing file.
 */
export async function createFilePromptStore(projectRoot: string): Promise<PromptStore> {
  const store = await readPromptStore(projectRoot);
  const refs: ReadonlySet<string> = store.available ? store.refs : new Set<string>();
  const dir = store.dir;
  return {
    has: (ref) => refs.has(ref),
    get: async (ref) => {
      if (!refs.has(ref)) throw new UnknownPromptRefError(ref, dir);
      return readFile(join(dir, `${ref}.md`), "utf-8");
    },
  };
}

// ── Spec read ───────────────────────────────────────────────────────

/**
 * The committed artifact, validated, as a {@link TopologySpec}.
 *
 * Read BEFORE `loadCompiledGraph` because the registries are a function of the spec — the
 * node implementations bind their ports off the artifact's own declarations — and
 * `loadCompiledGraph` takes registries as an argument. The artifact is therefore read
 * twice per run, which is one extra file read and buys the property that the graph the
 * interpreter executes came out of the SANCTIONED loader (validation included) rather
 * than out of a private code path this engine assembled.
 *
 * Failures are raised as {@link TopologyCompileError} with the same diagnostic shape
 * `loadCompiledGraph` uses, so the downgrade in `run()` has exactly one error class to
 * catch.
 */
export async function readValidatedTopologySpec(
  projectRoot: string,
  graphId: string,
): Promise<TopologySpec> {
  const path = topologyArtifactPath(projectRoot, graphId);
  const artifact = await readTopologyArtifact(path);
  if (!artifact.ok) {
    throw new TopologyCompileError(
      `Cannot load topology artifact ${path} (${artifact.reason}): ${artifact.message}`,
      [
        {
          code: "SchemaViolation",
          severity: "error",
          message: `Topology artifact ${path} could not be read (${artifact.reason}): ${artifact.message}`,
          nodeIds: [],
          edgeIds: [],
        },
      ],
    );
  }

  const report = validateTopology(artifact.raw, { mode: "structural" });
  if (!report.ok || !report.spec) {
    const errors = report.diagnostics.filter((d) => d.severity === "error");
    throw new TopologyCompileError(
      `Topology artifact ${path} is invalid: ${String(errors.length)} error diagnostic(s).`,
      errors,
    );
  }
  return report.spec;
}

// ── Engine ──────────────────────────────────────────────────────────

export class PgeEngine implements PipelineEngine {
  readonly name: PipelineEngineName = "pge";

  constructor(private readonly deps: PgeEngineDeps = {}) {}

  async run(
    userPrompt: string,
    projectRoot: string,
    config: BoberConfig,
    opts?: RunOptions,
  ): Promise<PipelineResult> {
    const clock = this.deps.clock ?? createSystemClock();
    const graphId = this.deps.graphId ?? CODING_GRAPH_ID;
    const runId = opts?.runId ?? `run-${String(clock.nowMs())}`;
    const startedAtMs = clock.nowMs();

    const scratch = createScratchStore(projectRoot);

    // ── Load and compile, or downgrade ───────────────────────────────
    let trace: TraceWriter | null = null;
    let graph: CompiledGraph;
    let registries: Registries;
    try {
      trace = await createTraceWriter(projectRoot, runId, { now: () => clock.now() });
      const spec = await readValidatedTopologySpec(projectRoot, graphId);
      const input: PgeRegistriesInput = {
        spec,
        projectRoot,
        runId,
        config,
        clock,
        trace,
        scratch,
      };
      registries = await (this.deps.registries ?? this.defaultRegistries())(input);
      graph = await loadCompiledGraph(projectRoot, graphId, registries);
    } catch (error) {
      // A downgraded run produced no spans, so it must not leave a trace claiming
      // otherwise. The file is opened before the compile because the sprint region's
      // sandbox is built around it; discarding it here is what keeps the downgrade path
      // free of side effects a direct TS run would not have.
      await discardTrace(trace);
      if (error instanceof TopologyCompileError) {
        logger.info(PGE_DOWNGRADE_LOG_LINE);
        const fallback = (this.deps.fallback ?? (() => new TsPipelineEngine()))();
        return fallback.run(userPrompt, projectRoot, config, opts);
      }
      throw error;
    }

    // ── Run ──────────────────────────────────────────────────────────
    const commit = createCommitBoundary({ clock });
    const ctx: RunContext = {
      runId,
      projectRoot,
      config,
      clock,
      signal: opts?.signal ?? new AbortController().signal,
      trace,
      scheduler: new Scheduler({ maxConcurrent: graph.spec.defaults.concurrency }),
      ledger: createBudgetLedger(),
      // The measured-basis ceiling above, not the interpreter's own conservative
      // DEFAULT_MAX_SUPERSTEPS — see "The superstep ceiling" section of this file's header.
      maxSupersteps: PGE_ENGINE_MAX_SUPERSTEPS,
      // Absent means UNCAPPED, which is the shipped default: `pipeline.budget` is optional
      // and `maxUsd` is nullable, and both spellings of "no ceiling" reach the interpreter
      // as `undefined` rather than as a zero that would abort every run instantly.
      ...(config.pipeline?.budget?.maxUsd == null
        ? {}
        : { budgetCeilingUsd: config.pipeline.budget.maxUsd }),
      commit,
      planner: createFrontierPlanner(),
      services: {
        // `Registries.effects` is optional to `compile()` — it carries the registry for
        // the interpreter's convenience and never consults it. A run needs one, so an
        // absent registry becomes an EMPTY one: every `ctx.effects.invoke` then fails with
        // `EffectNotRegisteredError`, which names the effect, rather than a TypeError.
        effects: registries.effects ?? createEffectRegistry(),
        scratch,
        archive: createArchiveWriter(projectRoot),
        cache: createSemanticCache(projectRoot, runId),
        prompts: await createFilePromptStore(projectRoot),
        models: createModelBinder(modelProfileFromConfig(config)),
      },
    };

    const interpreter = (this.deps.interpreterFactory ?? createGraphInterpreter)();
    let result: GraphRunResult;
    try {
      result = await interpreter.run(
        graph,
        initialOverallState({ runId, projectRoot, featureRequest: userPrompt }),
        ctx,
      );
    } catch (error) {
      await closeQuietly(trace);
      // The trace is flushed and the error is re-thrown UNCHANGED — no wrapping, no
      // downgrade, no `success: false` result carrying a message.
      //
      // That matters most for `BudgetExceededError` (`src/pge/runtime/ledger.ts`, which
      // re-exports the ONE class from `orchestrator/workflow/budget.ts`): a ledger ceiling
      // ABORTS the run,
      // and the abort has to reach the caller as the CLASS the ledger threw, with its
      // `kind`, so `catch (e) { if (e instanceof BudgetExceededError) }` keeps working
      // across the seam. `PipelineResult` has no error channel and this sprint may not add
      // one (nonGoal 3), so propagation is what "typed" can mean here. The run is
      // deliberately NOT finalized either: a run that stopped because it ran out of money
      // did not complete, and a completion marker would say it did.
      throw error;
    }
    await closeQuietly(trace);

    // ── Finalize through the single owner ────────────────────────────
    if (result.status === "interrupted") {
      throw new PgeRunNotCompletedError(
        runId,
        result.status,
        `paused at superstep ${String(result.supersteps)} for checkpoint '${result.pending.checkpointId}'`,
      );
    }

    // `completed` and `aborted` are both OVER, so both finalize. The verdict `finalize.ts`
    // reports is derived from the SPRINT SPLIT and from nothing else — the frozen formula
    // `failedSprints.length === 0 && completedSprints.length > 0` (`deriveRunSuccess`),
    // shared with the imperative engine precisely so the two cannot disagree about the same
    // facts. `errors` is layered AFTER finalization returns, exactly as
    // `RunResultFlusher.flush` layers `needsClarification` onto `finalizePipelineRun`'s
    // result (`workflow/flusher.ts:113-127`) — so the shared fields stay produced in
    // exactly one place and the two engines cannot disagree about them either.
    //
    // ── The error channel, sourced from the interpreter's own richer verdict ──
    //
    // `result` is narrowed to `completed | aborted` by the `interrupted` throw above, and
    // both variants declare `readonly failures: readonly TaskFailure[]`
    // (`runtime/interpreter.ts`) — the interpreter's own `verdictFrom` DOES account for task
    // failures, unlike the sprint-split-only formula `finalize.ts` uses. So a run in which a
    // fail-closed gate refused the `git`-effect `commit` node — the shipped sc-12-9
    // behaviour under an autopilot `noop` mechanism, which grants nothing — still reports
    // `success: true` from the sprint-split formula (every sprint did pass; the terminal
    // commit is not a sprint), but now ALSO reports that refusal through `errors`.
    //
    // The spread is CONDITIONAL, not unconditional: `errors` is present only when
    // `result.failures` is non-empty, so a clean run's `PipelineResult` keeps exactly the
    // frozen five keys `finalizePipelineRun` returns (sc-5-5) and `Object.keys()` on it is
    // unaffected.
    //
    // Widening the sprint split to absorb a terminal-node failure remains deliberately NOT
    // done: it would invent a FAILED SPRINT that did not happen, and would put the two
    // engines' shared success formula back into disagreement (spec-20260812-pge-real-
    // workload-errors, resolvedClarifications D3 — Option A). `conformance.engines.test.ts`
    // still records the divergence end to end.
    const finalized = await commit.finalize(result.state, {
      runId,
      projectRoot,
      config,
      superstep: result.supersteps,
      startedAtMs,
    });
    return {
      ...finalized,
      ...(result.failures.length === 0
        ? {}
        : {
            errors: result.failures.map(
              (failure): PipelineFailure => ({
                nodeId: failure.nodeId,
                branchKey: failure.branchKey,
                errorClass: failure.errorClass,
                message: failure.message,
              }),
            ),
          }),
    };
  }

  private defaultRegistries(): PgeRegistriesFactory {
    const bindings = this.deps.bindings;
    if (bindings === undefined) return productionRegistries;
    return async (input) => {
      const { codingRegistries } = await import("../registry/index.js");
      return codingRegistries(input.spec, await bindings(input));
    };
  }
}

// ── Trace lifecycle ─────────────────────────────────────────────────

/** Close the writer, swallowing a flush error so it cannot mask the run's own outcome. */
async function closeQuietly(trace: TraceWriter): Promise<void> {
  try {
    await trace.close();
  } catch (error) {
    logger.debug(`[pge] trace flush failed for ${trace.path()}: ${String(error)}`);
  }
}

/** Close and delete a trace that describes a run which never started. */
async function discardTrace(trace: TraceWriter | null): Promise<void> {
  if (trace === null) return;
  await closeQuietly(trace);
  await rm(trace.path(), { force: true });
}
