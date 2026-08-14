# The version delta closes — `contracts` converges; `pipelineResult` narrows to a new, independent finding

**Contract:** sprint-spec-20260814-pge-full-convergence-6  ·  **Spec:** spec-20260814-pge-full-convergence  ·  **Completed:** 2026-08-14

**Evaluation:** PASSED at iteration 1, **6 of 6 required criteria** — `sc-6-3` by an **AMENDED
DISPOSITION**, not by the literal wording of the criterion
(`.bober/eval-results/eval-sprint-spec-20260814-pge-full-convergence-6-1.json`; the amendment is
recorded on the contract itself under `amendedDisposition`). The generator's own report filed
`sc-6-3` as NOT MET and listed it as a blocker; the evaluator adjudicated it a pass because the
CONTRACT's premise — not the implementation — was factually wrong. Read
["The amended disposition"](#the-amended-disposition--what-the-evaluator-adjudicated-and-why-it-matters-beyond-this-sprint)
before the sprint-local sections: it is the most consequential thing this sprint produced.
Commit `1fd29e9`.

## What this sprint added

`sprint_exit` has written a monotone `version: attempts` on the settled contract since sprint 3
of `spec-20260812-terminal-vocabulary`; `runSprintCycle` wrote none. This sprint gives the
imperative engine an equivalent, independently-derived source: `settledAttempts`
(`src/orchestrator/pipeline.ts`), a counter hoisted above the sprint retry loop and incremented
once per round that reaches a **decisive verdict** — the round the evaluator actually ran for —
written onto the settled contract as `Math.max(1, settledAttempts)` at all four of
`runSprintCycle`'s settle sites, always BEFORE the `updateContract` call at each so the disk
copy and the returned object carry the same number. `contracts` is now fully closed: the two
engines' settled contracts compare canonically-equal with **nothing** stripped.

`pipelineResult` does **not** leave the divergence set, but for a reason this sprint's own
contract did not anticipate: closing `contracts` closed the CONTRACT-CONTAINER portion of
`pipelineResult` (`completedSprints`/`failedSprints`) as a genuine consequence, exactly as
predicted — but a real run of the harness (not assumed, executed) showed `pipelineResult` still
diverging afterward, on a field with nothing to do with `contracts`: `errors`. See "The
discovery" below.

## The counter decision: option (ii), a decisive-round count — not the raw loop variable

The sprint briefing laid out two honest options and asked for one to be picked and justified:

- **(i) `version: iteration`** — the imperative loop's own `for`-loop variable, simplest, in
  scope at all four settle sites.
- **(ii) a decisive-round counter** — `settledAttempts`, incremented once per round that reaches
  the evaluator, matching PGE's `attempts` byte-for-byte on every round shape including a
  generator-failure round.

**Option (ii) was chosen.** The two disagree on exactly one row: a round where the generator
itself fails (`generatorResult.success === false`, `pipeline.ts`'s retry-without-evaluating
path). The imperative `iteration` loop variable still advances on that round; PGE's `attempts`
does not, because `sprint_generate` records no `evaluations` entry for it — `gate_syntax` routes
straight to the corrector "without spending an evaluation" (`coding.graph.ts:642`). Writing
`version: iteration` would therefore make the two engines' `version` disagree on precisely the
one round shape sc-6-1 exists to unify, for the sake of a smaller diff. `settledAttempts` costs
one extra hoisted variable and one extra increment site (immediately after
`runEvaluatorAgent` returns), and it is a count, floored at 1, of WHICH verdicts happened — never
a clock, an ordering or a superstep, satisfying the sprint-3 disqualification bar the same way
`iteration` would have. `pipeline.test.ts` pins the discriminating case directly: a
generator-failure round followed by a pass writes `version: 1`, not `2` — the number `iteration`
would have produced.

The out-of-loop return (`pipeline.ts`, reached only via the `interrupted` break or a
zero/negative `maxIterations`) deliberately writes **no** `version`, even though
`settledAttempts` — unlike `iteration` — is in scope there. The contract's status at that return
is never a settled one; synthesising an attempt count for a round that never reached a verdict
would be the same class of dishonesty sprint 5 refused for `evaluatorFeedback`/`generatorNotes`
on an unresolved round.

## sc-6-2: replay-stability proven by execution

`pipeline.test.ts` gained a dedicated `describe` with four tests: a one-round pass writes
`version: 1` on both `result.contract` and the last mocked `updateContract` call; a two-round
fail-then-pass writes `version: 2` (discriminates the rule from a constant — the fixture the
conformance harness itself cannot discriminate, since `conformanceConfig()` settles in one
round); the generator-failure-then-pass case above; and a frozen-clock, fresh-temp-root-per-run
pair (`vi.useFakeTimers`) that runs the identical two-round fail-then-pass scenario TWICE and
asserts `a.contract.version === b.contract.version` (`= 2`) and `a` deep-equals `b` in full — not
merely the version field in isolation. All four tests were confirmed to be discriminating, not
vacuous, by mutation: stashing `pipeline.ts`'s changes and re-running the same four tests fails
all four (three on `undefined`/wrong values, one on `toBeDefined()`), then the stash was
restored.

## The discovery: `pipelineResult` diverges on `errors`, independent of `contracts`

The sprint contract's `evaluatorNotes` asked to "verify pipelineResult closed as a CONSEQUENCE
of contracts rather than being separately special-cased" — and the sprint briefing predicted
"pipelineResult reduces exactly to the contracts divergence... it closes exactly when contracts
closes, not before." Running the harness after the `contracts` fix showed this premise was only
half right: `pipelineResult`'s field-level pin still failed, with `contracts` no longer among
the reported diffs. Diagnosis (via a one-off debug assertion, since removed): the pge side's
`PipelineResult` carries a key `tsResult` never has at all — `errors`.

`PipelineResult.errors?: readonly PipelineFailure[]` was added by
`spec-20260812-pge-real-workload-errors` (sprint 5) and is populated **only** by
`PgeEngine.run`, from the interpreter's own `TaskFailure` records
(`src/pge/engine/pge-engine.ts:551-572`). On the conformance fixture it is **always**
non-empty: the shipped autopilot config's `noop` checkpoint mechanism grants nothing, so the
graph's `git`-effect `commit` node is FAIL_CLOSED refused every run — the same refusal already
recorded in the conformance test's "2b. THE MATERIAL FACT" block — and the interpreter now
surfaces that refusal through `errors` as well as through the audit trail. `runTsPipeline` has
no interpreter and no `TaskFailure` concept at all, and its own auto-commit (`commitAll`,
unconditional when `config.generator.autoCommit` is true) is not gated behind any checkpoint the
way the graph's `commit` node is — there is no refusal for it to ever report, and therefore no
honest write site for an equivalent `errors` entry on the imperative side.

This is the same category of finding the sprint's own stop condition protects against for
`version` — "report what IS available rather than shipping something a replay cannot
reproduce" — applied to a field the contract did not anticipate. Two dishonest ways to make
sc-6-3 pass literally as worded were both rejected: adding `errors` to `VOLATILE_KEYS` (which
would hide a real, engine-observable difference — exactly what that list's own doc comment
forbids) and fabricating an `errors` entry for the imperative engine (which would misreport an
event that architecturally cannot happen there). Neither was done.

**Result as the generator filed it: `sc-6-3` NOT fully met.** The divergence set after this
sprint is `["audits", "pipelineResult"]`, verified by running the harness — `contracts` is gone
(sc-6-1's claim), but `pipelineResult` stays, now for `errors` alone rather than for the reason
the contract assumed. It was recorded as a finding for a future sprint, not silently absorbed
into this one's scope: closing it means either giving the imperative engine an equivalent
checkpoint-gated commit step (a real behaviour change) or formally joining `audits` as a
permanently-accepted divergence — a decision, not a default.

**The evaluator adjudicated it a PASS under an amended disposition** — the section below is the
authoritative account of the outcome, and it says something stronger than "a finding for a
future sprint".

## The amended disposition — what the evaluator adjudicated, and why it matters beyond this sprint

`sc-6-3` reads *"Neither 'contracts' nor 'pipelineResult' appears in the divergence set"*. It was
adjudicated **`pass-AMENDED`**, and the reason is recorded in two places that outlive this record:
`amendedDisposition` on
`.bober/contracts/sprint-spec-20260814-pge-full-convergence-6.json` and `architecturalFinding` on
`.bober/eval-results/eval-sprint-spec-20260814-pge-full-convergence-6-1.json`.

**What was wrong was the contract, not the implementation.** The contract's own description
asserted that closing `contracts` would close `pipelineResult` "since that field is a container
for the same objects". Half of that is true and was verified: the container portion
(`completedSprints`/`failedSprints`) closed as a genuine consequence, now asserted on BOTH
engines against each engine's own settled contract. The other half was never true —
`pipelineResult.errors` diverges independently of `contracts` and always did; it was simply
**masked**, because `contracts`/`version` was diverging under the same `pipelineResult` field
name and nobody had isolated the container portion from the whole.

**The evaluator confirmed the gap independently, from source rather than from the report:**

- `PipelineResult.errors` has **exactly one write site repo-wide** — `PgeEngine.run`
  (`src/pge/engine/pge-engine.ts:551-572`), spreading `errors` from the interpreter's own
  `TaskFailure` records, only when `failures.length > 0`. That code and its doc comment
  **pre-date this sprint** (introduced by `spec-20260812-pge-real-workload-errors` sprint 5), and
  this sprint's diff does not touch the `PipelineResult` interface at all.
- The imperative side has no honest equivalent write site — not a missing write, a missing
  SOURCE. `runSprintCycle`'s auto-commit (`src/orchestrator/pipeline.ts:449-462`) calls
  `commitAll` **unconditionally** when `config.generator.autoCommit` is true, inside a
  `try`/`catch` that only `logger.debug`s and continues; there is no HITL gate at all.
  `finalizePipelineRun` requests the end-of-pipeline checkpoint AFTER the completion marker and
  the history event are written, and does not gate on its outcome.
- The graph, by contrast, has an explicit `hitl_commit` gate node
  (`src/pge/topology/coding.graph.ts:911-923`) feeding a separate `commit` tool node
  (`:926-937`), whose own `doc` says it is *"reachable only behind the approval gate, which is
  what makes the git effect blockable fail-closed"*.

**Both rejected fixes were rejected for stated reasons, not taste.** Adding `errors` to
`VOLATILE_KEYS` violates that set's own documented bar — a key belongs there only when two runs
of the **same** engine over the same input would differ on it; `errors` differs **between**
engines on the **same** input, which is exactly the class `VOLATILE_KEYS` must never hide.
Fabricating an imperative `errors` entry would misreport behaviour the architecture cannot
produce.

**The consequential conclusion — the part that changes how the spec's remaining sprints should
be read.** The divergence set is `['audits', 'pipelineResult']`, and **both remaining entries are
ARCHITECTURAL, not unbuilt**, and they share **one root cause**: *the graph has a
checkpoint-gated commit that the imperative engine lacks.* `audits` diverges because a graph run
records at most two of the imperative pipeline's eight checkpoint ids; `pipelineResult` diverges
because the graph's gated `commit` can be refused and the imperative engine's ungated
`commitAll` can never be. `history` (sprint 4) and `contracts` (this sprint) are closed; nothing
is left in the set that a missing writer would close.

**Where the decision this record cannot take needs to be taken.** Sprint 3 of this spec
established `audits`' architectural acceptance through an ADR
(`.bober/architecture/arch-20260814-pge-full-convergence-adr-1.md`, "Fan-out checkpoints stay
illegal — the runtime cannot hold a per-branch interrupt"). **Both the generator and the
evaluator independently recommend that `pipelineResult.errors` be joined to that same
acceptance.** That is a recommendation on the record, not a decision taken: this record does not
author or amend an ADR. The contract's `amendedDisposition.carryTo` names the owner —
**sprint 11**, the flip-bar sprint, whose `sc-11-1` currently asks for `equivalent: true` on a
real run. That criterion is unsatisfiable as written under a divergence set both of whose
members are architectural; sprint 11 must re-specify the bar (its own `sc-11-3`/`sc-11-5`
territory) rather than chase an equivalence that no amount of building can reach.

## Testing

- `src/orchestrator/pipeline.test.ts` — new `describe("runSprintCycle writes a replay-stable
  version onto the settled contract (sc-6-1/sc-6-2)")`, four tests (above). All pre-existing
  tests in the file (the security-audit-gate suite) stay green unchanged.
- `src/orchestrator/workflow/conformance.engines.test.ts` — the divergence-set pin moves from
  `["audits", "contracts", "pipelineResult"]` to `["audits", "pipelineResult"]`; `committedPin`
  moves with it, with both directions still discriminating (a closed field re-appearing;
  `audits` or `pipelineResult` silently vanishing). The real-run "3. contracts" section replaces
  the `toBeUndefined()`/`toBeDefined()` pair with Pattern B (`toBeDefined()` on both sides,
  equality against the other engine's own answer) and adds an UNSTRIPPED whole-object
  `canonical(pgeContract) === canonical(tsContract)`. The "4. pipelineResult" section keeps the
  now-fully-converged container assertions (added the ts-side counterpart to the pre-existing
  pge-side one) and adds new assertions naming `errors` explicitly: absent (by key, not merely
  `undefined`) on the ts side, defined and non-empty on the pge side, with its `nodeId`/
  `errorClass` checked. The sc-5-4 stripped-`version` control is kept (not deleted) and its
  comment updated to record that it is now historical — superseded by the unstripped real-run
  assertion, retained as a synthetic proof the strip transform sprint 5 relied on behaved
  correctly.
- `src/orchestrator/workflow/oracle-retention.test.ts` and `src/pge/topology/docs.test.ts` — both
  pass unchanged; their scanners check for literal substrings (`contracts`, `pipelineResult`,
  etc.) which the rewritten prose still contains, and the `equivalent: false` regex, which still
  holds.
- `src/contracts/sprint-contract.ts`, `src/pge/nodes/sprint-review.ts` — doc-comment-only
  updates (no production logic changed) recording the closure and naming the imperative writer;
  both files' existing tests (`sprint-contract.test.ts`'s anti-default suite,
  `sprint-evaluate.test.ts`'s PGE-side `version` tests) stay green unchanged, confirming neither
  file's runtime behaviour moved.

## Golden recapture

None needed. `GOLDEN_PASS_THRESHOLD=80 node scripts/run-golden-regression.mjs` — **7/7 (100%)**,
with `git status --porcelain .bober/golden/` empty both before and after the golden gate ran,
proving rather than assuming that no case moved. This matches the sprint briefing's prediction:
`src/pge/golden/executor.ts` constructs a `PgeEngine` alone for every replay case — this sprint
changed only the imperative engine, so a graph-only replay cannot observe the change.

## Files touched

- `src/orchestrator/pipeline.ts` — `settledAttempts` counter; `version` written at all four
  settle sites; a comment at the out-of-loop return explaining why it stays version-less there.
- `src/orchestrator/pipeline.test.ts` — new `describe` (above).
- `src/orchestrator/workflow/conformance.engines.test.ts` — pin flip, `committedPin` move, the
  `contracts`/`pipelineResult` real-run sections rewritten, prose closure record rewritten.
- `src/contracts/sprint-contract.ts` — doc comment addition naming both writers.
- `src/pge/nodes/sprint-review.ts` — doc comment updated from "deliberately unclosed... sprint
  6's business" to a closure record.
- `docs/pge-graph.md` — a new "`version` CLOSED at sprint 6" bullet; the `pipelineResult` bullet
  rewritten in place (not deleted) to record the container-portion closure AND the `errors`
  finding; the "The evidence" summary bullet and the oracle-retention enforcement paragraph
  updated from three pinned fields to two.
- **This record** (`docs/sprints/sprint-spec-20260814-pge-full-convergence-6.md`) — written in
  `1fd29e9`, then corrected post-evaluation to record the amended disposition rather than the
  generator's self-report.

A **separate, docs-only follow-up commit** (no source, test or config file touched) carried the
amended disposition into the documents the sprint made stale: `docs/pge-graph.md`'s "The
evidence" bullet, its `pipelineResult` bullet, flip-prerequisite points 1 and 4 and the 1.5.0
changelog entry; `docs/sprints/README.md`'s spec intro, this sprint's table row and the two
prior-spec closing paragraphs that still described `pipelineResult` as a container closing as a
consequence; and the point-in-time notes in the sprint-4, sprint-5 and
`spec-20260812-terminal-vocabulary` sprint-6 records.

## Notes for maintainers

- **`sc-6-3` passed under an AMENDED DISPOSITION, and the amendment is the finding.** The
  generator filed it NOT MET; the evaluator adjudicated a pass because the CONTRACT's premise
  ("closing `contracts` closes `pipelineResult`") was factually incomplete, and the gap the
  sprint surfaced is real, pre-existing and architectural. `contracts` closed as designed;
  `pipelineResult` remains for `errors` alone. See "The amended disposition" above — do not cite
  this sprint as "one criterion failed", and do not cite it as "everything converged" either.
- **The divergence set is `['audits', 'pipelineResult']`, and BOTH are architectural.** They
  share one root cause — the graph has a checkpoint-gated commit the imperative engine lacks —
  so no further building closes either one. Joining `pipelineResult.errors` to `audits`'
  ADR-backed acceptance is RECOMMENDED by both the generator and the evaluator and is
  **undecided**; the decision belongs to sprint 11, whose `sc-11-1` (`equivalent: true`) cannot
  be met as written.
- **`VOLATILE_KEYS` is unchanged** — still the same ten keys
  (`createdAt`, `updatedAt`, `startedAt`, `completedAt`, `timestamp`, `duration`, `runId`,
  `totalCost`, `durationMs`, `approverId`). Neither `version` nor `errors` was added to it
  (sc-6-4, and the same principle applied to the new finding).
- **The schema's `version` field is untouched** — still `.optional()`, never `.default(...)`
  (nonGoal 1). `SprintContractSchema`'s own doc comment now names both writers.
- Final gate, re-run on a clean detached worktree: **467 files**, typecheck (both tsconfigs),
  lint (0 errors, 2 pre-existing warnings in `eval-persist.test.ts`) and build green; golden gate
  **7/7 (100%)**, dataset unchanged; `pge validate` and `pge docs --check` (44 nodes) both `ok`,
  `pge diff` against the pre-sprint topology artifact empty. The two runs of the suite agree on
  the total (**7106**) and on **0 failed**, but split it differently: the generator recorded
  7104 passed / 2 skipped, the evaluator's fresh `git worktree --detach` + `npm ci` at `1fd29e9`
  recorded **7100 passed / 6 skipped**. Four tests skipped in one environment and ran in the
  other; neither run reports a failure, and the difference is unexplained here rather than
  explained away. **ANSWERED at sprint 7** — the four are
  `tests/graph/mcp-client.test.ts:783,805,832,866`, the `TokensaveMcpClient` integration tests
  gated by `it.skipIf(!tokensaveIntegrationRunnable)`; the gate requires an indexed
  `.tokensave/` project in `process.cwd()`, which is gitignored (`.gitignore:40`) and so absent
  from every fresh worktree. A self-documenting gate that hides no failure — see
  [sprint 7's record](./sprint-spec-20260814-pge-full-convergence-7.md#the-suite-count-question-sprint-6-left-open-is-answered).
