import { z } from "zod";

import { TopologySpecSchema } from "../../../contracts/topology.js";
import type { NodeSpec, TopologySpec } from "../../../contracts/topology.js";
import { PlanSpecSchema } from "../../../contracts/spec.js";
import type { PlanSpec } from "../../../contracts/spec.js";
import { SprintContractSchema } from "../../../contracts/sprint-contract.js";
import type { SprintContract } from "../../../contracts/sprint-contract.js";
import { checksumTopology } from "../../topology/canonical.js";
import type { SchemaCatalog } from "../../topology/validate.js";
import { createEffectRegistry } from "../../registry/effects.js";
import { createNodeRegistry } from "../../registry/nodes.js";
import type { NodeImpl, NodeRegistry, PortBinding } from "../../registry/nodes.js";
import { createReducerRegistry } from "../../registry/reducers.js";
import type { Registries } from "../../compile/compiler.js";
import { initialOverallState } from "../../state/overall.js";
import type { GraphMessage, OverallState, SprintVerdict } from "../../state/overall.js";
import { FAILURE_ARTIFACT_FORMAT_VERSION, writeFailureArtifact } from "../graceful-failure.js";

/**
 * The GOLDEN topology and its stub node bodies.
 *
 * A fixture, not a production graph: the sprint's non-goals forbid a single production
 * node body, and every handler here is a deterministic stub with no provider, no
 * filesystem and no clock of its own. What it is NOT is a toy — the shape is the shipped
 * `coding` topology's spine, reduced to the parts the interpreter has to get right:
 *
 *   plan_draft -> supervisor -> fanout_sprints =fanout=> [ sprint subgraph, one branch per
 *   contract ] -> supervisor (fan-in) -> gate_eval_in -> evaluate_global -> supervisor ->
 *   finalize -> END,  with graceful_failure as the failure terminal.
 *
 * Exercised on purpose, because each one is a semantic the interpreter can get silently
 * wrong: a gated subgraph boundary, a bounded rework cycle inside a branch, a router whose
 * outcome labels are declared in the artifact, a runtime-cardinality fan-out, a fan-in
 * whose result must not depend on arrival order, private node state that must not escape,
 * and a scalar single-writer channel beside seven order-invariant collection channels.
 *
 * ── Why `verdict` is a control key and not a channel ──
 *
 * `replaceIfNewer` is a maximum over canonical order, so on a bare enum string it picks
 * the lexicographically greatest value — `"pending"` would beat `"failed"`. That is lawful
 * (it IS a join) and semantically useless, so run verdict is a control-plane key merged by
 * unanimity at the commit boundary rather than a reduced channel. Same reasoning for
 * `currentPhase` and `specId`.
 *
 * ── Why contracts start `in-progress` and not `proposed` ──
 *
 * `appendById` resolves two updates claiming ONE id by canonical order, so the terminal
 * value of a channel member has to BE the canonical-order maximum. `"passed"` sorts after
 * `"in-progress"` and before `"proposed"`, so a `proposed -> passed` transition would
 * silently keep `proposed`. This fixture therefore models the transition the reducer can
 * actually express, and a topology that needs an arbitrary status transition must carry a
 * monotonic discriminator or model the field outside a reduced channel.
 */

// ── Ids ─────────────────────────────────────────────────────────────

export const GOLDEN_GRAPH_ID = "golden";
export const GOLDEN_SPEC_ID = "spec-golden-1";

/** Node ids, so a test never spells one by hand and drifts from the artifact. */
export const GOLDEN_NODES = {
  planDraft: "plan_draft",
  supervisor: "supervisor",
  fanout: "fanout_sprints",
  sprintBody: "sprint_body",
  sprintIn: "gate_sprint_in",
  generate: "sprint_generate",
  evaluate: "sprint_evaluate",
  route: "sprint_route",
  correct: "sprint_correct",
  sprintOut: "gate_sprint_out",
  evalIn: "gate_eval_in",
  evaluateGlobal: "evaluate_global",
  finalize: "finalize",
  gracefulFailure: "graceful_failure",
} as const;

// ── Schema catalog ──────────────────────────────────────────────────

export const GOLDEN_SCHEMA_REFS = [
  "BranchStatus",
  "Counters",
  "GraphMessage",
  "LedgerEntry",
  "PlanSpec",
  "ScratchRef",
  "SprintContract",
  "SprintVerdict",
  "TestAnchors",
] as const;

export function goldenSchemaCatalog(): SchemaCatalog {
  const known = new Set<string>(GOLDEN_SCHEMA_REFS);
  return { has: (ref) => known.has(ref), isAssignable: (from, to) => from === to };
}

/**
 * The Zod schema each `schemaRef` names.
 *
 * `SprintContract` resolves to the REAL contract schema, not a look-alike: the one port
 * pair the fixture declares carries a contract across the fan-out edge, and a fixture that
 * parsed it with `z.unknown()` would prove nothing about port resolution.
 */
export const GOLDEN_SCHEMA_MODULES: ReadonlyMap<string, z.ZodType> = new Map<string, z.ZodType>([
  ["BranchStatus", z.record(z.string(), z.unknown())],
  ["Counters", z.record(z.string(), z.number())],
  ["GraphMessage", z.object({ id: z.string(), seq: z.number() })],
  ["LedgerEntry", z.object({ nodeId: z.string() })],
  ["PlanSpec", PlanSpecSchema],
  ["ScratchRef", z.object({ uri: z.string() })],
  ["SprintContract", SprintContractSchema],
  ["SprintVerdict", z.object({ id: z.string(), seq: z.number() })],
  ["TestAnchors", z.array(z.string())],
]);

// ── Nodes ───────────────────────────────────────────────────────────

const N = GOLDEN_NODES;

const CONTRACT_PORT: PortBinding = { key: "contract", schemaRef: "SprintContract" };

const GOLDEN_NODE_SPECS: NodeSpec[] = [
  {
    id: N.planDraft,
    kind: "llm",
    title: "Draft the plan",
    doc: "Turns the feature request into a plan spec plus its sprint contracts. Sole writer of the scalar spec channel.",
    subgraph: null,
    role: "planner",
    modelTier: "frontier",
    promptRef: "plan/draft",
    inputPorts: [],
    outputPorts: [],
    reads: ["messages"],
    writes: ["spec", "sprintContracts", "messages", "counters"],
    effects: [],
  },
  {
    id: N.supervisor,
    kind: "router",
    title: "Supervisor",
    doc: "Chooses the next region and is the single point control returns to from every subgraph. Bounds the whole graph with supervisorRounds.",
    subgraph: null,
    role: "router",
    modelTier: "light",
    inputPorts: [],
    outputPorts: [],
    reads: ["spec", "sprintContracts", "branchStatus", "evaluations", "counters", "messages"],
    writes: ["counters"],
    effects: [],
    loop: { counterKey: "supervisorRounds", maxIterations: 8, onExhausted: N.gracefulFailure },
    targets: [
      { label: "sprints", to: N.fanout },
      { label: "evaluate", to: N.evalIn },
      { label: "done", to: N.finalize },
    ],
  },
  {
    id: N.fanout,
    kind: "router",
    title: "Sprint fan-out",
    doc: "Emits one branch per admitted contract down a single declared fan-out edge, so branch cardinality is a runtime fact and the topology checksum is invariant to contract count.",
    subgraph: null,
    role: "router",
    modelTier: "light",
    inputPorts: [],
    outputPorts: [{ key: "contract", schemaRef: "SprintContract", required: true }],
    reads: ["sprintContracts", "branchStatus"],
    writes: ["counters"],
    effects: [],
    targets: [
      { label: "dispatch", to: N.sprintBody },
      { label: "drained", to: N.supervisor },
    ],
  },
  {
    id: N.sprintBody,
    kind: "subgraph",
    title: "Sprint subgraph call site",
    doc: "Root-level call site for the sprint subgraph. Reached only through the fan-out edge, which is what puts the whole sprint region inside the fan-out region.",
    subgraph: null,
    role: "utility",
    inputPorts: [{ key: "contract", schemaRef: "SprintContract", required: true }],
    outputPorts: [{ key: "contract", schemaRef: "SprintContract", required: true }],
    reads: [],
    writes: ["branchStatus"],
    effects: [],
    subgraphRef: "sprint",
  },
  {
    id: N.sprintIn,
    kind: "gate",
    title: "Sprint entry gate",
    doc: "Boundary gate admitting one contract branch into the sprint subgraph; an inadmissible contract short-circuits straight to the branch exit.",
    subgraph: "sprint",
    role: "utility",
    inputPorts: [{ key: "contract", schemaRef: "SprintContract", required: true }],
    outputPorts: [],
    reads: ["sprintContracts"],
    writes: [],
    effects: [],
    gate: { check: "contract-admissible", onFail: N.sprintOut },
  },
  {
    id: N.generate,
    kind: "llm",
    title: "Generate the sprint",
    doc: "Produces the branch's work. Writes only order-invariant collection channels, because it runs inside the fan-out region.",
    subgraph: "sprint",
    role: "generator",
    modelTier: "frontier",
    promptRef: "generator/sprint",
    inputPorts: [],
    outputPorts: [],
    reads: ["sprintContracts", "messages", "counters"],
    writes: ["messages", "counters"],
    effects: [],
  },
  {
    id: N.evaluate,
    kind: "llm",
    title: "Evaluate the sprint",
    doc: "Judges one branch's work and records a verdict keyed by contract id, so a re-delivered verdict is a no-op rather than a duplicate row.",
    subgraph: "sprint",
    role: "terminal-evaluator",
    modelTier: "frontier",
    promptRef: "evaluator/sprint",
    inputPorts: [],
    outputPorts: [],
    reads: ["messages", "counters"],
    writes: ["evaluations", "testAnchors"],
    effects: [],
  },
  {
    id: N.route,
    kind: "router",
    title: "Sprint route",
    doc: "Chooses rework or exit for one branch. Bounds the branch's rework cycle with sprintIterations.",
    subgraph: "sprint",
    role: "router",
    modelTier: "light",
    inputPorts: [],
    outputPorts: [],
    reads: ["evaluations", "counters"],
    writes: ["counters"],
    effects: [],
    loop: { counterKey: "sprintIterations", maxIterations: 3, onExhausted: N.sprintOut },
    targets: [
      { label: "retry", to: N.correct },
      { label: "pass", to: N.sprintOut },
    ],
  },
  {
    id: N.correct,
    kind: "llm",
    title: "Correct the sprint",
    doc: "Applies the evaluator's feedback and hands control back to the generator, forming the branch's only cycle.",
    subgraph: "sprint",
    role: "generator",
    modelTier: "frontier",
    promptRef: "generator/correct",
    inputPorts: [],
    outputPorts: [],
    reads: ["evaluations"],
    writes: ["messages"],
    effects: [],
  },
  {
    id: N.sprintOut,
    kind: "gate",
    title: "Sprint exit gate",
    doc: "Boundary gate releasing ONE settled branch out of the sprint subgraph and back to the supervisor; the sprint subgraph's declared exit gate.",
    subgraph: "sprint",
    role: "utility",
    inputPorts: [],
    outputPorts: [],
    reads: ["evaluations"],
    writes: ["branchStatus", "sprintContracts"],
    effects: [],
    gate: { check: "branch-settled", onFail: N.gracefulFailure },
  },
  {
    id: N.evalIn,
    kind: "gate",
    title: "Global evaluation gate",
    doc: "Boundary gate admitting the joined branch results into the global evaluation stage.",
    subgraph: null,
    role: "utility",
    inputPorts: [],
    outputPorts: [],
    reads: ["evaluations"],
    writes: [],
    effects: [],
    gate: { check: "branches-settled", onFail: N.gracefulFailure },
  },
  {
    id: N.evaluateGlobal,
    kind: "llm",
    title: "Evaluate the run",
    doc: "The stage after the fan-in barrier: it must observe every branch exactly once, in an order that does not depend on which branch finished first.",
    subgraph: null,
    role: "terminal-evaluator",
    modelTier: "frontier",
    promptRef: "evaluator/global",
    inputPorts: [],
    outputPorts: [],
    reads: ["evaluations", "branchStatus", "sprintContracts"],
    writes: ["messages"],
    effects: [],
  },
  {
    id: N.finalize,
    kind: "tool",
    title: "Finalize the run",
    doc: "The success terminal. Records the run verdict as a control-plane fact and ends the run.",
    subgraph: null,
    role: "utility",
    inputPorts: [],
    outputPorts: [],
    reads: ["evaluations", "sprintContracts"],
    writes: ["messages"],
    effects: ["fs-write"],
    toolRef: "run.finalize",
  },
  {
    id: N.gracefulFailure,
    kind: "tool",
    title: "Fail gracefully",
    doc: "The single failure terminal: records why the run could not proceed and ends it without a commit. Reached from every gate's onFail and from a fully blocked frontier.",
    subgraph: null,
    role: "utility",
    inputPorts: [],
    outputPorts: [],
    reads: ["branchStatus"],
    writes: ["messages", "branchStatus"],
    effects: ["fs-write"],
    toolRef: "run.gracefulFailure",
  },
];

const GOLDEN_UNSEALED: TopologySpec = {
  formatVersion: 1,
  graphId: GOLDEN_GRAPH_ID,
  graphVersion: "1.0.0",
  description:
    "Golden runtime fixture: one gated fan-out subgraph with a bounded rework cycle, a fan-in barrier at the supervisor, and two terminals.",
  provenance: "authored",
  entry: N.planDraft,
  defaults: {
    supervisorNodeId: N.supervisor,
    modelTier: "light",
    concurrency: 1,
    durability: "superstep",
    maxInlineBytes: 4096,
  },
  channels: [
    { id: "messages", reducerRef: "appendById", schemaRef: "GraphMessage", scope: "public", maxInlineBytes: 4096 },
    { id: "evaluations", reducerRef: "appendById", schemaRef: "SprintVerdict", scope: "public", maxInlineBytes: 4096 },
    { id: "sprintContracts", reducerRef: "appendById", schemaRef: "SprintContract", scope: "public", maxInlineBytes: 65536 },
    { id: "refs", reducerRef: "appendById", schemaRef: "ScratchRef", scope: "public", maxInlineBytes: 4096 },
    { id: "counters", reducerRef: "maxNumber", schemaRef: "Counters", scope: "public", maxInlineBytes: 4096 },
    { id: "branchStatus", reducerRef: "lastWriteWinsByKey", schemaRef: "BranchStatus", scope: "public", maxInlineBytes: 4096 },
    { id: "testAnchors", reducerRef: "setUnion", schemaRef: "TestAnchors", scope: "public", maxInlineBytes: 4096 },
    { id: "ledger", reducerRef: "mergeLedger", schemaRef: "LedgerEntry", scope: "public", maxInlineBytes: 4096 },
    { id: "spec", reducerRef: "replaceIfNewer", schemaRef: "PlanSpec", scope: "public", maxInlineBytes: 8192 },
  ],
  nodes: GOLDEN_NODE_SPECS,
  edges: [
    { id: "e-plan-supervisor", from: N.planDraft, to: N.supervisor, kind: "normal" },
    { id: "e-supervisor-sprints", from: N.supervisor, to: N.fanout, kind: "conditional", label: "sprints" },
    { id: "e-supervisor-evaluate", from: N.supervisor, to: N.evalIn, kind: "conditional", label: "evaluate" },
    { id: "e-supervisor-done", from: N.supervisor, to: N.finalize, kind: "conditional", label: "done" },
    {
      id: "e-sprint-dispatch",
      from: N.fanout,
      to: N.sprintBody,
      kind: "fanout",
      label: "dispatch",
      ports: { from: "contract", to: "contract" },
    },
    { id: "e-sprint-drained", from: N.fanout, to: N.supervisor, kind: "conditional", label: "drained" },
    {
      id: "e-sprint-entry",
      from: N.sprintBody,
      to: N.sprintIn,
      kind: "normal",
      ports: { from: "contract", to: "contract" },
    },
    { id: "e-sprint-generate", from: N.sprintIn, to: N.generate, kind: "normal" },
    { id: "e-sprint-evaluate", from: N.generate, to: N.evaluate, kind: "normal" },
    { id: "e-sprint-route", from: N.evaluate, to: N.route, kind: "normal" },
    { id: "e-sprint-retry", from: N.route, to: N.correct, kind: "conditional", label: "retry" },
    { id: "e-sprint-regenerate", from: N.correct, to: N.generate, kind: "normal" },
    { id: "e-sprint-pass", from: N.route, to: N.sprintOut, kind: "conditional", label: "pass" },
    { id: "e-sprint-exit", from: N.sprintOut, to: N.supervisor, kind: "normal" },
    { id: "e-eval-global", from: N.evalIn, to: N.evaluateGlobal, kind: "normal" },
    { id: "e-eval-supervisor", from: N.evaluateGlobal, to: N.supervisor, kind: "normal" },
    { id: "e-finalize-end", from: N.finalize, to: "END", kind: "normal" },
    { id: "e-graceful-end", from: N.gracefulFailure, to: "END", kind: "normal" },
  ],
  checksum: `sha256:${"0".repeat(64)}`,
  subgraphs: [
    {
      id: "sprint",
      graphId: "golden-sprint",
      depth: 1,
      entryGate: N.sprintIn,
      exitGate: N.sprintOut,
      persistence: "inherit",
    },
  ],
};

/**
 * A fresh, sealed copy of the golden artifact.
 *
 * Round-tripped through `TopologySpecSchema` rather than deep-copied, so a fixture that
 * stopped matching the schema fails here instead of surviving as a plausible object every
 * runtime test would then trust.
 */
export function goldenSpec(): TopologySpec {
  const clone = TopologySpecSchema.parse(JSON.parse(JSON.stringify(GOLDEN_UNSEALED)) as unknown);
  return { ...clone, checksum: checksumTopology(clone) };
}

// ── Plan spec and contracts ─────────────────────────────────────────

const FIXED_TIME = "2026-08-05T00:00:00.000Z";

export function goldenPlanSpec(): PlanSpec {
  return PlanSpecSchema.parse({
    specId: GOLDEN_SPEC_ID,
    version: 1,
    title: "Golden runtime fixture",
    description: "A deterministic fixture spec used to exercise the superstep interpreter.",
    status: "in-progress",
    mode: "brownfield",
    features: [
      {
        featureId: "feat-6",
        title: "Executable graph semantics",
        description: "Run a compiled topology as a Pregel superstep loop.",
        priority: "must-have",
        acceptanceCriteria: ["Commits once per superstep", "Admits under dependsOn and file rules"],
      },
    ],
    assumptions: [],
    outOfScope: [],
    clarificationQuestions: [],
    resolvedClarifications: [],
    techStack: ["TypeScript"],
    nonFunctionalRequirements: [],
    constraints: [],
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
  });
}

export interface GoldenContractInput {
  index: number;
  dependsOn?: string[];
  estimatedFiles?: string[];
}

/** The branch key a contract is dispatched under. */
export function goldenContractId(index: number): string {
  return `sprint-golden-${String(index)}`;
}

/**
 * One valid `SprintContract`.
 *
 * Every field the real precision gate checks is populated, because the commit boundary
 * persists contracts through the SAME `saveContract` the shipped engines use — a fixture
 * that skipped the gate would prove the boundary writes something, not that it writes a
 * contract.
 */
export function goldenContract(input: GoldenContractInput): SprintContract {
  const id = goldenContractId(input.index);
  return SprintContractSchema.parse({
    contractId: id,
    specId: GOLDEN_SPEC_ID,
    sprintNumber: input.index,
    title: `Golden sprint ${String(input.index)}`,
    description: `Deterministic fixture branch ${String(input.index)} for the superstep interpreter.`,
    status: "in-progress",
    dependsOn: input.dependsOn ?? [],
    features: ["feat-6"],
    successCriteria: [
      {
        criterionId: `sc-golden-${String(input.index)}`,
        description: `Branch ${String(input.index)} commits its verdict exactly once through the boundary.`,
        verificationMethod: "unit-test",
        required: true,
      },
    ],
    nonGoals: ["Do not execute a production node body."],
    stopConditions: ["Stop when the branch has recorded its verdict."],
    definitionOfDone: "The branch records one verdict and one branch status.",
    assumptions: [],
    outOfScope: [],
    ambiguityScore: 1,
    estimatedFiles: input.estimatedFiles ?? [`src/golden/branch-${String(input.index)}.ts`],
    estimatedDuration: "small",
    iterationHistory: [],
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
  });
}

/** `n` contracts with disjoint file sets and no declared dependencies. */
export function goldenContracts(n: number): SprintContract[] {
  return Array.from({ length: n }, (_, i) => goldenContract({ index: i + 1 }));
}

// ── Initial state ───────────────────────────────────────────────────

export function goldenInitialState(runId: string, projectRoot: string): OverallState {
  return initialOverallState({
    runId,
    projectRoot,
    featureRequest: "Exercise the superstep interpreter end to end.",
  });
}

// ── Node implementations ────────────────────────────────────────────

/**
 * How the fixture behaves, so ONE topology serves every criterion.
 *
 * `reworkBranches` names the branch keys whose first evaluation fails, which is what
 * produces a real loop re-entry rather than a hand-written second span.
 */
export interface GoldenBehaviour {
  contracts: SprintContract[];
  /** Branch keys that fail their first evaluation and take the rework route once. */
  reworkBranches?: readonly string[];
  /**
   * Branch keys whose generator throws a NON-TRANSIENT error, so a sibling failure is
   * observable. `classifyTransient` rejects the message this raises, which is deliberate:
   * a retry policy must leave these branches at exactly one attempt.
   */
  failingBranches?: readonly string[];
  /**
   * Branch key -> how many times its generator throws a TRANSIENT provider error before
   * succeeding. A budget larger than the retry policy's `maxAttempts` is a permanently
   * failing node.
   */
  transientFailures?: Readonly<Record<string, number>>;
  /**
   * Make the graceful-failure terminal write `.bober/failures/<runId>.json` and record its
   * branches in `messages` instead of declaring a run verdict.
   *
   * Off by default, so the deadlock fixture keeps the terminal body it was written
   * against. On, it is the shape `coding.graph.ts` prescribes in prose: `finalize` owns
   * the terminal verdict and the failure path records what failed, which is also what
   * stops the two terminals from disagreeing about a control key in one superstep.
   */
  recordFailureArtifact?: boolean;
  /** Called when a node inside the fan-out region starts and finishes. */
  onBranchNode?: (event: "start" | "end", nodeId: string, branchKey: string) => void;
  /**
   * Extra microtask depth per branch, so branches complete in a scrambled order without
   * any timer. Ordering is what the barrier tests assert; elapsed time is never asserted.
   */
  stagger?: (branchKey: string) => number;
  /** A payload the generator commits verbatim, used to trip the inline-size guard. */
  oversizedMessageText?: string;
  /**
   * Replace one node's body outright.
   *
   * The graph stays the SAME artifact — same checksum, same edges, same ports — so a test
   * about routing, scope or isolation changes exactly the one thing it is about, and the
   * topology it runs against is still the one every other test uses.
   */
  handlerOverrides?: Readonly<Record<string, NodeImpl["handler"]>>;
}

async function yieldTimes(n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
}

/**
 * What an overloaded provider looks like to `classifyTransient`.
 *
 * Carries a real HTTP 503, so the SHARED classifier in
 * `src/orchestrator/workflow/retry.ts` decides it is retryable on its own terms. A
 * fixture error that the classifier had to be taught about would prove the test's
 * arrangement rather than the policy.
 */
export class TransientProviderError extends Error {
  readonly status = 503;
  readonly branchKey: string;

  constructor(branchKey: string, attempt: number) {
    super(
      `golden fixture: branch ${branchKey} hit an overloaded provider on attempt ${String(attempt)}`,
    );
    this.name = "TransientProviderError";
    this.branchKey = branchKey;
  }
}

/** What the graceful-failure terminal is told, when the interpreter routes to it. */
const GracefulFailureInputSchema = z.object({
  reason: z.string().min(1).default("Unknown"),
  branches: z
    .array(
      z.object({
        branchKey: z.string().min(1),
        contractId: z.string().min(1).optional(),
        nodeId: z.string().min(1),
        attempts: z.number().int().min(1),
        errorClass: z.string().min(1),
        message: z.string(),
      }),
    )
    .default([]),
});

function message(id: string, seq: number, nodeId: string, text: string): GraphMessage {
  return { id, seq, role: "assistant", nodeId, text, tokens: text.length };
}

type Handler = NodeImpl["handler"];

interface ImplSpec {
  kind: NodeImpl["kind"];
  inputPort?: PortBinding;
  outputPort?: PortBinding;
  inputSchema?: z.ZodType;
  outputSchema?: z.ZodType;
  handler: Handler;
}

/** The join payload every fan-in target receives. */
const FanInSchema = z.object({
  fanIn: z.array(z.object({ branchKey: z.string(), value: z.unknown() })),
});

function fanInCount(input: unknown): number {
  const parsed = FanInSchema.safeParse(input);
  return parsed.success ? parsed.data.fanIn.length : 0;
}

/** The branch keys AS THE JOIN DELIVERED THEM — order included, deliberately. */
function fanInOrder(input: unknown): string[] {
  const parsed = FanInSchema.safeParse(input);
  return parsed.success ? parsed.data.fanIn.map((entry) => entry.branchKey) : [];
}

const BranchOrderSchema = z.object({ branchOrder: z.array(z.string()) });

/**
 * The join order, forwarded from the supervisor to the global evaluator.
 *
 * It exists so the ORDER the fan-in delivered its branches in reaches a committed
 * artifact. Without it the join could deliver branches in completion order and every
 * artifact would still be byte-identical, which would make the determinism suite blind to
 * exactly the defect it is there to catch.
 */
function branchOrderOf(input: unknown): string[] {
  const parsed = BranchOrderSchema.safeParse(input);
  return parsed.success ? parsed.data.branchOrder : [];
}

/**
 * Build the golden node registry.
 *
 * Every handler is a pure function of its input, the frozen state snapshot it is given and
 * this behaviour description. None reads a clock, spawns a process or touches the
 * filesystem, so two runs of the same graph differ only in what the INTERPRETER did.
 */
export function goldenNodeRegistry(behaviour: GoldenBehaviour): NodeRegistry {
  const rework = new Set(behaviour.reworkBranches ?? []);
  const failing = new Set(behaviour.failingBranches ?? []);
  const stagger = behaviour.stagger ?? ((): number => 0);
  const transientBudget = behaviour.transientFailures ?? {};
  /** Transient throws already spent per branch. Per REGISTRY, so a fresh run starts over. */
  const transientSpent = new Map<string, number>();

  const branchNode =
    (nodeId: string, body: Handler): Handler =>
    async (input, state, ctx) => {
      const key = ctx.branchKey ?? "";
      behaviour.onBranchNode?.("start", nodeId, key);
      await yieldTimes(stagger(key));
      const result = await body(input, state, ctx);
      behaviour.onBranchNode?.("end", nodeId, key);
      return result;
    };

  const specs: Record<string, ImplSpec> = {
    [N.planDraft]: {
      kind: "llm",
      handler: async () => ({
        update: {
          spec: goldenPlanSpec(),
          sprintContracts: behaviour.contracts,
          messages: [message("m-plan", 0, N.planDraft, "drafted the plan")],
          counters: { planRounds: 1 },
        },
        phase: "planning",
        goto: { kind: "node", node: N.supervisor },
        output: { drafted: true },
      }),
    },

    [N.supervisor]: {
      kind: "router",
      handler: async (input, state) => {
        const dispatched = Object.keys(state.branchStatus).length;
        const rounds = (state.counters.supervisorRounds ?? 0) + 1;
        // Three outcomes, chosen at RUNTIME from committed state: dispatch the sprint
        // region, run the global evaluation once every branch has settled, or finish.
        const globalDone = state.messages.some((m) => m.nodeId === N.evaluateGlobal);
        const label = dispatched === 0 ? "sprints" : globalDone ? "done" : "evaluate";
        return {
          update: { counters: { supervisorRounds: rounds } },
          goto: { kind: "label", label },
          output: { label, joined: fanInCount(input), branchOrder: fanInOrder(input) },
        };
      },
    },

    [N.fanout]: {
      kind: "router",
      outputPort: CONTRACT_PORT,
      outputSchema: SprintContractSchema,
      handler: async (_input, state) => {
        const pending = state.sprintContracts.filter(
          (c) => state.branchStatus[c.contractId] === undefined,
        );
        if (pending.length === 0) {
          return {
            update: {},
            goto: { kind: "label", label: "drained" },
            output: behaviour.contracts[0],
          };
        }
        return {
          update: { counters: { fanoutRounds: 1 } },
          phase: "generating",
          // ONE routing decision, N branch dispatches. The cardinality is the length of
          // `sends`; the artifact still declares exactly one fan-out edge.
          goto: {
            kind: "fanout",
            sends: pending.map((contract) => ({ branchKey: contract.contractId, input: contract })),
          },
          output: pending[0],
        };
      },
    },

    [N.sprintBody]: {
      kind: "subgraph",
      inputPort: CONTRACT_PORT,
      inputSchema: SprintContractSchema,
      outputPort: CONTRACT_PORT,
      outputSchema: SprintContractSchema,
      handler: branchNode(N.sprintBody, async (input) => {
        const contract = SprintContractSchema.parse(input);
        return {
          update: {
            // `attempts: 0` — no attempt has COMPLETED yet, and that is what makes the
            // later `succeeded`/`failed` record win the per-key join. See the ordering
            // contract on `BranchStatusSchema`.
            branchStatus: { [contract.contractId]: { state: "running", attempts: 0 } },
          },
          goto: { kind: "node", node: N.sprintIn },
          output: contract,
        };
      }),
    },

    [N.sprintIn]: {
      kind: "gate",
      inputPort: CONTRACT_PORT,
      inputSchema: SprintContractSchema,
      handler: branchNode(N.sprintIn, async (input) => ({
        update: {},
        goto: { kind: "node", node: N.generate },
        output: input,
      })),
    },

    [N.generate]: {
      kind: "llm",
      handler: branchNode(N.generate, async (input, state, ctx) => {
        const key = ctx.branchKey ?? "";
        if (failing.has(key)) throw new Error(`golden fixture: branch ${key} failed generation`);
        // Thrown INSIDE the branch wrapper, so `onBranchNode` has already recorded this
        // execution: a retried attempt is a real second entry into the body, not a
        // bookkeeping increment somewhere above it.
        const budget = transientBudget[key] ?? 0;
        const spent = transientSpent.get(key) ?? 0;
        if (spent < budget) {
          transientSpent.set(key, spent + 1);
          throw new TransientProviderError(key, spent + 1);
        }
        // PRIVATE state: a working buffer that must never reach a channel.
        ctx.priv.set("goldenPrivateDraft", `draft for ${key}`);
        ctx.priv.set("goldenPrivateTokenCount", 42);
        const attempt = (state.counters[`attempts.${key}`] ?? 0) + 1;
        const text = behaviour.oversizedMessageText ?? `generated ${key} attempt ${String(attempt)}`;
        return {
          update: {
            messages: [message(`m-gen-${key}-${String(attempt)}`, attempt, N.generate, text)],
            counters: { [`attempts.${key}`]: attempt },
          },
          goto: { kind: "node", node: N.evaluate },
          output: input,
        };
      }),
    },

    [N.evaluate]: {
      kind: "llm",
      handler: branchNode(N.evaluate, async (input, state, ctx) => {
        const key = ctx.branchKey ?? "";
        const attempt = state.counters[`attempts.${key}`] ?? 1;
        const passing = !rework.has(key) || attempt > 1;
        const verdict: SprintVerdict = {
          id: `v-${key}-${String(attempt)}`,
          seq: attempt,
          contractId: key,
          sprintNumber: 1,
          iteration: attempt,
          verdict: passing ? "pass" : "fail",
          summary: `branch ${key} attempt ${String(attempt)}`,
          evalId: null,
        };
        return {
          update: { evaluations: [verdict], testAnchors: [`anchor:${key}`] },
          goto: { kind: "node", node: N.route },
          output: input,
        };
      }),
    },

    [N.route]: {
      kind: "router",
      handler: branchNode(N.route, async (input, state, ctx) => {
        const key = ctx.branchKey ?? "";
        const latest = state.evaluations.filter((e) => e.contractId === key).at(-1);
        const iterations = (state.counters[`iterations.${key}`] ?? 0) + 1;
        return {
          update: { counters: { [`iterations.${key}`]: iterations } },
          goto: { kind: "label", label: latest?.verdict === "pass" ? "pass" : "retry" },
          output: input,
        };
      }),
    },

    [N.correct]: {
      kind: "llm",
      handler: branchNode(N.correct, async (input, _state, ctx) => {
        const key = ctx.branchKey ?? "";
        return {
          update: { messages: [message(`m-fix-${key}`, 9, N.correct, `corrected ${key}`)] },
          goto: { kind: "node", node: N.generate },
          output: input,
        };
      }),
    },

    [N.sprintOut]: {
      kind: "gate",
      handler: branchNode(N.sprintOut, async (input, state, ctx) => {
        const key = ctx.branchKey ?? "";
        const contract = state.sprintContracts.find((c) => c.contractId === key);
        return {
          update: {
            branchStatus: { [key]: { state: "succeeded", attempts: 1 } },
            ...(contract === undefined
              ? {}
              : { sprintContracts: [{ ...contract, status: "passed" as const }] }),
          },
          // The declared way out of a subgraph. Naming the supervisor by id from here is
          // an UnknownNodeInScope failure, which is the point.
          goto: { kind: "parent" },
          output: { contractId: key, verdict: "pass", echo: input },
        };
      }),
    },

    [N.evalIn]: {
      kind: "gate",
      handler: async (input) => ({
        update: {},
        goto: { kind: "node", node: N.evaluateGlobal },
        output: input,
      }),
    },

    [N.evaluateGlobal]: {
      kind: "llm",
      handler: async (input, state) => ({
        update: {
          messages: [
            message(
              "m-eval-global",
              100,
              N.evaluateGlobal,
              `observed ${String(state.evaluations.length)} verdicts from [${branchOrderOf(input).join(",")}]`,
            ),
          ],
        },
        phase: "evaluating",
        goto: { kind: "node", node: N.supervisor },
        output: {
          observedBranches: Object.keys(state.branchStatus).length,
          observedVerdicts: state.evaluations.length,
          echo: input,
        },
      }),
    },

    [N.finalize]: {
      kind: "tool",
      handler: async (_input, state) => ({
        update: {
          messages: [message("m-final", 200, N.finalize, "run finalized")],
          verdict: state.sprintContracts.every((c) => c.status === "passed")
            ? ("success" as const)
            : ("partial" as const),
          specId: GOLDEN_SPEC_ID,
        },
        phase: "complete",
        goto: { kind: "node", node: "END" },
        output: { finalized: true },
      }),
    },

    [N.gracefulFailure]: {
      kind: "tool",
      handler: behaviour.recordFailureArtifact
        ? async (input, _state, ctx) => {
            const parsed = GracefulFailureInputSchema.safeParse(input);
            const reason = parsed.success ? parsed.data.reason : "Unknown";
            const branches = parsed.success ? parsed.data.branches : [];
            // The terminal's ONE effect: the failure artifact, written through the
            // runtime's atomic primitive, timed by the node's injected clock. It declares
            // no verdict — `finalize` owns that control key, and the failure path records
            // its branches instead, exactly as `coding.graph.ts` prescribes.
            await writeFailureArtifact(ctx.projectRoot, {
              formatVersion: FAILURE_ARTIFACT_FORMAT_VERSION,
              runId: ctx.runId,
              reason,
              supersteps: ctx.superstep,
              createdAt: ctx.clock.nowIso(),
              branches,
            });
            return {
              update: {
                messages: [
                  message(
                    "m-graceful",
                    300,
                    N.gracefulFailure,
                    `recorded ${String(branches.length)} failed branch(es) for ${reason}`,
                  ),
                ],
              },
              goto: { kind: "node", node: "END" },
              output: { failed: true, reason, branches: branches.map((b) => b.branchKey) },
            };
          }
        : async (input) => ({
            update: {
              messages: [message("m-graceful", 300, N.gracefulFailure, "run failed gracefully")],
              verdict: "failed" as const,
            },
            phase: "failed",
            goto: { kind: "node", node: "END" },
            output: { failed: true, echo: input },
          }),
    },
  };

  const overrides = behaviour.handlerOverrides ?? {};
  const registry = createNodeRegistry();
  for (const node of GOLDEN_NODE_SPECS) {
    const spec = specs[node.id];
    registry.register({
      id: node.id,
      kind: spec.kind,
      inputPort: spec.inputPort ?? null,
      outputPort: spec.outputPort ?? null,
      inputSchema: spec.inputSchema ?? z.unknown(),
      outputSchema: spec.outputSchema ?? z.unknown(),
      handler: Object.prototype.hasOwnProperty.call(overrides, node.id)
        ? overrides[node.id]
        : spec.handler,
    });
  }
  return registry;
}

export function goldenRegistries(behaviour: GoldenBehaviour): Registries {
  return {
    nodes: goldenNodeRegistry(behaviour),
    reducers: createReducerRegistry(),
    effects: createEffectRegistry(),
    schemas: goldenSchemaCatalog(),
    schemaModules: GOLDEN_SCHEMA_MODULES,
  };
}
