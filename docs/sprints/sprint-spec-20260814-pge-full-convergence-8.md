# `critique` and `rework_route` EXECUTE — and `context_compact` is recorded as structurally blocked rather than contrived around

**Contract:** sprint-spec-20260814-pge-full-convergence-8  ·  **Spec:** spec-20260814-pge-full-convergence  ·  **Completed:** 2026-08-14

**Evaluation:** PASSED at iteration 1, **5 of 5 required criteria — one of them `pass-AMENDED`**
(`.bober/eval-results/eval-sprint-spec-20260814-pge-full-convergence-8-1.json`). `sc-8-1` was
honestly NOT met and is recorded as a **structural finding**, which is what the contract's own
stop condition instructed: *"A node turns out to be unreachable for a structural reason rather
than a missing case — record which, with the reason, rather than contriving a case that reaches
it artificially."* The evaluator re-derived that block independently from source and from a
FRESH trace rather than accepting the report's account, and re-ran the whole gate on a clean
detached worktree with a fresh `npm install`. Commit `65ea5a8`.

## What this sprint added

One golden replay case, `.bober/golden/replay-corrected-sprint-still-grades-fail.json`
(`enforcement: "replay"`, captured — never hand-written), that drives `critique` to a
`status: "ok"` span and, through `critique`'s sole successor edge, `rework_route` too. Node
coverage moves **40 / 44 → 42 / 44 (~95.5 %)** and `NEVER_EXECUTED`
(`src/pge/golden/coverage.test.ts`) shrinks from four entries to
`["context_compact", "synthesize"]`. The golden replay set grows from 7 cases to **8**; the gate
reports **8/8**.

**No production code changed.** `git diff --stat` over `65ea5a8` touches exactly five paths: one
new golden case, two test files, one test-support file and `docs/pge-graph.md`. No non-test
`.ts` anywhere, no `package.json`, no `package-lock.json`, no topology. The coverage figure rose
because a case was written that exercises behaviour the shipped graph already had — not because
anything about the graph, the interpreter or the coverage rule moved. That is the strongest
claim this sprint makes, and it is the reason the number is worth anything.

**The coverage-ratio floor did not move either.** `coverage.test.ts:272` still asserts
`executed.size / declared.length > 0.85`; the evaluator checked the diff for exactly that,
because NFR0 forbids lowering a gate to protect a number, and `42 / 44` clears the untouched
floor on its own.

## The asymmetry the new case exploits

Two rules read the same evaluation history and disagree about it, and the disagreement is what
makes `route_after_eval` select `rework` on a run whose branches all succeeded:

- `branchOutcome` (`src/pge/nodes/sprint-review.ts`) settles a branch on its **last decisive
  verdict**. A branch that fails its first evaluation and passes its retry settles
  `"succeeded"`, so `reduce_sprints`'s `all-branches-settled` gate admits the run into global
  evaluation instead of re-dispatching it.
- `gradeContracts` (`src/pge/nodes/root.ts`) instead **reduces over every recorded verdict**,
  and one `"fail"` row outranks a later `"pass"` permanently. The same contract stays graded
  `"fail"` forever.

So `evaluate_global` returns a non-pass verdict on a run every branch of which succeeded,
`route_after_eval` selects `"rework"` (the rework counter is still under budget on a first
round), and `critique` runs. The case is produced by a `correctingBindings(1)` factory in
`src/pge/golden/capture.test.ts` — `wholeGraphBindings` twice, once passing and once failing,
switched on the `evaluator` seam alone so every other collaborator is identical to the existing
`replay-full-run-evaluation-fails`. The committed expectation ends at `terminalNodeId:
"graceful_failure"` with the contract settled `"completed"`.

**Span status was read, not inferred.** Both the generator and the evaluator ran the case
through `createGoldenExecutor({ keepRunRoots: true })` and read the raw trace JSONL: `critique`
at superstep 41, `status: "ok"`, `route.goto { kind: "node", node: "rework_route" }`;
`rework_route` at superstep 42, `status: "ok"`, `route.label: "exhausted"`. A case that reaches
a node but errors inside it would not have satisfied this sprint, and the coverage rule (since
sprint 9 of `spec-20260812-pge-real-workload-errors`) would not have counted it either.

## `rework_route` came with `critique` — the nonGoal was topology-forced, and was flagged first

The contract's nonGoal read *"Driving rework_route or synthesize — sprint 9."* It could not be
honoured for `rework_route`: `critique`'s only outbound edge is `critique -> rework_route`
(`e-eval-critiqued`), so **no case can drive one without driving the other**. This was recorded
in the contract's `preFlightFinding` *before* implementation, not discovered afterwards, and the
evaluator confirmed it from the artifact. It was let happen and written down rather than
contrived around.

`rework_route` still does no dispatch work when it runs: by the time it can run at all,
`reduce_sprints`'s gate has guaranteed every dispatched branch is `"succeeded"`, and
`dispatchableContracts` (`src/pge/nodes/sprint-fanout.ts`) excludes exactly `"succeeded"` and
`"abandoned"` branches, so its dispatch set is empty and it selects `"exhausted"` — still a
`status: "ok"` span, which is all coverage claims. `synthesize` was left untouched and remains
in `NEVER_EXECUTED`.

## sc-8-1: `context_compact` is structurally blocked, and no case-authoring lever reaches it

The block is at **label selection**, one step upstream of the node itself:

- The node's only inbound edge is `supervisor --compact--> context_compact`
  (`e-supervisor-compact`, declared at `src/pge/topology/coding.graph.ts:416`).
- The shipped supervisor handler (`src/pge/nodes/supervisor.ts:140-177`) has exactly **five**
  return statements — a refusal hop to graceful failure (`:144`), `PLAN_LABEL` (`:153`),
  `SPRINTS_LABEL` (`:166`), `EVALUATE_LABEL` (`:170`) and the default end-of-run
  (`:173-176`) — and none of them returns `COMPACT_LABEL`. `grep -rn COMPACT_LABEL src/` finds
  the label in non-test source **exactly once**: its own declaration at `supervisor.ts:82`.
- It cannot gain such a path without a topology change first. `supervisor.reads` is
  `["branchStatus", "counters", "spec", "evaluations"]` (`coding.graph.ts:408`) — no
  `messages` — so even a correct handler could not READ what a compaction threshold needs to
  measure.
- No case-authoring lever reaches around it. The golden executor **refuses** a case that seeds
  channel values (`src/pge/golden/executor.ts:446-451`), the only config input it permits is
  exactly `{ approved: true }` (`:175-179`, enforced at `:452`), and the `supervisor` node
  declares `effects: []` (`coding.graph.ts:410`), so no binding can influence its decision.
- This is not a token-threshold problem: `contextCompactNode`'s own body (`nodes/root.ts:660`,
  the `!decision.shouldCompact` branch at `:675`) would return a `status: "ok"` span even below
  its threshold if it were ever entered. Enlarging a case's message count changes nothing.
- **Verified by execution, not only by reading.** The evaluator ran the new case fresh and
  grepped the raw trace for `context_compact`: zero occurrences.

**Cost to close, stated honestly:** a topology change (adding `messages` to `supervisor.reads`)
plus the minor `graphVersion` bump that change requires, plus new supervisor handler logic that
measures the window and selects `COMPACT_LABEL`. That is shipped production code — out of scope
for a sprint whose whole premise was *"add cases that drive existing behaviour"*.

**The claim is test-backed, not merely written down.**
`src/pge/nodes/supervisor.test.ts` gains a `CLAIM:` describe block that runs the real
`supervisorNode({ spec: CODING_GRAPH })` over four states — empty, plan-ready, branches-settled,
and one with a 500-message window of 200-token messages — and asserts the command's `goto` is
never `{ kind: "label", label: COMPACT_LABEL }`. It goes red the moment the handler gains a
compact-selecting path, whether by a direct edit or by some state nobody thought to try. The
generator proved it bites by temporarily adding such a path (test red), then reverting to
byte-identical.

## Three structural limits in this spec, and they are the same KIND of finding

`context_compact` is the **third** confirmed structural limit `spec-20260814-pge-full-convergence`
has produced, and reading the three together is more useful than reading any one of them:

| # | limit | what the shipped architecture cannot express | cost to close |
| --- | --- | --- | --- |
| sprint 1/3 | `audits` — five undeclarable checkpoint ids | a per-branch interrupt inside a fan-out: `Checkpoint.interrupt` is one slot, `grantScope`/`clearScope` and `resumeMessageId` carry no branch key (`.bober/architecture/arch-20260814-pge-full-convergence-adr-1.md`) | a keyed, branch-aware interrupt slot plus branch discriminators through the resume path — a runtime redesign |
| sprint 6 | `pipelineResult.errors` | an imperative-engine write site for a FAIL_CLOSED refusal: there is no interpreter and no gated commit step to refuse — its auto-commit calls `commitAll` (`src/orchestrator/pipeline.ts:451`) inside a `try`/`catch` that only debug-logs, with no HITL gate at all | giving the imperative engine a checkpoint-gated commit — an architecture change |
| sprint 8 | `context_compact` unreachable | a supervisor decision that reads the message window: no handler path returns `COMPACT_LABEL`, and `supervisor.reads` does not authorise `messages` | a topology reads-list change + `graphVersion` bump + new handler logic |

What makes them one kind rather than three coincidences: each was found by **running or reading
the shipped system**, not by assuming; each was **recorded rather than worked around**, on the
authority of the owning contract's own stop condition; each has a **named, non-trivial
cost-to-close in production code** that no case, binding, seed or fixture can substitute for;
and in each the sprint's implementation was right while the CONTRACT's premise was wrong, which
is why all three carry an `amendedDisposition` rather than a retry. Three of them is a pattern
about how this spec was scoped — the plan assumed missing WRITERS and missing CASES everywhere,
and in three places the answer was a missing capability — not three unrelated setbacks.

## What sprint 9 and sprint 11 inherit

- **`synthesize` is sprint 9's only genuine remaining target.** `sc-9-1` (`rework_route`
  executes) is already satisfied by this sprint, by topology.
- **`sc-9-3` ("`NEVER_EXECUTED` is empty") and `sc-9-4` ("every node in the committed topology
  executed") are UNSATISFIABLE as literally written**, for exactly the reason above:
  `context_compact` cannot execute without shipped code that does not exist. The orchestrator
  has already recorded this on sprint 9's contract (`preFlightFinding`), with an amended intent
  — `NEVER_EXECUTED` contains ONLY nodes proven structurally unreachable, each with a recorded
  reason and a claim test, and coverage asserts every node executes EXCEPT those, computed
  against the topology artifact rather than a hardcoded count. **The guard must keep biting in
  both directions; deleting it is not the way to satisfy the criterion.**
- **Sprint 11 (the flip-bar/consolidation sprint) now owns three unsatisfiable-as-written
  criteria, not one.** `sc-11-1` (`equivalent: true` on a real run) was already known
  unsatisfiable because `audits` and `pipelineResult.errors` are architectural; `sc-9-3` and
  `sc-9-4` join it for the same class of reason. The satisfiable work is re-specifying each bar
  around a named, accepted, individually-justified exception set rather than around emptiness.

## Files touched

- `.bober/golden/replay-corrected-sprint-still-grades-fail.json` — **new**, captured, 1,350
  lines, `enforcement: "replay"`, `graphVersion 1.5.0`.
- `src/pge/golden/capture.test.ts` — the `correctingBindings(failures)` factory and the new
  `SCENARIOS` entry that produces the case (`capture.ts` hard-codes `enforcement: "replay"`, so
  no case can be captured as `integrity` by accident).
- `src/pge/golden/coverage.test.ts` — `NEVER_EXECUTED` shrinks to two entries; the doc block
  above it is rewritten (the `critique`/`rework_route` closure explained, `context_compact`'s
  reason sharpened from the upstream `reads`-drift symptom to the label-selection block
  itself); two new two-directional guard controls, each proven to bite by inverting its key
  assertion and observing red before restoring.
- `src/pge/nodes/supervisor.test.ts` — the `COMPACT_LABEL` claim test described above.
- `docs/pge-graph.md` — coverage figure `40/44 → 42/44`; the four-row `NEVER_EXECUTED` table
  replaced by a sprint-8 paragraph plus a two-row table; the mutation-proof paragraph gains
  sprint 8 as its second concrete instance.
- `docs/sprints/README.md` — new table row for this sprint *(documentation commit)*.
- **This record** — new *(documentation commit)*.

## Notes for maintainers

- **A `pass-AMENDED` criterion is not a deferred retry.** `sc-8-1` will not become satisfiable
  by trying harder at case authoring; anything that appears to satisfy it without the
  production change named above should be treated as a contrivance and rejected. The claim test
  in `supervisor.test.ts` is the tripwire: if it ever goes red, `NEVER_EXECUTED`'s
  `context_compact` entry must be deleted deliberately in the same change, not patched around.
- **`NEVER_EXECUTED` is a list of claims, not a to-do list.** Each entry is an explanation of
  why a node is unreachable, and the pin is two-directional — a node that starts executing while
  still listed fails the test just as a node that stops executing does. The two controls this
  sprint added exercise both directions against synthetic spans, because the real dataset can
  only ever demonstrate the direction its own cases happen to exercise.
- **`docs/pge-graph.md`'s negative-control section carried a stale case count.** It read "At the
  current **7**"; the dataset holds 8 replay cases as of this sprint. Corrected in the
  documentation commit, along with the `executor.test.ts:363` citation for a comment now at
  `:378`. The comment inside `executor.test.ts` still says "current 6" — a test-file comment,
  left alone here because this sprint's documentation pass does not edit tests.
- **Gate, as run:** working tree 7110 passed / 2 skipped; the evaluator's clean detached
  worktree with a fresh `npm install` 467 files / 7106 passed / 6 skipped / 0 failed (the same
  7112 total, split differently for the `.tokensave` reason sprint 7's record explains).
  `typecheck`, `typecheck:tests`, `lint` (0 errors, 2 pre-existing warnings) and `build` green
  in both. Golden gate **8/8 (100 %)** — 45 committed cases, 8 `replay`, 37 `integrity`,
  comfortably above `GOLDEN_MIN_REPLAY_CASES = 5`.
- **One transient flake, not attributable here:** an ESLint-spawn timeout in
  `src/pge/lint-boundary.test.ts` on the first clean-worktree run, which passed in 446 ms in
  isolation and was green on immediate rerun. Resource contention; this sprint touches no file
  it involves.
