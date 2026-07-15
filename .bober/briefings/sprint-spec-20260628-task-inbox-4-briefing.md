# Sprint Briefing: Domain finding intake (pool ingest + dedup)

**Contract:** sprint-spec-20260628-task-inbox-4
**Generated:** 2026-06-29T00:00:00.000Z

> Goal: export `ingestFinding(store, finding, { now })` from `src/hub/finding-store.ts`
> and add a `bober task ingest [file]` CLI that reads a Finding JSON from a file or
> stdin. Ingest derives a content-stable id (hash of `domain|title|kind`), validates
> against `FindingSchema`, and routes through the existing `writeFinding` so reconcile
> dedups a re-surfaced finding to a single active row.

---

## 1. Target Files

### `src/hub/finding-store.ts` (modify) — add `ingestFinding` + id derivation

**Current imports (lines 1-6) — `createHash` is NOT yet imported here, you must add it:**
```ts
import { FindingSchema } from "./finding.js";
import type { Finding } from "./finding.js";
import { HUB_SCOPE } from "./finding-source.js";
import type { FactStore } from "../state/facts.js";
import { writeFact } from "../state/facts.js";
import type { ReconcileAction } from "../state/facts.js";
```
ADD: `import { createHash } from "node:crypto";` (mirror task-inbox.ts:1).

**`writeFinding` you will reuse (lines 16-35) — note `subject: finding.id`:**
```ts
export async function writeFinding(
  store: FactStore,
  finding: Finding,
  { now }: { now: string },
): Promise<ReconcileAction> {
  return writeFact(
    store,
    { scope: HUB_SCOPE, subject: finding.id, predicate: "finding",
      value: JSON.stringify(finding), confidence: 1, sourceRunId: null,
      tValid: now, tCreated: now },
    { now },
  );
}
```
**Why dedup is free:** `subject: finding.id`. Two ingests of the same `domain|title|kind`
with no id → SAME derived id → SAME subject → `writeFact`→`reconcileFact` takes NOOP
(identical value) or UPDATE (different `surfacedAt`), never a second ADD. Either way
`getActiveFacts(...)` returns exactly one active row (sc-4-3).

**Imports this file uses:** `FindingSchema`, `Finding`, `HUB_SCOPE`, `FactStore`, `writeFact`, `ReconcileAction`.
**Imported by:** `src/cli/commands/task.ts`, `src/hub/task-inbox.ts`, `src/cli/commands/task.test.ts`, `src/hub/finding-store.test.ts`.
**Test file:** `src/hub/finding-store.test.ts` (exists — extend it).

---

### `src/cli/commands/task.ts` (modify) — add `runTaskIngest` DI core + `ingest [file]` subcommand

The file already has DI cores (`runTaskAdd`, `runTaskList`, `runTaskTransition`,
`runTaskSnooze`) + a `registerTaskCommand` that wires each as a commander subcommand.
Add a new exported `runTaskIngest(store, raw, now)` core (so tests drive a string
without touching stdin) and register `ingest [file]` whose handler does the file/stdin
read then calls the core. The handler stamps `now = new Date().toISOString()` at the
boundary exactly like the other subcommands (task.ts:257, 287, 315, 347).

**Test file:** `src/cli/commands/task.test.ts` (exists — extend it).

---

### `src/hub/finding-store.test.ts` & `src/cli/commands/task.test.ts` (modify) — add tests

See §6 for the exact templates (sc-4-2 / sc-4-3 in finding-store.test.ts; sc-4-4 + a valid-ingest case in task.test.ts).

---

## 2. Patterns to Follow

### Pattern A — The hash idiom to reuse for the derived id
**Source:** `src/state/facts.ts`, lines 58-69 (`factId`)
```ts
export function factId(scope, subject, predicate, value, tCreated): string {
  return createHash("sha256")
    .update(`${scope}|${subject}|${predicate}|${value}|${tCreated}`)
    .digest("hex")
    .slice(0, 16);
}
```
**Also see** `src/hub/task-inbox.ts:29-32` (captureTask) which uses the SAME idiom:
```ts
const id = createHash("sha256").update(`${title}|${now}`).digest("hex").slice(0, 16);
```
**Rule:** Derive the ingest id with `createHash("sha256").update(\`${domain}|${title}|${kind}\`).digest("hex").slice(0, 16)` — a private helper `deriveFindingId(domain, title, kind)` in finding-store.ts. NO `now` in the hash input (it must be content-stable so re-surfacing collides).

### Pattern B — `.parse` throws (validate-at-boundary) vs `.safeParse` skips
**Source:** `src/hub/finding-store.ts:44-48` (readFindings uses `.parse` — throws) vs `src/hub/finding-source.ts:43-47` (FactStoreFindingSource uses `.safeParse` — skips).
```ts
// finding-store.ts readFindings — PARSE, throws on malformed:
.map((r) => FindingSchema.parse(JSON.parse(r.value) as unknown));
```
**Rule:** `ingestFinding` must VALIDATE BEFORE any write. Use `.parse` so a missing required
field THROWS; the CLI core catches it, prints chalk.red, sets exitCode=1, writes nothing (sc-4-4).

### Pattern C — `ReconcileAction` is the return type
**Source:** `src/orchestrator/memory/reconcile.ts:16` (re-exported from `src/state/facts.ts:14`)
```ts
export type ReconcileAction = "add" | "update" | "delete" | "noop";
```
**Rule:** `ingestFinding` returns `Promise<ReconcileAction>` (just return `writeFinding(...)`'s result — it is already typed). Import the type from `../state/facts.js` (already imported in finding-store.ts:6). The CLI prints the value, e.g. `Ingested finding (${action})`. This satisfies sc-4-5 (typed reconcile action).

### Pattern D — `FindingSchema` required vs optional fields
**Source:** `src/hub/finding.ts:10-25`
```ts
export const FindingSchema = z.object({
  id: z.string().min(1),                                   // REQUIRED — but ingest DERIVES when absent
  domain: z.string().min(1),                               // REQUIRED
  title: z.string().min(1),                                // REQUIRED
  kind: z.enum(["action", "watch", "risk", "question"]),   // REQUIRED  (sc-4-2 uses "watch")
  urgency: z.number().int().min(1).max(5),                 // REQUIRED
  severity: z.number().int().min(1).max(5),                // REQUIRED
  evidence: z.array(z.string()),                           // REQUIRED
  surfacedAt: z.string().datetime(),                       // REQUIRED — but ingest sets = now when absent
  dueBy: z.string().datetime().optional(),                 // optional
  tags: z.array(z.string()),                               // REQUIRED
  estDurationMin: z.number().int().optional(),             // optional
  calendarSafeTitle: z.string().optional(),                // optional
  status: z.enum(["open","in-progress","snoozed","done","dropped"]), // REQUIRED
  promotesTo: z.string().optional(),                       // optional
});
```
**Rule for sc-4-4 (rejection test):** omit a TRULY required field that ingest does NOT auto-fill —
e.g. omit `title` (or `kind`, `urgency`, `status`, `tags`, `evidence`). Do NOT omit `id` or
`surfacedAt` to test rejection — those are auto-derived/defaulted by ingest and would NOT cause a reject.

### Pattern E — id-optional input via a derived input schema (zod ^3.24.2)
Because the input may arrive WITHOUT `id`/`surfacedAt` (contract assumption §3c) but
`FindingSchema` requires both, parse the raw input with a relaxed schema, fill the two
fields, then hand a fully-valid `Finding` to `writeFinding`. Two equivalent ways:
```ts
// preferred — reuses every other constraint, only loosens id + surfacedAt
const IngestInputSchema = FindingSchema.partial({ id: true, surfacedAt: true });
// or, equally valid:
// const IngestInputSchema = FindingSchema.extend({
//   id: z.string().min(1).optional(),
//   surfacedAt: z.string().datetime().optional(),
// });
```
**Rule:** `IngestInputSchema.parse(input)` still THROWS when `domain`/`title`/`kind`/`urgency`/
`severity`/`status`/`tags`/`evidence` are missing or wrong-typed — so sc-4-4 still rejects. The
input parameter type should be `unknown` (the CLI hands it `JSON.parse(raw)` which is `unknown`;
`unknown` also "accepts the imported Finding type" since `Finding` is assignable to `unknown`).

### Pattern F — never-throw CLI DI core (exit-code, not throw)
**Source:** `src/cli/commands/task.ts:65-90` (runTaskAdd) and `:101-135` (runTaskList)
```ts
export async function runTaskAdd(store, text, opts, now): Promise<void> {
  const title = text.trim();
  if (title.length === 0) {
    process.stderr.write(chalk.red("task add: text must not be empty\n"));
    process.exitCode = 1;
    return;                                  // <-- return, never throw
  }
  try { /* ... */ } catch (err) {
    process.stderr.write(chalk.red(`Failed to add task: ${err instanceof Error ? err.message : String(err)}\n`));
    process.exitCode = 1;
  }
}
```
**Rule:** `runTaskIngest` mirrors this: parse failure / schema failure → `chalk.red` + `process.exitCode = 1` + `return`, never throw. Inject `now` as a parameter — no clock read inside.

### Pattern G — subcommand registration with an OPTIONAL positional arg
**Source:** `src/cli/commands/chat.ts:25-27` (optional `[team]`) + `src/cli/commands/task.ts:240-273` (registration + boundary `now` + open/close store).
```ts
program.command("chat [team]").action(async (team?: string) => { /* ... */ });
```
And the task-command boundary shape to copy (task.ts:246-273):
```ts
taskCmd
  .command("ingest [file]")
  .description("Ingest a Finding JSON (file path, or stdin when omitted) into the hub pool")
  .action(async (file?: string) => {
    const projectRoot = await resolveRoot();
    try {
      const ns = await resolveDefaultNamespace(projectRoot);
      await ensureFactsDir(projectRoot, ns);
      const now = new Date().toISOString();          // stamp at boundary ONLY
      const raw = await readIngestInput(file);        // file or stdin — see §3 helper
      const store = new FactStore(factsDbPath(projectRoot, ns));
      try { await runTaskIngest(store, raw, now); } finally { store.close(); }
    } catch (err) {
      process.stderr.write(chalk.red(`task ingest failed: ${err instanceof Error ? err.message : String(err)}\n`));
      process.exitCode = 1;
    }
  });
```
**Rule:** Register `ingest [file]` INSIDE `registerTaskCommand` (task.ts:240-364), next to `add`/`list`/`snooze`. Optional arg → action receives `file?: string`.

---

## 3. The load-bearing code (paste-ready)

### `ingestFinding` (add to `src/hub/finding-store.ts`)
```ts
// ── ingestFinding ─────────────────────────────────────────────────────

/** Content-stable id: hash of domain|title|kind (no clock — mirrors factId). */
function deriveFindingId(domain: string, title: string, kind: string): string {
  return createHash("sha256")
    .update(`${domain}|${title}|${kind}`)
    .digest("hex")
    .slice(0, 16);
}

/** Input shape: id + surfacedAt are optional (ingest fills them); everything else required. */
const IngestInputSchema = FindingSchema.partial({ id: true, surfacedAt: true });

/**
 * Validate + normalize a domain-supplied Finding payload, then persist it via
 * writeFinding so reconcile dedups a re-surfaced finding to a single active row.
 *
 * - Validates with .parse — THROWS on a missing required field (caught at the CLI boundary).
 * - Derives a content-stable id from domain|title|kind when absent (supplied id is kept).
 * - Sets surfacedAt = now when absent. PURE: never reads the clock; `now` is injected.
 * Returns the ReconcileAction (add | update | delete | noop).
 */
export async function ingestFinding(
  store: FactStore,
  input: unknown,
  { now }: { now: string },
): Promise<ReconcileAction> {
  const parsed = IngestInputSchema.parse(input);           // validate BEFORE any write
  const id = parsed.id ?? deriveFindingId(parsed.domain, parsed.title, parsed.kind);
  const finding: Finding = FindingSchema.parse({
    ...parsed,
    id,
    surfacedAt: parsed.surfacedAt ?? now,
  });
  return writeFinding(store, finding, { now });            // reuse — reconcile dedups
}
```

### `runTaskIngest` + read helper (add to `src/cli/commands/task.ts`)
```ts
import { readFile } from "node:fs/promises";               // ADD to imports (node:fs/promises — NOT sync fs)
import { ingestFinding } from "../../hub/finding-store.js"; // ADD ingestFinding to the existing finding-store import

// ── readIngestInput (file or stdin) ───────────────────────────────────
/** Read the raw JSON payload from a file path, or stdin (fd 0) when omitted.
 *  Uses node:fs/promises only — no sync fs, no manual stream wiring. */
async function readIngestInput(file?: string): Promise<string> {
  return file !== undefined
    ? await readFile(file, "utf-8")
    : await readFile(0, "utf-8");   // fd 0 = stdin (works for piped input)
}

// ── runTaskIngest (DI core) ───────────────────────────────────────────
/** Parse the raw JSON, ingest it, print the reconcile action. Never throws:
 *  bad JSON or schema-invalid payload → chalk.red + exitCode=1 + return, no write. */
export async function runTaskIngest(
  store: FactStore,
  raw: string,
  now: string,
): Promise<void> {
  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch {
    process.stderr.write(chalk.red("task ingest: input is not valid JSON\n"));
    process.exitCode = 1;
    return;
  }
  try {
    const action = await ingestFinding(store, payload, { now });
    process.stdout.write(chalk.green(`Ingested finding (${chalk.bold(action)})\n`));
  } catch (err) {
    process.stderr.write(
      chalk.red(`task ingest: invalid finding: ${err instanceof Error ? err.message : String(err)}\n`),
    );
    process.exitCode = 1;
  }
}
```
Validation happens in `ingestFinding` BEFORE `writeFinding`, so a rejected payload persists nothing (sc-4-4 "no row is written").

---

## 4. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `writeFinding` | `src/hub/finding-store.ts:16` | `(store, finding: Finding, {now}): Promise<ReconcileAction>` | Persist a Finding via reconcile (subject=finding.id) — REUSE for dedup |
| `readFindings` | `src/hub/finding-store.ts:44` | `(store): Finding[]` | Read active hub findings (`.parse`) — used by list query |
| `factId` | `src/state/facts.ts:58` | `(scope,subject,predicate,value,tCreated): string` | The sha256→hex→slice(0,16) idiom to MIRROR for the derived id |
| `createHash` | `node:crypto` (imported task-inbox.ts:1) | `(alg)` | sha256 hashing primitive — import into finding-store.ts |
| `FindingSchema` | `src/hub/finding.ts:10` | zod object | Canonical schema — validate every payload; do NOT redefine Finding |
| `HUB_SCOPE` | `src/hub/finding-source.ts:8` | `"hub"` | FactStore scope used by writeFinding/getActiveFacts (already imported) |
| `writeFact` | re-export `src/state/facts.ts:13` (impl reconcile.ts:148) | `(store, FactInput, {judge?,now}): Promise<ReconcileAction>` | Reconcile-on-write; called by writeFinding — do NOT call insertFact directly |
| `getActiveFacts` | `src/state/facts.ts:226` | `(scope, subject?, predicate?): FactRecord[]` | Active-row query — assert `length===1` in dedup test |
| `ReconcileAction` | `src/orchestrator/memory/reconcile.ts:16` (re-export facts.ts:14) | `"add"\|"update"\|"delete"\|"noop"` | Return type of ingestFinding |
| `FactStore` | `src/state/facts.ts:136` | class; `new FactStore(":memory:")` | In-memory store for tests; `.getActiveFacts`, `.close()` |
| `captureTask` | `src/hub/task-inbox.ts:22` | `(store, text, {domain?,now}): Promise<Finding>` | Existing capture path; mirrors the hash idiom — do NOT route ingest through it |
| `readFile` | `node:fs/promises` | `(path\|fd, enc): Promise<string>` | File AND stdin (fd 0) read — no sync fs |
| `resolveRoot` / `resolveDefaultNamespace` / `ensureFactsDir` / `factsDbPath` | task.ts:33 / :45 / facts.ts:86 / facts.ts:77 | — | Boundary helpers already used by every task subcommand — reuse verbatim |

Directories reviewed: `src/state/`, `src/hub/`, `src/orchestrator/memory/`, `src/cli/commands/`, `src/utils/` — all relevant utilities listed above.

---

## 5. Prior Sprint Output

### Sprint 1 (0e39c15)
**Created:** `src/hub/finding-store.ts` — exports `writeFinding`, `readFindings`; `src/hub/finding.ts` — `FindingSchema` + `Finding`; `src/hub/finding-source.ts` — `HUB_SCOPE`, `FactStoreFindingSource`; `src/hub/task-inbox.ts` — `captureTask`.
**Connection:** ingestFinding lives alongside writeFinding/readFindings, validates with the same `FindingSchema`, persists with the same `writeFinding`, mirrors captureTask's `createHash` id idiom (but hashes content, not `title|now`).

### Sprint 2 (5e2bc2f) / Sprint 3 (2b5c3c9)
**Created:** `transitionFinding` (finding-store.ts:62) + `isVisibleInDefaultList`/`snoozeUntil` (finding-store.ts:85,104); `runTaskList` (task.ts:101) backs `bober task list`.
**Connection:** an ingested finding (status `open` by payload) is visible via `readFindings`→`isVisibleInDefaultList`→`runTaskList` — that is exactly what sc-4-2 asserts.

---

## 6. Testing Patterns

### Unit Test Pattern — store-level (extend `src/hub/finding-store.test.ts`)
**Runner:** vitest · **Assertion:** `expect` · **Store:** real in-memory `new FactStore(":memory:")` (NO fs mocks per principles) · **File naming:** `*.test.ts` collocated.
**Source idiom:** `src/hub/finding-store.test.ts:23-46`
```ts
import { describe, it, expect } from "vitest";
import { FactStore } from "../state/facts.js";
import { HUB_SCOPE } from "./finding-source.js";
import { ingestFinding, readFindings } from "./finding-store.js";

const T = "2026-06-28T00:00:00.000Z";

// sc-4-2: a watch-kind finding (no id) appears in the active pool + list query
it("sc-4-2: ingests a watch finding and it appears in the pool", async () => {
  const store = new FactStore(":memory:");
  const payload = { domain: "medical", title: "ferritin trending down", kind: "watch",
    urgency: 3, severity: 2, evidence: [], tags: [], status: "open" }; // no id, no surfacedAt
  const action = await ingestFinding(store, payload, { now: T });
  expect(action).toBe("add");
  const findings = readFindings(store);
  expect(findings).toHaveLength(1);
  expect(findings[0]!.kind).toBe("watch");
  expect(findings[0]!.id).toHaveLength(16);          // derived id
  expect(findings[0]!.surfacedAt).toBe(T);           // defaulted to now
  store.close();
});

// sc-4-3: same domain+title+kind twice -> exactly one active row (dedup via reconcile)
it("sc-4-3: re-ingesting the same finding leaves a single active row", async () => {
  const store = new FactStore(":memory:");
  const payload = { domain: "medical", title: "ferritin trending down", kind: "watch",
    urgency: 3, severity: 2, evidence: [], tags: [], status: "open" };
  await ingestFinding(store, payload, { now: T });
  await ingestFinding(store, payload, { now: T });   // same now -> identical value -> NOOP
  const active = store.getActiveFacts(HUB_SCOPE, undefined, "finding");
  expect(active).toHaveLength(1);                     // dedup, not a 2nd ADD
  store.close();
});
```
(If you re-ingest with a DIFFERENT `now`, the action is `"update"` and `getActiveFacts` is still length 1 — supersede+insert. Either is acceptable for sc-4-3.)

### Unit Test Pattern — CLI core (extend `src/cli/commands/task.test.ts`)
**Source idiom:** `src/cli/commands/task.test.ts:9-37` (exitCode save/restore + stderr spy).
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FactStore } from "../../state/facts.js";
import { runTaskIngest } from "./task.js";
import { HUB_SCOPE } from "../../hub/finding-source.js";

const T = "2026-06-28T00:00:00.000Z";
const originalExitCode = process.exitCode;
beforeEach(() => { process.exitCode = 0; });
afterEach(() => { vi.restoreAllMocks(); process.exitCode = originalExitCode as number | undefined; });

// sc-4-4a: malformed JSON -> exitCode 1, nothing written, no throw
it("sc-4-4: malformed JSON rejects with exitCode 1 and writes nothing", async () => {
  const store = new FactStore(":memory:");
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  await expect(runTaskIngest(store, "{ not json", T)).resolves.toBeUndefined();
  expect(process.exitCode).toBe(1);
  expect(store.getActiveFacts(HUB_SCOPE, undefined, "finding")).toHaveLength(0);
  store.close();
});

// sc-4-4b: schema-invalid (missing required `title`) -> exitCode 1, nothing written
it("sc-4-4: payload missing a required field rejects and writes nothing", async () => {
  const store = new FactStore(":memory:");
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const bad = JSON.stringify({ domain: "medical", kind: "watch", urgency: 3,
    severity: 2, evidence: [], tags: [], status: "open" }); // no title
  await expect(runTaskIngest(store, bad, T)).resolves.toBeUndefined();
  expect(process.exitCode).toBe(1);
  expect(store.getActiveFacts(HUB_SCOPE, undefined, "finding")).toHaveLength(0);
  store.close();
});

// valid ingest -> exitCode stays 0
it("valid finding JSON ingests and keeps exitCode 0", async () => {
  const store = new FactStore(":memory:");
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const good = JSON.stringify({ domain: "medical", title: "watch ferritin", kind: "watch",
    urgency: 3, severity: 2, evidence: [], tags: [], status: "open" });
  await runTaskIngest(store, good, T);
  expect(process.exitCode).toBe(0);
  store.close();
});
```
**Mock approach:** `vi.spyOn(process.stdout/stderr, "write").mockImplementation(() => true)`; restore in `afterEach`. The DI core is tested with a raw string — the file/stdin `readIngestInput` helper is the untested boundary (consistent with how `runTaskAdd` etc. omit the handler).

### E2E Test Pattern
Not applicable — this project has no Playwright/E2E suite; all coverage is vitest unit tests collocated as `*.test.ts`.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/cli/commands/task.ts` | `finding-store.ts` (new export `ingestFinding`) | low | Additive export; existing `writeFinding`/`readFindings`/`transitionFinding` imports unchanged. Add `ingestFinding` to the existing `{ ... } from "../../hub/finding-store.js"` import block (task.ts:23-28). |
| `src/hub/task-inbox.ts` | `finding-store.ts` (`writeFinding`) | low | Only imports `writeFinding` — do NOT change `writeFinding`'s signature/body. |
| `src/cli/index.ts` | `task.ts` (`registerTaskCommand`) | low | `registerTaskCommand` signature unchanged; the new subcommand is registered inside it (no new top-level wiring). |
| `src/cli/commands/task.test.ts`, `src/hub/finding-store.test.ts` | the modules under test | low | Append new tests; do NOT alter existing cases. |

### Existing Tests That Must Still Pass
- `src/hub/finding-store.test.ts` — `writeFinding + readFindings` (4 cases) and `transitionFinding` (3 cases). `ingestFinding` must NOT change `writeFinding`/`readFindings`/`transitionFinding` behavior; these prove the persistence + bitemporal-history invariants still hold.
- `src/cli/commands/task.test.ts` — `runTaskAdd`/`runTaskList`/`runTaskTransition`/`runTaskSnooze` suites (exitCode + stdout/stderr). Adding `runTaskIngest` + the `ingest` subcommand must not perturb these.
- `src/hub/finding-source.test.ts` (if present) and any FactStore reconcile tests — ingest routes through the unchanged `writeFinding`→`writeFact`→`reconcileFact`, so reconcile NOOP/UPDATE/ADD behavior is unchanged.

### Features That Could Be Affected
- **`bober task list` (Sprint 3)** — shares `readFindings`/`isVisibleInDefaultList`. An ingested `open` finding must appear in the default list (sc-4-2 / stop condition). Verify visibility unchanged.
- **`bober task add` (Sprint 1)** — shares `writeFinding` + the `createHash` id idiom. Adding `createHash` import to finding-store.ts must not collide with task-inbox's own import (separate files — fine).
- **priority-hub (sibling spec)** — consumes the hub-owned `FindingSchema`. Do NOT widen or alter `FindingSchema` in finding.ts; the relaxed `IngestInputSchema` is LOCAL to finding-store.ts.

### Recommended Regression Checks
1. `npm run build` (`tsc`) exits 0 — `ingestFinding` + `ingest` subcommand compile (sc-4-1, sc-4-5).
2. `npm run typecheck` (`tsc --noEmit`) exits 0 — no unused vars/params, `import type` for type-only imports (sc-4-5).
3. `npx vitest run src/hub/finding-store.test.ts src/cli/commands/task.test.ts` — new sc-4-2/3/4 cases pass AND all prior task/finding-store cases still pass.
4. `npx vitest run` (full suite) — zero regressions across the ~3264-test suite.

---

## 8. Implementation Sequence

1. **`src/hub/finding-store.ts`** — add `import { createHash } from "node:crypto";`, the private `deriveFindingId`, the `IngestInputSchema`, and the exported `ingestFinding`. Return `writeFinding(...)`'s `ReconcileAction`.
   - Verify: `npm run typecheck` — no unused-import/var errors; `ingestFinding` returns `Promise<ReconcileAction>`.
2. **`src/hub/finding-store.test.ts`** — add sc-4-2 (watch finding appears) and sc-4-3 (dedup → 1 active row) from §6.
   - Verify: `npx vitest run src/hub/finding-store.test.ts` green (old + new).
3. **`src/cli/commands/task.ts`** — add `readFile` import (`node:fs/promises`), add `ingestFinding` to the finding-store import, add `readIngestInput` helper + exported `runTaskIngest`, register `ingest [file]` inside `registerTaskCommand`.
   - Verify: `npm run build` exits 0; `bober task ingest --help` lists the subcommand.
4. **`src/cli/commands/task.test.ts`** — add sc-4-4 (malformed JSON + missing-field) and a valid-ingest case from §6.
   - Verify: `npx vitest run src/cli/commands/task.test.ts` green.
5. **Full verification** — `npm run build` && `npm run typecheck` && `npx vitest run`.

(Dependency order: types/schema reuse → store core (`ingestFinding`) → store tests → CLI wiring → CLI tests → full suite.)

---

## 9. Pitfalls & Warnings

- **Lint cleanliness (prior sprint failed once on an unused-var error).** Every import must be used; type-only imports use `import type` (`consistent-type-imports` is errored). If you add a parameter you don't use, prefix with `_`. Run `npm run typecheck` before declaring done.
- **No clock inside `ingestFinding`.** `now` is injected (sc/nonGoals). NO `Date.now()` / `new Date()` inside the store or the DI core — only the commander `.action` handler stamps `now = new Date().toISOString()` (task.ts:257 etc.).
- **No sync fs.** Read input with `node:fs/promises` `readFile` (file path OR fd `0` for stdin). `fs.readFileSync`/`readSync` are forbidden by principles.md:42.
- **Reuse `writeFinding`, never `insertFact`/`writeFact` directly.** evaluatorNotes explicitly check this. Routing through `writeFinding` is what makes reconcile dedup apply (subject=finding.id).
- **Validate BEFORE writing.** `ingestFinding` must `.parse` first; a rejected payload persists NOTHING (sc-4-4 asserts 0 rows after a malformed ingest).
- **id is content-derived, NOT clock-derived.** Hash `domain|title|kind` only. (captureTask hashes `title|now` — DON'T copy that; it would defeat dedup.)
- **Don't make the rejection test omit `id`/`surfacedAt`.** Those are auto-filled, so omitting them does NOT trigger a reject. Omit a genuinely-required field like `title`/`kind`/`urgency`.
- **`.partial({ id: true, surfacedAt: true })` keeps every other constraint.** Don't use bare `.partial()` (that makes ALL fields optional and would let a no-title payload through). zod is `^3.24.2` — both `.partial(mask)` and `.extend(...)` are available.
- **JSON.parse lives in the DI core, not the handler.** So the malformed-JSON test (sc-4-4) can drive `runTaskIngest(store, "{ bad", T)` directly without spawning the CLI.
- **`FindingSchema` is hub-owned and shared with priority-hub.** Do NOT modify finding.ts; keep `IngestInputSchema` local to finding-store.ts.
