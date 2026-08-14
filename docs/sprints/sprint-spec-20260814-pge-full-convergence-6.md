# The version delta closes — `contracts` converges; `pipelineResult` narrows to a new, independent finding

**Contract:** sprint-spec-20260814-pge-full-convergence-6  ·  **Spec:** spec-20260814-pge-full-convergence  ·  **Completed:** 2026-08-14

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

**Result: sc-6-3 is NOT fully met.** The divergence set after this sprint is `["audits",
"pipelineResult"]`, verified by running the harness — `contracts` is gone (sc-6-1's claim), but
`pipelineResult` stays, now for `errors` alone rather than for the reason the contract assumed.
This is recorded as a finding for a future sprint, not silently absorbed into this one's scope:
closing it means either giving the imperative engine an equivalent checkpoint-gated commit step
(a real behaviour change) or formally joining `audits` as a permanently-accepted divergence — a
decision, not a default.

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
- **This record** (`docs/sprints/sprint-spec-20260814-pge-full-convergence-6.md`).

## Notes for maintainers

- **sc-6-3 is the one required criterion NOT fully met.** `contracts` closed as designed;
  `pipelineResult` did not, for a reason (`errors`) outside this sprint's anticipated scope and
  outside its nonGoals/estimatedFiles. See "The discovery" above for the full account and the
  two closure paths a future sprint would choose between.
- **`VOLATILE_KEYS` is unchanged** — still the same ten keys
  (`createdAt`, `updatedAt`, `startedAt`, `completedAt`, `timestamp`, `duration`, `runId`,
  `totalCost`, `durationMs`, `approverId`). Neither `version` nor `errors` was added to it
  (sc-6-4, and the same principle applied to the new finding).
- **The schema's `version` field is untouched** — still `.optional()`, never `.default(...)`
  (nonGoal 1). `SprintContractSchema`'s own doc comment now names both writers.
- Final gate, re-run on a clean detached worktree: suite **467 files / 7104 passed, 2 skipped, 0
  failed**; typecheck (both tsconfigs), lint (0 errors, 2 pre-existing warnings in
  `eval-persist.test.ts`) and build green; golden gate **7/7 (100%)**, dataset unchanged.
