# Sprint Briefing: Recurring scheduler — cadence due-dates + idempotent `bober research tick`

**Contract:** sprint-spec-20260628-research-scheduler-4
**Generated:** 2026-06-30T00:00:00.000Z

---

## 0. Critical Findings (read first)

### FINDING A — SCHEMA GAP CONFIRMED: `ResearchJobSchema` has NO `nextDueAt` / `lastRunAt`
`src/research/types.ts:33-54` defines the schema with exactly:
`{ id, question, cadence, tier?, modelSet?, targetRepo?, domain?, onlineResearch (default false), createdAt }`.
There is **no `nextDueAt` and no `lastRunAt`**.

This matters because `addJob` validates with `ResearchJobSchema.safeParse(job)` and then writes
`validation.data` (`src/research/job-store.ts:48-59`). Zod `z.object()` **strips unknown keys**, so if the
scheduler sets `job.nextDueAt`/`job.lastRunAt` on a plain object and calls `addJob`, those keys are
**silently dropped on write** — the scheduler would never advance and `tick` would never become idempotent.

**REQUIRED FIX (adds `src/research/types.ts` to the file set even though `estimatedFiles` omitted it):**
Extend the schema with two optional ISO fields. Insert right after the `createdAt` line (types.ts:53):
```typescript
  /** ISO-8601 creation timestamp — set once at CLI boundary, never mutated. */
  createdAt: z.string().datetime(),
  /**
   * ISO-8601 next-due instant (Sprint 4). Unset => due immediately on first tick.
   * Advanced by computeNextDue(cadence, now) after each run. Never read from the wall clock.
   */
  nextDueAt: z.string().datetime().optional(),
  /** ISO-8601 timestamp of the most recent successful run (Sprint 4). Unset until first run. */
  lastRunAt: z.string().datetime().optional(),
});
```
Use `.datetime()` for consistency with `createdAt` (the round-trip tests reparse, so non-ISO values would
fail). Both MUST be `.optional()` so all existing jobs on disk (which lack these keys) still parse.

### FINDING B — PERSIST PATH: `addJob` is already an upsert; NO `updateJob` required
`jobId(question, createdAt)` (`src/research/job-store.ts:28-33`) hashes **only** `question|createdAt`.
It does NOT depend on `nextDueAt`/`lastRunAt`, so adding those fields **does not change a job's id**.
`addJob` writes to `jobPath(projectRoot, job.id)` (`job-store.ts:56-60`), which is derived from `job.id`
alone (`job-store.ts:16-19`). Therefore re-adding a job with the same `id` **overwrites the same file** =
an in-place upsert. The scheduler persists an advanced job by calling `addJob(projectRoot, updatedJob)`.

`src/research/job-store.ts` is in `estimatedFiles` only as an OPTIONAL convenience: you MAY add a thin
semantic alias `updateJob` for readability, but it would be byte-identical to `addJob`. **Recommendation:
reuse `addJob` and do NOT add a duplicate function** (principles L33 "small utility modules"; avoid
reinvention). If you add `updateJob`, make it `export const updateJob = addJob;` or a 1-line wrapper that
calls `addJob` — do not re-implement validation/write.

---

## 1. Target Files

### src/research/types.ts (MODIFY — see Finding A)
**Relevant section (lines 33-54)** — the full schema; add the two optional fields after line 53 (`createdAt`).
The `Cadence` type/enum is already here (lines 14-15) and is consumed by `computeNextDue`:
```typescript
export const CadenceSchema = z.enum(["daily", "weekly", "monthly"]);
export type Cadence = z.infer<typeof CadenceSchema>;
```
**Imported by:** `src/research/job-store.ts:6`, `src/research/runner.ts:28`, `src/cli/commands/research.ts:36`,
`src/research/runner.test.ts:17`, `src/research/job-store.test.ts:7`.
**Test file:** covered by `src/research/job-store.test.ts` (schema validation lives there, lines 38-91).

### src/research/cadence.ts (CREATE)
**Directory pattern:** files in `src/research/` are kebab-free lowercase nouns (`runner.ts`, `egress.ts`,
`note-writer.ts`, `model-diversity.ts`). Co-located `*.test.ts`. ESM `.js` import extensions.
**Most similar existing file:** `src/calendar/slotter.ts` — pure, clock-free, `Date.parse`/`toISOString`
arithmetic, exhaustive `switch` + `never` guard.
**Structure template:**
```typescript
import type { Cadence } from "./types.js";

/**
 * computeNextDue — PURE, clock-free next-due math (Sprint 4).
 * Never calls Date.now()/new Date() with no argument. `fromIso` is the injected
 * base instant; the wall clock is read only at the CLI .action() boundary.
 * Mirrors the clock discipline in src/state/facts.ts:18-21 and src/calendar/slotter.ts:1-16.
 */
export function computeNextDue(cadence: Cadence, fromIso: string): string {
  const base = new Date(Date.parse(fromIso)); // parsing a string is pure (no clock)
  switch (cadence) {
    case "daily":
      base.setUTCDate(base.getUTCDate() + 1);
      return base.toISOString();
    case "weekly":
      base.setUTCDate(base.getUTCDate() + 7);
      return base.toISOString();
    case "monthly":
      base.setUTCMonth(base.getUTCMonth() + 1); // see PITFALL: month-length rollover
      return base.toISOString();
    default: {
      const _exhaustive: never = cadence;
      throw new Error(`Unhandled cadence: ${String(_exhaustive)}`);
    }
  }
}
```
**No date library is needed** — Sprint stack has no date lib; `Date` arithmetic on the injected instant is
sufficient and pure. Do NOT add `dayjs`/`date-fns`.

### src/research/cadence.test.ts (CREATE) — see Section 6
### src/research/scheduler.ts (CREATE)
**Most similar existing file (deps-injection shape):** `src/research/runner.ts:46-61` (`RunDeps`).
**Structure template** (deps = `{ now, listJobs, saveJob, runJob }` per generatorNotes):
```typescript
import { computeNextDue } from "./cadence.js";
import type { ResearchJob } from "./types.js";

/** Injected dependencies for tick — all I/O and the clock are injected (testable, clock-free). */
export interface TickDeps {
  /** Injected ISO instant — stamped at the CLI boundary; never read the clock here. */
  now: string;
  /** Load all stored jobs (CLI binds to () => listJobs(projectRoot)). */
  listJobs: () => Promise<ResearchJob[]>;
  /** Persist an advanced job (CLI binds to (j) => addJob(projectRoot, j) — upsert by id). */
  saveJob: (job: ResearchJob) => Promise<void>;
  /** Run one due job (CLI binds runResearchJob with its deps bound; tests pass a spy). */
  runJob: (job: ResearchJob) => Promise<void>;
}

export interface TickResult {
  ran: string[];     // ids of jobs that ran
  skipped: string[]; // ids of jobs not yet due
}

/** Run every due job once, advance its nextDueAt, record lastRunAt. Idempotent at a fixed `now`. */
export async function tick(deps: TickDeps): Promise<TickResult> {
  const { now, listJobs, saveJob, runJob } = deps;
  const jobs = await listJobs();
  const ran: string[] = [];
  const skipped: string[] = [];

  for (const job of jobs) {
    // Due when never scheduled (undefined) OR nextDueAt is at/Before now.
    const due = job.nextDueAt === undefined || Date.parse(job.nextDueAt) <= Date.parse(now);
    if (!due) {
      skipped.push(job.id);
      continue;
    }
    await runJob(job);                                   // Sprint 2 runner, invoked unchanged
    const advanced: ResearchJob = {
      ...job,
      lastRunAt: now,
      nextDueAt: computeNextDue(job.cadence, now),
    };
    await saveJob(advanced);                             // upsert: same id => same file
    ran.push(job.id);
  }
  return { ran, skipped };
}
```
**Idempotency proof:** after a run `nextDueAt = computeNextDue(cadence, now)` which is strictly > `now`,
so a second `tick` at the same `now` evaluates `due === false` for that job (sc-4-3).
**Order matters:** run FIRST, then advance+persist. Do not advance before `runJob` resolves.

### src/research/scheduler.test.ts (CREATE) — see Section 6
### src/research/job-store.ts (OPTIONAL MODIFY — see Finding B)
Reuse `addJob` as the upsert. Only touch this file if you add a 1-line `updateJob` alias.

### src/cli/commands/research.ts (MODIFY)
Add a `tick [--watch]` subcommand on `researchCmd`. Follow the existing `research run` handler
(`research.ts:193-272`) for the deps-binding pattern and the `ResearchRunOverrides` injection point
(`research.ts:61-71`). **Relevant existing sections:**
- Override interface to extend (lines 61-64): `ResearchRunOverrides { queryModel?; findingSink? }`.
- Clock stamp at boundary (line 209): `const now = new Date().toISOString();` — the ONLY place a clock is read.
- runJob binding mirrors run (lines 216-259): build `qm`/`fs`, call `runResearchJob(job, { queryModel, findingSink, now, vaultRoot })`.
- Never-throw error handling (lines 264-271): `catch { process.stderr.write(...); process.exitCode = 1; }`.

**`tick` handler skeleton** (inject `now`/`runJob`/`listJobs`/`saveJob` so tests bypass real provider+SQLite):
```typescript
researchCmd
  .command("tick")
  .description(
    "Run every research job that is due as of now (idempotent).\n" +
      "Scheduling mechanism tradeoff:\n" +
      "  --watch        in-process setInterval loop — simple, but DIES with the process (not for unattended).\n" +
      "  OS cron/launchd call `bober research tick`  — survives reboots; RECOMMENDED for unattended runs.\n" +
      "  harness scheduler (/schedule) — fires the CLI on a cadence inside the agent harness.\n" +
      "Note: hosted-OAuth schedulers are unfit for unattended runs (research doc L135).",
  )
  .option("--watch", "Run tick on an in-process interval (loop dies when the process exits)")
  .option("--interval <ms>", "Watch interval in milliseconds", "3600000")
  .action(async (opts: { watch?: boolean; interval?: string }) => {
    const projectRoot = await resolveRoot();
    const runOnce = async (): Promise<void> => {
      const now = new Date().toISOString();            // clock read ONLY here (principles L31)
      // ...build qm/fs as in `research run` (lines 216-251), then:
      await tick({
        now,
        listJobs: () => listJobs(projectRoot),
        saveJob: (j) => addJob(projectRoot, j),        // upsert by id (Finding B)
        runJob: (job) => runResearchJob(job, { queryModel: qm, findingSink: fs, now, vaultRoot: projectRoot }).then(() => {}),
      });
    };
    try {
      await runOnce();
      if (opts.watch === true) {
        const ms = Number(opts.interval ?? "3600000");
        setInterval(() => { void runOnce(); }, ms);    // loop body delegates to the same injected-now tick
      }
    } catch (err) {
      process.stderr.write(chalk.red(`research tick failed: ${err instanceof Error ? err.message : String(err)}\n`));
      process.exitCode = 1;
    }
  });
```
NOTE: the `findingSink` real binding opens a `FactStore` (research.ts:238-251) — for a single `tick` run,
open the store once and `close()` in a `finally`, exactly like `research run` (lines 238-263). For `--watch`,
open/close per `runOnce()` call (do not hold the SQLite handle open across the whole interval loop).
**Do NOT** `setInterval(...).unref()` for `--watch` — unref lets the process exit; a watch loop must keep
the process alive (contrast `event-stream.ts:436` which unrefs a telemetry poll precisely so it does NOT
block exit).

---

## 2. Patterns to Follow

### Clock-free / injected-now discipline
**Source:** `src/state/facts.ts:18-21`, `src/research/runner.ts:18-19`, `src/cli/commands/research.ts:15-17`
```typescript
// runner.ts:18-19
// Clock discipline: `now` is always stamped at the CLI .action() boundary.
// This module never calls new Date() or Date.now().
```
**Rule:** `cadence.ts` and `scheduler.ts` MUST NOT call `new Date()` with no args or `Date.now()`. Parse the
injected ISO string (`Date.parse(iso)` / `new Date(Date.parse(iso))`) — that is pure. Read the clock only at
`research.ts` `.action()` (line 209 shows the existing pattern).

### Pure Date arithmetic via Date.parse / toISOString
**Source:** `src/calendar/slotter.ts:14-16, 46-78`
```typescript
// slotter.ts:14-16
// Time math uses Date.parse(iso) → epoch-ms arithmetic (pure — same ISO always yields same ms).
// new Date(ms).toISOString() converts back to ISO-8601 (also pure — deterministic).
```
**Rule:** Same-format UTC ISO strings round-trip deterministically; use this for both `computeNextDue` and
the due comparison in `tick`.

### Exhaustive switch + `never` guard
**Source:** `src/calendar/slotter.ts:137-150`
```typescript
switch (reason) {
  case "does-not-fit": return "...";
  case "no-free-slot-before-dueBy": return "...";
  default: {
    const _exhaustive: never = reason;
    throw new Error(`Unhandled UnscheduledReason: ${String(_exhaustive)}`);
  }
}
```
**Rule:** Use the same `never`-guard shape in `computeNextDue`'s cadence switch so adding a 4th cadence later
is a compile error, not a silent fall-through (satisfies `noFallthroughCasesInSwitch`, principles L18).

### Deps-injection contract for testability
**Source:** `src/research/runner.ts:46-61` (`RunDeps`) and `src/cli/commands/research.ts:61-69`
(`ResearchRunOverrides` passed into `registerResearchCommand`).
**Rule:** `tick(deps)` takes `now`/`listJobs`/`saveJob`/`runJob` so unit tests inject fakes (a `runJob` spy +
a real temp store) without mocking provider SDKs or SQLite.

### Zod safeParse-before-write upsert
**Source:** `src/research/job-store.ts:42-61`
```typescript
const validation = ResearchJobSchema.safeParse(job);
if (!validation.success) { throw new Error(`Invalid research job:\n${issues}`); }
await writeFile(jobPath(projectRoot, job.id), JSON.stringify(validation.data, null, 2) + "\n", "utf-8");
```
**Rule:** The schema gates the write — this is exactly why Finding A's schema extension is mandatory.

### CLI handler never-throws → process.exitCode = 1
**Source:** `src/cli/commands/research.ts:12-13, 123-130, 264-271`
**Rule:** `tick`'s `.action` wraps everything in try/catch, writes a red error to stderr, sets
`process.exitCode = 1`, and returns — never re-throws.

### Section box-drawing comments
**Source:** principles L32; e.g. `src/research/runner.ts:38, 101, 139`.
**Rule:** Organize new files with `// ── Section ──────` headers.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `jobId` | `src/research/job-store.ts:28` | `(question: string, createdAt: string): string` | Stable 16-char id from `question\|createdAt` — independent of nextDueAt/lastRunAt (Finding B) |
| `addJob` | `src/research/job-store.ts:42` | `(projectRoot, job): Promise<void>` | Validate + write `<id>.json` — **upsert by id**; use this to persist advanced jobs |
| `listJobs` | `src/research/job-store.ts:68` | `(projectRoot): Promise<ResearchJob[]>` | Load+validate all jobs; `[]` if dir missing — bind to `tick`'s `listJobs` |
| `readJob` | `src/research/job-store.ts:100` | `(projectRoot, id): Promise<ResearchJob \| null>` | Single-job read (not needed by tick, but available) |
| `removeJob` | `src/research/job-store.ts:119` | `(projectRoot, id): Promise<boolean>` | Delete a job file |
| `runResearchJob` | `src/research/runner.ts:149` | `(job, deps): Promise<RunResult>` | Sprint 2 runner — invoke UNCHANGED per due job |
| `CadenceSchema` / `Cadence` | `src/research/types.ts:14-15` | `z.enum(["daily","weekly","monthly"])` | The cadence domain `computeNextDue` switches over |
| `ResearchJobSchema` / `ResearchJob` | `src/research/types.ts:33,56` | Zod object / inferred type | Extend with nextDueAt/lastRunAt (Finding A) |
| `findProjectRoot` | `src/utils/fs.ts` (imported `research.ts:28`) | `(): Promise<string \| null>` | Resolve project root in the CLI handler (`resolveRoot`, research.ts:49-52) |
| `ensureDir` | `src/state/helpers.ts` (imported `job-store.ts:5`) | `(dir): Promise<void>` | Used inside `addJob`; do not call directly from scheduler |

Directories reviewed: `src/research/`, `src/state/` (helpers, facts), `src/utils/`, `src/calendar/` — the
above are all the helpers relevant to scheduling. No date/time util exists (none to reuse; use `Date`).

---

## 4. Prior Sprint Output

### Sprint 1 (0336e47): job types + store
**Created:** `src/research/types.ts` (`ResearchJobSchema`, `CadenceSchema`), `src/research/job-store.ts`
(`addJob`/`listJobs`/`readJob`/`removeJob`/`jobId`).
**Connection:** Sprint 4 extends the schema (Finding A), reuses `addJob` as the upsert (Finding B), and
switches over `CadenceSchema`'s values in `computeNextDue`.

### Sprint 2 (20d42cb): runner
**Created:** `src/research/runner.ts` — `runResearchJob(job, deps)` where deps =
`{ queryModel, findingSink, now, vaultRoot, egress?, retrievalClient? }` (`runner.ts:46-61`).
**Connection:** `tick`'s `runJob` invokes `runResearchJob` UNCHANGED, passing the injected `now` as the
run's `now`. The CLI builds `queryModel`/`findingSink` exactly as `research run` does (research.ts:216-251).

### Sprint 3 (0150737): egress axis
**Created/changed:** added OPTIONAL `egress?`/`retrievalClient?` to `RunDeps` (`runner.ts:56-60`).
**Connection:** Irrelevant to Sprint 4. The `research run` command omits these (research.ts:254-259 passes
no egress) → offline path. `tick` should likewise OMIT egress/retrievalClient — byte-identical offline run.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM everywhere** — all imports use `.js` extensions (L27). New files: `import { computeNextDue } from "./cadence.js"`.
- **Clock stamped at CLI boundary** — facts/runner never read the clock; mirror in cadence/scheduler (L31 filesystem state, runner.ts:18-19).
- **Zod for validation** — schema gates the write (L29); drives Finding A.
- **Tests collocated** `*.test.ts` next to `*.ts`, Vitest, **no fs mocks** — use temp dirs (L20, L44).
- **`import type`** for type-only imports (`consistent-type-imports`, L35). e.g. `import type { Cadence } from "./types.js"`.
- **Prefix unused params with `_`** (L36) — used by the `never` guard (`const _exhaustive`).
- **Section box-drawing headers** (L32).
- **No synchronous fs** (L42) — scheduler does no direct fs; it delegates to the injected store.

### Architecture Decisions
No `.bober/architecture/` ADR specific to the research scheduler was found. The scheduling-mechanism
tradeoff lives in the research doc (below), not an ADR.

### Other Docs — research landscape (`.bober/research/research-20260627-knowledge-platform-landscape.md`)
- Section 2 item 2 ("Scheduler for recurring multi-model research", ~L101-103): reuse harness-level cron
  (`/schedule`, `CronCreate`) to fire `bober run`/`fleet`/`chat` on a cadence; net-new is the thin research-job config.
- L135 (calendar caveat, cited by `generatorNotes`/`assumptions`): **hosted OAuth isn't built for unattended
  cron** → unattended runs need a local trigger. Quote this in the tick help text as the reason OS cron/launchd
  (not a hosted scheduler) is the recommended unattended trigger.

---

## 6. Testing Patterns

### Unit Test Pattern — pure function (cadence.test.ts)
**Source:** `src/calendar/slotter.test.ts:1-7` (imports + Vitest) — a pure function tested with fixed inputs.
```typescript
import { describe, it, expect } from "vitest";
import { computeNextDue } from "./cadence.js";

describe("computeNextDue — sc-4-1 (deterministic, clock-free)", () => {
  const BASE = "2026-06-15T12:00:00.000Z";
  it("daily adds one day", () => {
    expect(computeNextDue("daily", BASE)).toBe("2026-06-16T12:00:00.000Z");
  });
  it("weekly adds seven days", () => {
    expect(computeNextDue("weekly", BASE)).toBe("2026-06-22T12:00:00.000Z");
  });
  it("monthly adds one month", () => {
    expect(computeNextDue("monthly", BASE)).toBe("2026-07-15T12:00:00.000Z");
  });
  it("is deterministic — identical inputs yield identical output", () => {
    expect(computeNextDue("weekly", BASE)).toBe(computeNextDue("weekly", BASE));
  });
});
```
Also add a month-rollover edge case (see PITFALL): assert the actual output of `computeNextDue("monthly",
"2026-01-31T00:00:00.000Z")` and document it (JS `setUTCMonth` rolls Jan 31 → Mar 3 in a non-leap year).

### Unit Test Pattern — scheduler with real temp store + runJob spy (scheduler.test.ts)
**Source:** temp-dir lifecycle from `src/research/job-store.test.ts:1-19`; deps-injection from
`src/research/runner.test.ts:56-67`.
```typescript
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { addJob, listJobs, readJob, jobId } from "./job-store.js";
import { ResearchJobSchema, type ResearchJob } from "./types.js";
import { tick } from "./scheduler.js";

let tmpRoot: string;
beforeEach(async () => { tmpRoot = await mkdtemp(join(tmpdir(), "bober-research-tick-")); });
afterEach(async () => { await rm(tmpRoot, { recursive: true, force: true }); });

const NOW = "2026-06-15T12:00:00.000Z";
function makeJob(o: Partial<ResearchJob>): ResearchJob {
  const question = o.question ?? "Q";
  const createdAt = o.createdAt ?? "2026-06-01T00:00:00.000Z";
  return ResearchJobSchema.parse({ id: jobId(question, createdAt), question, cadence: "daily", onlineResearch: false, createdAt, ...o });
}

it("sc-4-2/sc-4-3: runs only due jobs, advances nextDueAt, and a second tick at same now is a no-op", async () => {
  const due = makeJob({ question: "due", nextDueAt: "2026-06-10T00:00:00.000Z" });   // <= now
  const future = makeJob({ question: "future", nextDueAt: "2026-07-01T00:00:00.000Z" }); // > now
  await addJob(tmpRoot, due);
  await addJob(tmpRoot, future);

  const ran: string[] = [];
  const deps = {
    now: NOW,
    listJobs: () => listJobs(tmpRoot),
    saveJob: (j: ResearchJob) => addJob(tmpRoot, j),
    runJob: async (j: ResearchJob) => { ran.push(j.id); },
  };

  const r1 = await tick(deps);
  expect(ran).toEqual([due.id]);                 // only the due job fired (sc-4-2)
  const advanced = await readJob(tmpRoot, due.id);
  expect(advanced?.lastRunAt).toBe(NOW);          // lastRunAt === injected now (sc-4-3)
  expect(advanced?.nextDueAt).toBe("2026-06-16T12:00:00.000Z"); // advanced by cadence (sc-4-3)
  expect(r1.skipped).toContain(future.id);

  ran.length = 0;
  await tick(deps);
  expect(ran).toEqual([]);                        // second tick at same now runs nothing (sc-4-3)
});

it("a job with no nextDueAt is due on first tick", async () => {
  await addJob(tmpRoot, makeJob({ question: "fresh" }));   // nextDueAt undefined
  const ran: string[] = [];
  await tick({ now: NOW, listJobs: () => listJobs(tmpRoot), saveJob: (j) => addJob(tmpRoot, j), runJob: async (j) => { ran.push(j.id); } });
  expect(ran).toHaveLength(1);
});
```
**Runner:** vitest. **Assertion style:** `expect`. **Mock approach:** NO module mocks — inject fakes + real
temp store (principles L44). **File naming:** `<name>.test.ts` co-located. **Location:** `src/research/`.

### CLI Test Pattern (research.ts tick subcommand)
**Source:** `src/cli/commands/research.test.ts:31-75` — mock ONLY `utils/fs.js` (`findProjectRoot`), build a
fresh `Command()` with `program.exitOverride()`, inject run overrides, and `parseAsync(["node","bober",...])`.
```typescript
vi.mock("../../utils/fs.js", () => ({ findProjectRoot: vi.fn() }));
// ...beforeEach: vi.mocked(findProjectRoot).mockResolvedValue(tmpRoot);
function makeProgramWithRunOverrides(queryModel, findingSink) {
  const program = new Command();
  program.exitOverride();
  registerResearchCommand(program, { queryModel, findingSink });
  return program;
}
// await parse(program, ["research", "tick"]);   // then assert process.exitCode === 0
```
Inject `queryModel`/`findingSink` overrides so `tick` never hits a real provider or SQLite (mirrors the
`research run` test at research.test.ts:228-274). For `--watch`, assert the flag PARSES (exitCode 0); do NOT
start a real interval in a unit test — if you must, capture the loop body via the injected-now path or stub
`setInterval` so the test does not hang.

### E2E Test Pattern
Not applicable — this is a CLI/library sprint, no Playwright. (`e2e/`-style tests here are CLI `parseAsync`
integration tests as shown above.)

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/research/job-store.ts` | `ResearchJobSchema` (types.ts) | low | Adding OPTIONAL fields cannot break `safeParse`; existing on-disk jobs (no new keys) still validate |
| `src/cli/commands/research.ts` | `ResearchJobSchema`, `addJob`, `listJobs`, `runResearchJob` | low | Existing `add`/`list`/`run` handlers unchanged; only a new `tick` command added |
| `src/research/runner.ts` | `ResearchJob` type | low | New optional fields are additive; runner ignores them — byte-identical run path |
| `src/research/job-store.test.ts` | `ResearchJobSchema` round-trip (lines 101-110) | medium | `reparsed === job` round-trip still holds because new fields are optional and absent in `makeJob` |
| `src/research/runner.test.ts` | `ResearchJobSchema.parse` fixtures (lines 27-42) | low | Fixtures omit the new fields; optional => still parse |
| `src/cli/index.ts:331` | `registerResearchCommand` | low | Signature unchanged; new subcommand auto-registers |

### Existing Tests That Must Still Pass
- `src/research/job-store.test.ts` — schema validation (lines 38-91) + store round-trip (lines 101-110); the
  round-trip `expect(reparsed).toEqual(job)` (line 109) is the canary that the new optional fields don't leak
  default values when absent. Run after the types.ts change.
- `src/research/runner.test.ts` — runner fixtures `ResearchJobSchema.parse(...)` (lines 27-42); confirm they
  still parse with the extended schema.
- `src/cli/commands/research.test.ts` — `add`/`list`/`remove`/`run` handlers (lines 79-286); confirm adding
  the `tick` command doesn't alter existing command registration.

### Features That Could Be Affected
- **`bober research run`** — shares `runResearchJob` and the `queryModel`/`findingSink` binding; verify `run`
  still prints the note path (research.test.ts:260-263) and `tick` reuses the SAME binding without regressing it.
- **Sprint 5 (digest, out of scope)** — will consume `lastRunAt`/`nextDueAt`; make the field names exactly
  `lastRunAt`/`nextDueAt` (ISO) so Sprint 5 can read them.

### Recommended Regression Checks (run after implementation)
1. `npm run build` — clean `tsc` (sc-4-4: scheduler module + tick + `--watch` flag compile).
2. `npx vitest run src/research/cadence.test.ts src/research/scheduler.test.ts` — new units green (sc-4-1/2/3).
3. `npx vitest run src/research/job-store.test.ts src/research/runner.test.ts src/cli/commands/research.test.ts`
   — prior research tests still green (schema extension is non-breaking).
4. `npm run lint` — `consistent-type-imports`, no unused vars, no `any` (principles L18-L19).

---

## 8. Implementation Sequence (dependency-ordered)

1. **src/research/types.ts** — add optional `nextDueAt` / `lastRunAt` (`z.string().datetime().optional()`) after `createdAt` (Finding A).
   - Verify: `npx vitest run src/research/job-store.test.ts` still green (round-trip line 109 holds).
2. **src/research/cadence.ts** — pure `computeNextDue(cadence, fromIso)` with `never`-guard switch (no clock).
   - Verify: grep the file for `Date.now`/`new Date()` (no-arg) → none; only `Date.parse`/`new Date(ms)`.
3. **src/research/cadence.test.ts** — daily/weekly/monthly + determinism + month-rollover edge.
   - Verify: `npx vitest run src/research/cadence.test.ts` green (sc-4-1).
4. **src/research/scheduler.ts** — `tick(deps)` with `{now, listJobs, saveJob, runJob}`; run→advance→persist.
   - Verify: file has no clock read; imports `computeNextDue` from `./cadence.js`.
5. **src/research/job-store.ts** — (OPTIONAL) only if adding a `updateJob = addJob` alias; otherwise skip (Finding B).
   - Verify: no duplicate validation/write logic introduced.
6. **src/research/scheduler.test.ts** — due-only selection, advancement, no-op second tick, undefined-nextDueAt-is-due.
   - Verify: `npx vitest run src/research/scheduler.test.ts` green (sc-4-2/sc-4-3).
7. **src/cli/commands/research.ts** — register `tick [--watch] [--interval]`; clock at `.action` only; bind store + runJob; help-text tradeoff doc.
   - Verify: `node dist/.../cli ... research tick --help` (after build) shows the tradeoff text; `--watch` parses.
8. **Run full verification** — `npm run build`, `npx vitest run src/research src/cli/commands/research.test.ts`, `npm run lint`.

---

## 9. Pitfalls & Warnings

- **Zod strips unknown keys (THE #1 trap):** without Finding A's schema extension, `addJob`'s `safeParse`
  drops `nextDueAt`/`lastRunAt` (job-store.ts:48-58) and the scheduler NEVER advances — `tick` re-runs every
  job every time, failing sc-4-3. Do types.ts FIRST.
- **Month-length rollover:** `Date.setUTCMonth(m+1)` on `2026-01-31` yields **2026-03-03** (Feb has 28 days,
  JS overflows into March), and `2026-01-30`→`2026-03-02`. This is deterministic and acceptable for a
  monthly cadence, but ADD an explicit test asserting the real output and a code comment documenting it.
  Do NOT try to "fix" it with clamp-to-end-of-month unless the contract asks (it does not).
- **ISO comparison:** `Date.parse(a) <= Date.parse(b)` is pure and robust; prefer it over raw string `<=`
  (string compare only works if both are identical UTC `...Z` millisecond format — they are here, but parse
  is safer and matches slotter.ts:50).
- **Clock discipline gate:** the evaluator greps cadence.ts/scheduler.ts for `Date.now()`/no-arg `new Date()`.
  Read the clock ONLY at `research.ts` `.action()` (existing pattern line 209). Pass `now` everywhere else.
- **`--watch` must NOT unref:** unlike `event-stream.ts:436`, do NOT `.unref()` the `setInterval` — the watch
  loop must keep the process alive. (unref would cause the CLI to exit immediately after the first tick.)
- **FactStore lifecycle in `--watch`:** open/close the `FactStore` per `runOnce()` (like research.ts:238-263),
  NOT once for the whole loop — holding a SQLite handle open across an unbounded interval loop risks lock/leak.
- **Reuse `addJob`, don't fork it:** `addJob` already validates+writes by id = upsert (Finding B). Creating a
  parallel `updateJob` with its own `writeFile` duplicates logic and risks schema-skip drift.
- **Invoke `runResearchJob` UNCHANGED:** contract nonGoal L38. Bind its deps in the CLI (queryModel/findingSink/
  now/vaultRoot), omit `egress`/`retrievalClient` (offline, byte-identical to `research run`). Do not edit runner.ts.
- **`registerResearchCommand` signature is shared:** `src/cli/index.ts:331` and the tests call it with the
  same `(program, overrides?)` shape — keep `ResearchRunOverrides` backward-compatible (add fields as optional
  if you need to inject `now`/`runJob` for the tick CLI test; do not make them required).
