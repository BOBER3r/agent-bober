# Resolve approvals from chat: /approve, /reject + feedback, NL

**Contract:** sprint-spec-20260615-chat-interrupt-approve-steer-3  ·  **Spec:** spec-20260615-chat-interrupt-approve-steer  ·  **Completed:** 2026-06-15

## What this sprint added

The **write side** of mid-flight human-in-the-loop control — it closes the HITL loop
opened by Sprints 1–2. A pending checkpoint surfaced by Sprint 2's read path can now be
resolved from inside `bober chat`, without leaving the REPL for the CLI. Two slash commands
land — `/approve <checkpointId>` and `/reject <checkpointId> [feedback]` — plus
natural-language approve/reject intent routed through the existing loose-JSON turn
classifier. Both paths **reuse** the existing approval store (`saveApproved` / `saveRejected`
behind the `pendingExists` guard) and `resolveApprover`; they write nothing new on disk
beyond the `.approved.json` / `.rejected.json` markers the CLI already produces. The detached
child's existing `DiskCheckpointMechanism` poll then resumes the run automatically, and a
rejection's feedback flows into the unchanged `runCheckpointWithFeedback` rework path. On
resolution the chat-owned `RunState` clears its three pending fields and flips back to
`running` — the inverse of Sprint 2's reflection.

## Public surface

- `/approve <checkpointId>` slash command (`src/chat/slash-commands.ts:91`) — approves a
  pending checkpoint and acks resumption. Missing arg => `Usage: /approve <checkpointId>`.
  Dispatched via a new optional `approveHandler` callback (`dispatch(...)` 5th param,
  `src/chat/slash-commands.ts:53`); absent handler => `"Approve is unavailable."`
- `/reject <checkpointId> [feedback]` slash command (`src/chat/slash-commands.ts:100`) —
  rejects a pending checkpoint with optional feedback. **Everything after the checkpoint id
  is captured as the feedback string** (spacing of the remainder preserved). Dispatched via
  a new optional `rejectHandler` 6th param (`src/chat/slash-commands.ts:54`); absent handler
  => `"Reject is unavailable."` Missing id => `Usage: /reject <checkpointId> [feedback]`.
- `HELP_TEXT` (`src/chat/slash-commands.ts:19`) — `/help` now lists `/approve <id>` and
  `/reject <id> [why]`.
- `ClassifierAction` union (`src/chat/turn-classifier.ts:16-17`) — extended additively with
  `{ action: "approve"; checkpointId?: string }` and
  `{ action: "reject"; checkpointId?: string; feedback?: string }`. Backed by matching Zod
  discriminated-union members and parsed by `parseClassifierAction`
  (`src/chat/turn-classifier.ts:93,97`); the classifier prompt advertises both shapes. Stays
  in `jsonObjectMode` (DeepSeek-safe), consistent with the existing actions.
- `ChatSession.handleApprove(checkpointId)` (`src/chat/chat-session.ts:319`, private) —
  `pendingExists` guard; on hit writes an `ApprovedMarker` (`{ approvedAt, approverId }`,
  `approverId` from `resolveApprover()`) via `saveApproved`, then `clearPending`. On a
  non-existent pending marker returns `No pending checkpoint found: <id>` and **writes
  nothing**.
- `ChatSession.handleReject(checkpointId, feedback)` (`src/chat/chat-session.ts:337`,
  private) — same `pendingExists` guard; on hit writes a `RejectedMarker`
  (`{ rejectedAt, rejecterId, feedback }`) via `saveRejected`, then `clearPending`. Same
  no-pending behavior.
- `ChatSession.clearPending(checkpointId)` (`src/chat/chat-session.ts:357`, private) —
  inverse of Sprint 2's reflection: finds the `input-required` RunState carrying this
  `pendingCheckpointId`, destructures out `pendingCheckpointId` / `pendingPrompt` /
  `pendingSince`, sets `status: "running"`, and `writeRunState`s. Idempotent — a no-op when
  no correlated state exists.
- `ChatSession.resolveCheckpoint(id?)` (`src/chat/chat-session.ts:379`, private) — the
  ambiguity arbiter for NL routing. Named id => use it; exactly one pending marker => use it;
  zero or several unnamed => returns an `ambiguous` result (a message) so the caller asks
  rather than guesses. The classify path (`src/chat/chat-session.ts:243-250`) routes
  `approve` / `reject` actions through it.

`resolveApprover` is **imported** from `src/cli/commands/approve.ts:29` (it was already
exported) — not re-implemented in the chat layer.

## How to use / how it fits

A blocked careful run (surfaced by Sprint 2) is now resolved without leaving chat:

```
> /careful on
> build a settings page          # detached careful run launches (Sprint 1)
  ...                            # run pauses at post-research, writes a .pending.json marker
> what's the status?             # Sprint-2 notice: [run run-1718... waiting at post-research: ...]
> /approve post-research         # → "Approved checkpoint post-research. The run will resume."
> /runs                          # the run is back to running on the next poll
```

Reject with feedback (everything after the id is the feedback string):

```
> /reject post-plan split sprint 2 into two smaller sprints
  → "Rejected checkpoint post-plan. Feedback sent for rework."
```

Natural language works too — the classifier emits `{action:"approve"|"reject", ...}` and the
turn routes it through the same handlers:

```
> looks good, approve it          # single pending marker → approved implicitly
> reject the plan, too broad       # → rejected with feedback "too broad" (if classifier extracts it)
```

When NL approve/reject names no checkpoint and **more than one** is pending, the turn replies
`Multiple pending checkpoints — which one? <ids>` and writes nothing; with **none** pending it
replies `No pending checkpoints to act on.` After a marker is written, the detached child's
existing `DiskCheckpointMechanism` poll picks it up on its next tick and resumes; a rejection's
`feedback` reaches the pipeline's `runCheckpointWithFeedback` rework round unchanged. This
sprint adds no new poll/resume code — chat only writes the marker and acks.

## Notes for maintainers

- **The `pendingExists` guard is load-bearing.** Both handlers check
  `pendingExists(projectRoot, checkpointId)` before writing and return a clear
  `No pending checkpoint found: <id>` (writing nothing) on a miss. This mirrors the CLI's
  guard (`approve.ts:44`) so chat never strands a dangling `.approved.json` /
  `.rejected.json` against a checkpoint that is not actually waiting. Do not let a refactor
  move the write ahead of the guard.
- **Never guess a load-bearing target (the ambiguity rule).** `resolveCheckpoint` only
  auto-resolves an absent checkpoint id when **exactly one** marker is pending. With zero or
  multiple pending and no named id, it returns an `ambiguous` message and the turn asks the
  user — it never picks one. Approving/rejecting the wrong checkpoint is irreversible, so the
  resolver is deliberately conservative. Keep it that way.
- **Disk-mechanism round-trip is the integration proof.** A genuine end-to-end test
  constructs a real `DiskCheckpointMechanism` pointed at a temp approvals dir, writes a
  rejected marker via the chat handler, and asserts `mechanism.request(...)` resolves to
  `{ approved: false, feedback }`. This proves the chat write integrates with the existing
  resume + feedback path, not a re-implementation. Note the timing: `DiskCheckpointMechanism`
  cleans stale `.approved` / `.rejected` / `.timeout` markers at the **start** of `request()`
  (but not `.pending`), so the test writes the rejected marker via `setTimeout` **after**
  polling begins — preserve that ordering if you touch the test.
- **Reuse, not rebuild (non-goals respected).** `saveApproved` / `saveRejected` /
  `pendingExists` (`approval-state.ts`), `DiskCheckpointMechanism` (`disk.ts`),
  `feedback-router.ts`, the `runCheckpointWithFeedback` consume path, and the
  `approve.ts` / `reject.ts` CLI behavior are all **untouched** (verified via `git stat`). The
  only change to `approve.ts` would have been exporting `resolveApprover`, which was already
  exported. Chat is a new caller of the existing store, not a second store.
- **Optional-handler threading stays backward-compatible.** `approveHandler` /
  `rejectHandler` are appended as optional `dispatch` params after `stopHandler` /
  `carefulHandler`, so existing 2-/3-/4-arg callers keep working and an absent handler returns
  an "unavailable" message rather than throwing — same pattern Sprints 1 and 4 (chat layer)
  used for `/careful` and `/stop`.
- **`clearPending` is the inverse of Sprint 2's reflection.** Sprint 2 flips a correlated
  RunState `running -> input-required` and sets the pending fields; this sprint flips it back
  to `running` and drops them. The flip is idempotent and only acts on an `input-required`
  state whose `pendingCheckpointId` matches; if you add an exhaustive `switch` on
  `RunState.status`, both transitions now occur in the chat layer.
- **Non-goals honored.** No guidance injection (Sprint 4), no pause/resume (Sprint 5), no
  marker hygiene on completion (Sprint 6), and no `runId`-scoped marker filenames (deferred).

## How it was verified

Build, typecheck, and lint clean (0 errors, 2 pre-existing warnings). Full suite: 2048 passed
/ 3 skipped across 173 files, **+27** new collocated tests (`chat-session-approval.test.ts`,
`slash-commands.test.ts`, `turn-classifier.test.ts`). All 7 required success criteria passed
on iteration 1 with zero attributable regressions
(`eval-sprint-spec-20260615-chat-interrupt-approve-steer-3-1`). Covered: `/approve` for an
existing pending marker writes `<id>.approved.json` with `approverId` while a non-existent one
writes nothing + returns a clear message (the `pendingExists` guard); `/reject` writes
`<id>.rejected.json` carrying the feedback string; the real `DiskCheckpointMechanism` reads
that rejected marker and resolves to `{ approved: false, feedback }` (the end-to-end proof);
stubbed-classifier NL approve with one pending marker approves it, NL reject with two unnamed
pending markers writes nothing and asks which; and the `RunState` transition back to `running`
with pending fields cleared plus `/help` listing both commands.
