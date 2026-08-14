import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import { ScratchRefSchema } from "../state/overall.js";
import type { ScratchKind, ScratchRef } from "../state/overall.js";
import type { ScratchStore as NodeContextScratchStore } from "../registry/nodes.js";

/**
 * The content-addressed scratch store: `.bober/scratch/<runId>/<sha256>.<ext>`.
 *
 * ── Why this exists ──
 *
 * A 5 MB workspace diff must never reach {@link OverallState}. The commit boundary
 * (sprint 7) REJECTS any channel value serialising above the channel's `maxInlineBytes`,
 * so a node that produces bulk output has exactly one legal move: write the bytes here
 * and put the 4-field {@link ScratchRef} in state. This module is what makes that move
 * possible; sprint 7 is what makes it mandatory.
 *
 * ── Filesystem, not Redis (ADR-7) ──
 *
 * The source documents prescribed a local Redis instance for offload. This CLI is
 * symlinked into arbitrary projects and may not require a daemon, so the store is plain
 * files addressed by the SHA-256 of their own bytes. Identical content dedupes for free —
 * the second `put` of the same payload finds the file already there and does not rewrite
 * it — and every entry is inspectable with `cat`. `better-sqlite3` is the sanctioned
 * escalation if measured lookup cost ever dominates; it is deliberately not taken first.
 *
 * ── No singleton ──
 *
 * {@link createScratchStore} takes `projectRoot` and holds it. There is no module-level
 * instance: `runInWorktree` substitutes `projectRoot` for the whole run, and a store
 * captured at import time would write a worktree run's payloads into the original
 * checkout.
 */

// ── Errors ──────────────────────────────────────────────────────────

/**
 * A path segment that would leave the store it names.
 *
 * `runId` reaches this module from a run manager and `nodeId`/`branchKey` reach
 * {@link ../runtime/archive.ts} from a topology artifact, so both are validated at the
 * boundary rather than trusted. `..` is the specific input this refuses.
 */
export class UnsafePathSegmentError extends Error {
  readonly label: string;
  readonly segment: string;

  constructor(label: string, segment: string) {
    super(
      `Unsafe ${label} "${segment}": a path segment must be non-empty and may contain only letters, digits, "." (not "." or ".."), "_" and "-".`,
    );
    this.name = "UnsafePathSegmentError";
    this.label = label;
    this.segment = segment;
  }
}

/** A {@link ScratchRef} whose `uri` does not resolve to a file inside the store. */
export class ScratchRefError extends Error {
  readonly uri: string;

  constructor(uri: string, reason: string) {
    super(`Scratch reference "${uri}" is not usable: ${reason}`);
    this.name = "ScratchRefError";
    this.uri = uri;
  }
}

/** The bytes on disk no longer hash to the digest the reference carries. */
export class ScratchIntegrityError extends Error {
  readonly uri: string;
  readonly expected: string;
  readonly actual: string;

  constructor(uri: string, expected: string, actual: string) {
    super(
      `Scratch payload "${uri}" failed its integrity check: expected sha256 ${expected}, found ${actual}.`,
    );
    this.name = "ScratchIntegrityError";
    this.uri = uri;
    this.expected = expected;
    this.actual = actual;
  }
}

// ── Path safety ─────────────────────────────────────────────────────

/**
 * A single path segment: no separator, no `.`/`..`, no NUL, no whitespace.
 *
 * Deliberately narrower than {@link SCRATCH_URI_PATTERN}, which permits `/` and `.`
 * because a URI is several segments joined.
 */
const SAFE_SEGMENT_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/;

/** Throw {@link UnsafePathSegmentError} unless `value` is a safe single path segment. */
export function assertSafePathSegment(label: string, value: string): void {
  if (!SAFE_SEGMENT_PATTERN.test(value)) throw new UnsafePathSegmentError(label, value);
}

/**
 * Resolve `child` under `root` and prove it stayed there.
 *
 * The containment check is on the RESOLVED path, so a symlink-free `..` in any component
 * is caught however it was assembled.
 */
export function resolveWithin(root: string, child: string): string | null {
  const base = resolve(root);
  const target = resolve(base, child);
  if (target === base) return target;
  return target.startsWith(base.endsWith(sep) ? base : base + sep) ? target : null;
}

// ── Atomic write ────────────────────────────────────────────────────

/**
 * Write bytes via temp-file + rename, so a crash never leaves a readable partial file.
 *
 * Shared by the other three filesystem stores in this directory (archive, cache, trace):
 * one implementation of the durability primitive, not four.
 */
export async function atomicWriteFile(path: string, data: Buffer | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

// ── File reads ──────────────────────────────────────────────────────

/**
 * The three distinguishable outcomes of reading a file that may legitimately be absent.
 *
 * `absent` is ONLY `ENOENT`. Every other errno — `EACCES`, `EISDIR`, `EPERM`, `ELOOP` —
 * means the file may well EXIST and we could not look at it, which is a different fact
 * with a different remedy. A caller that collapses the two either tells the operator to
 * create something that is already there, or — far worse, and the reason this lives in
 * the runtime layer at all — DELETES an entry it merely failed to open.
 *
 * Deliberately the same shape and the same member names as `FileRead` in
 * `../topology/dump.ts`, where the identical distinction was drawn first: one vocabulary
 * for one fact. It is restated rather than imported because the semantic cache must not
 * take a dependency on the topology serializer (and everything that module pulls in) for
 * a filesystem primitive — the runtime's shared fs helpers live here, next to
 * {@link atomicWriteFile}, for archive, cache and trace alike.
 */
export type FileRead =
  | { kind: "present"; text: string }
  | { kind: "absent" }
  | { kind: "unreadable"; code: string; message: string };

/** The `code` of a Node `SystemError`, or `undefined` for anything else. */
export function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** The `message` of an `Error`, or its string form — never `[object Object]` in a report. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Read `path` as UTF-8, distinguishing "not there" from "there but unreadable". */
export async function readIfPresent(path: string): Promise<FileRead> {
  try {
    return { kind: "present", text: await readFile(path, "utf8") };
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable", code: code ?? "UNKNOWN", message: errorMessage(error) };
  }
}

// ── Layout ──────────────────────────────────────────────────────────

/** File extension per payload class. Extensions are cosmetic; the sha256 is the address. */
export const SCRATCH_EXTENSIONS: Readonly<Record<ScratchKind, string>> = Object.freeze({
  stdout: "txt",
  stderr: "txt",
  diff: "diff",
  document: "md",
  payload: "json",
});

export const SCRATCH_URI_SCHEME = "scratch://";

/** `.bober/scratch/` for a project root. */
export function scratchRoot(projectRoot: string): string {
  return join(projectRoot, ".bober", "scratch");
}

/** `.bober/scratch/<runId>/` for one run. */
export function scratchRunDir(projectRoot: string, runId: string): string {
  assertSafePathSegment("runId", runId);
  return join(scratchRoot(projectRoot), runId);
}

/**
 * The absolute path a {@link ScratchRef} names, or a throw.
 *
 * Exported because a SECOND consumer — a later node, a digest pass, a human — reads the
 * payload from the ref alone, without the store that produced it.
 */
export function scratchPathForRef(projectRoot: string, ref: ScratchRef): string {
  if (!ref.uri.startsWith(SCRATCH_URI_SCHEME)) {
    throw new ScratchRefError(ref.uri, `it does not start with "${SCRATCH_URI_SCHEME}"`);
  }
  const relative = ref.uri.slice(SCRATCH_URI_SCHEME.length);
  if (relative.length === 0) throw new ScratchRefError(ref.uri, "it names no file");
  const target = resolveWithin(scratchRoot(projectRoot), relative);
  if (target === null) {
    throw new ScratchRefError(ref.uri, "it resolves outside .bober/scratch/");
  }
  return target;
}

// ── Retention ───────────────────────────────────────────────────────

/**
 * A bounded-size retention policy, in the shape the bounded `.bober/memory/` mechanism
 * already uses: keep the newest entries subject to a count bound, a total-byte bound and
 * an age bound. Every field is optional; an empty policy removes nothing.
 *
 * `now` is injected rather than read from the clock so an age-based prune is testable
 * without sleeping.
 */
export interface RetentionPolicy {
  maxEntries?: number;
  maxBytes?: number;
  maxAgeMs?: number;
  now?: number;
}

interface RetentionCandidate {
  path: string;
  bytes: number;
  mtimeMs: number;
}

/**
 * Newest-first selection under the three bounds. Returns the candidates to REMOVE.
 *
 * Shared with the archive writer so both stores age out under one rule.
 */
export function selectForRemoval<T extends RetentionCandidate>(
  candidates: readonly T[],
  policy: RetentionPolicy,
): T[] {
  const now = policy.now ?? Date.now();
  const newestFirst = [...candidates].sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : 1));
  const remove: T[] = [];
  let keptBytes = 0;
  let keptCount = 0;
  for (const candidate of newestFirst) {
    const tooOld = policy.maxAgeMs !== undefined && now - candidate.mtimeMs > policy.maxAgeMs;
    const tooMany = policy.maxEntries !== undefined && keptCount >= policy.maxEntries;
    const tooBig =
      policy.maxBytes !== undefined && keptBytes + candidate.bytes > policy.maxBytes;
    if (tooOld || tooMany || tooBig) {
      remove.push(candidate);
      continue;
    }
    keptCount += 1;
    keptBytes += candidate.bytes;
  }
  return remove;
}

// ── Store ───────────────────────────────────────────────────────────

/**
 * The scratch store.
 *
 * Wider than the {@link NodeContextScratchStore} a node body is handed: `prune` is a
 * run-lifecycle concern, not a node concern, so nodes cannot reach it.
 */
export interface ScratchStore {
  put(runId: string, kind: ScratchKind, data: string | Uint8Array): Promise<ScratchRef>;
  get(ref: ScratchRef): Promise<Buffer>;
  text(ref: ScratchRef): Promise<string>;
  prune(runId: string, policy: RetentionPolicy): Promise<void>;
  /** The directory this store writes into — asserted by the worktree-isolation test. */
  root(): string;
}

/**
 * `A extends B ? true : never` — a compile-time "A is usable wherever B is expected".
 *
 * Used below (and in the sibling runtime modules) to prove the concrete store still
 * satisfies the narrower interface the node-facing {@link NodeContext} declares. The
 * guard fails `npm run typecheck`, not a test, so drift cannot reach a green suite.
 */
export type Implements<A, B> = A extends B ? true : never;

/** sc-6-11 — the concrete store is still a legal `NodeContext.scratch`. */
export const _scratchStoreImplementsNodeContext: Implements<
  ScratchStore,
  NodeContextScratchStore
> = true;

/**
 * A scratch store rooted at `projectRoot`.
 *
 * @param projectRoot REQUIRED. Under a worktree run this is the worktree, never the
 *   original checkout.
 */
export function createScratchStore(projectRoot: string): ScratchStore {
  const root = scratchRoot(projectRoot);

  async function readCandidates(runId: string): Promise<RetentionCandidate[]> {
    const dir = scratchRunDir(projectRoot, runId);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const candidates: RetentionCandidate[] = [];
    for (const name of names) {
      const path = join(dir, name);
      const info = await stat(path);
      if (!info.isFile()) continue;
      candidates.push({ path, bytes: info.size, mtimeMs: info.mtimeMs });
    }
    return candidates;
  }

  // Free functions rather than object methods, so a destructured `const { get } = store`
  // keeps working — the interpreter passes these around individually.
  async function get(ref: ScratchRef): Promise<Buffer> {
    const path = scratchPathForRef(projectRoot, ref);
    const bytes = await readFile(path);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== ref.sha256) throw new ScratchIntegrityError(ref.uri, ref.sha256, actual);
    return bytes;
  }

  return {
    root: () => root,
    get,

    async put(runId, kind, data): Promise<ScratchRef> {
      const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const fileName = `${sha256}.${SCRATCH_EXTENSIONS[kind]}`;
      const dir = scratchRunDir(projectRoot, runId);
      const path = join(dir, fileName);

      // Content-addressed: identical bytes are already the file at this path, so the
      // second put is a stat, not a rewrite. The inode is stable, which the dedupe test
      // asserts — a rename-based rewrite would allocate a new one.
      let present: boolean;
      try {
        present = (await stat(path)).isFile();
      } catch {
        present = false;
      }
      if (!present) {
        await mkdir(dir, { recursive: true });
        await atomicWriteFile(path, bytes);
      }

      return ScratchRefSchema.parse({
        uri: `${SCRATCH_URI_SCHEME}${runId}/${fileName}`,
        sha256,
        bytes: bytes.byteLength,
        kind,
      });
    },

    async text(ref): Promise<string> {
      return (await get(ref)).toString("utf8");
    },

    async prune(runId, policy): Promise<void> {
      const candidates = await readCandidates(runId);
      for (const doomed of selectForRemoval(candidates, policy)) {
        await unlink(doomed.path);
      }
    },
  };
}
