# Research job schema, JSON store, and `bober research job` CLI

**Contract:** sprint-spec-20260628-research-scheduler-1  ·  **Spec:** spec-20260628-research-scheduler  ·  **Completed:** 2026-06-29

## What this sprint added

Sprint 1 — the opening sprint of the **research-scheduler** plan (1 of 5) — lays the
**definition layer** for recurring multi-model research jobs. It adds a new `src/research/`
module with a `ResearchJob` Zod schema (`src/research/types.ts`), a **clock-free, async-only**
JSON file store under `.bober/research/jobs/<jobId>.json` (`src/research/job-store.ts`), and a
`bober research job add|list|remove` CLI (`src/cli/commands/research.ts`) registered alongside the
existing top-level commands. The end-to-end ability to **define, list, and remove** recurring
research jobs now exists — but **no execution, model querying, scheduling, egress, or digest
output** does yet (those are Sprints 2–5). A job is just a validated JSON file on disk.

## Public surface

- **`bober research job add --question "..." [--cadence daily|weekly|monthly] [--tier <t>] [--domain <d>] [--target-repo <r>] [--online-research]`**
  (`src/cli/commands/research.ts:46`) — validate the inputs through `ResearchJobSchema` and persist
  one job as JSON. `--question` is **required** (non-empty); `--cadence` defaults to `weekly`;
  `--online-research` stores `onlineResearch=true` but **does not** enable any network call (the
  online-research egress axis is Sprint 3). Prints the new `jobId`, question, and cadence. Never
  throws — on a validation/IO error it writes to stderr and sets `process.exitCode = 1`.
- **`bober research job list`** (`src/cli/commands/research.ts:100`) — print every persisted job as
  `<jobId>  <cadence>  <question>  [<domain>]`. Prints `No research jobs defined.` when the store is
  empty.
- **`bober research job remove <jobId>`** (`src/cli/commands/research.ts:130`) — delete the job's
  JSON file. Prints a confirmation when removed; a not-found id prints a yellow message and sets
  `process.exitCode = 1`.
- `registerResearchCommand(program)` (`src/cli/commands/research.ts:34`) — registers the `research`
  command tree; wired into the root program at `src/cli/index.ts:42` (import) and `:331` (call),
  between `registerMedicalCommand` and `registerCalendarCommand`.
- `ResearchJobSchema` / `ResearchJob` (`src/research/types.ts:33`/`:56`) — the validated job shape:
  `id`, non-empty `question`, `cadence`, optional `tier` / `modelSet` / `targetRepo` / `domain`,
  `onlineResearch` (boolean, **default false**), and ISO-8601 `createdAt`. An empty `question` is
  rejected with a Zod error (`sc-1-1`).
- `CadenceSchema` / `Cadence` (`src/research/types.ts:14`/`:15`) — the **closed string enum**
  `"daily" | "weekly" | "monthly"`. The cadence representation is deliberately a closed enum (not a
  free-form cron string); next-due computation is **not** done here (it is Sprint 4).
- `jobId(question, createdAt)` (`src/research/job-store.ts:28`) — derives a deterministic 16-char
  hex id as `sha256(`​`question|createdAt`​`).slice(0,16)`. The store **never reads the clock**; the
  CLI stamps `createdAt = new Date().toISOString()` once at the `.action()` boundary and passes it in.
- `addJob(projectRoot, job)` (`src/research/job-store.ts:42`) — `safeParse`-before-write so an
  invalid job never reaches disk; writes `.bober/research/jobs/<safeId>.json`.
- `listJobs(projectRoot)` (`src/research/job-store.ts:68`) — read all jobs sorted by filename;
  returns `[]` if the directory is absent; **silently skips** malformed/invalid files.
- `readJob(projectRoot, id)` (`src/research/job-store.ts:100`) — read a single job, or `null` if
  missing/malformed.
- `removeJob(projectRoot, id)` (`src/research/job-store.ts:119`) — delete a job's file; returns
  `true` if deleted, `false` if not found.

## How to use / how it fits

```bash
$ bober research job add --question "What changed in the GLP-1 literature this week?" --cadence weekly --domain medical
Added research job 3f8a1c0b9d2e4f76
  question: What changed in the GLP-1 literature this week?
  cadence:  weekly

$ bober research job list
3f8a1c0b9d2e4f76  weekly  What changed in the GLP-1 literature this week?  [medical]

$ bober research job remove 3f8a1c0b9d2e4f76
Removed research job 3f8a1c0b9d2e4f76
```

Jobs are stored as JSON files under `.bober/research/jobs/` — **not** in `bober.config.json` and
**not** in the FactStore SQLite db. Each file round-trips through `ResearchJobSchema`. This module is
the **definition surface** the later sprints build on: a scheduler will read these jobs, compute
next-due dates from `cadence`, run them across a model set / `tier`, gate any online retrieval behind
`onlineResearch`, and write the results into the priority hub.

## Notes for maintainers

- **Clock discipline.** The store is clock-free by design (no `new Date()` / `Date.now()` anywhere in
  `job-store.ts`). The CLI is the only place wall-clock time is read (`.action()` boundary). Keep it
  that way — deterministic ids depend on the caller supplying `createdAt`.
- **`tier` vs `modelSet`.** Both are optional and stored verbatim; neither is interpreted yet. The
  executor (Sprint 2) resolves which to use at runtime.
- **`onlineResearch` is inert here.** The flag is persisted for forward-compatibility, but Sprint 1
  makes **no** network call. Egress is gated and activated in Sprint 3.
- **Filename safety.** `jobPath` sanitizes the id (`[^a-zA-Z0-9_-]` → `_`) before building the path;
  the deterministic hex `jobId` is already filesystem-safe, so this only matters if a non-derived id
  is ever passed.
- **Deferred to later sprints:** job execution / model querying / note output (Sprint 2), the
  online-research egress axis (Sprint 3), cadence due-date computation + the tick runner (Sprint 4),
  and digest output (Sprint 5).

Commit: `0336e47` — *bober(sprint-1): research job schema, JSON store, and CLI add/list/remove*
(6 files, +739; suite **3519** green; all 4 required criteria passed iteration 1).
