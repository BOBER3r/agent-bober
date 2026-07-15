# Sprint Briefing: Bounded history reads + crash-safe rotation (loadRecentHistory + archive)

**Contract:** sprint-spec-20260605-scale-safe-history-memory-1
**Generated:** 2026-06-05T00:00:00Z

> Storage-layer-only sprint. Add `loadRecentHistory` (bounded tail read of ACTIVE only),
> crash-safe rotation into `.bober/history.archive.jsonl` gated on a new
> `history.maxActiveLines` zod field, and make `loadHistory` read archive-then-active
> concatenated so its full-stream contract is preserved. Do NOT touch resume-cursor or
> conformance logic. Do NOT change the signatures of `loadHistory`/`appendHistory`.

---

## 1. Target Files

### `src/state/history.ts` (modify)

This is the core file. Full content is 216 lines; the parts you touch are below.

**Path helpers + constants (lines 9-21) — ADD `archivePath` next to `historyPath`:**
```ts
const BOBER_DIR = ".bober";
const HISTORY_FILE = "history.jsonl";
const PROGRESS_FILE = "progress.md";

function historyPath(projectRoot: string): string {
  return join(projectRoot, BOBER_DIR, HISTORY_FILE);
}
// ADD: const HISTORY_ARCHIVE_FILE = "history.archive.jsonl";
// ADD: function archivePath(projectRoot): join(projectRoot, BOBER_DIR, HISTORY_ARCHIVE_FILE)
```

**`HistoryEntrySchema` + type (lines 37-44) — REUSE, do not redefine. Already exported.:**
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

**`appendHistory` (lines 51-68) — append stays; call `rotateIfNeeded` AFTER the appendFile. Signature MUST NOT change (it is `(projectRoot, entry) => Promise<void>` and is called with exactly 2 args at ~25 sites — see Impact Analysis):**
```ts
export async function appendHistory(
  projectRoot: string,
  entry: HistoryEntry,
): Promise<void> {
  const boberDir = join(projectRoot, BOBER_DIR);
  await ensureDir(boberDir);
  const validation = HistoryEntrySchema.safeParse(entry);
  if (!validation.success) { /* throws */ }
  const line = JSON.stringify(entry) + "\n";
  await appendFile(historyPath(projectRoot), line, "utf-8");
  // ADD HERE: await rotateIfNeeded(projectRoot);   // reads maxActiveLines, default 2000
}
```

**`loadHistory` (lines 74-101) — CHANGE to read archive THEN active, concatenated, preserving the skip-malformed-line loop. Signature `(projectRoot) => Promise<HistoryEntry[]>` MUST NOT change:**
```ts
export async function loadHistory(projectRoot: string): Promise<HistoryEntry[]> {
  let content: string;
  try {
    content = await readFile(historyPath(projectRoot), "utf-8");
  } catch { return []; }              // file doesn't exist yet
  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  const entries: HistoryEntry[] = [];
  for (const line of lines) {
    try {
      const parsed: unknown = JSON.parse(line);
      const result = HistoryEntrySchema.safeParse(parsed);
      if (result.success) entries.push(result.data);
    } catch { /* skip malformed */ }
  }
  return entries;
}
```
> **Refactor hint:** extract the `split → for → safeParse → push` block into a private
> `parseEntries(content: string): HistoryEntry[]` helper, then `loadHistory` becomes:
> read archivePath (empty string on ENOENT) → read historyPath (empty on ENOENT) →
> `return [...parseEntries(archiveContent), ...parseEntries(activeContent)]`.
> `loadRecentHistory` reuses `parseEntries(activeContent)` then `.slice(-limit)`.

**Imports this file uses (line 1-7):**
- `readFile, writeFile, appendFile` from `node:fs/promises` — add `rename` (and keep no sync fs)
- `join` from `node:path`
- `z` from `zod`
- `ensureDir` from `./helpers.js`
- type-only: `SprintContract` from `../contracts/sprint-contract.js`, `PlanSpec` from `../contracts/spec.js`

**Imported by (the consumers you must NOT break):**
- `src/orchestrator/workflow/resume-cursor.ts` (loadHistory — return discarded, see §3)
- `src/orchestrator/workflow/conformance.ts` (loadHistory — deep-compared, see §3)
- `src/orchestrator/workflow/flusher.ts` (appendHistory)
- `src/state/index.ts` (barrel re-export — see §1 note below)
- plus ~10 appendHistory call sites (see §7)

**Test file:** `src/state/history.test.ts` — **does NOT exist**, you create it (C1–C4).

---

### `src/state/history-rotation.ts` (create — OPTIONAL but recommended)

**Directory pattern:** Files in `src/state/` are kebab-case, ESM, `node:fs/promises` only,
box-drawing section headers (`// ── Section ──`). See `src/state/run-state.ts:1-29`.
**Most similar existing file:** `src/state/run-state.ts` — it owns the atomic temp-file+rename
pattern and path helpers; follow its structure.
**Structure template (mirrors run-state.ts header + helpers):**
```ts
// ── history-rotation.ts ─────────────────────────────────────────────
//
// Crash-safe rotation: when active history.jsonl exceeds maxActiveLines,
// move the oldest (count - maxActiveLines) entries to history.archive.jsonl,
// then atomically rewrite active with the remaining tail.

import { readFile, writeFile, appendFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const BOBER_DIR = ".bober";
// ── Path helpers ─────────────────────────────────────────────────────
// ── Rotation ─────────────────────────────────────────────────────────
export async function rotateIfNeeded(
  projectRoot: string,
  maxActiveLines: number,    // caller passes config value or default 2000
): Promise<void> { /* count → archive-append → atomic active-rewrite */ }
```
> If you prefer to keep everything in `history.ts`, that is allowed by the contract
> (estimatedFiles lists history-rotation.ts as optional). Either way, `rotateIfNeeded`
> is the unit under test for C2 and C4.

---

### `src/config/schema.ts` (modify)

ADD a `HistorySectionSchema` (mirror `PipelineSectionSchema` style, lines 163-206) and
wire it into `BoberConfigSchema` (lines 325-344) as **optional** (every section that was
added later is `.optional()` — see `graph`, `codeReview`, `observability`, `incident`,
`telemetry`, `architect`).

**Add the section (model on the smallest section, e.g. `IncidentSectionSchema` 302-310):**
```ts
// ── History Section (Sprint 1 — scale-safe rotation) ─────────────────
export const HistorySectionSchema = z.object({
  /** Max entries kept in the active history.jsonl before rotation moves the
   *  oldest overflow to history.archive.jsonl. Positive integer, default 2000. */
  maxActiveLines: z.number().int().positive().default(2000),
});
export type HistorySection = z.infer<typeof HistorySectionSchema>;
```

**Wire into BoberConfigSchema (insert near line 341-343):**
```ts
  // ── Sprint 1: scale-safe history rotation ──
  history: HistorySectionSchema.optional(),
```
> `createDefaultConfig` (lines 368-431) does NOT need a `history` block — the field is
> optional and resolves its default via `.default(2000)` only when the section object is
> present. Because rotation reads with a default fallback of 2000 regardless, leaving
> `history` out of `createDefaultConfig` keeps the flusher tests untouched.

### `src/config/schema.test.ts` (modify)

ADD a `describe("HistorySectionSchema")` block (C5). Follow the exact assertion style of
`describe("EvaluatorSectionSchema.panel")` (lines 9-38) and `PipelineSectionSchema.engine`
(lines 106-126): `.parse({})` for the default, `expect(() => ...parse(...)).toThrow()` for
rejection. Add `HistorySectionSchema` to the import on line 2-7.

---

## 2. Patterns to Follow

### Atomic temp-file + rename rewrite (crash safety — C4)
**Source:** `src/state/run-state.ts`, lines 41-53
```ts
export async function writeRunState(projectRoot: string, state: RunState): Promise<void> {
  await ensureDir(runDir(projectRoot, state.runId));
  const filePath = statePath(projectRoot, state.runId);
  const rnd = randomBytes(4).toString("hex");
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${rnd}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  await rename(tmp, filePath);
}
```
**Also at:** `src/incident/timeline.ts:86-92` (`atomicWriteJson`) — same temp+rename idiom.
**Rule:** Never write the active file in place. Write a `.tmp`, then `rename` (atomic on
the same filesystem) so a crash leaves either the old or the new active file, never a
half-written one. For rotation, ORDER the steps so a crash cannot lose data — see §9.

### Skip-malformed-line JSONL parse (reuse, do not reinvent)
**Source:** `src/state/history.ts`, lines 85-98
```ts
const lines = content.split("\n").filter((line) => line.trim().length > 0);
for (const line of lines) {
  try {
    const parsed: unknown = JSON.parse(line);
    const result = HistoryEntrySchema.safeParse(parsed);
    if (result.success) entries.push(result.data);
  } catch { /* skip malformed */ }
}
```
**Rule:** Both `loadHistory` (archive + active) and `loadRecentHistory` (active only) MUST
preserve this exact safeParse + skip-malformed behavior. Extract it into one shared helper.

### ENOENT-as-empty read
**Source:** `src/state/history.ts`, lines 77-83
```ts
try { content = await readFile(historyPath(projectRoot), "utf-8"); }
catch { return []; }   // File doesn't exist yet
```
**Rule:** A missing archive file is normal (no rotation has happened yet). Reading
archivePath must degrade to empty content, never throw. Mirror this try/catch.

### Optional config section added late
**Source:** `src/config/schema.ts`, lines 334-343 + 351 (`deepPartial`)
```ts
  graph: GraphSectionSchema.optional(),
  codeReview: CodeReviewSectionSchema.optional(),
  observability: ObservabilitySectionSchema.optional(),
  incident: IncidentSectionSchema.optional(),
  telemetry: TelemetrySectionSchema.optional(),
  architect: ArchitectSectionSchema.optional(),
```
**Rule:** Add `history: HistorySectionSchema.optional()`. Optional keeps every existing
config file valid (the BoberConfigSchema test at schema.test.ts:69-104 parses configs that
omit late sections — your addition must not break those).

### `z.number().int().positive().default(N)` field
**Source:** `src/config/schema.ts`, lines 149 + 244-248 (timeoutMs / syncTimeoutMs use this exact chain)
```ts
  timeoutMs: z.number().int().positive().default(300_000),
  syncTimeoutMs: z.number().int().positive().default(2000),
```
**Rule:** Use `z.number().int().positive().default(2000)` verbatim — `.positive()` rejects
0 and negatives (C5), `.int()` rejects floats, `.default(2000)` supplies the default (C5).

### Box-drawing section headers
**Source:** `src/state/history.ts:9,23,46,103` and principle at `.bober/principles.md:32`
**Rule:** Organize new code with `// ── Section Name ──` headers. Required by house style.

---

## 3. The Full-Read Contract — WHY loadHistory Cannot Break (CRITICAL)

The contract's whole point: bounding *appends/reads* must NOT change what `loadHistory`
returns. Two consumers pin this and the contract forbids editing them:

### resume-cursor.ts discards loadHistory's return
**Source:** `src/orchestrator/workflow/resume-cursor.ts:18-19`
```ts
    // Corroborate with history, but contract status WINS on conflict
    await loadHistory(projectRoot);          // <-- return value NOT assigned
```
**Implication:** Bounding *reads* (loadRecentHistory) cannot alter the reconstructed
ResumeCursor because the cursor is built from `listContracts`, not from history. But you
must STILL leave `loadHistory` returning the full stream — do not "optimize" it to read
only active, and do not touch this file.

### conformance.ts deep-compares the full normalized history
**Source:** `src/orchestrator/workflow/conformance.ts:101-107` and `:131-137`
```ts
      const rawHistory = await loadHistory(root);          // line 102
      perEngine[engine] = { contracts: normalize(rawContracts) as unknown[],
                            history: normalize(rawHistory) as unknown[] };
      // ...
      if (JSON.stringify(a.history) !== JSON.stringify(b.history)) {   // line 131
        diffs.push({ artifact: "history", path: ".bober/history.jsonl", engines: [nameA, nameB] });
      }
```
**Implication:** The harness JSON-stringifies `loadHistory(root)` for two engines and
asserts equality. If `loadHistory` ever returned a *bounded* slice (or dropped archived
entries), an engine that rotated would diverge from one that didn't, falsely flagging a
conformance diff. THEREFORE `loadHistory` MUST return archive-then-active = every entry,
in original order. `normalize` (conformance.ts:18-27) strips `timestamp` etc. before
compare, so do not rely on volatile fields for ordering — ordering is positional.

**Bottom line for the Generator:** archive entries are the OLDER ones; active entries are
NEWER. `loadHistory` returns `[...archive, ...active]` so the order is identical to the
pre-rotation single-file sequence. C3 verifies exactly this.

---

## 4. Prior Sprint Output

None. `dependsOn: []`. This is Sprint 1 (Layer 1) of the spec. Build on the existing
`src/state/history.ts` and `src/config/schema.ts` only.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM everywhere** with `.js` import specifiers (line 27). NodeNext (`tsconfig.json:4`).
- **No synchronous filesystem ops** — `node:fs/promises` only (line 42). No `fs.readFileSync`.
- **Zod for config validation** in `config/schema.ts` (line 29).
- **Filesystem state** in `.bober/` JSON files; no DB, no in-memory global state (line 31).
- **Use `type` imports** — ESLint `consistent-type-imports` is a hard gate (line 35, 18-19).
- **Box-drawing section headers** `// ── Section ──` (line 32).
- **No test mocks for filesystem** — tests create temp dirs and clean up (line 44). This
  is the house style; the `mkdtemp`/`rm` fixture in run-state.test.ts is the template.
- **Conventional commit:** `bober(sprint-1): bounded history reads + crash-safe rotation`
  (line 34 + generatorNotes).
- **Prefix unused params with `_`** (line 36).

### Architecture Decisions
`.bober/architecture/` contains ADRs for unrelated specs (openhands fork, ide-desktop-shell).
None govern the history storage layer. No history-rotation ADR exists.

### Other Docs
No project-level `CLAUDE.md`. `package.json` scripts: `build=tsc`, `typecheck=tsc --noEmit`,
`test=vitest`, `lint=eslint src/`.

---

## 6. Testing Patterns

### Unit Test Pattern (mkdtemp real-fs fixture — house style)
**Source:** `src/state/run-state.test.ts:8-45` (and `flusher.test.ts:6-30`)
```ts
import { mkdtemp, rm, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { appendHistory, loadHistory, loadRecentHistory } from "./history.js";
import type { HistoryEntry } from "./history.js";

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-history-test-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

function makeEntry(i: number): HistoryEntry {
  return { timestamp: new Date().toISOString(), event: `e${i}`, phase: "generating", details: { i } };
}
```
**Runner:** vitest (`^3.0.5`, `package.json:96`). **No vitest.config file** — defaults.
**Assertion style:** `expect(...).toBe/toEqual/toHaveLength/toThrow`.
**Mock approach:** Prefer NO mocks (principle line 44). For C1 ("no read against archive"),
the robust approach is the data-based proof the evaluatorNotes endorse: seed a temp project
whose `history.archive.jsonl` contains entries A,B and active contains C,D,E; assert
`loadRecentHistory(root, { limit: 2 })` returns `[D, E]` (active tail only) and NEVER
includes A or B. That proves the archive was not consulted without a `vi.spyOn`.
(If you do spy: `vi.mock("../../utils/logger.js", ...)` is the only mock in the workflow
tests — see conformance.test.ts:12-19 — but data-proof is cleaner here.)
**File naming:** `history.test.ts` collocated next to `history.ts`.
**Location:** co-located (`src/state/history.test.ts`).

### Test seeding helper for rotation (C2/C3/C4)
To seed `maxActiveLines + 50` entries quickly, write the JSONL directly with `writeFile`
to `<tmp>/.bober/history.jsonl`, OR loop `appendHistory`. For C4 (crash simulation), seed
both files by hand: write the archive-append result and the OLD active file (un-truncated)
to simulate "crashed after archive-append, before active-rewrite", then assert
`loadHistory` ∪ has every original entry — de-dup if your ordering allows duplicates.

### Schema test pattern (C5)
**Source:** `src/config/schema.test.ts:9-38` and `:106-126`
```ts
describe("HistorySectionSchema", () => {
  it("defaults maxActiveLines to 2000 on empty config", () => {
    expect(HistorySectionSchema.parse({}).maxActiveLines).toBe(2000);
  });
  it("rejects a non-positive maxActiveLines (0 / -1)", () => {
    expect(() => HistorySectionSchema.parse({ maxActiveLines: 0 })).toThrow();
    expect(() => HistorySectionSchema.parse({ maxActiveLines: -1 })).toThrow();
  });
});
```

### E2E Test Pattern
Not applicable — this is a storage-layer node module. No Playwright in scope.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/orchestrator/workflow/resume-cursor.ts` | `loadHistory` | low | Discards return (line 19). Do NOT edit. Verify resume-cursor.test.ts still green. |
| `src/orchestrator/workflow/conformance.ts` | `loadHistory` | **high** | Deep-compares full history (lines 102,131). `loadHistory` MUST return full archive+active. Do NOT edit. |
| `src/orchestrator/workflow/flusher.ts` | `appendHistory` | medium | Calls `appendHistory(projectRoot, {...})` at line 84 with 2 args. Signature must stay 2-arg. |
| `src/orchestrator/pipeline.ts` | `appendHistory` | medium | ~20 call sites (lines 173,194,275,348,...), all 2-arg. Signature must stay 2-arg. |
| `src/cli/commands/sprint.ts`, `src/mcp/tools/sprint.ts` | `appendHistory` | low | 2-arg calls (181 / 184). |
| `src/orchestrator/evaluator-agent.ts` | `appendHistory` | low | 2-arg call (line 187). |
| `src/graph/preflight-injector.ts` | `appendHistory` | low | 2-arg call (line 536). |
| `src/state/index.ts` | barrel re-export | low | Add `loadRecentHistory` to the export block (lines 18-30) so it is reachable via `../state`. |
| `src/index.ts` | `loadHistory`/`appendHistory` | low | Public API barrel — only add `loadRecentHistory` if you intend it public; not required by contract. |

> **Signature lock (NonGoal):** `appendHistory(projectRoot, entry)` is called with exactly
> two arguments at every site above. You may NOT add a required 3rd `config`/`maxActiveLines`
> param. Rotation must obtain the limit WITHOUT a signature change — read it with a default
> fallback of 2000 inside the rotation path. (Do NOT call `loadConfig` inside `appendHistory`:
> `loadConfig` THROWS when no `bober.config.json` exists — `src/config/loader.ts:142-148` —
> and the mkdtemp test fixtures have no config. Use the hardcoded default 2000, or accept an
> optional `maxActiveLines` param on a NEW `rotateIfNeeded`/`loadRecentHistory` only.)

### Existing Tests That Must Still Pass
- `src/orchestrator/workflow/conformance.test.ts` — exercises the harness that deep-compares
  `loadHistory`; verifies the full-read contract end to end. MUST stay green.
- `src/orchestrator/workflow/flusher.test.ts:210-225` — asserts
  `loadHistory(tmpDir).length === result.pendingHistory.length` (small N, no rotation).
- `src/orchestrator/workflow/resume-cursor.test.ts` — resume reconstruction over history.
- `src/orchestrator/workflow/interpreter.test.ts` — imports loadHistory.
- `src/graph/preflight-telemetry.test.ts` — imports loadHistory.
- `src/config/schema.test.ts` — full-config parse tests (lines 69-104) must still pass
  after adding optional `history` section.
- `src/state/run-state.test.ts`, `approval-state.test.ts` — sibling state suites (C6:
  "existing src/state suites stay green").

### Features That Could Be Affected
- **Workflow engine resume/conformance** — shares `loadHistory`. Verify ResumeCursor and
  conformance output are byte-identical before/after (they read the FULL stream).
- **Pipeline history audit trail** — shares `appendHistory`. Verify entries still land and
  rotation only triggers above 2000 (default), so normal runs are unaffected.

### Recommended Regression Checks (run after implementation)
1. `npm run typecheck` exits 0 (C6).
2. `npm run build` exits 0 (C6).
3. `npx vitest run src/state` — new history.test.ts + existing state suites green.
4. `npx vitest run src/config/schema.test.ts` — C5 + existing config tests green.
5. `npx vitest run src/orchestrator/workflow/conformance.test.ts src/orchestrator/workflow/resume-cursor.test.ts src/orchestrator/workflow/flusher.test.ts` — full-read consumers green.
6. `git diff --name-only` shows ONLY: `src/state/history.ts`, (optional) `src/state/history-rotation.ts`,
   `src/state/history.test.ts`, `src/state/index.ts` (barrel export add), `src/config/schema.ts`,
   `src/config/schema.test.ts`. NO changes to `resume-cursor.ts` or `conformance.ts`.
   (Tolerate only the documented flaky tool-count baseline per C6/evaluatorNotes.)

---

## 8. Implementation Sequence

1. **`src/config/schema.ts`** — add `HistorySectionSchema` (`maxActiveLines: z.number().int().positive().default(2000)`) and `history: HistorySectionSchema.optional()` on `BoberConfigSchema`. Export the type.
   - Verify: `npx vitest run src/config/schema.test.ts` still green (no new test yet).
2. **`src/config/schema.test.ts`** — add `describe("HistorySectionSchema")` with default + rejection tests (C5).
   - Verify: those 2-3 tests pass; `npm run typecheck` clean.
3. **Rotation helper** — in `src/state/history-rotation.ts` (or inline in history.ts): `archivePath(projectRoot)`, `rotateIfNeeded(projectRoot, maxActiveLines = 2000)`. Use the atomic temp+rename from run-state.ts:46-52. Pick and document the crash-safe ordering (see §9, C4).
   - Verify: `npm run typecheck` clean; helper compiles.
4. **`src/state/history.ts` — extract `parseEntries`, add `loadRecentHistory`** — `loadRecentHistory(projectRoot, { limit })` reads ONLY active, `parseEntries`, returns `.slice(-limit)` (newest-last). (C1)
   - Verify: a quick local assert that it returns ≤ limit and ignores archive.
5. **`src/state/history.ts` — update `loadHistory`** to read archivePath (ENOENT→empty) then historyPath, return `[...parseEntries(archive), ...parseEntries(active)]`. (C3)
   - Verify: order preserved across a manual rotation.
6. **`src/state/history.ts` — wire `rotateIfNeeded` into `appendHistory`** after the `appendFile` call, passing the limit (default 2000; no signature change). (C2)
   - Verify: appending below 2000 does NOT create an archive (flusher tests unaffected).
7. **`src/state/index.ts`** — add `loadRecentHistory` to the `from "./history.js"` re-export block (lines 18-30).
   - Verify: `npm run typecheck` clean.
8. **`src/state/history.test.ts`** — write C1 (tail cap + archive-untouched), C2 (seed maxActiveLines+50, assert active ≤ max & archive holds overflow), C3 (span-rotation → loadHistory equals pre-rotation ordered set), C4 (crash simulation → union exactly-once).
   - Verify: `npx vitest run src/state/history.test.ts` all green.
9. **Run full verification** — `npm run typecheck` (0), `npm run build` (0), `npx vitest run src/state src/config src/orchestrator/workflow/conformance.test.ts src/orchestrator/workflow/resume-cursor.test.ts src/orchestrator/workflow/flusher.test.ts`. Confirm `git diff` scope (§7 check 6).

---

## 9. Pitfalls & Warnings

- **Do NOT change `appendHistory`/`loadHistory` signatures.** ~25 two-arg `appendHistory`
  call sites and the discard at resume-cursor.ts:19 / deep-compare at conformance.ts:131
  depend on the current shapes. (NonGoal #1.)
- **Do NOT make `loadHistory` bounded.** It must return archive+active = every entry, or
  conformance.test.ts diverges. (NonGoal #2; §3.)
- **Do NOT call `loadConfig` inside `appendHistory`/`rotateIfNeeded`.** `loadConfig` THROWS
  when no config file exists (`loader.ts:142-148`); the mkdtemp test fixtures have none.
  Default `maxActiveLines` to 2000 directly. Threading real config is for higher layers,
  not the storage primitive.
- **Crash-safe ordering for C4 — pick ONE and document it in a comment:**
  - Option A (append-archive-first): append overflow to archive → atomically rewrite active
    with the tail via temp+rename. A crash before the rename leaves the overflow in BOTH
    archive and (un-truncated) active → DUPLICATES. C4 tolerates this ONLY if your test
    de-dups the union. State this in the comment.
  - Option B (idempotent, preferred): write new-active TEMP first → append overflow to
    archive → rename temp over active. A crash before rename: archive may have overflow but
    active is untouched (full) → union still has every entry exactly once after you treat
    the rename as the commit point. Document the commit point.
  Either way, the rename is the single atomic commit; everything before it must be
  recoverable. C4's test simulates the interruption and asserts no loss / no unintended dup.
- **`writeFile` truncates** — never rewrite active in place; always temp+rename (run-state.ts:46-52).
- **ESM `.js` specifiers required** — `import { rotateIfNeeded } from "./history-rotation.js"`
  even though the source is `.ts` (NodeNext, tsconfig.json:4; principle line 27).
- **`import type` for type-only imports** — ESLint `consistent-type-imports` is a hard gate
  (principles.md:18,35). e.g. `import type { HistoryEntry } from "./history.js"`.
- **No sync fs** — use `node:fs/promises` exclusively (principle line 42).
- **Do NOT migrate the existing 276-line `.bober/history.jsonl`** — rotation applies to new
  appends going forward only (NonGoal #3; current file is well under 2000 lines anyway).
- **`history.archive.jsonl` may not exist** on first run — read it with ENOENT→empty, like
  the existing `loadHistory` try/catch (history.ts:77-83). A missing archive is not an error.
- **Box-drawing headers + conventional commit** `bober(sprint-1): bounded history reads + crash-safe rotation`.
