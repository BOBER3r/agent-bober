# `history` converges — the missing phase events

**Contract:** sprint-spec-20260814-pge-full-convergence-4  ·  **Spec:** spec-20260814-pge-full-convergence  ·  **Completed:** 2026-08-14

## What this sprint added

A graph run wrote exactly ONE history line, `pipeline-complete`, from the shared
`finalizePipelineRun`. The imperative engine writes TEN: nine phase events inline in
`runTsPipeline` (`pipeline-start` … `sprint-docs-complete`) plus the same shared terminal line.
`grep -rn "appendHistory\|history.jsonl" src/pge --include="*.ts"` (non-test) returned ZERO
hits — a MISSING WRITER, not a missing place for one, since the topology already declared two
`role: "curator"` nodes.

This sprint gives the graph engine that writer and wires it into nine node bodies, at the
node's real lifecycle boundary. A real run of both engines now produces the IDENTICAL ordered
event list, and `history` leaves the conformance harness's divergence set: three fields remain
(`audits`, `contracts`, `pipelineResult`), down from four.

## Sc-4-1: the mapping, recorded before any node was touched

`src/pge/runtime/history.ts` and its test landed in the FIRST commit of this sprint
(`072f814`), before any node body was edited. `HISTORY_EVENT_NODE_MAP` enumerates all ten
events in the imperative engine's own order, each row naming the imperative call site, the
graph node that should emit it (or `null` for the one that already has a shared writer), and
which end of that node's execution. `history.test.ts` checks the table two ways: every
node-emitted event's exact `event: "..."` literal still occurs in the real source of
`pipeline.ts`, and every non-null `graphNodeId` is a real node id in the committed topology —
both re-derived from disk on every run, not trusted as a comment. The order claim itself is
verified by a REAL run of both engines, in `conformance.engines.test.ts`'s "records WHAT each
divergence IS" test (unmodified by this sprint's first commit, already exercising exactly this
scenario for the ts side).

**No event in the ten had to be left unmapped.** The sprint contract's stop condition
pre-authorised recording an event with no honest graph-side emitter rather than inventing a
node for it — the case did not arise. The two research-phase events pitfall 1 of the sprint
briefing warned against (`research-started`/`research-completed`) are correctly absent from
BOTH engines' lists under `conformanceConfig()` (`researchPhase: false`), so mapping them onto
`research_reflect`/`research_collect` would have ADDED a divergence rather than closing one —
they were not mapped.

## The nine emitters, and the two decisions worth reading twice

`src/pge/runtime/history.ts` exports `emitPhaseEvent`, a thin wrapper delegating to the
EXISTING `appendHistory` (`src/state/history.ts:81`) — sc-4-4's requirement: no parallel
writer, no parallel file, no `historyEvents` channel a reader would have to merge with
`history.jsonl`. Three seams were possible (documented in the module's own header); this one
was chosen because it is the only one that can emit a "start" event before the node's effect
runs without either fail-closing an `effects: []` node through the effect registry or
recording the event a superstep late, at the commit boundary, which would misrepresent WHEN
something happened while still matching the event NAME list.

| node | events | boundary |
| --- | --- | --- |
| `research_body` | `pipeline-start` | entry |
| `plan_materialize` | `planning-complete` | after persisting |
| `sprint_curate_explain` | `curator-start` / `curator-complete` | before/after `curator.brief` |
| `sprint_generate` | `generator-start` | entry |
| `sprint_evaluate` | `evaluator-start` / `sprint-passed` | entry / passing return |
| `sprint_review` | `code-review-complete` | after `reviewer.sprint` |
| `documenter` | `sprint-docs-complete` | after `documenter.summary` |

**Decision 1 — the cache-hit curator.** `sprint_curate_explain` reads `ctx.cache` before
calling `EFFECTS.curatorBrief`. On a cache HIT there is no `SprintBriefing` to read
`filesAnalyzed`/`patternsFound`/`utilsIdentified` from, so `curator-complete` is emitted ONLY
on the miss path — never with stale or fabricated counts. `curator-start` still fires
unconditionally at handler entry either way, matching `pipeline.ts:260`'s unconditional write
before `runCurator`.

**Decision 2 — `iteration` needed a THIRD derivation, not the one the briefing proposed.** The
sprint briefing's own Pattern E recommended `sprint-evaluate.ts`'s `iterationOf` (a count of
`evaluations` entries) for both `generator-start` and `evaluator-start`. Tried against a real
`GOLDEN_CAPTURE=1` run, it produced `generator-start: {iteration: 1}` immediately followed by
`evaluator-start: {iteration: 2}` for the SAME round — the imperative engine's single `for`-loop
variable never does that. The cause: `sprint_security` unconditionally records its own verdict
(`skipped` or `fail`) immediately before `sprint_evaluate` runs, on `sprint_evaluate`'s ONLY
inbound edge, so `iterationOf` reads one higher there than `sprint_generate` read moments
earlier. The obvious fix — read the shared `sprintIterations` loop counter instead — was tried
next and ALSO produced a wrong number, for a different reason: `sprint_route` and
`sprint_correct` each declare that counter independently, so a retry that flows through
`sprint_route` (`sprint_evaluate -> gate_anchor_regression -> sprint_route --retry-->
sprint_correct`) spends TWO units of it, while a retry that reaches `sprint_correct` directly
through a gate's `onFail` spends only ONE — a capture of the one multi-round case in the golden
set (`replay-full-run-evaluation-fails`) showed the counter-derived number jump from 1 straight
to 3, skipping 2. `src/pge/nodes/gates.ts`'s new `generateAttemptsSoFar` sidesteps both: it
counts `sprint_generate`'s own committed `messages` entries for the branch, which advances by
exactly one every time a round's generation attempt actually completes, regardless of which of
the three routes a prior round's failure took. `sprint_generate` reads it as `+ 1` (before its
own attempt is recorded); `sprint_evaluate` reads it with no offset (after that attempt commits).
Both derivations are documented at length in `generateAttemptsSoFar`'s own doc comment, because
the wrong answer looked plausible enough to ship twice before the golden capture caught it.

## Sc-4-2/sc-4-3: the conformance pin

`conformance.engines.test.ts`'s divergence-set pin (`:377-381`) drops `"history"`, leaving
`["audits", "contracts", "pipelineResult"]`; `report.equivalent` stays `false`. The ordered-list
assertion ("1. history") keeps the ts list as a literal — it is the imperative engine's own
emission order and this sprint did not touch it — and asserts the pge list against the ts
list's OWN answer, the same idiom the file already uses for "3. contracts" and sc-13-3, so the
claim pinned is the CONVERGENCE, not a second copy of a literal that could drift out of sync by
hand. A new pure-function test proves the pin fails in both directions (sc-4-3): a synthetic
diff list gaining `"history"` back fails the committed pin, and one silently losing a real field
(`"contracts"`) fails it too — in the `golden/coverage.test.ts:311-354` idiom, over synthetic
input rather than hostage to today's dataset.

## Sc-4-5: the golden recapture

`GOLDEN_CAPTURE=1 npx vitest run src/pge/golden/capture.test.ts`, then every hunk read. All
seven replay cases gain the new lines under `expected.artifacts.history`; no other conformance
field moved in any case.

- FIVE cases gain the full nine-plus-terminal sequence, `iteration: 1` throughout (the
  single-pass scenarios). Six of the seven gain nine node events each — the sixth is the
  multi-round case below, whose nine are a different mix — for 6 × 9 + 1 = **55** new
  entries across the dataset.
- `replay-plan-clarify-rounds-exhausted` gains only `pipeline-start` — the scenario never
  reaches `plan_materialize`, so `planning-complete` correctly never fires, matching what the
  imperative engine would do for the identical clarify-never-settles scenario. It is also the
  one case whose `history` was `[]` before this sprint rather than the one shared
  `pipeline-complete` line: that run never reaches `finalize` either, so its array is ONE
  entry with no terminal line at all.
- `replay-full-run-evaluation-fails` — `evaluationPasses: false`, the one multi-round case —
  gains two full `generator-start`/`evaluator-start` pairs at `iteration: 1` and `iteration: 2`
  (the fix described above, verified against real output rather than reasoned about in the
  abstract), then a NINTH entry: a second `curator-start` with no matching `curator-complete`,
  immediately before the terminal `pipeline-complete`. This is the interpreter's own
  checkpoint-resume behaviour after `sprint_route`'s `LoopExhausted` — `sprint_curate_explain`
  is genuinely re-entered, and on that re-entry the `ctx.cache` (`scope: "run"`) is a HIT, so
  `curator-complete` correctly does not fire (Decision 1 above). This is pre-existing engine
  behaviour, invisible before this sprint because there was no history writer to show it — not
  a defect this sprint introduced, and not something sc-4-x asks this sprint to change.

Golden gate: **7/7 (100%)**.

## Files touched outside `src/pge/nodes/` and `.bober/golden/`

- **`src/contracts/status-vocabulary.invariant.test.ts`** — three `ALLOWLIST` entries
  (`sprint-curate.ts`, `sprint-generate.ts`, `documenter.ts`) had their pinned `:line` shift by
  the doc comments the new emitters were inserted above; updated to the new lines with the
  shift recorded in each reason string.
- **`docs/pge-graph.md`** — the "Engine migration disposition" section's evidence bullet drops
  to three divergent fields; the point-1 paragraph (previously "`history` is OPEN WORK, not
  permanently accepted") now records the closure — the nine node writers, the `emitPhaseEvent`
  module, and the `iteration` derivation defect and its fix — while leaving the `audits`
  sub-paragraph byte-identical, per its own note that the closure does not touch ADR-6/ADR-1
  grounds. The flip-bar's "unsatisfiable by design" paragraph drops `history` from the unbuilt
  list.
- **`src/pge/topology/docs.test.ts`** — the zero-writer scan inverts to its OWN stated
  retirement condition: `findAppendHistoryCallers` now asserts EXACTLY ONE caller,
  `src/pge/runtime/history.ts` (the nine node bodies reach `appendHistory` through
  `emitPhaseEvent`, so none of them match the literal-substring scan), with a new negative
  control proving a node body calling `emitPhaseEvent` is NOT flagged. `assertDispositionCitesEvidence`'s
  and `assertFlipPrerequisitesStated`'s history assertions move from "OPEN WORK, not
  permanently accepted" to "CLOSED at sprint 4", naming the writer module; their gutting
  controls move with them.

## Notes for maintainers

- **The briefing's proposed `iteration` derivation was wrong, and the golden capture is what
  caught it.** `iterationOf` looked correct in isolation (it is the graph's existing "iteration"
  concept, already used by `sprint_review`) and would have passed every test that does not
  actually run the sandwiched `sprint_security` node. Trust the real capture over the abstract
  argument when the two disagree.
- **The five hand-authored `enforcement: "integrity"` golden cases that also pin a one-entry
  `history` block** (`commit-approved-writes-commit-object`, `finalize-reports-failed-run`,
  `finalize-writes-marker-before-history-line`, `full-run-research-to-commit`,
  `progress-document-is-rewritten-not-appended`) are **not executed** by the gate
  (`case-schema.ts:95-102`), so they did not fail and were left byte-unchanged. Their pinned
  `history` array now understates what a real run would produce — the same judgement call
  `spec-20260812-pge-real-workload-errors` sprint 5 recorded for two different integrity cases
  in this same dataset. Re-authoring them needs judgement about what a real run of each specific
  scenario would emit, not a recapture; left for a sprint that owns hand-authored fixtures.
- **`iterationOf` itself is unchanged** — still exactly what `sprint_review`'s advisory verdict
  and every `sprintVerdict()` call use. This sprint added a SECOND, narrower derivation for one
  new purpose; it did not touch the first one's existing callers or their golden artifacts.
- Passed **iteration 1**, all 6 of 6 required criteria, every gate re-run against a clean
  detached worktree of `bf5b447`: suite **467 files / 7087 passed, 6 skipped, 0 failed**;
  typecheck (both tsconfigs), lint (0 errors, 2 pre-existing warnings) and build green; golden
  gate **7/7 (100%)**; `pge validate --mode full` and `pge docs --check` both `ok` (44 nodes);
  `pge diff` against the pre-sprint topology artifact is empty (no schema change this sprint).
  Commits `072f814`, `f74e9b3`, `f22de6a`, `39a2cbe`, `bf5b447`.
