# Hygiene, docs, and end-to-end verification (finale)

**Contract:** sprint-spec-20260615-chat-interrupt-approve-steer-6  ·  **Spec:** spec-20260615-chat-interrupt-approve-steer  ·  **Completed:** 2026-06-15

## What this sprint added

The **final** sprint of Phase 2 — it hardens the mid-flight HITL loop and documents it as
a feature, without adding any new steer capability. Three pieces land: (1) a best-effort
**terminal-run cleanup** that removes a run's stale steer artifacts (pending approval
marker(s), `guidance.jsonl`, `paused.json`) and clears the chat-owned `RunState`
pending/paused fields once the chat process observes the run reach a terminal status —
so a completed run's leftover markers can't re-surface as a zombie `input-required` notice
on a later turn; (2) a **full-loop end-to-end test** that drives the whole Sprint 1–5 loop
offline (careful → spawn → surface → tell → approve → pause → resume → completion → cleanup)
against a stubbed pipeline, the integration proof for the plan; and (3) the consolidated
**feature docs** (README section + `docs/chat-steer.md`) plus a `/help` full-set test.
With this sprint the plan is complete (6 of 6).

## Public surface

- `cleanupTerminalRun(projectRoot, runId): Promise<void>` (`src/chat/steer-cleanup.ts:25`) —
  best-effort hygiene for a run that has gone terminal. **Never throws** (each step is
  individually guarded so a cleanup failure can't break a chat turn), **ENOENT-tolerant**
  (the marker unlinks `.catch(() => {})`), and **run-isolated**. Steps, in order:
  1. **`safeSegment(runId)` guard first** (`steer-cleanup.ts:29`) — an unsafe runId skips
     silently before any path is built (mirrors `pause.ts`); reuses the exported guard from
     `src/state/guidance.ts:20`.
  2. **Delete correlated pending markers** — `listPending(projectRoot)` then
     `deletePending(projectRoot, m.checkpointId)` for **only** the markers whose `runId`
     field matches (`steer-cleanup.ts:32-41`); other runs' pending markers are left alone.
     `deletePending` is itself already best-effort.
  3. **Unlink `guidance.jsonl` + `paused.json`** under `.bober/runs/<runId>/`
     (`steer-cleanup.ts:44-46`), each tolerating a missing file.
  4. **Clear RunState pending/paused fields** (`steer-cleanup.ts:50-64`) — reads the state,
     and if present destructures out `pendingCheckpointId` / `pendingPrompt` / `pendingSince`
     / `pausedAt` and rewrites the rest, **preserving the terminal status**
     (`completed` / `aborted`) — it does **not** force the run back to `running`.
- Cleanup hook in `ChatSession.handleTurn` (`src/chat/chat-session.ts:149-158`) — one import
  (`steer-cleanup.js`, `:31`) plus a loop that calls `cleanupTerminalRun` for each completion
  the tailer poll returned. **Placement is load-bearing:** it sits **after** the completion
  poll try/catch (`:143-147`) and **before** the pending-approval prelude (`:160`), so a run
  that just completed has its stale pending marker removed *before* the same turn's approval
  poll could otherwise re-announce it as a fresh `input-required` notice. Wrapped in its own
  try/catch so a cleanup failure never breaks the turn.

## How to use / how it fits

This sprint adds no user-facing command — cleanup is automatic. The next chat turn after a
run completes (or is aborted) observes the completion via the tailer and silently sweeps that
run's steer artifacts. The full lifecycle a maintainer should picture:

```
/careful on  →  spawn (--approve-gates post-research,post-plan,post-sprint)
            →  run pauses at post-plan, chat surfaces [run … waiting at post-plan: …]
            →  /tell <runId> <guidance>   (guidance.jsonl)
            →  /approve post-plan          (.approved.json, RunState pending cleared)
            →  /pause <runId> / /resume    (paused.json ↔ RunState running)
            →  run completes               → next turn: cleanupTerminalRun sweeps markers
```

The consolidated user-facing documentation for the whole Phase 2 feature is
[`docs/chat-steer.md`](../chat-steer.md) (the cross-process model, `/careful` + the curated
gates, approve/reject/tell/pause-vs-stop, cleanup, and a Limitations section) and the README's
"Chat Steer Commands (Phase 2)" section — both authored by the generator as part of this
deliverable. Command-level usage also lives in [`COMMANDS.md`](../../COMMANDS.md).

## Notes for maintainers

- **Best-effort is the defining contract.** `cleanupTerminalRun` is structured so that no
  step can throw into a chat turn: the unsafe-id check returns early, the pending-sweep and
  RunState-clear are each wrapped in `try/catch`, and the unlinks swallow ENOENT. The call
  site in `handleTurn` adds a second outer `try/catch`. If you extend cleanup, keep every new
  step inside this never-throw envelope — a failed sweep must degrade to "stale marker left on
  disk," never to a broken turn.
- **Hook placement before the approval prelude is load-bearing.** Cleanup must run after the
  completion poll (so it knows which runs went terminal) but **before** the approval prelude
  (so the swept run's pending marker is gone before the same turn could re-announce it). Do not
  reorder these two blocks; moving cleanup after the approval poll would let a completed run's
  stale `*.pending.json` resurface as a zombie `input-required` notice — the exact failure this
  sprint exists to prevent.
- **Terminal status is preserved (intentional).** Step 4 destructures out only the
  pending/pause fields and rewrites the rest, leaving `status` at `completed`/`aborted`. Do not
  let a refactor flip a cleaned run back to `running`.
- **Run isolation is asserted.** Only markers whose `runId` field equals the terminal run's id
  are deleted; `steer-cleanup.test.ts` covers an other-run-isolation case (a concurrent run's
  pending marker survives). Keep the `m.runId === runId` filter — a broader sweep would clobber
  a sibling careful run's pending state.
- **Documented limitation carried into the finale: single careful run at a time.** Approval
  markers are keyed by `checkpointId` (shared across runs), not by `runId`, so two concurrent
  careful runs gating at the same checkpoint would collide. Phase 2 ships scoped to one careful
  run per session (the `runId`-correlation in cleanup and surfacing mitigates but does not
  remove this). The documented follow-up is **runId-scoped marker filenames**; it is an
  explicit non-goal here (see `docs/chat-steer.md` "Limitations and Follow-Ups").
- **No new public abstraction, no protected-file edits.** This is an integration + polish
  sprint. `pipeline.ts`, `disk.ts`, and `approval-state.ts` are untouched (only *imported
  from*); `guidance.ts` is only imported for its `safeSegment` export. `HELP_TEXT` already
  listed all ten commands after Sprint 5 — sc-6-6 is a test-only assertion, not a code change.
- **`npm run update-all` is a human follow-up.** Syncing the planner/chat skill + agent copies
  into the `.claude` install is noted in the docs as a manual post-merge step, not part of this
  sprint.

## How it was verified

Build, typecheck, and lint clean (0 errors, 2 pre-existing warnings). Full suite: 2139 passed /
3 skipped across 179 files, **+9** new tests; the known flake did not appear (179/179 green).
All **7 required** success criteria passed on iteration 1 with zero regressions
(`eval-sprint-spec-20260615-chat-interrupt-approve-steer-6-1`). Coverage:

- **Cleanup (sc-6-4)** — `src/chat/steer-cleanup.test.ts` seeds a run with a pending marker +
  `guidance.jsonl` + `paused.json` + RunState pending/paused fields, transitions it to
  `completed` (and separately `aborted`), and asserts all markers are removed and the RunState
  pending/paused fields are cleared while the terminal status is preserved; plus the
  idempotent/ENOENT case, other-run isolation, and the unsafe-id guard.
- **End-to-end (sc-6-5)** — `src/chat/chat-steer-e2e.test.ts` drives the complete loop offline
  in real temp dirs against a stubbed `RunSpawner` + fake LLM (no network, no real pipeline):
  `/careful on` (sidecar persisted) → spawn (captured args assert `--approve-gates`) → injected
  `post-plan` pending marker → turn surfaces the `input-required` notice + flips RunState →
  `/tell` (guidance.jsonl asserted) → `/approve post-plan` (`.approved.json` + RunState cleared)
  → injected `post-sprint` pending → `/pause` (`paused.json` + RunState `paused`) → `/resume`
  (cleared, back to `running`) → injected completion → next turn asserts cleanup swept the stale
  markers and cleared the RunState. Disk-artifact + RunState assertions at every step — this is
  the integration proof for the plan.
- **`/help` full set (sc-6-6)** — `src/chat/slash-commands.test.ts` (sc-6-6) asserts `HELP_TEXT`
  contains every command: `/careful`, `/approve`, `/reject`, `/tell`, `/pause`, `/resume`,
  `/stop`, `/runs`, `/help`, `/exit`.
- **Docs (sc-6-7)** — the generator authored the README "Chat Steer Commands (Phase 2)" section
  and `docs/chat-steer.md`, covering `/careful` + the curated gates (post-research / post-plan /
  post-sprint), approve/reject/tell/pause/resume, cleanup, and an explicit "Limitations and
  Follow-Ups" section (single-careful-run-at-a-time + the runId-scoped-marker follow-up).
