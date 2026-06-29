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

## Medical Team — Grounding Critic — complete (3 of 3)

`spec-20260618-medical-grounding-critic` — adds a **fail-closed grounding critic** to the
medical-sop pipeline: an independent reviewer that judges a synthesized answer for
**faithfulness + completeness** against its cited passages before it can reach the user.
Sprint 1 is the **risk-first crux** — the standalone, pure, injectable critic module, **not
yet wired into the engine**. New file `src/medical/retrieval/grounding-critic.ts` is
structurally modelled on the fleet critic (`src/fleet/critic-deep.ts`) — the same tolerant
`GroundingVerdict` shape, never-throws `validateGroundingVerdict` parser (direct parse →
fence extract → first-brace slice → zod `safeParse`), fresh-message-array (LOCK1)
`callGroundingCritic`, and bounded retry-with-coercion loop — with **one** behavioral
inversion: at parse exhaustion `getGroundingVerdict` FAIL-**CLOSED** returns
`{verdict:"reject", feedback:"<unparseable critic output>"}` (`grounding-critic.ts:206`),
the exact opposite of the fleet critic's fail-**open** `approve` (`critic-deep.ts:201`), so
an unparseable critic output can never approve an unverified medical answer.
`buildGroundingSystemPrompt(question, answerBody, passages)` pins the critic to the numbered
cited-passage block; the call budget is capped at `GROUNDING_MAX_LLM_CALLS` (= 2); transport
errors propagate (Sprint 2 maps them to abstain). The module depends only on `zod` + the
injected `LLMClient`/`Passage` types (no SDK / network / `fetch` import — the scoped
`src/medical/**` ESLint boundary stays green) and is **purely additive**: **no** engine
wiring, config, CLI, or audit field. **+22 tests, all 7 criteria passed iteration 1; no
regression in the pre-existing suite.**

Sprint 2 makes the critic **live in the pipeline** for the first time. A new
`synthesizeGrounded` (`src/medical/retrieval/literature.ts:259`) composes the existing
`synthesize` primitive with the Sprint-1 critic into a **fail-closed gate**: synthesize →
critique → on `reject`, **one** re-synthesis (`synthesizeWithFeedback`, module-private,
critic feedback appended to the synthesis system prompt) → re-critique → **abstain** on a
second `reject` **or on any thrown** transport/model error at any step. Every `synthesize`
and every `getGroundingVerdict` call is wrapped so a throw maps to the canned
`abstainAnswer` (`abstained:true`, `citations:[]`, footer present) — an exception **never**
escapes and an ungrounded answer is **never** returned. The exported
`GROUNDED_GATE_MAX_LLM_CALLS` (= 6 today) caps the gate's worst case and is **computed from**
`GROUNDING_MAX_LLM_CALLS`, not a literal (`1 synth + critic + 1 re-synth + re-critic`). The
engine's grounded branch (`engine.ts:403`) now calls `synthesizeGrounded` instead of the bare
`synthesize`, threading the same lazily-constructed local `LLMClient` + footer. **Crucially,
only the grounded-synthesis branch now makes > 1 LLM call** — every upstream gate stays
**zero-LLM**: the consent-refuse, red-flag short-circuit, content-policy refuse, numeric-only
(`sampleCount > 0`), and literature-disabled paths construct **no** critic and make **no** LLM
call (all 11 `engine.test.ts` spy-`LLMClient` negative assertions unchanged; only the grounded
happy-path count moved `1 → 2` for synth + critic). Config/CLI and the
`AuditEntry.criticVerdict` field remain deferred to Sprint 3 — the engine still appends the
existing `answer` / `abstain` audit event. **+12 collocated grounded-gate tests, all 8
criteria passed iteration 1; no regression.**

Sprint 3 **closes the plan** with the **configurable model + cloud-inference gating + audit
verdict**. (1) A new optional `config.medical.inference` block (`schema.ts`,
`{ provider?, endpoint?, model? }`, all optional) makes the synthesis/critic model + provider
configurable. (2) A resolver `buildMedicalInferenceClient(config, egress)`
(`src/medical/inference.ts`) returns `{ client, model }` and is the **single** place that
decides local-vs-cloud: it classifies "local" as `openai-compat` + a `localhost` endpoint, and
when `inference` names a **cloud** provider it is honoured **only** if
`egress.isAllowed("cloud-inference")` is `true` — otherwise it **FAILS CLOSED** (`inference.ts:44`),
returning the exact local Ollama default (`openai-compat`, `http://localhost:11434/v1`,
`llama3`) so **no cloud client is ever constructed** and no cloud egress occurs. With no
`inference` block the default is byte-identical to Sprint 2. **No new egress axis** was added —
cloud is gated by the existing `cloud-inference` axis (default **false**). (3)
`synthesizeGrounded`'s return widened from `MedicalAnswer` to `{ answer, verdict }` (new
`GroundedResult` type) and gained a threaded `model` param; the engine's grounded branch
resolves its `LLMClient` + `synthModel` via `buildMedicalInferenceClient` (injected
`deps.llmClient` still wins) and maps the returned verdict into a new optional
`AuditEntry.criticVerdict` (`'approve' | 'reject-abstained' | 'error-abstained'`,
IDs/enums-only) appended **only on the grounded path** (non-grounded entries byte-identical),
PHI-free at mode `0600`. **2673 tests pass** (6 pre-existing cockpit E2E failures unrelated);
all 8 criteria passed iteration 1; no regression.

| # | Record | What it added |
|---|--------|---------------|
| 1 | [sprint-spec-20260618-medical-grounding-critic-1.md](./sprint-spec-20260618-medical-grounding-critic-1.md) | **Fail-closed grounding-critic module (pure, not yet wired):** `src/medical/retrieval/grounding-critic.ts` exporting `GroundingVerdict`/`GroundingVerdictSchema`, never-throws `validateGroundingVerdict` (direct parse → fence → first-brace → zod `safeParse`), `buildGroundingSystemPrompt` (faithfulness + completeness review pinned to the cited-passage block), `getGroundingVerdict` (bounded retry-with-coercion, **FAIL-CLOSED `reject` on parse exhaustion** — the inversion of fleet `critic-deep.ts:201`'s fail-open `approve`), and the `GROUNDING_PARSE_MAX_RETRIES`/`GROUNDING_MAX_LLM_CALLS` (= 2) caps; internal `callGroundingCritic` builds a **fresh** single-`user`-turn message array (LOCK1, never extends the synthesis conversation) with `jsonObjectMode:true`; transport errors propagate (not caught here); depends only on `zod` + injected `LLMClient`/`Passage` (no SDK/network/`fetch`); **purely additive** — no engine wiring / config / CLI / audit (Sprints 2–3); +22 tests, all 7 criteria iter-1, no regression |
| 2 | [sprint-spec-20260618-medical-grounding-critic-2.md](./sprint-spec-20260618-medical-grounding-critic-2.md) | **Gated synthesis flow + engine wiring (critic now LIVE):** `synthesizeGrounded` (`literature.ts:259`) composes `synthesize` + `getGroundingVerdict` into a **fail-closed gate** — synthesize → critique → on `reject` **one** re-synth (`synthesizeWithFeedback`, feedback appended to the synthesis system prompt) → re-critique → **abstain** on second-reject **or any thrown** transport/model error (every call try/catch-wrapped → canned `abstainAnswer` `abstained:true`/`citations:[]`/footer; no exception escapes, no ungrounded answer); exported `GROUNDED_GATE_MAX_LLM_CALLS` (= 6) **computed** from `GROUNDING_MAX_LLM_CALLS` (`1 synth + critic + 1 re-synth + re-critic`), call-cap asserted on reject→reject; engine grounded branch swap (`engine.ts:403` `synthesize` → `synthesizeGrounded`, same `llmClient`/footer; import at `:29` updated) — **only the grounded branch now makes > 1 LLM call**; every non-grounded path (consent / red-flag / refuse / numeric-only / literature-disabled) stays **zero-LLM** (all 11 `engine.test.ts` spy assertions unchanged, only grounded happy-path count `1 → 2`); audit event unchanged (`answer`/`abstain`; `criticVerdict` deferred to S3); +12 grounded-gate tests, all 8 criteria iter-1, no regression |
| 3 | [sprint-spec-20260618-medical-grounding-critic-3.md](./sprint-spec-20260618-medical-grounding-critic-3.md) | **Finale — configurable model + cloud-inference gating + audit verdict:** optional `config.medical.inference` block (`schema.ts`, `{ provider?, endpoint?, model? }`, all-optional zod, sibling of `medical.egress`); resolver `buildMedicalInferenceClient(config, egress, factory?)` (`src/medical/inference.ts:31`) ⇒ `{ client, model }`, the **sole** local-vs-cloud decision + the **only** `createClient` seam — "local" = `openai-compat` + `localhost` endpoint; a cloud provider is honoured **only** when `egress.isAllowed("cloud-inference")` else **FAIL-CLOSED to the local default** (`inference.ts:44`, no cloud client ever constructed, factory-spy-asserted never-called-with-cloud), no-config ⇒ exact local default `openai-compat`/`http://localhost:11434/v1`/`llama3` (byte-identical to S2); **no new egress axis** — reuses `cloud-inference` (default false); `synthesizeGrounded` return widened `MedicalAnswer` → `{ answer, verdict }` (new `GroundedResult`) + threaded `model` param on `synthesize`/`synthesizeWithFeedback`/`synthesizeGrounded` (default `SYNTHESIS_MODEL` back-compat); engine grounded branch resolves client+`synthModel` via the resolver (injected `deps.llmClient` still wins, pinned `llama3`) and maps the verdict into new optional `AuditEntry.criticVerdict` (`CriticVerdict` = `approve`/`reject-abstained`/`error-abstained`, IDs/enums-only — never text) **spread in only on the grounded path** (`...(criticVerdict ? {criticVerdict} : {})`, non-grounded entries byte-identical), PHI-free, mode `0600` stat-asserted, line carries no prompt/answer substring; new `inference.test.ts` (cloud-off→local, cloud-on→cloud via factory spy, no-config→default) + `engine.test.ts`/`audit.test.ts` verdict additions; **2673 tests pass** (6 pre-existing cockpit E2E unrelated), all 8 criteria iter-1, no regression |

The configurable model + the `cloud-inference` gating + the `AuditEntry.criticVerdict` field
(Sprint 3) are now reflected in [`docs/teams.md`](../teams.md) (the "MedlinePlus grounded
retrieval + cited synthesis" section's "Configurable model + cloud-inference gating" and
"Critic verdict in the audit" notes), and the `medical.inference` block + its cloud-inference
gating note are in the README "Full Configuration Reference". See the sprint records
[`sprint-spec-20260618-medical-grounding-critic-1.md`](./sprint-spec-20260618-medical-grounding-critic-1.md),
[`sprint-spec-20260618-medical-grounding-critic-2.md`](./sprint-spec-20260618-medical-grounding-critic-2.md),
and
[`sprint-spec-20260618-medical-grounding-critic-3.md`](./sprint-spec-20260618-medical-grounding-critic-3.md).

### Plan close-out

`spec-20260618-medical-grounding-critic` is **complete (3 of 3)** on branch
`bober/medical-team` — all three sprints passed evaluation on iteration 1 (zero reworks),
**2673 tests** green (6 pre-existing cockpit E2E failures are unrelated / not a regression).
The spec adds a **fail-closed grounding critic** to the medical-sop pipeline (Sprints 1–2)
plus a **configurable synthesis/critic model** whose cloud use is **strictly gated by the
existing `cloud-inference` egress axis** — **default off, fail-closed to the local Ollama
default** — and an IDs/enums-only `criticVerdict` audit field (Sprint 3). It is **additive on
top of base ADRs 1-7** with **byte-zero impact on the programming team**, and the default
medical posture still makes **zero cloud egress** out of the box. **Shipping still inherits the
base medical team's external S6.5 FFDCA §201(h) counsel + regulatory review gate** — a
non-engineering gate that remains open; the code is engineering-complete. See the finale record
[`sprint-spec-20260618-medical-grounding-critic-3.md`](./sprint-spec-20260618-medical-grounding-critic-3.md).

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

## Fleet Tier / Provider Routing — complete (3 of 3)

`spec-20260618-fleet-tier-provider-routing` — Phase A of
`arch-20260618-heterogeneous-multi-provider-agent-team`: let a fleet route different roles to
different provider tiers. Sprint 1 lays the **provider-wiring groundwork** by adding **Grok /
xAI** as the **existing `openai-compat` provider** pointed at `https://api.x.ai/v1` — mirroring
the DeepSeek wiring at its three resolution sites. xAI exposes an OpenAI-wire-compatible API, so
`OpenAICompatAdapter` handles it **unchanged**: there is **no new `ProviderName` value and no new
adapter class** (the union stays `anthropic|openai|google|openai-compat|claude-code`). The model
resolver's `SHORTHAND_MAP` gains `grok` / `grok-4` / `grok-4-fast` shorthands resolving to
`{ provider: "openai-compat", modelId }`, and the `openai-compat` endpoint-attach branch selects
`https://api.x.ai/v1` when the resolved `modelId` starts with `grok` (else keeps
`https://api.deepseek.com`). A single shared `isXaiEndpoint(endpoint?)` predicate
(`factory.ts:83`) is the **sole** place the `api.x.ai` host substring is matched (grep-asserted),
reused by both factory sites: `validateApiKey` gains an xAI arm requiring
`apiKey ?? XAI_API_KEY` (clear throw naming Grok/xAI + `XAI_API_KEY` when absent), and
`createClient` gains a parallel arm injecting `XAI_API_KEY` into the **unchanged**
`OpenAICompatAdapter` ctor. Because `validateManifestCredentials` already forwards each child's
`endpoint` into `validateApiKey`, the fleet pre-spawn credential check recognizes Grok with
**zero edits to `src/fleet/index.ts`**. The grok model ids are placeholders, config-overridable;
tests assert routing/endpoint/key wiring, not a live API call. **This sprint changes no fleet
behavior and no tier logic** — tier mapping / `FleetChild.tier` (Sprint 2) and the `ToolRoleGuard`
(Sprint 3) are out of scope. Full suite 2690 passed (fleet 203/203); the only failures are the 6
pre-existing cockpit-integration MCP failures (unrelated). All 7 criteria passed iteration 1.

Sprint 2 makes that wiring **routable per child**: a closed `DifficultyTier` enum
(`default | cheap | standard | hard | frontier`) plus a `TierProviderPolicy` table in
`src/fleet/tier-policy.ts` map a tier to a `TieredRoleBlock` (one `RoleProviderBlock`
—`{provider,model,endpoint?}`— for each of planner / generator / evaluator). The table is
`cheap → DeepSeek` (`openai-compat` `api.deepseek.com`), `standard → Grok` (`openai-compat`
`https://api.x.ai/v1`, from Sprint 1), `hard → Anthropic Sonnet` (`endpoint:null`), and
`frontier → Anthropic Opus` (`endpoint:null`); **`default` (and `undefined`) resolve to
`undefined` = no overlay**, and **no block names `claude-code`** (children build with the tool
roles; the *enforcing* `ToolRoleGuard` is Sprint 3). `FleetChild` gains an **optional** `tier`
enum (`manifest.ts:10`; an out-of-enum value is a `ZodError`, absent leaves the shape unchanged),
and `buildChildConfig` applies `tierPolicy.resolveTier(child.tier)` over
`base.planner/generator/evaluator` **before** the unchanged
`const merged = {...base, ...(child.config ?? {})}` shallow-merge (`child-config.ts:51`). Two
guarantees fall out of that ordering: a **tier-less / `default` child is byte-identical to today's
DeepSeek default** (proven by a `deepEqual` against an expected config built through
`BoberConfigSchema.parse`), and an explicit `child.config` still **wins** over the tier block (a
`tier:"standard"` child with `config.generator={provider:"anthropic",…}` gets that generator on
Anthropic, planner/evaluator on Grok). No new SDK/network imports; `ProviderName` unchanged. +37
fleet tests; full suite **2714 passed** (only the 6 pre-existing cockpit-integration MCP failures
remain). All 8 criteria passed iteration 1.

Sprint 3 **closes Phase A** with a **build-time `ToolRoleGuard`** that rejects, **before any
child is spawned**, any child whose resolved config would place `claude-code` on a **tool role**
(`curator` / `generator` / `evaluator` / `codeReview`) — `claude-code` can drive a subscription
chat but cannot drive tools, so a builder child must use an api-key provider. `role-providers.ts`
gains an **exported** `isToolRole(role)` (derived from the authoritative `TOOL_ROLES`, **not** a
re-declared literal) and **exports** the existing `effectiveProvider`. A new
`src/fleet/tool-role-guard.ts` exposes a pure, never-throwing `check(child, resolved)` (returns a
`ToolRoleViolation {childFolder, role, provider:"claude-code"}` or `null`) and a throwing
`assertManifest(manifest)` (builds each child via `buildChildConfig`, throws a named `Error`
identifying `child.folder` + role on the first violation). `runFleet` calls `assertManifest`
in its fail-fast region **before** both `validateManifestCredentials` and `coordinator.execute`
(`index.ts:110`), so a violation prevents any spawn (a DI test asserts `coordinator.execute` is
**never called** on the throw path). The Sprint-2 tier table never emits a `claude-code` block, so
the guard's real job is catching a **hand-authored `child.config`**; it inspects the **raw**
effective provider, front-loading the same invariant the config loader already enforces per-process
into an explicit, named fleet-level rejection. The never-throw `validateManifest` is **byte-identical**
and a clean (incl. tiered) manifest passes with no throw — the no-flag fleet path is unchanged.
+39 tests; full suite **2734 passed** (only the 6 pre-existing cockpit-integration MCP failures
remain). All 8 criteria passed iteration 1.

| # | Record | What it added |
|---|--------|---------------|
| 1 | [sprint-spec-20260618-fleet-tier-provider-routing-1.md](./sprint-spec-20260618-fleet-tier-provider-routing-1.md) | **Grok/xAI wiring as the existing `openai-compat` provider (no new `ProviderName`/adapter):** `grok`/`grok-4`/`grok-4-fast` `SHORTHAND_MAP` entries → `{provider:"openai-compat",modelId}` + endpoint-attach branch selecting `https://api.x.ai/v1` for `grok*` (else `api.deepseek.com`); single shared `isXaiEndpoint(endpoint?)` (`factory.ts:83`, **sole** `api.x.ai` matcher, grep-asserted) reused by both factory sites — `validateApiKey` xAI arm (`apiKey ?? XAI_API_KEY`, clear throw when absent) + `createClient` parallel `XAI_API_KEY` injection into the **unchanged** `OpenAICompatAdapter`; `validateManifestCredentials` recognizes Grok with **zero edit** to `src/fleet/index.ts`; `ProviderName` union + DeepSeek/Ollama paths byte-unchanged; grok ids placeholder/config-overridable; **no fleet/tier behavior change** (Sprints 2–3); +17 collocated tests (resolution, key throw/no-throw, injection, single-predicate invariant, DeepSeek/Ollama non-regression) |
| 2 | [sprint-spec-20260618-fleet-tier-provider-routing-2.md](./sprint-spec-20260618-fleet-tier-provider-routing-2.md) | **`TierProviderPolicy` + `buildChildConfig` tier overlay (per-child provider routing, additive):** new `src/fleet/tier-policy.ts` (`DifficultyTier` closed enum + `RoleProviderBlock`/`TieredRoleBlock`/`TierProviderPolicy` types + `TIER_POLICY` table `cheap→DeepSeek`/`standard→Grok api.x.ai/v1`/`hard→anthropic Sonnet null`/`frontier→anthropic Opus null`; `tierPolicy.resolveTier` ⇒ `undefined` for `default`/`undefined` = **no overlay**; **no `claude-code` in any block**); optional `FleetChild.tier` enum (`manifest.ts:10`, out-of-enum ⇒ `ZodError`); `buildChildConfig` overlays `resolveTier(child.tier)` over `base.planner/generator/evaluator` **before** the unchanged `const merged` shallow-merge (`child-config.ts:51`) ⇒ **tier-less/`default` child byte-identical to DeepSeek default** (`deepEqual` proof) + **`child.config` still wins** over the tier block; no new SDK/network imports, `ProviderName` unchanged; `ToolRoleGuard` deferred to Sprint 3; +37 fleet tests (2714 total), no regression |
| 3 | [sprint-spec-20260618-fleet-tier-provider-routing-3.md](./sprint-spec-20260618-fleet-tier-provider-routing-3.md) | **Build-time `ToolRoleGuard` (fail-fast claude-code-on-tool-role rejection):** **exported** `isToolRole(role)` (`role-providers.ts:44`, derived from `TOOL_ROLES`, no re-declared literal) + **exported** existing `effectiveProvider` (`role-providers.ts:57`); new `src/fleet/tool-role-guard.ts` — `type ToolRoleViolation {childFolder, role, provider:"claude-code"}`, pure never-throws `check(child, resolved)` (first tool-role on `claude-code` ⇒ violation, else `null`), and `assertManifest(manifest)` (builds each child via `buildChildConfig`, **throws** a named `Error` identifying `child.folder` + role on first violation); wired into `runFleet` (`index.ts:110`) **before** `validateManifestCredentials` **and** `coordinator.execute` ⇒ **no child spawned** on a violation (DI test: `coordinator.execute` never called); inspects the **raw** effective provider, front-loading the loader's per-process invariant to manifest-build time; tier table never emits `claude-code` so the guard catches hand-authored `child.config`; never-throw `validateManifest` **byte-identical**, clean/tiered manifest passes silently (no-flag path unchanged); no new SDK/network imports; +39 tests (2734 total), all 8 criteria iter-1, no regression |

User-facing provider setup for Grok/xAI (the `openai-compat` adapter at `https://api.x.ai/v1`,
`XAI_API_KEY`, and the `grok` / `grok-4` / `grok-4-fast` model shorthands) is documented in
[`docs/providers.md`](../providers.md) under **Grok (xAI)** and the capability matrix. The
optional per-child fleet `tier` field and the tier → provider table are documented in
[`COMMANDS.md`](../../COMMANDS.md) under **Fleet Commands**. That the fleet now **rejects
`claude-code` on a tool role** (a builder child must use an api-key provider) is noted there
under the per-child tier table.

This phase's architecture is in `.bober/architecture/` under
`arch-20260618-heterogeneous-multi-provider-agent-team-*`.

### Plan close-out

`spec-20260618-fleet-tier-provider-routing` is **complete (3 of 3)** and **closes Phase A** of
`arch-20260618-heterogeneous-multi-provider-agent-team` — all three sprints passed evaluation on
iteration 1 (zero reworks), **2734 tests** green (only the 6 pre-existing cockpit-integration MCP
failures remain). Phase A delivers heterogeneous multi-provider fleet routing as three additive
layers: (1) **Grok / xAI wiring** as the existing `openai-compat` provider at `https://api.x.ai/v1`
(no new `ProviderName`, no new adapter — Sprint 1); (2) a per-child **`DifficultyTier` →
`TierProviderPolicy`** overlay (`cheap → DeepSeek`, `standard → Grok`, `hard → Sonnet`,
`frontier → Opus`; `default`/absent = byte-identical DeepSeek default — Sprint 2); and (3) a
**build-time `ToolRoleGuard`** that fails the fleet fast when a child would put `claude-code` on a
tool role (Sprint 3). The tier-less / no-`tier` fleet path is byte-identical to the prior DeepSeek
default throughout. The **shared-blackboard / cross-child coordination (Phase B)** was an explicit
non-goal of every sprint here and is now **complete** under
`spec-20260618-fleet-blackboard-exchange` (see the section below). See the finale record
[`sprint-spec-20260618-fleet-tier-provider-routing-3.md`](./sprint-spec-20260618-fleet-tier-provider-routing-3.md).

## Fleet Blackboard Exchange (Phase B) — complete (4 of 4)

`spec-20260618-fleet-blackboard-exchange` — Phase B of
`arch-20260618-heterogeneous-multi-provider-agent-team`: the bounded inter-agent exchange channel by
which isolated fleet children share findings, plus the head-side synthesis collection. **The plan
is complete (4 of 4) and the exchange is proven end-to-end:** the four sprints together deliver the
full data flow — a standalone WAL-backed `SharedBlackboard` module (Sprint 1), the additive
`config.fleet` / `manifest.blackboard` config seam + `agent-bober blackboard` child CLI (Sprint 2),
the coordinator bounded-rounds re-spawn loop with no-new-findings early-stop (Sprint 3), and the
head-side `fleet-synthesis.json` synthesis artifact (Sprint 4) — all opt-in via the manifest's
`blackboard` block, with the no-blackboard path byte-identical to Phase A throughout. Sprint 1 is
the **risk-first foundation** — the standalone `SharedBlackboard` module, **not yet wired into the
coordinator / `runFleet` / CLI** (WAL concurrency was the architecture's highest unknown, so it was
proven first). New file `src/fleet/shared-blackboard.ts` exports `BLACKBOARD_MAX_ROUNDS` (= 3, a hard
ceiling), the `BlackboardFinding` shape (`{childFolder, round, payload, confidence?}`), and the
`SharedBlackboard` class: a static async `open({dbPath, namespace, busyTimeoutMs?, maxRounds?})`
factory (`ensureDir` then a `FactStore` constructed with `{journalModeWal: true, busyTimeoutMs ??
5000}` for a file-backed db — WAL is **not** forced for `:memory:`; `maxRounds` clamped to 3, ctor
`private`), `publish(finding, now)` (writes a `predicate='finding'` `FactRecord` via
`FactStore.insertFact` with `scope=namespace`/`subject=childFolder`/`value=payload`/`tValid=tCreated=now`,
and **throws** `blackboard round <n> exceeds cap <cap>` past the effective cap), `readSiblings(selfFolder)`
(active `'finding'` facts excluding `subject===selfFolder`), `readAll()` (all of them), and `close()`
(checkpoints the WAL). To get WAL **without** touching any existing caller, `FactStore`'s constructor
gained an **optional** 2nd arg `{ journalModeWal?, busyTimeoutMs? }` that runs `PRAGMA journal_mode =
WAL` / `PRAGMA busy_timeout = <ms>` **only when set** — default-**off**, so every existing
`FactStore` caller (medical / memory / lessons) is byte-identical and a default store still reports
`journal_mode === 'delete'` (the sc-1-7 no-regression guard). The module depends **only** on
`FactStore` (no network / SDK import). No coordinator / `runFleet` / CLI / `config.fleet` /
`manifest.blackboard` wiring (Sprints 2-4). +15 tests (WAL-after-open, publish fields + round-cap
throw, `readSiblings`/`readAll` 2-subject + empty + namespace isolation, ≥5 concurrent `publish`,
default-FactStore non-WAL); full suite **2749 passed** (only the 6 pre-existing cockpit-integration
MCP failures remain). All 8 criteria passed iteration 1.

Sprint 2 lands the **additive config/manifest surface and the explicit child seam** that makes the
Sprint 1 module reachable. It declares an **optional `fleet` section on `BoberConfigSchema`**
(`FleetSectionSchema {blackboardDbPath, blackboardNamespace, blackboardSubject, maxRounds 1–3}`,
`schema.ts:405`/`:449`) — a **declared** section is required because `BoberConfigSchema` strips
unknown keys, so this is the only channel that survives the scaffold into a child — plus an
**optional `blackboard` block on `FleetManifestSchema`** (`{namespace.min(1), maxRounds 1–3 default
3}`, `manifest.ts:19`; `maxRounds>3` / empty ns ⇒ `ZodError`). The head-side
`resolveBlackboardPath(manifest)` (`index.ts:41`) computes **one ABSOLUTE**
`join(resolve(rootDir),'.bober','memory',<ns>,'facts.db')` (absolute even when `rootDir==='.'`) or
`undefined` — discharging ADR-5's caller-side absolute-path responsibility head-side. The
`ChildScaffolder.scaffold` gained an optional 3rd `blackboard?` param and, **inside the
`if(blackboard)` guard only**, sets `config.fleet` (`blackboardSubject=child.folder` + the absolute
shared path) before writing `bober.config.json` — so the **no-blackboard output is byte-identical**
(the test compares to `JSON.stringify(buildChildConfig(child),null,2)`). A new
**`agent-bober blackboard publish <value> [--round N]` / `read [--all]`** CLI
(`cli/commands/blackboard.ts`, registered in `cli/index.ts`, DI'd `runBlackboardPublish`/`Read`
cores) reads the absolute db path from **`config.fleet` ONLY** — never re-deriving from cwd — opens
the Sprint 1 `SharedBlackboard`, publishes a finding with `subject=blackboardSubject` (round
defaults to 1), prints siblings'/all findings as `[subject] value`, and `close()`s in a `finally`;
with **no** fleet section it prints a clear message + `process.exitCode=1` and **never throws**. A
two-cwd test (two configs at one shared `blackboardDbPath`) proves each cwd sees the other's
finding (path from config, not cwd). **No** coordinator rounds loop (Sprint 3), **no**
`fleet-synthesis.json` (Sprint 4), and **no** auto-wiring into `agent-bober run` — participation is
via the explicit CLI only. Full suite **2775 passed** (only the 6 pre-existing cockpit MCP
failures); all 8 criteria passed iteration 1, no regression, no SDK/network import in
`blackboard.ts`.

Sprint 3 makes the blackboard a **live exchange loop** — until now a blackboard manifest only
*configured* a shared db; the fleet still ran one pass. A new
`FleetCoordinator.executeRounds(manifest, blackboard, { maxRounds, dbPath })` (`coordinator.ts:55`)
runs the children for **up to `maxRounds` rounds** over the same `SharedBlackboard`: round 1
scaffolds each child (threading the Sprint-2 `{dbPath, namespace, maxRounds}` config), every round
re-spawns via `mapBounded(children, concurrency, …)`, and the loop **early-stops** the moment a
completed round adds **zero new `'finding'` facts** (`r > 1 && readAll().length === prevCount`,
`coordinator.ts:77`). The private round-aware `runChildRound` (`coordinator.ts:91`) enforces
**scaffold-once** — it calls the scaffolder only when `round === 1` and on rounds ≥ 2 synthesizes a
`ScaffoldResult` from `resolve(rootDir, child.folder)`, so a child's round-1 `bober.config.json`
(with its `fleet` section) is **never re-written/clobbered** — and is a full `try`/`catch`
never-reject thunk (a failing child becomes a `ChildExecution` with `scaffold.error`, never aborting
the round). The coordinator's `Scaffolder` seam interface gained the same **optional** 3rd
`blackboard?` param (not an overload, so the test fakes stay type-compatible). `runFleet`
(`index.ts:135`) now branches on `resolveBlackboardPath(manifest)`: with a path it `ensureDir`s the
db dir, `SharedBlackboard.open`s, runs `executeRounds` in a `try`/`finally` that always `close()`s
(WAL checkpoint even on error), and threads the absolute path into round-1 scaffolding; with **no**
blackboard it calls `coordinator.execute(...)` **verbatim** — a **byte-identical single pass** (no
blackboard opened, no `.bober/memory/.../facts.db` created, the 5 pre-existing coordinator tests +
all index tests unchanged). `fleet-report.json` is still written from the **final** round's
outcomes, and the exit-0 contract (per-child failures are data) is preserved. Early-stop is **purely
structural** ("no new findings this round") — no semantic convergence judging (a non-goal); the loop
runs at least 2 rounds before it can stop. **No** `fleet-synthesis.json` yet (Sprint 4) and **no**
auto-publish on the children's behalf (findings come only from task prompts calling the Sprint-2
CLI). Full suite **2781 passed**, fleet **268/268** (only the 6 pre-existing cockpit MCP failures);
all 8 criteria passed iteration 1, no regression.

Sprint 4 **closes the plan** with the **head-side synthesis collection** — the last piece of the
Phase B data flow. After a blackboard fleet's rounds finish, `runFleet` now assembles a **pure
data** bundle of the final-round child results, all blackboard findings, and the round count, and
atomically writes it to `<rootDir>/.bober/fleet-synthesis.json` for the head / dynamic-workflow to
synthesize — **the bober runtime deliberately does *not* synthesize**. A new `src/fleet/synthesis.ts`
exports `SynthesisBundle {rounds, childResults: PortfolioReport, findings: FactRecord[]}` and a
**pure** `collect(blackboard: SharedBlackboard | null, childResults, rounds)` =
`{ rounds, childResults, findings: blackboard ? blackboard.readAll() : [] }` — **no LLM, no network,
no IO, no provider/client construction** (it imports only `type`-level `SharedBlackboard` /
`PortfolioReport` / `FactRecord`, asserted by a source grep). The write is **additive + gated**: a
private `writeSynthesis` (`index.ts:60`, tmp+`rename`+`randomBytes`+`0o600`, mirroring
`PortfolioReporter.write`) runs **after** the unchanged `fleet-report.json` write under an `if (bb)`
guard, so `fleet-report.json` shape/behavior is **unchanged** and a no-blackboard run writes nothing
extra (the synthesis file is **absent** and the output is **byte-identical** to Phase A). The
Sprint-3 close-ordering was reworked: `bb` / `roundsRun` are hoisted out of the `if (dbPath)` block
and `bb.close()` moved to an **outer `finally`**, so `collect()` → `bb.readAll()` runs on a still-open
db (and the WAL is still checkpointed on any error path). One documented carry-forward (now
**RESOLVED** by `spec-20260618-fleet-synthesis-round-count`, see the section below): at the time of
this sprint `bundle.rounds` was sourced from the configured `maxRounds` **cap**, not the actual
executed round count (flagged with a `bober:` ceiling comment) — `executeRounds` returned only the
final-round executions with no count, and threading a returned count would touch the coordinator (an
explicit Sprint-4 non-goal); the evaluator accepted this as satisfying "the round count" as written.
Full suite **2786 passed**, fleet **273/273** (only the 6 pre-existing cockpit MCP failures); all 7
criteria (sc-4-1..sc-4-7) passed iteration 1, no regression.

| # | Record | What it added |
|---|--------|---------------|
| 1 | [sprint-spec-20260618-fleet-blackboard-exchange-1.md](./sprint-spec-20260618-fleet-blackboard-exchange-1.md) | **`SharedBlackboard` WAL `facts.db` wrapper + opt-in `FactStore` WAL (Phase B foundation, not yet wired):** new `src/fleet/shared-blackboard.ts` — `BLACKBOARD_MAX_ROUNDS=3` (hard ceiling, `min(maxRounds??3,3)`), `BlackboardFinding {childFolder,round,payload,confidence?}`, `SharedBlackboard` with `private` ctor + static async `open({dbPath,namespace,busyTimeoutMs?,maxRounds?})` (`ensureDir`, `FactStore({journalModeWal:true,busyTimeoutMs??5000})` for file-backed only — **not** `:memory:`), `publish(finding,now)` (writes `predicate='finding'` `FactRecord`, scope=namespace/subject=childFolder/value=payload/tValid=tCreated=now; **throws** past effective cap), `readSiblings(selfFolder)` (excludes self), `readAll()`, `close()` (WAL checkpoint); `FactStore` gains **optional** 2nd ctor arg `{journalModeWal?,busyTimeoutMs?}` ⇒ `PRAGMA journal_mode=WAL`/`busy_timeout` **only when set**, default-**off** ⇒ every existing caller byte-identical (default `journal_mode==='delete'`, sc-1-7); depends only on `FactStore` (no network/SDK import); **no** coordinator/`runFleet`/CLI/config wiring (Sprints 2-4); +15 tests, all 8 criteria iter-1, no regression |
| 2 | [sprint-spec-20260618-fleet-blackboard-exchange-2.md](./sprint-spec-20260618-fleet-blackboard-exchange-2.md) | **`config.fleet` section + `manifest.blackboard` + absolute path injection + `agent-bober blackboard` CLI (the child seam):** optional `FleetSectionSchema {blackboardDbPath,blackboardNamespace,blackboardSubject,maxRounds 1–3}` declared on `BoberConfigSchema` (`schema.ts:405`/`:449` — declared so it survives the unknown-key strip into children) + `type FleetSection`; optional `blackboard {namespace.min(1), maxRounds 1–3 default 3}` on `FleetManifestSchema` (`manifest.ts:19`; `maxRounds>3`/empty-ns ⇒ `ZodError`); `resolveBlackboardPath(manifest)` (`index.ts:41`) ⇒ **ABSOLUTE** `join(resolve(rootDir),'.bober','memory',<ns>,'facts.db')` or `undefined` (**ADR-5 caller-side absolute path, discharged head-side**); `ChildScaffolder.scaffold` optional 3rd `blackboard?` param sets `config.fleet` (`subject=child.folder`+abs path) **inside the `if`-guard only** ⇒ no-blackboard output **byte-identical**; new `agent-bober blackboard publish <value> [--round N]`/`read [--all]` CLI (`cli/commands/blackboard.ts`, DI'd `runBlackboardPublish`/`runBlackboardRead` cores, registered in `cli/index.ts`) reads abs path from **`config.fleet` ONLY** (never cwd), opens Sprint 1 `SharedBlackboard`, prints `[subject] value`, `close()` in `finally`; **no fleet section ⇒ clear message + `exitCode=1`, never throws**; two-cwd shared-visibility proof; **no** coordinator (S3)/synthesis (S4)/`run` auto-wiring; +tests, suite **2775 passed**, all 8 criteria iter-1, no regression |
| 3 | [sprint-spec-20260618-fleet-blackboard-exchange-3.md](./sprint-spec-20260618-fleet-blackboard-exchange-3.md) | **Coordinator rounds loop + `runFleet` blackboard branch (the live exchange loop):** `FleetCoordinator.executeRounds(manifest, blackboard, {maxRounds, dbPath})` (`coordinator.ts:55`) — bounded `1..maxRounds` loop, each round `mapBounded(children, concurrency, runChildRound)`, **scaffold-once** (Sprint-2 `{dbPath,namespace,maxRounds}` threaded **only on round 1**, `undefined` after), **early-stop** when `r > 1 && blackboard.readAll().length === prevCount` (`coordinator.ts:77`; `prevCount` seeded pre-loop so round 1 never stops), returns the **final** round's `ChildExecution[]`; private `runChildRound` (`coordinator.ts:91`) scaffolds only `round === 1` else reuses `resolve(rootDir, child.folder)` (**never re-writes/clobbers** round-1 `config.fleet`) + full `try`/`catch` never-reject thunk (failing child ⇒ `ChildExecution` w/ `scaffold.error`); coordinator's `Scaffolder` seam widened with **optional** 3rd `blackboard?` param (not an overload ⇒ test fakes stay type-compatible); `runFleet` (`index.ts:135`) branches on `resolveBlackboardPath(manifest)` ⇒ with a path: `ensureDir(dirname)` + `SharedBlackboard.open` + `executeRounds` in `try`/`finally(close)` (WAL checkpoint even on error) + abs path threaded into round-1 scaffold; **no** blackboard ⇒ `coordinator.execute(...)` **verbatim** (byte-identical single pass, no blackboard opened, no `.bober/memory/.../facts.db`, 5 pre-existing coordinator + all index tests unchanged); `fleet-report.json` still from the **final** round; exit-0 (per-child-failures-are-data) preserved; early-stop is **purely structural** (no semantic convergence — non-goal); **no** `fleet-synthesis.json` (S4), **no** auto-publish on children's behalf; suite **2781 passed**, fleet **268/268**, all 8 criteria iter-1, no regression |
| 4 | [sprint-spec-20260618-fleet-blackboard-exchange-4.md](./sprint-spec-20260618-fleet-blackboard-exchange-4.md) | **Finale — `SynthesisStep` + `fleet-synthesis.json` head-side artifact (PURE collection, no synthesis in the runtime):** new `src/fleet/synthesis.ts` — `interface SynthesisBundle {rounds:number, childResults:PortfolioReport, findings:FactRecord[]}` + **pure** `collect(blackboard:SharedBlackboard\|null, childResults, rounds)` = `{rounds, childResults, findings: blackboard ? blackboard.readAll() : []}` (**no LLM/network/IO/client**; imports only `type` `SharedBlackboard`/`PortfolioReport`/`FactRecord`, source-grep-asserted); `runFleet` (`index.ts`) writes `<rootDir>/.bober/fleet-synthesis.json` via a private `writeSynthesis` (`index.ts:60`, tmp+`rename`+`randomBytes`+`0o600`, mirrors `PortfolioReporter.write`) **after** the unchanged `fleet-report.json` write under an `if (bb)` gate — **additive + blackboard-only**, no-blackboard run writes **nothing extra** (file **absent**, byte-identical to Phase A), `fleet-report.json` shape **unchanged** + always written; Sprint-3 close-ordering reworked — `bb`/`roundsRun` **hoisted** + `bb.close()` moved to an **outer `finally`** so `collect()` → `bb.readAll()` runs on an **open** db (WAL still checkpointed on error); `bundle.rounds` = configured `maxRounds` **cap** (not executed count — `executeRounds` returned no count, plumbing one was a coordinator non-goal #5; `bober:` ceiling comment; evaluator-accepted as "the round count"; **later RESOLVED** by `spec-20260618-fleet-synthesis-round-count`); head/dynamic-workflow consumes the artifact — **the runtime does NOT synthesize**; suite **2786 passed**, fleet **273/273**, all 7 criteria (sc-4-1..sc-4-7) iter-1, no regression |

This phase's architecture is in `.bober/architecture/` under
`arch-20260618-heterogeneous-multi-provider-agent-team-*` — notably ADR-3 (shared blackboard via one
WAL-mode `facts.db`, bounded to ≤3 rounds) and ADR-5 (head-injected absolute blackboard path,
**discharged head-side by Sprint 2's `resolveBlackboardPath`**). User-facing usage for
`agent-bober blackboard publish|read` and the optional `manifest.blackboard` block lives in
[`COMMANDS.md`](../../COMMANDS.md) under "Fleet Commands". The internal child-injected `config.fleet`
section is deliberately **not** in the README "Full Configuration Reference" — it is head-written,
not user-authored. The Sprint-3 coordinator rounds loop (bounded re-spawn + no-new-findings
early-stop, byte-identical no-blackboard single pass) and the Sprint-4 head-side
`fleet-synthesis.json` output artifact (its `{rounds, childResults, findings}` shape, when it is
written, and that the head — not the bober runtime — consumes it to synthesize) are documented in
[`COMMANDS.md`](../../COMMANDS.md) under "Inter-child blackboard (Phase B)".

### Plan close-out

`spec-20260618-fleet-blackboard-exchange` is **complete (4 of 4)** on branch `bober/medical-team`
and **closes Phase B** of `arch-20260618-heterogeneous-multi-provider-agent-team` — all four
sprints passed evaluation on iteration 1 (zero reworks), **2786 tests** green, fleet **273/273**
(only the 6 pre-existing cockpit-integration MCP failures remain). The phase delivers the full
inter-agent exchange channel as four additive layers — (1) the WAL-backed `SharedBlackboard`
module + opt-in `FactStore` WAL (Sprint 1); (2) the `config.fleet` / `manifest.blackboard` config
seam + `agent-bober blackboard publish|read` child CLI (Sprint 2); (3) the coordinator bounded
re-spawn rounds loop with structural no-new-findings early-stop (Sprint 3); and (4) the pure
head-side `fleet-synthesis.json` collection artifact (Sprint 4). Every layer is opt-in via the
manifest's `blackboard` block, and the **no-blackboard fleet path is byte-identical to Phase A
throughout** (no WAL forced on existing `FactStore` callers, no `facts.db` created, no
`fleet-synthesis.json` written). The bober runtime **collects** the synthesis bundle but
**deliberately does not synthesize** — the head / dynamic-workflow consumes `fleet-synthesis.json`
to perform the actual cross-child synthesis. Phase B's deferred follow-on (the head agent's
synthesis step itself, and any auto-publish on children's behalf) is **not** part of this spec. See
the finale record
[`sprint-spec-20260618-fleet-blackboard-exchange-4.md`](./sprint-spec-20260618-fleet-blackboard-exchange-4.md).

## Fleet Synthesis Round Count — complete (1 of 1)

`spec-20260618-fleet-synthesis-round-count` — a single follow-on sprint that **closes the one
documented carry-forward of Phase B Sprint 4**: the reported round count was the configured
`maxRounds` **cap**, not the number of rounds actually executed when a blackboard run early-stopped.
`FleetCoordinator.executeRounds` now returns `{ executions, roundsRun }` where `roundsRun` is the
**real terminating round** (`=== maxRounds` on a full run, `< maxRounds` on a no-new-findings
early-stop) — captured as the first statement of each loop iteration so it survives the `break`.
`runFleet` destructures it, removes the obsolete `bober:` ceiling comment + the hardcoded
`roundsRun = maxRounds` assignment, and threads the real count into **both**
`.bober/fleet-synthesis.json.rounds` (via `collect`, replacing the cap value) **and** a **new
optional `rounds` field** on `.bober/fleet-report.json` — present **only** on blackboard runs
(`reporter.build(outcomes, bb ? { rounds: roundsRun } : undefined)`, guarded spread). The
**no-blackboard path stays byte-identical** to Phase A: no `rounds` key on its report and no
`fleet-synthesis.json`. `synthesis.ts` is unchanged (only the value passed to `collect` changed); no
behavior changed — only the reported count became accurate. Full suite **2789 passed**, fleet
**276/276** (only the 6 pre-existing cockpit MCP failures); all 7 criteria (sc-1-1..sc-1-7) passed
iteration 1, no regression.

| # | Record | What it added |
|---|--------|---------------|
| 1 | [sprint-spec-20260618-fleet-synthesis-round-count-1.md](./sprint-spec-20260618-fleet-synthesis-round-count-1.md) | **Real executed round count in fleet synthesis + report (closes the Phase B Sprint-4 cap carry-forward):** `FleetCoordinator.executeRounds` → `Promise<{ executions, roundsRun }>` (`coordinator.ts:55`), `roundsRun = r` as the **first** for-body statement (`:71`, captured before the early-stop `break` at `:79`) ⇒ `=== maxRounds` full run / `< maxRounds` early-stop / `=== 1` when `maxRounds === 1`; early-stop + scaffold-once + never-reject `runChildRound` **untouched**; `PortfolioReport.rounds?: number` + `PortfolioReporter.build(outcomes, opts?: { rounds?: number })` with **guarded spread** (`...(opts?.rounds !== undefined ? { rounds: opts.rounds } : {})`) ⇒ no-arg `build` byte-identical; `runFleet` destructures `executeRounds`, **removes** the `bober:` ceiling comment + hardcoded `roundsRun = maxRounds`, builds `reporter.build(outcomes, bb ? { rounds: roundsRun } : undefined)` and passes the real count into the existing `collect(bb, report, roundsRun)` ⇒ early-stop run writes `rounds: 2` (NOT cap `3`) to **both** files; **no-blackboard path byte-identical** (no `rounds` key on report, no `fleet-synthesis.json`); `synthesis.ts` **unchanged** (only the passed value changed); roundsRun counts the **terminating** round (incl. a final no-findings round), **not** "productive" rounds; commit `5a4d6b7`, only the 3 declared files (+ their tests); suite **2789 passed**, fleet **276/276**, all 7 criteria (sc-1-1..sc-1-7) iter-1, no regression |

User-facing usage for the `rounds` field on both `fleet-synthesis.json` and `fleet-report.json` lives
in [`COMMANDS.md`](../../COMMANDS.md) under "Inter-child blackboard (Phase B)".

### Plan close-out

`spec-20260618-fleet-synthesis-round-count` is **complete (1 of 1)** on branch `bober/medical-team`.
The single sprint passed evaluation on iteration 1 (zero reworks), **2789 tests** green, fleet
**276/276** (only the 6 pre-existing cockpit-integration MCP failures remain). It **resolves the
last open Phase B carry-forward** — the blackboard round count is now the real executed count on both
output artifacts, with the no-blackboard path byte-identical. See the record
[`sprint-spec-20260618-fleet-synthesis-round-count-1.md`](./sprint-spec-20260618-fleet-synthesis-round-count-1.md).

## Graph — Tokensave 6.1.1 MCP Compatibility — complete (2 of 2)

`spec-20260620-graph-tokensave-6-1-compat` — restores the graph engine against `tokensave serve`
**6.1.1**, which moved to a standard MCP wire protocol **and** a renamed tool catalog that the old
graph layer matched on neither (the `agent-bober onboard` `tokensave serve handshake timed out`
failure, then the stale `semantic_search_nodes`-style tool names behind it). Sprint 1 rewrites
the **transport layer only**: `spawnAndHandshake` now writes a JSON-RPC **`initialize`** request
after spawn and resolves `health="ready"` **only** on the correlated response id (a new private
`handshakeId` reserved from the same `nextId` counter) — no longer on an arbitrary first stdout
line — then emits a `notifications/initialized` notification before any tool call. `call()` writes
the **`tools/call`** envelope (`{ method:"tools/call", params:{ name, arguments } }`) and returns a
new `unwrapMcpContent(result)` helper that scans **all** `result.content[]` `text` entries and
returns the first JSON-parseable one (live `tokensave_status` returns a staleness `WARNING:` as
`content[0]` with the JSON payload a later entry), falling back to the first text string and
throwing `GRAPH_ERROR` on `isError:true` / a JSON-RPC `error`. `HANDSHAKE_TIMEOUT_MS` was raised
**1000 → 5000** for cold starts. The circuit breaker, health states, concurrent-call id
correlation, `stop()` shutdown, stderr→debug routing, and early-exit reject are **all preserved**;
the Sprint 1 diff is confined to `src/graph/mcp-client.ts` + its test. Sprint 2 **closes the plan**
by remapping `GraphClient`'s **tool-name catalog**: it replaces the stale `TOOL` map
(`semantic_search_nodes`/`query_graph`/`get_impact_radius`/`get_review_context`/
`get_architecture_overview`/`detect_changes`) with the real 6.1.1 names
(`tokensave_search`/`tokensave_impact`/`tokensave_context`/`tokensave_module_api`/
`tokensave_changelog`) plus a new `QUERY_TOOL` per-pattern map (6.1.1 has **no** single
`query_graph`, so `callers_of`/`callees_of`/`imports_of`/`tests_for` map to
`tokensave_callers`/`tokensave_callees`/`tokensave_file_dependents`/`tokensave_test_map`). Each of
the six methods gains a result adapter (a shared `toNodeRef()` with kind coercion + per-tool raw
row types) so it returns its **existing** stable type (`SearchHit[]`/`NodeRef[]`/`ImpactReport`/
`string`) — public signatures, the `GraphResult` contract, the sandbox `keepNode` filter, and the
disabled/unavailable short-circuits all unchanged, `types.ts` untouched. **With Sprint 1 + Sprint
2, `agent-bober onboard` and the graph features of `agent-bober run` work end-to-end against
tokensave 6.1.1:** the verified E2E run prints `Starting graph engine...` with **no** `handshake
timed out` and writes all 5 `.bober/onboarding/*.md` files with real symbol rows. Full suite
**2814 passed**; all 7 Sprint-2 criteria (sc-2-1..sc-2-7) passed iteration 1, zero regressions.

| # | Record | What it added |
|---|--------|---------------|
| 1 | [sprint-spec-20260620-graph-tokensave-6-1-compat-1.md](./sprint-spec-20260620-graph-tokensave-6-1-compat-1.md) | **MCP-compliant transport in `TokensaveMcpClient` (fixes `tokensave serve` 6.1.1 handshake timeout):** `spawnAndHandshake` (`mcp-client.ts:239`) writes a JSON-RPC `initialize` request (`protocolVersion "2024-11-05"`, `clientInfo {name:"agent-bober"}`, `capabilities {}`) post-spawn + resolves `health="ready"` **only** on the correlated response (`id === handshakeId`, the new private field reserved from `nextId`) — **not** on any first line — then writes `notifications/initialized`; `call<T>` (`:194`) writes `{ method:"tools/call", params:{ name: tool, arguments: params } }` and returns `unwrapMcpContent(result)`; `unwrapMcpContent` (`:79`) scans **all** `content[].text`, returns the **first JSON-parseable** one (handles the `content[0]` staleness `WARNING:` quirk), falls back to raw first text, throws `GRAPH_ERROR` on `isError:true`; JSON-RPC `error` + `isError` both reject `.reason === "GRAPH_ERROR"` (⇒ `client.ts` `toFailureResult` `ok:false`); `HANDSHAKE_TIMEOUT_MS` **1000 → 5000**; breaker / health / id-correlation / `stop()` / stderr→debug / early-exit reject **preserved**; integration test uses real `tokensave_status` round-trip (replaces stale `semantic_search_nodes`); **`GraphClient` tool catalog deferred to Sprint 2**; commit `1441890`, only `src/graph/mcp-client.ts` + `tests/graph/mcp-client.test.ts`; suite **2809 passed**, all 8 criteria (sc-1-1..sc-1-8) iter-1, no regression |
| 2 | [sprint-spec-20260620-graph-tokensave-6-1-compat-2.md](./sprint-spec-20260620-graph-tokensave-6-1-compat-2.md) | **Finale — remap `GraphClient` to the tokensave 6.1.1 tool catalog + verify onboard E2E:** rewrote `TOOL` (`client.ts:31`) to the real `tokensave_`-prefixed names (`search→tokensave_search`, `impact→tokensave_impact`, `reviewContext→tokensave_context`, `overview→tokensave_module_api`, `changes→tokensave_changelog`); new `QUERY_TOOL` (`:40`) per-pattern map (`callers_of→tokensave_callers`, `callees_of→tokensave_callees`, `imports_of→tokensave_file_dependents`, `tests_for→tokensave_test_map`) since 6.1.1 has **no** `query_graph`; shared `toNodeRef()` (`:116`) adapter + `NODE_KINDS` (`:114`) coercion (wider 6.1.1 kinds → `"symbol"`) + adapter-internal raw row types (`TsSearchRow`/`TsEdgeRow`/`TsImpactResult`/etc., in `client.ts` **not** `types.ts`); all 6 methods rewritten with 6.1.1 params + adapters returning their **existing** type — `search`→`SearchHit[]` (`name→symbol`, `signature→snippet`, post-filter `kind`), `query`→`NodeRef[]` (per-pattern `switch` + `assertNever`, `node_id`/`file` params, `tests_for` `test_files`→`uncovered` fallback), `impact`→`ImpactReport` (`nodes[0]`=root, `/test\|spec/i` split of one flat `nodes[]`), `reviewContext`→raw markdown via `{task}`, `overview`→`JSON.stringify(module_api{path:"src"})`, `changes`→`symbols_in_changed_files` (`{from_ref:since??"HEAD~1",to_ref:"HEAD"}`); **public signatures / `GraphResult` / sandbox `keepNode` / disabled-unavailable short-circuits preserved, `types.ts` + `onboard.ts` untouched** (explicit scope: onboard keeps its `search()`-based path); tests rewritten to **raw 6.1.1 payloads** (30 tests, +5); **onboard E2E verified against the real binary** (exit 0, no handshake timeout, 5 files / 10952 bytes, real hotspot rows); commit `6ed3f77`, only `src/graph/client.ts` + `tests/graph/client.test.ts`; suite **2814 passed**, all 7 criteria (sc-2-1..sc-2-7) iter-1, no regression. **Known limitation:** onboard output is functional but **noisy** (test fixtures as hotspots, `dist/`+`docs/` in architecture-overview, communities=`default`, `indexedFileCount=0`) because `onboard.ts` keeps semantic `search()` — the deferred **"option C"** rework to call `tokensave_hotspots`/`dead_code`/`circular`/`module_api` directly would make the docs accurate |

The graph engine's user-facing surface (`bober graph init|sync|status`, `bober onboard`,
`bober impact`) is documented in the README "Graph (Tokensave) Integration" section and in
[`COMMANDS.md`](../../COMMANDS.md) "Graph Commands" / "Utility Commands". The spec changed only
the **internal** MCP transport (Sprint 1) and the **internal** downstream tokensave tool names
`GraphClient` sends (Sprint 2) — not any command, flag, or config key — so those user-facing docs
stay accurate, and `agent-bober onboard` now works end-to-end against the version range the README
already declares (`>=6.0.0-beta.1 <7.0.0`, which covers 6.1.1).

### Plan close-out

`spec-20260620-graph-tokensave-6-1-compat` is **complete (2 of 2)** on branch
`bober/medical-team`. Both sprints passed evaluation on iteration 1 (zero reworks): Sprint 1 fixed
the MCP **transport handshake**, Sprint 2 remapped `GraphClient` to the real **6.1.1 tool catalog**.
Together they restore `agent-bober onboard` and the graph features of `agent-bober run` against
`tokensave serve` 6.1.1 — verified end-to-end (no `handshake timed out`; all 5
`.bober/onboarding/*.md` written with real symbol rows). **One scoped limitation carries forward:**
onboard output is functional but **low-quality / noisy** because `onboard.ts` intentionally keeps
its semantic-`search()` data path — test fixtures appear as hotspots, `dist/`/`docs/` entries leak
into the architecture overview, communities collapse to a single `default`, and the README
`indexedFileCount` is `0`. The deferred **"option C"** follow-up reworks `onboard.ts` to call the
dedicated `tokensave_hotspots` / `tokensave_dead_code` / `tokensave_circular` / `tokensave_module_api`
tools for accurate docs. A separate **pre-existing** dangling onboarding link (`README.md:204` /
`onboard.ts:27` → a missing `.bober/architecture/` doc) is **not** introduced by this spec and is
its own follow-up. See the finale record
[`sprint-spec-20260620-graph-tokensave-6-1-compat-2.md`](./sprint-spec-20260620-graph-tokensave-6-1-compat-2.md).

## Codebase Health Remediation — complete (3 of 3)

`spec-20260621-codebase-health-remediation` — acts on the structural findings of
`research-20260621-codebase-health-hotspots-cycles`. Sprint 1 **fully eliminates the genuine
runtime import cycle** between `src/fleet/critic-deep.ts` and `src/fleet/decomposer-deep.ts` — the
live `fleet` cycle the research flagged as highest-priority. Until now both directions carried a
runtime **value** import (`critic-deep` imported `runExpandStage`; `decomposer-deep` imports
`runCritiqueLoop` back) plus a **type** edge (`Outline`); the earlier incident fix `a73526c`
(inc-20260620-cli-tdz-crash) had only lifted the **module-init-time** constant reads into the
dependency-free `decomposer-deep-constants.ts` leaf, leaving the value edges (and their latent
module-init TDZ) intact. This sprint removes `critic-deep`'s **last edge** to `decomposer-deep` by
**dependency injection**: `runCritiqueLoop` gains an injected `expand` function parameter and calls
`input.expand(...)` instead of the imported `runExpandStage`, and the `Outline`/`OutlineArea` types
move into a **new dependency-free leaf** `src/fleet/decomposer-deep-types.ts` that
`decomposer-deep.ts` re-exports for back-compat. After this, `grep 'from "./decomposer-deep.js"'
src/fleet/critic-deep.ts` is **empty** and only a one-directional `decomposer-deep → critic-deep`
edge (not a cycle) remains. `decomposeGoalDeep` (the sole production caller) passes its in-file
`runExpandStage` in; its **exported signature is byte-identical**. **Pure structural refactor, zero
behavior change** — the critique→re-expand→accept-best / never-throw / accept-on-exhaustion
semantics are unchanged (a spy test asserts the injected `expand` is invoked once on a critique
miss). The diff is confined to 4 source files; build / typecheck / lint clean; **2815/2815 tests
green**, all 7 criteria (sc-1-1..sc-1-7) passed iteration 1.

**Sprint 2** addresses the second structural-health finding: `runSprintCycle`'s **7 positional
parameters** — a long argument list that was easy to mis-order. The signature now takes a single typed
**`RunSprintCycleParams`** options object (a new `export interface` carrying the same 7 fields with
`pipelineRunId` optional), the body gains exactly **one** destructure line, and all **6 invocations**
(1 production + 5 test) were converted to object literals. The production call maps its local
`completedSprints` var into the `completedContracts` field by position — the only non-identity mapping.
`runSprintCycle` stays **internal** (absent from `src/index.ts` and MCP), so there is **no public-API
impact**. **Pure mechanical refactor, zero behavior change** (the retry / evaluator-iteration /
contract-status / reviewer-and-documenter-spawning body is untouched): **2815/2815 tests green**, all 6
criteria (sc-2-1..sc-2-6) passed iteration 1.

**Sprint 3 closes the plan** by acting on the dead-code finding: it **removes the two verified
orphans** — `stashAndRestore` (`src/utils/git.ts`) and `saveOutline` (`src/state/outline-state.ts`) —
plus their two barrel re-export lines. Both were exported solely through a barrel
(`src/utils/index.ts`, `src/state/index.ts`) with **zero** call sites (grep-verified), so the removal
shrinks the public surface with **zero behavior change**. `outline-state.ts` is **kept** because its
other export `readOutline` is **live** (`pipeline.ts:58` import, `:828` call) — only `saveOutline` and
the now-unused `writeFile` / `ensureDir` imports it pulled in were pruned (a **mandatory** prune:
`noUnusedLocals` would otherwise fail the build). Crucially, the dead-code work **confirmed 3 of the 5
research candidates were false positives** and **left them untouched**: `runPlanAnswerInteractive`
(live caller `cli/index.ts:152`), `summarizeSprint` (live caller `context-handoff.ts:171`), and
`readBriefing` (public API via `src/index.ts:153`); dynamic-dispatch candidates (checkpoint renderers,
registry lookups, `createBoberMCPServer`) were also out of scope. After the sprint
`grep -rnE '\b(stashAndRestore|saveOutline)\b' src/` is **empty**; the diff is confined to 4 files;
**2815/2815 tests green**, all 5 required criteria (sc-3-1..sc-3-5) passed iteration 1.

| # | Record | What it added |
|---|--------|---------------|
| 1 | [sprint-spec-20260621-codebase-health-remediation-1.md](./sprint-spec-20260621-codebase-health-remediation-1.md) | **Fully break the `critic-deep` ↔ `decomposer-deep` runtime import cycle (dependency injection):** new dependency-free leaf `src/fleet/decomposer-deep-types.ts` (`OutlineArea`/`Outline`, **0 relative imports**, mirrors `decomposer-deep-constants.ts`); `critic-deep.ts` **deletes** its `./decomposer-deep.js` import (value **and** type) and imports `Outline` from `./decomposer-deep-types.js`; `runCritiqueLoop` (`critic-deep.ts:211`) gains an injected `expand: (input) => Promise<FleetManifest>` param (`:218`) and calls `input.expand(...)` (`:258`) in place of the imported `runExpandStage`; `decomposer-deep.ts` `import type`s + **re-exports** `Outline`/`OutlineArea` from the leaf (`:89-90`, public surface unchanged) and at `:371` passes `expand: runExpandStage` into `runCritiqueLoop`; `decomposeGoalDeep` (`:341`, sole production caller) **exported signature byte-identical**; `critic-deep.test.ts` supplies `expand` to all 8 existing `runCritiqueLoop` calls + 1 new sc-1-7 spy test (injected fn invoked once on a critique miss); supersedes `a73526c`'s module-init-only mitigation (constants leaf retained, `decomposer-deep-load-order.test.ts` guard still applies); **Cycle 1** (`fact-judge` ↔ `reconcile`, type-only) deliberately untouched; commit `349c22c`, 4 source files; suite **2815/2815**, all 7 criteria iter-1, no regression |
| 2 | [sprint-spec-20260621-codebase-health-remediation-2.md](./sprint-spec-20260621-codebase-health-remediation-2.md) | **Collapse `runSprintCycle`'s 7 positional params into a single typed `RunSprintCycleParams` object:** new `export interface RunSprintCycleParams` (`pipeline.ts:158`, 7 fields — `contract`/`spec`/`completedContracts`/`projectRoot`/`config`/`projectContext`/`pipelineRunId?`, names mirror the former params); signature `runSprintCycle(params: RunSprintCycleParams)` (`:168`) with the **only** body delta a destructure at `:171`; production caller `runTsPipeline` passes an object literal at `:936`, mapping local `completedSprints → completedContracts` by position (`:939`); the 5 test call sites (`code-reviewer-agent.test.ts:229,333`; `documenter-agent.test.ts:229,265,299`) converted to object literals; `runSprintCycle` stays **internal** (grep `src/index.ts` + `src/mcp/` empty, no public-API change); **zero behavior change** (retry/evaluator/status/reviewer-documenter body untouched); diff confined to 3 files; commit `c7e721c`, suite **2815/2815**, all 6 criteria iter-1, no regression |
| 3 | [sprint-spec-20260621-codebase-health-remediation-3.md](./sprint-spec-20260621-codebase-health-remediation-3.md) | **Finale — remove the two verified dead-code orphans `stashAndRestore` + `saveOutline`:** **deleted** `stashAndRestore<T>(cwd, fn)` from `src/utils/git.ts` (was `:149-171`, fn + doc; no import change) and de-listed it from the `./git.js` re-export in `src/utils/index.ts`; **deleted** `saveOutline(projectRoot, specId, content)` from `src/state/outline-state.ts` (fn + doc) and de-listed it from the `./outline-state.js` re-export in `src/state/index.ts`; **pruned** the now-unused `writeFile` + `ensureDir` imports in `outline-state.ts` (kept `readFile`) — a **mandatory** prune (`noUnusedLocals`); **`outline-state.ts` KEPT** because `readOutline` is live (`pipeline.ts:58` import, `:828` call), still re-exported; **3 false positives left untouched** — `runPlanAnswerInteractive` (live `cli/index.ts:152`), `summarizeSprint` (live `context-handoff.ts:171`), `readBriefing` (public API `src/index.ts:153`); dynamic-dispatch candidates out of scope; `grep '(stashAndRestore\|saveOutline)' src/` **empty**, diff confined to 4 files; **zero behavior change**; commit `a980d30`, suite **2815/2815**, all 5 required criteria (sc-3-1..sc-3-5) iter-1, no regression |

### Plan close-out

`spec-20260621-codebase-health-remediation` is **complete (3 of 3)** on branch
`bober/medical-team` — each sprint passed evaluation on iteration 1 (zero reworks), **2815/2815 tests**
green throughout. The plan acted on the structural findings of
`research-20260621-codebase-health-hotspots-cycles` with **zero behavior change across all three
sprints**:

- **Sprint 1 — broke the one genuine runtime import cycle** (the `fleet`
  `critic-deep` ↔ `decomposer-deep` value cycle): `critic-deep` now holds **zero** edges to the cycle
  node, the re-expand function is **injected** rather than imported, and `Outline` lives in a
  dependency-free leaf. The remaining `decomposer-deep → critic-deep` edge is one-directional and not
  a cycle. **Cycle 1** (`orchestrator/memory/fact-judge.ts` ↔ `reconcile.ts`) is `import type`-only —
  erased at compile time, no runtime cycle — and was **deliberately out of scope**.
- **Sprint 2 — collapsed `runSprintCycle`'s 7 positional parameters** into a single typed
  `RunSprintCycleParams` **options object** (pure mechanical refactor, internal-only). `runSprintCycle`
  now takes a params object rather than a mis-orderable positional list.
- **Sprint 3 — removed the two verified dead-code orphans** `stashAndRestore` (`src/utils/git.ts`) and
  `saveOutline` (`src/state/outline-state.ts`) plus their barrel re-export lines (`outline-state.ts`
  kept — `readOutline` is live). Critically, this work **confirmed that 3 of the 5 research candidates
  were false positives** — `runPlanAnswerInteractive`, `summarizeSprint`, and `readBriefing` have live
  callers / are public API and were **left untouched** — so the plan removed exactly the 2 genuinely
  dead exports and nothing more.

Overall outcome: the genuine fleet runtime cycle is broken, `runSprintCycle` takes a params object,
and two dead-code orphans are gone. See the records
[`sprint-spec-20260621-codebase-health-remediation-1.md`](./sprint-spec-20260621-codebase-health-remediation-1.md),
[`sprint-spec-20260621-codebase-health-remediation-2.md`](./sprint-spec-20260621-codebase-health-remediation-2.md),
and
[`sprint-spec-20260621-codebase-health-remediation-3.md`](./sprint-spec-20260621-codebase-health-remediation-3.md).

## Plan→Contracts Materialization — complete (3 of 3)

`spec-20260623-plan-contracts-materialization` — refactor the run pipeline's sprint-contract
creation into a reusable helper so a standalone `plan` path can share it, and make contract ids
deterministic. **The plan is complete (3 of 3) and the original bug is fixed end-to-end:**
`plan` → `sprint` works without the full `run` pipeline. The arc was: **(1)** extract the
inline materialization loop into a shared deterministic `materializeContracts` helper; **(2)**
give that helper an embedded branch and eagerly wire it into all three `plan` entry points so a
ready plan writes its contracts immediately — this **closed** the standalone plan→sprint gap
that made `sprint` error *"No sprint contracts found"* after a bare `plan`; **(3)** scope the
`sprint` command to the active spec's contracts and add a `needs-clarification` guard so the
freshly-materialized contracts are consumed safely even when older specs' contracts linger on
disk. Sprint 1 is the **extraction step only**: it pulls the inline contract-creation loop
out of `runTsPipeline` (the old `pipeline.ts:~856-906` block) into a new exported async helper
`materializeContracts(spec, projectRoot, config)` in `src/orchestrator/contract-materialization.ts`,
which `runTsPipeline` now calls in one line (`pipeline.ts:853`). The extraction is **verbatim** —
same `createContract` inputs (criteria mapped with `verificationMethod: "agent-evaluation"`), same
`generateContractPrecision` call, same log strings, same order — with **one authorized behavioral
change**: feature-derived contracts now get a **deterministic, zero-padded `sprint-<specId>-NN`**
id (overriding `createContract`'s `sprint-${Date.now()}-${counter}` default *after* construction)
so `listContracts()` lexical filename ordering equals sprint execution order (`-09` before `-10`).
The post-plan (`pipeline.ts:844`) and post-sprint-contract (`pipeline.ts:857`) audit checkpoints
**stay in the pipeline** on either side of the call; the helper carries **zero**
audit/checkpoint/history logic. The helper is orchestrator-internal (not re-exported from
`src/index.ts`) and as of that sprint had exactly **one caller** (`runTsPipeline`). Sprint 2
**closes the original bug** — it gives `materializeContracts` an **embedded branch** (use valid
`spec.sprints` *objects* verbatim, status→`proposed`, deterministic ids; any parse/precision
failure → whole-set feature-derived fallback, no throw, no partial mix) and **eagerly wires it
into all three `plan` entry points** (`runPlanCommand` + the two `plan answer` paths), which
**clear-then-materialize** the current spec's contracts on resolve→`ready` (skipped for
`needs-clarification`) via the new `clearContractsForSpec(projectRoot, specId)` helper. The
next-step hint across all paths was corrected from `run` (which re-plans and ignores the fresh
contracts) to `npx agent-bober sprint` (which consumes them) — the iteration-1 fail was this
hint *semantics* (S2-C6); fixed in iteration 2. **Standalone `plan` → `sprint` now works
end-to-end.** NB bober-authored specs store `spec.sprints` as contractId *strings* (which
safeParse-reject → fallback); the embedded branch is for external/planner specs that emit full
sprint *objects*. Sprint 3 **closes the plan** — it scopes `runSprintCommand` (`src/cli/commands/sprint.ts`)
to the active spec by filtering `listContracts` to `c.specId === spec.specId` **before**
`findNextPendingSprint` (stale other-spec contracts can no longer run), refuses a
`needs-clarification` spec (prints the open questions + the correct `plan answer` hint and
returns **before** invoking the generator), and improves the empty-contracts message to point at
`plan` (re-materialize) or `run` (full pipeline) — the single-spec flow is provably unchanged.
**2 iterations**: iter-1 (`6f4029d`) used a non-existent `plan-answer` (hyphen) hint and failed
S3-C3; iter-2 (`559025f`) corrected it to `plan answer` (space, interpolating `spec.specId`) +
test assertion; passed 5/5. **The standalone plan→sprint bug is now fixed end-to-end.**

| # | Record | What it added |
|---|--------|---------------|
| 1 | [sprint-spec-20260623-plan-contracts-materialization-1.md](./sprint-spec-20260623-plan-contracts-materialization-1.md) | Extraction step: new exported `materializeContracts(spec, projectRoot, config): Promise<SprintContract[]>` (`src/orchestrator/contract-materialization.ts`) replaces `runTsPipeline`'s inline contract-creation loop (verbatim content: `createContract` + `generateContractPrecision` + same logs/order); **sole behavioral change** = deterministic zero-padded `sprint-<specId>-NN` ids (override `createContract`'s `Date.now` default) so `listContracts()` lexical order == `sprintNumber` order for 12+ sprints; post-plan + post-sprint-contract checkpoints stay in `pipeline.ts` (helper has zero audit logic); orchestrator-internal, one caller; **extraction only — standalone plan→sprint wiring is Sprint 2, not shipped here** |
| 2 | [sprint-spec-20260623-plan-contracts-materialization-2.md](./sprint-spec-20260623-plan-contracts-materialization-2.md) | **Closes the bug** — `materializeContracts` gains an embedded branch (valid `spec.sprints` *objects* used verbatim: status→`proposed`, `specId` rebound, deterministic `sprint-<specId>-NN` ids; any parse/precision failure → **whole-set** feature-derived fallback, no throw/partial mix) + new `clearContractsForSpec(projectRoot, specId)` (`src/state/sprint-state.ts`, re-exported) deleting only that spec's contract files; all three `plan` entry points (`runPlanCommand` + `runPlanAnswerCommand` + `runPlanAnswerInteractive`) **clear-then-materialize** on resolve→`ready` (skipped for `needs-clarification`; `plan answer` paths non-fatal `try/catch`) so `sprint` finds contracts — **standalone plan→sprint works**; all next-step hints corrected `run`→`npx agent-bober sprint`. **2 iterations**: iter-1 (`36de025`) failed S2-C6 on hint semantics (`run` re-plans/ignores fresh contracts), iter-2 (`bef849e`) fixed hints + materialize-on-`plan answer`; passed 6/6 |
| 3 | [sprint-spec-20260623-plan-contracts-materialization-3.md](./sprint-spec-20260623-plan-contracts-materialization-3.md) | **Finale** — hardens `runSprintCommand` (`src/cli/commands/sprint.ts`): filters `listContracts` to `c.specId === spec.specId` **before** `findNextPendingSprint` so only the **active** (latest) spec's contracts run (stale other-spec contracts ignored); adds a `needs-clarification` guard (prints open questions via `getOpenClarifications` + the correct `plan answer` hint, returns **before** the generator — never spawns it); improves the empty-contracts message to point at `plan` (re-materialize) or `run` (full pipeline). Single-spec flow provably unchanged (filter is a no-op); **no** multi-spec parallel exec, **no** `dependsOn` topo-ordering (both non-goals). **2 iterations**: iter-1 (`6f4029d`) used a non-existent `plan-answer` (hyphen) hint, failed S3-C3; iter-2 (`559025f`) corrected it to `plan answer` (space, interpolating `spec.specId`) + asserted in the test; passed 5/5. **The standalone plan→sprint bug is fixed end-to-end.** |

## Obsidian Vault Storage Layer — complete (5 of 5 — COMPLETE)

`spec-20260628-obsidian-vault-store` — a **domain-agnostic vault storage layer** where each
per-domain repo is an Obsidian vault: markdown + YAML frontmatter is the **canonical source of
truth** and FactStore (SQLite) becomes a **derived, rebuildable index** over note frontmatter.
**The full layer now exists (5 of 5):** the typed `VaultNote` note model + pure parse/serialize +
filesystem I/O (Sprint 1), the **derived FactStore index** over note frontmatter via the existing
reconcile-at-ingest path (Sprint 2), the `bober vault reindex` CLI command that rebuilds that index
from a vault directory (Sprint 3), an **on-device-only Obsidian MCP read/write adapter** + the
optional `vault.obsidian` config section that declares the MCP server (Sprint 4), and the
`profile.yaml` SOPS-detection hook + the canonical `conventions.ts` (status values + attachments
dir) (Sprint 5). **The `bober vault reindex` CLI** (Sprint 3) walks a vault directory,
parses every note, and rebuilds the derived FactStore at the team/namespace memory path — the same
`facts.db` `bober facts` uses (path parity confirmed) — printing `notesParsed`/`factsAdded`/
`factsSuperseded`/`factsNoop` counts; never throws, always closes the store, defaults `--vault` to
the project root. It is a thin orchestration over the **derived FactStore index from Sprint 2**:
pure `noteToFacts` frontmatter→`FactInput` mapping + `reindexNotes` that writes through the existing
`writeFact` reconcile path (re-run = all `noop`, changed value supersedes, `status:superseded` notes
excluded). **Sprint 4** adds a thin `VaultMcpAdapter` (`src/vault/mcp-adapter.ts`) that **wraps**
(does not fork) the existing `ExternalMcpServer` to `readNote`/`writeNote`/`listNotes` through
configurable tool names (cyanheads/obsidian-mcp-server defaults, overridable), behind an
`isOnDevice()` guard that rejects any non-local server declaration **before** `start()` and a secret
discipline that never logs `mcpEnv`; the on-device server is declared in the optional top-level
`vault.obsidian` config section (`VaultSectionSchema`, mirrors `ObservabilityProviderSchema`).
**Sprint 5** closes the plan with `resolveProfile(vaultDir)` (`src/vault/profile.ts`) — parses a
plaintext `profile.yaml` into a generic `VaultProfile`, returns an opaque `{ encrypted: true }` on
**SOPS detection without decrypting** (top-level `sops:` key-presence), `undefined` on ENOENT — plus
the canonical `src/vault/conventions.ts` (`ACTIVE_STATUS`/`SUPERSEDED_STATUS`/`ATTACHMENTS_DIR`) and a
**`SUPERSEDED_STATUS` convergence** that centralizes the constant Sprint 2 had duplicated in
`index-map.ts` and `reindex.ts` (both now re-export it from `conventions.ts`, keeping Sprint-2 tests
green). Sprint 1 lays the **foundation only** — a new `src/vault/` module with the typed
`VaultNote` model (`{ frontmatter, body, path }` + `NoteStatus` enum), **pure** (no fs, no
clock) `parseFrontmatter`/`serializeFrontmatter` + `parseNote`/`serializeNote` over a
**hand-rolled, dependency-free** Dataview YAML subset (string, number, ISO-8601 date *string*,
block/inline list, status enum — quoted strings / nested objects / multi-line scalars
explicitly unsupported), and the `node:fs/promises` + `glob` bridge `readNote`/`writeNote`
(auto-`ensureDir`)/`listNotes` (recursive `**/*.md`, **absolute** paths). Round-trip is
**re-parse-deep-equal**, not byte-identity (arrays always re-emit as block lists; numbers stay
numeric, ISO dates stay parseable strings, lists stay arrays, body preserved verbatim). The
module is **domain-agnostic** — no medical keys, no `src/medical/` import, no network import.
(The FactStore index landed next in Sprint 2; the `bober vault reindex` CLI, the Obsidian MCP
adapter, and the `profile.yaml`/SOPS hook remain Sprints 3–5.) **+18 tests (full suite 2849), no
new deps, all five criteria (sc-1-1..sc-1-5) passed iteration 1.**

| # | Record | What it added |
|---|--------|---------------|
| 1 | [sprint-spec-20260628-obsidian-vault-store-1.md](./sprint-spec-20260628-obsidian-vault-store-1.md) | **Domain-agnostic vault foundation:** new `src/vault/` module — `types.ts` (`VaultNote { frontmatter: Record<string,unknown>; body; path }` + `NoteStatus "active"\|"superseded"`), `frontmatter.ts` (**PURE**, no fs/clock: `parseFrontmatter`/`serializeFrontmatter` + `parseNote`/`serializeNote` over a **hand-rolled dependency-free** Dataview YAML subset — unquoted strings, int/float numbers, ISO-8601 date *strings* (never coerced to `Date`), block `- item` / inline `[a, b]` lists, status enum; quoted/nested/multi-line **unsupported**, flagged for a YAML lib swap), `note-io.ts` (`readNote`/`writeNote` (auto-`ensureDir`)/`listNotes` via `node:fs/promises` + existing `glob`, **absolute** recursive `**/*.md`); round-trip is **re-parse-deep-equal** not byte-identity; no medical keys / no `src/medical/` import / no network; commit `e576e77`, 5 new files, +18 tests, no new deps, suite **2849** green, sc-1-1..sc-1-5 iter-1. **Foundation only — FactStore index / `bober vault reindex` / Obsidian MCP adapter / `profile.yaml` hook are sprints 2–5, not shipped here.** |
| 2 | [sprint-spec-20260628-obsidian-vault-store-2.md](./sprint-spec-20260628-obsidian-vault-store-2.md) | **Derived FactStore index over frontmatter (reconcile-at-ingest):** new `src/vault/index-map.ts` (**PURE**, no fs/clock — `noteToFacts(note, { scope, now, sourceRunId? })` ⇒ one `FactInput` per frontmatter key; `subject = frontmatter.id` else `note.path`; `predicate = key`; `value` stringified — scalars via `String()`, arrays/objects via `JSON.stringify` for stable ids; empty-stringified values **skipped** for `FactSchema value.min(1)`; exports `SUPERSEDED_STATUS`) + `src/vault/reindex.ts` (`reindexNotes(store, notes, { scope, now, sourceRunId?, judge? })` ⇒ `ReindexSummary {notesParsed, factsAdded, factsSuperseded, factsNoop}`; **skips** `status:superseded` notes; writes every fact through the **existing** `writeFact` from `../state/facts.js` — never `store.insertFact` — tallying `add`/`update`/`noop`; clock-free, `now` injected). Re-run over unchanged notes = all `noop` (active count unchanged), changed value supersedes the prior fact (`t_invalidated` set), superseded notes contribute **0** active facts; no judge ⇒ deterministic ADD fallback (`reconcile.ts:93-96`). `facts.ts`/`reconcile.ts` untouched. commit `01d17b4`, 2 new src + 2 test files, +20 tests (13 map + 7 reindex), no new deps, suite **2869** green, sc-2-1..sc-2-5 iter-1. **Index is in-process only — `bober vault reindex` CLI is Sprint 3.** |
| 3 | [sprint-spec-20260628-obsidian-vault-store-3.md](./sprint-spec-20260628-obsidian-vault-store-3.md) | **`bober vault reindex` CLI (orchestrates Sprint 1/2 from the command tree):** new `src/cli/commands/vault.ts` — `registerVaultCommand(program)` (wired into `src/cli/index.ts` import `:41`, call `:323`, between medical and fleet) exposing `vault reindex --scope <domain> [--vault <dir>]`, plus the extracted testable core `runVaultReindex(projectRoot, opts, deps?)` ⇒ `Promise<ReindexSummary \| undefined>` (`VaultReindexDeps { nowIso? }`). Resolves the FactStore at the team/namespace path via a **local `resolveDefaultNamespace` byte-identical to facts.ts's private impl** (path parity evaluator-confirmed ⇒ same `facts.db` as `bober facts`); `ensureFactsDir` → construct store **before** the explicit `stat()` vault guard (so `finally` always `close()`s; `listNotes`/glob returns `[]` not throws for a missing dir) → `listNotes`/`readNote` → Sprint 2 `reindexNotes` → prints `notesParsed`/`factsAdded`/`factsSuperseded`/`factsNoop` (chalk.green). **Never throws** — error ⇒ chalk.red stderr + `process.exitCode=1` + returns `undefined`; `now` read **once** at the boundary; `--vault` defaults to projectRoot; **read-only over the vault** (no note mutation, no git). Sprint 2 `reindex.ts` logic unchanged. commit `82ebc23`, 1 new src + 1 test file + 4-line index.ts wiring, 3 tests (sc-3-3 success, sc-3-4 missing-vault no-throw/exit1/close, sc-3-2 commander wiring), no new deps, suite **2872** green, sc-3-1..sc-3-4 iter-1. **Note:** `resolveDefaultNamespace` re-implemented locally (facts.ts doesn't export it) — keep in lockstep. **Obsidian MCP adapter + `profile.yaml`/SOPS hook remain Sprints 4–5.** |
| 4 | [sprint-spec-20260628-obsidian-vault-store-4.md](./sprint-spec-20260628-obsidian-vault-store-4.md) | **On-device Obsidian MCP read/write adapter + config:** new optional top-level `vault` config section — `VaultObsidianSchema`/`VaultSectionSchema` (`src/config/schema.ts:424`/`:448`, registered `:485`) mirrors `ObservabilityProviderSchema` (`name`/`mcpCommand`/`mcpArgs?`/`mcpEnv?`/`enabled`) + an optional `toolNames` record (cyanheads/obsidian-mcp-server defaults, overridable); `mcpEnv` is an opaque secret. New `src/vault/mcp-adapter.ts` — `VaultMcpAdapter` **wraps** (does not fork) the existing `ExternalMcpServer` via an injected `McpServerLike` `{start,listTools,callTool,stop}` interface (tests inject a fake, no subprocess), exposing `readNote`→sprint-1 `parseNote` / `writeNote`→sprint-1 `serializeNote` / `listNotes` / `stop` through configurable tool names (`DEFAULT_VAULT_TOOL_NAMES`). Exported `isOnDevice(cfg)` guard rejects remote URL-scheme `mcpCommand` (`https?\|wss?\|ftp\|tcp://`) or non-loopback-host `mcpArgs` and runs **before** `start()` on every read/write/list (eval asserts `startSpy` never called on rejection); the refusal error names only `config.name` — **`mcpEnv` is never logged/stringified**. **Not wired into reindex** (independent read/write surface; `src/mcp/external-client.ts` untouched). impl commit `4f5288d` + lint-fix `0185daf` (iter-1 failed only on an unused `beforeEach` import — no logic rework); `src/config/schema.ts` (+36) + new `mcp-adapter.ts` + 62 collocated schema/adapter tests, no new deps, suite **2907** green, sc-4-1..sc-4-4 iter-2. |
| 5 | [sprint-spec-20260628-obsidian-vault-store-5.md](./sprint-spec-20260628-obsidian-vault-store-5.md) | **Finale — `profile.yaml` SOPS-detection hook + conventions + `SUPERSEDED_STATUS` convergence:** new `src/vault/profile.ts` — `resolveProfile(vaultDir)` ⇒ `Promise<VaultProfile \| {encrypted:true} \| undefined>`: reads `<vaultDir>/profile.yaml` via `node:fs/promises`, reuses the **sprint-1** `parseFrontmatter` (wraps the standalone YAML in `---`), **detects SOPS via top-level `sops:` key-PRESENCE without decrypting** (`{encrypted:true}`, no value/ciphertext leak), ENOENT⇒`undefined`; **clock/crypto/sops-free** (`VaultProfile` is a generic open `Record`, no medical coupling). New `src/vault/conventions.ts` — canonical `ACTIVE_STATUS`/`SUPERSEDED_STATUS` (`NoteStatus`) + `ATTACHMENTS_DIR='attachments'` (binary attachments stay **out of git** — doc-convention only, no runtime enforcement). **Convergence refactor:** `index-map.ts` + `reindex.ts` now import-and-re-export `SUPERSEDED_STATUS` from `conventions.ts` (Sprint-2 import paths byte-identical, 20 convergence tests green) and `reindex.ts`'s orphaned `NoteStatus` import was removed (was a `noUnusedLocals` build-breaker). commit `bb95d3b`, 2 new src + 1 test file (4 tests) + 2 convergence edits, no new deps, full suite **2911** green, sc-5-1..sc-5-4 iter-1 (eval run orchestrator-direct due to a subagent session limit — every strategy/criterion independently re-executed). **The plan is complete (5 of 5).** |

User-facing usage for `bober vault reindex` lives in [`COMMANDS.md`](../../COMMANDS.md). The optional
`vault.obsidian` on-device MCP config section (Sprint 4) is in the README "Full Configuration
Reference".

### Plan close-out

`spec-20260628-obsidian-vault-store` is **complete (5 of 5)** — the full domain-agnostic vault storage
layer now exists: the typed `VaultNote` note model + pure parse/serialize + filesystem I/O (Sprint 1),
the **derived, rebuildable FactStore index** over note frontmatter via the existing reconcile-at-ingest
path (Sprint 2), the `bober vault reindex` CLI that rebuilds that index from a vault directory (Sprint
3), an **on-device-only Obsidian MCP read/write adapter** + the optional `vault.obsidian` config
section (Sprint 4), and the `profile.yaml` SOPS-**detection** hook + canonical `conventions.ts`
(status values + attachments dir) with the `SUPERSEDED_STATUS` convergence (Sprint 5). Markdown +
YAML frontmatter is the **canonical source of truth** and SQLite FactStore is a derived projection.
The layer is **domain-agnostic** — no medical/financial coupling, no network import outside the
on-device MCP adapter, which itself **refuses any non-local declaration before spawning**. SOPS
decryption is deliberately **not** implemented — Sprint 5 leaves only the detection hook. Full suite
**2911 tests** green, all 23 criteria across the five sprints passed (Sprints 1/2/3/5 iter-1, Sprint 4
iter-2 on a lint-only fix).

## Medical Ingest — Lab-PDF Parser — complete (5 of 5)

`spec-20260628-medical-ingest` — the **lab-ingestion leg** of the medical knowledge template: a lab-report
PDF is parsed (Claude `document` block, **no OCR**) into structured markers, written as
markdown-with-frontmatter notes in the canonical vault, reindexed into the existing `HealthDataStore`, with
a markdown-frontmatter supplements list and a SOPS-encrypted personalization `profile.yaml` rounding out the
plan. **Sprint 1 lands the lowest layer only:** a pure `parseLabPdf(pdfBytes, deps)` that base64-encodes a
native-text PDF, sends it to Claude as a `document` content block through an **injectable** `LLMClient` with
schema-constrained output, and returns a **Zod-validated** `ParsedLabReport` (panel, ISO collection date,
markers each with name / numeric value / unit / optional reference low+high+critical) — malformed model
output throws a `ZodError` and is **never returned unvalidated**. To carry the PDF, `ChatParams` gains an
**additive, optional** `documents` field that **only the Anthropic adapter** renders as a base64
`application/pdf` document block prepended to the first user message; every other adapter ignores it and a
request without `documents` is **byte-identical** to prior behaviour. There is **no CLI command, no vault
writing, and no store reindex** in this sprint — those are Sprints 2 (`Lab-note vault writer + reindex`) and
3 (`bober medical import-labs <pdf>`); supplements (Sprint 4) and the SOPS `profile.yaml` (Sprint 5) follow.
**Sprint 3 lands the first user-facing command** — `bober medical import-labs <pdf>` — wiring the Sprint 1
parser and Sprint 2 vault writer/reindex behind the **fail-closed `cloud-inference` egress gate**: with the
axis off (default) it prints a clear message naming `medical.egress.cloudInference`, exits 1, and reads **no
PDF bytes**; only when opted in does it parse → write notes → reindex → append an IDs/enums-only audit
`ingest` entry, with re-imports adding **zero** new rows. **Ships nothing to cloud by default.**
**Sprint 4 adds the supplements leg** — a deterministic, no-LLM `bober medical supplements
add|list` pair (nested under the `medical` command tree) that records a `{ name, dose }` entry
as a **FactStore fact under the `medical` scope** (`subject=name`, `predicate="dose"`) via the
existing `writeFact` reconcile with **no judge**; re-adding an identical name+dose is an
**idempotent NOOP** (active-fact count stays 1). Supplements are intentionally FactStore facts,
**not** `HealthDataStore` lab rows, and use a different subject/predicate shape from medications
(ADR-7). `list` prints entries from a markdown-frontmatter file (default
`.bober/medical/supplements.md`). **Sprint 5 closes the plan with the personalization-profile
leg** — a Zod-validated `ProfileSchema` (age / sex / conditions / medications / supplements /
allergies / goals) persisted as a **SOPS-encrypted `<vaultDir>/profile.yaml`** behind an
**injectable cipher seam** (default = `sops` age backend via `execa`). `writeProfile` /
`readProfile` are **fail-closed**: `cipher.available()` is checked **before** any serialize /
encrypt / disk IO, so when `sops` is unavailable both paths reject with a clear message and
**plaintext PHI never reaches disk**. The new `bober medical profile show|set` are nested
`medical` subcommands. **The plan is complete (5 of 5); 2975 tests pass.**

| # | Record | What it added |
|---|--------|---------------|
| 1 | [sprint-spec-20260628-medical-ingest-1.md](./sprint-spec-20260628-medical-ingest-1.md) | **Lab-PDF → structured JSON parser + `ChatParams.documents` plumbing:** new `src/medical/lab-types.ts` (`ParsedLabMarkerSchema` `{ name, value:number, unit, referenceLow?, referenceHigh?, critical? }` + `ParsedLabReportSchema` `{ panel, collectedAtIso, markers[] }` + inferred types) and `src/medical/lab-pdf-parser.ts` — `parseLabPdf(pdfBytes: Uint8Array, deps: { client: LLMClient; model: string }): Promise<ParsedLabReport>` base64-encodes the PDF, sends it via `client.chat({ documents:[{base64, mediaType:"application/pdf"}], responseSchema })`, `JSON.parse`s `response.text`, and returns `ParsedLabReportSchema.parse(...)` — **throws `ZodError` on malformed output, never coerces** (internal hand-written `LAB_REPORT_JSON_SCHEMA` literal as the `responseSchema`; markers map onto the existing `LabResult` shape `src/medical/types.ts:118`). Provider plumbing: **additive optional** `ChatParams.documents?: { base64: string; mediaType: string }[]` (`src/providers/types.ts:190`) rendered **only** by the Anthropic adapter (`src/providers/anthropic.ts:228`) as `{ type:"document", source:{ type:"base64", media_type, data } }` blocks **prepended to the first user message**, injected **before** the cache-breakpoint pass; **non-Anthropic adapters untouched** (`openai.ts`/`google.ts`/`openai-compat.ts`/`claude-code.ts`), no-`documents` request **byte-identical** (snapshot-guarded). Tests inject a fake/scripted `LLMClient` — **no network**; malformed-output tests use `.rejects.toThrow()` on the Zod parse. commit `be98982`, 3 new files + 2 provider edits + 4 sc-1-5 adapter tests, no new deps, suite **2921** green (+10), sc-1-1..sc-1-5 iter-1. **Plumbing only — `bober medical import-labs` CLI, vault-note writing, and reindex are Sprints 2–3.** |
| 2 | [sprint-spec-20260628-medical-ingest-2.md](./sprint-spec-20260628-medical-ingest-2.md) | **Lab-note vault writer + derived `HealthDataStore` reindex + ingest dedup:** new `src/medical/lab-note.ts` — pure/sync `deriveLabStatus(value, refLow?, refHigh?, critical?)` ⇒ `low`/`normal`/`high`/`critical` (critical flag wins, missing bounds ⇒ `normal`, **no LLM**), a **hand-rolled** flat-scalar YAML-frontmatter writer + `parseLabNote` (mirrors `src/vault/frontmatter.ts` but **never imports `src/vault`** — build stays independent of the sibling spec's timing), and `writeLabNote(vaultDir, marker, meta)` ⇒ `<vaultDir>/labs/<panel-slug>/<marker-slug>-<date>.md` with the 10 frontmatter keys `marker`/`value`/`unit`/`ref_low`/`ref_high`/`ref_range`/`date`/`status`/`panel`/`source`. New `src/medical/lab-reindex.ts` — `reindexLabNotes(vaultDir, store)` globs `<vaultDir>/labs/**/*.md`, parses each note's frontmatter back to a `LabResult`, upserts via `HealthDataStore.upsertLabResult`, and returns the **genuine new-row count**. Architecture: **vault markdown is canonical; `HealthDataStore.lab_results` is a derived, rebuildable index**; dedup is the deterministic `labResultId(biomarker, collectedAtIso, value)` SHA-256 under `INSERT OR IGNORE` (`health-store.ts:48,212`), so a **second reindex over unchanged notes returns 0** (`getLabSeries` length unchanged). **Pure file + SQLite** — no `createClient`/`fetch`, no `new Date()`/`Date.now()` (timestamps injected), all `node:fs/promises`. commit `181f30c`, 2 new src + 2 test files (23 new tests), no new deps (`glob` already vendored), suite **2944** green (+33), sc-2-1..sc-2-5 iter-1. **Library only — CLI wiring, egress gating, and audit are Sprint 3.** |
| 3 | [sprint-spec-20260628-medical-ingest-3.md](./sprint-spec-20260628-medical-ingest-3.md) | **`bober medical import-labs <pdf>` end-to-end command (fail-closed + audit + dedup):** the **first user-facing command** of this leg — registered under `medicalCmd` (a **subcommand** of `medical`, NOT a new top-level command), delegating to an exported, testable `runImportLabs(projectRoot, pdfPath, deps?, opts?)` (`src/cli/commands/medical.ts:153`) that mirrors the `runWhoopSync`/`WhoopSyncDeps` injection pattern via `ImportLabsDeps { parse?: typeof parseLabPdf; nowIso? }` (`:132`). **LOAD-BEARING fail-closed order:** `EgressGuard.fromConfig` → `cloud-inference` axis check (`:165`) — when **off (default)** it writes a clear message naming `medical.egress.cloudInference`, sets `process.exitCode = 1`, and **returns BEFORE `buildMedicalInferenceClient` (`:175`), `readFile` (`:177`), or `parse` (`:179`)** (sc-3-3 proves the injected parser spy `callCount === 0` + no `labs/` dir + `exitCode === 1` + stderr names the axis). When **on**: build client → read PDF → `parse` → `writeLabNote` per marker → `reindexLabNotes` into `HealthDataStore` at `.bober/medical/health.db` (`:195`) → append an **IDs/enums-only** audit `{ tIso, event: "ingest" }` (`:198`, no marker/value/panel/count/PHI) → print `records parsed`/`new rows`; `store.close()` in `finally`, never throws. **Ingest-time dedup** is inherited (`reindexLabNotes` → `INSERT OR IGNORE`): a second import of the same report reports `new rows: 0` (sc-3-4). `--vault <dir>` overrides the note dir (default under `.bober/medical`). Tests inject a fake parser + fixed `nowIso` — **no network**. commit `cd4a2ea`, modified `medical.ts` + `medical.test.ts` (3 new tests), no new deps, suite **2947** green (+3), sc-3-1..sc-3-4 iter-1. **First user-facing command of the spec — supplements (Sprint 4) and SOPS `profile.yaml` (Sprint 5) follow.** |
| 4 | [sprint-spec-20260628-medical-ingest-4.md](./sprint-spec-20260628-medical-ingest-4.md) | **Supplements markdown-frontmatter list → FactStore + `bober medical supplements add\|list`:** new `src/medical/supplements.ts` — a **hand-rolled** markdown-frontmatter list parser `parseSupplementsFile` (`Name \| dose` items between `---` fences; mirrors `lab-note.ts`, **never imports `src/vault`**), a `FactInput` builder `supplementToFact(name, dose, now)` (`scope:"medical"`, `subject:<name>`, `predicate:"dose"`, `value: dose ?? "unspecified"`/`DEFAULT_DOSE` — `FactSchema value.min(1)`; `confidence:1`, `sourceRunId:null`, injected `now`), and testable cores `runSupplementAdd`/`runSupplementList` (`SupplementAddDeps { store?; now? }` DI). `add` reconciles one entry into **FactStore** under the `medical` scope via the existing `writeFact` with **NO judge** (deterministic ADD/UPDATE/NOOP) — re-adding an identical name+dose is an **idempotent NOOP** (`reconcileFact` exact-match ⇒ `"noop"`, `getActiveFacts("medical")` length stays **1**, sc-4-3); a changed dose UPDATEs. `list` parses the markdown file (default `.bober/medical/supplements.md`, `--file` override) and prints each `name: dose`. Supplements deliberately diverge from medications in FactStore shape (ADR-7): `subject=name`/`predicate="dose"` (own subject row) vs meds' `subject="patient"`/`predicate="takes-medication"`; and they are **FactStore** facts, **not** `HealthDataStore` `lab_results` rows. Nested under the `medical` command tree (`src/cli/commands/medical.ts:293`), **not** a top-level command; `now` stamped once at the CLI boundary, both `.action()`s never throw (stderr + `process.exitCode=1`). Guardrail grep: **0** `createClient`/`fetch`/`Date.now()`/`FactJudge`/`src/vault` in executable code. commit `90842ec`, 1 new src + 1 test file (15 tests) + 29-line CLI subtree, no new deps, suite **2962** green (+15), sc-4-1..sc-4-4 iter-1. **Supplements leg complete — SOPS `profile.yaml` (Sprint 5) is the finale.** |
| 5 | [sprint-spec-20260628-medical-ingest-5.md](./sprint-spec-20260628-medical-ingest-5.md) | **Finale — personalization `profile.yaml` (SOPS-encrypted, injectable cipher) + `bober medical profile show\|set`:** new `src/medical/profile.ts` — Zod `ProfileSchema { age:int>=0, sex:enum(male\|female\|other), conditions/medications/supplements/allergies/goals:string[].default([]) }` (`parse` rejects negative age + unknown sex, sc-5-4); injectable `ProfileCipher` seam `{ available():boolean (sync), encrypt, decrypt }` (default `createSopsCipher` = `sops --version` `execaSync` probe + `sops --encrypt/--decrypt` over stdin via `execa` — age backend, **already-vendored dep**); **hand-rolled flat-YAML** `emitProfileYaml`/`parseProfileYaml` (scalars + `string[]`, **no YAML dep, never imports `src/vault`**); `writeProfile`/`readProfile` are **FAIL-CLOSED** — `cipher.available()` checked at `profile.ts:212` **before** `emitYaml`(`:218`)/`writeFile`(`:222`) and `:237` before `readFile`(`:242`), so when sops is unavailable **both reject + no plaintext PHI on disk** (sc-5-3; on-disk file is ciphertext, sc-5-2 round-trips age/sex/goals + arrays through a reversible fake cipher); testable cores `runProfileShow`/`runProfileSet` (`ProfileDeps { cipher? }` DI; set = read-modify-revalidate-write, safe default `{age:0,sex:"other"}` on ENOENT, array keys comma-split) **never throw** (stderr + `process.exitCode=1`). Nested `profile show|set` subtree under the `medical` command tree (`src/cli/commands/medical.ts:323`), **not** a top-level command; `--vault` overrides (default `.bober/medical`). **No real sops binary in tests** (fake cipher injected); profile is the small structured snapshot only — markdown bodies stay plaintext, `FactStore` stays canonical for med/supplement facts (lists are a denormalized snapshot). commit `9895965`, 1 new src + 1 test file (13 tests) + 26-line CLI subtree, no new deps, suite **2975** green (+13), sc-5-1..sc-5-4 iter-1. **The plan is complete (5 of 5).** |

User-facing usage for `bober medical import-labs <pdf>` is in [`COMMANDS.md`](../../COMMANDS.md) (Medical
Team Commands), the README "Medical team (Phase 6)" command list, and [`../teams.md`](../teams.md) (medical
intro block + "Ingestion"). The command is **fail-closed behind the `cloud-inference` egress axis (default
off)** — it ships nothing to cloud by default. The `bober medical supplements add|list` commands (Sprint 4)
and the `bober medical profile show|set` commands (Sprint 5) are documented in the same three places — the
profile is **SOPS-encrypted (age backend, local, no egress)** and read/write **fail closed** (refuse, no
plaintext PHI) when `sops` is unavailable. The Anthropic-only `documents` provider capability is noted in
[`../providers.md`](../providers.md). The medical data store this leg reindexes into (vault-canonical,
store-as-derived-index) is described in [`../teams.md`](../teams.md) under "Numerics + data store".

### Plan close-out

`spec-20260628-medical-ingest` is **engineering-complete (5 of 5)** on branch `bober/medical-team` — all
five sprints passed evaluation on iteration 1, **2975 tests** green. The leg gives the medical knowledge
template its full ingestion + personalization surface: lab-report PDFs are parsed into structured markers
(Claude `document` block, no OCR), written as markdown-with-frontmatter notes in the **canonical vault**, and
reindexed into the **derived, rebuildable `HealthDataStore` / `FactStore` indexes**; a deterministic no-LLM
supplements path records `{ name, dose }` entries as FactStore facts; and a SOPS-encrypted `profile.yaml`
holds the structured personalization snapshot. **Zero-egress is preserved throughout:** lab parsing is gated
behind the off-by-default `cloud-inference` axis, the profile cipher is **fail-closed** (no plaintext PHI on
disk when sops is unavailable, no network — age backend is local), and audit entries stay IDs/enums-only.
None of the leg's modules takes a **hard import of the sibling `src/vault` module** — the frontmatter
readers/writers are hand-rolled so the build stays independent of that spec's timing. **Shipping still
inherits the base medical team's external S6.5 FFDCA §201(h) counsel + regulatory review gate** — a
non-engineering gate that remains open. See the finale record
[`sprint-spec-20260628-medical-ingest-5.md`](./sprint-spec-20260628-medical-ingest-5.md).

## Medical Analysis — Proactive Review + Recommendation judge-loop — complete (5 of 5)

`spec-20260628-medical-analysis` — the **proactive analysis leg** of the medical knowledge
template: turn the lab data that ingestion wrote into surfaced **Findings** without waiting for a
reactive question. Sprint 1 lands the **deterministic, fully offline** opening pass. A new module
`src/medical/analysis/` adds the `MedicalFinding` field set + a deterministic `findingId`
(`SHA-256(domain|biomarker|ruleKey)`, **`now` excluded** ⇒ idempotent overwrite), a vault writer
(`writeFinding` ⇒ `<vaultDir>/findings/<id>.md`, `writeDashboard` ⇒ a `findings/dashboard.md`
Dataview `TABLE urgency, severity, kind, status` note), a **pure/synchronous** `analyzeTrends`
(Rule A reference-range crossing — `watch` / `risk` at the >20 % boundary; Rule B
slope-toward-nearer-edge; abstains at `sampleCount === 0`; **all** arithmetic delegated to
`NumericsQueryLayer.getLabTrend` per ADR-3, no inline slope math), and the schedulable
`runProactiveReview` entrypoint (opens `.bober/medical/health.db` like `engine.ts:350`, resolves
the vault from the **new optional `medical.vaultDir`** config key or `<root>/.bober/medical/vault`,
closes only stores it opened). Exposed as a `bober medical review` subcommand that reads the wall
clock **only at the CLI boundary** and sets `process.exitCode = 1` on error without throwing. **No
LLM, no network, no `Date.now()` inside the analysis modules; `engine.ts` untouched.** Findings are
emitted as markdown-with-frontmatter into the **canonical vault** — this sprint defines **no**
canonical Zod Finding schema (that is owned by `spec-20260628-priority-hub`, which will aggregate
these notes). Sprint 2 lands the **core safety engine** for the *recommendation* half of the leg: a
**pure, fully injectable** 4-lens judge loop under a new module `src/medical/recommend/`. Candidate
recommendations are gated through four independent lenses (evidence-grader,
contraindication-checker, conservative-clinician, optimization-lens) and reconciled by **strict
majority with an absolute contraindication VETO** (`reconcilePanel` checks the veto **first**, before
the vote — a veto can never be overridden by a majority), regenerating on rejection up to
`MEDICAL_PANEL_MAX_ROUNDS = 3` rounds and **failing CLOSED** (no recommendation surfaced, per-lens
dissent captured) on veto / tie / exhaustion. Two safety invariants — the **fail-closed inversion**
(parse-exhaustion, loop-exhaustion, and a thrown lens client all map to *reject*, mirroring
`grounding-critic.ts:203-206` and inverting fleet's `critic-deep.ts` accept-on-exhaustion) and the
**absolute veto** — were independently verified in source by the evaluator. The worst-case LLM call
count is bounded by `MEDICAL_PANEL_MAX_TOTAL_CALLS = 27` (`= 3 × (1 + 4×2)`). The whole module is
orchestration over **injected** functions — no fs / network / real provider / FactStore — and
`engine.ts` is untouched. **This is the CORE that Sprint 3 wires into a real path** (per-lens model
assignment via tier-policy, the real FactStore profile context, Finding emission, and the CLI);
there is **no `bober medical recommend` command yet** — the judge loop is internal-only this sprint.
Sprint 3 **closes the recommendation loop**: `generateRecommendation` (new
`src/medical/recommend/recommend.ts`) wires the Sprint-2 `runJudgeLoop` into a real path. It
assembles the profile context (meds via `FactStore.getActiveFacts("medical","patient",
"takes-medication")`, supplements via the **`"dose"` predicate**, conditions/allergies/goals via the
SOPS profile reader — all defaulting to empty when absent), builds four per-lens clients (distinct
tier providers when `cloud-inference` is allowed, **all-local fail-closed** via
`buildMedicalInferenceClient` otherwise), generates a candidate, gates it through the panel, and
emits a Finding keyed by outcome: **accepted** ⇒ a `kind: "action"` Finding stating the advice
**directly with no refer-out hedging** + an LLM-assigned urgency/severity/confidence
(`assignUrgencySeverity`, clamped 1..5, conservative default on failure, outside the ADR-3 numerics
boundary by design); **no-consensus** ⇒ a `kind: "question"` Finding **flagged for your review** with
per-lens dissent; **red-flag** ⇒ the canned escalation and **no Finding**. A per-outcome `AuditLog`
entry (IDs/enums only) is appended. Exposed as the new `bober medical recommend [--goal <g>]
<question>` subcommand (clock read **only** at the CLI boundary). Two invariants were independently
verified in source by the evaluator: **fail-closed model selection** (cloud-inference OFF constructs
**no** cloud client — all four lenses + the generator resolve to the local Ollama model) and
**no-refer-out hedging** on accepted Findings. `runJudgeLoop` is imported (not re-implemented), the
Sprint-1 finding-writer is reused, and `engine.ts` is untouched. Sprint 4 **extends the deterministic
offline pass with two new analyzers** and adds a gated dig-deeper path. `cadence.ts` flags biomarkers
**overdue for re-testing** against a CLOSED `RECOMMENDED_CADENCE_DAYS` table (`ldl`/`hba1c`/`tsh`/
`vitamin_d`/`ferritin`; biomarkers **absent** from the table are **skipped** — no guessed cadence), and
`cross-marker.ts` emits a single `kind: "question"` **OFFER** Finding ("want me to dig deeper?") when both
markers of a CLOSED `CROSS_MARKER_PAIRS` pair are out of reference range, persisting the pair in
`tags = ["cross-marker", a, b]` for later recovery — **zero LLM call**. `runProactiveReview` now writes
**trend + gap + cross-marker-offer** findings in one offline pass (DISTINCT ruleKeys keep ids from
colliding, Sprint-1 idempotency preserved), and a new `digDeeper()` dispatcher + a
`bober medical review --dig-deeper <findingId>` flag route the **only** gated, deep analysis through the
Sprint-3 `generateRecommendation` — **delegated, not re-implemented**. The zero-LLM-detection invariant
was confirmed by the evaluator via **grep of `cadence.ts` + `cross-marker.ts` (empty)**, not a test spy;
`engine.ts` is untouched. Sprint 5 **closes the plan** with the **online** complement to Sprint 1's offline
pass: an **egress-gated research job** under a new module `src/medical/research/`. `runResearchJob(projectRoot,
config, {markers, now}, deps?)` gates on the `literature-retrieval` egress axis **first** and returns
`{disabled:true, notesWritten:0, findingsWritten:0}` **before constructing any `LiteratureRetriever` /
`MedlineSource`** — **zero egress** when off. When on, per marker it retrieves MedlinePlus passages, grounds
each through the **fail-closed grounding critic** (`synthesizeGrounded`), and — only for non-abstained answers —
writes a `research/<date>-<marker>.md` citation note (via a new PURE `serializeResearchNote` that **flattens**
`Citation[]` into parallel `citationTitles[]`/`citationUrls[]` + scalar `source: "medlineplus"`, avoiding the
`[object Object]` frontmatter pitfall) plus an optional `kind: "watch"` "new evidence" Finding. Synthesis
**fail-closes to the local Ollama model** via `buildMedicalInferenceClient` unless `cloud-inference` is
independently enabled. A new `bober medical research [--marker <m>]` CLI subcommand reads the clock **only**
at the boundary and never throws. `runResearchJob` is the **schedulable entrypoint** consumed by
`spec-20260628-research-scheduler` (which owns cadence and injects `markers` + `now`); all retrieval /
synthesis / grounding-critic / model-selection primitives are **reused, not re-implemented**, and `engine.ts`
is **byte-unchanged**. The evaluator confirmed all three invariants — **zero-egress-when-off**,
**fail-closed-abstain**, **fail-closed-local-model** — **in source**.

| # | Record | What it added |
|---|--------|---------------|
| 1 | [sprint-spec-20260628-medical-analysis-1.md](./sprint-spec-20260628-medical-analysis-1.md) | **Deterministic offline proactive review pass:** new `src/medical/analysis/` — `MedicalFinding` field set + `findingId(domain,biomarker,ruleKey)` SHA-256 slice (**excludes `now`** ⇒ idempotent, mirrors `observationId`) + `serializeFindingToMarkdown` (reuses `src/vault/frontmatter.ts`); `writeFinding` ⇒ `findings/<id>.md` + `writeDashboard` ⇒ `findings/dashboard.md` fenced `dataview` `TABLE urgency,severity,kind,status` (`node:fs/promises` only); **pure/sync** `analyzeTrends` (Rule A range-crossing `watch`/`risk@>20%` precedence over Rule B slope-toward-edge; abstain at `sampleCount=0`; trend math **only** via `NumericsQueryLayer.getLabTrend`, ADR-3); `runProactiveReview(projectRoot,config,opts)` schedulable entrypoint (opens `.bober/medical/health.db`, resolves `config.medical.vaultDir` or default vault, closes only stores it opened, returns `{findingsWritten,dashboardPath,findingPaths}`); additive `HealthDataStore.listBiomarkers()` (DISTINCT, alpha-sorted); new optional `medical.vaultDir` on `MedicalSectionSchema`; `bober medical review` CLI subtree (clock read only here, `process.exitCode=1` on error, never throws). **No LLM/network/`Date.now()` in `src/medical/analysis/`; `engine.ts` untouched.** commit `307e5e7`, 4 new src + 4 collocated test files (43 tests) + 3 additive edits, no new deps, suite **3029** green (+43), sc-1-1..sc-1-7 iter-1. |
| 2 | [sprint-spec-20260628-medical-analysis-2.md](./sprint-spec-20260628-medical-analysis-2.md) | **Pure injectable 4-lens recommendation judge-loop core:** new `src/medical/recommend/` — `types.ts` (`LensName` union of the four lenses, `LensVerdict`, `LensClients` one injected `{client,model}` per lens, `PanelOutcome` discriminated union `accepted`/`rejected`/`short-circuit`/`refuse`, budget constants **`MEDICAL_PANEL_MAX_TOTAL_CALLS=27` = `MEDICAL_PANEL_MAX_ROUNDS(3) × (1 + 4×LENS_MAX_LLM_CALLS(2))`**); `lenses.ts` (**never-throwing** `validateLensVerdict` four-tier JSON extraction mirroring `grounding-critic.ts:40-88` + `getLensVerdict` **FAIL-CLOSED reject-on-parse-exhaustion** + the four lens system prompts, only contraindication-checker emits `veto`); `judge-panel.ts` (`reconcilePanel` — **absolute contraindication VETO checked BEFORE the strict-majority vote**, 2-2 tie ⇒ fail-closed `no-consensus`; `runJudgeLoop` — **red-flag guard fires FIRST** so `generateCandidate` is never called on short-circuit/refuse, bounded regenerate-on-reject loop folding per-lens dissent, a thrown lens client counted as reject, **never throws / never exceeds the call budget**). **Two safety invariants verified in source:** (1) FAIL-CLOSED inversion mirrors `grounding-critic.ts:203-206`, inverts `critic-deep.ts` accept-on-exhaustion (in-code line refs document the intent); (2) the veto early-return makes majority-override structurally impossible. **Pure orchestration over injected fns — no fs/network/provider/FactStore; `engine.ts` untouched; no `bober medical recommend` CLI yet (Sprint 3 wires the real path).** commit `fb467c6`, 5 new files (3 src + 2 collocated test, 43 tests), purely additive, no new deps, suite **3072** green (+43), sc-2-1..sc-2-7 iter-1. |
| 3 | [sprint-spec-20260628-medical-analysis-3.md](./sprint-spec-20260628-medical-analysis-3.md) | **Recommendation generation end-to-end + `bober medical recommend` CLI:** new `src/medical/recommend/recommend.ts` `generateRecommendation(projectRoot,config,{question,goal?,now},deps?)` wires the Sprint-2 `runJudgeLoop` (imported, not re-implemented) into a real path returning `RecommendOutcome {kind:"accepted"\|"question"\|"escalated"\|"refused", findingPath?, cannedResponse?, reason?}`; `context.ts` `assembleRecommendationContext` (meds via `getActiveFacts("medical","patient","takes-medication")`, supplements via **`"dose"` predicate**, conditions/allergies/goals via the SOPS profile reader, **all default-empty when absent**) + `contextToString`; `urgency.ts` `assignUrgencySeverity` (**one bounded LLM call**, never-throwing four-tier JSON parse, **clamp 1..5**, conservative default `{3,3,0.5}` on failure, **outside the ADR-3 numerics boundary** by design). Outcome routing: **accepted** ⇒ `kind:"action"` Finding stating the advice **directly, no refer-out hedging** + LLM urgency/severity + `confidence:<x>` tag; **no-consensus** ⇒ `kind:"question"` Finding **"flagged for your review"** with per-lens dissent; **red-flag** ⇒ canned escalation + **no Finding**; per-outcome `AuditLog` entry (`answer`/`abstain`/`short-circuit`/`refuse`, IDs/enums only). New `bober medical recommend [--goal <g>] <question>` CLI subtree (clock only at boundary, `process.exitCode=1` on error, never throws). **Two invariants evaluator-verified in source:** (1) **fail-closed model selection** — cloud-inference OFF skips the tier branch entirely, all four lenses + generator resolve to the local Ollama model via `buildMedicalInferenceClient`, factory spy proves **no** anthropic/x.ai/deepseek client constructed; (2) **no refer-out hedging** on accepted Findings. Sprint-1 finding-writer reused; `engine.ts` untouched. commit `3b2abb9`, 3 new src + 3 collocated test files (25 new tests), no new deps, suite **3097** green (+25), sc-3-1..sc-3-7 iter-1. |
| 4 | [sprint-spec-20260628-medical-analysis-4.md](./sprint-spec-20260628-medical-analysis-4.md) | **Cadence gaps + cross-marker dig-deeper offers in the proactive pass:** two new pure zero-LLM analyzers — `cadence.ts` (`RECOMMENDED_CADENCE_DAYS` CLOSED table `ldl:365`/`hba1c:180`/`tsh:365`/`vitamin_d:365`/`ferritin:365`, mirrors `NumericPrimitive` `types.ts:142`; `detectTestGaps(store,biomarkers,{now})` emits a `kind:"question"` gap Finding when `(now−latestCollectedAt)/86_400_000 > cadenceDays` via `getLabSeries`, **biomarkers absent from the table are SKIPPED — no guessed cadence**) + `cross-marker.ts` (`CROSS_MARKER_PAIRS` CLOSED `[ldl,triglycerides]`/`[hba1c,triglycerides]`; `detectCrossMarkerPatterns(store,{now})` emits a **single** `kind:"question"` OFFER Finding referencing both names when both are out of reference range, persisting the pair in `tags=["cross-marker",a,b]` for dig-deeper recovery — **ZERO LLM call**). `runProactiveReview` merges `[...analyzeTrends, ...detectTestGaps, ...detectCrossMarkerPatterns]` in **one deterministic offline pass** (DISTINCT ruleKeys `cadence-gap`/`cross-marker-<a>-<b>` ⇒ no id collision, sc-1-4 idempotency preserved). New `digDeeper(projectRoot,config,offerId,{now},deps?)` + `DigDeeperDeps` reads the offer note, recovers the pair from frontmatter `tags`, frames a question, and **delegates to Sprint-3 `generateRecommendation`** (`deps.generateRecommendation ?? generateRecommendation`) — the **only** LLM step, **not re-implemented**. Additive `bober medical review --dig-deeper <id>` flag (clock only at boundary, `process.exitCode=1` on error, never throws); plain `review` counts now include gap + offer findings. **Zero-LLM-detection verified by the evaluator via grep (empty), not a spy; `engine.ts` untouched.** **Non-blocking follow-up:** the sc-4-4 `llmSpy` in `cross-marker.test.ts:37` is a free-floating `vi.fn()` never passed into the detector (no LLM injection point) ⇒ the assertion is **tautological** — guarantee holds by source/grep, consider tightening/documenting later. commit `92a0481`, 2 new src + 2 collocated test files + `review-pass.ts`/`medical.ts` extended (+17 tests), no new deps, suite **3114** green (+17), sc-4-1..sc-4-7 iter-1. |
| 5 | [sprint-spec-20260628-medical-analysis-5.md](./sprint-spec-20260628-medical-analysis-5.md) | **Finale — egress-gated online research job + `bober medical research` CLI:** new module `src/medical/research/` — `online-research.ts` `runResearchJob(projectRoot,config,{markers,now},deps?) => Promise<ResearchSummary {notesWritten,findingsWritten,disabled}>` gates the `literature-retrieval` axis **FIRST** and returns `{disabled:true,0,0}` **before constructing `LiteratureRetriever`/`MedlineSource`** (**zero-egress proof** — `MedlineSource` spy `fetchPassages` never called, no files); on the axis-on branch, per marker `retrieve` → `synthesizeGrounded` (**fail-closed grounding critic**) → `answer.abstained ? continue : write note + watch finding` (no uncited synthesis persisted); synthesis client via `buildMedicalInferenceClient` **fail-closes to local Ollama `openai-compat localhost:11434`** unless `cloud-inference` ON (independent of `literature-retrieval`); `deps?` injectable (`retriever`/`llmClient`/`clientFactory`/`writeFindingFn`) for offline tests. PURE `research-note.ts` — `serializeResearchNote(marker,answer,now)` **flattens** `Citation[]` → parallel `citationTitles[]`/`citationUrls[]` + scalar `source:"medlineplus"` (sidesteps `serializeFrontmatter` `[object Object]` pitfall), `researchNotePath` derives `<vault>/research/<YYYY-MM-DD>-<marker>.md` date from injected `now` (no `Date.now()`); optional `kind:"watch"` "new evidence" Finding via Sprint-1 `writeFinding` (evidence = citation URLs). Additive `bober medical research [--marker <m>]` CLI (default markers `ldl`/`hdl`/`a1c`; clock only at boundary; prints ran+counts / disabled; `process.exitCode=1` on error, never throws, exits 0 on both). **Schedulable entrypoint** for `spec-20260628-research-scheduler` (which owns cadence + injects `markers`/`now`); all retrieval/synthesis/grounding/model primitives **reused, not re-implemented**; `engine.ts` byte-unchanged. **Three invariants evaluator-verified in source:** zero-egress-when-off, fail-closed-abstain, fail-closed-local-model. commit `07b0fb9`, 2 new src + 2 collocated test files (28 tests) + `medical.ts` extended, no new deps, suite **3142** green (+28), sc-5-1..sc-5-7 iter-1. |

User-facing usage for `bober medical review`, `bober medical recommend`, and `bober medical research` is
in [`COMMANDS.md`](../../COMMANDS.md) (Medical Team Commands) and the README "Medical team (Phase 6)"
command list; the new optional `medical.vaultDir` config key is in the README "Full Configuration
Reference".

### Plan close-out

`spec-20260628-medical-analysis` is **complete (5 of 5)** on branch `bober/medical-team` — **all five
sprints passed evaluation on iteration 1 (zero reworks)**, full suite **3142** tests green, and
`src/medical/engine.ts` is **byte-unchanged** across the whole plan. The leg delivers both halves of the
proactive analysis surface: the **deterministic, fully offline** review pass (trend + cadence-gap +
cross-marker-offer Findings, Sprints 1 & 4), the **fail-closed 4-lens recommendation judge-loop** + `bober
medical recommend` (Sprints 2 & 3), and the **egress-gated online research job** + `bober medical research`
(Sprint 5). The **zero-egress posture is preserved**: the offline pass makes no LLM/network call, and the
online research job ships **zero outbound bytes** until the `literature-retrieval` axis is explicitly opted
in (cloud synthesis stays independently fail-closed to the local model). `runResearchJob` is the schedulable
entrypoint awaiting `spec-20260628-research-scheduler`. Shipping still inherits the base medical team's
**external S6.5 FFDCA §201(h) counsel + regulatory review gate** (non-engineering). See the finale record
[`sprint-spec-20260628-medical-analysis-5.md`](./sprint-spec-20260628-medical-analysis-5.md).

## Priority Hub — complete (5 of 5)

`spec-20260628-priority-hub` — the unified cross-domain priority surface that collects **Findings**
(actionable items, watches, risks, open questions) from each domain into one ranked hub. Sprint 1
lays the **foundational vertical slice**: a new `src/hub/` module that **owns the single canonical
`Finding` Zod schema** for the whole codebase (no second Finding schema exists anywhere — domain
producers like `src/medical/analysis/` emit the same field set as markdown frontmatter only), a
`FindingSource` interface with a `FactStoreFindingSource` that reads predicate-`finding` rows from
the `hub` scope (`HUB_SCOPE = "hub"`) and turns each into a validated `Finding` while **silently
skipping malformed/invalid rows (never throws)**, and a `bober hub list` CLI command that prints the
local store's findings (`<title> [<kind>] urgency=<n> severity=<n>`). `runHubList(source)` is the
**DI seam** later sprints inject a different `FindingSource` into rather than re-wiring the CLI.
Sprint 2 makes `bober hub list` a **cross-repo aggregator**: a sibling resolver (`hub.repos` config
→ absolute paths, else discovered `kb-*` siblings) plus a pure collector that opens each sibling's
derived `facts.db` **read-only** and pools their findings deduplicated by `Finding.id` — landed via
the single additive `FactStore` `{ readonly?: boolean }` flag (the no-flag path stays byte-identical;
`schema.ts` untouched, so `hub.repos` is read from the raw config JSON). Sprint 3 adds the **ranking
brain**: an ephemeral query `Scope` (general / decision / filtered) and a two-pass `rankFindings`
judge over an **injected `LLMClient`** — pass 1 LLM relevance-filters the pool (decision scope drops
findings relevant to "neither"), pass 2 fans out **hub-specific** prioritization lenses (urgency /
impact / effort / deadline-risk, distinct from the eval lenses) and reconciles **strict-majority,
fail-closed-on-tie** (a no-consensus finding is **kept and tagged `flagged-for-review`**, never
dropped), then a **deterministic JS sort** (aggregate score → urgency → severity → earliest `dueBy`
→ id) produces the final order — **the LLM never emits the ordering**. Filtered scope is a pure-JS
fast path with **zero LLM calls**; the judge is **internal** (no CLI yet). Sprint 4 ships the
**output surface**: a **pure** `renderPriorityMd` that formats the judge's ranked array into a
Dataview-friendly `priority.md` (hand-rolled YAML frontmatter + a 7-column table + per-finding
rationale) — it **never re-ranks** (`rank = index + 1`) — plus `resolveOutVault` (absolute kb-hub
path from `hub.outVault` else the documented `<parent>/kb-hub` default) and the two CLI commands
`bober hub priority` (general / filtered) and `bober hub decide "X vs Y"` (decision) wiring the full
collect → scope → judge → render → write → summary pipeline behind a DI core; a missing output vault
**fails closed** (stderr + non-zero exit, never throws, never auto-creates the vault). No new
dependency. Sprint 5 **closes the plan** with the **conversational surface**: a built-in `hub` team
registered **as data inline in `loadTeam`** (memory namespace `hub`, default pipeline, no guardrails)
so `bober chat hub` routes through the existing `bober chat [team]` command, plus two **additive**
in-session slash commands — `/priority` and `/decide X vs Y` — gated on the hub namespace
(`this.memoryNamespace === "hub"`; any other team gets a no-op message with **zero** LLM call) that
delegate to the Sprint 2–4 functions (`collectFindings → rankFindings(this.llm) → renderPriorityMd`)
and return a `rank. title` summary while best-effort writing `priority.md`. The judge client is the
session's **injected** `this.llm` (never a fresh `createClient`), so the chat hub path runs fully
offline in tests. All ten pre-existing slash commands stay **byte-identical** — `HELP_TEXT` is
unchanged, so `/priority` and `/decide` are deliberately **not** advertised in `/help` (a documented
follow-up). No new dependency. **The plan is complete (5 of 5).**

| # | Record | What it added |
|---|--------|---------------|
| 1 | [sprint-spec-20260628-priority-hub-1.md](./sprint-spec-20260628-priority-hub-1.md) | **Canonical `Finding` schema + FactStore source + `bober hub list`:** new `src/hub/` — `finding.ts` `FindingSchema` (locked field set: `id`/`domain`/`title`/`kind`∈{action,watch,risk,question}/`urgency`&`severity` int 1–5/`evidence[]`/`surfacedAt` ISO/`dueBy?`/`tags[]`/`estDurationMin?`/`calendarSafeTitle?`/`status`∈{open,in-progress,snoozed,done,dropped}/`promotesTo?`) + exported `Finding` type (the **single** canonical schema, siblings import it); `finding-source.ts` `FindingSource {read():Finding[]}` + `FactStoreFindingSource` reading `getActiveFacts(HUB_SCOPE, undefined, "finding")` → `JSON.parse` → `safeParse`, **never-throw skip** of malformed/invalid rows + `HUB_SCOPE="hub"` constant; `src/cli/commands/hub.ts` `runHubList(source)` DI core + `registerHubCommand` registering `hub list` (resolves team namespace `facts.db`, `process.exitCode=1` on error, never throws, store always closed), wired via 4-line additive edit to `src/cli/index.ts`. commit `2bb3b95`, 3 new src + 3 collocated test files (21 tests: 12 schema, 6 source, 3 CLI), no new deps, `FactStore` constructor untouched, no competing Finding schema; sc-1-1..sc-1-5 iter-1, build/typecheck/lint clean, facts/blackboard regression green. |
| 2 | [sprint-spec-20260628-priority-hub-2.md](./sprint-spec-20260628-priority-hub-2.md) | **Cross-repo read-only collector + sibling resolver + `FactStore` readonly flag:** additive `{ readonly?: boolean }` on the `FactStore` constructor (`src/state/facts.ts:141` — opens better-sqlite3 `{readonly:true}` + **skips** `CREATE TABLE`/`CREATE INDEX`; no-flag path **byte-identical**, WAL/`busy_timeout` preserved; the spec's **single permitted core edit**). New `src/hub/repo-resolver.ts` `resolveSiblingRepos(projectRoot, configuredRepos?)` (configured→`path.resolve` absolute, else discover `kb-*` dirs in parent; keeps only repos with an existing `facts.db`; **never throws**, non-existent skipped) + `src/hub/collector.ts` `collectFindings(repoPaths, scope=HUB_SCOPE)` (**pure**, opens each sibling `new FactStore(factsDbPath(repo),{readonly:true})`, pools via Sprint 1 `FactStoreFindingSource`, **dedup by `Finding.id` keep-first**, missing/corrupt sibling skipped in `try/catch/finally`). `src/cli/commands/hub.ts` `list` now aggregates own+siblings (own first, wins dedup) via the Sprint 1 `runHubList` DI seam; private `resolveConfiguredRepos` reads `hub.repos` from the **raw** config JSON (`bober.config.json`/`.bober/config.json`) because Zod strip-mode would drop it — **`schema.ts` deliberately untouched**. commit `708c799`, 1 core edit + 2 new `src/hub/` modules + 1 CLI edit, +36 tests (facts readonly read-ok/write-throws + no-flag-creates-table regression; 6 resolver; 7 collector), no new deps; sc-2-1..sc-2-6 iter-1, suite **3178** green, build/typecheck/lint clean. Read-only is a **safety guarantee**: sibling `facts.db` byte-unchanged after collect, write through the handle throws `SQLITE_READONLY`. |
| 3 | [sprint-spec-20260628-priority-hub-3.md](./sprint-spec-20260628-priority-hub-3.md) | **Query scope parser + two-pass prioritization judge (LLM ranks, deterministic JS arranges):** `src/hub/scope.ts` `Scope` union (`general` \| `decision{optionA,optionB}` \| `filtered{domain?,dueWithinDays?,tag?}`) + `parseScope` (Zod `discriminatedUnion("mode").safeParse`, **fallback `general`, never throws**) + **pure** `applyFilter(findings,scope,now)` (no LLM/async; matches **all** of domain AND tag AND `dueBy` within `dueWithinDays` of injected `now`; no-`dueBy` fails a `dueWithinDays` constraint). `src/hub/lenses.ts` private `HUB_LENS_CATALOG` + `HUB_LENS_NAMES` (urgency/impact/effort/deadline-risk, **hub-specific — NOT the eval lenses** pinned by `lens-panel-parity.test.ts`) + `resolveHubLensFocus` (unknown→generic fallback, never throws) + `RelevanceVerdictSchema`/`LensScoreSchema` + four-tier `extractJson` (direct→fenced→first-`{}`→null) + `validateRelevanceVerdict`/`validateLensScore` (**null on failure, never throw**). `src/hub/judge.ts` `rankFindings(findings,scope,llm,now)` — **filtered = pure-JS fast path, ZERO `llm.chat` calls**; pass 1 LLM relevance (`null`/`relevant:false` drops; decision drops `relevantTo`∉{optionA,optionB,both}); pass 2 fans out 4 lenses, `aggregateScore`=**SUM** of per-lens scores (0–40), reconcile **strict-majority FAIL-CLOSED-ON-TIE** (`passVotes>failVotes`→ranked; else **kept + `flagged-for-review`** appended to a **SPREAD COPY** of `tags`, input never mutated, `Finding` schema unchanged); deterministic stable sort `aggregateScore` DESC → `urgency` DESC → `severity` DESC → `dueBy` ASC (`undefined`=+Infinity LAST) → `id` ASC — **LLM never emits order**. **Injected `LLMClient`** (only the type from `providers/types.js`, no `createClient`/SDK import — like `answerer.ts`); tests drive a `ScriptedClient` fake recording every `ChatParams`. commit `01af871`, 5 new `src/hub/` files **+1038/-0**, `eval-lenses.ts`+`finding.ts` byte-unchanged, no new deps; +38 tests (scope 22, judge 16), 69 hub + 73 regression green; sc-3-1..sc-3-6 iter-1, typecheck/build/lint clean. Judge is **internal** (no CLI yet). |
| 4 | [sprint-spec-20260628-priority-hub-4.md](./sprint-spec-20260628-priority-hub-4.md) | **`priority.md` renderer + `bober hub priority` / `bober hub decide`:** `src/hub/priority-md.ts` `renderPriorityMd(ranked,scopeLabel,now)` — **PURE** (no IO, no re-sort), hand-rolled flat-scalar YAML frontmatter (`generatedAt`/`scope`/`count`, **no yaml dep**) + 7-col Dataview table `\| rank \| title \| domain \| kind \| urgency \| severity \| dueBy \|` (one row/finding, **`rank=index+1`**, pipe-escaped + newline-collapsed cells, missing `dueBy`→empty) + per-finding `### <rank>. <title>` evidence section. `src/hub/hub-config.ts` `resolveOutVault(projectRoot)` reads `hub.outVault` from **raw** config JSON (`schema.ts` untouched) → `resolve` absolute, else documented default `<parentOfProjectRoot>/kb-hub`, **never throws**; `priorityMdPath(outVault)`=`<outVault>/priority.md`. `src/cli/commands/hub.ts` `runHubPriority(findings,scope,llm,outVault,now)` **DI core** (injected `llm`+`outVault` keep tests offline) — **missing-vault gate** `!fileExists(outVault)`→red stderr + `process.exitCode=1` + return (**never throws, never auto-creates** another repo's vault; `ensureDir` only on the file's already-existing parent) → `rankFindings`→`renderPriorityMd`→write `<outVault>/priority.md`→stdout `<rank>. <title>`; `bober hub priority [--domain --due --tag]` (any flag→filtered scope, else general) + `bober hub decide <expr>` (`/\s+vs\s+/i` split, malformed→stderr+exit1) build the real client via `createClient` (chat.ts pattern), `runHubList` byte-stable. commit `d82a27f`, 2 new `src/hub/` files + 1 additive CLI edit (5 changed, **+665/-13**), **no new deps**, `Finding`/judge/scope/`schema.ts` untouched, sibling stores read-only (mtime-unchanged); +18 tests (priority-md 11, hub 7) + 25 regression green; sc-4-1..sc-4-5 iter-1, typecheck/build/lint clean. |
| 5 | [sprint-spec-20260628-priority-hub-5.md](./sprint-spec-20260628-priority-hub-5.md) | **`bober chat hub` + scoped `/priority` + `/decide` (plan finale):** built-in `hub` team registered **as data inline in `loadTeam`** (`src/teams/registry.ts:47` — `memoryNamespace "hub"`, default `pipelineShape`, **no guardrails**, mirrors the `medical` branch) so `bober chat hub` routes through the **unchanged** `bober chat [team]` command. `src/chat/slash-commands.ts` — `priorityHandler`/`decideHandler` added as the **last two optional** dispatch params (positions 10/11, existing positional callers back-compatible) + `case "/priority"`/`case "/decide"` (`/decide` captures everything after the keyword as the `X vs Y` expr); **`HELP_TEXT` byte-identical** (new commands intentionally **not** in `/help` to satisfy sc-5-4 — documented follow-up). `src/chat/chat-session.ts` (+72) — `handleHubPriority`/`handleHubDecide`/`rankAndRenderHub` **gated on `this.memoryNamespace === "hub"`** (non-hub ⇒ informative no-op, **zero** LLM call — proven with a throwing client) delegating to `resolveSiblingRepos → collectFindings(HUB_SCOPE) → rankFindings(findings, scope, this.llm, now) → renderPriorityMd`; `/decide` splits on `/\s+vs\s+/i` (malformed ⇒ `Expected 'X vs Y'`); **best-effort** `priority.md` write in `try/catch` (missing vault never breaks the turn); judge client = **injected `this.llm`** (never a fresh `createClient`) ⇒ offline-testable. commit `45d3c17`, 3 additive src edits + tests (6 files, **+654/-1**), **no new deps**, `schema.ts`/`Finding`/judge/scope/renderer untouched; +6 registry + new `chat-session.test.ts` (+330, sc-5-1/2/3/4) + slash-commands regression; sc-5-1..sc-5-5 iter-1, full suite **3264** green, typecheck/build/lint clean. |

User-facing usage for `bober hub list` / `bober hub priority` / `bober hub decide` is in
[`COMMANDS.md`](../../COMMANDS.md) (Hub Commands), and `bober chat hub` (with the in-session
`/priority` / `/decide` commands) is documented under `bober chat hub` in the same Hub Commands
section; `bober chat hub` is also in the README "Priority hub" / CLI command list.

### Plan close-out

`spec-20260628-priority-hub` is **complete (5 of 5)** on branch `bober/medical-team` — all five
sprints passed evaluation on iteration 1 (zero reworks), full suite **3264** green. The plan ships
the unified cross-domain priority surface as a **net-new `src/hub/` module** (the single canonical
`Finding` schema + FactStore source, the read-only cross-repo collector + sibling resolver, the
scope parser + two-pass LLM-ranks/JS-arranges judge, and the pure `priority.md` renderer + out-vault
config) plus the `bober hub list` / `bober hub priority` / `bober hub decide` CLI and the
`bober chat hub` conversational surface. The **only** edit to existing core code across the whole
plan is the additive `{ readonly?: boolean }` flag on the `FactStore` constructor (Sprint 2, no-flag
path byte-identical); **no new dependency** was added. The do-bridge (`Finding.promotesTo`), calendar
slot-fill, the research scheduler, and the Telegram adapter remain owned by sibling specs.

## Task Inbox — complete (6 of 6)

`spec-20260628-task-inbox` — a **zero-friction personal task inbox** layered on the priority-hub
pool: every captured task is an ordinary open `kind=action` `Finding` written through a **single
`captureTask` write path** into the unified hub pool (`scope='hub'`, `predicate='finding'`), so it
immediately appears in `bober hub list` / `bober hub priority` / `bober chat hub`. The plan **imports**
the canonical `FindingSchema` from `src/hub/finding.ts` and **never redefines** it; capture fills the
schema's required `domain`/`urgency`/`severity` fields with neutral defaults (`inbox`/`3`/`1`) so it
can never block. Sprint 1 lands the **capture spine** — a thin `writeFinding`/`readFindings`
persistence helper over `FactStore`, a **pure** clock-injected `captureTask` (deterministic
`id = sha256(title|now).slice(0,16)`), and `bober task add <text> [--domain <d>]`. Sprint 2 makes the
inbox **usable**: a **pure** `transitionFinding` helper that supersedes a task's active Finding with a
new-status copy through the reconcile **UPDATE** path (prior status survives as bitemporal history —
**no row is ever `DELETE`d**), plus `bober task list [--all] [--status]` (default hides terminal tasks)
and the `bober task start|done|drop <id>` lifecycle subcommands. Sprint 3 adds **snooze with wake
semantics**: `bober task snooze <id> --until <when>` moves a task to `status='snoozed'`, records the
wake time as a `snooze-until:<ISO>` `tags[]` entry (**no schema field added**), and the **pure**
`isVisibleInDefaultList(finding, now)` predicate hides it from the default list until the wake time
passes — computed **lazily at list time** against an injected clock (no background timer, no auto-wake).
Sprint 4 opens a **domain intake seam**: an exported `ingestFinding(store, input, {now})` plus
`bober task ingest [file]` (file path or stdin) that validates the payload against `FindingSchema`,
derives a **content-stable** `id = sha256(domain|title|kind)` when none is supplied, and persists
through `writeFinding` so **re-surfacing the same finding reconciles to a single active row** (`update`
/`noop`) instead of duplicating; malformed/invalid input is **fail-closed** (stderr + `exitCode=1`,
writes nothing, never throws). Sprint 5 teaches **`bober chat` to recognise a task statement**: an
**additive** `{action:'capture-task', task}` classifier variant + a `handleCaptureTask` branch that
writes through the **same Sprint-1 `captureTask`** (no Answerer round-trip) — a question still routes to
`answer` and a decision/scope statement is explicitly **not** treated as a task; the classifier keeps
its never-throw `answer` fallback. Sprint 6 **closes the plan** with an **opt-in, default-off**
`bober task from-gmail <thread>`: a new **isolated** `taskInbox.gmailEgress` Zod axis (default
**false**, separate from the medical `EgressGuard`), a **pure** `parseGmailThread`, a
`sanitizeConnectorError` (token-stripping regex identical to `external-client.ts`), and a
`fromGmailTask` DI core that **refuses before constructing any MCP client / touching the network** when
the axis is off — reading one thread through the existing `ExternalMcpServer` connector and capturing it
via the same `captureTask` when on. **The plan is complete (6 of 6).**

| # | Record | What it added |
|---|--------|---------------|
| 1 | [sprint-spec-20260628-task-inbox-1.md](./sprint-spec-20260628-task-inbox-1.md) | **Capture spine + `bober task add`:** `writeFinding`/`readFindings` helper over `FactStore` (`src/hub/finding-store.ts`, routes through `writeFact`/reconcile not raw insert; `readFindings` strict-`parse` throws on bad row) + **pure** clock-injected `captureTask` (`src/hub/task-inbox.ts`, deterministic `id=sha256(title\|now)`, `kind='action'`/`status='open'`, neutral defaults `domain='inbox'`/`urgency=3`/`severity=1`, `--domain` sets field + `domain:<d>` tag) + `bober task add <text> [--domain]` (`runTaskAdd` DI core, never throws); imports canonical `FindingSchema`, never redefines. commit `0e39c15`, 3 src + 3 test files (+17 tests), no new deps, `finding.ts`/`facts.ts`/priority-hub untouched; sc-1-1..sc-1-5 iter-1, suite **3264 → 3281** green. |
| 2 | [sprint-spec-20260628-task-inbox-2.md](./sprint-spec-20260628-task-inbox-2.md) | **`task list` + start/done/drop lifecycle:** **pure** `transitionFinding(store,id,newStatus,{now,mutate?})` supersedes the active Finding via the reconcile **UPDATE** branch (prior status preserved as a `t_invalidated` history row, **never `DELETE`**; returns `null` if no active row) + `bober task list [--all] [--status]` (default shows `open`+`in-progress`, columns `ID STATUS DOMAIN TITLE`) + `bober task start\|done\|drop <id>` (one registration loop; unknown id ⇒ yellow msg + `exitCode=1`, never throws). commits `5e2bc2f` (+ `26f45db` trivial unused-var lint fix — the plan's **only** rework, S2 iter-2); sc-2-1..sc-2-5 passed. |
| 3 | [sprint-spec-20260628-task-inbox-3.md](./sprint-spec-20260628-task-inbox-3.md) | **Snooze with wake semantics:** `bober task snooze <id> --until <when>` ⇒ `status='snoozed'` + wake time stored as a `snooze-until:<ISO>` `tags[]` entry (**no schema field added**; `'snoozed'` already in the status enum; re-snooze **replaces** the tag, terminal tasks can't be snoozed) + **pure** `isVisibleInDefaultList(finding, now)` (hides snoozed until wake `<= now`, injected clock, **no background timer/auto-wake**) + `snoozeUntil`/`SNOOZE_TAG_PREFIX` helpers; `runTaskList` gained a third `now` param. commit `2b5c3c9`; never throws on bad `--until`/unknown id (msg + `exitCode=1`). |
| 4 | [sprint-spec-20260628-task-inbox-4.md](./sprint-spec-20260628-task-inbox-4.md) | **Domain finding intake (pool ingest + dedup):** exported `ingestFinding(store,input,{now})` validates against relaxed `IngestInputSchema` (`FindingSchema.partial({id,surfacedAt})`), derives content-stable `deriveFindingId = sha256(domain\|title\|kind).slice(0,16)` when no id, fills `surfacedAt=now`, **re-validates the full `FindingSchema`** then persists via `writeFinding` ⇒ re-surface reconciles to **one** active row (`add`/`update`/`noop`, never duplicates) + `bober task ingest [file]` (file path or **stdin**); malformed/invalid ⇒ **fail-closed** (stderr + `exitCode=1`, writes nothing, never throws). commit `5c77a49`. |
| 5 | [sprint-spec-20260628-task-inbox-5.md](./sprint-spec-20260628-task-inbox-5.md) | **Chat intent-detection capture:** **additive** `{action:'capture-task', task}` `ClassifierAction` variant (`turn-classifier.ts`, alongside the unchanged answer/spawn/steer/approve/reject/tell/pause/resume members) + two system-prompt rules (imperative to-do ⇒ `capture-task`; "deciding between X and Y" ⇒ `answer`, **not** a task) + private `ChatSession.handleCaptureTask(task)` writing through the **Sprint-1 `captureTask`** (single write path, no Answerer) ⇒ `Captured task: <text>`; classifier keeps its never-throw `answer` fallback. commit `3846c50` (FALLBACK byte-identical). |
| 6 | [sprint-spec-20260628-task-inbox-6.md](./sprint-spec-20260628-task-inbox-6.md) | **Finale — Gmail thread → task (egress-gated, default-off):** new **isolated** `TaskInboxSectionSchema` `{ gmailEgress: z.boolean().default(false) }` optional `taskInbox` key (`schema.ts`, existing configs byte-identical; medical `EgressGuard` untouched) + **pure** `parseGmailThread` (subject from `{subject}`/`{messages}`/MCP envelope, fallback `(no subject)`) + `sanitizeConnectorError` (`KEY=VALUE`→`[redacted]`, same regex as `external-client.ts:69`) + `fromGmailTask` DI core that **throws BEFORE `mcp.start()`/`callTool()`** when the axis is off (zero network) and otherwise reads one thread via `ExternalMcpServer` and captures via `captureTask` (`domain:"gmail"`, the **only** write path) + `bober task from-gmail <thread>` (fail-closed config, sanitized errors + `exitCode=1`, never throws, `mcp.stop()` in `finally`). One-thread-on-demand only (no polling). commit `55d6878`, +12 + 3 tests, no new dep; sc-6-1..sc-6-5 iter-1 (zero reworks), suite **3309 → 3324** green. |

User-facing usage for `bober task add\|list\|start\|done\|drop\|snooze\|ingest\|from-gmail` lives in
[`COMMANDS.md`](../../COMMANDS.md) and the README CLI list; the `taskInbox.gmailEgress` config key
(default false) is in the README configuration reference.

### Plan close-out

`spec-20260628-task-inbox` is **complete (6 of 6)** on branch `bober/medical-team` — five of six
sprints passed on iteration 1, the **only** rework being a trivial unused-var lint fix in Sprint 2
(`26f45db`, no logic change). Every command writes through the **single `captureTask` path** into the
unified hub pool and **imports the canonical `FindingSchema`** (never a second schema); `start`/`done`/
`drop`/`snooze`/`ingest` all transition via **supersede** so no Finding row is ever deleted. The only
config change is the additive, default-off, **isolated** `taskInbox.gmailEgress` axis (Sprint 6) — the
medical `EgressGuard` axes are untouched and **no new runtime dependency** was added. Full suite **3324**
green. See the finale record
[`sprint-spec-20260628-task-inbox-6.md`](./sprint-spec-20260628-task-inbox-6.md).

## Do-Bridge — promote a Finding into a `bober run` — complete (3 of 3)

`spec-20260628-do-bridge` — the bridge that turns a hub **Finding** into launched, tracked work: a
new `src/do-bridge/` module that resolves a domain-specific **Promoter** for a Finding, gates the
launch on human approval, spawns a detached `bober run`, links the Finding to the run, and reconciles
the run's terminal outcome back onto the Finding. Sprint 1 lays the **spine** — the `PromotionPlan` /
`PromotionRef` / `PromoterKey` / `Promoter` types, a `PromoterRegistry` (resolution precedence
**domain+kind > domain-only > undefined**, `resolve` never throws), a narrow `FindingStore` **read**
port (FactStore-backed + in-memory fake), the first `codingPromoter` (maps a `coding`/`projects`
Finding to a `{ kind:"bober-run", task, teamId? }` plan), and a **read-only** `bober do <findingId>
--dry-run` that previews the launch and changes nothing. Sprint 2 turns that into a **real,
approve-gated launch**: `bober do <findingId>` writes a `.bober/approvals/promote-<id>.pending.json`
marker (reusing the run pipeline's approval machinery verbatim), **gates** on it (TTY confirm ·
non-TTY poll for an external `bober approve`/`reject` · `--yes` auto-approve), and **only on approval**
launches the work **detached** through an injected `Launcher` port, links the Finding
(`promotesTo = { runId, status:"launched" }`) and transitions it `open → in-progress`; the structured
`PromotionRef` is **serialized into the existing `promotesTo: z.string()` field** so the hub
`FindingSchema` stays byte-unchanged. Sprint 3 **closes the loop and the plan**: `reconcilePromotions`
reads each launched run's `run-state.json` **snapshot** and advances the Finding to its terminal status
(`completed → done` via supersede + `promotesTo.status='completed'`; `aborted`/`failed → open` +
`promotesTo.status='aborted'`; `running`/missing → unchanged), **best-effort and never-throwing**,
exposed via `bober do --reconcile` and run at the start of every `bober do`. It also **proves registry
extensibility** by registering a second non-functional stub promoter under `{domain:'projects',
kind:'action'}` (an unregistered `(domain,kind)` still **fails closed**) and ships the consolidated
[`docs/do-bridge.md`](../do-bridge.md) extension-point guide. **The plan is complete (3 of 3).**

| # | Record | What it added |
|---|--------|---------------|
| 1 | [sprint-spec-20260628-do-bridge-1.md](./sprint-spec-20260628-do-bridge-1.md) | **Promoter registry + FindingStore read port + `bober do --dry-run`:** new `src/do-bridge/` — `types.ts` (`PromoterKey {domain;kind?}` / `PromotionPlan {kind:"bober-run";task;teamId?}` / `PromotionRef` (string this sprint) / `Promoter = (finding)=>plan`, pure), `registry.ts` `PromoterRegistry` (`register`/`resolve`, precedence **domain+kind > domain-only > undefined**, never throws), `finding-port.ts` narrow read port + `FactStoreFindingStore`/`InMemoryFindingStore`, `coding-promoter.ts` (`coding`/`projects` ⇒ `bober run` task from title + ≤2 evidence lines + optional `team:<id>` tag) + `runDo`/`registerDoCommand` (`bober do <id> --dry-run`, **read-only**: no marker, no spawn, no mutation; unknown id / unsupported domain ⇒ `exitCode=1`, never throws). commit `8370612`, +829/-0, **32 tests**, no new dep; sc-1-1..sc-1-5 iter-1. |
| 2 | [sprint-spec-20260628-do-bridge-2.md](./sprint-spec-20260628-do-bridge-2.md) | **Approve-gated real launch + `--yes`:** `Launcher` port + `RunSpawnerLauncher` (wraps chat `RunSpawner` ⇒ detached `agent-bober run <task> --run-id do-<id>-<ts>`; **hard boundary** — `do.ts` never imports `execa`/`RunSpawner`); `PromotionRef` **changed to a structured object** `{kind;runId;launchedAt;status}` + `serialize`/`parsePromotionRef` (JSON to/from the on-disk string); `DoFinding` view + `FindingStore.setPromotion` (sets `promotesTo` **and** `open→in-progress` via supersede-aware `transitionFinding`); `runPromotionGate` writes/clears `.bober/approvals/promote-<id>.pending.json` (reuses `approval-state.ts` verbatim; `--yes` · TTY confirm · non-TTY poll resolved by `bober approve`/`reject promote-<id>`) ⇒ launch only on approve, reject leaves Finding untouched. **`src/hub/finding.ts` byte-unchanged.** commit `cf33acb`, +1143/-37, **58 do-bridge tests**; sc-2-1..sc-2-5 iter-1. |
| 3 | [sprint-spec-20260628-do-bridge-3.md](./sprint-spec-20260628-do-bridge-3.md) | **Finale — terminal reconciliation + registry-extensibility proof + `docs/do-bridge.md`:** `reconcilePromotions(deps)` (`reconcile.ts`) lists promoted Findings, reads each launched run's `run-state.json` **snapshot** via injected `readState`, and applies `completed→done`(supersede,`promotesTo.status='completed'`) / `aborted`\|`failed`→`open`(`'aborted'`) / `running`\|missing→unchanged ⇒ `ReconcileSummary {completed,aborted,unchanged}`; **never throws** (per-finding try/catch + CLI try/catch), **snapshot not poll**, clock injected; new `FindingStore.listPromoted()`/`applyOutcome()` on both adapters; `bober do --reconcile` flag + **best-effort start-of-command reconcile** (mirrors `seedProjectFacts`, can't abort `bober do`); **second non-functional stub promoter** under `{domain:'projects',kind:'action'}` proves `register` accepts a new key (unregistered `(domain,kind)` **fails closed**); generator-owned [`docs/do-bridge.md`](../do-bridge.md) names the `register()` call site + `Promoter` interface. **`src/hub/finding.ts` byte-unchanged.** commit `f430fd1`, +686/-4, **76 do-bridge tests**, suite **3400** green; sc-3-1..sc-3-5 iter-1. *Non-blocking follow-up:* the unsupported-promoter error names only the domain, not the `(domain,kind)` pair (cosmetic; criterion passed). |

User-facing usage for `bober do [findingId] [--dry-run] [--yes] [--reconcile]` lives in
[`COMMANDS.md`](../../COMMANDS.md) under **Do-Bridge Commands** and the README CLI list; the consolidated
feature + extension-point guide is [`docs/do-bridge.md`](../do-bridge.md).

### Plan close-out

`spec-20260628-do-bridge` is **complete (3 of 3)** on branch `bober/medical-team` — all three sprints
passed evaluation on iteration 1 (zero reworks), full suite **3400** green. The plan ships the
Finding→work bridge as a **net-new `src/do-bridge/` module**: the promoter registry + read port +
dry-run preview (Sprint 1), the approve-gated detached real launch + `--yes` (Sprint 2), and terminal
reconciliation (`--reconcile`) + the registry-extensibility proof + the consolidated `docs/do-bridge.md`
(Sprint 3). The structured `PromotionRef` is **serialized into the existing `promotesTo` string field**,
so the canonical hub `FindingSchema` (`src/hub/finding.ts`) stays **byte-unchanged** across the whole
plan; **no new dependency** was added. Medical/financial promoters, calendar slot-fill, the research
scheduler, and the Telegram adapter remain owned by sibling specs — the registry is the documented seam
where they plug in. See the finale record
[`sprint-spec-20260628-do-bridge-3.md`](./sprint-spec-20260628-do-bridge-3.md).
