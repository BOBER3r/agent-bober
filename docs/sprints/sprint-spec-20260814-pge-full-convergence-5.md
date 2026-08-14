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
identical decorated-vs-raw fork for `sprint-passed`'s `feedback` detail
(`sprint-evaluate.ts:379-392`) and resolved it by carrying the RAW value separately, with a
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
verdict. This means a stale seed (however it got there) can never survive by omission — the
field is either the producing node's own value, or genuinely absent. A node-level negative
control (`sprint-evaluate.test.ts`) seeds a contract with `generatorNotes: "SEEDED — must not
survive"` and `evaluatorFeedback` to match, and asserts the settled contract carries the
STUB's real values instead.

## A pre-existing engine characteristic this sprint's new fields made visible, not created

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

## Testing

- `src/pge/state/overall.test.ts` — unaffected; the `SprintVerdictSchema` round-trip test still
  holds with the two new fields absent from its input.
- `src/pge/nodes/sprint-evaluate.test.ts` — four new tests: the raw pair on a passing branch,
  the sc-5-3 negative control against a differing seed, the raw pair surviving a multi-round
  failing branch to loop exhaustion, and a refusal settling with neither field present. All
  pre-existing tests in the file (including the two anchor-regression `summary` assertions)
  stay green unchanged.
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
seven replay cases move, each in three places (`expected.artifacts.contracts[0]`,
`expected.artifacts.pipelineResult[0].completedSprints[0]`/`.failedSprints[0]`, and the
`pinnedResponses` entries whose request embeds the settled contract — `sprint.exit` and
`documenter.summary`, never `reviewer.sprint`, which runs BEFORE the settle node). The seventh,
`replay-plan-clarify-rounds-exhausted`, correctly does NOT move — its pinned responses are
`research.*`/`planner.draft`/`run.gracefulFailure` only, and the sprint region never runs on
that fixture. `replay-full-run-evaluation-fails` (the multi-round case) gains an EXTRA hunk
versus the other five, for the pre-existing double-entry behaviour described above — five
hunks instead of four, all additive, no entry count change. Re-running the capture WITHOUT the
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
- **`docs/sprints/README.md`** — row 5 added.

## Notes for maintainers

- **`version` is sprint 6's business, not this one's** (nonGoal 1). Nothing in this sprint
  touches `sprint-review.ts`'s `version: attempts` write or `versionRank`.
- **`sprint_security`'s own verdict was deliberately left unpopulated.** Only
  `sprint_evaluate`'s final block carries the raw pair; `sprint_security`'s blocked-verdict
  call site does not, matching the recommendation to keep this sprint's surface to the single
  call site that has a genuine `EvaluationRunResult` to read from.
- Passed **iteration 1**, all 6 of 6 required criteria, every gate re-run against a clean
  detached worktree: suite **467 files / 7099 passed, 2 skipped, 0 failed**; typecheck (both
  tsconfigs), lint (0 errors, 2 pre-existing warnings) and build green; golden gate **7/7
  (100%)**; `pge validate --mode full` and `pge docs --check` both `ok` (44 nodes); `pge diff`
  against the pre-sprint topology artifact is empty (no schema/topology change this sprint).
  Commits `b03463b`, `412d967`, `ff7f8e1`, `59226b8`.
