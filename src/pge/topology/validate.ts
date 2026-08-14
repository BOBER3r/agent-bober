import type { z } from "zod";
import {
  FRONTIER_ONLY_ROLES,
  LIGHT_ONLY_ROLES,
  MAX_SUBGRAPH_DEPTH,
  TERMINAL_ENDPOINT,
  TopologySpecSchema,
  isKnownReducer,
  reducerProperties,
} from "../../contracts/topology.js";
import type {
  ChannelDecl,
  EdgeSpec,
  NodeRole,
  NodeSpec,
  TopologySpec,
} from "../../contracts/topology.js";
import { checksumTopology } from "./canonical.js";

/**
 * Structural validator for a topology artifact.
 *
 * `validateTopology` NEVER throws and NEVER performs a side effect — no filesystem,
 * no process spawn, no network, no clock. Zero node execution during validation is a
 * property of the module graph: the ESLint `no-restricted-imports` block scoped to
 * `src/pge/topology/**` AND to the layer's shared root `src/contracts/topology.ts`
 * forbids importing `src/pge/runtime/**`, `src/pge/nodes/**`, `src/orchestrator/**`,
 * `src/providers/**`, the root barrel `src/index.ts` (which re-exports the orchestrator
 * and every provider adapter), `node:child_process`/`node:worker_threads`, and the other
 * execution-capable layers — so an executor is not reachable from here even by accident.
 */

// ── Diagnostic codes ────────────────────────────────────────────────

/**
 * The closed diagnostic set. The 30 named structural codes come from the
 * architecture's TopologyValidator section. Two more are added, each with its own
 * fixture, as the contract's assumption permits:
 *  - `SchemaViolation` — `validateTopology` accepts `unknown` and must return a report
 *    (never throw) for input that is not even shaped like a topology.
 *  - `UnknownSchemaRef` — the `mode: "full"` counterpart of `UnknownPromptRef`. Without
 *    it the injected {@link SchemaCatalog}'s `has` is unreachable API surface and a
 *    `schemaRef` naming a schema that does not exist passes full-mode validation.
 */
export const DIAGNOSTIC_CODES = [
  "EmptyGraph",
  "DuplicateNodeId",
  "DuplicateEdgeId",
  "DanglingEdge",
  "UnreachableNode",
  "NoTerminalPath",
  "UndeclaredPort",
  "PortTypeMismatch",
  "UndeclaredChannel",
  "MissingReducer",
  "ChannelDeclMismatch",
  "MultipleWritersOnScalarChannel",
  "NonAssociativeReducerUnderFanOut",
  "UnboundedCycle",
  "UndeclaredRouteLabel",
  "RouterTargetNotDeclared",
  "BoundaryNotGated",
  "NestedCheckpointer",
  "SubgraphDepthExceeded",
  "SubgraphExitNotSupervisor",
  "CacheOnEffectfulNode",
  "InterruptInsideFanOut",
  "EffectfulNodeContainsHitl",
  "PromptRefOnToolNode",
  "MissingPromptRef",
  "UnknownPromptRef",
  "UnknownSchemaRef",
  "ModelTierMismatch",
  "ChecksumStale",
  "UndocumentedNode",
  "HitlWithoutOnReject",
  "SchemaViolation",
] as const;

export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

export type DiagnosticSeverity = "error" | "warn";

export interface ValidationDiagnostic {
  code: DiagnosticCode;
  severity: DiagnosticSeverity;
  message: string;
  nodeIds: string[];
  edgeIds: string[];
  path?: Array<string | number>;
}

export interface ValidationReport {
  ok: boolean;
  spec: TopologySpec | null;
  diagnostics: ValidationDiagnostic[];
}

// ── Injected resolvers (mode: "full") ───────────────────────────────

/** Resolves `schemaRef` strings. Injected so the validator stays filesystem-free. */
export interface SchemaCatalog {
  has(ref: string): boolean;
  /** True when a value produced under `fromRef` is accepted by `toRef`. */
  isAssignable(fromRef: string, toRef: string): boolean;
}

/** Resolves `promptRef` strings. Injected — the prompt store is a later sprint. */
export interface PromptRefSet {
  has(ref: string): boolean;
}

export type ValidationMode = "structural" | "full";

export interface ValidateTopologyOptions {
  mode?: ValidationMode;
  schemas?: SchemaCatalog;
  prompts?: PromptRefSet;
}

// ── Zod issue mapping ───────────────────────────────────────────────

function mapIssueToCode(issue: z.ZodIssue): DiagnosticCode {
  const path = issue.path;
  if (path.length === 1 && path[0] === "nodes" && issue.code === "too_small") {
    return "EmptyGraph";
  }
  if (path[0] === "subgraphs" && path[2] === "persistence" && issue.code === "invalid_literal") {
    return "NestedCheckpointer";
  }
  if (path[0] === "subgraphs" && path[2] === "depth" && issue.code === "too_big") {
    return "SubgraphDepthExceeded";
  }
  return "SchemaViolation";
}

function issueDiagnostic(issue: z.ZodIssue): ValidationDiagnostic {
  const code = mapIssueToCode(issue);
  const where = issue.path.length > 0 ? issue.path.join(".") : "<root>";
  const message =
    code === "EmptyGraph"
      ? "Topology declares no nodes; a graph must contain at least one node."
      : code === "NestedCheckpointer"
        ? `Subgraph at ${where} declares its own persistence; only "inherit" is representable (ADR-5 single checkpointer).`
        : code === "SubgraphDepthExceeded"
          ? `Subgraph at ${where} declares depth above the maximum of ${MAX_SUBGRAPH_DEPTH}.`
          : `Schema violation at ${where}: ${issue.message}`;
  return { code, severity: "error", message, nodeIds: [], edgeIds: [], path: [...issue.path] };
}

// ── Graph helpers ───────────────────────────────────────────────────

interface GraphIndex {
  nodesById: Map<string, NodeSpec>;
  nodeIndexById: Map<string, number>;
  channelsById: Map<string, ChannelDecl>;
  /**
   * Adjacency over edges whose endpoints resolve to declared nodes, PLUS the synthetic
   * edges derived from policy endpoints (see {@link policyEndpoints}). Recovery routes
   * are real control flow: leaving them out made a node reachable only via `onFail`
   * report `UnreachableNode`, and a node whose only terminal path is `onFail: "END"`
   * report `NoTerminalPath`.
   */
  outgoing: Map<string, EdgeSpec[]>;
  incoming: Map<string, EdgeSpec[]>;
  /**
   * Node ids from which the reserved terminal endpoint is directly reachable — via a
   * declared edge or via a policy endpoint whose value is `"END"`.
   */
  terminalNodeIds: Set<string>;
}

/**
 * A control-flow endpoint declared on a node policy rather than on `edges[]`.
 *
 * `gate.onFail`, `hitl.onReject` and `loop.onExhausted` are all typed `EndpointSchema`
 * ("a node id or END"). They are edges in everything but name, so they are resolved
 * like edges (`DanglingEdge`) and folded into the adjacency the reachability and
 * terminal-path rules walk.
 */
interface PolicyEndpoint {
  nodeId: string;
  nodeIndex: number;
  /** Field path under the node, e.g. `["gate", "onFail"]`. */
  field: string[];
  endpoint: string;
}

function policyEndpoints(spec: TopologySpec): PolicyEndpoint[] {
  const found: PolicyEndpoint[] = [];
  spec.nodes.forEach((node, nodeIndex) => {
    if (node.kind === "gate") {
      found.push({ nodeId: node.id, nodeIndex, field: ["gate", "onFail"], endpoint: node.gate.onFail });
    }
    if (node.hitl?.onReject !== undefined) {
      found.push({
        nodeId: node.id,
        nodeIndex,
        field: ["hitl", "onReject"],
        endpoint: node.hitl.onReject,
      });
    }
    if (node.loop !== undefined) {
      found.push({
        nodeId: node.id,
        nodeIndex,
        field: ["loop", "onExhausted"],
        endpoint: node.loop.onExhausted,
      });
    }
  });
  return found;
}

function buildIndex(spec: TopologySpec): GraphIndex {
  const nodesById = new Map<string, NodeSpec>();
  const nodeIndexById = new Map<string, number>();
  spec.nodes.forEach((node, index) => {
    if (!nodesById.has(node.id)) {
      nodesById.set(node.id, node);
      nodeIndexById.set(node.id, index);
    }
  });

  const channelsById = new Map<string, ChannelDecl>();
  for (const channel of spec.channels) {
    if (!channelsById.has(channel.id)) channelsById.set(channel.id, channel);
  }

  const outgoing = new Map<string, EdgeSpec[]>();
  const incoming = new Map<string, EdgeSpec[]>();
  const terminalNodeIds = new Set<string>();

  const link = (edge: EdgeSpec): void => {
    const out = outgoing.get(edge.from);
    if (out) out.push(edge);
    else outgoing.set(edge.from, [edge]);
    const inc = incoming.get(edge.to);
    if (inc) inc.push(edge);
    else incoming.set(edge.to, [edge]);
  };

  for (const edge of spec.edges) {
    const fromKnown = nodesById.has(edge.from);
    const toKnown = nodesById.has(edge.to);
    if (fromKnown && edge.to === TERMINAL_ENDPOINT) terminalNodeIds.add(edge.from);
    if (!fromKnown || !toKnown) continue;
    link(edge);
  }

  for (const policy of policyEndpoints(spec)) {
    if (policy.endpoint === TERMINAL_ENDPOINT) {
      terminalNodeIds.add(policy.nodeId);
      continue;
    }
    if (!nodesById.has(policy.endpoint)) continue; // reported as DanglingEdge
    link({
      id: `${policy.nodeId}#${policy.field.join(".")}`,
      from: policy.nodeId,
      to: policy.endpoint,
      kind: "normal",
    });
  }

  return { nodesById, nodeIndexById, channelsById, outgoing, incoming, terminalNodeIds };
}

function reachableFrom(
  index: GraphIndex,
  start: string,
  allow: (edge: EdgeSpec) => boolean,
): Set<string> {
  const seen = new Set<string>();
  if (!index.nodesById.has(start)) return seen;
  const stack = [start];
  seen.add(start);
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const edge of index.outgoing.get(current) ?? []) {
      if (!allow(edge)) continue;
      if (seen.has(edge.to)) continue;
      seen.add(edge.to);
      stack.push(edge.to);
    }
  }
  return seen;
}

/** Node ids from which the reserved terminal endpoint is reachable. */
function nodesThatReachTerminal(index: GraphIndex): Set<string> {
  const reaching = new Set<string>(index.terminalNodeIds);
  const stack = [...index.terminalNodeIds];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const edge of index.incoming.get(current) ?? []) {
      if (reaching.has(edge.from)) continue;
      reaching.add(edge.from);
      stack.push(edge.from);
    }
  }
  return reaching;
}

// ── Tarjan strongly connected components ────────────────────────────

export interface StronglyConnectedComponent {
  /** Member node ids, in declaration order. */
  nodeIds: string[];
  /** True when the component is a single node with an edge to itself. */
  selfLoop: boolean;
}

/**
 * Every cycle in the topology, as a strongly connected component. A component is a
 * cycle when it holds more than one node, or exactly one node with a self-edge.
 * Exported so a caller can walk cycles without re-deriving adjacency.
 */
export function findCycles(spec: TopologySpec): StronglyConnectedComponent[] {
  const index = buildIndex(spec);
  return findCyclesFromIndex(index, spec);
}

/**
 * @param scope  When given, only these node ids are traversed. Used by the cycle rule to
 *               re-examine what still cycles once the bounded nodes are removed.
 */
function findCyclesFromIndex(
  index: GraphIndex,
  spec: TopologySpec,
  scope?: ReadonlySet<string>,
): StronglyConnectedComponent[] {
  const ids = spec.nodes
    .map((node) => node.id)
    .filter((id, i, arr) => arr.indexOf(id) === i)
    .filter((id) => scope === undefined || scope.has(id));
  const order = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: StronglyConnectedComponent[] = [];
  let counter = 0;

  const inScope = (id: string): boolean => scope === undefined || scope.has(id);

  const selfLooped = new Set<string>();
  for (const edge of spec.edges) {
    if (edge.from === edge.to && index.nodesById.has(edge.from) && inScope(edge.from)) {
      selfLooped.add(edge.from);
    }
  }

  // Iterative Tarjan — a recursive walk would be bounded by node count, but an
  // iterative one keeps the validator stack-safe for any artifact size.
  for (const root of ids) {
    if (order.has(root)) continue;
    const work: Array<{ id: string; edgeIndex: number }> = [{ id: root, edgeIndex: 0 }];
    order.set(root, counter);
    low.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);

    while (work.length > 0) {
      const frame = work[work.length - 1];
      const edges = index.outgoing.get(frame.id) ?? [];
      if (frame.edgeIndex < edges.length) {
        const next = edges[frame.edgeIndex].to;
        frame.edgeIndex += 1;
        if (!inScope(next)) continue;
        if (!order.has(next)) {
          order.set(next, counter);
          low.set(next, counter);
          counter += 1;
          stack.push(next);
          onStack.add(next);
          work.push({ id: next, edgeIndex: 0 });
        } else if (onStack.has(next)) {
          low.set(frame.id, Math.min(low.get(frame.id) as number, order.get(next) as number));
        }
        continue;
      }

      work.pop();
      const parent = work.length > 0 ? work[work.length - 1] : undefined;
      if (parent) {
        low.set(parent.id, Math.min(low.get(parent.id) as number, low.get(frame.id) as number));
      }
      if (low.get(frame.id) === order.get(frame.id)) {
        const member: string[] = [];
        for (;;) {
          const popped = stack.pop() as string;
          onStack.delete(popped);
          member.push(popped);
          if (popped === frame.id) break;
        }
        const selfLoop = member.length === 1 && selfLooped.has(member[0]);
        if (member.length > 1 || selfLoop) {
          const ordered = ids.filter((id) => member.includes(id));
          components.push({ nodeIds: ordered, selfLoop });
        }
      }
    }
  }

  return components;
}

// ── Rule helpers ────────────────────────────────────────────────────

function diag(
  code: DiagnosticCode,
  message: string,
  nodeIds: string[] = [],
  edgeIds: string[] = [],
  path?: Array<string | number>,
): ValidationDiagnostic {
  return { code, severity: "error", message, nodeIds, edgeIds, path };
}

function hasDoc(node: NodeSpec): boolean {
  return typeof node.doc === "string" && node.doc.trim().length > 0;
}

function subgraphOf(node: NodeSpec | undefined): string | null {
  return node?.subgraph ?? null;
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Validate a topology artifact.
 *
 * `mode: "structural"` uses the artifact alone and is safe on a base-branch file
 * whose refs may not exist on head — that is the mode the CI diff gate uses.
 * `mode: "full"` additionally resolves `promptRef` through the injected
 * {@link PromptRefSet} and every `schemaRef` — on `channels[]` and on both port lists of
 * every node — through the injected {@link SchemaCatalog}, reporting `UnknownSchemaRef`
 * for a ref the catalog does not resolve and using `isAssignable` for port compatibility.
 *
 * Never throws, for any input.
 */
export function validateTopology(
  raw: unknown,
  opts: ValidateTopologyOptions = {},
): ValidationReport {
  try {
    return validateTopologyInner(raw, opts);
  } catch (error) {
    // Defence in depth: the contract is "never throws", so an unexpected internal
    // failure is reported as a diagnostic rather than propagated to the caller.
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      spec: null,
      diagnostics: [
        diag("SchemaViolation", `Topology could not be validated: ${message}`),
      ],
    };
  }
}

function validateTopologyInner(
  raw: unknown,
  opts: ValidateTopologyOptions,
): ValidationReport {
  const mode: ValidationMode = opts.mode ?? "structural";

  const parsed = TopologySpecSchema.safeParse(raw);
  if (!parsed.success) {
    const seen = new Set<string>();
    const diagnostics: ValidationDiagnostic[] = [];
    for (const issue of parsed.error.issues) {
      const candidate = issueDiagnostic(issue);
      const key = `${candidate.code}:${(candidate.path ?? []).join(".")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      diagnostics.push(candidate);
    }
    return { ok: false, spec: null, diagnostics };
  }

  const spec = parsed.data;
  const index = buildIndex(spec);
  const diagnostics: ValidationDiagnostic[] = [];

  collectDuplicateIds(spec, diagnostics);
  collectDanglingEndpoints(spec, index, diagnostics);
  const { fanOutRegion } = collectReachability(spec, index, diagnostics);
  collectChannelRules(spec, index, fanOutRegion, diagnostics);
  const unresolvedSchemaRefs = collectSchemaRefRules(spec, mode, opts.schemas, diagnostics);
  collectPortRules(spec, index, mode, opts.schemas, unresolvedSchemaRefs, diagnostics);
  collectCycleRules(spec, index, diagnostics);
  collectRoutingRules(spec, index, diagnostics);
  collectSubgraphRules(spec, index, diagnostics);
  collectNodePolicyRules(spec, fanOutRegion, diagnostics);
  collectChecksumRule(spec, diagnostics);

  if (mode === "full") {
    collectFullModeRules(spec, opts.prompts, diagnostics);
  }

  const ok = diagnostics.every((d) => d.severity !== "error");
  return { ok, spec, diagnostics };
}

// ── Rules ───────────────────────────────────────────────────────────

function collectDuplicateIds(spec: TopologySpec, out: ValidationDiagnostic[]): void {
  const nodeSeen = new Set<string>();
  spec.nodes.forEach((node, i) => {
    if (nodeSeen.has(node.id)) {
      out.push(
        diag("DuplicateNodeId", `Node id "${node.id}" is declared more than once.`, [node.id], [], [
          "nodes",
          i,
          "id",
        ]),
      );
      return;
    }
    nodeSeen.add(node.id);
  });

  const edgeSeen = new Set<string>();
  spec.edges.forEach((edge, i) => {
    if (edgeSeen.has(edge.id)) {
      out.push(
        diag("DuplicateEdgeId", `Edge id "${edge.id}" is declared more than once.`, [], [edge.id], [
          "edges",
          i,
          "id",
        ]),
      );
      return;
    }
    edgeSeen.add(edge.id);
  });
}

function collectDanglingEndpoints(
  spec: TopologySpec,
  index: GraphIndex,
  out: ValidationDiagnostic[],
): void {
  if (!index.nodesById.has(spec.entry)) {
    out.push(
      diag("DanglingEdge", `Graph entry "${spec.entry}" names no declared node.`, [], [], ["entry"]),
    );
  }
  spec.edges.forEach((edge, i) => {
    if (!index.nodesById.has(edge.from)) {
      out.push(
        diag(
          "DanglingEdge",
          `Edge "${edge.id}" originates at "${edge.from}", which names no declared node.`,
          [],
          [edge.id],
          ["edges", i, "from"],
        ),
      );
    }
    if (edge.to !== TERMINAL_ENDPOINT && !index.nodesById.has(edge.to)) {
      out.push(
        diag(
          "DanglingEdge",
          `Edge "${edge.id}" targets "${edge.to}", which names no declared node.`,
          [],
          [edge.id],
          ["edges", i, "to"],
        ),
      );
    }
  });

  // Policy endpoints are edges in everything but name — resolve them the same way.
  for (const policy of policyEndpoints(spec)) {
    if (policy.endpoint === TERMINAL_ENDPOINT) continue;
    if (index.nodesById.has(policy.endpoint)) continue;
    out.push(
      diag(
        "DanglingEdge",
        `Node "${policy.nodeId}" declares ${policy.field.join(".")} "${policy.endpoint}", which names no declared node.`,
        [policy.nodeId],
        [],
        ["nodes", policy.nodeIndex, ...policy.field],
      ),
    );
  }
}

function collectReachability(
  spec: TopologySpec,
  index: GraphIndex,
  out: ValidationDiagnostic[],
): { reachable: Set<string>; fanOutRegion: Set<string> } {
  if (!index.nodesById.has(spec.entry)) {
    // Entry is dangling — already reported. Reachability would produce a cascade of
    // noise, so it is skipped entirely rather than guessed at.
    return { reachable: new Set(), fanOutRegion: new Set() };
  }

  const reachable = reachableFrom(index, spec.entry, () => true);
  const withoutFanOut = reachableFrom(index, spec.entry, (edge) => edge.kind !== "fanout");
  const fanOutRegion = new Set<string>();
  for (const id of reachable) {
    if (!withoutFanOut.has(id)) fanOutRegion.add(id);
  }

  for (const node of index.nodesById.values()) {
    if (!reachable.has(node.id)) {
      const i = index.nodeIndexById.get(node.id) ?? 0;
      out.push(
        diag(
          "UnreachableNode",
          `Node "${node.id}" is not reachable from entry "${spec.entry}".`,
          [node.id],
          [],
          ["nodes", i],
        ),
      );
    }
  }

  const reachesTerminal = nodesThatReachTerminal(index);
  for (const id of reachable) {
    if (!reachesTerminal.has(id)) {
      const i = index.nodeIndexById.get(id) ?? 0;
      out.push(
        diag(
          "NoTerminalPath",
          `Node "${id}" is reachable but cannot reach the terminal endpoint "${TERMINAL_ENDPOINT}".`,
          [id],
          [],
          ["nodes", i],
        ),
      );
    }
  }

  return { reachable, fanOutRegion };
}

function collectChannelRules(
  spec: TopologySpec,
  index: GraphIndex,
  fanOutRegion: Set<string>,
  out: ValidationDiagnostic[],
): void {
  spec.channels.forEach((channel, i) => {
    if (!isKnownReducer(channel.reducerRef)) {
      out.push(
        diag(
          "MissingReducer",
          `Channel "${channel.id}" names reducer "${channel.reducerRef}", which is not in the closed reducer registry.`,
          [],
          [],
          ["channels", i, "reducerRef"],
        ),
      );
    }
  });

  const writersByChannel = new Map<string, string[]>();

  spec.nodes.forEach((node, i) => {
    for (const ref of node.reads) {
      if (!index.channelsById.has(ref)) {
        out.push(
          diag(
            "UndeclaredChannel",
            `Node "${node.id}" reads channel "${ref}", which is absent from channels[].`,
            [node.id],
            [],
            ["nodes", i, "reads"],
          ),
        );
      }
    }
    for (const ref of node.writes) {
      if (!index.channelsById.has(ref)) {
        out.push(
          diag(
            "ChannelDeclMismatch",
            `Node "${node.id}" writes channel "${ref}", which is absent from channels[].`,
            [node.id],
            [],
            ["nodes", i, "writes"],
          ),
        );
        continue;
      }
      const writers = writersByChannel.get(ref);
      if (writers) writers.push(node.id);
      else writersByChannel.set(ref, [node.id]);
    }
  });

  spec.channels.forEach((channel, i) => {
    // Own-property lookup: `KNOWN_REDUCERS["toString"]` would otherwise resolve through
    // the prototype chain to a truthy function whose `orderInvariant` is `undefined`,
    // firing a bogus NonAssociativeReducerUnderFanOut alongside the correct MissingReducer.
    const props = reducerProperties(channel.reducerRef);
    if (!props) return;
    const writers = writersByChannel.get(channel.id) ?? [];

    if (props.scalar && writers.length > 1) {
      out.push(
        diag(
          "MultipleWritersOnScalarChannel",
          `Scalar channel "${channel.id}" (reducer "${channel.reducerRef}") has ${writers.length} writers: ${writers.join(", ")}.`,
          writers,
          [],
          ["channels", i, "id"],
        ),
      );
    }

    if (!props.orderInvariant) {
      const inFanOut = writers.filter((id) => fanOutRegion.has(id));
      if (inFanOut.length > 0) {
        out.push(
          diag(
            "NonAssociativeReducerUnderFanOut",
            `Channel "${channel.id}" uses order-dependent reducer "${channel.reducerRef}" but is written inside a fan-out region by: ${inFanOut.join(", ")}.`,
            inFanOut,
            [],
            ["channels", i, "reducerRef"],
          ),
        );
      }
    }
  });
}

/**
 * `mode: "full"` resolves every `schemaRef` the artifact names — on `channels[]` and on
 * both port lists of every node — through the injected {@link SchemaCatalog}.
 * Returns the set of refs the catalog could not resolve, so the assignability check
 * downstream can stay silent about a ref that is already reported as unknown.
 */
function collectSchemaRefRules(
  spec: TopologySpec,
  mode: ValidationMode,
  schemas: SchemaCatalog | undefined,
  out: ValidationDiagnostic[],
): Set<string> {
  const unresolved = new Set<string>();
  if (mode !== "full" || !schemas) return unresolved;

  spec.channels.forEach((channel, i) => {
    if (schemas.has(channel.schemaRef)) return;
    unresolved.add(channel.schemaRef);
    out.push(
      diag(
        "UnknownSchemaRef",
        `Channel "${channel.id}" names schemaRef "${channel.schemaRef}", which the schema catalog does not resolve.`,
        [],
        [],
        ["channels", i, "schemaRef"],
      ),
    );
  });

  spec.nodes.forEach((node, i) => {
    for (const [listName, ports] of [
      ["inputPorts", node.inputPorts],
      ["outputPorts", node.outputPorts],
    ] as const) {
      ports.forEach((port, p) => {
        if (schemas.has(port.schemaRef)) return;
        unresolved.add(port.schemaRef);
        out.push(
          diag(
            "UnknownSchemaRef",
            `Node "${node.id}" declares ${listName} "${port.key}" with schemaRef "${port.schemaRef}", which the schema catalog does not resolve.`,
            [node.id],
            [],
            ["nodes", i, listName, p, "schemaRef"],
          ),
        );
      });
    }
  });

  return unresolved;
}

function collectPortRules(
  spec: TopologySpec,
  index: GraphIndex,
  mode: ValidationMode,
  schemas: SchemaCatalog | undefined,
  unresolvedSchemaRefs: Set<string>,
  out: ValidationDiagnostic[],
): void {
  spec.edges.forEach((edge, i) => {
    if (!edge.ports) return;
    const source = index.nodesById.get(edge.from);
    const target = index.nodesById.get(edge.to);
    if (!source || !target) return;

    const outputPort = source.outputPorts.find((p) => p.key === edge.ports?.from);
    const inputPort = target.inputPorts.find((p) => p.key === edge.ports?.to);

    if (!outputPort) {
      out.push(
        diag(
          "UndeclaredPort",
          `Edge "${edge.id}" binds output port "${edge.ports.from}", which node "${source.id}" does not declare.`,
          [source.id],
          [edge.id],
          ["edges", i, "ports", "from"],
        ),
      );
    }
    if (!inputPort) {
      out.push(
        diag(
          "UndeclaredPort",
          `Edge "${edge.id}" binds input port "${edge.ports.to}", which node "${target.id}" does not declare.`,
          [target.id],
          [edge.id],
          ["edges", i, "ports", "to"],
        ),
      );
    }
    if (!outputPort || !inputPort) return;
    // A ref the catalog could not resolve is already reported as UnknownSchemaRef;
    // asking `isAssignable` about it would add a second code for one defect.
    if (
      unresolvedSchemaRefs.has(outputPort.schemaRef) ||
      unresolvedSchemaRefs.has(inputPort.schemaRef)
    ) {
      return;
    }

    const compatible =
      mode === "full" && schemas
        ? schemas.isAssignable(outputPort.schemaRef, inputPort.schemaRef)
        : outputPort.schemaRef === inputPort.schemaRef;

    if (!compatible) {
      out.push(
        diag(
          "PortTypeMismatch",
          `Edge "${edge.id}": output port "${outputPort.key}" of "${source.id}" produces "${outputPort.schemaRef}" but input port "${inputPort.key}" of "${target.id}" requires "${inputPort.schemaRef}".`,
          [source.id, target.id],
          [edge.id],
          ["edges", i, "ports", "to"],
        ),
      );
    }
  });
}

/**
 * `LoopBoundSchema`'s contract is "EVERY cycle in the graph must contain one" — every
 * cycle, not every strongly connected component.
 *
 * Checking one bounded member per SCC is strictly weaker, and the gap is the shape this
 * topology is actually built from: a retry route (`gate.onFail`) that re-enters an
 * earlier node forms a cycle of its own INSIDE the supervisor's SCC, and that cycle
 * never passes through the supervisor, so the supervisor's `supervisorRounds` bound
 * does not bound it. A bounded member is therefore not a verdict on the component: it
 * is a verdict on the cycles that pass THROUGH it. Removing every bounded node and
 * re-running the search is exactly the documented contract — a cycle survives removal
 * if and only if it contains no bounded node.
 *
 * Terminates: each recursion drops at least one node from a finite set.
 */
function collectCycleRules(
  spec: TopologySpec,
  index: GraphIndex,
  out: ValidationDiagnostic[],
): void {
  const isBounded = (id: string): boolean => {
    const node = index.nodesById.get(id);
    return Boolean(node?.loop && node.loop.counterKey && node.loop.maxIterations >= 1);
  };

  const examine = (scope: ReadonlySet<string> | undefined): void => {
    for (const cycle of findCyclesFromIndex(index, spec, scope)) {
      if (!cycle.nodeIds.some(isBounded)) {
        out.push(
          diag(
            "UnboundedCycle",
            `Cycle [${cycle.nodeIds.join(" -> ")}] contains no node declaring counterKey and maxIterations.`,
            cycle.nodeIds,
          ),
        );
        continue;
      }
      const unbounded = new Set(cycle.nodeIds.filter((id) => !isBounded(id)));
      if (unbounded.size > 0) examine(unbounded);
    }
  };

  examine(undefined);
}

function collectRoutingRules(
  spec: TopologySpec,
  index: GraphIndex,
  out: ValidationDiagnostic[],
): void {
  const labelsByRouter = new Map<string, Set<string>>();
  for (const node of index.nodesById.values()) {
    if (node.kind !== "router") continue;
    labelsByRouter.set(node.id, new Set(node.targets.map((t) => t.label)));
  }

  spec.edges.forEach((edge, i) => {
    if (edge.label === undefined) return;
    const declared = labelsByRouter.get(edge.from);
    if (!declared) {
      if (!index.nodesById.has(edge.from)) return; // already DanglingEdge
      out.push(
        diag(
          "UndeclaredRouteLabel",
          `Edge "${edge.id}" carries label "${edge.label}" but "${edge.from}" is not a router.`,
          [edge.from],
          [edge.id],
          ["edges", i, "label"],
        ),
      );
      return;
    }
    if (!declared.has(edge.label)) {
      out.push(
        diag(
          "UndeclaredRouteLabel",
          `Edge "${edge.id}" carries label "${edge.label}", which router "${edge.from}" does not declare.`,
          [edge.from],
          [edge.id],
          ["edges", i, "label"],
        ),
      );
    }
  });

  spec.nodes.forEach((node, i) => {
    if (node.kind !== "router") return;
    node.targets.forEach((target, t) => {
      if (target.to === TERMINAL_ENDPOINT) return;
      if (index.nodesById.has(target.to)) return;
      out.push(
        diag(
          "RouterTargetNotDeclared",
          `Router "${node.id}" declares label "${target.label}" targeting "${target.to}", which names no declared node.`,
          [node.id],
          [],
          ["nodes", i, "targets", t, "to"],
        ),
      );
    });
  });
}

function collectSubgraphRules(
  spec: TopologySpec,
  index: GraphIndex,
  out: ValidationDiagnostic[],
): void {
  spec.edges.forEach((edge, i) => {
    const source = index.nodesById.get(edge.from);
    const target = index.nodesById.get(edge.to);
    if (!source || !target) return;
    if (subgraphOf(source) === subgraphOf(target)) return;
    if (source.kind === "gate" || target.kind === "gate") return;
    out.push(
      diag(
        "BoundaryNotGated",
        `Edge "${edge.id}" crosses the subgraph boundary ${subgraphOf(source) ?? "<root>"} -> ${subgraphOf(target) ?? "<root>"} without passing through a gate node.`,
        [source.id, target.id],
        [edge.id],
        ["edges", i],
      ),
    );
  });

  const supervisorId = spec.defaults.supervisorNodeId;

  /**
   * A FAN-IN BARRIER: the one node a subgraph exit gate may route to other than the
   * supervisor itself.
   *
   * A fanned-out subgraph exits once PER BRANCH, so a topology that fans out needs a
   * join between the per-branch exit gate and the single return to the supervisor.
   * Requiring `exitGate -> supervisor` unconditionally made that join unrepresentable
   * and pushed authors to relocate the barrier INSIDE the subgraph, where it is
   * instantiated per branch and therefore cannot join anything — the exact inversion
   * this rule exists to prevent.
   *
   * The invariant preserved is "control returns to the supervisor", now allowed to take
   * one declared hop. The barrier must be:
   *   - a `gate` node (a barrier is a gate, not a router: it has no branch labels), and
   *   - at the ROOT (`subgraph: null`) — a barrier inside any subgraph is per-instance
   *     and so cannot be a join, and
   *   - routed to the supervisor by EVERY one of its own declared edges, so the hop
   *     cannot become an escape route to somewhere else.
   * `gate.onFail` is deliberately not constrained: a barrier's failure path legitimately
   * re-enters the fan-out to retry a failed branch.
   */
  const isFanInBarrier = (nodeId: string): boolean => {
    const node = index.nodesById.get(nodeId);
    if (!node || node.kind !== "gate") return false;
    if (subgraphOf(node) !== null) return false;
    const outgoing = spec.edges.filter((e) => e.from === nodeId);
    return outgoing.length > 0 && outgoing.every((e) => e.to === supervisorId);
  };

  spec.subgraphs.forEach((sub, i) => {
    if (!index.nodesById.has(sub.exitGate)) return;
    // The RAW edge list, not `index.outgoing`: the adjacency deliberately excludes edges
    // to the reserved terminal, so walking it let `exitGate -> "END"` — an exit edge that
    // does not reach the supervisor — validate clean.
    for (const edge of spec.edges) {
      if (edge.from !== sub.exitGate) continue;
      if (edge.to === supervisorId) continue;
      if (isFanInBarrier(edge.to)) continue;
      out.push(
        diag(
          "SubgraphExitNotSupervisor",
          `Subgraph "${sub.id}" exit gate "${sub.exitGate}" routes to "${edge.to}" instead of the supervisor "${supervisorId}" or a root-level fan-in barrier gate that routes to it.`,
          [sub.exitGate, edge.to],
          [edge.id],
          ["subgraphs", i, "exitGate"],
        ),
      );
    }
  });

  // Actual nesting depth, derived from the call-site node of each subgraph rather
  // than from the declared `depth` field, so a hand-edited artifact cannot lie.
  const callSiteParent = new Map<string, string | null>();
  for (const node of index.nodesById.values()) {
    if (node.kind !== "subgraph") continue;
    if (!callSiteParent.has(node.subgraphRef)) {
      callSiteParent.set(node.subgraphRef, subgraphOf(node));
    }
  }

  const depthCache = new Map<string, number>();
  const resolveDepth = (id: string, seen: Set<string>): number => {
    const cached = depthCache.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return Number.POSITIVE_INFINITY;
    seen.add(id);
    const parent = callSiteParent.get(id);
    const depth = parent == null ? 1 : 1 + resolveDepth(parent, seen);
    depthCache.set(id, depth);
    return depth;
  };

  spec.subgraphs.forEach((sub, i) => {
    const actual = resolveDepth(sub.id, new Set());
    if (actual > MAX_SUBGRAPH_DEPTH) {
      out.push(
        diag(
          "SubgraphDepthExceeded",
          `Subgraph "${sub.id}" nests at depth ${actual}, above the maximum of ${MAX_SUBGRAPH_DEPTH}.`,
          [],
          [],
          ["subgraphs", i, "depth"],
        ),
      );
    }
  });
}

function collectNodePolicyRules(
  spec: TopologySpec,
  fanOutRegion: Set<string>,
  out: ValidationDiagnostic[],
): void {
  spec.nodes.forEach((node, i) => {
    if (node.cache && node.effects.length > 0) {
      out.push(
        diag(
          "CacheOnEffectfulNode",
          `Node "${node.id}" declares a cache policy but also declares effects: ${node.effects.join(", ")}.`,
          [node.id],
          [],
          ["nodes", i, "cache"],
        ),
      );
    }

    if (node.hitl) {
      if (fanOutRegion.has(node.id)) {
        out.push(
          diag(
            "InterruptInsideFanOut",
            `Node "${node.id}" raises a human-in-the-loop interrupt but is reachable only through a fan-out edge, so it runs once per concurrently-dispatched branch; the runtime holds one pending interrupt and one grant per checkpoint scope, so a second branch's approval evicts the first and the run cannot converge (arch-20260814-pge-full-convergence-adr-1). Move the interrupt to a node reachable only after the fan-out has joined.`,
            [node.id],
            [],
            ["nodes", i, "hitl"],
          ),
        );
      }
      if (node.effects.length > 0) {
        out.push(
          diag(
            "EffectfulNodeContainsHitl",
            `Node "${node.id}" declares effects (${node.effects.join(", ")}) and its own HITL interrupt; the approval must be a separate upstream node.`,
            [node.id],
            [],
            ["nodes", i, "hitl"],
          ),
        );
      }
      if (!node.hitl.onReject) {
        out.push(
          diag(
            "HitlWithoutOnReject",
            `Node "${node.id}" declares a HITL interrupt without an onReject endpoint.`,
            [node.id],
            [],
            ["nodes", i, "hitl", "onReject"],
          ),
        );
      }
    }

    if (node.kind === "tool" && node.promptRef !== undefined) {
      out.push(
        diag(
          "PromptRefOnToolNode",
          `Tool node "${node.id}" carries promptRef "${node.promptRef}"; tool nodes have no prompt.`,
          [node.id],
          [],
          ["nodes", i, "promptRef"],
        ),
      );
    }

    if (node.kind === "llm" && node.promptRef === undefined) {
      out.push(
        diag(
          "MissingPromptRef",
          `LLM node "${node.id}" declares no promptRef.`,
          [node.id],
          [],
          ["nodes", i, "promptRef"],
        ),
      );
    }

    // `role` is optional and defaults to "utility", which is in neither list — so a
    // kind:"router" node that simply omits `role` would escape the rule entirely. The
    // node KIND is authoritative where it implies a role.
    const effectiveRole: NodeRole = node.kind === "router" ? "router" : node.role;

    if (node.modelTier === "light" && FRONTIER_ONLY_ROLES.includes(effectiveRole)) {
      out.push(
        diag(
          "ModelTierMismatch",
          `Node "${node.id}" has role "${effectiveRole}" but declares the light model tier.`,
          [node.id],
          [],
          ["nodes", i, "modelTier"],
        ),
      );
    }
    if (node.modelTier === "frontier" && LIGHT_ONLY_ROLES.includes(effectiveRole)) {
      out.push(
        diag(
          "ModelTierMismatch",
          `Node "${node.id}" has role "${effectiveRole}" but declares the frontier model tier.`,
          [node.id],
          [],
          ["nodes", i, "modelTier"],
        ),
      );
    }

    if (!hasDoc(node)) {
      out.push(
        diag(
          "UndocumentedNode",
          `Node "${node.id}" carries no doc string.`,
          [node.id],
          [],
          ["nodes", i, "doc"],
        ),
      );
    }
  });
}

function collectChecksumRule(spec: TopologySpec, out: ValidationDiagnostic[]): void {
  const expected = checksumTopology(spec);
  if (spec.checksum !== expected) {
    out.push(
      diag(
        "ChecksumStale",
        `Artifact checksum ${spec.checksum} does not match the canonical form ${expected}.`,
        [],
        [],
        ["checksum"],
      ),
    );
  }
}

function collectFullModeRules(
  spec: TopologySpec,
  prompts: PromptRefSet | undefined,
  out: ValidationDiagnostic[],
): void {
  if (!prompts) return;
  spec.nodes.forEach((node, i) => {
    if (node.promptRef === undefined) return;
    if (prompts.has(node.promptRef)) return;
    out.push(
      diag(
        "UnknownPromptRef",
        `Node "${node.id}" names promptRef "${node.promptRef}", which the prompt set does not resolve.`,
        [node.id],
        [],
        ["nodes", i, "promptRef"],
      ),
    );
  });
}
