import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { EdgeSpec, TopologySpec } from "../../contracts/topology.js";
import { serializeTopology, topologyArtifactPath } from "../topology/dump.js";
import { fixtureNodeRegistry, fixtureRegistries, fixtureSpec } from "./__fixtures__/fixture-graph.js";
import { TopologyCompileError, compile, loadCompiledGraph } from "./compiler.js";
import type { CompiledGraph } from "./compiler.js";

/**
 * sc-5-8 — the compiled graph is the artifact, and the artifact is the compiled graph.
 *
 * The risk this file exists for is the quiet one: a compiler that registers or drops a
 * node relative to the artifact, so the topology everyone reads, diffs and version-bumps
 * describes something other than what runs. Every assertion below is therefore made in
 * BOTH directions with the SPEC authoritative — nothing in the compiled output may be
 * absent from the spec, and nothing in the spec may be absent from the output.
 */

const byId = (a: { id: string }, b: { id: string }): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** Every edge the compiled adjacency holds, flattened and ordered by edge id. */
function adjacencyEdges(graph: CompiledGraph): EdgeSpec[] {
  return [...graph.adjacency.values()].flatMap((edges) => [...edges]).sort(byId);
}

function assertFidelity(graph: CompiledGraph, spec: TopologySpec): void {
  // ── Nodes: same set, same order-independent identity ──
  const compiledIds = [...graph.nodes.keys()].sort();
  const specIds = spec.nodes.map((node) => node.id).sort();
  expect(compiledIds).toEqual(specIds);

  for (const node of spec.nodes) {
    const compiled = graph.nodes.get(node.id);
    expect(compiled, `spec node ${node.id} is missing from the compiled graph`).toBeDefined();
    // The compiled node carries the SPEC's declaration, not a copy that could drift.
    expect(compiled?.spec).toEqual(node);
    expect(compiled?.impl.id).toBe(node.id);
    expect(compiled?.impl.kind).toBe(node.kind);
  }
  for (const [id, compiled] of graph.nodes) {
    expect(specIds, `compiled node ${id} is absent from the spec`).toContain(id);
    expect(compiled.spec.id).toBe(id);
  }

  // ── Edges: the flattened adjacency IS spec.edges ──
  expect(adjacencyEdges(graph)).toEqual([...spec.edges].sort(byId));

  // Each adjacency bucket holds exactly the edges leaving that node, in declared order.
  for (const [nodeId, edges] of graph.adjacency) {
    expect(graph.nodes.has(nodeId), `adjacency key ${nodeId} is not a compiled node`).toBe(true);
    expect(edges.map((edge) => edge.id)).toEqual(
      spec.edges.filter((edge) => edge.from === nodeId).map((edge) => edge.id),
    );
    for (const edge of edges) expect(edge.from).toBe(nodeId);
  }

  // A node with outgoing edges must have a bucket; one without must not.
  for (const node of spec.nodes) {
    const outgoing = spec.edges.filter((edge) => edge.from === node.id);
    expect(graph.adjacency.has(node.id), `${node.id} adjacency presence`).toBe(outgoing.length > 0);
  }

  // ── Channels: same set, same declarations, same COUNT ──
  //
  // The count is asserted separately from the key set because the two fail differently:
  // a `Map` keyed by channel id collapses a repeated id, and `keys()` sorted still equals
  // the spec's ids sorted only if the sorted comparison is also deduplicated — it is not,
  // but the size assertion is the one that states the invariant directly.
  expect(graph.channels.size).toBe(spec.channels.length);
  expect(graph.nodes.size).toBe(spec.nodes.length);
  expect([...graph.channels.keys()].sort()).toEqual(spec.channels.map((c) => c.id).sort());
  for (const channel of spec.channels) {
    const compiled = graph.channels.get(channel.id);
    expect(compiled?.decl).toEqual(channel);
    expect(compiled?.reducer.id).toBe(channel.reducerRef);
  }
}

// ── The fixture, compiled in memory ─────────────────────────────────

describe("sc-5-8 compiler fidelity (in-memory spec)", () => {
  it("compiles a graph whose nodes, edges and channels are exactly the spec's", () => {
    const spec = fixtureSpec();
    assertFidelity(compile(spec, fixtureRegistries()), spec);
  });

  it("keeps fidelity for the subgraph region against the nodes that declare membership", () => {
    const spec = fixtureSpec();
    const graph = compile(spec, fixtureRegistries());
    const work = graph.subgraphs.get("work");
    if (!work) throw new Error("the fixture declares a work subgraph");

    const expectedNodes = spec.nodes.filter((node) => node.subgraph === "work").map((n) => n.id);
    expect([...work.nodes.keys()].sort()).toEqual([...expectedNodes].sort());

    // Every edge in the region leaves a node of the region — including the exit edge,
    // which is how the region reaches the supervisor.
    for (const [nodeId, edges] of work.adjacency) {
      expect(expectedNodes).toContain(nodeId);
      for (const edge of edges) expect(edge.from).toBe(nodeId);
    }
    expect(adjacencyEdges(work).map((e) => e.id)).toEqual([
      "e-draft-out",
      "e-in-draft",
      "e-out-supervisor",
    ]);
  });
});

// ── The fixture, compiled from a committed artifact ─────────────────

describe("sc-5-8 compiler fidelity (committed artifact)", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bober-pge-fidelity-"));
    await mkdir(join(root, ".bober", "topology"), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("compiles the JSON on disk, not the in-memory literal, and keeps fidelity to it", async () => {
    await writeFile(
      topologyArtifactPath(root, "fixture"),
      serializeTopology(fixtureSpec()),
      "utf8",
    );

    const graph = await loadCompiledGraph(root, "fixture", fixtureRegistries());
    // `graph.spec` is what was READ, and fidelity is asserted against that — so a
    // serializer that reordered or dropped anything would surface here.
    assertFidelity(graph, graph.spec);

    expect(graph.spec.checksum).toBe(fixtureSpec().checksum);
    expect(graph.spec.nodes.map((n) => n.id).sort()).toEqual(
      fixtureSpec().nodes.map((n) => n.id).sort(),
    );
    expect(graph.spec.edges.map((e) => e.id).sort()).toEqual(
      fixtureSpec().edges.map((e) => e.id).sort(),
    );
  });
});

// ── Fidelity cannot be achieved by ignoring a difference ────────────

describe("fidelity is a refusal, not an accommodation", () => {
  it("refuses to compile a node the registry does not implement, rather than omitting it", () => {
    const spec = fixtureSpec();
    expect(() => compile(spec, fixtureRegistries({ nodes: fixtureNodeRegistry({ omit: ["finalize"] }) })))
      .toThrow(TopologyCompileError);
  });

  it("refuses to compile with an implementation the artifact does not declare, rather than ignoring it", () => {
    const spec = fixtureSpec();
    const trimmed = spec.nodes.filter((node) => node.id !== "finalize");
    spec.nodes = trimmed;
    spec.edges = spec.edges.filter((edge) => edge.from !== "finalize" && edge.to !== "finalize");
    expect(() => compile(spec, fixtureRegistries())).toThrow(TopologyCompileError);
  });

  it("refuses N channel declarations that would compile to fewer than N channels", () => {
    // The spec is authoritative for channels too. A repeated id is the one input that can
    // make `graph.channels.size < spec.channels.length`, and the only two honest outcomes
    // are a compiled graph of the declared size or a refusal — never a quiet collapse.
    const spec = fixtureSpec();
    spec.channels.push({ ...spec.channels[0], reducerRef: "setUnion" });

    let compiled: CompiledGraph | null = null;
    try {
      compiled = compile(spec, fixtureRegistries());
    } catch (error) {
      expect(error).toBeInstanceOf(TopologyCompileError);
      expect((error as TopologyCompileError).has("DuplicateChannelId")).toBe(true);
    }
    expect(compiled).toBeNull();
  });

  it("keeps fidelity after a channel is added to the artifact", () => {
    const spec = fixtureSpec();
    spec.channels.push({ ...spec.channels[0], id: "audit" });
    spec.nodes[2].writes.push("audit");
    assertFidelity(compile(spec, fixtureRegistries()), spec);
  });

  it("keeps fidelity after a node is added to BOTH the artifact and the registry", () => {
    // The compiler is not pinned to a fixed node list: fidelity is a relation between
    // the artifact and the registry, so growing both together must still compile.
    const spec = fixtureSpec();
    const finalize = spec.nodes.find((node) => node.id === "finalize");
    if (!finalize) throw new Error("the fixture declares a finalize node");

    spec.nodes.push({
      ...finalize,
      id: "audit",
      title: "Audit the run",
      doc: "Writes a post-run audit record; added by the fidelity test to prove the relation is not a fixed list.",
      inputPorts: [],
      outputPorts: [],
      writes: [],
      reads: [],
      effects: [],
      toolRef: "run.audit",
    });
    spec.edges.push({ id: "e-finalize-audit", from: "finalize", to: "audit", kind: "normal" });
    spec.edges.push({ id: "e-audit-end", from: "audit", to: "END", kind: "normal" });

    const registry = fixtureNodeRegistry();
    registry.register({
      id: "audit",
      kind: "tool",
      inputPort: null,
      outputPort: null,
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      handler: async () => {
        throw new Error("must not run");
      },
    });

    const graph = compile(spec, fixtureRegistries({ nodes: registry }));
    assertFidelity(graph, spec);
    expect(graph.nodes.has("audit")).toBe(true);
    expect(graph.adjacency.get("audit")?.map((e) => e.id)).toEqual(["e-audit-end"]);
  });
});
