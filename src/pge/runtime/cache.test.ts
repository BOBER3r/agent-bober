import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CachePolicySchema } from "../../contracts/topology.js";
import type { CachePolicy } from "../../contracts/topology.js";
import type { CacheKeyParts } from "../registry/nodes.js";
import { UnsafePathSegmentError } from "./scratch.js";
import {
  CACHE_GLOBAL_DIR,
  CACHE_KEY_COMPONENTS,
  CACHE_RUNS_DIR,
  DEFAULT_CACHE_SCOPE,
  InvalidCacheKeyError,
  cacheKey,
  cachePathForKey,
  cacheRoot,
  cacheScopeDir,
  createSemanticCache,
  runCached,
} from "./cache.js";

/**
 * sc-6-5, sc-6-6 — the semantic cache.
 *
 * The two failure modes a cache has are tested directly:
 *
 *  - keying too NARROWLY (serving one call's answer for a different call) — six
 *    assertions, one per mandated component, each varying exactly that component and
 *    asserting a miss;
 *  - keying too WIDELY or expiring wrongly (never hitting, or hitting stale) — an
 *    identical call hits exactly once, an expired entry misses, and `prune` reports how
 *    many it removed.
 *
 * Serving one RUN's answer to another is the third failure mode, and it is the one a
 * key-only design cannot see: the key is identical by construction, so only the
 * namespace can separate the two. `CachePolicy.scope` is asserted end to end below.
 *
 * Every expiry assertion runs against an injected clock, so nothing here sleeps.
 */

let root = "";
const RUN = "run-20260805-a";
/** Where `scope: "run"` entries for {@link RUN} land — the default namespace. */
const runDir = (): string => cacheScopeDir(root, "run", RUN);

const BASE: CacheKeyParts = {
  systemPrompt: "You are the generator.",
  userPrompt: "Implement sprint 6.",
  contextFilesHash: "sha256:abc123",
  model: "claude-sonnet-4-5",
  temperature: 0.2,
  toolsMask: "read,write,bash",
};

const TTL_60: CachePolicy = { ttlSeconds: 60, scope: "run" };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bober-pge-cache-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("cacheKey composition (sc-6-5)", () => {
  it("hashes exactly the six mandated components", () => {
    expect([...CACHE_KEY_COMPONENTS]).toEqual([
      "systemPrompt",
      "userPrompt",
      "contextFilesHash",
      "model",
      "temperature",
      "toolsMask",
    ]);
    expect(Object.keys(BASE).sort()).toEqual([...CACHE_KEY_COMPONENTS].sort());
  });

  it("is a stable 64-char sha256 hex digest, insensitive to object key order", () => {
    const key = cacheKey(BASE);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(cacheKey(BASE)).toBe(key);

    const reordered: CacheKeyParts = {
      toolsMask: BASE.toolsMask,
      temperature: BASE.temperature,
      model: BASE.model,
      contextFilesHash: BASE.contextFilesHash,
      userPrompt: BASE.userPrompt,
      systemPrompt: BASE.systemPrompt,
    };
    expect(cacheKey(reordered)).toBe(key);
  });

  it("changes when ANY single component changes — one assertion per component", () => {
    const base = cacheKey(BASE);
    const variants: Array<[string, CacheKeyParts]> = [
      ["systemPrompt", { ...BASE, systemPrompt: "You are the evaluator." }],
      ["userPrompt", { ...BASE, userPrompt: "Implement sprint 7." }],
      ["contextFilesHash", { ...BASE, contextFilesHash: "sha256:def456" }],
      ["model", { ...BASE, model: "claude-haiku-4-5" }],
      ["temperature", { ...BASE, temperature: 0.20001 }],
      ["toolsMask", { ...BASE, toolsMask: "read,write" }],
    ];
    const keys = new Set<string>([base]);
    for (const [component, parts] of variants) {
      const key = cacheKey(parts);
      expect(key, `${component} must change the key`).not.toBe(base);
      keys.add(key);
    }
    // All seven keys are distinct — no two components collapse onto each other.
    expect(keys.size).toBe(7);
  });

  it("cannot be forged by moving content across the component boundary", () => {
    // Naive concatenation would make these two collide.
    const a = cacheKey({ ...BASE, systemPrompt: "ab", userPrompt: "c" });
    const b = cacheKey({ ...BASE, systemPrompt: "a", userPrompt: "bc" });
    expect(a).not.toBe(b);
  });

  it("refuses a key that is not a sha256 digest before it becomes a path", () => {
    expect(() => cachePathForKey(root, "../../etc/passwd", "run", RUN)).toThrow(
      InvalidCacheKeyError,
    );
    expect(() => cachePathForKey(root, "ABC", "run", RUN)).toThrow(InvalidCacheKeyError);
    expect(cachePathForKey(root, "a".repeat(64), "run", RUN)).toBe(
      join(cacheRoot(root), CACHE_RUNS_DIR, RUN, `${"a".repeat(64)}.json`),
    );
    expect(cachePathForKey(root, "a".repeat(64), "global", RUN)).toBe(
      join(cacheRoot(root), CACHE_GLOBAL_DIR, `${"a".repeat(64)}.json`),
    );
  });

  it("refuses a runId that would escape .bober/cache/", () => {
    expect(() => cachePathForKey(root, "a".repeat(64), "run", "../..")).toThrow(
      UnsafePathSegmentError,
    );
    expect(() => createSemanticCache(root, "../../escape")).toThrow(UnsafePathSegmentError);
  });
});

describe("runCached (sc-6-5)", () => {
  it("an identical call yields ONE provider invocation and one hit", async () => {
    const cache = createSemanticCache(root, RUN);
    let invocations = 0;
    const invoke = async (): Promise<{ text: string }> => {
      invocations += 1;
      return { text: `answer ${invocations}` };
    };

    const first = await runCached({ cache, parts: BASE, policy: TTL_60, now: 0, invoke });
    expect(first.status).toBe("miss");
    expect(first.value).toEqual({ text: "answer 1" });

    const second = await runCached({ cache, parts: BASE, policy: TTL_60, now: 1_000, invoke });
    expect(second.status).toBe("hit");
    expect(second.value).toEqual({ text: "answer 1" });
    expect(second.key).toBe(first.key);
    expect(invocations).toBe(1);
  });

  it("misses — and calls the provider again — when exactly one component differs", async () => {
    const cache = createSemanticCache(root, RUN);
    let invocations = 0;
    const invoke = async (): Promise<number> => {
      invocations += 1;
      return invocations;
    };

    await runCached({ cache, parts: BASE, policy: TTL_60, now: 0, invoke });
    expect(invocations).toBe(1);

    const variants: Array<[string, CacheKeyParts]> = [
      ["systemPrompt", { ...BASE, systemPrompt: "different system" }],
      ["userPrompt", { ...BASE, userPrompt: "different user" }],
      ["contextFilesHash", { ...BASE, contextFilesHash: "sha256:changed" }],
      ["model", { ...BASE, model: "gpt-5" }],
      ["temperature", { ...BASE, temperature: 0.9 }],
      ["toolsMask", { ...BASE, toolsMask: "read" }],
    ];
    for (const [component, parts] of variants) {
      const before = invocations;
      const result = await runCached({ cache, parts, policy: TTL_60, now: 0, invoke });
      expect(result.status, component).toBe("miss");
      expect(invocations, component).toBe(before + 1);
    }
    expect(invocations).toBe(7);
    expect((await readdir(runDir())).length).toBe(7);
  });

  it("stores the key parts alongside the value so a miss is diagnosable", async () => {
    const cache = createSemanticCache(root, RUN);
    await runCached({
      cache,
      parts: BASE,
      policy: TTL_60,
      now: 1_000,
      invoke: async () => ({ ok: true }),
    });
    const key = cacheKey(BASE);
    const body = JSON.parse(await readFile(cachePathForKey(root, key, "run", RUN), "utf8")) as {
      key: string;
      parts: CacheKeyParts;
      value: unknown;
      storedAt: number;
      expiresAt: number;
    };
    expect(body.key).toBe(key);
    expect(body.parts).toEqual(BASE);
    expect(body.value).toEqual({ ok: true });
    expect(body.storedAt).toBe(1_000);
    expect(body.expiresAt).toBe(61_000);
  });
});

describe("TTL against an injected clock (sc-6-6)", () => {
  it("hits inside ttlSeconds and misses after expiry", async () => {
    const cache = createSemanticCache(root, RUN);
    const key = cacheKey(BASE);
    await cache.put(key, { answer: 42 }, 60, 1_000, BASE);

    expect(await cache.get(key, 1_000)).toMatchObject({
      value: { answer: 42 },
      storedAt: 1_000,
      expiresAt: 61_000,
    });
    expect(await cache.get(key, 60_999)).toBeDefined();
    // Expiry is inclusive: at exactly expiresAt the entry is gone.
    expect(await cache.get(key, 61_000)).toBeUndefined();
    expect(await cache.get(key, 61_001)).toBeUndefined();
  });

  it("a provider is called again once the entry expires", async () => {
    const cache = createSemanticCache(root, RUN);
    let invocations = 0;
    const invoke = async (): Promise<number> => {
      invocations += 1;
      return invocations;
    };

    expect((await runCached({ cache, parts: BASE, policy: TTL_60, now: 0, invoke })).status).toBe(
      "miss",
    );
    expect((await runCached({ cache, parts: BASE, policy: TTL_60, now: 59_999, invoke })).status).toBe(
      "hit",
    );
    expect((await runCached({ cache, parts: BASE, policy: TTL_60, now: 60_000, invoke })).status).toBe(
      "miss",
    );
    expect(invocations).toBe(2);
  });

  it("prune removes expired entries and RETURNS the count removed", async () => {
    const cache = createSemanticCache(root, RUN);
    await cache.put(cacheKey(BASE), 1, 10, 0, BASE);
    await cache.put(cacheKey({ ...BASE, userPrompt: "b" }), 2, 20, 0, {
      ...BASE,
      userPrompt: "b",
    });
    await cache.put(cacheKey({ ...BASE, userPrompt: "c" }), 3, 1_000, 0, {
      ...BASE,
      userPrompt: "c",
    });
    expect((await readdir(runDir())).length).toBe(3);

    expect(await cache.prune(5_000)).toBe(0);
    expect(await cache.prune(15_000)).toBe(1);
    expect((await readdir(runDir())).length).toBe(2);
    expect(await cache.prune(25_000)).toBe(1);
    expect(await cache.prune(25_000)).toBe(0);
    expect((await readdir(runDir())).length).toBe(1);

    // The long-lived entry is untouched and still readable.
    expect(await cache.get(cacheKey({ ...BASE, userPrompt: "c" }), 25_000)).toMatchObject({
      value: 3,
    });
  });

  it("prune on an absent cache directory returns 0", async () => {
    const cache = createSemanticCache(root, RUN);
    expect(await cache.prune(1)).toBe(0);
  });

  it("rejects a non-positive ttl rather than storing an entry that never expires", async () => {
    const cache = createSemanticCache(root, RUN);
    await expect(cache.put(cacheKey(BASE), 1, 0, 0, BASE)).rejects.toBeInstanceOf(RangeError);
    await expect(cache.put(cacheKey(BASE), 1, -5, 0, BASE)).rejects.toBeInstanceOf(RangeError);
    await expect(cache.put(cacheKey(BASE), 1, Number.NaN, 0, BASE)).rejects.toBeInstanceOf(
      RangeError,
    );
    await expect(readdir(cacheRoot(root))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats a corrupt entry as a miss instead of failing the run", async () => {
    const cache = createSemanticCache(root, RUN);
    const key = cacheKey(BASE);
    await cache.put(key, { answer: 1 }, 60, 0, BASE);
    await writeFile(cachePathForKey(root, key, "run", RUN), "{ this is not json", "utf8");
    expect(await cache.get(key, 0)).toBeUndefined();
  });
});

describe("no declared policy means no cache file at all (sc-6-6)", () => {
  it("never reads, writes or keys the cache", async () => {
    const cache = createSemanticCache(root, RUN);
    let invocations = 0;
    const invoke = async (): Promise<string> => {
      invocations += 1;
      return "uncached";
    };

    for (const policy of [null, undefined] as const) {
      const result = await runCached({ cache, parts: BASE, policy, now: 0, invoke });
      expect(result.status).toBe("skip");
      expect(result.key).toBeNull();
      expect(result.value).toBe("uncached");
    }

    // Called every time, and `.bober/cache/` was never even created.
    expect(invocations).toBe(2);
    await expect(readdir(cacheRoot(root))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("a cached node and an uncached node in the same run do not interfere", async () => {
    const cache = createSemanticCache(root, RUN);
    let cachedCalls = 0;
    let uncachedCalls = 0;

    await runCached({
      cache,
      parts: BASE,
      policy: TTL_60,
      now: 0,
      invoke: async () => {
        cachedCalls += 1;
        return "a";
      },
    });
    await runCached({
      cache,
      parts: BASE,
      policy: null,
      now: 0,
      invoke: async () => {
        uncachedCalls += 1;
        return "b";
      },
    });
    await runCached({
      cache,
      parts: BASE,
      policy: TTL_60,
      now: 0,
      invoke: async () => {
        cachedCalls += 1;
        return "c";
      },
    });

    expect(cachedCalls).toBe(1);
    expect(uncachedCalls).toBe(1);
    // One file: the skip wrote nothing, so it could not have overwritten the hit.
    expect((await readdir(runDir())).length).toBe(1);
  });
});

describe("CachePolicy.scope decides the namespace (sc-6-5, sc-6-6)", () => {
  const OTHER_RUN = "run-20260805-b";

  /** A provider that counts its calls, so a "hit" claim is checked against real work. */
  function countingProvider(answer: string): { invoke: () => Promise<string>; calls: () => number } {
    let calls = 0;
    return {
      invoke: async () => {
        calls += 1;
        return answer;
      },
      calls: () => calls,
    };
  }

  it("the default scope is the narrow one", () => {
    expect(DEFAULT_CACHE_SCOPE).toBe("run");
    // ...and the contract schema agrees, so an omitted field and an omitted argument
    // land in the same namespace.
    expect(CachePolicySchema.parse({ ttlSeconds: 60 }).scope).toBe("run");
  });

  it('a scope:"run" entry MISSES from a different run — the same six-component key', async () => {
    const runA = createSemanticCache(root, RUN);
    const runB = createSemanticCache(root, OTHER_RUN);

    const a = countingProvider("answer from RUN A");
    const first = await runCached({
      cache: runA,
      parts: BASE,
      policy: TTL_60,
      now: 0,
      invoke: a.invoke,
    });
    expect(first.status).toBe("miss");

    const b = countingProvider("answer from RUN B");
    const second = await runCached({
      cache: runB,
      parts: BASE,
      policy: TTL_60,
      now: 1_000,
      invoke: b.invoke,
    });

    // Not "a different key" — the SAME key, in a different namespace.
    expect(second.key).toBe(first.key);
    expect(second.status).toBe("miss");
    expect(second.value).toBe("answer from RUN B");
    expect(b.calls()).toBe(1);
    // Run A's entry is untouched and still its own.
    expect(await runA.get(first.key as string, 1_000, "run")).toMatchObject({
      value: "answer from RUN A",
    });
  });

  it('a scope:"global" entry HITS from a different run', async () => {
    const globalPolicy: CachePolicy = { ttlSeconds: 60, scope: "global" };
    const runA = createSemanticCache(root, RUN);
    const runB = createSemanticCache(root, OTHER_RUN);

    const a = countingProvider("shared answer");
    expect(
      (await runCached({ cache: runA, parts: BASE, policy: globalPolicy, now: 0, invoke: a.invoke }))
        .status,
    ).toBe("miss");

    const b = countingProvider("should never be produced");
    const second = await runCached({
      cache: runB,
      parts: BASE,
      policy: globalPolicy,
      now: 1_000,
      invoke: b.invoke,
    });
    expect(second.status).toBe("hit");
    expect(second.value).toBe("shared answer");
    expect(b.calls()).toBe(0);
  });

  it("a policy that omits scope is defaulted to run — never promoted to global", async () => {
    // Exactly what the contract parser hands the interpreter for `{ ttlSeconds: 60 }`.
    const defaulted = CachePolicySchema.parse({ ttlSeconds: 60 });
    const runA = createSemanticCache(root, RUN);
    const runB = createSemanticCache(root, OTHER_RUN);

    await runCached({
      cache: runA,
      parts: BASE,
      policy: defaulted,
      now: 0,
      invoke: async () => "run A only",
    });

    const b = countingProvider("run B computes its own");
    const second = await runCached({
      cache: runB,
      parts: BASE,
      policy: defaulted,
      now: 0,
      invoke: b.invoke,
    });
    expect(second.status).toBe("miss");
    expect(second.value).toBe("run B computes its own");
    expect(b.calls()).toBe(1);

    // Nothing was written to the shared namespace at all.
    await expect(readdir(join(cacheRoot(root), CACHE_GLOBAL_DIR))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("writes each scope to its own directory on disk", async () => {
    const cache = createSemanticCache(root, RUN);
    const key = cacheKey(BASE);
    await cache.put(key, "scoped to the run", 60, 0, BASE, "run");
    await cache.put(key, "shared", 60, 0, BASE, "global");

    expect(await readdir(join(cacheRoot(root), CACHE_RUNS_DIR, RUN))).toEqual([`${key}.json`]);
    expect(await readdir(join(cacheRoot(root), CACHE_GLOBAL_DIR))).toEqual([`${key}.json`]);
    // One key, two entries, no collision between them.
    expect(await cache.get(key, 0, "run")).toMatchObject({ value: "scoped to the run" });
    expect(await cache.get(key, 0, "global")).toMatchObject({ value: "shared" });
  });

  it("an omitted scope argument reads and writes the run namespace", async () => {
    const runA = createSemanticCache(root, RUN);
    const runB = createSemanticCache(root, OTHER_RUN);
    const key = cacheKey(BASE);

    await runA.put(key, "implicitly run-scoped", 60, 0, BASE);
    expect(await runA.get(key, 0)).toMatchObject({ value: "implicitly run-scoped" });
    expect(await runB.get(key, 0)).toBeUndefined();
    expect(await readdir(join(cacheRoot(root), CACHE_RUNS_DIR, RUN))).toEqual([`${key}.json`]);
  });

  it("prune sweeps expired entries in BOTH namespaces and across every run", async () => {
    const runA = createSemanticCache(root, RUN);
    const runB = createSemanticCache(root, OTHER_RUN);
    const key = cacheKey(BASE);
    const longLived = cacheKey({ ...BASE, userPrompt: "long" });

    await runA.put(key, "a", 10, 0, BASE, "run");
    await runB.put(key, "b", 10, 0, BASE, "run");
    await runA.put(key, "g", 10, 0, BASE, "global");
    await runA.put(longLived, "keep", 1_000, 0, { ...BASE, userPrompt: "long" }, "run");

    // One prune call, issued from run A's cache, reaches run B's directory and the
    // shared one — an expired entry is expired whoever wrote it.
    expect(await runA.prune(5_000)).toBe(0);
    expect(await runA.prune(15_000)).toBe(3);
    expect(await runA.prune(15_000)).toBe(0);

    expect(await readdir(join(cacheRoot(root), CACHE_GLOBAL_DIR))).toEqual([]);
    expect(await readdir(join(cacheRoot(root), CACHE_RUNS_DIR, OTHER_RUN))).toEqual([]);
    expect(await runA.get(longLived, 15_000)).toMatchObject({ value: "keep" });
  });

  it("reports the run it namespaces run-scoped entries under", () => {
    expect(createSemanticCache(root, RUN).runId()).toBe(RUN);
    expect(createSemanticCache(root, RUN).root()).toBe(cacheRoot(root));
  });
});
