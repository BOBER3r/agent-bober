import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TopologySpecSchema } from "../../contracts/topology.js";
import type { TopologySpec } from "../../contracts/topology.js";
import { canonicalize, checksumTopology } from "./canonical.js";
import { CODING_GRAPH } from "./coding.graph.js";
import {
  PROMPT_DIR,
  TOPOLOGY_DIR,
  dumpTopology,
  looksLikeTopology,
  readPromptStore,
  readTopologyArtifact,
  serializeTopology,
  topologyArtifactPath,
} from "./dump.js";

/**
 * Serialization and on-disk placement of the topology artifact.
 *
 * Tests create real temp directories and clean them up; nothing here mocks the
 * filesystem.
 */

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bober-pge-dump-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function clone(spec: TopologySpec): TopologySpec {
  return TopologySpecSchema.parse(JSON.parse(JSON.stringify(spec)) as unknown);
}

// ── Paths ───────────────────────────────────────────────────────────

describe("topologyArtifactPath", () => {
  it("places the artifact under .bober/topology/<graphId>.json", () => {
    expect(TOPOLOGY_DIR).toBe(join(".bober", "topology"));
    expect(topologyArtifactPath("/p", "coding")).toBe(join("/p", ".bober", "topology", "coding.json"));
  });

  it("does not collide with the code-graph namespace", () => {
    expect(TOPOLOGY_DIR).not.toContain(join(".bober", "graph"));
    expect(topologyArtifactPath("/p", "coding")).not.toContain(join(".bober", "graph"));
  });
});

// ── Serialization ───────────────────────────────────────────────────

describe("serializeTopology", () => {
  it("is deterministic across calls", () => {
    expect(serializeTopology(CODING_GRAPH)).toBe(serializeTopology(CODING_GRAPH));
  });

  it("is invariant to declaration order", () => {
    const shuffled = clone(CODING_GRAPH);
    shuffled.nodes.reverse();
    shuffled.edges.reverse();
    shuffled.channels.reverse();
    shuffled.subgraphs.reverse();
    expect(serializeTopology(shuffled)).toBe(serializeTopology(CODING_GRAPH));
  });

  it("sorts the top-level keys and keeps the checksum", () => {
    const text = serializeTopology(CODING_GRAPH);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([...Object.keys(parsed)].sort());
    expect(parsed.checksum).toBe(CODING_GRAPH.checksum);
    expect(Object.keys(parsed)).toContain("checksum");
  });

  it("ends with exactly one trailing newline and is pretty-printed", () => {
    const text = serializeTopology(CODING_GRAPH);
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.endsWith("}\n\n")).toBe(false);
    expect(text.split("\n").length).toBeGreaterThan(100);
  });

  it("round-trips: literal -> bytes -> parse -> identical checksum", () => {
    const reparsed = TopologySpecSchema.parse(
      JSON.parse(serializeTopology(CODING_GRAPH)) as unknown,
    );
    expect(checksumTopology(reparsed)).toBe(CODING_GRAPH.checksum);
    expect(reparsed.checksum).toBe(CODING_GRAPH.checksum);
    expect(canonicalize(reparsed)).toBe(canonicalize(CODING_GRAPH));
  });

  it("changes by more than the checksum field when structure changes", () => {
    const mutated = clone(CODING_GRAPH);
    mutated.edges.push({
      id: "e-extra",
      from: "context_compact",
      to: "graceful_failure",
      kind: "normal",
    });
    mutated.checksum = checksumTopology(mutated);
    const before = serializeTopology(CODING_GRAPH);
    const after = serializeTopology(mutated);
    expect(after).not.toBe(before);
    expect(after).toContain("e-extra");
    expect(before).not.toContain("e-extra");
  });
});

// ── dumpTopology ────────────────────────────────────────────────────

describe("dumpTopology", () => {
  it("writes the artifact and reports the checksum", async () => {
    const result = await dumpTopology(root, CODING_GRAPH);
    expect(result.written).toBe(true);
    expect(result.drift).toBe("missing");
    expect(result.checksum).toBe(CODING_GRAPH.checksum);
    expect(result.path).toBe(topologyArtifactPath(root, "coding"));
    expect(await readFile(result.path, "utf8")).toBe(serializeTopology(CODING_GRAPH));
  });

  it("is idempotent: a second dump writes nothing and reports no drift", async () => {
    await dumpTopology(root, CODING_GRAPH);
    const second = await dumpTopology(root, CODING_GRAPH);
    expect(second.drift).toBe("none");
    expect(second.written).toBe(false);
  });

  it("check mode reports a missing artifact and creates nothing", async () => {
    const result = await dumpTopology(root, CODING_GRAPH, { check: true });
    expect(result.drift).toBe("missing");
    expect(result.written).toBe(false);
    const read = await readTopologyArtifact(result.path);
    expect(read.ok).toBe(false);
  });

  it("check mode reports content drift after a single-character mutation and does NOT repair it", async () => {
    const { path } = await dumpTopology(root, CODING_GRAPH);
    const original = await readFile(path, "utf8");
    const mutated = original.replace(
      `"graphVersion": "${CODING_GRAPH.graphVersion}"`,
      '"graphVersion": "9.9.9"',
    );
    expect(mutated).not.toBe(original);
    await writeFile(path, mutated, "utf8");

    const result = await dumpTopology(root, CODING_GRAPH, { check: true });
    expect(result.drift).toBe("content");
    expect(result.written).toBe(false);
    // The mutated bytes are still on disk — check mode must not silently rewrite.
    expect(await readFile(path, "utf8")).toBe(mutated);
  });

  it("detects a one-byte whitespace difference", async () => {
    const { path } = await dumpTopology(root, CODING_GRAPH);
    const original = await readFile(path, "utf8");
    await writeFile(path, `${original} `, "utf8");
    const result = await dumpTopology(root, CODING_GRAPH, { check: true });
    expect(result.drift).toBe("content");
  });

  it("rewrites a drifted artifact when not in check mode", async () => {
    const { path } = await dumpTopology(root, CODING_GRAPH);
    await writeFile(path, "{}\n", "utf8");
    const result = await dumpTopology(root, CODING_GRAPH, { check: false });
    expect(result.written).toBe(true);
    expect(result.drift).toBe("content");
    expect(await readFile(path, "utf8")).toBe(serializeTopology(CODING_GRAPH));
  });

  it("creates the .bober/topology directory when it does not exist", async () => {
    const nested = join(root, "deep", "project");
    await mkdir(nested, { recursive: true });
    const result = await dumpTopology(nested, CODING_GRAPH);
    expect(result.written).toBe(true);
    expect(result.path).toBe(join(nested, ".bober", "topology", "coding.json"));
  });

  /**
   * Regression: the reported checksum used to be recomputed with `checksumTopology`
   * while the BYTES carried `spec.checksum`, so a spec whose stored checksum had gone
   * stale produced a dump whose reported checksum appeared nowhere in the file it
   * wrote. There is now one value, and a stale spec is refused instead.
   */
  it("reports exactly the checksum carried by the bytes it produced", async () => {
    const result = await dumpTopology(root, CODING_GRAPH);
    const embedded = (JSON.parse(result.serialized) as { checksum: string }).checksum;
    expect(embedded).toBe(result.checksum);
    const onDisk = (JSON.parse(await readFile(result.path, "utf8")) as { checksum: string })
      .checksum;
    expect(onDisk).toBe(result.checksum);
  });

  it("refuses to write a spec whose stored checksum is not its canonical checksum", async () => {
    const stale = clone(CODING_GRAPH);
    stale.edges.push({
      id: "e-extra",
      from: "context_compact",
      to: "graceful_failure",
      kind: "normal",
    });
    // Deliberately NOT resealed.
    const result = await dumpTopology(root, stale);
    expect(result.drift).toBe("stale");
    expect(result.written).toBe(false);
    expect(result.stale).toEqual({
      stored: CODING_GRAPH.checksum,
      canonical: checksumTopology(stale),
    });
    expect(result.checksum).toBe(checksumTopology(stale));
    await expect(readFile(result.path, "utf8")).rejects.toThrow();
  });

  /**
   * Regression: the committed-artifact read used to be a bare `catch {}` that mapped
   * EVERY failure to `drift: "missing"`, so a file that existed but could not be opened
   * was reported as one that did not exist — and, outside check mode, was then
   * overwritten. A directory in the artifact's place produces EISDIR deterministically
   * and without depending on the test user's privileges.
   */
  it("distinguishes an unreadable artifact from a missing one and writes nothing", async () => {
    const path = topologyArtifactPath(root, "coding");
    await mkdir(path, { recursive: true });

    const checked = await dumpTopology(root, CODING_GRAPH, { check: true });
    expect(checked.drift).toBe("unreadable");
    expect(checked.drift).not.toBe("missing");
    expect(checked.unreadable?.code).toBe("EISDIR");

    const written = await dumpTopology(root, CODING_GRAPH);
    expect(written.drift).toBe("unreadable");
    expect(written.written).toBe(false);
    // Still a directory: nothing clobbered what it could not read.
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });
});

// ── readTopologyArtifact ────────────────────────────────────────────

describe("readTopologyArtifact", () => {
  it("returns a typed missing result rather than throwing", async () => {
    const result = await readTopologyArtifact(join(root, "nope.json"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("missing");
    expect(result.message.length).toBeGreaterThan(0);
  });

  it("distinguishes unreadable from missing", async () => {
    const path = join(root, "as-a-directory.json");
    await mkdir(path, { recursive: true });
    const result = await readTopologyArtifact(path);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unreadable");
    expect(result.message).toContain("EISDIR");
  });

  it("returns a typed unparseable result for invalid JSON", async () => {
    const path = join(root, "bad.json");
    await writeFile(path, "{ not json", "utf8");
    const result = await readTopologyArtifact(path);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unparseable");
  });

  it("returns the raw value and the exact bytes for a good file", async () => {
    const { path } = await dumpTopology(root, CODING_GRAPH);
    const result = await readTopologyArtifact(path);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe(serializeTopology(CODING_GRAPH));
    expect(TopologySpecSchema.safeParse(result.raw).success).toBe(true);
  });
});

// ── Prompt store ────────────────────────────────────────────────────

describe("readPromptStore", () => {
  it("reports an ABSENT store distinctly from an empty one", async () => {
    const absent = await readPromptStore(root);
    expect(absent.available).toBe(false);
    expect(absent.dir).toBe(join(root, PROMPT_DIR));

    // The same call once the directory exists and holds nothing: available, no refs.
    await mkdir(join(root, PROMPT_DIR), { recursive: true });
    const empty = await readPromptStore(root);
    expect(empty.available).toBe(true);
    if (!empty.available) return;
    expect(empty.refs).toEqual(new Set());
  });

  it("reports a store path occupied by a FILE as unavailable", async () => {
    await mkdir(join(root, ".bober"), { recursive: true });
    await writeFile(join(root, PROMPT_DIR), "not a directory", "utf8");
    expect((await readPromptStore(root)).available).toBe(false);
  });

  it("reports a store it could only PARTLY enumerate as unavailable", async () => {
    // A nested directory that cannot be read leaves the ref set incomplete; claiming
    // availability would report perfectly resolvable refs as UnknownPromptRef.
    await mkdir(join(root, PROMPT_DIR, "planner"), { recursive: true });
    await writeFile(join(root, PROMPT_DIR, "planner", "draft.md"), "draft", "utf8");
    expect((await readPromptStore(root)).available).toBe(true);

    await rm(join(root, PROMPT_DIR, "planner"), { recursive: true, force: true });
    // A FILE where the walk expects to recurse is not reachable through readdir, so the
    // unenumerable case is forced directly through a mode with no read permission.
    await mkdir(join(root, PROMPT_DIR, "locked"), { recursive: true });
    await chmod(join(root, PROMPT_DIR, "locked"), 0o000);
    try {
      const store = await readPromptStore(root);
      // Root (uid 0) ignores the mode bits, so only assert where the mode can bite.
      if (process.getuid?.() !== 0) expect(store.available).toBe(false);
    } finally {
      await chmod(join(root, PROMPT_DIR, "locked"), 0o755);
    }
  });

  it("derives refs from nested paths with posix separators and drops the extension", async () => {
    await mkdir(join(root, PROMPT_DIR, "planner"), { recursive: true });
    await mkdir(join(root, PROMPT_DIR, "generator"), { recursive: true });
    await writeFile(join(root, PROMPT_DIR, "planner", "draft.md"), "draft body", "utf8");
    await writeFile(join(root, PROMPT_DIR, "generator", "sprint.md"), "sprint body", "utf8");
    await writeFile(join(root, PROMPT_DIR, "top.md"), "top body", "utf8");
    await writeFile(join(root, PROMPT_DIR, "planner", "notes.txt"), "ignored", "utf8");

    const store = await readPromptStore(root);
    expect(store.available).toBe(true);
    if (!store.available) return;
    expect(store.refs).toEqual(new Set(["planner/draft", "generator/sprint", "top"]));
    expect(store.refs.has("planner/notes")).toBe(false);
  });

  it("is unaffected by prompt BODY content", async () => {
    await mkdir(join(root, PROMPT_DIR, "planner"), { recursive: true });
    const file = join(root, PROMPT_DIR, "planner", "draft.md");
    await writeFile(file, "first body", "utf8");
    const before = await readPromptStore(root);
    expect(before.available && before.refs).toEqual(new Set(["planner/draft"]));
    await writeFile(file, "a completely different body", "utf8");
    const after = await readPromptStore(root);
    expect(after.available && after.refs).toEqual(before.available && before.refs);
  });

  it("reads under .bober/prompts and not under .bober/topology", () => {
    expect(PROMPT_DIR).toBe(join(".bober", "prompts"));
    expect(PROMPT_DIR).not.toBe(TOPOLOGY_DIR);
  });
});

// ── looksLikeTopology ───────────────────────────────────────────────

describe("looksLikeTopology", () => {
  it.each([
    { label: "null", value: null, expected: false },
    { label: "array", value: [], expected: false },
    { label: "string", value: "x", expected: false },
    { label: "object without nodes", value: {}, expected: false },
    { label: "object with non-array nodes", value: { nodes: 1 }, expected: false },
    { label: "object with nodes array", value: { nodes: [] }, expected: true },
  ])("returns $expected for $label", ({ value, expected }) => {
    expect(looksLikeTopology(value)).toBe(expected);
  });

  it("accepts the real artifact", () => {
    expect(looksLikeTopology(JSON.parse(serializeTopology(CODING_GRAPH)))).toBe(true);
  });

  /**
   * Regression: the guard used to be a hand-rolled `isPlainObject(raw) &&
   * Array.isArray(raw.nodes)` living beside — and free to drift from —
   * `TopologySpecSchema`. It is now derived from a Zod schema, and nothing it accepts
   * may escape the real schema: acceptance here is never a substitute for parsing.
   */
  it("never accepts a document the real schema would reject without the schema also running", () => {
    const accepted = { nodes: [{ id: "x" }] };
    expect(looksLikeTopology(accepted)).toBe(true);
    expect(TopologySpecSchema.safeParse(accepted).success).toBe(false);
  });

  it("agrees with TopologySpecSchema on every rejection reason it claims", () => {
    for (const value of [null, [], "x", 42, {}, { nodes: 1 }, { nodes: {} }]) {
      expect(looksLikeTopology(value), JSON.stringify(value)).toBe(false);
      expect(TopologySpecSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
  });
});
