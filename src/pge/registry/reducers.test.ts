import { describe, expect, it } from "vitest";

import { KNOWN_REDUCERS, REDUCER_REFS, reducerProperties } from "../../contracts/topology.js";
import {
  REDUCER_IDS,
  allReducers,
  appendById,
  canonicalJson,
  createReducerRegistry,
  lastWriteWinsByKey,
  maxNumber,
  mergeLedger,
  replaceIfNewer,
  setUnion,
} from "./reducers.js";
import type { Reducer, ReducerId } from "./reducers.js";

/**
 * sc-5-3 / sc-5-4 / sc-5-5 — the reducer registry is a closed join-semilattice.
 *
 * Every registered reducer is asserted associative (in its batching form), commutative
 * (shuffle-invariant) and idempotent over GENERATED inputs, not over one hand-picked
 * example. The generators draw ids and keys from deliberately SMALL pools so updates
 * collide constantly — a property test whose inputs never conflict would prove only
 * that disjoint merges are easy.
 *
 * Results are compared as CANONICAL FORMS, never by reference: a reducer that returned
 * its first argument unchanged would satisfy a reference-equality assertion and fail
 * every real merge.
 *
 * The seed is recorded and fixed, so a failure is reproducible and a green run is not
 * an accident of the day's entropy.
 */

// ── Seeded RNG ──────────────────────────────────────────────────────

/** Recorded seed. Change it deliberately, never to make a failure disappear. */
const SEED = 20_260_805;

/** Randomized triples per law, per case. The contract's floor is 200. */
const CASE_COUNT = 200;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

interface Rng {
  float(): number;
  int(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
  shuffle<T>(items: readonly T[]): T[];
}

function rngFor(seed: number): Rng {
  const next = mulberry32(seed);
  const rng: Rng = {
    float: () => next(),
    int: (maxExclusive) => Math.floor(next() * maxExclusive),
    pick: (items) => items[Math.floor(next() * items.length)],
    shuffle: (items) => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        const swap = out[i];
        out[i] = out[j];
        out[j] = swap;
      }
      return out;
    },
  };
  return rng;
}

function times<T>(rng: Rng, maxLength: number, make: () => T): T[] {
  const length = rng.int(maxLength + 1);
  return Array.from({ length }, make);
}

// ── Generators, one per channel shape ───────────────────────────────

const MESSAGE_IDS = ["m0", "m1", "m2", "m3"] as const;
const ROLES = ["system", "user", "assistant", "tool"] as const;
const NODE_IDS = ["draft", "review"] as const;

function messagesValue(rng: Rng): unknown {
  return times(rng, 4, () => ({
    id: rng.pick(MESSAGE_IDS),
    seq: rng.int(4),
    role: rng.pick(ROLES),
    nodeId: rng.pick(NODE_IDS),
    text: rng.pick(["alpha", "beta", "gamma"]),
    tokens: rng.int(50),
  }));
}

const REF_KEYS = ["research", "diff", "stdout"] as const;

function refsValue(rng: Rng): unknown {
  const out: Record<string, unknown> = {};
  for (const key of REF_KEYS) {
    if (rng.float() < 0.5) continue;
    out[key] = {
      uri: `scratch://run-1/${rng.pick(["a", "b", "c"])}.txt`,
      sha256: rng.pick(["a", "b", "c"]).repeat(64),
      bytes: rng.int(4096),
      kind: rng.pick(["document", "diff", "stdout"] as const),
    };
  }
  return out;
}

const CONTRACT_IDS = ["contract-1", "contract-2", "contract-3"] as const;

function sprintContractsValue(rng: Rng): unknown {
  // Identified by `contractId`, not `id` — the same reducer must union a contract list
  // as happily as a message list, which is why `intrinsicId` consults several fields.
  return times(rng, 3, () => ({
    contractId: rng.pick(CONTRACT_IDS),
    sprintNumber: rng.int(4) + 1,
    status: rng.pick(["proposed", "passed", "failed"] as const),
  }));
}

const COUNTER_KEYS = ["researchReflexions", "supervisorRounds", "sprintAttempts"] as const;

function countersValue(rng: Rng): unknown {
  const out: Record<string, number> = {};
  for (const key of COUNTER_KEYS) {
    if (rng.float() < 0.4) continue;
    out[key] = rng.int(8);
  }
  return out;
}

const BRANCH_KEYS = ["branch-a", "branch-b", "branch-c"] as const;

function branchStatusValue(rng: Rng): unknown {
  const out: Record<string, unknown> = {};
  for (const key of BRANCH_KEYS) {
    if (rng.float() < 0.45) continue;
    out[key] = {
      state: rng.pick(["pending", "running", "succeeded", "failed"] as const),
      attempts: rng.int(4),
    };
  }
  return out;
}

const ANCHORS = ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts"] as const;

function testAnchorsValue(rng: Rng): unknown {
  return times(rng, 4, () => rng.pick(ANCHORS));
}

function specValue(rng: Rng): unknown {
  if (rng.float() < 0.3) return null;
  return {
    specId: rng.pick(["spec-1", "spec-2"]),
    version: rng.int(4),
    updatedAt: rng.pick([
      "2026-08-01T00:00:00.000Z",
      "2026-08-02T00:00:00.000Z",
      "2026-08-03T00:00:00.000Z",
    ]),
    title: rng.pick(["first", "second"]),
  };
}

function ledgerValue(rng: Rng): unknown {
  return times(rng, 4, () => ({
    nodeId: rng.pick(NODE_IDS),
    attempt: rng.int(2),
    callIndex: rng.int(2),
    calls: 1,
    tokensIn: rng.int(500),
    tokensOut: rng.int(200),
    costUsd: rng.int(100) / 1000,
  }));
}

interface LawCase {
  /** Readable name, used in test titles and failure messages. */
  readonly name: string;
  readonly reducerId: ReducerId;
  readonly reducer: Reducer<unknown>;
  readonly gen: (rng: Rng) => unknown;
}

const CASES: readonly LawCase[] = [
  { name: "appendById / messages (array, id field)", reducerId: "appendById", reducer: appendById, gen: messagesValue },
  { name: "appendById / refs (record keyed by id)", reducerId: "appendById", reducer: appendById, gen: refsValue },
  {
    name: "appendById / sprintContracts (array, contractId field)",
    reducerId: "appendById",
    reducer: appendById,
    gen: sprintContractsValue,
  },
  { name: "maxNumber / counters", reducerId: "maxNumber", reducer: maxNumber, gen: countersValue },
  {
    name: "lastWriteWinsByKey / branchStatus",
    reducerId: "lastWriteWinsByKey",
    reducer: lastWriteWinsByKey,
    gen: branchStatusValue,
  },
  { name: "setUnion / testAnchors", reducerId: "setUnion", reducer: setUnion, gen: testAnchorsValue },
  { name: "replaceIfNewer / spec", reducerId: "replaceIfNewer", reducer: replaceIfNewer, gen: specValue },
  { name: "mergeLedger / ledger", reducerId: "mergeLedger", reducer: mergeLedger, gen: ledgerValue },
];

// ── The registry is closed and complete ─────────────────────────────

describe("the closed reducer registry", () => {
  it("resolves exactly the six declared reducers", () => {
    const registry = createReducerRegistry();
    expect(registry.ids()).toEqual([
      "appendById",
      "lastWriteWinsByKey",
      "maxNumber",
      "mergeLedger",
      "replaceIfNewer",
      "setUnion",
    ]);
    expect([...REDUCER_IDS].sort()).toEqual(registry.ids());
    expect(allReducers()).toHaveLength(6);
  });

  it("declares all four join-semilattice flags as true on every entry", () => {
    for (const reducer of allReducers()) {
      expect(reducer.associative, reducer.id).toBe(true);
      expect(reducer.batchingInvariant, reducer.id).toBe(true);
      expect(reducer.orderInvariant, reducer.id).toBe(true);
      expect(reducer.idempotent, reducer.id).toBe(true);
    }
  });

  it("misses on inherited Object.prototype members rather than resolving them", () => {
    const registry = createReducerRegistry();
    for (const inherited of ["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"]) {
      expect(registry.get(inherited), inherited).toBeUndefined();
    }
    expect(registry.get("listAppend")).toBeUndefined();
  });

  it("has one property-test case for every registered reducer", () => {
    // A seventh reducer added without a generator fails HERE rather than shipping
    // untested — which is the only way the "closed registry" claim stays true.
    expect(new Set(CASES.map((c) => c.reducerId))).toEqual(new Set(createReducerRegistry().ids()));
  });

  it("deliberately does NOT register listAppend, which the topology layer still names", () => {
    // `KNOWN_REDUCERS` lists seven refs; `listAppend` is order-dependent by construction
    // and exists only so `NonAssociativeReducerUnderFanOut` has something to catch. A
    // channel that names it therefore fails compilation rather than merging unlawfully.
    expect(REDUCER_REFS).toContain("listAppend");
    expect([...REDUCER_IDS]).not.toContain("listAppend");
    expect(reducerProperties("listAppend")?.orderInvariant).toBe(false);
  });

  it("pins the intentional divergence on replaceIfNewer's orderInvariant flag", () => {
    // Two different questions, one word. The declarative flag answers "may a fan-out
    // region write this channel?" (no: it is scalar). The executable flag answers "is
    // the merge a join?" (yes: it is a maximum over a total order). Pinned so the
    // apparent contradiction is not "fixed" into a real one.
    expect(KNOWN_REDUCERS.replaceIfNewer.scalar).toBe(true);
    expect(KNOWN_REDUCERS.replaceIfNewer.orderInvariant).toBe(false);
    expect(replaceIfNewer.orderInvariant).toBe(true);
  });
});

// ── sc-5-3: batching invariance / associativity ─────────────────────

describe("sc-5-3 batching invariance", () => {
  for (const testCase of CASES) {
    it(`${testCase.name}: merge(merge(s,xs),ys) === merge(s,[...xs,...ys]) over ${CASE_COUNT} randomized triples`, () => {
      const rng = rngFor(SEED + testCase.name.length);
      for (let i = 0; i < CASE_COUNT; i += 1) {
        const current = testCase.gen(rng);
        const xs = times(rng, 3, () => testCase.gen(rng));
        const ys = times(rng, 3, () => testCase.gen(rng));

        const staged = testCase.reducer.merge(testCase.reducer.merge(current, xs), ys);
        const batched = testCase.reducer.merge(current, [...xs, ...ys]);

        expect(canonicalJson(staged), `${testCase.name} case ${i} (seed ${SEED})`).toBe(
          canonicalJson(batched),
        );
      }
    });
  }
});

// ── sc-5-4: shuffle invariance and idempotence ──────────────────────

describe("sc-5-4 shuffle invariance", () => {
  for (const testCase of CASES) {
    it(`${testCase.name}: merge(s, shuffle(xs)) === merge(s, xs) over ${CASE_COUNT} randomized batches`, () => {
      const rng = rngFor(SEED + 1 + testCase.name.length);
      for (let i = 0; i < CASE_COUNT; i += 1) {
        const current = testCase.gen(rng);
        // At least two updates, or "shuffled" is the same list and the assertion is empty.
        const xs = [testCase.gen(rng), testCase.gen(rng), ...times(rng, 2, () => testCase.gen(rng))];
        const shuffled = rng.shuffle(xs);

        expect(
          canonicalJson(testCase.reducer.merge(current, shuffled)),
          `${testCase.name} case ${i} (seed ${SEED})`,
        ).toBe(canonicalJson(testCase.reducer.merge(current, xs)));
      }
    });
  }
});

describe("sc-5-4 idempotence", () => {
  for (const testCase of CASES) {
    it(`${testCase.name}: merge(merge(s,xs),xs) === merge(s,xs) over ${CASE_COUNT} randomized batches`, () => {
      const rng = rngFor(SEED + 2 + testCase.name.length);
      for (let i = 0; i < CASE_COUNT; i += 1) {
        const current = testCase.gen(rng);
        const xs = times(rng, 3, () => testCase.gen(rng));

        const once = testCase.reducer.merge(current, xs);
        const twice = testCase.reducer.merge(once, xs);

        expect(canonicalJson(twice), `${testCase.name} case ${i} (seed ${SEED})`).toBe(
          canonicalJson(once),
        );
      }
    });
  }
});

describe("identity and canonical fixed point", () => {
  for (const testCase of CASES) {
    it(`${testCase.name}: identity absorbs, and a merged result is its own canonical form`, () => {
      const rng = rngFor(SEED + 3 + testCase.name.length);
      const reducer = testCase.reducer;

      expect(canonicalJson(reducer.merge(reducer.identity, []))).toBe(
        canonicalJson(reducer.identity),
      );

      for (let i = 0; i < CASE_COUNT; i += 1) {
        const value = testCase.gen(rng);
        const merged = reducer.merge(value, []);
        // Re-merging a canonical result with nothing must not move it, or the commit
        // boundary's output would depend on how many times it was written.
        expect(canonicalJson(reducer.merge(merged, [])), `${testCase.name} case ${i}`).toBe(
          canonicalJson(merged),
        );
        // The identity really is a left unit for a single update.
        expect(canonicalJson(reducer.merge(reducer.identity, [value])), `${testCase.name} case ${i}`).toBe(
          canonicalJson(merged),
        );
      }
    });
  }
});

// ── sc-5-5: the messages channel never loses a message ──────────────

describe("sc-5-5 messages channel monotonicity", () => {
  it("never shrinks and never drops a message id across 100 randomized concurrent merges", () => {
    const rng = rngFor(SEED + 5);
    let state = appendById.merge(appendById.identity, []) as unknown[];
    const seenIds = new Set<string>();

    for (let round = 0; round < 100; round += 1) {
      const before = state as Array<{ id: string }>;
      const beforeLength = before.length;
      const beforeIds = before.map((m) => m.id);
      for (const id of beforeIds) seenIds.add(id);

      // Between one and four branches committing into the same channel in one superstep.
      const concurrent = Array.from({ length: 1 + rng.int(4) }, () =>
        times(rng, 3, () => ({
          id: `m${rng.int(12)}`,
          seq: round,
          role: rng.pick(ROLES),
          nodeId: rng.pick(NODE_IDS),
          text: rng.pick(["alpha", "beta"]),
          tokens: rng.int(20),
        })),
      );

      state = appendById.merge(state, concurrent) as unknown[];
      const after = state as Array<{ id: string }>;
      const afterIds = new Set(after.map((m) => m.id));

      expect(after.length, `round ${round} length shrank`).toBeGreaterThanOrEqual(beforeLength);
      for (const id of seenIds) {
        expect(afterIds.has(id), `round ${round} lost message id ${id}`).toBe(true);
      }
      // Union by id: never two rows for one id.
      expect(afterIds.size).toBe(after.length);
    }

    expect(seenIds.size).toBeGreaterThan(0);
  });
});

// ── Per-reducer semantics ───────────────────────────────────────────

describe("appendById", () => {
  it("unions by intrinsic id and sorts by (seq, id)", () => {
    const merged = appendById.merge(
      [{ id: "b", seq: 1, text: "one" }],
      [
        [{ id: "a", seq: 1, text: "two" }],
        [{ id: "c", seq: 0, text: "three" }],
      ],
    ) as Array<{ id: string }>;

    expect(merged.map((m) => m.id)).toEqual(["c", "a", "b"]);
  });

  it("collapses a re-delivered message instead of appending it twice", () => {
    const once = appendById.merge([], [[{ id: "a", seq: 0, text: "x" }]]);
    const twice = appendById.merge(once, [[{ id: "a", seq: 0, text: "x" }]]);
    expect(twice).toHaveLength(1);
    expect(canonicalJson(twice)).toBe(canonicalJson(once));
  });

  it("resolves a same-id conflict deterministically, whichever way round it arrives", () => {
    const left = { id: "a", seq: 0, text: "aaa" };
    const right = { id: "a", seq: 0, text: "zzz" };
    const forward = appendById.merge([], [[left], [right]]);
    const backward = appendById.merge([], [[right], [left]]);
    expect(canonicalJson(forward)).toBe(canonicalJson(backward));
    expect(forward).toEqual([right]);
  });

  it("keeps the record shape for a record-valued channel and sorts its keys", () => {
    const merged = appendById.merge(
      { b: { uri: "scratch://x/b" } },
      [{ a: { uri: "scratch://x/a" } }],
    );
    expect(Object.keys(merged as Record<string, unknown>)).toEqual(["a", "b"]);
  });

  it("identifies an anonymous member by its own canonical form", () => {
    const merged = appendById.merge([], [[{ text: "x" }], [{ text: "x" }], [{ text: "y" }]]);
    expect(merged).toHaveLength(2);
  });
});

describe("maxNumber", () => {
  it("takes the per-key maximum, so a replayed superstep cannot double-count", () => {
    const first = maxNumber.merge({}, [{ retries: 1 }, { retries: 2 }]);
    expect(first).toEqual({ retries: 2 });
    expect(maxNumber.merge(first, [{ retries: 2 }])).toEqual({ retries: 2 });
    expect(maxNumber.merge(first, [{ retries: 1 }])).toEqual({ retries: 2 });
  });

  it("drops non-finite and non-numeric members rather than poisoning the channel", () => {
    expect(maxNumber.merge({ a: 1 }, [{ a: Number.NaN }, { b: "3" } as never])).toEqual({ a: 1 });
  });
});

describe("lastWriteWinsByKey", () => {
  it("merges disjoint per-branch keys without losing either", () => {
    const merged = lastWriteWinsByKey.merge({}, [
      { "branch-a": { state: "succeeded", attempts: 1 } },
      { "branch-b": { state: "failed", attempts: 3 } },
    ]);
    expect(merged).toEqual({
      "branch-a": { state: "succeeded", attempts: 1 },
      "branch-b": { state: "failed", attempts: 3 },
    });
  });

  it("resolves a collision on one key the same way in both arrival orders", () => {
    const a = { "branch-a": { state: "failed", attempts: 1 } };
    const b = { "branch-a": { state: "succeeded", attempts: 2 } };
    expect(canonicalJson(lastWriteWinsByKey.merge({}, [a, b]))).toBe(
      canonicalJson(lastWriteWinsByKey.merge({}, [b, a])),
    );
  });
});

describe("setUnion", () => {
  it("unions, dedupes and sorts", () => {
    expect(setUnion.merge(["b"], [["a", "b"], ["c"]])).toEqual(["a", "b", "c"]);
  });

  it("drops non-string members", () => {
    expect(setUnion.merge([], [["a", 1, null] as never])).toEqual(["a"]);
  });
});

describe("replaceIfNewer", () => {
  it("keeps the highest version", () => {
    const older = { specId: "s", version: 1, updatedAt: "2026-08-01T00:00:00.000Z" };
    const newer = { specId: "s", version: 2, updatedAt: "2026-08-01T00:00:00.000Z" };
    expect(replaceIfNewer.merge(older, [newer])).toEqual(newer);
    expect(replaceIfNewer.merge(newer, [older])).toEqual(newer);
  });

  it("breaks a version tie by updatedAt", () => {
    const early = { specId: "s", version: 1, updatedAt: "2026-08-01T00:00:00.000Z" };
    const late = { specId: "s", version: 1, updatedAt: "2026-08-09T00:00:00.000Z" };
    expect(replaceIfNewer.merge(early, [late])).toEqual(late);
    expect(replaceIfNewer.merge(late, [early])).toEqual(late);
  });

  it("treats null as the bottom element", () => {
    const value = { specId: "s", version: 0 };
    expect(replaceIfNewer.merge(null, [value])).toEqual(value);
    expect(replaceIfNewer.merge(value, [null])).toEqual(value);
    expect(replaceIfNewer.merge(null, [])).toBeNull();
  });
});

describe("mergeLedger", () => {
  const charge = (nodeId: string, attempt: number, callIndex: number, costUsd: number) => ({
    nodeId,
    attempt,
    callIndex,
    calls: 1,
    tokensIn: 10,
    tokensOut: 5,
    costUsd,
  });

  it("replaces by (nodeId, attempt, callIndex) instead of adding", () => {
    const first = mergeLedger.merge([], [[charge("draft", 0, 0, 0.02)]]);
    const replayed = mergeLedger.merge(first, [[charge("draft", 0, 0, 0.02)]]);
    expect(replayed).toHaveLength(1);
    expect(replayed).toEqual([charge("draft", 0, 0, 0.02)]);
  });

  it("keeps distinct calls apart when only callIndex differs", () => {
    const merged = mergeLedger.merge(
      [],
      [[charge("draft", 0, 0, 0.02)], [charge("draft", 0, 1, 0.03)]],
    ) as Array<{ callIndex: number }>;
    expect(merged).toHaveLength(2);
    expect(merged.map((e) => e.callIndex)).toEqual([0, 1]);
  });

  it("keeps distinct attempts apart, so a retry is its own charge", () => {
    const merged = mergeLedger.merge(
      [],
      [[charge("draft", 0, 0, 0.02)], [charge("draft", 1, 0, 0.05)]],
    );
    expect(merged).toHaveLength(2);
  });
});

// ── canonicalJson ───────────────────────────────────────────────────

describe("canonicalJson", () => {
  it("sorts object keys at every depth so key order cannot change a comparison", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("preserves array order, because array order is data", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("drops undefined members and never returns undefined", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson(undefined)).toBe("null");
  });
});
