import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  GateNode,
  LoopBound,
  NodeSpec,
  RouterNode,
  TopologySpec,
} from "../../contracts/topology.js";
import { NodeSchema, TopologySpecSchema } from "../../contracts/topology.js";
import { CODING_GRAPH } from "./coding.graph.js";
import {
  DOC_NODES_BEGIN,
  DOC_NODES_END,
  checkDocDrift,
  docDrift,
  docDriftReport,
  documentedNodeIds,
} from "./docs.js";
import { readTopologyArtifact, topologyArtifactPath } from "./dump.js";

/**
 * sc-3-7 — the doc-drift checker returns the symmetric difference between the node ids
 * a document declares and the node ids the artifact declares, and is empty ONLY when
 * the two sets are equal.
 *
 * Tests use real temp files; nothing mocks the filesystem.
 */

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bober-pge-docs-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A document that documents exactly `ids`, plus prose that must be ignored. */
function docFor(ids: readonly string[]): string {
  return [
    "# PGE graph",
    "",
    "The artifact is a `TopologySpec` carrying a `graphVersion` and a `checksum`.",
    "",
    DOC_NODES_BEGIN,
    ...ids.map((id) => `- \`${id}\` — a documented node`),
    DOC_NODES_END,
    "",
    "See `docs/pge-graph.md` for the rest.",
    "",
  ].join("\n");
}

function allNodeIds(spec: TopologySpec): string[] {
  return spec.nodes.map((node) => node.id).sort();
}

// ── Extraction ──────────────────────────────────────────────────────

describe("documentedNodeIds", () => {
  it("reads ids only from inside the marker block", () => {
    expect(documentedNodeIds(docFor(["supervisor", "commit"]))).toEqual(["commit", "supervisor"]);
  });

  it("ignores code spans outside the block, including schema and field names", () => {
    const ids = documentedNodeIds(docFor(["supervisor"]));
    expect(ids).toEqual(["supervisor"]);
    expect(ids).not.toContain("TopologySpec");
    expect(ids).not.toContain("graphVersion");
    expect(ids).not.toContain("checksum");
  });

  it("returns an empty list when the document has no marker block", () => {
    expect(documentedNodeIds("# PGE graph\n\nMentions `supervisor` in prose only.\n")).toEqual([]);
  });

  it("de-duplicates and sorts", () => {
    const doc = [DOC_NODES_BEGIN, "`zeta` `alpha` `zeta` `alpha`", DOC_NODES_END].join("\n");
    expect(documentedNodeIds(doc)).toEqual(["alpha", "zeta"]);
  });

  it("concatenates multiple marker blocks", () => {
    const doc = [
      DOC_NODES_BEGIN,
      "- `alpha`",
      DOC_NODES_END,
      "prose with `ignored_span`",
      DOC_NODES_BEGIN,
      "- `beta`",
      DOC_NODES_END,
    ].join("\n");
    expect(documentedNodeIds(doc)).toEqual(["alpha", "beta"]);
  });

  it("reads an unterminated block to the end of the document", () => {
    const doc = [DOC_NODES_BEGIN, "- `alpha`", "- `beta`"].join("\n");
    expect(documentedNodeIds(doc)).toEqual(["alpha", "beta"]);
  });

  it("ignores code spans that are not bare identifiers", () => {
    const doc = [
      DOC_NODES_BEGIN,
      "- `.bober/topology/coding.json`",
      "- `spec.nodes[0].id`",
      "- `bober pge render`",
      "- `real_node`",
      DOC_NODES_END,
    ].join("\n");
    expect(documentedNodeIds(doc)).toEqual(["real_node"]);
  });
});

// ── sc-3-7: symmetric difference ────────────────────────────────────

describe("docDrift", () => {
  it("returns an empty array only when the two sets are equal", () => {
    const complete = docFor(allNodeIds(CODING_GRAPH));
    expect(docDrift(CODING_GRAPH, complete)).toEqual([]);

    const oneShort = docFor(allNodeIds(CODING_GRAPH).filter((id) => id !== "supervisor"));
    expect(docDrift(CODING_GRAPH, oneShort)).toEqual(["supervisor"]);
  });

  it("reports a documented node that no longer exists", () => {
    const doc = docFor([...allNodeIds(CODING_GRAPH), "node_that_was_deleted"]);
    expect(docDrift(CODING_GRAPH, doc)).toEqual(["node_that_was_deleted"]);
  });

  it("reports drift in BOTH directions at once, sorted", () => {
    const ids = allNodeIds(CODING_GRAPH).filter((id) => id !== "commit");
    const doc = docFor([...ids, "aaa_ghost"]);
    expect(docDrift(CODING_GRAPH, doc)).toEqual(["aaa_ghost", "commit"]);
  });

  it("treats a document with no marker block as documenting nothing", () => {
    const drift = docDrift(CODING_GRAPH, "# PGE graph\n\nNo block here.\n");
    expect(drift).toEqual(allNodeIds(CODING_GRAPH));
    expect(drift).toHaveLength(CODING_GRAPH.nodes.length);
  });

  it("is insensitive to the order ids appear in the document", () => {
    const forward = docFor(allNodeIds(CODING_GRAPH));
    const backward = docFor([...allNodeIds(CODING_GRAPH)].reverse());
    expect(docDrift(CODING_GRAPH, forward)).toEqual(docDrift(CODING_GRAPH, backward));
    expect(docDrift(CODING_GRAPH, backward)).toEqual([]);
  });
});

describe("docDriftReport", () => {
  it("separates missing from extra", () => {
    const ids = allNodeIds(CODING_GRAPH).filter((id) => id !== "documenter");
    const report = docDriftReport(CODING_GRAPH, docFor([...ids, "ghost_node"]));
    expect(report.missing).toEqual(["documenter"]);
    expect(report.extra).toEqual(["ghost_node"]);
    expect(report.declared).toEqual(allNodeIds(CODING_GRAPH));
    expect(report.documented).toContain("ghost_node");
    expect(report.drift).toEqual(["documenter", "ghost_node"]);
  });

  it("reports nothing missing and nothing extra for a complete document", () => {
    const report = docDriftReport(CODING_GRAPH, docFor(allNodeIds(CODING_GRAPH)));
    expect(report.missing).toEqual([]);
    expect(report.extra).toEqual([]);
    expect(report.drift).toEqual([]);
    expect(report.documented).toEqual(report.declared);
  });
});

// ── The filesystem wrapper ──────────────────────────────────────────

describe("checkDocDrift", () => {
  it("reads the document from disk and agrees with the pure function", async () => {
    const path = join(root, "pge-graph.md");
    const text = docFor(allNodeIds(CODING_GRAPH).filter((id) => id !== "critique"));
    await writeFile(path, text, "utf8");
    expect(await checkDocDrift(CODING_GRAPH, path)).toEqual(["critique"]);
    expect(await checkDocDrift(CODING_GRAPH, path)).toEqual(docDrift(CODING_GRAPH, text));
  });

  it("returns an empty array for a document that matches the artifact exactly", async () => {
    const path = join(root, "complete.md");
    await writeFile(path, docFor(allNodeIds(CODING_GRAPH)), "utf8");
    expect(await checkDocDrift(CODING_GRAPH, path)).toEqual([]);
  });

  it("rejects rather than reporting a clean document when the file is missing", async () => {
    await expect(checkDocDrift(CODING_GRAPH, join(root, "absent.md"))).rejects.toThrow(/ENOENT/);
  });

  it("uses the markers the module exports", () => {
    expect(DOC_NODES_BEGIN).toBe("<!-- pge:nodes -->");
    expect(DOC_NODES_END).toBe("<!-- /pge:nodes -->");
  });
});

// ════════════════════════════════════════════════════════════════════
// sc-14-7 / sc-14-8 — the SHIPPED document against the COMMITTED artifact
// ════════════════════════════════════════════════════════════════════
//
// Everything below reads two real files: `docs/pge-graph.md` and
// `.bober/topology/coding.json`. Neither is ever written to — every negative control
// mutates an in-memory FIXTURE spec, never the committed artifact (HARD RULE 5).
//
// The document carries five machine-checked tables, each in its own marker region. Only
// the `pge:nodes` regions are read by the drift checker; the other four are read here, so
// the document cannot claim a gate check, a loop bound, a router outcome, an edge or a
// channel writer that the artifact does not declare — and cannot omit one either.
//
// EVERY assertion below is paired with a negative control that breaks the precondition on
// a fixture and proves the assertion fails. A gate that cannot fail is not a gate.

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DOC_PATH = join(REPO_ROOT, "docs", "pge-graph.md");
const ARTIFACT_PATH = topologyArtifactPath(REPO_ROOT, "coding");

const DOC_GATES_BEGIN = "<!-- pge:gates -->";
const DOC_GATES_END = "<!-- /pge:gates -->";
const DOC_LOOPS_BEGIN = "<!-- pge:loops -->";
const DOC_LOOPS_END = "<!-- /pge:loops -->";
const DOC_ROUTERS_BEGIN = "<!-- pge:routers -->";
const DOC_ROUTERS_END = "<!-- /pge:routers -->";
const DOC_EDGES_BEGIN = "<!-- pge:edges -->";
const DOC_EDGES_END = "<!-- /pge:edges -->";
const DOC_CHANNELS_BEGIN = "<!-- pge:channels -->";
const DOC_CHANNELS_END = "<!-- /pge:channels -->";

/** The committed artifact, parsed. Not `CODING_GRAPH` — sc-14-7 names the ARTIFACT. */
let committed: TopologySpec;
/** The same artifact BEFORE Zod parsing, so key-absence claims are about the bytes. */
let committedRaw: { edges: Record<string, unknown>[]; nodes: Record<string, unknown>[] };
/** The shipped `docs/pge-graph.md`, read from disk. */
let shippedDoc = "";

beforeAll(async () => {
  const read = await readTopologyArtifact(ARTIFACT_PATH);
  if (!read.ok) {
    throw new Error(`${ARTIFACT_PATH} is not readable as a topology artifact: ${read.message}`);
  }
  committed = TopologySpecSchema.parse(read.raw);
  committedRaw = read.raw as {
    edges: Record<string, unknown>[];
    nodes: Record<string, unknown>[];
  };
  shippedDoc = await readFile(DOC_PATH, "utf8");
});

// ── Reading the document's tables ───────────────────────────────────

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Every region delimited by `begin`/`end`, in document order. */
function regionsBetween(doc: string, begin: string, end: string): string[] {
  const found: string[] = [];
  let cursor = 0;
  for (;;) {
    const start = doc.indexOf(begin, cursor);
    if (start === -1) break;
    const contentStart = start + begin.length;
    const stop = doc.indexOf(end, contentStart);
    if (stop === -1) {
      throw new Error(`docs/pge-graph.md opens ${begin} and never closes it with ${end}`);
    }
    found.push(doc.slice(contentStart, stop));
    cursor = stop + end.length;
  }
  return found;
}

/**
 * Markdown table rows inside the named regions, one row per array of trimmed cells.
 *
 * Backticks are STRIPPED, so the document may render an id as a code span without the
 * comparison caring. The header row of each region is dropped and separator rows are
 * discarded, so a table gains no rows by being prettier.
 */
function tableRows(doc: string, begin: string, end: string): string[][] {
  const regions = regionsBetween(doc, begin, end);
  if (regions.length === 0) {
    throw new Error(`docs/pge-graph.md has no ${begin} region`);
  }
  const rows: string[][] = [];
  for (const region of regions) {
    const parsed = region
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("|"))
      .map((line) =>
        line
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split("|")
          .map((cell) => cell.trim().replace(/`/g, "")),
      )
      .filter((cells) => !cells.every((cell) => /^:?-+:?$/.test(cell)));
    rows.push(...parsed.slice(1));
  }
  return rows;
}

function sortRows(rows: readonly string[][]): string[][] {
  return [...rows].sort((a, b) => compare(a.join("\u0000"), b.join("\u0000")));
}

/**
 * The document's table must equal the artifact's rows FIELD BY FIELD.
 *
 * Two assertions, deliberately: the first compares the two-cell keys so a missing or
 * phantom row names itself, the second compares whole rows so a wrong value in any other
 * column cannot pass.
 */
function assertTableMatches(
  doc: string,
  begin: string,
  end: string,
  expected: readonly string[][],
  label: string,
): void {
  const documented = sortRows(tableRows(doc, begin, end));
  const want = sortRows(expected);
  expect(
    documented.map((row) => row.slice(0, 2).join(" ")),
    `${label}: the documented rows are not the artifact's rows`,
  ).toEqual(want.map((row) => row.slice(0, 2).join(" ")));
  expect(documented, `${label}: a documented field disagrees with the artifact`).toEqual(want);
}

// ── Deriving the expected rows FROM THE ARTIFACT ────────────────────

type LoopNode = NodeSpec & { loop: LoopBound };

function gateNodes(spec: TopologySpec): GateNode[] {
  return spec.nodes.filter((node): node is GateNode => node.kind === "gate");
}

function routerNodes(spec: TopologySpec): RouterNode[] {
  return spec.nodes.filter((node): node is RouterNode => node.kind === "router");
}

function loopNodes(spec: TopologySpec): LoopNode[] {
  return spec.nodes.filter((node): node is LoopNode => node.loop !== undefined);
}

function expectedNodeRows(spec: TopologySpec): string[][] {
  return spec.nodes.map((node) => [node.id, node.kind]);
}

function expectedGateRows(spec: TopologySpec): string[][] {
  return gateNodes(spec).map((gate) => [
    gate.id,
    gate.subgraph ?? "root",
    gate.gate.check,
    gate.gate.onFail,
    gate.inputPorts.length === 0
      ? "(none)"
      : gate.inputPorts.map((port) => `${port.key}:${port.schemaRef}`).join("; "),
    gate.hitl === undefined ? "(none)" : gate.hitl.checkpointId,
  ]);
}

function expectedLoopRows(spec: TopologySpec): string[][] {
  return loopNodes(spec).map((node) => [
    node.id,
    node.kind,
    node.loop.counterKey,
    String(node.loop.maxIterations),
    node.loop.onExhausted,
  ]);
}

function expectedRouterRows(spec: TopologySpec): string[][] {
  return routerNodes(spec).flatMap((router) =>
    router.targets.map((target) => [router.id, target.label, target.to]),
  );
}

function expectedEdgeRows(spec: TopologySpec): string[][] {
  return spec.edges.map((edge) => [
    edge.from,
    edge.to,
    edge.kind,
    edge.label ?? "(none)",
    edge.ports === undefined ? "(none)" : `${edge.ports.from}->${edge.ports.to}`,
  ]);
}

function expectedChannelRows(spec: TopologySpec): string[][] {
  return spec.channels.map((channel) => [
    channel.id,
    channel.scope,
    channel.reducerRef,
    channel.schemaRef,
    spec.nodes
      .filter((node) => node.writes.includes(channel.id))
      .map((node) => node.id)
      .sort(compare)
      .join(", "),
  ]);
}

// ── Fixture mutation (never the committed artifact) ─────────────────

/** Re-parses through `NodeSchema`, so a fixture mutation is always a LEGAL node. */
function patchNode(node: NodeSpec, fields: Record<string, unknown>): NodeSpec {
  return NodeSchema.parse({ ...node, ...fields });
}

function withNode(spec: TopologySpec, id: string, fields: Record<string, unknown>): TopologySpec {
  const found = spec.nodes.some((node) => node.id === id);
  if (!found) throw new Error(`fixture error: no node "${id}" to patch`);
  return {
    ...spec,
    nodes: spec.nodes.map((node) => (node.id === id ? patchNode(node, fields) : node)),
  };
}

function withExtraNode(spec: TopologySpec, id: string): TopologySpec {
  return {
    ...spec,
    nodes: [
      ...spec.nodes,
      NodeSchema.parse({
        id,
        kind: "gate",
        title: "A fixture-only gate",
        doc: "Exists only inside this test's in-memory fixture.",
        subgraph: null,
        gate: { check: "fixture-only", onFail: "graceful_failure" },
      }),
    ],
  };
}

function withoutNode(spec: TopologySpec, id: string): TopologySpec {
  return { ...spec, nodes: spec.nodes.filter((node) => node.id !== id) };
}

// ── sc-14-7: every node in the committed artifact is documented ─────

describe("sc-14-7 — docs/pge-graph.md documents every node in the committed artifact", () => {
  it("exists, is non-trivial, and carries at least one node region", () => {
    expect(shippedDoc.length).toBeGreaterThan(2000);
    expect(regionsBetween(shippedDoc, DOC_NODES_BEGIN, DOC_NODES_END).length).toBeGreaterThan(0);
  });

  it("documents a node id set EQUAL to the committed artifact's", () => {
    const report = docDriftReport(committed, shippedDoc);
    expect(report.missing, "nodes declared in the artifact but absent from the document").toEqual(
      [],
    );
    expect(report.extra, "nodes named in the document that the artifact does not declare").toEqual(
      [],
    );
    expect(report.drift).toEqual([]);
    expect(report.documented).toEqual(report.declared);
    expect(report.documented).toHaveLength(committed.nodes.length);
    expect(report.documented).toHaveLength(44);
  });

  it("agrees when the document is read from disk through checkDocDrift", async () => {
    expect(await checkDocDrift(committed, DOC_PATH)).toEqual([]);
  });

  it("documents the kind of every node, not merely its id", () => {
    const rows = tableRows(shippedDoc, DOC_NODES_BEGIN, DOC_NODES_END);
    expect(sortRows(rows.map((row) => row.slice(0, 2)))).toEqual(
      sortRows(expectedNodeRows(committed)),
    );
    // …and every row explains the node rather than merely naming it.
    for (const row of rows) {
      expect(row[2] ?? "", `node "${row[0]}" is listed with no description`).not.toBe("");
    }
  });

  it("covers the in-code CODING_GRAPH too, so the artifact and its source agree", () => {
    expect(committed.nodes.map((node) => node.id).sort(compare)).toEqual(
      CODING_GRAPH.nodes.map((node) => node.id).sort(compare),
    );
    expect(docDrift(CODING_GRAPH, shippedDoc)).toEqual([]);
  });

  // ── NEGATIVE CONTROLS ──

  it("FAILS when a fixture artifact adds a node the document does not mention", async () => {
    const fixture = withExtraNode(committed, "fixture_only_gate");
    expect(fixture.nodes).toHaveLength(committed.nodes.length + 1);

    const report = docDriftReport(fixture, shippedDoc);
    expect(report.missing).toEqual(["fixture_only_gate"]);
    expect(report.drift).toEqual(["fixture_only_gate"]);

    // The passing assertion, run against the mutated fixture, must THROW.
    expect(() => {
      expect(docDrift(fixture, shippedDoc)).toEqual([]);
    }).toThrow();

    // …and through the filesystem wrapper against the REAL document, too.
    expect(await checkDocDrift(fixture, DOC_PATH)).toEqual(["fixture_only_gate"]);
  });

  it("FAILS when a fixture artifact drops a node the document still documents", () => {
    const fixture = withoutNode(committed, "sprint_review");
    const report = docDriftReport(fixture, shippedDoc);
    expect(report.extra).toEqual(["sprint_review"]);
    expect(() => {
      expect(docDrift(fixture, shippedDoc)).toEqual([]);
    }).toThrow();
  });

  it("FAILS when the document loses a node region", () => {
    const stripped = shippedDoc.split(DOC_NODES_BEGIN).join("<!-- removed -->");
    expect(documentedNodeIds(stripped)).toEqual([]);
    expect(docDrift(committed, stripped)).toHaveLength(committed.nodes.length);
    expect(() => {
      expect(docDrift(committed, stripped)).toEqual([]);
    }).toThrow();
  });

  it("FAILS when a documented node id is silently misspelled", () => {
    // The inventory row, not a prose mention: "| `gate_syntax` | gate |" is unique to it.
    const typo = shippedDoc.replace("| `gate_syntax` | gate |", "| `gate_sintax` | gate |");
    expect(typo).not.toBe(shippedDoc);
    expect(docDriftReport(committed, typo).drift).toEqual(["gate_sintax", "gate_syntax"]);
    expect(() => {
      expect(docDrift(committed, typo)).toEqual([]);
    }).toThrow();
  });
});

// ── sc-14-8: gates and loop bounds, cross-checked field by field ────

describe("sc-14-8 — every gate's schema and failure route are documented", () => {
  it("documents check, failure route, validated port schema and human checkpoint", () => {
    expect(gateNodes(committed)).toHaveLength(13);
    assertTableMatches(
      shippedDoc,
      DOC_GATES_BEGIN,
      DOC_GATES_END,
      expectedGateRows(committed),
      "gate table",
    );
  });

  it("documents a schema for every gate that declares an input port", () => {
    const rows = new Map(
      tableRows(shippedDoc, DOC_GATES_BEGIN, DOC_GATES_END).map((row) => [row[0], row]),
    );
    for (const gate of gateNodes(committed)) {
      const row = rows.get(gate.id);
      expect(row, `gate "${gate.id}" has no row in the gate table`).toBeDefined();
      if (row === undefined) continue;
      expect(row[3], `gate "${gate.id}" documents the wrong failure route`).toBe(gate.gate.onFail);
      for (const port of gate.inputPorts) {
        expect(row[4], `gate "${gate.id}" does not document schema ${port.schemaRef}`).toContain(
          port.schemaRef,
        );
      }
      if (gate.inputPorts.length === 0) {
        expect(row[4], `gate "${gate.id}" declares no ports; that is data, not a hole`).toBe(
          "(none)",
        );
      }
    }
  });

  // ── NEGATIVE CONTROLS ──

  it("FAILS when a fixture gate changes where it routes on failure", () => {
    const fixture = withNode(committed, "gate_syntax", {
      gate: { check: "typecheck-and-lint", onFail: "graceful_failure" },
    });
    expect(() => {
      assertTableMatches(
        shippedDoc,
        DOC_GATES_BEGIN,
        DOC_GATES_END,
        expectedGateRows(fixture),
        "gate table",
      );
    }).toThrow();
  });

  it("FAILS when a fixture gate renames its check", () => {
    const fixture = withNode(committed, "gate_plan_in", {
      gate: { check: "research-digest-absent", onFail: "graceful_failure" },
    });
    expect(() => {
      assertTableMatches(
        shippedDoc,
        DOC_GATES_BEGIN,
        DOC_GATES_END,
        expectedGateRows(fixture),
        "gate table",
      );
    }).toThrow();
  });

  it("FAILS when a fixture gate validates a different schema", () => {
    const fixture = withNode(committed, "gate_research_in", {
      inputPorts: [{ key: "request", required: true, schemaRef: "PlanSpec" }],
    });
    expect(() => {
      assertTableMatches(
        shippedDoc,
        DOC_GATES_BEGIN,
        DOC_GATES_END,
        expectedGateRows(fixture),
        "gate table",
      );
    }).toThrow();
  });

  it("FAILS when a fixture adds a gate the table does not list", () => {
    const fixture = withExtraNode(committed, "fixture_only_gate");
    expect(gateNodes(fixture)).toHaveLength(14);
    expect(() => {
      assertTableMatches(
        shippedDoc,
        DOC_GATES_BEGIN,
        DOC_GATES_END,
        expectedGateRows(fixture),
        "gate table",
      );
    }).toThrow();
  });

  it("FAILS when a fixture moves a human checkpoint to an id nothing answers", () => {
    const fixture = withNode(committed, "hitl_commit", {
      hitl: { checkpointId: "hitl-commit", onReject: "graceful_failure" },
    });
    expect(() => {
      assertTableMatches(
        shippedDoc,
        DOC_GATES_BEGIN,
        DOC_GATES_END,
        expectedGateRows(fixture),
        "gate table",
      );
    }).toThrow();
  });
});

describe("sc-14-8 — every loop bound is documented with its counter, maximum and fallthrough", () => {
  it("reads the loop bounds off NODES, because no edge carries any", () => {
    // The criterion says "cyclic edge"; the artifact puts the bound on the NODE. A drift
    // test written against edges would iterate an empty list and pass while checking
    // nothing. This asserts the list really is empty — against the RAW bytes, because
    // Zod would have stripped an unknown key before a parsed spec could show it.
    for (const edge of committedRaw.edges) {
      const keys = Object.keys(edge);
      expect(keys, `edge ${String(edge.id)} unexpectedly carries loop metadata`).not.toContain(
        "counterKey",
      );
      expect(keys).not.toContain("maxIterations");
      expect(keys).not.toContain("onExhausted");
      expect(keys).not.toContain("loop");
    }
    // The bounds are on nodes, in the raw bytes as well as in the parsed spec.
    expect(committedRaw.nodes.filter((node) => "loop" in node)).toHaveLength(8);
    expect(loopNodes(committed)).toHaveLength(8);
  });

  it("documents counterKey, maxIterations and onExhausted for all eight", () => {
    assertTableMatches(
      shippedDoc,
      DOC_LOOPS_BEGIN,
      DOC_LOOPS_END,
      expectedLoopRows(committed),
      "loop table",
    );
  });

  it("documents the SHARED counter honestly rather than implying a 1:1 mapping", () => {
    const byCounter = new Map<string, string[]>();
    for (const node of loopNodes(committed)) {
      byCounter.set(node.loop.counterKey, [
        ...(byCounter.get(node.loop.counterKey) ?? []),
        node.id,
      ]);
    }
    const shared = [...byCounter.entries()].filter(([, ids]) => ids.length > 1);
    expect(shared).toHaveLength(1);
    expect(shared[0][0]).toBe("sprintIterations");
    expect(shared[0][1].sort(compare)).toEqual(["sprint_correct", "sprint_route"]);
    expect(byCounter.size).toBe(7);

    // The document must SAY it, not merely list two rows with the same counter.
    expect(shippedDoc).toContain("sprintIterations");
    expect(shippedDoc.toLowerCase()).toContain("1:n, not 1:1");
    for (const id of shared[0][1]) {
      expect(shippedDoc).toContain(id);
    }
  });

  // ── NEGATIVE CONTROLS ──

  it("FAILS when a fixture loop changes its maximum", () => {
    const fixture = withNode(committed, "sprint_route", {
      loop: { counterKey: "sprintIterations", maxIterations: 4, onExhausted: "sprint_exit" },
    });
    expect(() => {
      assertTableMatches(
        shippedDoc,
        DOC_LOOPS_BEGIN,
        DOC_LOOPS_END,
        expectedLoopRows(fixture),
        "loop table",
      );
    }).toThrow();
  });

  it("FAILS when a fixture loop renames its counter", () => {
    const fixture = withNode(committed, "supervisor", {
      loop: { counterKey: "phaseRounds", maxIterations: 12, onExhausted: "graceful_failure" },
    });
    expect(() => {
      assertTableMatches(
        shippedDoc,
        DOC_LOOPS_BEGIN,
        DOC_LOOPS_END,
        expectedLoopRows(fixture),
        "loop table",
      );
    }).toThrow();
  });

  it("FAILS when a fixture loop falls through somewhere else on exhaustion", () => {
    const fixture = withNode(committed, "research_route", {
      loop: { counterKey: "researchReflexions", maxIterations: 3, onExhausted: "graceful_failure" },
    });
    expect(() => {
      assertTableMatches(
        shippedDoc,
        DOC_LOOPS_BEGIN,
        DOC_LOOPS_END,
        expectedLoopRows(fixture),
        "loop table",
      );
    }).toThrow();
  });

  it("FAILS when a fixture adds a ninth loop the table does not list", () => {
    const fixture = withNode(committed, "sprint_generate", {
      loop: { counterKey: "generateRounds", maxIterations: 2, onExhausted: "sprint_exit" },
    });
    expect(loopNodes(fixture)).toHaveLength(9);
    expect(() => {
      assertTableMatches(
        shippedDoc,
        DOC_LOOPS_BEGIN,
        DOC_LOOPS_END,
        expectedLoopRows(fixture),
        "loop table",
      );
    }).toThrow();
  });

  it("FAILS when a fixture drops a loop the table still lists", () => {
    const fixture = withNode(committed, "rework_route", { loop: undefined });
    expect(loopNodes(fixture)).toHaveLength(7);
    expect(() => {
      assertTableMatches(
        shippedDoc,
        DOC_LOOPS_BEGIN,
        DOC_LOOPS_END,
        expectedLoopRows(fixture),
        "loop table",
      );
    }).toThrow();
  });
});

// ── Routing, edges and channels — documented and cross-checked ──────

describe("the document's routing, edge and channel tables track the artifact", () => {
  it("documents every router outcome label and its destination", () => {
    assertTableMatches(
      shippedDoc,
      DOC_ROUTERS_BEGIN,
      DOC_ROUTERS_END,
      expectedRouterRows(committed),
      "router table",
    );
  });

  it("documents all 56 edges with kind, label and port binding", () => {
    expect(committed.edges).toHaveLength(56);
    assertTableMatches(
      shippedDoc,
      DOC_EDGES_BEGIN,
      DOC_EDGES_END,
      expectedEdgeRows(committed),
      "edge table",
    );
  });

  it("documents every channel with its reducer, schema and writers", () => {
    expect(committed.channels).toHaveLength(11);
    assertTableMatches(
      shippedDoc,
      DOC_CHANNELS_BEGIN,
      DOC_CHANNELS_END,
      expectedChannelRows(committed),
      "channel table",
    );
  });

  // ── NEGATIVE CONTROLS ──

  it("FAILS when a fixture router re-points an outcome label", () => {
    const fixture = withNode(committed, "route_after_eval", {
      targets: [
        { label: "exhausted", to: "graceful_failure" },
        { label: "partial", to: "documenter" },
        { label: "pass", to: "documenter" },
        { label: "rework", to: "critique" },
      ],
    });
    expect(() => {
      assertTableMatches(
        shippedDoc,
        DOC_ROUTERS_BEGIN,
        DOC_ROUTERS_END,
        expectedRouterRows(fixture),
        "router table",
      );
    }).toThrow();
  });

  it("FAILS when a fixture edge is re-pointed", () => {
    const fixture: TopologySpec = {
      ...committed,
      edges: committed.edges.map((edge) =>
        edge.from === "hitl_commit" ? { ...edge, to: "finalize" } : edge,
      ),
    };
    expect(() => {
      assertTableMatches(
        shippedDoc,
        DOC_EDGES_BEGIN,
        DOC_EDGES_END,
        expectedEdgeRows(fixture),
        "edge table",
      );
    }).toThrow();
  });

  it("FAILS when a fixture edge loses its port binding", () => {
    const fixture: TopologySpec = {
      ...committed,
      edges: committed.edges.map((edge) =>
        edge.from === "evaluate_global" ? { ...edge, ports: undefined } : edge,
      ),
    };
    expect(() => {
      assertTableMatches(
        shippedDoc,
        DOC_EDGES_BEGIN,
        DOC_EDGES_END,
        expectedEdgeRows(fixture),
        "edge table",
      );
    }).toThrow();
  });

  it("FAILS when a fixture node starts writing a channel it did not write", () => {
    const fixture = withNode(committed, "sprint_review", {
      writes: ["evaluations", "ledger", "messages", "testAnchors"],
    });
    expect(() => {
      assertTableMatches(
        shippedDoc,
        DOC_CHANNELS_BEGIN,
        DOC_CHANNELS_END,
        expectedChannelRows(fixture),
        "channel table",
      );
    }).toThrow();
  });
});

// ── The document's non-tabular obligations ──────────────────────────

/** Version headings in the changelog section, newest first. */
function changelogVersions(doc: string): string[] {
  const at = doc.indexOf("## Changelog");
  if (at === -1) throw new Error("docs/pge-graph.md has no '## Changelog' section");
  return [...doc.slice(at).matchAll(/^### (\d+\.\d+\.\d+)\b/gm)].map((match) => match[1]);
}

function assertChangelogCoversVersion(spec: TopologySpec, doc: string): void {
  expect(
    changelogVersions(doc),
    `docs/pge-graph.md has no changelog entry for graphVersion ${spec.graphVersion}`,
  ).toContain(spec.graphVersion);
}

function assertGoldenLimitationStated(doc: string): void {
  const text = doc.toLowerCase();
  expect(text, "the document must say the golden dataset is not a quality measure").toContain(
    "not evidence of generation quality",
  );
  expect(text, "the document must say what a replay actually regression-tests").toContain(
    "runtime and the artifact shape",
  );
}

/**
 * sc-14-10 asks the disposition to state the EVIDENCE, not a conclusion — and evidence
 * has a location. A section that recorded "PGE stays opt-in" without naming what was
 * measured, or where the measurement is pinned, would satisfy a heading check and tell a
 * reader nothing they could verify.
 */
function assertDispositionCitesEvidence(doc: string): void {
  const cited = [
    // Where sprint 13's verdict is pinned.
    "conformance.engines.test.ts",
    // The three fields still diverging, plus `history` — CLOSED at sprint 4 of
    // spec-20260814-pge-full-convergence — cited for its closure record, not as an open one.
    "history",
    "audits",
    "contracts",
    "pipelineResult",
  ];
  const missing = cited.filter((needle) => !doc.includes(needle));
  expect(missing, `the disposition does not cite: ${missing.join(", ")}`).toEqual([]);

  expect(doc, "the disposition must state the conformance verdict").toMatch(
    /equivalent[^\n]*false/i,
  );
  expect(doc, "the most consequential divergence must be stated").toMatch(/does not commit/i);
  expect(doc, "…including that the run still reports success").toContain("success: true");
  expect(doc, "what would have to be true to flip the default must be stated").toContain(
    "pipeline.engine",
  );
}

/**
 * sc-6-4 (`spec-20260812-terminal-vocabulary` sprint 6) — the four things a flip would still
 * require BEYOND this spec, phrase-tolerant like {@link assertDispositionCitesEvidence}: this
 * guards that the four SUBJECTS sc-6-4 names are still addressed, not that any particular
 * sentence survives a later edit.
 */
function assertFlipPrerequisitesStated(doc: string): void {
  // (a) `audits` is recommended for PERMANENT ACCEPTANCE, not merely open work — the ADR-6
  // fan-out validation error is its architectural ground. `history` must NOT be paired with
  // it as a REMAINING prerequisite: it CLOSED at sprint 4 of
  // `spec-20260814-pge-full-convergence`, and the assertions below pin the closure alongside
  // audits' still-open disposition rather than treating the two as one item.
  expect(
    doc,
    "audits' permanent-acceptance disposition must be stated",
  ).toContain("permanent acceptance");
  expect(doc, "audits' ADR-6 fan-out ground must be named").toContain("InterruptInsideFanOut");
  expect(
    doc,
    "history's CLOSURE at sprint 4 must be stated, not its pre-closure open-work status",
  ).toContain("history` CLOSED at sprint 4");
  expect(
    doc,
    "the closure's writer module must be named",
  ).toContain("src/pge/runtime/history.ts");
  expect(
    doc,
    "the emitting curator node must still be named, as evidence for the closure",
  ).toContain("sprint_curate_explain");
  // sc-1-3/sc-1-4 (spec-20260814-pge-full-convergence sprint 1) — the ground is no longer
  // merely "unrevisited": the ADR WAS revisited and concluded the rule stands for a
  // runtime-grounded reason ADR-6 never gave. Both the citation and the reason must survive.
  expect(doc, "the sprint-1 ADR revisit must be cited by id").toContain(
    "arch-20260814-pge-full-convergence-adr-1",
  );
  expect(doc, "the runtime-grounded reason the revisit found must be named").toContain(
    "Checkpoint.interrupt",
  );

  // (b) Option B success semantics — the term of art, named as such, with its consequence.
  expect(doc, "Option B success semantics must be named").toContain("Option B");
  expect(
    doc,
    "the completionMarker consequence of taking Option B must be stated",
  ).toContain("completionMarker");

  // (c) a durable checkpoint mechanism for commit and finalize.
  expect(
    doc,
    "the durable-checkpoint gap for commit/finalize must be stated",
  ).toContain("durable checkpoint");
  expect(doc, "the autopilot mechanism that leaves the gap must be named").toContain("noop");

  // (d) an explicit re-specification of the bar itself.
  expect(doc, "re-specifying the bar must be named as a prerequisite").toMatch(/re-specif/i);
  expect(
    doc,
    "the bar must be stated as unsatisfiable by design given (a)-(c)",
  ).toMatch(/unsatisfiable/i);
}

/**
 * The dormant-subtree decision, module by module. Retention with a written criterion is a
 * correct outcome; naming the modules without saying what was decided is not.
 */
function assertSubtreeDispositionRecorded(doc: string): void {
  // The only two modules with no production caller and no in-subtree importer.
  expect(doc, "the genuinely dormant modules must be named").toContain("interpreter.ts");
  expect(doc).toContain("pure-sprint.ts");
  expect(doc, "a decision, not just an inventory").toMatch(/retain/i);

  // nonGoal 2's permanently-retained units, each named in the disposition.
  for (const unit of [
    "Scheduler",
    "Semaphore",
    "mapBounded",
    "Budget",
    "retry.ts",
    "reconciler.ts",
    "synthesizer.ts",
    "conformance.ts",
  ]) {
    expect(doc, `${unit} is permanently retained and must be recorded as such`).toContain(unit);
  }
}

/**
 * A version strictly ahead of the shipped graph's, DERIVED rather than written out — a
 * literal here rots the moment the shipped graph reaches it. It already happened once: this
 * fixture used the literal `"1.3.0"` until sprint 3 of spec-20260812-pge-real-workload-errors
 * bumped the shipped artifact to exactly that version, which would have silently turned this
 * negative control into a false positive (the changelog DOES cover `"1.3.0"` now) instead of
 * proving anything. Same idea as `bumpedVersion` in `src/cli/commands/pge.test.ts`.
 */
function versionTheChangelogDoesNotMention(from: string): string {
  const [major, minor] = from.split(".").map((part) => Number.parseInt(part, 10));
  return `${major}.${minor + 1}.0`;
}

describe("the document's changelog, disposition and stated limitations", () => {
  it("carries a changelog entry for the committed graphVersion", () => {
    expect(committed.graphVersion).toBe("1.5.0");
    assertChangelogCoversVersion(committed, shippedDoc);
    expect(changelogVersions(shippedDoc)).toEqual([
      "1.5.0",
      "1.4.0",
      "1.3.0",
      "1.2.0",
      "1.1.0",
      "1.0.0",
    ]);
  });

  it("FAILS when the artifact is bumped to a version the changelog does not mention", () => {
    const fixture: TopologySpec = {
      ...committed,
      graphVersion: versionTheChangelogDoesNotMention(committed.graphVersion),
    };
    expect(() => {
      assertChangelogCoversVersion(fixture, shippedDoc);
    }).toThrow();
  });

  it("states that the golden dataset regression-tests runtime and artifact shape only", () => {
    assertGoldenLimitationStated(shippedDoc);
  });

  it("FAILS when the golden-dataset limitation is edited out", () => {
    const gutted = shippedDoc.split("not evidence of generation quality").join("great");
    expect(() => {
      assertGoldenLimitationStated(gutted);
    }).toThrow();
  });

  it("records the engine migration disposition it is required to record", () => {
    // Deliberately phrase-tolerant: this guards that the four subjects sc-14-10 names are
    // still addressed, not that any particular sentence survives a later edit.
    expect(shippedDoc).toContain("## Engine migration disposition");
    expect(shippedDoc, "the retained oracle must be named").toContain("TsPipelineEngine");
    expect(shippedDoc, "the engine must be recorded as opt-in").toMatch(/opt-in/i);
    expect(shippedDoc, "the dormant subtree's decision must be recorded").toContain(
      "src/orchestrator/workflow/",
    );
    expect(shippedDoc, "the MCP sprint entry point's divergence must be recorded").toContain(
      "bober_sprint",
    );
  });

  it("cites the evidence it rests on, and where that evidence is pinned", () => {
    assertDispositionCitesEvidence(shippedDoc);
  });

  it("FAILS when the disposition stops naming where the evidence is pinned", () => {
    const gutted = shippedDoc.split("conformance.engines.test.ts").join("a test somewhere");
    expect(gutted).not.toBe(shippedDoc);
    expect(() => {
      assertDispositionCitesEvidence(gutted);
    }).toThrow();
  });

  it("FAILS when the disposition drops the conformance verdict", () => {
    const gutted = shippedDoc.split("equivalent: false").join("the expected result");
    expect(gutted).not.toBe(shippedDoc);
    expect(() => {
      assertDispositionCitesEvidence(gutted);
    }).toThrow();
  });

  it("records a decision for the dormant src/orchestrator/workflow/ subtree", () => {
    assertSubtreeDispositionRecorded(shippedDoc);
  });

  it("FAILS when a permanently-retained module stops being named", () => {
    const gutted = shippedDoc.split("synthesizer.ts").join("a helper");
    expect(gutted).not.toBe(shippedDoc);
    expect(() => {
      assertSubtreeDispositionRecorded(gutted);
    }).toThrow();
  });

  it("states what a flip would still require beyond this spec (sc-6-4)", () => {
    assertFlipPrerequisitesStated(shippedDoc);
  });

  it("FAILS when audits' permanent-acceptance disposition is edited out", () => {
    const gutted = shippedDoc.split("permanent acceptance").join("open work");
    expect(gutted).not.toBe(shippedDoc);
    expect(() => {
      assertFlipPrerequisitesStated(gutted);
    }).toThrow();
  });

  it("FAILS when history's CLOSED-at-sprint-4 disposition is edited out", () => {
    // Guards the sprint-4 closure itself: the doc must state `history` CLOSED, not merely
    // that it is no longer paired with `audits`. If a future edit quietly drops the closure
    // claim without the field actually re-diverging, this must catch it.
    const gutted = shippedDoc.split("history` CLOSED at sprint 4").join("history` was tracked");
    expect(gutted).not.toBe(shippedDoc);
    expect(() => {
      assertFlipPrerequisitesStated(gutted);
    }).toThrow();
  });

  it("FAILS when the closure stops naming its writer module", () => {
    const gutted = shippedDoc.split("src/pge/runtime/history.ts").join("a runtime module");
    expect(gutted).not.toBe(shippedDoc);
    expect(() => {
      assertFlipPrerequisitesStated(gutted);
    }).toThrow();
  });

  it("FAILS when the closure stops naming the emitting curator node", () => {
    const gutted = shippedDoc.split("sprint_curate_explain").join("a curator step");
    expect(gutted).not.toBe(shippedDoc);
    expect(() => {
      assertFlipPrerequisitesStated(gutted);
    }).toThrow();
  });

  it("FAILS when the sprint-1 ADR revisit citation is edited out (sc-1-3/sc-1-4)", () => {
    const gutted = shippedDoc
      .split("arch-20260814-pge-full-convergence-adr-1")
      .join("a prior decision");
    expect(gutted).not.toBe(shippedDoc);
    expect(() => {
      assertFlipPrerequisitesStated(gutted);
    }).toThrow();
  });

  it("FAILS when the runtime-grounded reason for audits' non-convergence is edited out", () => {
    const gutted = shippedDoc.split("Checkpoint.interrupt").join("the checkpoint state");
    expect(gutted).not.toBe(shippedDoc);
    expect(() => {
      assertFlipPrerequisitesStated(gutted);
    }).toThrow();
  });

  it("FAILS when Option B success semantics is no longer named", () => {
    const gutted = shippedDoc.split("Option B").join("the alternative");
    expect(gutted).not.toBe(shippedDoc);
    expect(() => {
      assertFlipPrerequisitesStated(gutted);
    }).toThrow();
  });

  it("FAILS when the durable-checkpoint gap for commit/finalize is edited out", () => {
    const gutted = shippedDoc.split("durable checkpoint").join("a mechanism");
    expect(gutted).not.toBe(shippedDoc);
    expect(() => {
      assertFlipPrerequisitesStated(gutted);
    }).toThrow();
  });

  it("FAILS when re-specifying the bar is no longer named as a prerequisite", () => {
    const gutted = shippedDoc.split("re-specif").join("xxxxxxxx");
    expect(gutted).not.toBe(shippedDoc);
    expect(() => {
      assertFlipPrerequisitesStated(gutted);
    }).toThrow();
  });
});

// ── The corrected `history` claim is a checked fact, not prose that can rot ────────────
//
// The 2026-08-14 targeted correction (`spec-20260814-pge-full-convergence`) replaced a false
// claim — "there is no curator node to emit a history write" — with a true one: two
// `role: "curator"` nodes exist, but no PGE node body calls `appendHistory`. The tests above
// only pin that the DOCUMENT states the corrected claim; the tests below re-derive the
// underlying FACT from the real `src/pge` source tree on every run, independent of what the
// document says, so a future PGE node gaining a real history writer — or this claim rotting
// the way the "no curator node" one silently did for two sprints — fails a test instead of
// becoming a second silent lie.

/** A minimal in-memory file, for the pure-function mutation controls below. */
interface ScannedFile {
  /** repo-relative, forward slashes */
  path: string;
  content: string;
}

/**
 * True for `foo.ts`, false for `foo.test.ts` and anything not ending `.ts` — exactly the
 * `--include="*.ts"` (non-test) semantics the doc's own cited `grep` command uses.
 */
function isProductionTsFile(name: string): boolean {
  return name.endsWith(".ts") && !name.endsWith(".test.ts");
}

/**
 * PURE — mirrors `findOffenders` in `src/contracts/status-vocabulary.invariant.test.ts`: the
 * mutation control below drives this directly with synthetic content, so "the scan bites" is
 * proven without ever writing a scratch file under `src/pge` (a crashed run would otherwise
 * leave one behind — see `lint-boundary.test.ts`'s identical rationale).
 */
function findAppendHistoryCallers(files: readonly ScannedFile[]): string[] {
  return files.filter((file) => file.content.includes("appendHistory")).map((file) => file.path);
}

/** Every production (non-test) `.ts` file under `dir`, repo-relative path, read from disk. */
async function collectPgeSourceFiles(dir: string, root: string): Promise<ScannedFile[]> {
  const out: ScannedFile[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      out.push(...(await collectPgeSourceFiles(full, root)));
      continue;
    }
    if (!isProductionTsFile(entry.name)) continue;
    out.push({
      path: full.slice(root.length).split("\\").join("/"),
      content: await readFile(full, "utf8"),
    });
  }
  return out;
}

describe("the `history` claim is checked against source, not trusted as prose", () => {
  it("finds EXACTLY ONE appendHistory caller in src/pge today — the sprint-4 writer — and the doc's claim agrees", async () => {
    const files = await collectPgeSourceFiles(join(REPO_ROOT, "src", "pge"), REPO_ROOT);
    // Sanity: the walk actually happened against the real tree (71+ non-test files as of
    // this closure), not an empty or missing directory silently reporting "no callers".
    expect(files.length).toBeGreaterThan(50);
    // Sprint 4 of spec-20260814-pge-full-convergence closed the missing-writer gap this
    // scanner used to prove was zero: `src/pge/runtime/history.ts` now calls `appendHistory`
    // directly (sc-4-4 — no parallel writer), and every node body that emits a phase event
    // reaches it THROUGH that one module, not by calling `appendHistory` itself. So the
    // caller set is exactly one file, not nine (one per emitting node) and not zero.
    expect(
      findAppendHistoryCallers(files),
      "src/pge's appendHistory caller set changed shape — either the sprint-4 writer moved, " +
        "or a node body now calls appendHistory directly instead of going through it " +
        "(sc-4-4). Update this pin, docs/pge-graph.md and conformance.engines.test.ts's " +
        "prose together with whichever changed.",
    ).toEqual(["src/pge/runtime/history.ts"]);
    // The other direction of the same invariant: the doc must still state the closure fact
    // this test just re-derived from source, so an edit that quietly reverts the doc's claim
    // (without the writer actually disappearing) fails here too, not just when it appears.
    expect(
      shippedDoc,
      "the doc must still state appendHistory now has exactly one caller under src/pge",
    ).toContain("returns exactly ONE hit: src/pge/runtime/history.ts");
  });

  it("the scanner actually bites: a synthetic node body calling appendHistory is caught", () => {
    const hit = findAppendHistoryCallers([
      {
        path: "src/pge/nodes/fake-node.ts",
        content: 'await appendHistory(root, { event: "curator-start" });',
      },
      { path: "src/pge/nodes/other-node.ts", content: "export const x = 1;" },
    ]);
    expect(hit).toEqual(["src/pge/nodes/fake-node.ts"]);
  });

  it("a node body calling emitPhaseEvent — the sprint-4 wrapper, not appendHistory directly — is NOT flagged", () => {
    // The real shape of every emitting node body today: none of them contain the literal
    // substring "appendHistory", because they all reach it through
    // `src/pge/runtime/history.ts`'s `emitPhaseEvent`. This is the negative half of the
    // pin above — a scanner that flagged every INDIRECT caller too would report nine files,
    // not one, and this sprint's own node bodies would fail the "exactly one" claim.
    const hit = findAppendHistoryCallers([
      {
        path: "src/pge/nodes/sprint-generate.ts",
        content:
          'import { HISTORY_EVENT, emitPhaseEvent } from "../runtime/history.js";\n' +
          'await emitPhaseEvent(ctx, { event: HISTORY_EVENT.GENERATOR_START, phase: "generating", details: {} });',
      },
    ]);
    expect(hit).toEqual([]);
  });

  it("isProductionTsFile matches the doc's cited grep semantics: *.ts, excluding *.test.ts", () => {
    expect(isProductionTsFile("sprint-curate.ts")).toBe(true);
    expect(isProductionTsFile("sprint-curate.test.ts")).toBe(false);
    expect(isProductionTsFile("sprint-curate.tsx")).toBe(false);
    expect(isProductionTsFile("README.md")).toBe(false);
  });
});
