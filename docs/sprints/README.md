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

## Domain-Agnostic Team Abstraction — complete (4 of 4)

`spec-20260615-team-abstraction` — Phase 4 of the chattable multi-agent platform: make a
"team" (the providers, pipeline shape, memory namespace, and role set the pipeline runs
with) a **resolvable data object** rather than hard-coded behavior, with the existing
programming flow as the first instance. **The plan is complete and the abstraction is
proven end-to-end: adding a team is data, not code.** Sprint 1 lands the data model, the
`loadTeam(config, teamId?)` resolver, the built-in `programming` team (zero behavior
change), and the optional `teams` / `defaultTeam` config fields. Sprint 2 threads an
optional per-team **namespace** through the lessons store and retriever so two teams'
lessons are isolated, with the default team keeping the existing `.bober/memory/` path.
Sprint 3 wires the active team's **`pipelineShape`** into runtime engine selection:
`runPipeline` resolves the team via `loadTeam` and a new `selectPipelineEngineForTeam`
seam picks the engine, reusing the existing eligibility + `'careful'`-mode downgrade
(byte-identical log line) — the programming / no-team path is unchanged. Sprint 4 proves
the claim: a minimal `example` team declared purely as a `teams` config entry (**no code
branch**) flows through `loadTeam`; `bober run --team <id>` (additive, mirroring
`--run-id`) threads to `runPipeline`, `bober chat [team]` resolves the once-ignored team
arg and routes its memory namespace into `ChatSession`, so a lesson under the example team
lands in `.bober/memory/example/`. User-facing docs ([`docs/teams.md`](../teams.md) +
README Teams section) ship with it.

| # | Record | What it added |
|---|--------|---------------|
| 1 | [sprint-spec-20260615-team-abstraction-1.md](./sprint-spec-20260615-team-abstraction-1.md) | `Team` type + `loadTeam` registry + `programming` team + optional `teams`/`defaultTeam` config schema |
| 2 | [sprint-spec-20260615-team-abstraction-2.md](./sprint-spec-20260615-team-abstraction-2.md) | Per-team memory namespace threaded through `memoryDir`/`appendLesson`/`loadLessonIndex`/`loadLesson`/`retrieveRelevantLessons`; default team unchanged |
| 3 | [sprint-spec-20260615-team-abstraction-3.md](./sprint-spec-20260615-team-abstraction-3.md) | Team-aware pipeline-shape selection: `resolveEngineNameForTeam`/`selectPipelineEngineForTeam` + `runPipeline` `opts.teamId` (default `programming`); eligibility + `careful` downgrade preserved |
| 4 | [sprint-spec-20260615-team-abstraction-4.md](./sprint-spec-20260615-team-abstraction-4.md) | Example team as pure config data + `bober run --team <id>` + `bober chat [team]` routing → `.bober/memory/example/`; user-facing [`docs/teams.md`](../teams.md) + README Teams section (the platform proof) |

User-facing "how to add a team" docs live in [`docs/teams.md`](../teams.md).
