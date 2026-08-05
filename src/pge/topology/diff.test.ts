import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TopologySpecSchema } from "../../contracts/topology.js";
import type { NodeSpec, TopologySpec } from "../../contracts/topology.js";
import { checksumTopology } from "./canonical.js";
import { CODING_GRAPH } from "./coding.graph.js";
import { diffTopology, isVersionBumped, serializeTopologyDiff } from "./diff.js";

/**
 * sc-3-3 … sc-3-6 — the diff must be STRUCTURAL, not textual.
 *
 * Every case below builds its second artifact from the first, so the only difference is
 * the one the case is about. Where a case asserts "exactly one entry", it also asserts
 * the OTHER lists are empty, because a differ that reported everything would pass a
 * weaker assertion.
 */

const FIXTURE_DIR = fileURLToPath(new URL("./__fixtures__/", import.meta.url));

async function loadFixture(name: string): Promise<TopologySpec> {
  const raw = JSON.parse(await readFile(`${FIXTURE_DIR}${name}.json`, "utf8")) as unknown;
  return TopologySpecSchema.parse(raw);
}

function clone(spec: TopologySpec): TopologySpec {
  return TopologySpecSchema.parse(JSON.parse(JSON.stringify(spec)) as unknown);
}

function reseal(spec: TopologySpec): TopologySpec {
  return { ...spec, checksum: checksumTopology(spec) };
}

function extraGate(id: string): NodeSpec {
  return {
    id,
    kind: "gate",
    title: `Gate ${id}`,
    doc: `A gate added by a diff fixture: ${id}.`,
    subgraph: null,
    role: "utility",
    inputPorts: [],
    outputPorts: [],
    reads: [],
    writes: [],
    effects: [],
    gate: { check: "extra", onFail: "END" },
  };
}

/** Deep-reverse every object's key order without changing any value. */
function permuteKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(permuteKeys);
  if (typeof value === "object" && value !== null) {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).reverse()) out[key] = permuteKeys(source[key]);
    return out;
  }
  return value;
}

// ── sc-3-4: no change is no diff ────────────────────────────────────

describe("diffTopology on identical inputs", () => {
  it("reports empty:true for a graph against itself", () => {
    const diff = diffTopology(CODING_GRAPH, CODING_GRAPH);
    expect(diff.empty).toBe(true);
    expect(diff.nodesAdded).toEqual([]);
    expect(diff.nodesRemoved).toEqual([]);
    expect(diff.nodesRenamed).toEqual([]);
    expect(diff.nodesChanged).toEqual([]);
    expect(diff.edgesAdded).toEqual([]);
    expect(diff.edgesRemoved).toEqual([]);
    expect(diff.channelsAdded).toEqual([]);
    expect(diff.channelsRemoved).toEqual([]);
    expect(diff.routeLabelsAdded).toEqual([]);
    expect(diff.routeLabelsRemoved).toEqual([]);
  });

  it("reports empty:true when only ARRAY ordering differs", () => {
    const reordered = clone(CODING_GRAPH);
    reordered.nodes.reverse();
    reordered.edges.reverse();
    reordered.channels.reverse();
    reordered.subgraphs.reverse();
    expect(diffTopology(CODING_GRAPH, reordered).empty).toBe(true);
    expect(diffTopology(reordered, CODING_GRAPH).empty).toBe(true);
  });

  it("reports empty:true when only KEY ordering differs", async () => {
    const spec = await loadFixture("valid");
    const permuted = TopologySpecSchema.parse(
      permuteKeys(JSON.parse(JSON.stringify(spec)) as unknown),
    );
    expect(diffTopology(spec, permuted).empty).toBe(true);
  });

  it("reports empty:true when only the checksum field differs", () => {
    const restamped: TopologySpec = { ...clone(CODING_GRAPH), checksum: `sha256:${"b".repeat(64)}` };
    expect(diffTopology(CODING_GRAPH, restamped).empty).toBe(true);
  });

  it("reports empty:true when only graphVersion differs, and marks it bumped", () => {
    const bumped = reseal({ ...clone(CODING_GRAPH), graphVersion: "1.1.0" });
    const diff = diffTopology(CODING_GRAPH, bumped);
    expect(diff.empty).toBe(true);
    expect(diff.graphVersion).toEqual({ from: "1.0.0", to: "1.1.0", bumped: true });
  });
});

// ── sc-3-3: one added node and one added edge ───────────────────────

describe("diffTopology structural additions", () => {
  it("reports exactly one nodesAdded and one edgesAdded for a one-node one-edge addition", async () => {
    const before = await loadFixture("valid");
    const after = clone(before);
    after.nodes.push(extraGate("extra_gate"));
    after.edges.push({ id: "e-extra", from: "supervisor", to: "extra_gate", kind: "normal" });

    const diff = diffTopology(before, reseal(after));
    expect(diff.empty).toBe(false);
    expect(diff.nodesAdded).toEqual(["extra_gate"]);
    expect(diff.edgesAdded).toEqual(["e-extra"]);
    expect(diff.nodesRemoved).toEqual([]);
    expect(diff.edgesRemoved).toEqual([]);
    expect(diff.nodesRenamed).toEqual([]);
    // The router gained a destination but no new LABEL, so routing is unchanged.
    expect(diff.routeLabelsAdded).toEqual([]);
    expect(diff.routeLabelsRemoved).toEqual([]);
  });

  it("reports the reverse diff as removals", async () => {
    const before = await loadFixture("valid");
    const after = clone(before);
    after.nodes.push(extraGate("extra_gate"));
    after.edges.push({ id: "e-extra", from: "supervisor", to: "extra_gate", kind: "normal" });

    const diff = diffTopology(reseal(after), before);
    expect(diff.nodesRemoved).toEqual(["extra_gate"]);
    expect(diff.edgesRemoved).toEqual(["e-extra"]);
    expect(diff.nodesAdded).toEqual([]);
    expect(diff.edgesAdded).toEqual([]);
  });

  it("reports channel additions and removals by id", async () => {
    const before = await loadFixture("valid");
    const after = clone(before);
    after.channels.push({
      id: "traces",
      reducerRef: "appendById",
      schemaRef: "GraphMessage",
      scope: "private",
      maxInlineBytes: 4096,
    });
    const diff = diffTopology(before, reseal(after));
    expect(diff.channelsAdded).toEqual(["traces"]);
    expect(diff.channelsRemoved).toEqual([]);
    expect(diff.empty).toBe(false);
  });

  it("reports a re-pointed edge as a removal plus an addition of the same id", async () => {
    const before = await loadFixture("valid");
    const after = clone(before);
    const edge = after.edges.find((e) => e.id === "e13");
    if (!edge) throw new Error("fixture drift: no edge e13");
    edge.to = "gate_in";

    const diff = diffTopology(before, reseal(after));
    expect(diff.edgesAdded).toEqual(["e13"]);
    expect(diff.edgesRemoved).toEqual(["e13"]);
    expect(diff.empty).toBe(false);
  });

  it("reports a changed channel reducer as a removal plus an addition of the same id", async () => {
    const before = await loadFixture("valid");
    const after = clone(before);
    const channel = after.channels.find((c) => c.id === "messages");
    if (!channel) throw new Error("fixture drift: no messages channel");
    channel.reducerRef = "listAppend";

    const diff = diffTopology(before, reseal(after));
    expect(diff.channelsAdded).toEqual(["messages"]);
    expect(diff.channelsRemoved).toEqual(["messages"]);
  });
});

// ── Node field changes and renames ──────────────────────────────────

describe("diffTopology node changes", () => {
  it("names the changed fields of a node that kept its id", async () => {
    const before = await loadFixture("valid");
    const after = clone(before);
    const node = after.nodes.find((n) => n.id === "plan_draft");
    if (!node || node.kind !== "llm") throw new Error("fixture drift: plan_draft is not an llm node");
    node.promptRef = "planner/draft-v2";
    node.title = "Draft the plan, again";

    const diff = diffTopology(before, reseal(after));
    expect(diff.nodesChanged).toEqual([{ id: "plan_draft", fields: ["promptRef", "title"] }]);
    expect(diff.nodesAdded).toEqual([]);
    expect(diff.nodesRemoved).toEqual([]);
    expect(diff.empty).toBe(false);
  });

  it("detects a rename when the full field set is identical apart from the id", async () => {
    const before = await loadFixture("valid");
    const after = clone(before);
    const node = after.nodes.find((n) => n.id === "sprint_test");
    if (!node) throw new Error("fixture drift: no sprint_test node");
    node.id = "sprint_verify";

    const diff = diffTopology(before, reseal(after));
    expect(diff.nodesRenamed).toEqual([{ from: "sprint_test", to: "sprint_verify" }]);
    expect(diff.nodesAdded).toEqual([]);
    expect(diff.nodesRemoved).toEqual([]);
    expect(diff.empty).toBe(false);
  });

  it("refuses to guess a rename when any other field also changed", async () => {
    const before = await loadFixture("valid");
    const after = clone(before);
    const node = after.nodes.find((n) => n.id === "sprint_test");
    if (!node) throw new Error("fixture drift: no sprint_test node");
    node.id = "sprint_verify";
    node.title = "Verify the sprint";

    const diff = diffTopology(before, reseal(after));
    expect(diff.nodesRenamed).toEqual([]);
    expect(diff.nodesAdded).toEqual(["sprint_verify"]);
    expect(diff.nodesRemoved).toEqual(["sprint_test"]);
  });

  it("pairs renames deterministically when two identical-shaped nodes are renamed", async () => {
    const before = await loadFixture("valid");
    const withPair = clone(before);
    withPair.nodes.push(extraGate("g_alpha"), extraGate("g_beta"));
    // Both gates are identical apart from id and title; equalise the title so the two
    // removals and two additions are genuinely interchangeable.
    for (const node of withPair.nodes) {
      if (node.id === "g_alpha" || node.id === "g_beta") node.title = "Gate";
    }
    const renamed = clone(withPair);
    for (const node of renamed.nodes) {
      if (node.id === "g_alpha") node.id = "g_gamma";
      if (node.id === "g_beta") node.id = "g_delta";
    }

    const first = diffTopology(reseal(withPair), reseal(renamed));
    const second = diffTopology(reseal(withPair), reseal(renamed));
    expect(first.nodesRenamed).toEqual(second.nodesRenamed);
    expect(first.nodesRenamed).toHaveLength(2);
    expect(first.nodesAdded).toEqual([]);
    expect(first.nodesRemoved).toEqual([]);
  });
});

// ── sc-3-5: route labels ────────────────────────────────────────────

describe("diffTopology route labels", () => {
  it("reports exactly one routeLabelsAdded for a label added to an existing router", async () => {
    const before = await loadFixture("valid");
    const after = clone(before);
    const router = after.nodes.find((n) => n.id === "supervisor");
    if (!router || router.kind !== "router") throw new Error("fixture drift: supervisor");
    router.targets.push({ label: "escalate", to: "hitl_commit" });

    const diff = diffTopology(before, reseal(after));
    expect(diff.routeLabelsAdded).toEqual([{ router: "supervisor", label: "escalate" }]);
    expect(diff.routeLabelsRemoved).toEqual([]);
    // The change is INSIDE the router's targets array — no edge was touched.
    expect(diff.edgesAdded).toEqual([]);
    expect(diff.edgesRemoved).toEqual([]);
    expect(diff.nodesAdded).toEqual([]);
    expect(diff.nodesRemoved).toEqual([]);
    expect(diff.empty).toBe(false);
    // The node itself is also reported as changed, which is how a reviewer finds it.
    expect(diff.nodesChanged).toEqual([{ id: "supervisor", fields: ["targets"] }]);
  });

  it("reports routeLabelsRemoved for a dropped outcome", async () => {
    const before = await loadFixture("valid");
    const after = clone(before);
    const router = after.nodes.find((n) => n.id === "plan_route");
    if (!router || router.kind !== "router") throw new Error("fixture drift: plan_route");
    router.targets = router.targets.filter((t) => t.label !== "retry");

    const diff = diffTopology(before, reseal(after));
    expect(diff.routeLabelsRemoved).toEqual([{ router: "plan_route", label: "retry" }]);
    expect(diff.routeLabelsAdded).toEqual([]);
  });

  it("reports a re-targeted label as a node change, not as a label change", async () => {
    const before = await loadFixture("valid");
    const after = clone(before);
    const router = after.nodes.find((n) => n.id === "supervisor");
    if (!router || router.kind !== "router") throw new Error("fixture drift: supervisor");
    const target = router.targets.find((t) => t.label === "done");
    if (!target) throw new Error("fixture drift: supervisor has no done label");
    target.to = "commit";

    const diff = diffTopology(before, reseal(after));
    expect(diff.routeLabelsAdded).toEqual([]);
    expect(diff.routeLabelsRemoved).toEqual([]);
    expect(diff.nodesChanged).toEqual([{ id: "supervisor", fields: ["targets"] }]);
  });

  it("does not report label churn when a router is merely renamed", async () => {
    const before = await loadFixture("valid");
    const after = clone(before);
    const router = after.nodes.find((n) => n.id === "plan_route");
    if (!router) throw new Error("fixture drift: plan_route");
    router.id = "plan_gate_route";

    const diff = diffTopology(before, reseal(after));
    expect(diff.nodesRenamed).toEqual([{ from: "plan_route", to: "plan_gate_route" }]);
    expect(diff.routeLabelsAdded).toEqual([]);
    expect(diff.routeLabelsRemoved).toEqual([]);
  });
});

// ── Graph-level fields (regression: sc-3-5's "never an empty diff") ─

/**
 * REGRESSION. `empty` once consulted only nodes, edges, channels and router labels, so
 * every change below — each of which moves the canonical checksum, and each of which is
 * a routing change — reported `empty: true` and sailed through `--require-version-bump`.
 * Each case asserts the checksum really moved, so none of them can decay into a test of
 * a no-op.
 */
describe("diffTopology graph-level fields", () => {
  it("reports a re-pointed entry rather than an empty diff", async () => {
    const before = await loadFixture("valid");
    const after = clone(before);
    after.entry = "plan_draft";
    expect(after.entry).not.toBe(before.entry);
    const sealed = reseal(after);
    expect(checksumTopology(sealed)).not.toBe(checksumTopology(before));

    const diff = diffTopology(before, sealed);
    expect(diff.graphFieldsChanged).toEqual(["entry"]);
    expect(diff.empty).toBe(false);
    // Nothing else moved: the blind spot was precisely that no other list fires.
    expect(diff.nodesAdded).toEqual([]);
    expect(diff.nodesRemoved).toEqual([]);
    expect(diff.nodesChanged).toEqual([]);
    expect(diff.edgesAdded).toEqual([]);
    expect(diff.edgesRemoved).toEqual([]);
    expect(diff.routeLabelsAdded).toEqual([]);
    expect(diff.routeLabelsRemoved).toEqual([]);
  });

  it("reports a changed defaults.supervisorNodeId rather than an empty diff", async () => {
    const before = await loadFixture("valid");
    const after = clone(before);
    after.defaults = { ...after.defaults, supervisorNodeId: "plan_route" };
    const sealed = reseal(after);
    expect(checksumTopology(sealed)).not.toBe(checksumTopology(before));

    const diff = diffTopology(before, sealed);
    expect(diff.graphFieldsChanged).toEqual(["defaults"]);
    expect(diff.empty).toBe(false);
  });

  it("reports an added subgraph declaration and a changed exitGate rather than an empty diff", async () => {
    const before = await loadFixture("valid");
    const after = clone(before);
    const first = after.subgraphs[0];
    if (!first) throw new Error("fixture drift: no subgraph declarations");
    first.exitGate = "gate_in";
    after.subgraphs.push({
      id: "zz_new",
      graphId: "fixture.zz",
      depth: 2,
      entryGate: "gate_sprint_in",
      exitGate: "gate_sprint_out",
      persistence: "inherit",
    });
    const sealed = reseal(after);
    expect(checksumTopology(sealed)).not.toBe(checksumTopology(before));

    const diff = diffTopology(before, sealed);
    expect(diff.graphFieldsChanged).toEqual(["subgraphs"]);
    expect(diff.empty).toBe(false);
  });

  it("reports a provenance flip from authored to optimizer", async () => {
    const before = await loadFixture("valid");
    const after = reseal({ ...clone(before), provenance: "optimizer" });
    expect(checksumTopology(after)).not.toBe(checksumTopology(before));

    const diff = diffTopology(before, after);
    expect(diff.graphFieldsChanged).toEqual(["provenance"]);
    expect(diff.empty).toBe(false);
  });

  it("reports a rewritten description", async () => {
    const before = await loadFixture("valid");
    const after = reseal({ ...clone(before), description: "A totally rewritten description." });

    const diff = diffTopology(before, after);
    expect(diff.graphFieldsChanged).toEqual(["description"]);
    expect(diff.empty).toBe(false);
  });

  it("names every changed graph-level field, sorted", async () => {
    const before = await loadFixture("valid");
    const after = clone(before);
    after.entry = "plan_draft";
    after.description = "Rewritten.";
    after.provenance = "optimizer";

    const diff = diffTopology(before, reseal(after));
    expect(diff.graphFieldsChanged).toEqual(["description", "entry", "provenance"]);
  });

  it("leaves graphFieldsChanged empty for node, edge and channel changes", async () => {
    const before = await loadFixture("valid");
    const after = clone(before);
    after.nodes.push(extraGate("extra_gate"));
    after.edges.push({ id: "e-extra", from: "supervisor", to: "extra_gate", kind: "normal" });

    const diff = diffTopology(before, reseal(after));
    expect(diff.graphFieldsChanged).toEqual([]);
    expect(diff.empty).toBe(false);
  });

  it("leaves graphFieldsChanged empty for a version-only change, which is still not a diff", () => {
    const bumped = reseal({ ...clone(CODING_GRAPH), graphVersion: "1.1.0" });
    const diff = diffTopology(CODING_GRAPH, bumped);
    expect(diff.graphFieldsChanged).toEqual([]);
    expect(diff.empty).toBe(true);
  });

  it("leaves graphFieldsChanged empty when only the checksum field differs", () => {
    const restamped: TopologySpec = { ...clone(CODING_GRAPH), checksum: `sha256:${"b".repeat(64)}` };
    const diff = diffTopology(CODING_GRAPH, restamped);
    expect(diff.graphFieldsChanged).toEqual([]);
    expect(diff.empty).toBe(true);
  });
});

// ── sc-3-6: graphVersion ────────────────────────────────────────────

describe("diffTopology graphVersion", () => {
  it("reports bumped:false for a structural change with an unchanged version", async () => {
    const before = await loadFixture("valid");
    const after = clone(before);
    after.nodes.push(extraGate("extra_gate"));

    const diff = diffTopology(before, reseal(after));
    expect(diff.empty).toBe(false);
    expect(diff.graphVersion.from).toBe("1.0.0");
    expect(diff.graphVersion.to).toBe("1.0.0");
    expect(diff.graphVersion.bumped).toBe(false);
  });

  it("reports bumped:true when the version moved forward alongside the change", async () => {
    const before = await loadFixture("valid");
    const after = clone(before);
    after.nodes.push(extraGate("extra_gate"));
    after.graphVersion = "1.0.1";

    const diff = diffTopology(before, reseal(after));
    expect(diff.empty).toBe(false);
    expect(diff.graphVersion).toEqual({ from: "1.0.0", to: "1.0.1", bumped: true });
  });

  it.each([
    { from: "1.0.0", to: "1.0.0", expected: false },
    { from: "1.0.0", to: "1.0.1", expected: true },
    { from: "1.0.0", to: "1.1.0", expected: true },
    { from: "1.9.9", to: "2.0.0", expected: true },
    { from: "1.1.0", to: "1.0.0", expected: false },
    { from: "2.0.0", to: "1.9.9", expected: false },
    { from: "1.0.0", to: "1.0.10", expected: true },
    { from: "1.0.2", to: "1.0.10", expected: true },
  ])("isVersionBumped($from -> $to) === $expected", ({ from, to, expected }) => {
    expect(isVersionBumped(from, to)).toBe(expected);
  });
});

// ── Error handling and serialization ────────────────────────────────

describe("diffTopology rejection", () => {
  it("throws TypeError when the left input is not a topology", () => {
    const bad = { nodes: [] } as unknown as TopologySpec;
    expect(() => diffTopology(bad, CODING_GRAPH)).toThrow(TypeError);
    expect(() => diffTopology(bad, CODING_GRAPH)).toThrow(/left topology/);
  });

  it("throws TypeError when the right input is not a topology", () => {
    const bad = JSON.parse(JSON.stringify(CODING_GRAPH)) as Record<string, unknown>;
    delete bad.entry;
    expect(() => diffTopology(CODING_GRAPH, bad as unknown as TopologySpec)).toThrow(TypeError);
    expect(() => diffTopology(CODING_GRAPH, bad as unknown as TopologySpec)).toThrow(
      /right topology/,
    );
  });

  it("names the offending path in the error message", () => {
    const bad = JSON.parse(JSON.stringify(CODING_GRAPH)) as Record<string, unknown>;
    bad.graphVersion = "not-a-version";
    expect(() => diffTopology(bad as unknown as TopologySpec, CODING_GRAPH)).toThrow(
      /graphVersion/,
    );
  });
});

describe("serializeTopologyDiff", () => {
  it("emits parseable JSON with a trailing newline", () => {
    const text = serializeTopologyDiff(diffTopology(CODING_GRAPH, CODING_GRAPH));
    expect(text.endsWith("}\n")).toBe(true);
    expect(JSON.parse(text)).toMatchObject({ empty: true });
  });

  it("is deterministic", async () => {
    const before = await loadFixture("valid");
    const after = clone(before);
    after.nodes.push(extraGate("extra_gate"));
    const first = serializeTopologyDiff(diffTopology(before, reseal(after)));
    const second = serializeTopologyDiff(diffTopology(before, reseal(after)));
    expect(first).toBe(second);
  });
});
