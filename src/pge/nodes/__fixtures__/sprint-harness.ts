import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { BoberConfig } from "../../../config/schema.js";
import { createDefaultConfig } from "../../../config/schema.js";
import type { SprintContract } from "../../../contracts/sprint-contract.js";
import type { TopologySpec } from "../../../contracts/topology.js";
import type { EvaluationRunResult } from "../../../evaluators/registry.js";
import { compile } from "../../compile/compiler.js";
import type { CompiledGraph } from "../../compile/compiler.js";
import type { EffectRegistry } from "../../registry/effects.js";
import { sprintRegistries, terminalRegistries } from "../../registry/index.js";
import type { RegionBindings } from "../../registry/index.js";
import type { Clock, NodeImpl, NodeRegistry, PromptStore } from "../../registry/nodes.js";
import { createModelBinder } from "../../registry/nodes.js";
import { createArchiveWriter } from "../../runtime/archive.js";
import { createSemanticCache } from "../../runtime/cache.js";
import type { CheckpointRef, GraphCheckpointer } from "../../runtime/checkpointer.js";
import { createCommitBoundary } from "../../runtime/commit.js";
import { createFrontierPlanner } from "../../runtime/frontier.js";
import { createGraphInterpreter } from "../../runtime/interpreter.js";
import type { GraphRunResult, RunContext } from "../../runtime/interpreter.js";
import { createInterruptController } from "../../runtime/interrupt.js";
import type { InterruptController } from "../../runtime/interrupt.js";
import { createBudgetLedger } from "../../runtime/ledger.js";
import { createSandboxRunner } from "../../runtime/sandbox.js";
import type { SandboxOutcome, SandboxPolicy, SandboxRunner } from "../../runtime/sandbox.js";
import { createScratchStore } from "../../runtime/scratch.js";
import type { ScratchStore } from "../../runtime/scratch.js";
import { createTraceWriter, readSpans } from "../../runtime/trace.js";
import type { Span, TraceWriter } from "../../runtime/trace.js";
import {
  RecordingScheduler,
  countingArtifactWriter,
  countingNodeRegistry,
  countingReducerRegistry,
  createMonotonicClock,
} from "../../runtime/__fixtures__/run-harness.js";
import type {
  ArtifactWriteLog,
  HandlerCallLog,
  ReducerCallLog,
} from "../../runtime/__fixtures__/run-harness.js";
import { initialOverallState } from "../../state/overall.js";
import type { OverallState } from "../../state/overall.js";
import { CODING_GRAPH } from "../../topology/coding.graph.js";
import { SPRINT_REGION, TERMINAL_REGION, regionSpec } from "../regions.js";
import type { RegionId } from "../regions.js";
import type { ExplainResponse, MocksResponse } from "../effects.js";
import { recordingCommitBoundary, recordingNodeRegistry } from "./region-harness.js";
import type { HandlerInputLog, StateSnapshot } from "./region-harness.js";
import type { SprintRuntime } from "../verification.js";

/**
 * The harness the SPRINT and TERMINAL regions of the committed artifact run through.
 *
 * Sibling of `region-harness.ts` (sprint 11) and composed with it: `recordingNodeRegistry`,
 * `recordingCommitBoundary`, `countingNodeRegistry`, `countingReducerRegistry`,
 * `countingArtifactWriter`, `RecordingScheduler` and `createMonotonicClock` are all
 * IMPORTED, not re-implemented. What is new here is only what those cannot do: build a
 * {@link SprintRuntime} around a real {@link SandboxRunner} and count what that runner was
 * asked to execute.
 *
 * Through graphVersion 1.1.0 this file also carried two adapters that worked around
 * artifact defects the sprint region hit at runtime: one stripped the `process-exec` tag
 * from the four ungated verification nodes, the other substituted a legal checkpoint id for
 * `hitl_commit`'s `"hitl-commit"`. Both defects are fixed in the artifact itself as of
 * 1.2.0 — the verification nodes declare `sandbox-exec` (or nothing, for the one that
 * executes nothing) and `hitl_commit` names `end-of-pipeline` — so the adapters are gone
 * and the SHIPPED controller now decides every interrupt in this harness unmodified.
 *
 * Real temp directories, real `.bober/` writes, a real scratch store, a real trace file and
 * the real interpreter throughout. The only substituted collaborators are the agent
 * functions at the very edge, and they are substituted through the effect registry the
 * artifact already declares as the only way out.
 */

// ── Recording sandbox ───────────────────────────────────────────────

export interface SandboxCall {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly nodeId: string;
  readonly branchKey: string | null;
}

export interface SandboxCallLog {
  readonly calls: SandboxCall[];
}

/**
 * Wrap the REAL sandbox runner so every execution attempt is recorded.
 *
 * The instrument sc-12-8 needs. "The expensive suite was skipped" is not observable as a
 * node that did not run — the artifact has no such node — so it is observed as an
 * invocation that did not happen, at the one seam every execution passes through. The runner
 * underneath is the shipped one, so a denied binary is still denied and a timeout is still a
 * timeout.
 */
export function recordingSandbox(inner: SandboxRunner): {
  runner: SandboxRunner;
  log: SandboxCallLog;
} {
  const calls: SandboxCall[] = [];
  const runner: SandboxRunner = {
    async run(cmd, args, policy, scratch, span): Promise<SandboxOutcome> {
      calls.push({
        cmd,
        args: [...args],
        nodeId: span?.nodeId ?? "unknown",
        branchKey: span?.branchKey ?? null,
      });
      return inner.run(cmd, args, policy, scratch, span);
    },
  };
  return { runner, log: { calls } };
}

/** A runner that answers with a scripted outcome without spawning anything. */
export function scriptedSandbox(
  outcomes: (cmd: string, args: readonly string[]) => SandboxOutcome | Promise<SandboxOutcome>,
): SandboxRunner {
  return {
    async run(cmd, args): Promise<SandboxOutcome> {
      return outcomes(cmd, args);
    },
  };
}

// ── Stub agent bindings ─────────────────────────────────────────────

/** An explanation set that satisfies sc-12-1 for whatever tests it is asked about. */
export function stubExplain(
  build: (testId: string) => string = (testId) =>
    `${testId} asserts the behaviour the contract names, and fails when that behaviour regresses.`,
): RegionBindings["explain"] {
  return async (req) => ({
    explanations: req.testIds.map((testId) => ({ testId, expectedBehavior: build(testId) })),
  });
}

/** A curator that explains too few tests, or too briefly. The sc-12-1 negative fixture. */
export function underDeliveringExplain(count: number, behavior = "ok"): RegionBindings["explain"] {
  return async (req) => ({
    explanations: req.testIds.slice(0, count).map((testId) => ({ testId, expectedBehavior: behavior })),
  });
}

export const ALL_MOCK_CATEGORIES = ["boundary", "empty", "large", "negative"] as const;

/** A mock manifest with `count` tests spread over the requested categories. */
export function stubMocks(
  count = 6,
  categories: ReadonlyArray<(typeof ALL_MOCK_CATEGORIES)[number]> = ALL_MOCK_CATEGORIES,
): RegionBindings["mocks"] {
  return async (req): Promise<MocksResponse> => ({
    contractId: req.contract.contractId,
    tests: Array.from({ length: count }, (_value, index) => ({
      testId: `mock-${String(index + 1)}`,
      category: categories[index % categories.length],
      intent: `exercises the ${categories[index % categories.length]} case`,
      path: `tests/mock-${String(index + 1)}.test.ts`,
    })),
  });
}

/** A curator that produces no briefing worth reading, so the explain path is what is tested. */
export const stubCurator: NonNullable<RegionBindings["curator"]> = async (contract) => ({
  contractId: contract.contractId,
  timestamp: "2026-08-05T00:00:00.000Z",
  briefing: `# ${contract.title}\n\nBriefing for ${contract.contractId}.`,
  filesAnalyzed: contract.estimatedFiles ?? [],
  patternsFound: 1,
  utilsIdentified: 1,
});

/** A generator that claims the given files changed. */
export function stubGenerator(
  filesChanged: readonly string[] = ["src/example.ts"],
  success = true,
): NonNullable<RegionBindings["generator"]> {
  return async (handoff) => ({
    success,
    notes: `generated ${handoff.currentContract?.contractId ?? "unknown"}`,
    filesChanged: [...filesChanged],
  });
}

/** A security auditor that always answers `disabled`, matching a default config. */
export const stubSecurity: NonNullable<RegionBindings["security"]> = async () => ({
  blocked: false,
  reason: "disabled",
});

/** An `EvaluationRunResult` with the given per-criterion outcomes. */
export function stubEvaluation(args: {
  evaluator?: string;
  details: Array<{ criterion: string; passed: boolean }>;
  score?: number;
}): EvaluationRunResult {
  const evaluator = args.evaluator ?? "unit-test";
  const passed = args.details.every((detail) => detail.passed);
  return {
    passed,
    score: args.score ?? (passed ? 95 : 40),
    results: [
      {
        evaluator,
        passed,
        score: args.score ?? (passed ? 95 : 40),
        details: args.details.map((detail) => ({
          criterion: detail.criterion,
          passed: detail.passed,
          message: detail.passed ? "ok" : "failed",
          severity: detail.passed ? ("info" as const) : ("error" as const),
        })),
        summary: `${evaluator} summary`,
        feedback: `${evaluator} feedback`,
        timestamp: "2026-08-05T00:00:00.000Z",
      },
    ],
    summary: passed ? "all criteria met" : "criteria failed",
    timestamp: "2026-08-05T00:00:00.000Z",
  };
}

/** An evaluator that answers with the same result every iteration. */
export function stubEvaluator(result: EvaluationRunResult): NonNullable<RegionBindings["evaluator"]> {
  return async () => result;
}

/** An evaluator that answers differently on each successive call. */
export function scriptedEvaluator(
  script: ReadonlyArray<() => Promise<EvaluationRunResult>>,
): { evaluator: NonNullable<RegionBindings["evaluator"]>; calls: () => number } {
  let index = 0;
  return {
    evaluator: async () => {
      const step = script[Math.min(index, script.length - 1)];
      index += 1;
      return step();
    },
    calls: () => index,
  };
}

export const stubReviewer: NonNullable<RegionBindings["reviewer"]> = async (contract) => ({
  reviewId: `review-${contract.contractId}`,
  contractId: contract.contractId,
  specId: contract.specId,
  timestamp: "2026-08-05T00:00:00.000Z",
  summary: "no blocking findings",
  critical: [],
  important: [],
  minor: [],
  approvedAreas: ["structure"],
});

/**
 * A documenter that WRITES THE DOC, because writing the doc is the whole product.
 *
 * `runDocumenter` does not return a document — it instructs a model holding fs-write tools to
 * write `docs/sprints/<contractId>.md` under the project root and then reports the path it
 * asked for (`documenter-agent.ts:106,134,175`). A stub that returned the path and wrote
 * nothing would leave sc-12-9's "a sprint doc file is written" unobservable: the whole
 * `refs[DOCUMENTATION_REF_KEY]` write in `documenter.ts:135-139` could be deleted and every
 * test would still pass. So the stub performs the same fs-write effect the real agent
 * performs, against the run's REAL temp `projectRoot`, and `commit.test.ts` reads the file
 * back off disk at the path the node recorded in state.
 *
 * The agent function itself is untouched (nonGoal 2) — this is a binding at the effect seam,
 * which is the only substitution the artifact permits.
 */
export function stubDocumenter(
  seen: { instructions: string[] } = { instructions: [] },
): NonNullable<RegionBindings["documenter"]> {
  return async (contract, _evaluation, _generatorResult, projectRoot) => {
    seen.instructions.push(contract.description);
    const sprintDocPath = `docs/sprints/${contract.contractId}.md`;
    const absolute = join(projectRoot, sprintDocPath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(
      absolute,
      `# ${contract.title}\n\nSprint ${String(contract.sprintNumber)} — ${contract.contractId}.\n`,
      "utf-8",
    );
    return {
      contractId: contract.contractId,
      sprintDocPath,
      relatedDocsUpdated: [],
      concerns: [],
      summary: `documented ${contract.contractId}`,
    };
  };
}

// ── Prompt store ────────────────────────────────────────────────────

/**
 * `.bober/prompts/` does not exist in this repository, so every `promptRef` is stubbed.
 *
 * The same stub shape `run-harness.ts:207-212` uses. Creating the directory would change
 * `pge validate --mode full` behaviour repo-wide and is out of this sprint's scope.
 */
export function stubPromptStore(): PromptStore {
  return { has: () => true, get: async (ref: string) => `stub prompt for ${ref}` };
}

// ── Runner ──────────────────────────────────────────────────────────

export interface SprintRunOptions {
  projectRoot: string;
  region?: RegionId;
  bindings: Omit<RegionBindings, "runtime"> & { runtime?: SprintRuntime };
  runId?: string;
  contracts?: SprintContract[];
  initialState?: OverallState;
  seed?: (state: OverallState) => Promise<OverallState>;
  maxSupersteps?: number;
  clock?: Clock;
  config?: BoberConfig;
  checkpointer?: GraphCheckpointer;
  /** Replaces the constructed controller outright, for the fail-closed commit test. */
  interrupts?: (inner: InterruptController) => InterruptController;
  resumeFrom?: { ref: CheckpointRef; value?: unknown };
  /** Replaces the sandbox runner, for scripted denial/timeout outcomes. */
  sandbox?: (real: SandboxRunner, policy: (cwd: string) => SandboxPolicy) => SandboxRunner;
}

export interface SprintRun {
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
  sandboxLog: SandboxCallLog;
  snapshots: StateSnapshot[];
  finalState: OverallState;
  scratch: ScratchStore;
  trace: TraceWriter;
  effects: EffectRegistry;
}

/** Compile a region of the COMMITTED artifact against the sprint-12 registries. */
export function compileSprintRegion(
  region: RegionId,
  bindings: RegionBindings,
): {
  graph: CompiledGraph;
  spec: TopologySpec;
  effects: EffectRegistry;
  reducerLog: ReducerCallLog;
  handlerLog: HandlerCallLog;
  inputLog: HandlerInputLog;
} {
  const spec = regionSpec(CODING_GRAPH, region);
  const registries =
    region === TERMINAL_REGION ? terminalRegistries(spec, bindings) : sprintRegistries(spec, bindings);
  const effects = registries.effects;
  if (effects === undefined) throw new Error("the region registries carry no effect registry");
  const counted = countingReducerRegistry(registries.reducers);
  const nodes = countingNodeRegistry(registries.nodes as NodeRegistry);
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

/**
 * A config whose `commands` name binaries the sandbox allowlist will then contain.
 *
 * The allowlist is DERIVED from these commands (`verification.ts`), so a test that declares
 * `test: "node -e …"` is a test that allows `node` and nothing else — which is what makes
 * sc-12-10's denial case a genuine denial rather than a missing entry.
 */
export function sprintConfig(
  commands: Partial<BoberConfig["commands"]> = {},
  extra: { checkpointMechanism?: string; pge?: BoberConfig["pge"] } = {},
): BoberConfig {
  const config = createDefaultConfig("pge-sprint", "brownfield");
  return {
    ...config,
    commands: { ...config.commands, ...commands },
    pipeline: {
      ...config.pipeline,
      ...(extra.checkpointMechanism === undefined
        ? {}
        : { checkpointMechanism: extra.checkpointMechanism as BoberConfig["pipeline"]["checkpointMechanism"] }),
    },
    ...(extra.pge === undefined ? {} : { pge: extra.pge }),
  };
}

/** Run a region of the committed artifact to completion against real stores. */
export async function runSprint(options: SprintRunOptions): Promise<SprintRun> {
  const region = options.region ?? SPRINT_REGION;
  const runId = options.runId ?? `run-${region}`;
  const projectRoot = options.projectRoot;
  const config = options.config ?? sprintConfig();
  const clock = options.clock ?? createMonotonicClock();

  // Built BEFORE the registries: the sprint node bodies close over the sandbox, and the
  // sandbox needs the run's own trace and scratch store.
  const scratch = createScratchStore(projectRoot);
  const trace = await createTraceWriter(projectRoot, runId, { now: () => clock.now() });
  const realSandbox = createSandboxRunner(projectRoot, runId, trace);
  const chosen =
    options.sandbox === undefined
      ? realSandbox
      : options.sandbox(realSandbox, () => ({
          allowBinaries: [],
          denyBinaries: [],
          timeoutMs: 1_000,
          maxOutputBytes: 1_000,
          cwd: projectRoot,
          env: {},
          network: false,
        }));
  const sandbox = recordingSandbox(chosen);
  const runtime: SprintRuntime = { sandbox: sandbox.runner, scratch, trace };

  const compiled = compileSprintRegion(region, { ...options.bindings, runtime });
  const artifacts = countingArtifactWriter();
  const recorder = recordingCommitBoundary(createCommitBoundary({ clock, artifacts: artifacts.writer }));
  const scheduler = new RecordingScheduler({ maxConcurrent: compiled.spec.defaults.concurrency });

  const base = createInterruptController({ mode: "mechanism" });
  // The SHIPPED controller, unadapted: the artifact's own checkpoint ids and effect tags
  // are what it decides on. `options.interrupts` is a per-test hook, not a workaround.
  const interrupts = options.interrupts === undefined ? base : options.interrupts(base);

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
      effects: compiled.effects,
      scratch,
      archive: createArchiveWriter(projectRoot),
      cache: createSemanticCache(projectRoot, runId),
      prompts: stubPromptStore(),
      models: createModelBinder({
        light: { provider: "stub", modelId: "stub-light" },
        frontier: { provider: "stub", modelId: "stub-frontier" },
      }),
    },
    ...(options.checkpointer === undefined ? {} : { checkpointer: options.checkpointer }),
    interrupts,
    maxSupersteps: options.maxSupersteps ?? 60,
  };

  const seeded =
    options.initialState ??
    withContracts(
      initialOverallState({ runId, projectRoot, featureRequest: "run the sprint region" }),
      options.contracts ?? [],
    );
  const init = options.seed === undefined ? seeded : await options.seed(seeded);

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
    sandboxLog: sandbox.log,
    snapshots: recorder.snapshots,
    finalState: result.state,
    scratch,
    trace,
    effects: compiled.effects,
  };
}

/** Seed the contracts channel, which is where the fan-out reads its work from. */
export function withContracts(state: OverallState, contracts: SprintContract[]): OverallState {
  return { ...state, sprintContracts: contracts };
}

/** A `SprintContract` in the shipped shape, parameterised for the case under test. */
export function sprintContractFixture(overrides: Partial<SprintContract> = {}): SprintContract {
  return {
    contractId: "sprint-fixture-1",
    specId: "spec-fixture",
    sprintNumber: 1,
    title: "Wire the sprint region",
    description: "Compile and run the sprint region end to end against stub providers.",
    status: "proposed",
    dependsOn: [],
    features: [],
    successCriteria: [
      {
        criterionId: "sc-f-1",
        description: "The sprint region compiles from the committed artifact and runs end to end.",
        verificationMethod: "unit-test",
        required: true,
      },
    ],
    nonGoals: ["Do not modify a shipped agent function."],
    stopConditions: ["The region compiled from the artifact and the branch settled."],
    definitionOfDone:
      "The sprint region compiled from the committed artifact, generated, evaluated and settled the branch.",
    assumptions: [],
    outOfScope: [],
    estimatedFiles: ["src/example.ts", "src/example.test.ts"],
    iterationHistory: [],
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
    ...overrides,
  };
}

/** A minimal binding set: every required binding, every optional one stubbed. */
export function stubSprintBindings(
  overrides: Partial<Omit<RegionBindings, "runtime">> = {},
): Omit<RegionBindings, "runtime"> {
  return {
    // `reflect` and `critique` belong to the research region and are never invoked here;
    // `RegionBindings` demands them because it is one interface across four regions.
    reflect: async () => ({}),
    critique: async () => ({ critique: null }),
    explain: stubExplain(),
    mocks: stubMocks(),
    curator: stubCurator,
    generator: stubGenerator(),
    security: stubSecurity,
    evaluator: stubEvaluator(stubEvaluation({ details: [{ criterion: "sc-f-1", passed: true }] })),
    reviewer: stubReviewer,
    writeContract: async () => {
      /* the exit node's persistence is asserted through the effect, not the filesystem */
    },
    ...overrides,
  };
}

/**
 * The terminal region's bindings.
 *
 * `committer` is DELIBERATELY left unbound by default, so it resolves to the shipped
 * `commitAll` and a commit test that reaches the commit node creates a real git object in a
 * real temporary repository — which is the only way "no git object was created" can be
 * asserted about the fail-closed case rather than about a stub.
 */
export function stubTerminalBindings(
  overrides: Partial<Omit<RegionBindings, "runtime">> = {},
): Omit<RegionBindings, "runtime"> {
  return {
    reflect: async () => ({}),
    critique: async () => ({ critique: null }),
    explain: stubExplain(),
    mocks: stubMocks(),
    documenter: stubDocumenter(),
    ...overrides,
  };
}

/** Every node id whose handler was entered, sorted. */
export function enteredNodes(run: SprintRun): string[] {
  return Object.entries(run.handlerLog.calls)
    .filter(([, count]) => count > 0)
    .map(([nodeId]) => nodeId)
    .sort();
}

/** The route each span recorded, in span order. */
export function routesOf(run: SprintRun, nodeId: string): Array<string | undefined> {
  return run.spans
    .filter((span) => span.nodeId === nodeId && span.route !== undefined)
    .map((span) => span.route?.goto.node ?? span.route?.goto.label);
}

/** Every implementation the compiled region registered, sorted. */
export function registeredIds(graph: CompiledGraph): string[] {
  return [...graph.nodes.keys()].sort();
}

export type { NodeImpl, ExplainResponse };
