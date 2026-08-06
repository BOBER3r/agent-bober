import { z } from "zod";

import type { BoberConfig } from "../../config/schema.js";
import { TERMINAL_ENDPOINT } from "../../contracts/topology.js";
import type { Durability, NodeSpec, TopologySpec } from "../../contracts/topology.js";
import type { CheckpointOutcome } from "../../orchestrator/checkpoints/types.js";
import type { Scheduler } from "../../orchestrator/workflow/scheduler.js";
import { PhaseSchema } from "../../state/history.js";
import type { Phase } from "../../state/history.js";
import type { CompiledGraph, CompiledNode } from "../compile/compiler.js";
import type { EffectRegistry } from "../registry/effects.js";
import type {
  Command,
  Goto,
  ModelBinder,
  NodeContext,
  PromptStore,
  ScratchStore,
} from "../registry/nodes.js";
import type { OverallState, RunVerdict } from "../state/overall.js";
import { OverallStateSchema } from "../state/overall.js";
import { archiveNodeDir } from "./archive.js";
import type { ArchiveWriter } from "./archive.js";
import type { SemanticCache } from "./cache.js";
import {
  CHECKPOINT_FORMAT_VERSION,
  assertCheckpointMatchesGraph,
  resolveSubgraphCheckpointers,
} from "./checkpointer.js";
import type {
  Checkpoint,
  CheckpointRef,
  GraphCheckpointer,
  InterruptRecord,
} from "./checkpointer.js";
import type { ChannelUpdate, CommitBoundary, StateBloatError } from "./commit.js";
import { createPendingTask } from "./frontier.js";
import type { AdmissionReason, DeferredTask, FrontierPlanner, PendingTask } from "./frontier.js";
import { GraphInterrupted, createInterruptController, isApproved } from "./interrupt.js";
import type { EffectGate, InterruptController } from "./interrupt.js";
import type { BudgetLedger } from "./ledger.js";
import type { RetryPolicy } from "./retry-planner.js";
import type { SpanEnd, SpanHandle, TraceWriter } from "./trace.js";

/**
 * The superstep interpreter: executable graph semantics for a compiled topology.
 *
 * ── The loop, in fixed order ──
 *
 *   plan frontier -> admit -> execute -> BARRIER -> commit once -> route
 *
 * Nothing in that order is negotiable. The barrier is what makes the commit see the whole
 * batch, the single commit is what makes each channel's reducer run exactly once, and
 * routing AFTER the commit is what stops a node from routing on state that a sibling has
 * not contributed to yet. Sprint 8 inserts checkpointing between commit and route; the
 * seam is deliberately left where the architecture puts it.
 *
 * ── Routing is a value, not a wiring table ──
 *
 * A node returns ONE {@link Command}: a state delta and a destination. There is no static
 * conditional-edge map anywhere — the artifact declares a router's outcome LABELS and the
 * router body picks one, so a topology diff shows which destinations exist and the
 * interpreter resolves the chosen label through the compiled adjacency. `Goto` has four
 * kinds and each fails loudly rather than silently:
 *
 *   label   — must be a label the router declares; anything else is UndeclaredRouteLabel
 *   node    — must be reachable by a declared edge, or live in the same region; anything
 *             else is UnknownNodeInScope
 *   fanout  — one branch per `send`, dispatched down the single declared fan-out edge, so
 *             cardinality is a runtime fact and the topology checksum does not move when
 *             the contract count changes
 *   parent  — return to the parent scope's supervisor; unavailable at root scope
 *
 * ── The fan-in barrier is the superstep model ──
 *
 * A branch that leaves the fan-out region does not enqueue its successor: it deposits its
 * result in a join buffer. The join fires only when the LAST branch has left, as ONE task
 * whose input is the branch results sorted by branch key. So the stage after a fan-out
 * sees every branch exactly once, in an order that does not depend on which branch
 * finished first, at cap 1 and at cap 8 alike.
 *
 * ── This interpreter writes no files ──
 *
 * Every artifact write goes through {@link CommitBoundary}. The interpreter's only
 * filesystem contact is the trace, which is an execution record rather than a domain
 * artifact, and the stores a node body chooses to use.
 */

// ── Command validation ──────────────────────────────────────────────

export const GOTO_KINDS = ["label", "node", "fanout", "parent"] as const;
export const GotoKindSchema = z.enum(GOTO_KINDS);

export const CommandGotoSchema = z.object({
  kind: GotoKindSchema,
  label: z.string().min(1).optional(),
  node: z.string().min(1).optional(),
  sends: z.array(z.object({ branchKey: z.string().min(1), input: z.unknown() })).optional(),
});

/**
 * What every node return is parsed with: an OPTIONAL state delta and a REQUIRED
 * destination.
 *
 * Required, because a node that returns no destination has not said where control goes,
 * and the only two ways to treat that are "fall through to the single declared edge" —
 * which re-introduces the static wiring table this design exists to remove — or "stop",
 * which strands the run. Both are worse than a parse failure at the call site.
 */
export const CommandSchema = z.object({
  update: z.record(z.string(), z.unknown()).optional(),
  goto: CommandGotoSchema,
  phase: PhaseSchema.optional(),
});
export type ParsedCommand = z.infer<typeof CommandSchema>;

// ── Errors ──────────────────────────────────────────────────────────

/** A router body returned a label the artifact does not declare for that router. */
export class UndeclaredRouteLabelError extends Error {
  readonly nodeId: string;
  readonly label: string;
  readonly declared: string[];

  constructor(nodeId: string, label: string, declared: string[]) {
    super(
      `Node "${nodeId}" routed to label "${label}", which it does not declare (declared: ${declared.length === 0 ? "<none>" : declared.join(", ")}).`,
    );
    this.name = "UndeclaredRouteLabelError";
    this.nodeId = nodeId;
    this.label = label;
    this.declared = declared;
  }
}

/**
 * A `goto` naming a node that is not addressable from where the caller stands.
 *
 * Scope is the node's own region plus whatever the artifact gives it a declared edge to.
 * A node inside a subgraph therefore cannot name the root supervisor by id — it must
 * return `{ kind: "parent" }`, which is the declared way out.
 */
export class UnknownNodeInScopeError extends Error {
  readonly nodeId: string;
  readonly target: string;
  readonly scope: string | null;

  constructor(nodeId: string, target: string, scope: string | null) {
    super(
      `Node "${nodeId}" routed to node "${target}", which is not in scope ${scope === null ? "<root>" : `"${scope}"`} and is not the target of a declared edge from "${nodeId}". Use { kind: "parent" } to leave a subgraph.`,
    );
    this.name = "UnknownNodeInScopeError";
    this.nodeId = nodeId;
    this.target = target;
    this.scope = scope;
  }
}

/** `{ kind: "parent" }` from a node that is already at root scope. */
export class ParentScopeUnavailableError extends Error {
  readonly nodeId: string;

  constructor(nodeId: string) {
    super(`Node "${nodeId}" is at root scope and has no parent scope to return to.`);
    this.name = "ParentScopeUnavailableError";
    this.nodeId = nodeId;
  }
}

/** A fan-out from a node the artifact gives no fan-out edge, or with nothing to send. */
export class FanOutNotDispatchableError extends Error {
  readonly nodeId: string;

  constructor(nodeId: string, reason: string) {
    super(`Node "${nodeId}" returned a fan-out that cannot be dispatched: ${reason}.`);
    this.name = "FanOutNotDispatchableError";
    this.nodeId = nodeId;
  }
}

/**
 * A resume, or a suspend, attempted with no checkpointer in the run context.
 *
 * Fail loudly rather than quietly returning an unresumable result: a run that pauses and
 * writes nothing is a run that has silently lost its state, which is the failure class
 * this whole sprint exists to make impossible.
 */
export class CheckpointerRequiredError extends Error {
  readonly operation: string;

  constructor(operation: string) {
    super(
      `RunContext.checkpointer is required for "${operation}". Construct one with createFsCheckpointer(projectRoot).`,
    );
    this.name = "CheckpointerRequiredError";
    this.operation = operation;
  }
}

/**
 * A graph that declares a bounded cycle but binds its counter channel to a reducer that
 * is not a per-key maximum.
 *
 * ADR-4's stated elimination of the alternative state design is that "a non-idempotent
 * counter reducer over-counts on replay, so a bounded loop can exhaust early or never".
 * A loop bound folded through `+` is therefore not a weaker bound — it is not a bound at
 * all once a superstep is replayed, so this is a load error rather than a warning.
 */
export class NonIdempotentCounterChannelError extends Error {
  readonly channel: string;
  readonly reducerId: string;

  constructor(channel: string, reducerId: string) {
    super(
      `Channel "${channel}" carries the declared loop counters but is bound to reducer "${reducerId}". A loop bound survives a replayed superstep only under an idempotent per-key maximum ("maxNumber"); under any other reducer a re-executed superstep can exhaust the cycle early or never.`,
    );
    this.name = "NonIdempotentCounterChannelError";
    this.channel = channel;
    this.reducerId = reducerId;
  }
}

/** The loop ran past its bound. A guard against a routing bug, never an expected outcome. */
export class SuperstepLimitExceededError extends Error {
  readonly limit: number;

  constructor(limit: number) {
    super(
      `Graph run exceeded ${String(limit)} supersteps. That is a routing defect, not a workload: raise maxSupersteps only after establishing the cycle is bounded.`,
    );
    this.name = "SuperstepLimitExceededError";
    this.limit = limit;
  }
}

// ── Shapes ──────────────────────────────────────────────────────────

/** The collaborators a node body is handed, assembled once per run. */
export interface NodeServices {
  effects: EffectRegistry;
  scratch: ScratchStore;
  archive: ArchiveWriter;
  cache: SemanticCache;
  prompts: PromptStore;
  models: ModelBinder;
}

export interface RunContext {
  readonly runId: string;
  readonly projectRoot: string;
  readonly config: BoberConfig;
  readonly clock: CommitContextClock;
  readonly signal: AbortSignal;
  readonly trace: TraceWriter;
  readonly scheduler: Scheduler;
  readonly ledger: BudgetLedger;
  readonly commit: CommitBoundary;
  readonly planner: FrontierPlanner;
  readonly services: NodeServices;
  /**
   * Where a superstep's resumable snapshot goes.
   *
   * OPTIONAL, and absent means no checkpoint is written at all — which is what keeps a
   * test that only cares about routing from leaving a `.bober/checkpoints/` tree behind.
   * `resume` requires one and says so with {@link CheckpointerRequiredError}.
   */
  readonly checkpointer?: GraphCheckpointer;
  /**
   * The human-in-the-loop gate. Defaults to a fresh controller in `"mechanism"` mode, so
   * a node with a gated effect is fail-closed by DEFAULT rather than when someone
   * remembers to pass one.
   */
  readonly interrupts?: InterruptController;
  /** Tasks admitted per superstep. Defaults to the graph's own `defaults.concurrency`. */
  readonly concurrency?: number;
  /** Defaults to the graph's own `defaults.durability`. */
  readonly durability?: Durability;
  /** Runaway guard. Default {@link DEFAULT_MAX_SUPERSTEPS}. */
  readonly maxSupersteps?: number;
  /**
   * The run's USD spend ceiling. ABSENT MEANS UNCAPPED — the same null-means-unlimited
   * convention `src/orchestrator/workflow/budget.ts` uses.
   *
   * Checked at the superstep barrier, after the commit, and enforced by throwing
   * `BudgetExceededError` out of the run loop. Held here rather than read from `config`
   * inside the interpreter so the runtime keeps one place where a ceiling can come from
   * and a test can set one without a whole config.
   */
  readonly budgetCeilingUsd?: number;
  /**
   * Per-branch retry policy, and what an exhausted branch does to the run.
   *
   * OPTIONAL, and ABSENT MEANS ONE ATTEMPT AND NO GRACEFUL ROUTING — a failed task is
   * recorded, its branch is released so the join can still fire, and nothing else
   * happens. That is exactly the behaviour every superstep-loop test written before this
   * policy existed was written against, so an absent policy is not a degraded mode: it is
   * the previous semantics, unchanged byte for byte.
   *
   * Supplying one turns on three things at once, because they are one decision: failed
   * tasks are retried in isolation on the shared jittered schedule, the branch's
   * `branchStatus` record gains its attempt count and error class, and a branch that has
   * spent every attempt routes the run to the artifact's graceful-failure terminal.
   *
   * Note what is NOT gated on it: the loop bounds each cycle declares in the topology are
   * enforced unconditionally. A bound that had to be switched on is not a bound.
   */
  readonly retry?: RetryPolicy;
}

/** The clock shape both the interpreter and the commit boundary consume. */
export type CommitContextClock = NodeContext["clock"];

export interface CommitRecord {
  readonly superstep: number;
  readonly writesPerChannel: Record<string, number>;
  readonly batchSizePerChannel: Record<string, number>;
  readonly rejected: readonly StateBloatError[];
  readonly artifactWrites: number;
}

export interface TaskFailure {
  readonly nodeId: string;
  readonly branchKey: string | null;
  readonly superstep: number;
  readonly errorClass: string;
  readonly message: string;
}

export type GraphRunResult =
  | {
      readonly status: "completed";
      readonly state: OverallState;
      readonly verdict: Exclude<RunVerdict, "pending">;
      readonly supersteps: number;
      readonly commits: readonly CommitRecord[];
      readonly failures: readonly TaskFailure[];
      /** True when the run reached the terminal through the deadlock path. */
      readonly deadlocked: boolean;
    }
  | {
      readonly status: "aborted";
      readonly reason: string;
      readonly state: OverallState;
      readonly supersteps: number;
      readonly commits: readonly CommitRecord[];
      readonly failures: readonly TaskFailure[];
    }
  | {
      /**
       * Paused at a superstep boundary for a human decision.
       *
       * `state` is the last COMMITTED state and nothing more: the interrupt was evaluated
       * before any node of `supersteps` executed, so there is no partial superstep to
       * describe and no branch in flight.
       */
      readonly status: "interrupted";
      readonly checkpointRef: CheckpointRef;
      readonly pending: InterruptRecord;
      readonly state: OverallState;
      readonly supersteps: number;
      readonly commits: readonly CommitRecord[];
      readonly failures: readonly TaskFailure[];
    };

export interface GraphInterpreter {
  run(graph: CompiledGraph, init: OverallState, ctx: RunContext): Promise<GraphRunResult>;
  /**
   * Continue a run from a persisted checkpoint, in a process that may know nothing about
   * the one that wrote it.
   *
   * @param resumeValue the human decision, when the checkpoint carries a pending interrupt.
   * @throws CheckpointNotFoundError, CorruptCheckpointError, ChecksumMismatchError
   */
  resume(
    graph: CompiledGraph,
    ref: CheckpointRef,
    resumeValue: unknown,
    ctx: RunContext,
  ): Promise<GraphRunResult>;
}

/** The node a fully blocked frontier routes to, when the artifact declares one. */
export const GRACEFUL_FAILURE_NODE_ID = "graceful_failure";

/** Runaway guard on the superstep loop. */
export const DEFAULT_MAX_SUPERSTEPS = 200;

/** `errorClass` of the synthetic span the deadlock path writes. */
export const DEADLOCK_ERROR_CLASS = "FrontierDeadlock";

/** `errorClass` of the span a node blocked for want of a recorded approval writes. */
export const FAIL_CLOSED_ERROR_CLASS = "FailClosed";

/** `errorClass` of the span a node whose HITL gate was rejected writes. */
export const HITL_REJECTED_ERROR_CLASS = "HitlRejected";

/** `errorClass` recorded when a branch has spent every attempt {@link RunContext.retry} allows. */
export const RETRIES_EXHAUSTED_ERROR_CLASS = "RetriesExhausted";

/**
 * `errorClass` of the BOUNDED-EXIT span: a cycle reached the `maxIterations` its topology
 * declares and was routed to that loop's `onExhausted` instead of round again.
 *
 * A `failed` span with a distinguishing error class rather than a sixth
 * {@link SPAN_STATUSES} member, exactly like {@link DEADLOCK_ERROR_CLASS} and
 * {@link FAIL_CLOSED_ERROR_CLASS} — the trace schema does not move for a new outcome that
 * the existing vocabulary already describes.
 */
export const LOOP_EXHAUSTED_ERROR_CLASS = "LoopExhausted";

/** The channel every declared `loop.counterKey` is a KEY INSIDE. */
export const COUNTER_CHANNEL = "counters";

/** The channel a failed branch's state, attempt count and error class are recorded on. */
export const BRANCH_STATUS_CHANNEL = "branchStatus";

/** The only reducer under which a loop bound survives a replayed superstep (ADR-4). */
export const COUNTER_REDUCER_ID = "maxNumber";

/**
 * The `counters` key one loop bound is actually counted on.
 *
 * A topology declares ONE `counterKey` per cycle, but a cycle inside a fan-out region is
 * entered once PER BRANCH. Counting every branch on the same key would make the bound a
 * function of the concurrency cap — at cap 8 the eight branches all write `prev + 1` and
 * the counter reads 1, while at cap 1 they run in eight different supersteps and it reads
 * 8 — so the same graph would exhaust in one schedule and not in another. Scoping by
 * branch key makes the count a property of the GRAPH, which is what makes the
 * concurrency-1-versus-8 artifact comparison decidable at all.
 *
 * A root-scope loop (`branchKey === null`) counts on the declared key unchanged, so a
 * node body that maintains the same counter itself writes the same key with the same
 * value.
 */
export function loopCounterKey(counterKey: string, branchKey: string | null): string {
  return branchKey === null ? counterKey : `${counterKey}.${branchKey}`;
}

// ── State snapshots ─────────────────────────────────────────────────

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  for (const member of Object.values(value as Record<string, unknown>)) deepFreeze(member);
  return Object.freeze(value);
}

/**
 * The state a node body sees: its own deep CLONE, deeply frozen.
 *
 * Cloned so two branches running in the same superstep cannot reach each other through a
 * shared array, and frozen so an attempt to mutate throws in the node rather than
 * corrupting the batch. Nothing a node does to this object can be observed by anyone: the
 * only way state changes is `Command.update`, through the commit boundary.
 */
export function isolatedSnapshot(state: OverallState): Readonly<OverallState> {
  return deepFreeze(JSON.parse(JSON.stringify(state)) as OverallState);
}

// ── Region and fan-out analysis ─────────────────────────────────────

function reachableFrom(spec: TopologySpec, includeFanout: boolean): Set<string> {
  const outgoing = new Map<string, string[]>();
  for (const edge of spec.edges) {
    if (!includeFanout && edge.kind === "fanout") continue;
    if (edge.to === TERMINAL_ENDPOINT) continue;
    const list = outgoing.get(edge.from);
    if (list) list.push(edge.to);
    else outgoing.set(edge.from, [edge.to]);
  }
  const seen = new Set<string>();
  const stack = [spec.entry];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of outgoing.get(id) ?? []) stack.push(next);
  }
  return seen;
}

/**
 * The nodes that exist only inside a fan-out — reachable from the entry, but not without
 * traversing a fan-out edge.
 *
 * The same derivation the validator uses for `NonAssociativeReducerUnderFanOut`, restated
 * here rather than imported: the topology layer is forbidden by a module-graph boundary
 * from being imported by the runtime's executors, and duplicating six lines is cheaper
 * than widening that boundary.
 */
export function computeFanOutRegion(spec: TopologySpec): Set<string> {
  const withFanOut = reachableFrom(spec, true);
  const withoutFanOut = reachableFrom(spec, false);
  const region = new Set<string>();
  for (const id of withFanOut) {
    if (!withoutFanOut.has(id)) region.add(id);
  }
  return region;
}

// ── Effect gates ────────────────────────────────────────────────────

/**
 * Which HITL gate authorises each node, read off the ARTIFACT.
 *
 * A node carrying `effects: ["git"]` or `["process-exec"]` may execute only when a node
 * with a `hitl` policy has a DECLARED EDGE into it — the inbound-edge rule ADR-6 names.
 * Derived here rather than configured, so a topology diff that removes the gate edge is
 * visibly a change to what may run unattended.
 *
 * `sandbox-exec` is deliberately NOT in `GATED_EFFECTS`: it is the project's own configured
 * verification commands running through `SandboxRunner` under an allowlist, not the deploy
 * path, and demanding a human approval before every typecheck would empty the gate of
 * meaning. What constrains it is the runner and the ESLint spawner boundary on
 * `src/pge/nodes/**`, not this function.
 */
export function computeEffectGates(spec: TopologySpec): Map<string, EffectGate> {
  const byId = new Map(spec.nodes.map((node) => [node.id, node] as const));
  const gates = new Map<string, EffectGate>();
  for (const edge of spec.edges) {
    const from = byId.get(edge.from);
    if (from?.hitl === undefined) continue;
    gates.set(edge.to, {
      checkpointId: from.hitl.checkpointId,
      gateNodeId: from.id,
      onReject: from.hitl.onReject ?? null,
    });
  }
  return gates;
}

// ── Branch facts ────────────────────────────────────────────────────

const BranchFactsSchema = z.object({
  contractId: z.string().min(1),
  dependsOn: z.array(z.string()).default([]),
  estimatedFiles: z.array(z.string()).default([]),
});

interface BranchFacts {
  contractId?: string;
  dependsOn: string[];
  files: string[];
}

/**
 * The scheduling facts a fan-out send carries.
 *
 * Read off `SprintContract` — `dependsOn` and `estimatedFiles` are the only declared
 * dependency and file information that exists anywhere in the repository. An input that
 * is not a contract contributes no facts, which at cap 1 changes nothing and above cap 1
 * makes the branch conflict with everything.
 */
export function branchFactsOf(input: unknown): BranchFacts {
  const parsed = BranchFactsSchema.safeParse(input);
  if (!parsed.success) return { dependsOn: [], files: [] };
  return {
    contractId: parsed.data.contractId,
    dependsOn: parsed.data.dependsOn,
    files: parsed.data.estimatedFiles,
  };
}

// ── Routing resolution ──────────────────────────────────────────────

type Destination =
  | { kind: "single"; nodeId: string }
  | { kind: "terminal" }
  | { kind: "fanout"; nodeId: string; sends: ReadonlyArray<{ branchKey: string; input?: unknown }> };

/**
 * A destination request, from either side of the Zod boundary.
 *
 * `Goto` declares `sends[].input` as required `unknown`; parsing the same shape with Zod
 * makes it optional, because `unknown` admits `undefined`. Both are legal requests, so the
 * resolver accepts the weaker one and every caller fits.
 */
export interface ResolvableGoto {
  readonly kind: Goto["kind"];
  readonly label?: string;
  readonly node?: string;
  readonly sends?: ReadonlyArray<{ branchKey: string; input?: unknown }>;
}

function declaredLabels(node: NodeSpec): string[] {
  return node.kind === "router" ? node.targets.map((t) => t.label) : [];
}

/**
 * Where a `Goto` sends control, resolved against the ARTIFACT.
 *
 * Every branch below reads the compiled adjacency or the node's declared targets — never
 * a table built inside the interpreter — so what a topology diff shows is what the
 * runtime does.
 */
export function resolveDestination(
  graph: CompiledGraph,
  node: CompiledNode,
  goto: ResolvableGoto,
): Destination {
  const edges = graph.adjacency.get(node.spec.id) ?? [];

  if (goto.kind === "label") {
    const label = goto.label;
    if (label === undefined) {
      throw new UndeclaredRouteLabelError(node.spec.id, "<missing>", declaredLabels(node.spec));
    }
    const edge = edges.find((e) => e.label === label);
    if (edge) {
      return edge.to === TERMINAL_ENDPOINT ? { kind: "terminal" } : { kind: "single", nodeId: edge.to };
    }
    const target =
      node.spec.kind === "router" ? node.spec.targets.find((t) => t.label === label) : undefined;
    if (!target) {
      throw new UndeclaredRouteLabelError(node.spec.id, label, declaredLabels(node.spec));
    }
    return target.to === TERMINAL_ENDPOINT
      ? { kind: "terminal" }
      : { kind: "single", nodeId: target.to };
  }

  if (goto.kind === "node") {
    const target = goto.node;
    if (target === undefined) {
      throw new UnknownNodeInScopeError(node.spec.id, "<missing>", node.spec.subgraph);
    }
    if (target === TERMINAL_ENDPOINT) return { kind: "terminal" };
    const viaEdge = edges.some((e) => e.to === target);
    const inRegion = graph.nodes.has(target)
      ? (graph.nodes.get(target) as CompiledNode).spec.subgraph === node.spec.subgraph
      : false;
    if (!viaEdge && !inRegion) {
      throw new UnknownNodeInScopeError(node.spec.id, target, node.spec.subgraph);
    }
    return { kind: "single", nodeId: target };
  }

  if (goto.kind === "parent") {
    if (node.spec.subgraph === null) throw new ParentScopeUnavailableError(node.spec.id);
    const supervisor = graph.spec.defaults.supervisorNodeId;
    if (!graph.nodes.has(supervisor)) {
      throw new UnknownNodeInScopeError(node.spec.id, supervisor, node.spec.subgraph);
    }
    return { kind: "single", nodeId: supervisor };
  }

  const fanoutEdges = edges.filter((e) => e.kind === "fanout");
  if (fanoutEdges.length !== 1) {
    throw new FanOutNotDispatchableError(
      node.spec.id,
      `the artifact declares ${String(fanoutEdges.length)} fan-out edges from it, and exactly one is required`,
    );
  }
  const sends = goto.sends ?? [];
  if (sends.length === 0) {
    throw new FanOutNotDispatchableError(node.spec.id, "it carries no sends");
  }
  const seen = new Set<string>();
  for (const send of sends) {
    if (seen.has(send.branchKey)) {
      throw new FanOutNotDispatchableError(
        node.spec.id,
        `branch key "${send.branchKey}" is sent twice, and two branches sharing a key cannot be told apart at the join`,
      );
    }
    seen.add(send.branchKey);
  }
  return { kind: "fanout", nodeId: fanoutEdges[0].to, sends };
}

// ── Lazy archive handle ─────────────────────────────────────────────

/**
 * A per-task archive handle that creates nothing until a node actually writes.
 *
 * `dir` is derived from the layout function rather than from an opened handle, so a node
 * that only wants to name its archive directory does not cause one to exist. A run whose
 * nodes never archive leaves no `.bober/archive/` tree at all.
 */
function lazyArchiveHandle(
  writer: ArchiveWriter,
  projectRoot: string,
  runId: string,
  nodeId: string,
  branchKey: string | null,
): NodeContext["archive"] {
  let opened: Promise<NodeContext["archive"]> | null = null;
  const open = (): Promise<NodeContext["archive"]> => {
    opened ??= writer.open(runId, nodeId, branchKey);
    return opened;
  };
  return {
    dir: archiveNodeDir(projectRoot, runId, nodeId, branchKey),
    writeSnapshot: async (value) => (await open()).writeSnapshot(value),
    appendStdout: async (chunk) => (await open()).appendStdout(chunk),
    writeOutputs: async (value) => (await open()).writeOutputs(value),
    seal: async () => (await open()).seal(),
  };
}

// ── Execution ───────────────────────────────────────────────────────

interface TaskOutcome {
  readonly task: PendingTask;
  readonly command: ParsedCommand;
  readonly destination: Destination;
  readonly output: unknown;
  readonly privKeys: string[];
}

function errorClassOf(reason: unknown): string {
  return reason instanceof Error ? reason.name : typeof reason;
}

function errorMessageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * The identity a commit-boundary rejection names, so a refused update can be traced back
 * to the span of the task that produced it. Built by serialising the pair rather than by
 * concatenating it, so no node id containing the separator can collide with another pair.
 */
function refusalKeyOf(nodeId: string, branchKey: string | null): string {
  return JSON.stringify([nodeId, branchKey]);
}

function verdictFrom(state: OverallState, failures: readonly TaskFailure[]): Exclude<RunVerdict, "pending"> {
  const passed = state.sprintContracts.filter((c) => c.status === "passed").length;
  const total = state.sprintContracts.length;

  // A graph may DECLARE its own verdict, and a terminal node normally does. It may not
  // declare away a failure the INTERPRETER recorded: a task that threw, a frontier that
  // deadlocked, or an update the commit boundary refused are facts about the run that no
  // node body observed and therefore none can overwrite. A node whose 5 MB write was
  // dropped still reaches a terminal that sees every contract passed, so without this
  // downgrade a run that lost work reports "success".
  if (state.verdict !== "pending") {
    if (state.verdict === "success" && failures.length > 0) return passed > 0 ? "partial" : "failed";
    // ...and it may not declare away the work that DID land, either. A run whose failure
    // terminal fired while some branches completed is `partial`: reporting it `failed`
    // tells an operator to redo work that is already committed, and a caller that has to
    // reconcile "verdict failed" with "seven contracts passed" reconciles it by ignoring
    // one of them. `success` is unreachable from here — every path below either sees a
    // recorded failure or sees none.
    if (state.verdict === "failed" && passed > 0) return "partial";
    return state.verdict;
  }

  if (failures.length === 0 && passed > 0 && passed === total) return "success";
  if (passed > 0) return "partial";
  return "failed";
}

// ── Interpreter ─────────────────────────────────────────────────────

/**
 * Everything the superstep loop needs in order to start — from the beginning, or from a
 * checkpoint written by a process that has since exited.
 *
 * `run` and `resume` differ ONLY in how they build this seed. That is deliberate: a resume
 * path that re-implemented the loop would be a SECOND set of barrier, commit and routing
 * semantics, and ADR-1's stated risk is precisely that those fail silently.
 */
interface LoopSeed {
  readonly state: OverallState;
  readonly pending: readonly PendingTask[];
  readonly done: Set<string>;
  readonly activeBranches: Set<string>;
  readonly joinBuffer: Map<string, Array<{ branchKey: string; value: unknown }>>;
  readonly superstep: number;
  readonly failures: TaskFailure[];
  readonly deadlocked: boolean;
  /** The phase the previous checkpoint saw, so `durability: "exit"` can spot a boundary. */
  readonly lastPhase: Phase;
  readonly interrupts: InterruptController;
}

/**
 * A task refused at the boundary.
 *
 * It did not execute, so it produced no output and contributed no channel update. All the
 * routing pass needs from it is where control goes instead; the span and the failure are
 * recorded at the point of refusal, where the outcome that caused them is still in hand.
 */
interface BlockedTask {
  readonly task: PendingTask;
  /** The gate's `onReject`, or `null` to drop the task and release its branch. */
  readonly target: string | null;
}

/**
 * A branch that spent every attempt {@link RunContext.retry} allowed.
 *
 * Carries `branchKey`, `contractId`, `attempts` and `errorClass` because those are the
 * four facts the graceful-failure terminal needs in order to NAME the branch in its
 * artifact without reading the trace file back.
 */
interface ExhaustedBranch {
  readonly branchKey: string;
  readonly contractId?: string;
  readonly nodeId: string;
  readonly attempts: number;
  readonly errorClass: string;
  readonly message: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function executeLoop(
  graph: CompiledGraph,
  seed: LoopSeed,
  ctx: RunContext,
): Promise<GraphRunResult> {
  const spec = graph.spec;
  const fanOutRegion = computeFanOutRegion(spec);
  const effectGates = computeEffectGates(spec);
  const cap = Math.max(1, Math.trunc(ctx.concurrency ?? spec.defaults.concurrency));
  const maxSupersteps = ctx.maxSupersteps ?? DEFAULT_MAX_SUPERSTEPS;
  const durability: Durability = ctx.durability ?? spec.defaults.durability;
  const interrupts = seed.interrupts;
  const startedAtMs = ctx.clock.nowMs();

  let state = seed.state;
  let pending: PendingTask[] = [...seed.pending];
  let lastPhase: Phase = seed.lastPhase;

  const done = seed.done;
  const activeBranches = seed.activeBranches;
  const joinBuffer = seed.joinBuffer;
  const commits: CommitRecord[] = [];
  const failures: TaskFailure[] = seed.failures;
  let superstep = seed.superstep;
  let deadlocked = seed.deadlocked;

  const nodeOf = (id: string): CompiledNode => {
    const compiled = graph.nodes.get(id);
    if (!compiled) throw new UnknownNodeInScopeError("<interpreter>", id, null);
    return compiled;
  };

  // ── LOOP BOUNDS ARE A LOAD-TIME PRECONDITION ──
  //
  // Checked once, before the first node body, and only for a graph that actually declares
  // a bounded cycle: a counter channel that is not a per-key maximum makes every bound in
  // the artifact unenforceable the moment a superstep is replayed, and discovering that at
  // the bound — after a crash, on the retry — is discovering it too late.
  const countersChannel = graph.channels.get(COUNTER_CHANNEL);
  if (spec.nodes.some((node) => node.loop !== undefined) && countersChannel !== undefined) {
    if (countersChannel.reducer.id !== COUNTER_REDUCER_ID) {
      throw new NonIdempotentCounterChannelError(COUNTER_CHANNEL, countersChannel.reducer.id);
    }
  }
  const countersAreEnforceable = countersChannel !== undefined;

  /**
   * Persist the run.
   *
   * `superstep` is the index this snapshot describes and `nextSuperstep` is the index the
   * restored frontier runs at. They differ by one for a post-commit checkpoint and are
   * EQUAL for an interrupt checkpoint, because an interrupt fires before the superstep
   * executes and resuming must re-enter that same superstep — not the one after it.
   */
  const persist = async (args: {
    superstep: number;
    nextSuperstep: number;
    frontier: readonly PendingTask[];
    interrupt: InterruptRecord | null;
  }): Promise<CheckpointRef> => {
    const checkpointer = ctx.checkpointer;
    if (checkpointer === undefined) throw new CheckpointerRequiredError("checkpoint");
    const checkpoint: Checkpoint = {
      formatVersion: CHECKPOINT_FORMAT_VERSION,
      runId: ctx.runId,
      superstep: args.superstep,
      nextSuperstep: args.nextSuperstep,
      graphId: spec.graphId,
      graphVersion: spec.graphVersion,
      checksum: spec.checksum,
      createdAt: ctx.clock.nowIso(),
      state,
      pending: [...args.frontier],
      completedTaskKeys: [...done].sort(),
      interrupt: args.interrupt,
      decisions: { ...interrupts.decisions() },
      activeBranches: [...activeBranches].sort(),
      joinBuffer: [...joinBuffer.keys()]
        .sort()
        .map((nodeId) => ({ nodeId, entries: joinBuffer.get(nodeId) ?? [] })),
      failures: [...failures],
      deadlocked,
    };
    return checkpointer.put(checkpoint);
  };

  /** A `serialized` span, so a deferral is a recorded fact rather than an absence. */
  const recordDeferral = (deferred: DeferredTask, reason: AdmissionReason): void => {
    const node = nodeOf(deferred.task.nodeId);
    const handle = ctx.trace.begin({
      nodeId: node.spec.id,
      kind: node.spec.kind,
      phase: state.currentPhase,
      branchKey: deferred.task.branchKey,
      superstep,
    });
    handle.end({
      status: "serialized",
      serializedReason: reason,
      blockedBy: deferred.blockedBy,
    });
  };

  const executeTask = async (task: PendingTask, span: SpanHandle): Promise<TaskOutcome> => {
    const node = nodeOf(task.nodeId);
    const priv = new Map<string, unknown>();
    const nodeCtx: NodeContext = {
      runId: ctx.runId,
      projectRoot: ctx.projectRoot,
      config: ctx.config,
      nodeId: node.spec.id,
      branchKey: task.branchKey,
      superstep,
      spanId: span.spanId,
      priv,
      declaredEffects: node.spec.effects,
      clock: ctx.clock,
      signal: ctx.signal,
      effects: ctx.services.effects,
      scratch: ctx.services.scratch,
      archive: lazyArchiveHandle(
        ctx.services.archive,
        ctx.projectRoot,
        ctx.runId,
        node.spec.id,
        task.branchKey,
      ),
      cache: ctx.services.cache,
      trace: ctx.trace,
      ledger: ctx.ledger,
      prompts: ctx.services.prompts,
      models: ctx.services.models,
    };

    const input = node.impl.inputSchema.parse(task.input);

    // ── RETRY WRAPS THE HANDLER CALL, AND NOTHING ELSE ──
    //
    // Not the schema parses on either side of it and not `resolveDestination` below: an
    // input that does not match its port schema, an output that does not match its own, or
    // a `goto` the artifact does not authorise are all DETERMINISTIC defects of this node,
    // and retrying them spends the branch's whole budget on something that cannot succeed.
    //
    // And it is INSIDE the `Scheduler.settle` thunk, which is what makes two properties
    // true at once. One thunk is one task is one branch, so "retry the failed branch only"
    // needs no enforcement — there is nothing else in scope to retry. And the interrupt
    // gate ran before any thunk was dispatched (ADR-6), so a transient 503 retried three
    // times does not ask a human for approval three times.
    const invoke = (): Promise<unknown> =>
      Promise.resolve(node.impl.handler(input, isolatedSnapshot(state), nodeCtx));
    const returned = (ctx.retry === undefined
      ? await invoke()
      : await ctx.retry.run(invoke, {
          nodeId: node.spec.id,
          branchKey: task.branchKey,
          taskKey: task.taskKey,
        })) as Command<Partial<OverallState>> & { output: unknown };
    const command = CommandSchema.parse({
      update: returned.update,
      goto: returned.goto,
      phase: returned.phase,
    });
    const output = node.impl.outputSchema.parse(returned.output);

    // Resolved HERE, inside the task, and deliberately not in the routing pass below:
    // a node that named a destination the artifact does not authorise has returned an
    // invalid value, which is that NODE's failure. Resolving it after the barrier
    // would make one node's bad goto reject the whole superstep and take its siblings'
    // committed work with it.
    const destination = resolveDestination(graph, node, command.goto);

    // `priv` dies here. It was never a channel, was never handed to the boundary, and
    // the only trace of it that survives is the key list recorded on the span.
    return { task, command, destination, output, privKeys: [...priv.keys()].sort() };
  };

  /**
   * Where a task goes once its node's DECLARED loop bound has had its say.
   *
   * Read off the artifact — `loop.counterKey`, `loop.maxIterations`, `loop.onExhausted` —
   * and evaluated against the COMMITTED counter, which already includes this execution's
   * own increment. So the check is "this node has now run `maxIterations` times", not "it
   * is about to", and a cycle can be entered exactly as many times as the topology says
   * and no more.
   *
   * A node already heading for the terminal or for its own `onExhausted` target is left
   * alone: it is leaving the cycle of its own accord, and overriding a decision that
   * agrees with us would put a spurious failure in the trace. Everything else is
   * redirected, and the redirection is RECORDED — a `failed` span carrying
   * {@link LOOP_EXHAUSTED_ERROR_CLASS} and the counter key that ran out, plus a
   * {@link TaskFailure}, because a run that silently stopped iterating is a run whose
   * result nobody can account for.
   */
  const boundedDestination = (result: TaskOutcome): Destination => {
    const node = nodeOf(result.task.nodeId);
    const loop = node.spec.loop;
    if (loop === undefined || !countersAreEnforceable) return result.destination;

    const key = loopCounterKey(loop.counterKey, result.task.branchKey);
    const taken = state.counters[key] ?? 0;
    if (taken < loop.maxIterations) return result.destination;

    const exit: Destination =
      loop.onExhausted === TERMINAL_ENDPOINT || !graph.nodes.has(loop.onExhausted)
        ? { kind: "terminal" }
        : { kind: "single", nodeId: loop.onExhausted };
    if (
      result.destination.kind === "terminal" ||
      (result.destination.kind === "single" &&
        exit.kind === "single" &&
        result.destination.nodeId === exit.nodeId)
    ) {
      return result.destination;
    }

    const handle = ctx.trace.begin({
      nodeId: node.spec.id,
      kind: node.spec.kind,
      phase: state.currentPhase,
      branchKey: result.task.branchKey,
      superstep,
      inputHash: result.task.taskKey,
    });
    handle.end({
      status: "failed",
      errorClass: LOOP_EXHAUSTED_ERROR_CLASS,
      blockedBy: [key],
    });
    failures.push({
      nodeId: node.spec.id,
      branchKey: result.task.branchKey,
      superstep,
      errorClass: LOOP_EXHAUSTED_ERROR_CLASS,
      message: `loop counter "${key}" reached the declared bound of ${String(loop.maxIterations)}; routing to "${loop.onExhausted}" instead of re-entering the cycle`,
    });
    return exit;
  };

  while (pending.length > 0) {
    if (ctx.signal.aborted) {
      return {
        status: "aborted",
        reason: "AbortSignal",
        state,
        supersteps: superstep,
        commits,
        failures,
      };
    }
    if (superstep >= maxSupersteps) throw new SuperstepLimitExceededError(maxSupersteps);

    const decision = ctx.planner.plan(pending, done, cap);

    // `concurrencyCap` deferrals are backpressure, not a decision about the work: they
    // clear next superstep on their own, and tracing them would make the trace a
    // function of the cap rather than of the graph.
    for (const deferred of decision.defer) {
      if (deferred.reason !== "concurrencyCap") recordDeferral(deferred, deferred.reason);
    }

    if (decision.admit.length === 0) {
      deadlocked = true;
      const blocked = decision.defer[0];
      const node = nodeOf(blocked.task.nodeId);
      const handle = ctx.trace.begin({
        nodeId: node.spec.id,
        kind: node.spec.kind,
        phase: state.currentPhase,
        branchKey: blocked.task.branchKey,
        superstep,
      });
      handle.end({
        status: "failed",
        errorClass: DEADLOCK_ERROR_CLASS,
        blockedBy: blocked.blockedBy,
      });
      failures.push({
        nodeId: node.spec.id,
        branchKey: blocked.task.branchKey,
        superstep,
        errorClass: DEADLOCK_ERROR_CLASS,
        message: `frontier of ${String(pending.length)} task(s) admitted none; blocked by ${blocked.blockedBy.join(", ")}`,
      });
      if (!graph.nodes.has(GRACEFUL_FAILURE_NODE_ID)) break;
      pending = [
        createPendingTask({
          nodeId: GRACEFUL_FAILURE_NODE_ID,
          input: {
            reason: DEADLOCK_ERROR_CLASS,
            blockedBy: [...decision.defer].map((d) => d.task.nodeId).sort(),
          },
        }),
      ];
      superstep += 1;
      continue;
    }

    // ── INTERRUPTS, BEFORE ANY NODE BODY IS ENTERED ──
    //
    // This block runs before `Scheduler.settle` dispatches a single thunk, which is what
    // makes "no node re-runs on resume" a property of the control flow rather than a
    // discipline: a paused superstep executed NOTHING, so there is nothing to re-execute.
    // A blocked node likewise never enters its handler, so a git commit that was refused
    // did not half-happen.
    const admitted: PendingTask[] = [];
    const blockedTasks: BlockedTask[] = [];

    for (const task of decision.admit) {
      const node = nodeOf(task.nodeId);
      const gate = effectGates.get(task.nodeId) ?? null;
      let outcome: CheckpointOutcome;
      try {
        outcome = await interrupts.maybeInterrupt(
          node.spec,
          task.input,
          {
            runId: ctx.runId,
            projectRoot: ctx.projectRoot,
            config: ctx.config,
            superstep,
            branchKeys: task.branchKey === null ? [] : [task.branchKey],
          },
          gate,
        );
      } catch (error) {
        if (!(error instanceof GraphInterrupted)) throw error;
        const handle = ctx.trace.begin({
          nodeId: node.spec.id,
          kind: node.spec.kind,
          phase: state.currentPhase,
          branchKey: task.branchKey,
          superstep,
          inputHash: task.taskKey,
        });
        handle.end({ status: "interrupted", outputHash: task.taskKey });
        // The WHOLE frontier is checkpointed, not just the interrupted task: the tasks
        // that would have run alongside it did not run either, and dropping them would
        // silently prune the graph at the pause.
        const frontier = [...decision.admit, ...decision.defer.map((deferred) => deferred.task)];
        const checkpointRef = await persist({
          superstep,
          nextSuperstep: superstep,
          frontier,
          interrupt: error.record,
        });
        return {
          status: "interrupted",
          checkpointRef,
          pending: error.record,
          state,
          supersteps: superstep,
          commits,
          failures,
        };
      }

      if (isApproved(outcome)) {
        admitted.push(task);
        continue;
      }

      const failClosed = node.spec.hitl === undefined;
      const feedback =
        "approved" in outcome && outcome.approved === false ? outcome.feedback : "";
      const handle = ctx.trace.begin({
        nodeId: node.spec.id,
        kind: node.spec.kind,
        phase: state.currentPhase,
        branchKey: task.branchKey,
        superstep,
        inputHash: task.taskKey,
      });
      handle.end({
        status: "interrupted",
        outputHash: task.taskKey,
        failClosed,
        errorClass: failClosed ? FAIL_CLOSED_ERROR_CLASS : HITL_REJECTED_ERROR_CLASS,
      });
      // A fail-closed block is a RUN failure — the graph asked to do something
      // irreversible and was refused — while a human rejecting a plan is the gate
      // working as designed and routes to `onReject` without downgrading the verdict.
      if (failClosed) {
        failures.push({
          nodeId: node.spec.id,
          branchKey: task.branchKey,
          superstep,
          errorClass: FAIL_CLOSED_ERROR_CLASS,
          message: feedback,
        });
      }
      blockedTasks.push({ task, target: node.spec.hitl?.onReject ?? gate?.onReject ?? null });
    }

    // Spans open in ADMISSION order and close at the barrier in the same order, so the
    // trace is a deterministic record of the superstep rather than a race-order log.
    //
    // ── `span.model` is the binding the node RAN UNDER, resolved here ──
    //
    // A topology names a TIER and never a model, and the tier is resolved to a provider and
    // a model id by `ModelBinder` from the run's own config. Recording the resolved binding
    // on the span is what makes "which model did this node use" answerable from the trace
    // alone — the question sc-13-8 asks of every routing, classification and syntax node.
    // Only a node that DECLARES a tier gets one: a gate or a tool has no model, and
    // defaulting it to the graph's `defaults.modelTier` would put a model on a span that
    // never had one and make the same assertion vacuous in the other direction.
    const handles = admitted.map((task) => {
      const node = nodeOf(task.nodeId);
      const tier = node.spec.modelTier;
      return ctx.trace.begin({
        nodeId: node.spec.id,
        kind: node.spec.kind,
        phase: state.currentPhase,
        branchKey: task.branchKey,
        superstep,
        inputHash: task.taskKey,
        ...(tier === undefined ? {} : { model: ctx.services.models.bind(tier) }),
      });
    });

    const settled = await ctx.scheduler.settle(
      admitted.map((task, index) => () => executeTask(task, handles[index])),
    );

    // ── BARRIER ──
    const batch: ChannelUpdate[] = [];
    const succeeded: TaskOutcome[] = [];
    /**
     * Spans admitted this superstep, held OPEN across the commit.
     *
     * A node does not decide whether its update became state — the boundary does, and
     * it REFUSES an oversized value rather than throwing (see
     * {@link CommitResult.rejected}). A span closed `ok` before that ran would record a
     * success the committed state does not contain. They are collected in admission
     * order and closed below in the same order, which is the order they were opened in.
     */
    const closing: Array<{
      handle: SpanHandle;
      outcome: SpanEnd;
      /** `nodeId\0branchKey`, the identity a rejection names. `null` when the task threw. */
      refusalKey: string | null;
    }> = [];

    /** Branches that spent every attempt this superstep, aggregated for ONE terminal task. */
    const exhausted: ExhaustedBranch[] = [];

    settled.forEach((outcome, index) => {
      const task = admitted[index];
      const handle = handles[index];
      if (outcome.status === "rejected") {
        const errorClass = errorClassOf(outcome.reason);
        const message = errorMessageOf(outcome.reason);
        // `attemptsFor` is what the policy actually SPENT — one for a non-transient error
        // it refused to retry, `maxAttempts` for one it retried to exhaustion — so the
        // number recorded is a fact about this execution rather than the configured cap.
        const attempts = ctx.retry === undefined ? 1 : Math.max(1, ctx.retry.attemptsFor(task.taskKey));
        closing.push({
          handle,
          outcome: { status: "failed", errorClass },
          refusalKey: null,
        });
        failures.push({
          nodeId: task.nodeId,
          branchKey: task.branchKey,
          superstep,
          errorClass,
          message,
        });
        // The branch's own record, written to the branch's OWN key. `lastWriteWinsByKey`
        // is sound over `branchStatus` precisely because the key domains are disjoint, so
        // eight branches failing in one superstep merge into one write with eight keys and
        // no branch can overwrite another's attempt count or error class.
        if (
          ctx.retry !== undefined &&
          task.branchKey !== null &&
          graph.channels.has(BRANCH_STATUS_CHANNEL)
        ) {
          batch.push({
            channel: BRANCH_STATUS_CHANNEL,
            nodeId: task.nodeId,
            branchKey: task.branchKey,
            value: { [task.branchKey]: { state: "failed", attempts, errorClass } },
          });
        }
        if (ctx.retry?.onExhausted === "graceful" && task.branchKey !== null) {
          exhausted.push({
            branchKey: task.branchKey,
            ...(task.contractId === undefined ? {} : { contractId: task.contractId }),
            nodeId: task.nodeId,
            attempts,
            errorClass,
            message,
          });
        }
        // A failed branch can contribute nothing, so it must stop holding the join
        // open — otherwise one rejecting branch deadlocks every sibling that finished.
        if (task.branchKey !== null) activeBranches.delete(task.branchKey);
        return;
      }
      const result = outcome.value;
      succeeded.push(result);

      // ── THE LOOP COUNTER IS THE INTERPRETER'S WRITE, CARRIED ON THE NODE'S OWN ──
      //
      // A bound that only advances when the node body remembers to advance it is not a
      // bound: the body is the thing whose defect the bound exists to contain. So the
      // increment is produced here, from the COMMITTED value plus one, and folded into
      // the node's own `counters` update when it has one.
      //
      // Folded rather than appended because `batchSizePerChannel` is asserted elsewhere as
      // a property of the GRAPH — how many writers a channel had this superstep. A second
      // update for the same node and channel would make that number a function of the
      // runtime instead. `maxNumber` makes the fold safe either way: the node's own value
      // and the interpreter's join to their maximum, and a replayed superstep re-derives
      // the same `prev + 1` from the same `prev`, so it can neither exhaust early nor gain
      // an iteration.
      const loop = nodeOf(task.nodeId).spec.loop;
      const counterKey =
        loop === undefined || !countersAreEnforceable
          ? null
          : loopCounterKey(loop.counterKey, task.branchKey);
      const counterValue = counterKey === null ? 0 : (state.counters[counterKey] ?? 0) + 1;
      let counterCarried = counterKey === null;

      for (const [channel, value] of Object.entries(result.command.update ?? {})) {
        if (value === undefined) continue;
        if (counterKey !== null && channel === COUNTER_CHANNEL && isPlainRecord(value)) {
          batch.push({
            channel,
            nodeId: task.nodeId,
            branchKey: task.branchKey,
            value: { ...value, [counterKey]: counterValue },
          });
          counterCarried = true;
          continue;
        }
        batch.push({ channel, nodeId: task.nodeId, branchKey: task.branchKey, value });
      }
      if (!counterCarried && counterKey !== null) {
        batch.push({
          channel: COUNTER_CHANNEL,
          nodeId: task.nodeId,
          branchKey: task.branchKey,
          value: { [counterKey]: counterValue },
        });
      }
      if (result.command.phase !== undefined) {
        batch.push({
          channel: "currentPhase",
          nodeId: task.nodeId,
          branchKey: task.branchKey,
          value: result.command.phase satisfies Phase,
        });
      }
      closing.push({
        handle,
        outcome: {
          status: "ok",
          outputHash: result.task.taskKey,
          route: { label: result.command.goto.label, goto: result.command.goto },
          privKeys: result.privKeys,
        },
        refusalKey: refusalKeyOf(task.nodeId, task.branchKey),
      });
    });

    // ── COMMIT ONCE ──
    const committed = await ctx.commit.commit(graph, state, batch, {
      runId: ctx.runId,
      projectRoot: ctx.projectRoot,
      config: ctx.config,
      superstep,
      startedAtMs,
    });
    state = committed.state;
    commits.push({
      superstep,
      writesPerChannel: committed.writesPerChannel,
      batchSizePerChannel: committed.batchSizePerChannel,
      rejected: committed.rejected,
      artifactWrites: committed.artifactWrites,
    });

    // ── CLOSE THE SPANS, WITH THE COMMIT'S VERDICT ──
    //
    // A refused update is LOST WORK: the value never reached the reducer and is in no
    // artifact, so the node that produced it did not do what its return value claimed.
    // Recording it as a `TaskFailure` is what stops `verdictFrom` from calling the run
    // a success, and closing the producing span `failed` is what puts it in the trace.
    // Without both, an oversized write vanishes with nothing anywhere recording it.
    const refusedBy = new Map<string, StateBloatError[]>();
    for (const rejection of committed.rejected) {
      const key = refusalKeyOf(rejection.nodeId, rejection.branchKey);
      const bucket = refusedBy.get(key);
      if (bucket) bucket.push(rejection);
      else refusedBy.set(key, [rejection]);
      failures.push({
        nodeId: rejection.nodeId,
        branchKey: rejection.branchKey,
        superstep,
        errorClass: rejection.name,
        message: rejection.message,
      });
    }

    for (const entry of closing) {
      const refused = entry.refusalKey === null ? undefined : refusedBy.get(entry.refusalKey);
      entry.handle.end(
        refused === undefined
          ? entry.outcome
          : { ...entry.outcome, status: "failed", errorClass: refused[0].name },
      );
    }

    // ── THE SPEND CEILING, CHECKED AT THE BARRIER ──
    //
    // After the commit and after the spans are closed, so a run that stops here still has a
    // complete account of the superstep that spent the money: the state it produced is
    // durable and every span it opened is on disk.
    //
    // It ABORTS. `BudgetExceededError` is thrown out of the run loop and, because
    // `PgeEngine.run` re-throws it unchanged, reaches the caller as the CLASS the ledger
    // threw with its `kind` intact. The run is deliberately not finalized: a run that
    // stopped because it ran out of money did not complete, and a completion marker would
    // say it did.
    if (ctx.budgetCeilingUsd !== undefined) {
      ctx.ledger.assertWithinCeiling(ctx.budgetCeilingUsd);
    }

    // ── ROUTE ──
    const next: PendingTask[] = [];

    /**
     * Enqueue a task, and STOP counting its key as completed.
     *
     * `taskKey` is `sha256(nodeId + branchKey + inputHash)`, so a bounded rework cycle
     * re-enters a node with a key it already carried once. Keeping that key in `done`
     * would make the resume-time skip refuse a legitimate loop iteration, so `done` means
     * "committed and NOT currently pending" — which is exactly the set a resume may skip.
     */
    const enqueue = (task: PendingTask): void => {
      done.delete(task.taskKey);
      next.push(task);
    };

    for (const deferred of decision.defer) enqueue(deferred.task);

    for (const result of succeeded) {
      const task = result.task;
      done.add(task.taskKey);
      const destination = boundedDestination(result);

      if (destination.kind === "terminal") {
        if (task.branchKey !== null) activeBranches.delete(task.branchKey);
        continue;
      }

      if (destination.kind === "fanout") {
        for (const send of destination.sends) {
          const facts = branchFactsOf(send.input);
          activeBranches.add(send.branchKey);
          enqueue(
            createPendingTask({
              nodeId: destination.nodeId,
              branchKey: send.branchKey,
              input: send.input,
              contractId: facts.contractId,
              dependsOn: facts.dependsOn,
              files: facts.files,
            }),
          );
        }
        continue;
      }

      const leavingFanOut =
        task.branchKey !== null &&
        fanOutRegion.has(task.nodeId) &&
        !fanOutRegion.has(destination.nodeId);

      if (leavingFanOut) {
        const bucket = joinBuffer.get(destination.nodeId) ?? [];
        bucket.push({ branchKey: task.branchKey as string, value: result.output });
        joinBuffer.set(destination.nodeId, bucket);
        activeBranches.delete(task.branchKey as string);
        // The branch's contract has now COMMITTED: everything it wrote went through
        // the boundary above. Only here does a dependent branch become admissible.
        if (task.contractId !== undefined) done.add(task.contractId);
        continue;
      }

      enqueue(
        createPendingTask({
          nodeId: destination.nodeId,
          branchKey: task.branchKey,
          input: result.output,
          contractId: task.contractId,
          dependsOn: task.dependsOn,
          files: task.files,
        }),
      );
    }

    // ── ROUTE THE BLOCKED ──
    //
    // A blocked task did not execute, so it produced no output: its `onReject` successor
    // is handed the blocked task's own INPUT, which is the only value that exists.
    for (const blocked of blockedTasks) {
      const task = blocked.task;
      done.delete(task.taskKey);
      const target = blocked.target;
      if (target === null || target === TERMINAL_ENDPOINT || !graph.nodes.has(target)) {
        if (task.branchKey !== null) activeBranches.delete(task.branchKey);
        continue;
      }
      enqueue(
        createPendingTask({
          nodeId: target,
          branchKey: task.branchKey,
          input: task.input,
          contractId: task.contractId,
          dependsOn: task.dependsOn,
          files: task.files,
        }),
      );
    }

    // ── ROUTE THE EXHAUSTED ──
    //
    // ONE terminal task per superstep, however many branches spent their attempts in it.
    // The graceful-failure terminal is the run's single account of why it could not
    // proceed, not a per-branch notification, and N of them would race to write one
    // artifact — so the branches are aggregated into one input, sorted by branch key so
    // the terminal's own output does not depend on which branch rejected first.
    //
    // Built directly with `createPendingTask` rather than resolved, exactly as the
    // deadlock path builds its own: a fan-out branch has no declared edge to a root-scope
    // terminal and does not share its region, so `resolveDestination` would refuse the hop
    // — correctly, because nothing in the artifact authorises it. The branch was already
    // released from `activeBranches` at the barrier, so its siblings' join still fires.
    if (exhausted.length > 0 && graph.nodes.has(GRACEFUL_FAILURE_NODE_ID)) {
      enqueue(
        createPendingTask({
          nodeId: GRACEFUL_FAILURE_NODE_ID,
          input: {
            reason: RETRIES_EXHAUSTED_ERROR_CLASS,
            superstep,
            branches: [...exhausted].sort((a, b) =>
              a.branchKey < b.branchKey ? -1 : a.branchKey > b.branchKey ? 1 : 0,
            ),
          },
        }),
      );
    }

    // ── JOIN ──
    //
    // Fires only when the LAST branch has left the fan-out, as ONE task per join
    // target whose input is the branch results sorted by branch key. That sort is the
    // whole barrier guarantee: the stage after a fan-out cannot tell which branch
    // finished first, so cap 1 and cap 8 hand it the same value.
    if (activeBranches.size === 0 && joinBuffer.size > 0) {
      for (const nodeId of [...joinBuffer.keys()].sort()) {
        const results = (joinBuffer.get(nodeId) as Array<{ branchKey: string; value: unknown }>)
          .slice()
          .sort((a, b) => (a.branchKey < b.branchKey ? -1 : a.branchKey > b.branchKey ? 1 : 0));
        enqueue(createPendingTask({ nodeId, input: { fanIn: results } }));
      }
      joinBuffer.clear();
    }

    // ── CHECKPOINT ──
    //
    // AFTER the commit and AFTER routing, so `state` and `pending` are consistent: a
    // checkpoint written between them would restore a frontier that does not match the
    // state it is supposed to run against. `superstep` durability writes one per
    // superstep; `exit` writes only where the phase changed or the run ended, trading
    // resume granularity for one write per phase.
    if (ctx.checkpointer !== undefined) {
      const phaseChanged = state.currentPhase !== lastPhase;
      if (durability === "superstep" || phaseChanged || next.length === 0) {
        await persist({
          superstep,
          nextSuperstep: superstep + 1,
          frontier: next,
          interrupt: null,
        });
      }
      lastPhase = state.currentPhase;
    }

    pending = next;
    superstep += 1;
  }

  return {
    status: "completed",
    state,
    verdict: verdictFrom(state, failures),
    supersteps: superstep,
    commits,
    failures,
    deadlocked,
  };
}

export function createGraphInterpreter(): GraphInterpreter {
  return {
    async run(graph, init, ctx): Promise<GraphRunResult> {
      const state = OverallStateSchema.parse(init);
      // Before the first node body, and before the first checkpoint: a subgraph that owns
      // its own persistence handle splits the run's state across two stores, and the
      // failure surfaces only at the resume that restores half of it.
      resolveSubgraphCheckpointers(graph.spec, ctx.checkpointer ?? null);

      return executeLoop(
        graph,
        {
          state,
          pending: [
            createPendingTask({
              nodeId: graph.spec.entry,
              input: { featureRequest: state.featureRequest },
            }),
          ],
          done: new Set<string>(),
          activeBranches: new Set<string>(),
          joinBuffer: new Map<string, Array<{ branchKey: string; value: unknown }>>(),
          superstep: 0,
          failures: [],
          deadlocked: false,
          lastPhase: state.currentPhase,
          interrupts: ctx.interrupts ?? createInterruptController(),
        },
        ctx,
      );
    },

    async resume(graph, ref, resumeValue, ctx): Promise<GraphRunResult> {
      const checkpointer = ctx.checkpointer;
      if (checkpointer === undefined) throw new CheckpointerRequiredError("resume");
      resolveSubgraphCheckpointers(graph.spec, checkpointer);

      let checkpoint = await checkpointer.get(ref);
      // Graph identity BEFORE anything else. Task keys are hashes of node ids, so
      // replaying them into a different artifact would skip and dispatch essentially at
      // random — a loud failure here is the only safe outcome.
      assertCheckpointMatchesGraph(checkpoint, graph.spec);

      const interrupts = ctx.interrupts ?? createInterruptController();
      interrupts.restore(checkpoint.decisions);
      if (checkpoint.interrupt !== null) {
        checkpoint = interrupts.applyResume(checkpoint, resumeValue);
      }

      const done = new Set<string>(checkpoint.completedTaskKeys);

      // ── SKIP BEFORE DISPATCH ──
      //
      // Generalises the sprint-number cursor at `workflow/resume-cursor.ts:12` to task
      // keys. Filtered HERE, off the frontier, rather than checked inside the task body:
      // a task removed before `plan` is never admitted, never opens a span and is never
      // handed to `Scheduler.settle`, so "it did not re-run" is observable as an absence
      // of a DISPATCH rather than as an early return from an execution.
      const pending: PendingTask[] = [];
      for (const task of checkpoint.pending) {
        if (!done.has(task.taskKey)) {
          pending.push(task);
          continue;
        }
        const node = graph.nodes.get(task.nodeId);
        if (node === undefined) continue;
        const handle = ctx.trace.begin({
          nodeId: node.spec.id,
          kind: node.spec.kind,
          phase: checkpoint.state.currentPhase,
          branchKey: task.branchKey,
          superstep: checkpoint.nextSuperstep,
          inputHash: task.taskKey,
        });
        handle.end({ status: "skipped", outputHash: task.taskKey });
      }

      return executeLoop(
        graph,
        {
          state: checkpoint.state,
          pending,
          done,
          activeBranches: new Set<string>(checkpoint.activeBranches),
          joinBuffer: new Map(
            checkpoint.joinBuffer.map((bucket) => [bucket.nodeId, [...bucket.entries]] as const),
          ),
          superstep: checkpoint.nextSuperstep,
          failures: [...checkpoint.failures],
          deadlocked: checkpoint.deadlocked,
          lastPhase: checkpoint.state.currentPhase,
          interrupts,
        },
        ctx,
      );
    },
  };
}
