# Sprint Briefing: The channel join becomes rank-aware, and pipelineResult converges

**Contract:** sprint-spec-20260812-terminal-vocabulary-4
**Generated:** 2026-08-12T20:45:00Z
**Baseline verified:** `npx vitest run src/orchestrator/workflow/conformance.engines.test.ts` — 5 tests green, 2.8s (run by the curator before writing this).

---

## 0. Executive findings — READ THIS FIRST

Six findings, each proved below with file:line evidence and, where marked **[measured]**, by
executing code in this checkout.

1. **Line number.** The join is at `src/pge/registry/reducers.ts:187`, not 189 or 187-in-a-
   different-file. `mergeEntries` spans `:183-191`. `versionRank` is `:348-359`,
   `rankIsGreater` is `:361-367`. **`mergeEntries` has exactly ONE caller: `appendById.merge`
   (`reducers.ts:230`).** `lastWriteWinsByKey` (`:299`) and `mergeLedger` (`:437`) each call
   `joinByCanonicalOrder` INLINE and do NOT route through `mergeEntries`.

2. **Blast radius is provably narrow. [measured]** For any value carrying neither a top-level
   `version` nor a top-level `updatedAt`, `rankIsGreater(item, incumbent)` reduces EXACTLY to
   `canonicalJson(item) > canonicalJson(incumbent)`, which is byte-for-byte what
   `joinByCanonicalOrder(incumbent, item)` already returns. Of the four `appendById` channels,
   only `sprintContracts` has values carrying either field. `messages`, `evaluations` and
   `refs` are provably unchanged (§7.1).

3. **sc-4-3 is NOT satisfied by the sc-4-1 change, and the contract/feature text asserting it
   is wrong. [measured]** `BranchStatus` is `{ state, attempts, errorClass? }`
   (`src/pge/state/overall.ts:159-163`) — no `version`, no `updatedAt`. So
   `rankIsGreater({attempts:10}, {attempts:9})` falls through to `canonicalJson` and returns
   `false`, exactly as today. Measured: `rankIsGreater(10, 9) = false`. **Switching
   `lastWriteWinsByKey` to `rankIsGreater` fixes nothing.** A real fix needs a decision — §7.2
   lays out the three options and the recommended one.

4. **Order-invariance IS preserved, and here is the proof. [measured]** A rank tie
   (`rankIsGreater` returns `false` in both directions) requires `aj === bj`, i.e. equal
   `canonicalJson` — which is EXACTLY the tie condition of the shipped `joinByCanonicalOrder`
   (`reducers.ts:127`: `if (a === b) return left`). Same tie set, same incumbent-wins rule,
   therefore the same order-invariance guarantee, no better and no worse (§2.2).

5. **sc-4-5's premise is FALSE: the `pipelineResult` divergence does not close at sprint 4.**
   `PipelineResult.completedSprints` carries whole `SprintContract` objects, and after this
   change the pge copy reads `status: "completed", version: 1` while the ts copy reads
   `status: "passed"` plus `evaluatorFeedback` and `generatorNotes`. Those are the *same four
   deltas* the `contracts` divergence is made of (`conformance.engines.test.ts:286-293`), and
   none of them is in `VOLATILE_KEYS` (`conformance.ts:65-76`). The pin must be edited to
   record what actually happened — pipelineResult's divergence REDUCES to the contracts
   divergence — not deleted (§7.4).

6. **Golden blast radius, predicted exactly.** 5 of the 6 `replay` cases move;
   `replay-plan-clarify-rounds-exhausted` does not (it has no `sprint.exit` pin). In each
   moved case, `expected.artifacts` changes in exactly TWO keys in TWO places (§7.5).

7. **Security directive: choose option (a).** Strip `version` in `materializeContracts`'
   embedded branch. Option (b) would put `isSettledContractStatus` inside a reducer module
   that today has **zero imports** and merges four unrelated value domains — a layering
   violation AND a live risk to sc-4-4 (§5.4).

---

## 1. Target Files

### `src/pge/registry/reducers.ts` (modify) — THE ONE-LINE CHANGE

**The join, lines 183-191:**
```ts
function mergeEntries(containers: readonly unknown[]): Map<string, unknown> {
  const merged = new Map<string, unknown>();
  for (const container of containers) {
    for (const [id, item] of collectionEntries(container)) {
      merged.set(id, merged.has(id) ? joinByCanonicalOrder(merged.get(id), item) : item);
    }
  }
  return merged;
}
```
Only `:187` changes. Note the shape: `merged.has(id) ? join(existing, item) : item` — on a
FIRST sighting the item is taken unconditionally; only a duplicate id reaches the join.

**The two functions to reuse verbatim, lines 348-367:**
```ts
function versionRank(value: unknown): [number, string, string] {
  if (value === null || value === undefined) return [Number.NEGATIVE_INFINITY, "", ""];
  let version = 0;
  let updatedAt = "";
  if (isPlainObject(value)) {
    const rawVersion = value.version;
    if (typeof rawVersion === "number" && Number.isFinite(rawVersion)) version = rawVersion;
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
```
Both are module-private and declared ABOVE their current only consumer `replaceIfNewer`
(`:385-399`) but BELOW `mergeEntries` (`:183`). Function declarations hoist, so calling
`rankIsGreater` from `:187` compiles with no reordering — do NOT move them (every doc in the
repo cites `reducers.ts:348-359`; see Pitfalls).

**The other two call sites of `joinByCanonicalOrder` — NOT reached by this change:**
```ts
// :299  lastWriteWinsByKey.merge — the branchStatus channel
merged.set(key, merged.has(key) ? joinByCanonicalOrder(merged.get(key), value) : value);
// :437  mergeLedger.merge — the ledger channel
merged.set(key, merged.has(key) ? joinByCanonicalOrder(merged.get(key), entry) : entry);
```

**Module-header prose that goes FALSE with this change** — `reducers.ts:40-49`, the "Conflict
resolution" block: *"Where two updates claim the same key with DIFFERENT content, the survivor
is the one whose `canonicalJson` sorts greater."* That is no longer true of `appendById`. It
must be rewritten in this sprint, and the rewrite is where the generatorNotes' instruction
lands: **say in the code why the `canonicalJson` fallback term is what preserves
order-invariance.**

**Imports:** the file has **ZERO import statements** (verified: `grep -n "^import"` returns
nothing). Keep it that way — see §5.4.

**Test file:** `src/pge/registry/reducers.test.ts` — exists, 572 lines.

---

### `src/pge/registry/reducers.test.ts` (modify)

**The generator that must grow (lines 119-129):**
```ts
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
```
It emits **no `version` and no `updatedAt`**, so the 200-case property suite currently exercises
only the canonical-order path for contracts. Adding both fields (drawn from small pools so ties
happen constantly — see the module note at `:22-25`) is how sc-4-4 gets property coverage rather
than three hand-picked cases.

**The per-reducer test that must KEEP passing unchanged (lines 430-437):**
```ts
it("resolves a same-id conflict deterministically, whichever way round it arrives", () => {
  const left = { id: "a", seq: 0, text: "aaa" };
  const right = { id: "a", seq: 0, text: "zzz" };
  const forward = appendById.merge([], [[left], [right]]);
  const backward = appendById.merge([], [[right], [left]]);
  expect(canonicalJson(forward)).toBe(canonicalJson(backward));
  expect(forward).toEqual([right]);
});
```
Neither value carries `version`/`updatedAt`, so the rank-aware join returns `right` too. **If
this test fails, the change is wrong.** [measured: rank-aware === shipped for all 6 permutations
of a 3-container message batch.]

`versionRank` and `rankIsGreater` are NOT exported. A unit test for sc-4-1/sc-4-2 must go
through `appendById.merge(...)`, or the sprint must export them (an API widening the contract
does not ask for — prefer testing through `appendById`).

---

### `src/orchestrator/workflow/conformance.engines.test.ts` (modify) — THE PIN

**The divergence-set pin, lines 305-311:**
```ts
    expect([...new Set(report.diffs.map((diff) => diff.field))].sort()).toEqual([
      "audits",
      "contracts",
      "history",
      "pipelineResult",
    ]);
    expect(report.equivalent).toBe(false);
```

**Its per-field record for pipelineResult, lines 294-300 (comment above the pin):**
```
//  - `pipelineResult`: does NOT merely follow from `contracts` — it is worse, and it is
//    the sprint-12 limitation `nodes/sprint-review.ts` documents. `commit.finalize` reads
//    `state.sprintContracts`, and `appendById` resolves a duplicate `contractId` by
//    CANONICAL ORDER, under which every settled status sorts before the seeded
//    `"proposed"` — so the channel keeps the PLANNED copy and a pge run reports a
//    contract still marked `"proposed"` inside `completedSprints`. Closing it needs a
//    monotone discriminator on `SprintContract`, i.e. a shipped-schema revision.
```

**The behavioural assertion, lines 414-424:**
```ts
    // ── 4. pipelineResult: the graph reports a contract still marked "proposed" ──
    ...
    expect(tsResult?.completedSprints.map((c) => c.status)).toEqual(["passed"]);
    expect(pgeResult?.completedSprints.map((c) => c.status)).toEqual(["proposed"]);
    expect(pgeResult?.failedSprints).toEqual([]);
```
`:423` becomes `["completed"]`. See §7.4 for what the pin at `:305` should look like afterwards.

---

### `docs/pge-graph.md` (modify)

Three sites, all in "Engine migration disposition" (`## Engine migration disposition` at `:1162`):
- `:1174-1177` — "exactly **four** pinned divergent fields".
- `:1226-1240` — the bullet ending *"Nothing consults it yet — `mergeEntries`
  (`src/pge/registry/reducers.ts:183`) still resolves a duplicate id by canonical order, so the
  seeded copy still wins and the assertion above still passes."* This sentence becomes false.
- `:1206` and `:1233` are the only two `reducers.ts:NNN` citations in the whole document
  (verified by grep) — check both if any line moves in `reducers.ts`.

The recapture-discipline precedent to imitate is at `:664-676` (worked example: *"52 insertions,
zero deletions, every added key inside a new `errors` array... no other field moved, and the
replay count still exactly `GOLDEN_MIN_REPLAY_CASES`"*). Sprint doc goes at
`docs/sprints/sprint-spec-20260812-terminal-vocabulary-4.md` (siblings `-1.md`…`-3.md` exist).

---

### `.bober/golden/` (re-capture) — see §7.5 for the exact prediction

Command: `GOLDEN_CAPTURE=1 npx vitest run src/pge/golden/capture.test.ts`. Gate:
`node scripts/run-golden-regression.mjs`. Floor: `GOLDEN_MIN_REPLAY_CASES = 5`
(`src/pge/golden/case-schema.ts:127`), asserted at `src/pge/golden/dataset.test.ts:143` and
`src/pge/golden/coverage.test.ts:237`.

---

### `src/pge/nodes/sprint-evaluate.test.ts` (modify — NOT in estimatedFiles, but it WILL fail)

`:775-789` asserts the channel keeps `"proposed"`:
```ts
    // KNOWN LIMITATION, asserted so it cannot change unnoticed rather than hidden: the
    // `sprintContracts` channel still carries `proposed`. ...
    expect(
      run.finalState.sprintContracts.find((entry) => entry.contractId === contract.contractId)
        ?.status,
    ).toBe("proposed");
```
This is the pin sprint 3 left as the marker for this sprint. Flip it to `"completed"` and rewrite
the comment — deliberately, in this commit.

---

### `src/pge/nodes/sprint-review.ts` (modify — prose only)

`:33-51` is the "KNOWN LIMITATION: the `sprintContracts` channel still keeps the seeded copy"
header. It literally says *"Switching the join to read `version` is a separate change"* — this
sprint IS that change. Rewrite it. Same for `src/pge/runtime/commit.ts:503-521`.

---

## 2. Patterns to Follow

### 2.1 The reducer contract — every reducer is a TOTAL join, encoding no policy
**Source:** `src/pge/registry/reducers.ts:40-49`
```
 * Where two updates claim the same key with DIFFERENT content, the survivor is the one
 * whose {@link canonicalJson} sorts greater. A join needs a deterministic winner or it
 * is not commutative; "whichever arrived last" is precisely the non-commutative answer.
 * In the shipped topology this tie-break is unreachable — `appendById` keys are
 * content-derived, `lastWriteWinsByKey` keys are per-branch disjoint, `mergeLedger`
 * keys identify one call, and scalar channels are single-writer by
 * `MultipleWritersOnScalarChannel` — so it exists to make each reducer a TOTAL join
 * rather than to encode a policy.
```
**Rule:** a reducer may not know what domain its values come from; it may only compare them by a
total order. This is the sentence that decides the security directive in §5.4.

### 2.2 THE ORDER-INVARIANCE PROOF (sc-4-4) — write this reasoning into the code
**Source:** `src/pge/registry/reducers.ts:124-129`
```ts
/** Deterministic winner between two conflicting values. */
function joinByCanonicalOrder(left: unknown, right: unknown): unknown {
  const a = canonicalJson(left);
  const b = canonicalJson(right);
  if (a === b) return left;
  return a > b ? left : right;
}
```
Why today's join is order-invariant: it is a MAXIMUM over the total order `canonicalJson`, and
maximum over a total order is associative, commutative and idempotent. When the two canonical
forms are EQUAL it returns `left` (the incumbent) — arrival-order-dependent as an object
reference, but canonically identical, and the whole property suite compares canonical forms
(`reducers.test.ts:29-31`, `:291-293`).

Why `rankIsGreater` preserves it, exactly:
- `rankIsGreater` compares the triple `(version, updatedAt, canonicalJson)` lexicographically.
- Two values with equal `canonicalJson` necessarily have equal `version` and `updatedAt`
  (both are read off the same value by `versionRank`), so the triple order's equivalence classes
  are EXACTLY the `canonicalJson` equality classes.
- Therefore `rankIsGreater(a,b) === false && rankIsGreater(b,a) === false` ⟺
  `canonicalJson(a) === canonicalJson(b)` — the identical tie condition as `:127`.
- On that tie `mergeEntries` keeps the incumbent (`merged.has(id) ? … : item` with a false
  predicate). The incumbent depends on arrival order, but the two candidates are canonically
  identical, so the merged result is canonically identical either way. **The tie case cannot
  produce a different result.**
- Off the tie, the relation is a strict total order, so `max` is order-invariant by the same
  argument as today.

**[measured]** 120 permutations of five containers holding `version` values `{1, 1, absent, 2, 2}`
with differing text, merged through a faithful re-implementation of the proposed
`mergeEntries` + `rankIsGreater`: **1 distinct canonical result**. And the pure-tie case
(identical `version` AND identical `updatedAt`, different text) also yields 1 result — the
`canonicalJson` term deciding, which is the fallback the generatorNotes want explained in a
comment.

**The one thing that would break it:** any resolution rule that is not a total order — e.g.
"only a settled contract may win on version" (security-directive option b), or "prefer the
later arrival on a tie". Both make the winner arrival-dependent. That is the stop condition.

### 2.3 The two-directional pin discipline
**Source:** `src/orchestrator/workflow/conformance.engines.test.ts:249-258`
```
    // Pinned EXACTLY: not asserted to be empty, and not asserted merely to be non-empty. The
    // sprint contract's fourth stop condition pre-authorises this outcome ... and a pinned set
    // is what "recorded" means operationally: a NEW divergence fails this test, and a divergence
    // that gets FIXED fails it too, so neither can happen silently.
```
**Rule:** the pin is `toEqual` over a sorted set, never `toContain` and never a length check. Keep
that shape (nonGoal 2). The same discipline restated for coverage at `docs/pge-graph.md:580-585`.

### 2.4 Documented-limitation comment style
**Source:** `src/pge/nodes/sprint-review.ts:42-51` — a limitation is stated in the node header AND
pinned by an assertion, with the two cross-referencing each other by file:line. When the
limitation is lifted, BOTH move in the same commit.

### 2.5 Section headers and ESM
`// ── Section Name ─────` box-drawing headers (`reducers.ts:52`, `:91`, `:131`). All imports carry
`.js` extensions (`reducers.test.ts:3-16`). `import type` for types (ESLint
`consistent-type-imports`, per `.bober/principles.md`).

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `rankIsGreater` | `src/pge/registry/reducers.ts:361` | `(candidate: unknown, incumbent: unknown) => boolean` | Strict total order: version → updatedAt → canonicalJson. **Module-private.** Reuse as-is. |
| `versionRank` | `src/pge/registry/reducers.ts:348` | `(value: unknown) => [number, string, string]` | The rank triple; `null`/`undefined` ⇒ `-Infinity`; missing/non-finite version ⇒ `0`. **Module-private.** |
| `joinByCanonicalOrder` | `src/pge/registry/reducers.ts:124` | `(left: unknown, right: unknown) => unknown` | Today's resolver. Still used by `lastWriteWinsByKey:299` and `mergeLedger:437` — do not delete it. |
| `canonicalJson` | `src/pge/registry/reducers.ts:119` | `(value: unknown) => string` | Exported. The canonical form every comparison in the suite uses. |
| `intrinsicId` | `src/pge/registry/reducers.ts:153` | `(item: unknown) => string` | Union key: first non-empty `id`/`contractId`/`key`/`uri`, else canonical form. |
| `isSettledContractStatus` | `src/contracts/sprint-contract.ts` (sprint 1) | `(status) => boolean` | `passed \| completed`. Available — but see §5.4 for why it must NOT enter `reducers.ts`. |
| `normalize` | `src/orchestrator/workflow/conformance.ts:85` | `(value: unknown) => unknown` | Strips `VOLATILE_KEYS`, sorts keys. Used by BOTH the conformance harness and the golden collector. |
| `collectRunArtifacts` | `src/orchestrator/workflow/conformance.ts` (`collectFields` at `:435`) | `(projectRoot, pipelineResult?) => Promise<Record<ConformanceField, unknown[]>>` | Reads the 11 fields off disk + the return value, redacts roots, normalizes. This is why golden `expected.artifacts` carry no `updatedAt`. |
| `compareGoldenArtifacts` | `src/pge/golden/runner.ts:141` | `(expected, actual) => string[]` | Multiset comparison per field over the UNION of fields. |
| `listContracts` | `src/state/sprint-state.ts` | `(projectRoot) => Promise<SprintContract[]>` | The `contracts` field's reader — final file state, one element per file. |

Directories reviewed for the inventory: `src/pge/registry/`, `src/pge/runtime/`,
`src/orchestrator/workflow/`, `src/pge/golden/`, `src/utils/`, `src/state/`. No new helper is
needed for this sprint; the ranking logic already ships (sc-4-1 says so explicitly).

---

## 4. Prior Sprint Output

### Sprint 3: A monotone version, replay-stable
**Modified:** `src/contracts/sprint-contract.ts` — added `version: z.number().int().min(0).optional()`
at `:213`, with a 17-line doc block at `:196-212` stating it is *"DELIBERATELY `.optional()`, never
`.default(...)`"* because a default would materialise `version` on the seeded copy at every
`OverallStateSchema.parse` and destroy the ordering.
**Modified:** `src/pge/nodes/sprint-review.ts:197-213` — `sprintExitNode` computes
`attempts = Math.max(1, state.evaluations.filter(contractId match && verdict !== "skipped").length)`
and writes `{...contract, status, updatedAt: ctx.clock.nowIso(), version: attempts}`.
**Connection:** the settled copy ranks `attempts >= 1`; the seeded copy has no `version` at all and
ranks `0`. This sprint is the consumer of that field — the ONLY thing missing is `:187`.
**Also:** re-captured 5 golden replay cases (commit `83ceed1`) where every hunk added exactly one
`"version": N` line inside `pinnedResponses[].request.contract`, and `expected.artifacts` was
untouched. Commit message: *"expected.artifacts is untouched, confirming the settled contract
still never reaches disk in a replay"*. **This sprint is what makes it reach disk.**

### Sprint 1: One settled-status predicate
`isSettledContractStatus` / `isTerminalContractStatus` in `src/contracts/sprint-contract.ts`, plus
the line-number-pinned allowlist in `src/contracts/status-vocabulary.invariant.test.ts` — see §7.3,
it is a live tripwire for this sprint.

---

## 5. Relevant Documentation

### 5.1 Project principles (`.bober/principles.md`, delivered in the handoff)
ESM with `.js` extensions; `import type`; Zod for validation; small focused utils; section
comments; conventional commit `bober(sprint-4): …`; zero type errors and zero lint errors are hard
gates; tests collocated as `*.test.ts`.

### 5.2 Spec-level decisions (`.bober/specs/spec-20260812-terminal-vocabulary.json`)
- **D2:** *"versionRank (reducers.ts:348-359) already reads a `version` number, so no reducer logic
  is invented."*
- **D4 (matters for the golden prediction):** *"updatedAt cannot serve as the discriminator even
  though versionRank already reads it: the replay harness runs on a fixed clock, so the seeded and
  settled copies stamp identically and the comparison falls through to the canonical-order
  tiebreak."* Confirmed: `whole-graph.ts:150` `FIXED_ISO = "2026-08-05T00:00:00.000Z"`,
  `goldenContracts()` stamps it at `:143-148`, and `capture.test.ts:55`
  `CAPTURE_INSTANT = new Date("2026-08-05T00:00:00.000Z")`. `version` is the only discriminator.

### 5.3 Architecture (`docs/pge-graph.md`)
ADR-4 (closed reducer registry, six entries, no seventh) is stated in `reducers.ts:1-50`. The
engine-migration disposition is at `:1162+`; its decision block (`### The decision`, `:1246+`)
must NOT be flipped by this sprint — `oracle-retention.test.ts` still asserts the default is `"ts"`.

### 5.4 THE SECURITY DIRECTIVE — assessment and recommendation

**The finding, verified.** `materializeContracts`' embedded branch
(`src/orchestrator/contract-materialization.ts:45-66`) does exactly four normalizations on a
producer-supplied contract:
```ts
      const contract = parsed.data;
      contract.status = "proposed";
      contract.specId = spec.specId;
      contract.sprintNumber = i + 1;
      // bober: width-2 pad covers 1–99; widen to 3 if suite grows past 99.
      contract.contractId = `sprint-${spec.specId}-${String(i + 1).padStart(2, "0")}`;
      embedded.push(contract);
```
`version` is not among them, and `SprintContractSchema` bounds it only by `.int().min(0)`
(`sprint-contract.ts:213`) — no upper bound. `plan_materialize` writes the effect's return value
straight into the channel with no normalization (`src/pge/nodes/plan.ts:404-431`). So an embedded
`version: 999999` would permanently outrank every settled copy (`attempts` is bounded by
`sprintIterations.maxIterations = 3`, `coding.graph.ts:695`) — inverting exactly the ordering this
sprint exists to create.

**Option (a) — strip/reset `version` on the embedded branch.**
- Sits in the block that already normalizes four producer-supplied fields; one more line, same
  pattern, same place a reviewer already looks.
- Keeps the reducer a pure total join (§2.1) and keeps `reducers.ts` import-free.
- Cannot affect order-invariance, because it changes an INPUT, not the order.
- Cost: it technically touches a writer, which nonGoal 1 defers to sprint 5. The directive is
  BINDING and names this option first; nonGoal 1's evident target is the status *word*
  (`runSprintCycle` writing `"passed"`), not a security normalization. **Record that reading in
  the commit message and in the sprint doc** so the evaluator does not read it as scope creep.
- Pin: a test in `src/orchestrator/contract-materialization.test.ts` (the existing embedded-branch
  tests are at `:177` and `:242`) asserting an embedded contract carrying `version: 9999` is
  materialized with `version` ABSENT — failing if the guard is removed.

**Option (b) — make the join settled-status-aware.** REJECT. Three independent reasons:
1. **Layering.** `appendById` merges four unrelated value domains: `GraphMessage`,
   `SprintVerdict`, `ScratchRef` and `SprintContract` (`coding.graph.ts:143-196`). Putting
   `isSettledContractStatus` inside `mergeEntries` applies a contract vocabulary to every one of
   them, and would fire on any future value that happens to carry a `status` key. It directly
   contradicts `reducers.ts:48-49` ("rather than to encode a policy").
2. **Module purity.** `src/pge/registry/reducers.ts` has **zero imports** today. Option (b) makes
   the closed reducer registry depend on `src/contracts/sprint-contract.ts`.
3. **It endangers sc-4-4.** "Only a settled value may win on version" is not a total order:
   with A(settled, v=1), B(unsettled, v=9), C(settled, v=2) the winner becomes arrival-dependent
   unless the guard is folded into the rank triple itself — which is new ranking logic, which
   sc-4-1 forbids. This is precisely the stop condition ("Order-invariance cannot be preserved").

**Recommendation: option (a). Do not litigate it mid-implementation.**

**Secondary note (record, do not build):** the directive's warning that on-disk `version` can go
`2 → absent → 1` across a re-run is real — the feature-derived branch
(`contract-materialization.ts:81-134`) builds contracts through `createContract` and never sets
`version`. Within one run the rank is derived from within-run state (`state.evaluations.length`),
which is the safe form; note it in the doc.

---

## 6. Testing Patterns

**Runner:** vitest 3.2.6. **Assertions:** `expect`. **Location:** collocated `*.test.ts`.
**Commands:** `npx vitest run <path>` for one file; `npm run typecheck`, `npm run typecheck:tests`,
`npm run lint`, `npm run build`.

### 6.1 Seeded property test (the template for sc-4-4)
**Source:** `src/pge/registry/reducers.test.ts:37-41`, `:301-318`
```ts
/** Recorded seed. Change it deliberately, never to make a failure disappear. */
const SEED = 20_260_805;
/** Randomized triples per law, per case. The contract's floor is 200. */
const CASE_COUNT = 200;
...
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
```
sc-4-4 asks for *"several different arrival orders"* — the strongest available form is ALL
permutations of a small fixed container set (deterministic, no seed, and it covers the tie case
by construction). The seeded shuffle suite above then gives volume for free once
`sprintContractsValue` emits `version`/`updatedAt`.

### 6.2 Both-directions assertion (the template for sc-4-2 and sc-4-3)
**Source:** `src/pge/nodes/sprint-evaluate.test.ts:820-847` — note the CONTROL test, which is the
part that makes the claim non-vacuous:
```ts
    const seeded = sprintContractFixture({ status: "proposed", updatedAt });
    // The seeded copy carries no `version` key at all — exactly what `plan_materialize`
    // produces (sc-3-1's absence guarantee), not `version: 0`.
    expect("version" in seeded).toBe(false);
    const settled = { ...seeded, status: "completed" as const, updatedAt, version: 1 };
    expect(replaceIfNewer.merge(seeded, [settled])).toEqual(settled);
    expect(replaceIfNewer.merge(settled, [seeded])).toEqual(settled);
```
plus `:837-847`, *"control: with version absent from BOTH copies and updatedAt held equal too, the
seeded copy wins instead — proving the test above is version deciding, not an accident of
canonicalJson"*. **Write the sc-4-2 test as this exact pair, but through `appendById.merge`.**

### 6.3 Region-run integration test
`src/pge/nodes/sprint-evaluate.test.ts:733-790` uses `runSprint({ projectRoot, bindings, contracts })`
and asserts on `run.finalState.sprintContracts`, `run.finalState.branchStatus`, `run.artifactLog`.
Harness: `src/pge/nodes/__fixtures__/sprint-harness.ts`.

### 6.4 Golden re-capture
`GOLDEN_CAPTURE=1 npx vitest run src/pge/golden/capture.test.ts` rewrites; without the env var the
same file RE-CAPTURES and byte-compares (`capture.test.ts:16-43`). Then
`node scripts/run-golden-regression.mjs`.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### 7.1 EVERY channel that flows through `mergeEntries` — the blast radius

`mergeEntries` has exactly one caller: `appendById.merge` (`reducers.ts:230`). Four channels bind
`appendById` in `src/pge/topology/coding.graph.ts`:

| Channel | Decl | Value schema | Carries `version`? | `updatedAt`? | Duplicate ids happen? | Verdict |
|---|---|---|---|---|---|---|
| `messages` | `:143-149` | `GraphMessageSchema` `overall.ts:99-107` (`id, seq, role, nodeId, text?, textRef?, tokens`) | no | no | yes — `note()` keys on `nodeId:branchKey:superstep` (`sprint-review.ts:61-70`), so a re-executed superstep re-delivers the same id | **UNCHANGED.** Rank collapses to canonicalJson. [measured] |
| `evaluations` | `:150-156` | `SprintVerdictSchema` `overall.ts:123-133` (`id, seq, contractId, sprintNumber, iteration, verdict, summary, evalId`) | no | no | yes, on replay/retry | **UNCHANGED.** |
| `refs` | `:157-163` | record keyed by ref name; values `ScratchRefSchema` `overall.ts` (`uri, sha256, bytes, kind`) | no | no | yes — `PLAN_SPEC_REF_KEY` and the curator's keys are rewritten per round | **UNCHANGED.** |
| `sprintContracts` | `:185-196` | `SprintContractSchema` | **YES** (`sprint-contract.ts:213`) | **YES** (`:217`) | **yes, by design** — seeded copy from `plan_materialize` (`plan.ts:404-431`) vs settled copy from `sprint_exit` (`sprint-review.ts:203-229`) | **THIS IS THE TARGET.** |

Formal argument for the three "UNCHANGED" rows: for a value with neither field,
`versionRank` returns `[0, "", canonicalJson(v)]`, so `rankIsGreater(item, incumbent)` ≡
`canonicalJson(item) > canonicalJson(incumbent)`; and `joinByCanonicalOrder(incumbent, item)`
returns `incumbent` when `a === b` or `a > b`, else `item` — the same function. **[measured]**
byte-identical for all 6 permutations of a colliding 3-container message batch. **Nothing but
`sprintContracts` can move, and no unplanned divergence can come from this line.**

Channels NOT bound to `appendById` and therefore not reached by the `:187` edit:
`counters`/`maxNumber` (`:164-170`), `branchStatus`/`lastWriteWinsByKey` (`:171-177`),
`testAnchors`/`setUnion` (`:178-184`), `spec`, `specDraft`, `verdict`/`replaceIfNewer`
(`:197-240`, `:248-256`), `ledger`/`mergeLedger` (`:241-247`).

**Downstream readers of `sprintContracts` whose behaviour changes because the SETTLED copy now
wins** (this is the real, intended blast radius — check each):
- `src/pge/runtime/commit.ts:531-533` — `passed(c) = c.status === "passed" || succeededBranches.has(...)`.
  Unchanged in outcome (`"completed"` is not `"passed"`; classification still comes from
  `branchStatus`), but the OBJECTS returned in `completedSprints`/`failedSprints` are now the
  settled ones. This is sc-4-2 end-to-end.
- `src/pge/runtime/commit.ts:450-462` — the commit boundary persists every
  `state.sprintContracts` entry through `persistIfChanged` (`:336-347`, memoised on canonical
  bytes). Today the settled copy never differs from what was already persisted, so 0 writes; after
  the change the file is rewritten once with the settled copy. **This is why the golden `contracts`
  artifact moves.**
- `src/pge/nodes/sprint-curate.ts:253-255` — `completedSprints: state.sprintContracts.filter(entry => entry.status === "completed" && entry.contractId !== contract.contractId)`.
  Today always `[]` for a pge run. In a MULTI-contract run it now carries genuinely completed
  siblings — a real improvement, and a change in the `curator.brief` effect REQUEST.
- `src/pge/nodes/sprint-generate.ts:132-134` — same filter for `sprintHistory`.
  Both are harmless for the golden cases (single contract, and the filter excludes self), but say
  so in the sprint doc rather than letting a reviewer find it.
- `src/pge/nodes/documenter.ts:82-84` — `status?.state === "succeeded" || contract.status === "completed"`.
  Already true via `branchStatus`; no outcome change.
- `src/pge/runtime/interpreter.ts:728` (`verdictFrom`) counts `status === "passed"`. Still 0 for a
  pge run (`"completed"` ≠ `"passed"`). **Unchanged — do not "fix" it here**, it is allowlisted
  with a reason at `status-vocabulary.invariant.test.ts:199-203`.

### 7.2 sc-4-3 — the latent `lastWriteWinsByKey` defect, located and confirmed

**The site (`src/pge/registry/reducers.ts:293-303`):**
```ts
  merge(current, updates) {
    const merged = new Map<string, unknown>();
    for (const container of [current, ...updates]) {
      if (!isPlainObject(container)) continue;
      for (const key of Object.keys(container)) {
        const value = container[key];
        merged.set(key, merged.has(key) ? joinByCanonicalOrder(merged.get(key), value) : value);
      }
    }
    return recordFromEntries(merged);
  },
```
It backs exactly ONE channel: `branchStatus` (`coding.graph.ts:171-177`), whose value schema is
`BranchStatusSchema` = `{ state, attempts, errorClass? }` (`overall.ts:159-163`).

**The claim, traced.** `canonicalValue` sorts keys, so `attempts` is compared FIRST inside the
JSON string. `canonicalJson({state:"running",attempts:10})` = `{"attempts":10,"state":"running"}`
and for 9 it is `{"attempts":9,"state":"running"}`. String comparison hits `'1'` (U+0031) vs
`'9'` (U+0039) at index 13, so the 10-string is LESS. **[measured]**
`lastWriteWinsByKey.merge({}, [{k:{attempts:10}}, {k:{attempts:9}}])` returns `attempts: 9`, and so
does the reverse order. The defect is exactly as the contract states.

Why it matters at all: `overall.ts:146-157` documents `attempts` as *"the ordering
discriminator, not decoration"* — a branch's `running → succeeded` transition is only expressible
because the later record is the canonical-order maximum. The defect is latent only because
`sprintIterations.maxIterations = 3` (`coding.graph.ts:695`) keeps `attempts` in single digits.

**Does the sc-4-1 change fix it? NO — measured.** `lastWriteWinsByKey` does not call
`mergeEntries`; and even if `:299` were switched to `rankIsGreater`, `BranchStatus` carries neither
`version` nor `updatedAt`, so the triple collapses to `canonicalJson` and
`rankIsGreater({attempts:10,…}, {attempts:9,…})` returns **false**. It needs its own touch.

**The three options, with the trade-off stated so it is not discovered mid-implementation:**
- **(i) Give `BranchStatus` a `version` and have `branchRecord` write it.** Touches
  `overall.ts` (schema), `gates.ts:696-700` (`branchRecord`) and every writer
  (`gates.ts:686/770/789`, `sprint-review.ts:224-228`) — a writer change nonGoal 1 defers, and a
  duplicated field that means the same thing as `attempts`.
- **(ii) Widen `versionRank` to fall back to a numeric `attempts`.** One line, fixes the channel
  with no writer change and no schema change — but it IS "new ranking logic", which sc-4-1
  forbids in so many words, and it re-imports a domain concept into a generic rank function
  (the same objection as §5.4 option b). It is also SAFE for order-invariance (the triple stays a
  total order) and touches nothing else: no other channel value has an `attempts` key
  (`LedgerEntry` uses `attempt`, `SprintVerdict` uses `iteration`).
- **(iii) Compare the numeric fields numerically inside `lastWriteWinsByKey` only.** New logic in
  a second place; worst of both.
**Recommendation: (ii), scoped and documented as a widening of `versionRank`'s FIRST term rather
than a new order — and if the evaluator reads sc-4-1 strictly, (i) is the fallback. Whichever is
chosen, pin it with `attempts: 10` beating `attempts: 9` in BOTH arrival orders, and state the
choice in the sprint doc. Do not silently leave sc-4-3 unimplemented on the theory that the
one-line change covered it — it does not. [measured]**

### 7.3 Existing tests that must still pass (and the ones that must be edited)

MUST BE EDITED DELIBERATELY (they pin the old behaviour):
- `src/pge/nodes/sprint-evaluate.test.ts:775-789` — `.toBe("proposed")` → `"completed"`.
- `src/orchestrator/workflow/conformance.engines.test.ts:423` — `["proposed"]` → `["completed"]`.
- `src/orchestrator/workflow/conformance.engines.test.ts:294-300` + `:305-310` — the record and
  the pin (§7.4).
- `.bober/golden/replay-*.json` × 5 (§7.5).

MUST STILL PASS UNCHANGED — run these explicitly:
- `src/pge/registry/reducers.test.ts` — all 8 property cases × 4 laws, plus `:430-437`
  (same-id conflict), `:466-485` (lastWriteWinsByKey), `:497-518` (replaceIfNewer). **[measured
  safe for the appendById half.]**
- `src/pge/runtime/commit.test.ts:555`, `:576` — `completedSprints` by contractId.
- `src/pge/engine/pge-engine.test.ts:296`, `:417`, `:476`.
- `src/pge/nodes/commit.test.ts:353` — a contract that never settled stays `proposed`
  (no `branchStatus`, no `sprint_exit` write ⇒ no duplicate ⇒ no join).
- `src/pge/runtime/__fixtures__/golden-graph.ts:46-53` — the fixture whose contracts go
  `in-progress → passed` *because* canonical order allows it. Neither copy carries `version`, so
  the rank-aware join still picks `"passed"`. Unchanged — but read the comment before touching it.
- `src/pge/golden/coverage.test.ts` — node coverage (38/44) is unaffected; the change moves no
  routing decision (`dispatchableContracts` filters on `branchStatus` only,
  `sprint-fanout.ts:52-64`; `sprintEntryGate` reads contractId + dependsOn only,
  `gates.ts:442-473`).
- **`src/contracts/status-vocabulary.invariant.test.ts` — THE NON-OBVIOUS TRIPWIRE.** Its
  ALLOWLIST is pinned by FILE:LINE (`:138-222`) and the test *"every ALLOWLIST entry corresponds
  to a REAL, currently-matching offender"* (`:253-264`) fails if a line moves. Entries at risk
  from this sprint's edits: `src/pge/runtime/commit.ts:531` (you will rewrite the comment block at
  `:503-521` right above it), `src/pge/nodes/documenter.ts:83`, `src/pge/nodes/sprint-curate.ts:254`,
  `src/pge/nodes/sprint-generate.ts:133`, `src/pge/runtime/interpreter.ts:728`. **Any comment edit
  that changes a line count above one of those lines requires updating the allowlist number in the
  same commit.**

### 7.4 sc-4-5 — the conformance pin, and what "edited deliberately" means here

**The prediction, from evidence:** after this change the harness will still report
`pipelineResult` as divergent. `PipelineResult.completedSprints` holds full `SprintContract`
objects; the ts copy has `status: "passed"`, `evaluatorFeedback` and `generatorNotes` (pinned at
`conformance.engines.test.ts:400-405`); the pge copy will have `status: "completed"` and
`version: 1` and neither of the other two (the settled copy is `{...seededContract, status,
updatedAt, version}` — `sprint-review.ts:203-213` — and the seeded copy has neither field). None of
`status`, `version`, `evaluatorFeedback`, `generatorNotes` is in `VOLATILE_KEYS`
(`conformance.ts:65-76`). **So the divergence SET stays `["audits","contracts","history",
"pipelineResult"]`; what changes is WHAT the pipelineResult divergence IS.**

**MEASURE IT, do not assume it** — the evaluatorNotes demand exactly this: run
`npx vitest run src/orchestrator/workflow/conformance.engines.test.ts` (2.8s in this checkout) and
read `report.diffs` for the pipelineResult entry.

**What the pin should look like afterwards, in either outcome:**
- If pipelineResult still diverges (predicted): the `toEqual([...4 fields])` array is UNCHANGED,
  and the per-field record at `:294-300` is REWRITTEN to say what closed and what did not — e.g.
  *"no longer the seeded-copy defect: the rank-aware join (`reducers.ts:187`, sprint 4) means the
  channel now keeps the settled copy, and `pipelineResult`'s remaining delta is EXACTLY the
  `contracts` delta above, because `completedSprints` carries the contract objects. It closes when
  `contracts` closes."* Plus `:423` → `["completed"]`. The pin still fails in both directions: a
  fifth field fails it, and a fourth field closing fails it.
- If it closes: drop `"pipelineResult"` from the array — but ALSO add a positive assertion that
  the two engines' `completedSprints[0]` agree, so the field's absence is evidence rather than
  silence (the `:427-443` block "is EQUIVALENT on every field outside the recorded divergence set"
  is where that goes: add `pipelineResult` to its `for (const field of [...])` list).
- Either way, **do not** weaken `toEqual` to `toContain`, do not assert `.length`, and do not
  delete the paragraph — nonGoal 2.

**"In ONE commit with the docs/pge-graph.md disposition" means, concretely:** the edits to
`conformance.engines.test.ts:294-310` + `:423`, the edits to `docs/pge-graph.md:1174-1177` and
`:1226-1240`, and `docs/sprints/sprint-spec-20260812-terminal-vocabulary-4.md` land in a SINGLE
commit whose message states the divergence-set delta explicitly. Never as a side effect of the
recapture commit. Precedent: commit `83ceed1` (sprint 3) did exactly this, and its message spells
out the field-delta count change three → four.

### 7.5 sc-4-6 — golden blast radius, PREDICTED

**Mechanism.** A replay answers every outward call from the recording and never performs an effect
(`capture.ts:30-41`), so `sprint.exit`'s `saveContract` never runs in a replay: the ONLY writer of
`.bober/contracts/` in a replay is the commit boundary, from the channel
(`commit.ts:450-462`). Today the channel holds the seeded copy, so the file stays `"proposed"` —
which is why every replay case records `contracts: [{status: "proposed"}]` even though the
`sprint.exit` PIN carries `{status: "completed", version: 1}`. After this sprint, the channel holds
the settled copy, so `persistIfChanged` sees new bytes and rewrites the file.

**`expected.artifacts` values are already volatile-stripped** (`collectRunArtifacts` →
`normalize`, `conformance.ts:435-450`; verified — the committed contracts carry no
`createdAt`/`updatedAt`). So `updatedAt` will NOT appear in the diff.

**Prediction — exactly two keys, in exactly two places, per case:**

| Case | `expected.artifacts.contracts[0]` | `expected.artifacts.pipelineResult[0]` |
|---|---|---|
| `replay-full-run-evaluation-passes` | `status: proposed → completed`, `+ version: 1` | `completedSprints[0]`: same two |
| `replay-plan-clarification-round` | `status: proposed → completed`, `+ version: 1` | `completedSprints[0]`: same two |
| `replay-research-reflexions-exhausted` | `status: proposed → completed`, `+ version: 1` | `completedSprints[0]`: same two |
| `replay-research-second-reflexion` | `status: proposed → completed`, `+ version: 1` | `completedSprints[0]`: same two |
| `replay-full-run-evaluation-fails` | `status: proposed → failed`, `+ version: 2` | `failedSprints[0]`: same two (`completedSprints` stays `[]`) |
| `replay-plan-clarify-rounds-exhausted` | **NO CHANGE** — `contracts: []`, no `sprint.exit` pin, `plan_materialize` never runs | **NO CHANGE** |

The version values are read off the committed `sprint.exit` pins: `completed/1` in four cases,
`failed/2` (twice) in `replay-full-run-evaluation-fails`.

**`pinnedResponses` will ALSO change — predicted, and it is legitimate.** Any recorded effect
request whose `contract` is resolved from the channel AFTER `sprint_exit` now carries the settled
copy (`resolveContract`, `gates.ts:711-718`, reads `state.sprintContracts`):
- `replay-full-run-evaluation-passes` / `-plan-clarification-round` / `-research-reflexions-exhausted`
  / `-research-second-reflexion`: `documenter@None#0 documenter.summary` request
  `contract.status: proposed → completed`, `+ version: 1`.
- `replay-full-run-evaluation-fails`: `sprint_curate_mocks@…#1 curator.mocks` request
  `contract.status: proposed → failed`, `+ version: 2`.
Replay pin lookup is keyed on `(nodeId, branchKey, callIndex)` and the request is NEVER compared
(`replay.ts:363-367`, `:398-412`), so a changed request cannot break a replay.

**Anything else moving is a stop condition.** Specifically: no case may gain or lose a pin (that
would mean routing changed — it cannot: §7.1's reader list shows no router or gate reads
`contract.status`), no case may change `terminalNodeId`, the replay count must stay exactly 5
(`GOLDEN_MIN_REPLAY_CASES`, `case-schema.ts:127`) and no case may be relabelled `integrity`.
The 37 `integrity` cases are NOT executed (`executor.ts:268-272` refuses them) and must not change.

---

## 8. Implementation Sequence

1. **`src/pge/registry/reducers.ts:187`** — replace the join with the rank-aware resolution:
   `const incumbent = merged.get(id); merged.set(id, merged.has(id) ? (rankIsGreater(item, incumbent) ? item : incumbent) : item);`
   Rewrite the module header's "Conflict resolution" block (`:40-49`) and add a comment at the
   join explaining WHY the `canonicalJson` third term is what preserves order-invariance (§2.2).
   Do NOT move `versionRank`/`rankIsGreater`.
   - Verify: `npx vitest run src/pge/registry/reducers.test.ts` — all green with NO test edits yet.
2. **`src/pge/registry/reducers.ts`, sc-4-3** — apply the §7.2 decision (recommended: widen
   `versionRank`'s numeric term, documented; else the fallback). If you widen `versionRank`,
   re-run step 1's verification: the appendById channels have no `attempts` key, so nothing there
   may move.
   - Verify: `attempts: 10` beats `attempts: 9` through `lastWriteWinsByKey.merge` in BOTH orders.
3. **`src/orchestrator/contract-materialization.ts:52-65`** — the security directive, option (a):
   strip `version` alongside the four fields already normalized on the embedded branch.
   - Verify: `npx vitest run src/orchestrator/contract-materialization.test.ts`.
4. **Tests** — `reducers.test.ts` (sc-4-1, sc-4-2 with its control, sc-4-3, sc-4-4 over all
   permutations + `version`/`updatedAt` in `sprintContractsValue`), and the pinning test for
   step 3 in `contract-materialization.test.ts`.
   - Verify: each new test FAILS when you revert step 1/2/3 locally. Do this — it is the sprint's
     definitionOfDone ("every documentation claim added backed by a test that fails when the claim
     stops being true").
5. **`src/pge/nodes/sprint-evaluate.test.ts:775-789`** — flip `"proposed"` → `"completed"`, rewrite
   the KNOWN-LIMITATION comment into a statement of the new behaviour.
   - Verify: `npx vitest run src/pge/nodes/sprint-evaluate.test.ts`.
6. **Prose that is now false** — `src/pge/nodes/sprint-review.ts:33-51`,
   `src/pge/runtime/commit.ts:503-521`. **Count the lines you add/remove** and update
   `src/contracts/status-vocabulary.invariant.test.ts`'s allowlist line numbers in the SAME edit
   (§7.3).
   - Verify: `npx vitest run src/contracts/status-vocabulary.invariant.test.ts`.
7. **Run the conformance harness and READ the diff** —
   `npx vitest run src/orchestrator/workflow/conformance.engines.test.ts`. Compare the actual
   divergence set and the actual pipelineResult diff detail against §7.4's prediction before
   editing anything.
8. **Edit the pin + the doc disposition + the sprint doc, ONE commit** —
   `conformance.engines.test.ts:294-310` and `:423`, `docs/pge-graph.md:1174-1177` / `:1226-1240`,
   `docs/sprints/sprint-spec-20260812-terminal-vocabulary-4.md`.
   - Verify: the pin still fails in both directions (temporarily add a fifth field ⇒ red; remove a
     real one ⇒ red).
9. **Golden re-capture** — `GOLDEN_CAPTURE=1 npx vitest run src/pge/golden/capture.test.ts`, then
   `git diff .bober/golden/` and check it against §7.5's table line by line.
   - Verify: `node scripts/run-golden-regression.mjs` and
     `npx vitest run src/pge/golden/` (dataset, coverage, gate, capture).
10. **Full verification** — `npx vitest run`, `npm run typecheck`, `npm run typecheck:tests`,
    `npm run lint`, `npm run build`.

---

## 9. Pitfalls & Warnings

- **`mergeEntries` is NOT `lastWriteWinsByKey`.** The one-line change touches `appendById` only.
  sc-4-3 needs its own edit at `reducers.ts:299` or in `versionRank`. Confirming this by
  measurement rather than assumption is the single highest-value thing in this sprint (§7.2).
- **Do not move `versionRank`/`rankIsGreater`.** `reducers.ts:348-359` is cited by name in
  `src/contracts/sprint-contract.ts:199`, `src/pge/nodes/sprint-review.ts:44` and `:211`,
  `src/orchestrator/workflow/conformance.engines.test.ts:292`, and `docs/pge-graph.md:1206`.
  Function declarations hoist; calling them from `:187` needs no reordering.
- **Line-number tripwire.** `status-vocabulary.invariant.test.ts`'s allowlist is FILE:LINE pinned
  and asserted in BOTH directions (`:253-264`). Editing comments in `commit.ts`, `documenter.ts`,
  `sprint-curate.ts`, `sprint-generate.ts` or `interpreter.ts` shifts those lines. Update the
  allowlist in the same commit or the suite goes red for a reason unrelated to your change.
- **`version` must never gain a `.default()`.** `sprint-contract.ts:203-212` explains why: a default
  materialises `version: 0` on the seeded copy at every `OverallStateSchema.parse` (which the
  commit boundary runs at `commit.ts:441`), collapsing the two ranks and silently re-breaking this
  sprint. If you find yourself adding one, stop.
- **`updatedAt` cannot be relied on as the discriminator.** Both the conformance harness
  (`conformance.engines.test.ts:88` `FROZEN_ISO`) and the golden capture
  (`capture.test.ts:55` `CAPTURE_INSTANT`) run at the same frozen instant the fixture stamps
  (`whole-graph.ts:150` `FIXED_ISO`) — seeded and settled tie on it. Only `version` decides.
  Do NOT "improve" the ordering by leaning on `updatedAt` (spec decision D4).
- **A pre-existing wart you may trip over and must not blame on your change. [measured]** For a
  RECORD-shaped container, a member whose value is `null` in one container and `undefined` in
  another canonicalises identically (`canonicalJson(undefined) === "null"`, `reducers.ts:119-121`)
  so the incumbent wins — and the final record differs (`{"a":null}` vs `{}`) depending on arrival
  order. **This is true of the SHIPPED join and of the rank-aware one identically.** It is
  unreachable in the topology (no writer emits `undefined` members) and is out of scope. Do not
  "fix" it inside this sprint.
- **`joinByCanonicalOrder` must stay.** It still has two callers (`:299`, `:437`). Deleting it
  breaks `mergeLedger` and `lastWriteWinsByKey`. `mergeLedger` is out of scope: `LedgerEntry`
  (`overall.ts:175-183`) has neither `version` nor `updatedAt`, so switching it would be a no-op
  churn on a channel the contract does not mention.
- **Do not weaken the pin.** nonGoal 2. `toEqual` over a sorted set, both directions live.
- **Do not touch the flip.** `oracle-retention.test.ts` asserts the default engine is still `"ts"`;
  `docs/pge-graph.md:1246+` ("### The decision") stays as-is except for the divergence record.
- **A git worktree copy exists at `.claude/worktrees/youthful-satoshi-563347/` and vitest picks it
  up** (there is no `vitest.config.ts`; the root `package.json` sets only `"test": "vitest"`). The
  conformance file ran TWICE in the curator's baseline (2 files / 10 tests for a 5-test file).
  Expect doubled counts, and make sure your edits land in the tree you are verifying.
- **Effect requests are never compared on replay** (`replay.ts:363-367`) — a changed
  `pinnedResponses[].request` is expected and harmless. Pin COUNT or ORDER changing is not: that
  would mean routing moved, which nothing in §7.1 permits.
