# Steer: inspect + kill-by-PID stop with /stop command

**Contract:** sprint-spec-20260614-bober-chat-session-layer-4  ·  **Spec:** spec-20260614-bober-chat-session-layer  ·  **Completed:** 2026-06-14

## What this sprint added

Implements the `steer` paths for `bober chat`, the last open piece of the Chat
Session Layer. A run can now be **stopped** from chat — either with the deterministic
`/stop <runId>` slash command (no LLM call) or by asking in natural language (classifier
`steer:stop`) — and **inspected** via `steer:inspect`, which returns the same roster
summary as `/runs`. Both stop entry points funnel through one shared `ChatSession.handleStop`
so behaviour is identical regardless of how the request arrived. Stop is a real hard-stop:
`RunSpawner.stop` resolves the child PID from the session pid sidecar, sends it `SIGTERM`
(tolerating an already-dead pid), and flips the run's roster `state.json` to `aborted` on disk.

## Public surface

- `RunSpawner.stop(runId, reason)` (`src/chat/run-spawner.ts:140`) — resolves the PID from
  the `PidSidecar`. If a sidecar entry exists, calls the injected `KillFn` (default
  `process.kill`) with that PID and `SIGTERM`, ESRCH-tolerant, then flips `state.json` to
  `aborted` via `writeRunState` (sets `status`, `abortedAt`, `abortReason`). Returns
  `{ stopped: true, runId, killedPid }`. No sidecar entry → no kill; disk flip only →
  `{ stopped: true, runId, fallbackFlagOnly: true }`. Run absent from disk → `{ stopped: false, runId }`.
- `StopResult` type (`src/chat/run-spawner.ts`) — `{ stopped, runId, killedPid?, fallbackFlagOnly? }`.
- `KillFn` type + `RunSpawnerOptions.kill` (`src/chat/run-spawner.ts`) — injectable kill
  function so tests never kill real processes; defaults to `process.kill`.
- `ChatSession.handleStop(runId)` (`src/chat/chat-session.ts:191`, private) — shared stop
  handler. Resolves the runId against the **current disk roster at stop-time** (never from
  spawn-time memory); a runId that is not a `running` run replies `No such running run: <id>`
  and never reaches the kill function. Wired from both the `/stop` slash command and the
  classifier `steer:stop` branch.
- `/stop <runId>` slash command (`src/chat/slash-commands.ts:61`) — deterministic, no LLM.
  Missing arg → `Usage: /stop <runId>`. `dispatch` gained an optional 3rd arg `stopHandler`;
  when omitted (legacy 2-arg callers) `/stop` replies `Stop is unavailable.`
- `steer:inspect` routing (`src/chat/chat-session.ts:158`) — returns `RosterReader.summarize(states)`,
  the same output as `/runs`.

## How to use / how it fits

```bash
bober chat
> build a settings page with dark mode
# → "Launched run run-1718370000000 for: ... Use /runs to track it."
> /stop run-1718370000000
# → "Stopped run run-1718370000000 (killed pid 48213)."
> stop the settings page run        # natural language → classifier steer:stop → handleStop
> what's running?                   # natural language → classifier steer:inspect → roster summary
```

The PID comes from the Sprint 2 pid sidecar (`.bober/chat/<sessionId>.pids.json`), the only
authoritative source of session-recorded PIDs, so chat can never kill a PID it did not spawn.
The `aborted` flip uses `writeRunState` (`src/state/run-state.ts`) directly — **not**
`RunManager.abortRun`, which no-ops across processes (`run-manager.ts:123`).

## Notes for maintainers

- **Kill is restricted to session-recorded PIDs.** The kill function is reached only when a
  sidecar entry for the runId exists; an unknown/stale runId falls back to the disk flip or
  reports `No such running run`. Do not loosen this guard — it is the safety property that
  stops chat from killing arbitrary PIDs (sc-4-9).
- **No cooperative child shutdown in Phase 1.** The child is hard-killed; it does not poll the
  disk `aborted` flag. Cooperative/graceful shutdown handshakes and pause/resume are Phase 2.
- **Stop-time roster resolution is intentional.** `handleStop` re-reads the disk roster on each
  call rather than trusting spawn-time memory, so a run already finished or aborted elsewhere is
  treated correctly.
