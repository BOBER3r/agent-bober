# PGE writes `evaluatorFeedback` and `generatorNotes`

**Contract:** sprint-spec-20260814-pge-full-convergence-5  ·  **Spec:** spec-20260814-pge-full-convergence  ·  **Completed:** 2026-08-14

## What this sprint added

Two of the three `contracts` field deltas existed because no PGE node wrote either field at
all: `evaluatorFeedback`/`generatorNotes` were `undefined` on every settled PGE contract, while
`runSprintCycle` writes both (`pipeline.ts:592`/`:719` and `:428`). This sprint gives the graph
engine writers for both, sourced from the same place the imperative engine reads them, so the
two engines cannot drift by construction. The divergence set does not shrink — `contracts` and
`pipelineResult` were already pinned before this sprint and stay pinned after it — but the
*content* of that pin narrows from three field deltas to ONE (`version`), which is what sprint
6 is scoped to close.

## The trap the sprint contract's own generatorNotes named, and why it mattered

`sprint_evaluate` already carries a `summary` local for the `evaluations` channel, but it is
DECORATED: `` `${result.summary} [${decision.reason}]` `` on the normal path,
`encodeAnchorRegression(...)` on an anchor trade. Writing
`evaluatorFeedback = branchOutcome(...).summary` (the obvious reading of "carry the verdict's
summary onto the settled contract") compiles, is non-empty, and is WRONG: it would produce
`"all criteria met [low-risk-and-passing]"` where the imperative engine writes
`"all criteria met"` verbatim. sc-5-1 requires the values MATCH, not merely be present, and the
decoration is not reversible by stripping a trailing `[...]` — the same field carries the
anchor-regression encoding or a sandbox critique on other paths. Sprint 4 had already hit an
identical decorated-vs-raw fork for `sprint-passed`'s `feedback` detail (the `if (passed)`
history emission, `sprint-evaluate.ts:402-414` after this sprint's insertions shifted it down)
and resolved it by carrying the RAW value separately, with a
comment citing the imperative line number; this sprint follows the same pattern for a second
field, `evaluatorFeedback`, and adds a third, `generatorNotes`.

## The carrier: an optional pair on `SprintVerdict`, not a new channel

`sprint_evaluate` declares `writes: ["evaluations", ...]`; `sprint_exit` declares
`reads: ["evaluations"]` alone. That pair of facts is exactly enough to route both raw values
without touching the topology: `SprintVerdictSchema` (`src/pge/state/overall.ts`) gained two
OPTIONAL fields, `evaluatorFeedback` and `generatorNotes`, and `sprintVerdict()`
(`src/pge/nodes/sprint-evaluate.ts`) accepts them as optional constructor arguments. No channel
was added, no `graphVersion` bump, no golden re-capture for a topology change — `pge diff`
against the pre-sprint artifact is empty.

This design was checked against two prior findings in the tree rather than invented fresh:

- **`sprint-correct.ts`'s "a node body may only touch its declared channels" note.** There is
  no runtime enforcement of a node's declared `writes` — writing an undeclared channel would
  WORK — but the artifact's channel writers are DERIVED from `nodes[].writes`
  (`topology/audit.ts`), so writing one anyway would silently contradict the artifact. Routing
  through the existing `evaluations` channel (`sprint_evaluate` writes it, `sprint_exit` reads
  it — both already declared) keeps every node inside its own declaration.
- **`anchors.ts`'s rejection of widening `SprintVerdictSchema` for the broken-anchor list**, on
  the ground that fact is LOCAL to one edge (`sprint_evaluate -> gate_anchor_regression`) and a
  channel would be disproportionate for it. This sprint's fact is not local to one edge — it
  has to survive the whole retry loop back to `sprint_exit` — which is exactly the shape a
  channel exists for, and `evaluations` already is that channel. An OPTIONAL field on an
  EXISTING schema adds no channel and does not move the sixteen-key state budget, so the
  anchors note's proportionality objection does not apply here; `overall.ts`'s new doc comment
  says so explicitly rather than leaving a future reader to reconcile the two on their own.

## Where the raw values are populated, and where they are deliberately left absent

Only `sprint_evaluate`'s FINAL pass/fail verdict block (the one built from a genuinely-completed
`EvaluationRunResult`, after the security gate, the agent evaluation, selective verification and
the anchor-regression check have all run) attaches `evaluatorFeedback: result.summary` and
`generatorNotes: generated?.notes`. Because that block's `goto` is unconditional — pass and fail
both continue to `gate_anchor_regression` rather than branching early — this single call site
covers BOTH of `pipeline.ts`'s raw writes (`:592` pass, `:719` fail), which use the identical
`evaluation.summary` expression on both branches.

Two failure modes have no graph analogue and are deliberately NOT synthesised, per the
contract's stop condition:

- `pipeline.ts:418-421`'s literal `"Generator failed to complete the implementation."`, written
  only at `maxIterations` on the imperative side. `sprint_generate` does not branch on
  `result.success` in the graph, so there is nothing to carry.
- `pipeline.ts:520-525`'s rendered security-gate feedback. The graph's security block routes to
  `sprint_correct`, not to a settle, so the fields it would populate never reach `sprint_exit`
  through a decisive verdict either.

A refusal (`gate_sprint_in`'s admission check, or the curate region's own short-circuit) reaches
`sprint_exit` with no evaluation ever having run; `sprint_exit`'s `branchOutcome` returns no raw
values for it, and `sprint-review.ts` strips any stale copy off the SEEDED contract before
conditionally re-adding the producing node's value (see next section) — so the settled contract
carries neither field, genuinely absent, rather than a placeholder.

## sc-5-3: written from the owning node, not echoed from the seed

`sprint_exit`'s settle site now destructures `evaluatorFeedback`/`generatorNotes` OFF the seeded
contract before spreading it, then conditionally re-adds them from `branchOutcome`'s decisive
verdict (`sprint-review.ts:276-279`, with the claim spelled out at `:267-275`). This means a
stale seed (however it got there) can never survive by omission — the field is either the
producing node's own value, or genuinely absent.

**The proof took two iterations, and the reason is worth keeping.** Iteration 1 shipped a
"negative control" that seeded `"SEEDED — must not survive"` into both fields, ran a PASSING
branch, and asserted the stub's real values came out instead. It passes on the shipped code —
and it also passes on the mutant. The evaluator deleted the destructure at `:276-278` and
changed `...contractWithoutFeedback` back to `...contract` at `:279`, and **all 32 tests in
`sprint-evaluate.test.ts` still passed**, that control among them. The reason is object-spread
semantics, not a weak assertion: on a passing branch `outcome.evaluatorFeedback` and
`outcome.generatorNotes` are always defined, so the later key wins over the seed whether or not
the seed was ever stripped. The test looked like a proof of the strip and was actually a proof
of last-key-wins. sc-5-3 failed on that ground (a `definitionOfDone` violation too — the doc
comment at `:267-275` asserted something no test could falsify).

Iteration 2 changed **no production code** (`23a1718` touches only `sprint-evaluate.test.ts`)
and replaced the control with one that discriminates: seed the same stale pair, but route the
branch through `underDeliveringExplain(1)` so the curate region's admission check refuses
before `sprint_generate` — let alone `sprint_evaluate` — ever runs. `outcome` then carries
NEITHER raw value, both conditional spreads contribute `{}`, and the strip is the only thing
standing between the seeded string and `settled`. The test asserts `"evaluatorFeedback" in
entry === false` (absence, not merely difference) on every write. Under the same mutation it is
the ONE failing test out of 33; reverted, 33/33 pass. The iteration-1 test was kept but
**renamed** to what it actually proves (the passing-branch sc-5-1/sc-5-2 claim) and carries a
comment stating outright that it cannot detect the strip's removal.

The generalisable lesson: a negative control that seeds a value only discriminates if the code
path under test has nothing else that would overwrite that value. Route through the path where
the overwrite is absent, or the control is decorative.

## KNOWN ISSUE (pre-existing, unfixed): `sprint_exit` is entered twice on a multi-round branch

This sprint's new fields made it visible; they did not create it, and this sprint deliberately
did not fix it (out of scope). **A future sprint looking for it should start here.**

`sprint_route` and `sprint_correct` share the `sprintIterations` loop counter and both declare
`onExhausted: "sprint_exit"`. On the one multi-round golden case
(`replay-full-run-evaluation-fails`), `sprint_exit`'s handler is entered TWICE — verified,
before touching any sprint-5 code, by stashing this sprint's changes and re-running the
identical scenario: `written.length` was already 2. The second entry re-derives the same
settled contract from the same channel state, so every write agrees; the node-level tests below
assert on every write rather than a literal count of 1, to stay correct under this shape without
either fixing it (out of scope) or hiding it. The golden capture for this case shows the same
shape: `sprint_curate_mocks` is also re-entered (its pinned request now embeds the already-
settled contract, `version: 2`), which was already true of the committed dataset — 19
`pinnedResponses` entries before this sprint and 19 after, only the CONTENT of the contract
objects inside three of them changed.

**Why it is harmless today, and what would make it stop being harmless:** every write agrees in
content, because the second entry re-derives the settled contract from the same channel state as
the first. If a future change ever makes the two entries disagree — a non-idempotent write at
the settle site, or a field derived from something that moves between the two entries — the
last writer silently wins and nothing in the suite would notice. The two loop declarations are
`coding.graph.ts:709,730`.

## Testing

- `src/pge/state/overall.test.ts` — unaffected; the `SprintVerdictSchema` round-trip test still
  holds with the two new fields absent from its input.
- `src/pge/nodes/sprint-evaluate.test.ts` — **five** new tests: the raw pair on a passing branch;
  the same claim against a DISAGREEING seed (renamed in iteration 2 — it is an sc-5-1/sc-5-2
  test, not the sc-5-3 proof it was first labelled); the sc-5-3 discriminating test (stale seed
  + refusal path, the only one in the file that fails when the strip is deleted); the raw pair
  surviving a multi-round failing branch to loop exhaustion; and a refusal settling with neither
  field present. All pre-existing tests in the file (including the two anchor-regression
  `summary` assertions) stay green unchanged.
- `src/orchestrator/workflow/conformance.engines.test.ts` — the four literal
  `toBeUndefined()`/`toBeDefined()` assertions at the old gap flip to Pattern D (asserted
  against the OTHER engine's own answer). A new sc-5-4 assertion compares the two contracts'
  `canonical` bytes with `version` stripped from both sides, plus a pure-function
  both-directions control over synthetic input (the `coverage.test.ts:311-354` idiom) proving
  the stripping neither hides a real divergence nor fails to hide `version` itself. The
  three-field divergence-set pin (`["audits", "contracts", "pipelineResult"]`) is UNCHANGED —
  the array is the same; only the prose above it, and the field-content assertions inside the
  "records WHAT each divergence IS" test, narrowed.
- `src/pge/topology/docs.test.ts` — a new scanner (mirroring sprint 4's `history` one) proves
  `evaluatorFeedback`/`generatorNotes` now have real writers in `src/pge/state/overall.ts`,
  `src/pge/nodes/sprint-evaluate.ts` and `src/pge/nodes/sprint-review.ts`, and that the doc
  states the closure — re-derived from source on every run, not trusted as a comment.

## Golden recapture

`GOLDEN_CAPTURE=1 npx vitest run src/pge/golden/capture.test.ts`, every hunk read. SIX of the
seven replay cases move — four hunks each, across three kinds of location
(`expected.artifacts.contracts[0]`,
`expected.artifacts.pipelineResult[0].completedSprints[0]`/`.failedSprints[0]`, and the
`pinnedResponses` entries whose request embeds the settled contract — `sprint.exit` and
`documenter.summary`, never `reviewer.sprint`, which runs BEFORE the settle node). The seventh,
`replay-plan-clarify-rounds-exhausted`, correctly does NOT move — its pinned responses are
`research.*`/`planner.draft`/`run.gracefulFailure` only, and the sprint region never runs on
that fixture. `replay-full-run-evaluation-fails` (the multi-round case) gains an EXTRA hunk
versus the other five, for the pre-existing double-entry behaviour described above — five
hunks instead of four, all additive, no entry count change: its three changed
`pinnedResponses` entries are `sprint_exit`/`sprint.exit` **twice** and
`sprint_curate_mocks`/`curator.mocks` once, 19 entries before and 19 after. Re-running the capture WITHOUT the
flag afterward reproduces an identical (empty) diff — byte-stable. Golden gate: **7/7 (100%)**.

## Files touched outside `src/pge/nodes/`, `src/pge/state/` and `.bober/golden/`

- **`docs/pge-graph.md`** — a new bullet in "Engine migration disposition" records the closure
  and its exact expressions; the `pipelineResult` bullet immediately after it updates its
  "differ on three fields" claim to "differ on ONE field (`version`)"; the flip-bar's
  "unsatisfiable by design" paragraph updates its `contracts`/`pipelineResult` prerequisite from
  "unbuilt, need a writer" to "narrowed to `version` alone". The superseded historical
  paragraphs (the `spec-20260812-terminal-vocabulary` sprint-1/sprint-5 record) are left
  byte-identical, with one added sentence pointing forward to the new bullet, per the same
  discipline sprint 4 used for `history`'s closure.
- **`docs/sprints/README.md`** — row 5 added, plus the `spec-20260812-terminal-vocabulary`
  preamble's "`evaluatorFeedback` and `generatorNotes` need a PGE-node writer" open item marked
  closed, in that document's existing parenthetical-update style.
- **This record** (`docs/sprints/sprint-spec-20260814-pge-full-convergence-5.md`).

## Notes for maintainers

- **`version` is sprint 6's business, not this one's** (nonGoal 1). Nothing in this sprint
  touches `sprint-review.ts`'s `version: attempts` write or `versionRank`.
- **`sprint_security`'s own verdict was deliberately left unpopulated.** Only
  `sprint_evaluate`'s final block carries the raw pair; `sprint_security`'s blocked-verdict
  call site does not, matching the recommendation to keep this sprint's surface to the single
  call site that has a genuine `EvaluationRunResult` to read from.
- **The divergence SET did not shrink.** `["audits", "contracts", "pipelineResult"]` is the same
  three-element array before and after this sprint, and `report.equivalent` is still `false`.
  What narrowed is the field CONTENT inside two of those three entries: `contracts` from three
  deltas to one (`version`), and `pipelineResult` identically, because it is a container for
  `SprintContract`. Do not read this record as "a divergence closed".
- **FAILED iteration 1 on sc-5-3, passed iteration 2.** Iteration 1 (`b03463b`, `412d967`,
  `ff7f8e1`, `59226b8`, `080967b`) shipped the whole implementation and five of six criteria
  verified clean; sc-5-3's proof was inert under mutation (see the sc-5-3 section above).
  Iteration 2 (`23a1718`) is a **test-only** commit — zero lines of production code and zero
  golden bytes changed — replacing that control with a discriminating one and renaming the old
  one to what it actually proves.
- Final gate, every check re-run by the evaluator against a clean detached worktree at
  `23a1718`: suite **467 files / 7096 passed, 6 skipped, 0 failed**; typecheck (both tsconfigs),
  lint (0 errors, 2 pre-existing warnings) and build green; golden gate **7/7 (100%)**;
  `pge validate --mode full` and `pge docs --check` both `ok` (44 nodes); `pge diff` against the
  pre-sprint topology artifact is empty (no schema/topology change this sprint). Commits
  `b03463b`, `412d967`, `ff7f8e1`, `59226b8`, `080967b`, `23a1718`.
