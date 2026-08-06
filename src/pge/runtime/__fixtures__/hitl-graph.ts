import { z } from "zod";

import type { BoberConfig } from "../../../config/schema.js";
import { createDefaultConfig } from "../../../config/schema.js";
import type { MechanismName } from "../../../orchestrator/checkpoints/audit.js";
import { TopologySpecSchema } from "../../../contracts/topology.js";
import type { NodeSpec, TopologySpec } from "../../../contracts/topology.js";
import { Scheduler } from "../../../orchestrator/workflow/scheduler.js";
import { compile } from "../../compile/compiler.js";
import type { CompiledGraph, Registries } from "../../compile/compiler.js";
import { createEffectRegistry } from "../../registry/effects.js";
import { createModelBinder, createNodeRegistry } from "../../registry/nodes.js";
import type { NodeImpl, NodeRegistry } from "../../registry/nodes.js";
import { createReducerRegistry } from "../../registry/reducers.js";
import { initialOverallState } from "../../state/overall.js";
import type { GraphMessage, OverallState } from "../../state/overall.js";
import { checksumTopology } from "../../topology/canonical.js";
import { createArchiveWriter } from "../archive.js";
import { createSemanticCache } from "../cache.js";
import type { CheckpointRef, GraphCheckpointer } from "../checkpointer.js";
import { createCommitBoundary } from "../commit.js";
import { createFrontierPlanner } from "../frontier.js";
import { createGraphInterpreter } from "../interpreter.js";
import type { GraphRunResult, RunContext } from "../interpreter.js";
import type { InterruptController } from "../interrupt.js";
import { createBudgetLedger } from "../ledger.js";
import { createScratchStore } from "../scratch.js";
import { createTraceWriter, readSpans } from "../trace.js";
import type { Span } from "../trace.js";
import { GOLDEN_SCHEMA_MODULES, goldenSchemaCatalog } from "./golden-graph.js";
import { countingNodeRegistry, createMonotonicClock } from "./run-harness.js";
import type { HandlerCallLog } from "./run-harness.js";

/**
 * The HITL fixture: a straight line through two approval gates and the two irreversible
 * effects they authorise.
 *
 *   plan -> gate_commit -> commit_changes(git) -> gate_deploy -> deploy(process-exec)
 *        -> finalize -> END,   with graceful_failure as the rejection terminal.
 *
 * Deliberately NOT the golden graph. The golden topology is pinned by the determinism and
 * exactly-once suites down to span counts, so adding two gates and two effectful nodes to
 * it would make every one of those assertions a statement about this sprint's fixture
 * instead of about the barrier semantics they exist to prove.
 *
 * ── The gate is a separate node, because the validator says so ──
 *
 * `EffectfulNodeContainsHitl` refuses a node that declares BOTH effects and its own HITL
 * policy, so an approval is always an upstream gate and the effect is always downstream of
 * it. That is what makes the runtime's inbound-edge rule checkable: `computeEffectGates`
 * reads the gate off the declared edge, and removing that edge is a visible topology diff.
 *
 * ── `performed` is the proof that fail-closed means fail-closed ──
 *
 * The two effectful handlers push their name into {@link HitlBehaviour.performed} as the
 * FIRST thing they do. A test asserting only "an error came back" would pass against an
 * implementation that ran the git commit and then reported a rejection; asserting that
 * `performed` is empty is what proves the operation did not happen.
 */

// ── Ids ─────────────────────────────────────────────────────────────

export const HITL_GRAPH_ID = "hitl-fixture";

export const HITL_NODES = {
  plan: "plan",
  gateCommit: "gate_commit",
  commit: "commit_changes",
  gateDeploy: "gate_deploy",
  deploy: "deploy",
  finalize: "finalize",
  gracefulFailure: "graceful_failure",
} as const;

/** Two of the NINE documented checkpoint ids. No tenth id is invented anywhere. */
export const HITL_CHECKPOINTS = {
  commit: "post-sprint",
  deploy: "end-of-pipeline",
} as const;

const N = HITL_NODES;

// ── Topology ────────────────────────────────────────────────────────

const HITL_NODE_SPECS: NodeSpec[] = [
  {
    id: N.plan,
    kind: "llm",
    title: "Draft the change",
    doc: "Produces the change set the commit gate is asked to approve. Writes only order-invariant collection channels.",
    subgraph: null,
    role: "planner",
    modelTier: "frontier",
    promptRef: "plan/draft",
    inputPorts: [],
    outputPorts: [],
    reads: ["messages"],
    writes: ["messages", "counters"],
    effects: [],
  },
  {
    id: N.gateCommit,
    kind: "gate",
    title: "Approve the commit",
    doc: "The human-in-the-loop gate in front of the git commit. Carries no effects of its own, because a node may not both raise an interrupt and perform an effect.",
    subgraph: null,
    role: "utility",
    inputPorts: [],
    outputPorts: [],
    reads: ["messages"],
    writes: [],
    effects: [],
    gate: { check: "commit-approved", onFail: N.gracefulFailure },
    hitl: { checkpointId: HITL_CHECKPOINTS.commit, onReject: N.gracefulFailure },
  },
  {
    id: N.commit,
    kind: "tool",
    title: "Commit to git",
    doc: "The irreversible half: writes a real commit. Reachable only through the approval gate above it.",
    subgraph: null,
    role: "utility",
    inputPorts: [],
    outputPorts: [],
    reads: ["messages"],
    writes: ["messages", "counters"],
    effects: ["git"],
    toolRef: "git.commit",
  },
  {
    id: N.gateDeploy,
    kind: "gate",
    title: "Approve the deploy",
    doc: "The second human-in-the-loop gate, in front of the deploy. A separate checkpoint id, so approving a commit is not approving a release.",
    subgraph: null,
    role: "utility",
    inputPorts: [],
    outputPorts: [],
    reads: ["messages"],
    writes: [],
    effects: [],
    gate: { check: "deploy-approved", onFail: N.gracefulFailure },
    hitl: { checkpointId: HITL_CHECKPOINTS.deploy, onReject: N.gracefulFailure },
  },
  {
    id: N.deploy,
    kind: "tool",
    title: "Deploy",
    doc: "Runs the release command. Declares process-exec, so it is gated exactly like the commit.",
    subgraph: null,
    role: "utility",
    inputPorts: [],
    outputPorts: [],
    reads: ["messages"],
    writes: ["messages", "counters"],
    effects: ["process-exec"],
    toolRef: "deploy.run",
  },
  {
    id: N.finalize,
    kind: "tool",
    title: "Finalize",
    doc: "The success terminal. Records the run verdict as a control-plane fact and ends the run.",
    subgraph: null,
    role: "utility",
    inputPorts: [],
    outputPorts: [],
    reads: ["messages"],
    writes: ["messages"],
    effects: [],
    toolRef: "run.finalize",
  },
  {
    id: N.gracefulFailure,
    kind: "tool",
    title: "Fail gracefully",
    doc: "The rejection terminal: every gate's onReject and onFail lands here, and the run ends without the effect having happened.",
    subgraph: null,
    role: "utility",
    inputPorts: [],
    outputPorts: [],
    reads: ["messages"],
    writes: ["messages"],
    effects: [],
    toolRef: "run.gracefulFailure",
  },
];

const HITL_UNSEALED: TopologySpec = {
  formatVersion: 1,
  graphId: HITL_GRAPH_ID,
  graphVersion: "1.0.0",
  description:
    "HITL fixture: two approval gates in front of the two irreversible effects a run can perform.",
  provenance: "authored",
  entry: N.plan,
  defaults: {
    supervisorNodeId: N.finalize,
    modelTier: "light",
    concurrency: 1,
    durability: "superstep",
    maxInlineBytes: 4096,
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
  ],
  nodes: HITL_NODE_SPECS,
  edges: [
    { id: "e-plan-gate", from: N.plan, to: N.gateCommit, kind: "normal" },
    { id: "e-gate-commit", from: N.gateCommit, to: N.commit, kind: "normal" },
    { id: "e-commit-gate", from: N.commit, to: N.gateDeploy, kind: "normal" },
    { id: "e-gate-deploy", from: N.gateDeploy, to: N.deploy, kind: "normal" },
    { id: "e-deploy-finalize", from: N.deploy, to: N.finalize, kind: "normal" },
    { id: "e-finalize-end", from: N.finalize, to: "END", kind: "normal" },
    { id: "e-graceful-end", from: N.gracefulFailure, to: "END", kind: "normal" },
  ],
  checksum: `sha256:${"0".repeat(64)}`,
  subgraphs: [],
};

/** A fresh, sealed copy of the HITL artifact. */
export function hitlSpec(): TopologySpec {
  const clone = TopologySpecSchema.parse(JSON.parse(JSON.stringify(HITL_UNSEALED)) as unknown);
  return { ...clone, checksum: checksumTopology(clone) };
}

/**
 * The same artifact with ONE extra edge: `commit_changes -> gate_commit`.
 *
 * That single edge turns the straight line into the shape the coding topology actually
 * has — a bounded rework cycle — and it is the shape the straight-line fixture cannot
 * express: a HITL gate that is ENTERED MORE THAN ONCE. An approval cached under the bare
 * checkpoint id is invisible in a line and catastrophic in a loop, because the second and
 * every later iteration then commits on the first iteration's approval.
 *
 * `HitlBehaviour.reworkRounds` decides how many times `commit_changes` takes the new edge
 * back to the gate before continuing to the deploy half, so the loop is bounded by the
 * fixture rather than by a superstep cap.
 */
export function hitlReworkSpec(): TopologySpec {
  const clone = TopologySpecSchema.parse(
    JSON.parse(JSON.stringify(HITL_UNSEALED)) as unknown,
  );
  const withCycle: TopologySpec = {
    ...clone,
    graphVersion: "1.1.0",
    edges: [
      ...clone.edges,
      { id: "e-commit-rework", from: N.commit, to: N.gateCommit, kind: "normal" },
    ],
  };
  return { ...withCycle, checksum: checksumTopology(withCycle) };
}

// ── Node bodies ─────────────────────────────────────────────────────

export interface HitlBehaviour {
  /**
   * Every effectful node that ACTUALLY ENTERED ITS BODY, in order.
   *
   * The array a fail-closed test asserts is empty. "An error was returned" is not the same
   * claim as "the git operation did not happen", and only this one is checkable.
   */
  readonly performed: string[];
  /** Node ids whose handler throws, for the failure-path tests. */
  readonly failing?: readonly string[];
  /**
   * How many times `commit_changes` routes back to `gate_commit` before moving on.
   *
   * Only reachable with {@link hitlReworkSpec}, which declares the edge. Each round carries
   * a DIFFERENT `revision` in its output, so the gate is re-entered with content the human
   * has not seen — which is exactly the fact a per-checkpoint-id approval cache loses.
   */
  readonly reworkRounds?: number;
}

function message(id: string, seq: number, nodeId: string, text: string): GraphMessage {
  return { id, seq, role: "assistant", nodeId, text, tokens: text.length };
}

function hitlNodeRegistry(behaviour: HitlBehaviour): NodeRegistry {
  const failing = new Set(behaviour.failing ?? []);
  const registry = createNodeRegistry();

  const reworkRounds = behaviour.reworkRounds ?? 0;

  const effectful = (nodeId: string, next: string, counter: string): NodeImpl["handler"] => {
    let round = 0;
    return async () => {
      // FIRST statement in the body: reaching this line is what "the effect happened"
      // means, and a gate that let it happen cannot hide behind a later error.
      behaviour.performed.push(nodeId);
      if (failing.has(nodeId)) throw new Error(`hitl fixture: ${nodeId} failed`);
      round += 1;
      const rework = nodeId === N.commit && round <= reworkRounds;
      return {
        update: {
          messages: [message(`m-${nodeId}`, behaviour.performed.length, nodeId, `${nodeId} ran`)],
          counters: { [counter]: 1 },
        },
        goto: { kind: "node", node: rework ? N.gateCommit : next },
        // `revision` appears only in the cycling fixture, so the straight-line topology's
        // task keys and payloads are byte-for-byte what they were.
        output: reworkRounds === 0 ? { performed: nodeId } : { performed: nodeId, revision: round },
      };
    };
  };

  const specs: Record<string, { kind: NodeImpl["kind"]; handler: NodeImpl["handler"] }> = {
    [N.plan]: {
      kind: "llm",
      handler: async () => ({
        update: {
          messages: [message("m-plan", 0, N.plan, "drafted the change")],
          counters: { planRounds: 1 },
        },
        phase: "planning",
        goto: { kind: "node", node: N.gateCommit },
        output: { drafted: true },
      }),
    },
    [N.gateCommit]: {
      kind: "gate",
      handler: async (input) => ({
        update: {},
        goto: { kind: "node", node: N.commit },
        output: input,
      }),
    },
    [N.commit]: { kind: "tool", handler: effectful(N.commit, N.gateDeploy, "commits") },
    [N.gateDeploy]: {
      kind: "gate",
      handler: async (input) => ({
        update: {},
        goto: { kind: "node", node: N.deploy },
        output: input,
      }),
    },
    [N.deploy]: { kind: "tool", handler: effectful(N.deploy, N.finalize, "deploys") },
    [N.finalize]: {
      kind: "tool",
      handler: async () => ({
        update: {
          messages: [message("m-final", 200, N.finalize, "run finalized")],
          verdict: "success" as const,
        },
        phase: "complete",
        goto: { kind: "node", node: "END" },
        output: { finalized: true },
      }),
    },
    [N.gracefulFailure]: {
      kind: "tool",
      handler: async (input) => ({
        update: {
          messages: [message("m-graceful", 300, N.gracefulFailure, "blocked before the effect")],
          verdict: "failed" as const,
        },
        phase: "failed",
        goto: { kind: "node", node: "END" },
        output: { blocked: true, echo: input },
      }),
    },
  };

  for (const node of HITL_NODE_SPECS) {
    const spec = specs[node.id];
    registry.register({
      id: node.id,
      kind: spec.kind,
      inputPort: null,
      outputPort: null,
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      handler: spec.handler,
    });
  }
  return registry;
}

export function hitlRegistries(behaviour: HitlBehaviour): Registries {
  return {
    nodes: hitlNodeRegistry(behaviour),
    reducers: createReducerRegistry(),
    effects: createEffectRegistry(),
    schemas: goldenSchemaCatalog(),
    schemaModules: GOLDEN_SCHEMA_MODULES,
  };
}

export function compileHitl(
  behaviour: HitlBehaviour,
  spec: TopologySpec = hitlSpec(),
): { graph: CompiledGraph; handlerLog: HandlerCallLog } {
  const registries = hitlRegistries(behaviour);
  const counted = countingNodeRegistry(registries.nodes);
  return {
    graph: compile(spec, { ...registries, nodes: counted.registry }),
    handlerLog: counted.log,
  };
}

// ── Harness ─────────────────────────────────────────────────────────

export interface RunHitlOptions {
  projectRoot: string;
  behaviour: HitlBehaviour;
  runId?: string;
  config?: BoberConfig;
  spec?: TopologySpec;
  checkpointer?: GraphCheckpointer;
  interrupts?: InterruptController;
  /** Continue from a checkpoint instead of starting a run. */
  resumeFrom?: { ref: CheckpointRef; value?: unknown };
}

export interface HitlRun {
  result: GraphRunResult;
  spans: Span[];
  graph: CompiledGraph;
  runId: string;
  finalState: OverallState;
  /** Node id -> handler bodies ENTERED in this process. */
  handlerLog: HandlerCallLog;
}

/** A config with the checkpoint mechanism pinned, for the mechanism-resolution tests. */
export function hitlConfig(overrides: {
  /** Typed as the shipped union, so a typo is a compile error rather than a cast. */
  checkpointMechanism?: MechanismName;
  mode?: "autopilot" | "careful";
} = {}): BoberConfig {
  const config = createDefaultConfig("hitl-fixture", "brownfield");
  return {
    ...config,
    pipeline: {
      ...config.pipeline,
      ...(overrides.mode === undefined ? {} : { mode: overrides.mode }),
      ...(overrides.checkpointMechanism === undefined
        ? {}
        : { checkpointMechanism: overrides.checkpointMechanism }),
    },
  };
}

export async function runHitl(options: RunHitlOptions): Promise<HitlRun> {
  const runId = options.runId ?? "run-hitl";
  const projectRoot = options.projectRoot;
  const config = options.config ?? hitlConfig();
  const clock = createMonotonicClock();
  const spec = options.spec ?? hitlSpec();
  const { graph, handlerLog } = compileHitl(options.behaviour, spec);
  const trace = await createTraceWriter(projectRoot, runId, { now: () => clock.now() });
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
      effects: createEffectRegistry(),
      scratch: createScratchStore(projectRoot),
      archive: createArchiveWriter(projectRoot),
      cache: createSemanticCache(projectRoot, runId),
      prompts: { has: () => true, get: async (ref: string) => `stub prompt for ${ref}` },
      models: createModelBinder({
        light: { provider: "stub", modelId: "stub-light" },
        frontier: { provider: "stub", modelId: "stub-frontier" },
      }),
    },
    ...(options.checkpointer === undefined ? {} : { checkpointer: options.checkpointer }),
    ...(options.interrupts === undefined ? {} : { interrupts: options.interrupts }),
  };

  const interpreter = createGraphInterpreter();
  let result: GraphRunResult;
  try {
    result =
      options.resumeFrom === undefined
        ? await interpreter.run(graph, initialOverallState({
            runId,
            projectRoot,
            featureRequest: "Commit and deploy, if a human says so.",
          }), ctx)
        : await interpreter.resume(graph, options.resumeFrom.ref, options.resumeFrom.value, ctx);
  } finally {
    await trace.close();
  }

  return {
    result,
    spans: await readSpans(trace.path()),
    graph,
    runId,
    finalState: result.state,
    handlerLog,
  };
}
