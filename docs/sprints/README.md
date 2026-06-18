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

## Fleet Expand (decomposer) — complete (2 of 2)

`spec-20260617-fleet-expand-decomposer` — Phase 2 of the fleet orchestrator: let a single
high-level **goal** string be decomposed into a multi-child `FleetManifest` (the manifest the
merged Phase 1 `fleet <manifest>` runner already executes). **The plan is complete (2 of 2)
and the feature is user-facing.** Sprint 1 lands the **risk-first
core** — a pure `src/fleet/decomposer.ts` module whose `decomposeGoal({ goal, client, model,
maxRetries })` turns one goal into a children-only, Zod-valid `FleetManifest` via a single
DeepSeek `LLMClient.chat` call (`jsonObjectMode: true`, **not** `responseSchema` — DeepSeek
rejects strict `json_schema`) plus at most **one** bounded coercion re-prompt. A per-child
guard rejects any child carrying a `config` key *beyond* `FleetManifestSchema.safeParse`
(`FleetChildSchema.config` is optional, so the explicit `hasOwnProperty` check is what keeps
decomposed children folder/task-only), and the JSON-extraction + coercion shape mirrors
`parsePlanSpec` in `planner-agent.ts`. The module is **purely additive** — no CLI, no spawn,
no network, no fs, no Phase 1 file touched — and is proven entirely against a fake `LLMClient`
(22 collocated tests; ≤2 `chat` calls; bad-then-good = 2 calls, bad-then-bad throws with the
formatted Zod issues). Sprint 2 ships the **user-facing CLI** that consumes `decomposeGoal`:
a new `agent-bober fleet expand <goal>` subcommand attached as a sibling of the locked
`fleet <manifest>` runner (byte-identical registration). It builds the DeepSeek client with a
**credential fail-fast before any IO** (missing `DEEPSEEK_API_KEY` → exit 1, no file written,
`decomposeGoal` never reached), assembles `{ rootDir, concurrency, children }`, **atomically
writes** it to `<root>/.bober/fleet-expand.json` (temp+rename, overwrite notice; `--out`
redirects), prints the manifest + a `Review then run: agent-bober fleet "<outPath>"` hint, and
**stops by default** (exit 0, no spawn). The only `runFleet(outPath)` call site sits inside
`if (opts.yes)` — the write-and-stop review gate is the **sole** spawn gate (no TTY check, no
interactive prompt). Options: `--count` (soft target), `--provider`, `--model` (decomposer LLM
only), `--root`, `--concurrency`, `--out`, `--yes`. The action body is the exported testable
seam `runFleetExpand(goal, opts, deps?)` with injectable `decompose` / `runFleet` / `createClient`
(14 collocated tests, no network/spawn); `runFleet` / `FleetManifestSchema` / `buildChildConfig`
are untouched.

| # | Record | What it added |
|---|--------|---------------|
| 1 | [sprint-spec-20260617-fleet-expand-decomposer-1.md](./sprint-spec-20260617-fleet-expand-decomposer-1.md) | Pure `decomposeGoal` (goal → Zod-valid children-only `FleetManifest`): one `jsonObjectMode:true` DeepSeek call + one bounded coercion re-prompt, `validateManifest` JSON-extract (`direct→`` ```json ``fence→first-brace`) + `safeParse` + post-parse `config`-key guard, `DECOMPOSE_SYSTEM_PROMPT` / `DECOMPOSE_COERCION_INSTRUCTION` / `DECOMPOSE_MAX_RETRIES=1`; no CLI/spawn/network/fs, no Phase 1 file touched |
| 2 | [sprint-spec-20260617-fleet-expand-decomposer-2.md](./sprint-spec-20260617-fleet-expand-decomposer-2.md) | **Finale** — user-facing `agent-bober fleet expand <goal>` subcommand: credential fail-fast (no write) → `decomposeGoal` → assemble `{rootDir,concurrency,children}` → atomic temp+rename write to `<root>/.bober/fleet-expand.json` (overwrite notice, `--out` redirect) → print manifest + review hint → **write-and-stop by default**, `runFleet(outPath)` only inside `if (opts.yes)`; exported `runFleetExpand(goal,opts,deps?)` seam + `registerFleetExpandSubcommand`; `fleet <manifest>` registration byte-identical |

User-facing usage lives in [`COMMANDS.md`](../../COMMANDS.md) under **Fleet Commands**
(`agent-bober fleet <manifest>` and `agent-bober fleet expand <goal>`).

The fleet orchestrator's architecture is in `.bober/architecture/` under
`arch-20260609-fleet-orchestrator-tech-lead-*` (Phase 1, the `fleet <manifest>` runner) and
`arch-20260617-fleet-orchestrator-phase-2-expand-*` (this phase, goal → manifest).

## Fleet Expand Deep (robust two-stage decomposition) — complete (2 of 2)

`spec-20260618-fleet-expand-deep` — Phase 3 of the fleet orchestrator: a **robust** goal
decomposer for very large or ambiguous goals where Phase 2's single-shot `decomposeGoal` yields
one giant low-quality child or fails validation. **The plan is complete (2 of 2) and the feature
is user-facing.** Sprint 1 lands the **engine core** — a new
sibling module `src/fleet/decomposer-deep.ts` whose `decomposeGoalDeep({ goal, client, model,
count?, planMaxRetries?, expandMaxRetries? })` runs a bounded **PLAN → EXPAND** loop instead of a
single pass: `runPlanStage` makes one bounded DeepSeek call (`jsonObjectMode: true`, **not**
`responseSchema`) to produce a **transient, in-memory** `Outline` (`{ areas: [{ name, intent }] }`)
gated by a never-throwing `validateOutline`, then `runExpandStage` makes one bounded call to turn
that outline into a children-only `FleetManifest` validated through `validateManifest` **imported
verbatim** from `decomposer.ts` (inheriting its JSON-extract + `FleetManifestSchema.safeParse` +
per-child `config`-key guard). Both stages mirror Phase 2's `maxAttempts = 1 + maxRetries` loop and
3-message `[user, assistant, user]` coercion shape, and the whole run is capped at a fixed
`DEEP_MAX_TOTAL_CALLS = 4` (= `(1+DEEP_PLAN_MAX_RETRIES)+(1+DEEP_EXPAND_MAX_RETRIES)`, both `= 1`);
a PLAN exhaustion stops at 2 calls and never reaches EXPAND. The module is **engine-only and
additive** — no CLI, no disk IO, no network, and the byte-locked Phase-2
decomposer/manifest/CLI (`decomposeGoal`, `FleetManifestSchema`, `fleet expand`, the `--yes` gate)
are untouched — proven entirely against a fake `LLMClient` (both calls asserted
`jsonObjectMode:true` + `responseSchema:undefined`; budget ≤4). Sprint 2 ships the **user-facing
CLI** that wraps `decomposeGoalDeep`: a new `agent-bober fleet expand-deep <goal>` subcommand
attached additively in `src/fleet/index.ts` as a sibling of the locked `fleet <manifest>` runner
and Phase-2 `fleet expand`. It mirrors `runFleetExpand` step-for-step — **credential fail-fast
before any IO** (missing `DEEPSEEK_API_KEY` → exit 1, no file written, decompose never reached),
assemble `{ rootDir, concurrency, children }`, **atomic temp+rename write** to
`<root>/.bober/fleet-expand.json` (overwrite notice, `--out` redirect), print the manifest + a
`Review then run: agent-bober fleet "<outPath>"` hint, and **write-and-stop by default** — and
differs in exactly one line: it calls `decomposeGoalDeep` instead of `decomposeGoal`. The only
`runFleet(outPath)` call sits inside `if (opts.yes)` (the **sole** spawn gate; the write precedes
it, so the manifest exists on disk before any spawn). Same seven options as `expand`
(`--count`/`--provider`/`--model`/`--root`/`--concurrency`/`--out`/`--yes`); the exported testable
seam is `runFleetExpandDeep(goal, opts, deps?)` with injectable `decomposeDeep`/`runFleet`/
`createClient`. The evaluator confirmed the change is **purely additive** (only `src/fleet/index.ts`
+ a new test, zero deleted lines): `fleet <manifest>`, `fleet expand`/`runFleetExpand`,
`FleetManifestSchema`, `buildChildConfig`, and `src/cli/index.ts` are byte-unchanged. Full suite:
2294 passed.

| # | Record | What it added |
|---|--------|---------------|
| 1 | [sprint-spec-20260618-fleet-expand-deep-1.md](./sprint-spec-20260618-fleet-expand-deep-1.md) | Engine core `decomposeGoalDeep` (bounded **PLAN → EXPAND**, goal → Zod-valid children-only `FleetManifest`): `runPlanStage` → never-throwing `validateOutline` → transient in-memory `Outline`, then `runExpandStage` → **imported** `validateManifest`; both `jsonObjectMode:true`/no `responseSchema`, 3-message coercion, fixed `DEEP_MAX_TOTAL_CALLS=4` (`DEEP_PLAN_MAX_RETRIES`/`DEEP_EXPAND_MAX_RETRIES=1`); engine-only, no CLI/spawn/network/fs, Phase-2 path byte-locked |
| 2 | [sprint-spec-20260618-fleet-expand-deep-2.md](./sprint-spec-20260618-fleet-expand-deep-2.md) | **Finale** — user-facing `agent-bober fleet expand-deep <goal>` subcommand wrapping `decomposeGoalDeep`: credential fail-fast (no write) → two-stage decompose → assemble `{rootDir,concurrency,children}` → atomic temp+rename write to `<root>/.bober/fleet-expand.json` (overwrite notice, `--out` redirect) → print manifest + review hint → **write-and-stop by default**, `runFleet(outPath)` only inside `if (opts.yes)`; exported `runFleetExpandDeep(goal,opts,deps?)` seam + `registerFleetExpandDeepSubcommand` (same 7 options as `expand`); differs from `runFleetExpand` in one line (`decomposeGoalDeep` vs `decomposeGoal`); `fleet <manifest>` + `fleet expand` registrations byte-identical |

User-facing usage lives in [`COMMANDS.md`](../../COMMANDS.md) under **Fleet Commands**
(`agent-bober fleet <manifest>`, `agent-bober fleet expand <goal>`, and
`agent-bober fleet expand-deep <goal>`).

This phase's architecture is in `.bober/architecture/` under
`arch-20260617-fleet-robust-decomposition-*` (extends Phase 1
`arch-20260609-fleet-orchestrator-tech-lead-*` and Phase 2
`arch-20260617-fleet-orchestrator-phase-2-expand-*`).

## Fleet Critique Loop (self-judged expand-deep gate) — complete (2 of 2)

`spec-20260618-fleet-expand-deep-critique` — Phase 4 of the fleet orchestrator: add a
**self-judged critique gate** to `fleet expand-deep` so a shape-valid-but-degenerate manifest
(e.g. 2 children for a 12-area outline) is caught before it reaches the human write-and-stop
review. A **fresh LLM critic** returns a boolean `approve | reject` verdict plus free-text
feedback; on **reject** the manifest is re-expanded through a fresh `runExpandStage` seeded with
that feedback, bounded by a single round and a closed-form budget `DEEP_CRITIQUE_MAX_TOTAL_CALLS =
8`. On every failure mode the gate **fails open / accepts-best** and never throws, so behavior
degrades to Phase 3 and never below it. **The plan is complete (2 of 2) and the feature is
user-facing.**

Sprint 1 (engine + opt-in threading) is the bounded fresh-critic loop in a new module
`src/fleet/critic-deep.ts`: `validateVerdict` (tolerant JSON-extract + Zod `CritiqueVerdictSchema`,
mirrors `validateOutline`, never throws) → `callCritic` (its **own** clean `CRITIQUE_SYSTEM_PROMPT`,
manifest presented as a third-party "review this", `jsonObjectMode:true` / no `responseSchema`,
3-message coercion) → `getCriticVerdict` (**fail-open** to `{verdict:"approve"}` after 2 unparseable
responses) → `runCritiqueLoop` (`reject` → fresh `runExpandStage({ critiqueFeedback })` →
**accept-best** on exhaustion, tiebreak most children then baseline, never throws, ≤8 calls). Three
**additive** edits thread it into `src/fleet/decomposer-deep.ts`: `DecomposeDeepInput.critique?`,
a `critiqueFeedback?` appended to the first EXPAND user turn only when present, and
`decomposeGoalDeep` routing into `runCritiqueLoop` **only** when `critique===true`. With `critique`
absent/false the chat sequence is **byte-identical to Phase 3** (zero critic calls, ≤4 chat). The
evaluator confirmed the change is purely additive (`decomposer-deep.ts` 16 insertions, **0 deleted
lines**): `decomposer.ts`, `manifest.ts` (`FleetManifestSchema`), `src/fleet/index.ts` (the
`fleet`/`expand`/`expand-deep` CLI), and `providers/` are byte-unchanged. **Engine-only — no CLI
this sprint.**

Sprint 2 ships the **user-facing flag** that exposes the engine: a `--critique` boolean on the
existing `agent-bober fleet expand-deep <goal>` subcommand. Three additive edits in
`src/fleet/index.ts` thread it — `FleetExpandDeepOptions.critique?`, a
`.option("--critique", …)` beside the existing seven options, and a guarded spread
`...(opts.critique ? { critique: true } : {})` on the `decomposeGoalDeep` call in
`runFleetExpandDeep`. With `--critique` the decomposition routes through Sprint 1's
`runCritiqueLoop` (one bounded round, accept-best, budget 8) **after** the structural
`validateManifest` gate and **before** the atomic write; without it the decompose argument object
is **byte-identical to Phase 3** (the `critique` key is *absent*, not `undefined`) and emits zero
extra chat calls. No sibling subcommand was added (LOCK2): `--critique` is a flag on the existing
command, and the byte-locked tree (`fleet <manifest>` positional + `--concurrency`/`--root` and the
`fleet expand` subcommand) is intact. Spawn-safety is unchanged on the `--critique` path —
credential fail-fast (no file on missing key), write-before-spawn, and `--yes` as the sole spawn
gate all hold. The evaluator confirmed the change is purely additive (`src/fleet/index.ts` +1 new
test; the lone deleted line is the intended rewrite of the single-line decompose call into the
multi-line guarded-spread form): `decomposer-deep.ts`, `critic-deep.ts`, `decomposer.ts`,
`manifest.ts`, and `src/cli/index.ts` are byte-unchanged. All 14 fleet suites (188 tests) plus 9
new `expand-deep-critique` tests are green.

| # | Record | What it added |
|---|--------|---------------|
| 1 | [sprint-spec-20260618-fleet-expand-deep-critique-1.md](./sprint-spec-20260618-fleet-expand-deep-critique-1.md) | Engine `src/fleet/critic-deep.ts` (bounded fresh-critic critique/refine loop): `validateVerdict` (never-throw, mirrors `validateOutline`) + `callCritic` (own `CRITIQUE_SYSTEM_PROMPT`, third-party framing, `jsonObjectMode:true`/no `responseSchema`, 3-message coercion) + `getCriticVerdict` (fail-open `approve` after 2 parse fails) + `runCritiqueLoop` (`reject`→fresh `runExpandStage({critiqueFeedback})`→accept-best, never throws, ≤`DEEP_CRITIQUE_MAX_TOTAL_CALLS=8`); constants `CRITIQUE_MAX_ROUNDS=1`/`CRITIQUE_PARSE_MAX_RETRIES=1` + closed-form budget audit test; additive `decomposer-deep.ts` threading (`critique?`, `critiqueFeedback?`, `decomposeGoalDeep` routing) byte-identical Phase 3 when absent; **engine-only, no CLI**, Phase-2/3 decomposer/manifest/CLI byte-locked |
| 2 | [sprint-spec-20260618-fleet-expand-deep-critique-2.md](./sprint-spec-20260618-fleet-expand-deep-critique-2.md) | **Finale** — user-facing `--critique` flag on `agent-bober fleet expand-deep <goal>`: additive `FleetExpandDeepOptions.critique?` + `.option("--critique", …)` (beside the existing 7 options) + guarded spread `...(opts.critique ? { critique: true } : {})` on the `decomposeGoalDeep` call in `runFleetExpandDeep`, routing into Sprint 1's `runCritiqueLoop` (one round, accept-best, budget 8) **after** `validateManifest`, **before** the atomic write; **opt-in (default off = byte-identical to Phase 3** — `critique` key *absent*, zero extra chat calls); **no sibling subcommand (LOCK2)**, byte-locked command tree intact; spawn-safety (credential fail-fast, write-before-spawn, `--yes` sole gate) unchanged; the lone deleted line is the intended decompose-call rewrite, all other fleet modules + `src/cli/index.ts` byte-unchanged |

User-facing usage lives in [`COMMANDS.md`](../../COMMANDS.md) under **Fleet Commands** — the
`--critique` flag is documented under `agent-bober fleet expand-deep <goal>` (opt-in; default off
is byte-identical to plain `expand-deep`).

This phase's architecture is in `.bober/architecture/` under
`arch-20260618-fleet-expand-deep-critique-*` (ADR-1 loop structure / boolean critic / accept-best;
ADR-2 opt-in `critique` field preserves byte-identical Phase-3 default; ADR-3 verdict parse mirrors
`validateOutline`, closed-form fail-open coercion budget; ADR-4 reuse `runExpandStage` as the
re-expand seam; ADR-5 critic after `validateManifest`, before the atomic write). It extends Phase 1
`arch-20260609-fleet-orchestrator-tech-lead-*`, Phase 2
`arch-20260617-fleet-orchestrator-phase-2-expand-*`, and Phase 3
`arch-20260617-fleet-robust-decomposition-*`.

## Fleet Manifest Provenance — complete (1 of 1)

`spec-20260618-fleet-manifest-provenance` — an **ADR-4-preserving follow-up** to the fleet
`expand` / `expand-deep` **shared-default-path clobber risk** surfaced by
`research-20260618-fleet-branch-merge-readiness`. Both subcommands write the same default
manifest path (`<root>/.bober/fleet-expand.json`), so a second decompose silently overwrote the
first. Rather than split the path (which would re-open the ADR-4 single-shared-default-path
decision), this single sprint makes the overwrite **recoverable and self-documenting**: a new
shared helper `writeManifestWithProvenance` (`src/fleet/manifest-write.ts`) routes both
subcommands' Step-4 writes through one path that (a) emits a provenance sidecar
`<outPath>.meta.json` (`{ command, goal, critique, childCount, timestamp }`), (b) on overwrite
**moves the prior manifest to `<outPath>.bak` before** atomically writing the new one (so the
previous manifest is always recoverable), and (c) prints an **informative, non-blocking** notice
(with a prior sidecar: which command/goal/childCount produced it and its relative age; without
one: a generic notice that still states a `.bak` was kept). `sidecarPath`/`bakPath` derive from
the actual `outPath`, so `--out <custom>` writes `<custom>.meta.json`/`<custom>.bak` and never
touches the default. The on-disk manifest (`FleetManifestSchema`, children-only) is **unchanged**
— provenance lives only in the sidecar — and the shared default path is **deliberately
unchanged**. The clock is injectable for deterministic timestamps + relative-age strings (the tmp
filename still uses the real `Date.now` to stay collision-free). The evaluator confirmed only 5
files changed; `manifest.ts`, `decomposer*.ts`, `critic-deep.ts`, and `runFleet` are untouched,
the `--yes` gate + write-and-stop default are unchanged, and the written manifest still parses
`FleetManifestSchema`-valid with no provenance keys. **The plan is complete (1 of 1).**

| # | Record | What it added |
|---|--------|---------------|
| 1 | [sprint-spec-20260618-fleet-manifest-provenance-1.md](./sprint-spec-20260618-fleet-manifest-provenance-1.md) | Shared `writeManifestWithProvenance` (`src/fleet/manifest-write.ts`): provenance sidecar `<outPath>.meta.json` + recoverable overwrite (`rename` prior manifest → `<outPath>.bak` **before** atomic tmp+rename write) + informative non-blocking notice (`formatRelativeAge` buckets `just now`/`Nm`/`Nh`/`Nd`; missing/corrupt prior sidecar → generic notice, never throws); `sidecar`/`.bak` derived from `outPath`; injectable `now()` clock; both `fleet expand` (`critique:false`) and `fleet expand-deep` (`critique:opts.critique===true`) Step-4 blocks rewired through it with the **raw** `goal`; manifest schema + shared default path + `--yes` gate unchanged (ADR-4 preserved) |

User-facing usage lives in [`COMMANDS.md`](../../COMMANDS.md) under **Fleet Commands** — the
provenance sidecar (`.meta.json`) and recoverable overwrite (`.bak` + notice) are documented
under both `agent-bober fleet expand <goal>` and `agent-bober fleet expand-deep <goal>`.
