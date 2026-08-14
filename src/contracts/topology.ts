import { z } from "zod";

/**
 * Topology data contract for the Prompt Graph Engineering (PGE) execution layer.
 *
 * This module is PURE DATA. It defines, as Zod, every legal node kind, edge kind,
 * port, channel, policy and route label a topology artifact may contain. It imports
 * nothing but `zod` and is never allowed to reach an executor — the ESLint
 * `no-restricted-imports` boundary covers `src/pge/topology/**` AND this file (the
 * layer's shared root, imported by every file in that subtree), so zero-execution
 * during validation is a property of the module graph rather than of an assertion.
 *
 * See `.bober/architecture/arch-20260805-pge-graph-engineering-architecture.md`
 * and ADR-2 / ADR-3 / ADR-4 / ADR-5 / ADR-6.
 */

// ── Reserved endpoints ──────────────────────────────────────────────

/**
 * The single reserved terminal endpoint. An edge whose `to` is `"END"` terminates
 * a path; `END` is never a declared node, so endpoint resolution treats it specially.
 */
export const TERMINAL_ENDPOINT = "END";

/** A node id or the reserved {@link TERMINAL_ENDPOINT}. */
export const EndpointSchema = z.string().min(1);
export type Endpoint = z.infer<typeof EndpointSchema>;

// ── Enums ───────────────────────────────────────────────────────────

export const NODE_KINDS = ["llm", "tool", "gate", "router", "subgraph"] as const;
export const NodeKindSchema = z.enum(NODE_KINDS);
export type NodeKind = z.infer<typeof NodeKindSchema>;

/**
 * What a node body may do to the world outside the graph.
 *
 * `sandbox-exec` is a process executed through `SandboxRunner` under a config-derived
 * allowlist, with cwd confinement, a denylist enforced by the runner itself and a kill
 * timeout — NOT the deploy path, which is `process-exec` and stays gated. The distinction
 * exists because running the project's own configured typecheck/lint/test command and
 * shipping to production are categorically different acts, and requiring a human approval
 * before every typecheck would make the approval gate meaningless in the other direction.
 */
export const EFFECT_TAGS = [
  "fs-write",
  "git",
  "network",
  "process-exec",
  "sandbox-exec",
] as const;
export const EffectTagSchema = z.enum(EFFECT_TAGS);
export type EffectTag = z.infer<typeof EffectTagSchema>;

export const MODEL_TIERS = ["light", "frontier"] as const;
export const ModelTierSchema = z.enum(MODEL_TIERS);
export type ModelTier = z.infer<typeof ModelTierSchema>;

export const EDGE_KINDS = ["normal", "conditional", "fanout"] as const;
export const EdgeKindSchema = z.enum(EDGE_KINDS);
export type EdgeKind = z.infer<typeof EdgeKindSchema>;

export const CHANNEL_SCOPES = ["public", "private"] as const;
export const ChannelScopeSchema = z.enum(CHANNEL_SCOPES);
export type ChannelScope = z.infer<typeof ChannelScopeSchema>;

export const PROVENANCES = ["authored", "optimizer"] as const;
export const ProvenanceSchema = z.enum(PROVENANCES);
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const DURABILITY_TIERS = ["exit", "superstep"] as const;
export const DurabilitySchema = z.enum(DURABILITY_TIERS);
export type Durability = z.infer<typeof DurabilitySchema>;

/**
 * Node roles. The role is what makes `ModelTierMismatch` mechanically checkable:
 * heavyweight reasoning roles may not run on the light tier and cheap classification
 * roles may not burn the frontier tier.
 */
export const NODE_ROLES = [
  "planner",
  "architect",
  "generator",
  "terminal-evaluator",
  "curator",
  "researcher",
  "reviewer",
  "documenter",
  "classifier",
  "syntax",
  "router",
  "utility",
] as const;
export const NodeRoleSchema = z.enum(NODE_ROLES);
export type NodeRole = z.infer<typeof NodeRoleSchema>;

/** Roles that must never declare the `light` tier. */
export const FRONTIER_ONLY_ROLES: readonly NodeRole[] = [
  "planner",
  "architect",
  "generator",
  "terminal-evaluator",
];

/** Roles that must never declare the `frontier` tier. */
export const LIGHT_ONLY_ROLES: readonly NodeRole[] = ["router", "classifier", "syntax"];

// ── Reducer registry (declarative half) ─────────────────────────────

/**
 * Structural properties of a registered reducer, as far as the topology layer can
 * see them. The executable half lives in `src/pge/registry/reducers.ts` (a later
 * sprint) and must not be imported here.
 */
export interface ReducerProperties {
  /** A reducer is fan-in safe only when the committed result is independent of arrival order. */
  readonly orderInvariant: boolean;
  /** A scalar channel holds one value, so a second writer is a topology error. */
  readonly scalar: boolean;
}

/**
 * The closed reducer registry (ADR-4). `listAppend` is deliberately present and
 * deliberately NOT order-invariant: it is legal outside a fan-out region and is what
 * `NonAssociativeReducerUnderFanOut` exists to catch inside one.
 */
export const KNOWN_REDUCERS: Readonly<Record<string, ReducerProperties>> = Object.freeze({
  appendById: { orderInvariant: true, scalar: false },
  maxNumber: { orderInvariant: true, scalar: false },
  lastWriteWinsByKey: { orderInvariant: true, scalar: false },
  setUnion: { orderInvariant: true, scalar: false },
  mergeLedger: { orderInvariant: true, scalar: false },
  replaceIfNewer: { orderInvariant: false, scalar: true },
  listAppend: { orderInvariant: false, scalar: false },
});

/** Every reducer id the topology layer will accept in `channels[].reducerRef`. */
export const REDUCER_REFS: readonly string[] = Object.freeze(Object.keys(KNOWN_REDUCERS));

/**
 * Own-property lookup into {@link KNOWN_REDUCERS}.
 *
 * `Object.freeze` does NOT sever the prototype chain, so a plain `KNOWN_REDUCERS[ref]`
 * resolves inherited members — `"toString"`, `"constructor"`, `"valueOf"`,
 * `"hasOwnProperty"`, `"isPrototypeOf"` — to truthy `Object.prototype` values whose
 * `orderInvariant`/`scalar` are `undefined`. Every reducer lookup MUST go through this
 * helper so a typo'd reducer name yields exactly `MissingReducer` and never a spurious
 * second diagnostic.
 */
export function reducerProperties(ref: string): ReducerProperties | undefined {
  return Object.prototype.hasOwnProperty.call(KNOWN_REDUCERS, ref)
    ? KNOWN_REDUCERS[ref]
    : undefined;
}

/** True when `ref` is an own member of the closed reducer registry. */
export function isKnownReducer(ref: string): boolean {
  return Object.prototype.hasOwnProperty.call(KNOWN_REDUCERS, ref);
}

/** Maximum legal subgraph nesting depth (ADR-5 supervisor topology). */
export const MAX_SUBGRAPH_DEPTH = 2;

/** Default per-channel inline byte cap before a value must be offloaded to scratch. */
export const DEFAULT_MAX_INLINE_BYTES = 4096;

// ── Leaf schemas ────────────────────────────────────────────────────

/**
 * A router outcome label bound to a destination (ADR-3). The router body selects a
 * label; it is structurally unable to name a node id, which is what makes a
 * structural diff of routing meaningful.
 */
export const RouteTargetSchema = z.object({
  label: z.string().min(1),
  to: EndpointSchema,
});
export type RouteTarget = z.infer<typeof RouteTargetSchema>;

/** A declared loop bound. Every cycle in the graph must contain one. */
export const LoopBoundSchema = z.object({
  counterKey: z.string().min(1),
  maxIterations: z.number().int().min(1),
  onExhausted: EndpointSchema,
});
export type LoopBound = z.infer<typeof LoopBoundSchema>;

export const PortSchema = z.object({
  key: z.string().min(1),
  schemaRef: z.string().min(1),
  required: z.boolean().default(true),
});
export type Port = z.infer<typeof PortSchema>;

/**
 * Channel declaration. `writers`/`readers` are deliberately absent — they are DERIVED
 * from `nodes[].writes/reads` so the state audit has a single encoding to read
 * (ADR-4). `ChannelDeclMismatch` guards the one remaining cross-reference.
 */
export const ChannelDeclSchema = z.object({
  id: z.string().min(1),
  reducerRef: z.string(),
  schemaRef: z.string().min(1),
  scope: ChannelScopeSchema,
  maxInlineBytes: z.number().int().min(1).default(DEFAULT_MAX_INLINE_BYTES),
});
export type ChannelDecl = z.infer<typeof ChannelDeclSchema>;

/** Only nodes whose `effects` array is empty may declare a cache policy. */
export const CachePolicySchema = z.object({
  ttlSeconds: z.number().int().min(1),
  scope: z.enum(["run", "global"]).default("run"),
});
export type CachePolicy = z.infer<typeof CachePolicySchema>;

/** Human-in-the-loop policy. `onReject` is required in practice — see `HitlWithoutOnReject`. */
export const HitlPolicySchema = z.object({
  checkpointId: z.string().min(1),
  onReject: EndpointSchema.optional(),
});
export type HitlPolicy = z.infer<typeof HitlPolicySchema>;

export const GatePolicySchema = z.object({
  check: z.string().min(1),
  onFail: EndpointSchema,
});
export type GatePolicy = z.infer<typeof GatePolicySchema>;

// ── Node union ──────────────────────────────────────────────────────

const nodeBase = {
  id: z.string().min(1),
  title: z.string().min(1),
  /** Prose documentation. Absent or blank ⇒ `UndocumentedNode`. */
  doc: z.string().min(1).optional(),
  /** Id of the containing subgraph, or `null` for a top-level node. */
  subgraph: z.string().min(1).nullable().default(null),
  role: NodeRoleSchema.default("utility"),
  modelTier: ModelTierSchema.optional(),
  /**
   * Required on `llm` nodes (`MissingPromptRef`), forbidden on `tool` nodes
   * (`PromptRefOnToolNode`). It lives on the base so both violations surface as
   * named diagnostics rather than as raw Zod issues.
   */
  promptRef: z.string().min(1).optional(),
  inputPorts: z.array(PortSchema).default([]),
  outputPorts: z.array(PortSchema).default([]),
  reads: z.array(z.string().min(1)).default([]),
  writes: z.array(z.string().min(1)).default([]),
  effects: z.array(EffectTagSchema).default([]),
  cache: CachePolicySchema.optional(),
  hitl: HitlPolicySchema.optional(),
  loop: LoopBoundSchema.optional(),
};

export const LlmNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("llm"),
  modelTier: ModelTierSchema,
});
export type LlmNode = z.infer<typeof LlmNodeSchema>;

export const ToolNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("tool"),
  toolRef: z.string().min(1),
});
export type ToolNode = z.infer<typeof ToolNodeSchema>;

export const GateNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("gate"),
  gate: GatePolicySchema,
});
export type GateNode = z.infer<typeof GateNodeSchema>;

export const RouterNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("router"),
  targets: z.array(RouteTargetSchema).min(1),
});
export type RouterNode = z.infer<typeof RouterNodeSchema>;

export const SubgraphNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("subgraph"),
  subgraphRef: z.string().min(1),
});
export type SubgraphNode = z.infer<typeof SubgraphNodeSchema>;

export const NodeSchema = z.discriminatedUnion("kind", [
  LlmNodeSchema,
  ToolNodeSchema,
  GateNodeSchema,
  RouterNodeSchema,
  SubgraphNodeSchema,
]);
export type NodeSpec = z.infer<typeof NodeSchema>;

// ── Edges ───────────────────────────────────────────────────────────

/** Binds a source node output port key to a target node input port key. */
export const EdgePortBindingSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});
export type EdgePortBinding = z.infer<typeof EdgePortBindingSchema>;

export const EdgeSchema = z.object({
  id: z.string().min(1),
  from: EndpointSchema,
  to: EndpointSchema,
  kind: EdgeKindSchema.default("normal"),
  /** Set only on edges leaving a router; must be one of that router's declared labels. */
  label: z.string().min(1).optional(),
  ports: EdgePortBindingSchema.optional(),
});
export type EdgeSpec = z.infer<typeof EdgeSchema>;

// ── Subgraphs ───────────────────────────────────────────────────────

/**
 * `persistence` is `z.literal("inherit")` so a nested checkpointer is UNREPRESENTABLE
 * rather than merely checked (ADR-5). `NestedCheckpointer` exists only to give
 * hand-edited JSON a named diagnostic instead of a raw Zod issue.
 */
export const SubgraphDeclSchema = z.object({
  id: z.string().min(1),
  graphId: z.string().min(1),
  depth: z.number().int().min(1).max(MAX_SUBGRAPH_DEPTH),
  entryGate: z.string().min(1),
  exitGate: z.string().min(1),
  persistence: z.literal("inherit"),
});
export type SubgraphDecl = z.infer<typeof SubgraphDeclSchema>;

// ── Graph defaults ──────────────────────────────────────────────────

export const GraphDefaultsSchema = z.object({
  /** Every subgraph exit edge must target this node. */
  supervisorNodeId: z.string().min(1),
  modelTier: ModelTierSchema.default("light"),
  concurrency: z.number().int().min(1).default(1),
  durability: DurabilitySchema.default("superstep"),
  maxInlineBytes: z.number().int().min(1).default(DEFAULT_MAX_INLINE_BYTES),
});
export type GraphDefaults = z.infer<typeof GraphDefaultsSchema>;

// ── TopologySpec ────────────────────────────────────────────────────

export const CHECKSUM_PATTERN = /^sha256:[0-9a-f]{64}$/;
export const GRAPH_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

export const TopologySpecSchema = z.object({
  formatVersion: z.literal(1),
  graphId: z.string().min(1),
  graphVersion: z.string().regex(GRAPH_VERSION_PATTERN),
  description: z.string().min(1),
  provenance: ProvenanceSchema.default("authored"),
  entry: EndpointSchema,
  defaults: GraphDefaultsSchema,
  channels: z.array(ChannelDeclSchema),
  nodes: z.array(NodeSchema).min(1),
  edges: z.array(EdgeSchema),
  checksum: z.string().regex(CHECKSUM_PATTERN),
  subgraphs: z.array(SubgraphDeclSchema),
});
export type TopologySpec = z.infer<typeof TopologySpecSchema>;

// ── Narrowing helpers ───────────────────────────────────────────────

export function isLlmNode(node: NodeSpec): node is LlmNode {
  return node.kind === "llm";
}

export function isToolNode(node: NodeSpec): node is ToolNode {
  return node.kind === "tool";
}

export function isGateNode(node: NodeSpec): node is GateNode {
  return node.kind === "gate";
}

export function isRouterNode(node: NodeSpec): node is RouterNode {
  return node.kind === "router";
}

export function isSubgraphNode(node: NodeSpec): node is SubgraphNode {
  return node.kind === "subgraph";
}

/** True when the endpoint is the reserved terminal rather than a node id. */
export function isTerminalEndpoint(endpoint: string): boolean {
  return endpoint === TERMINAL_ENDPOINT;
}
