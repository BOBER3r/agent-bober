# A plan that never settles reports failure instead of crashing

**Contract:** sprint-spec-20260812-pge-real-workload-errors-7  ·  **Spec:** spec-20260812-pge-real-workload-errors  ·  **Completed:** 2026-08-12

## What this sprint added

A planner that keeps asking clarifying questions exhausts `planClarifyRounds`, is rerouted to
`graceful_failure`, and arrives at the finalize boundary with `state.spec` still null — because
`plan_materialize`, the only writer of `spec`, never ran. `commit.finalize` threw
`FinalizeWithoutSpecError` for that case, so **an unattended run whose plan never settled crashed
the engine instead of reporting a failure**. This sprint fixes it with a **new scalar channel**,
`specDraft` (`graphVersion` **1.3.0 → 1.4.0**, 10 → **11 channels**, `OverallState` 15 → **16
keys**): sole writer `plan_draft`, written on *every* round of the plan region, clarifying or
settled. `commit.finalize` falls back to it when `spec` is null and **resolves** with
`success: false`, `needsClarification: true` and a populated `errors` array instead of throwing.

The obvious fix — a second writer on `spec` — was not merely more expensive, it was **structurally
illegal**, and the contract had that verified before the sprint started: `spec`'s reducer
`replaceIfNewer` is declared scalar (`src/contracts/topology.ts:133`) and the validator emits
`MultipleWritersOnScalarChannel` at severity `error` for any scalar channel with more than one
writer (`src/pge/topology/validate.ts:704-716`). A new channel was the only legal shape.

`FinalizeWithoutSpecError` is **narrowed, not deleted** — it still throws when *neither* `spec` nor
`specDraft` was ever written (a run that never dispatched `plan_draft` at all), and its message was
rewritten to say so. And the golden case the old crash made impossible to record now exists:
`replay-plan-clarify-rounds-exhausted`, a planner that never accepts an answer, driving
`plan_clarify_check`'s declared bound of 3 to exhaustion.

## Public surface

- **`specDraft` channel** (`src/pge/topology/coding.graph.ts:235`) — `scope: public`, reducer
  `replaceIfNewer` (scalar), schema `PlanSpec`, `maxInlineBytes: 65_536`. Sole writer `plan_draft`,
  verified from the *regenerated* artifact rather than the authored literal. It has **no node
  readers at all** (`.bober/topology/state-audit.json` records `readers: []`) — its only consumer is
  the commit boundary, which is a method, not a node. A write-only channel is not a smell here; it
  is the shape of the fix.
- **`plan_draft` writes it** (`src/pge/nodes/plan.ts:290`, `writes` at
  `src/pge/topology/coding.graph.ts:448`) — on the node's single return path, so the draft is
  recorded on every round whether the planner settles or asks again.
- **`OverallState.specDraft: PlanSpec | null`** (`src/pge/state/overall.ts:216`, initialised `null`
  at `:324`) — with `OVERALL_STATE_KEY_BUDGET` moved **15 → 16** (`:262`) and a new `Exact<>` drift
  guard `_specDraftIsExact` holding it to `PlanSpec | null`, the same guard `spec` has.
- **`CommitBoundary.finalize` fallback** (`src/pge/runtime/commit.ts:490-501`) — when
  `state.spec === null` and `state.specDraft !== null`, returns
  `{ success: false, spec: state.specDraft, completedSprints: [], failedSprints: [], duration, needsClarification: true }`.
  It deliberately does **not** route through `finalizePipelineRun`: no completion marker is written
  and no `pipeline-complete` history line is emitted, because a run that never left the
  clarification loop never reached a terminal artifact set. `errors` is not set here either — it is
  layered onto the returned `PipelineResult` by `PgeEngine.run` from the interpreter's own
  `TaskFailure` records (sprint 5's machinery, unmodified), and `finalize` sees only `state`, so
  inventing an entry would mean fabricating a `nodeId` this boundary does not know.
- **`FinalizeWithoutSpecError`** (`src/pge/runtime/commit.ts:153`) — still exported, still thrown,
  now only when neither channel is set. Its message changed from *"state.spec is null"* to
  *"neither state.spec nor state.specDraft is set"*.
- **`buildSpecDraftRealFixtureEntry`** and an exported **`buildObservedEntries`**
  (`src/pge/golden/__fixtures__/workload-build.ts:371`, `:452`) — test-only corpus builders;
  `buildObservedEntries` was exported so a *surgical* corpus addition can run one step instead of
  the whole `buildWorkloadCorpus`, avoiding the "corpus invalidates itself mid-run" hazard sprint 3
  hit. `specDraft` also joins `OBSERVED_CHANNELS` (`:390`).
- **`.bober/golden/replay-plan-clarify-rounds-exhausted.json`** — new `replay` case; terminal
  `graceful_failure`, 8 pinned responses of which **exactly 3 are `plan_draft`**, and a
  `pipelineResult` carrying `needsClarification: true` plus one `LoopExhausted` error at
  `plan_clarify_check`. The replay set is now **6** (floor `GOLDEN_MIN_REPLAY_CASES` is 5); the
  dataset is 43 cases, 37 `integrity`.

## How the cap was sized — the pin caught an analogy, then caught the safe-looking default

This is the part worth carrying forward, because it is about the method rather than the feature.

`specDraft` and `spec` share a schema, so **131,072 by analogy to `spec`** is the number a careful
reader would reach for, and it is the number the generator wrote first. Sprint 3's cap pin rejected
it. That pin is an **equality** — every declared `maxInlineBytes` must *equal*
`capForCorpusMax(corpusMax[channel])` — and it is generic over *every* declared channel, so it
applied to a channel that did not exist when it was written. Notably,
`src/pge/golden/workload.test.ts` **is not in this commit's diff at all**: the pin needed no
extension to bite.

The second attempt was the conservative one: leave the new channel at the graph's default 4,096.
That satisfies the pin *arithmetically* — with only a small observed draft in the corpus (650
canonical bytes), `capForCorpusMax` of it floors at 4,096 — and it silently **reproduced the exact defect sprint 3 had
fixed for `spec`**, because `plan_draft`'s real write on this repository's own plan is **29,214**
canonical bytes and would have been rejected the moment the channel started being written. What
caught it was sprint 1's zero-rejections guarantee in `real-workload.test.ts` (sc-4-1) going false.

The resolution was to stop choosing and start measuring: a real corpus entry
(`.bober/workload/specDraft-spec-20260805-pge-graph-engineering.json`, provenance `file` — this
repository's own committed plan, restated under the `specDraft` channel) makes the corpus maximum
29,214, and `capForCorpusMax(29_214) = 65_536` falls out. It is a *real* payload rather than an
invented one because `spec` and `specDraft` hold identical bytes by construction whenever
clarification settles without a round trip — `plan_draft` writes the draft on the same call whose
output `plan_materialize` later writes to `spec` unchanged. The corpus grew 120 → **122** entries.

Both failure modes were caught by pins that already existed. That is the two-directional cap
discipline doing precisely the job it was built for — including on the direction ("too small") a
literal cap could never have been pinned in.

## Three negative controls had stopped biting, and were strengthened

Growing the replay set from **5 to 6** broke the failure-injection arithmetic in three gate tests.
The threshold is a strict `> 80 %` pass rate over executed cases:

| control | before | at 5 cases | at 6 cases |
| --- | --- | --- | --- |
| `dataset.test.ts`, `gate.test.ts` | fail every 4th case (`seen % 4`) | 1 of 5 fails ⇒ 80 % pass, refused by the strict `>` | 1 of 6 fails ⇒ **83 % pass — the control could no longer fail** |
| `executor.test.ts` | mutate `replayCases[0]` | 1 of 5 ⇒ 80 %, refused | 1 of 6 ⇒ **83 %, false pass** |

The fix: the two threshold controls moved to `seen % 3` (a ~33 % fail rate, which cannot clear 80 %
at any count from the floor upward), and `executor.test.ts` now mutates **two** named cases — both
`replay-full-run-evaluation-*`, chosen because each is a whole run guaranteed a non-empty
`expected.artifacts.contracts` to drift.

The evaluator's verdict was **strengthened**, and it did not take the diff's word for it: it
reverted each control to its pre-sprint logic and confirmed the old versions produced **false
passes** against the 6-case dataset. So these were a required fix, not a threshold accommodation.

**Name the hazard, because it is general:** a negative control that injects a *fixed* fraction or a
*fixed count* of failures against a *growing* denominator degrades silently. Nothing fails when it
stops biting — the suite stays green, and the gate reads as coverage while granting none. This is
the second time in this spec a control was found asleep at a boundary nobody was watching (the
first was `docs.test.ts`'s version fixture in sprint 3, re-keyed off a literal that the shipped
graph had just reached).

## Notes for maintainers

- **`specDraft` is a fallback, not a second source of truth.** `spec` still has exactly one writer
  and still means "the plan was materialised". Anything that reads `specDraft` should be prepared
  for a draft that still carries open `clarificationQuestions` — that is the *only* state in which
  the boundary ever reads it.
- **A failed-to-settle run writes no completion marker.** `finalize`'s fallback path deliberately
  bypasses `finalizePipelineRun`, so `.bober/runs/<runId>.completed.json` is absent and no
  `pipeline-complete` history line is written. A consumer that treats "no marker" as "still running"
  should look at `PipelineResult.needsClarification` / `errors` instead.
- **`success` is still not the field to read.** Unchanged from sprints 5 and 6: this path returns
  `success: false` because there is genuinely no plan, but a *refused* run (fail-closed `commit`)
  still returns `success: true` with a populated `errors`. Check `errors`.
- **LIVE FOLLOW-UP, carried to sprint 8 (evaluator, medium).**
  `src/pge/golden/executor.test.ts:235-240`'s new comment claims its 2-case mutation is safe "regardless
  of how many more cases the replay set grows to hold." **That is false.** For a fixed mutation
  count against a growing denominator, `(n-2)/n` crosses 80 % at **n = 11** (9/11 = 81.8 %). Its two
  siblings switched to a modulo strategy that scales; `executor.test.ts` hardcodes two caseIds and
  will silently stop biting again at 11 replay cases — the same class of break this sprint had to
  fix at 6. Either correct the comment to state the real breakpoint or scale the mutation count with
  `replayCases.length`.
- **The `1.3.0 → 1.4.0` recapture was the second run of a known tension**, not a surprise: a fresh
  capture embeds the current `graphVersion`, so every committed `replay` case fails
  `capture.test.ts`'s byte-exact check on any bump, MINOR included, while `case-schema.ts`'s
  integrity rule is deliberately MAJOR-only. Five cases were recaptured with the diff verified
  confined to the `graph.graphVersion` stamp; the sixth is new. The byte-exact comparison was not
  weakened (NFR0).
- Passed **iteration 1**, all 7 of 7 required criteria. Suite **6897 passed / 2 skipped / 0 failed**
  (baseline 6894, **+3**); typecheck (both tsconfigs), build and lint green; `pge validate --mode
  full` 0 diagnostics with no `MultipleWritersOnScalarChannel`; `pge docs --check` ok (44 nodes);
  golden **6/6**. The evaluator mutated `commit.ts` in **both** directions — forcing the `specDraft`
  branch to throw, and turning the neither-present throw into `if (false)` — and confirmed the
  matching test failed each time, so neither branch is vacuous. Commit `d3134b1`.
