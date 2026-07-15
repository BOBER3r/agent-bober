# Sprint Briefing: Deterministic distillation + bober memory CLI (distill | list | show)

**Contract:** sprint-spec-20260605-scale-safe-history-memory-3
**Generated:** 2026-06-05T00:00:00Z

---

## 0. TL;DR — The Three Things Most Likely To Go Wrong

1. **Registration site is `src/cli/index.ts`, NOT `src/index.ts`.** The contract's `estimatedFiles` lists `src/index.ts` — that is the **library barrel** (re-exports types/functions; see `src/index.ts:140-155`). CLI commander commands register in `src/cli/index.ts`. Mirror `registerIncidentCommand(program)` (`src/cli/index.ts:269-270`). Add `import { registerMemoryCommand } from "./commands/memory.js";` near `src/cli/index.ts:30` and call `registerMemoryCommand(program);` in `main()` next to the other `register*Command(program)` calls (`src/cli/index.ts:243-282`). You may ALSO add `export { distill } from "./orchestrator/memory/distill.js";` to the `src/index.ts` barrel if you want the pure fn re-exported, but the behavioral registration belongs in `src/cli/index.ts`.
2. **`distill()` is PURE — no `Date.now()`, no clock, no `import` from `../../providers`.** `createdAt` is stamped at persist time inside the CLI handler (`new Date().toISOString()`), never inside the pure function. `lessonId` comes from a `createHash` of `category+tags+sourceEntryRefs` (deterministic), not from a timestamp.
3. **`createHash` has NO precedent in this repo** — only `randomUUID`/`randomBytes` are used (`src/state/history-rotation.ts:26`). You must introduce `import { createHash } from "node:crypto";`. That is fine; just match the `import { X } from "node:crypto";` style.

---

## 1. Target Files

### src/orchestrator/memory/distill.ts (create)

**Directory pattern:** `src/orchestrator/memory/` does NOT exist yet — you create it. Sibling modules in `src/orchestrator/` use the section-comment style (`// ── Constants ──`, `// ── Schema ──`) seen in `src/state/memory.ts:7` and `src/state/history.ts:10`.
**Most similar existing file (pure, side-effect-free core):** `src/orchestrator/eval-lenses.ts` (pure `evaluateLenses` core, extracted side-effect-free per commit `00dae32`). Also model the determinism/dedupe discipline on `src/state/memory.ts`.

**Exact export required (from generatorNotes):**
```ts
import { createHash } from "node:crypto";

import type { HistoryEntry } from "../../state/history.js";
import type { SprintContract } from "../../contracts/sprint-contract.js";
import type { LessonEntry } from "../../state/memory.js";

// PURE: no Date.now, no network, no provider import, no fs.
export function distill(
  history: HistoryEntry[],
  contracts: SprintContract[],
): LessonEntry[] { /* ... */ }
```

**Critical:** `LessonEntry` (`src/state/memory.ts:40`) REQUIRES a `createdAt: z.string().datetime()` field (`src/state/memory.ts:31`). Since `distill` must be pure (no clock), it CANNOT stamp a real `createdAt`. Two viable approaches — pick ONE and document it:
- **(A) Return objects WITHOUT `createdAt`** (a `Omit<LessonEntry, "createdAt">[]` or an internal `DraftLesson` type), and the CLI handler adds `createdAt` before calling `appendLesson`. Cleanest for purity. Requires a local draft type.
- **(B) Inject a clock**: `distill(history, contracts, now: () => string)` and pass a fixed/real clock. generatorNotes explicitly allows "or pass a clock in". The fixture test passes a constant clock for determinism.
Recommendation: (A) keeps `distill(history, contracts): LessonEntry[]`-shaped signature but returns drafts; or use a frozen sentinel `createdAt` inside the pure fn that the handler overwrites. The fixture test (C1) must assert an EXACT lesson set stable across calls — so any `createdAt` produced inside the pure fn must itself be deterministic (constant), not `Date.now()`.

**Structure template (skeleton — fill in the grouping logic):**
```ts
// ── Constants ──
const ITERATION_THRESHOLD_DEFAULT = 3; // matches config evaluator.maxIterations default (src/config/schema.ts:107)

// ── Hash helper (deterministic lessonId) ──
function lessonIdFromSignature(category: string, tags: string[], refs: string[]): string {
  const canonical = JSON.stringify({ category, tags: [...tags].sort(), refs: [...refs].sort() });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

// ── Severity band (deterministic) ──
function severityFor(occurrences: number): "info" | "warn" | "high" {
  if (occurrences >= 5) return "high";
  if (occurrences >= 3) return "warn";
  return "info";
}

export function distill(history: HistoryEntry[], contracts: SprintContract[]): LessonEntry[] {
  // 1. group history failure events by structured signature (event/phase/details fields)
  // 2. count recurrences; build sourceEntryRefs from sprintId / stable entry identifiers
  // 3. flag contracts whose iterationHistory.length >= threshold
  // 4. emit one LessonEntry per signature; sort output for stable ordering
}
```

---

### src/cli/commands/memory.ts (create)

**Directory pattern:** Files in `src/cli/commands/` that own a parent command + subcommands export a `register<Name>Command(program: Command): void` function. Confirmed: `registerIncidentCommand` (`src/cli/commands/incident.ts:202`), `registerAuditCommand` (`src/cli/commands/audit-show.ts:45`), `registerWorktreeCommand`, `registerTelemetryCommand`.
**Most similar existing file:** `src/cli/commands/incident.ts` — a parent command (`incident`) with 5 subcommands, each with `process.stdout.write` + `chalk` output and `process.exitCode = 1` error handling. **Copy its shape exactly.**

**Structure template:**
```ts
import { join } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";

import { findProjectRoot } from "../../utils/fs.js";
import { loadHistory } from "../../state/history.js";
import { listContracts } from "../../state/sprint-state.js"; // NOTE: import from sprint-state.js OR the barrel
import { appendLesson, loadLessonIndex, loadLesson } from "../../state/memory.js";
import { distill } from "../../orchestrator/memory/distill.js";

async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}

export function registerMemoryCommand(program: Command): void {
  const memCmd = program
    .command("memory")
    .description("Inspect and distill self-improvement lessons (distill, list, show)");

  // ── memory distill ──
  memCmd
    .command("distill")
    .description("Distill sprint history into deterministic lessons (idempotent)")
    .action(async () => {
      const projectRoot = await resolveRoot();
      try {
        const history = await loadHistory(projectRoot);
        const contracts = await listContracts(projectRoot);
        const drafts = distill(history, contracts);
        let added = 0;
        const now = new Date().toISOString();        // createdAt stamped HERE, not in distill
        const beforeIndex = await loadLessonIndex(projectRoot, { limit: Number.MAX_SAFE_INTEGER });
        const seen = new Set(beforeIndex.map((r) => r.lessonId));
        for (const draft of drafts) {
          const lesson = { ...draft, createdAt: now }; // if (A): draft has no createdAt
          if (!seen.has(lesson.lessonId)) added++;     // dedupe by lessonId (= content hash)
          await appendLesson(projectRoot, lesson);     // appendLesson UPSERTS — re-running same id = no new index line
        }
        process.stdout.write(chalk.green(`distilled ${drafts.length} lessons (${added} new)\n`));
      } catch (err) {
        process.stderr.write(chalk.red(`Failed to distill: ${err instanceof Error ? err.message : String(err)}\n`));
        process.exitCode = 1;
      }
    });

  // ── memory list ──  -> loadLessonIndex(projectRoot, { limit }) then print each record
  // ── memory show <lessonId> ──  -> loadLesson(projectRoot, lessonId) then print incl. sourceEntryRefs
}
```

**Idempotency note (C2):** `appendLesson` (`src/state/memory.ts:196-233`) already UPSERTS one INDEX.md line per `lessonId` (it filters out the prior line for that id at `src/state/memory.ts:225-229` and re-appends). So if `distill` produces a STABLE `lessonId` (content hash) across runs, re-running yields ZERO new index lines automatically — your dedupe lives in the determinism of the hash, not in extra bookkeeping. The `(M new)` count is computed by comparing against the pre-existing index (the `seen` set above).

---

### src/index.ts (modify — OPTIONAL barrel re-export only)

**This is the library barrel, NOT the CLI.** Relevant section (`src/index.ts:140-155`) re-exports state functions:
```ts
export {
  ensureBoberDir, saveContract, loadContract, listContracts, updateContract,
  saveSpec, loadSpec, loadLatestSpec, listSpecs,
  appendHistory, loadHistory,
  saveBriefing, readBriefing, listBriefings,
} from "./state/index.js";
```
If you re-export `distill`, add a `// ── Memory ──` block mirroring the above. **Do NOT register the commander command here.** Registration goes in `src/cli/index.ts`.

---

## 2. Patterns to Follow

### Parent command + subcommands (commander)
**Source:** `src/cli/commands/incident.ts`, lines 202-241
```ts
export function registerIncidentCommand(program: Command): void {
  const incCmd = program
    .command("incident")
    .description("Manage production incidents (start, status, end, list, abort)");

  incCmd
    .command("start <symptom>")
    .description("Create a new incident and return its ID")
    .option("--severity <level>", "Severity: S1|S2|S3|S4")
    .action(async (symptom: string, opts: { severity?: string }) => {
      const projectRoot = await resolveRoot();
      try { /* ... */ }
      catch (err) {
        process.stderr.write(chalk.red(`Failed ...: ${err instanceof Error ? err.message : String(err)}\n`));
        process.exitCode = 1;
      }
    });
}
```
**Rule:** Handlers MUST NOT throw — catch, write to `process.stderr` with `chalk.red`, set `process.exitCode = 1`, and `return`. Success output goes to `process.stdout.write` with `chalk.green`/`chalk.gray`.

### Command registration in main()
**Source:** `src/cli/index.ts`, lines 21-34 (imports) and 243-282 (calls)
```ts
import { registerIncidentCommand } from "./commands/incident.js";   // line 30
// ...
registerIncidentCommand(program);                                    // line 270
```
**Rule:** Add `import { registerMemoryCommand } from "./commands/memory.js";` to the import block and `registerMemoryCommand(program);` to the `register*` call block in `main()`.

### Output / printing
**Source:** `src/cli/commands/incident.ts:66-69, 233-234`
```ts
process.stdout.write(`Incident: ${incidentId} (symptom: "${meta.symptom}")\n`);
process.stdout.write(chalk.green(`Incident created: ${incidentId}\n`));
```
**Rule:** Use `process.stdout.write(... + "\n")` with `chalk` colors, NOT `console.log`. (A `logger` exists at `src/utils/logger.ts:87` but CLI command handlers in this repo print via `process.stdout.write` directly — follow the command precedent, not the logger.)

### node:crypto import style (for createHash)
**Source:** `src/state/history-rotation.ts:26`
```ts
import { randomBytes } from "node:crypto";
```
**Rule:** Introduce `import { createHash } from "node:crypto";` in the same destructured `node:crypto` style. There is NO existing `createHash` call to copy — you are the first; keep the canonical-input + `sha256` + `.digest("hex")` pattern consistent.

### import type + ESM .js specifiers
**Source:** `src/state/history.ts:5-6`
```ts
import type { SprintContract } from "../contracts/sprint-contract.js";
import type { PlanSpec } from "../contracts/spec.js";
```
**Rule:** Type-only imports use `import type`; ALL relative imports end in `.js` even for `.ts` source. From `src/orchestrator/memory/distill.ts` the path to memory types is `../../state/memory.js` and to contracts is `../../contracts/sprint-contract.js`.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `loadHistory` | `src/state/history.ts:107` | `(projectRoot: string): Promise<HistoryEntry[]>` | Reads full archive+active history stream. distill input source. |
| `loadRecentHistory` | `src/state/history.ts:135` | `(projectRoot, { limit }): Promise<HistoryEntry[]>` | Tail-only; NOT for distill (distill needs full history per C4). |
| `listContracts` | `src/state/sprint-state.ts:113` | `(projectRoot: string): Promise<SprintContract[]>` | Lists all `.bober/contracts/*.json`, validated, sorted. distill input. Also re-exported from `./state/index.js` (`src/index.ts:147`). |
| `appendLesson` | `src/state/memory.ts:196` | `(projectRoot: string, lesson: LessonEntry): Promise<void>` | Writes `<lessonId>.md` + UPSERTS one INDEX.md line. Validates schema (throws on empty sourceEntryRefs). Idempotent by lessonId. |
| `loadLessonIndex` | `src/state/memory.ts:242` | `(projectRoot, { limit }): Promise<LessonIndexRecord[]>` | Index-only read (never opens lesson files). For `memory list`. Returns last `limit`. |
| `loadLesson` | `src/state/memory.ts:272` | `(projectRoot: string, lessonId: string): Promise<LessonEntry>` | Reads one `<lessonId>.md`, parses front-matter, validates. For `memory show`. Throws "Lesson not found" on ENOENT. |
| `LessonEntry` (type) | `src/state/memory.ts:40` | `z.infer<typeof LessonEntrySchema>` | Output element type. Fields: lessonId, createdAt, category, tags, summary, occurrences, severity, sourceEntryRefs. |
| `LessonEntrySchema` | `src/state/memory.ts:29-38` | zod object | severity enum is `["info","warn","high"]`; sourceEntryRefs `.min(1)` (non-empty); occurrences `.int().positive()`. |
| `LessonIndexRecord` (type) | `src/state/memory.ts:42-49` | interface | What `loadLessonIndex` returns: lessonId, category, severity, occurrences, tags, summarySnippet. |
| `HistoryEntry` (type) | `src/state/history.ts:45` | `z.infer<typeof HistoryEntrySchema>` | Fields: `timestamp`, `event`, `phase` (Phase enum), `sprintId?`, `details: Record<string, unknown>`. distill keys off these. |
| `Phase` (type/enum) | `src/state/history.ts:26-36` | enum init/planning/curating/generating/evaluating/rework/complete/failed | A `phase: "failed"` or `event` string is a candidate failure signal. |
| `SprintContract` (type) | `src/contracts/sprint-contract.ts:138` | zod-inferred | Has `successCriteria[]`, `iterationHistory: unknown[]`, `lastEvalId`, `evalResults?: unknown[]`, `status`. |
| `SuccessCriterion` (type) | `src/contracts/sprint-contract.ts:78` | `{criterionId, description, verificationMethod, required}` | `verificationMethod` is a strong category key for grouping. |
| `VerificationMethod` (enum) | `src/contracts/sprint-contract.ts:55-64` | manual/typecheck/lint/unit-test/playwright/api-check/build/agent-evaluation | Deterministic category for "repeated failing eval strategies". |
| `EvalResult` / `CriterionResult` | `src/contracts/eval-result.ts:79, 30` | `CriterionResult = {criterionId, description, required, result: pass\|fail\|skipped, evidence?, feedback?}` | If eval results are surfaced in history `details` or contract `evalResults`, use `result==="fail"` + `criterionId` as the failure signature. |
| `findProjectRoot` | `src/utils/fs.ts:58` | `(): Promise<string \| null>` | Used by every CLI handler via a local `resolveRoot()` wrapper. |
| `ensureDir` | `src/state/helpers.ts:6` | `(dirPath: string): Promise<void>` | Already called inside `appendLesson` — you do NOT need to call it from the command. |
| `logger` | `src/utils/logger.ts:87` | `Logger` instance (.info/.success/.warn/.error) | Exists but CLI commands print via `process.stdout.write`; do not switch styles. |

**Utilities reviewed and NOT applicable:** `randomUUID`/`randomBytes` (`node:crypto`) — distill needs deterministic ids, so use `createHash` instead. No existing `createHash`, content-hash, or dedupe utility exists — you write the hash helper inline in `distill.ts`.

---

## 4. Prior Sprint Output

### Sprint 2: Deterministic lessons memory store
**Created:** `src/state/memory.ts` — exports `LessonEntrySchema`, `LessonEntry`, `LessonIndexRecord`, `appendLesson`, `loadLessonIndex`, `loadLesson`.
**Connection:** distill's output element type is `LessonEntry` (`src/state/memory.ts:40`); the CLI persists via `appendLesson` and reads via `loadLessonIndex`/`loadLesson`. **`memory.ts` is NOT in the `src/state/index.ts` barrel** — import directly from `../../state/memory.js` (confirmed: barrel `src/index.ts:140-155` lists `appendHistory`/`loadHistory` but NOT any lesson fn).
**Schema constraints you MUST satisfy:** `sourceEntryRefs` non-empty (`src/state/memory.ts:37`), `occurrences` positive int (`:35`), `severity ∈ {info,warn,high}` (`:36`), `createdAt` must be `datetime()` ISO (`:31`).

### Sprint 1: Bounded history reads + crash-safe rotation
**Created:** `src/state/history.ts` (`loadHistory` full stream, `loadRecentHistory` tail), `src/state/history-rotation.ts`.
**Connection:** distill consumes `loadHistory(projectRoot)` (full archive+active) — nonGoal forbids changing `loadHistory` or its signature.

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` consulted for this sprint scope. Determinism + no-network constraints come from the contract (`successCriteria` C1/C3, `nonGoals[0]`, `nonGoals[1]`).

### Architecture Decisions
`.bober/architecture/` exists but no ADR is specific to memory distillation. The relevant invariants are encoded in the contract: distill is the planner's future feedback source (Sprint 4 wires retrieval), so it must stay pure and CLI-only.

### Other Docs / Conventions
- TypeScript strict, ESM `.js` specifiers on all relative imports, `import type` for type-only imports, zod for schemas, Vitest collocated (`*.test.ts` next to source), `node:fs/promises`.
- CLI handlers never throw: `process.exitCode = 1` + `process.stderr.write` (documented in `src/cli/commands/incident.ts:11-13`).

---

## 6. Testing Patterns

### Unit Test Pattern — temp project + fixture seeding
**Source:** `src/cli/commands/telemetry.test.ts:7-36`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-memory-cmd-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });
```
**Runner:** vitest. **Assertion style:** `expect(...)`. **File naming:** `<name>.test.ts` collocated. **Seeding:** write fixtures into `join(tmpDir, ".bober", ...)` with `mkdir(..., { recursive: true })`.

### Command-registration assertion (C4 structural check)
**Source:** `src/cli/commands/audit-show.test.ts:171-188`
```ts
const { Command } = await import("commander");
const { registerMemoryCommand } = await import("./memory.js");
const program = new Command();
program.exitOverride();
registerMemoryCommand(program);
const memCmd = program.commands.find((c) => c.name() === "memory");
expect(memCmd).toBeDefined();
const subNames = memCmd!.commands.map((c) => c.name());
expect(subNames).toEqual(expect.arrayContaining(["distill", "list", "show"]));
```

### Capturing printed output (C4 "asserts the printed counts")
**Source:** `src/cli/commands/plan.test.ts:38` (console spy) — adapt for `process.stdout.write`:
```ts
const writes: string[] = [];
const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
  writes.push(String(chunk)); return true;
});
// invoke the distill subcommand action against tmpDir...
expect(writes.join("")).toContain("distilled");
expect(writes.join("")).toMatch(/\(\d+ new\)/);
stdoutSpy.mockRestore();
```
Note: `chalk` may strip colors in test env; assert on substrings (`"distilled"`, `"new"`), not exact color codes.

### Pure-function determinism test (C1)
Build a FIXED `HistoryEntry[]` + `SprintContract[]` fixture inline (no fs), call `distill(...)` twice, and assert `JSON.stringify(a) === JSON.stringify(b)` AND deep-equals an exact expected `LessonEntry[]` (with a frozen/sentinel `createdAt` if approach (B), or omit `createdAt` if approach (A)).

### No-provider guard test (C3)
**Source:** providers live at `src/providers/factory.ts:172` (`createClient`), `:230` (`new AnthropicAdapter`), `:233` (`new OpenAIAdapter`). **Simplest, strongest guarantee: a STATIC-IMPORT check.** distill.ts must NOT import anything from `../providers`. Assert it in two complementary ways:
```ts
// (a) static: read the source file, assert no provider import string is present
import { readFile } from "node:fs/promises";
const src = await readFile(new URL("./distill.ts", import.meta.url), "utf-8");
expect(src).not.toMatch(/from ["'].*providers/);
expect(src).not.toMatch(/node:https?|fetch\(/);
// (b) runtime spy: spy on the factory and assert it is never called during distill()
import * as factory from "../../providers/factory.js";
const spy = vi.spyOn(factory, "createClient");
distill(historyFixture, contractsFixture);
expect(spy).not.toHaveBeenCalled();
spy.mockRestore();
```
Document in distill.ts a header comment: "PURE — must not import from ../providers; no network."

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/cli/index.ts` | new `registerMemoryCommand` | low | Adding an import + one call; mirror `incident` exactly. Typecheck catches a bad import path. |
| `src/index.ts` (if barrel-exported) | new `distill` export | low | Optional; an export-only addition cannot break existing consumers. |
| `src/state/memory.ts` | UNCHANGED (consumed only) | none | nonGoal forbids changing the LessonEntry schema. Do not edit it. |
| `src/state/history.ts` | UNCHANGED (consumed only) | none | nonGoal forbids changing `loadHistory`. Do not edit it. |
| `pipeline.ts` | MUST NOT change | none | evaluatorNotes: confirm `pipeline.ts` has NO new call into `distill`. CLI is the only entry point. |

### Existing Tests That Must Still Pass
- `src/state/memory.test.ts` — covers `appendLesson`/`loadLessonIndex`/`loadLesson` (Sprint 2). You consume these unchanged; these tests must remain green.
- `src/state/history.test.ts` (and `history-rotation.test.ts`) — Sprint 1. Unchanged consumption; must remain green.
- `src/cli/commands/audit-show.test.ts`, `worktree.test.ts`, `telemetry.test.ts` — registration-pattern siblings; unaffected, but confirm `npm run build`/typecheck still pass after editing `src/cli/index.ts`.
- `src/contracts/sprint-contract.test.ts`, `eval-result.test.ts` — type sources you import; unchanged.

### Features That Could Be Affected
- **Sprint 4 (planner reads lessons)** — shares `src/state/memory.ts` and the lesson INDEX.md format. Keep `appendLesson`'s INDEX.md line format intact (it already upserts). Do not change the lesson markdown/front-matter shape.
- **Existing CLI command surface** — adding a top-level `memory` command must not collide with any existing command name. Confirmed no existing `memory` command (`src/cli/index.ts` registers init/plan/sprint/eval/run/mcp/graph/onboard/impact/approve/reject/list-approvals/audit/rollback/postmortem/incident/playbook/config/telemetry/worktree — no `memory`).

### Recommended Regression Checks
1. `npm run typecheck` exits 0.
2. `npm run build` exits 0.
3. `npx vitest run src/orchestrator/memory/distill.test.ts src/cli/commands/memory.test.ts` — new tests green.
4. `npx vitest run src/state/memory.test.ts src/state/history.test.ts` — Sprint 1/2 tests still green.
5. `git diff --name-only` confined to: `src/orchestrator/memory/distill.ts`, `src/orchestrator/memory/distill.test.ts`, `src/cli/commands/memory.ts`, `src/cli/commands/memory.test.ts`, `src/cli/index.ts`, and OPTIONALLY `src/index.ts` (barrel re-export). **`pipeline.ts` must NOT appear.**
6. Manual idempotency: run `bober memory distill` twice against a seeded temp project; second run prints `(0 new)` and `.bober/memory/INDEX.md` line count is unchanged.

---

## 8. Implementation Sequence

1. **`src/orchestrator/memory/distill.ts`** — write the pure `distill(history, contracts)` first (no deps on the CLI). Define the failure-signature grouping (by `verificationMethod` / failed `criterionId` / `phase==="failed"` events), the `createHash`-based `lessonId`, severity band, and the iteration-threshold flag (`iterationHistory.length >= 3`). Decide createdAt strategy (A omit vs B injected clock) and document it.
   - Verify: import-only typecheck passes; no `../providers` import; no `Date.now()`.
2. **`src/orchestrator/memory/distill.test.ts`** — fixture-based determinism (C1), idempotency-via-stable-hash, and the no-provider static + spy guard (C3).
   - Verify: `npx vitest run src/orchestrator/memory/distill.test.ts` green.
3. **`src/cli/commands/memory.ts`** — `registerMemoryCommand(program)` with `distill | list | show`. distill loads `loadHistory`+`listContracts`, stamps `createdAt = new Date().toISOString()`, persists via `appendLesson`, prints `distilled N lessons (M new)`. list → `loadLessonIndex`. show → `loadLesson` rendering `sourceEntryRefs`.
   - Verify: command names registered; handlers don't throw.
4. **`src/cli/index.ts`** — add `import { registerMemoryCommand } from "./commands/memory.js";` (near line 30) and `registerMemoryCommand(program);` (in the register block, ~line 282).
   - Verify: `bober --help` (or the registration test) lists `memory`.
5. **`src/cli/commands/memory.test.ts`** — temp-project (mkdtemp) seeded with a history fixture + contract fixtures; invoke the three handlers; assert printed count summary, list output, and that `show <id>` renders provenance (sourceEntryRefs). Assert second `distill` run adds zero new index lines (C2).
   - Verify: `npx vitest run src/cli/commands/memory.test.ts` green.
6. **(Optional) `src/index.ts`** — add `export { distill } from "./orchestrator/memory/distill.js";` if a barrel export is desired.
7. **Run full verification** — `npm run typecheck`, `npm run build`, then `npx vitest run` for the new + Sprint 1/2 memory/history tests. Confirm `git diff --name-only` is confined (no `pipeline.ts`).

**Determinism rule (restate):** The pure `distill` takes NO clock by default (or an INJECTED clock); `createdAt` is stamped at PERSIST time in the command handler with `new Date().toISOString()`. `lessonId` is a `createHash` over `category+tags+sourceEntryRefs` — never derived from time. Output array must be sorted deterministically (e.g., by lessonId) so repeated calls produce byte-identical results.

---

## 9. Pitfalls & Warnings

- **`src/index.ts` is the library barrel, not the CLI.** Do NOT put commander registration there. The commander registration site is `src/cli/index.ts:243-282`. (The contract's estimatedFiles lists `src/index.ts` — interpret it as "the registration site"; the real one is `src/cli/index.ts`.)
- **`memory.ts` is NOT in the `src/state/index.ts` barrel.** Import lesson functions from `../../state/memory.js` directly. Importing from `../../state/index.js` will fail to resolve them.
- **`createHash` has no precedent — you introduce it.** Use `import { createHash } from "node:crypto";` and a CANONICAL input (sort `tags` and `sourceEntryRefs` before hashing) so reordering doesn't change the id.
- **`createdAt` purity trap.** `LessonEntrySchema` requires `createdAt` (`src/state/memory.ts:31`). Do NOT call `new Date()` / `Date.now()` inside `distill` — that breaks C1 determinism AND C3 purity. Stamp it in the CLI handler, or return drafts without it, or inject a frozen clock in tests.
- **`sourceEntryRefs` MUST be non-empty** (`src/state/memory.ts:37`, `.min(1)`). Every lesson must aggregate at least one history entry / sprintId or `appendLesson` throws. `HistoryEntry` has no stable `id` field (`src/state/history.ts:38-44`) — use `sprintId` (when present) or a synthesized stable ref like `${phase}:${event}` or the entry's `timestamp`. Pick a deterministic ref scheme.
- **Don't recompute idempotency by hand.** `appendLesson` already upserts one INDEX.md line per lessonId (`src/state/memory.ts:225-230`). Idempotency falls out of a STABLE content hash. The `(M new)` counter compares against the pre-existing index (`loadLessonIndex` before the loop).
- **`iterationHistory` is `z.array(z.unknown())`** (`src/contracts/sprint-contract.ts` field). Only its `.length` is reliably typed — do NOT index into elements assuming a shape. Threshold check = `contract.iterationHistory.length >= THRESHOLD`.
- **No network / no provider import in distill.** The strongest guarantee is a static check: distill.ts imports nothing from `../providers`. Providers are constructed at `src/providers/factory.ts:172/230/233`; your C3 test spies `createClient` and/or greps the source.
- **CLI handlers must not throw.** Catch, `process.stderr.write(chalk.red(...))`, `process.exitCode = 1`, `return` (per `src/cli/commands/incident.ts:11-13`). `memory show <missing-id>` should print a friendly not-found (loadLesson throws "Lesson not found" — catch it).
- **Use `process.stdout.write`, not `console.log`** for command output, matching the incident/audit precedent. Tests spy on `process.stdout.write`.
- **chalk in tests:** assert on plain substrings; color codes may differ across environments.
