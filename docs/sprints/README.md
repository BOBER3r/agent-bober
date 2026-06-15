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

## Chat Interrupt / Approve / Steer — in progress (4 of 6)

`spec-20260615-chat-interrupt-approve-steer` — Phase 2 of the chattable platform: mid-flight
human-in-the-loop control of chat-launched runs (surface pending approvals, approve/reject,
inject guidance, pause/resume). Sprint 1 lays the spine — all additive, default-off, autopilot
unchanged: the `RunState` status grammar gains `input-required` / `paused` plus four optional
pending/pause fields; `bober run` gains an additive `--approve-gates <comma-list>` flag that
disk-gates only the named checkpoint sites (validated against `CHECKPOINT_SITES`, unknown gate
rejected with no partial merge); and a session-persisted `/careful on|off` chat toggle makes
`RunSpawner` launch the detached child with the curated
`--approve-gates post-research,post-plan,post-sprint`. With careful off, a chat spawn is
byte-for-byte identical to Phase 1. Sprint 2 adds the **read/surface** path: an `ApprovalReader`
over `.bober/approvals/*.pending.json`, an announce-once dedupe `ApprovalCursor`, and a
poll-prelude in `handleTurn` that weaves a one-time `[run <id> waiting at <gate>: <prompt>]`
notice into the reply and flips the correlated chat-owned `RunState` to `input-required` so
`/runs` shows `[INPUT-REQUIRED]` + `waiting=<gate>`. Read-only — no markers are written, and
with no pending markers behavior matches Phase 1. Sprint 3 closes the loop with the
**write/resolve** path: `/approve <id>` and `/reject <id> [feedback]` slash commands plus
natural-language approve/reject intent, all reusing the existing approval store
(`saveApproved` / `saveRejected` behind the `pendingExists` guard + imported `resolveApprover`)
to write the `.approved.json` / `.rejected.json` markers. The detached child's existing
`DiskCheckpointMechanism` poll then resumes the run, reject feedback reaches the unchanged
`runCheckpointWithFeedback` rework path (proven by a real-mechanism round-trip test), and the
chat-owned `RunState` clears its pending fields back to `running` — the inverse of Sprint 2's
reflection. NL resolution never guesses a load-bearing target: it auto-picks only the single
outstanding marker and otherwise asks which. Sprint 4 adds the **steer/guidance** path: a
`runId`-keyed guidance channel at `.bober/runs/<id>/guidance.jsonl` written by a
`/tell <runId> <text>` slash command (and an NL `tell run X to …` classifier action), plus
a single **additive** pipeline read point that drains pending guidance at each sprint
boundary and injects it into the generator's handoff as `Human guidance: <text>` entries.
`appendGuidance` validates the runId via a `safeSegment` path-traversal guard *before* any
write, `drainGuidance` atomically marks entries consumed so a redrain returns nothing, and
`injectGuidanceIntoHandoff` returns the **same handoff reference** when no guidance is
queued — so with no guidance the pipeline is byte-for-byte unchanged (`runTsPipeline` and
the `:571` invariant untouched). Guidance is advisory-only, applies at the next boundary,
and does not require careful mode. The pause/resume (Sprint 5) and hygiene+docs+e2e
(Sprint 6) paths are not built yet.

| # | Record | What it added |
|---|--------|---------------|
| 1 | [sprint-spec-20260615-chat-interrupt-approve-steer-1.md](./sprint-spec-20260615-chat-interrupt-approve-steer-1.md) | Additive `RunState` grammar (`input-required`/`paused` + pending/pause fields) + `bober run --approve-gates` + `CarefulSidecar` + `/careful [on\|off]` + careful-aware `RunSpawner.spawn` |
| 2 | [sprint-spec-20260615-chat-interrupt-approve-steer-2.md](./sprint-spec-20260615-chat-interrupt-approve-steer-2.md) | Read-only approval surfacing in chat: `ApprovalReader` + announce-once `ApprovalCursor` + `handleTurn` poll-prelude notice + idempotent `RunState` reflection + roster `[INPUT-REQUIRED]` / `waiting=<gate>` |
| 3 | [sprint-spec-20260615-chat-interrupt-approve-steer-3.md](./sprint-spec-20260615-chat-interrupt-approve-steer-3.md) | Resolve approvals from chat (write path): `/approve <id>` + `/reject <id> [feedback]` slash commands + NL approve/reject classifier intent, reusing `saveApproved`/`saveRejected` behind the `pendingExists` guard + `resolveApprover`; never-guess ambiguity rule; `RunState` cleared back to `running`; `DiskCheckpointMechanism` round-trip proof |
| 4 | [sprint-spec-20260615-chat-interrupt-approve-steer-4.md](./sprint-spec-20260615-chat-interrupt-approve-steer-4.md) | Free-text guidance/steer path: `runId`-keyed `guidance.jsonl` channel (`safeSegment` path-traversal guard + atomic drain-consume), `/tell <runId> <text>` slash command + NL `tell` classifier action, and a single additive `pipeline.ts` read point draining guidance into the generator handoff (`Human guidance: <text>`); reference-identity no-op when none queued |

User-facing usage lives in [`COMMANDS.md`](../../COMMANDS.md) under `bober run` (`--approve-gates`) and `bober chat` (`/careful`, `/runs`, `/approve`, `/reject`, `/tell`).

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
