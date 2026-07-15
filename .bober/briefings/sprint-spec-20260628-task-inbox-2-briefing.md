# Sprint Briefing: Task listing + lifecycle transitions (start / done / drop)

**Contract:** sprint-spec-20260628-task-inbox-2
**Generated:** 2026-06-29T00:00:00.000Z

---

## 0. TL;DR (read this first)

Add ONE pure helper `transitionFinding` to `src/hub/finding-store.ts`, then add four
subcommands (`list`, `start`, `done`, `drop`) + their DI cores to `src/cli/commands/task.ts`,
then extend the two existing `*.test.ts` files. Nothing in sprint-1 changes shape.

**The load-bearing detail (sc-2-2):** transitions MUST go through `writeFinding` → `writeFact`
→ `reconcileFact`, which on a *different value for the same subject+predicate* takes the
UPDATE branch = `supersedeFact(old)` + `insertFact(new)` (`reconcile.ts:70-78`). The old row
is NOT deleted — it survives with `t_invalidated` set. To READ that historical row back in a
`:memory:` test you reconstruct its deterministic id and call `store.getFact(oldId)` (there is
no "list all rows incl. invalidated" method). Exact recipe in §6.

---

## 1. Target Files

### src/hub/finding-store.ts (modify — ADD `transitionFinding`)

Current full contents (49 lines). The two existing exports are the building blocks; you ADD a
third export below them. DO NOT change `writeFinding` / `readFindings`.

**`writeFinding` signature (lines 16-35):**
```ts
export async function writeFinding(
  store: FactStore,
  finding: Finding,
  { now }: { now: string },
): Promise<ReconcileAction> {
  return writeFact(store, {
    scope: HUB_SCOPE, subject: finding.id, predicate: "finding",
    value: JSON.stringify(finding), confidence: 1, sourceRunId: null,
    tValid: now, tCreated: now,
  }, { now });
}
```
Note: `subject = finding.id`, `predicate = "finding"`, `tValid = tCreated = now`. These are
what make the reconcile UPDATE branch fire when only the `value` (status) changes.

**`readFindings` signature (lines 44-48):**
```ts
export function readFindings(store: FactStore): Finding[] {
  return store
    .getActiveFacts(HUB_SCOPE, undefined, "finding")
    .map((r) => FindingSchema.parse(JSON.parse(r.value) as unknown));
}
```
`readFindings` returns ACTIVE rows only (superseded rows are excluded — that is exactly why a
done task disappears from the default list). It throws on malformed rows (`.parse`, not
`.safeParse`).

**What to add (new export, append after line 48):**
```ts
// ── transitionFinding ─────────────────────────────────────────────────

/**
 * Read the active Finding for `id`, apply `newStatus` (+ optional field
 * mutation), and write it back via writeFinding. Because subject=id and
 * predicate='finding' are unchanged but the value differs, reconcileFact
 * takes the UPDATE branch (supersede old + insert new), preserving the
 * prior row as bitemporal history (reconcile.ts:70-78).
 *
 * Returns the new Finding, or null if no active Finding has that id.
 * PURE: never reads the clock — `now` is injected at the CLI boundary.
 */
export async function transitionFinding(
  store: FactStore,
  id: string,
  newStatus: Finding["status"],
  { now, mutate }: { now: string; mutate?: Partial<Finding> },
): Promise<Finding | null> {
  const current = readFindings(store).find((f) => f.id === id);
  if (current === undefined) return null;
  const next: Finding = { ...current, ...mutate, status: newStatus };
  await writeFinding(store, next, { now });
  return next;
}
```
- `status: newStatus` is LAST in the literal so it always wins over any `mutate.status`.
- `Finding["status"]` is the union `"open" | "in-progress" | "snoozed" | "done" | "dropped"`
  (from `finding.ts:23`). Use this indexed type so callers can't pass a bad status.
- The existing `import type { Finding } from "./finding.js";` (line 2) already covers the type
  reference — no new import needed.

**Imports this file uses (lines 1-6):** `FindingSchema` + `type Finding` from `./finding.js`,
`HUB_SCOPE` from `./finding-source.js`, `type FactStore`, `writeFact`, `type ReconcileAction`
from `../state/facts.js`.

**Imported by:** `src/hub/task-inbox.ts:4` (imports `writeFinding`),
`src/hub/finding-store.test.ts:4` (imports `writeFinding`, `readFindings`). Adding a new export
is additive — neither breaks.

**Test file:** `src/hub/finding-store.test.ts` — EXISTS (extend it; do not recreate).

---

### src/hub/finding-store.test.ts (modify — ADD transition + history tests)

Existing file (63 lines) already has the `:memory:` template and a `SAMPLE_FINDING` literal you
can reuse to seed a task. Append new `describe("transitionFinding", ...)` blocks. See §6 for the
exact sc-2-2 history-read recipe.

---

### src/cli/commands/task.ts (modify — ADD list/start/done/drop)

Current file = `add` only (122 lines). You MIRROR the existing structure. Three reusable pieces
already exist at top: `resolveRoot()` (26-29), `resolveDefaultNamespace()` (38-47), and the
`runTaskAdd` DI-core + handler-boundary pattern. ADD:
1. DI cores: `runTaskList(store, opts)` and `runTaskTransition(store, id, newStatus, now)`.
2. Inside `registerTaskCommand` (after the `task add` block, before the closing `}` at line 121):
   the `list`, `start <id>`, `done <id>`, `drop <id>` subcommand registrations.

**The `runTaskAdd` DI-core pattern to MIRROR (lines 58-83):**
```ts
export async function runTaskAdd(
  store: FactStore, text: string, opts: { domain?: string }, now: string,
): Promise<void> {
  const title = text.trim();
  if (title.length === 0) {
    process.stderr.write(chalk.red("task add: text must not be empty\n"));
    process.exitCode = 1;
    return;
  }
  try {
    const finding = await captureTask(store, title, { domain: opts.domain, now });
    process.stdout.write(chalk.green(`Captured task ${chalk.bold(finding.id)}\n`));
    // ...
  } catch (err) {
    process.stderr.write(chalk.red(`Failed to add task: ${err instanceof Error ? err.message : String(err)}\n`));
    process.exitCode = 1;
  }
}
```

**The `task add` handler-boundary pattern to MIRROR (lines 93-120):**
```ts
taskCmd
  .command("add <text>")
  .description("...")
  .option("--domain <domain>", "...")
  .action(async (text: string, opts: { domain?: string }) => {
    const projectRoot = await resolveRoot();
    try {
      const ns = await resolveDefaultNamespace(projectRoot);
      await ensureFactsDir(projectRoot, ns);
      const now = new Date().toISOString();          // ← clock ONLY at boundary
      const store = new FactStore(factsDbPath(projectRoot, ns));
      try {
        await runTaskAdd(store, text, opts, now);
      } finally {
        store.close();                                // ← try/finally close
      }
    } catch (err) {
      process.stderr.write(chalk.red(`task add failed: ${err instanceof Error ? err.message : String(err)}\n`));
      process.exitCode = 1;
    }
  });
```

**Suggested new DI cores (add near `runTaskAdd`):**
```ts
import { transitionFinding, readFindings } from "../../hub/task-inbox.js"; // see PITFALLS re: path
import type { Finding } from "../../hub/finding.js";

const ACTIVE_STATUSES: ReadonlyArray<Finding["status"]> = ["open", "in-progress"];

/** DI core for `task list`. Read-only; no `now` needed. Never throws. */
export function runTaskList(store: FactStore, opts: { all?: boolean; status?: string }): void {
  try {
    let findings = readFindings(store);
    if (opts.status) {
      findings = findings.filter((f) => f.status === opts.status);
    } else if (!opts.all) {
      findings = findings.filter((f) => ACTIVE_STATUSES.includes(f.status));
    }
    if (findings.length === 0) {
      process.stdout.write(chalk.gray("No tasks found.\n"));
      return;
    }
    // table — mirror facts.ts:179-192 (header + dashes + padded rows)
    process.stdout.write(chalk.bold(`${"ID".padEnd(18)} ${"STATUS".padEnd(12)} ${"DOMAIN".padEnd(12)} TITLE\n`));
    process.stdout.write(`${"-".repeat(80)}\n`);
    for (const f of findings) {
      const title = f.title.length > 36 ? `${f.title.slice(0, 33)}...` : f.title;
      process.stdout.write(`${f.id.padEnd(18)} ${f.status.padEnd(12)} ${f.domain.padEnd(12)} ${title}\n`);
    }
  } catch (err) {
    process.stderr.write(chalk.red(`Failed to list tasks: ${err instanceof Error ? err.message : String(err)}\n`));
    process.exitCode = 1;
  }
}

/** DI core for start/done/drop. Missing id → chalk.yellow + exitCode=1 + return. Never throws. */
export async function runTaskTransition(
  store: FactStore, id: string, newStatus: Finding["status"], now: string,
): Promise<void> {
  try {
    const updated = await transitionFinding(store, id, newStatus, { now });
    if (updated === null) {
      process.stderr.write(chalk.yellow(`task: no task found with id ${id}\n`));
      process.exitCode = 1;
      return;
    }
    process.stdout.write(chalk.green(`Task ${chalk.bold(id)} → ${chalk.bold(newStatus)}\n`));
  } catch (err) {
    process.stderr.write(chalk.red(`Failed to update task: ${err instanceof Error ? err.message : String(err)}\n`));
    process.exitCode = 1;
  }
}
```

**Suggested subcommand registrations (inside `registerTaskCommand`):**
```ts
taskCmd
  .command("list")
  .description("List tasks (open + in-progress by default)")
  .option("--all", "Show tasks in every status, including done/dropped")
  .option("--status <status>", "Show only tasks with this status")
  .action(async (opts: { all?: boolean; status?: string }) => {
    const projectRoot = await resolveRoot();
    try {
      const ns = await resolveDefaultNamespace(projectRoot);
      await ensureFactsDir(projectRoot, ns);
      const store = new FactStore(factsDbPath(projectRoot, ns));
      try { runTaskList(store, opts); } finally { store.close(); }
    } catch (err) {
      process.stderr.write(chalk.red(`task list failed: ${err instanceof Error ? err.message : String(err)}\n`));
      process.exitCode = 1;
    }
  });

// start/done/drop share one shape — repeat the block with the status literal swapped:
for (const [name, status, desc] of [
  ["start", "in-progress", "Mark a task in-progress"],
  ["done",  "done",        "Mark a task done"],
  ["drop",  "dropped",     "Abandon a task (supersede to dropped — never deleted)"],
] as const) {
  taskCmd
    .command(`${name} <id>`)
    .description(desc)
    .action(async (id: string) => {
      const projectRoot = await resolveRoot();
      try {
        const ns = await resolveDefaultNamespace(projectRoot);
        await ensureFactsDir(projectRoot, ns);
        const now = new Date().toISOString();
        const store = new FactStore(factsDbPath(projectRoot, ns));
        try { await runTaskTransition(store, id, status, now); } finally { store.close(); }
      } catch (err) {
        process.stderr.write(chalk.red(`task ${name} failed: ${err instanceof Error ? err.message : String(err)}\n`));
        process.exitCode = 1;
      }
    });
}
```
(A literal-array loop avoids three near-identical copies; a flat copy-paste of three blocks is
equally acceptable if you prefer.)

**Imported by:** `src/cli/index.ts` calls `registerTaskCommand(program)` next to
`registerFactsCommand`. Adding subcommands inside the existing function needs NO index.ts change.

**Test file:** `src/cli/commands/task.test.ts` — EXISTS (extend it).

---

### src/cli/commands/task.test.ts (modify — ADD list/transition tests)

77-line file with the canonical `:memory:` + `process.exitCode` template (see §6).

---

## 2. Patterns to Follow

### Pattern: reconcile UPDATE = supersede(old) + insert(new) (THE history mechanism)
**Source:** `src/orchestrator/memory/reconcile.ts`, lines 56-78
```ts
const exactMatches = store.getActiveFacts(incoming.scope, incoming.subject, incoming.predicate);
if (exactMatches.length > 0) {
  const same = exactMatches.find((r) => r.value === incoming.value);
  if (same !== undefined) return "noop";                 // ← IDENTICAL value = NO history!
  for (const old of exactMatches) {
    store.supersedeFact(old.id, now, incoming.tValid);    // ← old row kept, t_invalidated set
  }
  store.insertFact(incoming);                             // ← new active row
  return "update";
}
```
**Rule:** A transition creates history ONLY when the new value differs from the active one. A
`done → done` (or any no-op) transition returns `"noop"` and writes NO historical row. For
sc-2-2 (open → done) the value differs, so UPDATE fires — good. Never call `invalidateFact`
alone or `DELETE` to "remove" a task; that would lose the active row entirely.

### Pattern: supersedeFact sets BOTH temporal closure fields
**Source:** `src/state/facts.ts`, lines 295-304
```ts
supersedeFact(id: string, tInvalidated: string, tInvalid: string): boolean {
  const info = this.db.prepare(
    `UPDATE semantic_facts SET t_invalidated = ?, t_invalid = ?
     WHERE id = ? AND t_invalidated IS NULL`,
  ).run(tInvalidated, tInvalid, id);
  return info.changes > 0;
}
```
**Rule:** After a transition, the OLD row has `t_invalidated` non-null (record-time = `now`) and
`t_invalid` non-null (world-time = incoming `tValid` = `now`). The sc-2-2 test asserts
`oldRow.tInvalidated !== null`.

### Pattern: deterministic fact id (lets you re-derive a historical row's id)
**Source:** `src/state/facts.ts`, lines 58-69
```ts
export function factId(scope, subject, predicate, value, tCreated): string {
  return createHash("sha256")
    .update(`${scope}|${subject}|${predicate}|${value}|${tCreated}`)
    .digest("hex").slice(0, 16);
}
```
**Rule:** Because the id is a pure function of `(scope, subject, predicate, value, tCreated)`,
the test can recompute the OLD (open) row's id from the object `captureTask` returned and read it
back with `store.getFact(oldId)`. This is the only way to read a superseded row out of a
`:memory:` store (no enumerate-all-rows API exists).

### Pattern: CLI list table rendering
**Source:** `src/cli/commands/facts.ts`, lines 179-192
```ts
process.stdout.write(chalk.bold(`${"ID".padEnd(18)} ${"SUBJECT".padEnd(20)} ${"PREDICATE".padEnd(22)} VALUE\n`));
process.stdout.write(`${"-".repeat(90)}\n`);
for (const r of records) {
  const valueSnippet = r.value.length > 30 ? `${r.value.slice(0, 27)}...` : r.value;
  process.stdout.write(`${r.id.padEnd(18)} ${r.subject.padEnd(20)} ${r.predicate.padEnd(22)} ${valueSnippet}\n`);
}
```
**Rule:** Header via `chalk.bold` + `padEnd` columns, a dashed separator, then one padded line
per row with the long field truncated. Empty result prints `chalk.gray("...\n")` and returns
(facts.ts:172-177). Mirror this for `task list`.

### Pattern: CLI handler never throws — exitCode=1 + return
**Source:** `src/cli/commands/task.ts:64-82`, `src/cli/commands/facts.ts:221-225`
```ts
if (rec === null) {
  process.stderr.write(chalk.yellow(`Fact not found: ${id}\n`));
  process.exitCode = 1;
  return;
}
```
**Rule:** Bad input / not-found → write a `chalk.yellow`/`chalk.red` message to stderr, set
`process.exitCode = 1`, `return`. Never `throw`, never `process.exit()`.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `writeFinding` | `src/hub/finding-store.ts:16` | `(store, Finding, {now}) => Promise<ReconcileAction>` | Persist a Finding via reconcile (dedup/supersede). The write path your transition reuses. |
| `readFindings` | `src/hub/finding-store.ts:44` | `(store) => Finding[]` | Read ACTIVE hub findings. Your list + transition both build on it. |
| `captureTask` | `src/hub/task-inbox.ts:22` | `(store, text, {domain?, now}) => Promise<Finding>` | Seed an open task. Reuse it in tests; DO NOT modify (non-goal). |
| `writeFact` | `src/orchestrator/memory/reconcile.ts:148` (re-exported `src/state/facts.ts:13`) | `(store, FactInput, {judge?, now}) => Promise<ReconcileAction>` | Reconcile-then-write. UPDATE/NOOP/ADD decision lives here. |
| `reconcileFact` | `src/orchestrator/memory/reconcile.ts:51` | `(store, FactInput, {judge?, now}) => Promise<ReconcileAction>` | The supersede+insert UPDATE engine (lines 70-78). |
| `FactStore.getActiveFacts` | `src/state/facts.ts:226` | `(scope, subject?, predicate?) => FactRecord[]` | Active rows only (t_invalidated IS NULL). |
| `FactStore.getFact` | `src/state/facts.ts:267` | `(id) => FactRecord \| null` | Fetch ONE row by fact-id **regardless of invalidation** — the only way to read a superseded row. |
| `FactStore.supersedeFact` | `src/state/facts.ts:295` | `(id, tInvalidated, tInvalid) => boolean` | Soft-close a row. Called by reconcile; do NOT call directly from the transition. |
| `factId` | `src/state/facts.ts:58` | `(scope, subject, predicate, value, tCreated) => string` | Re-derive a row id deterministically (test-side, for sc-2-2). |
| `factsDbPath` | `src/state/facts.ts:77` | `(projectRoot, namespace?) => string` | DB path for the handler boundary. |
| `ensureFactsDir` | `src/state/facts.ts:86` | `(projectRoot, namespace?) => Promise<void>` | mkdir before opening a file-backed store. |
| `HUB_SCOPE` | `src/hub/finding-source.ts:8` | `const = "hub"` | Scope all hub findings live under. |
| `findProjectRoot` | `src/utils/fs.js` (via `resolveRoot` task.ts:26) | `() => Promise<string \| null>` | Already wrapped by `resolveRoot()`; reuse that. |

**Utilities reviewed:** `src/utils/`, `src/state/`, `src/hub/`, `src/orchestrator/memory/` — the
above is the applicable set. There is **NO** "list all rows including invalidated" / "get history
by subject" method on FactStore — confirmed by reading `facts.ts:136-310`. Use the `factId` +
`getFact` recipe (§6) instead; do not invent a new store method.

---

## 4. Prior Sprint Output (Sprint 1 — commit 0e39c15)

### `src/hub/finding-store.ts` — exports `writeFinding`, `readFindings`
**Connection:** ADD `transitionFinding` here; it composes `readFindings` (find by id) + `writeFinding` (write back) → reconcile UPDATE.

### `src/hub/task-inbox.ts` — exports `captureTask`
**Connection:** Reuse in tests to seed an open task. The returned object is the exact thing that
was JSON-serialized into the store (no mutation), so `JSON.stringify(captured)` reproduces the
stored value byte-for-byte — critical for the sc-2-2 id reconstruction.

### `src/cli/commands/task.ts` — exports `runTaskAdd` + `registerTaskCommand`; wired in `src/cli/index.ts`
**Connection:** Add `runTaskList` / `runTaskTransition` cores + the four subcommands inside the
existing `registerTaskCommand`. No `index.ts` change (registration already wired).

### `src/hub/finding.ts` — `FindingSchema` (runtime) + `type Finding`
**Connection:** `Finding["status"]` union (`"open"|"in-progress"|"snoozed"|"done"|"dropped"`,
line 23) types `newStatus`. Import the type with `import type` (`consistent-type-imports`).

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM `.js` extensions on every relative import** (line 27) — `./finding.js`, `../state/facts.js`, etc.
- **`import type { ... }` for type-only imports** (line 35) — ESLint `consistent-type-imports` is a hard gate. `Finding` is type-only; `FindingSchema`, `writeFinding`, `factId` are value imports.
- **Collocated tests** (line 20) — `*.test.ts` next to source; Vitest.
- **Strict TS** (line 18) — `noUnusedLocals`/`noUnusedParameters` (prefix intentionally-unused with `_`), `noImplicitReturns`, `noFallthroughCasesInSwitch`. Zero type + zero lint errors are hard gates.
- **Section comments** (line 32) — `// ── Section ──────────` box headers (the files already use them).
- **No new dependencies** (contract non-goal) — chalk/commander/zod/better-sqlite3 only.
- **Clock only at the CLI boundary** — `now = new Date().toISOString()` lives in the `.action()` handler; helpers/stores take `now` as a parameter and NEVER read the clock (contract non-goal + the PURE docblocks on `writeFinding`, `captureTask`, `reconcileFact`, `FactStore`).

### Architecture Decisions
No `.bober/architecture/` doc is specific to this sprint. The governing convention is the
bitemporal supersede model in `reconcile.ts` + `facts.ts` (cited above). MEMORY note: meds/tasks
ride on `FactStore` rather than a bespoke table (ADR-7 pattern) — this sprint follows it.

### Other Docs
`package.json` scripts: build `tsc`, test `vitest`, typecheck `tsc --noEmit`, lint `eslint src/`.

---

## 6. Testing Patterns

### Unit Test Pattern (FactStore in-memory)
**Source:** `src/hub/finding-store.test.ts:22-45` and `src/cli/commands/task.test.ts:18-43`
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FactStore } from "../../state/facts.js";
import { runTaskAdd } from "./task.js";

const T = "2026-06-28T00:00:00.000Z";
const originalExitCode = process.exitCode;
beforeEach(() => { process.exitCode = 0; });
afterEach(() => { vi.restoreAllMocks(); process.exitCode = originalExitCode as number | undefined; });

it("valid input → exitCode stays 0", async () => {
  const store = new FactStore(":memory:");
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  await runTaskAdd(store, "renew passport", {}, T);
  expect(process.exitCode).toBe(0);
  store.close();
});
```
**Runner:** vitest. **Assertion:** `expect`. **Mock:** `vi.spyOn(process.stdout/stderr, "write").mockImplementation(() => true)` to silence/capture output. **DB:** `new FactStore(":memory:")` then `store.close()`. **File naming:** `*.test.ts` collocated.

### THE sc-2-2 history-read recipe (load-bearing — copy this shape)
There is no "read invalidated rows" API. Reconstruct the OLD row's deterministic id and fetch it
with `getFact`. The store keeps it (proof of the pattern: `facts.test.ts:36-53` shows
`getActiveFacts → 0` while `getFact(id).tInvalidated` is set after a soft-close).
```ts
import { describe, it, expect } from "vitest";
import { FactStore, factId } from "../state/facts.js";
import { HUB_SCOPE } from "./finding-source.js";
import { readFindings, transitionFinding } from "./finding-store.js";
import { captureTask } from "./task-inbox.js";

const T0 = "2026-06-28T00:00:00.000Z";   // capture time
const T1 = "2026-06-29T00:00:00.000Z";   // transition time

it("sc-2-2: done supersedes the open row but keeps it as history", async () => {
  const store = new FactStore(":memory:");

  // 1. seed an open task; `captured` IS the object that was JSON.stringify'd into the store
  const captured = await captureTask(store, "renew passport", { now: T0 });

  // 2. re-derive the OPEN row's deterministic id (scope|subject|predicate|value|tCreated)
  const openRowId = factId(HUB_SCOPE, captured.id, "finding", JSON.stringify(captured), T0);

  // 3. transition open -> done (different value => reconcile UPDATE branch)
  await transitionFinding(store, captured.id, "done", { now: T1 });

  // 4a. ACTIVE row is now status=done
  const active = readFindings(store).find((f) => f.id === captured.id);
  expect(active?.status).toBe("done");

  // 4b. the historical OPEN row still exists, superseded (t_invalidated set)
  const oldRow = store.getFact(openRowId);
  expect(oldRow).not.toBeNull();
  expect(oldRow!.tInvalidated).not.toBeNull();                       // <- proves it is history
  expect((JSON.parse(oldRow!.value) as { status: string }).status).toBe("open");

  store.close();
});
```
**Why it works:** `captureTask` (task-inbox.ts:22-50) builds `finding`, returns it unchanged, and
`writeFinding` stores `value = JSON.stringify(finding)`, `tCreated = now = T0`,
`subject = finding.id`, `predicate = "finding"`, `scope = HUB_SCOPE`. So `factId(...)` recomputes
the exact id. After the transition, reconcile superseded that row (UPDATE branch) — it is gone
from `getActiveFacts`/`readFindings` but `getFact(openRowId)` still returns it with `tInvalidated`
set. CAUTION: compute `openRowId` from the object `captureTask` RETURNED, not from a re-read via
`readFindings` (zod `.parse` reorders keys → different JSON string → different id).

### Tests to add (map to success criteria)
- **sc-2-2** — the recipe above (one active done + one superseded open for the same id).
- **sc-2-3** — capture two tasks; `runTaskList(store, {})` (or `transitionFinding`+`readFindings`)
  shows both while open; after `transitionFinding(store, id, "done", {now:T1})` the default filter
  (`status ∈ {open,in-progress}`) excludes it, but `--status done` / `--all` include it. Assert by
  filtering `readFindings` the same way the core does, or by capturing `process.stdout` writes.
- **sc-2-4** — `transitionFinding(store, id, "in-progress", {now})` → active row status `in-progress`.
- **sc-2-5** (optional) — `runTaskTransition(store, "unknown-id", "done", T1)`: `expect(process.exitCode).toBe(1)` and it resolves (no throw); spy stderr.

### E2E Test Pattern
Not applicable — this is a CLI/library sprint with no Playwright surface.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/hub/task-inbox.ts` | `finding-store.ts` (imports `writeFinding`) | low | Adding `transitionFinding` is additive; `writeFinding`/`readFindings` unchanged. |
| `src/hub/finding-store.test.ts` | `finding-store.ts` | low | Existing assertions on `writeFinding`/`readFindings` keep passing. |
| `src/cli/index.ts` | `task.ts` (`registerTaskCommand`) | low | New subcommands live inside the existing function; signature unchanged. |
| `src/cli/commands/task.test.ts` | `task.ts` (`runTaskAdd`) | low | `runTaskAdd` untouched; only new exports added. |
| Hub consumers of findings (`collector.ts`, `judge.ts`, `priority-md.ts`, `lenses.ts`) | the hub `finding` predicate rows | low–med | They read ACTIVE findings via `getActiveFacts`/`FactStoreFindingSource`. Done/dropped tasks remain ACTIVE rows (status field, not invalidation), so they will now appear in those consumers with status done/dropped — expected per contract assumption #2. Verify nothing assumes every hub finding is `open`. |

### Existing Tests That Must Still Pass
- `src/hub/finding-store.test.ts` — covers `writeFinding`/`readFindings`; verify still green after adding `transitionFinding`.
- `src/hub/task-inbox.test.ts` — covers `captureTask`; do not change capture behavior (non-goal).
- `src/cli/commands/task.test.ts` — covers `runTaskAdd` empty-input/exitCode; keep passing.
- `src/state/facts.test.ts` — covers `getActiveFacts`/`invalidateFact`/`getFact`/readonly/journal mode; you only READ these APIs, so they must stay green.
- `src/hub/finding-source.test.ts`, `collector.test.ts`, `scope.test.ts`, `judge.test.ts`, `priority-md.test.ts` — share the hub `finding` rows; run them to confirm no regression from terminal-status findings now existing.

### Features That Could Be Affected
- **Priority hub (`bober hub priority`/`list`)** — shares the hub `finding` predicate/scope. Verify a `done`/`dropped` task does not corrupt ranking/rendering (it stays an ACTIVE row carrying its terminal status; consumers that only want open work should filter by status, same as `task list`).
- **Sprint 3 (snooze)** — will add another status transition; keep `transitionFinding` generic (status + optional `mutate`) so snooze can reuse it. Do NOT implement snooze now (non-goal).

### Recommended Regression Checks (run after implementation)
1. `npm run build` (= `tsc`) exits 0 — sc-2-1.
2. `npx vitest run src/hub/finding-store.test.ts src/cli/commands/task.test.ts` — new tests pass.
3. `npx vitest run src/hub src/state src/cli/commands` — no regressions in the touched areas.
4. `npm run lint` (= `eslint src/`) — zero errors (watch `consistent-type-imports`, unused vars).
5. `npx vitest run` — full suite green.
6. Manual stop-condition: `bober task add "x"` → `bober task done <id>` removes it from `bober task list`, while `bober task list --all` still shows it with `status=done`.

---

## 8. Implementation Sequence (dependency-ordered)

1. **`src/hub/finding-store.ts`** — add `transitionFinding` (composes `readFindings` + `writeFinding`; returns `Finding | null`; `now` injected; no clock read).
   - Verify: `npm run build` and `npx vitest run src/hub/finding-store.test.ts` pass (existing tests still green).
2. **`src/hub/finding-store.test.ts`** — add the sc-2-2 history test (recipe §6) + sc-2-4 in-progress test.
   - Verify: both new tests pass; `oldRow.tInvalidated` is non-null and old status is `open`.
3. **`src/cli/commands/task.ts`** — add `runTaskList` + `runTaskTransition` DI cores, then the `list`/`start`/`done`/`drop` subcommands inside `registerTaskCommand`.
   - Verify: `npm run build` clean; `bober task list`/`start`/`done`/`drop` register (no commander error).
4. **`src/cli/commands/task.test.ts`** — add sc-2-3 (default filter excludes done; `--all`/`--status done` includes) + sc-2-5 (unknown id → exitCode=1, no throw), mirroring the `:memory:` + `process.exitCode` template.
   - Verify: new tests pass; `process.exitCode` asserted as the existing tests do.
5. **Run full verification** — `npm run build`, `npx vitest run`, `npm run lint`.

---

## 9. Pitfalls & Warnings

- **NOOP = no history.** Transitioning to the SAME status (or any write whose serialized value
  equals the active value) returns `"noop"` (`reconcile.ts:64-68`) and writes NO historical row.
  sc-2-2 (open→done) is a real change, so it's fine — but don't write a test that transitions to
  the current status and expects a superseded row.
- **Compute the old id from `captured`, not from a re-read.** zod `FindingSchema.parse`
  (`readFindings`) rebuilds the object in SCHEMA key order, so `JSON.stringify` of a re-read
  finding differs from the stored bytes → wrong `factId`. Use the object `captureTask` returned.
- **Never DELETE / never `invalidateFact`-only for `drop`.** `drop` is `status: "dropped"` via the
  SAME UPDATE path (supersede old + insert new active row). The contract/evaluator explicitly
  reject delete-or-invalidate-only (non-goal + evaluatorNotes).
- **Clock only at the `.action()` boundary.** `transitionFinding`, `runTaskTransition` core, and
  the store take `now` as a parameter. Do not call `new Date()`/`Date.now()` inside helpers
  (PURE contract; evaluatorNotes verify this).
- **`import type` for `Finding`.** `Finding` is type-only (`consistent-type-imports` hard gate).
  `FindingSchema`, `writeFinding`, `readFindings`, `transitionFinding`, `factId`, `FactStore`,
  `captureTask` are value imports. All relative imports need `.js`.
- **Import-path choice for the CLI core.** `transitionFinding`/`readFindings` are exported from
  `src/hub/finding-store.ts`. `task.ts` currently imports `captureTask` from
  `../../hub/task-inbox.js`. Import `transitionFinding`/`readFindings` from
  `../../hub/finding-store.js` (NOT task-inbox.js — task-inbox only re-uses, it does not re-export
  them). Confirmed: `task-inbox.ts` imports `writeFinding` but does not re-export it.
- **`:memory:` stores can't be opened twice.** Unlike `facts.test.ts:188` (file-backed, raw second
  `Database` connection), a `:memory:` DB is connection-private. For sc-2-2 use the `factId` +
  `getFact` recipe, not a second connection.
- **Default list status set.** Default = `status ∈ {open, in-progress}`. `snoozed` is NOT in the
  default set (it's a sprint-3 status but already in the schema enum) — `--all`/`--status` reveal
  everything; `done`/`dropped` are hidden by default.
- **No `process.exit()`, no `throw` from handlers.** Set `process.exitCode = 1` and `return`
  (matches `runTaskAdd` and `facts.ts`). Tests assert `process.exitCode`, not a thrown error.
