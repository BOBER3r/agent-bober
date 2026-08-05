import type { z } from "zod";

import { TERMINAL_ENDPOINT } from "../../contracts/topology.js";
import type {
  ChannelDecl,
  EdgeSpec,
  NodeSpec,
  Port,
  SubgraphDecl,
  TopologySpec,
} from "../../contracts/topology.js";
import { readTopologyArtifact, topologyArtifactPath } from "../topology/dump.js";
import { validateTopology } from "../topology/validate.js";
import type {
  DiagnosticCode,
  SchemaCatalog,
  ValidationDiagnostic,
} from "../topology/validate.js";
import type { EffectRegistry } from "../registry/effects.js";
import type { NodeImpl, NodeRegistry, PortBinding } from "../registry/nodes.js";
import type { Reducer, ReducerRegistry } from "../registry/reducers.js";

/**
 * The topology compiler: a validated artifact plus registries in, a `CompiledGraph` out.
 *
 * ── What it is for ──
 *
 * The artifact is stringly typed by design — `reducerRef`, `schemaRef`, `promptRef`,
 * node ids — which buys a diffable, versionable, CI-gateable structure and costs
 * compile-time safety. `compile()` is where that cost is paid back: every reference it
 * owns is resolved here, and an unresolved one is a loud failure at load time rather
 * than a `TypeError` forty minutes into a run.
 *
 * ── Both directions, or it is not a check ──
 *
 * A compiler that only checks "every node in the artifact has an implementation" lets a
 * registered implementation drift out of the graph and keep running in someone's head.
 * `compile()` fails on `UnregisteredNodeImpl` AND on `OrphanNodeImpl`, so the artifact
 * and the registry are provably the same set of nodes. `compilerFidelity.test.ts` then
 * asserts the same thing about the compiled OUTPUT, with the spec authoritative in both
 * directions.
 *
 * ── Which references live where ──
 *
 *  - node id → `NodeImpl`      : here (`UnregisteredNodeImpl` / `OrphanNodeImpl`)
 *  - `reducerRef` → `Reducer`   : here (`MissingReducer`)
 *  - `schemaRef` on a port      : here, against the implementation's declared binding
 *                                 (`NodeImplPortMismatch`), against the injected catalog
 *                                 when one is supplied (`UnknownSchemaRef`), and — when
 *                                 {@link Registries.schemaModules} is supplied — against
 *                                 the implementation's OWN `inputSchema`/`outputSchema`
 *                                 by reference identity (`NodeImplPortMismatch`), so the
 *                                 binding cannot merely assert a string about itself
 *  - `reads` / `writes` → channel: here (`UndeclaredChannel` / `ChannelDeclMismatch`)
 *  - `promptRef` → prompt store : `validateTopology(mode: "full")` (`UnknownPromptRef`)
 *  - `toolRef` → tool binding   : the node implementation's own concern; a tool node's
 *                                 `toolRef` names its tool, not an effect, so the effect
 *                                 registry is not the namespace that resolves it.
 */

// ── Diagnostics ─────────────────────────────────────────────────────

/**
 * Codes the compiler alone can emit. Everything else it reports reuses a
 * {@link DiagnosticCode} from the validator, so one defect never has two names
 * depending on which layer noticed it.
 */
export const COMPILE_DIAGNOSTIC_CODES = [
  "UnregisteredNodeImpl",
  "OrphanNodeImpl",
  "NodeKindMismatch",
  "NodeImplPortMismatch",
  "DuplicateChannelId",
] as const;
export type CompileOnlyDiagnosticCode = (typeof COMPILE_DIAGNOSTIC_CODES)[number];

export type CompileDiagnosticCode = CompileOnlyDiagnosticCode | DiagnosticCode;

/**
 * Structurally a {@link ValidationDiagnostic} with a widened code and an optional port
 * key, so a validator diagnostic can be carried through {@link loadCompiledGraph}
 * verbatim rather than being flattened into a string.
 */
export interface CompileDiagnostic extends Omit<ValidationDiagnostic, "code"> {
  code: CompileDiagnosticCode;
  /** Set when the diagnostic is about one declared port. */
  portKey?: string;
}

/** Compilation failed. Carries every diagnostic, not just the first. */
export class TopologyCompileError extends Error {
  readonly diagnostics: readonly CompileDiagnostic[];

  constructor(message: string, diagnostics: readonly CompileDiagnostic[]) {
    super(message);
    this.name = "TopologyCompileError";
    this.diagnostics = diagnostics;
  }

  /** True when any diagnostic carries `code`. */
  has(code: CompileDiagnosticCode): boolean {
    return this.diagnostics.some((d) => d.code === code);
  }
}

// ── Compiled shapes ─────────────────────────────────────────────────

export interface CompiledNode {
  readonly spec: NodeSpec;
  readonly impl: NodeImpl;
}

export interface CompiledChannel {
  readonly decl: ChannelDecl;
  readonly reducer: Reducer<unknown>;
}

export interface CompiledGraph {
  /**
   * The artifact this graph was compiled from.
   *
   * A subgraph's `spec` is the SAME artifact as its parent's: a subgraph is a region of
   * one topology — one checksum, one channel set, one checkpointer (ADR-5) — not a
   * separate artifact that happens to be nested.
   */
  readonly spec: TopologySpec;
  readonly nodes: ReadonlyMap<string, CompiledNode>;
  /** Outgoing edges per node id, in declaration order. Nodes with none are absent. */
  readonly adjacency: ReadonlyMap<string, readonly EdgeSpec[]>;
  readonly channels: ReadonlyMap<string, CompiledChannel>;
  /** Compiled regions, keyed by subgraph declaration id. */
  readonly subgraphs: ReadonlyMap<string, CompiledGraph>;
}

export interface Registries {
  nodes: NodeRegistry;
  reducers: ReducerRegistry;
  /**
   * Carried for the interpreter's convenience and not consulted here: a node's declared
   * `effects` are TAGS, which the effect registry checks at invocation time against the
   * effect's own tags. There is no artifact string for `compile()` to resolve against it.
   */
  effects?: EffectRegistry;
  /** When supplied, every `schemaRef` an implementation binds must resolve through it. */
  schemas?: SchemaCatalog;
  /**
   * `schemaRef` → the Zod schema that ref NAMES, when the caller can resolve one.
   *
   * {@link SchemaCatalog} answers `has` and `isAssignable` over ref STRINGS and cannot
   * hand back a schema, so without this map the port check compares
   * `Port.schemaRef` against `PortBinding.schemaRef` — two strings, one of which the
   * implementation writes about itself. That proves the implementation AGREES with the
   * artifact about a name, not that the Zod schema it will actually parse the payload
   * with is the one the name resolves to. With the map supplied, `compile()` closes the
   * gap by reference identity: the schema behind a bound port's ref must BE the
   * implementation's own `inputSchema`/`outputSchema` (sc-5-9).
   */
  schemaModules?: ReadonlyMap<string, z.ZodType>;
}

// ── Helpers ─────────────────────────────────────────────────────────

function diag(
  code: CompileDiagnosticCode,
  message: string,
  nodeIds: string[] = [],
  edgeIds: string[] = [],
  path?: Array<string | number>,
  portKey?: string,
): CompileDiagnostic {
  return { code, severity: "error", message, nodeIds, edgeIds, path, portKey };
}

interface PortSide {
  /** `"input"` or `"output"`, used verbatim in messages. */
  readonly side: "input" | "output";
  readonly declared: readonly Port[];
  readonly bound: PortBinding | null;
  /** The implementation's own `inputSchema`/`outputSchema` for this side. */
  readonly implSchema: z.ZodType<unknown>;
  readonly listName: "inputPorts" | "outputPorts";
  /** `"inputSchema"` or `"outputSchema"`, used verbatim in messages. */
  readonly implSchemaName: "inputSchema" | "outputSchema";
}

/**
 * One side of one node's port contract.
 *
 * Every branch names the node id AND the port key, because "the schemas do not match"
 * without both is an unactionable message on a forty-node graph.
 */
function checkPortSide(
  node: NodeSpec,
  nodeIndex: number,
  side: PortSide,
  schemas: SchemaCatalog | undefined,
  schemaModules: ReadonlyMap<string, z.ZodType> | undefined,
  out: CompileDiagnostic[],
): void {
  const { declared, bound, listName, implSchema, implSchemaName } = side;

  // ── At most one port per side ──
  //
  // `NodeHandler` takes exactly ONE input value and returns exactly ONE output value, so
  // a `NodeImpl` binds at most one port per side and there is no interpreter semantics
  // yet for feeding a second declared port into a handler. The artifact schema is wider
  // than that (`inputPorts` / `outputPorts` are arrays of any length), which leaves a
  // node free to declare a port no implementation is checked against — exactly the
  // artifact-vs-registry drift this function exists to make loud. So an unsupported
  // artifact is REFUSED here rather than compiled with an unchecked port; a sprint that
  // teaches the interpreter how to compose several ports into one input lifts the
  // refusal, and until then the check below (one bound port, one resolved schema) is
  // total rather than partial.
  if (declared.length > 1) {
    const unbound = declared.filter((p) => p.key !== bound?.key);
    out.push(
      diag(
        "NodeImplPortMismatch",
        `Node "${node.id}" declares ${declared.length} ${listName} (${declared.map((p) => p.key).join(", ")}) but an implementation binds at most one ${side.side} port, so ${unbound
          .map((p) => `"${p.key}"`)
          .join(", ")} has no implementation behind it.`,
        [node.id],
        [],
        ["nodes", nodeIndex, listName],
        unbound[0]?.key,
      ),
    );
    return;
  }

  if (bound === null) {
    if (declared.length === 0) return;
    const first = declared[0];
    out.push(
      diag(
        "NodeImplPortMismatch",
        `Node "${node.id}" declares ${listName} "${first.key}" (schemaRef "${first.schemaRef}") but its implementation binds no ${side.side} port.`,
        [node.id],
        [],
        ["nodes", nodeIndex, listName, 0],
        first.key,
      ),
    );
    return;
  }

  if (declared.length === 0) {
    out.push(
      diag(
        "NodeImplPortMismatch",
        `Node "${node.id}" declares no ${listName}, but its implementation binds ${side.side} port "${bound.key}".`,
        [node.id],
        [],
        ["nodes", nodeIndex, listName],
        bound.key,
      ),
    );
    return;
  }

  const port = declared.find((p) => p.key === bound.key);
  if (!port) {
    out.push(
      diag(
        "NodeImplPortMismatch",
        `Node "${node.id}" implementation binds ${side.side} port "${bound.key}", which the node does not declare in ${listName} (declared: ${declared.map((p) => p.key).join(", ")}).`,
        [node.id],
        [],
        ["nodes", nodeIndex, listName],
        bound.key,
      ),
    );
    return;
  }

  if (port.schemaRef !== bound.schemaRef) {
    out.push(
      diag(
        "NodeImplPortMismatch",
        `Node "${node.id}" ${listName} "${port.key}" declares schemaRef "${port.schemaRef}" but its implementation binds "${bound.schemaRef}".`,
        [node.id],
        [],
        ["nodes", nodeIndex, listName, declared.indexOf(port), "schemaRef"],
        port.key,
      ),
    );
    return;
  }

  if (schemas && !schemas.has(bound.schemaRef)) {
    out.push(
      diag(
        "UnknownSchemaRef",
        `Node "${node.id}" ${listName} "${port.key}" names schemaRef "${bound.schemaRef}", which the schema catalog does not resolve.`,
        [node.id],
        [],
        ["nodes", nodeIndex, listName, declared.indexOf(port), "schemaRef"],
        port.key,
      ),
    );
    return;
  }

  // ── The ref against the schema the implementation actually parses with ──
  if (!schemaModules) return;

  const resolved = schemaModules.get(bound.schemaRef);
  if (!resolved) {
    out.push(
      diag(
        "UnknownSchemaRef",
        `Node "${node.id}" ${listName} "${port.key}" names schemaRef "${bound.schemaRef}", which the schema module map does not resolve to a Zod schema.`,
        [node.id],
        [],
        ["nodes", nodeIndex, listName, declared.indexOf(port), "schemaRef"],
        port.key,
      ),
    );
    return;
  }

  // Reference identity, not structural comparison: two Zod schemas that happen to accept
  // the same values today are still two declarations that can drift apart tomorrow, and
  // the point of the ref indirection is that ONE schema is the meaning of the name.
  if (resolved !== implSchema) {
    out.push(
      diag(
        "NodeImplPortMismatch",
        `Node "${node.id}" ${listName} "${port.key}" declares schemaRef "${bound.schemaRef}", but the implementation's ${implSchemaName} is not the Zod schema that ref resolves to.`,
        [node.id],
        [],
        ["nodes", nodeIndex, listName, declared.indexOf(port), "schemaRef"],
        port.key,
      ),
    );
  }
}

// ── Region assembly ─────────────────────────────────────────────────

/** The subgraph a subgraph declaration is CALLED FROM, derived from its call-site node. */
function callSiteParents(spec: TopologySpec): Map<string, string | null> {
  const parents = new Map<string, string | null>();
  for (const node of spec.nodes) {
    if (node.kind !== "subgraph") continue;
    if (!parents.has(node.subgraphRef)) parents.set(node.subgraphRef, node.subgraph ?? null);
  }
  return parents;
}

/**
 * Compile the region belonging to `subgraphId`, or the whole graph when it is `null`.
 *
 * `seen` guards a hand-edited artifact whose call sites form a cycle: `depth` in the
 * declaration is not trusted (a hand-edited file can lie about it), so termination has
 * to come from somewhere that cannot.
 */
function compileRegion(
  spec: TopologySpec,
  subgraphId: string | null,
  nodesById: ReadonlyMap<string, CompiledNode>,
  channels: ReadonlyMap<string, CompiledChannel>,
  parents: ReadonlyMap<string, string | null>,
  decls: readonly SubgraphDecl[],
  seen: ReadonlySet<string>,
): CompiledGraph {
  const regionNodes = new Map<string, CompiledNode>();
  for (const [id, compiled] of nodesById) {
    const owner = compiled.spec.subgraph ?? null;
    if (subgraphId === null || owner === subgraphId) regionNodes.set(id, compiled);
  }

  const adjacency = new Map<string, EdgeSpec[]>();
  for (const edge of spec.edges) {
    if (!regionNodes.has(edge.from)) continue;
    const existing = adjacency.get(edge.from);
    if (existing) existing.push(edge);
    else adjacency.set(edge.from, [edge]);
  }

  const subgraphs = new Map<string, CompiledGraph>();
  for (const decl of decls) {
    if (seen.has(decl.id)) continue;
    const parent = parents.has(decl.id) ? (parents.get(decl.id) as string | null) : null;
    if (parent !== subgraphId) continue;
    subgraphs.set(
      decl.id,
      compileRegion(
        spec,
        decl.id,
        nodesById,
        channels,
        parents,
        decls,
        new Set([...seen, decl.id]),
      ),
    );
  }

  return { spec, nodes: regionNodes, adjacency, channels, subgraphs };
}

// ── compile ─────────────────────────────────────────────────────────

/**
 * Resolve a validated artifact against the registries.
 *
 * Every diagnostic is collected before anything is thrown: a graph with four unregistered
 * nodes reports four, not the first one four times over four runs.
 *
 * @throws {TopologyCompileError} when any reference fails to resolve in either direction.
 */
export function compile(spec: TopologySpec, reg: Registries): CompiledGraph {
  const diagnostics: CompileDiagnostic[] = [];

  // ── Nodes, both directions ──
  const specNodeIds = new Set<string>();
  const nodes = new Map<string, CompiledNode>();

  spec.nodes.forEach((node, index) => {
    if (specNodeIds.has(node.id)) {
      diagnostics.push(
        diag(
          "DuplicateNodeId",
          `Node id "${node.id}" is declared more than once; a compiled graph is keyed by node id and cannot hold both.`,
          [node.id],
          [],
          ["nodes", index, "id"],
        ),
      );
      return;
    }
    specNodeIds.add(node.id);

    const impl = reg.nodes.get(node.id);
    if (!impl) {
      diagnostics.push(
        diag(
          "UnregisteredNodeImpl",
          `Node "${node.id}" is declared in the topology but no implementation is registered for it.`,
          [node.id],
          [],
          ["nodes", index, "id"],
        ),
      );
      return;
    }

    if (impl.kind !== node.kind) {
      diagnostics.push(
        diag(
          "NodeKindMismatch",
          `Node "${node.id}" is declared as kind "${node.kind}" but its implementation registers kind "${impl.kind}".`,
          [node.id],
          [],
          ["nodes", index, "kind"],
        ),
      );
    }

    checkPortSide(
      node,
      index,
      {
        side: "input",
        declared: node.inputPorts,
        bound: impl.inputPort,
        implSchema: impl.inputSchema,
        listName: "inputPorts",
        implSchemaName: "inputSchema",
      },
      reg.schemas,
      reg.schemaModules,
      diagnostics,
    );
    checkPortSide(
      node,
      index,
      {
        side: "output",
        declared: node.outputPorts,
        bound: impl.outputPort,
        implSchema: impl.outputSchema,
        listName: "outputPorts",
        implSchemaName: "outputSchema",
      },
      reg.schemas,
      reg.schemaModules,
      diagnostics,
    );

    nodes.set(node.id, { spec: node, impl });
  });

  for (const id of reg.nodes.ids()) {
    if (specNodeIds.has(id)) continue;
    diagnostics.push(
      diag(
        "OrphanNodeImpl",
        `Node implementation "${id}" is registered but the topology declares no such node.`,
        [id],
      ),
    );
  }

  // ── Channels ──
  //
  // The duplicate guard mirrors `DuplicateNodeId` above, and for the same reason: the
  // compiled graph is a `ReadonlyMap` keyed by channel id, so a repeated id would collapse
  // to ONE compiled channel. Worse than lossy, it would be lossy in the opposite direction
  // from the validator, which indexes channels first-wins — the compiled channel would run
  // under a reducer no validator rule (single-writer, fan-out safety, inline budget) ever
  // examined. Neither declaration is preferable to the other: the artifact is ambiguous
  // and is refused.
  const specChannelIds = new Set<string>();
  const channels = new Map<string, CompiledChannel>();
  spec.channels.forEach((decl, index) => {
    if (specChannelIds.has(decl.id)) {
      diagnostics.push(
        diag(
          "DuplicateChannelId",
          `Channel id "${decl.id}" is declared more than once; a compiled graph is keyed by channel id and cannot hold both.`,
          [],
          [],
          ["channels", index, "id"],
        ),
      );
      return;
    }
    specChannelIds.add(decl.id);

    const reducer = reg.reducers.get(decl.reducerRef);
    if (!reducer) {
      diagnostics.push(
        diag(
          "MissingReducer",
          `Channel "${decl.id}" names reducer "${decl.reducerRef}", which the closed reducer registry does not resolve (registered: ${reg.reducers.ids().join(", ")}).`,
          [],
          [],
          ["channels", index, "reducerRef"],
        ),
      );
      return;
    }
    if (reg.schemas && !reg.schemas.has(decl.schemaRef)) {
      diagnostics.push(
        diag(
          "UnknownSchemaRef",
          `Channel "${decl.id}" names schemaRef "${decl.schemaRef}", which the schema catalog does not resolve.`,
          [],
          [],
          ["channels", index, "schemaRef"],
        ),
      );
    }
    channels.set(decl.id, { decl, reducer });
  });

  const declaredChannelIds = new Set(spec.channels.map((c) => c.id));
  spec.nodes.forEach((node, index) => {
    for (const ref of node.reads) {
      if (declaredChannelIds.has(ref)) continue;
      diagnostics.push(
        diag(
          "UndeclaredChannel",
          `Node "${node.id}" reads channel "${ref}", which is absent from channels[].`,
          [node.id],
          [],
          ["nodes", index, "reads"],
        ),
      );
    }
    for (const ref of node.writes) {
      if (declaredChannelIds.has(ref)) continue;
      diagnostics.push(
        diag(
          "ChannelDeclMismatch",
          `Node "${node.id}" writes channel "${ref}", which is absent from channels[].`,
          [node.id],
          [],
          ["nodes", index, "writes"],
        ),
      );
    }
  });

  // ── Edges ──
  if (!specNodeIds.has(spec.entry)) {
    diagnostics.push(
      diag("DanglingEdge", `Graph entry "${spec.entry}" names no declared node.`, [], [], ["entry"]),
    );
  }
  spec.edges.forEach((edge, index) => {
    if (!specNodeIds.has(edge.from)) {
      diagnostics.push(
        diag(
          "DanglingEdge",
          `Edge "${edge.id}" originates at "${edge.from}", which names no declared node.`,
          [],
          [edge.id],
          ["edges", index, "from"],
        ),
      );
    }
    if (edge.to !== TERMINAL_ENDPOINT && !specNodeIds.has(edge.to)) {
      diagnostics.push(
        diag(
          "DanglingEdge",
          `Edge "${edge.id}" targets "${edge.to}", which names no declared node.`,
          [],
          [edge.id],
          ["edges", index, "to"],
        ),
      );
    }
  });

  if (diagnostics.length > 0) {
    const codes = [...new Set(diagnostics.map((d) => d.code))].join(", ");
    throw new TopologyCompileError(
      `Topology "${spec.graphId}" did not compile: ${diagnostics.length} diagnostic(s) [${codes}].`,
      diagnostics,
    );
  }

  return compileRegion(spec, null, nodes, channels, callSiteParents(spec), spec.subgraphs, new Set());
}

// ── loadCompiledGraph ───────────────────────────────────────────────

/**
 * Read `.bober/topology/<graphId>.json`, validate it, and compile it.
 *
 * The ARTIFACT is the input, never the authored TypeScript literal: the literal is a
 * convenience for authors, and a runtime that read it could execute a graph the
 * committed file does not describe (ADR-2).
 *
 * @throws {TopologyCompileError} when the file is missing, unreadable, invalid, or fails
 *         to resolve against the registries.
 */
export async function loadCompiledGraph(
  projectRoot: string,
  graphId: string,
  reg: Registries,
): Promise<CompiledGraph> {
  const path = topologyArtifactPath(projectRoot, graphId);
  const artifact = await readTopologyArtifact(path);
  if (!artifact.ok) {
    throw new TopologyCompileError(
      `Cannot load topology artifact ${path} (${artifact.reason}): ${artifact.message}`,
      [
        diag(
          "SchemaViolation",
          `Topology artifact ${path} could not be read (${artifact.reason}): ${artifact.message}`,
        ),
      ],
    );
  }

  // Structural mode deliberately: `mode: "full"` additionally demands a prompt store,
  // which is not this function's business, and every schemaRef the compiler cares about
  // is resolved against `reg.schemas` by `compile()` a few lines below.
  const report = validateTopology(artifact.raw, { mode: "structural" });
  if (!report.ok || !report.spec) {
    const errors = report.diagnostics.filter((d) => d.severity === "error");
    throw new TopologyCompileError(
      `Topology artifact ${path} is invalid: ${errors.length} error diagnostic(s) [${[
        ...new Set(errors.map((d) => d.code)),
      ].join(", ")}].`,
      errors,
    );
  }

  return compile(report.spec, reg);
}
