# Sprint Briefing: Snooze with wake semantics

**Contract:** sprint-spec-20260628-task-inbox-3
**Generated:** 2026-06-29T00:00:00.000Z

> Adds `bober task snooze <id> --until <when>`: sets status=`snoozed`, records a
> `snooze-until:<ISO>` tag (reuses `tags[]`, NO schema field), and makes the default
> `task list` hide a snoozed task until its wake time `<= now` (now injected, lazy wake).

---

## 1. Target Files

### src/hub/finding-store.ts (modify — ADDITIVE)

You ADD a pure visibility helper + a tag-prefix constant. You do **NOT** touch
`writeFinding`, `readFindings`, or `transitionFinding` — they already do everything snooze needs.

**`transitionFinding` — the exact reuse point (lines 62-73):**
```ts
export async function transitionFinding(
  store: FactStore,
  id: string,
  newStatus: Finding["status"],
  { now, mutate }: { now: string; mutate?: Partial<Finding> },
): Promise<Finding | null> {
  const current = readFindings(store).find((f) => f.id === id);
  if (current === undefined) return null;
  const next: Finding = { ...current, ...mutate, status: newStatus };  // mutate OVERWRITES fields
  await writeFinding(store, next, { now });
  return next;
}
```
**CRITICAL:** `mutate` is spread as `{ ...current, ...mutate }` — passing `mutate: { tags: [...] }`
**replaces** the whole `tags` array. So you must compute the new `tags` from `current.tags`
(strip+append) **before** calling, then pass the finished array. `transitionFinding` will NOT
merge arrays for you.

**`readFindings` shape (lines 44-48):** `readFindings(store): Finding[]` — returns active
hub findings (status filtering is the caller's job). Use it to grab `current.tags`.

**HUB_SCOPE:** imported from `./finding-source.js` (value `"hub"`, finding-source.ts:8).

**Imported by (dependents of this file):**
- `src/cli/commands/task.ts` — imports `readFindings`, `transitionFinding`
- `src/hub/task-inbox.ts` — imports `writeFinding`
- `src/cli/commands/task.test.ts` + `src/hub/finding-store.test.ts` — tests

**Test file:** `src/hub/finding-store.test.ts` (exists)

---

### src/cli/commands/task.ts (modify)

Three edits: (a) add a `runTaskSnooze` DI core, (b) thread `now` into `runTaskList` and swap its
default filter to the wake-aware helper, (c) register the `snooze <id>` subcommand + update the
`list` handler to stamp `now`.

**`ACTIVE_STATUSES` + current default filter (lines 89, 97-107):**
```ts
const ACTIVE_STATUSES: ReadonlyArray<Finding["status"]> = ["open", "in-progress"];

export function runTaskList(
  store: FactStore,
  opts: { all?: boolean; status?: string },
): void {
  try {
    let findings = readFindings(store);
    if (opts.status) {
      findings = findings.filter((f) => f.status === opts.status);
    } else if (!opts.all) {
      findings = findings.filter((f) => ACTIVE_STATUSES.includes(f.status));  // <-- REPLACE this line
    }
```
**Change:** `runTaskList` must gain a `now: string` parameter, and the default branch becomes
`findings.filter((f) => isVisibleInDefaultList(f, now))`. (`ACTIVE_STATUSES` can stay — the helper
uses the same statuses; or move the literal into the helper.)

**`runTaskTransition` DI core (lines 138-162)** — REUSE AS-IS for sc-3-4 (`done` on a snoozed task).
No change needed; done is not snoozed/active so the task leaves the default list automatically.
Note the not-found convention: `chalk.yellow(...)` + `process.exitCode = 1` + `return`.

**Boundary `now`-stamping + store lifecycle (the pattern every write subcommand follows, lines 237-249):**
```ts
.action(async (id: string) => {
  const projectRoot = await resolveRoot();
  try {
    const ns = await resolveDefaultNamespace(projectRoot);
    await ensureFactsDir(projectRoot, ns);
    const now = new Date().toISOString();              // wall clock ONLY here, at the boundary
    const store = new FactStore(factsDbPath(projectRoot, ns));
    try {
      await runTaskTransition(store, id, status, now);
    } finally {
      store.close();
    }
  } catch (err) { /* chalk.red + exitCode=1 */ }
});
```
The `list` handler (lines 207-226) currently calls `runTaskList(store, opts)` with NO `now` — it must
now stamp `const now = new Date().toISOString();` and pass it: `runTaskList(store, opts, now)`.

**Imported by:** `src/cli/index.ts:38` imports `registerTaskCommand`, calls it at index.ts:322.
`runTaskList` is called ONLY at task.ts:214 + in task.test.ts — no external callers, so the signature
change is contained to files this sprint owns.

**Test file:** `src/cli/commands/task.test.ts` (exists)

---

### src/hub/finding.ts (read-only — confirms NO schema change)

```ts
tags: z.array(z.string()),                                            // finding.ts:20 — string[]
status: z.enum(["open", "in-progress", "snoozed", "done", "dropped"]),  // finding.ts:23 — "snoozed" ALREADY present
```
**Confirmed:** `tags` is `string[]` so `"snooze-until:<ISO>"` is schema-valid with zero edits, and
`"snoozed"` is already a legal status. **Do NOT add a field. Do NOT edit finding.ts.** (Adding a
field would violate nonGoal #1 and the evaluatorNotes check.)

---

## 2. Patterns to Follow

### Pure DI core + never-throw handler
**Source:** `src/cli/commands/task.ts`, lines 138-162 (`runTaskTransition`)
```ts
export async function runTaskTransition(store, id, newStatus, now): Promise<void> {
  try {
    const updated = await transitionFinding(store, id, newStatus, { now });
    if (updated === null) {
      process.stderr.write(chalk.yellow(`task: no task found with id ${id}\n`));
      process.exitCode = 1; return;
    }
    process.stdout.write(chalk.green(`Task ${chalk.bold(id)} → ${chalk.bold(newStatus)}\n`));
  } catch (err) {
    process.stderr.write(chalk.red(`Failed to update task: ${err instanceof Error ? err.message : String(err)}\n`));
    process.exitCode = 1;
  }
}
```
**Rule:** Write `runTaskSnooze(store, id, until, now)` the same way — try/catch, never throw, report
via `chalk` + `process.exitCode = 1` + `return`. Use `chalk.red` for the bad-`--until` parse error
(sc-3-5), `chalk.yellow` for not-found id, `chalk.green` for success.

### requiredOption + action declaration
**Source:** `src/cli/commands/reject.ts`, lines 34-38
```ts
program
  .command("reject <checkpointId>")
  .description("Reject a pending checkpoint by writing the .rejected.json marker")
  .requiredOption("--feedback <text>", "Why the checkpoint is rejected")
  .action(async (checkpointId: string, opts: { feedback: string }) => { /* ... */ });
```
**Rule:** Declare `snooze <id>` with `.requiredOption("--until <when>", "Wake time (ISO date or datetime)")`
and `.action(async (id: string, opts: { until: string }) => { ... })`. Commander enforces presence of
`--until`; YOUR code enforces parseability (the NaN check below).

### Boundary parse of user date input (allowed wall-clock-adjacent op)
**Source:** allowed by the contract assumptions + principles note; mirrors `new Date().toISOString()` boundary stamping at task.ts:243
```ts
const d = new Date(opts.until);          // parse user input — NOT a clock read
if (Number.isNaN(d.getTime())) {         // unparseable → sc-3-5 error path
  process.stderr.write(chalk.red(`task snooze: invalid --until value: ${opts.until}\n`));
  process.exitCode = 1;
  return;
}
const untilIso = d.toISOString();        // normalized ISO stored in the tag
```
**Rule:** `new Date(<userInput>)` is permitted at the CLI handler / DI-core boundary because it parses
a supplied string, not the wall clock. It must NEVER appear inside `finding-store.ts` helpers.

### Strip-then-append the snooze tag (replace, never stack)
**Rule (from generatorNotes + evaluatorNotes):** compute the next tags from the CURRENT finding so a
re-snooze replaces rather than stacks:
```ts
const tags = [
  ...current.tags.filter((t) => !t.startsWith(SNOOZE_TAG_PREFIX)),  // drop any prior snooze-until:*
  `${SNOOZE_TAG_PREFIX}${untilIso}`,                                // append the fresh one
];
await transitionFinding(store, id, "snoozed", { now, mutate: { tags } });
```

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `transitionFinding` | `src/hub/finding-store.ts:62` | `(store, id, newStatus, {now, mutate?}): Promise<Finding\|null>` | Read active finding by id, apply status+mutate, write back (supersede+insert). REUSE for snooze. |
| `readFindings` | `src/hub/finding-store.ts:44` | `(store): Finding[]` | Read all active hub findings; use to grab `current.tags` before snoozing. |
| `writeFinding` | `src/hub/finding-store.ts:16` | `(store, finding, {now}): Promise<ReconcileAction>` | Low-level persist; you won't call directly — `transitionFinding` wraps it. |
| `captureTask` | `src/hub/task-inbox.ts:22` | `(store, text, {domain?, now}): Promise<Finding>` | Seed an open task in tests (sha256 id, now injected). |
| `HUB_SCOPE` | `src/hub/finding-source.ts:8` | `"hub"` | FactStore scope const; already used inside finding-store. |
| `FindingSchema` / `Finding` | `src/hub/finding.ts:10,27` | zod schema / `z.infer` type | Canonical schema. `tags: string[]`, status includes `"snoozed"`. Import `Finding` as `import type`. |
| `FactStore` | `src/state/facts.ts` | `new FactStore(path)` | SQLite store; `new FactStore(":memory:")` in tests. |
| `factId` | `src/state/facts.ts:58` | `(scope, subject, predicate, value, tCreated): string` | Deterministic row id (used in finding-store.test.ts:78 to assert history). |
| `factsDbPath` / `ensureFactsDir` | `src/state/facts.ts` | path resolver / dir creator | Used in the CLI handler boundary (task.ts:185, 211). |

Utilities reviewed: `src/utils/` (fs.ts/git.ts/logger.ts), `src/state/`, `src/hub/` — the snooze logic
needs NO new utility. A `string.startsWith` filter + `new Date()` boundary parse suffice. Do NOT add a
date-parsing library (nonGoal #5: no new dependencies).

---

## 4. Prior Sprint Output

### Sprint 1 (0e39c15): capture
**Created:** `src/hub/finding-store.ts` (`writeFinding`/`readFindings`), `src/hub/task-inbox.ts`
(`captureTask`, sha256 id), `src/cli/commands/task.ts` (`registerTaskCommand` + `runTaskAdd`).
**Connection:** `captureTask` seeds open tasks in your new tests; `tags[]` exists on every Finding.

### Sprint 2 (5e2bc2f + 26f45db): lifecycle + list
**Created/extended:** `transitionFinding(store, id, newStatus, {now, mutate?})` in finding-store.ts;
`runTaskList` (default filter `ACTIVE_STATUSES`), `start`/`done`/`drop` subcommands, `runTaskTransition`
in task.ts. `now` stamped at the handler boundary (task.ts:243).
**Connection:** Snooze REUSES `transitionFinding` with `newStatus="snoozed"` + `mutate:{tags}`. You EXTEND
`runTaskList`'s default filter to be wake-aware. `done`/`drop` on a snoozed task already work unchanged
(sc-3-4) — do NOT alter them (nonGoal #3).

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM `.js` extensions** on all imports (NodeNext) — principles.md:27.
- **`import type { ... }`** enforced by `consistent-type-imports` — principles.md:35. Import `Finding`,
  `Command`, `FactStore` as `import type`.
- **Tests collocated** `*.test.ts` next to source, Vitest — principles.md:20.
- **Strict TS**, zero type/lint errors are hard gates — principles.md:18-19.
- **Section comments** `// ── Section ──` box-drawing headers — principles.md:32 (already used in task.ts).

### Sprint-specific clock rule (from contract + orchestrator note)
- NO `Date.now()` / no-arg `new Date()` (clock read) inside the list filter or any `finding-store.ts`
  helper — `now` is INJECTED. `isVisibleInDefaultList(finding, now)` MUST take `now` as a parameter and
  compare strings; it must not construct a `Date` from the clock.
- `new Date(opts.until)` to PARSE the user's `--until` string is allowed **only at the CLI handler /
  DI-core boundary** (that's where wall clock + user input live).

### Architecture Decisions
No `.bober/architecture/` ADR is specific to this sprint. The bitemporal supersede behavior that
`transitionFinding` relies on is documented inline at finding-store.ts:52-60 (reconcile UPDATE branch).

---

## 6. Testing Patterns

### Unit Test Pattern
**Source:** `src/cli/commands/task.test.ts` lines 81-147 + `src/hub/finding-store.test.ts` lines 66-102
```ts
import { describe, it, expect, vi } from "vitest";
import { FactStore } from "../../state/facts.js";
import { runTaskList, runTaskTransition } from "./task.js";
import { captureTask } from "../../hub/task-inbox.js";
import { readFindings } from "../../hub/finding-store.js";

const T0 = "2026-06-28T00:00:00.000Z";  // capture time
const T1 = "2026-06-29T00:00:00.000Z";  // wake time
const T2 = "2026-06-30T00:00:00.000Z";  // after wake

it("sc-3-3: snoozed task hidden before wake, visible after", async () => {
  const store = new FactStore(":memory:");
  const writes: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((c) => { writes.push(String(c)); return true; });

  const task = await captureTask(store, "deferred task", { now: T0 });
  await runTaskSnooze(store, task.id, T1, T0);   // wake at T1, stored as new Date(T1).toISOString()

  writes.length = 0;
  runTaskList(store, {}, T0);                     // now BEFORE wake -> absent
  expect(writes.join("")).not.toContain(task.id);

  writes.length = 0;
  runTaskList(store, {}, T2);                     // now AFTER wake -> present
  expect(writes.join("")).toContain(task.id);
  store.close();
});
```
**sc-3-2 (exact tag match):** snooze until a FULL ISO (`"2026-12-01T00:00:00.000Z"`) so the stored value
round-trips identically, then assert on the active Finding read back via `readFindings`:
```ts
const active = readFindings(store).find((f) => f.id === task.id)!;
expect(active.status).toBe("snoozed");
expect(active.tags).toContain(`snooze-until:2026-12-01T00:00:00.000Z`);
```
**sc-3-4 (done on snoozed):** `await runTaskSnooze(...)` then `await runTaskTransition(store, id, "done", T1)`;
assert `readFindings` active status is `"done"` and `runTaskList(store, {}, T2)` output does NOT contain the id.
**sc-3-5 (bad --until):** spy `process.stderr.write`, `await runTaskSnooze(store, id, "not-a-date", T0)`,
`expect(process.exitCode).toBe(1)` and the promise resolves (no throw). Reset `process.exitCode = 0` in
`beforeEach` (task.test.ts:11-13).

**Runner:** vitest · **Assertion:** `expect()` · **Mock:** `vi.spyOn(process.stdout/stderr, "write")`
returning `true`; `vi.restoreAllMocks()` in `afterEach`. **Store:** `new FactStore(":memory:")` + `store.close()`.
**File naming/location:** collocated `*.test.ts`. **Clock:** injected via the trailing `now`/`T*` arg — NEVER `Date.now()`.

### E2E Test Pattern
Not applicable — this is a CLI/library sprint; no Playwright config governs `src/`.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/cli/commands/task.test.ts` | `runTaskList` (3 calls: lines 138, 161, 177) | **high** | Adding `now` param to `runTaskList` makes these TS-error (missing arg). Update each to `runTaskList(store, opts, T)`. |
| `src/cli/commands/task.ts` (list handler, line 214) | `runTaskList` | **high** | Same signature change — stamp `now` in the `list` action and pass it. |
| `src/hub/finding-store.test.ts` | `transitionFinding`/`readFindings`/`writeFinding` | **low** | You only ADD exports to finding-store.ts; these existing functions are untouched, tests stay green. |
| `src/hub/task-inbox.ts` | `writeFinding` | **low** | `writeFinding` unchanged — no impact. |
| `src/cli/index.ts` | `registerTaskCommand` | **low** | Calls the registrar, not `runTaskList`. The new `snooze` subcommand registers additively. |

### Existing Tests That Must Still Pass
- `src/cli/commands/task.test.ts` — `runTaskList` suite (sc-2-3 default/--all/--status, empty store) — **will not
  compile** until you add the `now` arg to each call; once updated, behavior must be unchanged for open/done tasks.
- `src/hub/finding-store.test.ts` — sc-2-2 (done supersedes + history), sc-2-4 (start), null-on-unknown-id — must
  stay green; do not modify `transitionFinding`.
- `src/cli/commands/task.test.ts` — `runTaskAdd` suite (sc-1-5) — unaffected.

### Features That Could Be Affected
- **Task lifecycle (sprint 2 done/drop/start)** — shares `transitionFinding` + the default list filter. Verify
  done/dropped tasks still vanish from the default list and `--all`/`--status` still surface them after the filter swap.
- Sibling `kb-*` / hub consumers read Findings via `FactStoreFindingSource` (finding-source.ts) — they tolerate any
  `tags[]`/status, so the new tag + `snoozed` status are inert to them. No change required there.

### Recommended Regression Checks
1. `npm run build` — exits 0 (catches the `runTaskList` arity change everywhere).
2. `npx vitest run src/cli/commands/task.test.ts src/hub/finding-store.test.ts` — full task + store suites green.
3. Manual: `bober task add "x"` → `bober task snooze <id> --until 2999-01-01T00:00:00.000Z` → `bober task list`
   (absent) → re-run conceptually with a past `--until` to confirm it reappears (or rely on the injected-now tests).
4. `bober task snooze <id> --until garbage` → prints red error, exit code 1, no stack trace.

---

## 8. Implementation Sequence

1. **`src/hub/finding-store.ts`** — add (additive exports, no clock):
   - `export const SNOOZE_TAG_PREFIX = "snooze-until:";`
   - `export function snoozeUntil(finding: Finding): string | null` (find tag with prefix, slice off prefix, else null).
   - `export function isVisibleInDefaultList(finding: Finding, now: string): boolean` — `true` if status is
     `open`/`in-progress`; if `snoozed`, return `wake !== null && wake <= now` (lexicographic compare of normalized
     ISO strings — safe because both sides are `toISOString()` output); else `false`. **Takes `now` as a param; no `new Date()`.**
   - Verify: `npm run build`; `npx vitest run src/hub/finding-store.test.ts` still green.
2. **`src/cli/commands/task.ts`** — wire the command:
   - Import `isVisibleInDefaultList`, `SNOOZE_TAG_PREFIX` from `../../hub/finding-store.js`.
   - Add `runTaskSnooze(store, id, until, now)` DI core: `new Date(until)` NaN-guard → `chalk.red` + `exitCode=1` + return;
     `const untilIso = d.toISOString();` read `current` via `readFindings(...).find(f=>f.id===id)` (not-found →
     `chalk.yellow` + exit 1); strip+append the snooze tag; `await transitionFinding(store, id, "snoozed", { now, mutate: { tags } })`.
   - Change `runTaskList(store, opts, now: string)` and swap the default branch to `isVisibleInDefaultList(f, now)`.
   - Update the `list` action (lines 207-226) to stamp `const now = new Date().toISOString();` and pass it.
   - Register `snooze <id>` with `.requiredOption("--until <when>", ...)`, stamp `now`, open/close store, call `runTaskSnooze`.
   - Verify: `npm run build` (will surface the test arity errors next).
3. **`src/cli/commands/task.test.ts`** — update the 3 existing `runTaskList(store, ...)` calls to pass a `T` clock;
   add sc-3-2 (exact tag), sc-3-3 (before/after wake), sc-3-4 (done on snoozed), sc-3-5 (bad `--until`).
   **`src/hub/finding-store.test.ts`** — optional: add a direct `isVisibleInDefaultList` unit test (snoozed
   before/after wake, open always visible).
   - Verify: `npx vitest run src/cli/commands/task.test.ts src/hub/finding-store.test.ts`.
4. **Run full verification** — `npm run build`, `npm test` (or `npx vitest run`), lint/typecheck clean (sc-3-1).

---

## 9. Pitfalls & Warnings

- **`runTaskList` arity change is the #1 break risk.** Adding `now` errors 3 test calls (task.test.ts:138,161,177)
  AND the in-file handler (task.ts:214). Update all four. `npm run build` catches it.
- **`mutate` overwrites, it does not merge.** `transitionFinding` does `{ ...current, ...mutate }`, so `mutate.tags`
  replaces the array. Compute the full next-tags array (strip prior `snooze-until:*` + append) from `current.tags`
  before calling — never expect array merging.
- **Re-snooze must REPLACE, not stack** (evaluatorNotes). The `.filter(t => !t.startsWith(SNOOZE_TAG_PREFIX))` before
  the append is mandatory; a second snooze must leave exactly one `snooze-until:` tag.
- **Lexicographic ISO compare is only valid for normalized strings.** Always store `new Date(when).toISOString()`
  (full `…T…Z`, millisecond precision). If you store a date-only or non-normalized string, `wake <= now` can misorder.
- **No clock inside the helper.** `isVisibleInDefaultList`/`snoozeUntil` must take `now` and compare strings — no
  `new Date()`/`Date.now()`. Only the CLI handler + `runTaskSnooze` boundary may call `new Date(until)` (parsing input)
  and `new Date().toISOString()` (stamping now).
- **Do NOT edit `src/hub/finding.ts`.** `tags` is already `string[]` and `"snoozed"` is already in the status enum.
  Adding a field fails the evaluatorNotes/nonGoal-#1 check.
- **Do NOT alter `done`/`drop`/`start`** beyond the natural effect of a snoozed task leaving the list (nonGoal #3).
  `runTaskTransition` is reused untouched for sc-3-4.
- **`requiredOption` vs parse-failure are different paths.** Commander errors at parse time if `--until` is OMITTED;
  the sc-3-5 unparseable-VALUE path is your own `Number.isNaN(d.getTime())` check inside `runTaskSnooze`.
- **`import type`** for `Finding`/`Command`/`FactStore`, **`.js`** extensions on every import (lint/build hard gates).
