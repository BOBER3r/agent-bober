# Soft pause / resume: /pause, /resume + paused RunState + cooperative gate

**Contract:** sprint-spec-20260615-chat-interrupt-approve-steer-5  ·  **Spec:** spec-20260615-chat-interrupt-approve-steer  ·  **Completed:** 2026-06-15

## What this sprint added

A **soft** suspend for chat-launched runs — distinct from the already-built hard `/stop`
(Phase 1 kill-by-PID). `/pause <runId>` (and a natural-language `pause` classifier action)
writes a `runId`-keyed pause marker (`.bober/runs/<runId>/paused.json`) and flips the
chat-owned `RunState` to `'paused'` **without sending any kill signal** — the child process
stays alive. The pipeline gains one **additive** cooperative-pause gate at the same
checkpoint boundary cluster as Sprint 4's guidance read: when the marker is present the
pipeline holds (polls) at the next boundary; `/resume <runId>` removes the marker and flips
`RunState` back to `'running'`, and the gate advances. With no marker (or no `runId`) the
gate is a single existence check that returns immediately — provably additive. The poll loop
takes an injected clock and a bounded timeout, so a forgotten marker can never hang the
pipeline forever and tests never sleep real time.

## Public surface

- `setPaused(projectRoot, runId): Promise<void>` (`src/state/pause.ts:52`) — validates
  `safeSegment(runId)` **before** building any path (throws a clear error if unsafe), then
  **atomically** writes `paused.json` (`{ pausedAt }`) via temp-file + `rename` at mode
  `0o600` (mirrors `run-state.ts:41-52`).
- `clearPaused(projectRoot, runId): Promise<void>` (`src/state/pause.ts:78`) — best-effort
  `unlink` of the marker; idempotent, never throws (no-op if already gone or runId unsafe).
  Mirrors `approval-state.ts:deletePending`.
- `isPaused(projectRoot, runId): Promise<boolean>` (`src/state/pause.ts:91`) — `access`-checks
  the marker; returns `false` for a missing file or unsafe runId, never throws. Mirrors
  `guidance.ts:hasRunDir` shape.
- `waitWhilePaused(projectRoot, runId, opts?): Promise<void>` (`src/state/pause.ts:128`) — the
  cooperative gate. `opts` is `{ pollMs?, timeoutMs?, now? }` (`WaitWhilePausedOptions`,
  `src/state/pause.ts:103`). Does an **inline** `isPaused` check first; if not paused it
  returns immediately with **zero** scheduled ticks (the sc-5-7 no-op). Otherwise it polls
  every `pollMs` (default 2000) using the injected `now()` clock until the marker is gone or
  `timeoutMs` (default 24h, **capped at a 7-day `MAX_TIMEOUT_MS`**) elapses; on timeout it
  **resolves rather than rejects** so a stuck pause never crashes the pipeline. The `finally`
  block always clears the pending timer.
- `pause.ts` **reuses the exported `safeSegment`** from `src/state/guidance.ts:20` (the Sprint 4
  path-traversal guard) — `guidance.ts` itself is untouched. The module clones guidance.ts's
  structure (path helpers + atomic write) without modifying it.
- Cooperative-pause gate in the pipeline (`src/orchestrator/pipeline.ts:301-305`) — one import
  (`waitWhilePaused`, `:63`) plus one guarded
  `if (pipelineRunId) { await waitWhilePaused(projectRoot, pipelineRunId); }` block, inserted
  immediately **after** Sprint 4's guidance-injection block and **before** the Generate phase.
  Diff is **+8 / -0** (pure addition): `runSprintCycle`, `runTsPipeline`, `runPipeline`, and the
  `:570-587` invariant block are all untouched, no phase reordered.
- `ChatSession.handlePause(runId)` (`src/chat/chat-session.ts:393`, private) — roster guard
  (run must exist with status `running`; otherwise `No such running run: <runId>`, writes
  nothing), then `setPaused` + `writeRunState({ ...target, status: "paused", pausedAt })`.
  **Sends no kill signal** (the load-bearing distinction from `handleStop`). Ack explicitly
  says the process stays alive and is "NOT /stop".
- `ChatSession.handleResume(runId)` (`src/chat/chat-session.ts:417`, private) — `clearPaused`
  (best-effort) then, if a matching `paused` RunState exists, `writeRunState` back to
  `running` with `pausedAt` **destructured out** so it is not re-serialized. Ack
  `Resumed run <runId>.`
- `/pause <runId>` and `/resume <runId>` slash commands (`src/chat/slash-commands.ts:137`,
  `:144`) — dispatched via two new optional handlers (`pauseHandler`, `resumeHandler`, the
  **last** two `dispatch(...)` params, `src/chat/slash-commands.ts:65-66`), so existing
  callers keep working; absent handler → `"Pause is unavailable."` / `"Resume is
  unavailable."`. Missing arg → `Usage: /pause <runId>` / `Usage: /resume <runId>`.
- `HELP_TEXT` (`src/chat/slash-commands.ts:18`) — `/help` now lists `/pause` and `/resume`
  **and re-labels `/stop`** to make the soft/hard distinction explicit:
  `/stop <runId> — Stop a run by killing its process (hard stop)` vs
  `/pause <runId> — Soft-pause a run at the next boundary (process stays alive)`.
- `ClassifierAction` union (`src/chat/turn-classifier.ts:18-19`) — extended additively with
  `{ action: "pause"; runId: string }` and `{ action: "resume"; runId: string }`, backed by
  matching Zod discriminated-union members (`turn-classifier.ts:42-43`), parsed by
  `parseClassifierAction` (`turn-classifier.ts:111-116`), and advertised in the classifier
  prompt (`turn-classifier.ts:153-154`). Stays in loose-JSON mode (DeepSeek-safe).

## How to use / how it fits

From inside `bober chat`, soft-pause a known running run and later resume it:

```
> build a settings page          # detached run launches (Sprint 1), shows under /runs
> /pause run-1718...
  → "Paused run run-1718... at the next boundary — the process stays alive
     (use /resume run-1718... to continue). This is NOT /stop."
> /resume run-1718...
  → "Resumed run run-1718..."
```

Natural language routes through the same handlers (`pause that run` / `resume run X`).

The contrast with `/stop` is the point: `/stop` resolves the child PID, sends `SIGTERM`, and
flips the roster to `aborted` (the run is over). `/pause` writes a marker and flips `RunState`
to `paused` — the child keeps running and simply holds at its **next** checkpoint boundary,
where the pipeline calls `waitWhilePaused(projectRoot, pipelineRunId)`
(`src/orchestrator/pipeline.ts:305`) right after the Sprint 4 guidance block and before the
Generate phase. `pipelineRunId` is the same id chat threads via `--run-id`, so chat (writer of
the marker) and pipeline (reader of the marker) agree on the channel key. Resume removes the
marker; the pipeline's poll observes it gone and advances. Like guidance, pause acts only at a
boundary, never mid-agent, and does not require careful mode.

## Notes for maintainers

- **No-kill is the defining invariant (load-bearing).** `handlePause` calls only `setPaused` +
  `writeRunState` — never `spawner.stop`/`kill`. `chat-session-steer.test.ts` asserts
  `killCalls.length === 0` for `/pause`, directly contrasted with `/stop` asserting
  `=== 1`. Do not let a refactor route pause through the stop path; that would turn a soft
  suspend into a process kill and silently break the user's mental model.
- **Injected-clock + bounded timeout is load-bearing.** `waitWhilePaused` accepts `now()` and
  `pollMs` so the poll-loop tests drive it deterministically with zero wall-clock sleep (the
  full suite stays ~38s with no hung loops). The `timeoutMs` is `Math.min(..., MAX_TIMEOUT_MS)`
  (7-day cap) and a timeout **resolves** (continues the pipeline) rather than rejecting — a
  forgotten `paused.json` must never hang a run forever. Keep both the clock injection and the
  resolve-on-timeout behavior if you touch the loop. The `pollHandle` is always cleared in
  `finally` so no timer leaks.
- **Inline-first-check is the additive no-op (load-bearing).** `waitWhilePaused` checks
  `isPaused` inline *before* scheduling any `setTimeout`; with no marker it returns with zero
  ticks (sc-5-7). Combined with the `if (pipelineRunId)` guard at the call site, the gate is a
  single existence check when nothing is paused — the existing pipeline suite stays
  byte-for-byte green. Do not move the first check behind a scheduled tick.
- **Additive-pipeline discipline (+8 / -0).** The committed `pipeline.ts` diff is one import
  plus one guarded `await waitWhilePaused(...)` block — **zero deletions**, no phase reordering.
  `runTsPipeline`, `runPipeline`, and the `:570-587` invariant block are untouched (verified
  via the commit's numstat). When extending the pipeline, keep pause a read-only gate at a
  clearly-commented boundary, exactly as guidance (Sprint 4) is.
- **Marker writer vs reader split.** The chat process **owns** the `RunState` and the marker
  lifecycle (writes/clears `paused.json`, flips status); the pipeline only **reads** the marker
  to decide whether to block. Resume is observed by the chat-owned `RunState` flip and by the
  pipeline's poll independently — they communicate solely through `paused.json` on disk.
- **`pausedAt` is dropped on resume (intentional).** `handleResume` destructures `pausedAt` out
  of the RunState before `writeRunState`, so a resumed run carries no stale pause timestamp.
- **Non-goals honored.** No process kill (that is the unchanged Phase 1 `/stop`), no phase-order
  or algorithm change, no mid-agent pause (gate acts only at boundaries), and no hygiene / docs /
  e2e (Sprint 6). Protected files untouched: `disk.ts`, `approval-state.ts`,
  `feedback-router.ts`, and `guidance.ts` (the latter only *imported from*, never edited).

## How it was verified

Build, typecheck, and lint clean (0 errors, 2 pre-existing warnings). Full suite: 2130 passed /
3 skipped across 177 files, **+44** new collocated tests (`src/state/pause.test.ts`,
`src/orchestrator/pipeline.pause.test.ts`, plus additions to `src/chat/slash-commands.test.ts`,
`src/chat/turn-classifier.test.ts`, `src/chat/chat-session-steer.test.ts`). All 7 required
success criteria passed on iteration 1 with zero regressions
(`eval-sprint-spec-20260615-chat-interrupt-approve-steer-5-1`). Covered: `/pause` on a running
run writes `paused.json`, transitions `RunState` to `paused` + `pausedAt`, and sends **no** kill
signal (`killCalls === 0`, contrasted with `/stop === 1`), while `/pause` on an unknown /
non-running run returns a clear message and writes nothing (sc-5-4); the injected-clock gate
keeps polling across ticks while the marker exists and resolves once it is removed (sc-5-5);
`/resume` removes the marker and flips `RunState` back to `running`, and `/help` lists both
commands (sc-5-6); the no-marker path is a verified immediate no-op and the stubbed-classifier
NL `pause`/`resume` intent routes to the handlers (sc-5-7); the suite ran ~38s with no hung poll
loops.
