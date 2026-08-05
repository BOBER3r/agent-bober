import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TopologySpec } from "../../contracts/topology.js";
import { CODING_GRAPH } from "./coding.graph.js";
import {
  DOC_NODES_BEGIN,
  DOC_NODES_END,
  checkDocDrift,
  docDrift,
  docDriftReport,
  documentedNodeIds,
} from "./docs.js";

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
