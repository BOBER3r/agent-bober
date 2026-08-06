import type { BoberConfig } from "../../../config/schema.js";
import { createDefaultConfig } from "../../../config/schema.js";
import type { PlanSpec } from "../../../contracts/spec.js";
import type { SprintContract } from "../../../contracts/sprint-contract.js";
import type { Durability, TopologySpec } from "../../../contracts/topology.js";
import { Scheduler } from "../../../orchestrator/workflow/scheduler.js";
import type { Settled } from "../../../orchestrator/workflow/scheduler.js";
import { compile } from "../../compile/compiler.js";
import type { CompiledGraph } from "../../compile/compiler.js";
import { createEffectRegistry } from "../../registry/effects.js";
import { createModelBinder } from "../../registry/nodes.js";
import type { Clock, NodeImpl, NodeRegistry, PromptStore } from "../../registry/nodes.js";
import type { Reducer, ReducerRegistry } from "../../registry/reducers.js";
import type { OverallState } from "../../state/overall.js";
import { createArchiveWriter } from "../archive.js";
import { createSemanticCache } from "../cache.js";
import type { CheckpointRef, GraphCheckpointer } from "../checkpointer.js";
import { createCommitBoundary, createDomainArtifactWriter } from "../commit.js";
import type { CommitBoundary, DomainArtifactWriter } from "../commit.js";
import { createFrontierPlanner } from "../frontier.js";
import { createGraphInterpreter } from "../interpreter.js";
import type { GraphRunResult, RunContext } from "../interpreter.js";
import type { InterruptController } from "../interrupt.js";
import { createBudgetLedger } from "../ledger.js";
import { createScratchStore } from "../scratch.js";
import { createTraceWriter, readSpans } from "../trace.js";
import type { Span } from "../trace.js";
import { goldenInitialState, goldenRegistries, goldenSpec } from "./golden-graph.js";
import type { GoldenBehaviour } from "./golden-graph.js";

/**
 * The harness every runtime test runs the golden graph through.
 *
 * It exists so a test states WHAT it is asserting rather than re-assembling eleven
 * collaborators, and so every test gets the same three properties for free:
 *
 *  - a MONOTONIC LOGICAL CLOCK, so span timestamps are a total order a test can assert
 *    ordering against without ever asserting elapsed time;
 *  - a COUNTING reducer registry and a COUNTING artifact writer, so "exactly once" is
 *    proved by counting real invocations rather than by observing that a file exists;
 *  - real temp directories and real `.bober/` writes, because a filesystem mock would
 *    make the determinism comparison a comparison of the mock.
 */

// ── Clock ───────────────────────────────────────────────────────────

/**
 * A clock that advances one millisecond per read.
 *
 * Logical, not wall-clock: what the barrier tests need is a total ORDER over events, and
 * a real clock would give them a flaky one at millisecond resolution while inviting an
 * assertion about duration. Nothing in this sprint asserts duration.
 */
export function createMonotonicClock(startIso = "2026-08-05T00:00:00.000Z", stepMs = 1): Clock {
  let cursor = new Date(startIso).getTime();
  const tick = (): number => {
    const current = cursor;
    cursor += stepMs;
    return current;
  };
  return {
    now: () => new Date(tick()),
    nowMs: () => tick(),
    nowIso: () => new Date(tick()).toISOString(),
  };
}

// ── Counting wrappers ───────────────────────────────────────────────

export interface ReducerCallLog {
  /** Channel id -> number of `merge` invocations across the whole run. */
  readonly calls: Record<string, number>;
  /** One entry per invocation, in order, with the batch size it was handed. */
  readonly invocations: Array<{ reducerId: string; batchSize: number }>;
}

/**
 * Wrap a reducer registry so every `merge` is counted.
 *
 * The count is taken at the REDUCER, which is where the commit boundary applies a channel
 * — not at a node return, where a count would say how many updates were produced rather
 * than how many times state was written.
 */
export function countingReducerRegistry(inner: ReducerRegistry): {
  registry: ReducerRegistry;
  log: ReducerCallLog;
} {
  const calls: Record<string, number> = {};
  const invocations: Array<{ reducerId: string; batchSize: number }> = [];
  const registry: ReducerRegistry = {
    ids: () => inner.ids(),
    get(id) {
      const reducer = inner.get(id);
      if (!reducer) return undefined;
      const wrapped: Reducer<unknown> = {
        ...reducer,
        merge(current, updates) {
          calls[id] = (calls[id] ?? 0) + 1;
          invocations.push({ reducerId: id, batchSize: updates.length });
          return reducer.merge(current, updates);
        },
      };
      return wrapped;
    },
  };
  return { registry, log: { calls, invocations } };
}

export interface ArtifactWriteLog {
  readonly specs: string[];
  readonly contracts: string[];
}

/** Wrap the real `.bober/` writer so every write call is recorded, then performed. */
export function countingArtifactWriter(inner: DomainArtifactWriter = createDomainArtifactWriter()): {
  writer: DomainArtifactWriter;
  log: ArtifactWriteLog;
} {
  const specs: string[] = [];
  const contracts: string[] = [];
  return {
    writer: {
      async saveSpec(projectRoot: string, spec: PlanSpec): Promise<void> {
        specs.push(spec.specId);
        await inner.saveSpec(projectRoot, spec);
      },
      async saveContract(projectRoot: string, contract: SprintContract): Promise<void> {
        contracts.push(contract.contractId);
        await inner.saveContract(projectRoot, contract);
      },
    },
    log: { specs, contracts },
  };
}

export interface HandlerCallLog {
  /** Node id -> number of times its handler body was ENTERED, across this process. */
  readonly calls: Record<string, number>;
}

/**
 * Wrap a node registry so every handler ENTRY is counted.
 *
 * The write-counter spy the kill-and-resume invariant needs: "the node did not re-run"
 * is a claim about how many times a BODY executed, and nothing else — a span count would
 * also be satisfied by a run that re-executed a node and then discarded its result.
 */
export function countingNodeRegistry(inner: NodeRegistry): {
  registry: NodeRegistry;
  log: HandlerCallLog;
} {
  const calls: Record<string, number> = {};
  const registry: NodeRegistry = {
    ids: () => inner.ids(),
    register: (impl) => {
      inner.register(impl);
    },
    get(id) {
      const impl = inner.get(id);
      if (!impl) return undefined;
      const wrapped: NodeImpl = {
        ...impl,
        handler: (input, state, ctx) => {
          calls[id] = (calls[id] ?? 0) + 1;
          return impl.handler(input, state, ctx);
        },
      };
      return wrapped;
    },
  };
  return { registry, log: { calls } };
}

export interface DispatchLog {
  /** One entry per `settle` call, holding how many thunks were handed to the scheduler. */
  readonly batches: number[];
  /** Total thunks DISPATCHED across the run. */
  total(): number;
}

/**
 * A scheduler that records every DISPATCH ATTEMPT.
 *
 * The distinction the skip-before-dispatch criterion rests on: a task filtered off the
 * frontier is never handed to `settle` at all, whereas a task that was dispatched and then
 * returned early from inside its own body still shows up here. Comparing this total to
 * {@link HandlerCallLog} is what tells the two apart.
 */
export class RecordingScheduler extends Scheduler {
  readonly log: DispatchLog;

  constructor(opts: { maxConcurrent: number }) {
    super(opts);
    const batches: number[] = [];
    this.log = { batches, total: () => batches.reduce((a, b) => a + b, 0) };
  }

  override settle<T>(thunks: ReadonlyArray<() => Promise<T>>): Promise<Array<Settled<T>>> {
    this.log.batches.push(thunks.length);
    return super.settle(thunks);
  }
}

// ── Services ────────────────────────────────────────────────────────

function stubPromptStore(): PromptStore {
  return {
    has: () => true,
    get: async (ref: string) => `stub prompt for ${ref}`,
  };
}

// ── Harness ─────────────────────────────────────────────────────────

export interface RunGoldenOptions {
  projectRoot: string;
  behaviour: GoldenBehaviour;
  /** Tasks admitted per superstep. Defaults to the graph's own `defaults.concurrency` (1). */
  concurrency?: number;
  runId?: string;
  /** A topology other than the golden one, for the scope and deadlock fixtures. */
  spec?: TopologySpec;
  maxSupersteps?: number;
  /** Call `CommitBoundary.finalize` after the loop. Off by default. */
  finalize?: boolean;
  config?: BoberConfig;
  signal?: AbortSignal;
  /** Replace the boundary entirely, for the tests that need to observe it. */
  commit?: CommitBoundary;
  clock?: Clock;
  /** Persist a resumable snapshot. Absent means no `.bober/checkpoints/` tree is written. */
  checkpointer?: GraphCheckpointer;
  /** Human-in-the-loop gate. Absent means the interpreter builds its own fail-closed one. */
  interrupts?: InterruptController;
  /** Overrides the graph's own `defaults.durability`. */
  durability?: Durability;
  /**
   * Continue from a persisted checkpoint instead of starting a run.
   *
   * `value` is the human decision, and is ignored when the checkpoint carries no pending
   * interrupt.
   */
  resumeFrom?: { ref: CheckpointRef; value?: unknown };
  /**
   * Called once, after compilation and BEFORE the first superstep.
   *
   * The kill-and-resume child needs the handler counter while the run is still going,
   * because it terminates the process from inside the checkpointer and `runGolden` never
   * returns.
   */
  onCompiled?: (info: { graph: CompiledGraph; handlerLog: HandlerCallLog }) => void;
}

export interface GoldenRun {
  result: GraphRunResult;
  spans: Span[];
  graph: CompiledGraph;
  runId: string;
  projectRoot: string;
  reducerLog: ReducerCallLog;
  artifactLog: ArtifactWriteLog;
  handlerLog: HandlerCallLog;
  dispatchLog: DispatchLog;
  finalState: OverallState;
}

/** Compile the golden graph against fixture registries, with reducer counting attached. */
export function compileGolden(
  behaviour: GoldenBehaviour,
  spec: TopologySpec = goldenSpec(),
): { graph: CompiledGraph; reducerLog: ReducerCallLog; handlerLog: HandlerCallLog } {
  const registries = goldenRegistries(behaviour);
  const counted = countingReducerRegistry(registries.reducers);
  const nodes = countingNodeRegistry(registries.nodes);
  const graph = compile(spec, {
    ...registries,
    reducers: counted.registry,
    nodes: nodes.registry,
  });
  return { graph, reducerLog: counted.log, handlerLog: nodes.log };
}

/**
 * Run the golden graph to completion against real stores under `projectRoot`.
 *
 * The trace writer is closed before the spans are read, so every span the run produced is
 * on disk when a test looks at it.
 */
export async function runGolden(options: RunGoldenOptions): Promise<GoldenRun> {
  const runId = options.runId ?? "run-golden";
  const projectRoot = options.projectRoot;
  const config = options.config ?? createDefaultConfig("golden-fixture", "brownfield");
  const clock = options.clock ?? createMonotonicClock();
  const spec = options.spec ?? goldenSpec();

  const { graph, reducerLog, handlerLog } = compileGolden(options.behaviour, spec);
  options.onCompiled?.({ graph, handlerLog });
  const artifacts = countingArtifactWriter();
  const trace = await createTraceWriter(projectRoot, runId, { now: () => clock.now() });
  const commit = options.commit ?? createCommitBoundary({ clock, artifacts: artifacts.writer });
  const scheduler = new RecordingScheduler({
    maxConcurrent: options.concurrency ?? spec.defaults.concurrency,
  });

  const ctx: RunContext = {
    runId,
    projectRoot,
    config,
    clock,
    signal: options.signal ?? new AbortController().signal,
    trace,
    scheduler,
    ledger: createBudgetLedger(),
    commit,
    planner: createFrontierPlanner(),
    services: {
      effects: createEffectRegistry(),
      scratch: createScratchStore(projectRoot),
      archive: createArchiveWriter(projectRoot),
      cache: createSemanticCache(projectRoot, runId),
      prompts: stubPromptStore(),
      models: createModelBinder({
        light: { provider: "stub", modelId: "stub-light" },
        frontier: { provider: "stub", modelId: "stub-frontier" },
      }),
    },
    ...(options.checkpointer === undefined ? {} : { checkpointer: options.checkpointer }),
    ...(options.interrupts === undefined ? {} : { interrupts: options.interrupts }),
    ...(options.durability === undefined ? {} : { durability: options.durability }),
    concurrency: options.concurrency,
    maxSupersteps: options.maxSupersteps,
  };

  const interpreter = createGraphInterpreter();
  let result: GraphRunResult;
  try {
    result =
      options.resumeFrom === undefined
        ? await interpreter.run(graph, goldenInitialState(runId, projectRoot), ctx)
        : await interpreter.resume(
            graph,
            options.resumeFrom.ref,
            options.resumeFrom.value,
            ctx,
          );
    if (options.finalize && result.status === "completed") {
      await commit.finalize(result.state, {
        runId,
        projectRoot,
        config,
        superstep: result.supersteps,
        startedAtMs: clock.nowMs(),
      });
    }
  } finally {
    await trace.close();
  }

  return {
    result,
    spans: await readSpans(trace.path()),
    graph,
    runId,
    projectRoot,
    reducerLog,
    artifactLog: artifacts.log,
    handlerLog,
    dispatchLog: scheduler.log,
    finalState: result.state,
  };
}
