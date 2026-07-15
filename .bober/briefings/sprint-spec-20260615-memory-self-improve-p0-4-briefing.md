# Sprint Briefing: Fail→pass contrast extractor in distill

**Contract:** sprint-spec-20260615-memory-self-improve-p0-4
**Generated:** 2026-06-15T00:00:00.000Z

---

## 0. TL;DR for the Generator

Add a **fourth signal (d)** to the EXISTING pure `distill()` in `src/orchestrator/memory/distill.ts`. The function already mines three signals (a/b/c). You will add a loop over `contracts` that detects, within each `contract.iterationHistory`, a **fail→pass transition** (at least one `result==='fail'` entry that is FOLLOWED in iteration order by a `result==='pass'` entry) and emits one lesson per such contract with `category = \`fix-contrast:${contractId}\``. **Reuse the closure `upsertGroup` and the existing helpers — write NO new id/severity logic.** Then add three tests to `src/orchestrator/memory/distill.test.ts`. Touch ONLY these two files. **Purity (sc-4-4) is the load-bearing constraint: no `../providers` import, no `Date.now()`/`new Date()`, no `fs`/`fetch`.**

---

## 1. Target Files

### src/orchestrator/memory/distill.ts (modify)

This is a **single pure function** (`distill`) plus three private helpers. You will add one new loop inside `distill()` (signal d) — do NOT touch the helpers, the existing loops, or the final sort/build block.

**The purity contract — quote it, preserve it verbatim** (`src/orchestrator/memory/distill.ts:1-21`):
```ts
/**
 * PURE deterministic distillation of sprint outcomes into LessonEntry records.
 *
 * PURE — must not import from ../providers; no network, no Date.now(), no side effects,
 * no filesystem access. createdAt is stamped at PERSIST TIME by the CLI handler, not here.
 * lessonId is a sha256 content-hash of category+tags+sourceEntryRefs — never derived from time.
 *
 * IMPORTANT — this distills from the data shapes the REAL pipeline actually produces ...
 *   (a) recurring failed-criterion categories  — from eval results' criteriaResults[].result==="fail" ...
 *   (b) repeated failing eval strategies        — from eval results' strategyResults[].result==="fail" ...
 *   (c) sprints that needed rework              — from contract.iterationHistory entries whose
 *       result==="fail" (real shape: { iteration, evalId, result }) ...
 */
```
**ACTION:** Extend the header's signal list to add `(d) fail→pass contrast`. Keep the PURE clause exactly as-is.

**The `distill()` signature — DO NOT change it** (`src/orchestrator/memory/distill.ts:118-122`):
```ts
export function distill(
  history: HistoryEntry[],
  contracts: SprintContract[],
  evalResults: DistillableEval[] = [],
): LessonEntry[] {
```

**The `upsertGroup` closure you MUST reuse** (`src/orchestrator/memory/distill.ts:125-139`):
```ts
function upsertGroup(
  category: string,
  tags: string[],
  summary: string,
  ref: string,
): void {
  const sortedTags = [...tags].sort();
  const key = `${category}|${sortedTags.join(",")}`;
  let group = groups.get(key);
  if (!group) {
    group = { category, tags: sortedTags, summary, sourceEntryRefs: new Set() };
    groups.set(key, group);
  }
  group.sourceEntryRefs.add(ref);
}
```
Note: `upsertGroup` keys groups by `category|sortedTags`. Each call adds ONE ref to the group's `Set`. Call it once per source ref (failing iterations AND the passing iteration).

**The existing signal (c) loop — your new signal (d) mirrors this exactly** (`src/orchestrator/memory/distill.ts:185-205`):
```ts
const sprintsCountedFromContracts = new Set<string>();
for (const contract of contracts) {
  const iters = Array.isArray(contract.iterationHistory)
    ? contract.iterationHistory
    : [];
  const failedRefs: string[] = [];
  for (const it of iters) {
    if (isRecord(it) && it["result"] === "fail") {
      const n = typeof it["iteration"] === "number" ? it["iteration"] : "?";
      failedRefs.push(`${contract.contractId}:iteration-${n}`);
    }
  }
  if (failedRefs.length >= REWORK_THRESHOLD) {
    sprintsCountedFromContracts.add(contract.contractId);
    const tags = ["phase:rework", `sprintId:${contract.contractId}`];
    const summary = `Sprint '${contract.contractId}' needed ${failedRefs.length} rework iteration(s) before passing`;
    for (const ref of failedRefs) {
      upsertGroup("sprint-rework", tags, summary, ref);
    }
  }
}
```
**This is your structural template.** Signal (d) is a NEW, separate loop over `contracts` (place it after the `(c)` block, before the history fallback at line 210 OR after the fallback — order does not matter because output is sorted by lessonId). It does NOT replace or modify signal (c): a fail→pass sprint will legitimately produce BOTH a `sprint-rework` lesson (from c) AND a `fix-contrast:` lesson (from d). That is correct and expected.

**The final build/sort block — DO NOT touch** (`src/orchestrator/memory/distill.ts:222-249`): it iterates `groups.values()`, computes `lessonId` via `lessonIdFromSignature`, `severity` via `severityFor`, stamps `createdAt: SENTINEL_CREATED_AT`, and sorts by `lessonId`. Because you used `upsertGroup`, your new lessons flow through this block automatically — you get content-hashing, severity banding, the SENTINEL createdAt, and byte-stable sorting **for free**. This is why reusing `upsertGroup` is mandatory.

**Imports this file uses** (`src/orchestrator/memory/distill.ts:23-27`) — you need NO new imports:
- `createHash` from `node:crypto`
- `type HistoryEntry` from `../../state/history.js`
- `type SprintContract` from `../../contracts/sprint-contract.js`
- `type LessonEntry` from `../../state/memory.js`

**Imported by:**
- `src/cli/commands/memory.ts:32` (`import { distill } from "../../orchestrator/memory/distill.js"`) — the only production consumer
- `src/orchestrator/memory/distill.test.ts:21`

**Test file:** `src/orchestrator/memory/distill.test.ts` — **exists** (309 lines, this is your second target).

---

### src/orchestrator/memory/distill.test.ts (modify)

Add three new `it(...)` cases. Use the existing `contract(...)` fixture helper — do NOT invent a new fixture builder.

**The fixture helper to reuse** (`src/orchestrator/memory/distill.test.ts:31-68`): `contract(contractId, iterationHistory)` returns a fully-valid `SprintContract`. You pass the `iterationHistory` array directly. Existing real-shape usage (`src/orchestrator/memory/distill.test.ts:72-75`):
```ts
contract("sprint-real-1", [
  { iteration: 1, evalId: "eval-sprint-real-1-1", result: "fail", timestamp: TS },
  { iteration: 2, evalId: "eval-sprint-real-1-2", result: "pass", timestamp: TS },
]),
```
This confirms the **real iterationHistory item shape**: `{ iteration: number, evalId: string, result: "pass"|"fail", timestamp: string }`. `result` is the field signal (d) keys on; `iteration` drives the `:iteration-<n>` ref suffix.

**`TS` constant** (`src/orchestrator/memory/distill.test.ts:28`): `const TS = "2026-01-01T00:00:00.000Z";` — reuse it for fixture timestamps.

**`categories()` helper** (`src/orchestrator/memory/distill.test.ts:116-118`): `categories(lessons)` returns `lessons.map(l => l.category).sort()`. Use `lessons.find(l => l.category.startsWith("fix-contrast:"))` to locate your new lesson in assertions.

---

## 2. Patterns to Follow

### Pattern: emit a contract-keyed lesson group with sourceEntryRefs citing iterations
**Source:** `src/orchestrator/memory/distill.ts:185-205` (signal c, shown in full above)
**Rule:** Build a `string[]` of refs in the form `\`${contract.contractId}:iteration-${n}\`` (guard `n` with `typeof it["iteration"] === "number" ? it["iteration"] : "?"`), then call `upsertGroup(category, tags, summary, ref)` once per ref. Never push to `groups` directly.

### Pattern: read iterationHistory leniently via isRecord
**Source:** `src/orchestrator/memory/distill.ts:80-82, 187-194`
```ts
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
// ...
const iters = Array.isArray(contract.iterationHistory) ? contract.iterationHistory : [];
for (const it of iters) {
  if (isRecord(it) && it["result"] === "fail") { /* ... it["iteration"] ... */ }
}
```
**Rule:** `contract.iterationHistory` is typed `unknown[]` (`src/contracts/sprint-contract.ts:124`). You MUST narrow each item with `isRecord(it)` and bracket-access `it["result"]` / `it["iteration"]`. Do NOT add type casts or assume the dot-shape. This keeps signal (d) resilient to missing fields (sc-4-4 / generatorNotes "read leniently").

### Pattern: tags array convention
**Source:** `src/orchestrator/memory/distill.ts:199` (`["phase:rework", `sprintId:${contractId}`]`) and `:161, :175`
**Rule:** Tags are `key:value` strings. Per the contract (sc-4-2 / generatorNotes), signal (d) tags are `["phase:fix-contrast", \`sprintId:${contract.contractId}\`]`. `upsertGroup` sorts tags internally, so order in the literal does not matter.

### Pattern: category convention
**Source:** `src/orchestrator/memory/distill.ts:160` (`eval-strategy-failure:${s.strategy}`), `:174` (`failed-criterion:${resolvedVm}`)
**Rule:** Categories are `prefix:discriminator`. Signal (d) uses `\`fix-contrast:${contract.contractId}\`` (generatorNotes). The test asserts `category.startsWith("fix-contrast:")` (sc-4-2), so the prefix is exact and load-bearing.

### Pattern: detecting fail→pass ordering (NEW logic — the one piece you write)
There is no existing fail→pass detector to copy; here is the precise spec. A transition exists **iff** there is at least one `result==='fail'` that is FOLLOWED (in iteration order) by a `result==='pass'`. Implementation hint that stays deterministic and order-faithful:
```ts
// iterate iterationHistory in array order (it is already chronological);
// track whether a fail has been seen; the transition fires when a pass
// appears AFTER at least one fail.
let sawFail = false;
let flipped = false;
const failedRefs: string[] = [];
let passRef: string | undefined;
for (const it of iters) {
  if (!isRecord(it)) continue;
  const n = typeof it["iteration"] === "number" ? it["iteration"] : "?";
  if (it["result"] === "fail") {
    sawFail = true;
    failedRefs.push(`${contract.contractId}:iteration-${n}`);
  } else if (it["result"] === "pass" && sawFail) {
    flipped = true;
    passRef = `${contract.contractId}:iteration-${n}`;
    break; // first pass after a fail is the flip point
  }
}
if (flipped && passRef) {
  // emit fix-contrast lesson: upsertGroup(...) for each failedRef AND passRef
}
```
**Rule:** A first-iteration pass (`pass` before any `fail`) sets neither `sawFail` nor `flipped` → no lesson (sc-4-3). An all-fail history never reaches the `pass` branch → no lesson (sc-4-3). `[fail, fail, pass]` → `failedRefs=[...:iteration-1, ...:iteration-2]`, `passRef=...:iteration-3`, emit one lesson citing all three (sc-4-2). Iterate in **array order** — do NOT sort by `iteration` first; the array is already chronological and the spec is about positional order.

### Pattern (OPTIONAL enrichment — only if cheap & resilient): tag the flipped strategy/criterion
**Source for the eval shape:** `DistillableEval` at `src/orchestrator/memory/distill.ts:50-67`; existing strategy/criterion reads at `:158-178`.
generatorNotes permits: "If eval results (DistillableEval[]) are available for those iterations, you MAY enrich tags with the strategy/criterion that flipped." If you do this: match `evalResults` by `ev.contractId === contract.contractId` and `ev.iteration` matching the failing/passing iteration numbers; compare `strategyResults`/`criteriaResults` to find one that went `fail`→`pass`; add a `\`strategy:${name}\`` or `\`criterion:${id}\`` tag. **Every `DistillableEval` field is optional (`:50-67`)** — guard everything. **Keep it deterministic (sort any derived tags via the existing `upsertGroup` sort).** This is OPTIONAL; the required sc-4-2/sc-4-3 cases do NOT depend on enrichment. If in doubt, ship the minimal version (`["phase:fix-contrast", sprintId:...]`) — fewer moving parts, easier purity proof.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `upsertGroup` (closure) | `src/orchestrator/memory/distill.ts:125` | `(category: string, tags: string[], summary: string, ref: string) => void` | Accumulate one source ref into a category+tags-keyed group; dedupes via Set. **USE THIS for signal (d).** |
| `lessonIdFromSignature` | `src/orchestrator/memory/distill.ts:88` | `(category: string, tags: string[], refs: string[]) => string` | sha256 content-hash → 16-char hex lessonId. Called by the build block automatically; do NOT call directly. |
| `severityFor` | `src/orchestrator/memory/distill.ts:102` | `(occurrences: number) => "info"\|"warn"\|"high"` | Maps ref count to severity band. Applied automatically in the build block. |
| `isRecord` | `src/orchestrator/memory/distill.ts:80` | `(v: unknown) => v is Record<string,unknown>` | Narrow `unknown` iterationHistory items before bracket-access. **USE THIS.** |
| `SENTINEL_CREATED_AT` (const) | `src/orchestrator/memory/distill.ts:38` | `"1970-01-01T00:00:00.000Z"` | Placeholder `createdAt`; CLI overwrites at persist time. Applied automatically. |
| `REWORK_THRESHOLD` (const) | `src/orchestrator/memory/distill.ts:32` | `1` | Used by signal (c) only; signal (d) does NOT need a threshold (a single flip suffices). |
| `contract` (test fixture) | `src/orchestrator/memory/distill.test.ts:31` | `(contractId: string, iterationHistory: unknown[]) => SprintContract` | Build a valid contract fixture. **USE THIS in your new tests.** |
| `categories` (test helper) | `src/orchestrator/memory/distill.test.ts:116` | `(lessons: {category:string}[]) => string[]` | Sorted category list for assertions. |
| `appendLesson` | `src/state/memory.ts:296` | `(root, lesson: LessonEntry, ns?) => Promise<...>` | Persists a lesson (CLI side). NOT called from distill. |

**Utilities reviewed:** there is no `src/utils/`, `src/lib/`, `src/helpers/`, or `src/shared/` directory relevant to this pure function — all reusable vocabulary lives inside `distill.ts` itself (intentional: the file is self-contained to preserve purity). Do NOT import helpers from elsewhere.

---

## 4. Prior Sprint Output

### Sprint 3: lesson hygiene (retrieve.ts ranking, hygiene.ts, memory.ts quarantine, `memory prune`)
**Created/modified:** ranking + hygiene + quarantine in the memory subsystem. **distill.ts was NOT modified by Sprint 3.**
**Connection to this sprint:** NONE at the code level. The new `fix-contrast:` lessons you emit will flow through the SAME `appendLesson` → INDEX.md → retrieve/hygiene path as the existing three signals, so no new wiring is needed. The CLI handler (`src/cli/commands/memory.ts:79-95`) already calls `distill(history, contracts, evalResults)` and persists every returned draft — your new lessons are picked up automatically (this satisfies sc-4-5 with no CLI change).

### Sprints 1 & 2: SQLite facts store + reconcile — unrelated. Do NOT import from the facts subsystem.

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` found. The governing principle for THIS sprint is the in-file purity contract (`src/orchestrator/memory/distill.ts:1-21`, quoted in §1) — treat it as binding.

### Architecture Decisions
`.bober/architecture/` exists in the repo but contains no ADR specific to distill purity. The purity contract is enforced by the test suite itself (see §6) rather than a separate doc.

### Other Docs
The data-shape contract that matters: `iterationHistory` items are `{ iteration, evalId, result }` (documented at `src/orchestrator/memory/distill.ts:15` and the contract schema types `iterationHistory: z.array(z.unknown())` at `src/contracts/sprint-contract.ts:124`). `result` is `"pass"|"fail"`. This is the REAL pipeline shape — the test file (`distill.test.ts:1-14`) has a drift-guard that fails distill if it ever matches invented shapes, so stay on the real shape.

---

## 6. Testing Patterns

### Unit Test Pattern
**Source:** `src/orchestrator/memory/distill.test.ts:122-184`
```ts
describe("distill extracts lessons from the real pipeline data shapes", () => {
  it("(c) flags a sprint that needed rework from its iterationHistory", () => {
    const lessons = distill([], contractsFixture, []);
    const rework = lessons.find((l) => l.category === "sprint-rework");
    expect(rework).toBeDefined();
    expect(rework!.tags).toContain("sprintId:sprint-real-1");
    expect(rework!.sourceEntryRefs).toContain("sprint-real-1:iteration-1");
  });
});
```
**Runner:** vitest (`import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";`, `distill.test.ts:16`)
**Assertion style:** `expect(...)` with `.find`/`.toContain`/`.toHaveLength`/`.toBeDefined`. Non-null assert `!` after `.find` is the established idiom.
**Mock approach:** mostly none (pure fn). One test spies on `createClient` via `vi.spyOn` (`:302-308`).
**File naming:** co-located `*.test.ts` next to source.
**Location:** co-located (`src/orchestrator/memory/distill.test.ts`).

### Three required new tests (sc-4-2, sc-4-3)

**(1) Positive — `[fail, fail, pass]` emits exactly one fix-contrast lesson citing fail AND pass iterations (sc-4-2):**
```ts
it("(d) emits a fix-contrast lesson for a fail→fail→pass transition", () => {
  const c = [contract("flip-1", [
    { iteration: 1, evalId: "e1", result: "fail", timestamp: TS },
    { iteration: 2, evalId: "e2", result: "fail", timestamp: TS },
    { iteration: 3, evalId: "e3", result: "pass", timestamp: TS },
  ])];
  const lessons = distill([], c, []);
  const fix = lessons.filter((l) => l.category.startsWith("fix-contrast:"));
  expect(fix).toHaveLength(1);
  expect(fix[0]!.category).toBe("fix-contrast:flip-1");
  expect(fix[0]!.tags).toContain("phase:fix-contrast");
  expect(fix[0]!.tags).toContain("sprintId:flip-1");
  expect(fix[0]!.sourceEntryRefs).toContain("flip-1:iteration-1");
  expect(fix[0]!.sourceEntryRefs).toContain("flip-1:iteration-2");
  expect(fix[0]!.sourceEntryRefs).toContain("flip-1:iteration-3"); // the pass
});
```
(Note: this same contract ALSO yields a `sprint-rework` lesson from signal c — assert ONLY the fix-contrast subset via `.filter(... startsWith)`, not total length.)

**(2) Negative — first-iteration pass yields NO fix-contrast (sc-4-3):**
```ts
it("(d) does not emit fix-contrast when the sprint passed on its first iteration", () => {
  const c = [contract("clean-1", [
    { iteration: 1, evalId: "e1", result: "pass", timestamp: TS },
  ])];
  const lessons = distill([], c, []);
  expect(lessons.filter((l) => l.category.startsWith("fix-contrast:"))).toHaveLength(0);
});
```

**(3) Negative — never passed (all fail) yields NO fix-contrast (sc-4-3):**
```ts
it("(d) does not emit fix-contrast when the sprint never passed", () => {
  const c = [contract("stuck-1", [
    { iteration: 1, evalId: "e1", result: "fail", timestamp: TS },
    { iteration: 2, evalId: "e2", result: "fail", timestamp: TS },
  ])];
  const lessons = distill([], c, []);
  expect(lessons.filter((l) => l.category.startsWith("fix-contrast:"))).toHaveLength(0);
});
```
**Optional 4th (ordering rigor, matches evaluatorNotes):** a `[pass, fail]` history (pass BEFORE a fail with no later pass) is NOT a transition → assert zero fix-contrast lessons. Cheap to add and pre-empts the evaluator's ordering check.

### E2E / CLI Pattern (sc-4-5, manual)
No Playwright. sc-4-5 is verified manually by the evaluator: seed a contract with a `[fail,pass]` iterationHistory, run `node dist/cli/index.js memory distill` then `memory list`. **No code change is needed for this** — the CLI handler (`src/cli/commands/memory.ts:69-109`) already persists all distill drafts. Just make sure your lesson shape is a valid `LessonEntry` (it will be, because `upsertGroup` + the build block produce the canonical shape).

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/cli/commands/memory.ts` | `distill` (`:32,:79`) | low | Signature unchanged (still `(history, contracts, evalResults)`); it persists whatever drafts come back. New `fix-contrast:` lessons flow through unchanged. |
| `src/orchestrator/memory/distill.test.ts` | `distill`, `DistillableEval` (`:21`) | low | You are editing this; existing assertions about the "four expected lessons" fixture (`:123-132`) MUST still pass — `contractsFixture` is `[fail, pass]` so it ALSO becomes a fail→pass transition. See WARNING below. |

### Existing Tests That Must Still Pass
- `src/orchestrator/memory/distill.test.ts:123-132` — "produces exactly the four expected lessons from the fixture" — **HIGH-ATTENTION:** `contractsFixture` (`:71-76`) is `[{i:1,fail},{i:2,pass}]`, which IS a fail→pass transition. Once signal (d) fires, `distill(historyFixture, contractsFixture, evalResultsFixture)` will return **FIVE** lessons (the four existing + one `fix-contrast:sprint-real-1`), and `categories()` will include `"fix-contrast:sprint-real-1"`. **You MUST update this test's `toHaveLength(4)` → `toHaveLength(5)` and add `"fix-contrast:sprint-real-1"` to the expected `categories(...)` array** (it sorts before `failed-criterion`, after `eval-strategy-failure`). This is the single most likely regression — do not miss it.
- `distill.test.ts:240-244` — "evalResults defaults to []" expects `["sprint-rework","sprint-rework"]` from `(historyFixture, contractsFixture)`. `contractsFixture` flips fail→pass, so this will ALSO gain `"fix-contrast:sprint-real-1"` → update expected to `["fix-contrast:sprint-real-1","sprint-rework","sprint-rework"]` (sorted).
- `distill.test.ts:208-211` (drift guard) — invented `[{round:1}...]` has no `result` field → no fix-contrast. Must STILL yield `[]`. Your `isRecord(it) && it["result"]==="fail"` guard preserves this. Verify.
- `distill.test.ts:216-245` (determinism block) — your new lessons must sort by lessonId and be byte-identical across calls. Reusing `upsertGroup` + the build block guarantees this; just confirm the suite stays green.
- `distill.test.ts:284-308` (purity block) — greps the source for `providers`/`fetch`/`node:https`/`Date.now()`/`new Date()`. **Your added code must contain NONE of these.**

### Features That Could Be Affected
- **Sprint 3 hygiene/retrieve** — shares the lesson INDEX.md pipeline. New `fix-contrast:` lessons participate in ranking/quarantine like any other category. No special handling required; verify `memory list`/`memory prune` don't crash on the new category (they treat category as an opaque string).

### Recommended Regression Checks
1. `npm run build` — exit 0 (sc-4-1).
2. `npm run typecheck` — zero errors (sc-4-1).
3. `npx vitest run src/orchestrator/memory/distill.test.ts` — ALL pass, including the UPDATED length/category assertions (see HIGH-ATTENTION above).
4. `npx vitest run src/orchestrator/memory` — hygiene/retrieve/memory tests unaffected.
5. `npm run lint` — zero errors (sc-4-6).
6. Purity grep (sc-4-4, evaluatorNotes): `grep -nE "providers|Date\.now|new Date\(|readFile|fetch" src/orchestrator/memory/distill.ts` — must return nothing outside comments.

---

## 8. Implementation Sequence

1. **distill.ts — extend the header comment** — add `(d) fail→pass contrast` to the signal list (`:8-16`); keep the PURE clause verbatim.
   - Verify: header still contains the "must not import from ../providers; no network, no Date.now()" sentence.
2. **distill.ts — add signal (d) loop** — after the signal (c) block (`:205`), add a new `for (const contract of contracts)` loop implementing the fail→pass detector from §2, emitting via `upsertGroup("fix-contrast:" + contract.contractId, ["phase:fix-contrast", "sprintId:"+contractId], summary, ref)` for each failed ref AND the pass ref. Summary: `\`Sprint '${contract.contractId}' flipped from fail to pass after ${failedRefs.length} iteration(s)\``.
   - Verify: no new imports added; bracket-access (`it["result"]`) used; no dot-shape casts; no `Date`/`fs`/`fetch`.
3. **distill.ts — (OPTIONAL) eval enrichment** — only if you can do it with full optional-field guards and deterministic tag sorting. Skip if uncertain.
   - Verify: every `DistillableEval` field access is guarded; output still deterministic.
4. **distill.test.ts — fix existing assertions** — update `toHaveLength(4)`→`(5)` and the two `categories(...)` expected arrays (`:125-131`, `:243`) to include `"fix-contrast:sprint-real-1"`.
   - Verify: re-run the file; these two tests pass.
5. **distill.test.ts — add the three new tests** (positive `[fail,fail,pass]`, first-pass negative, all-fail negative) from §6, plus the optional `[pass,fail]` ordering test.
   - Verify: new tests pass; `.filter(l => l.category.startsWith("fix-contrast:"))` length is 1 / 0 / 0 respectively.
6. **Run full verification** — `npm run build`, `npm run typecheck`, `npx vitest run src/orchestrator/memory/distill.test.ts`, `npm run lint`, plus the purity grep.

---

## 9. Pitfalls & Warnings

- **THE FIXTURE TRAP (most likely failure):** `contractsFixture` at `distill.test.ts:71-76` is `[fail, pass]` — a real fail→pass transition. Signal (d) WILL fire on it, changing the existing "four expected lessons" test to FIVE and the `evalResults defaults to []` test's expected array. **You MUST update those two existing assertions** (§7). If you forget, the suite goes red even though signal (d) is correct.
- **Both signals fire for one sprint:** a fail→pass sprint produces a `sprint-rework` (c) AND a `fix-contrast:` (d) lesson. This is intentional. In your positive test, assert on the `fix-contrast`-filtered subset, never on total `lessons.length`.
- **Do NOT sort iterationHistory by `iteration` before scanning.** The array is already chronological; the spec is positional ("FOLLOWED in iteration order"). Re-sorting could mask a genuinely out-of-order `[pass, fail]` non-transition. Iterate in array order.
- **`iterationHistory` is `unknown[]`** (`sprint-contract.ts:124`). Always narrow with `isRecord(it)` and bracket-access `it["result"]`/`it["iteration"]`. A dot-access or cast will fail typecheck or break the drift-guard's leniency contract.
- **Purity is grep-enforced** (`distill.test.ts:284-300`). Do not add ANY import, do not call `Date`, do not touch `fs`/`fetch`. `createdAt` stays `SENTINEL_CREATED_AT` (applied automatically by the build block — don't set it yourself).
- **Reuse `upsertGroup` — never push to `groups` directly.** Direct pushes bypass the tag-sort + Set-dedupe and would break byte-stability (sc-4-4).
- **Category prefix is exact:** `fix-contrast:` (with trailing colon, then contractId). The test asserts `.startsWith("fix-contrast:")` and `=== "fix-contrast:flip-1"`. A typo like `fix_contrast` or `fixcontrast:` fails sc-4-2.
- **Do not modify `src/cli/commands/memory.ts`** — it already persists distill output (sc-4-5 needs no CLI change). Touch only the two estimated files.
