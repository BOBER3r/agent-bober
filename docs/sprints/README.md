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

## Domain-Agnostic Team Abstraction — in progress (2 of 4)

`spec-20260615-team-abstraction` — Phase 4 of the chattable multi-agent platform: make a
"team" (the providers, pipeline shape, memory namespace, and role set the pipeline runs
with) a **resolvable data object** rather than hard-coded behavior, with the existing
programming flow as the first instance. Sprint 1 lands the data model, the
`loadTeam(config, teamId?)` resolver, the built-in `programming` team (zero behavior
change), and the optional `teams` / `defaultTeam` config fields. Sprint 2 threads an
optional per-team **namespace** through the lessons store and retriever so two teams'
lessons are isolated, with the default team keeping the existing `.bober/memory/` path.
Runtime pipeline-shape selection (Sprint 3) and CLI wiring + an example team + user-facing
docs (Sprint 4) are deferred.

| # | Record | What it added |
|---|--------|---------------|
| 1 | [sprint-spec-20260615-team-abstraction-1.md](./sprint-spec-20260615-team-abstraction-1.md) | `Team` type + `loadTeam` registry + `programming` team + optional `teams`/`defaultTeam` config schema |
| 2 | [sprint-spec-20260615-team-abstraction-2.md](./sprint-spec-20260615-team-abstraction-2.md) | Per-team memory namespace threaded through `memoryDir`/`appendLesson`/`loadLessonIndex`/`loadLesson`/`retrieveRelevantLessons`; default team unchanged |
