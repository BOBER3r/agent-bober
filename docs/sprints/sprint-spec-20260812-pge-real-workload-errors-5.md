# `PipelineResult` gains an error channel, layered in the engine

**Contract:** sprint-spec-20260812-pge-real-workload-errors-5  ·  **Spec:** spec-20260812-pge-real-workload-errors  ·  **Completed:** 2026-08-12

## What this sprint added

**A run whose `commit` was refused can now say so.** `PipelineResult` gained
`errors?: readonly PipelineFailure[]`, populated in `PgeEngine.run` from the interpreter's own
`TaskFailure` records — the records the engine previously **discarded** at the finalize boundary,
under a comment that said exactly what it was waiting for. Sprint 4 made that defect visible on
real data for the first time (`engineOutcome: {kind: "resolved", success: true}` sitting next to
`verdict: "failed"` and a `FailClosed` `commit` failure in the committed measurement); this sprint
closes the reporting half of it.

**This is a deliberate revision of a surface the previous spec froze — twice.** `PipelineResult`
was off-limits under sprint-13's nonGoal 3, and both `pge-engine.ts` and
`conformance.engines.test.ts` carried comments saying the gap could not be corrected because
adding a field to `PipelineResult` was a spec-level change. That authorisation now exists
(`spec-20260812-pge-real-workload-errors`, `resolvedClarifications` D2), and this sprint is where
it was used.

**Three structural decisions carried the change, and all three were verified rather than
asserted.** `PipelineFailure` is a **pure type** in `src/orchestrator/pipeline.ts` — a runtime
export would create a real `orchestrator ↔ pge` import cycle and break `pge-engine.test.ts`'s
whole-module `vi.mock` of `pipeline.js`. The array is layered in `PgeEngine.run` with a
**CONDITIONAL** spread *after* `commit.finalize` returns, mirroring how `RunResultFlusher.flush`
layers `needsClarification` after `finalizePipelineRun` — so shared fields keep being produced in
exactly one place, `src/orchestrator/finalize.ts` and its frozen key-order pin
`src/orchestrator/finalize.test.ts` are **hash-verified byte-identical** before and after, and a
clean run carries **no `errors` key at all**, not merely an undefined one (proven with
`"errors" in result`, never `=== undefined`). And `success` is **unchanged**: it keeps the frozen
`deriveRunSuccess` sprint-split formula shared with the imperative engine (Option A, D3).

## The blast radius was one case larger than the curator predicted

The curator measured the blast radius by executing all five committed `replay` golden cases
through `dist/` and predicted **four** of the five would gain an `errors` key — every case with a
`FailClosed` `commit` span. **All five did.** The fifth, `replay-full-run-evaluation-fails`, gained
`errors` from **three `LoopExhausted` `TaskFailure`s** (`sprint_route`, `gate_mock_coverage`,
`reduce_sprints`, all on branch `sprint-spec-20260805-pge-conformance-01`) rather than from a
fail-closed refusal.

That is worth recording rather than filing as noise: it shows the mechanism is **broader than its
motivating case**. The layering is generic over any non-empty `result.failures`, not scoped to one
`errorClass`, so `errors` reports loop-bound exhaustion just as it reports a gate refusal. The
evaluator judged the unpredicted case in scope for exactly that reason — it is a direct mechanical
consequence of the same generic code path, not a second change smuggled in.

| recaptured `replay` case | what it now carries in `pipelineResult[0].errors` |
| --- | --- |
| `replay-full-run-evaluation-passes` | 1 × `{nodeId: "commit", errorClass: "FailClosed", branchKey: null}` |
| `replay-plan-clarification-round` | 1 × `{nodeId: "commit", errorClass: "FailClosed", branchKey: null}` |
| `replay-research-reflexions-exhausted` | 1 × `{nodeId: "commit", errorClass: "FailClosed", branchKey: null}` |
| `replay-research-second-reflexion` | 1 × `{nodeId: "commit", errorClass: "FailClosed", branchKey: null}` |
| `replay-full-run-evaluation-fails` | **3 × `LoopExhausted`** — `sprint_route`, `gate_mock_coverage`, `reduce_sprints` (the unpredicted case) |

**The recapture was moved into this sprint, and the reason matters.** It was planned for sprint 8.
The curator measured that a green suite was otherwise unreachable: with the field added and the
cases not recaptured, the golden gate sits at **0 of 5** against an 80 % CI threshold, so `sc-5-7`
("full suite green") would have been **unsatisfiable by construction**. The orchestrator moved the
re-CAPTURE in; re-AUTHORING the two hand-written `integrity` cases stayed in sprint 8, because
those need judgement, not a rerun.

**The recapture diff is the evidence the change is confined: 52 insertions, ZERO deletions, five
files.** Every added key sits inside a new `errors` array in `pipelineResult[0]`, and no entry
carries a `superstep` field — the 1:1-minus-`superstep` mapping is visible directly in the
committed data. Nothing else moved. The replay count stayed at exactly `GOLDEN_MIN_REPLAY_CASES`
(5, zero slack), the same five filenames, 37 `integrity` cases — no case was relabelled to dodge a
failure. Golden gate **0/5 → 5/5**.

## Public surface

- **`PipelineFailure`** (`src/orchestrator/pipeline.ts:79`) — `readonly nodeId: string`,
  `readonly branchKey: string | null`, `readonly errorClass: string`, `readonly message: string`.
  Mapped 1:1 from the interpreter's `TaskFailure` (`src/pge/runtime/interpreter.ts`) **minus
  `superstep`**: a superstep number is a graph-engine execution detail with no imperative-engine
  analogue, so it is dropped at this seam rather than carried into a field no TS-engine caller
  could ever populate. Exported as a **type only** — there is no runtime value to import.
- **`PipelineResult.errors?: readonly PipelineFailure[]`** (`src/orchestrator/pipeline.ts:114`) —
  optional, and **absent** (not `undefined`) whenever the run recorded no failures. Optional by
  design so every existing `PipelineResult` consumer keeps compiling untouched.
- **The layering site** (`src/pge/engine/pge-engine.ts:551-575`) — `PgeEngine.run` now awaits
  `commit.finalize(...)` into a local and returns `{...finalized, ...(result.failures.length === 0
  ? {} : {errors: …})}`. `finalizePipelineRun` itself is untouched and still owns every shared
  field.
- **`superstepsForMeasuredCost(measuredSupersteps: number): number`**
  (`src/pge/engine/pge-engine.ts:184`) — **renamed** this sprint from `supersepsForMeasuredCost`,
  which was missing a `t`. Behaviour is identical (next power of two at or above
  `SUPERSTEP_HEADROOM_FACTOR × measuredSupersteps`, floored at `DEFAULT_MAX_SUPERSTEPS`); the
  rename covers the declaration and all five call sites across `pge-engine.ts` and
  `real-workload.test.ts`, plus `docs/pge-graph.md`. `PGE_ENGINE_MAX_SUPERSTEPS` (`:200`) is
  unchanged at **512**.
- **`.bober/golden/replay-*.json` (five files)** — recaptured via `GOLDEN_CAPTURE=1`; each now
  carries an `errors` array in its expected `pipelineResult`.

Two comment-only corrections shipped alongside (`sc-5-8`), neither of which can move behaviour:
`src/pge/topology/coding.graph.ts:108` "123 real payloads" → **120** and `:191` "52 committed
PlanSpecs that parse" → **50**, the values since sprint 3's in-flight-spec exclusion. The topology
checksum is provably unmoved (`sha256:e4909da6…45a5`) because `canonicalize` hashes the runtime
object value only, never comments.

## How to use / how it fits

**Check `errors`, not `success`, to learn whether a run did everything it claims.** That is the
whole of the caller contract Option A creates:

```ts
const result = await engine.run(request, root, config, { runId });

if (result.errors?.length) {
  // A gate refusal or a loop-bound exhaustion happened. `result.success` may still be `true`.
  for (const failure of result.errors) {
    console.error(`${failure.nodeId} (${failure.errorClass}): ${failure.message}`);
  }
}
```

`success` is derived from the **sprint split** and from nothing else — `failedSprints.length === 0
&& completedSprints.length > 0` — and that formula is shared with `TsPipelineEngine` precisely so
the two engines cannot disagree about a field they both produce. A `FAIL_CLOSED` refusal of the
git-effect `commit` node is not a failed *sprint*, so it does not and will not move `success`.
Widening the sprint split to absorb it was explicitly rejected: it would invent a failed sprint
that did not happen, and would move the completion marker and the `pipeline-complete` history
phase — adding `completionMarker` to the conformance divergence set.

**Only `PgeEngine.run` ever populates this.** `TsPipelineEngine` has no interpreter to source
`TaskFailure` records from, so a TS-engine `PipelineResult` never carries the key at all; the same
is true of `RunResultFlusher.flush`, which only ever layers `needsClarification`. Both are pinned
in `src/orchestrator/finalize.e2e.test.ts` with `"errors" in result` assertions rather than
undefined checks.

**The conformance divergence set is UNCHANGED.** It is still exactly
`[audits, contracts, history, pipelineResult]` with `equivalent: false`
(`src/orchestrator/workflow/conformance.engines.test.ts`). Adding the channel did **not** add a
fifth divergent field — `pipelineResult` already diverged, and the harness records one diff per
field. `oracle-retention.test.ts` is unmodified. A fifth field appearing would have been a
declared stop condition; it did not fire.

## Notes for maintainers

- **A refused run still reports `success: true` at the type level.** Only `errors` tells the
  truth. This is deliberate (Option A, `resolvedClarifications` D3) and is *not* a bug left
  behind — Option B (`success: false` on a fail-closed refusal) was explicitly out of scope for
  the reason above. If the project ever flips `config.pipeline.engine` to `"pge"` by default,
  every caller that decides on `success` alone must first be migrated to check `errors` too.
- **Nothing surfaces `errors` to an operator yet.** The CLI and MCP layers were an explicit
  nonGoal here; that is **sprint 6**'s territory. As of this sprint the channel exists and is
  populated, and a human running `bober run` still sees nothing new.
- **Two hand-authored `integrity` golden cases now carry false prose, deliberately untouched.**
  `.bober/golden/pipeline-result-reports-success-with-no-error-channel.json` and
  `.bober/golden/commit-refused-fail-closed-under-noop-gate.json` assert, in their `title` and
  `intent` text, that `PipelineResult` has **no** error channel. That claim stopped being true in
  this commit. They were left byte-unchanged on purpose: an `integrity` case is hand-authored
  prose plus a partial pin set, so fixing them is a re-**authoring** job requiring judgement, not
  a `GOLDEN_CAPTURE=1` rerun — and it is scoped to **sprint 8**. Until then, read those two files'
  prose as historical.
- **Two source comments still repeat the same stale claim**, and were out of this sprint's scope:
  `src/pge/engine/pge-engine.ts:504` (in the budget-abort `catch`) and
  `src/orchestrator/workflow/conformance.engines.test.ts:385` both still say "`PipelineResult` has
  no error channel and this sprint may not add one (nonGoal 3)". Neither is load-bearing — the
  behaviour each describes (re-throwing `BudgetExceededError` unchanged; both engines reporting
  `success: true`) is still correct — but both sentences are now wrong about the *reason*.
- **No topology change follows from this sprint.** `graphVersion` stays `1.3.0`, no changelog
  entry, `pge dump --check` reports the same `sha256:e4909da6…45a5` and `.bober/topology/` is
  clean. The golden recapture was caused by a *runtime artifact shape* change, not by a structural
  change to the graph.
- **`finalize.ts` untouched is a load-bearing property, not a convenience.** The only
  `PipelineResult` consumer that enumerates keys is `normalize()`
  (`src/orchestrator/workflow/conformance.ts:96`), which sorts and walks `Object.keys`. That is
  why the spread is conditional and why the field is layered in the engine: a clean run's
  `PipelineResult` must keep exactly its five keys, or the conformance comparison changes shape
  for every run, not just failing ones.
- Passed **iteration 1**: all 9 of 9 required criteria met. Suite **6883 passed / 2 skipped /
  0 failed** (baseline 6879, **+4**); typecheck (both tsconfigs), build and lint (0 errors,
  2 pre-existing warnings in an unrelated file) all green; five `pge` gates green with the golden
  regression at **5/5** (100 %, threshold > 80 %). Commit `93ab3a9`.
