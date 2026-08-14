import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { TopologySpec } from "../../contracts/topology.js";
import { serializeTopology, topologyArtifactPath } from "../topology/dump.js";
import { validateTopology } from "../topology/validate.js";
import { createNodeRegistry } from "../registry/nodes.js";
import { createReducerRegistry } from "../registry/reducers.js";
import {
  FIXTURE_SCHEMA_MODULES,
  fixtureNodeRegistry,
  fixtureRegistries,
  fixtureSchemaCatalog,
  fixtureSpec,
  registerMismatchedImpl,
  registerOrphanImpl,
  registerWrongSchemaImpl,
} from "./__fixtures__/fixture-graph.js";
import { TopologyCompileError, compile, loadCompiledGraph } from "./compiler.js";
import type { CompileDiagnosticCode } from "./compiler.js";

/**
 * sc-5-7 / sc-5-9 — the compiler resolves every reference it owns, or fails loudly.
 */

/** The Zod schema a fixture ref names, failing loudly rather than yielding `undefined`. */
function schemaModule(ref: string): z.ZodType {
  const schema = FIXTURE_SCHEMA_MODULES.get(ref);
  if (!schema) throw new Error(`fixture schema map has no "${ref}"`);
  return schema;
}

/** Compile and return the error, asserting that compilation did fail. */
function compileFailure(spec: TopologySpec, registries: Parameters<typeof compile>[1]): TopologyCompileError {
  try {
    compile(spec, registries);
  } catch (error) {
    if (error instanceof TopologyCompileError) return error;
    throw error;
  }
  throw new Error("expected compile() to throw TopologyCompileError");
}

function codes(error: TopologyCompileError): CompileDiagnosticCode[] {
  return error.diagnostics.map((d) => d.code);
}

// ── The fixture is honest ───────────────────────────────────────────

describe("the compiler fixture", () => {
  it("is a topology that validates clean, so a compile failure is about the compiler", () => {
    const report = validateTopology(fixtureSpec());
    expect(report.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("hands out a fresh spec each call, so one test's mutation cannot reach another", () => {
    const first = fixtureSpec();
    first.nodes.pop();
    expect(fixtureSpec().nodes).toHaveLength(6);
    expect(first.nodes).toHaveLength(5);
  });
});

// ── The happy path ──────────────────────────────────────────────────

describe("compile", () => {
  it("resolves every node, channel and edge of a valid artifact", () => {
    const graph = compile(fixtureSpec(), fixtureRegistries());

    expect([...graph.nodes.keys()].sort()).toEqual([
      "draft",
      "finalize",
      "gate_work_in",
      "gate_work_out",
      "supervisor",
      "work_body",
    ]);
    expect([...graph.channels.keys()].sort()).toEqual(["counters", "messages", "spec", "verdict"]);
    expect(graph.channels.get("messages")?.reducer.id).toBe("appendById");
    expect(graph.channels.get("counters")?.reducer.id).toBe("maxNumber");
    expect(graph.channels.get("spec")?.reducer.id).toBe("replaceIfNewer");
    expect(graph.nodes.get("draft")?.impl.id).toBe("draft");
    expect(graph.nodes.get("draft")?.spec.kind).toBe("llm");
  });

  it("executes no node body — compilation resolves declarations, it does not run them", () => {
    // Every fixture handler throws on invocation, so a compiler that called one would
    // fail this test rather than pass it quietly.
    expect(() => compile(fixtureSpec(), fixtureRegistries())).not.toThrow();
  });

  it("compiles the subgraph region from the nodes that declare membership", () => {
    const graph = compile(fixtureSpec(), fixtureRegistries());
    expect([...graph.subgraphs.keys()]).toEqual(["work"]);

    const work = graph.subgraphs.get("work");
    expect(work).toBeDefined();
    expect([...(work as NonNullable<typeof work>).nodes.keys()].sort()).toEqual([
      "draft",
      "gate_work_in",
      "gate_work_out",
    ]);
    // A subgraph is a REGION of one artifact, so it shares the parent's spec and channels.
    expect((work as NonNullable<typeof work>).spec.graphId).toBe("fixture");
    expect([...(work as NonNullable<typeof work>).channels.keys()].sort()).toEqual([
      "counters",
      "messages",
      "spec",
      "verdict",
    ]);
    expect((work as NonNullable<typeof work>).subgraphs.size).toBe(0);
  });

  it("works without a schema catalog, which is optional", () => {
    const graph = compile(fixtureSpec(), fixtureRegistries({ schemas: null }));
    expect(graph.nodes.size).toBe(6);
  });
});

// ── sc-5-7: both directions ─────────────────────────────────────────

describe("sc-5-7 UnregisteredNodeImpl", () => {
  it("throws when the artifact names a node with no registered implementation", () => {
    const error = compileFailure(
      fixtureSpec(),
      fixtureRegistries({ nodes: fixtureNodeRegistry({ omit: ["draft"] }) }),
    );

    expect(codes(error)).toEqual(["UnregisteredNodeImpl"]);
    const diagnostic = error.diagnostics[0];
    expect(diagnostic.nodeIds).toEqual(["draft"]);
    expect(diagnostic.severity).toBe("error");
    expect(diagnostic.message).toContain('Node "draft"');
    expect(diagnostic.message).toContain("no implementation is registered");
    expect(error.has("UnregisteredNodeImpl")).toBe(true);
    expect(error.has("OrphanNodeImpl")).toBe(false);
  });

  it("reports every unregistered node, not just the first", () => {
    const error = compileFailure(
      fixtureSpec(),
      fixtureRegistries({ nodes: fixtureNodeRegistry({ omit: ["draft", "finalize", "supervisor"] }) }),
    );
    expect(codes(error)).toEqual([
      "UnregisteredNodeImpl",
      "UnregisteredNodeImpl",
      "UnregisteredNodeImpl",
    ]);
    expect(error.diagnostics.flatMap((d) => d.nodeIds).sort()).toEqual([
      "draft",
      "finalize",
      "supervisor",
    ]);
  });

  it("refuses an empty registry rather than compiling an empty graph", () => {
    const error = compileFailure(fixtureSpec(), fixtureRegistries({ nodes: createNodeRegistry() }));
    expect(error.diagnostics).toHaveLength(6);
    expect(new Set(codes(error))).toEqual(new Set(["UnregisteredNodeImpl"]));
  });
});

describe("sc-5-7 OrphanNodeImpl", () => {
  it("throws when a registered implementation is absent from the artifact", () => {
    const registry = fixtureNodeRegistry();
    registerOrphanImpl(registry, "ghost_node");

    const error = compileFailure(fixtureSpec(), fixtureRegistries({ nodes: registry }));

    expect(codes(error)).toEqual(["OrphanNodeImpl"]);
    expect(error.diagnostics[0].nodeIds).toEqual(["ghost_node"]);
    expect(error.diagnostics[0].message).toContain("ghost_node");
    expect(error.diagnostics[0].message).toContain("the topology declares no such node");
  });

  it("catches a node RENAMED in the artifact but not in the registry, in both directions at once", () => {
    const spec = fixtureSpec();
    const draft = spec.nodes.find((n) => n.id === "draft");
    if (!draft) throw new Error("fixture lost its draft node");
    draft.id = "draft_v2";
    for (const edge of spec.edges) {
      if (edge.from === "draft") edge.from = "draft_v2";
      if (edge.to === "draft") edge.to = "draft_v2";
    }

    const error = compileFailure(spec, fixtureRegistries());
    expect(new Set(codes(error))).toEqual(new Set(["UnregisteredNodeImpl", "OrphanNodeImpl"]));
    expect(error.message).toContain("UnregisteredNodeImpl");
    expect(error.message).toContain("OrphanNodeImpl");
  });
});

describe("NodeKindMismatch", () => {
  it("throws when the implementation registers a different kind than the artifact declares", () => {
    const registry = fixtureNodeRegistry({ omit: ["draft"] });
    registry.register({
      id: "draft",
      kind: "tool",
      inputPort: { key: "request", schemaRef: "FeatureRequest" },
      outputPort: { key: "draft", schemaRef: "PlanSpec" },
      // The schemas the bound refs actually name: this test is about the KIND
      // disagreeing, so its implementation must be honest about everything else or the
      // assertion below stops being a verdict on one rule.
      inputSchema: schemaModule("FeatureRequest"),
      outputSchema: schemaModule("PlanSpec"),
      handler: async () => {
        throw new Error("must not run");
      },
    });

    const error = compileFailure(fixtureSpec(), fixtureRegistries({ nodes: registry }));
    expect(codes(error)).toEqual(["NodeKindMismatch"]);
    expect(error.diagnostics[0].message).toContain('declared as kind "llm"');
    expect(error.diagnostics[0].message).toContain('registers kind "tool"');
  });
});

// ── sc-5-9: port contract ───────────────────────────────────────────

describe("sc-5-9 NodeImplPortMismatch", () => {
  it("names the node id and the port key when an input schemaRef disagrees", () => {
    const registry = fixtureNodeRegistry({ omit: ["draft"] });
    registerMismatchedImpl(
      registry,
      "draft",
      { key: "request", schemaRef: "PlanSpec" },
      { key: "draft", schemaRef: "PlanSpec" },
    );

    const error = compileFailure(fixtureSpec(), fixtureRegistries({ nodes: registry }));

    expect(codes(error)).toEqual(["NodeImplPortMismatch"]);
    const diagnostic = error.diagnostics[0];
    expect(diagnostic.nodeIds).toEqual(["draft"]);
    expect(diagnostic.portKey).toBe("request");
    expect(diagnostic.message).toContain('Node "draft"');
    expect(diagnostic.message).toContain('inputPorts "request"');
    expect(diagnostic.message).toContain('"FeatureRequest"');
    expect(diagnostic.message).toContain('"PlanSpec"');
    expect(diagnostic.path).toEqual(["nodes", 2, "inputPorts", 0, "schemaRef"]);
  });

  it("names the node id and the port key when an output schemaRef disagrees", () => {
    const registry = fixtureNodeRegistry({ omit: ["draft"] });
    registerMismatchedImpl(
      registry,
      "draft",
      { key: "request", schemaRef: "FeatureRequest" },
      { key: "draft", schemaRef: "FeatureRequest" },
    );

    const error = compileFailure(fixtureSpec(), fixtureRegistries({ nodes: registry }));
    expect(codes(error)).toEqual(["NodeImplPortMismatch"]);
    expect(error.diagnostics[0].portKey).toBe("draft");
    expect(error.diagnostics[0].message).toContain("outputPorts");
  });

  it("rejects an implementation binding a port key the node does not declare", () => {
    const registry = fixtureNodeRegistry({ omit: ["draft"] });
    registerMismatchedImpl(
      registry,
      "draft",
      { key: "payload", schemaRef: "FeatureRequest" },
      { key: "draft", schemaRef: "PlanSpec" },
    );

    const error = compileFailure(fixtureSpec(), fixtureRegistries({ nodes: registry }));
    expect(codes(error)).toEqual(["NodeImplPortMismatch"]);
    expect(error.diagnostics[0].portKey).toBe("payload");
    expect(error.diagnostics[0].message).toContain("which the node does not declare");
    expect(error.diagnostics[0].message).toContain("declared: request");
  });

  it("rejects an implementation binding NO port where the node declares one", () => {
    const registry = fixtureNodeRegistry({ omit: ["draft"] });
    registerMismatchedImpl(registry, "draft", null, { key: "draft", schemaRef: "PlanSpec" });

    const error = compileFailure(fixtureSpec(), fixtureRegistries({ nodes: registry }));
    expect(codes(error)).toEqual(["NodeImplPortMismatch"]);
    expect(error.diagnostics[0].portKey).toBe("request");
    expect(error.diagnostics[0].message).toContain("binds no input port");
  });

  it("rejects an implementation binding a port where the node declares none", () => {
    // `supervisor` declares no output ports at all: a router selects a label, it does
    // not emit a payload.
    const registry = fixtureNodeRegistry({ omit: ["supervisor"] });
    registerMismatchedImpl(
      registry,
      "supervisor",
      { key: "draft", schemaRef: "PlanSpec" },
      { key: "decision", schemaRef: "PlanSpec" },
    );

    const error = compileFailure(fixtureSpec(), fixtureRegistries({ nodes: registry }));
    expect(codes(error)).toEqual(["NodeImplPortMismatch"]);
    expect(error.diagnostics[0].nodeIds).toEqual(["supervisor"]);
    expect(error.diagnostics[0].portKey).toBe("decision");
    expect(error.diagnostics[0].message).toContain("declares no outputPorts");
  });

  it("accepts a null binding where the node declares no port on that side", () => {
    // The other half of the same rule: `finalize` declares no input ports and binds none.
    expect(() => compile(fixtureSpec(), fixtureRegistries())).not.toThrow();
  });
});

// ── sc-5-9: a declared port with no implementation behind it ────────

describe("sc-5-9 a node may not declare more ports than an implementation can bind", () => {
  it("refuses a second declared input port instead of leaving it unchecked", () => {
    // A `NodeImpl` binds at most one port per side, so this second declaration would
    // have no implementation behind it — and before the guard, compile() looked up the
    // ONE bound key, found it, and returned without ever noticing the other declaration.
    const spec = fixtureSpec();
    spec.nodes[2].inputPorts.push({ key: "extra", schemaRef: "Counters", required: true });

    const error = compileFailure(spec, fixtureRegistries());

    expect(codes(error)).toEqual(["NodeImplPortMismatch"]);
    const diagnostic = error.diagnostics[0];
    expect(diagnostic.nodeIds).toEqual(["draft"]);
    expect(diagnostic.portKey).toBe("extra");
    expect(diagnostic.message).toContain('Node "draft"');
    expect(diagnostic.message).toContain("2 inputPorts (request, extra)");
    expect(diagnostic.message).toContain('"extra" has no implementation behind it');
    expect(diagnostic.path).toEqual(["nodes", 2, "inputPorts"]);
  });

  it("refuses a second declared output port too", () => {
    const spec = fixtureSpec();
    spec.nodes[2].outputPorts.push({ key: "notes", schemaRef: "GraphMessage", required: false });

    const error = compileFailure(spec, fixtureRegistries());
    expect(codes(error)).toEqual(["NodeImplPortMismatch"]);
    expect(error.diagnostics[0].portKey).toBe("notes");
    expect(error.diagnostics[0].message).toContain("2 outputPorts (draft, notes)");
  });

  it("names every unbound key when the implementation binds none of several", () => {
    const spec = fixtureSpec();
    spec.nodes[2].inputPorts.push({ key: "extra", schemaRef: "Counters", required: true });
    const registry = fixtureNodeRegistry({ omit: ["draft"] });
    registerMismatchedImpl(registry, "draft", null, { key: "draft", schemaRef: "PlanSpec" });

    const error = compileFailure(spec, fixtureRegistries({ nodes: registry }));
    expect(codes(error)).toEqual(["NodeImplPortMismatch"]);
    expect(error.diagnostics[0].message).toContain('"request", "extra" has no implementation');
  });

  it("still accepts every single-port node in the fixture", () => {
    // The refusal must be about the SECOND port, not about ports in general.
    expect(() => compile(fixtureSpec(), fixtureRegistries())).not.toThrow();
  });
});

// ── sc-5-9: the ref resolves to the schema the handler parses with ──

describe("sc-5-9 the bound schemaRef resolves to the implementation's own schema", () => {
  it("rejects an implementation whose inputSchema is not what its bound ref names", () => {
    // Bindings are entirely correct — right keys, right schemaRef strings. Only the Zod
    // schema the handler would actually parse with is wrong, which a string-vs-string
    // comparison cannot see.
    const registry = fixtureNodeRegistry({ omit: ["draft"] });
    registerWrongSchemaImpl(registry, "draft", { inputSchema: z.number() });

    const error = compileFailure(fixtureSpec(), fixtureRegistries({ nodes: registry }));

    expect(codes(error)).toEqual(["NodeImplPortMismatch"]);
    const diagnostic = error.diagnostics[0];
    expect(diagnostic.nodeIds).toEqual(["draft"]);
    expect(diagnostic.portKey).toBe("request");
    expect(diagnostic.message).toContain('schemaRef "FeatureRequest"');
    expect(diagnostic.message).toContain("inputSchema is not the Zod schema that ref resolves to");
    expect(diagnostic.path).toEqual(["nodes", 2, "inputPorts", 0, "schemaRef"]);
  });

  it("rejects an implementation whose outputSchema is not what its bound ref names", () => {
    const registry = fixtureNodeRegistry({ omit: ["draft"] });
    registerWrongSchemaImpl(registry, "draft", { outputSchema: z.number() });

    const error = compileFailure(fixtureSpec(), fixtureRegistries({ nodes: registry }));
    expect(codes(error)).toEqual(["NodeImplPortMismatch"]);
    expect(error.diagnostics[0].portKey).toBe("draft");
    expect(error.diagnostics[0].message).toContain("outputSchema is not the Zod schema");
  });

  it("rejects a schema that merely LOOKS like the one the ref names", () => {
    // Structural equality is not the test: the ref indirection means one schema object is
    // the meaning of the name, so a private clone that drifts next sprint is a defect now.
    const registry = fixtureNodeRegistry({ omit: ["draft"] });
    registerWrongSchemaImpl(registry, "draft", { inputSchema: z.object({ request: z.string() }) });

    const error = compileFailure(fixtureSpec(), fixtureRegistries({ nodes: registry }));
    expect(codes(error)).toEqual(["NodeImplPortMismatch"]);
    expect(error.diagnostics[0].portKey).toBe("request");
  });

  it("accepts the fixture implementations, which declare the schemas their refs name", () => {
    expect(() => compile(fixtureSpec(), fixtureRegistries())).not.toThrow();
  });

  it("throws UnknownSchemaRef when the module map cannot resolve a bound ref", () => {
    // No catalog here, so the module map is the only resolver and its failure is the
    // diagnostic — a ref nothing can resolve to a schema is unusable, not merely unproven.
    const spec = fixtureSpec();
    spec.nodes[2].inputPorts[0].schemaRef = "NotAThing";
    const registry = fixtureNodeRegistry({ omit: ["draft"] });
    registerMismatchedImpl(
      registry,
      "draft",
      { key: "request", schemaRef: "NotAThing" },
      { key: "draft", schemaRef: "PlanSpec" },
    );

    const error = compileFailure(spec, fixtureRegistries({ nodes: registry, schemas: null }));
    expect(codes(error)).toEqual(["UnknownSchemaRef"]);
    expect(error.diagnostics[0].message).toContain("schema module map does not resolve");
    expect(error.diagnostics[0].portKey).toBe("request");
  });

  it("skips the identity check entirely when no schema module map is supplied", () => {
    // The map is optional: a caller that cannot resolve refs to schemas still gets the
    // key and schemaRef checks, and gets no false failure for the part it cannot prove.
    const registry = fixtureNodeRegistry({ omit: ["draft"] });
    registerWrongSchemaImpl(registry, "draft", { inputSchema: z.number() });

    expect(() =>
      compile(fixtureSpec(), fixtureRegistries({ nodes: registry, schemaModules: null })),
    ).not.toThrow();
  });
});

// ── Reducers, channels, schema refs and edges ───────────────────────

describe("compile resolves the remaining artifact references", () => {
  it("throws MissingReducer for a reducer the closed registry does not resolve", () => {
    const spec = fixtureSpec();
    // `listAppend` is a legal `reducerRef` to the topology layer and is deliberately
    // NOT an executable reducer — it is order-dependent. Compilation is where that gap
    // becomes an error instead of an unlawful merge.
    spec.channels[0].reducerRef = "listAppend";

    const error = compileFailure(spec, fixtureRegistries());
    expect(codes(error)).toEqual(["MissingReducer"]);
    expect(error.diagnostics[0].message).toContain('reducer "listAppend"');
    expect(error.diagnostics[0].message).toContain("appendById");
    expect(error.diagnostics[0].path).toEqual(["channels", 0, "reducerRef"]);
  });

  it("throws MissingReducer for an inherited Object.prototype name", () => {
    const spec = fixtureSpec();
    spec.channels[1].reducerRef = "toString";
    expect(codes(compileFailure(spec, fixtureRegistries()))).toEqual(["MissingReducer"]);
  });

  it("throws UnknownSchemaRef when a channel names a schema the catalog cannot resolve", () => {
    const spec = fixtureSpec();
    spec.channels[0].schemaRef = "NotAThing";
    const error = compileFailure(spec, fixtureRegistries());
    expect(codes(error)).toEqual(["UnknownSchemaRef"]);
    expect(error.diagnostics[0].message).toContain("NotAThing");
  });

  it("throws UnknownSchemaRef when an implementation binds an unresolvable schemaRef", () => {
    const spec = fixtureSpec();
    spec.nodes[2].inputPorts[0].schemaRef = "NotAThing";
    const registry = fixtureNodeRegistry({ omit: ["draft"] });
    registerMismatchedImpl(
      registry,
      "draft",
      { key: "request", schemaRef: "NotAThing" },
      { key: "draft", schemaRef: "PlanSpec" },
    );

    const error = compileFailure(spec, fixtureRegistries({ nodes: registry }));
    expect(codes(error)).toEqual(["UnknownSchemaRef"]);
    expect(error.diagnostics[0].portKey).toBe("request");
  });

  it("throws UndeclaredChannel when a node reads a channel that is not declared", () => {
    const spec = fixtureSpec();
    spec.nodes[2].reads.push("ghostChannel");
    const error = compileFailure(spec, fixtureRegistries());
    expect(codes(error)).toEqual(["UndeclaredChannel"]);
    expect(error.diagnostics[0].message).toContain("ghostChannel");
  });

  it("throws ChannelDeclMismatch when a node writes a channel that is not declared", () => {
    const spec = fixtureSpec();
    spec.nodes[2].writes.push("ghostChannel");
    const error = compileFailure(spec, fixtureRegistries());
    expect(codes(error)).toEqual(["ChannelDeclMismatch"]);
  });

  it("throws DanglingEdge for an edge that targets no declared node", () => {
    const spec = fixtureSpec();
    spec.edges[0].to = "nowhere";
    const error = compileFailure(spec, fixtureRegistries());
    expect(codes(error)).toEqual(["DanglingEdge"]);
    expect(error.diagnostics[0].edgeIds).toEqual(["e-entry"]);
  });

  it("accepts an edge to the reserved terminal endpoint", () => {
    const graph = compile(fixtureSpec(), fixtureRegistries());
    expect(graph.adjacency.get("finalize")?.map((e) => e.to)).toEqual(["END"]);
  });

  it("throws DanglingEdge when the graph entry names no declared node", () => {
    const spec = fixtureSpec();
    spec.entry = "nowhere";
    const error = compileFailure(spec, fixtureRegistries());
    expect(codes(error)).toEqual(["DanglingEdge"]);
    expect(error.diagnostics[0].path).toEqual(["entry"]);
  });

  it("throws DuplicateNodeId rather than silently dropping one of two same-id nodes", () => {
    const spec = fixtureSpec();
    spec.nodes.push({ ...spec.nodes[2] });
    const error = compileFailure(spec, fixtureRegistries());
    expect(codes(error)).toContain("DuplicateNodeId");
    expect(error.diagnostics[0].message).toContain("cannot hold both");
  });

  it("throws DuplicateChannelId rather than binding the LAST declaration's reducer", () => {
    // The dangerous shape, not merely a repeated id: the second declaration names a
    // DIFFERENT reducer. `channels` is a Map keyed by id, so before the guard the last
    // declaration silently won — while the validator indexes channels first-wins, so
    // every channel rule had reasoned about `appendById` and the graph ran `setUnion`.
    const spec = fixtureSpec();
    spec.channels.push({ ...spec.channels[0], reducerRef: "setUnion" });

    const error = compileFailure(spec, fixtureRegistries());

    expect(codes(error)).toEqual(["DuplicateChannelId"]);
    const diagnostic = error.diagnostics[0];
    expect(diagnostic.severity).toBe("error");
    expect(diagnostic.message).toContain('Channel id "messages"');
    expect(diagnostic.message).toContain("cannot hold both");
    expect(diagnostic.path).toEqual(["channels", 4, "id"]);
    expect(error.has("DuplicateChannelId")).toBe(true);
  });

  it("reports every repeated channel id, not just the first", () => {
    const spec = fixtureSpec();
    spec.channels.push({ ...spec.channels[0] }, { ...spec.channels[1] });
    const error = compileFailure(spec, fixtureRegistries());
    expect(codes(error)).toEqual(["DuplicateChannelId", "DuplicateChannelId"]);
    expect(error.diagnostics.map((d) => d.path)).toEqual([
      ["channels", 4, "id"],
      ["channels", 5, "id"],
    ]);
  });

  it("accepts an artifact whose channel ids are all distinct", () => {
    const spec = fixtureSpec();
    spec.channels.push({ ...spec.channels[0], id: "audit" });
    spec.nodes[2].writes.push("audit");
    const graph = compile(spec, fixtureRegistries());
    expect(graph.channels.size).toBe(spec.channels.length);
    expect(graph.channels.get("audit")?.reducer.id).toBe("appendById");
  });
});

// ── loadCompiledGraph ───────────────────────────────────────────────

describe("loadCompiledGraph", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bober-pge-compile-"));
    await mkdir(join(root, ".bober", "topology"), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeArtifact(spec: TopologySpec): Promise<void> {
    await writeFile(topologyArtifactPath(root, spec.graphId), serializeTopology(spec), "utf8");
  }

  it("reads the committed JSON artifact and compiles it", async () => {
    await writeArtifact(fixtureSpec());
    const graph = await loadCompiledGraph(root, "fixture", fixtureRegistries());
    expect([...graph.nodes.keys()].sort()).toEqual([
      "draft",
      "finalize",
      "gate_work_in",
      "gate_work_out",
      "supervisor",
      "work_body",
    ]);
    expect(graph.spec.checksum).toBe(fixtureSpec().checksum);
  });

  it("throws TopologyCompileError when the artifact is missing", async () => {
    await expect(loadCompiledGraph(root, "fixture", fixtureRegistries())).rejects.toBeInstanceOf(
      TopologyCompileError,
    );
    try {
      await loadCompiledGraph(root, "fixture", fixtureRegistries());
      throw new Error("unreachable");
    } catch (error) {
      expect((error as TopologyCompileError).message).toContain("missing");
    }
  });

  it("throws TopologyCompileError with the validator's own diagnostic for a stale checksum", async () => {
    const spec = fixtureSpec();
    spec.checksum = `sha256:${"b".repeat(64)}`;
    await writeArtifact(spec);

    try {
      await loadCompiledGraph(root, "fixture", fixtureRegistries());
      throw new Error("unreachable");
    } catch (error) {
      expect(error).toBeInstanceOf(TopologyCompileError);
      expect((error as TopologyCompileError).has("ChecksumStale")).toBe(true);
    }
  });

  it("throws TopologyCompileError for a JSON document that is not a topology", async () => {
    await writeFile(topologyArtifactPath(root, "fixture"), '{"hello":"world"}\n', "utf8");
    await expect(loadCompiledGraph(root, "fixture", fixtureRegistries())).rejects.toBeInstanceOf(
      TopologyCompileError,
    );
  });

  it("compiles the ARTIFACT, so a registry mismatch fails at load rather than at run", async () => {
    await writeArtifact(fixtureSpec());
    await expect(
      loadCompiledGraph(root, "fixture", {
        nodes: fixtureNodeRegistry({ omit: ["finalize"] }),
        reducers: createReducerRegistry(),
        schemas: fixtureSchemaCatalog(),
      }),
    ).rejects.toThrow(/UnregisteredNodeImpl/);
  });
});
