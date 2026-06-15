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

## Chat Interrupt / Approve / Steer — complete (6 of 6)

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
and does not require careful mode. Sprint 5 adds the **soft pause/resume** path — distinct
from the hard `/stop` kill: `/pause <runId>` (and an NL `pause` action) writes a `runId`-keyed
`.bober/runs/<id>/paused.json` marker and flips the chat-owned `RunState` to `paused`
**without any kill signal** (the process stays alive), while one **additive** cooperative-pause
gate (`waitWhilePaused`, **+8 / -0** in `pipeline.ts`, immediately after Sprint 4's guidance
block) holds the run at its next boundary while the marker is present; `/resume <runId>` removes
it and flips `RunState` back to `running`. The poll loop takes an injected clock and a
bounded timeout (7-day cap, resolve-on-timeout) so a forgotten marker can't hang a run and
tests never sleep; with no marker the gate is a single existence check (provably additive).
`pause.ts` reuses Sprint 4's exported `safeSegment` guard and leaves `guidance.ts` untouched.
Sprint 6 closes the plan with **hygiene + e2e + consolidated docs**: a best-effort, never-throw,
ENOENT-tolerant, run-isolated `cleanupTerminalRun` sweeps a completed/aborted run's stale steer
artifacts (correlated pending marker(s), `guidance.jsonl`, `paused.json`) and clears the
chat-owned `RunState` pending/paused fields **while preserving the terminal status** — hooked into
`handleTurn` *after* the completion poll and *before* the approval prelude so a completed run's
stale marker can't re-surface as a zombie `input-required` notice. A full-loop e2e test
(`chat-steer-e2e.test.ts`) drives the whole Sprint 1–5 loop offline against a stubbed pipeline
(careful → spawn → surface → tell → approve → pause → resume → completion → cleanup) with
disk-artifact + RunState assertions at every step — the integration proof. The consolidated
user-facing feature docs ([`docs/chat-steer.md`](../chat-steer.md) + README "Chat Steer Commands
(Phase 2)" section) ship with it, including an explicit single-careful-run-at-a-time limitation +
runId-scoped-marker follow-up. **The plan is complete (6 of 6).**

| # | Record | What it added |
|---|--------|---------------|
| 1 | [sprint-spec-20260615-chat-interrupt-approve-steer-1.md](./sprint-spec-20260615-chat-interrupt-approve-steer-1.md) | Additive `RunState` grammar (`input-required`/`paused` + pending/pause fields) + `bober run --approve-gates` + `CarefulSidecar` + `/careful [on\|off]` + careful-aware `RunSpawner.spawn` |
| 2 | [sprint-spec-20260615-chat-interrupt-approve-steer-2.md](./sprint-spec-20260615-chat-interrupt-approve-steer-2.md) | Read-only approval surfacing in chat: `ApprovalReader` + announce-once `ApprovalCursor` + `handleTurn` poll-prelude notice + idempotent `RunState` reflection + roster `[INPUT-REQUIRED]` / `waiting=<gate>` |
| 3 | [sprint-spec-20260615-chat-interrupt-approve-steer-3.md](./sprint-spec-20260615-chat-interrupt-approve-steer-3.md) | Resolve approvals from chat (write path): `/approve <id>` + `/reject <id> [feedback]` slash commands + NL approve/reject classifier intent, reusing `saveApproved`/`saveRejected` behind the `pendingExists` guard + `resolveApprover`; never-guess ambiguity rule; `RunState` cleared back to `running`; `DiskCheckpointMechanism` round-trip proof |
| 4 | [sprint-spec-20260615-chat-interrupt-approve-steer-4.md](./sprint-spec-20260615-chat-interrupt-approve-steer-4.md) | Free-text guidance/steer path: `runId`-keyed `guidance.jsonl` channel (`safeSegment` path-traversal guard + atomic drain-consume), `/tell <runId> <text>` slash command + NL `tell` classifier action, and a single additive `pipeline.ts` read point draining guidance into the generator handoff (`Human guidance: <text>`); reference-identity no-op when none queued |
| 5 | [sprint-spec-20260615-chat-interrupt-approve-steer-5.md](./sprint-spec-20260615-chat-interrupt-approve-steer-5.md) | Soft pause/resume: `runId`-keyed `paused.json` marker (`setPaused`/`clearPaused`/`isPaused`, reusing Sprint 4's `safeSegment`) + injected-clock bounded `waitWhilePaused` cooperative gate (**+8 / -0** additive in `pipeline.ts`); `/pause <runId>` + `/resume <runId>` slash commands + NL `pause`/`resume` actions; **no kill signal** (`killCalls === 0`, vs `/stop === 1`), `RunState` `paused`↔`running`, `/help` distinguishes soft `/pause` from hard `/stop` |
| 6 | [sprint-spec-20260615-chat-interrupt-approve-steer-6.md](./sprint-spec-20260615-chat-interrupt-approve-steer-6.md) | **Finale** — hygiene + e2e + docs: best-effort never-throw `cleanupTerminalRun` sweeps a terminal run's correlated pending marker(s) + `guidance.jsonl` + `paused.json` and clears `RunState` pending/paused (terminal status preserved), hooked into `handleTurn` *before* the approval prelude (prevents zombie `input-required` re-surface); full-loop offline e2e (`chat-steer-e2e.test.ts`) as the integration proof; `/help` full-set test; consolidated feature docs ([`docs/chat-steer.md`](../chat-steer.md) + README) with explicit single-careful-run limitation + runId-scoped-marker follow-up |

User-facing usage lives in [`COMMANDS.md`](../../COMMANDS.md) under `bober run` (`--approve-gates`) and `bober chat` (`/careful`, `/runs`, `/approve`, `/reject`, `/tell`, `/pause`, `/resume`). The consolidated feature guide is [`docs/chat-steer.md`](../chat-steer.md).

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

## Memory Self-Improvement (P0) — complete (5 of 5)

`spec-20260615-memory-self-improve-p0` — upgrades the memory substrate from a distilled
**lessons** index into a queryable **facts** layer that is now produced and reconciled
automatically and fed back into planning. **The plan is complete (5 of 5).** Sprint 1 lands
the storage foundation: the project's **first
relational store** — a bi-temporal SQLite **semantic-facts** store (`src/state/facts.ts`,
`better-sqlite3` behind a swappable `FactStore` class) plus a `bober facts
add|list|show|invalidate` CLI. Facts are `(scope, subject, predicate, value)` rows with
confidence + source-run provenance and four temporal columns; invalidation is a
soft-delete (`t_invalidated`) so nothing is ever destroyed. The store is **pure** (every
timestamp is a caller parameter — no wall-clock read inside the store), ids are a
deterministic content hash, and the DB file (`.bober/memory/facts.db`) is namespaced by the
active team exactly like the lessons `INDEX.md`. Sprint 2 adds **reconcile-on-write**: fact
writes flow through `reconcileFact` / `writeFact` so a changed value **supersedes** the prior
fact (`supersedeFact` closes both `t_invalidated` and `t_invalid`), an identical value is a
`noop`, and only a deterministic *normalized-key* ambiguity consults an injected LLM
`FactJudge` (with an `add` fallback) — the exact-match path stays LLM-free, and `bober facts
add` now dedupes/supersedes instead of duplicating. Still not wired into planning — producers
and a retrieval path are later sprints. Sprint 3 turns to the **lessons** store and closes its
monotonic-growth gap: ranking in `retrieveRelevantLessons` becomes **occurrence-weighted** (a
more-often-seen lesson wins on equal token overlap; overlap stays dominant), and a new **pure
hygiene pass** (`pruneLessons`) plus `bober memory prune` quarantine stale/low-occurrence and
deterministically-contradictory lessons into a `QUARANTINE.md` sidecar — moving the literal
`INDEX.md` line with provenance and **never deleting** the per-lesson `.md`. Sprint 4 mines a
signal the generator↔evaluator retry loop previously discarded: the pure `distill()` gains a
fourth signal **(d) fail→pass contrast** that detects a contract whose `iterationHistory` shows
one or more fails **followed by** a pass and emits a `fix-contrast:<contractId>` lesson (tags
`phase:fix-contrast` + `sprintId:<id>`, refs citing the failing iterations and the passing one).
First-iteration passes, all-fail histories, and pass-before-fail are not transitions; the signal
is additive (a reworked-then-passed sprint also keeps its `sprint-rework` lesson) and stays
byte-stable and pure. Sprint 5 **closes the plan** with the **auto-producer + retrieval**: a pure
`detectProjectFacts({ packageJson, boberConfig, lockfiles })` maps manifests/config into project-fact
drafts (`testCommand`, `buildCommand`, `packageManager`, `framework`), and a thin `seedProjectFacts()`
IO caller writes them through Sprint 2's idempotent `writeFact` near the start of `runPipeline` and at
chat-session startup — both **guarded** so a facts failure never aborts a run. A new
`retrieveRelevantFacts` + `serializeFactsForContext` pair injects scope-isolated active facts (SQL
`WHERE scope=? AND t_invalidated IS NULL`, deterministic token-overlap rank, hard `charBudget` slice)
into the planner's context alongside the lessons path. No LLM runs on the produce path (the only LLM
remains Sprint 2's reconcile ambiguity branch). With this, the memory layer now has **two stores fed
back into planning**: durable bi-temporal facts and hygienic distilled lessons.

| # | Record | What it added |
|---|--------|---------------|
| 1 | [sprint-spec-20260615-memory-self-improve-p0-1.md](./sprint-spec-20260615-memory-self-improve-p0-1.md) | Bi-temporal SQLite `FactStore` (`insertFact`/`getActiveFacts`/`getFact`/`invalidateFact`/`close`, deterministic `factId`, namespaced `facts.db`) + `bober facts add\|list\|show\|invalidate` CLI; `better-sqlite3` is the first relational dependency |
| 2 | [sprint-spec-20260615-memory-self-improve-p0-2.md](./sprint-spec-20260615-memory-self-improve-p0-2.md) | Reconcile-on-write: pure `reconcileFact`/`writeFact` (`add`/`update`/`delete`/`noop`) — deterministic exact-match supersede (`FactStore.supersedeFact` sets both bi-temporal fields) + NOOP, with an injected `FactJudge`/`createLLMFactJudge()` consulted **only** on normalized-key ambiguity and an `add` fallback; `bober facts add` routes through `writeFact` with action-aware output |
| 3 | [sprint-spec-20260615-memory-self-improve-p0-3.md](./sprint-spec-20260615-memory-self-improve-p0-3.md) | Lessons-store hygiene: occurrence-weighted `retrieveRelevantLessons` ranking (overlap DESC → occurrences DESC → lessonId ASC, C1 preserved) + pure `pruneLessons(records,{now,...}) → {kept,quarantined}` (deterministic decay + conflict-quarantine) + `quarantinePath`/`rewriteIndexForQuarantine` (moves literal `INDEX.md` lines → `QUARANTINE.md` with provenance, never deletes `.md`) + `bober memory prune` CLI |
| 4 | [sprint-spec-20260615-memory-self-improve-p0-4.md](./sprint-spec-20260615-memory-self-improve-p0-4.md) | Fail→pass contrast extractor: pure `distill()` gains signal **(d)** — detects a contract whose `iterationHistory` shows fail(s) **followed by** a pass and emits a `fix-contrast:<contractId>` lesson (tags `phase:fix-contrast` + `sprintId:<id>`, refs citing the failing iterations + the passing one); first-iteration-pass / all-fail / pass-before-fail are not transitions; additive (reworked-then-passed sprint also keeps its `sprint-rework` lesson), byte-stable, no LLM/clock/fs |
| 5 | [sprint-spec-20260615-memory-self-improve-p0-5.md](./sprint-spec-20260615-memory-self-improve-p0-5.md) | **Finale** — auto-producer + retrieval: pure `detectProjectFacts({packageJson,boberConfig,lockfiles})` → project-fact drafts (`testCommand`/`buildCommand`/`packageManager`/`framework`) + thin `seedProjectFacts()` IO caller (one clock stamp, idempotent `writeFact`) wired **guarded** into `runPipeline` (`pipeline.ts:1030`) and `ChatSession.start()` (`chat-session.ts:504`) so a facts failure never aborts a run; `retrieveRelevantFacts` (scope-isolated `getActiveFacts(scope)` SQL + deterministic token-overlap rank) + `serializeFactsForContext` (hard `charBudget` slice) injected into the planner `userMessage` (`planner-agent.ts`, guarded); no LLM on the produce path |

The facts store is documented alongside the lessons store in
[`docs/self-improvement-memory.md`](../self-improvement-memory.md) ("Semantic Facts Store"); the
lessons-store hygiene/prune lifecycle is in the same guide ("Lesson Hygiene: Prune & Quarantine"),
and the four distill signals — including Sprint 4's fail→pass `fix-contrast` signal — are listed
under "Distilling Lessons from History".

## Self-Improvement P1/P2 (Phase 5) — in progress (2 of 4)

`spec-20260615-self-improve-p1-p2` — Phase 5 of the self-improvement effort: make
self-improvement **safe to enable** before it is allowed to act. Sprint 1 lands the **storage
foundation** of the replay regression harness — a pure, SQLite-backed `ReplayStore`
(`src/orchestrator/selfimprove/replay-store.ts`) cloning the `FactStore` discipline
(`better-sqlite3` behind a swappable class, `:memory:`-testable, no clock read inside the
store, every statement parameterized, deterministic content-hash `caseId`), immutable per-case
JSON fixtures under `.bober/replay/cases/`, a `replay_cases` baseline index in
`.bober/replay/replay.db`, an **off-by-default** `selfImprove` config section
(`deterministicGate` / `rubricIsolation` / `requireCitedArtifact` each `.default(false)` +
`replayDir`, wired `.optional()` into `BoberConfigSchema`), and a `bober replay
capture|list|show` CLI that ingests existing `.bober/eval-results/eval-*.json` into the frozen
corpus. **No live pipeline file is touched and no LLM call is made.** Sprint 2 lands the
**regression gate** that *acts* on that corpus: a PURE `compareToBaseline(baseline, fresh)`
comparator (no clock/fs/LLM) that classifies each baseline caseId as a **regression** (baseline
`pass` → fresh `fail`), an **improvement** (`fail` → `pass`), or **unchanged**; an async
`runReplayHarness(projectRoot, config)` that opens the Sprint 1 `ReplayStore` and re-derives each
fresh verdict **deterministically from the frozen `eval_details_json`** (`fail` iff any captured
failure has `passed === false` AND `severity === 'error'`) — **never** re-running the generator or
evaluator LLM (grep-verified: zero `runGeneratorAgent`/`runEvaluatorAgent`/`createClient` refs);
and a `bober replay run` verb that prints a `CASE ID | BASELINE | FRESH | DELTA` table and **exits
1 on any regression** (0 on a clean/improvement-only corpus, `no cases captured` + 0 on an empty
one). `runReplayHarness` is the public function **Sprint 4's GEPA `evolve` verb imports as its
promotion gate**. Still no pipeline/LLM touch and the Sprint 1 `ReplayStore` schema is unchanged.
The evaluator guards (Sprint 3) and the GEPA evolve loop (Sprint 4) are still to come — which is
why every `selfImprove` flag defaults to `false`.

| # | Record | What it added |
|---|--------|---------------|
| 1 | [sprint-spec-20260615-self-improve-p1-p2-1.md](./sprint-spec-20260615-self-improve-p1-p2-1.md) | Pure SQLite `ReplayStore` (`putCase`/`getCase`/`listCases`/`getBaselineVerdict`/`close`, deterministic `caseId` = `sha256(contractId\|iteration\|diffDigest).slice(0,16)`, `:memory:`-testable, no clock read in class) + immutable `.bober/replay/cases/*.json` fixtures + `replay_cases` baseline DB; off-by-default `SelfImproveSectionSchema` (`deterministicGate`/`rubricIsolation`/`requireCitedArtifact` `.default(false)` + `replayDir`) wired `.optional()` into `BoberConfigSchema`; `bober replay capture\|list\|show` CLI ingesting `.bober/eval-results/eval-*.json`; reuses existing `better-sqlite3` (no new dep), no pipeline/LLM touch |
| 2 | [sprint-spec-20260615-self-improve-p1-p2-2.md](./sprint-spec-20260615-self-improve-p1-p2-2.md) | The replay **gate**: PURE `compareToBaseline(baseline, fresh)` → `{ regressions (baseline pass→fresh fail), improvements (fail→pass), unchanged }` (sorted, no clock/fs/LLM) + async `runReplayHarness(projectRoot, config)` re-deriving fresh verdicts **deterministically from frozen `eval_details_json`** (NO LLM — zero `runGeneratorAgent`/`runEvaluatorAgent`/`createClient`) → `{ …, total, baseline, fresh }`; `bober replay run` per-case delta table, **exit 1 on regression** / 0 clean / `no cases captured` empty; tolerant `loadConfig`, never-throws. `runReplayHarness` is **Sprint 4's GEPA promotion gate**; ReplayStore schema + pipeline/agents untouched |

The replay harness is documented in
[`docs/self-improvement-memory.md`](../self-improvement-memory.md) ("Replay Regression Harness
(Phase 5)"), including the off-by-default invariant, the `bober replay` CLI (now `capture|list|show|run`),
the [replay gate](../self-improvement-memory.md#the-replay-gate-sprint-2) (`replay run` /
`runReplayHarness` / `compareToBaseline` semantics + the deterministic no-LLM fresh-verdict rule),
the `selfImprove` config section, and the Sprints 2–4 roadmap.
