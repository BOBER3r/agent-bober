/**
 * The CLOSED reducer registry (ADR-4).
 *
 * Six reducers, no seventh, and no escape hatch that accepts an arbitrary merge
 * function. Each one is a JOIN-SEMILATTICE over its channel's value domain:
 *
 *   associative        merge(merge(s, xs), ys) === merge(s, [...xs, ...ys])
 *   commutative        merge(s, shuffle(xs))   === merge(s, xs)
 *   idempotent         merge(merge(s, xs), xs) === merge(s, xs)
 *
 * Those three laws are why a fan-in is order-invariant (concurrency 1 and concurrency 8
 * commit the same bytes) and why replay is decidable (a re-executed superstep cannot
 * double-append, double-count or double-charge). `reducers.test.ts` asserts all three
 * for every registered reducer over generated inputs with a recorded seed — not over a
 * hand-picked example.
 *
 * ── The signature is a BATCH signature, on purpose ──
 *
 * `merge(current, updates[])` is called ONCE per channel per superstep with the whole
 * batch, never folded update-by-update. Batching-invariance then becomes an assertion
 * over the actual signature instead of an emergent property of each implementation, and
 * "exactly one write per channel per superstep" is true by construction.
 *
 * ── The four flags are literal `true` ──
 *
 * {@link Reducer} declares `associative`, `batchingInvariant`, `orderInvariant` and
 * `idempotent` as the literal type `true`, so an object that admits `false` is not
 * assignable to `Reducer<T>` and cannot reach {@link defineReducer}. A non-join
 * reducer is unregisterable at the type level, not merely unregistered. The type-level
 * negative fixtures at the bottom of this file prove that rejection under
 * `npm run typecheck`.
 *
 * ── Totality ──
 *
 * Every reducer is TOTAL: any input — including a value of the wrong shape — maps
 * deterministically to a canonical output. A partial reducer would make the laws hold
 * only on the inputs the author happened to imagine, which is exactly the class of bug
 * a property test exists to find.
 *
 * ── Conflict resolution ──
 *
 * Where two updates claim the same key with DIFFERENT content, `appendById` and
 * `lastWriteWinsByKey` resolve to the higher-ranked value: {@link rankIsGreater}'s total
 * order over `(version, updatedAt, canonicalJson(value))`. The `canonicalJson` term is
 * what keeps that order deterministic ON A TIE — two values that agree on `version` and
 * `updatedAt` still need a defined winner, or the join is not commutative; "whichever
 * arrived last" is precisely the non-commutative answer a total order rules out.
 * `mergeLedger` still resolves by {@link canonicalJson} alone via `joinByCanonicalOrder`:
 * `LedgerEntry` carries neither `version` nor `updatedAt`, so the two resolvers agree
 * there, and its key — `(nodeId, attempt, callIndex)` — identifies one call, so the
 * tie-break stays unreachable exactly as before. Scalar channels stay single-writer by
 * `MultipleWritersOnScalarChannel`, so `replaceIfNewer`'s identical rank-aware join never
 * meets a real conflict either. The collision this section describes IS real, by design,
 * for `appendById`'s `sprintContracts` (a seeded and a settled copy of the same contract,
 * distinguished by `version`) and for `lastWriteWinsByKey`'s `branchStatus` (successive
 * writes to the same branch key across supersteps, distinguished by `attempts`) — which is
 * exactly why both needed a total order richer than `canonicalJson` alone.
 */

// ── Reducer ─────────────────────────────────────────────────────────

/**
 * A registered channel reducer.
 *
 * The four flags are declarations the type system enforces and cannot prove; the
 * property suite is what proves them. Both are required: the flags stop a
 * non-conforming reducer from being written down, the tests stop a conforming-looking
 * one from being wrong.
 */
export interface Reducer<T> {
  /** Registry id, matching `channels[].reducerRef` in the topology artifact. */
  readonly id: string;
  /** The bottom element: `merge(identity, [])` is `identity`. */
  readonly identity: T;
  readonly associative: true;
  readonly batchingInvariant: true;
  readonly orderInvariant: true;
  readonly idempotent: true;
  /** Called ONCE per channel per superstep with the whole batch of updates. */
  merge(current: T, updates: readonly T[]): T;
}

/**
 * The ONLY way an entry enters the closed table.
 *
 * It is deliberately a plain identity function: its entire job is to be a typed gate,
 * so an object literal whose `associative` (or any other flag) is not the literal
 * `true` is rejected at the call site rather than at review time.
 */
export function defineReducer<T>(reducer: Reducer<T>): Reducer<T> {
  return reducer;
}

export interface ReducerRegistry {
  get(id: string): Reducer<unknown> | undefined;
  ids(): string[];
}

// ── Canonical form ──────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = value[key];
      if (child === undefined) continue;
      out[key] = canonicalValue(child);
    }
    return out;
  }
  return value;
}

/**
 * Deterministic string form of any value: object keys sorted at every depth, array
 * order preserved, `undefined` members dropped.
 *
 * Two roles. It is the total order the conflict tie-break joins on, and it is what the
 * property suite compares — comparing references would pass for two reducers that
 * merely return the same object, which is not the law being tested.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value)) ?? "null";
}

/** Deterministic winner between two conflicting values. */
function joinByCanonicalOrder(left: unknown, right: unknown): unknown {
  const a = canonicalJson(left);
  const b = canonicalJson(right);
  if (a === b) return left;
  return a > b ? left : right;
}

// ── appendById ──────────────────────────────────────────────────────

/**
 * A channel whose value is a collection of independently identified members: either an
 * ARRAY of records carrying an intrinsic id, or a RECORD whose keys are the ids.
 *
 * Both shapes exist in the shipped topology — `messages`, `evaluations` and
 * `sprintContracts` are arrays; `refs` is a record — and both are bound to
 * `appendById`, so the reducer handles either.
 */
export type IdentifiedCollection = readonly unknown[] | Readonly<Record<string, unknown>>;

/** Fields consulted, in order, for an array member's intrinsic id. */
const INTRINSIC_ID_FIELDS = ["id", "contractId", "key", "uri"] as const;

/**
 * The identity `appendById` unions on.
 *
 * A member with no id field is identified by its own canonical form, so two identical
 * anonymous members collapse (idempotence) and two different ones both survive
 * (no silent loss).
 */
function intrinsicId(item: unknown): string {
  if (isPlainObject(item)) {
    for (const field of INTRINSIC_ID_FIELDS) {
      const raw = item[field];
      if (typeof raw === "string" && raw.length > 0) return raw;
    }
  }
  return canonicalJson(item);
}

/** Primary sort key of the canonical array form; members without one sort at 0. */
function seqOf(item: unknown): number {
  if (isPlainObject(item)) {
    const raw = item.seq;
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  }
  return 0;
}

/** `[id, member]` pairs contributed by one container. A non-collection contributes none. */
function collectionEntries(container: unknown): Array<[string, unknown]> {
  if (Array.isArray(container)) {
    return container.map((item) => [intrinsicId(item), item] as [string, unknown]);
  }
  if (isPlainObject(container)) {
    return Object.keys(container).map((key) => [key, container[key]] as [string, unknown]);
  }
  return [];
}

function mergeEntries(containers: readonly unknown[]): Map<string, unknown> {
  const merged = new Map<string, unknown>();
  for (const container of containers) {
    for (const [id, item] of collectionEntries(container)) {
      // rank-aware join (sc-4-1): a duplicate id survives as the higher-ranked value, not
      // merely the canonically-greater one — see `higherRanked` and the module header.
      merged.set(id, merged.has(id) ? higherRanked(merged.get(id), item) : item);
    }
  }
  return merged;
}

function recordFromEntries(merged: ReadonlyMap<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of [...merged.keys()].sort()) out[key] = merged.get(key);
  return out;
}

function arrayFromEntries(merged: ReadonlyMap<string, unknown>): unknown[] {
  return [...merged.entries()]
    .sort((a, b) => {
      const seqDelta = seqOf(a[1]) - seqOf(b[1]);
      if (seqDelta !== 0) return seqDelta;
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    })
    .map(([, item]) => item);
}

/**
 * Union by intrinsic id, then canonical order — `(seq, id)` for the array form, sorted
 * keys for the record form.
 *
 * This is the reducer plain list-append cannot be. Append is associative but NOT
 * order-invariant, so two branches finishing in a different order commit different
 * arrays and the concurrency-1 / concurrency-8 criterion becomes non-deterministic.
 *
 * The output shape is a record when ANY input container is a record and an array
 * otherwise — an OR over the input set, so it is itself order-independent and the
 * batching law survives a mixed batch.
 */
export const appendById: Reducer<IdentifiedCollection> = defineReducer<IdentifiedCollection>({
  id: "appendById",
  identity: [],
  associative: true,
  batchingInvariant: true,
  orderInvariant: true,
  idempotent: true,
  merge(current, updates) {
    const containers: unknown[] = [current, ...updates];
    const merged = mergeEntries(containers);
    return containers.some(isPlainObject)
      ? recordFromEntries(merged)
      : arrayFromEntries(merged);
  },
});

// ── maxNumber ───────────────────────────────────────────────────────

export type CounterMap = Readonly<Record<string, number>>;

/**
 * Per-key maximum over a numeric record.
 *
 * `max` — not `+` — is what makes a loop bound survive replay: a superstep re-executed
 * after a crash re-writes `{ retries: 2 }`, and 2 joined with 2 is still 2, so a
 * bounded cycle can neither exhaust early nor run forever. Non-finite values are
 * dropped rather than propagated, since `NaN` would poison every later join.
 */
export const maxNumber: Reducer<CounterMap> = defineReducer<CounterMap>({
  id: "maxNumber",
  identity: {},
  associative: true,
  batchingInvariant: true,
  orderInvariant: true,
  idempotent: true,
  merge(current, updates) {
    const merged = new Map<string, number>();
    for (const container of [current, ...updates]) {
      if (!isPlainObject(container)) continue;
      for (const key of Object.keys(container)) {
        const raw = container[key];
        if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
        const seen = merged.get(key);
        merged.set(key, seen === undefined ? raw : Math.max(seen, raw));
      }
    }
    const out: Record<string, number> = {};
    for (const key of [...merged.keys()].sort()) out[key] = merged.get(key) as number;
    return out;
  },
});

// ── lastWriteWinsByKey ──────────────────────────────────────────────

export type KeyedRecord = Readonly<Record<string, unknown>>;

/**
 * Per-key replacement over DISJOINT key domains — the `branchStatus` shape, where a
 * branch only ever writes its own key.
 *
 * Disjointness across CONCURRENT writers is what makes this commutative within one
 * batch: two different branches never contend for the same key in the same call. It says
 * nothing about the SAME key written twice at different supersteps, which is exactly a
 * branch's own lifecycle (`running` -> `succeeded`/`failed`) — `current` (the previously
 * committed value) and a later write for the same branch collide on every settling
 * transition, and that collision is real, not merely a total-join completion of an
 * unreachable case (sc-4-3 fixed a real bug found there: canonical order sorted
 * `attempts: 10` lexically BEFORE `attempts: 9`). The tie-break below is now
 * {@link rankIsGreater} rather than {@link joinByCanonicalOrder}: `attempts` is the
 * ordering discriminator (`state/overall.ts:146-157`), and `versionRank`'s widened first
 * term (`reducers.ts` above) reads it directly, so the later attempt wins regardless of
 * digit count.
 */
export const lastWriteWinsByKey: Reducer<KeyedRecord> = defineReducer<KeyedRecord>({
  id: "lastWriteWinsByKey",
  identity: {},
  associative: true,
  batchingInvariant: true,
  orderInvariant: true,
  idempotent: true,
  merge(current, updates) {
    const merged = new Map<string, unknown>();
    for (const container of [current, ...updates]) {
      if (!isPlainObject(container)) continue;
      for (const key of Object.keys(container)) {
        const value = container[key];
        merged.set(key, merged.has(key) ? higherRanked(merged.get(key), value) : value);
      }
    }
    return recordFromEntries(merged);
  },
});

// ── setUnion ────────────────────────────────────────────────────────

/**
 * Sorted set union over string members — the `testAnchors` channel.
 *
 * Set semantics make this the trivial join: union is associative, commutative and
 * idempotent by definition, and sorting fixes one canonical representative per set.
 * Non-string members are dropped rather than stringified, so a malformed update cannot
 * quietly widen the anchor set.
 */
export const setUnion: Reducer<readonly string[]> = defineReducer<readonly string[]>({
  id: "setUnion",
  identity: [],
  associative: true,
  batchingInvariant: true,
  orderInvariant: true,
  idempotent: true,
  merge(current, updates) {
    const members = new Set<string>();
    for (const container of [current, ...updates]) {
      if (!Array.isArray(container)) continue;
      for (const value of container) {
        if (typeof value === "string") members.add(value);
      }
    }
    return [...members].sort();
  },
});

// ── replaceIfNewer ──────────────────────────────────────────────────

/**
 * A scalar channel value: `null` (bottom) or a value that may carry `version` and
 * `updatedAt`.
 */
export type VersionedValue = unknown;

/**
 * Total order on scalar values: `version` first, then `updatedAt`, then canonical form.
 *
 * `null` is bottom, so any real value replaces it and two nulls are equal.
 */
function versionRank(value: unknown): [number, string, string] {
  if (value === null || value === undefined) return [Number.NEGATIVE_INFINITY, "", ""];
  let version = 0;
  let updatedAt = "";
  if (isPlainObject(value)) {
    const rawVersion = value.version;
    if (typeof rawVersion === "number" && Number.isFinite(rawVersion)) {
      version = rawVersion;
    } else {
      // bober: widened first-rank term (sc-4-3) — a value with no `version` field at all
      // ranks on `attempts` instead, when it has one. This is the `branchStatus` shape
      // (`state/overall.ts:159-163`: `{ state, attempts, errorClass? }`), whose own doc
      // block calls `attempts` "the ordering discriminator, not decoration". Before this,
      // `lastWriteWinsByKey`'s fallback to `canonicalJson` sorted `attempts` as a STRING —
      // "10" lexically before "9" — so a branch's tenth attempt could lose a conflict to
      // its ninth. Ranking the number directly fixes that for every value shaped this way.
      // Safe elsewhere: no other value domain in the topology carries a numeric `attempts`
      // field (`LedgerEntry` uses `attempt`, singular; `SprintVerdict` uses `iteration`) —
      // verified by `reducers.test.ts`'s property suite, which now draws `attempts` for
      // `branchStatus` from a two-digit-capable pool specifically to exercise this.
      const rawAttempts = value.attempts;
      if (typeof rawAttempts === "number" && Number.isFinite(rawAttempts)) version = rawAttempts;
    }
    const rawUpdatedAt = value.updatedAt;
    if (typeof rawUpdatedAt === "string") updatedAt = rawUpdatedAt;
  }
  return [version, updatedAt, canonicalJson(value)];
}

function rankIsGreater(candidate: unknown, incumbent: unknown): boolean {
  const [av, au, aj] = versionRank(candidate);
  const [bv, bu, bj] = versionRank(incumbent);
  if (av !== bv) return av > bv;
  if (au !== bu) return au > bu;
  return aj > bj;
}

/**
 * The higher-ranked of two conflicting values, by {@link rankIsGreater}'s total order.
 *
 * Shared by `appendById` (`sprintContracts`, sc-4-1/sc-4-2) and `lastWriteWinsByKey`
 * (`branchStatus`, sc-4-3): both resolve a same-key conflict this way now, in place of
 * `joinByCanonicalOrder`. `mergeLedger` keeps `joinByCanonicalOrder` directly — see its
 * own section for why switching it would be no-op churn on a channel this sprint does not
 * touch.
 */
function higherRanked(incumbent: unknown, candidate: unknown): unknown {
  return rankIsGreater(candidate, incumbent) ? candidate : incumbent;
}

/**
 * Keep the highest-ranked value — the `spec` and `verdict` channels.
 *
 * This is a maximum over a total order, so it is a join even though the name reads
 * imperatively. It is intended for a SINGLE-WRITER channel: `MultipleWritersOnScalarChannel`
 * is the topology rule that stops a second writer from ever making the ordering
 * semantically load-bearing, and this reducer is what stays lawful if one slips through.
 *
 * NOTE on the declarative half. `KNOWN_REDUCERS` in `src/contracts/topology.ts` marks
 * `replaceIfNewer` as `orderInvariant: false`, which reads as a contradiction and is
 * not one: that flag answers the AUTHORING question "may this channel be written from
 * inside a fan-out region?", and for a scalar channel the answer is no whatever the
 * merge's algebra — which is exactly what `NonAssociativeReducerUnderFanOut` exists to
 * say. The flag here answers the ALGEBRAIC question. Same word, two questions;
 * `reducers.test.ts` pins the divergence so it is not "fixed" by accident.
 */
export const replaceIfNewer: Reducer<VersionedValue> = defineReducer<VersionedValue>({
  id: "replaceIfNewer",
  identity: null,
  associative: true,
  batchingInvariant: true,
  orderInvariant: true,
  idempotent: true,
  merge(current, updates) {
    let winner: unknown = current;
    for (const candidate of updates) {
      if (rankIsGreater(candidate, winner)) winner = candidate;
    }
    return winner === undefined ? null : winner;
  },
});

// ── mergeLedger ─────────────────────────────────────────────────────

/** Composite key of a charge: `(nodeId, attempt, callIndex)`. */
function ledgerKey(entry: unknown): string {
  if (!isPlainObject(entry)) return `${canonicalJson(entry)}`;
  const nodeId = typeof entry.nodeId === "string" ? entry.nodeId : "";
  const attempt = typeof entry.attempt === "number" && Number.isFinite(entry.attempt)
    ? entry.attempt
    : 0;
  const callIndex = typeof entry.callIndex === "number" && Number.isFinite(entry.callIndex)
    ? entry.callIndex
    : 0;
  return `${nodeId} ${attempt} ${callIndex}`;
}

/**
 * Replace-by-key over charged calls, emitted in key order.
 *
 * REPLACING rather than adding is the whole point: a resumed run re-charges calls it
 * already charged, and an additive ledger would bill them twice, so per-node sums would
 * stop equalling run totals exactly when the run crashed — the case the budget ceiling
 * matters most.
 */
export const mergeLedger: Reducer<readonly unknown[]> = defineReducer<readonly unknown[]>({
  id: "mergeLedger",
  identity: [],
  associative: true,
  batchingInvariant: true,
  orderInvariant: true,
  idempotent: true,
  merge(current, updates) {
    const merged = new Map<string, unknown>();
    for (const container of [current, ...updates]) {
      if (!Array.isArray(container)) continue;
      for (const entry of container) {
        const key = ledgerKey(entry);
        merged.set(key, merged.has(key) ? joinByCanonicalOrder(merged.get(key), entry) : entry);
      }
    }
    return [...merged.keys()].sort().map((key) => merged.get(key));
  },
});

// ── The closed table ────────────────────────────────────────────────

/** Every reducer id the executable registry resolves. Exactly six, deliberately. */
export const REDUCER_IDS = [
  "appendById",
  "maxNumber",
  "lastWriteWinsByKey",
  "setUnion",
  "replaceIfNewer",
  "mergeLedger",
] as const;
export type ReducerId = (typeof REDUCER_IDS)[number];

/**
 * The table itself.
 *
 * A `Map` rather than an object literal so a lookup of `"toString"`,
 * `"constructor"` or `"hasOwnProperty"` misses instead of resolving through
 * `Object.prototype` to a truthy value with `undefined` flags.
 */
const REDUCERS: ReadonlyMap<string, Reducer<unknown>> = new Map<string, Reducer<unknown>>([
  [appendById.id, appendById],
  [maxNumber.id, maxNumber],
  [lastWriteWinsByKey.id, lastWriteWinsByKey],
  [setUnion.id, setUnion],
  [replaceIfNewer.id, replaceIfNewer],
  [mergeLedger.id, mergeLedger],
]);

/**
 * The closed registry.
 *
 * There is no `register` method and no way to add a seventh: the set is fixed at
 * module load, and a channel naming anything else fails compilation with
 * `MissingReducer` rather than merging with a default.
 */
export function createReducerRegistry(): ReducerRegistry {
  return {
    get: (id) => REDUCERS.get(id),
    ids: () => [...REDUCERS.keys()].sort(),
  };
}

/** Every registered reducer, in registry-id order. Used by the property suite. */
export function allReducers(): Reducer<unknown>[] {
  return [...REDUCERS.keys()].sort().map((id) => REDUCERS.get(id) as Reducer<unknown>);
}

// ── Type-level negative fixtures (sc-5-6) ───────────────────────────

/**
 * These live in a NON-test module on purpose: `tsconfig.json` excludes `**\/*.test.ts`,
 * so a fixture written in the test file would never be seen by `npm run typecheck` and
 * the criterion would be unverifiable. They are pure type assertions plus one never-
 * invoked function, so they cost nothing at runtime.
 */
type IsAssignable<A, B> = [A] extends [B] ? true : false;

/** A reducer shape that is correct in every respect except one literal flag. */
interface NonAssociativeShape {
  readonly id: string;
  readonly identity: readonly string[];
  readonly associative: false;
  readonly batchingInvariant: true;
  readonly orderInvariant: true;
  readonly idempotent: true;
  merge(current: readonly string[], updates: readonly (readonly string[])[]): readonly string[];
}

/** Same, with a widened `boolean` flag — the shape an inferred literal decays to. */
interface WidenedFlagShape {
  readonly id: string;
  readonly identity: readonly string[];
  readonly associative: boolean;
  readonly batchingInvariant: boolean;
  readonly orderInvariant: boolean;
  readonly idempotent: boolean;
  merge(current: readonly string[], updates: readonly (readonly string[])[]): readonly string[];
}

/** A conforming reducer with exactly one flag weakened to the literal `false`. */
type FlagFalse<K extends "associative" | "batchingInvariant" | "orderInvariant" | "idempotent"> =
  Omit<Reducer<readonly string[]>, K> & Record<K, false>;

/**
 * If any assertion ever flipped to `true`, `= false` would stop being assignable and
 * `npm run typecheck` would fail — which is the criterion: a non-join-semilattice
 * reducer must be unregisterable at the TYPE level, not merely absent from the table.
 *
 * All FOUR flags are covered individually, because "three of the four are enforced" is
 * exactly the state in which a reducer that is associative, commutative and batching-
 * invariant but not idempotent slips into the table and double-counts on replay.
 */
export const _falseAssociativeIsUnassignable: IsAssignable<
  FlagFalse<"associative">,
  Reducer<readonly string[]>
> = false;

export const _falseBatchingInvariantIsUnassignable: IsAssignable<
  FlagFalse<"batchingInvariant">,
  Reducer<readonly string[]>
> = false;

export const _falseOrderInvariantIsUnassignable: IsAssignable<
  FlagFalse<"orderInvariant">,
  Reducer<readonly string[]>
> = false;

export const _falseIdempotentIsUnassignable: IsAssignable<
  FlagFalse<"idempotent">,
  Reducer<readonly string[]>
> = false;

export const _nonAssociativeIsUnassignable: IsAssignable<
  NonAssociativeShape,
  Reducer<readonly string[]>
> = false;

export const _widenedFlagIsUnassignable: IsAssignable<
  WidenedFlagShape,
  Reducer<readonly string[]>
> = false;

/** A conforming shape MUST still be assignable, or the guard is vacuous. */
export const _conformingIsAssignable: IsAssignable<
  typeof setUnion,
  Reducer<readonly string[]>
> = true;

/**
 * The same rejection at the call site. Never invoked; it exists so that if
 * {@link defineReducer} ever stopped rejecting a `false` flag, the now-unnecessary
 * `@ts-expect-error` would itself become a `tsc` error.
 */
export function _defineReducerRejectsNonLattice(): void {
  defineReducer<readonly string[]>({
    id: "notALattice",
    identity: [],
    // @ts-expect-error a reducer whose associative flag is not the literal true is unregisterable
    associative: false,
    batchingInvariant: true,
    orderInvariant: true,
    idempotent: true,
    merge: (current) => current,
  });
}
