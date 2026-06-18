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

## Medical Team — complete (7 of 7)

`spec-20260616-medical-team` — Phase 6 of the chattable multi-agent platform: a
domain-specific **medical** team running a guardrailed Standard-Operating-Procedure
(SOP) pipeline (consent/red-flag gates, JS-native numerics, ingestion, egress guard,
literature retrieval) on top of the team abstraction. Sprint 1 is the **risk-first
integration linchpin** — additive plumbing + skeleton only. It threads a new
`medical-sop` orchestration engine name through every place the engine union is
mirrored (the `PipelineEngineName` TS union at `engine.ts:7`, the
`PipelineSectionSchema.engine` Zod enum at `schema.ts:220`, the
`TeamConfigSchema.pipelineShape` Zod enum at `schema.ts:366`, and **both** exhaustive
`never`-guarded selector switches in `selector.ts`), and stands up a new `src/medical/`
module with a **stub** `MedicalSopEngine` (`run` returns a trivial `PipelineResult`,
no LLM/SDK), the `GuardrailSet`/`GuardrailVerdict`/`GuardrailContext`/`MedicalAnswer`
type surface, and `buildMedicalTeam(config)`. `loadTeam(config, "medical")` now
resolves to a **code-registered built-in** `medical` team (`pipelineShape "medical-sop"`,
`memoryNamespace "medical"`, a concrete allow-all stub `GuardrailSet` in its `guardrails`
slot). The `medical-sop` config-path selector case is a **defensive exhaustiveness branch**
(falls through to `TsPipelineEngine`) because `config.pipeline.engine` is never legitimately
`medical-sop` — so the `ts`/`skill`/`workflow` engines and the programming team stay
**byte-identical** (regression-verified). Sprint 2 lands the **first code-enforced gate
and the audit substrate**: a fail-closed `ConsentGate` wired as Gate 1 of
`MedicalSopEngine.run` (absent consent ⇒ refuse `MedicalAnswer` with **zero** downstream
calls), an append-only mode-0600 `AuditLog` writing IDs/enums-only entries to
`.bober/medical/audit-<date>.jsonl` (never prompt text or health values), and a versioned
`DisclaimerComposer` footer attached to every answer — all on injected timestamps. Sprint 3
lands the **headline safety guarantee — Gate 2, the deterministic red-flag emergency
short-circuit**: a pure/synchronous `RedFlagDetector` (`src/medical/red-flag.ts`, zero
imports) classifies a prompt into `cardiac` / `stroke` / `anaphylaxis` / `self-harm` /
`overdose` / `none` over a versioned `PATTERNSET_VERSION` (conservative case-insensitive
phrase matching, self-harm/overdose ordered first so 988 wins over 911), and the real
`MedicalGuardrails` (`src/medical/guardrails.ts`) replaces the S1–S2 allow-only stub — its
`evaluate` throws on an empty prompt and returns a `short-circuit` verdict with a **canned,
never-model-generated** 911/988 escalation on any match. `MedicalSopEngine.run` runs this
guardrail **immediately after the consent gate and before any numerics/LLM**: a match returns
the canned escalation `MedicalAnswer` (`shortCircuit: true`) with the disclaimer footer + a
PHI-free `short-circuit` audit entry (`ruleId` + `rulesetVersion` + `patternsetVersion`) and
reaches **zero** downstream calls. `MedicalSopDeps` gained real `llmClient?: LLMClient` +
`numerics?` injection slots (the Sprint 2 carry-forward fix) so spies prove the never-called
guarantee. Detection is deliberately conservative (ADR-2): novel phrasing may miss and fall
through to the normal path — advisory false-negative gaps are surfaced to the patternset
revision / S6.5 counsel review. Sprint 4 lands the **data + numerics layer that keeps
arithmetic out of the LLM (ADR-3)**: a synchronous `better-sqlite3` `HealthDataStore`
(`src/medical/health-store.ts`) mirroring `FactStore` — three tables
(`health_observations` + `lab_results` + `kv_store`), a deterministic SHA-256
`observationId(metric|tStart|source|value)`, `INSERT OR IGNORE` dedup, and
`upsertObservations` returning the **NEW-row count only** — plus a `NumericsQueryLayer`
(`src/medical/numerics.ts`) exposing a **closed 8-primitive whitelist**
(`mean | min | max | latest | delta | slope | percentile | zscore`) via an exhaustive
`never`-guarded `switch`, plus `getLabTrend`. There is **no `eval` / `Function` / `vm` /
`child_process` / `execa`** anywhere in the layer — the LLM never does arithmetic, and
adding a computation requires extending `NumericPrimitive` (a code-review event).
`getMetric` never throws; it distinguishes a true **abstain** (empty window ⇒
`{value:null, sampleCount:0}`) from a code-enforced **cross-unit refusal** (mixed units ⇒
`{value:null, sampleCount:N>0}`) — `zscore` n<2 and degenerate-slope similarly return null
with `sampleCount:N`. The numeric/lab type surface was added additively to
`src/medical/types.ts`. The 3-table shape deviates from the contract summary's "single
generic events table" wording (each of labs/baselines/preferences has a distinct shape);
the deviation was flagged by the generator and accepted by the evaluator since no
`sc-4` criterion mandates a single table. Sprint 5 lands the **streaming
ingestion** that fills that store: an `IngestionNormalizer` holds an `IngestionAdapter`
**registry** and drives `importFile(path)` through the first adapter that `canHandle`s the
file, into the store via an async `ObservationSink` (`StoreObservationSink` accumulates the
NEW-row count across all batches). The first adapter, `AppleHealthAdapter`
(`src/medical/adapters/apple-health.ts`), stream-parses Apple Health `export.xml` via **SAX**
(`sax@1.6.0`, a pure-JS no-network dep **isolated to the adapter file**): the file is opened
with `createReadStream` and consumed as an async iterable, each `<Record>` open tag maps to a
`HealthObservation` (`type→metric`, `value→value` via `parseFloat` with non-numeric records
**skipped**, `unit→unit`, `startDate→tStart`, `endDate→tEnd`, constant `source:"apple-health"`),
and at `BATCH_CAP` (1000) the loop `await`s `sink.writeBatch` before pulling the next chunk —
the `for-await` `await` **is** the backpressure, so rows never accumulate unbounded and the
whole (~multi-GB) document is never read into memory. Re-import is **idempotent** via the S4
`INSERT OR IGNORE` dedup (second run `newRows: 0`, row count unchanged); `importFile` throws
`No ingestion adapter can handle '<path>'` for an unmatched file. A `bober medical import <file>`
CLI command (`src/cli/commands/medical.ts`, registered in `src/cli/index.ts:318`, mirroring
`registerFactsCommand`) opens `.bober/medical/health.db`, runs the import, prints
`records parsed` / `new rows`, and always closes the store. Whoop/CSV adapters stay an
additive future (a new class + `register()`, ADR-4) — explicit non-goals here. Sprint 6 is
the **integration linchpin**: it wires the **full ordered SOP** under a **code-enforced
zero-egress default**. A new `EgressGuard` (`src/medical/egress.ts`) exposes **two
independently opt-in axes** (`cloud-inference`, `literature-retrieval`), both default
**false** (`fromConfig` reads the new optional `medical.egress.{cloudInference,literatureRetrieval}`
config keys via `MedicalSectionSchema` in `schema.ts`); `isAllowed(axis)` reads each axis
independently and `assertAllowed(axis)` **throws** when off. A scoped
`no-restricted-imports` ESLint block over `src/medical/**/*.ts` forbids
`undici`/`got`/`axios`/`node-fetch` + `http`/`https`/`net`/`tls`/`dgram` (+`node:` forms) +
the `fetch` global, with a **single exception override** for
`src/medical/retrieval/medline-source.ts` (flat-config last-match-wins) — the one file
reserved for S7's live MedlinePlus call, which currently holds **no** network import. A
`LiteratureRetriever` (`retrieval/literature.ts`) checks the axis **before** the source and
returns `{ disabled }` **synchronously** when off (the zero-egress proof). Medications are
read via `FactStore.getActiveFacts("medical","patient","takes-medication")` (the bi-temporal
value-of-record, ADR-7) — **never** `HealthDataStore`. `MedicalSopEngine.run` now runs the
full order: **consent → red-flag → numerics → meds → egress gate → retrieve (disabled ⇒
abstain) → disclaimer footer → audit → `PipelineResult`** — and the *ordering itself* is the
safety guarantee: both gates run before any numerics/meds/egress/retrieval/LLM work, so a
refuse/short-circuit reaches **zero** downstream calls. With both axes off, a numeric question
answers from deterministic compute (spy `LLMClient` never called) and a literature question
abstains (`MedlineSource.fetchPassages` never called) — **default outbound bytes = 0**. Both
prior carry-forward test cleanups were folded in (real `llmSpy`/`numericsSpy` injection in the
S2 `sc-2-4` test; `numerics.test.ts` `readFileSync` → async `readFile`). Sprint 7 **closes
the plan** with the **opt-in networked slice**: the real MedlinePlus / NIH (no-auth) grounded
retrieval + cited LLM synthesis. The live `fetch` lands in the **one** ESLint-excepted file
(`retrieval/medline-source.ts`) with `EgressGuard.assertAllowed("literature-retrieval")` as
its **first** statement (runtime defense-in-depth over the static lint boundary); an injectable
`FetchLike` transport (default global `fetch`, only here) lets CI run **fully offline** against a
committed fixture (`__fixtures__/medlineplus-sample.json`) — no live network. `fetchPassages`
parses the `nlmSearchResult` JSON into `Passage[]` and returns `grounded` | `abstain{no-passages}`
| `abstain{source-error}`, **never throwing and never fabricating content**. `synthesize`
(`retrieval/literature.ts`) makes a **single provider-agnostic `LLMClient.chat` call** (local
Ollama `llama3` via `createClient("openai-compat", localhost:11434)` by default, injectable via
`deps.llmClient`) pinned to the passages: it **abstains** unless a passage supports the claim
(empty / `ABSTAIN` model output ⇒ abstained, `citations: []`) and otherwise emits **≥ 1
citation** — there is **no** code path producing a non-abstained answer with zero citations.
The path is **fail-closed at three independent layers** — axis off (`assertAllowed` throws),
source error (`!res.ok` / network throw / empty / malformed), and model unavailable (`llm.chat`
throws) — each ⇒ an abstained `MedicalAnswer` with no clinical assertion; **never fail-open, no
uncited claim**. `cloud-inference` stays **independently off**: the grounded path constructs only
the local/Ollama `LLMClient`, never a cloud provider, with **no** auto-fallback, and enabling
literature retrieval does not enable cloud inference (`EgressGuard(false,true)` keeps
`cloud-inference` false). Wired into `MedicalSopEngine.run`'s grounded branch, which resolves the
`LLMClient` **lazily on that path only** so numeric / disabled / red-flag / abstain turns still
construct **zero** LLM clients. **The plan is engineering-complete (7 of 7); 2393 tests pass.**

| # | Record | What it added |
|---|--------|---------------|
| 1 | [sprint-spec-20260616-medical-team-1.md](./sprint-spec-20260616-medical-team-1.md) | Additive `medical-sop` `PipelineEngineName` member + both mirrored Zod enums widened in lockstep + both exhaustive selector switches extended (team→`MedicalSopEngine`, config→defensive `TsPipelineEngine`); new `src/medical/` module (stub `MedicalSopEngine`, `GuardrailSet`/`GuardrailVerdict`/`GuardrailContext`/`MedicalAnswer` types, `buildMedicalTeam`); built-in `medical` team registered in `loadTeam`; `ts`/`skill`/`workflow` + programming team byte-identical, no SDK leakage in `src/medical/` |
| 2 | [sprint-spec-20260616-medical-team-2.md](./sprint-spec-20260616-medical-team-2.md) | First code-enforced safety gate + audit substrate: fail-closed `ConsentGate` (`.bober/medical/consent.json`) wired as **Gate 1** of `MedicalSopEngine.run` (no consent ⇒ refuse + **zero** downstream calls); append-only mode-0600 `AuditLog` → `.bober/medical/audit-<date>.jsonl`, IDs/enums-only (`AuditEntry`/`AuditEvent`), no PHI; versioned `DisclaimerComposer` footer on every answer; `MedicalSopDeps` DI seam (zero-arg ctor preserved); all timestamps injected via `opts.now` |
| 3 | [sprint-spec-20260616-medical-team-3.md](./sprint-spec-20260616-medical-team-3.md) | **Gate 2 — deterministic red-flag emergency short-circuit (0 LLM/numerics):** pure/sync `RedFlagDetector` (`red-flag.ts`, zero imports, 5 categories + `PATTERNSET_VERSION`, self-harm/overdose first so 988 > 911) + real `MedicalGuardrails` (`guardrails.ts`) replacing the S1–S2 allow-only stub (`evaluate` throws on empty; canned 911/988 escalation never model-generated; `refuse` placeholder → S6); wired into `MedicalSopEngine.run` after consent and before any numerics/LLM (match ⇒ canned `MedicalAnswer` `shortCircuit:true` + PHI-free `short-circuit` audit `ruleId`/`rulesetVersion`/`patternsetVersion`, zero downstream calls); `MedicalSopDeps` += real `llmClient?:LLMClient`/`numerics?` slots (S2 carry-forward fix) so spies prove never-called; conservative matching per ADR-2 (advisory false-negatives surfaced to patternset revision / S6.5 counsel) |
| 4 | [sprint-spec-20260616-medical-team-4.md](./sprint-spec-20260616-medical-team-4.md) | **Data + numerics layer (keeps arithmetic out of the LLM, ADR-3):** sync `better-sqlite3` `HealthDataStore` (`health-store.ts`, mirrors `FactStore`; tables `health_observations`+`lab_results`+`kv_store`; deterministic `observationId`/`labResultId` SHA-256; `INSERT OR IGNORE`; `upsertObservations` returns **NEW-row count only**; `getObservations`/`getLabSeries`/`upsertLabResult`/`getBaseline`/`putBaseline`/`getPreference`/`close`) + `NumericsQueryLayer` (`numerics.ts`, `getMetric` over the **closed 8-primitive whitelist** via exhaustive `never`-guarded `switch` + `getLabTrend`); **no `eval`/`Function`/`vm`/`child_process`/`execa`**; empty-window **abstain** `{value:null,sampleCount:0}` vs. cross-unit **refusal** `{value:null,sampleCount:N>0}`, `zscore` n<2 / degenerate-slope abstain with `sampleCount:N`; numeric/lab types added additively to `types.ts`; 3-table design deviates from the "single generic events table" wording (generator-flagged, evaluator-accepted); store never reads the clock; medications NOT stored here (FactStore value-of-record, S6/ADR-7) |
| 6 | [sprint-spec-20260616-medical-team-6.md](./sprint-spec-20260616-medical-team-6.md) | **EgressGuard + full SOP wiring (zero-egress end-to-end):** `EgressGuard` (`egress.ts`) — two **independent** axes `cloud-inference`/`literature-retrieval`, both default **false**, `isAllowed`/`assertAllowed` (throws off), `fromConfig` over new optional `medical.egress.{cloudInference,literatureRetrieval}` (`MedicalSectionSchema`, `schema.ts`); scoped `no-restricted-imports` ESLint block over `src/medical/**/*.ts` (forbids `undici`/`got`/`axios`/`node-fetch` + `http`/`https`/`net`/`tls`/`dgram`(+`node:`) + `fetch` global) with a **single exception** for `retrieval/medline-source.ts` (flat-config last-match-wins; **no** network import yet — reserved for S7); `LiteratureRetriever` (`retrieval/literature.ts`) checks axis **before** source ⇒ `{ disabled }` **synchronously** when off; medications via `FactStore.getActiveFacts("medical","patient","takes-medication")` (ADR-7, **never** `HealthDataStore`); `MedicalSopEngine.run` runs the **full ordered SOP** (consent → red-flag → numerics → meds → egress → retrieve(disabled⇒abstain) → footer → audit → `PipelineResult`) — gate-ordering **is** the safety guarantee (both gates before any downstream call); **default outbound bytes = 0** (spy `LLMClient` + network spy both zero); both carry-forward cleanups folded in (real `llmSpy`/`numericsSpy` in `sc-2-4`; `numerics.test.ts` async `readFile`) |
| 5 | [sprint-spec-20260616-medical-team-5.md](./sprint-spec-20260616-medical-team-5.md) | **Streaming ingestion + `bober medical import`:** `IngestionNormalizer` (`ingestion.ts`, `register`/`importFile` over an `IngestionAdapter` **registry**; throws `No ingestion adapter can handle '<path>'` when none match) + async `StoreObservationSink` (`writeBatch` → S4 `upsertObservations`/`upsertLabResult`, accumulates `newRows`) + `AppleHealthAdapter` (`adapters/apple-health.ts`, `sax@1.6.0` **isolated to this file**; `createReadStream` as async iterable, never `readFile`; `<Record>` `type→metric`/`value→value` (`parseFloat`, non-numeric **skipped**)/`unit`/`startDate→tStart`/`endDate→tEnd`/const `source:"apple-health"`; `BATCH_CAP` 1000 with `await writeBatch` **as** backpressure; tail flush); `IngestionResult {recordsParsed,newRows}` + `ObservationSink`/`IngestionAdapter` types added additively to `types.ts`; **idempotent re-import** via S4 `INSERT OR IGNORE` (2nd run `newRows:0`); `bober medical import <file>` CLI (`commands/medical.ts`, registered `index.ts:318`, mirrors `registerFactsCommand`, opens `.bober/medical/health.db`, prints counts, always `close()`); Whoop/CSV adapters additive future (ADR-4, non-goals here); **recovery:** first generator attempt crashed on a transient API socket error post-impl, recovered via a focused lint-fix+commit (`aa7f9be`, no logic rework) |
| 7 | [sprint-spec-20260616-medical-team-7.md](./sprint-spec-20260616-medical-team-7.md) | **Finale — opt-in MedlinePlus grounded retrieval + cited synthesis:** real MedlinePlus/NIH (no-auth) `fetch` in the **single** ESLint-excepted `retrieval/medline-source.ts` with `EgressGuard.assertAllowed("literature-retrieval")` **first** (runtime defense-in-depth); injectable `FetchLike` transport (default global `fetch` only here) ⇒ CI offline via committed `__fixtures__/medlineplus-sample.json`; `fetchPassages` parses `nlmSearchResult` → `Passage[]`, returns `grounded` \| `abstain{no-passages}` \| `abstain{source-error}` (never throws/fabricates); `synthesize` (`retrieval/literature.ts`) = **single** provider-agnostic `LLMClient.chat` (local Ollama `llama3` via `createClient("openai-compat",localhost:11434)`, injectable `deps.llmClient`) pinned to passages, **abstains** on empty/`ABSTAIN` (`citations:[]`) else **≥1 citation** (no uncited-claim path); **fail-closed at 3 layers** (axis off / source error / model unavailable ⇒ abstained, never fail-open); `cloud-inference` **independently off** (no cloud provider, no fallback); `Citation` real fields (`title`/`url`/`source:"medlineplus"`); wired into `MedicalSopEngine.run` grounded branch with **lazy** `LLMClient` (numeric/disabled/red-flag/abstain ⇒ 0 LLM clients); **plan engineering-complete (7/7), 2393 tests** |

The medical team's `pipelineShape: "medical-sop"`, its built-in `loadTeam` branch, the
real `MedicalGuardrails` in its `GuardrailSet` slot, the deterministic
`HealthDataStore` + `NumericsQueryLayer` data/numerics layer, the Sprint 5 streaming
ingestion path, the Sprint 6 `EgressGuard` + full SOP wiring + zero-egress posture, and
the Sprint 7 MedlinePlus grounded retrieval + cited synthesis are documented in
[`docs/teams.md`](../teams.md) (Pipeline Shape table, "Guardrails (Phase 6 — Gate 2 Live)",
"Safety gates + audit substrate", the "Numerics + data store (Phase 6 Sprint 4)" data-model
section, the "Ingestion (Phase 6 Sprint 5)" section, the "EgressGuard + full SOP wiring
(Phase 6 Sprint 6)" section, the "MedlinePlus grounded retrieval + cited synthesis (Phase 6
Sprint 7)" section, and "How `loadTeam` Works"). The
`medical.egress.{cloudInference,literatureRetrieval}` config keys (both default false) are in
the README "Full Configuration Reference". User-facing usage for `bober medical import` lives
in [`COMMANDS.md`](../../COMMANDS.md).

### Plan close-out

`spec-20260616-medical-team` is **engineering-complete on branch `bober/medical-team`** — 7
of 7 sprints passed evaluation, **2393 tests** green, and the **five code-enforced safety
guarantees** verified (fail-closed consent; deterministic 0-LLM red-flag short-circuit;
arithmetic kept out of the LLM via the closed 8-primitive numerics whitelist; code-enforced
zero-egress default via two independent axes + the scoped ESLint network boundary; and
abstain-unless-supported, fail-closed cited retrieval). **Both egress axes default `false` and
consent is fail-closed, so it ships nothing to cloud by default.** **Shipping / enabling the
medical team remains gated on the EXTERNAL S6.5 FFDCA §201(h) counsel + regulatory review**,
which is **not a buildable sprint** — the code is done, the regulatory gate is open. **Advisory
carry-forward:** red-flag detection uses ADR-2 conservative phrase matching with **known
false-negatives** (an intentional precision-over-recall choice) that are surfaced to the
patternset revision / S6.5 counsel review rather than patched by widening matching here. See the
finale record [`sprint-spec-20260616-medical-team-7.md`](./sprint-spec-20260616-medical-team-7.md).

## Medical Team — WHOOP + Guardrails — complete (3 of 3)

`spec-20260617-medical-whoop-guardrails` — production-grade extensions to the medical team
for a single self-responsible user: a code-enforced non-emergency refusal layer plus a WHOOP
device-connection ingestion path behind a third `device-connection` egress axis.
**Additive on top of base ADRs 1-7; programming-team behavior byte-unaffected.** Sprint 1
closes the **non-emergency content-policy refusal gap**: the `{kind:"refuse"}` verdict (and the
`refuse` audit event) already existed in the type surface but `MedicalGuardrails.evaluate` never
emitted it — prescription / dosing / treatment-plan prompts fell through to `{kind:"allow"}` and
were refused **prompt-only by the LLM**. A new pure/synchronous `RefusalDetector`
(`src/medical/refusal.ts`, zero imports, `REFUSAL_PATTERNSET_VERSION "refusal-2026.06.17"`)
classifies a prompt into `prescription` / `specific-dosing` / `individualized-treatment-plan` /
`none` over a conservative ~4-rules-per-category phrase set (accepts false-negatives, **never**
false-positives into advice — ADR-3). `evaluate` now runs the `RedFlagDetector` **first**
(emergency short-circuit wins by early return) and **then** the `RefusalDetector`, returning
`{ kind: "refuse", rule, reason }` with **fixed, never-model-generated** decline text from the
exported `REFUSAL_REASONS` record (byte-asserted in tests, distinct from the 911/988 escalations).
`MedicalSopEngine.run` gained a refuse-dispatch branch (Gate 2b, mirroring the consent-refuse
path) that returns the canned `MedicalAnswer` (`shortCircuit: true`, `abstained: false`,
`citations: []`), writes an IDs-only `refuse` audit entry (`ruleId` / `rulesetVersion` /
`patternsetVersion`, no prompt text or health values), and reaches **zero** numerics / FactStore
/ retrieval / LLM. Self-contained, no network, does not touch WHOOP. **+45 tests (2393 → 2438),
all 8 criteria passed iteration 1.** Sprint 2 establishes **authenticated, egress-gated access to
WHOOP without persisting data**: the `EgressGuard` gains a **third independent axis**,
`device-connection` (default **false**; `EgressAxis` becomes a 3-value union, the constructor's 3rd
param is **optional** so 2-arg call sites stay byte-identical, `isAllowed` becomes an exhaustive
`switch` with a compile-time `never` guard, `fromConfig` reads new
`medical.egress.deviceConnection`). A network-free `WhoopTokenStore` (`whoop/whoop-token.ts`) reads
`WHOOP_CLIENT_ID`/`WHOOP_CLIENT_SECRET` from env (clear throw if unset) and persists the rotating
refresh token in a `0600` sidecar at `.bober/medical/whoop-token.json` (no keychain; corrupt/absent
⇒ `undefined`). A `WhoopClient` (`whoop/whoop-client.ts`) — the **second** ESLint-excepted network
file — does the OAuth2 `refresh_token` grant + paginated WHOOP **v2** fetch (cursor pagination,
401-refresh-retry-once, 429-Reset-wait via an **injected** waiter), calling
`assertAllowed("device-connection")` **before any HTTP**; transport/waiter/clock are all injectable
so CI runs offline and sleepless. No sync adapter, record mapping, persistence, or CLI yet (Sprint
3). **+35 tests (2438 → 2473), all 7 criteria passed iteration 1.** Sprint 3 **closes the spec** with
the **end-to-end visible slice — pull WHOOP data and persist it**: a `WhoopSyncAdapter`
(`whoop/whoop-sync.ts`, **no network import**, **not** an `IngestionAdapter` — its entry point is a
network `sync(window, sink)`) pages `WhoopClient` across the four collections, maps each record to
`source:"whoop"` `HealthObservation`s via a fixed reviewable `WHOOP_FIELD_MAP` (`id` left unset so the
store derives the content-SHA-256 dedup key — **not** the WHOOP UUID; unmapped fields **skipped, never
guessed**), and writes via the **existing** `StoreObservationSink.writeBatch` in bounded per-batch
transactions. Re-running is **idempotent** (`INSERT OR IGNORE` ⇒ `newRows: 0` on a repeat over an
overlapping window) and a mid-pagination throw is **fail-closed** (it propagates — **no**
catch-and-continue — committed batches survive and a clean re-run reaches the same end-state; no
persisted cursor, ADR-4). A new `bober medical whoop sync [--since <iso>]` subcommand
(`cli/commands/medical.ts` via an exported testable `runWhoopSync()` helper) mirrors `medical import`:
it checks the `device-connection` axis **before** constructing any `WhoopClient`/HTTP (axis off ⇒ clear
message + `exit 1`, **zero** outbound bytes), surfaces clear missing-credential / not-authorised
messages (each `exit 1`, **never** throws), computes the window (default last 7 days or `--since`) at
the CLI boundary (the adapter/store never read the clock), appends an IDs/enums-only `event:"ingest"`
audit entry, prints `records parsed` / `new rows`, and **always** `store.close()` in `finally`. All
HTTP stays in `whoop-client.ts` (no network import in `whoop-sync.ts` or the CLI). On-demand only — no
webhooks. **+11 tests (2473 → 2484), all 8 criteria passed iteration 1.**

| # | Record | What it added |
|---|--------|---------------|
| 1 | [sprint-spec-20260617-medical-whoop-guardrails-1.md](./sprint-spec-20260617-medical-whoop-guardrails-1.md) | **Code-enforced non-emergency refusal layer (Gate 2b, 0-LLM):** pure/sync `RefusalDetector` (`refusal.ts`, zero imports, 3 refusal categories + `none`, `REFUSAL_PATTERNSET_VERSION`, fixed `REFUSAL_REASONS` decline strings) classifying prescription / specific-dosing / individualized-treatment-plan; `MedicalGuardrails.evaluate` runs red-flag **first** (emergency precedence) then refusal ⇒ `{ kind:"refuse", rule, reason }` with byte-fixed never-model-generated text + `refusalPatternsetVersion` getter; `MedicalSopEngine.run` refuse-dispatch branch (mirrors consent-refuse) ⇒ canned `MedicalAnswer` (`shortCircuit:true`/`abstained:false`/`citations:[]`) + IDs-only `refuse` audit entry + **zero** numerics/FactStore/retrieval/LLM; conservative patternset (false-negatives accepted, ADR-3; never an LLM filter); `GuardrailContext` unchanged; +45 tests, no regression |
| 2 | [sprint-spec-20260617-medical-whoop-guardrails-2.md](./sprint-spec-20260617-medical-whoop-guardrails-2.md) | **WHOOP egress axis + authenticated transport (no persistence yet):** third **independent** `EgressAxis` `device-connection` (default **false**; optional 3rd `EgressGuard` ctor param ⇒ 2-arg sites byte-identical; ternary → exhaustive `switch` + compile-time `never` guard; `fromConfig` reads `medical.egress.deviceConnection`; new `deviceConnection: z.boolean().default(false)` in `MedicalSectionSchema`); network-free `WhoopTokenStore` (`whoop/whoop-token.ts`) — `WHOOP_CLIENT_ID`/`WHOOP_CLIENT_SECRET` env creds (clear throw if unset, **no keychain** — ADR-2) + `0600` refresh-token sidecar `.bober/medical/whoop-token.json` (absent/corrupt ⇒ `undefined`, fail-closed); `WhoopClient` (`whoop/whoop-client.ts`) — the **second** ESLint-excepted network file — OAuth2 `refresh_token` grant (scope `offline`) + paginated WHOOP **v2** GET (`recovery`/`sleep`/`cycle`/`workout`, `nextToken` cursor, **401**→refresh+retry-**once** then throw, **429**→`X-RateLimit-Reset`×1000 via **injected** waiter), `assertAllowed("device-connection")` **first** in both methods (axis off ⇒ throws, 0 fetch calls); injectable `FetchLike`/waiter/`nowIso` (no `Date.now()`) ⇒ offline+sleepless CI; `eslint.config.js` exception list now `[medline-source.ts, whoop-client.ts]` only; **no** sync/mapping/persistence/CLI (Sprint 3); +35 tests (2438 → 2473), all 7 criteria iter-1, no regression |
| 3 | [sprint-spec-20260617-medical-whoop-guardrails-3.md](./sprint-spec-20260617-medical-whoop-guardrails-3.md) | **Finale — WHOOP sync adapter + `bober medical whoop sync` CLI (end-to-end persistence):** `WhoopSyncAdapter` (`whoop/whoop-sync.ts`, **no network import**; **not** an `IngestionAdapter` — entry point is `sync(window, sink)`) pages `WhoopClient` across the four collections, maps records to `source:"whoop"` `HealthObservation`s via a fixed reviewable `WHOOP_FIELD_MAP` (`id` **unset** ⇒ store-derived content-SHA-256 dedup, **not** the WHOOP UUID; unmapped fields **skipped, never guessed**), writes via the **existing** `StoreObservationSink.writeBatch` in bounded per-batch txns ⇒ `IngestionResult{recordsParsed,newRows}`; **idempotent** (`INSERT OR IGNORE` ⇒ 2nd run `newRows:0`, no cursor — ADR-4) + **fail-closed** (mid-pagination throw **propagates**, no catch-and-continue, committed batches survive, clean re-run completes); `bober medical whoop sync [--since <iso>]` (`commands/medical.ts` via exported testable `runWhoopSync()`) mirrors `medical import`: axis check **before** any `WhoopClient`/HTTP (off ⇒ clear msg + exit 1, **0** outbound bytes), env-cred + refresh-token branches (clear msg + exit 1, **never** throws), window (last 7d or `--since`) computed at CLI boundary (adapter/store never read clock), IDs-only `event:"ingest"` audit, prints counts, `store.close()` in `finally`; all HTTP stays in `whoop-client.ts`; on-demand only (no webhooks); +11 tests (2473 → 2484), all 8 criteria iter-1, no regression |

The live refuse gate (Gate 2b) is documented in [`docs/teams.md`](../teams.md) under "Guardrails
(Phase 6 — Gates 2 + 2b Live)", "Safety gates + audit substrate", and the full ordered SOP list.
The third `device-connection` egress axis + the WHOOP transport (`WhoopTokenStore` + `WhoopClient`)
are documented in [`docs/teams.md`](../teams.md) under "EgressGuard + full SOP wiring" (now three
axes) and "WHOOP device-connection axis + authenticated transport"; the WHOOP sync adapter + the
`bober medical whoop sync` CLI are documented under "WHOOP sync adapter + CLI" (same doc) and in
[`COMMANDS.md`](../../COMMANDS.md). The `medical.egress.deviceConnection` config key (default false)
is in the README "Full Configuration Reference".

### Plan close-out

`spec-20260617-medical-whoop-guardrails` is **complete (3 of 3)** on branch
`bober/medical-team` — all three sprints passed evaluation on iteration 1 (zero reworks),
**2484 tests** green. The spec adds two production-grade extensions to the medical team,
both **additive on top of base ADRs 1-7** with **byte-zero impact on the programming
team**: (1) a code-enforced non-emergency **refusal Gate 2b** (0-LLM canned decline for
prescription / dosing / treatment-plan prompts, Sprint 1), and (2) a full **WHOOP
device-connection ingestion path** behind a **third zero-default egress axis** —
authenticated transport (Sprint 2) + sync adapter & `bober medical whoop sync` CLI
(Sprint 3), idempotent and fail-closed, with **zero outbound bytes** until the axis is
explicitly opted in. **Shipping still inherits the base medical team's external S6.5
FFDCA §201(h) counsel + regulatory review gate** — a non-engineering gate that remains
open; the code is engineering-complete. See the finale record
[`sprint-spec-20260617-medical-whoop-guardrails-3.md`](./sprint-spec-20260617-medical-whoop-guardrails-3.md).

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
