# Sprint Briefing: Deterministic lessons memory store (LessonEntry schema + .bober/memory state module)

**Contract:** sprint-spec-20260605-scale-safe-history-memory-2
**Generated:** 2026-06-05T00:00:00Z

> Scope (from contract): schema + persistence + bounded read ONLY. No distillation, no LLM/network, no CLI, no planner wiring, no history.jsonl reads. Changes confined to `src/state/memory.ts` and `src/state/memory.test.ts`. This is greenfield/additive — nothing imports a memory module yet (grep confirmed: NONE).

---

## 1. Target Files

### src/state/memory.ts (create)

**Directory pattern:** Files in `src/state/` are kebab-case `*.ts` state modules. Each one defines private `const DIR_NAME` constants + path-helper functions, calls `ensureDir` before writes, uses `node:fs/promises` (NO sync fs), validates with a zod schema + `safeParse`, and skips malformed input rather than throwing on read. See `src/state/history.ts`, `src/state/architect-state.ts`, `src/state/research-state.ts`.

**Most similar existing file:** `src/state/history.ts` — the contract explicitly says mirror it (assumptions[1], generatorNotes). It is the canonical "state module" pattern: constants → path helpers → zod schema + type → parse helper (skip-malformed) → append op (ensureDir + safeParse + fs write) → bounded read op.

**Structure template (modeled on `src/state/history.ts:1-150`):**
```ts
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { ensureDir } from "./helpers.js";   // NOT ../utils/fs.js — state modules use the local helper

// ── Constants ───────────────────────────────────────────────────────
const BOBER_DIR = ".bober";
const MEMORY_DIR = "memory";
const INDEX_FILE = "INDEX.md";

// ── Path helpers ────────────────────────────────────────────────────
function memoryDir(projectRoot: string): string {
  return join(projectRoot, BOBER_DIR, MEMORY_DIR);
}
function lessonPath(projectRoot: string, lessonId: string): string {
  return join(memoryDir(projectRoot), `${lessonId}.md`);
}
function indexPath(projectRoot: string): string {
  return join(memoryDir(projectRoot), INDEX_FILE);
}

// ── LessonEntry schema ──────────────────────────────────────────────
export const LessonEntrySchema = z.object({ /* see Pattern §2 + generatorNotes */ });
export type LessonEntry = z.infer<typeof LessonEntrySchema>;

// ── Persistence ─────────────────────────────────────────────────────
export async function appendLesson(projectRoot: string, lesson: LessonEntry): Promise<void> { /* ... */ }
export async function loadLessonIndex(projectRoot: string, opts: { limit: number }): Promise<LessonIndexRecord[]> { /* ... */ }
export async function loadLesson(projectRoot: string, lessonId: string): Promise<LessonEntry> { /* ... */ }
```

**Imports this file will use:**
- `readFile, writeFile, appendFile` (or just `readFile, writeFile`) from `node:fs/promises`
- `join` from `node:path`
- `z` from `zod`
- `ensureDir` from `./helpers.js`  ← see §3, this is the in-`state/` helper history.ts uses

**Imported by:** Nobody yet (greenfield). Do NOT touch `src/state/index.ts` — the contract restricts the diff to `memory.ts` + its test. (If you add a barrel export it widens the diff beyond stopConditions; leave it out unless you confirm it is permitted. The evaluator will "confirm git diff is confined to src/state/memory.ts and its test.")

**Test file:** `src/state/memory.test.ts` (create — see §6).

### src/state/memory.test.ts (create)

**Most similar existing file:** `src/state/history.test.ts` — real-fs `mkdtemp` fixture, no fs mocks, `describe`/`it`/`expect` per criterion. Mirror it (see §6).

---

## 2. Patterns to Follow

### Zod schema + inferred type + named export
**Source:** `src/state/history.ts:38-45`
```ts
export const HistoryEntrySchema = z.object({
  timestamp: z.string().datetime(),
  event: z.string().min(1),
  phase: PhaseSchema,
  sprintId: z.string().optional(),
  details: z.record(z.string(), z.unknown()),
});
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;
```
**Rule:** Define `LessonEntrySchema` with `z.object`, export it AND the inferred type. Use the exact shape from generatorNotes:
`lessonId: z.string().min(1)`, `createdAt: z.string().datetime()`, `category: z.string().min(1)`, `tags: z.array(z.string()).default([])`, `summary: z.string().min(1)`, `occurrences: z.number().int().positive()`, `severity: z.enum(["info","warn","high"])`, `sourceEntryRefs: z.array(z.string().min(1)).min(1)`. The `.min(1)` on `sourceEntryRefs` is the load-bearing provenance invariant (C1/C4 — empty array must be REJECTED). Note `z.string().datetime()` is the house pattern for ISO timestamps (history.ts:39).

### safeParse on write (reject invalid before persisting)
**Source:** `src/state/history.ts:87-93`
```ts
const validation = HistoryEntrySchema.safeParse(entry);
if (!validation.success) {
  const issues = validation.error.issues
    .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  throw new Error(`Invalid history entry:\n${issues}`);
}
```
**Rule:** In `appendLesson`, `safeParse` the lesson first; throw a formatted error on failure. This guarantees no lesson with an empty `sourceEntryRefs` is ever written (defense beyond the schema). For `loadLesson`, `safeParse` after parsing the file and throw if invalid (round-trip integrity, C4).

### ensureDir before any write
**Source:** `src/state/history.ts:84-85` and `src/state/architect-state.ts:31`
```ts
const boberDir = join(projectRoot, BOBER_DIR);
await ensureDir(boberDir);
```
**Rule:** Call `await ensureDir(memoryDir(projectRoot))` at the top of `appendLesson` before writing `<id>.md` or `INDEX.md`. `ensureDir` is `mkdir(path, { recursive: true })` so calling it on the memory dir creates `.bober/memory/` in one shot.

### Read that tolerates a missing file (ENOENT → empty)
**Source:** `src/state/history.ts:139-145` (loadRecentHistory) and `:118-124` (loadHistory)
```ts
let activeContent: string;
try {
  activeContent = await readFile(historyPath(projectRoot), "utf-8");
} catch {
  // Active file does not exist yet
  return [];
}
```
**Rule:** `loadLessonIndex` must return `[]` when `INDEX.md` does not exist (catch the read error). Do NOT let a missing index throw.

### Skip-malformed line parsing
**Source:** `src/state/history.ts:53-70`
```ts
function parseEntries(content: string): HistoryEntry[] {
  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  const entries: HistoryEntry[] = [];
  for (const line of lines) {
    try {
      const parsed: unknown = JSON.parse(line);
      const result = HistoryEntrySchema.safeParse(parsed);
      if (result.success) entries.push(result.data);
    } catch { /* Skip malformed lines */ }
  }
  return entries;
}
```
**Rule:** Parse `INDEX.md` line-by-line with `content.split("\n").filter((l) => l.trim().length > 0)`; skip any line that does not match your index-line format rather than throwing. Each INDEX line is a lightweight record `{ lessonId, category, severity, occurrences, tags, summarySnippet }` — NOT a full `LessonEntry` (C3: index read never opens per-lesson files).

### Bounded tail read (return last N)
**Source:** `src/state/history.ts:147-149`
```ts
const entries = parseEntries(activeContent);
// Return the newest `limit` entries (tail of the array), preserving ascending order
return entries.slice(-limit);
```
**Rule:** `loadLessonIndex(projectRoot, { limit })` returns `records.slice(-limit)` — the last `limit` parsed INDEX records. Mirror the `{ limit }` destructured-options signature exactly (history.ts:135-138).

### YAML front-matter: hand-rolled (NO `yaml` package in deps)
**There is no `yaml`/`gray-matter` dependency** (`package.json` deps: @anthropic-ai/sdk, @modelcontextprotocol/sdk, chalk, commander, execa, glob, ora, prompts, semver, zod). Front-matter must be written and parsed by hand. Two in-repo precedents to mirror — prefer the regex split in `agent-loader.ts` for the body/meta split:

**Source (body/meta split):** `src/orchestrator/agent-loader.ts:38-43`
```ts
const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
if (!match) {
  return { meta: {}, body: raw };
}
const [, yamlBlock, body] = match;
```
**Source (line-based fence detection):** `src/incident/playbook-search.ts:88-101` — start must be `---`, scan for the closing `---`, slice the lines between.

**Rule:** Write `<id>.md` as `---\n<key: value lines + list blocks>\n---\n\n<human-readable body>`. To round-trip in `loadLesson`, split on the `^---\n...\n---\n` regex, parse the simple `key: value` scalars and `key:\n  - item` list blocks (for `tags` and `sourceEntryRefs`), reconstruct the object, then `LessonEntrySchema.safeParse`. Keep the front-matter scalar-and-list shape simple — you control both the writer and reader, so pick a serialization you can parse back losslessly (e.g. JSON-encode the structured fields in front-matter values, or use the simple `key: value` + `  - item` block format the two precedents handle). Booleans/numbers come back as strings — coerce `occurrences` with `Number(...)` and let zod re-validate.

### INDEX.md curated-index line format (mirror MEMORY.md)
**Source (MEMORY.md curated index this sprint mirrors):** `~/.claude/projects/.../memory/MEMORY.md` line format is `- [<id>](<file>) — <one-line summary>` (em-dash `—` separator, one line per entry, the index NEVER inlines the full body — the body lives in the linked file). The contract's generatorNotes specify the lesson-store variant:
```
- <lessonId> [<category>/<severity>] (x<occurrences>) tags: a,b — <summary first 80 chars>
```
**Rule:** Emit exactly this shape (em-dash `—` U+2014 before the snippet, `tags:` comma-joined). When parsing back in `loadLessonIndex`, extract `lessonId`, `category`, `severity`, `occurrences`, `tags`, `summarySnippet` from the line. The whole point of C3 is that this one line carries enough to render an index WITHOUT opening `<id>.md`.

### Upsert one INDEX line per lessonId (replace-or-append, never duplicate)
**Rule (from generatorNotes; no exact in-repo precedent — this is new logic):** read `INDEX.md` (ENOENT → empty), split into non-empty lines, filter OUT any existing line whose `lessonId` matches, push the freshly-built line, rewrite the whole file with `writeFile`. This guarantees C2's invariant: repeated `appendLesson` of the same `lessonId` keeps INDEX.md at exactly one line for that id. Match the id by parsing the leading `- <lessonId> ` token, not a substring contains (avoid `lesson-1` matching `lesson-12`).

### Box-drawing section headers
**Source:** `src/state/history.ts:10`, `src/state/history-rotation.ts:1,31,45`, `.bober/principles.md:32`
```ts
// ── Constants ───────────────────────────────────────────────────────
```
**Rule:** Use `// ── Section Name ──────` unicode box-drawing headers to divide the module (Constants / Path helpers / Schema / Persistence / Read). Principles §"Section comments" mandates this.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `ensureDir` | `src/state/helpers.ts:6` | `(dirPath: string): Promise<void>` | `mkdir(path, { recursive: true })`. **Use the `./helpers.js` one** — history.ts/architect-state.ts/research-state.ts all import it from there, NOT from `../utils/fs.js`. |
| `ensureDir` (alt) | `src/utils/fs.ts:45` | `(path: string): Promise<void>` | Duplicate in utils — same behavior. State modules use the `helpers.ts` copy; stay consistent with that. |
| `fileExists` | `src/utils/fs.ts:10` | `(path: string): Promise<boolean>` | Async `access(path, R_OK)` existence check. Available if you want an explicit "exists" check, but the house read pattern is try/catch on `readFile` (history.ts:139). |
| `readJson<T>` | `src/utils/fs.ts:24` | `(path: string): Promise<T>` | Read+`JSON.parse`. NOT for this sprint — lessons are markdown, not JSON. |
| `writeJson` | `src/utils/fs.ts:34` | `(path, data): Promise<void>` | Pretty JSON write + auto ensureDir. NOT for this sprint — lessons are `.md`. |
| `findProjectRoot` | `src/utils/fs.ts:58` | `(startDir?): Promise<string | null>` | Walk up to project root. Not needed — `projectRoot` is passed in. |
| `parseFrontmatter` | `src/orchestrator/agent-loader.ts:34` | `(raw): { meta, body }` | **Private** (not exported). Do NOT import — it is module-local. Copy/adapt the regex `^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$` pattern inline. |
| `parseFrontmatter` | `src/incident/playbook-search.ts:88` | `(content): ParsedFrontmatter | null` | **Private**, hardcoded to playbook keys. Do NOT import. Reference for the line-based fence-scan approach. |

**Utilities reviewed:** `src/utils/` (fs.ts, git.ts, logger.ts, index.ts), `src/state/helpers.ts`. There is no `lib/`, `shared/`, or `common/` directory. No existing markdown front-matter writer/reader is exported anywhere — you must write `<id>.md` serialization + a local parser. Reuse `ensureDir` from `./helpers.js`; reuse `node:fs/promises` directly for read/write/append (the house pattern, history.ts:1).

---

## 4. Prior Sprint Output

### Sprint 1 (PASSED): Bounded history reads + crash-safe rotation
**Created:** `src/state/history-rotation.ts` — exports `rotateIfNeeded`, `historyActivePath`, `historyArchivePath`.
**Modified:** `src/state/history.ts` — added `loadRecentHistory(projectRoot, { limit })` and archive-concat in `loadHistory`.
**Connection to this sprint:** None at runtime — Sprint 2 does NOT read or import history (nonGoals[3]: "Do not read or modify history.jsonl"). The connection is purely *stylistic*: `history.ts` is the canonical state-module template you mirror (path helpers, `{ limit }` bounded-read signature, skip-malformed parsing, box-drawing headers, ensureDir-before-write). The `{ limit }` destructured options signature on `loadRecentHistory` (history.ts:135-138) is the exact shape `loadLessonIndex` should copy.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM everywhere** — all imports use `.js` specifiers for NodeNext (principles:27). `import { ensureDir } from "./helpers.js"`.
- **Zod for validation, no hand-rolled validation** (principles:29). Use `LessonEntrySchema.safeParse`.
- **Filesystem state, no DB / no in-memory globals** (principles:31). Lessons are files in `.bober/memory/`.
- **Section comments** — unicode box-drawing headers `// ── Section ──` (principles:32).
- **`import type { ... }`** — ESLint `consistent-type-imports` is enforced; the `type` keyword is required for type-only imports (principles:35). Export `LessonEntry` as a type alias and import it with `import type` anywhere it is type-only.
- **Prefix unused params with `_`** (principles:36).
- **Type safety is a hard gate** — strict mode with `noUnusedLocals`/`noUnusedParameters` (principles:18). No unused imports/vars or build fails.
- **Conventional commit:** `bober(sprint-2): deterministic lessons memory store` (generatorNotes + principles:34).

### Spec techNotes (`spec-...json`)
- `dataModel`: `LessonEntry { lessonId, createdAt, category, tags: string[], summary, occurrences: positive int, severity: enum, sourceEntryRefs: non-empty string[] }` persisted as `.bober/memory/<lessonId>.md` (front-matter + body) with bounded `.bober/memory/INDEX.md` (one line per lesson). Matches the contract schema exactly.
- `existingPatterns`: "Mirror `src/state/history.ts` module style (path helpers, zod schema + safeParse, append-only file ops). Collocate `*.test.ts` with Vitest. ESM with `.js` import specifiers. Unicode box-drawing section headers."
- `feat-2` AC: AC1 (`<id>.md` + exactly one INDEX line upsert), AC2 (empty `sourceEntryRefs` rejected), AC3 (`loadLessonIndex` capped, opens no per-lesson file).

### Architecture
ADRs in `.bober/architecture/` are for prior OpenHands-fork / IDE-shell plans — none address the memory store. No ADR governs this sprint.

---

## 6. Testing Patterns

### Unit Test Pattern
**Source:** `src/state/history.test.ts:1-31`
```ts
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { appendHistory, loadHistory, loadRecentHistory } from "./history.js";
import type { HistoryEntry } from "./history.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-history-test-"));
  await mkdir(join(tmpDir, ".bober"), { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeEntry(i: number): HistoryEntry {
  return { timestamp: new Date().toISOString(), event: `event-${i}`, phase: "generating", details: { index: i } };
}
```
**Runner:** vitest (`npm run test` = `vitest`).
**Assertion style:** `expect(x).toBe(...)`, `.toHaveLength(...)`, `.toContain(...)`.
**Mock approach:** NONE for this module — real-fs `mkdtemp` temp project, no fs mocks. (Mocks of `node:fs/promises` exist elsewhere e.g. `agent-loader.test.ts:16` but the state-module house style is real-fs temp dirs.)
**File naming:** `memory.test.ts` collocated next to `memory.ts`.
**Location:** co-located in `src/state/`.
**Fixture builder:** add a `makeLesson(id, overrides?)` helper returning a valid `LessonEntry` with a non-empty `sourceEntryRefs` (e.g. `["history.jsonl#42"]`), `severity: "warn"`, `occurrences: 1`, mirroring `makeEntry`.

### Mapping success criteria → tests
- **C1 schema:** `expect(LessonEntrySchema.safeParse(validLesson).success).toBe(true)` and `expect(LessonEntrySchema.safeParse({ ...validLesson, sourceEntryRefs: [] }).success).toBe(false)`.
- **C2 persist + single upsert:** `await appendLesson(tmpDir, l)`; assert `lessonPath`/`<id>.md` and `INDEX.md` exist (read them); append the SAME lessonId twice; read `INDEX.md`, split non-empty lines, filter to lines starting `- <id> `, assert exactly 1.
- **C3 bounded, index-only:** append N lessons, `loadLessonIndex(tmpDir, { limit: 2 })` returns ≤2. **Prove it opens no per-lesson file** by the cleanest house-style technique: after appending, `await rm(lessonPath(tmpDir, "<id>"), { force: true })` to delete a `<id>.md`, then assert `loadLessonIndex(tmpDir, { limit: 10 })` STILL succeeds and includes that id's record (it only read INDEX.md). This uses the same real-fs `rm` already imported in the fixture — no spy needed. (Spy alternative: `vi.spyOn` on `node:fs/promises.readFile` and assert it was called only with the INDEX path — but the delete-then-load approach is simpler and matches the no-mock house style.)
- **C4 round-trip + provenance:** `await appendLesson(tmpDir, l)`; `const back = await loadLesson(tmpDir, l.lessonId)`; `expect(back).toEqual(l)` and `expect(back.sourceEntryRefs.length).toBeGreaterThan(0)`.

### E2E Test Pattern
Not applicable — no Playwright in this repo for this layer; this is a pure node/state module.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| (none) | `src/state/memory.ts` | none | Greenfield — grep for `state/memory`, `appendLesson`, `loadLessonIndex`, `loadLesson`, `LessonEntry`, `memoryDir` returned NONE. No file imports the memory module yet. |
| `src/state/index.ts` | — | low | The barrel does NOT export memory and you should NOT add it (keeps diff confined per stopConditions). Leaving it untouched = zero risk. |

### Existing Tests That Must Still Pass
- `src/state/history.test.ts` — covers Sprint 1 (loadRecentHistory cap, rotation, crash-safety). Unaffected (you don't touch history.ts), but it lives in the same dir; running `vitest src/state` must stay green.
- Full suite via `npm run test` — must show no NEW failures beyond the documented flaky baseline (C5). Run the whole suite once before finishing to spot any unexpected regression.

### Features That Could Be Affected
- **feat-3 (next sprint, distillation + CLI)** — will import `appendLesson` and `LessonEntry` from this module. Keep the public API clean and stable: `LessonEntrySchema`, `LessonEntry`, `appendLesson`, `loadLessonIndex`, `loadLesson`. Do NOT add distill/CLI here (nonGoals).
- **feat-4 (planner retrieval)** — will call `loadLessonIndex` and rank by tags/keywords. Ensure the index record carries `tags` and `summarySnippet` so feat-4 can rank index-only without opening lesson files.

### Recommended Regression Checks
1. `npm run typecheck` → exit 0 (strict mode; no unused imports/vars, `import type` for type-only).
2. `npm run build` → exit 0 (`tsc`).
3. `npx vitest run src/state/memory.test.ts` → all new tests pass.
4. `npm run test` (full) → no new failures beyond the documented flaky baseline.
5. `git diff --name-only` → only `src/state/memory.ts` + `src/state/memory.test.ts` (evaluator will confirm this).

---

## 8. Implementation Sequence

1. **Schema** — define `LessonEntrySchema` (z.object per generatorNotes) + `export type LessonEntry`. Add a `LessonIndexRecord` type `{ lessonId, category, severity, occurrences, tags, summarySnippet }` for the bounded read.
   - Verify: `LessonEntrySchema.safeParse(valid)` succeeds; `{ ...valid, sourceEntryRefs: [] }` fails (C1).
2. **Path helpers** — `memoryDir`, `lessonPath`, `indexPath` (all private, `join(projectRoot, ".bober", "memory", ...)`).
   - Verify: paths point under `.bober/memory/`.
3. **Front-matter serialization** — a private `serializeLesson(lesson): string` (front-matter `---...---` + body) and a private `buildIndexLine(lesson): string` (`- <id> [<cat>/<sev>] (x<occ>) tags: a,b — <summary 0..80>`).
   - Verify: a hand-written round of serialize then parse reproduces the object (covered by C4 test).
4. **appendLesson** — `ensureDir(memoryDir)`, `safeParse` (throw on invalid), `writeFile(lessonPath, serializeLesson(lesson))`, then upsert: read `INDEX.md` (ENOENT→""), split non-empty lines, filter out the line for this `lessonId`, push `buildIndexLine(lesson)`, `writeFile(indexPath, lines.join("\n") + "\n")`.
   - Verify: C2 — both files exist; appending same id twice keeps INDEX at one line for that id.
5. **loadLessonIndex** — read `INDEX.md` (ENOENT→`[]`), split non-empty lines, parse each into a `LessonIndexRecord` (skip malformed), return `.slice(-limit)`. Opens NO `<id>.md`.
   - Verify: C3 — cap holds; delete a `<id>.md` then load still succeeds and returns that id's record.
6. **loadLesson** — read `lessonPath` (throw a clear "lesson not found" error on ENOENT, mirroring architect-state.ts:49-54), split front-matter via the `^---\n...\n---\n` regex, parse scalars + list blocks, coerce `occurrences` to number, `LessonEntrySchema.safeParse`, throw on invalid, return data.
   - Verify: C4 — `loadLesson` round-trips `appendLesson` output; `sourceEntryRefs` non-empty.
7. **Tests** — `src/state/memory.test.ts` mirroring `history.test.ts` fixture; one `describe` per C1–C4.
8. **Run full verification** — `npm run typecheck`, `npm run build`, `npx vitest run src/state/memory.test.ts`, then `npm run test`.

---

## 9. Pitfalls & Warnings

- **No `yaml` package exists.** Do not `import yaml` / `gray-matter` — they are not in deps. Hand-roll front-matter using the `^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$` regex from `agent-loader.ts:38`. Because you write AND read the file, you control the format — pick a serialization you can parse back losslessly (coerce `occurrences` with `Number()`; arrays via `key:\n  - item` blocks or a comma split).
- **Use `./helpers.js` `ensureDir`, not `../utils/fs.js`.** State modules consistently import `ensureDir` from `./helpers.js` (history.ts:7, architect-state.ts:4, research-state.ts:5). Both copies behave identically, but match the local convention.
- **ESM `.js` specifiers are mandatory** (NodeNext). `import { ensureDir } from "./helpers.js"` — never `./helpers` or `./helpers.ts`.
- **`consistent-type-imports` is enforced.** Import `LessonEntry`/`LessonIndexRecord` with `import type` wherever they are type-only, or the build fails on the lint gate.
- **No sync fs.** Use only `node:fs/promises` (`readFile`/`writeFile`/`appendFile`/`mkdir`). No `fs.readFileSync` (techStack: "node:fs/promises (no sync fs)").
- **Upsert must match the whole leading id token, not a substring.** Filter INDEX lines by the `- <lessonId> ` prefix (split on whitespace), so `lesson-1` does not also drop `lesson-12`. C2 depends on exactly-one-line-per-id.
- **`loadLessonIndex` must NOT open `<id>.md`.** It reads only `INDEX.md`. The C3 test deletes a `<id>.md` and asserts the load still succeeds — if you accidentally open per-lesson files, that test fails.
- **Empty `sourceEntryRefs` must be REJECTED** at the schema level (`.min(1)`). This is the provenance invariant (C1/C4). Also `safeParse` in `appendLesson` so an invalid lesson is never persisted.
- **Do NOT widen the diff.** No edits to `src/state/index.ts`, no CLI, no planner, no history reads, no LLM/network. The evaluator confirms `git diff` is confined to `src/state/memory.ts` + `src/state/memory.test.ts` (stopConditions, evaluatorNotes).
- **`createdAt` uses `z.string().datetime()`** — generate test values with `new Date().toISOString()` (as `makeEntry` does, history.test.ts:25); a non-ISO string will fail schema validation.
- **`tags: z.array(z.string()).default([])`** — the default means an input omitting `tags` parses to `[]`. Account for this in the round-trip equality assertion (serialize the resolved/defaulted value, not the raw input, so `toEqual` matches).
