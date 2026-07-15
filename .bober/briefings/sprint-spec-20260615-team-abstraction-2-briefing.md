# Sprint Briefing: Per-team memory namespacing of the lessons store

**Contract:** sprint-spec-20260615-team-abstraction-2
**Generated:** 2026-06-15T00:00:00Z

---

## 0. TL;DR — the one rule that governs the whole sprint

Thread an OPTIONAL TRAILING `namespace?: string` param through `memoryDir` and everything downstream. Centralize the namespace→subdir decision in ONE helper so every path computation agrees:

```
namespace === undefined || namespace === "" || namespace === "programming"
   → .bober/memory/            (current path, NO subdir — back-compat, no migration)
any other value                → .bober/memory/<namespace>/
```

The programming team's `memoryNamespace` is `""` (the sentinel from Sprint 1, `src/teams/registry.ts:66`). `loadTeam(config, teamId).memoryNamespace` is how every caller derives the namespace. Namespace values are already constrained to `^[a-z0-9_-]+$` by the Sprint 1 schema (`src/config/schema.ts:364`), so no path-traversal sanitization is required here.

---

## 1. Target Files

### src/state/memory.ts (modify)

This is the core. Add the centralized helper + thread `namespace?` through the three path helpers and the three public functions.

**Path helpers (lines 9-25) — current verbatim:**
```ts
const BOBER_DIR = ".bober";
const MEMORY_DIR = "memory";
const INDEX_FILE = "INDEX.md";

// ── Path Helpers ─────────────────────────────────────────────────────

function memoryDir(projectRoot: string): string {
  return join(projectRoot, BOBER_DIR, MEMORY_DIR);
}

function lessonPath(projectRoot: string, lessonId: string): string {
  return join(memoryDir(projectRoot), `${lessonId}.md`);
}

function indexPath(projectRoot: string): string {
  return join(memoryDir(projectRoot), INDEX_FILE);
}
```
Target shape: `memoryDir(projectRoot, namespace?)`, `lessonPath(projectRoot, lessonId, namespace?)`, `indexPath(projectRoot, namespace?)`. `memoryDir` applies the centralized rule; the other two forward `namespace` into `memoryDir(...)`.

**appendLesson — current signature (lines 196-199) and the two path call sites:**
```ts
export async function appendLesson(
  projectRoot: string,
  lesson: LessonEntry,
): Promise<void> {
```
Inside (lines 208-215): `const dir = memoryDir(projectRoot);` then `await ensureDir(dir);` then `writeFile(lessonPath(projectRoot, lesson.lessonId), ...)` and `const idxPath = indexPath(projectRoot);`. All three must pass `namespace` through. `ensureDir` (the only mkdir) lives at line 209 — it already creates the dir recursively, so a namespaced subdir is auto-created. Add `namespace?: string` as the trailing 3rd param.

**loadLessonIndex — current signature (lines 242-245):**
```ts
export async function loadLessonIndex(
  projectRoot: string,
  { limit }: { limit: number },
): Promise<LessonIndexRecord[]> {
```
Inside (line 248): `content = await readFile(indexPath(projectRoot), "utf-8");`. Add `namespace?: string` as the trailing 3rd param and forward it to `indexPath`. Missing INDEX.md already returns `[]` (lines 249-251), which gives isolation for free (a namespace with no lessons returns empty).

**loadLesson — current signature (lines 272-275):**
```ts
export async function loadLesson(
  projectRoot: string,
  lessonId: string,
): Promise<LessonEntry> {
```
Inside (lines 278, 280): `readFile(lessonPath(projectRoot, lessonId), ...)` plus an error message that re-computes `lessonPath(projectRoot, lessonId)`. Add `namespace?: string` as the trailing 3rd param; forward to BOTH `lessonPath` call sites.

**Imports this file uses:** `readFile, writeFile` from `node:fs/promises`; `join` from `node:path`; `z` from `zod`; `ensureDir` from `./helpers.js`.
**Imported by:** `src/orchestrator/memory/retrieve.ts:10`, `src/cli/commands/memory.ts:20-24`, `src/chat/chat-session.ts:9`, `src/orchestrator/memory/distill.ts:27` (type-only `LessonEntry`).
**Test file:** `src/state/memory.test.ts` (exists — 284 lines, extend it).

---

### src/orchestrator/memory/retrieve.ts (modify)

**retrieveRelevantLessons — current signature (lines 80-87):**
```ts
export async function retrieveRelevantLessons(
  projectRoot: string,
  keywords: string[],
  {
    topK = DEFAULT_TOP_K,
    charBudget: _charBudget,
  }: { topK?: number; charBudget?: number } = {},
): Promise<LessonIndexRecord[]> {
  const records = await loadLessonIndex(projectRoot, { limit: INDEX_LOAD_LIMIT });
```
Add `namespace` to the opts object: `{ topK?: number; charBudget?: number; namespace?: string }`, destructure it, and pass it as the trailing arg to `loadLessonIndex(projectRoot, { limit: INDEX_LOAD_LIMIT }, namespace)` (line 88). Evaluator note sc-2-7 calls it as `retrieveRelevantLessons(root, keywords, { namespace: 'teamA' })` — opts-object placement is REQUIRED, not a positional param. This is the ONLY `loadLessonIndex` call here (line 88).
**Imports:** `loadLessonIndex`, `type LessonIndexRecord` from `../../state/memory.js`.
**Imported by:** no non-test source caller (planner skill references it textually only — see retrieve.test.ts C4). **Test file:** `src/orchestrator/memory/retrieve.test.ts` (exists).

---

### src/cli/commands/memory.ts (modify)

Three subcommands; the four memory call sites to thread namespace through:
- `loadLessonIndex(projectRoot, { limit: Number.MAX_SAFE_INTEGER })` at line 58 (distill — beforeIndex)
- `appendLesson(projectRoot, lesson)` at line 68 (distill — persist)
- `loadLessonIndex(projectRoot, { limit })` at line 93 (list)
- `loadLesson(projectRoot, lessonId)` at line 139 (show)

**How root is currently resolved (lines 30-33):**
```ts
async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}
```
There is NO `loadConfig`/`loadTeam` import here yet. To derive the namespace you must add `import { loadConfig } from "../../config/loader.js";` and `import { loadTeam } from "../../teams/registry.js";`. Pattern: `const config = await loadConfig(projectRoot); const ns = loadTeam(config, teamId).memoryNamespace;`. `loadConfig(projectRoot)` (`src/config/loader.ts:142`) THROWS when no config file exists — so wrap it or default gracefully (these actions are already inside try/catch that sets `process.exitCode = 1`). The contract's nonGoals say "Do not add CLI --team flags … that is Sprint 4", so for THIS sprint the CLI should resolve the DEFAULT team (`loadTeam(config, undefined)` → `""` → current path). sc-2-8 only requires the CLI/distill namespace RESOLUTION to default to the current path; a test exercises "default team → current path". Keep the change minimal: resolve the default-team namespace and pass it through — do NOT add a `.option("--team")`.
**Imports of note:** `findProjectRoot` from `../../utils/fs.js` (line 17), `chalk`, `join` from `node:path` (note line 160 hardcodes `join(projectRoot, ".bober", "memory", ...)` for the show file path — if you namespace, this display path must agree; safest is to reuse the same namespace decision).
**Test file:** `src/cli/commands/memory.test.ts` (exists — uses `vi.spyOn(fsUtils, "findProjectRoot").mockResolvedValue(tmpDir)`).

---

### src/chat/chat-session.ts (modify)

**buildMemoryDistill — current (lines 41-59):**
```ts
async function buildMemoryDistill(projectRoot: string): Promise<string> {
  try {
    const index = await loadLessonIndex(projectRoot, { limit: 10 });
    if (index.length === 0) return "";

    const lines: string[] = ["Recent lessons learned:"];
    for (const record of index) {
      try {
        const lesson = await loadLesson(projectRoot, record.lessonId);
        lines.push(`- [${lesson.severity}] ${lesson.summary}`);
      } ...
```
`loadLessonIndex` at line 43, `loadLesson` at line 49. Add a trailing `namespace?: string` param to `buildMemoryDistill(projectRoot, namespace?)` and thread it into both calls. The call site is `buildMemoryDistill(this.projectRoot)` at line 140 (inside `Promise.all` in `handleTurn`).

**What team context the session has:** `ChatSession` currently has NO config or team field. `ChatSessionOptions` (lines 21-33) carries `llm, projectRoot, sessionId?, rl?, spawner?, now?, tailer?` — no team. The session uses `this.projectRoot` (line 65). The CLI command `src/cli/commands/chat.ts:24` accepts `[team]` but IGNORES it ("accepted but ignored in Phase 1", line 4) and constructs `ChatSession` with only `{ llm, projectRoot, sessionId }` (lines 37-41). To derive a namespace the simplest in-scope option is: add an optional `memoryNamespace?: string` (or `team?: string`) to `ChatSessionOptions`, store it on the instance, and pass it into `buildMemoryDistill`. `chat.ts` already calls `loadConfig` (line 27) so it CAN compute `loadTeam(config, team).memoryNamespace` and pass it in — but nonGoals defer CLI `--team` to Sprint 4, so default-team (`""` → current path) is sufficient. The minimal sc-2-8-satisfying change: thread `namespace` so a test can call `buildMemoryDistill(tmpDir, "teamA")` and assert scoping, and the default call still reads the current path.
**Test file:** check for `src/chat/chat-session.test.ts` (search before assuming — see Impact section).

---

### src/orchestrator/memory/distill.ts (modify) — CAUTION

**The generatorNotes say "distill.ts (appendLesson call)" but this file has NO `appendLesson` call.** `distill()` (lines 118-250) is the PURE, side-effect-free, NO-filesystem function — its header (lines 1-7) explicitly forbids fs access: "no filesystem access. createdAt is stamped at PERSIST TIME by the CLI handler, not here." The ACTUAL `appendLesson` call lives in `src/cli/commands/memory.ts:68` (verified by grep). So:
- **Do NOT add `appendLesson` or any namespace/fs logic into `distill.ts`.** That would violate its purity invariant and break `distill.test.ts`.
- The "active run's team namespace" for the distill PERSIST path is handled in `src/cli/commands/memory.ts:68` (covered above).
- If `estimatedFiles` lists `distill.ts`, the correct edit is likely NONE, or at most a comment — verify there is genuinely nothing to change. Treat the contract's distill reference as already satisfied by the memory.ts CLI edit. Do not invent a persistence call here.

---

## 2. Patterns to Follow

### Path helper composition (centralize, then forward)
**Source:** `src/state/memory.ts`, lines 15-25
```ts
function memoryDir(projectRoot: string): string {
  return join(projectRoot, BOBER_DIR, MEMORY_DIR);
}
function lessonPath(projectRoot: string, lessonId: string): string {
  return join(memoryDir(projectRoot), `${lessonId}.md`);
}
function indexPath(projectRoot: string): string {
  return join(memoryDir(projectRoot), INDEX_FILE);
}
```
**Rule:** `lessonPath`/`indexPath` derive from `memoryDir` — put the namespace decision ONLY in `memoryDir` and forward `namespace` to it; never recompute the subdir logic twice. Implement the centralized rule inline in `memoryDir`, e.g. `const ns = namespace && namespace !== "programming" ? namespace : undefined; return ns ? join(projectRoot, BOBER_DIR, MEMORY_DIR, ns) : join(projectRoot, BOBER_DIR, MEMORY_DIR);`

### Optional trailing param for back-compat
**Source:** registry resolver `src/teams/registry.ts:34` (`loadTeam(config, teamId?)`) and the contract generatorNotes.
**Rule:** Add `namespace?: string` as the LAST parameter on every signature so existing callers (and tests) that omit it keep compiling and keep reading the current path.

### Section comments (box-drawing headers)
**Source:** `src/state/memory.ts` lines 7, 13, 27, 51, 188, 235; `.bober/principles.md:32`
```ts
// ── Path Helpers ─────────────────────────────────────────────────────
```
**Rule:** Organize new code under unicode box-drawing section headers. If you add a namespace helper, give it a header like `// ── Namespace ───`.

### Type imports
**Source:** `src/orchestrator/memory/retrieve.ts:11` (`import type { LessonIndexRecord } ...`), `src/state/memory.test.ts:12`
**Rule:** ESLint enforces `consistent-type-imports`. Import types with `import type { ... }`.

### Namespace derivation from active team
**Source:** `src/teams/registry.ts:34-58` and `:66`
```ts
export function loadTeam(config: BoberConfig, teamId?: string): Team {
  if (teamId === undefined || teamId === "programming") {
    return buildProgrammingTeam(config);   // memoryNamespace: "" (line 66)
  }
  ...
  return { ..., memoryNamespace: entry.memoryNamespace ?? teamId, ... };
}
```
**Rule:** Callers obtain the namespace as `loadTeam(config, teamId).memoryNamespace`. For the programming/default team this is `""`, which your `memoryDir` rule maps to the current path.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `ensureDir` | `src/state/helpers.ts:6` | `(dirPath: string): Promise<void>` | `mkdir(dir,{recursive:true})` — already creates namespaced subdirs; reuse, do not add new mkdir |
| `loadTeam` | `src/teams/registry.ts:34` | `(config: BoberConfig, teamId?: string): Team` | Resolves the active team; `.memoryNamespace` is the namespace source |
| `loadConfig` | `src/config/loader.ts:142` | `(projectRoot: string): Promise<BoberConfig>` | Loads/validates config; THROWS if no config file exists |
| `LessonEntrySchema` | `src/state/memory.ts:29` | Zod schema | Validate lessons — REUSE unchanged (generatorNotes: "Reuse LessonEntrySchema/serialization unchanged") |
| `serializeLesson` (internal) | `src/state/memory.ts:57` | `(lesson): string` | Lesson→markdown; leave untouched |
| `buildIndexLine` / `parseIndexLine` (internal) | `src/state/memory.ts:85` / `:96` | `(lesson)→string` / `(line)→record\|null` | INDEX.md line format; leave untouched |
| `findProjectRoot` | `src/utils/fs.ts` | `(): Promise<string \| null>` | Root resolution in CLI handlers (already imported in memory.ts:17) |
| `resolveRoleProviders` | `src/config/role-providers.ts` | `(config): RoleProviderMap` | Used by registry + chat.ts; not needed for namespacing |

**Directories reviewed:** `src/state/`, `src/utils/`, `src/teams/`, `src/config/` — no existing "namespace→path" helper exists; you must create the centralized rule inside `memoryDir`. No path-sanitizer needed (schema regex `src/config/schema.ts:364` already constrains values).

---

## 4. Prior Sprint Output

### Sprint 1: Team type + loadTeam (DONE, commit 274338b)
**Created:** `src/teams/types.ts` — exports `Team` (with `memoryNamespace: string`, doc-comment at `:24` says "Sentinel ('' …) that Sprint 2 maps to .bober/memory/") and `Role`.
**Created:** `src/teams/registry.ts` — exports `loadTeam(config, teamId?)`; programming team's `memoryNamespace` is `""` at `:66`.
**Modified:** `src/config/schema.ts` — added `TeamConfigSchema` (`:361`, `memoryNamespace` regex `^[a-z0-9_-]+$` at `:364`), `teams` (`:401`) and `defaultTeam` (`:402`) on `BoberConfigSchema`.
**Connection to this sprint:** Every caller imports `loadTeam` from `src/teams/registry.js` and reads `.memoryNamespace` to derive the path namespace. The `""` sentinel is exactly what your `memoryDir` rule must map to the unchanged `.bober/memory/` path (no migration — contract nonGoal #2).

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`) — HARD rules in scope
- **No synchronous fs** (`:42`): use `node:fs/promises` only. `memory.ts` already does (`readFile, writeFile` from `node:fs/promises`).
- **No fs mocks in tests** (`:44`): tests create real temp dirs and clean up. See the verbatim pattern in §6.
- **`.js` extensions** (`:27`): every import path ends in `.js` for NodeNext (e.g. `../../state/memory.js`).
- **`type` imports** (`:35`): `import type { ... }`.
- **Section comments** (`:32`): unicode box-drawing headers in long files.
- **Small utility modules** (`:33`): keep the namespace logic inside `memoryDir`; do not spawn a sprawling new module.
- **Collocated Vitest tests** (`:20`): `*.test.ts` next to source.

### Architecture Decisions
No `.bober/architecture/` ADR specific to memory namespacing was found relevant. (An `.bober/architecture/` directory exists but contains plan-level docs, not a memory-namespacing ADR.)

### Other Docs
The contract's `generatorNotes`/`evaluatorNotes` (in the contract JSON) are the most precise spec — follow the evaluatorNotes call shapes EXACTLY for the new tests.

---

## 6. Testing Patterns

### Unit Test Pattern (memory store) — REAL temp dirs, no mocks
**Source:** `src/state/memory.test.ts:1-40`
```ts
import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { LessonEntrySchema, appendLesson, loadLessonIndex, loadLesson } from "./memory.js";
import type { LessonEntry } from "./memory.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-memory-test-"));
  await mkdir(join(tmpDir, ".bober"), { recursive: true });   // mirrors real layout
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeLesson(id: string, overrides: Partial<LessonEntry> = {}): LessonEntry {
  return {
    lessonId: id,
    createdAt: new Date().toISOString(),
    category: "testing",
    tags: ["unit", "state"],
    summary: `Lesson ${id}: a concise summary of the observed pattern`,
    occurrences: 1,
    severity: "warn",
    sourceEntryRefs: ["history.jsonl#42"],
    ...overrides,
  };
}
```
**Runner:** vitest. **Assertion:** `expect(...)`. **Mock approach:** NONE for fs — real temp dirs + `afterEach` cleanup. **File naming:** `memory.test.ts` collocated. **Location:** co-located next to `memory.ts`.

**New tests to add to `memory.test.ts`** (map directly to evaluatorNotes):
- sc-2-4: `expect(memoryDir(root)).toBe(join(root, ".bober", "memory"))` and `memoryDir(root, "teamA")` === `join(root, ".bober", "memory", "teamA")`. NOTE: `memoryDir`/`lessonPath`/`indexPath` are currently NOT exported. To assert paths directly you must EXPORT them (add `export`) OR assert via on-disk effects. Exporting them is the lowest-risk way to satisfy sc-2-4 ("A unit test asserts both resolved paths"). Same for `lessonPath`/`indexPath`.
- sc-2-5 (isolation both directions): `await appendLesson(root, makeLesson("la"), "teamA"); expect((await loadLessonIndex(root,{limit:10},"teamA")).map(r=>r.lessonId)).toContain("la"); expect((await loadLessonIndex(root,{limit:10})).map(...)).not.toContain("la");` then append a default lesson and assert teamA's index excludes it.
- sc-2-6 (back-compat / pre-existing fixture): manually `mkdir .bober/memory/` then `writeFile` a valid `<id>.md` + a matching INDEX.md line into the NO-namespace dir, and assert `loadLessonIndex(root,{limit:10})` returns it. The INDEX line format is `- <id> [<cat>/<sev>] (x<occ>) tags: <a,b> — <snippet80>` (see `buildIndexLine` `src/state/memory.ts:85-90`). Easiest: append a lesson with no namespace to create the fixture, then assert it's visible with no namespace.

### Unit Test Pattern (retriever scoping)
**Source:** `src/orchestrator/memory/retrieve.test.ts` (same temp-dir convention; calls e.g. `retrieveRelevantLessons(tmpDir, ["auth"], { topK: 5 })` at `:46,:59`).
- sc-2-7: seed lessons under `"teamA"` and `"teamB"` via `appendLesson(root, lesson, "teamA"/"teamB")`, then `retrieveRelevantLessons(root, keywords, { namespace: "teamA" })` returns only teamA's.

### Unit Test Pattern (CLI handler namespace resolution)
**Source:** `src/cli/commands/memory.test.ts:136-159`
```ts
const fsUtils = await import("../../utils/fs.js");
const rootSpy = vi.spyOn(fsUtils, "findProjectRoot").mockResolvedValue(tmpDir);
// ... registerMemoryCommand(program); await program.parseAsync(["node","bober","memory","list"]);
// finally: stdoutSpy.mockRestore(); rootSpy.mockRestore();
```
**Mock approach:** `vi.spyOn` on `findProjectRoot` (a module export) and on `process.stdout.write` — NOT on fs. Real temp dir for state. **Note:** because the CLI handler will now call `loadConfig(projectRoot)`, the temp project needs a `bober.config.json` written into `.bober/` parent (or the handler must tolerate a missing config). sc-2-8 only requires asserting "default team → current path", so a test can seed a minimal config OR assert that with no team the CLI reads `.bober/memory/` (current path). Keep `loadConfig` failures non-fatal in the handler (it is already wrapped in try/catch that sets `process.exitCode=1`).

### E2E Test Pattern
Not applicable — no Playwright/`e2e/` for this CLI/library sprint.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/orchestrator/memory/retrieve.ts` | `loadLessonIndex` (memory.ts) | low | Trailing optional param keeps the existing `loadLessonIndex(root,{limit})` call valid |
| `src/cli/commands/memory.ts` | `appendLesson, loadLessonIndex, loadLesson` | medium | 4 call sites (lines 58,68,93,139); adding `loadConfig`+`loadTeam` here is new wiring — keep non-throwing |
| `src/chat/chat-session.ts` | `loadLessonIndex, loadLesson` | medium | `buildMemoryDistill` call at line 140 must still compile; default path must round-trip |
| `src/orchestrator/memory/distill.ts` | `type LessonEntry` only | low | Type-only import — PURE fn, must NOT gain fs/appendLesson logic |
| Planner skill/agent (textual) | references `retrieveRelevantLessons` name | low | retrieve.test.ts C4 (`:198`) asserts the NAME appears; do not rename the export |

### Existing Tests That Must Still Pass
- `src/state/memory.test.ts` — 4 describe blocks (C1-C4, lines 44/95/174/235). Every existing call omits namespace; trailing-optional param keeps them green. MUST stay green.
- `src/orchestrator/memory/retrieve.test.ts` — calls `retrieveRelevantLessons(tmpDir, [...], { topK })` with no namespace (lines 46,54,59,92,105,132,139,158,176,187). Adding `namespace?` to opts must not change default behavior. C4 (`:198-208`) asserts planner skill text contains `retrieveRelevantLessons` — do not rename.
- `src/cli/commands/memory.test.ts` — invokes distill/list/show against a temp dir via `findProjectRoot` spy (lines 136-180+). After adding `loadConfig`/`loadTeam`, these tests must still pass — ensure the default-team path equals the current path and missing-config is tolerated.
- `src/orchestrator/memory/distill.test.ts` — asserts the pure distill output (INDEX path read at `:267`). Must stay green — keep distill.ts pure.

### Features That Could Be Affected
- **`bober memory` CLI** — shares `appendLesson`/`loadLessonIndex`/`loadLesson`; verify distill→list→show still round-trips on the default (current) path.
- **`bober chat` memory distill** — shares `buildMemoryDistill`; verify the answerer still receives lessons for the default team.
- **Planner lesson retrieval** — shares `retrieveRelevantLessons`; default behavior (no namespace) must be byte-identical.

### Recommended Regression Checks
1. `npm run build` (sc-2-1) — zero TS errors.
2. `npm run typecheck` (sc-2-2) — zero strict errors.
3. `npm run test` (sc-2-3) — ALL tests, especially the four existing memory/retrieve/distill test files above, must be green.
4. Run `npx vitest run src/state/memory.test.ts src/orchestrator/memory/retrieve.test.ts src/cli/commands/memory.test.ts src/orchestrator/memory/distill.test.ts` to fast-check the affected suites.
5. Confirm `src/state/memory.ts` still imports only from `node:fs/promises` (no sync fs introduced).

---

## 8. Implementation Sequence (dependency-ordered)

1. **src/state/memory.ts — `memoryDir` + the centralized rule.** Add `namespace?: string` to `memoryDir`; implement: undefined/`""`/`"programming"` → current path, else `join(..., MEMORY_DIR, namespace)`. EXPORT `memoryDir`, `lessonPath`, `indexPath` (needed for sc-2-4 direct-path assertions).
   - Verify: `memoryDir(root)` unchanged; `memoryDir(root,"teamA")` ends with `/teamA`.
2. **src/state/memory.ts — `lessonPath` + `indexPath`.** Add trailing `namespace?` and forward to `memoryDir`.
   - Verify: both compose `memoryDir(projectRoot, namespace)`.
3. **src/state/memory.ts — `appendLesson`, `loadLessonIndex`, `loadLesson`.** Add trailing `namespace?`; thread into every `memoryDir`/`lessonPath`/`indexPath` call (appendLesson lines 208/212/215; loadLessonIndex line 248; loadLesson lines 278/280). `ensureDir` already creates subdirs.
   - Verify: existing memory.test.ts (no-namespace) still passes.
4. **src/orchestrator/memory/retrieve.ts — `retrieveRelevantLessons`.** Add `namespace?` to the opts object; pass through to `loadLessonIndex` (line 88).
   - Verify: existing retrieve.test.ts passes; opts-object placement matches sc-2-7 call shape.
5. **src/cli/commands/memory.ts — derive default-team namespace.** Add `loadConfig` + `loadTeam` imports; in each action resolve `const ns = loadTeam(await loadConfig(projectRoot).catch(()=>undefinedConfig), undefined).memoryNamespace` (default team → `""`) and pass to the 4 call sites; keep handlers non-throwing. Also reconcile the hardcoded show path at line 160 with the namespace.
   - Verify: memory.test.ts CLI suite passes; distill/list/show still use the current path for the default team.
6. **src/chat/chat-session.ts — thread namespace into `buildMemoryDistill`.** Add a `namespace?`/`memoryNamespace?` option to `ChatSessionOptions`, store it, pass it to `buildMemoryDistill(this.projectRoot, this.memoryNamespace)` (call at line 140).
   - Verify: default path round-trips; existing chat tests (if any) pass.
7. **src/orchestrator/memory/distill.ts — verify NO change needed.** Confirm there is no `appendLesson` call here; leave the pure function untouched (distill.test.ts must stay green).
   - Verify: distill.test.ts passes unchanged.
8. **Tests — extend `src/state/memory.test.ts` + add retriever/CLI namespace tests.** Cover sc-2-4 (both paths), sc-2-5 (isolation both directions), sc-2-6 (pre-existing default fixture), sc-2-7 (scoped retrieval), sc-2-8 (CLI/distill default → current path).
   - Verify: new + all existing tests green.
9. **Run full verification** — `npm run build`, `npm run typecheck`, `npm run test`.

---

## 9. Pitfalls & Warnings

- **distill.ts is a TRAP.** generatorNotes say "distill.ts (appendLesson call)" but there is NO appendLesson call there — `distill()` is PURE (header lines 1-7 forbid fs). The real persist call is `src/cli/commands/memory.ts:68`. Do NOT add fs/namespace logic to distill.ts; you will break its purity invariant and distill.test.ts.
- **`memoryDir`/`lessonPath`/`indexPath` are NOT currently exported.** sc-2-4 requires a test asserting both resolved paths — add `export` to these helpers (low risk; nothing depends on them being private).
- **Centralize the rule ONCE.** Put the `""`/`"programming"`/undefined → current-path decision only in `memoryDir`. If you duplicate it in `lessonPath`/`indexPath`/the CLI, the paths can diverge and isolation tests will flicker. Forward `namespace` everywhere instead.
- **`"programming"` is a valid namespace input that must map to the CURRENT path**, same as `""` and `undefined` (back-compat rule). A named team literally called something else (e.g. `"teamA"`) gets a subdir.
- **No migration.** Do NOT create a `.bober/memory/programming/` subdir or move existing lessons (contract nonGoal #2). The default team stays on `.bober/memory/`.
- **`loadConfig` throws when no config file exists** (`src/config/loader.ts:142-148`). CLI/chat handlers must tolerate this — default to the current path rather than crashing. The memory CLI actions are already inside try/catch (e.g. lines 74-81); keep namespace resolution inside that guard.
- **No CLI `--team` flag, no example team this sprint** (nonGoals #4). Resolve the DEFAULT team only. Adding `--team` is Sprint 4.
- **Use `node:fs/promises` + `ensureDir`; NO sync fs, NO fs mocks** (principles `:42`,`:44`). Tests use real temp dirs with `mkdtemp`/`afterEach rm` (memory.test.ts:18-26).
- **`.js` import extensions and `import type`** are hard ESLint/build gates (principles `:27`,`:35`). New imports: `../../config/loader.js`, `../../teams/registry.js`.
- **The INDEX.md line format is exact** (`buildIndexLine` `src/state/memory.ts:85-90`). When hand-writing the sc-2-6 pre-existing fixture, match `- <id> [<cat>/<sev>] (x<occ>) tags: <csv> — <snippet>` or `parseIndexLine` (`:96-119`) will return null and the test will wrongly see an empty index. Easiest: create the fixture by calling `appendLesson(root, lesson)` with no namespace.
- **Do not rename `retrieveRelevantLessons`** — retrieve.test.ts C4 (`:198-208`) asserts the planner skill/agent text contains that exact name.
