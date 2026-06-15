# Surface pending approvals in chat (read path) + roster input-required

**Contract:** sprint-spec-20260615-chat-interrupt-approve-steer-2  ·  **Spec:** spec-20260615-chat-interrupt-approve-steer  ·  **Completed:** 2026-06-15

## What this sprint added

The **read side** of mid-flight human-in-the-loop control: a blocked careful run is now
visible inside `bober chat`. When a curated gate (Sprint 1) writes a pending marker under
`.bober/approvals/*.pending.json`, the next chat turn weaves a one-time
`[run <id> waiting at <gate>: <prompt>]` notice into the reply, and `/runs` shows the
correlated run as `[INPUT-REQUIRED]` with a `waiting=<checkpointId>` segment. Three pieces
land: an `ApprovalReader` (a read-only wrapper over the existing `listPending`), an
`ApprovalCursor` announce-once dedupe (mirroring the completion-tailer `cursor-store`), and a
poll-prelude in `handleTurn` that surfaces new markers and reflects them onto the chat-owned
`RunState`. **This sprint is strictly read-only with respect to the approvals dir** — it
never writes `.pending` / `.approved` / `.rejected` markers (that is Sprint 3). With no
pending markers, chat behavior is byte-identical to Phase 1.

## Public surface

- `ApprovalReader` class (`src/chat/approval-reader.ts:11`) —
  `new ApprovalReader(projectRoot)`; `read(): Promise<PendingMarker[]>` delegates to
  `listPending` (`src/state/approval-state.ts`). Missing dir => `[]`; corrupt marker files
  are skipped silently. Never writes.
- `ApprovalCursor` class (`src/chat/approval-cursor.ts:34`) —
  `new ApprovalCursor(projectRoot, sessionId)`; `filterNew(markers): Promise<PendingMarker[]>`
  returns the subset not yet announced and atomically records them. Persists the announced-key
  set per session at `.bober/chat/<sessionId>.approvals-cursor.json` (mode `0o600`). Missing /
  malformed file => empty set, never throws.
- `markerKey(m: PendingMarker): string` (`src/chat/approval-cursor.ts:28`) — exported identity
  key, `` `${checkpointId}@${requestedAt}` ``. Stable while a gate stays pending; changes if the
  gate is re-requested in a later round (new `requestedAt`).
- `ChatSession` approval prelude (`src/chat/chat-session.ts:139`) — in `handleTurn`, next to the
  completion-tailer poll, reads pending markers, filters new via the cursor, reflects correlated
  RunStates, and prepends the notice to **both** the slash-command reply (`:195`) and the LLM
  reply (`:246`). The whole block is wrapped in `try/catch` so a read error never breaks a turn.
- `ChatSessionOptions.approvalReader?` (`src/chat/chat-session.ts:37`) — optional injected
  `ApprovalReader` for testing; omit to use a real instance rooted at the project.
- `RosterReader.summarize` (`src/chat/roster-reader.ts:39`) — additive `waiting=<checkpointId>`
  segment appended to the line of an `input-required` run that carries a `pendingCheckpointId`.
  `[INPUT-REQUIRED]` itself comes for free from the existing `status.toUpperCase()`.

## How to use / how it fits

A blocked careful run surfaces automatically — there is no new command:

```
> /careful on
> build a settings page          # detached careful run launches (Sprint 1)
  ...                            # run pauses at post-research, writes a .pending.json marker
> what's the status?             # next turn weaves the notice into its reply:
  [run run-1718... waiting at post-research: Approve research before planning?]
> /runs
  [INPUT-REQUIRED] run-1718...  task="build a settings page"  started=...  waiting=post-research
```

The notice fires on the **next** turn after the marker appears (no live between-turn push),
exactly like Phase 1 completion notices. Correlation is by the pending marker's optional
`runId` field matched against `running` RunStates from `RosterReader`; a correlated run is
idempotently flipped to `status='input-required'` with `pendingCheckpointId` / `pendingPrompt`
/ `pendingSince` set, so `/runs` stays consistent across turns even after the announce-once
notice has fired. A marker with **no** `runId` is still announced (as `run unknown`) so a
CLI-spawned careful run is not silently hidden, but it has no RunState to reflect onto.

The actual resolve action (typing approve/reject in chat) does **not** exist yet — Sprint 3
owns the write path. For now the way to unblock a surfaced run is the existing
`bober approve` / `bober reject` CLI (see `COMMANDS.md` → Approval & Checkpoint Commands).

## Notes for maintainers

- **Announce-once dedupe key = `checkpointId@requestedAt`** (`markerKey`, the load-bearing
  design choice). It is stable while a marker stays pending, so a still-present marker does
  **not** re-announce on the next turn; it changes if the same gate is re-requested in a later
  round, so a genuinely new request does announce again. The announced-key set persists per
  session, mirroring the completion cursor (`.bober/chat/<sessionId>.cursor.json`), so a marker
  is surfaced at most once even across a REPL restart.
- **Idempotent RunState reflection (the second load-bearing guard).** The prelude only flips a
  RunState from `running -> input-required`; it never clobbers a `completed` / `aborted` /
  `failed` state, and it only acts on a marker whose `runId` matches a currently-`running`
  RunState. The chat process owns the RunState of the runs it spawned, so this write is local
  and safe. If you add an exhaustive `switch` on `RunState.status`, remember `input-required`
  is now actually produced here (Sprint 1 only declared the grammar).
- **Read-only invariant.** `approval-state.ts` write functions (`savePending`, `approve`,
  `reject`, …) and `DiskCheckpointMechanism` are untouched — confirmed by the committed diff.
  `ApprovalReader` is a thin delegate over `listPending` and must stay that way; do not let a
  later refactor add a write path through it.
- **Phase 1 parity.** `approvalNotice` initialises empty and is only prepended when non-empty,
  and the whole poll is inside `try/catch`. With no pending markers the turn output is
  byte-identical to Phase 1; the existing chat-session and roster tests stay green. Do not let
  later edits emit an empty-but-truthy notice.
- **Single careful run at a time (intentional limitation, carried from Sprint 1).** Marker
  files are `checkpointId`-keyed in a shared dir, so concurrent careful runs from one session
  could collide on correlation; this phase assumes one careful run at a time. Disambiguation /
  hygiene is deferred to Sprint 6.
- **Non-goals respected.** No write/resolve (Sprint 3), no guidance injection (Sprint 4), no
  pause/resume (Sprint 5), no marker cleanup on completion (Sprint 6).

## How it was verified

Build, typecheck, and lint clean (0 errors, 2 pre-existing warnings). Full suite: 2021 passed
/ 3 skipped across 173 files, +19 new collocated tests (`approval-reader.test.ts` 3,
`approval-cursor.test.ts` 8, `chat-session-approval.test.ts` 8). All 8 required success
criteria passed on iteration 1 with zero attributable regressions
(`eval-sprint-spec-20260615-chat-interrupt-approve-steer-2-1`). Covered: two synthetic markers
(one with `runId`, one without) both returned, corrupt file skipped, missing dir => `[]`; the
woven notice naming runId + checkpoint + prompt; two-turn announce-once dedupe; the reflected
RunState fields read back from disk plus `[INPUT-REQUIRED]` in the roster; and the no-pending
no-op parity case.
