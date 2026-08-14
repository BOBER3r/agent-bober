# Every channel and every node this repository's own real workload touches — measured, and NOTHING was raised

**Contract:** sprint-spec-20260814-pge-full-convergence-10  ·  **Spec:** spec-20260814-pge-full-convergence  ·  **Completed:** 2026-08-14

**Evaluation:** PASSED at iteration 1, **5 of 5 required criteria**
(`.bober/eval-results/eval-sprint-spec-20260814-pge-full-convergence-10-1.json`). Commit
`ba0248f`. This was a **measurement sprint**, so the numbers below — not the prose around
them — are the deliverable. The evaluator re-derived the workload's canonical byte count from
scratch, confirmed `observedWrites` uses the commit boundary's *exact* comparison rather than a
proxy, and confirmed the never-executed set is pinned two-directionally.

## THE CAVEAT THAT GOVERNS EVERY NUMBER ON THIS PAGE

**The workload's DATA is real. The workload's COLLABORATORS are STUBS.** Read every number
below with both halves in mind; the evaluator recorded the split as
`realSpec: true, realCollaborators: false`.

- **Real:** this repository's own committed `spec-20260805-pge-graph-engineering`
  (**29,214 canonical bytes**, re-derived independently by the evaluator with a key-sorted
  `JSON.stringify` — exact match) and its **14 real committed `SprintContract` files**.
  `realWorkloadBindings` (`src/pge/engine/__fixtures__/real-workload.ts:85-91`) replaces
  **only** the planner and materialize collaborators, so the graph is fed genuine plan data.
- **Stub:** every collaborator *downstream* of the plan region is `wholeGraphBindings`'
  shipped fixture body. `generator.notes` is the literal template
  `` `generated ${contractId}` `` (`src/pge/engine/__fixtures__/whole-graph.ts:284`); the
  evaluator stub's `summary` is the literal `"all criteria met"`
  (`stubEvaluation`, `src/pge/nodes/__fixtures__/sprint-harness.ts:222`).

**What this evidence CAN carry:** *the graph engine correctly processes this repository's real
29 KB spec + 14 contracts through 234 supersteps without any channel or superstep-ceiling
breach on the observed path.*

**What it CANNOT carry:** *that the `evaluations` channel is safe under production (non-stub)
evaluator output.* That is an **OPEN, NAMED risk**, not a closed finding — see
[The carried finding, and why it did not close](#the-carried-finding-and-why-it-did-not-close).

## What this sprint added

**No production `.ts` file changed.** `git diff defe8e1..ba0248f --stat` touches exactly three
paths: `.bober/topology/measurements/real-workload.json` (+119), `docs/pge-graph.md` (+99, −7)
and `src/pge/engine/real-workload.test.ts` (+220, −3). The suite total did not move either —
the new assertions live **inside** the existing measurement test rather than in new `it`
blocks, so `real-workload.test.ts` is still 6 tests and the repo is still 7,120 tests.

Two new committed measurement fields, both re-derived byte-identically on every run of the
test and both gated by the same compare-against-the-committed-file rule sprints 1–4
established:

- **`observedWrites`** — per channel, the largest single `ChannelUpdate.value` this run asked
  the boundary to commit, its write count, its declared cap and whether it would have been
  rejected. Produced by `recordingCommitBoundary` (`real-workload.test.ts:325-342`), which
  wraps the **real** `CommitBoundary` the run drives and records `byteSize(update.value)`
  **before** delegating — never altering what the boundary accepts, rejects or commits.
- **`nodeCoverage`** — this run's own spans filtered to `status: "ok"` (the same rule
  `src/pge/golden/coverage.test.ts`'s `executedNodeIdsFromSpans` applies to the golden
  dataset) against all 44 node ids read off `topology.nodes`.

Everything before this sprint answered "does the run complete" and checked **three of eleven**
channels (`messages`, `evaluations`, `refs`) against a *static* corpus payload — real data, but
not data from *this* run, and not every channel. Both gaps are now closed.

## The run

| fact | value |
| --- | --- |
| status | `completed` |
| terminal node | `graceful_failure` — **explicitly not `finalize`** |
| verdict (interpreter's own `GraphRunResult`) | `partial` |
| supersteps | **234** of a **512** ceiling (`headroomFactor: 2` over the measured basis) |
| failures recorded | exactly one: `{nodeId: "commit", errorClass: "FailClosed", superstep: 232}` |
| branches dispatched / settled | 14 / 14, every one `succeeded` at `attempts: 1` |
| rejections | none |

## Per-channel bytes vs declared cap — `observedWrites`

The metric is **not a proxy**: `commit.ts:388-400` computes `bytes = byteSize(update.value)`
and rejects when `bytes > declared.decl.maxInlineBytes`; `recordingCommitBoundary` computes
`byteSize(update.value)` on the same `update` and `wouldReject` uses the identical operator.
The evaluator verified this line-for-line and spot-checked two of the numbers independently.
The key set is pinned by **set-equality against `channelLimits`' own keys** — not a hand-picked
subset — so a channel added later cannot silently escape the measurement.

| channel | largest single write (bytes) | writes | declared cap | over cap? |
| --- | --- | --- | --- | --- |
| `branchStatus` | 108 | 28 | 4,096 | no |
| `counters` | 70 | 47 | 4,096 | no |
| `evaluations` | **368** | 43 | 4,096 | **no** |
| `ledger` | 221 | 90 | 4,096 | no |
| `messages` | 267 | 93 | 4,096 | no |
| `refs` | 287 | 46 | 4,096 | no |
| `spec` | 29,214 | 1 | 131,072 | no |
| `specDraft` | 29,214 | 1 | 65,536 | no |
| `sprintContracts` | 135,106 | 15 | 524,288 | no |
| `testAnchors` | 22 | 14 | 4,096 | no |
| `verdict` | 0 | **0** | 4,096 | n/a — never written this run |

**NO channel breached. Nothing was raised.** The contract's stop condition made that the
obligation rather than a happy accident: *"The real workload exceeds a channel cap or a
superstep ceiling — that is the finding, and it is worth more than a passing run. Report the
measured number rather than raising the cap reflexively."* No row came back
`wouldReject: true`, so no cap and no ceiling moved.

`verdict`'s row is recorded as `writeCount: 0`, **not** as "measured and found small". Its sole
writer is `finalize`, and `finalize` is one of the eight nodes below that never executed on
this run — so its 4,096-byte cap was exercised **zero** times. That is a fact distinct from
headroom, and the test pins it explicitly (`writeCount === 0 && maxBytes === 0`) so nobody
reads a `wouldReject: false` as evidence either way.

## The carried finding, and why it did not close

Sprint 5's audit flagged that `sprint_evaluate` now writes one `evaluations` entry carrying
**three independent copies of unbounded model text** — `summary` (decorated, but wrapping the
raw evaluator text), `evaluatorFeedback` (`result.summary`, raw) and `generatorNotes`
(`generated.notes`, raw). The node's own `bober:` comment
(`src/pge/nodes/sprint-evaluate.ts:423-431`) names the tripling as a potential
`StateBloatError` source — *"Tens of bytes on this fixture's stub evaluator; a real evaluator's
`summary` could be large enough to make the doubling matter."* The static `corpusHeadroom`
check could not see the risk at all: the
corpus `evaluations` entries it reads **predate all three fields**.

`observedWrites` can see it, and it measured **368 bytes against a 4,096-byte cap across 43
writes** — comfortably under, *even carrying all three copies*.

**That number closes nothing.** It is 368 bytes because this run's stub collaborators write a
few dozen bytes of text each; three copies of `"all criteria met"` and
`"generated <contractId>"` stay two orders of magnitude under the cap by construction. **This
measurement proves the STUB corpus does not breach. It does not prove that a real evaluator's
longer free-text summary and feedback would not.** The `bober:` comment's own upgrade path —
stop decorating `summary` on the passing case, where it and `evaluatorFeedback` would then be
identical — remains unexercised, and tuning was an explicit nonGoal of this sprint. The risk
is carried forward **named and open**, in this record and in `docs/pge-graph.md`, rather than
retired.

## Node coverage on one real path — 36 of 44

**36 of the 44 declared nodes executed with `status: "ok"`. All 8 that did not are named
individually**, with a reason each, rather than averaged into a coverage percentage. The pin is
`toEqual` over the exact 8 ids — two-directional, so a node that *starts* executing fails the
test just as one that stops does.

**This is deliberately NOT the golden dataset's 42/44.** A golden dataset is many cases
engineered to reach every region; one real run is **one path** through the graph, so it misses
every node whose triggering condition this workload's real spec and stub collaborators happen
never to produce.

| node | reached? | why not |
| --- | --- | --- |
| `commit` | reached, span `"interrupted"` | FAIL_CLOSED refusal — the plain `conformanceConfig()` runs `mode: "autopilot"` with no durable approval for `end-of-pipeline`. Golden case `replay-full-run-commit-approved` proves `commit` completes `"ok"` under `goldenApprovedConfig()`. A fact about this measurement's config, **not** a structural block. |
| `finalize` | no | sole inbound edge is `commit -> finalize`; `commit` never resolves `"ok"` here, so the edge is never crossed. Same root cause as `commit`, not independent. |
| `critique` | no | needs `route_after_eval`'s `rework` label, which needs a non-passing verdict. All **14** branches pass on their first stub attempt (`attempts === 1`, asserted). Golden case `replay-corrected-sprint-still-grades-fail` proves it runs. |
| `rework_route` | no | sole inbound edge is `critique -> rework_route`; not reached for the identical reason. |
| `sprint_correct` | no | needs a generated sprint to fail a check or need another attempt; the stub generator and evaluator both succeed first-attempt on all 14 contracts. |
| `plan_clarify` | no | needs `plan_clarify_check`'s `clarify` label; the planner stub resolves `{kind: "ready", spec}` directly with the real committed spec, so clarification is never needed. |
| `context_compact` | no — **STRUCTURAL** | the golden dataset's own block (sprint 8): no shipped handler path returns `COMPACT_LABEL`. Independent of this workload's inputs. |
| `synthesize` | no — **STRUCTURAL** | the golden dataset's own block (sprint 9): the `reworkRoundsTaken >= 2` precondition `route_after_eval`'s `partial` label needs cannot arise. Independent of this workload's inputs. |

**Six of the eight are workload-specific misses, not new unreachability claims.** Each is
proven reachable elsewhere by a named golden case, and the backstop is structural rather than
anecdotal: `coverage.test.ts:274` pins the golden dataset's missing set to exactly
`["context_compact", "synthesize"]`, so all six of these nodes demonstrably execute somewhere
in the committed dataset. The evaluator independently located and read four of the six named
cases on disk. Only `context_compact` and `synthesize` carry the stronger claim, and this
measurement does **not** re-derive it — it cites the golden dataset's own proof.

## What sprint 11 inherits

- **A real-workload record it can take a flip decision against** — committed, re-derivable and
  test-gated, covering every channel and every node.
- **The `evaluations` risk, OPEN.** Sprint 11 must account for it rather than silently inherit
  it as settled. "No breach on real data" is true; "no breach under real collaborators" was not
  measured and is not implied.
- **36/44 is not a coverage regression against 42/44.** The two numbers answer different
  questions (one real path vs. the whole engineered dataset) and must not be compared or
  averaged. Only two of this run's eight misses are structural; the other six are the
  signature of a single path.
- **Nothing here licenses raising a cap.** Every cap is still sized off the committed corpus
  by `capForCorpusMax`, and this measurement's role is to *observe* those caps, never to
  justify moving them.

## Files touched

- `src/pge/engine/real-workload.test.ts` — `+220/−3`. `ObservedChannelWrite` / `NodeCoverage`
  types, `recordingCommitBoundary`, the `observedWrites` and `nodeCoverage` assembly, and the
  sc-10-2 / sc-10-3 assertion blocks inside the existing measurement test. No new `it`.
- `.bober/topology/measurements/real-workload.json` — `+119`. Regenerated with
  `MEASURE_REAL_WORKLOAD=1`; now carries `observedWrites` and `nodeCoverage` alongside the
  fields sprints 1–4 established.
- `docs/pge-graph.md` *(generator)* — new section "Every channel and every node this real run
  touches — sprint 10" with both tables and the stub caveat; **plus** a pre-existing staleness
  corrected in the immediately adjacent section: three `verdict: "failed"` mentions moved to
  `"partial"` with a cross-reference to the sprint-7 `verdictFrom` fix that caused the move.
- `docs/pge-graph.md` *(documentation commit)* — the CAN/CANNOT framing added directly beneath
  the numbers; reciprocal cross-references from the Channels section, the committed-corpus
  section and the golden-coverage section, so a reader arriving from any of the three learns
  that per-channel and per-node observation now exists and what its limit is.
- `docs/sprints/README.md` — new table row, spec paragraph, section count 9 → 10 of 11
  *(documentation commit)*.
- **This record** — new *(documentation commit)*.

## Notes for maintainers

- **The measurement is a PIN, not a snapshot.** Re-running **without** `MEASURE_REAL_WORKLOAD=1`
  compares the freshly derived measurement against the committed file and fails on any
  difference — the evaluator confirmed this on a genuinely clean detached worktree, so the
  record cannot silently re-record itself. If a number here changes, that diff **is** the
  statement that behaviour changed, and it must be explained rather than re-captured.
- **`recordingCommitBoundary` observes, it never decides.** It delegates every call to the real
  boundary unchanged. A rejected write is recorded in `observedWrites` **as well as** in
  `rejections`, which is what lets `observedWrites` answer "every channel" without a reader
  reconciling two lists.
- **Do not treat `wouldReject: false` on `verdict` as headroom.** `writeCount: 0` is the load-
  bearing field on that row.
- **One stale cross-reference, deliberately not fixed here.** A comment in
  `real-workload.test.ts` (around the sc-10-3 assertions) points at a
  `docs/pge-graph.md` section called *"The real workload's own node coverage"*; the section that
  actually shipped is titled *"Every channel and every node this real run touches — sprint 10"*.
  Documentation may not edit test files, so it is recorded here instead — a one-word fix for
  whoever next touches that file.
- **Gate, as run:** clean detached worktree at `ba0248f` with a fresh install — **468 files /
  7,114 passed / 6 skipped / 0 failed**; the working tree reports **7,118 passed / 2 skipped**,
  the same 7,120 total (the four-test split is the `.tokensave` gate explained in the sprint 7
  record). `typecheck` and `typecheck:tests` clean; `lint` 0 errors / 2 pre-existing warnings;
  `build` clean; golden gate **8/8**; `pge docs --check` ok (44 nodes). Generator and evaluator
  numbers match exactly. Run the suite as `npx vitest run --exclude '**/.claude/worktrees/**'
  --exclude '**/node_modules/**'` — a bare run picks up nested worktrees.
