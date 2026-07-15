# Structure Outline: Self-improvement P1/P2 (offline, gated)

**Spec ID:** spec-20260615-self-improve-p1-p2

Each phase is a vertical slice: store/pure-core + wiring/guard + CLI surface (where applicable) +
collocated vitest. Every phase is additive and off-by-default; the live pipeline is byte-identical
unless a new `selfImprove` flag is explicitly set.

## Phase 1 (Sprint 1): Replay store + `bober replay capture|list|show`
**Key Changes:** `ReplayStore` class (pure SQLite adapter, deterministic caseId hash, injected
timestamps, `:memory:`-testable); `ReplayCase` type `{caseId, contractId, iteration, baselineVerdict,
diffDigest, evalDetails[]}`; `SelfImproveSectionSchema` Zod section (all flags default false) added to
`BoberConfigSchema` as `selfImprove?`; `bober replay capture|list|show` CLI verb that ingests
`.bober/eval-results/*.json` into immutable fixtures + a baseline row.
**Files:** `src/orchestrator/selfimprove/replay-store.ts` (+ `.test.ts`),
`src/orchestrator/selfimprove/replay-types.ts`, `src/cli/commands/replay.ts` (+ `.test.ts`),
`src/cli/index.ts`, `src/config/schema.ts` (+ `schema.test.ts`)
**Test Checkpoint:** `npm run build && npm run typecheck` clean; `npm test -- replay` green;
`node dist/cli/index.js replay capture` in a temp dir creates `.bober/replay/cases/*.json` +
`replay.db`, `replay list` prints them, `replay show <id>` prints provenance.
**Depends On:** nothing

## Phase 2 (Sprint 2): `bober replay run` — deterministic regression gate
**Key Changes:** pure `compareToBaseline(cases, fresh)` → `{regressions[], improvements[], unchanged}`;
`bober replay run` re-derives each case's verdict deterministically (re-run the captured programmatic
strategies / re-read the frozen diff digest), diffs vs baseline, prints a delta table, and sets
`process.exitCode=1` when any regression is found (exit 0 + "no regressions" otherwise). Public
`runReplayHarness(projectRoot, config)` API returned for S5.3 to import as its gate.
**Files:** `src/orchestrator/selfimprove/replay-harness.ts` (+ `.test.ts`),
`src/cli/commands/replay.ts`, `src/cli/commands/replay.test.ts`
**Test Checkpoint:** `npm test -- replay` covers: identical rerun ⇒ 0 regressions exit 0; a flipped
verdict ⇒ 1 regression exit 1; empty corpus ⇒ friendly message exit 0. `npm run build` clean.
**Depends On:** Phase 1

## Phase 3 (Sprint 3): Evaluator anti-degeneration guards (off-by-default)
**Key Changes:** three pure guards: `shouldShortCircuitJudge(programmaticResults)` (true iff a
`required` strategy failed) wired into `runEvaluatorAgent` to skip `runAgentEvaluation`;
`redactRubric(handoff)` stripping `successCriteria`/`evaluatorNotes` from the generator-bound handoff,
wired in `pipeline.ts`; `enforceCitedArtifacts(evalResult)` downgrading uncited FAIL details. All three
gated by `config.selfImprove.{deterministicGate,rubricIsolation,requireCitedArtifact}` (default false).
**Files:** `src/orchestrator/selfimprove/eval-guards.ts` (+ `.test.ts`),
`src/orchestrator/evaluator-agent.ts`, `src/orchestrator/pipeline.ts`
**Test Checkpoint:** `npm test -- eval-guards` proves each guard pure + correct; an
all-flags-false run leaves the handoff/eval byte-identical (invariant test). `npm run build` +
`npm run typecheck` clean.
**Depends On:** nothing (independent of replay; ordered after for review focus)

## Phase 4 (Sprint 4): GEPA offline prompt evolution `bober evolve`, replay-gated
**Key Changes:** `proposeVariants(basePrompt, seed)` (deterministic mutation operators), `paretoSet`
selection over (replay-pass-count, prompt-length), `bober evolve --role generator|evaluator` that
reads `agents/<role>.md`, scores each variant ONLY via `runReplayHarness`, keeps the Pareto set, and
writes the winner to `.bober/evolve/<runId>/promoted/<role>.md` + `report.json` ONLY IF it beats the
baseline with zero regressions; otherwise writes "no promotion". NEVER writes `agents/` and is never
called by `runPipeline`.
**Files:** `src/orchestrator/selfimprove/gepa.ts` (+ `.test.ts`),
`src/cli/commands/evolve.ts` (+ `.test.ts`), `src/cli/index.ts`
**Test Checkpoint:** `npm test -- gepa` proves: a variant that regresses the replay set is NOT
promoted (no `promoted/` file); a variant that strictly beats baseline with 0 regressions IS written
under `.bober/evolve/`; `grep` proves no write path targets `agents/`. `node dist/cli/index.js evolve
--role generator --dry-run` exits 0. `npm run build` clean.
**Depends On:** Phase 2 (imports `runReplayHarness` as its gate)
