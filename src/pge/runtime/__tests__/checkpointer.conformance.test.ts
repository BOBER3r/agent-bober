import {
  open,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initialOverallState } from "../../state/overall.js";
import { goldenSpec } from "../__fixtures__/golden-graph.js";
import {
  CHECKPOINT_FORMAT_VERSION,
  CheckpointNotFoundError,
  CorruptCheckpointError,
  checkpointDir,
  checkpointPath,
  createFsCheckpointer,
  encodeCheckpoint,
  listCheckpointFiles,
} from "../checkpointer.js";
import type { Checkpoint, CheckpointRef, GraphCheckpointer } from "../checkpointer.js";
import { createPendingTask } from "../frontier.js";

/**
 * ADVERSARIAL CHECKPOINTER CONFORMANCE — the suite ADR-1 names as the only defence.
 *
 * ADR-1's stated risk is that "a bug in checkpoint write ordering or in
 * `completedTaskKeys` reconstruction re-executes a completed node or skips an incomplete
 * one — both silent". Its prescribed mitigation is a conformance suite over
 * `put`/`get`/`latest`/`list`/`prune` modelled on the published
 * `@langchain/langgraph-checkpoint-validation` contract, WITH kill-mid-write fault
 * injection. That package is deliberately not a dependency; its semantics are restated
 * here and asserted against this implementation.
 *
 * ── The contract, in four sentences ──
 *
 *  1. `put` is atomic. There is no observable intermediate state between "the previous
 *     checkpoint" and "the new one".
 *  2. `get` either returns a checkpoint that satisfies the schema in full, or throws. It
 *     never returns a partial one, and it never returns one that belongs to another run.
 *  3. `list` never yields a ref whose `get` fails.
 *  4. `latest` returns the highest-numbered READABLE checkpoint, so a damaged newest
 *     checkpoint degrades to the last good one instead of stranding the run.
 *
 * ── Fault injection is against real files ──
 *
 * Nothing here mocks `node:fs`. A mocked filesystem would turn every assertion below into
 * a statement about the mock, and the failure this suite exists to catch — a write that
 * lands before its bytes do — is not expressible in a mock at all. Every injected fault
 * truncates, empties or corrupts a REAL file in a REAL temp directory.
 *
 * ── Mutation-proven ──
 *
 * Each group below was run against a deliberate breakage of the corresponding code path
 * and failed; the mutations are named in the group's docblock. Every mutation named there
 * was applied to the real source, measured, and reverted — a claim that has not been
 * observed to fail is worse than none, because it suppresses the review that would find
 * the gap. (The first group's claim was previously such a claim: `put`'s atomicity was
 * asserted in a title and enforced by nothing, and a `put` with no temp file and no rename
 * at all left the entire suite green.)
 */

const RUN = "run-conformance";

let root = "";
let store: GraphCheckpointer;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bober-pge-conf-"));
  store = createFsCheckpointer(root);
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
    createdAt: `2026-08-05T00:00:0${String(superstep % 10)}.000Z`,
    state: initialOverallState({ runId: RUN, projectRoot: root, featureRequest: "conformance" }),
    pending: [createPendingTask({ nodeId: "supervisor", input: { superstep } })],
    completedTaskKeys: Array.from({ length: superstep }, (_, i) => `task-${String(i)}`),
    interrupt: null,
    decisions: {},
    activeBranches: [],
    joinBuffer: [],
    failures: [],
    deadlocked: false,
    ...overrides,
  };
}

async function seed(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) await store.put(checkpointAt(i));
}

async function collect(runId: string): Promise<CheckpointRef[]> {
  const refs: CheckpointRef[] = [];
  for await (const ref of store.list(runId)) refs.push(ref);
  return refs;
}

/**
 * Reproduce, byte for byte, what a process killed BETWEEN the write and the rename leaves
 * behind: a dot-prefixed temp file in the checkpoint directory holding a prefix of the
 * intended bytes, and no final file.
 *
 * This is what the production `put` does up to the point of the kill — open a temp name in
 * the target directory, write, and (never) rename — so the leftovers are the real thing
 * rather than a stand-in for it.
 */
async function leaveKilledWrite(superstep: number, fraction: number): Promise<string> {
  const dir = checkpointDir(root, RUN);
  const bytes = encodeCheckpoint(checkpointAt(superstep));
  const partial = bytes.slice(0, Math.floor(bytes.length * fraction));
  const temp = join(dir, `.${String(superstep)}.killed.tmp`);
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.write(partial);
  } finally {
    await handle.close();
  }
  return temp;
}

/**
 * ── Mutation-proven ──
 *
 * Four mutations, each applied to the real `put`, measured across all of `src/pge/runtime`
 * (341 tests), and reverted:
 *
 *   - `open(final, "w")` + `write`, no temp file and no rename → 2 red, both in this
 *     group: `overwrites a checkpoint by REPLACING the file` and `never mutates the bytes
 *     of the checkpoint it is replacing`. An in-place write keeps the inode, so it
 *     rewrites the previous checkpoint's bytes where they lie.
 *   - `writeFile(final, bytes, "utf8")` → the same 2 red here, plus the file-mode
 *     assertion in `checkpointer.test.ts`.
 *   - a temp name without `randomUUID()` → 1 red, `keeps one payload intact when the SAME
 *     superstep is written concurrently`: the second writer's `open(temp, "wx")` hits
 *     EEXIST and its `put` rejects.
 *   - abandoning the staged file instead of unlinking it in the `catch` → 1 red,
 *     `publishes nothing and stages nothing when it cannot complete`.
 *
 * NOT pinned, and stated rather than implied: staging in the SAME DIRECTORY as the final
 * name. Moving the temp file to `os.tmpdir()` leaves all 341 tests green, because the
 * repository's temp root and the OS temp directory are the same device on the machines
 * this runs on, so the cross-device `rename(2)` that the requirement exists to prevent
 * never fires. Nothing short of a second filesystem would make it falsifiable, and this
 * suite mounts nothing.
 *
 * ── Why the inode, and not a kill ──
 *
 * `put`'s atomicity cannot be observed by damaging a file after the fact: the tests below
 * this group inject faults into files that `put` never wrote, so they constrain the READER
 * and say nothing about the writer. What distinguishes temp-file-plus-rename from an
 * in-place write is that the previous checkpoint's bytes are NEVER touched — the new
 * content lands on a different inode and `rename(2)` swaps the name over in one step, so
 * there is no window in which `<n>.json` is truncated and its replacement is not yet
 * written. A hard link to the old file witnesses exactly that, deterministically and
 * without racing anything.
 *
 * The fsync between write and rename is a separate durability step that no test here
 * pins: observing it requires either a real power loss or a `node:fs` mock, and this suite
 * mocks nothing.
 */
describe("CONFORMANCE: put is atomic (sc-8-2)", () => {
  it("returns the ref it wrote and makes the checkpoint immediately readable", async () => {
    const ref = await store.put(checkpointAt(0));
    expect(ref).toEqual({ runId: RUN, superstep: 0 });
    expect((await store.get(ref)).superstep).toBe(0);
  });

  it("leaves no temp file behind after a successful write", async () => {
    await seed(4);
    const entries = await readdir(checkpointDir(root, RUN));
    expect(entries.filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(entries.sort()).toEqual(["0.json", "1.json", "2.json", "3.json"]);
  });

  it("overwrites a checkpoint by REPLACING the file, never by writing over it", async () => {
    // `put` overwrites `<n>.json` on every superstep of a real run. An in-place write
    // truncates the last good checkpoint before the new bytes exist; a rename-replace has
    // no such window, and the inode is what tells the two apart.
    await store.put(checkpointAt(0));
    const path = checkpointPath(root, RUN, 0);
    const before = await stat(path);

    await store.put(checkpointAt(0, { createdAt: "2026-08-05T23:59:59.000Z" }));
    const after = await stat(path);

    expect(after.ino).not.toBe(before.ino);
    expect((await store.get({ runId: RUN, superstep: 0 })).createdAt).toBe(
      "2026-08-05T23:59:59.000Z",
    );
  });

  it("never mutates the bytes of the checkpoint it is replacing", async () => {
    await store.put(checkpointAt(0));
    const path = checkpointPath(root, RUN, 0);
    const original = await readFile(path, "utf8");

    // A hard link holds the ORIGINAL inode open. If `put` replaces the name, the witness
    // still reads the old checkpoint; if `put` writes through the name, the witness sees
    // the new bytes — which is the same event as "the previous checkpoint was destroyed
    // before its replacement existed".
    const witness = join(checkpointDir(root, RUN), "witness.hardlink");
    await link(path, witness);

    await store.put(checkpointAt(0, { createdAt: "2026-08-06T00:00:00.000Z" }));

    expect(await readFile(witness, "utf8")).toBe(original);
    expect(await readFile(path, "utf8")).not.toBe(original);
    await rm(witness);
  });

  it("publishes nothing and stages nothing when it cannot complete", async () => {
    // A `put` that fails at the rename must leave the directory exactly as it found it —
    // the staged bytes are not a checkpoint and an abandoned one would accumulate for
    // every crashed run. Provoked with a real obstruction rather than a mock: a DIRECTORY
    // sitting on the final name, which `rename(2)` refuses to replace.
    const dir = checkpointDir(root, RUN);
    await store.put(checkpointAt(0));
    await mkdir(join(dir, "7.json"), { recursive: true });

    await expect(store.put(checkpointAt(7))).rejects.toThrow();

    expect((await readdir(dir)).sort()).toEqual(["0.json", "7.json"]);
    // And the checkpoint that WAS good is still readable, byte for byte.
    expect((await store.get({ runId: RUN, superstep: 0 })).superstep).toBe(0);
  });

  it("writes concurrent supersteps without either write observing the other", async () => {
    await Promise.all([0, 1, 2, 3, 4, 5].map((i) => store.put(checkpointAt(i))));
    expect(await listCheckpointFiles(root, RUN)).toEqual([0, 1, 2, 3, 4, 5]);
    for (const ref of await collect(RUN)) {
      expect((await store.get(ref)).superstep).toBe(ref.superstep);
    }
  });

  it("keeps one payload intact when the SAME superstep is written concurrently", async () => {
    // The property temp-plus-rename actually buys, stated as a race: six writers, one
    // file name, and a reader afterwards sees ONE of the six in full — never a blend and
    // never a prefix. The previous test writes six different names and cannot show this.
    const stamps = [0, 1, 2, 3, 4, 5].map((i) => `2026-08-05T00:00:0${String(i)}.000Z`);
    await Promise.all(stamps.map((createdAt) => store.put(checkpointAt(0, { createdAt }))));
    expect(stamps).toContain((await store.get({ runId: RUN, superstep: 0 })).createdAt);
    expect((await readdir(checkpointDir(root, RUN))).sort()).toEqual(["0.json"]);
  });
});

/**
 * ── Mutation-proven ──
 *
 * RED against `listCheckpointFiles` matching `/\.json$|\.tmp$/` instead of `^\d+\.json$`:
 * the killed write then appears in `list` and `latest`, and `get` on it throws.
 */
describe("CONFORMANCE: kill-mid-write leaves nothing readable (sc-8-2)", () => {
  it("makes a write killed before its rename INVISIBLE, not merely invalid", async () => {
    await seed(3);
    await leaveKilledWrite(3, 0.4);

    // Nothing knows superstep 3 exists.
    expect(await listCheckpointFiles(root, RUN)).toEqual([0, 1, 2]);
    expect((await collect(RUN)).map((r) => r.superstep)).toEqual([0, 1, 2]);
    await expect(store.get({ runId: RUN, superstep: 3 })).rejects.toThrow(
      CheckpointNotFoundError,
    );
  });

  it("falls back to the last good checkpoint after a killed write", async () => {
    await seed(3);
    await leaveKilledWrite(3, 0.9);
    const latest = await store.latest(RUN);
    expect(latest?.superstep).toBe(2);
    expect(latest?.completedTaskKeys).toEqual(["task-0", "task-1"]);
  });

  it("survives a killed write at every fraction of the intended bytes", async () => {
    await seed(1);
    for (const fraction of [0, 0.01, 0.25, 0.5, 0.75, 0.99]) {
      const temp = await leaveKilledWrite(5, fraction);
      expect(await listCheckpointFiles(root, RUN)).toEqual([0]);
      expect((await store.latest(RUN))?.superstep).toBe(0);
      await rm(temp);
    }
  });
});

/**
 * ── Mutation-proven ──
 *
 * RED against `decodeCheckpoint` returning `JSON.parse(raw)` without the
 * `CheckpointSchema.safeParse` step: every truncation case below then either returns a
 * half object or throws a raw `SyntaxError` instead of `CorruptCheckpointError`.
 */
describe("CONFORMANCE: a damaged checkpoint is never readable (sc-8-2)", () => {
  it("rejects a checkpoint truncated at ANY offset", async () => {
    await store.put(checkpointAt(1));
    const path = checkpointPath(root, RUN, 1);
    const full = (await readFile(path, "utf8")).length;

    // Every seventh offset, plus every offset in the last 40 bytes — where a truncation
    // is likeliest to still look like a document.
    const offsets = new Set<number>();
    for (let i = 0; i < full; i += 7) offsets.add(i);
    for (let i = Math.max(0, full - 40); i < full; i += 1) offsets.add(i);
    expect(offsets.size).toBeGreaterThan(50);

    for (const offset of [...offsets].sort((a, b) => a - b)) {
      await truncate(path, offset);
      await expect(
        store.get({ runId: RUN, superstep: 1 }),
        `truncated to ${String(offset)} of ${String(full)} bytes`,
      ).rejects.toThrow(CorruptCheckpointError);
    }
  });

  it("rejects an empty file, garbage, trailing junk and a JSON scalar", async () => {
    const path = checkpointPath(root, RUN, 0);
    const good = encodeCheckpoint(checkpointAt(0));
    for (const bytes of ["", "   ", "not json at all", `${good}trailing`, "42", '"a string"', "null"]) {
      await store.put(checkpointAt(0));
      await writeFile(path, bytes, "utf8");
      await expect(store.get({ runId: RUN, superstep: 0 })).rejects.toThrow(
        CorruptCheckpointError,
      );
    }
  });

  it("rejects structurally valid JSON that is not a checkpoint", async () => {
    await store.put(checkpointAt(0));
    const path = checkpointPath(root, RUN, 0);
    const decoded = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

    const mutations: Array<[string, Record<string, unknown>]> = [
      ["missing state", { ...decoded, state: undefined }],
      ["missing completedTaskKeys", { ...decoded, completedTaskKeys: undefined }],
      ["wrong formatVersion", { ...decoded, formatVersion: 2 }],
      ["negative superstep", { ...decoded, superstep: -1 }],
      ["state violating OverallStateSchema", { ...decoded, state: { runId: "x" } }],
      ["pending entry without a taskKey", { ...decoded, pending: [{ nodeId: "a" }] }],
      ["decision that is not an outcome", { ...decoded, decisions: { "post-plan": { hmm: 1 } } }],
    ];

    for (const [label, mutated] of mutations) {
      await writeFile(path, JSON.stringify(mutated), "utf8");
      await expect(store.get({ runId: RUN, superstep: 0 }), label).rejects.toThrow(
        CorruptCheckpointError,
      );
    }
  });

  it("names WHAT was wrong, so a corrupt checkpoint is diagnosable from the message", async () => {
    await store.put(checkpointAt(0));
    await writeFile(checkpointPath(root, RUN, 0), "{", "utf8");
    await expect(store.get({ runId: RUN, superstep: 0 })).rejects.toThrow(/invalid JSON/);

    await store.put(checkpointAt(0));
    const decoded = JSON.parse(await readFile(checkpointPath(root, RUN, 0), "utf8")) as object;
    await writeFile(
      checkpointPath(root, RUN, 0),
      JSON.stringify({ ...decoded, deadlocked: "yes" }),
      "utf8",
    );
    await expect(store.get({ runId: RUN, superstep: 0 })).rejects.toThrow(
      /schema violation at deadlocked/,
    );
  });
});

/**
 * ── Mutation-proven ──
 *
 * RED against `list` yielding every `<n>.json` without decoding it first, and separately
 * against `latest` returning the highest-numbered file rather than the highest READABLE
 * one: the first breaks "list never yields a ref whose get fails", the second strands the
 * run on a damaged newest checkpoint.
 */
describe("CONFORMANCE: list never yields a ref whose get fails (sc-8-2)", () => {
  it("skips damaged checkpoints and yields only readable ones", async () => {
    await seed(5);
    await writeFile(checkpointPath(root, RUN, 2), "{ truncated", "utf8");
    await truncate(checkpointPath(root, RUN, 4), 12);

    const refs = await collect(RUN);
    expect(refs.map((r) => r.superstep)).toEqual([0, 1, 3]);

    // The contract, asserted rather than assumed: every yielded ref really does `get`.
    for (const ref of refs) {
      const checkpoint = await store.get(ref);
      expect(checkpoint.superstep).toBe(ref.superstep);
    }
  });

  it("returns the highest READABLE checkpoint from latest, not the highest file", async () => {
    await seed(5);
    await truncate(checkpointPath(root, RUN, 4), 30);
    expect((await store.latest(RUN))?.superstep).toBe(3);

    await truncate(checkpointPath(root, RUN, 3), 30);
    expect((await store.latest(RUN))?.superstep).toBe(2);
  });

  it("returns undefined when every checkpoint is damaged", async () => {
    await seed(2);
    for (const superstep of [0, 1]) {
      await writeFile(checkpointPath(root, RUN, superstep), "corrupt", "utf8");
    }
    expect(await store.latest(RUN)).toBeUndefined();
    expect(await collect(RUN)).toEqual([]);
  });

  it("does not leak one run's checkpoints into another's listing", async () => {
    await seed(3);
    const other = createFsCheckpointer(root);
    await other.put({ ...checkpointAt(0), runId: "run-other" });

    expect((await collect(RUN)).map((r) => r.superstep)).toEqual([0, 1, 2]);
    expect((await collect("run-other")).map((r) => r.superstep)).toEqual([0]);
    expect((await store.get({ runId: "run-other", superstep: 0 })).runId).toBe("run-other");
  });
});

/**
 * ── Mutation-proven ──
 *
 * RED against `prune` sorting file names as strings: `["10","11","2","9"]` then retains
 * "9" and "2" and deletes the two newest checkpoints — a data-losing bug that a test
 * seeded with fewer than ten supersteps would never see.
 */
describe("CONFORMANCE: prune retains the newest and nothing else (sc-8-2, sc-8-11)", () => {
  it("removes exactly the checkpoints outside the retention window", async () => {
    await seed(6);
    await store.prune(RUN, 2);
    expect(await listCheckpointFiles(root, RUN)).toEqual([4, 5]);
    await expect(store.get({ runId: RUN, superstep: 3 })).rejects.toThrow(
      CheckpointNotFoundError,
    );
    expect((await store.latest(RUN))?.superstep).toBe(5);
  });

  it("is a no-op on a run that has no checkpoints", async () => {
    await expect(store.prune("never-ran", 3)).resolves.toBeUndefined();
  });

  it("prunes damaged files too, so a corrupt checkpoint cannot pin the directory open", async () => {
    await seed(4);
    await writeFile(checkpointPath(root, RUN, 1), "corrupt", "utf8");
    await store.prune(RUN, 2);
    expect(await listCheckpointFiles(root, RUN)).toEqual([2, 3]);
  });
});
