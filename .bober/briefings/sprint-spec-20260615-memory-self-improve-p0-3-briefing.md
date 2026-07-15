# Sprint Briefing: Lesson hygiene — occurrence-weighted ranking, decay & conflict-quarantine

**Contract:** sprint-spec-20260615-memory-self-improve-p0-3
**Generated:** 2026-06-15T00:00:00.000Z

> This sprint is INDEPENDENT of Sprints 1–2 (SQLite facts). It touches ONLY the
> lessons store (`.bober/memory/INDEX.md` + per-lesson `<lessonId>.md` files).
> Four moves: (1) make `scoreRecord` occurrence-weighted, (2) new PURE
> `pruneLessons`, (3) deterministic conflict detection, (4) `bober memory prune`.

---

## 1. Target Files

### `src/orchestrator/memory/retrieve.ts` (modify)

This is a PURE module (no `Date.now()`, no direct `fs`, all reads via `loadLessonIndex`).
You will change ONLY `scoreRecord` (its return value) and the sort comparator.

**`scoreRecord` today (lines 42-61) — returns a plain token-overlap count:**
```ts
function scoreRecord(
  record: LessonIndexRecord,
  keywordTokens: Set<string>,
): number {
  if (keywordTokens.size === 0) return 0;

  const recordTokens = new Set<string>([
    ...tokenize(record.category),
    ...record.tags.flatMap(tokenize),
    ...tokenize(record.summarySnippet),
  ]);

  let count = 0;
  for (const token of keywordTokens) {
    if (recordTokens.has(token)) {
      count++;
    }
  }
  return count;          // <-- occurrence weighting goes here (keep overlap dominant)
}
```

**The current sort + C1 filter (lines 93-102) — overlap DESC, then lessonId ASC:**
```ts
const scored = records
  .map((r) => ({ r, score: scoreRecord(r, keywordTokens) }))
  .filter((x) => x.score > 0); // C1: non-matching keyword -> empty

// Sort: score DESC, then lessonId ASC for stable tiebreak
scored.sort(
  (a, b) => b.score - a.score || a.r.lessonId.localeCompare(b.r.lessonId),
);

return scored.slice(0, topK).map((x) => x.r);
```

**HOW to add bounded occurrence weighting WITHOUT breaking token-overlap dominance (sc-3-2):**
The simplest deterministic approach that the existing comparator already supports is to add a
SECONDARY occurrence comparator BETWEEN the overlap comparator and the lessonId tiebreak —
this keeps `scoreRecord` returning the pure integer overlap count (so the C1 filter `score > 0`
and all overlap-based tests are untouched) and adds occurrences purely as a tiebreak when overlap is equal:

```ts
scored.sort(
  (a, b) =>
    b.score - a.score ||                         // 1. token overlap (DOMINANT)
    b.r.occurrences - a.r.occurrences ||          // 2. higher occurrences win on ties (sc-3-2)
    a.r.lessonId.localeCompare(b.r.lessonId),     // 3. byte-stable final tiebreak
);
```
This is the LEAST-RISK option: every existing assertion that keys off overlap count is unchanged,
and the new ordering only fires when overlap is exactly equal. If the contract reviewer instead
wants occurrences folded INTO `scoreRecord`'s returned number, it MUST be a strictly-bounded
fractional add (e.g. `overlap + min(occurrences, CAP) / (CAP + 1)`) so a single extra overlap
token always outweighs any occurrence delta — but the three-key comparator above is cleaner,
preserves the `score > 0` integer semantics, and is what the generatorNotes ("tiebreaker/booster",
"sort stable: overlap desc, then occurrence-weighted, then lessonId asc") describes. Prefer the comparator.

**Imports this file uses (lines 10-11):**
- `loadLessonIndex` from `../../state/memory.js`
- `type { LessonIndexRecord }` from `../../state/memory.js`

**Imported by:** the planner skill/agent (via runtime), and `retrieve.test.ts`.
`LessonIndexRecord.occurrences` already exists (memory.ts:62) — no new field needed for ranking.

**Test file:** `src/orchestrator/memory/retrieve.test.ts` (exists)

---

### `src/orchestrator/memory/retrieve.test.ts` (modify)

Add ONE test under the C1 describe block asserting occurrence ordering on equal overlap.
ALL existing tests must keep passing — especially the tiebreak test at lines 99-107
(equal overlap + equal occurrences = lessonId ASC) which still holds because the third
comparator key is unchanged. Note `makeLesson` defaults `occurrences: 1` (line 31), so set
`occurrences` explicitly via overrides in the new test.

**Existing tiebreak test that MUST still pass (lines 99-107):**
```ts
it("applies stable tiebreak by lessonId ASC when scores are equal", async () => {
  await appendLesson(tmpDir, makeLesson("l-z", { tags: ["auth"] }));
  await appendLesson(tmpDir, makeLesson("l-a", { tags: ["auth"] }));
  await appendLesson(tmpDir, makeLesson("l-m", { tags: ["auth"] }));
  const out = await retrieveRelevantLessons(tmpDir, ["auth"], { topK: 5 });
  expect(out.map((r) => r.lessonId)).toEqual(["l-a", "l-m", "l-z"]);
});
```
(This passes unchanged: all three have `occurrences: 1` so the new key is a no-op tie → lessonId ASC.)

**New test to ADD (occurrence wins on equal overlap, sc-3-2):**
```ts
it("ranks higher-occurrence lesson above equal-overlap lower-occurrence lesson", async () => {
  await appendLesson(tmpDir, makeLesson("l-lo", { tags: ["auth"], occurrences: 1 }));
  await appendLesson(tmpDir, makeLesson("l-hi", { tags: ["auth"], occurrences: 7 }));
  const out = await retrieveRelevantLessons(tmpDir, ["auth"], { topK: 5 });
  expect(out.map((r) => r.lessonId)).toEqual(["l-hi", "l-lo"]); // l-hi first despite "z" > "h" lex order
});
```

---

### `src/orchestrator/memory/hygiene.ts` (create) — NEW PURE module

**Directory pattern:** files in `src/orchestrator/memory/` are kebab-free single words
(`distill.ts`, `reconcile.ts`, `retrieve.ts`, `eval-source.ts`, `fact-judge.ts`).
**Most similar existing file:** `src/orchestrator/memory/reconcile.ts` — copy its PURE-module
doc-header style and its `now`-injection signature shape.

**Structure template (follow `distill.ts` header + `reconcile.ts` now-injection):**
```ts
/**
 * PURE deterministic lesson hygiene: decay-based pruning + conflict quarantine.
 *
 * PURE — no Date.now(), no new Date(), no network, no filesystem. `now` is injected
 * by the CLI handler (mirrors reconcileFact's { now } at reconcile.ts:54). Operates
 * ONLY on the fields each record carries (the CLI assembles recency input — see §6).
 */

import type { LessonIndexRecord } from "../../state/memory.js";

// ── Types ────────────────────────────────────────────────────────────────

/** A record plus its CLI-derived recency proxy (ISO createdAt), kept OUT of the pure score. */
export interface PrunableLesson extends LessonIndexRecord {
  createdAt?: string; // ISO 8601, assembled by the CLI from <lessonId>.md; may be absent
}

export interface PruneOptions {
  now: string;                 // injected ISO wall-clock — NEVER read inside
  minOccurrences?: number;     // below this AND stale => quarantine
  maxAgeMs?: number;           // older than this (by createdAt) contributes to decay
  // ...thresholds you choose; keep all defaulted + documented
}

export interface PruneResult {
  kept: PrunableLesson[];
  quarantined: PrunableLesson[];
}

// ── Core ─────────────────────────────────────────────────────────────────

export function pruneLessons(
  records: PrunableLesson[],
  { now, minOccurrences = 2, maxAgeMs = THIRTY_DAYS_MS }: PruneOptions,
): PruneResult {
  // 1. conflict detection FIRST: same signature key + opposing markers => BOTH quarantined
  // 2. decay score for the rest: low occurrences + old createdAt => quarantine
  // 3. return { kept, quarantined }; both arrays sorted by lessonId ASC for byte-stability
}
```

**Test file:** `src/orchestrator/memory/hygiene.test.ts` (create) — pure-fn test style, no fs needed
for the core partition tests (construct `PrunableLesson[]` literals directly). See §6 for conflict-key shape.

---

## 2. Patterns to Follow

### PURE module with injected `now` (NO clock inside)
**Source:** `src/orchestrator/memory/reconcile.ts`, lines 1-10 (header) and 51-54 (signature)
```ts
/**
 * PURE — never reads the clock (now is injected), never calls createClient,
 * no network access, no Date.now(), no side effects beyond the injected store.
 */
export async function reconcileFact(
  store: FactStore,
  incoming: FactInput,
  { judge, now }: { judge?: FactJudge; now: string },
```
**Rule:** `pruneLessons` takes `{ now }` as injected ISO string — the evaluator will grep
hygiene.ts for `Date.now`/`new Date(` and there must be NONE (sc-3-3, evaluatorNotes).

### Deterministic, byte-stable output: sort by lessonId before returning
**Source:** `src/orchestrator/memory/distill.ts`, lines 246-249
```ts
// Sort by lessonId for deterministic, byte-identical output.
lessons.sort((a, b) => a.lessonId.localeCompare(b.lessonId));
return lessons;
```
**Rule:** sort both `kept` and `quarantined` by `lessonId.localeCompare` so repeated runs are byte-identical.

### Lesson signature / contradiction-key building blocks
**Source:** `src/orchestrator/memory/distill.ts`, lines 88-99 (`lessonIdFromSignature`)
```ts
function lessonIdFromSignature(category: string, tags: string[], refs: string[]): string {
  const canonical = JSON.stringify({ category, tags: [...tags].sort(), refs: [...refs].sort() });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
```
**Source:** `src/orchestrator/memory/distill.ts`, lines 198-218 — category roots + tag vocabulary
the real store produces: `category` values are `eval-strategy-failure:<s>`, `failed-criterion:<vm>`,
`"sprint-rework"`; tags include `"phase:rework"`, `sprintId:<id>`, `strategy:<s>`,
`verificationMethod:<vm>`. These are the ONLY tag/category shapes in the store.
**Rule for conflict detection (sc-3-5):** define the contradiction signature key as a deterministic
function of the **category root** (substring before `:`) + a shared discriminator tag
(e.g. the `sprintId:` or `strategy:` tag). An "opposing marker" is two records sharing that key but
carrying mutually-exclusive markers (e.g. one tagged a positive/keep marker, the other a negative).
NOTE: the live store has no built-in "opposing" pair, so your hygiene.ts must DEFINE the marker
convention explicitly and the test must seed two records that share the key and carry opposing markers,
then assert BOTH land in `quarantined`. Keep the predicate a pure deterministic string comparison.

### INDEX.md line format — exact build + parse (you must round-trip these)
**Source:** `src/state/memory.ts`, lines 101-106 (`buildIndexLine`) and 112-136 (`parseIndexLine`)
```ts
// build:  - <lessonId> [<category>/<severity>] (x<occurrences>) tags: a,b — <summary first 80>
return `- ${lesson.lessonId} [${lesson.category}/${lesson.severity}] (x${lesson.occurrences}) ${tagsSegment} — ${snippet}`;
// parse regex:
/^- (\S+) \[([^/\]]+)\/([^\]]+)\] \(x(\d+)\) tags: ([^—]*)— (.*)$/
```
**Rule:** QUARANTINE.md lines must be INDEX-style (sc-3-4 "INDEX-style lines"). The cleanest path is
to reuse the existing INDEX.md text by MOVING the exact source lines (string-level) rather than
re-serializing — `loadLessonIndex` already gives you parsed records to decide WHICH to move, but the
literal line text is what you append to QUARANTINE.md and remove from INDEX.md. Add a small exported
helper in memory.ts that does the line-level rewrite (see §1 memory.ts target below).

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `tokenize` | `src/orchestrator/memory/retrieve.ts:30` | `(s: string): string[]` | Lowercase alphanumeric tokenizer (PRIVATE to retrieve.ts — do not import; reconcile re-implemented it, see reconcile.ts:24-29) |
| `loadLessonIndex` | `src/state/memory.ts:259` | `(root, {limit}, ns?): Promise<LessonIndexRecord[]>` | Parse INDEX.md → records (returns `[]` if absent) — use in CLI to get records to prune |
| `loadLesson` | `src/state/memory.ts:290` | `(root, lessonId, ns?): Promise<LessonEntry>` | Load one `<lessonId>.md`; has `createdAt` — use in CLI to assemble recency proxy (see §6) |
| `appendLesson` | `src/state/memory.ts:212` | `(root, lesson, ns?): Promise<void>` | Upsert lesson file + one INDEX line — used by tests to seed |
| `indexPath` | `src/state/memory.ts:39` | `(root, ns?): string` | Absolute path to INDEX.md — add `quarantinePath` beside it |
| `lessonPath` | `src/state/memory.ts:35` | `(root, lessonId, ns?): string` | Absolute path to `<lessonId>.md` — do NOT delete these (sc-3-4) |
| `memoryDir` | `src/state/memory.ts:26` | `(root, ns?): string` | Namespace→dir mapping (programming sentinel) — reuse, do not duplicate |
| `ensureDir` | `src/state/helpers.ts:6` | `(dirPath): Promise<void>` | `mkdir -p` wrapper — use before writing QUARANTINE.md |
| `resolveDefaultNamespace` | `src/cli/commands/memory.ts:45` | `(root): Promise<string\|undefined>` | Resolve ns from team config, never throws — reuse in `prune` handler |
| `findProjectRoot` / `resolveRoot` | `src/cli/commands/memory.ts:33` | `(): Promise<string>` | Locate `.bober/` root — reuse in `prune` handler |

Utilities reviewed: `src/state/` (memory.ts, helpers.ts), `src/orchestrator/memory/` (all),
`src/cli/commands/memory.ts`, `src/utils/fs.js`. No existing prune/quarantine/decay util — this is net-new.

---

## 4. Prior Sprint Output

### Sprint 1: SQLite facts store
**Created:** `src/state/facts.ts` (+ facts CLI). **Connection:** NONE — facts are a separate store.
Do not import from facts.ts.

### Sprint 2: facts reconcile-on-write
**Created:** `src/orchestrator/memory/reconcile.ts` — exports `reconcileFact`.
**Connection:** Reuse ONLY its PURE-module + `{ now }`-injection PATTERN (cited §2), not its code.

The lessons store (`src/state/memory.ts`, `retrieve.ts`, `distill.ts`) predates this spec and is
the actual substrate for this sprint.

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` found. Conventions are enforced by inline module headers
("PURE — no Date.now()...") and by tests (the C2 source-inspection test at retrieve.test.ts:113-126
greps the source for forbidden imports — your hygiene.ts faces the same evaluator scrutiny for
`Date.now`/`new Date(`).

### Architecture Decisions
ADR references in the agent prompt (ADR-5/ADR-8, graph tool gating) are about the harness runtime,
not this sprint. No sprint-specific ADR.

### Other Docs / hard conventions
- ESM NodeNext: ALL relative imports MUST carry a `.js` extension (e.g. `from "../../state/memory.js"`)
  even though the source is `.ts`. See every import in retrieve.ts/distill.ts/memory.ts.
- TypeScript strict. chalk for CLI color. Commander for subcommands. Vitest for tests.

---

## 6. Recency-Proxy Resolution (generatorNotes question)

**LessonIndexRecord has NO timestamp.** Confirmed at `src/state/memory.ts:58-65`:
```ts
export interface LessonIndexRecord {
  lessonId: string; category: string; severity: string;
  occurrences: number; tags: string[]; summarySnippet: string;
}
```
The INDEX.md line format (memory.ts:101-106) carries no date either.
BUT each per-lesson `<lessonId>.md` front-matter DOES carry `createdAt` (written at memory.ts:83,
read back by `loadLesson` at memory.ts:310; schema requires it, memory.ts:47).

**RECOMMENDATION (preferred — matches generatorNotes "prefer keeping the pure fn operating on
whatever fields it is given and let the CLI assemble inputs"):**

Keep `pruneLessons` PURE and operating ONLY on fields it is handed. Have the CLI handler assemble
the recency input by calling `loadLesson(root, r.lessonId, ns)` for each index record to read its
`createdAt`, attach it as `PrunableLesson.createdAt` (see §1 type), and pass the enriched array in.
The pure fn computes decay from the `createdAt` it RECEIVES plus the injected `now` — it never
reads a file or the clock itself. This avoids touching the INDEX.md line format (no parser/build
change, no risk to round-trip + existing memory.ts tests) and keeps `pruneLessons` trivially testable
with object literals.

DO NOT add `lastSeen` to the INDEX line for P0 — it would force changes to `buildIndexLine`,
`parseIndexLine`, and `LessonIndexRecord`, risking the existing memory.ts/retrieve.ts test suite
for no benefit, since `createdAt` is already durably available per-lesson.

Concrete CLI assembly shape (in the new `prune` handler):
```ts
const records = await loadLessonIndex(root, { limit: Number.MAX_SAFE_INTEGER }, ns);
const enriched: PrunableLesson[] = [];
for (const r of records) {
  let createdAt: string | undefined;
  try { createdAt = (await loadLesson(root, r.lessonId, ns)).createdAt; } catch { /* file missing -> no recency */ }
  enriched.push({ ...r, createdAt });
}
const { kept, quarantined } = pruneLessons(enriched, { now: new Date().toISOString() });
```
`pruneLessons` must treat a missing `createdAt` deterministically (e.g. as "maximally stale" or
"unknown -> not stale-on-its-own"; pick one and document it). `now` is stamped at the handler
boundary exactly like distill.ts:76 does.

---

## 7. memory.ts target — `quarantinePath` + index-rewrite helper (create within modify)

### `src/state/memory.ts` (modify)

**Add `quarantinePath` next to `indexPath` (after line 41):**
```ts
const QUARANTINE_FILE = "QUARANTINE.md";   // add beside INDEX_FILE at line 11

export function quarantinePath(projectRoot: string, namespace?: string): string {
  return join(memoryDir(projectRoot, namespace), QUARANTINE_FILE);
}
```

**Add an exported line-level rewrite helper.** `appendLesson` (lines 240-249) already shows the
idiom: read INDEX.md, split on `\n`, filter blank lines, drop matching lines by leading
`"- <lessonId>"` token, rewrite with trailing `\n`:
```ts
const lines = existingContent.split("\n").filter((l) => l.trim().length > 0);
const filtered = lines.filter((l) => {
  const parts = l.split(" ");
  return !(parts[0] === "-" && parts[1] === lesson.lessonId);  // match by lessonId token
});
filtered.push(buildIndexLine(lesson));
await writeFile(idxPath, filtered.join("\n") + "\n", "utf-8");
```
Mirror this for the quarantine move: given a `Set<string>` of lessonIds to quarantine, read INDEX.md,
partition each non-blank line by whether `line.split(" ")[1]` is in the set, write the kept lines back
to INDEX.md (`filtered.join("\n") + "\n"`) and APPEND the moved literal lines to QUARANTINE.md
(create with `ensureDir` first). Provenance (sc-3-4): prepend/annotate each quarantined block with a
reason marker (e.g. a `<!-- quarantined: <reason> @ <now> -->` comment or a `(reason)` suffix) — keep
it deterministic given the injected `now`.

**Test file:** `src/state/memory.test.ts` (exists) — add round-trip tests for `quarantinePath` and
the rewrite helper if you put rewrite logic in memory.ts. Existing memory.test.ts imports at lines 6-14
must keep resolving (so keep `indexPath`/`lessonPath`/`memoryDir` exports unchanged).

---

## 8. Testing Patterns

### Unit / pure-fn test pattern
**Source:** `src/orchestrator/memory/reconcile.test.ts` (now-injection) and `retrieve.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
```
**Runner:** vitest. **Assertion style:** `expect(...).toEqual(...)` / `.toBe(...)` / `.toHaveLength(...)`.
**Mock approach:** for CLI handlers, `vi.spyOn(process.stdout, "write")` + `vi.spyOn(fsUtils, "findProjectRoot").mockResolvedValue(tmpDir)` (memory.test.ts:140-160). Pure fns need NO mocks — pass literals.
**File naming:** co-located `<name>.test.ts`. **Location:** beside the source file.

For hygiene.test.ts (pure): construct `PrunableLesson[]` literals directly — no tmpdir needed for the
partition/conflict tests. Inject a fixed `now` (e.g. `"2026-01-01T00:00:00.000Z"`) for determinism.

**Conflict test (sc-3-5) skeleton:**
```ts
it("quarantines BOTH lessons of a deterministically-detected contradictory pair", () => {
  const a = makeRec("l-a", { category: "sprint-rework", tags: ["sprintId:s1", "<keep-marker>"] });
  const b = makeRec("l-b", { category: "sprint-rework", tags: ["sprintId:s1", "<opposing-marker>"] });
  const { kept, quarantined } = pruneLessons([a, b], { now: NOW });
  expect(quarantined.map(r => r.lessonId).sort()).toEqual(["l-a", "l-b"]);
  expect(kept).not.toContainEqual(a);
});
```

### CLI subcommand test pattern (sc-3-4)
**Source:** `src/cli/commands/memory.test.ts:137-215` — `invokeDistill/List/Show` spy-and-parse helpers.
Add an `invokePrune()` that runs `["node","bober","memory","prune"]`, seed lessons via `appendLesson`,
then assert: INDEX.md line count shrank, QUARANTINE.md gained the moved lines + provenance, the
`<lessonId>.md` files still exist (`readFile(lessonPath(...))` resolves), and stdout contains the
kept/quarantined counts. Registration test at memory.test.ts:219-232 should be extended to expect
`"prune"` in `subNames`.

No E2E/Playwright in this repo for this area — N/A.

---

## 9. CLI `prune` subcommand — where it registers

### `src/cli/commands/memory.ts` (modify)
Add a fourth `memCmd.command("prune")` block AFTER the `show` block (after line 201, before the
closing `}` of `registerMemoryCommand` at line 202). Follow the EXACT distill handler skeleton
(lines 63-103): resolve root, `try { ns = await resolveDefaultNamespace(root); ... } catch { ...
process.exitCode = 1; }`, stamp `const now = new Date().toISOString();` at the boundary (line 76 idiom),
print a chalk summary, NEVER throw.

**Imports to ADD to the top import block (lines 13-29):** `pruneLessons` from
`../../orchestrator/memory/hygiene.js`, and from `../../state/memory.js` add `quarantinePath`,
`lessonPath` (and your rewrite helper) alongside the existing `{ appendLesson, loadLessonIndex,
loadLesson, memoryDir }`.

**Edge cases (must not throw):**
- Absent/empty INDEX.md → `loadLessonIndex` returns `[]` (memory.ts:266-269). Print a friendly
  gray message like the `list` handler does (memory.ts:117-119: `chalk.gray("No lessons found...")`)
  and `return` — do NOT create an empty QUARANTINE.md.
- Per-lesson `<lessonId>.md` files are NEVER deleted (sc-3-4) — only INDEX.md lines move.
- `loadLesson` may throw if a referenced `.md` is missing — wrap per-lesson recency reads in
  try/catch (see §6) so one bad file does not abort the prune.

**Summary output (sc-3-4):** mirror distill's green summary (memory.ts:92-94), e.g.
`chalk.green(\`pruned: \${kept.length} kept, \${quarantined.length} quarantined\n\`)`.

---

## 10. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/orchestrator/memory/retrieve.test.ts` | `retrieve.ts` (scoreRecord/sort) | medium | Tiebreak test (lines 99-107) + C1 empty-on-no-match must still pass; new comparator key is a no-op when occurrences equal |
| planner skill/agent (runtime) | `retrieveRelevantLessons` order | low | Ranking change is additive (only reorders equal-overlap ties) — return type unchanged |
| `src/state/memory.test.ts` | `indexPath/lessonPath/memoryDir/appendLesson` exports | medium | Keep existing exports + INDEX line format unchanged; only ADD `quarantinePath` + rewrite helper |
| `src/orchestrator/memory/reconcile.ts` | re-implements `tokenize` shape, references retrieve.ts:30-35 in a comment | low | Do not change `tokenize`; if you touch retrieve.ts tokenizer the comment at reconcile.ts:24 goes stale |
| `src/cli/commands/memory.test.ts` | `registerMemoryCommand` subcommand set | medium | Registration test asserts subcommand names — add `prune` and update the expectation |
| `src/cli/index.ts:311` | `registerMemoryCommand` | low | Already wired; new subcommand auto-registers, no change needed |

### Existing Tests That Must Still Pass
- `src/orchestrator/memory/retrieve.test.ts` — C1 (empty on non-match, lines 51-56), tiebreak by
  lessonId (99-107), namespace scoping (198-227), C2 source-inspection (113-126). The C2 test greps
  retrieve.ts source: do NOT add a `readFile` import or a `state/history` import to retrieve.ts.
- `src/state/memory.test.ts` — schema, append/upsert, loadLessonIndex round-trip. Index line format
  must remain byte-identical.
- `src/cli/commands/memory.test.ts` — distill/list/show handlers + registration set.
- `src/orchestrator/memory/distill.test.ts` — unaffected (you only READ distill's signature concepts).

### Features That Could Be Affected
- **Planner memory injection** — shares `retrieveRelevantLessons`. Verify the serialized planner
  block (serializeLessonsForPlanner, retrieve.ts:118) still renders; you are not changing it.
- **`bober memory distill/list/show`** — share `memory.ts` + the CLI file. Verify they still work
  after adding `quarantinePath`/`prune`.

### Recommended Regression Checks (run after implementation)
1. `npm run build` (exit 0) and `npm run typecheck` (zero errors) — sc-3-1.
2. `npm test -- retrieve hygiene memory` — covers all touched suites (evaluatorNotes).
3. `grep -nE "Date\.now|new Date\(" src/orchestrator/memory/hygiene.ts` → MUST print nothing — sc-3-3.
4. `npm run lint` on new/modified files (sc-3-6, non-required but expected).
5. Manual: in a temp dir, `appendLesson` a few lessons, run `node dist/cli/index.js memory prune`,
   confirm INDEX.md shrank, QUARANTINE.md gained provenance lines, `<lessonId>.md` files still exist,
   summary prints kept/quarantined counts; run `memory prune` with no INDEX.md → friendly no-throw message.

---

## 11. Implementation Sequence (dependency-ordered)

1. **`src/orchestrator/memory/retrieve.ts`** — add the occurrence comparator key to the existing sort
   (overlap DESC → occurrences DESC → lessonId ASC). Keep `scoreRecord` returning the integer overlap.
   - Verify: no `readFile`/`state/history` import added (C2 source test).
2. **`src/orchestrator/memory/retrieve.test.ts`** — add the equal-overlap occurrence-ordering test;
   keep all existing tests.
   - Verify: `npm test -- retrieve` green.
3. **`src/state/memory.ts`** — add `QUARANTINE_FILE` const + `quarantinePath` (beside `indexPath`)
   + an exported line-level index→quarantine rewrite helper (mirror appendLesson's filter idiom).
   - Verify: existing memory exports + INDEX line format unchanged; `npm test -- memory` (state) green.
4. **`src/orchestrator/memory/hygiene.ts`** — PURE `pruneLessons(records, { now, ... })` returning
   `{ kept, quarantined }`: conflict detection (same signature key + opposing markers → BOTH quarantined)
   then decay (occurrences + recency-from-injected-createdAt). Sort outputs by lessonId. No clock.
   - Verify: `grep -nE "Date\.now|new Date\(" hygiene.ts` empty.
5. **`src/orchestrator/memory/hygiene.test.ts`** — pure-fn tests: occurrence/recency partition +
   the conflict test (BOTH quarantined). Object literals, fixed `now`.
   - Verify: `npm test -- hygiene` green.
6. **`src/cli/commands/memory.ts`** — add the `prune` subcommand after `show`: resolve root+ns,
   assemble recency via `loadLesson`, stamp `now`, call `pruneLessons`, rewrite INDEX.md + append
   QUARANTINE.md with provenance, never delete `.md` files, print chalk summary, never throw.
   - Verify: empty-INDEX friendly message; extend registration test to include `prune`.
7. **Run full verification** — `npm run build`, `npm run typecheck`, `npm test -- retrieve hygiene memory`, `npm run lint`.

---

## 12. Pitfalls & Warnings

- **`tokenize` is PRIVATE to retrieve.ts (line 30) — not exported.** Do not try to import it into
  hygiene.ts. reconcile.ts re-implemented it on purpose (reconcile.ts:24-29). If hygiene needs
  normalization, inline a small local helper.
- **Do NOT fold occurrences into `scoreRecord`'s integer in a way that can ever beat one extra
  overlap token.** The C1 filter is `score > 0` and many tests assert exact overlap counts. The
  three-key comparator (overlap → occurrences → lessonId) is the safe choice — prefer it.
- **ESM `.js` specifiers are mandatory** on every relative import (e.g. `../../state/memory.js`),
  even importing a `.ts` file. Forgetting this breaks `npm run build`.
- **`new Date()`/`Date.now()` are FORBIDDEN inside hygiene.ts** — the evaluator greps for them
  (sc-3-3). Stamp `now` ONLY in the CLI handler (distill.ts:76 idiom).
- **Never delete `<lessonId>.md` files** during prune (sc-3-4) — only move INDEX.md lines.
- **INDEX.md line format is parsed by a strict regex** (memory.ts:114). If you re-serialize lines
  instead of moving the literal source text, ensure the `— ` (em-dash + space) separator and
  `(x<n>)` occurrence token are byte-exact, or `parseIndexLine` will drop them on next load.
- **Empty/absent INDEX.md must print a friendly message and return** (not throw, not create an empty
  QUARANTINE.md) — `loadLessonIndex` returns `[]` for absent files; branch on `records.length === 0`.
- **CLI handlers set `process.exitCode = 1` and return on error — they never throw** (memory.ts file
  header + every existing handler). The `prune` handler must follow this exactly.
- **Briefing assumes the comparator approach** for ranking. If a reviewer mandates score-folding,
  re-read the bounded-fraction note in §1 before implementing.
