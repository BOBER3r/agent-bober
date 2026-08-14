# The bar is met, and the default deliberately stays 'ts'

**Contract:** sprint-spec-20260814-pge-full-convergence-11  ·  **Spec:**
spec-20260814-pge-full-convergence  ·  **Completed:** 2026-08-14

**This is the closing record for `spec-20260814-pge-full-convergence`, 11 of 11 sprints.**

## THE CENTRAL FACT

`sc-11-1`'s literal text — *"the conformance harness reports `equivalent: true` on a real run
of both engines"* — is **UNSATISFIABLE BY BUILDING, not by shortfall**. Two divergences remain
and BOTH are architectural, sharing one root cause: the graph has a checkpoint-gated `commit`
the imperative engine lacks.

- `audits` — PROVEN unreachable: the runtime cannot express a per-branch interrupt. Established
  by sprint 1's ADR revisit (`.bober/architecture/arch-20260814-pge-full-convergence-adr-1.md`,
  which supplies the runtime soundness argument ADR-6 never gave) and upheld at sprint 3, which
  declared the one checkpoint id outside the fan-out region and left `audits` RECOMMENDED FOR
  PERMANENT ACCEPTANCE.
- `pipelineResult.errors` — proven at sprint 6: only `PgeEngine.run` writes it, from the
  interpreter's `TaskFailure` records after a checkpoint-gated commit refusal; the imperative
  `commitAll` is unconditional and ungated, so there is no honest equivalent write site.

The contract's own stop condition pre-authorised this outcome: *"A spec that closed three of
four honestly is worth more than one that claims four."* The orchestrator's amendment
(`amendment.sc-11-1` on the contract) replaces the unreachable literal claim with a reachable
one, at the same standard sprint 3 applied to `audits` alone: **the harness reports the TRUE
divergence set on a real run, and every remaining entry is proven architectural rather than
merely unbuilt, each with a recorded reason** — explicitly NOT met by adjusting the comparison.

## What this sprint added

**No topology moved, no golden case moved, and the only production file touched is
`src/orchestrator/workflow/conformance.ts`.** `git diff <parent>..1487ba1 --stat` touches
exactly two paths: `src/orchestrator/workflow/conformance.ts` (+62) and
`src/orchestrator/workflow/conformance.engines.test.ts` (+101). `docs/pge-graph.md` and
`docs/sprints/README.md` move in a second, documentation-only commit, per this spec's own
convention (sprint 4 onward).

### `ARCHITECTURALLY_ACCEPTED_DIVERGENCES` + `equivalentModuloAcceptedDivergences`

Two new exports, `conformance.ts`:

- **`ARCHITECTURALLY_ACCEPTED_DIVERGENCES`** — `Readonly<Partial<Record<ConformanceField,
  string>>>`, exactly `{ audits: "<reason>", pipelineResult: "<reason>" }`, each reason
  source-grounded (`Checkpoint.interrupt`'s single slot / `grantScope`'s branch-blindness for
  `audits`; `PgeEngine.run`'s sole write site / the imperative engine's ungated `commitAll` for
  `pipelineResult`) and cross-referenced to the sprints and the ADR that established them.
- **`equivalentModuloAcceptedDivergences(report)`** — `true` only when
  `report.diffs`'s field set is EXACTLY `ARCHITECTURALLY_ACCEPTED_DIVERGENCES`'s two keys. Not
  a subset check: a report missing one of the two accepted fields returns `false`, because that
  would mean the comparison stopped *detecting* a divergence that, in fact, still exists — a
  silently-relaxed comparison, not a real convergence.

This is `sc-11-1`'s amended claim, made code rather than left as a sentence in a doc.

### sc-11-1 — run against the two real engines

`conformance.engines.test.ts` gains one new `it` inside the existing `describe`, using the same
`compare()` helper the file's other real-engine tests share:

```
expect(report.equivalent).toBe(false);                          // the literal claim: still unreached
expect(equivalentModuloAcceptedDivergences(report)).toBe(true);  // the amended claim: met
```

Both assertions are pinned side by side, deliberately — the record does not let the amended
statement stand in silently for the literal one.

### sc-11-2 — proven to fail in both directions, by mutation

Two proofs, not one, following the sprint-6 house precedent of live mutation rather than a
read-through:

1. **A PERMANENT synthetic test**, in this file's own established idiom
   (`coverage.test.ts:311-354` — hand-built `ConformanceReport` values against the exported
   function itself, not against the real dataset). Five cases: the accepted baseline reads
   `true`; a NEW divergence (`history` regressing) flips it `false`; ONE of the two accepted
   divergences silently disappearing flips it `false`; BOTH disappearing (the literal,
   un-amended `equivalent: true`) also reads `false` — this function does not quietly grant the
   claim it is not the assertion for; and a `vacuous` report reads `false` too, for the same
   reason `report.equivalent` has always refused one (an empty comparison proves nothing about
   either engine).
2. **Two LIVE mutations of the shipped source, observed red, then reverted byte-identical** —
   not committed, and not this diff:
   - `ARCHITECTURALLY_ACCEPTED_DIVERGENCES` gained a third, bogus entry (`history`, which the
     real run does not diverge on). The real-run assertion above went red:
     `expected false to be true`.
   - `equivalentModuloAcceptedDivergences`'s "no less" half was weakened to a subset check —
     the exact shape a silently-relaxed comparison would take. The new direction-2 synthetic
     test went red: `expected true to be false`.

   Each mutation was applied with a scratch copy of the pre-mutation file held aside, the
   affected test file re-run to confirm red, then the file restored and `diff` confirmed
   byte-identical against the held copy before re-running green.

### sc-11-4 — `oracle-retention.test.ts`

**Byte-for-byte unmodified.** Still asserts `pipeline.engine` defaults to `"ts"`, still asserts
`TsPipelineEngine` constructs, is selected by the default config and is `PgeEngine`'s own
fallback, and still asserts `conformance.engines.test.ts` constructs both real engines, is not
skipped, and pins `equivalent: false` with all four historical field names present in its
source. `git diff` over this file for this sprint is empty by construction — it was never
opened for editing.

### sc-11-3 / sc-11-5 — `docs/pge-graph.md`'s disposition, rewritten

The "Engine migration disposition" section is rewritten in place (not deleted and
re-authored): the numbered "what a flip would still require" item covering `sc-11-1` now
records what closed this sprint, what the amended bar is, and the proof that it holds in both
directions. A new closing subsection, "Sprint 11's own outcome," states plainly what did and
did not converge across the whole spec — `history`/`contracts` closed;
`audits`/`pipelineResult.errors` architectural and open; `context_compact`/`synthesize` (the
coverage-side pair) already closed under their own amended form by sprint 9 — and restates,
rather than lets travel forward uncredited, sprint 10's two evidence caveats (stub
collaborators; per-update not accumulated channel measurement).

**The sentence this record is built around:** what a flip would now actually require, now that
the bar itself is no longer the blocker. Three things remain, none of them a missing writer,
case or test: (1) the same amended equivalence holding under sustained real runs and other
configurations, not only the one golden fixture; (2) the still-undecided Option B
success-semantics call; (3) the still-RECOMMENDED, still-UNDECIDED formal ADR joinder of
`pipelineResult.errors` to `audits`' acceptance. All three are decisions, not code — which is
exactly what "the default stays `'ts'` by choice rather than by blocker" means in practice.

**What this sprint deliberately did NOT do (nonGoals):** it did not flip the default, did not
remove `TsPipelineEngine` as the oracle, and did not write or amend an ADR to formally join
`pipelineResult.errors` to `audits`' acceptance — that is an architecture decision for an
architect to take on purpose, not a documentation sprint's to assume. It also did not shrink or
grow `ARCHITECTURALLY_ACCEPTED_DIVERGENCES`'s membership from the two fields
`conformance.engines.test.ts` has pinned since sprint 6 — only named them, and their reasons,
explicitly in code for the first time.

## Was the amendment moving the goalpost? — the verdict, on record

This is the claim most likely to be challenged later, so the reasoning is recorded here rather
than left in an eval-result JSON. **Verdict: legitimate — and VERIFIED, not accepted**
(`.bober/eval-results/eval-sprint-spec-20260814-pge-full-convergence-11-1.json`,
`goalpostVerdict`). Five grounds, each independently checkable:

1. **The literal bar was never softened.** `report.equivalent`'s formula
   (`diffs.length === 0 && !vacuous`) is BYTE-IDENTICAL to what it was before this sprint —
   untouched — and the real-engine test asserts it directly, in the same test, immediately
   before checking the amended claim. A second, narrower claim was added BESIDE the original.
2. **The accepted set cannot widen invisibly.** Exactly two members, `Object.freeze`d, and the
   test HARDCODES `expect(Object.keys(ARCHITECTURALLY_ACCEPTED_DIVERGENCES).sort())` against
   the literal `["audits", "pipelineResult"]`. A third field requires editing that literal
   inside a test — a diff a reviewer sees.
3. **Both mutation directions were reproduced INDEPENDENTLY** by the evaluator in a disposable
   worktree, each observed red with the generator's exact error text, then reverted
   byte-identical (`git diff --stat` empty).
4. **The amendment pre-dates the work.** The ORCHESTRATOR wrote it into the contract
   (`amendment.sc-11-1`, `amendedAt: 2026-08-14T18:04:50Z` — before either commit), specifying
   this exact form and forbidding comparison-adjustment outright. The generator implemented a
   pre-specified amendment, not a self-serving relaxation of a bar it was failing.
5. **Both recorded reasons trace to source the evaluator re-checked itself:**
   `Checkpoint.interrupt`'s single slot (`checkpointer.ts:247`), branch-blind
   `grantScope`/`resumeMessageId` (`interrupt.ts:268`, `:332`), and `PgeEngine.run` as the sole
   repo-wide writer of `PipelineResult.errors` against `pipeline.ts:451`'s unconditional,
   ungated `commitAll`. `audits`' half rests on ADR-1 — written at sprint 1, upheld at sprint 3
   — established independently of this sprint.

**The limitation this verdict discloses, and does not paper over:** a test can enforce that the
accepted set stays internally consistent and stays exactly two members; it **CANNOT prove that
the "architectural" characterisation of either member is correct**. That remains a human/ADR
judgement, carrying the same limit the sprint-1/sprint-3 precedent carries for `audits` — which
is exactly why `pipelineResult.errors`' formal ADR joinder is recorded below as RECOMMENDED and
UNDECIDED rather than silently treated as settled: the code records the EVIDENCE, an architect
still owes the DECISION. What goalpost-moving would have looked like, for the record: quietly
merging the literal and the amended claim into one, or weakening `report.equivalent` itself.
This sprint did neither. The same account is kept in `docs/pge-graph.md`'s "Engine migration
disposition", which is where a reader who meets `ARCHITECTURALLY_ACCEPTED_DIVERGENCES` in the
source is pointed.

## What did NOT converge — stated plainly (sc-11-5)

| field | status | reason |
| --- | --- | --- |
| `audits` | architectural, permanently recommended for acceptance | `Checkpoint.interrupt` is one slot; `grantScope`/`clearScope` are branch-blind; `resumeMessageId` collapses every branch onto one message row (ADR-1) |
| `pipelineResult.errors` | architectural, recommended for acceptance, formal ADR joinder UNDECIDED | `PgeEngine.run` is the only write site, sourced from a checkpoint-gated commit refusal; the imperative `commitAll` is unconditional and ungated (sprint 6) |
| `context_compact` (node coverage) | structural, already closed under its amended form (sprint 8) | the shipped supervisor has no code path selecting `COMPACT_LABEL` |
| `synthesize` (node coverage) | structural, already closed under its amended form (sprint 9) | `route_after_eval`'s `partial` label needs a second invocation that the graph's own routing order forecloses |

`equivalent: true`, unamended, remains permanently unreached and is pinned as such directly in
`conformance.engines.test.ts` — this record does not claim otherwise.

## Files touched

- `src/orchestrator/workflow/conformance.ts` — `+62`. `ARCHITECTURALLY_ACCEPTED_DIVERGENCES`,
  `equivalentModuloAcceptedDivergences`.
- `src/orchestrator/workflow/conformance.engines.test.ts` — `+101`. Two new `it` blocks
  (`sc-11-1` real-run, `sc-11-2` synthetic both-directions) plus the two updated imports.
- `docs/pge-graph.md` *(documentation commit)* — "Engine migration disposition" rewritten in
  place; new "Sprint 11's own outcome" closing subsection; the oracle-retention paragraph gains
  a short passage recording that the file itself is unmodified and that the amended claim lives
  BESIDE its pin rather than replacing it, and the closing "revisit deliberately" sentence gains
  the same rule for `ARCHITECTURALLY_ACCEPTED_DIVERGENCES`.
- `docs/sprints/README.md` *(documentation commit)* — heading moves to "complete (11 of 11)",
  the spec's intro paragraph gains the three-of-four outcome sentence, new sprint-11 narrative
  paragraph, new table row.
- **This record** — new *(documentation commit)*.

## Notes for maintainers

- **`ARCHITECTURALLY_ACCEPTED_DIVERGENCES` is a decision, not a cache.** Shrinking it when a
  field genuinely closes, or growing it to paper over a regression, is exactly the "adjusting
  the comparison" this spec's stop conditions forbid throughout. Each entry carries a reason to
  argue with for that purpose.
- **The formal ADR joinder for `pipelineResult.errors` is still open, and now UNOWNED.** This
  sprint's code records BOTH fields as architectural (satisfying `sc-11-1`'s "each with a
  recorded reason") without taking the separate decision to formally amend or extend
  `arch-20260814-pge-full-convergence-adr-1` to cover `pipelineResult.errors` explicitly. Three
  independent agents have now recommended it (sprint 6's generator and its evaluator, and this
  documentation pass) and no one has taken it. The contract's `amendedDisposition.carryTo`
  named sprint 11 as the owner; sprint 11 is over, so the decision belongs to an ARCHITECT —
  an amendment to that ADR, or a new one — not to a sprint measuring itself against the
  acceptance, and not to a documentation pass. Recorded as open rather than quietly dropped.
- **The `evaluations` channel is still UNMEASURED under production-length evaluator text.**
  Sprint 10 measured 368 bytes against the 4,096-byte cap on a real 29,214-byte spec and 14
  real contracts — but with STUB collaborators (`generator.notes` is
  `` `generated ${contractId}` ``,
  the evaluator stub's `summary` is `"all criteria met"`). Sprint 5's carried finding therefore
  did NOT close, and nothing in sprint 11 closed it either: a real evaluator's free text is
  longer than a ~1 KB stub corpus, and this repository has no measurement of it. Do not read
  "no channel breached" as clearing that cap. Related, and equally open: `wouldReject` is
  checked per `ChannelUpdate` before the reducer, so an append-style channel's ACCUMULATED
  footprint after many writes is a different question the measurement does not answer.
- **Gate, as run and as independently reproduced:** working tree — 468 files / **7,120 passed
  / 2 skipped / 0 failed**; and, re-run by the evaluator on a CLEAN detached worktree at
  `97ac340` — 468 files / **7,116 passed / 6 skipped / 0 failed** (both totals are 7,122: four
  tests that run in the working tree are skipped on a clean checkout). `typecheck` and
  `typecheck:tests` clean, `lint` 0 errors / 2 pre-existing warnings, `build` clean and golden
  gate **8/8 (100%)** in both. Run the suite as `npx vitest run --exclude
  '**/.claude/worktrees/**' --exclude '**/node_modules/**'` — a bare run picks up nested
  worktrees. Commits `1487ba1` (code + tests) and `97ac340` (docs).
