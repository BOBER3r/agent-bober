# Diagnose why a real plan still does not terminate, and fix it only if the cause is a ceiling

**Contract:** sprint-spec-20260812-pge-real-workload-errors-4  ·  **Spec:** spec-20260812-pge-real-workload-errors  ·  **Completed:** 2026-08-12

## What this sprint added

**`PgeEngine` executes this repository's own real 29 KB `PlanSpec` and its 14 real
`SprintContract`s end to end.** That had never happened before: sprint 1 measured the engine
refusing the writes, sprint 3 admitted them and hit a second wall, and this sprint took the wall
down. The sprint was a **diagnosis first** — its whole reason to exist was to establish, by
measurement, which of two very different things the `SuperstepLimitExceededError` sprint 3
surfaced actually was, because only one of them was fixable here. **Verdict: (a) INSUFFICIENT
CEILING, not a convergence bug.** The fix follows from the measurement: `PGE_ENGINE_MAX_SUPERSTEPS
= supersepsForMeasuredCost(234) = 512`, the ceiling `PgeEngine.run` configures on its
`RunContext`, pinned two-directionally exactly the way sprint 3 pinned the channel caps. The
interpreter's own `DEFAULT_MAX_SUPERSTEPS = 200` was **not** touched.

**Two things this record states precisely, because both are easy to overstate.** First, the
terminal reached is **`graceful_failure`, not `finalize`** — `commit` is still FAIL_CLOSED-refused
under the autopilot `noop` checkpoint mechanism, so the engine runs a real plan to the completion
of its *graph*; it does not commit. Second, the run now shows the error-channel defect **on real
data for the first time**: the committed measurement carries
`engineOutcome: {kind: "resolved", success: true}` next to `verdict: "failed"` and
`failures: [{nodeId: "commit", errorClass: "FailClosed", superstep: 232}]`. A run whose `commit`
was refused reports success. That divergence is open as of this sprint and is `feat-3`'s
(`An error channel on PipelineResult`) territory, not this one's.

**The contract was re-scoped mid-flight**, and the reason is worth keeping. As originally planned
under `feat-2`, sprint 4 was the *confirmation* sprint — AC5's "a `PgeEngine` run over the
committed 29 KB spec and its 14 contracts produces zero `StateBloatError` failures and leaves
`state.spec` non-null". Sprint 3 made exactly half of that true and revealed the superstep ceiling
blocking the other half, so the orchestrator re-authored the contract before the sprint started
(`.bober/history.jsonl`, `sprint-started` at `2026-08-12T06:40:00Z`: *"contract re-scoped: sprint
3 revealed SuperstepLimitExceededError; sprint 4 now diagnoses ceiling-vs-non-convergence before
fixing anything"*). The re-scope shows in the criteria themselves: `sc-4-1` calls itself "the half
of the original criterion sprint 3 made true", and **`sc-4-5` and `sc-4-6` are mutually exclusive
branches** — raise the ceiling only under verdict (a); under verdict (b), record the repeating
node and **stop without fixing anything**. `sc-4-6` is the one criterion of nine marked *skipped*,
by its own trigger.

## The measurement that settled the verdict

| contract count | supersteps | terminal | branches settled |
| --- | --- | --- | --- |
| 1 (no `dependsOn`) | **39** | `graceful_failure` | 1 of 1, `"succeeded"`, first attempt |
| 14 (this repository's real, `dependsOn`-linked contracts) | **234** | `graceful_failure` | 14 of 14, `"succeeded"`, first attempt |

Those two points are what the sprint committed as data. **The evaluator re-derived the
relationship independently at five contract counts** with its own harness driving `PgeEngine`
directly — 1: 39, 4: 84, 7: 129, 10: 174, 14: 234 — **exactly 15 supersteps of marginal cost per
contract at every interval**. Linear in declared work: neither flat (which would have falsified
"scales with work" and therefore the verdict) nor unbounded.

The one number that looks like non-convergence and is not: **`sprint_body` accounts for 1,272
spans** in the 14-contract run. The evaluator read the raw trace rather than trusting the sprint's
own assertions and found **14 spans with status `ok` — one per branch — and 1,258 with status
`serialized`**. A `serialized` span is *deferral bookkeeping*: the frontier planner defers a task
whose `dependsOn` is unmet before it ever considers the concurrency cap
(`src/pge/runtime/frontier.ts:216-227`), and the interpreter writes one span per deferral
(`recordDeferral`, `src/pge/runtime/interpreter.ts:898`, called at `:1068` for every deferral
whose reason is not `concurrencyCap`). Under `defaults.concurrency: 1` on a real cross-contract
DAG, a blocked task records one such span per superstep it stays blocked. Every *other* per-branch
node appears exactly 14 times with zero repeats, the branch set fully drains, and the only
`TaskFailure` anywhere is `commit`/`FailClosed` at superstep 232.

## Public surface

- **`PGE_ENGINE_MAX_SUPERSTEPS = 512`** (`src/pge/engine/pge-engine.ts:200`) — the ceiling
  `PgeEngine.run` now sets on `ctx.maxSupersteps` (`:463`) for every run. Before this sprint the
  engine passed no override at all, so every run inherited the interpreter's own baseline.
- **`supersepsForMeasuredCost(measuredSupersteps: number): number`**
  (`src/pge/engine/pge-engine.ts:184`) — the next power of two at or above
  `SUPERSTEP_HEADROOM_FACTOR × measuredSupersteps`, floored at the interpreter's
  `DEFAULT_MAX_SUPERSTEPS`, so the function can only ever **raise** the runaway guard, never lower
  it. (The exported name is missing a `t` — read it as *supersteps*-for-measured-cost. It is
  spelled that way at every call site; see *Notes for maintainers*.)
- **`MEASURED_REAL_WORKLOAD_SUPERSTEPS = 234`** (`:174`) — the measured natural completion cost of
  this repository's own real workload, pinned in `real-workload.test.ts` against a fresh
  measurement, the same way the corpus maxima are pinned against a fresh read of the corpus.
- **`SUPERSTEP_HEADROOM_FACTOR = 2`** (`:164`) — the headroom multiplier, deliberately the same
  factor and the same discipline as `capForCorpusMax`'s `CAP_HEADROOM_FACTOR`.
- **`.bober/topology/measurements/real-workload.json`** — regenerated, and the diff is the story.
  Six fields flip from `null` to real values (`rejections: []`, `failures`, `terminalNodeId:
  "graceful_failure"`, `status: "completed"`, `verdict: "failed"`, `specChannelNullAtBoundary:
  false`), `engineOutcome` moves from `{kind: "threw", errorClass: "SuperstepLimitExceededError"}`
  to `{kind: "resolved", success: true}`, and three fields are new:
  - `supersteps: 234` — what the interpreter actually consumed.
  - `superstepCeiling: {configured: 512, measuredBasis: 234, headroomFactor: 2}` — the shipped
    constants, never a per-observation value, so the file documents the production fact even when
    a test drives a probe override underneath it.
  - `contractCountScaling: [{contractCount, supersteps, terminalNodeId, status}]` — the 1- and
    14-contract points above.
- **`src/pge/engine/real-workload.test.ts`** — extended, not replaced (the contract forbade a
  third measurement path). `observeRealWorkload` gains a **test-only** `options.maxSupersteps`
  probe that overrides `ctx` through the existing `interpreterFactory` seam; nothing in it lowers
  what `PgeEngine.run` itself configures. Two new tests at `:692` carry `sc-4-5`: one proves the
  shipped constant equals a fresh call of the pure function (plus its floor and its sensitivity),
  the other drives the identical real workload at `DEFAULT_MAX_SUPERSTEPS` and reproduces
  `SuperstepLimitExceededError`.

## How to use / how it fits

**A ceiling, like a cap, is a function of a measurement — never a number someone picks.** That is
now the rule in two places in this codebase: `capForCorpusMax` (`src/pge/golden/workload.ts`, for
channel bytes) and `supersepsForMeasuredCost` (`src/pge/engine/pge-engine.ts`, for supersteps).
Both are pinned by **equality** against a re-derivable measurement, which is what makes them fail
in *both* directions — a hand-edited literal breaks the test even when the literal is larger.

Re-deriving this sprint's measurement is a deliberate act, and the file's runs are slow (several
real engine runs over the 29 KB spec, each with its own 120-second timeout):

```
MEASURE_REAL_WORKLOAD=1 npx vitest run src/pge/engine/real-workload.test.ts   # rewrites the committed file
npx vitest run src/pge/engine/real-workload.test.ts                          # every other run compares it byte-for-byte
```

If the real workload's natural cost ever moves, `MEASURED_REAL_WORKLOAD_SUPERSTEPS` is the one
number to update; `PGE_ENGINE_MAX_SUPERSTEPS` follows from it. Raising the ceiling to make a red
test green — with no measurement moved — is what the two-directional pin exists to catch.

**No topology changed.** `pge diff` is empty, `graphVersion` stays `1.3.0`, no changelog entry and
no golden recapture follow: this is runtime configuration derived from a measurement, not a
structural change to the artifact. The golden fixtures all complete well under 200 supersteps, so
the raise is invisible to them.

## Notes for maintainers

- **The exported function name is misspelled: `supersepsForMeasuredCost`** (`superseps`, not
  `supersteps`), `src/pge/engine/pge-engine.ts:184`. It is consistent across its declaration and
  its two call sites, so nothing is broken — but it is a public export and a rename is a
  mechanical follow-up someone should take deliberately rather than in passing.
- **`graceful_failure` is not a happy path, and this record should not be read as "the engine
  works now".** `commit` is refused FAIL-CLOSED under the autopilot `noop` checkpoint mechanism,
  which is why the run routes to `graceful_failure` rather than `finalize`. Reaching `finalize`
  needs a durable checkpoint mechanism — a later sprint's territory, and explicitly a nonGoal
  here.
- **A run whose `commit` was refused still returns `success: true`.** `GraphRunResult.verdict` is
  `"failed"` (it accounts for the `FailClosed` `TaskFailure`), while `PgeEngine.run`'s returned
  `PipelineResult.success` is `true`, computed by the frozen `deriveRunSuccess` formula shared with
  the imperative engine — sprint-split based, and blind to a terminal-node failure that is not a
  sprint. Until that changes, **any harness that inspects only the returned `PipelineResult` will
  observe nothing**; this file's harness reads the interpreter's own result through
  `PgeEngineDeps.interpreterFactory` for exactly that reason.
- **Sprint 3's corpus-rebuild hazard is resolved, but the rebuild was deliberately not run.** The
  `verdict` channel's only corpus entry is sourced from this measurement's `verdict`, which was
  `null` while the run threw; it is now `"failed"`, so `BUILD_WORKLOAD_CORPUS=1` is safe again.
  This sprint's scope was the measurement (`.bober/topology/measurements/`), not the corpus
  (`.bober/workload/`), and the corpus is unaffected by anything here — a rebuild is a follow-up,
  not a bundled change.
- **Two stale counts in source comments are still there**, carried forward from sprint 3 and still
  worth someone's five minutes: `src/pge/topology/coding.graph.ts:108` says "123 real payloads"
  and `:191` says "52 committed PlanSpecs that parse"; the in-flight-spec exclusion made those
  **120** and **50**. Comments only — the artifact, the caps and `docs/pge-graph.md` all carry the
  corrected numbers.
- **The evaluator did not take the sprint's word for anything load-bearing.** It wrote its own
  harness for the scaling relationship (five points, not two), read the raw trace itself to
  falsify non-convergence, mutated the pin in both directions (hand-editing the constant to 999
  fails with *"expected 999 to be 512"*, so the pin is not tautological), confirmed
  `interpreter.ts:386` and the throw at `:1060` are byte-identical to sprint 3's state, and
  regenerated the measurement artifact and diffed it byte-identical.
- Passed **iteration 1**: 8 of 9 criteria met, `sc-4-6` skipped by its own mutually-exclusive
  trigger. Suite **6879 passed / 2 skipped / 0 failed** (baseline 6877, +2 matching the two new
  pin tests); typecheck, typecheck:tests, lint (0 errors, 2 pre-existing warnings in an unrelated
  file) and build all green; all five `pge` gates green with `pge diff` empty and the golden gate
  32/32. Commit `5c169bb`.
