# The channel join becomes rank-aware, and pipelineResult converges

**Contract:** sprint-spec-20260812-terminal-vocabulary-4  ·  **Spec:** spec-20260812-terminal-vocabulary  ·  **Completed:** 2026-08-12

## What this sprint added

One line changed the resolution rule at `mergeEntries` (`src/pge/registry/reducers.ts:197`):
a duplicate `contractId` in the `appendById`-backed `sprintContracts` channel is now resolved
by `higherRanked` (`:412-414`, thin wrapper over the already-shipped `rankIsGreater`,
`:395-401`) instead of `joinByCanonicalOrder`. `versionRank` and `rankIsGreater` are reused
exactly as they shipped for THIS change — no new comparison logic was written for sc-4-1. The
settled contract `sprint_exit` writes now carries `version: attempts` (sprint 3) and outranks
the seeded copy, which carries no `version` at all, so a pge run's `sprintContracts` channel —
and everything downstream of it, including `PipelineResult.completedSprints` — holds the
settled contract instead of the planned one.

Two more things were needed to make that one line safe and complete, both scoped narrowly:

- **sc-4-3**, a second, INDEPENDENT defect in `lastWriteWinsByKey` (the `branchStatus`
  channel): canonical order compared `attempts` as a JSON STRING, so `"10"` sorted lexically
  BEFORE `"9"` and a branch's tenth settling attempt could lose a same-key conflict to its
  ninth. Fixed by widening `versionRank`'s first term (`:366-393`) to read `attempts`
  directly when `version` is absent, and switching `lastWriteWinsByKey.merge` (`:317`) to the
  same `higherRanked` resolver `appendById` now uses.
- **A security directive from sprint 3's audit**, closed in the same sprint that made it
  decision-bearing: `materializeContracts`' embedded branch
  (`src/orchestrator/contract-materialization.ts:76`) now strips a producer-supplied
  `version` on an embedded contract, alongside the four fields it already normalized there.

## Why sc-4-1 and sc-4-3 needed to be TWO separate changes, not one

`mergeEntries` (`appendById`) and `lastWriteWinsByKey` are different reducers with different
callers (`reducers.ts:16-18`: `mergeEntries` has exactly one caller, `appendById.merge`;
`lastWriteWinsByKey` calls `joinByCanonicalOrder` inline and never routed through
`mergeEntries`). Fixing the `sprintContracts` join does nothing for `branchStatus` —
`rankIsGreater(candidate, incumbent)` on two `BranchStatus` values (`{state, attempts}`, no
`version`, no `updatedAt`) fell straight through to `canonicalJson` before this sprint, same
as `joinByCanonicalOrder` did. Measured directly: `rankIsGreater({attempts:10}, {attempts:9})`
was `false`. The contract's own text asserting sc-4-1 alone fixed sc-4-3 was wrong, and the
sprint treated that as a finding to correct rather than a box to check — see
`src/pge/registry/reducers.test.ts`'s `sc-4-3` describe block, which pins `attempts: 10`
beating `attempts: 9` in both arrival orders, and fails if reverted.

**The chosen fix widens `versionRank`, not `lastWriteWinsByKey`.** Two other options existed
(give `BranchStatus` its own `version` field written by every branch-status writer; or compare
the two numeric fields inline inside `lastWriteWinsByKey` only) and were rejected: the first
touches writers `nonGoal 1` defers to a later sprint, the second duplicates comparison logic in
a second place. Widening `versionRank`'s FIRST term is one function, reused by both reducers
that now consult it, and is safe by construction: no OTHER value domain in the topology carries
a numeric `attempts` field (`LedgerEntry` uses `attempt`, singular; `SprintVerdict` uses
`iteration`) — verified by grep and pinned by the property suite, which now draws `attempts`
for `branchStatus` from a pool that crosses the two-digit boundary specifically to exercise
this.

## Order-invariance, proven rather than assumed (sc-4-4)

`rankIsGreater` compares the triple `(version, updatedAt, canonicalJson(value))`
lexicographically. Two values with equal `canonicalJson` necessarily have equal `version` and
`updatedAt` too (`versionRank` reads both off the SAME value), so the triple's tie set is
EXACTLY the `canonicalJson` equality class — the identical tie condition
`joinByCanonicalOrder` already had (`reducers.ts:127`-equivalent: `if (a === b) return left`).
On that tie, `mergeEntries`/`lastWriteWinsByKey` keep the incumbent — arrival-order-dependent
as an object reference, but canonically identical, so the merged CANONICAL result cannot
differ. Off the tie, the relation is a strict total order, so the join is a maximum over it —
associative, commutative, idempotent — by the same argument as the shipped
`joinByCanonicalOrder`.

`src/pge/registry/reducers.test.ts`'s `sc-4-4` describe block states this as an executable
claim rather than an assertion in a comment: every permutation of a rank-DECIDED batch
converges on one canonical result (`appendById` and `lastWriteWinsByKey` both), and — the case
most likely to hide a silent break — every permutation of a batch TIED on `version` AND
`updatedAt` also converges, exercising the `canonicalJson` fallback the tie case depends on.
The property suite's own generators (`sprintContractsValue`, `branchStatusValue`) were widened
to draw `version`/`updatedAt`/two-digit `attempts` from small pools, so ties happen constantly
across the existing 200-case-per-law suite rather than only in the three hand-picked cases
above.

## The security guard this sprint made decision-bearing

`SprintContractSchema.version` is bounded only by `.int().min(0)` — no upper bound
(`src/contracts/sprint-contract.ts:213`). Before this sprint that was inert: nothing read
`SprintContract.version`. The moment `mergeEntries` started consulting it, a producer-supplied
`version` on an EMBEDDED contract (an external/planner-authored spec's `spec.sprints`, the one
producer-supplied path `materializeContracts` has) became able to permanently outrank the
settled copy `sprint_exit` writes — inverting exactly the ordering this sprint exists to
provide, and unreachable from the shipped generator's own contracts (which never set
`version`) but reachable from any spec file on disk.

`materializeContracts`' embedded branch already normalizes four producer-supplied fields
(`status`, `specId`, `sprintNumber`, `contractId`) in the same few lines
(`contract-materialization.ts:60-65`). `delete contract.version;` (`:76`) is a fifth, in the
same block, same pattern. The alternative — making the JOIN itself settled-status-aware, so
only a contract passing `isSettledContractStatus` may win on `version` — was rejected: it is
not a total order (a settled-but-lower-version value and an unsettled-but-higher-version value
have no defined winner without folding the settled check INTO the rank triple, which is new
ranking logic sc-4-1 forbids), it would import a contract-domain concept into a reducer module
that has zero imports and merges four unrelated value domains, and it directly contradicts the
module header's own stated principle that a reducer may not know what domain its values come
from. Pinned by `src/orchestrator/contract-materialization.test.ts`'s new test: an embedded
contract carrying `version: 9999` is materialized — and persisted to disk — with `version`
absent, not merely lowered.

## pipelineResult: the seeded-copy defect closed, the divergence did not (sc-4-5)

The contract's literal text asserts sc-4-5's divergence is CLOSED. Measured by running
`src/orchestrator/workflow/conformance.engines.test.ts` against the two real engines: the
divergence SET is unchanged — still exactly `audits`, `contracts`, `history`, `pipelineResult`
— because `PipelineResult.completedSprints`/`failedSprints` carry whole `SprintContract`
objects. Once the channel converges on the settled copy, what a caller sees inside
`pipelineResult` is exactly what `listContracts` sees on disk: the SAME four field deltas the
`contracts` divergence is made of (`status`, `evaluatorFeedback`, `generatorNotes`, `version`),
none of them in `VOLATILE_KEYS`. `pipelineResult`'s divergence is not independently closable —
it is a container for the `contracts` divergence, and closes exactly when `contracts` does.

What DID close, and is asserted positively rather than merely dropped from a list:
`pgeResult?.completedSprints.map(c => c.status)` now reads `["completed"]`, not `["proposed"]`
— the sprint-12 limitation the docs used to describe by that name is gone — and
`pgeResult?.completedSprints[0]` now `toEqual`s the SAME contract object `listContracts` reads
back off disk, proving the two are the identical settled object rather than merely "not
proposed". The pin at `conformance.engines.test.ts`'s divergence-set array is UNCHANGED (still
`toEqual` over the same four-element sorted array, still failing in both directions: a fifth
field fails it, a fourth field closing fails it too), and its per-field prose was rewritten to
record what actually happened rather than the sprint-12 mechanism that no longer applies. The
edits to the pin's prose, the behavioural assertion, `docs/pge-graph.md`'s "Engine migration
disposition" (the "exactly four" paragraph's supporting bullets and the `mergeEntries`
citation that went false), and this sprint doc landed in one commit, per the discipline the
previous sprint established.

## Every claim, and the test that fails when it stops being true

| Claim | The test that pins it |
|---|---|
| `mergeEntries` resolves a duplicate id by rank, not canonical order — proven on a case where the two disagree | `src/pge/registry/reducers.test.ts`, `sc-4-1` describe block |
| The same-canonical-id conflict with neither side carrying `version`/`updatedAt` is UNCHANGED (the `messages`/`evaluations`/`refs` channels) | same file, `sc-4-1`'s second `it` |
| A settled `sprintContracts` entry outranks the seeded `"proposed"` one, in both arrival orders | same file, `sc-4-2` describe block |
| **Control:** with `version` absent from BOTH copies, the seeded copy wins instead | same file, `sc-4-2`'s control `it` |
| `attempts: 10` outranks `attempts: 9` through `lastWriteWinsByKey`, in both arrival orders, and generally across the two-digit boundary | same file, `sc-4-3` describe block |
| Every arrival order of a rank-DECIDED `appendById`/`lastWriteWinsByKey` batch converges on one canonical result | same file, `sc-4-4` describe block |
| Every arrival order of a batch TIED on `version` AND `updatedAt` still converges | same file, `sc-4-4`'s tie `it` |
| The property suite's 200-case-per-law generators now draw `version`/`updatedAt`/two-digit `attempts` | `sprintContractsValue`/`branchStatusValue` in the same file |
| An embedded contract's producer-supplied `version` is stripped before it reaches the channel — and stays stripped on disk | `src/orchestrator/contract-materialization.test.ts`'s security-directive test |
| The `sprintContracts` channel carries the SETTLED status end to end through `runSprint` | `src/pge/nodes/sprint-evaluate.test.ts` (flipped from the sprint-3 known-limitation pin) |
| `pgeResult.completedSprints[0].status` is `"completed"`, not `"proposed"` | `src/orchestrator/workflow/conformance.engines.test.ts`, "4. pipelineResult" |
| `pgeResult.completedSprints[0]` is IDENTICAL to the contract `listContracts` reads off disk | same file, the positive assertion added this sprint |
| The divergence set stays exactly `audits`/`contracts`/`history`/`pipelineResult`, both directions | same file, the pinned `toEqual` array (unchanged) |
| `status-vocabulary.invariant.test.ts`'s allowlist still matches every real offender by file:line after this sprint's comment edits shifted lines | same file's own self-check tests |

Suite **13,898 passed / 4 pre-existing skips** in the real tree (23 failures observed during
verification were entirely confined to a stray `.claude/worktrees/youthful-satoshi-563347/`
checkout vitest also picks up — its own uncommitted diff and its own eslint-boundary
environment, unrelated to this sprint; zero failures outside it). Typecheck (both tsconfigs),
lint (0 errors, 2 pre-existing warnings in an untouched file), build green; golden gate **6/6**.

## Golden re-capture: exactly the 5 of 6 cases predicted, one hunk shape

`GOLDEN_CAPTURE=1 npx vitest run src/pge/golden/capture.test.ts` moved 5 of the 6 `replay`
cases; `replay-plan-clarify-rounds-exhausted` was correctly untouched (it has no `sprint_exit`
pin — `plan_materialize` never runs on that path). Every moved case's `expected.artifacts`
changed in exactly the same two places, the same two keys:

| case | `contracts[0]` | `pipelineResult[0]` |
|---|---|---|
| `replay-full-run-evaluation-passes` | `status: proposed → completed`, `+ version: 1` | `completedSprints[0]`: same two |
| `replay-plan-clarification-round` | same | same |
| `replay-research-reflexions-exhausted` | same | same |
| `replay-research-second-reflexion` | same | same |
| `replay-full-run-evaluation-fails` | `status: proposed → failed`, `+ version: 2` | `failedSprints[0]`: same two (`completedSprints` stays `[]`) |
| `replay-plan-clarify-rounds-exhausted` | **no change** | **no change** |

`pinnedResponses` also moved, legitimately: any recorded effect request whose `contract` is
resolved from the channel AFTER `sprint_exit` now carries the settled copy (the
`documenter@None#0 documenter.summary` request in the four passing cases; the
`sprint_curate_mocks@…#1 curator.mocks` request in the failing one). Replay pin lookup is keyed
on `(nodeId, branchKey, callIndex)` and the REQUEST is never compared during replay
(`src/pge/runtime/replay.ts`), so a changed request cannot break a replay — confirmed by
`node scripts/run-golden-regression.mjs` reporting **6/6 passed**, and by
`npx vitest run src/pge/golden/` (dataset, coverage, gate, capture — all green, no case count
change, no case relabelled `integrity`).

## Cross-sprint consequence: `verdictFrom`'s live defect narrows, but does not close

**(Historical — the defect this section describes was CLOSED at sprint 7 of
`spec-20260814-pge-full-convergence`, which migrated the counter to `isSettledContractStatus`
and proved the downgrade paths reachable by execution. Read what follows as the state at
sprint 4; see [sprint 7's record](./sprint-spec-20260814-pge-full-convergence-7.md) for the
closure.)**

`src/pge/runtime/interpreter.ts:728` (`verdictFrom`) still counts `status === "passed"` over
`state.sprintContracts` — a word no PGE run writes — so the count is still zero for a graph
run, and every downstream verdict consequence still under-reports exactly as before. What
changed is WHY: before this sprint the channel had two independent problems (the wrong copy
AND the wrong word); after this sprint it has only the second. Migrating `verdictFrom`'s
literal alone would still not fix it, and doing so is still a writer-adjacent change this
sprint's `nonGoal 1` defers. `docs/pge-graph.md`'s "Engine migration disposition" section
records this narrowing explicitly rather than leaving the pre-sprint-4 explanation to go
silently stale.

## Notes for maintainers

- **`versionRank`/`rankIsGreater` did not move file position, but their line numbers did.**
  The widened `versionRank` grew from 12 to 28 lines documenting the `attempts` fallback;
  every citation of `reducers.ts:348-359`/`:361-367` found across the repo (six production
  files plus two docs) was updated to `:366-393`/`:395-401` in the same commit as the code
  that moved them, per the same discipline `status-vocabulary.invariant.test.ts`'s
  line-pinned allowlist already enforces for a different file.
- **`joinByCanonicalOrder` was not deleted.** It still backs `mergeLedger` (`LedgerEntry`
  carries neither `version` nor `updatedAt`, so switching it would be no-op churn on a channel
  this sprint does not touch) and is still the algebraic basis `rankIsGreater`'s fallback term
  falls through to on a tie.
- **`updatedAt` still cannot serve as a discriminator under the golden harness's fixed clock**
  (spec decision D4, restated from sprint 3) — this sprint's fixes rank on `version` and the
  widened `attempts` fallback, never on `updatedAt` alone.
- **A pre-existing wart, not introduced or fixed here:** a record-shaped container member that
  is `null` in one input and `undefined` in another canonicalizes identically, so the
  incumbent wins and the result depends on arrival order for that one member. True of the
  shipped join and the rank-aware one identically; unreachable in the topology (no writer
  emits `undefined` members); out of scope.
- Passed **iteration 1**, all 7 required criteria, each re-verified by execution rather than
  by trusting the sprint's own tests (rank-aware join and canonical-order collapse both
  measured directly for the "narrow blast radius" claim; the divergence-set pin diffed and
  read hunk by hunk before committing; the golden diff read against the prediction before
  capture). Commits `20220a7` (the rank-aware join + its property/unit tests), `a1b7178`
  (security guard + test), `949661d` (KNOWN LIMITATION flip + prose + allowlist), `5da9940`
  (stale line-citation fixes collateral to the reducers.ts shift), the commit containing this
  doc (conformance pin + `docs/pge-graph.md` disposition), and a final golden re-capture
  commit.

