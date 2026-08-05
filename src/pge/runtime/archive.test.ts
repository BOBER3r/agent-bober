import { chmod, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UnsafePathSegmentError } from "./scratch.js";
import {
  ARCHIVE_BRANCH_SEPARATOR,
  ARCHIVE_OUTPUTS_FILE,
  ARCHIVE_SEALED_MARKER,
  ARCHIVE_SNAPSHOT_FILE,
  ARCHIVE_STDOUT_FILE,
  ArchiveImmutableError,
  DEFAULT_ARCHIVE_SEAL_MODE,
  SEALED_FILE_MODE,
  archiveNodeDir,
  createArchiveWriter,
  restoreWritableTree,
  treeBytes,
} from "./archive.js";

/**
 * sc-6-3, sc-6-4 — the sealed archive.
 *
 * Two separate guarantees, tested separately:
 *
 *  1. IMMUTABILITY is an API guarantee. Every write path rejects after `seal()`,
 *     including through a handle that was obtained BEFORE sealing and through a second
 *     handle opened afterwards. This holds under the default `"marker"` mode, where no
 *     file permission has changed at all.
 *  2. CLEANUP still works. Under the default mode a sealed directory is removable with
 *     an ordinary `rm -rf` — which is what `git clean` and the worktree cleanup in
 *     `src/orchestrator/worktree.ts` do, and what a `chmod 0o444` default would have
 *     turned into a permissions puzzle over a run's only copy of its work.
 */

let root = "";
const RUN = "run-20260805-b";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bober-pge-archive-"));
});

afterEach(async () => {
  await restoreWritableTree(root);
  await rm(root, { recursive: true, force: true });
});

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

describe("ArchiveWriter.open (sc-6-3)", () => {
  it("creates .bober/archive/<runId>/<nodeId>/ with all three files", async () => {
    const writer = createArchiveWriter(root);
    const handle = await writer.open(RUN, "sprint_generate", null);

    expect(handle.dir).toBe(join(root, ".bober", "archive", RUN, "sprint_generate"));
    expect((await readdir(handle.dir)).sort()).toEqual([
      ARCHIVE_OUTPUTS_FILE,
      ARCHIVE_SNAPSHOT_FILE,
      ARCHIVE_STDOUT_FILE,
    ]);
    expect(handle.sealed()).toBe(false);
    expect(handle.sealMode).toBe(DEFAULT_ARCHIVE_SEAL_MODE);
  });

  it("suffixes the directory with the branch key for a fan-out branch", async () => {
    const writer = createArchiveWriter(root);
    const handle = await writer.open(RUN, "sprint_generate", "sprint-3");
    expect(handle.dir).toBe(
      join(root, ".bober", "archive", RUN, `sprint_generate${ARCHIVE_BRANCH_SEPARATOR}sprint-3`),
    );

    const sibling = await writer.open(RUN, "sprint_generate", "sprint-4");
    expect(sibling.dir).not.toBe(handle.dir);
    expect((await readdir(join(root, ".bober", "archive", RUN))).sort()).toEqual([
      `sprint_generate${ARCHIVE_BRANCH_SEPARATOR}sprint-3`,
      `sprint_generate${ARCHIVE_BRANCH_SEPARATOR}sprint-4`,
    ]);
  });

  it("never aliases two distinct node executions onto one directory", async () => {
    // A node id may legally contain "." (`z.string().min(1)`, and the shared segment
    // pattern permits it), so a "." separator would make these two the SAME directory:
    // node "a.b" with no branch, and node "a" on branch "b".
    expect(archiveNodeDir(root, RUN, "a.b", null)).not.toBe(archiveNodeDir(root, RUN, "a", "b"));
    expect(archiveNodeDir(root, RUN, "sprint.1", null)).not.toBe(
      archiveNodeDir(root, RUN, "sprint", "1"),
    );

    // The separator itself can never appear in either part, so the leaf splits back into
    // exactly one (nodeId, branchKey) pair.
    expect(() => archiveNodeDir(root, RUN, `a${ARCHIVE_BRANCH_SEPARATOR}b`, null)).toThrow(
      UnsafePathSegmentError,
    );
    expect(() => archiveNodeDir(root, RUN, "a", `b${ARCHIVE_BRANCH_SEPARATOR}c`)).toThrow(
      UnsafePathSegmentError,
    );
  });

  it("keeps a dotted node id and a branched node id as two independent archives", async () => {
    const writer = createArchiveWriter(root);

    const dotted = await writer.open(RUN, "sprint.1", null);
    await dotted.writeOutputs({ who: "node sprint.1, no branch" });
    await dotted.seal();

    // A DIFFERENT node execution. Before the separator fix it inherited the directory
    // above: born sealed, every write refused, and the first execution's outputs left in
    // place as if they were its own.
    const branched = await writer.open(RUN, "sprint", "1");
    expect(branched.dir).not.toBe(dotted.dir);
    expect(branched.sealed()).toBe(false);
    await branched.writeOutputs({ who: "node sprint, branch 1" });

    expect(JSON.parse(await readFile(join(dotted.dir, ARCHIVE_OUTPUTS_FILE), "utf8"))).toEqual({
      who: "node sprint.1, no branch",
    });
    expect(JSON.parse(await readFile(join(branched.dir, ARCHIVE_OUTPUTS_FILE), "utf8"))).toEqual({
      who: "node sprint, branch 1",
    });
    expect((await readdir(join(root, ".bober", "archive", RUN))).sort()).toEqual([
      "sprint.1",
      `sprint${ARCHIVE_BRANCH_SEPARATOR}1`,
    ]);
  });

  it("records snapshot, stdout and outputs where a reader expects them", async () => {
    const writer = createArchiveWriter(root);
    const handle = await writer.open(RUN, "sprint_evaluate", null);

    await handle.writeSnapshot({ contractId: "sprint-6", attempt: 2 });
    await handle.appendStdout("first line\n");
    await handle.appendStdout("second line\n");
    await handle.writeOutputs({ verdict: "pass" });

    expect(JSON.parse(await readFile(join(handle.dir, ARCHIVE_SNAPSHOT_FILE), "utf8"))).toEqual({
      contractId: "sprint-6",
      attempt: 2,
    });
    expect(await readFile(join(handle.dir, ARCHIVE_STDOUT_FILE), "utf8")).toBe(
      "first line\nsecond line\n",
    );
    expect(JSON.parse(await readFile(join(handle.dir, ARCHIVE_OUTPUTS_FILE), "utf8"))).toEqual({
      verdict: "pass",
    });
  });

  it("refuses a nodeId or branchKey that would escape the run directory", async () => {
    const writer = createArchiveWriter(root);
    await expect(writer.open(RUN, "../../escape", null)).rejects.toBeInstanceOf(
      UnsafePathSegmentError,
    );
    await expect(writer.open(RUN, "node", "../..")).rejects.toBeInstanceOf(
      UnsafePathSegmentError,
    );
    expect(() => archiveNodeDir(root, "..", "node", null)).toThrow(UnsafePathSegmentError);
  });
});

describe("ArchiveHandle.seal (sc-6-3)", () => {
  it("rejects every write path with ArchiveImmutableError naming the directory", async () => {
    const writer = createArchiveWriter(root);
    const handle = await writer.open(RUN, "commit", null);
    await handle.writeSnapshot({ before: true });
    await handle.seal();

    for (const [operation, attempt] of [
      ["writeSnapshot", () => handle.writeSnapshot({ after: true })],
      ["appendStdout", () => handle.appendStdout("late\n")],
      ["writeOutputs", () => handle.writeOutputs({ after: true })],
    ] as const) {
      await expect(attempt(), operation).rejects.toBeInstanceOf(ArchiveImmutableError);
      await expect(attempt(), operation).rejects.toThrow(handle.dir);
      await expect(attempt(), operation).rejects.toThrow(operation);
    }

    // Refused, not merely reported: the pre-seal content is intact.
    expect(JSON.parse(await readFile(join(handle.dir, ARCHIVE_SNAPSHOT_FILE), "utf8"))).toEqual({
      before: true,
    });
    expect(await readFile(join(handle.dir, ARCHIVE_STDOUT_FILE), "utf8")).toBe("");
  });

  it("carries the directory on the error object, not only in the message", async () => {
    const writer = createArchiveWriter(root);
    const handle = await writer.open(RUN, "commit", "b1");
    await handle.seal();

    const error = await handle.appendStdout("x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ArchiveImmutableError);
    expect((error as ArchiveImmutableError).dir).toBe(handle.dir);
    expect((error as ArchiveImmutableError).operation).toBe("appendStdout");
    expect((error as ArchiveImmutableError).name).toBe("ArchiveImmutableError");
  });

  it("rejects through a handle held from BEFORE the seal, and through one opened after", async () => {
    const writer = createArchiveWriter(root);
    const early = await writer.open(RUN, "curate", null);
    const sealer = await writer.open(RUN, "curate", null);

    await sealer.seal();

    // The handle that existed before the seal is bound to the same directory and must
    // notice: re-opening is not a way around the guarantee, and neither is holding on.
    const late = await writer.open(RUN, "curate", null);
    expect(late.sealed()).toBe(true);
    await expect(late.writeOutputs({})).rejects.toBeInstanceOf(ArchiveImmutableError);
    await expect(early.writeOutputs({})).rejects.toBeInstanceOf(ArchiveImmutableError);
  });

  it("is idempotent", async () => {
    const writer = createArchiveWriter(root);
    const handle = await writer.open(RUN, "plan", null);
    await handle.seal();
    await expect(handle.seal()).resolves.toBeUndefined();
    expect(handle.sealed()).toBe(true);
  });
});

describe("seal modes (sc-6-4)", () => {
  it("defaults to marker mode: a .sealed sidecar and NO permission change", async () => {
    const writer = createArchiveWriter(root, {
      now: () => new Date("2026-08-05T12:00:00.000Z"),
    });
    const handle = await writer.open(RUN, "review", null);
    await handle.appendStdout("output\n");
    await handle.seal();

    const marker = JSON.parse(
      await readFile(join(handle.dir, ARCHIVE_SEALED_MARKER), "utf8"),
    ) as Record<string, unknown>;
    expect(marker).toEqual({
      sealedAt: "2026-08-05T12:00:00.000Z",
      sealMode: "marker",
      dir: handle.dir,
    });

    for (const name of [ARCHIVE_SNAPSHOT_FILE, ARCHIVE_STDOUT_FILE, ARCHIVE_OUTPUTS_FILE]) {
      expect(await modeOf(join(handle.dir, name)), name).not.toBe(SEALED_FILE_MODE);
    }

    // The point of the default: `rm -rf` — which is what worktree cleanup and
    // `git clean` do — still works with no chmod dance at all.
    await rm(handle.dir, { recursive: true });
    expect(await readdir(join(root, ".bober", "archive", RUN))).toEqual([]);
  });

  it("sets 0o444 only under the opt-in chmod mode", async () => {
    const writer = createArchiveWriter(root, { sealMode: "chmod" });
    const handle = await writer.open(RUN, "review", null);
    await handle.appendStdout("output\n");

    for (const name of [ARCHIVE_SNAPSHOT_FILE, ARCHIVE_STDOUT_FILE, ARCHIVE_OUTPUTS_FILE]) {
      expect(await modeOf(join(handle.dir, name)), name).not.toBe(SEALED_FILE_MODE);
    }

    await handle.seal();
    expect(handle.sealMode).toBe("chmod");
    for (const name of [ARCHIVE_SNAPSHOT_FILE, ARCHIVE_STDOUT_FILE, ARCHIVE_OUTPUTS_FILE]) {
      expect(await modeOf(join(handle.dir, name)), name).toBe(SEALED_FILE_MODE);
    }
    const marker = JSON.parse(
      await readFile(join(handle.dir, ARCHIVE_SEALED_MARKER), "utf8"),
    ) as { sealMode: string };
    expect(marker.sealMode).toBe("chmod");

    // The API guarantee is identical under both modes.
    await expect(handle.writeOutputs({})).rejects.toBeInstanceOf(ArchiveImmutableError);
  });

  it("restoreWritableTree makes a chmod-sealed tree writable again", async () => {
    const writer = createArchiveWriter(root, { sealMode: "chmod" });
    const handle = await writer.open(RUN, "gate", null);
    await handle.seal();
    expect(await modeOf(join(handle.dir, ARCHIVE_STDOUT_FILE))).toBe(SEALED_FILE_MODE);

    // Proof the mode bit MEANT something before the restore: a direct write is refused
    // by the kernel. Skipped for uid 0, for which no mode bit is a barrier.
    if (process.getuid?.() !== 0) {
      await expect(
        writeFile(join(handle.dir, ARCHIVE_STDOUT_FILE), "should not land", "utf8"),
      ).rejects.toMatchObject({ code: "EACCES" });
    }

    await restoreWritableTree(handle.dir);
    expect(await modeOf(join(handle.dir, ARCHIVE_STDOUT_FILE))).toBe(0o644);
    // ...and proof it is genuinely writable afterwards, not merely reported as such.
    await writeFile(join(handle.dir, ARCHIVE_STDOUT_FILE), "cleanup rewrote me", "utf8");
    expect(await readFile(join(handle.dir, ARCHIVE_STDOUT_FILE), "utf8")).toBe(
      "cleanup rewrote me",
    );
  });

  it("prune restores writable mode before unlink under BOTH seal modes", async () => {
    for (const sealMode of ["marker", "chmod"] as const) {
      const writer = createArchiveWriter(root, { sealMode });
      const handle = await writer.open(`run-${sealMode}`, "node", null);
      await handle.appendStdout("data\n");
      await handle.seal();

      await writer.prune(root, { maxEntries: 0 });

      expect(await readdir(join(root, ".bober", "archive")), sealMode).not.toContain(
        `run-${sealMode}`,
      );
    }
  });

  it("prune keeps the newest runs and removes the rest", async () => {
    const writer = createArchiveWriter(root);
    for (const run of ["run-a", "run-b", "run-c"]) {
      const handle = await writer.open(run, "node", null);
      await handle.writeOutputs({ run });
      await handle.seal();
    }
    await writer.prune(root, { maxEntries: 2 });
    const remaining = await readdir(join(root, ".bober", "archive"));
    expect(remaining.length).toBe(2);
  });

  it("prune on an absent archive root is a no-op", async () => {
    const writer = createArchiveWriter(root);
    await expect(writer.prune(root, { maxEntries: 0 })).resolves.toBeUndefined();
  });

  it("prune bounds archives by their REAL tree size, not the directory inode size", async () => {
    const writer = createArchiveWriter(root);
    const payload = "x".repeat(100_000);
    const mtimes: Record<string, Date> = {
      "run-a": new Date("2026-08-01T00:00:00.000Z"),
      "run-b": new Date("2026-08-02T00:00:00.000Z"),
      "run-c": new Date("2026-08-03T00:00:00.000Z"),
    };

    // Three runs holding ~100 KB of stdout each, with pinned mtimes so "keep the newest"
    // is unambiguous rather than dependent on filesystem timestamp resolution.
    for (const [run, mtime] of Object.entries(mtimes)) {
      const handle = await writer.open(run, "node", null);
      await handle.appendStdout(payload);
      await handle.seal();
      await utimes(join(root, ".bober", "archive", run), mtime, mtime);
    }

    // `stat(dir).size` is the dirent size — under a kilobyte on every filesystem this
    // runs on — which is what made every maxBytes policy a silent no-op.
    const runA = join(root, ".bober", "archive", "run-a");
    expect((await stat(runA)).size).toBeLessThan(10_000);
    expect(await treeBytes(runA)).toBeGreaterThan(100_000);

    // Room for exactly one run directory.
    await writer.prune(root, { maxBytes: 150_000 });
    expect(await readdir(join(root, ".bober", "archive"))).toEqual(["run-c"]);
    // The survivor is intact, not a truncated leftover.
    expect(
      await readFile(join(root, ".bober", "archive", "run-c", "node", ARCHIVE_STDOUT_FILE), "utf8"),
    ).toBe(payload);
  });

  it("treeBytes sums files recursively and reads a missing directory as zero", async () => {
    const writer = createArchiveWriter(root);
    const handle = await writer.open(RUN, "node", null);
    await handle.appendStdout("1234567890");

    // snapshot.json ("null\n") + outputs.json ("null\n") + the 10 stdout bytes.
    expect(await treeBytes(handle.dir)).toBe(20);
    // One level up: the same files, reached by recursion.
    expect(await treeBytes(join(root, ".bober", "archive"))).toBe(20);
    expect(await treeBytes(join(root, "does-not-exist"))).toBe(0);
  });
});

describe("restoreWritableTree", () => {
  it("recurses into subdirectories and ignores files that vanish", async () => {
    const writer = createArchiveWriter(root, { sealMode: "chmod" });
    const handle = await writer.open(RUN, "nested", null);
    await handle.seal();

    // A read-only file two levels down, of the kind a nested archive would hold.
    const deep = join(root, ".bober", "archive", RUN);
    await restoreWritableTree(deep);
    expect(await modeOf(join(handle.dir, ARCHIVE_OUTPUTS_FILE))).toBe(0o644);

    await chmod(join(handle.dir, ARCHIVE_OUTPUTS_FILE), SEALED_FILE_MODE);
    await restoreWritableTree(join(root, ".bober"));
    expect(await modeOf(join(handle.dir, ARCHIVE_OUTPUTS_FILE))).toBe(0o644);

    await expect(restoreWritableTree(join(root, "does-not-exist"))).resolves.toBeUndefined();
  });
});
