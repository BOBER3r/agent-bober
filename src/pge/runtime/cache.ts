import { createHash } from "node:crypto";
import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { CachePolicySchema } from "../../contracts/topology.js";
import type { CachePolicy } from "../../contracts/topology.js";
import type { Exact } from "../state/overall.js";
import type {
  CacheEntry,
  CacheKeyParts,
  SemanticCache as NodeContextSemanticCache,
} from "../registry/nodes.js";
import {
  assertSafePathSegment,
  atomicWriteFile,
  errnoCode,
  errorMessage,
  readIfPresent,
  resolveWithin,
} from "./scratch.js";
import type { Implements } from "./scratch.js";

/**
 * The semantic cache: one file per key under a SCOPE namespace (ADR-7) —
 * `.bober/cache/runs/<runId>/<sha256>.json` or `.bober/cache/global/<sha256>.json`.
 *
 * ── Six components, and exactly six ──
 *
 * {@link CACHE_KEY_COMPONENTS} is the whole key. Anything omitted is a correctness bug —
 * two calls that differ only in `temperature` or in `toolsMask` are DIFFERENT calls, and
 * a cache that collapses them serves one call's answer for the other. Anything added is
 * a cost bug: a key that includes, say, a timestamp never hits. The list is written down
 * once, the hash is computed from that list in a fixed order, and `cache.test.ts` varies
 * each component in turn and asserts a miss.
 *
 * ── Scope is a NAMESPACE, not a key component ──
 *
 * `CachePolicy.scope` defaults to `"run"`, and a run-scoped entry must not be served to a
 * a different run. It is honoured by the DIRECTORY the entry lands in rather than by
 * mixing `runId` into the digest, so the key stays exactly the six components above and
 * an identical call in two runs still produces the same key — it simply resolves under a
 * different namespace. `"global"` entries live in one shared directory and cross runs on
 * purpose.
 *
 * ── TTL against an injected clock ──
 *
 * Each file carries `expiresAt` and every read takes `now` as an argument. There is no
 * `Date.now()` in this module, so expiry is testable without sleeping and a replayed run
 * can be handed the recorded clock.
 *
 * ── No Redis, no index ──
 *
 * A lookup is one `readFile` at a path derived from the key. The store is inspectable
 * (`cat .bober/cache/<key>.json` shows the key parts alongside the value, which is why
 * they are stored), it needs no daemon, and `better-sqlite3` is the sanctioned escalation
 * if measured lookup cost ever dominates.
 *
 * Only nodes whose `effects` array is EMPTY may declare a cache policy — the
 * `CacheOnEffectfulNode` diagnostic rejects the rest at validation time, so a cached
 * replay can never skip a side effect.
 */

// ── Key ─────────────────────────────────────────────────────────────

/**
 * The six mandated key components, in hash order.
 *
 * The order is part of the contract: the digest is taken over a canonical array built
 * from this list, not over `JSON.stringify(parts)`, so a reordered object literal at a
 * call site cannot change a key.
 */
export const CACHE_KEY_COMPONENTS = [
  "systemPrompt",
  "userPrompt",
  "contextFilesHash",
  "model",
  "temperature",
  "toolsMask",
] as const;

export const CacheKeyPartsSchema = z.object({
  systemPrompt: z.string(),
  userPrompt: z.string(),
  contextFilesHash: z.string(),
  model: z.string(),
  temperature: z.number(),
  toolsMask: z.string(),
});

/** The schema and the node-facing type are the same type, or `tsc` fails. */
export const _cacheKeyPartsAreExact: Exact<
  z.infer<typeof CacheKeyPartsSchema>,
  CacheKeyParts
> = true;

/** The schema's own key set equals {@link CACHE_KEY_COMPONENTS}, or `tsc` fails. */
export const _cacheKeyComponentsAreExact: Exact<
  (typeof CACHE_KEY_COMPONENTS)[number],
  keyof CacheKeyParts
> = true;

export const CACHE_KEY_PATTERN = /^[0-9a-f]{64}$/;

/**
 * The content address of one inference call.
 *
 * Values are placed in an ARRAY in {@link CACHE_KEY_COMPONENTS} order and each is
 * `JSON.stringify`d individually, so no component can bleed into its neighbour: a
 * `systemPrompt` ending in `"` cannot forge the boundary that separates it from
 * `userPrompt`.
 */
export function cacheKey(parts: CacheKeyParts): string {
  const validated = CacheKeyPartsSchema.parse(parts);
  const canonical = CACHE_KEY_COMPONENTS.map((component) =>
    JSON.stringify(validated[component]),
  ).join("\u0000");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

// ── Entry ───────────────────────────────────────────────────────────

/**
 * The on-disk body.
 *
 * `key` and `parts` are stored alongside the value for debugging — "why did this miss"
 * is answered by diffing two files, which is the whole argument for plain files over an
 * opaque index.
 */
export const CacheFileSchema = z.object({
  key: z.string().regex(CACHE_KEY_PATTERN),
  parts: CacheKeyPartsSchema,
  value: z.unknown(),
  storedAt: z.number(),
  expiresAt: z.number(),
});
export type CacheFile = z.infer<typeof CacheFileSchema>;

/**
 * The outcome of reading one entry: the three `FileRead` cases from `./scratch.ts`,
 * plus `corrupt`.
 *
 * `corrupt` is the ONLY one of the four that means "this file is junk". Keeping it
 * separate from `unreadable` is the whole point of the type — the previous shape
 * returned `undefined` for all of absent, denied and malformed, so `prune` deleted
 * files it had merely been refused permission to open.
 */
type CacheRead =
  | { kind: "present"; entry: CacheFile }
  | { kind: "absent" }
  | { kind: "unreadable"; code: string; message: string }
  | { kind: "corrupt"; message: string };

// ── Layout ──────────────────────────────────────────────────────────

/** The two namespaces a {@link CachePolicy} can select. `"run"` is the schema default. */
export type CacheScope = CachePolicy["scope"];

/** What an omitted scope means. Deliberately the NARROWER of the two. */
export const DEFAULT_CACHE_SCOPE: CacheScope = "run";

/** `.bober/cache/global/` — entries a `scope: "global"` policy shares across runs. */
export const CACHE_GLOBAL_DIR = "global";
/** `.bober/cache/runs/<runId>/` — one directory per run, for `scope: "run"`. */
export const CACHE_RUNS_DIR = "runs";

/** `.bober/cache/` for a project root — the parent of both namespaces. */
export function cacheRoot(projectRoot: string): string {
  return join(projectRoot, ".bober", "cache");
}

/**
 * The directory one scope's entries live in.
 *
 * `runId` is required even for `"global"`, because a cache is constructed for a run and
 * carries one either way; it simply does not reach the path when the scope is global.
 */
export function cacheScopeDir(projectRoot: string, scope: CacheScope, runId: string): string {
  assertSafePathSegment("runId", runId);
  return scope === "global"
    ? join(cacheRoot(projectRoot), CACHE_GLOBAL_DIR)
    : join(cacheRoot(projectRoot), CACHE_RUNS_DIR, runId);
}

/** A key that is not 64 hex characters never becomes a path. */
export class InvalidCacheKeyError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(`Cache key "${key}" is not a 64-character lowercase sha256 hex digest.`);
    this.name = "InvalidCacheKeyError";
    this.key = key;
  }
}

export function cachePathForKey(
  projectRoot: string,
  key: string,
  scope: CacheScope,
  runId: string,
): string {
  if (!CACHE_KEY_PATTERN.test(key)) throw new InvalidCacheKeyError(key);
  const path = resolveWithin(cacheScopeDir(projectRoot, scope, runId), `${key}.json`);
  if (path === null) throw new InvalidCacheKeyError(key);
  return path;
}

// ── Prune report ────────────────────────────────────────────────────

/**
 * One entry `prune` walked past without removing, and why.
 *
 *  - `unreadable` — the file EXISTS and could not be read (`EACCES`, `EISDIR`, …). It is
 *    left exactly where it is: an entry that cannot be opened is not an entry that is
 *    known to be junk, and deleting it would destroy a perfectly valid cached answer on
 *    the strength of a permission bit.
 *  - `unremovable` — the entry was due for removal and `unlink` itself failed. Reported
 *    rather than thrown, so one locked file cannot abort the whole sweep and lose the
 *    removals it had already made.
 *
 * A file that is simply GONE is neither: see {@link SemanticCache.pruneWithReport}.
 */
export interface PruneProblem {
  path: string;
  kind: "unreadable" | "unremovable";
  code: string;
  message: string;
}

/** What one sweep did, and what it declined to touch. */
export interface PruneReport {
  /** Entries actually unlinked — expired ones plus genuinely corrupt ones. */
  removed: number;
  /** Entries left on disk because acting on them was not safe. Empty on a clean sweep. */
  problems: PruneProblem[];
}

// ── Cache ───────────────────────────────────────────────────────────

/**
 * The semantic cache.
 *
 * Wider than the {@link NodeContextSemanticCache} a node body is handed: `prune` is a
 * run-lifecycle concern.
 */
export interface SemanticCache {
  key(parts: CacheKeyParts): string;
  /** `scope` defaults to {@link DEFAULT_CACHE_SCOPE}, so an omission cannot cross runs. */
  get(key: string, now: number, scope?: CacheScope): Promise<CacheEntry | undefined>;
  put(
    key: string,
    value: unknown,
    ttlSeconds: number,
    now: number,
    parts: CacheKeyParts,
    scope?: CacheScope,
  ): Promise<void>;
  /**
   * Remove every entry whose `expiresAt` has passed, in BOTH namespaces and across every
   * run directory. Returns how many were removed — {@link SemanticCache.pruneWithReport}
   * for the removals PLUS what the sweep refused to touch.
   */
  prune(now: number): Promise<number>;
  /**
   * The same sweep, reporting what it declined to remove.
   *
   * `prune` deletes files, so the three ways a read can fail are three different facts
   * and it must tell them apart:
   *
   *  - ABSENT (`ENOENT`) — listed by `readdir`, gone by the time it was opened. Another
   *    sweep or an external `rm` won the race; there is nothing to delete, and nothing
   *    THIS call removed, so it is not counted and not a problem.
   *  - UNREADABLE (any other errno) — the file is there and could not be opened. NOT
   *    deleted, NOT counted, and reported as a {@link PruneProblem}.
   *  - CORRUPT — read fine, and is not a cache entry (bad JSON, or JSON the schema
   *    rejects). Nothing can ever be served from it, so it is removed and counted.
   */
  pruneWithReport(now: number): Promise<PruneReport>;
  /** The directory this cache writes into — asserted by the worktree-isolation test. */
  root(): string;
  /** The run this cache namespaces `scope: "run"` entries under. */
  runId(): string;
}

/** sc-6-11 — the concrete cache is still a legal `NodeContext.cache`. */
export const _semanticCacheImplementsNodeContext: Implements<
  SemanticCache,
  NodeContextSemanticCache
> = true;

/**
 * A cache rooted at `projectRoot`, namespaced by `runId`.
 *
 * @param projectRoot REQUIRED and FIRST. Two roots means two caches; there is no
 *   module-level instance to share an entry across them.
 * @param runId REQUIRED. A `scope: "run"` entry — the schema default — is readable only
 *   through a cache built with the same `runId`, which is what stops one run's inference
 *   results being replayed into another.
 */
export function createSemanticCache(projectRoot: string, runId: string): SemanticCache {
  assertSafePathSegment("runId", runId);
  const root = cacheRoot(projectRoot);

  /**
   * Read one entry into the four-way {@link CacheRead}.
   *
   * `get` collapses all four outcomes to a miss because a cache must never fail a run;
   * `prune` does not, because `prune` deletes.
   */
  async function readEntry(path: string): Promise<CacheRead> {
    const read = await readIfPresent(path);
    if (read.kind === "absent") return { kind: "absent" };
    if (read.kind === "unreadable") {
      return { kind: "unreadable", code: read.code, message: read.message };
    }
    try {
      return { kind: "present", entry: CacheFileSchema.parse(JSON.parse(read.text)) };
    } catch (error) {
      return { kind: "corrupt", message: errorMessage(error) };
    }
  }

  async function pruneWithReport(now: number): Promise<PruneReport> {
    const problems: PruneProblem[] = [];
    let removed = 0;

    /** Unlink one doomed entry. A file some other sweep already took is not a failure. */
    async function remove(path: string): Promise<void> {
      try {
        await unlink(path);
        removed += 1;
      } catch (error) {
        const code = errnoCode(error);
        // Gone between the read and the unlink: the outcome we wanted, by another hand.
        // Not counted — this call removed nothing.
        if (code === "ENOENT") return;
        problems.push({
          path,
          kind: "unremovable",
          code: code ?? "UNKNOWN",
          message: errorMessage(error),
        });
      }
    }

    /** Sweep one namespace directory. A missing directory removes nothing. */
    async function pruneDir(dir: string): Promise<void> {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        return;
      }
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const path = join(dir, name);
        const read = await readEntry(path);

        // ABSENT — listed by readdir, gone when opened. Nothing to delete, and nothing
        // this call removed, so it is neither counted nor reported.
        if (read.kind === "absent") continue;

        // UNREADABLE — the file IS there. Deleting what we could not even look at would
        // throw away a valid entry over a permission bit, so it survives and is reported.
        if (read.kind === "unreadable") {
          problems.push({ path, kind: "unreadable", code: read.code, message: read.message });
          continue;
        }

        // Live entry: keep.
        if (read.kind === "present" && read.entry.expiresAt > now) continue;

        // What remains is CORRUPT (opened, and not a cache entry — nothing can ever be
        // served from it) or present-and-expired. Both are genuinely removable.
        await remove(path);
      }
    }

    // Both namespaces, and EVERY run directory rather than only this cache's own:
    // an expired entry is expired whichever run wrote it, and a run whose cache
    // object is long gone would otherwise leave its entries behind forever.
    await pruneDir(join(root, CACHE_GLOBAL_DIR));
    let runNames: string[];
    try {
      runNames = await readdir(join(root, CACHE_RUNS_DIR));
    } catch {
      return { removed, problems };
    }
    for (const name of runNames) {
      await pruneDir(join(root, CACHE_RUNS_DIR, name));
    }
    return { removed, problems };
  }

  return {
    root: () => root,
    runId: () => runId,
    key: cacheKey,

    async get(key, now, scope = DEFAULT_CACHE_SCOPE): Promise<CacheEntry | undefined> {
      const read = await readEntry(cachePathForKey(projectRoot, key, scope, runId));
      // Absent, unreadable and corrupt are all one thing HERE — a miss, never a throw:
      // the cache is an optimisation and must not be able to fail a run. `prune` is the
      // caller that must tell them apart, because `prune` is the caller that deletes.
      if (read.kind !== "present") return undefined;
      const { entry } = read;
      // Expiry is inclusive of the instant itself: an entry stored with ttl 60 at t=0
      // has already expired at t=60_000.
      if (entry.expiresAt <= now) return undefined;
      return { value: entry.value, storedAt: entry.storedAt, expiresAt: entry.expiresAt };
    },

    async put(key, value, ttlSeconds, now, parts, scope = DEFAULT_CACHE_SCOPE): Promise<void> {
      if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
        throw new RangeError(`ttlSeconds must be a positive finite number, received ${ttlSeconds}`);
      }
      const file: CacheFile = CacheFileSchema.parse({
        key,
        parts,
        value,
        storedAt: now,
        expiresAt: now + ttlSeconds * 1000,
      });
      await atomicWriteFile(
        cachePathForKey(projectRoot, key, scope, runId),
        JSON.stringify(file, null, 2) + "\n",
      );
    },

    pruneWithReport,

    async prune(now): Promise<number> {
      return (await pruneWithReport(now)).removed;
    },
  };
}

// ── Cached call ─────────────────────────────────────────────────────

export type CacheStatus = "hit" | "miss" | "skip";

export interface CachedCallResult<T> {
  value: T;
  status: CacheStatus;
  /** `null` exactly when `status` is `"skip"` — no key was computed, no file was read. */
  key: string | null;
}

/**
 * Run `invoke` through the cache, or straight past it.
 *
 * The `policy === null` path is the important one: a node with NO declared cache policy
 * must not read, write or even key the cache — status `"skip"`, key `null`, zero files
 * touched. That is what keeps `.bober/cache/` empty for a graph that declares no caching
 * at all, and it is asserted by counting files, not by trusting the status.
 *
 * Both declared fields are honoured. The policy is re-parsed here so `scope` is present
 * even when the caller hand-built the object: a dropped `scope` would default a run-only
 * entry into the shared namespace, which is exactly the failure the field exists to
 * prevent.
 */
export async function runCached<T>(args: {
  cache: SemanticCache;
  parts: CacheKeyParts;
  policy: CachePolicy | null | undefined;
  now: number;
  invoke: () => Promise<T>;
}): Promise<CachedCallResult<T>> {
  const { cache, parts, policy, now, invoke } = args;
  if (policy === null || policy === undefined) {
    return { value: await invoke(), status: "skip", key: null };
  }
  const { ttlSeconds, scope } = CachePolicySchema.parse(policy);
  const key = cache.key(parts);
  const hit = await cache.get(key, now, scope);
  if (hit !== undefined) {
    // The cache stores `unknown`; the caller declares what it put in. This is the single
    // narrowing point, rather than an `any` leaking through every consumer.
    return { value: hit.value as T, status: "hit", key };
  }
  const value = await invoke();
  await cache.put(key, value, ttlSeconds, now, parts, scope);
  return { value, status: "miss", key };
}
