# Sprint records

Durable, per-sprint records of what each passing Bober sprint shipped. One file per
contract, written by the documenter agent immediately after the sprint passes evaluation.

## Chat Session Layer — Phase 1 complete (4 sprints)

`spec-20260614-bober-chat-session-layer` — Phase 1 of the chattable self-improving
multi-agent platform. The four sprints together deliver the end-to-end `bober chat`
capability: a **persistent, resumable REPL** that **classifies each turn** (chat /
spawn / steer), **detached-spawns** real `bober run` work keyed on a session-chosen
`--run-id`, weaves **rotation-safe completion notices** back into later turns, and lets
you **steer/stop** a live run deterministically — all roster- and memory-aware, with no
SDK leakage into `src/chat`.

| # | Record | What it added |
|---|--------|---------------|
| 1 | [sprint-spec-20260614-bober-chat-session-layer-1.md](./sprint-spec-20260614-bober-chat-session-layer-1.md) | Persistent resumable REPL + turn classifier |
| 2 | [sprint-spec-20260614-bober-chat-session-layer-2.md](./sprint-spec-20260614-bober-chat-session-layer-2.md) | Detached run spawn (`--run-id`) + pid sidecar |
| 3 | [sprint-spec-20260614-bober-chat-session-layer-3.md](./sprint-spec-20260614-bober-chat-session-layer-3.md) | Rotation-safe completion weaving (history.jsonl tailer) |
| 4 | [sprint-spec-20260614-bober-chat-session-layer-4.md](./sprint-spec-20260614-bober-chat-session-layer-4.md) | Steer: inspect + kill-by-PID stop with `/stop` |

User-facing usage lives in [`COMMANDS.md`](../../COMMANDS.md) under `bober chat`.
