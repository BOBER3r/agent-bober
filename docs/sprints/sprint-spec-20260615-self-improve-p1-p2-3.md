# Evaluator anti-degeneration guards (deterministic-first, rubric isolation, cite-artifact) — off-by-default

**Contract:** sprint-spec-20260615-self-improve-p1-p2-3  ·  **Spec:** spec-20260615-self-improve-p1-p2  ·  **Completed:** 2026-06-15

## What this sprint added

Lands the **three evaluator anti-degeneration guards** that Sprint 1's `selfImprove` config
section was reserving flags for. A new `src/orchestrator/selfimprove/eval-guards.ts` exports three
**PURE** functions — `shouldShortCircuitJudge`, `redactRubric`, `enforceCitedArtifacts` (no clock,
no fs, no LLM, no mutation of inputs; modeled on `distill.ts`) — each defending against a distinct
way the generator↔evaluator loop can degenerate. Unlike Sprints 1–2 (which touched no live pipeline
file), this sprint wires the guards into the **live** evaluator and pipeline — but every new branch
is gated behind `config.selfImprove?.<flag>` optional chaining, and **all three flags default to
`false`**. With the flags off (or the `selfImprove` section absent), the evaluation flow and the
generator-bound handoff are **byte-identical** to the pre-Sprint-3 path — proven by the `sc-3-7`
`loopSpy` invariant test. Full suite: **2290 tests, zero regressions**.

## Public surface

- `shouldShortCircuitJudge(programmaticResults, requiredEvaluators)` (`src/orchestrator/selfimprove/eval-guards.ts:27`)
  — **PURE** predicate. Returns `true` iff at least one programmatic `EvalResult` has
  `passed === false` **and** its `evaluator` (strategy type name) is in the `requiredEvaluators`
  `Set<string>`. `EvalResult` carries no `required` flag, so the caller builds the set from
  `config.evaluator.strategies` (`filter(s => s.required).map(s => s.type)`).
- `redactRubric(handoff)` (`src/orchestrator/selfimprove/eval-guards.ts:51`) — **PURE**. Returns a
  **new** `ContextHandoff` whose `currentContract` drops `successCriteria` and `evaluatorNotes`
  (the scoring rubric), keeping `title` / `description` / `definitionOfDone` / `generatorNotes` /
  `nonGoals`. The original handoff is **never mutated** (spread, not in-place). To keep
  `SprintContractSchema.min(1)` happy if the contract is ever re-validated, it substitutes a single
  neutral placeholder criterion (`criterionId: "rubric-redacted"`, `verificationMethod: "manual"`,
  `required: false`). A handoff with no `currentContract` is returned by reference (pure no-op).
- `enforceCitedArtifacts(result)` (`src/orchestrator/selfimprove/eval-guards.ts:126`) — **PURE**.
  Returns a **new** `EvalResult` in which every `detail` with `passed === false` that carries **no
  cited artifact** is rewritten to `passed: true`, `severity: "info"`, with
  `" [downgraded: no cited artifact]"` appended to its `message`. Cited FAILs pass through
  unchanged, and `result.passed` is recomputed from the returned details. The internal `isCited`
  predicate (`:99`) treats a detail as cited iff `detail.file` is a non-empty string **or**
  `detail.message` contains a command/test signal substring: `.test.`, `FAIL `, `npm run`, `tsc`,
  `exit code`, or `:` (a path-like `file:line` token).

## How to use / how it fits

Each guard is **off by default** and is opted into via a `config.selfImprove` flag (the Sprint 1
schema, all `.default(false)`). The three flags and their wiring:

| Flag (`config.selfImprove.*`) | Guard | Wired in | Defends against |
|-------------------------------|-------|----------|-----------------|
| `deterministicGate` | `shouldShortCircuitJudge` | `evaluator-agent.ts` (after `runEvaluation`) | The LLM judge **rubber-stamping** a sprint whose required build/typecheck strategy already failed — and burning a judge call to do it |
| `rubricIsolation` | `redactRubric` | `pipeline.ts` (on the generator-bound `injectedHandoff` only) | The generator **teaching to the test** — overfitting to the evaluator's literal success criteria instead of the spec |
| `requireCitedArtifact` | `enforceCitedArtifacts` | `evaluator-agent.ts` (wraps the agent `EvalResult`) | An **uncited FAIL** (a vibe-based "this doesn't look right" with no file / failing test / command output) blocking an otherwise-passing sprint |

```jsonc
// bober.config.json — opt in per guard; omit any flag to keep the pre-Sprint-3 behavior.
"selfImprove": {
  "deterministicGate":    true,   // required programmatic failure → FAIL, LLM judge skipped
  "rubricIsolation":      true,   // strip successCriteria/evaluatorNotes from the generator handoff
  "requireCitedArtifact": true,   // downgrade uncited FAIL details so they can't fail the sprint
  "replayDir":            ".bober/replay"
}
```

### Deterministic-first gate (`deterministicGate`)

In `runEvaluatorAgent` (`src/orchestrator/evaluator-agent.ts`), **after** `runEvaluation` produces
the programmatic results and **before** `runAgentEvaluation` (the LLM judge): when the flag is set
and `shouldShortCircuitJudge(programmaticEval.results, requiredSet)` is `true`, the function builds
a FAIL `EvaluationRunResult` straight from the programmatic results — summary
`"deterministic gate: required check failed — LLM judge skipped"` — and **returns without calling
`runAgentEvaluation` at all** (saving the judge call). `requiredSet` is derived from
`config.evaluator.strategies` (`filter(s => s.required).map(s => s.type)`).

### Rubric isolation (`rubricIsolation`)

In `runSprintCycle` (`src/orchestrator/pipeline.ts`), the guard runs **after** guidance injection
(so human guidance in `handoff.issues` is preserved) and is applied to the **generator-bound
`injectedHandoff` only** — `redactRubric(injectedHandoff)`. **The `evalHandoff` is deliberately
untouched: the evaluator MUST keep the full rubric.** With the flag set, the generator no longer
receives the evaluator's `successCriteria` / `evaluatorNotes`.

### Cite-artifact guard (`requireCitedArtifact`)

In `runEvaluatorAgent`, the agent's `EvalResult` is passed through
`enforceCitedArtifacts(agentResult)` only when the flag is set. An uncited FAIL detail is downgraded
to a passing `info` detail (with the downgrade note appended), so it can no longer fail the sprint;
a FAIL that names a `file`, a failing test, or command output survives intact.

## Notes for maintainers

- **Off-by-default / byte-identity is the load-bearing invariant — and it is independently proven.**
  Every new branch in both live files (`evaluator-agent.ts`, `pipeline.ts`) is guarded by
  `config.selfImprove?.<flag>` optional chaining, so an absent `selfImprove` section (e.g.
  `createDefaultConfig` output) is falsy and the existing path runs unchanged. The `sc-3-7`
  invariant suite in `src/orchestrator/evaluator-agent.test.ts` (`:390`) uses a `loopSpy` mock over
  `runAgenticLoop` to prove three cases: **(a)** with `selfImprove` **absent** + a required
  programmatic FAIL, the judge **still runs** (`loopSpy` called once); **(b)** with `selfImprove`
  present but `deterministicGate: false`, same (judge runs once); **(c)** with
  `deterministicGate: true`, the judge is **skipped** (`loopSpy` 0 calls) and the result is
  `passed === false`. (a)/(b) are the additive guarantee; (c) is the gate doing its job.
- **The guards are PURE — keep them that way.** No clock, no fs, no LLM, no mutation of inputs
  (mirrors `distill.ts` / `reconcile.ts` / `replay-harness.ts` discipline). `redactRubric` and
  `enforceCitedArtifacts` return new objects via spread; `shouldShortCircuitJudge` returns a boolean
  computed only from its two parameters. Non-mutation is unit-tested (the original handoff still has
  `successCriteria` after `redactRubric`).
- **`redactRubric` applies to the generator handoff only.** Do **not** extend it to `evalHandoff` —
  the evaluator needs the rubric to score the sprint. The placeholder `rubric-redacted` criterion is
  belt-and-suspenders for a schema re-validation that the generator path (`serializeHandoff` →
  `JSON.stringify`, no re-parse) does not actually perform.
- **`enforceCitedArtifacts` recomputes `result.passed`.** After downgrading uncited FAILs,
  `passed = details.every(d => d.passed)`. A result that failed **solely** because of uncited FAILs
  therefore flips to `passed: true`; a result with even one cited FAIL stays `passed: false`.
- **Scope guardrails honored.** No guard is enabled by default; the
  `programmaticEval.passed && agentResult.passed` combine logic is unchanged when the flag is off;
  the evaluator JSON schema and `agents/bober-evaluator.md` are untouched; and the Sprint 1–2 replay
  store/harness modules are not touched (`git diff` confirmed). Files changed: `eval-guards.ts`
  (+ 33-test suite), additive edits to `evaluator-agent.ts` (+36/-2) and `pipeline.ts` (+12), and
  the `sc-3-7` invariant tests in `evaluator-agent.test.ts`.
- **Next:** Sprint 4 (the plan's last) lands the **GEPA evolve loop**, importing the Sprint 2
  `runReplayHarness` as its promotion gate.
