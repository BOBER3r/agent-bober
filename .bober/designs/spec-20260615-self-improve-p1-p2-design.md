# Design Discussion: Self-improvement P1/P2 (offline, gated)

**Spec ID:** spec-20260615-self-improve-p1-p2
**Date:** 2026-06-15
**Status:** reviewed

---

## Current State

Phases 1–4 are merged. The self-correction unit is the generator↔evaluator retry loop in
`src/orchestrator/pipeline.ts:239-432`: per iteration it builds a handoff, runs the generator, then
calls `runEvaluatorAgent` (`src/orchestrator/evaluator-agent.ts:45`). That function runs the
programmatic plugins (`runEvaluation`, registry of typecheck/lint/unit-test/build, `:62-81`) AND the
LLM judge (`runAgentEvaluation`, `:90`) **unconditionally**, then combines via
`programmaticEval.passed && agentResult.passed` (`:116`). Gaps relevant to Phase 5:

- No deterministic-first short-circuit: the LLM judge call is burned even when a required
  programmatic strategy (build/typecheck) already failed.
- The generator handoff (`createHandoff`, pipeline.ts:276) embeds `currentContract` — which carries
  `successCriteria` + `evaluatorNotes` (the scoring rubric) — so the generator can "teach to the test."
- A FAIL `EvalDetail` may omit `file`/`line` (both optional in `src/contracts/eval-result.ts:14-15`);
  nothing rejects an uncited FAIL.
- No frozen corpus of past (contract, diff, verdict) tuples and no way to replay them; eval results
  are written per-round to `.bober/eval-results/` (`eval-persist.ts`) but never collected as a
  regression baseline.
- Agent instruction text lives in `agents/bober-generator.md` / `agents/bober-evaluator.md` (body
  after frontmatter is the systemPrompt, loaded by `loadAgentDefinition`/`assembleSystemPrompt`); it
  is hand-edited only — no offline evolution path.

## Desired End State

Three additive, off-by-default workstreams under `src/orchestrator/selfimprove/` (and a new
`src/cli/commands/replay.ts` + `evolve.ts`):

- `.bober/replay/` holds immutable golden fixtures (one JSON per case + a SQLite index `replay.db`),
  and `bober replay run` re-scores them deterministically vs a recorded baseline, reporting pass/fail
  deltas and exiting non-zero on any regression. This is the GATE for S5.3.
- A `ReplayHarness` API + an evaluator anti-degeneration guard module that (1) short-circuits the LLM
  judge when a required programmatic strategy fails, (2) strips the rubric from the generator-bound
  handoff, (3) rejects any FAIL detail with no cited artifact — all opt-in via a new `selfImprove`
  config section (every flag defaults to off; pipeline behavior is byte-identical when unset).
- `bober evolve` mutates generator/evaluator prompt variants, keeps a Pareto set, scores each ONLY
  against the replay harness, and refuses to write a promoted prompt unless it beats the baseline with
  zero regressions. It NEVER touches the live pipeline.

## Patterns to Follow

- `src/state/facts.ts` (`FactStore`) — pure SQLite adapter: deterministic content-hash id, timestamps
  injected as params (never reads the clock), `:memory:`-testable, `CREATE TABLE IF NOT EXISTS` in
  ctor, hidden behind an interface. Model for the replay store.
- `src/cli/commands/facts.ts` + `src/cli/commands/memory.ts` — CLI verb shape: `register<X>Command`,
  `resolveRoot` via `findProjectRoot`, chalk output, handlers MUST NOT throw (set
  `process.exitCode=1` and return). Register in `src/cli/index.ts` next to `registerFactsCommand`.
- `src/orchestrator/eval-persist.ts` — the (contractId, iteration, passed, results[]) payload shape to
  capture as a replay fixture.
- `src/config/schema.ts` — Zod section pattern (`EvaluatorSectionSchema`, `.optional()` at the top
  level, every field `.default()`). New `SelfImproveSectionSchema`, all flags default false.
- `src/orchestrator/memory/distill.ts` — purity discipline (no wall-clock inside pure fns) and the
  `lessonIdFromSignature` deterministic-hash pattern, reused by the GEPA variant id.
- `src/orchestrator/agent-loader.ts` (`loadAgentDefinition`) — how a prompt is read from
  `agents/<name>.md`; GEPA reads/writes prompt-variant text against this contract.

## Resolved Design Decisions

### Q1: tech-constraints — Where does the replay corpus live and what stores the index?
**Decision:** Files under `.bober/replay/cases/<caseId>.json` (immutable fixtures) + a SQLite index
`.bober/replay/replay.db` (baseline verdicts), built with the exact `FactStore` adapter pattern.
**Rationale:** principles.md mandates filesystem state with "no DB except where SQLite already used";
SQLite IS already used (`src/state/facts.ts:3` better-sqlite3). A pure adapter (`facts.ts:136`) keeps
it `:memory:`-testable and deterministic. Cases as standalone JSON keeps them git-diffable + immutable.

### Q2: tech-constraints — How does S5.2's deterministic-first gate short-circuit without changing default behavior?
**Decision:** Insert a pure guard in `runEvaluatorAgent` after `runEvaluation` (evaluator-agent.ts:81)
that, when `config.selfImprove.deterministicGate` is true AND a `required` programmatic strategy
failed, skips `runAgentEvaluation` and returns a synthetic FAIL. Default false ⇒ both calls still run,
byte-identical to today (`:90-98`).
**Rationale:** `runEvaluation` already produces per-strategy `passed`+`required` (registry.ts:181-203);
the gate is a pure predicate over that array. Off-by-default preserves the `programmaticEval.passed &&
agentResult.passed` combine (`:116`).

### Q3: scope — What does "rubric isolation" strip, and from where?
**Decision:** A pure `redactRubric(handoff)` removes `successCriteria`, `evaluatorNotes`, and
`successCriteria[].verificationMethod` from the generator-bound handoff's `currentContract`, leaving
`title`/`description`/`definitionOfDone`/`generatorNotes`/`nonGoals` intact. Applied in pipeline.ts at
`createHandoff` (`:276`) only when `config.selfImprove.rubricIsolation` is true.
**Rationale:** the handoff carries the full `currentContract` (context-handoff.ts:47) including the
rubric; the generator does not need the evaluator's scoring criteria to implement. Off-by-default.

### Q4: error-handling — What makes a FAIL "uncited" and what happens to it?
**Decision:** A FAIL `EvalDetail` is uncited if it has no `file` (with optional `line`) AND no failing
test name / command output substring in its `message`. When `config.selfImprove.requireCitedArtifact`
is true, the post-parse guard downgrades an uncited FAIL detail to `passed:true severity:info` with a
note, so an uncited FAIL cannot fail the sprint. Pure fn over `EvalResult.details`.
**Rationale:** `EvalDetail.file/line` are optional (eval-result.ts:14-15); the existing judge prompt
already asks for file:line evidence (evaluator-agent.ts:289). The guard enforces it deterministically.

### Q5: scope — Does GEPA ever mutate the live agent .md files or pipeline?
**Decision:** No. `bober evolve` reads `agents/<role>.md`, generates variants in
`.bober/evolve/<runId>/`, scores each against the replay harness only, writes the winner to
`.bober/evolve/<runId>/promoted/<role>.md` + a report — never to `agents/` and never invoked by
`runPipeline`. Promotion to `agents/` is a manual human copy, explicitly out of scope here.
**Rationale:** research §5 P2 + §7 risk #3: "Never let the system edit itself without a deterministic,
replay-gated check." Keeping the write target inside `.bober/evolve/` makes Phase 5 fully reversible.

## Open Questions

None blocking. Two pragmatic decisions deferred to the generator (documented as assumptions):
- The exact mutation operators for GEPA prompt variants (paraphrase / add-constraint / reorder) — the
  generator picks a small deterministic-seeded set; the harness gate is what matters, not the operator.
- Whether `bober replay capture` ingests from `.bober/eval-results/` + git history or requires an
  explicit case list — default to ingesting existing eval-results, with an explicit `--case` override.
