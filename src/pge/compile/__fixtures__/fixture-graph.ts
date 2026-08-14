import { z } from "zod";

import { TopologySpecSchema } from "../../../contracts/topology.js";
import type { NodeSpec, TopologySpec } from "../../../contracts/topology.js";
import { checksumTopology } from "../../topology/canonical.js";
import type { SchemaCatalog } from "../../topology/validate.js";
import { createEffectRegistry } from "../../registry/effects.js";
import { createNodeRegistry } from "../../registry/nodes.js";
import type { NodeImpl, NodeRegistry, PortBinding } from "../../registry/nodes.js";
import { createReducerRegistry } from "../../registry/reducers.js";
import type { Registries } from "../compiler.js";

/**
 * A small, genuinely valid topology plus the fixture registries that compile against it.
 *
 * The sprint's non-goals forbid registering a production node body, and forbid compiling
 * the real `coding` artifact (most of its implementations do not exist yet, so
 * `compile()` correctly refuses it — the first full-graph compile is sprint 13). What
 * the compiler tests need instead is a graph small enough to reason about and real
 * enough to be dishonest about nothing: this one passes `validateTopology` unmodified,
 * which `compiler.test.ts` asserts before it asserts anything else.
 *
 * Shape (entry `work_body`):
 *
 *   work_body ──▶ gate_work_in ──▶ draft ──▶ gate_work_out ──▶ supervisor ──▶ finalize ──▶ END
 *   └ root ┘      └───────────── subgraph "work" ───────────┘   └────────── root ─────────┘
 *
 * It exercises, on purpose: a subgraph region with gated boundaries, a router with
 * declared outcome labels, a scalar single-writer channel, a collection channel, ports
 * bound on both sides of an edge, and one node (`supervisor`) that declares no output
 * port at all.
 */

// ── Schema catalog ──────────────────────────────────────────────────

export const FIXTURE_SCHEMA_REFS = [
  "Counters",
  "FeatureRequest",
  "GraphMessage",
  "PlanSpec",
  "RunVerdict",
] as const;

/** Nominal catalog: a ref resolves iff it is in the closed list, and identity is assignability. */
export function fixtureSchemaCatalog(): SchemaCatalog {
  const known = new Set<string>(FIXTURE_SCHEMA_REFS);
  return {
    has: (ref) => known.has(ref),
    isAssignable: (from, to) => from === to,
  };
}

/**
 * The Zod schema each fixture `schemaRef` NAMES.
 *
 * Real schemas, not `z.unknown()`: `compile()` proves a bound port's ref resolves to the
 * implementation's own `inputSchema`/`outputSchema` by reference identity, and a fixture
 * where every schema is the same `z.unknown()` object could not tell a correct binding
 * from a wrong one — every comparison would succeed by accident.
 */
export const FIXTURE_SCHEMA_MODULES: ReadonlyMap<string, z.ZodType> = new Map<string, z.ZodType>([
  ["Counters", z.record(z.string(), z.number())],
  ["FeatureRequest", z.object({ request: z.string() })],
  ["GraphMessage", z.object({ id: z.string(), seq: z.number(), text: z.string() })],
  ["PlanSpec", z.object({ specId: z.string(), title: z.string() })],
  ["RunVerdict", z.object({ status: z.enum(["passed", "failed"]) })],
]);

// ── The artifact ────────────────────────────────────────────────────

const FIXTURE_NODES: NodeSpec[] = [
  {
    id: "work_body",
    kind: "subgraph",
    title: "Work subgraph call site",
    doc: "Root-level call site for the work subgraph and the graph entry point.",
    subgraph: null,
    role: "utility",
    inputPorts: [],
    outputPorts: [{ key: "request", schemaRef: "FeatureRequest", required: true }],
    reads: [],
    writes: [],
    effects: [],
    subgraphRef: "work",
  },
  {
    id: "gate_work_in",
    kind: "gate",
    title: "Work entry gate",
    doc: "Boundary gate admitting the feature request into the work subgraph.",
    subgraph: "work",
    role: "utility",
    inputPorts: [{ key: "request", schemaRef: "FeatureRequest", required: true }],
    outputPorts: [{ key: "request", schemaRef: "FeatureRequest", required: true }],
    reads: [],
    writes: [],
    effects: [],
    gate: { check: "feature-request-present", onFail: "finalize" },
  },
  {
    id: "draft",
    kind: "llm",
    title: "Draft the plan",
    doc: "Turns the feature request into a plan spec and records the exchange in messages.",
    subgraph: "work",
    role: "planner",
    modelTier: "frontier",
    promptRef: "plan/draft",
    inputPorts: [{ key: "request", schemaRef: "FeatureRequest", required: true }],
    outputPorts: [{ key: "draft", schemaRef: "PlanSpec", required: true }],
    reads: ["messages"],
    writes: ["messages", "spec", "counters"],
    effects: [],
  },
  {
    id: "gate_work_out",
    kind: "gate",
    title: "Work exit gate",
    doc: "Boundary gate returning control from the work subgraph to the supervisor.",
    subgraph: "work",
    role: "utility",
    inputPorts: [{ key: "draft", schemaRef: "PlanSpec", required: true }],
    outputPorts: [{ key: "draft", schemaRef: "PlanSpec", required: true }],
    reads: ["spec"],
    writes: [],
    effects: [],
    gate: { check: "spec-present", onFail: "finalize" },
  },
  {
    id: "supervisor",
    kind: "router",
    title: "Supervisor",
    doc: "Chooses the next region. In this fixture there is one outcome and it finishes the run.",
    subgraph: null,
    role: "router",
    modelTier: "light",
    inputPorts: [{ key: "draft", schemaRef: "PlanSpec", required: true }],
    outputPorts: [],
    reads: ["counters", "spec"],
    writes: ["counters"],
    effects: [],
    loop: { counterKey: "supervisorRounds", maxIterations: 4, onExhausted: "finalize" },
    targets: [{ label: "done", to: "finalize" }],
  },
  {
    id: "finalize",
    kind: "tool",
    title: "Finalize the run",
    doc: "Writes the terminal verdict and the completion marker; the single writer of the verdict channel.",
    subgraph: null,
    role: "utility",
    inputPorts: [],
    outputPorts: [{ key: "verdict", schemaRef: "RunVerdict", required: true }],
    reads: ["spec", "counters"],
    writes: ["verdict", "messages"],
    effects: ["fs-write"],
    toolRef: "run.finalize",
  },
];

const FIXTURE_UNSEALED: TopologySpec = {
  formatVersion: 1,
  graphId: "fixture",
  graphVersion: "1.0.0",
  description: "Compiler fixture: one gated subgraph region, one router, one terminal tool node.",
  provenance: "authored",
  entry: "work_body",
  defaults: {
    supervisorNodeId: "supervisor",
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
    {
      id: "spec",
      reducerRef: "replaceIfNewer",
      schemaRef: "PlanSpec",
      scope: "public",
      maxInlineBytes: 4096,
    },
    {
      id: "verdict",
      reducerRef: "replaceIfNewer",
      schemaRef: "RunVerdict",
      scope: "public",
      maxInlineBytes: 4096,
    },
  ],
  nodes: FIXTURE_NODES,
  edges: [
    {
      id: "e-entry",
      from: "work_body",
      to: "gate_work_in",
      kind: "normal",
      ports: { from: "request", to: "request" },
    },
    {
      id: "e-in-draft",
      from: "gate_work_in",
      to: "draft",
      kind: "normal",
      ports: { from: "request", to: "request" },
    },
    {
      id: "e-draft-out",
      from: "draft",
      to: "gate_work_out",
      kind: "normal",
      ports: { from: "draft", to: "draft" },
    },
    {
      id: "e-out-supervisor",
      from: "gate_work_out",
      to: "supervisor",
      kind: "normal",
      ports: { from: "draft", to: "draft" },
    },
    { id: "e-supervisor-finalize", from: "supervisor", to: "finalize", kind: "normal", label: "done" },
    { id: "e-finalize-end", from: "finalize", to: "END", kind: "normal" },
  ],
  checksum: `sha256:${"0".repeat(64)}`,
  subgraphs: [
    {
      id: "work",
      graphId: "fixture-work",
      depth: 1,
      entryGate: "gate_work_in",
      exitGate: "gate_work_out",
      persistence: "inherit",
    },
  ],
};

/**
 * A fresh, sealed copy of the fixture artifact.
 *
 * Fresh because the compiler tests mutate it (dropping a node, renaming a schemaRef),
 * and a shared object would leak one test's damage into the next. Sealed by
 * {@link checksumTopology} rather than by a hand-written hex constant, which would go
 * stale the first time the fixture is edited.
 */
export function fixtureSpec(): TopologySpec {
  // Round-tripped through the schema rather than deep-copied: the clone is re-parsed,
  // so a fixture that stopped matching `TopologySpecSchema` fails here rather than
  // surviving as a plausible-looking object the compiler tests would trust.
  const clone = TopologySpecSchema.parse(JSON.parse(JSON.stringify(FIXTURE_UNSEALED)) as unknown);
  return { ...clone, checksum: checksumTopology(clone) };
}

// ── Fixture node implementations ────────────────────────────────────

const NEVER_CALLED = "fixture node implementation was invoked; the compiler must not execute a node";

/**
 * A node body that exists to be REGISTERED, never to run.
 *
 * `compile()` resolves declarations; it does not execute. If the compiler ever grew a
 * call into a handler, every compiler test would fail loudly here rather than quietly
 * passing.
 */
/**
 * The schema an honest implementation declares for a port it binds: the one its
 * `schemaRef` resolves to. A side that binds nothing parses nothing, hence `z.unknown()`.
 */
function schemaFor(binding: PortBinding | null): z.ZodType {
  if (!binding) return z.unknown();
  return FIXTURE_SCHEMA_MODULES.get(binding.schemaRef) ?? z.unknown();
}

function fixtureImpl(
  id: string,
  kind: NodeImpl["kind"],
  inputPort: PortBinding | null,
  outputPort: PortBinding | null,
  schemas: { inputSchema?: z.ZodType; outputSchema?: z.ZodType } = {},
): NodeImpl {
  return {
    id,
    kind,
    inputPort,
    outputPort,
    inputSchema: schemas.inputSchema ?? schemaFor(inputPort),
    outputSchema: schemas.outputSchema ?? schemaFor(outputPort),
    handler: async () => {
      throw new Error(`${NEVER_CALLED} (${id})`);
    },
  };
}

/** The port bindings each fixture implementation declares, mirroring the artifact. */
export const FIXTURE_IMPL_PORTS: Record<
  string,
  { kind: NodeImpl["kind"]; input: PortBinding | null; output: PortBinding | null }
> = {
  work_body: {
    kind: "subgraph",
    input: null,
    output: { key: "request", schemaRef: "FeatureRequest" },
  },
  gate_work_in: {
    kind: "gate",
    input: { key: "request", schemaRef: "FeatureRequest" },
    output: { key: "request", schemaRef: "FeatureRequest" },
  },
  draft: {
    kind: "llm",
    input: { key: "request", schemaRef: "FeatureRequest" },
    output: { key: "draft", schemaRef: "PlanSpec" },
  },
  gate_work_out: {
    kind: "gate",
    input: { key: "draft", schemaRef: "PlanSpec" },
    output: { key: "draft", schemaRef: "PlanSpec" },
  },
  supervisor: {
    kind: "router",
    input: { key: "draft", schemaRef: "PlanSpec" },
    output: null,
  },
  finalize: {
    kind: "tool",
    input: null,
    output: { key: "verdict", schemaRef: "RunVerdict" },
  },
};

/** A registry holding one implementation per fixture node, unless `omit` says otherwise. */
export function fixtureNodeRegistry(opts: { omit?: readonly string[] } = {}): NodeRegistry {
  const omit = new Set(opts.omit ?? []);
  const registry = createNodeRegistry();
  for (const [id, ports] of Object.entries(FIXTURE_IMPL_PORTS)) {
    if (omit.has(id)) continue;
    registry.register(fixtureImpl(id, ports.kind, ports.input, ports.output));
  }
  return registry;
}

/** Register an extra implementation the artifact knows nothing about. */
export function registerOrphanImpl(registry: NodeRegistry, id: string): void {
  registry.register(fixtureImpl(id, "tool", null, null));
}

/** Register an implementation whose port binding disagrees with the artifact. */
export function registerMismatchedImpl(
  registry: NodeRegistry,
  id: string,
  input: PortBinding | null,
  output: PortBinding | null,
): void {
  const ports = FIXTURE_IMPL_PORTS[id];
  registry.register(fixtureImpl(id, ports.kind, input, output));
}

/**
 * Register an implementation whose port bindings are CORRECT — right keys, right
 * `schemaRef` strings — but whose Zod schemas are not the ones those refs name.
 *
 * This is the drift `PortBinding.schemaRef` alone cannot catch: the binding says the
 * right thing about itself while the handler parses with something else entirely.
 */
export function registerWrongSchemaImpl(
  registry: NodeRegistry,
  id: string,
  schemas: { inputSchema?: z.ZodType; outputSchema?: z.ZodType },
): void {
  const ports = FIXTURE_IMPL_PORTS[id];
  registry.register(fixtureImpl(id, ports.kind, ports.input, ports.output, schemas));
}

/**
 * Full fixture registries, with the schema catalog and the schema module map attached
 * unless they are opted out.
 */
export function fixtureRegistries(
  opts: {
    nodes?: NodeRegistry;
    schemas?: SchemaCatalog | null;
    schemaModules?: ReadonlyMap<string, z.ZodType> | null;
  } = {},
): Registries {
  return {
    nodes: opts.nodes ?? fixtureNodeRegistry(),
    reducers: createReducerRegistry(),
    effects: createEffectRegistry(),
    schemas: opts.schemas === null ? undefined : (opts.schemas ?? fixtureSchemaCatalog()),
    schemaModules:
      opts.schemaModules === null ? undefined : (opts.schemaModules ?? FIXTURE_SCHEMA_MODULES),
  };
}
