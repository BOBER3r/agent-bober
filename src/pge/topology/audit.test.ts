import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TopologySpecSchema } from "../../contracts/topology.js";
import type { TopologySpec } from "../../contracts/topology.js";
import {
  STATE_AUDIT_FILENAME,
  StateAuditSchema,
  generateStateAudit,
  serializeStateAudit,
  stateAuditPath,
  writeStateAudit,
} from "./audit.js";
import { checksumTopology } from "./canonical.js";
import { CODING_GRAPH } from "./coding.graph.js";
import { TOPOLOGY_DIR } from "./dump.js";

/**
 * sc-3-8 — the state audit is DERIVED from `nodes[].writes` / `nodes[].reads`, the
 * single encoding ADR-4 allows, and is byte-stable.
 *
 * The determinism assertion compares BYTES, not parsed objects: a parsed comparison
 * would pass even if the writer emitted its keys in a different order every run, which
 * is exactly what would make `git diff --exit-code` churn in CI.
 */

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bober-pge-audit-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function clone(spec: TopologySpec): TopologySpec {
  return TopologySpecSchema.parse(JSON.parse(JSON.stringify(spec)) as unknown);
}

// ── Derivation ──────────────────────────────────────────────────────

describe("generateStateAudit", () => {
  it("emits one row per declared channel, sorted by key", () => {
    const audit = generateStateAudit(CODING_GRAPH);
    expect(audit.keys).toHaveLength(CODING_GRAPH.channels.length);
    expect(audit.keys.map((k) => k.key)).toEqual([...audit.keys.map((k) => k.key)].sort());
    expect(audit.keys.map((k) => k.key)).toEqual(
      [...CODING_GRAPH.channels.map((c) => c.id)].sort(),
    );
  });

  it("gives every channel key at least one declared writer", () => {
    for (const row of generateStateAudit(CODING_GRAPH).keys) {
      expect(row.writers.length, `channel "${row.key}" has no writer`).toBeGreaterThan(0);
    }
  });

  it("names no writer or reader that is not a declared node", () => {
    const declared = new Set(CODING_GRAPH.nodes.map((n) => n.id));
    for (const row of generateStateAudit(CODING_GRAPH).keys) {
      for (const id of [...row.writers, ...row.readers]) {
        expect(declared.has(id), `"${id}" is not a declared node`).toBe(true);
      }
    }
  });

  it("derives writers and readers from the node declarations, not from channels[]", () => {
    const spec = clone(CODING_GRAPH);
    const node = spec.nodes.find((n) => n.id === "documenter");
    if (!node) throw new Error("fixture drift: no documenter node");
    node.writes = [...node.writes, "testAnchors"];

    const before = generateStateAudit(CODING_GRAPH).keys.find((k) => k.key === "testAnchors");
    const after = generateStateAudit(spec).keys.find((k) => k.key === "testAnchors");
    expect(before?.writers).not.toContain("documenter");
    expect(after?.writers).toContain("documenter");
    // The channel declaration itself was untouched.
    expect(spec.channels).toEqual(CODING_GRAPH.channels);
  });

  it("carries the reducer of each channel", () => {
    const audit = generateStateAudit(CODING_GRAPH);
    for (const channel of CODING_GRAPH.channels) {
      const row = audit.keys.find((k) => k.key === channel.id);
      expect(row?.reducer).toBe(channel.reducerRef);
    }
  });

  it("records generatedFrom so a stale audit is detectable", () => {
    const audit = generateStateAudit(CODING_GRAPH);
    expect(audit.generatedFrom.graphId).toBe("coding");
    expect(audit.generatedFrom.checksum).toBe(checksumTopology(CODING_GRAPH));
    expect(audit.generatedFrom.checksum).toBe(CODING_GRAPH.checksum);
  });

  it("reports the TRUE canonical checksum even when the artifact's field is stale", () => {
    const stale: TopologySpec = { ...clone(CODING_GRAPH), checksum: `sha256:${"0".repeat(64)}` };
    expect(generateStateAudit(stale).generatedFrom.checksum).toBe(checksumTopology(CODING_GRAPH));
  });

  it("moves the recorded checksum when the topology changes", () => {
    const changed = clone(CODING_GRAPH);
    const node = changed.nodes.find((n) => n.id === "documenter");
    if (!node) throw new Error("fixture drift: no documenter node");
    node.reads = [...node.reads, "testAnchors"];
    expect(generateStateAudit(changed).generatedFrom.checksum).not.toBe(
      generateStateAudit(CODING_GRAPH).generatedFrom.checksum,
    );
  });

  it("de-duplicates and sorts writers and readers", () => {
    const spec = clone(CODING_GRAPH);
    const node = spec.nodes.find((n) => n.id === "documenter");
    if (!node) throw new Error("fixture drift: no documenter node");
    node.writes = ["messages", "messages", "messages"];

    const row = generateStateAudit(spec).keys.find((k) => k.key === "messages");
    expect(row?.writers.filter((id) => id === "documenter")).toEqual(["documenter"]);
    expect(row?.writers).toEqual([...(row?.writers ?? [])].sort());
  });

  it("is invariant to node declaration order", () => {
    const reordered = clone(CODING_GRAPH);
    reordered.nodes.reverse();
    reordered.channels.reverse();
    expect(serializeStateAudit(generateStateAudit(reordered))).toBe(
      serializeStateAudit(generateStateAudit(CODING_GRAPH)),
    );
  });

  it("produces a value that parses against StateAuditSchema", () => {
    expect(StateAuditSchema.safeParse(generateStateAudit(CODING_GRAPH)).success).toBe(true);
  });

  it("omits channels that are written but never declared", () => {
    const spec = clone(CODING_GRAPH);
    const node = spec.nodes.find((n) => n.id === "documenter");
    if (!node) throw new Error("fixture drift: no documenter node");
    node.writes = [...node.writes, "not_a_declared_channel"];

    const audit = generateStateAudit(spec);
    expect(audit.keys.map((k) => k.key)).not.toContain("not_a_declared_channel");
    expect(audit.keys).toHaveLength(spec.channels.length);
  });
});

// ── sc-3-8: writing ─────────────────────────────────────────────────

describe("writeStateAudit", () => {
  it("writes .bober/topology/state-audit.json", async () => {
    const result = await writeStateAudit(root, CODING_GRAPH);
    expect(result.written).toBe(true);
    expect(result.drift).toBe("missing");
    expect(result.path).toBe(join(root, TOPOLOGY_DIR, STATE_AUDIT_FILENAME));
    expect(result.path).toBe(stateAuditPath(root));

    const text = await readFile(result.path, "utf8");
    expect(text).toBe(serializeStateAudit(result.audit));
    expect(StateAuditSchema.safeParse(JSON.parse(text)).success).toBe(true);
  });

  it("produces byte-identical output when run twice", async () => {
    await writeStateAudit(root, CODING_GRAPH);
    const first = await readFile(stateAuditPath(root), "utf8");
    const second = await writeStateAudit(root, CODING_GRAPH);
    const bytes = await readFile(stateAuditPath(root), "utf8");

    expect(bytes).toBe(first);
    expect(second.drift).toBe("none");
    expect(second.written).toBe(false);
  });

  it("check mode reports a missing audit and creates nothing", async () => {
    const result = await writeStateAudit(root, CODING_GRAPH, { check: true });
    expect(result.drift).toBe("missing");
    expect(result.written).toBe(false);
    await expect(readFile(stateAuditPath(root), "utf8")).rejects.toThrow(/ENOENT/);
  });

  /**
   * Regression: the committed-audit read was a bare `catch {}` mapping every failure to
   * "missing", so an audit that existed but could not be opened was reported absent and
   * then OVERWRITTEN. A directory in its place yields EISDIR without depending on the
   * test user's privileges.
   */
  it("distinguishes an unreadable audit from a missing one and overwrites nothing", async () => {
    await mkdir(stateAuditPath(root), { recursive: true });

    const result = await writeStateAudit(root, CODING_GRAPH);
    expect(result.drift).toBe("unreadable");
    expect(result.drift).not.toBe("missing");
    expect(result.written).toBe(false);
    expect(result.unreadable?.code).toBe("EISDIR");
    // Still a directory: nothing clobbered what it could not read.
    await expect(readFile(stateAuditPath(root), "utf8")).rejects.toThrow(/EISDIR/);
  });

  it("check mode reports content drift and does NOT repair it", async () => {
    await writeStateAudit(root, CODING_GRAPH);
    const tampered = '{\n  "generatedFrom": {},\n  "keys": []\n}\n';
    await writeFile(stateAuditPath(root), tampered, "utf8");

    const result = await writeStateAudit(root, CODING_GRAPH, { check: true });
    expect(result.drift).toBe("content");
    expect(result.written).toBe(false);
    expect(await readFile(stateAuditPath(root), "utf8")).toBe(tampered);
  });

  it("rewrites a drifted audit when not in check mode", async () => {
    await writeStateAudit(root, CODING_GRAPH);
    await writeFile(stateAuditPath(root), "{}\n", "utf8");
    const result = await writeStateAudit(root, CODING_GRAPH, { check: false });
    expect(result.written).toBe(true);
    expect(result.drift).toBe("content");
    expect(await readFile(stateAuditPath(root), "utf8")).toBe(serializeStateAudit(result.audit));
  });

  /**
   * REGRESSION. `writeStateAudit` used to serialize and write whatever
   * `generateStateAudit` returned, without ever applying `StateAuditSchema`. The two
   * schemas genuinely disagree — `ChannelDeclSchema.reducerRef` is `z.string()` while
   * `StateAuditKeySchema.reducer` is `z.string().min(1)` — so an artifact with an empty
   * `reducerRef` parses as a topology and audits to a row the module's own exported
   * schema rejects. The file was committed anyway, and the next `StateAuditSchema.parse`
   * threw on it.
   */
  it("refuses to write an audit its own schema rejects, and leaves no file behind", async () => {
    const spec = clone(CODING_GRAPH);
    const channel = spec.channels[0];
    if (!channel) throw new Error("fixture drift: no channels");
    channel.reducerRef = "";
    // The artifact is still a valid topology — that is what makes this reachable.
    expect(TopologySpecSchema.safeParse(spec).success).toBe(true);
    expect(StateAuditSchema.safeParse(generateStateAudit(spec)).success).toBe(false);

    const result = await writeStateAudit(root, spec);
    expect(result.drift).toBe("invalid");
    expect(result.written).toBe(false);
    expect(result.serialized).toBe("");
    expect(result.invalid?.key).toBe(channel.id);
    expect(result.invalid?.path).toMatch(/^keys\.\d+\.reducer$/);
    await expect(readFile(stateAuditPath(root), "utf8")).rejects.toThrow(/ENOENT/);
  });

  it("does not clobber an existing valid audit when the new derivation is invalid", async () => {
    await writeStateAudit(root, CODING_GRAPH);
    const good = await readFile(stateAuditPath(root), "utf8");

    const spec = clone(CODING_GRAPH);
    const channel = spec.channels[0];
    if (!channel) throw new Error("fixture drift: no channels");
    channel.reducerRef = "";
    const result = await writeStateAudit(root, spec);

    expect(result.written).toBe(false);
    expect(await readFile(stateAuditPath(root), "utf8")).toBe(good);
  });

  it("writes only bytes that parse back through StateAuditSchema", async () => {
    const result = await writeStateAudit(root, CODING_GRAPH);
    const parsed = StateAuditSchema.safeParse(
      JSON.parse(await readFile(result.path, "utf8")) as unknown,
    );
    expect(parsed.success).toBe(true);
  });

  it("lands beside the topology artifact and not in the code-graph namespace", () => {
    expect(stateAuditPath("/p")).toBe(join("/p", ".bober", "topology", "state-audit.json"));
    expect(stateAuditPath("/p")).not.toContain(join(".bober", "graph"));
  });
});

describe("serializeStateAudit", () => {
  it("is pretty-printed with exactly one trailing newline", () => {
    const text = serializeStateAudit(generateStateAudit(CODING_GRAPH));
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.endsWith("}\n\n")).toBe(false);
    expect(text).toContain('\n  "keys": [');
  });
});
