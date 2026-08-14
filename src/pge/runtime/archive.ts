import { appendFile, chmod, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ArchiveHandle as NodeContextArchiveHandle } from "../registry/nodes.js";
import {
  UnsafePathSegmentError,
  assertSafePathSegment,
  atomicWriteFile,
  selectForRemoval,
} from "./scratch.js";
import type { Implements, RetentionPolicy } from "./scratch.js";

/**
 * The per-node-run archive: `.bober/archive/<runId>/<nodeId>[@<branchKey>]/`.
 *
 * Each directory holds `snapshot.json` (the node's inputs), `stdout.log` (whatever the
 * node streamed) and `outputs.json` (what it produced), and stops accepting writes the
 * moment {@link ArchiveHandle.seal} is called. Sprint 10's Engram layer reads these
 * directories to build digests and handoffs; nothing downstream may rewrite history it
 * is summarising.
 *
 * ── Sealing is an API guarantee, not a file permission ──
 *
 * The obvious implementation of "sealed" is `chmod 0o444`. It is the WRONG default here:
 *
 *  - `runInWorktree` (`src/orchestrator/worktree.ts`) removes the worktree on success,
 *    and that worktree may hold the only copy of a run's work,
 *  - `git clean` and `rm -rf` are how a developer recovers a wedged tree,
 *  - and a read-only tree turns all three into a permissions puzzle.
 *
 * So the default {@link ArchiveSealMode} is `"marker"`: `seal()` writes a `.sealed`
 * sidecar and every subsequent write rejects with {@link ArchiveImmutableError} naming
 * the directory. Immutability is enforced by THIS module on every platform, including
 * the ones where a mode bit means little (Windows) or nothing (a container running as
 * root, for which `0o444` is not a barrier at all). `"chmod"` remains available for a
 * caller that wants the belt as well as the braces, and {@link restoreWritableTree}
 * exists so cleanup under either mode is a normal `rm -rf`.
 */

// ── Layout ──────────────────────────────────────────────────────────

export const ARCHIVE_SNAPSHOT_FILE = "snapshot.json";
export const ARCHIVE_STDOUT_FILE = "stdout.log";
export const ARCHIVE_OUTPUTS_FILE = "outputs.json";
export const ARCHIVE_SEALED_MARKER = ".sealed";

/** Every file `open()` creates, in a stable order. */
export const ARCHIVE_FILES = [
  ARCHIVE_SNAPSHOT_FILE,
  ARCHIVE_STDOUT_FILE,
  ARCHIVE_OUTPUTS_FILE,
] as const;

export const ARCHIVE_SEAL_MODES = ["marker", "chmod"] as const;
export type ArchiveSealMode = (typeof ARCHIVE_SEAL_MODES)[number];

/** The default. See the module comment for why it is not `"chmod"`. */
export const DEFAULT_ARCHIVE_SEAL_MODE: ArchiveSealMode = "marker";

export const SEALED_FILE_MODE = 0o444;
export const WRITABLE_FILE_MODE = 0o644;

/** `.bober/archive/` for a project root. */
export function archiveRoot(projectRoot: string): string {
  return join(projectRoot, ".bober", "archive");
}

/** `.bober/archive/<runId>/` for one run. */
export function archiveRunDir(projectRoot: string, runId: string): string {
  assertSafePathSegment("runId", runId);
  return join(archiveRoot(projectRoot), runId);
}

/**
 * The one character that separates a node id from a branch key in a leaf name.
 *
 * It is `@` and NOT `.` for a correctness reason, not a cosmetic one. `.` is legal
 * INSIDE a path segment (`SAFE_SEGMENT_PATTERN` permits it, and a node id is only
 * `z.string().min(1)`), so a `.` separator makes the leaf ambiguous: node `a.b` with no
 * branch and node `a` on branch `b` would be the same directory, and the second
 * execution would silently inherit — and be refused by — the first one's seal. `@` is
 * outside the segment charset, so no node id and no branch key can contain it.
 */
export const ARCHIVE_BRANCH_SEPARATOR = "@";

/**
 * `.bober/archive/<runId>/<nodeId>[@<branchKey>]/`.
 *
 * The branch key is a SUFFIX rather than a nested directory so a fan-out's branches sit
 * beside each other under one node, and `readdir` of the run directory lists every node
 * execution in one pass. That only holds if the leaf name is INJECTIVE in
 * `(nodeId, branchKey)`, which is what the separator check below enforces directly
 * rather than inferring from the current shape of `SAFE_SEGMENT_PATTERN`: a leaf carries
 * at most one `@`, so it splits back into exactly one pair.
 */
export function archiveNodeDir(
  projectRoot: string,
  runId: string,
  nodeId: string,
  branchKey: string | null,
): string {
  assertSafePathSegment("nodeId", nodeId);
  if (branchKey !== null) assertSafePathSegment("branchKey", branchKey);
  assertSeparatorFree("nodeId", nodeId);
  if (branchKey !== null) assertSeparatorFree("branchKey", branchKey);
  const leaf =
    branchKey === null ? nodeId : `${nodeId}${ARCHIVE_BRANCH_SEPARATOR}${branchKey}`;
  return join(archiveRunDir(projectRoot, runId), leaf);
}

/**
 * Refuse a part that carries the separator itself.
 *
 * Redundant today — `assertSafePathSegment` already rejects `@` — and deliberately kept
 * anyway: it is what makes the injectivity of the leaf a property of THIS module, so a
 * future widening of the shared segment charset cannot quietly re-alias two node
 * executions onto one directory.
 */
function assertSeparatorFree(label: string, value: string): void {
  if (value.includes(ARCHIVE_BRANCH_SEPARATOR)) {
    throw new UnsafePathSegmentError(label, value);
  }
}

// ── Errors ──────────────────────────────────────────────────────────

/**
 * A write was attempted against a sealed archive directory.
 *
 * Carries `dir` and the refused `operation`, because "which archive, and what did you
 * try to do to it" is the whole of the diagnosis.
 */
export class ArchiveImmutableError extends Error {
  readonly dir: string;
  readonly operation: string;

  constructor(dir: string, operation: string) {
    super(`Archive "${dir}" is sealed; ${operation} was refused.`);
    this.name = "ArchiveImmutableError";
    this.dir = dir;
    this.operation = operation;
  }
}

// ── Handle ──────────────────────────────────────────────────────────

/**
 * One node execution's archive directory.
 *
 * Wider than the {@link NodeContextArchiveHandle} a node body is handed — `sealed()` and
 * `sealMode` are there for the interpreter and for tests, not for node bodies.
 */
export interface ArchiveHandle {
  readonly dir: string;
  readonly sealMode: ArchiveSealMode;
  sealed(): boolean;
  writeSnapshot(value: unknown): Promise<void>;
  appendStdout(chunk: string): Promise<void>;
  writeOutputs(value: unknown): Promise<void>;
  seal(): Promise<void>;
}

/** sc-6-11 — the concrete handle is still a legal `NodeContext.archive`. */
export const _archiveHandleImplementsNodeContext: Implements<
  ArchiveHandle,
  NodeContextArchiveHandle
> = true;

export interface ArchiveWriter {
  open(runId: string, nodeId: string, branchKey: string | null): Promise<ArchiveHandle>;
  prune(projectRoot: string, policy: RetentionPolicy): Promise<void>;
  /** The directory this writer writes into — asserted by the worktree-isolation test. */
  root(): string;
}

export interface ArchiveWriterOptions {
  /** Default `"marker"`. `"chmod"` additionally sets `0o444` on every sealed file. */
  sealMode?: ArchiveSealMode;
  /** Injected clock, so the `.sealed` marker is assertable. */
  now?: () => Date;
}

// ── Writer ──────────────────────────────────────────────────────────

/**
 * Restore writable permissions across a tree, depth-first.
 *
 * The counterpart to `sealMode: "chmod"`: cleanup paths (`prune`, worktree removal,
 * `git clean`) call this first so an unlink never fails on a mode bit. Missing files are
 * ignored — this runs on trees that may be half-removed already.
 */
export async function restoreWritableTree(dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const path = join(dir, name);
    let info;
    try {
      info = await stat(path);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      await restoreWritableTree(path);
      continue;
    }
    try {
      await chmod(path, WRITABLE_FILE_MODE);
    } catch {
      // A file that vanished between readdir and chmod needs no restoring.
    }
  }
}

/**
 * Total size of every FILE under `dir`, recursively.
 *
 * `stat(dir).size` is the inode/dirent size — 96 bytes for a directory holding 200 KB of
 * stdout — so feeding it to {@link selectForRemoval} makes a `maxBytes` policy inert and
 * `.bober/archive/` grows without bound while `prune` reports success. A run directory
 * holds three files per node execution, so the walk is cheap and runs once per prune.
 * Entries that vanish mid-walk contribute nothing rather than throwing.
 */
export async function treeBytes(dir: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  let total = 0;
  for (const name of entries) {
    const path = join(dir, name);
    let info;
    try {
      info = await stat(path);
    } catch {
      continue;
    }
    if (info.isDirectory()) total += await treeBytes(path);
    else if (info.isFile()) total += info.size;
  }
  return total;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * An archive writer rooted at `projectRoot`.
 *
 * @param projectRoot REQUIRED, and held for the writer's lifetime. No module-level
 *   instance exists: a worktree run must not archive into the original checkout.
 */
export function createArchiveWriter(
  projectRoot: string,
  options: ArchiveWriterOptions = {},
): ArchiveWriter {
  const sealMode = options.sealMode ?? DEFAULT_ARCHIVE_SEAL_MODE;
  const now = options.now ?? (() => new Date());
  const root = archiveRoot(projectRoot);

  return {
    root: () => root,

    async open(runId, nodeId, branchKey): Promise<ArchiveHandle> {
      const dir = archiveNodeDir(projectRoot, runId, nodeId, branchKey);
      await mkdir(dir, { recursive: true });

      const snapshotPath = join(dir, ARCHIVE_SNAPSHOT_FILE);
      const stdoutPath = join(dir, ARCHIVE_STDOUT_FILE);
      const outputsPath = join(dir, ARCHIVE_OUTPUTS_FILE);
      const markerPath = join(dir, ARCHIVE_SEALED_MARKER);

      // A handle opened on an ALREADY sealed directory is born sealed. Without this,
      // "reopen it" would be the trivial way around the guarantee; with it, the marker
      // on disk is authoritative for every handle, not just the one that sealed.
      let isSealed = await pathExists(markerPath);

      if (!isSealed) {
        for (const [path, initial] of [
          [snapshotPath, "null\n"],
          [stdoutPath, ""],
          [outputsPath, "null\n"],
        ] as const) {
          if (!(await pathExists(path))) await writeFile(path, initial, "utf8");
        }
      }

      /**
       * The marker on DISK is authoritative, not this handle's own memory of sealing.
       *
       * Two handles on one directory is the ordinary case — the interpreter opens one,
       * a retry opens another — and "the handle that sealed" must not be the only one
       * that refuses. Re-reading the marker before every write also makes the guarantee
       * hold for a handle obtained before the seal and for a second process entirely.
       * Once seen, it is cached: sealing is one-way.
       */
      async function assertWritable(operation: string): Promise<void> {
        if (isSealed) throw new ArchiveImmutableError(dir, operation);
        if (await pathExists(markerPath)) {
          isSealed = true;
          throw new ArchiveImmutableError(dir, operation);
        }
      }

      return {
        dir,
        sealMode,
        sealed: () => isSealed,

        async writeSnapshot(value): Promise<void> {
          await assertWritable("writeSnapshot");
          await atomicWriteFile(snapshotPath, JSON.stringify(value, null, 2) + "\n");
        },

        async appendStdout(chunk): Promise<void> {
          await assertWritable("appendStdout");
          await appendFile(stdoutPath, chunk, "utf8");
        },

        async writeOutputs(value): Promise<void> {
          await assertWritable("writeOutputs");
          await atomicWriteFile(outputsPath, JSON.stringify(value, null, 2) + "\n");
        },

        async seal(): Promise<void> {
          if (isSealed || (await pathExists(markerPath))) {
            isSealed = true;
            return; // idempotent, including across handles
          }
          await writeFile(
            markerPath,
            JSON.stringify({ sealedAt: now().toISOString(), sealMode, dir }, null, 2) + "\n",
            "utf8",
          );
          if (sealMode === "chmod") {
            for (const name of ARCHIVE_FILES) {
              await chmod(join(dir, name), SEALED_FILE_MODE);
            }
          }
          isSealed = true;
        },
      };
    },

    /**
     * Age out whole run directories under `.bober/archive/`.
     *
     * `projectRoot` is passed explicitly rather than taken from the closure so a cleanup
     * pass can prune a root the writer was not constructed for — the worktree case,
     * where the run wrote into the worktree and the surviving process holds the original
     * checkout.
     *
     * Writable mode is restored BEFORE unlink under both seal modes, so `prune` behaves
     * identically whether or not `chmod` was used.
     *
     * A candidate's `bytes` is the real {@link treeBytes} of the run directory, not
     * `stat(dir).size`: the latter is the dirent size and would make `maxBytes` a silent
     * no-op on every archive.
     */
    async prune(pruneRoot, policy): Promise<void> {
      const base = archiveRoot(pruneRoot);
      let names: string[];
      try {
        names = await readdir(base);
      } catch {
        return;
      }
      const candidates: Array<{ path: string; bytes: number; mtimeMs: number }> = [];
      for (const name of names) {
        const path = join(base, name);
        const info = await stat(path);
        if (!info.isDirectory()) continue;
        candidates.push({ path, bytes: await treeBytes(path), mtimeMs: info.mtimeMs });
      }
      for (const doomed of selectForRemoval(candidates, policy)) {
        await restoreWritableTree(doomed.path);
        await rm(doomed.path, { recursive: true, force: true });
      }
    },
  };
}
