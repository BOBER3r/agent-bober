# Deterministic slot-fill engine + dry-run plan CLI

**Contract:** sprint-spec-20260628-calendar-planner-1  ·  **Spec:** spec-20260628-calendar-planner  ·  **Completed:** 2026-06-29

## What this sprint added

Sprint 1 lays the **heart of the calendar planner** — a pure, synchronous, LLM-free slot-fill engine
in a new `src/calendar/` module, plus a **read-only** `bober calendar plan --dry-run` command that
prints a proposed schedule and **writes nothing to any calendar**. Given a pre-ranked `Finding[]` (the
priority order produced upstream by the hub) and a free/busy model, `planSlots` derives free intervals
from a window minus busy intervals, then places each finding **in input order** into the earliest free
slot that fits its `estDurationMin` before its `dueBy`, emitting `scheduled` items plus an `unscheduled`
list with a per-item reason. Placement is entirely deterministic synchronous TypeScript — **no LLM, no
async, no fs, no network inside the algorithm** — so identical input yields deep-equal output, mirroring
the medical `NumericsQueryLayer` purity boundary. The connectors (.ics export, Google Calendar MCP) and
the approval gate are explicit non-goals owned by Sprints 2–4.

## Public surface

- `planSlots(findings, busy, constraints)` (`src/calendar/slotter.ts:169`) — the pure synchronous core.
  Returns a `ProposedPlan`. Processes findings in **input order** (index 0 = highest priority — the LLM
  never packs slots), places each into the earliest fitting free interval before `dueBy`, splits the
  consumed interval in-place, and pushes non-placed findings to `unscheduled` with an exhaustive-switch
  reason. Defaults missing `estDurationMin` to 30 min; treats missing `dueBy` as no deadline. Title is
  `finding.calendarSafeTitle ?? finding.title`. No `await`/`async`/`node:fs`/provider import.
- `ProposedPlan` (`src/calendar/types.ts:87`) — `{ scheduled: PlanItem[]; unscheduled: { findingId, reason }[] }`.
- `PlanItem` (`src/calendar/types.ts:69`) — `{ findingId, title, startIso, endIso }`, a placed slot.
- `UnscheduledReason` (`src/calendar/types.ts:84`) — closed string-literal union
  `"does-not-fit" | "no-free-slot-before-dueBy"`. Adding a variant forces a compile error in the
  exhaustive `never`-guarded switch in `slotter.ts` (`labelUnscheduledReason`).
- `SlotConstraints` (`src/calendar/types.ts:57`) — window bounds `{ windowStartIso, windowEndIso }` plus
  optional `workingHours` (UTC-hour clamp) and informational `timezone`.
- `BusyInterval` / `FreeInterval` (`src/calendar/types.ts:37`, `:43`) — `{ startIso, endIso }` ISO pairs.
- `WorkingHours` (`src/calendar/types.ts:49`) — `{ startHour, endHour }` UTC-hour daily clamp.
- `Finding` type + `FindingSchema` (`src/calendar/types.ts:29`, `:12`) — a **local** consume-copy whose
  field names mirror `src/hub/finding.ts` exactly (`id`/`domain`/`title`/`kind`/`urgency`/`severity`/
  `evidence`/`surfacedAt`/`dueBy?`/`tags`/`estDurationMin?`/`calendarSafeTitle?`/`status`/`promotesTo?`).
  Deliberately **not** imported from `src/hub` — see Notes. `FindingArraySchema` (`:32`) is the ordered
  ranked-input array schema.
- `readFindingsFromFile(path)` (`src/calendar/finding-source.ts:28`) — reads a ranked `Finding[]` JSON
  file (order preserved), Zod-validated, fail-closed (throws on I/O or validation error).
- `readBusyIntervalsFromFile(path)` (`src/calendar/finding-source.ts:39`) — reads a `BusyInterval[]` JSON
  file with the same fail-closed policy.
- `runCalendarPlan(projectRoot, opts, deps?)` (`src/cli/commands/calendar.ts:50`) — the extracted DI core
  for the command. Reads findings (required `--findings`) and free/busy (optional `--freebusy`, defaults
  to `[]`), builds a 7-day window from `nowIso` **read only at the CLI boundary**, runs `planSlots`, and
  prints the plan to **stdout only**. Never throws — every failure branch sets `process.exitCode = 1`.
- `CalendarPlanDeps` (`src/cli/commands/calendar.ts:25`) — injectable `{ readFindings?, readFreeBusy?, nowIso? }`
  so tests use fixtures and a fixed clock; production passes none.
- `bober calendar plan` (`registerCalendarCommand`, `src/cli/commands/calendar.ts:126`) — the CLI command
  with `--dry-run`, `--findings <path>`, `--freebusy <path>`; registered in `src/cli/index.ts:330` next to
  `registerMedicalCommand`.

## How to use / how it fits

```bash
bober calendar plan --dry-run --findings ./ranked-findings.json --freebusy ./freebusy.json
```

prints:

```text
Proposed calendar plan
Window: 2026-06-29T00:00:00.000Z → 2026-07-06T00:00:00.000Z

Scheduled (2):
  [2026-06-29T00:00:00.000Z → 2026-06-29T00:30:00.000Z]  Renew prescription
  [2026-06-29T00:30:00.000Z → 2026-06-29T01:30:00.000Z]  Book dentist

Unscheduled (1):
  f-90  reason: does-not-fit

(dry-run — nothing written to any calendar)
```

The `--findings` file is a ranked `Finding[]` (the same shape the hub emits, index 0 = highest
priority); `--freebusy` is a `BusyInterval[]` (omit it to plan against a fully-open window). This sprint
only **reads** files and **prints** — it does not read a live calendar (Sprint 3) and writes no events or
.ics output (Sprints 2–4). Fixtures shipped under `src/calendar/__fixtures__/` (`findings.json` =
3 findings at 30/60/90 min; `freebusy.json` = `[]`).

## Notes for maintainers

- **Local Finding copy is intentional.** `src/calendar/types.ts` re-declares the `Finding` shape rather
  than importing `src/hub/finding.ts`, because the priority-hub is a sibling spec the planner avoids a
  compile-time coupling to. The field names are kept **identical** to the hub schema. If the canonical
  hub schema changes, update this copy in lockstep.
- **Purity is the contract (do not break it).** `slotter.ts` must stay free of `await`/`async`/`node:fs`/
  network/provider/LLM imports — `slotter.test.ts` source-scans the file and asserts this. Time math uses
  `Date.parse(iso)` → epoch-ms arithmetic and `new Date(ms).toISOString()` back, both pure. The clock is
  read **only** at the CLI boundary (`runCalendarPlan`), never in the engine.
- **`workingHours` clamping is single-day-aware but coarse.** `clampToWorkingHours` iterates day-by-day in
  UTC; the in-code note flags a per-day-iterator upgrade path if multi-day windows become common. No
  caller passes `workingHours` yet (Sprint 1 introduces the type but the CLI does not set it).
- **Unscheduled reasons are a closed set.** Adding a third reason requires extending `UnscheduledReason`
  **and** the exhaustive switch in `labelUnscheduledReason` (the `never` guard makes the compiler enforce
  it). The current two reasons distinguish "a slot exists before the deadline but is too small"
  (`does-not-fit`) from "free slots exist but all start at/after `dueBy`" (`no-free-slot-before-dueBy`).
- **Dry-run writes nothing.** `--dry-run` prints only; there are no connectors in this sprint, so the
  command cannot write to a calendar regardless. The empty `freebusy.json` fixture makes the documented
  CLI stop-condition succeed at any wall-clock time.

## Scope

Commit `0d141c1`: 10 files changed, **+1063 / -0**. New module `src/calendar/` (`types.ts`, `slotter.ts`,
`finding-source.ts` + collocated tests, plus `__fixtures__/findings.json` and `__fixtures__/freebusy.json`)
and `src/cli/commands/calendar.ts`, wired via a 4-line additive edit to `src/cli/index.ts`. **28 new
calendar tests** (3 files); build + typecheck + lint clean, full suite **3428** green, zero regressions.
All six required criteria (`sc-1-1..sc-1-6`) passed on iteration 1; eval
`eval-sprint-spec-20260628-calendar-planner-1-1` → **pass** (6/6 required).

> **Plan status:** Sprint 1 of 4 of `spec-20260628-calendar-planner` (*Calendar planner: deterministic
> slotter + Google MCP/.ics + approve-gate*). The .ics export, the Google Calendar MCP adapter, the live
> free/busy read, and the approve-gated write are owned by Sprints 2–4. User-facing CLI usage for
> `bober calendar plan --dry-run` lives in [`COMMANDS.md`](../../COMMANDS.md) under **Calendar Commands**
> and the README CLI list.
