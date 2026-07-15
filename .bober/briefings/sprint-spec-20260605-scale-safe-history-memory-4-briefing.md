# Sprint Briefing: Planner reads bounded memory (close the arc) + demonstrably-improves gate

**Contract:** sprint-spec-20260605-scale-safe-history-memory-4
**Generated:** 2026-06-05T00:00:00Z

---

## 0. Sprint Goal (one paragraph)

Create `src/orchestrator/memory/retrieve.ts` exporting **two pure functions**:
`retrieveRelevantLessons(projectRoot, keywords, { topK, charBudget })` (index-only, deterministic
tag/keyword overlap, stable lessonId tiebreak, returns top `topK`) and
`serializeLessonsForPlanner(records, { charBudget })` (compact block truncated to a char budget).
Then wire it into `skills/bober.plan/SKILL.md` Step 2 and `agents/bober-planner.md` Phase 1
(context gathering) with an **explicit prohibition on reading raw `.bober/history.jsonl`**, and
document the close-the-arc flow + the `findPrecisionIssues` A/B measure in
`docs/self-improvement-memory.md`. Add collocated `retrieve.test.ts`.

**Edit the canonical sources** `skills/bober.plan/SKILL.md` and `agents/bober-planner.md` — NOT the
distributed copies in `.claude/`. Those are synced later via `npm run update-all`.

---

## 1. Target Files

### `src/orchestrator/memory/retrieve.ts` (create)

**Directory pattern:** `src/orchestrator/memory/` currently holds `distill.ts` + `distill.test.ts`
(verified via `ls`). There is **no barrel/index.ts** in this dir — modules are imported directly by
path (e.g. `src/cli/commands/memory.ts:25` does `import { distill } from "../../orchestrator/memory/distill.js"`).
So `retrieve.ts` is imported by tests/wiring via the same direct-path style. No barrel to update.

**Most similar existing file:** `src/orchestrator/memory/distill.ts` — mirror its module style exactly:
- Top-of-file block comment stating PURE / no side effects (`distill.ts:1-7`)
- Box-drawing section headers: `// ── Constants ───` / `// ── Types ───` / `// ── Helpers ───` / `// ── Core ───` (`distill.ts:15,26,36,73`)
- `import type { LessonEntry } from "../../state/memory.js";` — ESM `.js` specifier + `import type` (`distill.ts:13`)
- Pure functions, deterministic, stable `lessonId.localeCompare` sort as the tiebreak (`distill.ts:198`)

**Required import (verified):**
```ts
import { loadLessonIndex } from "../../state/memory.js";
import type { LessonIndexRecord } from "../../state/memory.js";
```

**EXACT signature of `loadLessonIndex`** (`src/state/memory.ts:242-265`):
```ts
export async function loadLessonIndex(
  projectRoot: string,
  { limit }: { limit: number },
): Promise<LessonIndexRecord[]>
```
It reads ONLY `.bober/memory/INDEX.md` (`memory.ts:248`), returns `[]` if INDEX.md is missing
(`memory.ts:249-252`), and `.slice(-limit)` caps the result (`memory.ts:264`). It NEVER opens
`history.jsonl` and NEVER opens per-lesson files. **Calling `retrieveRelevantLessons` through
`loadLessonIndex` is what guarantees C2 (index-only).** Do not read any other file in retrieve.ts.

**EXACT shape of `LessonIndexRecord`** (`src/state/memory.ts:42-49`) — score against THESE field names:
```ts
export interface LessonIndexRecord {
  lessonId: string;        // stable sort tiebreak
  category: string;        // score against this
  severity: string;
  occurrences: number;
  tags: string[];          // score against this (primary overlap signal)
  summarySnippet: string;  // score against this
}
```
NOTE: the field is `summarySnippet` (NOT `summary`). `summary` only exists on the full `LessonEntry`
(`memory.ts:29-40`), which retrieve.ts must NOT load.

**Suggested structure skeleton (follow distill.ts conventions):**
```ts
/**
 * PURE deterministic, INDEX-ONLY retrieval of relevant lessons for the planner.
 *
 * Reads only the bounded .bober/memory/INDEX.md (via loadLessonIndex) — never history.jsonl,
 * never per-lesson files. Scoring is deterministic lowercased token overlap; ties break on lessonId.
 */
import { loadLessonIndex } from "../../state/memory.js";
import type { LessonIndexRecord } from "../../state/memory.js";

// ── Constants ───────────────────────────────────────────────────────
const DEFAULT_TOP_K = 5;
const DEFAULT_CHAR_BUDGET = 1200;        // see §7 — param default, NOT a config field
const INDEX_LOAD_LIMIT = 200;            // bounded read before scoring

// ── Helpers ──────────────────────────────────────────────────────────
function tokenize(s: string): string[] { /* lowercase, split on /[^a-z0-9]+/ , filter empty */ }
function scoreRecord(record: LessonIndexRecord, keywordTokens: Set<string>): number { /* count shared tokens across tags+category+summarySnippet */ }

// ── Core ─────────────────────────────────────────────────────────────
export async function retrieveRelevantLessons(
  projectRoot: string,
  keywords: string[],
  { topK = DEFAULT_TOP_K, charBudget }: { topK?: number; charBudget?: number } = {},
): Promise<LessonIndexRecord[]> {
  const records = await loadLessonIndex(projectRoot, { limit: INDEX_LOAD_LIMIT });
  const kw = new Set(keywords.flatMap(tokenize));
  const scored = records
    .map((r) => ({ r, score: scoreRecord(r, kw) }))
    .filter((x) => x.score > 0);                 // C1: non-matching keyword -> empty
  scored.sort((a, b) =>
    b.score - a.score || a.r.lessonId.localeCompare(b.r.lessonId),  // stable tiebreak
  );
  return scored.slice(0, topK).map((x) => x.r);
}

export function serializeLessonsForPlanner(
  records: LessonIndexRecord[],
  { charBudget = DEFAULT_CHAR_BUDGET }: { charBudget?: number } = {},
): string {
  // render compact block (one line per lesson), then truncate to charBudget chars
}
```
**Determinism rule (REQUIRED):** lowercase + tokenize before overlap; sort `score DESC`, then
`lessonId.localeCompare` ASC as the stable tiebreak (mirror `distill.ts:198`). Never use `Date.now()`
or any non-deterministic input — the test asserts byte-stable ordering.

---

### `src/orchestrator/memory/retrieve.test.ts` (create)

**Template:** mirror `src/state/memory.test.ts` (temp-project + `appendLesson` fixture) and
`src/orchestrator/memory/distill.test.ts` (determinism describe blocks). See §6 for the full template.

---

### `skills/bober.plan/SKILL.md` (modify) — Step 2

**Relevant section to extend (lines 71-85):**
```markdown
## Step 2: Gather Codebase Context

Read the following files if they exist (skip those that do not):

1. `bober.config.json` — project configuration
2. `CLAUDE.md` — project-level instructions and context
3. `package.json` — dependencies, scripts, project metadata
4. `tsconfig.json` — TypeScript configuration
5. Any files listed in `planner.contextFiles` from the config

Survey the project structure:
- Use Glob with patterns appropriate to the stack ...
- Use Grep to find key patterns ...
- Read `.bober/specs/` to check for existing plans
- Read `.bober/progress.md` to understand current project state
```
**Edit:** add a new numbered item (item 6) AND a "Learn from past sprints" sub-block. Required content
(C4 grep targets: must mention `retrieveRelevantLessons`, the memory **index**, the **topK** cap, and
the **history.jsonl prohibition**):
```markdown
6. **Learn from past sprint outcomes (bounded memory):** Load the distilled lessons index via
   `retrieveRelevantLessons(projectRoot, keywords, { topK })`, deriving `keywords` from the feature
   title/description. This reads ONLY the bounded `.bober/memory/INDEX.md` and returns at most
   `topK` deterministically-ranked lessons. **Do NOT read `.bober/history.jsonl` directly** — the raw
   history is unbounded and is intentionally off-limits to the planner. Use the returned lessons to
   avoid repeating past failure patterns when shaping sprints.
```

---

### `agents/bober-planner.md` (modify) — Phase 1: Context Gathering

**Relevant section to extend (lines 86-100), specifically after item 4 (lines 99-100):**
```markdown
### Phase 1: Context Gathering

1. **Read `bober.config.json`** ...
2. **Read `.bober/principles.md`** if it exists. ...
3. **Analyze existing codebase** (if brownfield or existing project): ...
4. **Read existing specs** in `.bober/specs/` to understand what has already been planned. ...
```
**Edit:** add item 5 with the SAME instruction + explicit history prohibition + topK cap:
```markdown
5. **Read the bounded lessons index (close the feedback arc).** Call
   `retrieveRelevantLessons(projectRoot, keywords, { topK })` with keywords derived from the feature
   title/description. This reads ONLY `.bober/memory/INDEX.md` (the distilled, bounded lessons index)
   and returns at most `topK` deterministically-ranked lessons. **You MUST NOT read
   `.bober/history.jsonl` directly** — only the bounded index is permitted. Fold the retrieved lessons
   into your planning so recurring failure patterns inform the new sprint contracts.
```

---

### `docs/self-improvement-memory.md` (create)

**Most similar existing doc:** `docs/providers.md` (`docs/providers.md:1-18`) — H1 title, intro
paragraph, `---` rules between sections, `##` section headers, fenced code blocks. Mirror that style.
**Must include (C6):**
- The **close-the-arc flow**: history.jsonl (Sprint 1 rotation) → `bober memory distill` CLI
  (Sprint 3, `src/cli/commands/memory.ts`) writes `.bober/memory/INDEX.md` (Sprint 2 store) →
  planner reads the bounded index via `retrieveRelevantLessons` at plan time (this sprint).
- The **A/B measure** naming the REAL symbol `findPrecisionIssues`
  (`src/contracts/sprint-contract.ts:242`), which returns `ContractPrecisionIssue[]` for banned vague
  phrases. Procedure: plan the SAME feature twice — once with `.bober/memory/INDEX.md` populated,
  once with it absent — and compare the **count** of `findPrecisionIssues` across the generated
  contracts. **Expected direction: FEWER precision issues when memory is present** (the planner learns
  from past lessons and writes tighter contracts).
- State this is a **manual** A/B procedure (C6 verificationMethod = manual; there is no automated A/B
  harness — describe the steps precisely).

---

## 2. Patterns to Follow

### Pure-module style (box headers, top block comment, ESM .js, import type)
**Source:** `src/orchestrator/memory/distill.ts`, lines 1-15
```ts
/**
 * PURE deterministic distillation of sprint history into LessonEntry records.
 * PURE — must not import from ../providers; no network, no Date.now(), no side effects.
 */
import { createHash } from "node:crypto";
import type { HistoryEntry } from "../../state/history.js";
import type { LessonEntry } from "../../state/memory.js";

// ── Constants ───────────────────────────────────────────────────────
```
**Rule:** retrieve.ts lives in the same dir — copy this header/comment/import-type style verbatim in spirit.

### Deterministic stable sort with tiebreak
**Source:** `src/orchestrator/memory/distill.ts`, line 198
```ts
lessons.sort((a, b) => a.lessonId.localeCompare(b.lessonId));
```
**Rule:** for retrieve, sort `b.score - a.score || a.lessonId.localeCompare(b.lessonId)` — score DESC, lessonId ASC tiebreak. Byte-stable.

### Index-only read (the C2 guarantee)
**Source:** `src/state/memory.ts`, lines 242-265
```ts
export async function loadLessonIndex(projectRoot, { limit }): Promise<LessonIndexRecord[]> {
  let content: string;
  try { content = await readFile(indexPath(projectRoot), "utf-8"); }
  catch { return []; }   // INDEX.md missing -> empty
  ...
  return records.slice(-limit);
}
```
**Rule:** retrieve.ts reaches the filesystem ONLY through `loadLessonIndex`. It must not call `readFile`/`history.ts` itself. This single dependency IS what makes C2 ("never reads history.jsonl") true by construction.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `loadLessonIndex` | `src/state/memory.ts:242` | `(projectRoot: string, { limit: number }) => Promise<LessonIndexRecord[]>` | Reads ONLY `.bober/memory/INDEX.md`, returns bounded records. USE THIS — do not parse INDEX.md yourself. |
| `LessonIndexRecord` (type) | `src/state/memory.ts:42` | `interface { lessonId; category; severity; occurrences; tags; summarySnippet }` | The record shape retrieve.ts scores and returns. Import as `import type`. |
| `loadLesson` | `src/state/memory.ts:272` | `(projectRoot, lessonId) => Promise<LessonEntry>` | Loads a FULL lesson file. **Do NOT call** — that would touch per-lesson files; retrieval is index-only. |
| `appendLesson` | `src/state/memory.ts:196` | `(projectRoot, lesson: LessonEntry) => Promise<void>` | Test-only: use in retrieve.test.ts to seed INDEX.md (same as memory.test.ts). |
| `findPrecisionIssues` | `src/contracts/sprint-contract.ts:242` | `(contract: SprintContract) => ContractPrecisionIssue[]` | The REAL A/B metric the doc must reference. Do not redefine; just cite in docs. |
| `distill` | `src/orchestrator/memory/distill.ts:88` | `(history, contracts) => LessonEntry[]` | Sprint 3's distiller. Style reference only; not imported by retrieve. |
| `ensureDir` | `src/state/helpers.js` (used `memory.ts:5`) | dir helper | Not needed in retrieve (read-only path). Listed so you don't recreate it. |

Utilities reviewed: `src/state/` (memory.ts, helpers.js), `src/orchestrator/memory/` (distill.ts),
`src/contracts/` (sprint-contract.ts). No generic `utils/`, `lib/`, `shared/`, or `common/` dir is
relevant to this read-only scoring task — string tokenization is trivial inline.

---

## 4. Prior Sprint Output

### Sprint 1: history rotation — `src/state/history.ts`
Added scale-safe rotation (`history.archive.jsonl`) + `HistorySectionSchema` (`src/config/schema.ts:325-329`, default `maxActiveLines: 2000`). **This sprint must NOT read history.ts/history.jsonl** — it is deliberately bounded away from the planner.

### Sprint 2: lessons store — `src/state/memory.ts`
Exports `loadLessonIndex` (USE), `loadLesson` (DO NOT use), `appendLesson` (test seeding only), `LessonIndexRecord` (import type), `LessonEntry`/`LessonEntrySchema`. INDEX.md line format defined by `buildIndexLine`/`parseIndexLine` (`memory.ts:85-120`).
**Connection:** retrieve.ts builds entirely on `loadLessonIndex` + `LessonIndexRecord`.

### Sprint 3: distill + CLI — `src/orchestrator/memory/distill.ts`, `src/cli/commands/memory.ts`
`bober memory distill|list|show` (registered in `src/cli/index.ts`) is what WRITES `.bober/memory/INDEX.md` from history. The doc's close-the-arc flow names this command as the producer the planner consumes.
**Connection:** retrieve.ts is the consumer end of distill's output; the doc must connect them.

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` found in repo root for this concern. (The contract's nonGoals ARE the governing constraints: planner-only, index-only, no embeddings, no auto-distill.)

### Architecture Decisions
No ADR specific to memory retrieval. The contract `nonGoals` (lines 53-58) are authoritative:
1. Do not feed lessons to generator/evaluator — planner only.
2. Do not read history.jsonl from the planner or retrieval path.
3. No embeddings/semantic search — deterministic tag/keyword overlap only.
4. No auto-distill — consume whatever `bober memory distill` last wrote.

### Other Docs
`docs/` contains `providers.md`, `observability-mcps/`, `PR-graph-telemetry-and-update-all.md`. Use
`docs/providers.md` (H1 + intro + `---` + `##` + fenced blocks) as the style template for the new doc.

---

## 6. Testing Patterns

### Unit Test Pattern (temp-project + appendLesson seeding)
**Source:** `src/state/memory.test.ts:14-40` and `src/orchestrator/memory/distill.test.ts:9-18`
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLesson } from "../../state/memory.js";
import type { LessonEntry } from "../../state/memory.js";
import { retrieveRelevantLessons, serializeLessonsForPlanner } from "./retrieve.js";

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-retrieve-test-"));
  await mkdir(join(tmpDir, ".bober"), { recursive: true });   // do NOT create history.jsonl
});
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

function makeLesson(id: string, overrides: Partial<LessonEntry> = {}): LessonEntry {
  return {
    lessonId: id,
    createdAt: new Date().toISOString(),
    category: "eval-fail",
    tags: ["unit", "state"],
    summary: `Lesson ${id}: a concise summary of the observed pattern`,
    occurrences: 1,
    severity: "warn",
    sourceEntryRefs: ["history.jsonl#42"],
    ...overrides,
  };
}
```
**Runner:** vitest. **Assertion style:** `expect()`. **Mock approach:** `vi.spyOn` (see C2 below).
**File naming:** `retrieve.test.ts` (collocated next to `retrieve.ts`). **Location:** collocated.

**C1 — topK cap + match + non-match:**
```ts
it("caps at topK and surfaces a matching lesson", async () => {
  await appendLesson(tmpDir, makeLesson("l-auth", { tags: ["auth", "login"] }));
  await appendLesson(tmpDir, makeLesson("l-db",   { tags: ["database"] }));
  await appendLesson(tmpDir, makeLesson("l-ui",   { tags: ["ui"] }));
  const out = await retrieveRelevantLessons(tmpDir, ["auth"], { topK: 1 });
  expect(out).toHaveLength(1);
  expect(out[0]!.lessonId).toBe("l-auth");
});
it("returns empty for a non-matching keyword", async () => {
  await appendLesson(tmpDir, makeLesson("l-auth", { tags: ["auth"] }));
  const out = await retrieveRelevantLessons(tmpDir, ["zzz-nonexistent"], { topK: 5 });
  expect(out).toEqual([]);
});
```

**C2 — never reads history.jsonl (path assertion via spy):**
```ts
import * as fsp from "node:fs/promises";
it("never reads .bober/history.jsonl during retrieval", async () => {
  await appendLesson(tmpDir, makeLesson("l-x", { tags: ["auth"] }));
  const spy = vi.spyOn(fsp, "readFile");
  await retrieveRelevantLessons(tmpDir, ["auth"], { topK: 5 });
  const paths = spy.mock.calls.map((c) => String(c[0]));
  expect(paths.some((p) => p.includes("history.jsonl"))).toBe(false);
  expect(paths.some((p) => p.endsWith(join(".bober", "memory", "INDEX.md")))).toBe(true);
  spy.mockRestore();
});
```
NOTE: `memory.ts` imports `readFile` via `import { readFile } from "node:fs/promises"`. Spying on the
`node:fs/promises` module export works because the import binding resolves to the same module object.
Belt-and-suspenders: the temp project never creates `history.jsonl`, so even a stray read would ENOENT.

**C3 — serialized block respects topK AND charBudget:**
```ts
it("serialized block respects topK and the character budget", async () => {
  for (let i = 0; i < 10; i++)
    await appendLesson(tmpDir, makeLesson(`l-${i}`, { tags: ["auth"], summary: "x".repeat(300) }));
  const recs = await retrieveRelevantLessons(tmpDir, ["auth"], { topK: 3 });
  expect(recs.length).toBeLessThanOrEqual(3);
  const block = serializeLessonsForPlanner(recs, { charBudget: 200 });
  expect(block.length).toBeLessThanOrEqual(200);
});
```

**C4 — grep/string assertion on the skill + agent (a unit test reading the markdown):**
```ts
it("planner skill + agent reference the memory index, topK, and forbid history.jsonl", async () => {
  const skill = await readFile(new URL("../../../skills/bober.plan/SKILL.md", import.meta.url), "utf-8");
  const agent = await readFile(new URL("../../../agents/bober-planner.md", import.meta.url), "utf-8");
  for (const text of [skill, agent]) {
    expect(text).toContain("retrieveRelevantLessons");
    expect(text).toMatch(/topK/);
    expect(text).toMatch(/history\.jsonl/);   // appears in the prohibition sentence
  }
});
```
Verify the relative URL depth from `src/orchestrator/memory/` to repo root: `../../../` reaches root
(memory → orchestrator → src → root). Confirm with the actual computed path; if the test runs from
`src/orchestrator/memory/retrieve.test.ts`, `new URL("../../../skills/...", import.meta.url)` resolves
correctly. Alternatively read via `join(process.cwd(), "skills", ...)` since vitest runs from repo root.

### E2E Test Pattern
Not applicable — no Playwright config; this is a CLI/library sprint.

---

## 7. Config vs Param for `charBudget` (C3 clarification)

**Recommendation: use a PARAM with a sensible default constant — do NOT add a config schema field.**

Rationale:
- `generatorNotes` passes `{ topK, charBudget }` as **function params** (contract line 74), and C3 says
  "a configured character budget" — satisfied by a documented default constant + caller override.
- The `stopConditions` confine changes to `src/orchestrator/memory/`, the skill, the agent, docs, and
  tests (contract line 61). Adding a field to `src/config/schema.ts:325` would put the diff OUTSIDE the
  allowed surface and require loader/defaults plumbing — unnecessary scope.
- Precedent: `HistorySectionSchema` (`src/config/schema.ts:325-329`) holds a single rotation knob; the
  retrieval budget is a call-site concern, not a persisted project setting. Keep it a `DEFAULT_CHAR_BUDGET`
  constant in `retrieve.ts` plus a `topK`/`charBudget` param. The test exercises both caps via params,
  fully satisfying C3 without touching config.

If a future need arises, a `memory: { charBudget }` schema section can be added then — note it in the
doc as a deliberate deferral, but do NOT build it now.

---

## 8. Impact Analysis — Affected Files, Tests & Features

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| (new) `retrieve.ts` | `loadLessonIndex`, `LessonIndexRecord` (`src/state/memory.ts`) | low | memory.ts is unchanged; pure consumer. |
| `skills/bober.plan/SKILL.md` | additive Step 2 edit | low | Insert item 6; do not renumber/break Steps 3-8. |
| `agents/bober-planner.md` | additive Phase 1 edit | low | Insert item 5; do not disturb IRON LAW / Phase 2+. |
| `.claude/commands/bober-plan.md`, `.claude/agents/bober-planner.md` | distributed copies | n/a | **DO NOT EDIT** — synced later via `npm run update-all`. |

### Existing Tests That Must Still Pass
- `src/state/memory.test.ts` — tests `loadLessonIndex`/`appendLesson`/`loadLesson`; retrieve.ts does
  not modify memory.ts, so these stay green. Verify still passes after changes.
- `src/orchestrator/memory/distill.test.ts` — tests `distill`; untouched. Verify still passes.
- `src/contracts/sprint-contract.test.ts:185` — tests `findPrecisionIssues`; doc-only reference, no
  code change. Verify still passes.

### Features That Could Be Affected
- **Planner pipeline** (`bober.plan` skill + `bober-planner` agent) — shares the two markdown files.
  The edits are additive context-gathering steps; verify the HARD-GATE (SKILL.md:155) and IRON LAW
  (bober-planner.md:59) blocks are NOT disturbed.
- **`bober memory distill` CLI** (Sprint 3) — produces the INDEX.md this sprint consumes; no code
  change, but the doc must describe the producer→consumer arc.

### Recommended Regression Checks (run after implementation)
1. `npm run typecheck` — exits 0 (C5).
2. `npm run build` — exits 0 (C5).
3. `npx vitest run src/orchestrator/memory/retrieve.test.ts` — new tests pass.
4. `npx vitest run src/state/memory.test.ts src/orchestrator/memory/distill.test.ts` — unchanged tests pass.
5. `grep -c "retrieveRelevantLessons" skills/bober.plan/SKILL.md agents/bober-planner.md` — both > 0 (C4).
6. `grep "history.jsonl" skills/bober.plan/SKILL.md agents/bober-planner.md` — prohibition present (C4).
7. `grep "findPrecisionIssues" docs/self-improvement-memory.md` — metric named (C6).
8. `git status` — diff confined to `src/orchestrator/memory/`, the skill, the agent, `docs/`, tests.

---

## 9. Implementation Sequence

1. **`src/orchestrator/memory/retrieve.ts`** — implement `tokenize`, `scoreRecord`,
   `retrieveRelevantLessons`, `serializeLessonsForPlanner`. Import only from `../../state/memory.js`.
   - Verify: `npm run typecheck` clean; `loadLessonIndex` is the only fs access.
2. **`src/orchestrator/memory/retrieve.test.ts`** — write C1/C2/C3/C4 tests (§6 templates).
   - Verify: `npx vitest run src/orchestrator/memory/retrieve.test.ts` green.
3. **`skills/bober.plan/SKILL.md`** — add Step 2 item 6 (retrieveRelevantLessons + topK + history prohibition).
   - Verify: grep finds `retrieveRelevantLessons`, `topK`, `history.jsonl`.
4. **`agents/bober-planner.md`** — add Phase 1 item 5 (same instruction).
   - Verify: grep finds the three markers.
5. **`docs/self-improvement-memory.md`** — write close-the-arc flow + `findPrecisionIssues` A/B
   (expected direction: fewer precision issues WITH memory). Mirror `docs/providers.md` style.
   - Verify: grep finds `findPrecisionIssues`; doc states the direction.
6. **Run full verification** — `npm run typecheck`, `npm run build`,
   `npx vitest run src/orchestrator/memory/ src/state/memory.test.ts`, then the §8 regression greps.

---

## 10. Pitfalls & Warnings

- **EDIT CANONICAL SOURCES ONLY.** `skills/bober.plan/SKILL.md` and `agents/bober-planner.md` are the
  targets. `.claude/commands/bober-plan.md` and `.claude/agents/bober-planner.md` are DISTRIBUTED
  COPIES — editing them is out of scope and will be synced over by `npm run update-all`.
- **Field name is `summarySnippet`, NOT `summary`.** `LessonIndexRecord` (`memory.ts:42-49`) has
  `summarySnippet`; only the full `LessonEntry` has `summary`. Scoring `record.summary` will not compile.
- **Do NOT call `loadLesson`.** That opens per-lesson `.md` files and breaks the index-only invariant
  (C2). Stay on `loadLessonIndex`.
- **Do NOT read `history.jsonl` or import `src/state/history.ts`** from retrieve.ts (nonGoals line 55).
- **Do NOT add a config schema field for charBudget** (§7) — it pushes the diff outside the allowed
  surface (stopConditions line 61). Use a default constant + param.
- **Determinism:** no `Date.now()`/`new Date()` in retrieve.ts. Lowercase-tokenize before overlap;
  sort `score DESC, lessonId ASC`. The C1/C3 tests assume stable ordering.
- **Empty result on no match:** filter out score-0 records so a non-matching keyword returns `[]` (C1).
- **`retrieveRelevantLessons` is async** (it awaits `loadLessonIndex`); `serializeLessonsForPlanner`
  is sync (operates on already-loaded records). Keep that split — the test calls them separately.
- **No barrel file** in `src/orchestrator/memory/` — import retrieve.ts by direct `./retrieve.js` path
  (mirror how `memory.ts:25` imports distill). Do not create an index.ts.
- **charBudget truncation must be a hard slice** (e.g. `block.slice(0, charBudget)`), so the C3
  assertion `block.length <= charBudget` holds even when many long summaries are concatenated.
