# The convergence record, and what a flip would still need

**Contract:** sprint-spec-20260812-terminal-vocabulary-6  ·  **Spec:** spec-20260812-terminal-vocabulary  ·  **Completed:** 2026-08-12

## Erratum (2026-08-14, `spec-20260814-pge-full-convergence` targeted correction)

This record's own claim, below, that `history` has **"no curator node to emit a
start/complete pair from"** is **FALSE, and was already false when this sprint closed**: the
topology declared two `role: "curator"` nodes at that time — `sprint_curate_explain` and
`sprint_curate_mocks` (`src/pge/topology/coding.graph.ts:576,592`) — shipped in commit
`7d33553`, sprints 1-3 of `spec-20260805-pge-graph-engineering`, well before this sprint's
2026-08-12 close. The ground actually checked, directly rather than inferred: no PGE node
body calls `appendHistory` (`grep -rn "appendHistory" src/pge --include="*.ts"`, non-test, is
zero hits) — a MISSING WRITER, not a missing node to host one. `history` is corrected to
**OPEN WORK, not permanently accepted**; `audits`' own disposition (the
`InterruptInsideFanOut` fan-out ground) is unaffected and unchanged. The claims below are
left as originally written, for the record of what this sprint actually concluded — read them
alongside this erratum, not in place of it. The corrected, canonical disposition lives in
`docs/pge-graph.md`'s "Engine migration disposition" and is enforced by
`src/pge/topology/docs.test.ts`.

**Update (2026-08-14, later the same day): `history` is no longer open work either — it
CLOSED.** Sprint 4 of `spec-20260814-pge-full-convergence` built the missing writer:
`src/pge/runtime/history.ts` exports `emitPhaseEvent`, delegating to the same
`appendHistory` the imperative engine calls, and nine node bodies emit their phase events at
their real lifecycle boundaries. A real run of both engines now produces the identical
ordered event list, so `history` left the conformance divergence set — three fields remain
(`audits`, `contracts`, `pipelineResult`) and `equivalent` is still `false`. Read "OPEN WORK"
above as this record's state between the correction and that closure; `audits`' disposition
is untouched by both.

## What this sprint added

Nothing that runs. This is the spec's docs-only closing sprint: no production `.ts` file
changed, no topology moved (`pge diff` empty, `graphVersion` unchanged at `1.4.0`), and the
golden dataset moved zero cases. What changed is the record — three files, each a claim
that had to be measured before it could be written down.

## The contract's own description was falsified, and the stop condition pre-authorised saying so

The contract's `description` read *"Two divergences closed, two remaining."* A real run of
both engines, driven exactly as `src/orchestrator/workflow/conformance.engines.test.ts`
drives them, still reports `equivalent: false` with the identical four field names —
`audits`, `contracts`, `history`, `pipelineResult` — it reported before this spec's first
sprint. **The divergence SET never shrank.** What sprint 4 and sprint 5 actually closed sat
one level *below* the field: the `pipelineResult` **mechanism** (sprint 4 — the channel
reducer stopped keeping the seeded `"proposed"` copy of a settled contract) and the
`contracts` **status delta** (sprint 5 — both engines write `"completed"` for a settled
sprint). Neither closure removed a field from the pinned set, because `pipelineResult` is a
*container* for whole `SprintContract` objects and reduces exactly to `contracts`'s
divergence, and `contracts` still carries three open deltas (`evaluatorFeedback`,
`generatorNotes`, `version`).

This sprint's own stop condition covers exactly this outcome: *"The divergence set is not
what this spec predicted — record what it actually is and why, rather than adjusting
anything to match the prediction."* No test and no production source were changed to make
"two closed" come true. `conformance.engines.test.ts`'s pinned array
(`:334-339`) is the same four literals it has been since sprint 13 of
`spec-20260805-pge-graph-engineering`.

## sc-6-1 — the pin verified by mutation, in both directions, at both granularities

Verified by actually mutating the shipped test and the shipped write, not by reading the
pin and assuming it bites:

| Mutation | Direction | Result |
|---|---|---|
| `src/orchestrator/pipeline.ts:589` reverted `"completed"` → `"passed"` | 2 (silently un-fixed) | `conformance.engines.test.ts:435` fails: `expected 'passed' to be 'completed'` |
| A fifth, fake field (`"fakeField"`) added to the pinned array | 1 (new divergence) | `:334` fails on array mismatch |
| `"contracts"` removed from the pinned array (pretend it closed) | 2 (field-level) | `:334` fails on array mismatch |
| `pgeContract.evaluatorFeedback` expectation flipped `toBeUndefined()` → `toBeDefined()` | 2 (delta-level, pretend a PGE writer exists) | `:439` fails: `expected undefined to be defined` |

Every mutation was applied to a real copy of the file, run, observed to fail, then restored
and re-verified green (`diff` against the pre-mutation copy, byte-identical). The delta-level
mutation is the one that matters most: it proves the pin bites *inside* `contracts` even when
the field-level array is untouched — a PGE node gaining an `evaluatorFeedback` writer
tomorrow would still fail this test, not just silently shrink the divergence count.

**What actually changed in the file, and why it is prose, not assertions:** sc-6-1 asks the
test to pin "the divergence set to exactly what a real run now produces" — a real run
produces the same four fields it always has, so the pinned array does not move. What moved
is the ~90-line record comment above it (`"THE RECORDED DIVERGENCE SET"`): the `audits`
bullet's "only checkpoint id the committed artifact declares" wording was corrected (the
artifact declares **two** HITL checkpoint ids, `end-of-pipeline` and `post-plan`; only the
former is ever *evaluated* on this fixture, because a settled plan takes `e-plan-ok`, never
the `e-plan-clarify` edge that reaches `post-plan`), and both the `history` and `audits`
bullets now state the **permanent-acceptance** disposition and its architectural grounds —
no curator node to emit a start/complete pair from (`history` — **see erratum above: this
ground is FALSE, corrected 2026-08-14**), and `InterruptInsideFanOut`
(`src/pge/topology/validate.ts:1089-1099`) being a blocking validation error for five of the
eight checkpoint ids the fan-out region would need (`audits`) — grounds this spec's own
`outOfScope[0]` states but this file had not spelled out until now. The per-field test's own
audits comment (previously the same imprecise wording, `~:379-380`) was corrected in the
same shape.

## sc-6-2 / sc-6-4 — `docs/pge-graph.md`'s closing record

Inserted at the exact slot the previous spec's own closing record used (`docs/pge-graph.md`,
between `spec-20260812-pge-real-workload-errors`'s five-line closing paragraph and
`**This decision is enforced, not just recorded.**`), in the same shape: name the spec and
where it closed, state what it did and did not move, state the divergence set as it stands,
state the consequence. This spec's record is longer than the model because sc-6-4 asks for
four additional things, each sourced rather than invented:

1. **`audits` is recommended for permanent acceptance**, not left as open work — the ground
   is the one above, restated as a numbered flip-prerequisite rather than only inside the
   divergence-set prose. (**`history` was originally paired here too, under the same "no
   curator node" ground the erratum above corrects; `history` is open work, not permanently
   accepted.**)
2. **Option B success semantics**, defined verbatim from
   `spec-20260812-pge-real-workload-errors.json`'s `resolvedClarifications` D3: making
   `PipelineResult.success` false on a `FAIL_CLOSED` refusal, rejected there and here because
   it would add `completionMarker` — currently identical across both engines — to the
   divergence set. Taking it trades one open divergence for another.
3. **A durable checkpoint mechanism for `commit` and `finalize`**: four mechanisms are
   registered (`cli`, `disk`, `pr`, `noop`), but nothing in this repository ever runs those
   two nodes under a non-`noop` one, because the shipped `conformanceConfig()` is autopilot
   by construction and the golden executor pins that one config on purpose. Consequence
   already on record: both are two of the six `NEVER_EXECUTED` entries
   (`src/pge/golden/coverage.test.ts:139-146`).
4. **An explicit re-specification of the bar itself**, stated as a conclusion rather than a
   suggestion: the bar as written — *"requires sustained green conformance across real
   runs"*, operationally `equivalent: true` — is now **unsatisfiable by design**, because two
   fields are recommended for permanent acceptance and the other two cannot close without a
   PGE-node writer this spec never added. `diffs` can therefore never become empty under the
   bar's current wording. Re-specifying it is this spec's own `nonGoals`/`outOfScope[2]`, not
   this record's to perform.

The record also restates two carry-forward facts from sprint 5 (`verdictFrom` now
structurally dead for both engines, not just PGE; `flusher.ts:76`'s bare-local comparison,
safe today and invisible to the sc-1-4 scan by construction) and names two hazards found
along the way rather than fixed: the recurring stale-`path:line`-citation problem (below),
and that `src/pge/topology/docs.test.ts` — the file that gates this very section — is itself
unreadable by plain `grep` (two literal NUL bytes at its own line 308, pre-existing, same
class as `reducers.ts`'s and `frontier.ts`'s).

## sc-6-5 — the new claims, each with a test that fails when it stops being true

`assertFlipPrerequisitesStated(doc)` (`src/pge/topology/docs.test.ts`, beside the existing
`assertDispositionCitesEvidence`) checks the four sc-6-4 subjects by phrase — the same
phrase-tolerant discipline the existing helper uses, so a later rewording survives as long
as the *claim* survives. Five new tests: one positive (`shippedDoc` satisfies the helper) and
four paired `FAILS when …` gutted controls, one per subject (`permanent acceptance`,
`Option B`, `durable checkpoint`, `re-specif…`), each asserting `gutted !== shippedDoc`
before asserting the helper throws on it — so a control that stopped mutating anything would
be caught by its own first line.

`node dist/cli/index.js pge docs --check` → `ok … (44 nodes documented)`, exit 0 — but, per
the briefing, this is not evidence the prose is *correct*, only that no declared node id went
missing from the three `pge:nodes` regions. **One real trap found and fixed while writing
this record:** an early draft cited `pge docs --check`'s own region mechanism by writing the
literal marker text `<!-- pge:nodes -->` in prose — exactly the trap this document's own
`## How to read this document` section warns about. It opened a fourth, unclosed region
running to the end of the file and turned dozens of unrelated backticked identifiers
(`Budget`, `PgeEngine`, `bober_sprint`, …) into claimed-but-undeclared node ids, failing
`docs.test.ts`'s drift-mutation test with an 80-line diff. Caught by running the suite
before committing, not by the check itself; fixed by rephrasing to name the section instead
of reproducing the marker, the same technique line 47 already uses.

## sc-6-3 — the oracle, unmodified

`git log --oneline 4aef5ea..HEAD -- src/orchestrator/workflow/oracle-retention.test.ts` →
empty, both before and after this sprint. The file was not opened for editing. Its coupling
to `conformance.engines.test.ts`'s *source text* — at least 5 `it(` blocks, both engine
constructors, `assertEquivalent`, `report.equivalent`, `expect(report.equivalent).toBe(false)`,
and all four field names — was re-verified after this sprint's prose edits: still true, all
16 tests across both files still green.

## The stale-citation hazard, and the decision on a freshness guard

Four `path:line` citations inside the very section this sprint edits were already stale
before this sprint touched it — `sprint-review.ts:205→215`, `sprint-review.ts:215→222`,
`sprint-evaluate.test.ts:765→776`, `sprint-contract.ts:213→214` — fixed in the same commit as
the prose around them. This sprint's *own* prose edit then shifted two more, live:
`conformance.engines.test.ts:417-419` and `:417-426` moved to `:435-437` and `:435-444` after
the divergence-set comment grew, and both citations in `docs/pge-graph.md` were re-measured
and updated rather than left to the next sprint to discover. Sprints 3, 4 and 5 each had to
do the identical repair (`5da9940` fixed `versionRank` citations after `reducers.ts` shifted;
sprint 5 fixed more). **Nothing in CI catches any of this** — `pge docs --check` only diffs
node ids inside the three node-inventory regions and cannot see a `path:line` string in
prose at all.

**Weighed and declined, on the record rather than silently:** a general citation-freshness
guard is not a cheap addition. It would need to parse free-text `path:line`/`path:line-range`
references out of prose reliably — distinguishing them from version strings, code spans and
ordinary punctuation — across a ~1,500-line document carrying dozens of citations in varying
shorthand, then check each against the live file. That is a real capability worth its own
sprint, not something to bolt onto a closing record under this sprint's docs-only, four-file
scope; doing so here would itself be the scope creep `nonGoals` exists to prevent. Recorded
as a follow-up, not performed.

## Every claim, and the test that fails when it stops being true

| Claim | The test that pins it |
|---|---|
| The divergence set is unchanged at four fields, both directions, field- and delta-level | `conformance.engines.test.ts`, the pinned array + the "3. contracts" per-field asserts (re-verified by mutation this sprint, see above) |
| `history`/`audits` are recommended for permanent acceptance, with the ADR-6/no-curator-node grounds (**the no-curator-node ground was FALSE — see erratum above; `history` is open work, not permanently accepted**) | `src/pge/topology/docs.test.ts`, `assertFlipPrerequisitesStated` + its permanent-acceptance gutted control |
| Option B is named as the term of art and its `completionMarker` consequence stated | same file, the Option B gutted control |
| The durable-checkpoint gap for `commit`/`finalize` is stated | same file, the durable-checkpoint gutted control |
| Re-specifying the bar is named as the prerequisite, and the bar is stated unsatisfiable by design | same file, the re-specification gutted control |
| The audits "only checkpoint id" wording no longer claims the artifact declares only one | `conformance.engines.test.ts`'s own two corrected bullets (read directly; no separate pin — a prose correction inside an already-pinned comment) |
| `oracle-retention.test.ts` is unmodified | `git log --oneline 4aef5ea..HEAD --` on the file, empty |
| `pge docs --check` passes | `node dist/cli/index.js pge docs --check`, `ok … (44 nodes documented)` |

Suite **459 files / 1 pre-existing skip (460), 6965 tests passed / 2 skipped (6967), 0
failed** — up from the sprint-5 baseline of 6960 passed by exactly the 5 new `it()` blocks
this sprint added to `docs.test.ts` (`assertFlipPrerequisitesStated`'s positive test plus its
four gutted controls; the prose fixes elsewhere added no new test cases). Typecheck (both
tsconfigs), lint (0 errors, 2 pre-existing warnings in an untouched file), build all green.
Golden gate **6/6**, dataset unchanged at 43 files — a docs/test-prose sprint moved zero
artifacts, as expected.

## Notes for maintainers

- **This spec closes having moved the divergence set by exactly zero fields across all six
  sprints**, and that is the honest headline, not a caveat. What moved is *inside* two of the
  four fields, and what remains is now recommended for permanent acceptance rather than left
  ambiguous — a stronger, more falsifiable end state than "in progress" was, even though the
  number of open fields did not change. (**Corrected 2026-08-14 — see erratum above: only
  `audits` is permanently accepted; `history` is open work.**)
- **A future reader must not read "two mechanisms closed" as "halfway to a flip."** The bar
  as currently written cannot be satisfied by any further vocabulary sprint — it needs a new
  PGE-node writer (a topology change, `nonGoal`-adjacent everywhere in this spec) and a
  deliberate re-specification of what "equivalent" should mean once two fields are
  permanently accepted. That re-specification is the next spec's to write, not this one's.
  (**Corrected 2026-08-14: only `audits` is permanently accepted — see erratum above; the
  "new PGE-node writer" this bullet already names is exactly what would close `history`,
  which was open work even at this sprint's close, not a second permanently-accepted
  field.**)
- **The `<!-- pge:nodes -->` literal-marker trap is real and easy to hit while writing about
  the checker itself** — caught here only because the full suite was run before committing.
  Any future edit to this section that needs to describe what the checker does should name
  the section ("How to read this document") rather than quote the marker.
- Passed **iteration 1**, all 6 required criteria, each re-verified by execution: sc-6-1's
  both-directions claim was proven by four separate live mutations (one production write, two
  field-level array edits, one delta-level assertion flip), each observed to fail and then
  restored byte-identical against a pre-mutation copy; sc-6-3's "unmodified" claim by `git
  log`, not by memory; sc-6-5's `pge docs --check` pass by running it after a real build, not
  by inference. Commits `53986cf` (the divergence-record prose + stale-citation fixes) and
  `ba937e6` (the sc-6-4 test hook + the closing record itself).
