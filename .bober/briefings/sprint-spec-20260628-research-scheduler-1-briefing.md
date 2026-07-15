# Sprint Briefing: Research job schema, JSON store, and `bober research job` CLI

**Contract:** sprint-spec-20260628-research-scheduler-1
**Generated:** 2026-06-29T00:00:00.000Z

> Scope (Sprint 1 of 5): job-definition layer ONLY — a `ResearchJob` Zod schema, a JSON
> file store at `.bober/research/jobs/<jobId>.json`, and a `bober research job add|list|remove`
> CLI. NO execution, egress, scheduling, or digest. Non-goals are hard (see contract L36-41).

---

## 1. Target Files

All four `src/research/*` files and both new test files are **create**. Only `src/cli/index.ts` is **modify**.

### src/research/types.ts (create)

**Directory pattern:** `src/research/` does not exist yet — you create it. A standalone Zod-schema
module follows `src/calendar/types.ts:1-32` (a `types.ts` that is `import { z }` → `z.object` →
`export type X = z.infer<...>`).
**Most similar existing files:** `src/calendar/types.ts:12-29` (file-level schema module) and
`src/state/facts.ts:18-33` (the `FactSchema` style the contract explicitly says to mirror).
**Structure template:**
```typescript
import { z } from "zod";

// ── Cadence ───────────────────────────────────────────────────────────
/**
 * Recurrence cadence. Sprint 1 stores this verbatim; next-due computation is
 * Sprint 4 and is intentionally NOT done here (contract outOfScope L55).
 */
export const CadenceSchema = z.enum(["daily", "weekly", "monthly"]);
export type Cadence = z.infer<typeof CadenceSchema>;

// ── ResearchJob ───────────────────────────────────────────────────────
/**
 * A recurring research job definition. All timestamps are ISO-8601 strings;
 * this module never reads the clock (mirrors src/state/facts.ts:18-21).
 */
export const ResearchJobSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),           // sc-1-1: empty question MUST fail parse
  cadence: CadenceSchema,
  tier: z.string().optional(),           // tier OR modelSet (sc-1-1) — both optional, pick at run time
  modelSet: z.array(z.string()).optional(),
  targetRepo: z.string().optional(),
  domain: z.string().optional(),
  onlineResearch: z.boolean().default(false), // sc-1-1: default false (no egress yet)
  createdAt: z.string().datetime(),
});

export type ResearchJob = z.infer<typeof ResearchJobSchema>;
```
**Rule:** `question` MUST be `z.string().min(1)` so an empty question is a Zod parse failure
(sc-1-1). `onlineResearch` MUST `.default(false)`. Decide tier-vs-modelSet as both-optional and
document it; do NOT add an egress field. Document the cadence choice in the doc-comment (generatorNotes).

---

### src/research/job-store.ts (create)

**Most similar existing file:** `src/state/plan-state.ts:1-140` — copy its exact shape
(ensureDir → `safeParse` before write → `writeFile` JSON; `readdir` + per-file `safeParse`-skip for
list). For `remove`, add `unlink` exactly like `src/state/approval-state.ts:138-140`.
**Path/slug helper:** mirror `src/state/plan-state.ts:13-16` (and identically `src/state/research-state.ts:11-14`):
```typescript
const JOBS_DIR = ".bober/research/jobs";
function jobsDir(projectRoot: string): string {
  return join(projectRoot, JOBS_DIR);
}
function jobPath(projectRoot: string, id: string): string {
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_"); // plan-state.ts:14
  return join(jobsDir(projectRoot), `${safeId}.json`);
}
```
**add — write template (from plan-state.ts:22-38):**
```typescript
export async function addJob(projectRoot: string, job: ResearchJob): Promise<void> {
  await ensureDir(jobsDir(projectRoot));                 // helpers.ts:6
  const validation = ResearchJobSchema.safeParse(job);
  if (!validation.success) {
    const issues = validation.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid research job:\n${issues}`);
  }
  await writeFile(jobPath(projectRoot, job.id),
    JSON.stringify(validation.data, null, 2) + "\n", "utf-8");
}
```
**list — readdir + safeParse-skip template (from plan-state.ts:106-140):**
```typescript
export async function listJobs(projectRoot: string): Promise<ResearchJob[]> {
  let entries: string[];
  try { entries = await readdir(jobsDir(projectRoot)); }
  catch { return []; }                                   // dir absent → []
  const jobs: ResearchJob[] = [];
  for (const file of entries.filter((f) => f.endsWith(".json")).sort()) {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(jobsDir(projectRoot), file), "utf-8"));
      const r = ResearchJobSchema.safeParse(parsed);
      if (r.success) jobs.push(r.data);                  // skip malformed
    } catch { /* skip */ }
  }
  return jobs;
}
```
**remove — unlink (from approval-state.ts:138-140):**
```typescript
export async function removeJob(projectRoot: string, id: string): Promise<boolean> {
  try { await unlink(jobPath(projectRoot, id)); return true; }
  catch { return false; }
}
```
**Deterministic id (CLI passes a pre-built job, store never invents one).** Clock + id are stamped at
the CLI boundary, NOT in the store (generatorNotes: "never read the clock for ids beyond a passed-in
timestamp"). Build the id from a slug + the injected `createdAt` string, mirroring the no-wall-clock
hashing in `src/state/facts.ts:53-69` (`createHash("sha256").update(...).digest("hex").slice(0,16)`).

---

### src/cli/commands/research.ts (create)

**Most similar existing file:** `src/cli/commands/task.ts:333-453` (a `registerXCommand` that adds a
parent `program.command("task")` then child `.command("add"/"list"/...)` with DI cores) and
`src/cli/commands/medical.ts:229-297` (the `program.command("medical")` → `.command("whoop")` →
`.command("sync")` nesting the contract cites). The required shape is `research` → `job` → `add|list|remove`.
**Structure template (DI core + thin .action — task.ts pattern):**
```typescript
import { join } from "node:path";          // only if you build paths here
import chalk from "chalk";
import type { Command } from "commander";
import { findProjectRoot } from "../../utils/fs.js";
import { addJob, listJobs, removeJob } from "../../research/job-store.js";
import { ResearchJobSchema, type ResearchJob } from "../../research/types.js";

async function resolveRoot(): Promise<string> {       // medical.ts:36-39 / task.ts:44-47
  const root = await findProjectRoot();
  return root ?? process.cwd();
}

export function registerResearchCommand(program: Command): void {
  const researchCmd = program
    .command("research")
    .description("Recurring multi-model research jobs");
  const jobCmd = researchCmd
    .command("job")
    .description("Define recurring research jobs (JSON store under .bober/research/jobs)");

  jobCmd
    .command("add")
    .description("Add a recurring research job")
    .requiredOption("--question <q>", "the research question")
    .option("--cadence <c>", "daily|weekly|monthly", "weekly")
    .option("--tier <t>", "difficulty tier")
    .option("--domain <d>", "domain tag")
    .option("--target-repo <r>", "repo to research against")
    .option("--online-research", "enable online research (stored only; no egress yet)")
    .action(async (opts: { question: string; cadence?: string; /* ... */ }) => {
      const projectRoot = await resolveRoot();
      try {
        const now = new Date().toISOString();          // clock ONLY here (task.ts:352)
        const id = /* slug(opts.question) + timestamp, hash per facts.ts:58-69 */;
        const job: ResearchJob = ResearchJobSchema.parse({
          id, question: opts.question, cadence: opts.cadence ?? "weekly",
          onlineResearch: opts.onlineResearch ?? false, createdAt: now, /* ...optionals */
        });
        await addJob(projectRoot, job);
        process.stdout.write(chalk.green(`Added research job ${chalk.bold(job.id)}\n`));
      } catch (err) {
        process.stderr.write(chalk.red(`research job add failed: ${err instanceof Error ? err.message : String(err)}\n`));
        process.exitCode = 1;                           // MUST NOT throw — task.ts:360-367
      }
    });
  // ── job list / job remove <jobId> follow the same try/catch + exitCode=1 shape ──
}
```
**Rule:** CLI handlers MUST NOT throw — catch, write chalk to stderr, set `process.exitCode = 1`,
return (task.ts:360-367, medical.ts:262-270). Read the wall clock ONLY at the `.action` boundary,
never inside the store (task.ts:352 comment "Stamp wall-clock time at handler boundary").

---

### src/cli/index.ts (modify)

**Relevant section — imports block (lines 36-46):** add the new import next to `registerMedicalCommand`:
```typescript
import { registerMedicalCommand } from "./commands/medical.js";   // line 41 (existing)
// ADD:
import { registerResearchCommand } from "./commands/research.js";
```
**Relevant section — registration block in main() (lines 326-348):** add the call next to the others:
```typescript
  // ── medical ───────────────────────────────────────────────────────
  registerMedicalCommand(program);   // line 327 (existing)
  // ADD (e.g. after registerMedicalCommand or near registerTaskCommand at 324):
  registerResearchCommand(program);
```
**Imported by:** this is the CLI entrypoint (`#!/usr/bin/env node`, line 1) — nothing imports it; it
is invoked as the binary. Adding one import + one call is byte-additive (sc-1-4).
**Test file:** none for `index.ts` itself (it only wires registrars). The CLI behavior is tested via
`src/cli/commands/research.test.ts`.

---

## 2. Patterns to Follow

### A. Zod schema module (`z.object` → `z.infer` export)
**Source:** `src/state/facts.ts`, lines 18-33 (and `src/calendar/types.ts:12-29`)
```typescript
/** ...the store never reads the clock. */
export const FactSchema = z.object({
  scope: z.string(),
  subject: z.string().min(1),
  ...
});
export type FactInput = z.infer<typeof FactSchema>;
```
**Rule:** Export both the schema constant and a `z.infer` type alias from the same module. Use
`.min(1)` for required non-empty strings; `.default(false)` for the optional boolean.

### B. JSON-file-per-id store (validate → writeFile; readdir → safeParse-skip)
**Source:** `src/state/plan-state.ts`, lines 22-38 (save) and 106-140 (list)
```typescript
export async function saveSpec(projectRoot, spec) {
  await ensureDir(specsDir(projectRoot));
  const validation = PlanSpecSchema.safeParse(spec);
  if (!validation.success) { /* throw formatted issues */ }
  await writeFile(specPath(projectRoot, spec.specId), JSON.stringify(spec, null, 2), "utf-8");
}
```
**Rule:** `ensureDir` before every write; `safeParse` before persisting; on list, swallow a missing
dir (`catch { return []; }`) and skip malformed files. This is the exact contract for round-trip (sc-1-2).

### C. Path + slug helper
**Source:** `src/state/plan-state.ts`, lines 13-16 (and `src/state/research-state.ts:11-14`)
```typescript
function specPath(projectRoot: string, id: string): string {
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(specsDir(projectRoot), `${safeId}.json`);
}
```
**Rule:** Sanitize ids into safe filenames with `replace(/[^a-zA-Z0-9_-]/g, "_")` before joining.

### D. Commander subcommand tree (`registerXCommand`)
**Source:** `src/cli/commands/medical.ts`, lines 229-297; `src/cli/commands/task.ts`, lines 335-368
```typescript
export function registerMedicalCommand(program: Command): void {
  const medicalCmd = program.command("medical").description("...");
  const whoopCmd = medicalCmd.command("whoop").description("...");
  whoopCmd.command("sync").option("--since <iso>", "...").action(async (opts) => { ... });
}
```
**Rule:** Build the tree `program.command("research")` → `.command("job")` → `.command("add"|"list"|"remove")`.
Export a single `registerResearchCommand(program: Command): void`.

### E. CLI handler never throws + clock at boundary
**Source:** `src/cli/commands/task.ts`, lines 345-368
```typescript
.action(async (text, opts) => {
  const projectRoot = await resolveRoot();
  try {
    const now = new Date().toISOString();   // clock ONLY at the handler boundary
    ...
  } catch (err) {
    process.stderr.write(chalk.red(`... ${err instanceof Error ? err.message : String(err)}\n`));
    process.exitCode = 1;                    // set exitCode, do NOT rethrow
  }
});
```
**Rule:** Wrap every action body in try/catch → `process.exitCode = 1` (NEVER `process.exit()` /
NEVER `throw`). Read `new Date().toISOString()` only here; pass it down to the store.

### F. CLI registrar wiring in index.ts
**Source:** `src/cli/index.ts`, line 41 (import) and line 327 (call)
```typescript
import { registerMedicalCommand } from "./commands/medical.js";   // L41
...
registerMedicalCommand(program);                                  // L327
```
**Rule:** One import in the top block + one `registerXCommand(program)` call inside `main()`.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `ensureDir` | `src/state/helpers.ts:6` | `(dirPath: string): Promise<void>` | mkdir recursive. **Contract says use THIS one** for the store. |
| `ensureDir` (dup) | `src/utils/fs.ts:45` | `(path: string): Promise<void>` | Same behavior; CLI files (medical.ts:11) import it from utils/fs. Pick the helpers one in the store per generatorNotes. |
| `findProjectRoot` | `src/utils/fs.ts:58` | `(startDir?: string): Promise<string \| null>` | Walks up for bober.config.json/package.json. Use in `resolveRoot()`. |
| `writeJson` | `src/utils/fs.ts:34` | `(path: string, data: unknown): Promise<void>` | Pretty JSON + auto-ensureDir. Available, but state stores use raw `writeFile` + `safeParse`-first (plan-state.ts:37) — prefer the validate-then-write form so an invalid job never hits disk. |
| `readJson` | `src/utils/fs.ts:24` | `<T>(path: string): Promise<T>` | Reads+parses JSON (no validation). State stores parse + `safeParse` manually instead. |
| `fileExists` | `src/utils/fs.ts:10` | `(path: string): Promise<boolean>` | Existence check (used by findProjectRoot). |
| `factId` | `src/state/facts.ts:58` | `(scope, subject, predicate, value, tCreated): string` | 16-char sha256 slice; clock-free id derivation **reference** for building the jobId. |
| `chalk` | npm (e.g. `medical.ts:8`) | `chalk.green/red/yellow/bold(str)` | Terminal coloring for CLI output. |

Node `fs/promises` primitives used directly by the store: `writeFile`, `readFile`, `readdir`, `unlink`
(see imports at `plan-state.ts:1` and `approval-state.ts:1`). Use `node:fs/promises` — NO sync fs (principles L42).

Directories reviewed: `src/utils/`, `src/state/` (helpers + stores). No existing job/cadence
utility exists — `src/research/` is new (verified: directory absent).

---

## 4. Prior Sprint Output

No prior sprints for this spec (`dependsOn: []`). Sibling specs on this branch are NOT dependencies but
establish the conventions reused above:
- **priority-hub** → `src/hub/finding-store.ts` (DI-core + clock-at-boundary). Do NOT route research
  jobs through the hub/FactStore — non-goal L40 says jobs are plain JSON files.
- **task-inbox** → `src/cli/commands/task.ts` is the closest CLI template (DI cores + register tree).
- **calendar-planner** → `src/calendar/types.ts` is the closest `types.ts` schema-module template.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
Hard gates that apply to every file in this sprint:
- **ESM `.js` import extensions** for NodeNext (L27). Every relative import ends in `.js`
  (e.g. `../../research/job-store.js`).
- **`import type { ... }`** — `consistent-type-imports` is enforced (L35). Import `Command`, `ResearchJob`
  as types: `import type { Command } from "commander";`.
- **Zod for validation** (L29) — no hand-rolled validation; use `ResearchJobSchema.safeParse`/`.parse`.
- **No synchronous fs** (L42) — `node:fs/promises` only.
- **Filesystem state as JSON under `.bober/`** (L31) — exactly what this store does.
- **Section comments** `// ── Name ──────` box headers (L32) — used throughout the cited files.
- **Tests collocated** `*.test.ts` next to source (L20).
- **Unused params** prefix with `_` (L36); strict-mode flags incl. `noUnusedLocals` (L18).

### Architecture Decisions
No ADR file specific to research-scheduler found under `.bober/architecture/`. The contract's own
`assumptions`/`outOfScope` (L47-57) are the governing decisions: jobs are JSON files (not FactStore/
config), no egress axis, no cadence math this sprint.

### Other Docs
No `CONTRIBUTING.md` guidance beyond principles.md applies here.

---

## 6. Testing Patterns

### Unit Test Pattern — JSON store (temp projectRoot)
**Source:** `src/state/approval-state.test.ts:1-66`
```typescript
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { addJob, listJobs, removeJob } from "./job-store.js";
import { ResearchJobSchema } from "./types.js";

let tmpRoot: string;
beforeEach(async () => { tmpRoot = await mkdtemp(join(tmpdir(), "bober-research-job-")); });
afterEach(async () => { await rm(tmpRoot, { recursive: true, force: true }); });

it("sc-1-2: add persists JSON that round-trips and list returns it", async () => {
  const job = ResearchJobSchema.parse({ id: "j1", question: "q?", cadence: "weekly",
    onlineResearch: false, createdAt: "2026-06-29T00:00:00.000Z" });
  await addJob(tmpRoot, job);
  const got = await listJobs(tmpRoot);
  expect(got).toHaveLength(1);
  expect(ResearchJobSchema.parse(got[0])).toEqual(job);   // round-trip
});

it("sc-1-1: empty question fails Zod parse", () => {
  expect(ResearchJobSchema.safeParse({ id: "x", question: "", cadence: "weekly",
    createdAt: "2026-06-29T00:00:00.000Z" }).success).toBe(false);
});
```
**Runner:** vitest. **Assertion style:** `expect(...)`. **Mock approach:** none — real temp dir
(principles L44: "No test mocks for filesystem"). **File naming:** `*.test.ts`. **Location:** collocated.

### Unit Test Pattern — CLI add→list→remove (spy stdout/exitCode)
**Source:** `src/cli/commands/task.test.ts:17-86` (exitCode + stdout-spy) and
`src/cli/commands/medical.test.ts:50-66` (mkdtemp temp projectRoot + exitCode reset)
```typescript
const originalExitCode = process.exitCode;
beforeEach(() => { process.exitCode = 0; });
afterEach(() => { vi.restoreAllMocks(); process.exitCode = originalExitCode as number | undefined; });

it("captures stdout", async () => {
  const writes: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((c) => { writes.push(String(c)); return true; });
  // ...drive the action / DI core, then:
  expect(writes.join("")).toMatch(/Added research job/);
  expect(process.exitCode).toBe(0);
});
```
**How to exercise the CLI (sc-1-3):** the cleanest path is to build a `new Command()`, call
`registerResearchCommand(program)`, then `await program.parseAsync(["node","bober","research","job","add",
"--question","q","--cadence","weekly"], { from: "node" })` inside a temp cwd — OR (simpler, matches the
medical.test.ts DI ethos) export the small action bodies / call `addJob`/`listJobs`/`removeJob`
directly with a temp `projectRoot` and assert the printed id/question/cadence and that remove deletes
the file. Spy on `process.stdout.write` to capture the printed id+question+cadence; assert `listJobs`
omits the id after `removeJob`. Reset `process.exitCode` in before/after (task.test.ts:17-26).
**No real network/clock** — pass a fixed `createdAt` ISO string.

### E2E Test Pattern
Not applicable — agent-bober is a CLI/library, no Playwright (principles L48).

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/cli/index.ts` | new `./commands/research.js` import + call | low | One additive import (L36-46 block) + one `registerResearchCommand(program)` call (L326-348). A typo in the import path breaks the whole CLI build (sc-1-4). |
| (nothing) | `src/research/*` | n/a | Brand-new module — nothing imports it yet (Sprint 2 will). No existing file depends on it. |

`src/state/research-state.ts` is **NOT** affected and **MUST NOT** be edited — see Pitfalls.

### Existing Tests That Must Still Pass
- `src/cli/commands/medical.test.ts`, `src/cli/commands/task.test.ts`, `src/cli/commands/calendar.test.ts`,
  etc. — they construct their own `Command` and registrar; adding `registerResearchCommand` to
  `index.ts` does not touch them, but the **full build** (`tsc`) must stay green (sc-1-4). Run the
  whole suite after wiring.
- `src/state/approval-state.test.ts` / `src/state/run-state.test.ts` — the JSON-store patterns you
  copy from; unaffected, but confirm your new store test follows the same temp-dir lifecycle so it
  doesn't leak temp dirs into a shared run.
- No test currently imports `src/cli/index.ts`, so the index edit has no direct test dependents — its
  only gate is `npm run build`.

### Features That Could Be Affected
- **research markdown docs** (researcher agent → `.bober/research/*.md` via `src/state/research-state.ts`).
  Shares the `.bober/research/` *directory* but a DIFFERENT subtree (`*.md` files vs your new
  `jobs/*.json`). Verify your `JOBS_DIR = ".bober/research/jobs"` so the two never collide and
  `listJobs` only globs `*.json` under `jobs/` (your `.endsWith(".json")` filter already protects this).

### Recommended Regression Checks
After implementation, the Generator MUST verify:
1. `npm run build` — clean `tsc` (sc-1-4 / stopConditions).
2. `npx vitest run src/research src/cli/commands/research.test.ts` — new schema/store/CLI tests pass.
3. `npx vitest run` — full suite still green (no regression from the index.ts edit).
4. `npm run lint` (or the eslint task) — `consistent-type-imports`, no unused vars, `.js` extensions.
5. Manual sanity: `node dist/cli/index.js research job add --question "x" --cadence weekly` then
   `... research job list` shows the id/question/cadence, then `... research job remove <id>` and a
   re-`list` omits it (sc-1-3).

---

## 8. Implementation Sequence

1. **src/research/types.ts** — `ResearchJobSchema` (+`CadenceSchema`) and `z.infer` type exports.
   - Verify: `ResearchJobSchema.safeParse({question:""}).success === false` (sc-1-1).
2. **src/research/job-store.ts** — `addJob`/`listJobs`/`removeJob` (+`readJob` optional) over
   `.bober/research/jobs/`, importing `ensureDir` from `../state/helpers.js` and the schema from
   `./types.js`. Clock-free.
   - Verify: a write then `listJobs` round-trips through `ResearchJobSchema` (sc-1-2).
3. **src/research/job-store.test.ts** — temp-projectRoot round-trip + empty-question reject + remove.
   - Verify: `npx vitest run src/research/job-store.test.ts` green.
4. **src/cli/commands/research.ts** — `registerResearchCommand(program)` with `research job add|list|remove`;
   stamp `now`/id at the action boundary, never throw → `process.exitCode = 1`.
   - Verify: actions call the store with a temp/real projectRoot; no `process.exit()`.
5. **src/cli/commands/research.test.ts** — drive add→list→remove, spy stdout, assert id/question/cadence
   printed and post-remove list omits it (sc-1-3).
   - Verify: `npx vitest run src/cli/commands/research.test.ts` green; `process.exitCode` reset in hooks.
6. **src/cli/index.ts** — add the import (next to L41) and the `registerResearchCommand(program)` call
   (next to L327).
   - Verify: `npm run build` clean (sc-1-4).
7. **Run full verification** — `npm run build`, `npx vitest run`, lint.

---

## 9. Pitfalls & Warnings

- **DO NOT touch `src/state/research-state.ts`.** It already owns `.bober/research/*.md` (researcher
  agent output) and is unrelated to research *jobs*. Your new module is `src/research/` and your data
  lives in the `jobs/` SUBDIR (`.bober/research/jobs/*.json`). Confusing the two is the #1 risk here.
- **Jobs are JSON files, not FactStore/SQLite and not bober.config.json** (non-goals L40). Do NOT
  reuse `FactStore`/`writeFinding` — that is the hub pattern, wrong for this sprint.
- **No egress / no cadence math / no execution** this sprint (non-goals L37-39, outOfScope L53-56).
  `onlineResearch` is just a stored boolean (default false); do NOT add an egress axis or compute a
  next-due date.
- **`.js` import extensions are mandatory** (NodeNext). `import { addJob } from "../../research/job-store.js"`
  — omitting `.js` compiles in your editor but fails the real build.
- **`import type` for type-only symbols** (`Command`, `ResearchJob`) or eslint `consistent-type-imports`
  errors (hard gate).
- **CLI handlers must NEVER `throw` or call `process.exit()`** — set `process.exitCode = 1` and return
  (task.ts:360-367). Tests reset `process.exitCode` in before/after hooks (task.test.ts:17-26); follow
  that or you leak a non-zero exit code into sibling tests.
- **`listJobs` must tolerate a missing dir** — wrap `readdir` in `try/catch { return []; }`
  (plan-state.ts:111-117); the first `list` before any `add` must return `[]`, not throw.
- **Two `ensureDir`s exist** (`state/helpers.ts:6` and `utils/fs.ts:45`). The contract directs the
  store to use the `state/helpers.ts` one; CLI files conventionally import from `utils/fs.ts`. Either
  is correct behaviorally — just be consistent and don't define a third.
- **`writeJson` (utils/fs.ts:34) skips Zod validation.** Prefer the plan-state.ts shape
  (`safeParse` THEN `writeFile`) so an invalid job never reaches disk and the round-trip guarantee
  (sc-1-2) holds.
