import { z } from "zod";

import { SchemaIssueSchema, schemaIssuesOf } from "../../contracts/problem-reflection.js";
import type { SchemaIssue } from "../../contracts/problem-reflection.js";
import { TERMINAL_ENDPOINT } from "../../contracts/topology.js";
import type { NodeSpec, TopologySpec } from "../../contracts/topology.js";
import { SprintContractSchema } from "../../contracts/sprint-contract.js";
import { SprintVerdictSchema } from "../state/overall.js";
import type { BranchStatus, OverallState, SprintVerdict } from "../state/overall.js";
import type { SandboxOutcome } from "../runtime/sandbox.js";
import type { Goto, NodeContext, NodeImpl, PortBinding } from "../registry/nodes.js";
import { decodeAnchorRegression } from "./anchors.js";
import { buildCorrection, isCorrectionPayload } from "./sprint-correct.js";
import type { CorrectionPayload, CorrectionSource } from "./sprint-correct.js";
import {
  commandFor,
  describeSandboxOutcome,
  sandboxCorrectionSource,
  sprintSandboxPolicy,
  verificationPassed,
} from "./verification.js";
import type { SprintRuntime, VerificationCommand } from "./verification.js";

/**
 * The fail-closed boundary gates, as one factory.
 *
 * ── What a gate IS ──
 *
 * A pure validator plus a {@link Goto}. It parses the payload traversing it with the REAL
 * Zod schema from `src/contracts/`, and on failure it returns a `Command` whose `goto`
 * routes to the artifact's declared `gate.onFail` endpoint and whose output is a
 * {@link NodeRefusal} — never the rejected payload, and never a partial copy of it. It
 * does not throw: a gate that threw would leave the fail-closed hop inside a `catch` in
 * the interpreter, where a topology diff cannot see it. The routing is in the artifact,
 * so it is in the diff.
 *
 * ── Why a gate's `inputSchema` is `z.unknown()`, and why that is not a weakening ──
 *
 * The interpreter parses a task's input with the implementation's `inputSchema` BEFORE it
 * enters the handler (`interpreter.ts:929`). A gate whose `inputSchema` were the strict
 * payload schema would therefore never run its own body on the one input it exists to
 * refuse — the parse would throw first, the task would be recorded as a generic node
 * failure, and no `Command`, no route to `graceful_failure` and no typed diagnostic would
 * be produced. The strict parse still happens; it happens INSIDE the body, where its
 * failure is expressible as a route. Gates are the only nodes in this library that
 * declare a permissive input schema, and it is what makes them gates.
 *
 * ── Why the module map is not supplied for these regions ──
 *
 * `compile()` can assert by reference identity that a bound port's `schemaRef` resolves
 * to the implementation's own `inputSchema`/`outputSchema` (`compiler.ts:325`), which is
 * the strongest port check available. Two facts about the committed artifact make it
 * inexpressible here:
 *
 *  1. a gate's output is `admitted | refusal`, and no single schema behind the ref
 *     `"FeatureRequest"` can be both the feature request and the refusal that replaces it;
 *  2. the artifact uses one ref for two cardinalities — `fanout_sprints` binds
 *     `schemaRef: "SprintContract"` on a PLURAL `contracts` input port and a SINGULAR
 *     `contract` output port (`coding.graph.ts:453-454`) — so the ref names the ELEMENT
 *     type while the key names the cardinality, and the compiler's map is keyed by ref
 *     alone.
 *
 * The composition root therefore supplies `Registries.schemas` (every bound ref must
 * resolve through the artifact's own `CODING_SCHEMA_REFS`) and not `schemaModules`. Both
 * facts are reported as findings rather than papered over.
 *
 * ── Why a research-scope gate cannot `goto` the failure terminal directly ──
 *
 * `gate_research_in` and `gate_research_out` declare `gate.onFail: "graceful_failure"`
 * and live in the `research` subgraph, while `graceful_failure` lives at the root.
 * `gate.onFail` is a POLICY endpoint the VALIDATOR folds into its reachability adjacency
 * (`validate.ts:189-213`); the COMPILED adjacency is built from `spec.edges` alone
 * (`compiler.ts:373-379`), so `resolveDestination` refuses the hop with
 * `UnknownNodeInScopeError` and says so in its message. A subgraph-scoped gate therefore
 * fails with `{ kind: "parent" }` — to the supervisor, which completes the declared hop.
 * One hop longer than the artifact's `onFail` suggests, and derived from it rather than
 * from a literal.
 */

// ── Refusal ─────────────────────────────────────────────────────────

/**
 * The discriminator of a refusal, spelled once.
 *
 * A namespaced literal rather than a bare `"refusal"` so a refusal can never be confused
 * with a domain payload that happens to carry a `kind` field — `PlannerResult`, for one,
 * is discriminated on `kind`.
 */
export const NODE_REFUSAL_KIND = "pge.node.refusal";

/**
 * A node's typed refusal of a payload it could not admit.
 *
 * What it carries is the DIAGNOSIS: which node refused, which declared check it was
 * applying, where the payload was supposed to go instead, and the Zod issue paths. What
 * it deliberately does NOT carry is any part of the payload — a refusal that echoed the
 * rejected value would re-introduce it into whatever the refusal is written to, which is
 * the propagation a fail-closed gate exists to prevent (sc-11-5).
 */
export const NodeRefusalSchema = z.object({
  kind: z.literal(NODE_REFUSAL_KIND),
  nodeId: z.string().min(1),
  /** The `gate.check` the artifact declares, or the check a non-gate node applied. */
  check: z.string().min(1),
  /** Where the artifact says a refusal goes. */
  onFail: z.string().min(1),
  superstep: z.number().int().min(0),
  refusedAt: z.string().min(1),
  issues: z.array(SchemaIssueSchema).min(1),
});
export type NodeRefusal = z.infer<typeof NodeRefusalSchema>;

/** True when `value` is a refusal rather than an admitted payload. */
export function isNodeRefusal(value: unknown): value is NodeRefusal {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === NODE_REFUSAL_KIND
  );
}

/** Build a refusal from the refusing node's context. Never sees the payload. */
export function refuse(
  ctx: NodeContext,
  args: { check: string; onFail: string; issues: readonly SchemaIssue[] },
): NodeRefusal {
  return NodeRefusalSchema.parse({
    kind: NODE_REFUSAL_KIND,
    nodeId: ctx.nodeId,
    check: args.check,
    onFail: args.onFail,
    superstep: ctx.superstep,
    refusedAt: ctx.clock.nowIso(),
    issues: [...args.issues],
  });
}

/** A one-line human summary of a refusal: node, check, and every failing path. */
export function describeRefusal(refusal: NodeRefusal): string {
  const paths = refusal.issues
    .map((issue) => `${issue.path === "" ? "<root>" : issue.path} [${issue.code}]`)
    .join(", ");
  return `${refusal.nodeId} refused "${refusal.check}": ${paths}`;
}

// ── Artifact lookups ────────────────────────────────────────────────

/** A node could not be built because the artifact does not describe it that way. */
export class NodeSpecMismatchError extends Error {
  readonly nodeId: string;

  constructor(nodeId: string, detail: string) {
    super(`Cannot build an implementation for node "${nodeId}": ${detail}.`);
    this.name = "NodeSpecMismatchError";
    this.nodeId = nodeId;
  }
}

/** The artifact's declaration of `nodeId`. */
export function nodeSpecOf(spec: TopologySpec, nodeId: string): NodeSpec {
  const node = spec.nodes.find((entry) => entry.id === nodeId);
  if (node === undefined) throw new NodeSpecMismatchError(nodeId, "the topology declares no such node");
  return node;
}

/**
 * The ONE port a node declares on `side`, or `null`.
 *
 * Read off the artifact rather than spelled in the implementation: a `PortBinding`
 * written by hand only ever asserts that the implementation agrees with itself, and
 * `compile()` would then compare the artifact against a copy of the artifact somebody
 * typed twice.
 */
export function portOf(node: NodeSpec, side: "input" | "output"): PortBinding | null {
  const declared = side === "input" ? node.inputPorts : node.outputPorts;
  const first = declared[0];
  if (first === undefined) return null;
  if (declared.length > 1) {
    throw new NodeSpecMismatchError(
      node.id,
      `it declares ${String(declared.length)} ${side} ports and an implementation binds at most one`,
    );
  }
  return { key: first.key, schemaRef: first.schemaRef };
}

/**
 * The single successor a straight-line node hands control to, read off the artifact.
 *
 * Only `normal` edges: a `conditional` edge belongs to a router's label set and a
 * `fanout` edge is dispatched with sends, so neither is a `goto { kind: "node" }`.
 */
export function soleSuccessor(spec: TopologySpec, nodeId: string): string {
  const edges = spec.edges.filter((edge) => edge.from === nodeId && edge.kind === "normal");
  if (edges.length !== 1) {
    throw new NodeSpecMismatchError(
      nodeId,
      `the topology declares ${String(edges.length)} normal outgoing edge(s) from it, and exactly one is required to route without a label`,
    );
  }
  return edges[0].to;
}

/** The declared `loop.maxIterations` of a bounded node. */
export function loopBoundOf(spec: TopologySpec, nodeId: string): { counterKey: string; maxIterations: number } {
  const node = nodeSpecOf(spec, nodeId);
  if (node.loop === undefined) {
    throw new NodeSpecMismatchError(nodeId, "the topology declares no loop bound on it");
  }
  return { counterKey: node.loop.counterKey, maxIterations: node.loop.maxIterations };
}

/**
 * The sole successor of a straight-line node, or the reserved terminal when the projection
 * does not contain one.
 *
 * A REGION projection legitimately truncates a chain: the terminal region stops before
 * `finalize` (a sprint-13 node), so `commit` — which has exactly one successor in the full
 * artifact — has none in that projection. `soleSuccessor` would throw, which would make a
 * legitimate projection look like a topology defect. Falling back to `END` says what is
 * actually true: control leaves the graph here because the graph ends here.
 */
export function successorOrEnd(spec: TopologySpec, nodeId: string): string {
  const edges = spec.edges.filter((edge) => edge.from === nodeId && edge.kind === "normal");
  if (edges.length === 0) return TERMINAL_ENDPOINT;
  return soleSuccessor(spec, nodeId);
}

/**
 * Where a node's declared `gate.onFail` actually sends control.
 *
 * `gate.onFail` is a POLICY endpoint the VALIDATOR folds into its reachability adjacency
 * (`validate.ts:189-213`), while the COMPILED adjacency is built from `spec.edges` alone
 * (`compiler.ts:373-379`). `resolveDestination` (`interpreter.ts:604-618`) therefore admits
 * a `{ kind: "node" }` hop only when the target is edge-reachable OR shares the source's
 * `subgraph`. Three cases follow, and all three occur in the committed artifact:
 *
 *  - SAME SCOPE (`gate_syntax` -> `sprint_correct`, both `subgraph: "sprint"`;
 *    `reduce_sprints` -> `fanout_sprints`, both root): a direct node hop, which is what the
 *    artifact says and what the interpreter admits, even though no edge declares it;
 *  - OUT OF A SUBGRAPH (`gate_research_out` -> `graceful_failure`, gate in `research`,
 *    terminal at the root): `{ kind: "parent" }` to the supervisor, which finishes the hop
 *    the gate's own declaration started (see the module header);
 *  - TARGET ABSENT from a projection: `{ kind: "parent" }` if there is a parent to leave
 *    to, otherwise the reserved terminal.
 */
export function failGotoOf(spec: TopologySpec, node: NodeSpec, onFail: string): Goto {
  const target = spec.nodes.find((entry) => entry.id === onFail);
  if (target !== undefined && target.subgraph === node.subgraph) {
    return { kind: "node", node: onFail };
  }
  if (node.subgraph !== null) return { kind: "parent" };
  return target === undefined ? { kind: "node", node: TERMINAL_ENDPOINT } : { kind: "node", node: onFail };
}

// ── The gate factory ────────────────────────────────────────────────

/**
 * A state-level precondition a gate applies AFTER the payload parses.
 *
 * Returns the issues that stop the payload from being admitted, or an empty array. It is
 * separate from the schema because the two answer different questions: the schema asks
 * whether the payload is well-formed, and this asks whether the run is in a state where a
 * well-formed payload may cross. A gate only ever consults channels its artifact
 * declaration lists in `reads`.
 */
export type GatePrecondition<T> = (value: T, state: Readonly<OverallState>) => SchemaIssue[];

export interface SchemaGateOptions<T> {
  /** The topology the gate belongs to; every declaration below is read off it. */
  spec: TopologySpec;
  nodeId: string;
  /** The REAL schema from `src/contracts/` that the traversing payload must satisfy. */
  admitted: z.ZodType<T>;
  precondition?: GatePrecondition<T>;
}

/**
 * A boundary gate: parse with the real schema, admit or refuse, never merge.
 *
 * Everything structural comes from the artifact — the ports, the declared `gate.check`,
 * the `gate.onFail` endpoint, the successor on the admit path, and whether the refusal
 * has to leave a subgraph to reach the failure terminal.
 */
export function schemaGate<T>(options: SchemaGateOptions<T>): NodeImpl<unknown, T | NodeRefusal> {
  const { spec, nodeId, admitted, precondition } = options;
  const node = nodeSpecOf(spec, nodeId);
  if (node.kind !== "gate") {
    throw new NodeSpecMismatchError(nodeId, `it is declared as kind "${node.kind}", not "gate"`);
  }
  if (node.gate === undefined) {
    throw new NodeSpecMismatchError(nodeId, "a gate node must declare a gate policy");
  }
  const check = node.gate.check;
  const onFail = node.gate.onFail;
  const admitGoto: Goto = { kind: "node", node: successorOrEnd(spec, nodeId) };
  // Same-scope gates reach the declared endpoint directly; one whose endpoint lives outside
  // its subgraph cannot (see {@link failGotoOf}) and leaves through the declared boundary.
  const failGoto: Goto = failGotoOf(spec, node, onFail);

  return {
    id: nodeId,
    kind: "gate",
    inputPort: portOf(node, "input"),
    outputPort: portOf(node, "output"),
    // Permissive by necessity, not by omission — see the header.
    inputSchema: z.unknown(),
    outputSchema: z.union([admitted, NodeRefusalSchema]),
    handler: async (input, state, ctx) => {
      const parsed = admitted.safeParse(input);
      if (!parsed.success) {
        return {
          // NO `update`. The artifact declares `writes: []` on every boundary gate, and a
          // refused payload merges nothing at all — not partially, and not into a
          // quarantine key. The failure record is appended by `graceful_failure`, which
          // the artifact DOES declare as a writer of `messages`.
          goto: failGoto,
          output: refuse(ctx, { check, onFail, issues: schemaIssuesOf(parsed.error) }),
        };
      }
      const issues = precondition?.(parsed.data, state) ?? [];
      if (issues.length > 0) {
        return { goto: failGoto, output: refuse(ctx, { check, onFail, issues }) };
      }
      return { goto: admitGoto, output: parsed.data };
    },
  };
}

/** A precondition issue: a `custom` diagnostic at a named path. */
export function preconditionIssue(path: string, message: string): SchemaIssue {
  return { path, pathSegments: path === "" ? [] : path.split("."), code: "custom", message };
}

/** The `{ check, onFail }` policy a gate node declares, narrowed off the artifact. */
export function gatePolicyOf(spec: TopologySpec, nodeId: string): { check: string; onFail: string } {
  const node = nodeSpecOf(spec, nodeId);
  if (node.kind !== "gate" || node.gate === undefined) {
    throw new NodeSpecMismatchError(nodeId, `it is declared as kind "${node.kind}" and carries no gate policy`);
  }
  return { check: node.gate.check, onFail: node.gate.onFail };
}

// ── The guard factory ───────────────────────────────────────────────

/**
 * What a guard decided, and what it wants to hand on.
 *
 * A second factory beside {@link schemaGate} because a sprint guard answers a different
 * question. `schemaGate` asks "is this payload well-formed", refuses with a
 * {@link NodeRefusal} and merges nothing. A sprint guard asks "did this iteration hold up",
 * refuses with a {@link CorrectionPayload} the corrector can ACT ON, and records the branch
 * outcome its artifact declaration lists in `writes`. Folding both into one factory would
 * mean a refusal type that is sometimes actionable and sometimes not.
 */
export interface GuardDecision {
  readonly admitted: boolean;
  /** What travels to the destination — the admitted payload, or the correction. */
  readonly output: unknown;
  /** Channel writes, which must stay inside the node's declared `writes`. */
  readonly update?: Partial<OverallState>;
}

export type GuardCheck = (
  input: unknown,
  state: Readonly<OverallState>,
  ctx: NodeContext,
) => Promise<GuardDecision>;

export interface GuardGateOptions {
  spec: TopologySpec;
  nodeId: string;
  check: GuardCheck;
}

/**
 * A sprint guard: run the check, route on the answer, never throw.
 *
 * Both destinations come off the artifact — the admit path from the single declared normal
 * edge, the refusal path from `gate.onFail` through {@link failGotoOf}. The body decides
 * WHETHER, and the artifact decides WHERE, which is what keeps the routing in the diff.
 */
export function guardGate(options: GuardGateOptions): NodeImpl<unknown, unknown> {
  const { spec, nodeId, check } = options;
  const node = nodeSpecOf(spec, nodeId);
  if (node.kind !== "gate") {
    throw new NodeSpecMismatchError(nodeId, `it is declared as kind "${node.kind}", not "gate"`);
  }
  if (node.gate === undefined) {
    throw new NodeSpecMismatchError(nodeId, "a gate node must declare a gate policy");
  }
  const admitGoto: Goto = { kind: "node", node: successorOrEnd(spec, nodeId) };
  const failGoto: Goto = failGotoOf(spec, node, node.gate.onFail);

  return {
    id: nodeId,
    kind: "gate",
    inputPort: portOf(node, "input"),
    outputPort: portOf(node, "output"),
    // Permissive for the same reason every gate is: the interpreter parses a task's input
    // BEFORE the handler runs (`interpreter.ts:929`), so a guard whose input schema were
    // strict could never run the body that refuses a bad payload.
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    handler: async (input, state, ctx) => {
      const decision = await check(input, state, ctx);
      return {
        ...(decision.update === undefined ? {} : { update: decision.update }),
        goto: decision.admitted ? admitGoto : failGoto,
        output: decision.output,
      };
    },
  };
}

/** The branch record a guard writes when it refuses. `attempts: 0` — still running. */
export function runningBranch(errorClass: string): BranchStatus {
  return { state: "running", attempts: 0, errorClass };
}

// ── gate_sprint_in ──────────────────────────────────────────────────

export const SPRINT_GATE_IDS = {
  entry: "gate_sprint_in",
  mockCoverage: "gate_mock_coverage",
  syntax: "gate_syntax",
  anchorRegression: "gate_anchor_regression",
  route: "sprint_route",
  exit: "gate_sprint_out",
  reduce: "reduce_sprints",
} as const;

/**
 * The sprint entry gate: one contract, admissible, into the subgraph.
 *
 * "Admissible" is read off the two channels the artifact lists in `reads`
 * (`coding.graph.ts:486`): the contract must be one the run actually planned
 * (`sprintContracts`), and every contract it `dependsOn` must have settled successfully
 * (`branchStatus`). A contract whose dependency failed is short-circuited to `sprint_exit`
 * rather than generated against a broken predecessor.
 */
export function sprintEntryGate(spec: TopologySpec): NodeImpl<unknown, unknown> {
  return schemaGate({
    spec,
    nodeId: SPRINT_GATE_IDS.entry,
    admitted: SprintContractSchema,
    precondition: (contract, state) => {
      const issues: SchemaIssue[] = [];
      const planned = state.sprintContracts.some(
        (entry) => entry.contractId === contract.contractId,
      );
      if (!planned) {
        issues.push(
          preconditionIssue(
            "contractId",
            `contract "${contract.contractId}" is not one of the ${String(state.sprintContracts.length)} contracts this run planned`,
          ),
        );
      }
      for (const dependency of contract.dependsOn ?? []) {
        const status = state.branchStatus[dependency];
        if (status !== undefined && status.state !== "succeeded" && status.attempts > 0) {
          issues.push(
            preconditionIssue(
              "dependsOn",
              `dependency "${dependency}" settled as "${status.state}", so this contract cannot be generated against it`,
            ),
          );
        }
      }
      return issues;
    },
  });
}

// ── gate_mock_coverage ──────────────────────────────────────────────

/**
 * The categories a mock-test set must cover, and the count band it must sit in.
 *
 * Both are the sprint contract's own numbers ("6 to 8 additional diverse mock tests
 * covering boundary, empty, large and negative categories"), written here rather than in
 * config because there is no config key for them and inventing one would put a
 * contract-level requirement somewhere a project could quietly lower it.
 */
export const MOCK_CATEGORIES = ["boundary", "empty", "large", "negative"] as const;
export const MockCategorySchema = z.enum(MOCK_CATEGORIES);
export type MockCategory = z.infer<typeof MockCategorySchema>;

export const MOCK_TEST_MIN = 6;
export const MOCK_TEST_MAX = 8;

/** One curated mock test: what it is called, what it covers, and where it was written. */
export const MockTestSchema = z.object({
  testId: z.string().min(1),
  category: MockCategorySchema,
  /** What the test asserts, in the curator's words. */
  intent: z.string().min(1),
  /** The fixture file the curator wrote, relative to the project root. */
  path: z.string().min(1),
});
export type MockTest = z.infer<typeof MockTestSchema>;

export const MockManifestSchema = z.object({
  contractId: z.string().min(1),
  tests: z.array(MockTestSchema),
});
export type MockManifest = z.infer<typeof MockManifestSchema>;

/** The `refs` key the mock manifest is offloaded under. */
export const MOCK_MANIFEST_REF_KEY = "sprint-mock-manifest";

/**
 * Why a mock set does not clear the gate, or `[]`.
 *
 * Both halves are reported, not the first: a set of five cases missing `negative` should
 * tell the curator both things in one round rather than costing two of the two rounds the
 * artifact's `mockCurationRounds` bound allows.
 */
export function mockCoverageIssues(manifest: MockManifest | null): SchemaIssue[] {
  if (manifest === null) {
    return [preconditionIssue("refs", "the mock curator wrote no manifest to the scratch store")];
  }
  const issues: SchemaIssue[] = [];
  const count = manifest.tests.length;
  if (count < MOCK_TEST_MIN || count > MOCK_TEST_MAX) {
    issues.push(
      preconditionIssue(
        "tests",
        `${String(count)} mock test(s) were curated and the gate admits ${String(MOCK_TEST_MIN)} to ${String(MOCK_TEST_MAX)}`,
      ),
    );
  }
  const covered = new Set(manifest.tests.map((test) => test.category));
  const missing = MOCK_CATEGORIES.filter((category) => !covered.has(category));
  if (missing.length > 0) {
    issues.push(
      preconditionIssue("tests.category", `no mock test covers ${missing.join(", ")}`),
    );
  }
  return issues;
}

/**
 * The mock-coverage gate (sc-12-2).
 *
 * Reads the manifest through `refs` — the channel its artifact declaration lists — and
 * refuses back to `sprint_curate_mocks`, which is what makes re-curation a declared cycle
 * with its own `mockCurationRounds` bound rather than an ad-hoc retry.
 *
 * The node declares no effects, which is the truth about this body: checking a manifest is
 * a pure comparison and nothing here executes a process. It declared `["process-exec"]`
 * until graphVersion 1.2.0, which was both false and fatal — `process-exec` is gated, so
 * the node could not run at all.
 */
export function mockCoverageGate(spec: TopologySpec): NodeImpl<unknown, unknown> {
  const { check, onFail } = gatePolicyOf(spec, SPRINT_GATE_IDS.mockCoverage);

  return guardGate({
    spec,
    nodeId: SPRINT_GATE_IDS.mockCoverage,
    check: async (_input, state, ctx) => {
      const manifest = await readMockManifest(state, ctx);
      const issues = mockCoverageIssues(manifest);
      if (issues.length === 0) return { admitted: true, output: manifest };
      return {
        admitted: false,
        // A refusal, never the rejected manifest: the curator is being asked to produce a
        // new one, and echoing the old set would let it be re-submitted unchanged.
        output: refuse(ctx, { check, onFail, issues }),
      };
    },
  });
}

/** The mock manifest the curator offloaded, or `null` when there is none to read. */
export async function readMockManifest(
  state: Readonly<OverallState>,
  ctx: NodeContext,
): Promise<MockManifest | null> {
  const ref = state.refs[MOCK_MANIFEST_REF_KEY];
  if (ref === undefined) return null;
  try {
    const parsed = MockManifestSchema.safeParse(JSON.parse(await ctx.scratch.text(ref)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ── gate_syntax ─────────────────────────────────────────────────────

/** The branch error class a failing syntax gate records. */
export const SYNTAX_GATE_ERROR_CLASS = "SyntaxGateFailed";

export interface SandboxGateOptions {
  spec: TopologySpec;
  runtime: SprintRuntime;
}

/**
 * Run one configured command in the sandbox and report what happened.
 *
 * Every outcome is a value. `SandboxRunner.run` never throws (`sandbox.ts:141`), so a
 * denied binary and a non-terminating child are ROUTED on rather than caught — which is
 * what sc-12-10 asserts at the node level.
 */
export async function runGuardCommand(
  runtime: SprintRuntime,
  ctx: NodeContext,
  command: VerificationCommand,
  timeoutMs?: number,
): Promise<{ outcome: SandboxOutcome; passed: boolean }> {
  const policy = sprintSandboxPolicy(ctx.config, ctx.projectRoot, {
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  const outcome = await runtime.sandbox.run(command.cmd, command.args, policy, runtime.scratch, {
    nodeId: ctx.nodeId,
    kind: "gate",
    branchKey: ctx.branchKey,
    superstep: ctx.superstep,
  });
  return { outcome, passed: verificationPassed(outcome) };
}

/**
 * Build the correction a failed guard command produces.
 *
 * The verbatim bytes come from the sandbox's OWN `stderrRef` when the command actually ran,
 * so "verbatim" means the file the child wrote and not a re-rendering of it. A denial or a
 * timeout produced no child output at all, and the correction says so in its critique
 * instead of inventing one.
 */
export async function correctionFromOutcome(
  ctx: NodeContext,
  command: VerificationCommand,
  outcome: SandboxOutcome,
  fallbackSource: CorrectionSource,
  contractId: string | null,
): Promise<CorrectionPayload> {
  const source = sandboxCorrectionSource(outcome) ?? fallbackSource;
  const critique = describeSandboxOutcome(command, outcome);
  return buildCorrection(ctx, {
    source,
    critique,
    contractId,
    ...(outcome.status === "ok" ? { stderrRef: outcome.stderrRef } : {}),
  });
}

/**
 * The syntax gate (sc-12-3, sc-12-10).
 *
 * Runs the project's own `typecheck` and `lint` commands through the sandbox and, on the
 * first failure, routes to `sprint_correct` carrying the diagnostics. Nothing downstream —
 * not the security node, not the evaluator — is reached, which is the point: an iteration
 * that does not compile has nothing an evaluation could measure.
 *
 * ── Where the diagnostics go, and why not into a channel ──
 *
 * The node declares `writes: ["branchStatus"]` and no output ports (`coding.graph.ts:553`).
 * `branchStatus` is `{state, attempts, errorClass?}` and holds a class name, nothing more.
 * So the correction travels as the node's OUTPUT, which the interpreter hands to
 * `sprint_correct` as its input (`interpreter.ts:1462-1470`), and the verbatim bytes travel
 * as the `ScratchRef` inside it. No undeclared channel is written and no 4 KiB budget is
 * strained. See the header of `sprint-correct.ts`.
 */
export function syntaxGate(options: SandboxGateOptions): NodeImpl<unknown, unknown> {
  const { spec, runtime } = options;

  return guardGate({
    spec,
    nodeId: SPRINT_GATE_IDS.syntax,
    check: async (input, state, ctx) => {
      const contractId = contractIdOf(input, state, ctx);
      for (const method of ["typecheck", "lint"] as const) {
        const command = commandFor(ctx.config, method);
        // A project that declares no lint command has nothing for the gate to run. That is
        // an answer, not a pass by omission — and it is visible, because the allowlist this
        // gate runs under is derived from the same configured commands.
        if (command === null) continue;
        const { outcome, passed } = await runGuardCommand(runtime, ctx, command);
        if (passed) continue;
        return {
          admitted: false,
          update: { branchStatus: branchRecord(ctx, runningBranch(SYNTAX_GATE_ERROR_CLASS)) },
          output: await correctionFromOutcome(ctx, command, outcome, "syntax", contractId),
        };
      }
      return { admitted: true, output: input };
    },
  });
}

/** `{ [branchKey]: status }`, or `{}` for an unbranched task. */
export function branchRecord(
  ctx: NodeContext,
  status: BranchStatus,
): Record<string, BranchStatus> {
  return ctx.branchKey === null ? {} : { [ctx.branchKey]: status };
}

/**
 * The full contract this branch is about, resolved from `sprintContracts`.
 *
 * The branch key IS the contract id (`fanout_sprints` sends it that way), so a node deep in
 * the subgraph that was handed a correction payload rather than a contract can still find
 * the contract it is correcting — from the channel the artifact declares it in, never from
 * a copy carried along the edges.
 */
export function resolveContract(
  input: unknown,
  state: Readonly<OverallState>,
  ctx: NodeContext,
): z.infer<typeof SprintContractSchema> | null {
  const id = contractIdOf(input, state, ctx);
  if (id === null) return state.sprintContracts[0] ?? null;
  return state.sprintContracts.find((entry) => entry.contractId === id) ?? null;
}

/** The contract this branch is about, from the payload, the state or the branch key. */
export function contractIdOf(
  input: unknown,
  state: Readonly<OverallState>,
  ctx: NodeContext,
): string | null {
  const carried = SprintContractSchema.safeParse(input);
  if (carried.success) return carried.data.contractId;
  if (isCorrectionPayload(input) && input.contractId !== null) return input.contractId;
  if (ctx.branchKey !== null) return ctx.branchKey;
  return state.sprintContracts[0]?.contractId ?? null;
}

// ── gate_anchor_regression ──────────────────────────────────────────

/** The branch error class an anchor regression records. */
export const ANCHOR_GATE_ERROR_CLASS = "AnchorRegression";

/**
 * The anchor-regression gate (sc-12-5).
 *
 * Two independent signals, and either one refuses:
 *
 *  1. the verdict handed to it carries an encoded regression. `sprint_evaluate` is the node
 *     that HAS both the branch's recorded anchors (a declared read) and the fresh
 *     `EvaluationRunResult`, so it is the node that can compare them; the comparison
 *     travels on the `SprintVerdict` port the artifact already declares between them;
 *  2. re-running the project's test command under the sandbox does not come back green,
 *     which is the gate's own declared check ("anchor-tests-still-green") and the reason it
 *     declares `process-exec`.
 *
 * Either way the route is `sprint_correct` — `gate.onFail`, REGARDLESS of the sprint's own
 * verdict, exactly as the artifact's doc says. A passing verdict that broke an anchor is
 * still a rejected iteration.
 */
export function anchorRegressionGate(options: SandboxGateOptions): NodeImpl<unknown, unknown> {
  const { spec, runtime } = options;

  return guardGate({
    spec,
    nodeId: SPRINT_GATE_IDS.anchorRegression,
    check: async (input, state, ctx) => {
      const contractId = contractIdOf(input, state, ctx);
      const verdict = SprintVerdictSchema.safeParse(input);
      const broken = verdict.success ? decodeAnchorRegression(verdict.data.summary) : [];

      if (broken.length > 0) {
        return {
          admitted: false,
          update: { branchStatus: branchRecord(ctx, runningBranch(ANCHOR_GATE_ERROR_CLASS)) },
          output: await buildCorrection(ctx, {
            source: "anchor",
            contractId,
            critique: `a previously green anchor was traded for the targeted fix: ${broken.join(", ")}. Restore ${broken.length === 1 ? "it" : "them"} without reverting the fix.`,
          }),
        };
      }

      // Nothing to re-run when the branch has recorded no anchors yet: the first iteration
      // of a branch has nothing to regress, and running the suite to prove that would spend
      // the most expensive command in the sprint on a question already answered.
      const command = state.testAnchors.length === 0 ? null : commandFor(ctx.config, "unit-test");
      if (command === null) return { admitted: true, output: input };

      const { outcome, passed } = await runGuardCommand(runtime, ctx, command);
      if (passed) return { admitted: true, output: input };
      return {
        admitted: false,
        update: { branchStatus: branchRecord(ctx, runningBranch(ANCHOR_GATE_ERROR_CLASS)) },
        output: await correctionFromOutcome(ctx, command, outcome, "anchor", contractId),
      };
    },
  });
}

// ── sprint_route ────────────────────────────────────────────────────

/** The three labels the artifact declares on `sprint_route` (`coding.graph.ts:624-628`). */
export const SPRINT_ROUTE_LABELS = ["retry", "pass", "exhausted"] as const;

/**
 * The sprint iteration router (sc-12-7).
 *
 * A router selects a LABEL and nothing else (ADR-3): `resolveDestination` throws
 * `UndeclaredRouteLabelError` for anything outside the declared set
 * (`interpreter.ts:588`), and the artifact says where each label leads.
 *
 * ── The bound is NOT re-implemented here ──
 *
 * `sprint_route` declares `loop: { counterKey: "sprintIterations", maxIterations: 3 }` and
 * so does `sprint_correct` — deliberately the SAME counter, so a branch gets three
 * correction attempts however it reached the corrector (`coding.graph.ts:634`). The
 * interpreter owns both halves: it folds `prev + 1` into whatever `counters` update this
 * node returns (`interpreter.ts:1298-1330`) and it overrides the destination once the
 * committed counter reaches the bound (`interpreter.ts:988-1029`). A body that counted for
 * itself would double-count and exhaust the branch early, which is the specific mistake the
 * sprint-9 replay-idempotence suite was mutation-tested against.
 *
 * So this body only ever answers "did the iteration pass", and the `exhausted` label is
 * left to the interpreter's own redirect — which additionally records a `failed` span
 * carrying `LoopExhausted` and a `TaskFailure`, so a run that stopped iterating is
 * accounted for rather than merely stopped.
 */
export function sprintRouter(spec: TopologySpec): NodeImpl<unknown, unknown> {
  const nodeId = SPRINT_GATE_IDS.route;
  const node = nodeSpecOf(spec, nodeId);
  if (node.kind !== "router") {
    throw new NodeSpecMismatchError(nodeId, `it is declared as kind "${node.kind}", not "router"`);
  }
  const declared = new Set(node.targets.map((target) => target.label));
  for (const label of SPRINT_ROUTE_LABELS) {
    if (!declared.has(label)) {
      throw new NodeSpecMismatchError(nodeId, `the topology declares no "${label}" target on it`);
    }
  }

  return {
    id: nodeId,
    kind: "router",
    inputPort: portOf(node, "input"),
    outputPort: portOf(node, "output"),
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    handler: async (input, state, ctx) => {
      const verdict = SprintVerdictSchema.safeParse(input);
      const passed = verdict.success && verdict.data.verdict === "pass";
      if (passed) {
        return { goto: { kind: "label", label: "pass" }, output: verdict.data };
      }
      const contractId = contractIdOf(input, state, ctx);
      // The corrector's input, built here so the retry carries the reason with it rather
      // than making `sprint_correct` re-derive one from the evaluations channel.
      const output = isCorrectionPayload(input)
        ? input
        : await buildCorrection(ctx, {
            source: "evaluator",
            contractId,
            critique: verdict.success
              ? `the evaluator returned "${verdict.data.verdict}": ${verdict.data.summary}`
              : latestFailureSummary(state, contractId),
          });
      return { goto: { kind: "label", label: "retry" }, output };
    },
  };
}

/** The most recent failing verdict recorded for `contractId`, as a critique. */
function latestFailureSummary(state: Readonly<OverallState>, contractId: string | null): string {
  const failures = state.evaluations.filter(
    (entry) => entry.verdict !== "pass" && (contractId === null || entry.contractId === contractId),
  );
  const last: SprintVerdict | undefined = failures[failures.length - 1];
  return last === undefined
    ? "the evaluator produced no usable verdict for this iteration"
    : `${last.verdict}: ${last.summary}`;
}

// ── gate_sprint_out ─────────────────────────────────────────────────

/**
 * The sprint exit gate: one settled branch leaves the subgraph.
 *
 * Its declared check is `branch-verdicts-recorded`, so what it verifies is that
 * `sprint_exit` actually recorded this branch — `attempts >= 1`, the ordering discriminator
 * that distinguishes a settled branch from a running one (`state/overall.ts:131-142`). A
 * branch that reached the exit gate without a recorded verdict is a branch nobody can
 * account for, and it routes to `graceful_failure`.
 *
 * The route out is `{ kind: "parent" }` and not a direct hop: the gate lives in the
 * `sprint` subgraph and `graceful_failure` lives at the root, which the compiled adjacency
 * cannot express (see {@link failGotoOf}). The supervisor finishes the hop the gate's own
 * declaration started.
 */
export function sprintExitGate(spec: TopologySpec): NodeImpl<unknown, unknown> {
  const { check, onFail } = gatePolicyOf(spec, SPRINT_GATE_IDS.exit);

  return guardGate({
    spec,
    nodeId: SPRINT_GATE_IDS.exit,
    check: async (input, state, ctx) => {
      const branchKey = ctx.branchKey;
      const status = branchKey === null ? undefined : state.branchStatus[branchKey];
      if (status !== undefined && status.attempts >= 1) {
        return { admitted: true, output: input };
      }
      return {
        admitted: false,
        output: refuse(ctx, {
          check,
          onFail,
          issues: [
            preconditionIssue(
              "branchStatus",
              branchKey === null
                ? "the exit gate ran outside a branch, so no branch verdict could be recorded"
                : `branch "${branchKey}" reached the exit gate with ${status === undefined ? "no recorded status" : `status "${status.state}" and ${String(status.attempts)} completed attempt(s)`}`,
            ),
          ],
        }),
      };
    },
  });
}

// ── reduce_sprints ──────────────────────────────────────────────────

/**
 * The fan-in barrier (sc-12-7's terminal path).
 *
 * ── What the runtime actually does here, which is not quite what the artifact's doc says ──
 *
 * The artifact calls this "the single join for the sprint fan-out". The interpreter's own
 * fan-out analysis disagrees, and the interpreter wins: `computeFanOutRegion`
 * (`interpreter.ts:479`) puts every node reachable ONLY through a fan-out edge in the
 * region, and `reduce_sprints` is reachable only through `gate_sprint_out`, which is
 * reachable only through the fan-out. So `leavingFanOut` (`interpreter.ts:1443`) is false
 * for `gate_sprint_out -> reduce_sprints` and true for `reduce_sprints -> supervisor`: this
 * node runs ONCE PER BRANCH and the join fires one hop later, at the supervisor.
 *
 * The check is therefore written as the per-branch reduction of "all branches settled": a
 * branch may not be released while ANY branch has settled badly. A branch that is merely
 * still running is not a reason to re-dispatch — under `concurrency > 1` the first branch to
 * arrive would otherwise re-fan-out its siblings while they were still working.
 *
 * ── The graceful-failure path ──
 *
 * `gate.onFail` is `fanout_sprints` and `loop` is `{ fanoutRetries, maxIterations: 2,
 * onExhausted: "graceful_failure" }`. A failed branch is therefore re-dispatched twice and
 * then degrades to the failure terminal — which is the artifact's declared route from a
 * failing sprint to the graceful-failure artifact, and the one sc-12-7 follows.
 */
export function reduceSprintsGate(spec: TopologySpec): NodeImpl<unknown, unknown> {
  const { check, onFail } = gatePolicyOf(spec, SPRINT_GATE_IDS.reduce);

  return guardGate({
    spec,
    nodeId: SPRINT_GATE_IDS.reduce,
    check: async (input, state, ctx) => {
      const unsettled = Object.entries(state.branchStatus)
        .filter(([, status]) => status.state === "failed" || status.state === "abandoned")
        .map(([branchKey]) => branchKey)
        .sort();
      if (unsettled.length === 0) return { admitted: true, output: input };
      return {
        admitted: false,
        output: refuse(ctx, {
          check,
          onFail,
          issues: [
            preconditionIssue(
              "branchStatus",
              `${String(unsettled.length)} branch(es) settled badly and must be re-dispatched: ${unsettled.join(", ")}`,
            ),
          ],
        }),
      };
    },
  });
}
