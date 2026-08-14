import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TopologySpecSchema } from "../../contracts/topology.js";
import type { NodeSpec, TopologySpec } from "../../contracts/topology.js";
import { checksumTopology } from "./canonical.js";
import { CODING_GRAPH } from "./coding.graph.js";
import { RENDER_FORMATS, isRenderFormat, recoveryRoutes, renderTopology } from "./render.js";

/**
 * sc-3-1 / sc-3-2 — the diagram is DERIVED from the artifact.
 *
 * The mermaid output is pinned by a golden file (`__fixtures__/coding.mermaid`) exactly
 * as a snapshot would be: any change to the committed coding topology moves the file
 * and the test fails until it is regenerated.
 *
 * No mermaid parser is in this repository's dependency tree and adding one is out of
 * scope, so "a mermaid parser accepts it" is asserted by a strict grammar check over
 * every emitted line plus a reference check that every id used in a link is declared —
 * the two failure classes a parser would report.
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

// ── A strict mermaid grammar ────────────────────────────────────────

const MERMAID_HEADER = "flowchart TD";
const NODE_DECL = /^ {2}([A-Za-z_][A-Za-z0-9_]*)(\[\[|\{\{|\(\[|\[)"([^"]*)"(\]\]|\}\}|\]\)|\])$/;
const LINK = /^ {2}([A-Za-z_][A-Za-z0-9_]*) (-->|==>|-\.->)(?:\|"([^"]*)"\|)? ([A-Za-z_][A-Za-z0-9_]*)$/;
const COMMENT = /^ {2}%% .*$/;

interface MermaidParse {
  declared: Set<string>;
  links: Array<{ from: string; to: string; arrow: string; label?: string }>;
}

/**
 * Parse the mermaid source strictly and throw on anything a real parser would reject:
 * an unknown line shape, an unbalanced bracket pair, a reserved bare keyword as an id,
 * or a link naming an id that was never declared.
 */
function parseMermaid(text: string): MermaidParse {
  const lines = text.split("\n");
  expect(lines.at(-1)).toBe("");
  expect(lines[0]).toBe(MERMAID_HEADER);

  const declared = new Set<string>();
  const links: MermaidParse["links"] = [];
  const closers: Record<string, string> = { "[[": "]]", "{{": "}}", "([": "])", "[": "]" };

  for (const line of lines.slice(1, -1)) {
    if (COMMENT.test(line)) continue;
    const decl = NODE_DECL.exec(line);
    if (decl) {
      const [, id, open, label, close] = decl;
      if (closers[open] !== close) throw new Error(`unbalanced shape on: ${line}`);
      if (id.toLowerCase() === "end" && id !== "END") {
        throw new Error(`reserved mermaid keyword used as an id: ${line}`);
      }
      if (declared.has(id)) throw new Error(`duplicate node declaration: ${line}`);
      expect(label.length).toBeGreaterThan(0);
      declared.add(id);
      continue;
    }
    const link = LINK.exec(line);
    if (link) {
      const [, from, arrow, label, to] = link;
      links.push({ from, to, arrow, label });
      continue;
    }
    throw new Error(`unparseable mermaid line: ${JSON.stringify(line)}`);
  }

  for (const link of links) {
    if (!declared.has(link.from)) throw new Error(`link from undeclared id "${link.from}"`);
    if (!declared.has(link.to)) throw new Error(`link to undeclared id "${link.to}"`);
  }
  return { declared, links };
}

// ── A strict dot reader ─────────────────────────────────────────────

const DOT_NODE = /^ {2}"([^"]+)" \[/;
const DOT_EDGE = /^ {2}"([^"]+)" -> "([^"]+)"/;

function dotNodeIds(text: string): string[] {
  return text
    .split("\n")
    .map((line) => DOT_NODE.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1]);
}

function dotEdges(text: string): Array<{ from: string; to: string }> {
  return text
    .split("\n")
    .map((line) => DOT_EDGE.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ from: m[1], to: m[2] }));
}

// ── sc-3-1: mermaid ─────────────────────────────────────────────────

describe("renderTopology mermaid", () => {
  it("matches the committed golden for the shipped coding topology", async () => {
    const golden = await readFile(`${FIXTURE_DIR}coding.mermaid`, "utf8");
    expect(renderTopology(CODING_GRAPH, "mermaid")).toBe(golden);
  });

  it("emits text the mermaid grammar accepts, with every linked id declared", () => {
    const parsed = parseMermaid(renderTopology(CODING_GRAPH, "mermaid"));
    expect(parsed.declared.size).toBe(CODING_GRAPH.nodes.length + 1); // + the terminal
    expect(parsed.declared.has("END")).toBe(true);
    expect(parsed.links.length).toBeGreaterThan(CODING_GRAPH.edges.length);
  });

  it("accepts the fixture graph too", async () => {
    const spec = await loadFixture("valid");
    const parsed = parseMermaid(renderTopology(spec, "mermaid"));
    expect(parsed.declared.size).toBe(spec.nodes.length + 1);
  });

  it("changes when one node is added to a fixture graph", async () => {
    const before = await loadFixture("valid");
    const after = clone(before);
    const extra: NodeSpec = {
      id: "zz_extra_gate",
      kind: "gate",
      title: "Extra gate",
      doc: "An extra gate added to prove the diagram tracks the artifact.",
      subgraph: null,
      role: "utility",
      inputPorts: [],
      outputPorts: [],
      reads: [],
      writes: [],
      effects: [],
      gate: { check: "extra", onFail: "END" },
    };
    after.nodes.push(extra);

    const beforeText = renderTopology(before, "mermaid");
    const afterText = renderTopology(reseal(after), "mermaid");
    expect(afterText).not.toBe(beforeText);
    expect(beforeText).not.toContain("zz_extra_gate");
    expect(afterText).toContain('zz_extra_gate["zz_extra_gate"]');
    // The header carries the counts, so the size of the graph is visible in the diff.
    expect(beforeText).toContain(`${before.nodes.length} nodes`);
    expect(afterText).toContain(`${before.nodes.length + 1} nodes`);
  });

  it("uses the blueprint shapes: {{subgraph}}, [[hitl]], router labels and ([END])", () => {
    const text = renderTopology(CODING_GRAPH, "mermaid");
    expect(text).toContain('research_body{{"subgraph research_body"}}');
    expect(text).toContain('sprint_body{{"subgraph sprint_body"}}');
    expect(text).toContain('hitl_commit[["hitl hitl_commit"]]');
    expect(text).toContain('plan_clarify[["hitl plan_clarify"]]');
    expect(text).toContain('supervisor["router supervisor"]');
    expect(text).toContain('END(["END"])');
    // A plain llm node keeps the plain rectangle and the bare id.
    expect(text).toContain('plan_draft["plan_draft"]');
  });

  it("labels router edges with the outcome label and fan-out edges with fanout", () => {
    const text = renderTopology(CODING_GRAPH, "mermaid");
    expect(text).toContain('supervisor -->|"sprints"| fanout_sprints');
    expect(text).toContain('fanout_sprints ==>|"dispatch"| sprint_body');
  });

  it("draws policy recovery routes as dotted links", () => {
    const text = renderTopology(CODING_GRAPH, "mermaid");
    expect(text).toContain('gate_syntax -.->|"onFail"| sprint_correct');
    expect(text).toContain('supervisor -.->|"onExhausted"| graceful_failure');
    expect(text).toContain('hitl_commit -.->|"onReject"| graceful_failure');
    expect(text).toContain('reduce_sprints -.->|"onFail"| fanout_sprints');
  });

  it("renders one dotted link per resolvable policy endpoint", () => {
    const routes = recoveryRoutes(CODING_GRAPH);
    const dotted = renderTopology(CODING_GRAPH, "mermaid")
      .split("\n")
      .filter((line) => line.includes("-.->"));
    // 24 = 13 gate.onFail routes + 3 hitl.onReject routes (hitl_commit, plan_clarify and,
    // since spec-20260814-pge-full-convergence sprint 3, gate_plan_out) + 8 loop.onExhausted
    // routes, one per loop-bearing node (including the three retry cycles that bypass
    // their region's router: reduce_sprints, gate_mock_coverage and sprint_correct).
    // 23 before this sprint declared gate_plan_out's post-sprint-contract checkpoint.
    expect(routes.length).toBe(24);
    expect(dotted).toHaveLength(routes.length);
  });

  it("sanitizes ids that mermaid would choke on", () => {
    const spec = clone(CODING_GRAPH);
    const target = spec.nodes.find((n) => n.id === "finalize");
    if (!target) throw new Error("fixture drift: coding graph has no finalize node");
    target.id = "end";
    for (const edge of spec.edges) {
      if (edge.from === "finalize") edge.from = "end";
      if (edge.to === "finalize") edge.to = "end";
    }
    const text = renderTopology(reseal(spec), "mermaid");
    expect(text).toContain('n_end["end"]');
    expect(text).not.toContain('  end["end"]');
    expect(() => parseMermaid(text)).not.toThrow();
  });
});

// ── sc-3-2: dot ─────────────────────────────────────────────────────

describe("renderTopology dot", () => {
  it("emits exactly one node statement per declared node and one edge per declared edge", () => {
    const text = renderTopology(CODING_GRAPH, "dot");
    const nodes = dotNodeIds(text);
    const edges = dotEdges(text);
    expect(nodes).toHaveLength(CODING_GRAPH.nodes.length);
    expect(edges).toHaveLength(CODING_GRAPH.edges.length);
    expect([...nodes].sort()).toEqual([...CODING_GRAPH.nodes.map((n) => n.id)].sort());
    expect(edges.map((e) => `${e.from}->${e.to}`).sort()).toEqual(
      CODING_GRAPH.edges.map((e) => `${e.from}->${e.to}`).sort(),
    );
  });

  it("holds the same 1:1 property on the fixture graph", async () => {
    const spec = await loadFixture("valid");
    const text = renderTopology(spec, "dot");
    expect(dotNodeIds(text)).toHaveLength(spec.nodes.length);
    expect(dotEdges(text)).toHaveLength(spec.edges.length);
  });

  it("does not emit the reserved terminal as a node statement", () => {
    const text = renderTopology(CODING_GRAPH, "dot");
    expect(dotNodeIds(text)).not.toContain("END");
    // ...even though a declared edge targets it.
    expect(dotEdges(text).some((e) => e.to === "END")).toBe(true);
  });

  it("omits policy recovery routes, keeping the edge count exactly spec.edges.length", () => {
    const text = renderTopology(CODING_GRAPH, "dot");
    expect(text).not.toContain("onFail");
    expect(text).not.toContain("onExhausted");
    expect(dotEdges(text)).toHaveLength(CODING_GRAPH.edges.length);
  });

  it("opens a digraph named for the graph and closes it", () => {
    const text = renderTopology(CODING_GRAPH, "dot");
    expect(text.startsWith('digraph "coding" {\n')).toBe(true);
    expect(text.endsWith("}\n")).toBe(true);
  });

  it("gives each node kind its own shape and marks hitl nodes", () => {
    const text = renderTopology(CODING_GRAPH, "dot");
    expect(text).toContain('"supervisor" [label="supervisor", shape=diamond];');
    expect(text).toContain('"research_body" [label="research_body", shape=hexagon];');
    expect(text).toContain('"gate_syntax" [label="gate_syntax", shape=box];');
    expect(text).toContain(
      '"hitl_commit" [label="hitl_commit", shape=box, peripheries=2];',
    );
  });

  it("matches the committed dot golden", async () => {
    const golden = await readFile(`${FIXTURE_DIR}coding.dot`, "utf8");
    expect(renderTopology(CODING_GRAPH, "dot")).toBe(golden);
  });
});

// ── Determinism ─────────────────────────────────────────────────────

describe("render determinism", () => {
  it.each(RENDER_FORMATS)("%s output is byte-identical across calls", (format) => {
    expect(renderTopology(CODING_GRAPH, format)).toBe(renderTopology(CODING_GRAPH, format));
  });

  it.each(RENDER_FORMATS)("%s output is invariant to declaration order", (format) => {
    const shuffled = clone(CODING_GRAPH);
    shuffled.nodes.reverse();
    shuffled.edges.reverse();
    shuffled.channels.reverse();
    expect(renderTopology(shuffled, format)).toBe(renderTopology(CODING_GRAPH, format));
  });

  it("renders nothing that depends on the prompt store or the checksum field", () => {
    const restamped = { ...clone(CODING_GRAPH), checksum: `sha256:${"a".repeat(64)}` as const };
    expect(renderTopology(restamped, "mermaid")).toBe(renderTopology(CODING_GRAPH, "mermaid"));
  });
});

describe("isRenderFormat", () => {
  it.each([
    { value: "mermaid", expected: true },
    { value: "dot", expected: true },
    { value: "svg", expected: false },
    { value: "", expected: false },
    { value: "constructor", expected: false },
  ])("returns $expected for $value", ({ value, expected }) => {
    expect(isRenderFormat(value)).toBe(expected);
  });
});
