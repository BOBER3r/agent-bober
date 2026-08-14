# Re-authoring what a recapture cannot fix — including a caseId that had gone false

**Contract:** sprint-spec-20260812-pge-real-workload-errors-8  ·  **Spec:** spec-20260812-pge-real-workload-errors  ·  **Completed:** 2026-08-12

## What this sprint added

Nothing executable. **No runtime behaviour, no topology, no public API moved** — `pge diff` is
empty, `graphVersion` stays `1.4.0`, and the suite count is unchanged at 6897. What moved is the
truth of four hand-written claims that the previous three sprints had falsified: two `integrity`
golden cases whose prose (and, in one case, whose own **caseId**) asserted that `PipelineResult`
has no error channel; one test asserting that a truncated replay *throws*; and the last negative
control in the golden gate that injected a **fixed count** of failures against a growing
denominator.

**The contract was re-scoped mid-flight**, and for a reason worth recording. As written, sprint 8
owned the golden **recapture** for the whole spec. That work had already been pulled forward
twice: sprint 5 recaptured all five `replay` cases when it added `PipelineResult.errors` (the
curator measured that a green suite was otherwise unreachable — field added, cases not recaptured
⇒ golden gate 0/5 against an 80 % threshold), and sprint 7 recaptured again for the `1.3.0 → 1.4.0`
stamp and added a sixth case. So the contract was rewritten before generation to own only the
residue — the work a capture *cannot* do — and its `nonGoals` say so explicitly: *"Re-capturing
replay cases — already done by sprints 5 and 7, with both diffs verified."*

## The distinction this sprint is a worked example of

This is the durable part, and it now also lives in
[docs/pge-graph.md](../pge-graph.md#the-golden-dataset-what-it-proves-and-what-it-does-not):

| | `replay` case | `integrity` case |
| --- | --- | --- |
| where its expectation came from | captured from a real run | hand-authored prose + a **partial** pin set |
| when behaviour changes | **re-CAPTURE** — `GOLDEN_CAPTURE=1`, mechanical, and the diff is the statement of what moved | **re-AUTHOR** — a judgement call, sentence by sentence |
| can it be recaptured? | yes, that is the maintenance path | **no.** Replaying a partial pin set throws `MissingRecordingError` at the first call its author did not think to write down |

A `replay` case that goes red is a question for the runtime. An `integrity` case that goes false
is a question for a *writer*: nothing in CI can detect that its English no longer matches the
code, because nothing executes it. Sprints 5 and 7 are the capture half of the example; this
sprint is the authoring half.

**And the caseId is itself a claim.** `pipeline-result-reports-success-with-no-error-channel`
asserted the falsehood in the one place a reader greps for, which is worse than a stale comment.
Correcting it is not an in-place edit: `validateGoldenDataset` requires every file to be named
`${caseId}.json` (`src/pge/golden/runner.ts:394-397` — *"a case whose id and filename disagree
cannot be found from a failure message"*), so a rename is a **new file plus a delete**. Git
recorded it as `R079`, and the evaluator diffed the pinned artifact blocks either side of the
rename in Python to confirm they are **byte-identical**: only prose moved.

## Public surface

There is no new code symbol. The changed surfaces are dataset files and the claims two tests make.

- **`.bober/golden/pipeline-result-omits-errors-key-on-a-clean-run.json`** (was
  `pipeline-result-reports-success-with-no-error-channel.json`) — same pinned run, narrowed claim:
  a run with nothing to report carries **no `errors` KEY at all**, checked with `in` rather than
  `=== undefined`. That is the *other* half of the optional field sprint 5 added, not a channel
  that never exists. Its pinned `pipelineResult` still has exactly four keys
  (`completedSprints`, `failedSprints`, `spec`, `success`), and a future change that started
  spreading an empty `errors` unconditionally would fail it. Still `enforcement: "integrity"`,
  still pinned against `graphVersion 1.2.0` — valid at `1.4.0` because `checkCaseAgainstGraph`'s
  integrity rule is deliberately MAJOR-only.
- **`.bober/golden/commit-refused-fail-closed-under-noop-gate.json`** — caseId kept (the refusal
  *is* still fail-closed, still under the `noop` gate); prose corrected and a `pipelineResult`
  artifact added, pinning one `PipelineFailure` (`nodeId: "commit"`, `errorClass: "FailClosed"`,
  `branchKey: null`) alongside `success: true`. The pinned message is the one
  `src/pge/runtime/interrupt.ts:543` writes, matched **verbatim** by the evaluator. Its `intent`
  additionally names the two sprint-6 consequences that are *not* expressible as a pinned artifact
  because `collectRunArtifacts` does not collect them — `bober run`'s exit code and `Refused:`
  block (`src/cli/commands/run.ts:250-261`) and the MCP `RunManager`'s `RunState.status: "failed"`
  (`src/mcp/run-manager.ts:227-231`) — and points at `run.test.ts` / `run-manager.test.ts` as the
  tests that actually prove them. Tag `known-divergence` → `error-channel`.
- **`src/pge/golden/executor.test.ts`** — two claims re-expressed:
  - the truncated-run test now asserts **"the case does not pass"** (`runGoldenRegression`,
    imported rather than reimplemented, `results[0].passed === false`) instead of
    `rejects.toThrow()`. Sprint 7 gave `CommitBoundary.finalize` a second ending, so a truncation
    deep enough to have written `state.specDraft` now **resolves** with `success: false` instead
    of throwing; a test pinning the throw was pinning where the truncation happens to land.
  - the gate negative control now drifts `(index + 1) % 3 === 0` of **all** replay cases, mutating
    `pipelineResult[0].success`, instead of two named cases' `contracts[0].title`.
- **Dataset shape unchanged:** 43 cases, **6 `replay` / 37 `integrity`**, floor
  `GOLDEN_MIN_REPLAY_CASES = 5`. The evaluator read `enforcement` out of all 43 files at both
  `HEAD` and `HEAD~1` and got identical sets — **no case was relabelled** to make a count work.
  Golden gate 6/6.

## The last fixed-count negative control, and why the field had to change too

Sprint 7 fixed two of the three controls that had stopped biting when the replay set grew from 5
to 6, and left `executor.test.ts`'s with a comment claiming a fixed mutation of 2 cases was safe
*"regardless of how many more cases the replay set grows to hold."* It is not: `(n-2)/n` crosses
the strict 80 % bar at **n = 11**, so the control would have gone quiet the moment the dataset
reached eleven replay cases, with nothing anywhere reporting it. That was carried as an evaluator
follow-up into this contract and is now closed — all three controls inject a fraction, so none has
a breakpoint left to compute.

The **mutated field** changed for an independent reason, and the evaluator's verdict on the
control was **strengthened** because of it: `contracts[0].title` is not a field every case has —
`replay-plan-clarify-rounds-exhausted` never reaches `sprint_exit`, so its
`expected.artifacts.contracts` is empty and the old selector would have been mutating `undefined`.
`pipelineResult` is a `SCALAR_ARTIFACT_FIELDS` entry (`src/pge/golden/case-schema.ts:138`) and
`PipelineResult.success` is required, so every present and future case can take the mutation. At
6 replay cases the new fraction drifts exactly 2 — the same failure count as before — so this is a
scaling fix, not a change in what today's run catches.

## Notes for maintainers

- **When a behaviour change falsifies an `integrity` case, budget for authoring, not for a
  rerun.** Read the case's `title`, `intent`, `tags`, `notes` **and caseId**; every one of them is
  a claim, and only the pins are machine-checked. If the caseId has to move, the rename is a new
  file plus a delete — verify the pinned artifact block is byte-identical afterwards, or the
  rename has quietly become a recapture nobody reviewed.
- **Two source comments still repeat the falsified claim**, carried from sprint 5 and *still* not
  fixed here (this sprint's scope was the dataset and its tests):
  `src/pge/engine/pge-engine.ts:504` and
  `src/orchestrator/workflow/conformance.engines.test.ts:386` both say *"`PipelineResult` has no
  error channel and this sprint may not add one (nonGoal 3)"*. Neither is load-bearing — the
  behaviour each describes is still correct — but both are wrong about the reason.
- **The design record is two graph versions behind, by design.**
  `.bober/architecture/arch-20260805-pge-graph-engineering-architecture.md` is a dated `draft`
  artifact of the *previous* spec and still says `OverallState` has *"Exactly 15 keys"* (16 since
  `specDraft` at `1.4.0`) and that channel values cap at 4 KiB (`spec` is 131,072 and
  `sprintContracts` 524,288 since `1.3.0`). It is deliberately **not** rewritten — it records what
  was designed on 2026-08-05, not what ships. `docs/pge-graph.md` is the current description and
  is the one CI gates on; it now says so.
- **`src/pge/topology/docs.test.ts` contains two literal NUL bytes** (inside a `join("\0")` in
  `sortRows`, written as raw bytes rather than an escape), so `git`, `grep` and `rg` classify the
  file as binary and skip it in text searches. Pre-existing, harmless to the suite, and a source
  file — not fixed here, but do not conclude the file lacks a match just because a grep was silent.
- **Read `errors`, not `success`.** Unchanged and deliberate since sprint 5 (Option A): the
  re-authored refusal case pins `success: true` beside a populated `errors`.
- Passed **iteration 1**, all 7 of 7 required criteria, negative-control verdict **strengthened**.
  Suite **6897 passed / 2 skipped / 0 failed** (unchanged — no test was added or removed, only
  rewritten); typecheck (both tsconfigs), build and lint green; five `pge` gates green; the real
  CI script run rather than a proxy, golden **6/6**, exit 0. The evaluator flipped the rewritten
  boolean in a live copy and re-ran to prove the assertion is not vacuous. Commit `9deac68`.
