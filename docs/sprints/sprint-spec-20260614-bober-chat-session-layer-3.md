# Rotation-safe completion weaving (history.jsonl tailer)

**Contract:** sprint-spec-20260614-bober-chat-session-layer-3  ·  **Spec:** spec-20260614-bober-chat-session-layer  ·  **Completed:** 2026-06-14

## What this sprint added

Closes the loop on chat-spawned runs: when a detached run launched from `bober chat`
finishes, the **next** chat turn surfaces a `[run <id> finished: <phase>]` notice woven
into the reply. The enabling piece is a `CompletionTailer` that tails
`.bober/history.jsonl` from a persisted byte cursor, detects `pipeline-complete` events,
and is **rotation-safe** — if the log was rotated or truncated (file size shrank below the
stored cursor) it resets the cursor to 0, re-scans the whole file, and dedupes by `runId`
so nothing is dropped or re-emitted. Dedupe state (`seenRunIds`) is persisted alongside the
cursor at `.bober/chat/<sessionId>.cursor.json`, so a completion already announced is not
re-announced after a REPL restart. Completions surface on the next turn only — there is no
live between-turn push (Sprint 4 covers stop/kill).

## Public surface

- `CompletionTailer` (`src/chat/completion-tailer.ts:97`) — `new CompletionTailer(projectRoot, sessionId)`; `poll(): Promise<CompletionEvent[]>` reads `.bober/history.jsonl` from the persisted byte cursor, returns only newly-seen `pipeline-complete` events, advances and persists the cursor. Missing history file → returns `[]` without throwing and without mutating the stored cursor. Only complete lines (up to the last `\n`) are consumed; a partial trailing line mid-write is left for the next poll.
- `CompletionEvent` type (`src/chat/completion-tailer.ts:22`) — `{ runId?, phase: "complete" | "failed", completed, failed, durationMs, timestamp }`.
- `CursorStore` (`src/chat/cursor-store.ts:25`) — `new CursorStore(projectRoot, sessionId)`; `read(): Promise<CursorFile>` (returns the zero-state default on missing/malformed file, never throws) and `write(cursor)` (creates `.bober/chat/`, writes mode `0o600`). Persists to `.bober/chat/<sessionId>.cursor.json`.
- `CursorFile` type (`src/chat/cursor-store.ts:14`) — `{ byteCursor: number, lastSize: number, seenRunIds: string[] }`. `seenRunIds` is serialised as an array and hydrated into a `Set` on read.
- `ChatSession` completion weaving (`src/chat/chat-session.ts`) — `handleTurn` now polls the tailer as a prelude (before the slash/LLM path) and folds any new completions into both slash-command and LLM replies as `[run <id> finished: <phase>]` notices, one per line. Poll errors never break the turn. A `tailer` option allows injecting a fake `CompletionTailer` in tests.

## How to use / how it fits

```bash
bober chat
> build a settings page with dark mode
# → "Launched run run-1718370000000 for: ..."
# ... the detached run finishes while you keep chatting ...
> anything done yet?
# → "[run run-1718370000000 finished: complete]\n\n<assistant reply>"
```

The tailer reads the same `.bober/history.jsonl` the orchestrator already appends to; it
does not modify `EventStreamManager` or the history/rotation modules. When a
`pipeline-complete` line omits `runId` (the terminal line in `pipeline.ts` may not carry
it), the tailer falls back to scanning `.bober/runs/<id>.completed.json` markers for the
first unseen run. If no `runId` is resolvable at all, a synthetic key (`timestamp:durationMs`)
is used for dedupe so a completion is still announced exactly once.

## Notes for maintainers

- **Dedupe by runId is the correctness keystone.** After a shrink-triggered cursor reset the
  whole file is re-scanned; without the persisted `seenRunIds` set, every prior completion
  would be re-emitted. Any change to the reset path must keep dedupe intact.
- **Marker fallback is first-unseen, not timestamp-correlated.** `findUnseenMarkerRunId`
  returns the first `.completed.json` marker not already in `seenRunIds`; for a session with
  multiple concurrent runs whose completion lines lack `runId`, this can mis-assign. The
  marked upgrade path (`bober:` comment in source) is to embed `runId` in the
  `pipeline-complete` history line. The `timestamp` parameter is already threaded for a future
  timestamp-based correlation.
- This sprint does not read the rotated `history.archive.jsonl`; the completion marker is the
  fallback for a completion line that was rotated away.

### Iteration-2 fix: scanner self-scan expectation (kebab-case now dominant)

Iteration 1 (commit `625cb9a`) shipped the tailer code and passed its eight criteria, but
the self-scanning convention test in `src/discovery/scanner.test.ts` flipped: the new
`src/chat` module files (`chat-session.ts`, `completion-tailer.ts`, `cursor-store.ts`,
`run-spawner.ts`, `pid-sidecar.ts`, plus their `*.test.ts`) added enough **kebab-case**
filenames that kebab-case overtook camelCase as the repo's dominant file-naming style.
`scanCodeConventions(PROJECT_ROOT)` correctly now reports `kebab-case`, so iteration 2
(commit `1234c1c`) updated the test's expectation from `camelCase` to `kebab-case` to match
reality. This is a test-expectation correction, not a behavior change — the scanner was right;
the assertion was stale. Going forward, kebab-case is the dominant convention new modules
should follow.
