import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TopologySpecSchema } from "../../contracts/topology.js";
import type { TopologySpec } from "../../contracts/topology.js";
import { initialOverallState } from "../state/overall.js";
import { UnsafePathSegmentError } from "./scratch.js";
import { goldenSpec } from "./__fixtures__/golden-graph.js";
import {
  CHECKPOINT_FORMAT_VERSION,
  CheckpointNotFoundError,
  CheckpointSchema,
  ChecksumMismatchError,
  CorruptCheckpointError,
  NestedCheckpointerError,
  assertCheckpointMatchesGraph,
  checkpointDir,
  checkpointPath,
  checkpointsRoot,
  createFsCheckpointer,
  decodeCheckpoint,
  encodeCheckpoint,
  listCheckpointFiles,
  resolveCheckpointerFor,
  resolveSubgraphCheckpointers,
  toCheckpointOutcome,
} from "./checkpointer.js";
import type { Checkpoint, CheckpointRef, GraphCheckpointer } from "./checkpointer.js";
import { createPendingTask } from "./frontier.js";

/**
 * Unit coverage for the filesystem checkpointer.
 *
 * The ADVERSARIAL half — kill-mid-write, truncation at every offset, `list` never yielding
 * a ref whose `get` fails — lives in `__tests__/checkpointer.conformance.test.ts`. This
 * file covers the shape of the thing: paths, encoding, graph identity, the nested-handle
 * rule and retention.
 *
 * Every test uses a real temp directory. A filesystem mock would make the atomicity claim
 * a claim about the mock, and atomicity is the entire reason this component exists.
 */

const RUN = "run-cp";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bober-pge-cp-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function checkpointAt(superstep: number, overrides: Partial<Checkpoint> = {}): Checkpoint {
  const spec = goldenSpec();
  return {
    formatVersion: CHECKPOINT_FORMAT_VERSION,
    runId: RUN,
    superstep,
    nextSuperstep: superstep + 1,
    graphId: spec.graphId,
    graphVersion: spec.graphVersion,
    checksum: spec.checksum,
    createdAt: "2026-08-05T00:00:00.000Z",
    state: initialOverallState({ runId: RUN, projectRoot: "/tmp/project", featureRequest: "f" }),
    pending: [createPendingTask({ nodeId: "supervisor", input: { superstep } })],
    completedTaskKeys: ["key-a", "key-b"],
    interrupt: null,
    decisions: {},
    activeBranches: [],
    joinBuffer: [],
    failures: [],
    deadlocked: false,
    ...overrides,
  };
}

async function seed(store: GraphCheckpointer, count: number): Promise<CheckpointRef[]> {
  const refs: CheckpointRef[] = [];
  for (let i = 0; i < count; i += 1) refs.push(await store.put(checkpointAt(i)));
  return refs;
}

describe("checkpoint paths", () => {
  it("puts every checkpoint under .bober/checkpoints/<runId>/<superstep>.json", () => {
    expect(checkpointsRoot("/p")).toBe(join("/p", ".bober", "checkpoints"));
    expect(checkpointDir("/p", RUN)).toBe(join("/p", ".bober", "checkpoints", RUN));
    expect(checkpointPath("/p", RUN, 7)).toBe(
      join("/p", ".bober", "checkpoints", RUN, "7.json"),
    );
  });

  it("refuses a runId that would escape the checkpoint directory", () => {
    expect(() => checkpointDir("/p", "../../etc")).toThrow(UnsafePathSegmentError);
  });

  it("keeps two project roots apart, because there is no module-level instance (worktrees)", async () => {
    const other = await mkdtemp(join(tmpdir(), "bober-pge-cp-other-"));
    try {
      const a = createFsCheckpointer(root);
      const b = createFsCheckpointer(other);
      await a.put(checkpointAt(0));

      expect(await listCheckpointFiles(root, RUN)).toEqual([0]);
      expect(await listCheckpointFiles(other, RUN)).toEqual([]);
      expect(await b.latest(RUN)).toBeUndefined();
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});

describe("put / get", () => {
  it("round-trips every field of a checkpoint", async () => {
    const store = createFsCheckpointer(root);
    const original = checkpointAt(3, {
      interrupt: {
        checkpointId: "post-sprint",
        nodeId: "gate_commit",
        branchKeys: ["b1", "b2"],
        payload: { contractId: "sprint-1" },
        raisedAt: "2026-08-05T01:00:00.000Z",
        superstep: 3,
      },
      decisions: { "post-plan": { approved: false, feedback: "not yet" } },
      activeBranches: ["b1"],
      joinBuffer: [{ nodeId: "supervisor", entries: [{ branchKey: "b0", value: { ok: 1 } }] }],
      failures: [
        { nodeId: "x", branchKey: null, superstep: 1, errorClass: "Boom", message: "boom" },
      ],
      deadlocked: true,
    });

    const ref = await store.put(original);
    expect(ref).toEqual({ runId: RUN, superstep: 3 });
    expect(await store.get(ref)).toEqual(original);
  });

  it("writes the file mode 0600 and leaves no temp file behind", async () => {
    const store = createFsCheckpointer(root);
    await store.put(checkpointAt(0));

    const entries = await readdir(checkpointDir(root, RUN));
    expect(entries).toEqual(["0.json"]);
    const info = await stat(checkpointPath(root, RUN, 0));
    expect(info.mode & 0o777).toBe(0o600);
  });

  it("encodes indented, key-sorted JSON so `cat` and `git diff` stay useful", async () => {
    const store = createFsCheckpointer(root);
    await store.put(checkpointAt(0));
    const raw = await readFile(checkpointPath(root, RUN, 0), "utf8");

    expect(raw.endsWith("}\n")).toBe(true);
    expect(raw.split("\n").length).toBeGreaterThan(20);
    const topLevelKeys = Object.keys(JSON.parse(raw) as Record<string, unknown>);
    expect(topLevelKeys).toEqual([...topLevelKeys].sort());
    expect(topLevelKeys[0]).toBe("activeBranches");
  });

  it("produces byte-identical output for two identical checkpoints", () => {
    expect(encodeCheckpoint(checkpointAt(4))).toBe(encodeCheckpoint(checkpointAt(4)));
    expect(encodeCheckpoint(checkpointAt(4))).not.toBe(encodeCheckpoint(checkpointAt(5)));
  });

  it("overwrites the same superstep in place, so a re-run of a superstep is not a new file", async () => {
    const store = createFsCheckpointer(root);
    await store.put(checkpointAt(0));
    await store.put(checkpointAt(0, { completedTaskKeys: ["later"] }));

    expect(await readdir(checkpointDir(root, RUN))).toEqual(["0.json"]);
    expect((await store.get({ runId: RUN, superstep: 0 })).completedTaskKeys).toEqual(["later"]);
  });

  it("throws CheckpointNotFoundError, not a raw ENOENT, for a superstep that was never written", async () => {
    const store = createFsCheckpointer(root);
    await store.put(checkpointAt(0));
    await expect(store.get({ runId: RUN, superstep: 9 })).rejects.toThrow(
      CheckpointNotFoundError,
    );
    await expect(store.get({ runId: "no-such-run", superstep: 0 })).rejects.toThrow(
      CheckpointNotFoundError,
    );
  });

  it("refuses a checkpoint whose declared identity disagrees with its own file name", () => {
    const raw = encodeCheckpoint(checkpointAt(2));
    expect(() => decodeCheckpoint(raw, { runId: RUN, superstep: 5 })).toThrow(
      CorruptCheckpointError,
    );
    expect(() => decodeCheckpoint(raw, { runId: "other", superstep: 2 })).toThrow(
      /identity mismatch/,
    );
  });

  it("validates on the way in, so a state the schema forbids fails at the superstep that produced it", async () => {
    const store = createFsCheckpointer(root);
    const broken = { ...checkpointAt(0), state: { runId: "" } } as unknown as Checkpoint;
    await expect(store.put(broken)).rejects.toThrow();
    expect(await listCheckpointFiles(root, RUN)).toEqual([]);
  });
});

describe("latest / list / prune", () => {
  it("lists refs in ascending superstep order and returns the highest as latest", async () => {
    const store = createFsCheckpointer(root);
    // Written out of order on purpose: enumeration must not depend on write order.
    for (const superstep of [3, 0, 11, 2]) await store.put(checkpointAt(superstep));

    const listed: number[] = [];
    for await (const ref of store.list(RUN)) listed.push(ref.superstep);
    expect(listed).toEqual([0, 2, 3, 11]);
    expect((await store.latest(RUN))?.superstep).toBe(11);
  });

  it("returns undefined from latest and yields nothing from list for an unknown run", async () => {
    const store = createFsCheckpointer(root);
    expect(await store.latest("never-ran")).toBeUndefined();
    const seen: CheckpointRef[] = [];
    for await (const ref of store.list("never-ran")) seen.push(ref);
    expect(seen).toEqual([]);
  });

  it("retains EXACTLY the requested number of most recent checkpoints (sc-8-11)", async () => {
    const store = createFsCheckpointer(root);
    await seed(store, 7);

    await store.prune(RUN, 3);
    expect(await listCheckpointFiles(root, RUN)).toEqual([4, 5, 6]);

    await store.prune(RUN, 3);
    expect(await listCheckpointFiles(root, RUN)).toEqual([4, 5, 6]);

    await store.prune(RUN, 1);
    expect(await listCheckpointFiles(root, RUN)).toEqual([6]);

    await store.prune(RUN, 0);
    expect(await listCheckpointFiles(root, RUN)).toEqual([]);
  });

  it("keeps everything when asked to retain more than exist", async () => {
    const store = createFsCheckpointer(root);
    await seed(store, 3);
    await store.prune(RUN, 99);
    expect(await listCheckpointFiles(root, RUN)).toEqual([0, 1, 2]);
  });

  it("prunes by superstep NUMBER, not by file-name string order", async () => {
    const store = createFsCheckpointer(root);
    for (const superstep of [2, 9, 10, 11]) await store.put(checkpointAt(superstep));
    await store.prune(RUN, 2);
    // Lexicographic order would have kept "9" and "2"; numeric order keeps 10 and 11.
    expect(await listCheckpointFiles(root, RUN)).toEqual([10, 11]);
  });
});

describe("graph identity (sc-8-3)", () => {
  it("accepts a checkpoint written against the same artifact", () => {
    const spec = goldenSpec();
    expect(() => assertCheckpointMatchesGraph(checkpointAt(0), spec)).not.toThrow();
  });

  it("throws ChecksumMismatch when the checksum moved", () => {
    const spec = goldenSpec();
    const drifted: TopologySpec = { ...spec, checksum: `sha256:${"a".repeat(64)}` };
    try {
      assertCheckpointMatchesGraph(checkpointAt(0), drifted);
      expect.unreachable("expected ChecksumMismatchError");
    } catch (error) {
      expect(error).toBeInstanceOf(ChecksumMismatchError);
      const mismatch = error as ChecksumMismatchError;
      expect(mismatch.code).toBe("ChecksumMismatch");
      expect(mismatch.expected.checksum).toBe(spec.checksum);
      expect(mismatch.actual.checksum).toBe(drifted.checksum);
      expect(mismatch.message).toContain("replay completed task keys");
    }
  });

  it("throws ChecksumMismatch when only the graph VERSION moved", () => {
    const spec = goldenSpec();
    expect(() =>
      assertCheckpointMatchesGraph(checkpointAt(0), { ...spec, graphVersion: "2.0.0" }),
    ).toThrow(ChecksumMismatchError);
  });

  it("throws ChecksumMismatch when the checkpoint belongs to a different graph", () => {
    const spec = goldenSpec();
    expect(() =>
      assertCheckpointMatchesGraph(checkpointAt(0), { ...spec, graphId: "other" }),
    ).toThrow(ChecksumMismatchError);
  });
});

describe("nested checkpointer (sc-8-9)", () => {
  it("resolves the PARENT's handle by identity for an inheriting subgraph", () => {
    const parent = createFsCheckpointer(root);
    const resolved = resolveCheckpointerFor(parent, { id: "sprint", persistence: "inherit" });
    expect(resolved).toBe(parent);

    const spec = goldenSpec();
    expect(spec.subgraphs).toHaveLength(1);
    const all = resolveSubgraphCheckpointers(spec, parent);
    expect(all.get("sprint")).toBe(parent);
  });

  it("rejects a hand-edited subgraph that declares its own persistence handle", () => {
    const parent = createFsCheckpointer(root);
    try {
      resolveCheckpointerFor(parent, { id: "sprint", persistence: "own" });
      expect.unreachable("expected NestedCheckpointerError");
    } catch (error) {
      expect(error).toBeInstanceOf(NestedCheckpointerError);
      const nested = error as NestedCheckpointerError;
      // Wired to the validator's OWN diagnostic code rather than a second spelling of it.
      expect(nested.code).toBe("NestedCheckpointer");
      expect(nested.subgraphId).toBe("sprint");
      expect(nested.persistence).toBe("own");
    }
  });

  it("refuses the whole artifact when any subgraph declares its own handle", () => {
    const spec = goldenSpec();
    const handEdited = {
      ...spec,
      subgraphs: [{ ...spec.subgraphs[0], persistence: "own" }],
    } as unknown as TopologySpec;
    expect(() => resolveSubgraphCheckpointers(handEdited, createFsCheckpointer(root))).toThrow(
      NestedCheckpointerError,
    );
  });

  it("cannot even PARSE a nested handle back into a TopologySpec", () => {
    const spec = goldenSpec();
    const handEdited = {
      ...spec,
      subgraphs: [{ ...spec.subgraphs[0], persistence: "own" }],
    };
    expect(TopologySpecSchema.safeParse(handEdited).success).toBe(false);
  });
});

describe("outcome narrowing", () => {
  it("drops an absent editDelta rather than materialising undefined", () => {
    expect(toCheckpointOutcome({ approved: true })).toEqual({ approved: true });
    expect(toCheckpointOutcome({ approved: true, editDelta: { a: 1 } })).toEqual({
      approved: true,
      editDelta: { a: 1 },
    });
    expect(toCheckpointOutcome({ approved: false, feedback: "no" })).toEqual({
      approved: false,
      feedback: "no",
    });
    expect(toCheckpointOutcome({ edit: true, editDelta: "after" })).toEqual({
      edit: true,
      editDelta: "after",
    });
  });

  it("refuses a decision value that is not a CheckpointOutcome", () => {
    const bad = { ...checkpointAt(0), decisions: { "post-plan": { maybe: true } } };
    expect(CheckpointSchema.safeParse(bad).success).toBe(false);
  });
});

describe(".gitignore (sc-8-11)", () => {
  it("ignores .bober/checkpoints/ in the same change that creates it", async () => {
    const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const ignored = await readFile(join(repoRoot, ".gitignore"), "utf8");
    const lines = ignored.split("\n").map((line) => line.trim());

    expect(lines).toContain(".bober/checkpoints/");
    // The sibling run-state directories from sprint 6 must not have been dropped.
    for (const dir of [".bober/scratch/", ".bober/traces/", ".bober/archive/"]) {
      expect(lines).toContain(dir);
    }
  });

  it("does not ignore the version-controlled topology directory", async () => {
    const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const ignored = await readFile(join(repoRoot, ".gitignore"), "utf8");
    expect(ignored.split("\n").map((l) => l.trim())).not.toContain(".bober/topology/");
  });
});

describe("temp files", () => {
  it("never enumerates a dot-prefixed temp file as a checkpoint", async () => {
    const store = createFsCheckpointer(root);
    await store.put(checkpointAt(0));
    await writeFile(join(checkpointDir(root, RUN), ".1.abc.tmp"), "{partial", "utf8");

    expect(await listCheckpointFiles(root, RUN)).toEqual([0]);
    const listed: number[] = [];
    for await (const ref of store.list(RUN)) listed.push(ref.superstep);
    expect(listed).toEqual([0]);
    expect((await store.latest(RUN))?.superstep).toBe(0);
  });
});
