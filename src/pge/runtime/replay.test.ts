import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createDefaultConfig } from "../../config/schema.js";
import { PlanSpecSchema } from "../../contracts/spec.js";
import type { PlanSpec } from "../../contracts/spec.js";
import { SprintContractSchema } from "../../contracts/sprint-contract.js";
import type { SprintContract } from "../../contracts/sprint-contract.js";
import { TopologySpecSchema } from "../../contracts/topology.js";
import type { NodeSpec, TopologySpec } from "../../contracts/topology.js";
import type { PipelineResult } from "../../orchestrator/pipeline.js";
import { Scheduler } from "../../orchestrator/workflow/scheduler.js";
import { compile } from "../compile/compiler.js";
import { EffectNotDeclaredError, createEffectRegistry } from "../registry/effects.js";
import type { EffectDef, EffectRegistry } from "../registry/effects.js";
import { createModelBinder, createNodeRegistry } from "../registry/nodes.js";
import type { NodeContext, NodeRegistry } from "../registry/nodes.js";
import { createReducerRegistry } from "../registry/reducers.js";
import { initialOverallState } from "../state/overall.js";
import type { GraphMessage } from "../state/overall.js";
import { checksumTopology } from "../topology/canonical.js";
import { createArchiveWriter } from "./archive.js";
import { createSemanticCache } from "./cache.js";
import { createCommitBoundary, createFixedClock } from "./commit.js";
import { createFrontierPlanner } from "./frontier.js";
import { createGraphInterpreter } from "./interpreter.js";
import type { RunContext } from "./interpreter.js";
import { createBudgetLedger } from "./ledger.js";
import {
  MissingRecordingError,
  NetworkDisabledInReplayError,
  ProcessExecutionDisabledInReplayError,
  REPLAY_INPUT_PATHS,
  createRecording,
  createRefusingSandbox,
  createReplayEffectRegistry,
  createRunRecorder,
  prepareReplayRoot,
  readRecording,
  recordingKey,
  replayRecordedRun,
  withNetworkDisabled,
} from "./replay.js";
import type { Recording } from "./replay.js";
import { createScratchStore } from "./scratch.js";
import { createTraceWriter, readSpans, tracePath } from "./trace.js";
import type { TraceWriter } from "./trace.js";

/**
 * Offline trace replay (sc-13-6).
 *
 * Every run in this file goes through the SHIPPED units — `compile`,
 * `createGraphInterpreter`, `createCommitBoundary`, `createTraceWriter`, `createScratchStore`
 * and `EngineConformanceHarness` (through `replayRecordedRun`) — against real temp roots and
 * real `.bober/` writes. Only the topology and the three node bodies are fixture, exactly as
 * `__fixtures__/golden-graph.ts` is: the graph has to declare an effect and a body has to
 * INVOKE one, and no shipped graph small enough to run in a unit test does.
 *
 * What is asserted is the runtime and the artifact shape. The planner's "answer" here is a
 * pair of strings; the point is that the artifacts are a function of it, so a replay that
 * fabricated a default response could not produce the recorded contracts.
 */

// ── Fixture topology ────────────────────────────────────────────────

const NODES = {
  plan: "plan_draft",
  supervisor: "supervisor",
  finalize: "finalize",
} as const;

const PLANNER_EFFECT = "planner.draft";
const FIXTURE_SPEC_ID = "spec-replay-fixture";
const FIXED_ISO = "2026-08-06T00:00:00.000Z";
const FEATURE_REQUEST = "Replay the recorded run and compare its artifacts.";

const PlannerRequestSchema = z.object({ prompt: z.string().min(1) });
const PlannerResponseSchema = z.object({
  specTitle: z.string().min(1),
  sprintTitle: z.string().min(1),
});
type PlannerResponse = z.infer<typeof PlannerResponseSchema>;

const FIXTURE_NODES: NodeSpec[] = [
  {
    id: NODES.plan,
    kind: "llm",
    title: "Draft the plan",
    doc: "Asks the planner effect for a plan and commits the spec and its one contract.",
    subgraph: null,
    role: "planner",
    modelTier: "frontier",
    promptRef: "plan/draft",
    inputPorts: [],
    outputPorts: [],
    reads: ["messages"],
    writes: ["spec", "sprintContracts", "messages", "counters"],
    effects: ["network"],
  },
  {
    id: NODES.supervisor,
    kind: "router",
    title: "Supervisor",
    doc: "One outcome label in this fixture; it finishes the run.",
    subgraph: null,
    role: "router",
    modelTier: "light",
    inputPorts: [],
    outputPorts: [],
    reads: ["spec", "counters"],
    writes: ["counters"],
    effects: [],
    targets: [{ label: "done", to: NODES.finalize }],
  },
  {
    id: NODES.finalize,
    kind: "tool",
    title: "Finalize the run",
    doc: "Records the run verdict as a control-plane fact and ends the run.",
    subgraph: null,
    role: "utility",
    inputPorts: [],
    outputPorts: [],
    reads: ["sprintContracts"],
    writes: ["messages"],
    effects: [],
    toolRef: "run.finalize",
  },
];

const FIXTURE_UNSEALED: TopologySpec = {
  formatVersion: 1,
  graphId: "replay-fixture",
  graphVersion: "1.0.0",
  description: "Replay fixture: one effectful llm node, one router, one terminal tool node.",
  provenance: "authored",
  entry: NODES.plan,
  defaults: {
    supervisorNodeId: NODES.supervisor,
    modelTier: "light",
    concurrency: 1,
    durability: "superstep",
    maxInlineBytes: 65536,
  },
  channels: [
    {
      id: "messages",
      reducerRef: "appendById",
      schemaRef: "GraphMessage",
      scope: "public",
      maxInlineBytes: 4096,
    },
    {
      id: "counters",
      reducerRef: "maxNumber",
      schemaRef: "Counters",
      scope: "public",
      maxInlineBytes: 4096,
    },
    {
      id: "spec",
      reducerRef: "replaceIfNewer",
      schemaRef: "PlanSpec",
      scope: "public",
      maxInlineBytes: 65536,
    },
    {
      id: "sprintContracts",
      reducerRef: "appendById",
      schemaRef: "SprintContract",
      scope: "public",
      maxInlineBytes: 65536,
    },
  ],
  nodes: FIXTURE_NODES,
  edges: [
    { id: "e-plan-supervisor", from: NODES.plan, to: NODES.supervisor, kind: "normal" },
    {
      id: "e-supervisor-done",
      from: NODES.supervisor,
      to: NODES.finalize,
      kind: "conditional",
      label: "done",
    },
    { id: "e-finalize-end", from: NODES.finalize, to: "END", kind: "normal" },
  ],
  checksum: `sha256:${"0".repeat(64)}`,
  subgraphs: [],
};

function fixtureSpec(): TopologySpec {
  const clone = TopologySpecSchema.parse(JSON.parse(JSON.stringify(FIXTURE_UNSEALED)) as unknown);
  return { ...clone, checksum: checksumTopology(clone) };
}

// ── Fixture artifacts ───────────────────────────────────────────────

function fixturePlanSpec(title: string): PlanSpec {
  return PlanSpecSchema.parse({
    specId: FIXTURE_SPEC_ID,
    version: 1,
    title,
    description: "A plan whose content is a function of the recorded provider response.",
    status: "in-progress",
    mode: "brownfield",
    features: [
      {
        featureId: "feat-replay",
        title: "Offline replay",
        description: "Re-execute a recorded run from its span file.",
        priority: "must-have",
        acceptanceCriteria: ["Reproduces byte-identical artifacts"],
      },
    ],
    assumptions: [],
    outOfScope: [],
    clarificationQuestions: [],
    resolvedClarifications: [],
    techStack: ["TypeScript"],
    nonFunctionalRequirements: [],
    constraints: [],
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
  });
}

function fixtureContract(title: string): SprintContract {
  return SprintContractSchema.parse({
    contractId: "sprint-replay-1",
    specId: FIXTURE_SPEC_ID,
    sprintNumber: 1,
    title,
    description: "A contract whose title comes from the recorded provider response.",
    status: "passed",
    dependsOn: [],
    features: ["feat-replay"],
    successCriteria: [
      {
        criterionId: "sc-replay-1",
        description: "The replayed run writes the same contract as the recorded one.",
        verificationMethod: "unit-test",
        required: true,
      },
    ],
    nonGoals: ["Do not assert anything about model output quality."],
    stopConditions: ["Stop once the artifacts have been compared."],
    definitionOfDone: "The replay reproduces the recorded artifacts.",
    assumptions: [],
    outOfScope: [],
    ambiguityScore: 1,
    estimatedFiles: ["src/pge/runtime/replay.ts"],
    estimatedDuration: "small",
    iterationHistory: [],
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
  });
}

function message(id: string, seq: number, nodeId: string, text: string): GraphMessage {
  return { id, seq, role: "assistant", nodeId, text, tokens: text.length };
}

// ── Fixture node registry ───────────────────────────────────────────

function fixtureNodeRegistry(): NodeRegistry {
  const registry = createNodeRegistry();

  registry.register({
    id: NODES.plan,
    kind: "llm",
    inputPort: null,
    outputPort: null,
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    handler: async (_input, _state, ctx) => {
      // THE outward call. Every artifact below is derived from its answer, so a replay
      // that invented a response could not reproduce the recorded contracts.
      const answer: PlannerResponse = PlannerResponseSchema.parse(
        await ctx.effects.invoke(PLANNER_EFFECT, { prompt: "draft the plan" }, ctx),
      );
      return {
        update: {
          spec: fixturePlanSpec(answer.specTitle),
          sprintContracts: [fixtureContract(answer.sprintTitle)],
          messages: [message("m-plan", 0, NODES.plan, `drafted ${answer.specTitle}`)],
          counters: { planRounds: 1 },
        },
        phase: "planning" as const,
        goto: { kind: "node" as const, node: NODES.supervisor },
        output: {},
      };
    },
  });

  registry.register({
    id: NODES.supervisor,
    kind: "router",
    inputPort: null,
    outputPort: null,
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    handler: async () =>
      Promise.resolve({
        update: { counters: { supervisorRounds: 1 } },
        goto: { kind: "label" as const, label: "done" },
        output: { label: "done" },
      }),
  });

  registry.register({
    id: NODES.finalize,
    kind: "tool",
    inputPort: null,
    outputPort: null,
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    handler: async (_input, state) =>
      Promise.resolve({
        update: {
          messages: [message("m-final", 100, NODES.finalize, "run finalized")],
          verdict: state.sprintContracts.every((c) => c.status === "passed")
            ? ("success" as const)
            : ("partial" as const),
          specId: FIXTURE_SPEC_ID,
        },
        phase: "complete" as const,
        goto: { kind: "node" as const, node: "END" },
        output: {},
      }),
  });

  return registry;
}

// ── The fixture run ─────────────────────────────────────────────────

const RECORDED_ANSWER: PlannerResponse = {
  specTitle: "Recorded plan title",
  sprintTitle: "Recorded sprint title",
};

interface FixtureRunOptions {
  projectRoot: string;
  runId: string;
  /** Wraps the real effect registry — the recorder on the way in, the replay on the way back. */
  wrapEffects?: (inner: EffectRegistry) => EffectRegistry;
  wrapTrace?: (inner: TraceWriter) => TraceWriter;
  /** What the LIVE planner effect answers. Never consulted during a replay. */
  answer?: PlannerResponse;
  /** Counts live invocations of the planner effect body. */
  onLiveCall?: () => void;
}

function plannerEffectDef(options: FixtureRunOptions): EffectDef<
  z.infer<typeof PlannerRequestSchema>,
  PlannerResponse
> {
  return {
    name: PLANNER_EFFECT,
    requestSchema: PlannerRequestSchema,
    responseSchema: PlannerResponseSchema,
    effects: ["network"],
    run: async () => {
      options.onLiveCall?.();
      return Promise.resolve(options.answer ?? RECORDED_ANSWER);
    },
  };
}

/** Run the fixture graph to completion and finalize it through the commit boundary. */
async function runFixture(options: FixtureRunOptions): Promise<PipelineResult> {
  const { projectRoot, runId } = options;
  const clock = createFixedClock(FIXED_ISO);
  const config = createDefaultConfig("replay-fixture", "brownfield");
  const scratch = createScratchStore(projectRoot);

  const baseTrace = await createTraceWriter(projectRoot, runId, { now: () => clock.now() });
  const trace = options.wrapTrace ? options.wrapTrace(baseTrace) : baseTrace;

  const baseEffects = createEffectRegistry();
  baseEffects.register(plannerEffectDef(options));
  const effects = options.wrapEffects ? options.wrapEffects(baseEffects) : baseEffects;

  const graph = compile(fixtureSpec(), {
    nodes: fixtureNodeRegistry(),
    reducers: createReducerRegistry(),
    effects,
  });

  const commit = createCommitBoundary({ clock });
  const ctx: RunContext = {
    runId,
    projectRoot,
    config,
    clock,
    signal: new AbortController().signal,
    trace,
    scheduler: new Scheduler({ maxConcurrent: 1 }),
    ledger: createBudgetLedger(),
    commit,
    planner: createFrontierPlanner(),
    services: {
      effects,
      scratch,
      archive: createArchiveWriter(projectRoot),
      cache: createSemanticCache(projectRoot, runId),
      prompts: { has: () => true, get: (ref) => Promise.resolve(`stub prompt for ${ref}`) },
      models: createModelBinder({
        light: { provider: "stub", modelId: "stub-light" },
        frontier: { provider: "stub", modelId: "stub-frontier" },
      }),
    },
  };

  const result = await createGraphInterpreter().run(
    graph,
    initialOverallState({ runId, projectRoot, featureRequest: FEATURE_REQUEST }),
    ctx,
  );
  await trace.close();

  if (result.status !== "completed") {
    throw new Error(`fixture run ended '${result.status}', expected 'completed'`);
  }

  return commit.finalize(result.state, {
    runId,
    projectRoot,
    config,
    superstep: result.supersteps,
    startedAtMs: clock.nowMs(),
  });
}

/** Record a run into `projectRoot`, returning its result and how often the effect really ran. */
async function recordFixtureRun(
  projectRoot: string,
  runId: string,
): Promise<{ result: PipelineResult; liveCalls: number }> {
  const scratch = createScratchStore(projectRoot);
  const recorder = createRunRecorder({ runId, scratch });
  let liveCalls = 0;
  const result = await runFixture({
    projectRoot,
    runId,
    wrapEffects: (inner) => recorder.effects(inner),
    wrapTrace: (inner) => recorder.trace(inner),
    onLiveCall: () => {
      liveCalls += 1;
    },
  });
  return { result, liveCalls };
}

// ── Temp roots ──────────────────────────────────────────────────────

let tmpRoots: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  tmpRoots = [];
});

afterEach(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  tmpRoots = [];
});

async function mkTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bober-replay-test-"));
  tmpRoots.push(dir);
  return dir;
}

/** A `NodeContext` with the three fields the effect registry reads. */
function callerContext(nodeId: string, declaredEffects: NodeContext["declaredEffects"]): NodeContext {
  return { nodeId, branchKey: null, declaredEffects } as unknown as NodeContext;
}

// ── Tests ───────────────────────────────────────────────────────────

describe("run recorder", () => {
  it("stamps each node's recording onto its own span and reads it back through readSpans", async () => {
    const root = await mkTmp();
    const runId = "run-record-1";

    const { liveCalls } = await recordFixtureRun(root, runId);
    expect(liveCalls).toBe(1);

    const spans = await readSpans(tracePath(root, runId));
    const planSpans = spans.filter((s) => s.nodeId === NODES.plan);
    expect(planSpans).toHaveLength(1);
    expect(planSpans[0].toolOutputRef).toBeDefined();
    // Only the node that made a call carries a recording ref.
    expect(spans.filter((s) => s.toolOutputRef !== undefined)).toHaveLength(1);

    const recording = await readRecording(root, runId);
    expect(recording.size).toBe(1);
    const key = recordingKey({ nodeId: NODES.plan, branchKey: null, callIndex: 0 });
    expect(recording.get(key)?.effectName).toBe(PLANNER_EFFECT);
    expect(recording.get(key)?.response).toEqual(RECORDED_ANSWER);
    expect(recording.get(key)?.request).toEqual({ prompt: "draft the plan" });
  });

  it("reads no recording from a run that has no trace", async () => {
    const root = await mkTmp();
    const recording = await readRecording(root, "run-that-never-ran");
    expect(recording.size).toBe(0);
  });
});

describe("replayRecordedRun", () => {
  it("reproduces byte-identical artifacts from the recorded responses alone", async () => {
    const recordedRoot = await mkTmp();
    const replayRoot = await mkTmp();
    const runId = "run-replay-1";

    const recorded = await recordFixtureRun(recordedRoot, runId);
    expect(recorded.liveCalls).toBe(1);

    let replayLiveCalls = 0;
    const fetchSpy = vi.fn(() => {
      throw new Error("the replay must not reach globalThis.fetch");
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    let outcome;
    try {
      outcome = await replayRecordedRun({
        recordedRoot,
        replayRoot,
        runId,
        recordedResult: recorded.result,
        rerun: ({ projectRoot, recording }) =>
          runFixture({
            projectRoot,
            runId,
            wrapEffects: (inner) => createReplayEffectRegistry(inner, recording),
            // A DIFFERENT live answer, so a replay that fell through to the real effect
            // would produce different artifacts instead of failing invisibly.
            answer: { specTitle: "LIVE plan title", sprintTitle: "LIVE sprint title" },
            onLiveCall: () => {
              replayLiveCalls += 1;
            },
          }),
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(outcome.identical).toBe(true);
    expect(outcome.divergences).toEqual([]);
    expect(outcome.report.vacuous).toBe(false);
    expect(outcome.recordedCalls).toBe(1);
    // The recorded response answered the call; the live effect body never ran again.
    expect(replayLiveCalls).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();

    // The equivalence has to rest on artifacts that actually exist on both sides.
    expect(outcome.comparedFields).toEqual(
      expect.arrayContaining(["contracts", "specs", "history", "completionMarker", "pipelineResult"]),
    );

    // And the artifacts really are the recorded ones, not the live answer's.
    const replayedContract = JSON.parse(
      await readFile(join(replayRoot, ".bober", "contracts", "sprint-replay-1.json"), "utf-8"),
    ) as { title: string };
    expect(replayedContract.title).toBe(RECORDED_ANSWER.sprintTitle);
  });

  it("reports a structured divergence when the replayed run writes different artifacts", async () => {
    const recordedRoot = await mkTmp();
    const replayRoot = await mkTmp();
    const runId = "run-replay-diverge";

    const recorded = await recordFixtureRun(recordedRoot, runId);

    const outcome = await replayRecordedRun({
      recordedRoot,
      replayRoot,
      runId,
      recordedResult: recorded.result,
      // A replay that answers from a DIFFERENT recording is a divergence, not a miss.
      rerun: ({ projectRoot }) =>
        runFixture({
          projectRoot,
          runId,
          wrapEffects: (inner) =>
            createReplayEffectRegistry(
              inner,
              createRecording(runId, [
                {
                  nodeId: NODES.plan,
                  branchKey: null,
                  effectName: PLANNER_EFFECT,
                  callIndex: 0,
                  request: { prompt: "draft the plan" },
                  response: { specTitle: "Other plan", sprintTitle: "Other sprint" },
                },
              ]),
            ),
        }),
    });

    expect(outcome.identical).toBe(false);
    expect(outcome.divergences.length).toBeGreaterThan(0);
    for (const divergence of outcome.divergences) {
      expect(divergence.sides).toEqual(["recorded", "replayed"]);
      expect(divergence.path.length).toBeGreaterThan(0);
    }
    expect(outcome.divergences.map((d) => d.artifact)).toEqual(
      expect.arrayContaining(["contract", "spec"]),
    );
  });
});

describe("a missing recording", () => {
  it("fails the replay loudly instead of degrading to a default response", async () => {
    const recordedRoot = await mkTmp();
    const replayRoot = await mkTmp();
    const runId = "run-replay-missing";

    const recorded = await recordFixtureRun(recordedRoot, runId);
    const full = await readRecording(recordedRoot, runId);
    expect(full.size).toBe(1);

    // Delete the one recorded response, exactly as a truncated trace would.
    const empty = createRecording(runId, []);
    let liveCalls = 0;

    await expect(
      replayRecordedRun({
        recordedRoot,
        replayRoot,
        runId,
        recordedResult: recorded.result,
        rerun: ({ projectRoot }) =>
          runFixture({
            projectRoot,
            runId,
            wrapEffects: (inner) => createReplayEffectRegistry(inner, empty),
            onLiveCall: () => {
              liveCalls += 1;
            },
          }),
      }),
    ).rejects.toThrow();

    // The registry threw, so the node FAILED — it did not fall through to the live effect
    // and it did not invent an answer. The span names the class, which is what makes the
    // miss diagnosable from the replay's own trace.
    expect(liveCalls).toBe(0);
    const spans = await readSpans(tracePath(replayRoot, runId));
    const failed = spans.filter((s) => s.status === "failed");
    expect(failed.map((s) => s.errorClass)).toContain(MissingRecordingError.name);

    // And nothing was written from a fabricated response.
    await expect(readdir(join(replayRoot, ".bober", "contracts"))).rejects.toThrow();
  });

  it("names the call it could not answer", async () => {
    const registry = createReplayEffectRegistry(
      registryWithPlannerEffect(),
      createRecording("run-x", []),
    );
    const error = await registry
      .invoke(PLANNER_EFFECT, { prompt: "p" }, callerContext(NODES.plan, ["network"]))
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(error).toBeInstanceOf(MissingRecordingError);
    const missing = error as MissingRecordingError;
    expect(missing.reason).toBe("absent");
    expect(missing.key).toBe(recordingKey({ nodeId: NODES.plan, branchKey: null, callIndex: 0 }));
    expect(missing.message).toContain(PLANNER_EFFECT);
  });

  it("refuses a recorded call that belongs to a different effect", async () => {
    const registry = createReplayEffectRegistry(
      registryWithPlannerEffect(),
      createRecording("run-x", [
        {
          nodeId: NODES.plan,
          branchKey: null,
          effectName: "some.other.effect",
          callIndex: 0,
          request: {},
          response: {},
        },
      ]),
    );
    const error = await registry
      .invoke(PLANNER_EFFECT, { prompt: "p" }, callerContext(NODES.plan, ["network"]))
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(error).toBeInstanceOf(MissingRecordingError);
    expect((error as MissingRecordingError).reason).toBe("effect-mismatch");
  });
});

describe("the replay effect registry", () => {
  it("still refuses an effect the calling node did not declare", async () => {
    const registry = createReplayEffectRegistry(
      registryWithPlannerEffect(),
      createRecording("run-x", [
        {
          nodeId: NODES.plan,
          branchKey: null,
          effectName: PLANNER_EFFECT,
          callIndex: 0,
          request: {},
          response: RECORDED_ANSWER,
        },
      ]),
    );
    await expect(
      registry.invoke(PLANNER_EFFECT, { prompt: "p" }, callerContext(NODES.plan, [])),
    ).rejects.toBeInstanceOf(EffectNotDeclaredError);
  });

  it("hands back a clone, so a node body cannot edit the recording", async () => {
    const recording = createRecording("run-x", [
      {
        nodeId: NODES.plan,
        branchKey: null,
        effectName: PLANNER_EFFECT,
        callIndex: 0,
        request: {},
        response: { specTitle: "a", sprintTitle: "b" },
      },
    ]);
    const registry = createReplayEffectRegistry(registryWithPlannerEffect(), recording);
    const first = (await registry.invoke(
      PLANNER_EFFECT,
      { prompt: "p" },
      callerContext(NODES.plan, ["network"]),
    )) as { specTitle: string };
    first.specTitle = "mutated";

    const key = recordingKey({ nodeId: NODES.plan, branchKey: null, callIndex: 0 });
    expect(recording.get(key)?.response).toEqual({ specTitle: "a", sprintTitle: "b" });
  });
});

function registryWithPlannerEffect(): EffectRegistry {
  const registry = createEffectRegistry();
  registry.register({
    name: PLANNER_EFFECT,
    requestSchema: PlannerRequestSchema,
    responseSchema: PlannerResponseSchema,
    effects: ["network"],
    run: () => {
      throw new Error("the replay registry must never reach the live effect body");
    },
  });
  return registry;
}

describe("the network and process stubs", () => {
  it("throws on fetch instead of returning a canned response, and restores fetch after", async () => {
    const original = globalThis.fetch;
    let thrown: unknown = null;
    await withNetworkDisabled(() => {
      try {
        // SYNCHRONOUS, deliberately: a rejected promise can be turned into a fallback
        // response by a `.catch()` the caller already has; a throw cannot.
        void globalThis.fetch("https://api.example.com/v1/messages");
      } catch (error) {
        thrown = error;
      }
      return Promise.resolve();
    });
    expect(thrown).toBeInstanceOf(NetworkDisabledInReplayError);
    expect((thrown as NetworkDisabledInReplayError).target).toContain("api.example.com");
    expect(globalThis.fetch).toBe(original);
  });

  it("restores fetch even when the replayed run throws", async () => {
    const original = globalThis.fetch;
    await expect(
      withNetworkDisabled(() => Promise.reject(new Error("run blew up"))),
    ).rejects.toThrow("run blew up");
    expect(globalThis.fetch).toBe(original);
  });

  it("refuses to spawn a process", () => {
    const sandbox = createRefusingSandbox();
    expect(() =>
      sandbox.run("npm", ["test"], { cwd: "/tmp", timeoutMs: 1, env: {}, allowNetwork: false }, {
        put: () => Promise.reject(new Error("unused")),
        get: () => Promise.reject(new Error("unused")),
        text: () => Promise.reject(new Error("unused")),
      } as never),
    ).toThrow(ProcessExecutionDisabledInReplayError);
  });
});

describe("prepareReplayRoot", () => {
  it("copies the run's inputs and none of its outputs", async () => {
    const recordedRoot = await mkTmp();
    const replayRoot = await mkTmp();

    await mkdir(join(recordedRoot, ".bober", "topology"), { recursive: true });
    await writeFile(join(recordedRoot, ".bober", "topology", "coding.json"), "{}", "utf-8");
    await mkdir(join(recordedRoot, ".bober", "contracts"), { recursive: true });
    await writeFile(join(recordedRoot, ".bober", "contracts", "c.json"), "{}", "utf-8");

    const copied = await prepareReplayRoot(recordedRoot, replayRoot);
    expect(copied).toContain(REPLAY_INPUT_PATHS[0]);

    await expect(
      readFile(join(replayRoot, ".bober", "topology", "coding.json"), "utf-8"),
    ).resolves.toBe("{}");
    // An OUTPUT copied into the replay root would make the comparison read the recorded
    // artifact back on both sides.
    await expect(
      readFile(join(replayRoot, ".bober", "contracts", "c.json"), "utf-8"),
    ).rejects.toThrow();
  });
});

describe("recording lookup", () => {
  it("addresses a call by node, branch and position", () => {
    expect(recordingKey({ nodeId: "n", branchKey: null, callIndex: 0 })).toBe("n@#0");
    expect(recordingKey({ nodeId: "n", branchKey: "b", callIndex: 2 })).toBe("n@b#2");
  });

  it("keeps branches apart", () => {
    const recording: Recording = createRecording("run-x", [
      {
        nodeId: "n",
        branchKey: "a",
        effectName: PLANNER_EFFECT,
        callIndex: 0,
        request: {},
        response: "A",
      },
      {
        nodeId: "n",
        branchKey: "b",
        effectName: PLANNER_EFFECT,
        callIndex: 0,
        request: {},
        response: "B",
      },
    ]);
    expect(recording.size).toBe(2);
    expect(recording.get(recordingKey({ nodeId: "n", branchKey: "a", callIndex: 0 }))?.response).toBe(
      "A",
    );
    expect(recording.get(recordingKey({ nodeId: "n", branchKey: "b", callIndex: 0 }))?.response).toBe(
      "B",
    );
  });
});
