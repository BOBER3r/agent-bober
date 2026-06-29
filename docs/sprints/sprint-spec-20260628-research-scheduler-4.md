# Recurring scheduler: cadence due-dates + idempotent `bober research tick`

**Contract:** sprint-spec-20260628-research-scheduler-4  ·  **Spec:** spec-20260628-research-scheduler  ·  **Completed:** 2026-06-30

## What this sprint added

Sprint 4 — the **scheduler layer** of the **research-scheduler** plan (4 of 5) — turns the
on-demand Sprint 2 runner into a **recurring** one. It adds deterministic, clock-free cadence
math (`computeNextDue`) and an **idempotent** `tick(deps)` that selects every job that is due as
of an injected `now`, runs it via the **unchanged** Sprint 2 `runResearchJob`, then advances the
job's `nextDueAt` and records its `lastRunAt` and persists the result. A new
`bober research tick [--watch] [--interval <ms>]` CLI drives this — stamping the wall clock **only**
at the `.action()` boundary — and its help text documents the scheduling-mechanism tradeoff (in-repo
`--watch` loop vs OS cron/launchd vs harness scheduler). Because each run advances `nextDueAt` to a
strictly future instant, a second `tick` at the same `now` runs **zero** jobs.

## Public surface

- `computeNextDue(cadence, fromIso): string` (`src/research/cadence.ts:36`) — **pure, clock-free**
  next-due ISO-8601 timestamp from an injected base instant. Cadence mapping: `daily` → `+1` UTC day
  (`setUTCDate +1`), `weekly` → `+7` UTC days, `monthly` → `+1` UTC month (`setUTCMonth +1`).
  Exhaustive `switch` with a compile-time `never` guard. Parses the **injected** string
  (`new Date(Date.parse(fromIso))`) — no argless `new Date()` / `Date.now()`.
- `tick(deps: TickDeps): Promise<TickResult>` (`src/research/scheduler.ts:69`) — the idempotent
  scheduler. Lists all jobs, selects those that are due (`nextDueAt` unset **or**
  `Date.parse(nextDueAt) <= Date.parse(now)` — boundary-inclusive), runs each via `runJob`, then sets
  `lastRunAt = now` and `nextDueAt = computeNextDue(cadence, now)` and persists via `saveJob`. Runs
  **first**, advances/persists **after** — if `runJob` throws, the job is not persisted and stays due.
- `TickDeps` (`src/research/scheduler.ts:26`) — injected I/O + clock: `{ now: string,
  listJobs: () => Promise<ResearchJob[]>, saveJob: (job) => Promise<void>,
  runJob: (job) => Promise<void> }`. All I/O and the clock are injected so tests bypass real
  providers/SQLite (mirrors `RunDeps`).
- `TickResult` (`src/research/scheduler.ts:47`) — `{ ran: string[], skipped: string[] }` (job ids
  that ran vs were skipped as not-yet-due).
- `ResearchJobSchema.nextDueAt` / `ResearchJobSchema.lastRunAt` (`src/research/types.ts:58`/`:60`) —
  two new **optional** `z.string().datetime()` fields. `nextDueAt` unset ⇒ due immediately on first
  tick; `lastRunAt` unset until the first run. The deterministic `jobId` still hashes only
  `question|createdAt`, so the id is **stable** when the scheduler writes these fields back.
- `bober research tick [--watch] [--interval <ms>]` (`src/cli/commands/research.ts:280`) — run every
  due job once (idempotent). `--watch` runs `tick` on an in-process `setInterval` loop (default
  interval `3600000` ms = 1 hour, clamped to a `1000` ms floor); without `--watch` it runs exactly
  once and exits. Prints `research tick: ran N job(s): <ids>` or `research tick: no jobs due.`; never
  throws (errors ⇒ stderr + `process.exitCode = 1`).

## How to use / how it fits

Run every job that is due as of now:

```bash
bober research tick
# research tick: ran 2 job(s): 3f8a1c0b9d2e4f76, a91c…   (or) research tick: no jobs due.
```

`tick` is **idempotent**: after a job runs, its `nextDueAt` is advanced to a strictly future instant,
so re-running `tick` immediately runs nothing until the next cadence boundary arrives. The clock is
read **once** per invocation at the `.action()` boundary and threaded as `now` into both the
scheduler and the Sprint 2 runner.

The command help documents the scheduling-mechanism tradeoff — pick the trigger that fits the run:

- **`--watch`** — an in-process `setInterval` loop. Simple, but **dies with the process** (no reboot
  survival); suitable for a foreground/dev session, not unattended production.
- **OS cron / launchd calling `bober research tick`** — survives reboots and system sleep;
  **recommended for unattended runs**. Example crontab entry (top of every hour):

  ```cron
  0 * * * * /usr/local/bin/bober research tick
  ```

- **harness scheduler** — fires the CLI on a cadence from inside the agent harness.

> Hosted-OAuth schedulers are unfit for unattended runs (research doc L135) — use OS cron/launchd for
> unattended scheduling.

This sits between Sprint 3's egress-gated runner and Sprint 5: `tick` is the recurring driver; Sprint
5 adds digest aggregation over the notes/findings these runs produce.

## Notes for maintainers

- **Month-length rollover is intentional.** `setUTCMonth +1` overflows into the following month when
  the source day exceeds the destination month's length — e.g. `2026-01-31` + 1 month → `2026-03-03`
  (Feb 2026 has 28 days). The contract puts clamp-to-end-of-month **out of scope**; callers MUST NOT
  rely on a monthly cadence landing on the last day of the month. This is documented in `cadence.ts`
  and asserted by 4 month-rollover edge tests.
- **Run-first, persist-after = safe retry.** A job whose `runJob` throws is **not** advanced or
  persisted, so it remains due on the next tick. There is no retry/backoff beyond this (contract
  out-of-scope) — a failure leaves the job due rather than advancing `nextDueAt` past it.
- **Schema extension prevents silent strip.** `addJob`'s `safeParse`-before-write would have dropped
  `nextDueAt`/`lastRunAt` had the schema not been extended (briefing Finding A); both are optional so
  every pre-Sprint-4 job file still round-trips unchanged.
- **Single-process, no lock.** `tick` assumes a single process (the two-person personal use case) —
  distributed/locked scheduling and multi-host coordination are explicitly out of scope.
- **`--watch` keeps the FactStore short-lived.** Each interval iteration opens and closes its own
  `FactStore` (in a `finally`) to avoid holding a SQLite lock across iterations.
- **Deferred to later sprints:** digest aggregation (Sprint 5); retry/backoff for failed runs;
  binding a real web-search `RetrievalClient` in the CLI (still a Sprint 3 follow-up — `tick` inherits
  the offline-by-default posture).

## Sprint criteria

| Criterion | Verified |
|---|---|
| sc-4-1 — `computeNextDue` deterministic per cadence with an injected `fromInstant`, no wall-clock read | unit-test (9 tests incl. 4 month-rollover edges) |
| sc-4-2 — `tick` selects only `nextDueAt <= now` (or unset), skips future jobs | unit-test (10 scheduler tests; boundary-inclusive) |
| sc-4-3 — post-run `nextDueAt` advanced + `lastRunAt = now`; a second tick at the same `now` runs zero jobs | unit-test (read-back from disk; idempotency) |
| sc-4-4 — build green; `tick` + `--watch` + `--interval` registered | build / typecheck / lint exit 0 |

Commit: `c8c4b53` — *bober(sprint-4): cadence due-dates + idempotent `bober research tick`*
(7 files, +688/−1; full suite **3575** green, +22; all 4 required criteria — sc-4-1..sc-4-4 — passed
iteration 1; typecheck/build/lint clean, zero regressions; only `src/research/` + `src/cli/commands/research.ts`
changed).
