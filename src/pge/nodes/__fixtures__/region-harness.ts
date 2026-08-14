import type { BoberConfig } from "../../../config/schema.js";
import { createDefaultConfig } from "../../../config/schema.js";
import type { ProblemReflection, ResearchDigest } from "../../../contracts/problem-reflection.js";
import { createSpec } from "../../../contracts/spec.js";
import type { ClarificationQuestion, PlanSpec } from "../../../contracts/spec.js";
import type { SprintContract } from "../../../contracts/sprint-contract.js";
import type { TopologySpec } from "../../../contracts/topology.js";
import type { ResearchDoc } from "../../../orchestrator/research-agent.js";
import { compile } from "../../compile/compiler.js";
import type { CompiledGraph } from "../../compile/compiler.js";
import { planRegistries, researchRegistries } from "../../registry/index.js";
import type { RegionBindings } from "../../registry/index.js";
import type { Clock, NodeImpl, NodeRegistry, PromptStore } from "../../registry/nodes.js";
import { createModelBinder } from "../../registry/nodes.js";
import { initialOverallState } from "../../state/overall.js";
import type { OverallState } from "../../state/overall.js";
import { createArchiveWriter } from "../../runtime/archive.js";
import { createSemanticCache } from "../../runtime/cache.js";
import type { CheckpointRef, GraphCheckpointer } from "../../runtime/checkpointer.js";
import { createCommitBoundary } from "../../runtime/commit.js";
import type { CommitBoundary, CommitResult } from "../../runtime/commit.js";
import type { EffectRegistry } from "../../registry/effects.js";
import { createFrontierPlanner } from "../../runtime/frontier.js";
import { createGraphInterpreter } from "../../runtime/interpreter.js";
import type { GraphRunResult, RunContext } from "../../runtime/interpreter.js";
import { createInterruptController } from "../../runtime/interrupt.js";
import type { InterruptController } from "../../runtime/interrupt.js";
import { createBudgetLedger } from "../../runtime/ledger.js";
import { createScratchStore } from "../../runtime/scratch.js";
import { createTraceWriter, readSpans } from "../../runtime/trace.js";
import type { Span } from "../../runtime/trace.js";
import {
  RecordingScheduler,
  countingArtifactWriter,
  countingNodeRegistry,
  countingReducerRegistry,
  createMonotonicClock,
} from "../../runtime/__fixtures__/run-harness.js";
import type { ArtifactWriteLog, HandlerCallLog, ReducerCallLog } from "../../runtime/__fixtures__/run-harness.js";
import { CODING_GRAPH } from "../../topology/coding.graph.js";
import { RESEARCH_REGION, regionSpec } from "../regions.js";
import type { RegionId } from "../regions.js";
import { RESEARCH_DIGEST_REF_KEY } from "../research.js";

/**
 * The harness the research and plan REGIONS of the committed artifact run through.
 *
 * It is the golden-graph harness's sibling, not its replacement: every counting instrument
 * it needs already exists in `../../runtime/__fixtures__/run-harness.ts` and is imported
 * from there rather than re-implemented — {@link createMonotonicClock},
 * {@link countingReducerRegistry}, {@link countingArtifactWriter},
 * {@link countingNodeRegistry} and {@link RecordingScheduler}. What is genuinely new is
 * only what the golden harness cannot do: compile a REGION OF THE SHIPPED ARTIFACT rather
 * than the golden fixture, supply the effect registry the real node bodies reach the
 * outside world through, record per-superstep state snapshots, and record the INPUT each
 * handler was entered with.
 *
 * Real temp directories and real `.bober/` writes throughout. Nothing under test is
 * mocked: the only substituted collaborators are the two agent functions at the very edge
 * of the system, and they are substituted through the effect registry the artifact already
 * declares as the only way out.
 */

// ── Snapshots ───────────────────────────────────────────────────────

/**
 * A deep, structural copy of `value`, for an assertion that must not be able to be
 * retro-actively changed by a later superstep mutating a shared object.
 *
 * `globalThis.` is spelled out deliberately. `structuredClone` is a PLATFORM global rather
 * than an ECMAScript one, so it is absent from the explicit `languageOptions.globals` list
 * in `eslint.config.js` and a bare reference is a `no-undef` error. Reaching it through
 * `globalThis` — which IS an ECMAScript global — keeps the exact clone semantics (a JSON
 * round trip would silently erase the difference between an absent key and an explicit
 * `undefined`, which is precisely the difference sc-11-5's before/after comparison is
 * looking for) without editing a shared config file this sprint does not own.
 */
export function deepSnapshot<T>(value: T): T {
  return globalThis.structuredClone(value);
}

// ── Recording node registry ─────────────────────────────────────────

export interface HandlerInputLog {
  /** Node id -> the input value each entry of its handler was given, in order. */
  readonly inputs: Record<string, unknown[]>;
}

/**
 * Wrap a node registry so every handler's INPUT is recorded.
 *
 * Composed with {@link countingNodeRegistry} rather than replacing it: "how many times did
 * the explorer run" and "what was it given each time" are different questions, and
 * sc-11-2 asks both. The value is cloned on the way in, so a later mutation of a shared
 * object cannot retroactively change what a test believes was passed.
 */
export function recordingNodeRegistry(inner: NodeRegistry): {
  registry: NodeRegistry;
  log: HandlerInputLog;
} {
  const inputs: Record<string, unknown[]> = {};
  const registry: NodeRegistry = {
    ids: () => inner.ids(),
    register: (impl) => {
      inner.register(impl);
    },
    get(id) {
      const impl = inner.get(id);
      if (impl === undefined) return undefined;
      const wrapped: NodeImpl = {
        ...impl,
        handler: (input, state, ctx) => {
          const bucket = inputs[id] ?? [];
          bucket.push(deepSnapshot(input));
          inputs[id] = bucket;
          return impl.handler(input, state, ctx);
        },
      };
      return wrapped;
    },
  };
  return { registry, log: { inputs } };
}

// ── Recording commit boundary ───────────────────────────────────────

export interface StateSnapshot {
  readonly superstep: number;
  readonly before: OverallState;
  readonly after: OverallState;
}

/**
 * Wrap the REAL commit boundary so every superstep's before/after state is captured.
 *
 * The seam sc-11-5 needs. `RunContext.commit` already accepts a substituted boundary, so
 * this observes the shipped merge rather than standing in for it: the states recorded are
 * the ones the run actually committed, deep-cloned so a later superstep cannot mutate an
 * earlier snapshot out from under an assertion.
 */
export function recordingCommitBoundary(inner: CommitBoundary): {
  commit: CommitBoundary;
  snapshots: StateSnapshot[];
} {
  const snapshots: StateSnapshot[] = [];
  const commit: CommitBoundary = {
    async commit(graph, current, batch, ctx): Promise<CommitResult> {
      const before = deepSnapshot(current);
      const result = await inner.commit(graph, current, batch, ctx);
      snapshots.push({
        superstep: ctx.superstep,
        before,
        after: deepSnapshot(result.state),
      });
      return result;
    },
    finalize: (state, ctx) => inner.finalize(state, ctx),
  };
  return { commit, snapshots };
}

// ── Interrupt-controller adapter ────────────────────────────────────

/**
 * A suspend-mode controller for the planner clarification gate.
 *
 * Nothing is adapted. Until graphVersion 1.2.0 this wrapped the shipped controller to
 * substitute a legal checkpoint id, because `plan_clarify` declared `"plan-clarify"` —
 * an id outside the nine `src/orchestrator/checkpoints/types.ts` publishes, which made
 * `assertKnownCheckpointId` throw the moment the node was dispatched. The artifact now
 * names `"post-plan"`, so the shipped controller answers the artifact's own id directly
 * and the adapter has nothing left to do.
 */
export function clarificationInterrupts(): InterruptController {
  return createInterruptController({ mode: "suspend" });
}

// ── Stub providers ──────────────────────────────────────────────────

/** A well-formed reflection, the shape `ProblemReflectionSchema` demands. */
export function stubReflection(goal = "wire the research region onto the graph"): ProblemReflection {
  return {
    goal,
    inputs: ["the feature request", "the committed topology artifact"],
    outputs: ["a research document under .bober/research/"],
    rules: ["the shipped agents are not modified"],
    constraints: ["the PGE layer stays unreachable from every shipped execution path"],
  };
}

/** What a researcher that emits PROSE instead of structure looks like (sc-11-1). */
export const PROSE_ONLY_REFLECTION = {
  text: "I looked at the repo and it seems fine.",
};

/** A `ResearchDoc` in the shipped shape, parameterised by round so rounds are tellable apart. */
export function stubResearchDoc(round: number, critique: string | null): ResearchDoc {
  return {
    id: "research-20260805-region",
    timestamp: "2026-08-05T00:00:00.000Z",
    questions: ["what does the interpreter forward to a successor?"],
    findings: `round ${String(round)} findings${critique === null ? "" : ` addressing: ${critique}`}`,
    sections: {
      architectureOverview: "superstep interpreter",
      existingPatterns: "commit boundary",
      keyFiles: "src/pge/runtime/interpreter.ts",
      integrationPoints: "src/pge/registry/index.ts",
      testCoverage: "src/pge/nodes/",
      riskAreas: "artifact drift",
    },
    filesExplored: ["src/pge/runtime/interpreter.ts"],
    questionsAnswered: 1,
  };
}

/** A `PlanSpec` in the shipped shape, built by the shipped `createSpec`. */
export function stubPlanSpec(questions: ClarificationQuestion[] = []): PlanSpec {
  return createSpec(
    "Region plan",
    "A plan produced by the plan region against stub providers.",
    [
      {
        title: "Wire the region",
        description: "Compile and run the plan region end to end.",
        priority: "must-have",
        acceptanceCriteria: ["the region compiles", "the region runs"],
        dependencies: [],
      },
    ],
    questions.length === 0
      ? { status: "ready" }
      : { clarificationQuestions: questions, ambiguityScore: 8 },
  );
}

/** One clarification question, in the shipped vocabulary. */
export function stubQuestion(questionId = "q-1"): ClarificationQuestion {
  return {
    questionId,
    category: "scope",
    question: "Should the region write its own contracts, or only its channels?",
  };
}

/** A contract set derived from a spec, in the shipped `SprintContract` shape. */
export function stubContracts(spec: PlanSpec): SprintContract[] {
  return spec.features.map((feature, index) => ({
    contractId: `sprint-${spec.specId}-${String(index + 1).padStart(2, "0")}`,
    specId: spec.specId,
    sprintNumber: index + 1,
    title: feature.title,
    description: feature.description,
    status: "proposed" as const,
    dependsOn: [],
    features: [feature.featureId],
    successCriteria: [
      {
        criterionId: `sc-${String(index + 1)}-1`,
        description: "The region compiles from the committed artifact and runs end to end.",
        verificationMethod: "unit-test" as const,
        required: true,
      },
    ],
    nonGoals: ["Do not modify a shipped agent function."],
    stopConditions: ["The region compiled from the artifact and the run reached its terminal."],
    definitionOfDone:
      "The plan region compiled from the committed artifact, materialised its contracts and returned control to the supervisor.",
    assumptions: [],
    outOfScope: [],
    estimatedFiles: [],
    iterationHistory: [],
    createdAt: spec.createdAt,
    updatedAt: spec.updatedAt,
  }));
}

function stubPromptStore(): PromptStore {
  return { has: () => true, get: async (ref: string) => `stub prompt for ${ref}` };
}

// ── Seeding a brief ─────────────────────────────────────────────────

/** A `ResearchDigest` the plan region can be started from. */
export function stubDigest(documentId: string | null = "research-20260805-region"): ResearchDigest {
  const doc = stubResearchDoc(1, null);
  return {
    researchId: doc.id,
    timestamp: doc.timestamp,
    reflection: stubReflection(),
    questions: doc.questions,
    findings: doc.findings,
    sections: doc.sections,
    filesExplored: doc.filesExplored,
    questionsAnswered: doc.questionsAnswered,
    critique: null,
    reflexionRound: 1,
    documentId,
  };
}

/**
 * Put a digest where the plan region will find it: the REAL scratch store, under the real
 * temp root, referenced from `refs` exactly as `research_collect` leaves it.
 *
 * Not a fabricated state object — the bytes are on disk and the run reads them back
 * through `ctx.scratch`, so the plan region is exercised against the same handover the
 * research region produces.
 */
export async function seedResearchDigest(
  projectRoot: string,
  runId: string,
  state: OverallState,
  digest: ResearchDigest = stubDigest(),
): Promise<OverallState> {
  const ref = await createScratchStore(projectRoot).put(runId, "document", JSON.stringify(digest));
  return { ...state, refs: { ...state.refs, [RESEARCH_DIGEST_REF_KEY]: ref } };
}

// ── Runner ──────────────────────────────────────────────────────────

export interface RegionRunOptions {
  projectRoot: string;
  region: RegionId;
  bindings: RegionBindings;
  runId?: string;
  featureRequest?: string;
  /** Replaces the constructed initial state outright. */
  initialState?: OverallState;
  /** Called with the constructed initial state, for seeding refs from the real store. */
  seed?: (state: OverallState) => Promise<OverallState>;
  /** Explicit, so a routing bug fails fast rather than after 200 supersteps. */
  maxSupersteps?: number;
  clock?: Clock;
  checkpointer?: GraphCheckpointer;
  interrupts?: InterruptController;
  resumeFrom?: { ref: CheckpointRef; value?: unknown };
  config?: BoberConfig;
}

export interface RegionRun {
  result: GraphRunResult;
  spans: Span[];
  graph: CompiledGraph;
  spec: TopologySpec;
  runId: string;
  projectRoot: string;
  reducerLog: ReducerCallLog;
  artifactLog: ArtifactWriteLog;
  handlerLog: HandlerCallLog;
  inputLog: HandlerInputLog;
  snapshots: StateSnapshot[];
  finalState: OverallState;
}

/** Compile a region of the COMMITTED artifact against the sprint-11 registries. */
export interface CompiledRegion {
  graph: CompiledGraph;
  spec: TopologySpec;
  /** The ONE effect registry the run uses; the node bodies reach the agents through it. */
  effects: EffectRegistry;
  reducerLog: ReducerCallLog;
  handlerLog: HandlerCallLog;
  inputLog: HandlerInputLog;
}

export function compileRegion(region: RegionId, bindings: RegionBindings): CompiledRegion {
  const spec = regionSpec(CODING_GRAPH, region);
  const registries =
    region === RESEARCH_REGION ? researchRegistries(spec, bindings) : planRegistries(spec, bindings);
  const effects = registries.effects;
  if (effects === undefined) throw new Error("the region registries carry no effect registry");
  const counted = countingReducerRegistry(registries.reducers);
  const nodes = countingNodeRegistry(registries.nodes);
  const recorded = recordingNodeRegistry(nodes.registry);
  const graph = compile(spec, {
    ...registries,
    reducers: counted.registry,
    nodes: recorded.registry,
  });
  return {
    graph,
    spec,
    effects,
    reducerLog: counted.log,
    handlerLog: nodes.log,
    inputLog: recorded.log,
  };
}

/** Run a region of the committed artifact to completion against real stores. */
export async function runRegion(options: RegionRunOptions): Promise<RegionRun> {
  const runId = options.runId ?? `run-${options.region}`;
  const projectRoot = options.projectRoot;
  const config = options.config ?? createDefaultConfig("pge-region", "brownfield");
  const clock = options.clock ?? createMonotonicClock();

  const compiled = compileRegion(options.region, options.bindings);
  const artifacts = countingArtifactWriter();
  const trace = await createTraceWriter(projectRoot, runId, { now: () => clock.now() });
  const recorder = recordingCommitBoundary(
    createCommitBoundary({ clock, artifacts: artifacts.writer }),
  );
  const scheduler = new RecordingScheduler({ maxConcurrent: compiled.spec.defaults.concurrency });

  const ctx: RunContext = {
    runId,
    projectRoot,
    config,
    clock,
    signal: new AbortController().signal,
    trace,
    scheduler,
    ledger: createBudgetLedger(),
    commit: recorder.commit,
    planner: createFrontierPlanner(),
    services: {
      // The registry built for this region: the node bodies reach `runResearch` and
      // `runPlanner` through exactly this channel and no other.
      effects: compiled.effects,
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
    maxSupersteps: options.maxSupersteps ?? 40,
  };

  const base =
    options.initialState ??
    initialOverallState({
      runId,
      projectRoot,
      featureRequest: options.featureRequest ?? "wire the research region onto the graph",
    });
  const init = options.seed === undefined ? base : await options.seed(base);

  const interpreter = createGraphInterpreter();
  let result: GraphRunResult;
  try {
    result =
      options.resumeFrom === undefined
        ? await interpreter.run(compiled.graph, init, ctx)
        : await interpreter.resume(compiled.graph, options.resumeFrom.ref, options.resumeFrom.value, ctx);
  } finally {
    await trace.close();
  }

  return {
    result,
    spans: await readSpans(trace.path()),
    graph: compiled.graph,
    spec: compiled.spec,
    runId,
    projectRoot,
    reducerLog: compiled.reducerLog,
    artifactLog: artifacts.log,
    handlerLog: compiled.handlerLog,
    inputLog: compiled.inputLog,
    snapshots: recorder.snapshots,
    finalState: result.state,
  };
}
