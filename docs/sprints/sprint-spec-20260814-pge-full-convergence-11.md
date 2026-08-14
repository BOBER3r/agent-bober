# The bar is met, and the default deliberately stays 'ts'

**Contract:** sprint-spec-20260814-pge-full-convergence-11  ·  **Spec:**
spec-20260814-pge-full-convergence  ·  **Completed:** 2026-08-14

**This is the closing record for `spec-20260814-pge-full-convergence`, 11 of 11 sprints.**

## THE CENTRAL FACT

`sc-11-1`'s literal text — *"the conformance harness reports `equivalent: true` on a real run
of both engines"* — is **UNSATISFIABLE BY BUILDING, not by shortfall**. Two divergences remain
and BOTH are architectural, sharing one root cause: the graph has a checkpoint-gated `commit`
the imperative engine lacks.

- `audits` — PROVEN unreachable at sprint 3: the runtime cannot express a per-branch interrupt
  (`.bober/architecture/arch-20260814-pge-full-convergence-adr-1.md`).
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
   function itself, not against the real dataset). Four cases: the accepted baseline reads
   `true`; a NEW divergence (`history` regressing) flips it `false`; ONE of the two accepted
   divergences silently disappearing flips it `false`; and BOTH disappearing (the literal,
   un-amended `equivalent: true`) also reads `false` — this function does not quietly grant the
   claim it is not the assertion for.
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
  one clarifying sentence (the file itself untouched).
- `docs/sprints/README.md` *(documentation commit)* — heading moves to "complete (11 of 11)",
  new sprint-11 narrative paragraph, new table row.
- **This record** — new *(documentation commit)*.

## Notes for maintainers

- **`ARCHITECTURALLY_ACCEPTED_DIVERGENCES` is a decision, not a cache.** Shrinking it when a
  field genuinely closes, or growing it to paper over a regression, is exactly the "adjusting
  the comparison" this spec's stop conditions forbid throughout. Each entry carries a reason to
  argue with for that purpose.
- **The formal ADR joinder for `pipelineResult.errors` is still open.** This sprint's code
  records BOTH fields as architectural (satisfying `sc-11-1`'s "each with a recorded reason")
  without taking the separate, still-recommended decision to formally amend or extend
  `arch-20260814-pge-full-convergence-adr-1` to cover `pipelineResult.errors` explicitly. That
  is unfinished business for an architect, named rather than silently dropped.
- **Gate, as run:** working tree — 468 files / **7,120 passed / 2 skipped / 0 failed**;
  `typecheck` and `typecheck:tests` clean; `lint` 0 errors / 2 pre-existing warnings; `build`
  clean; golden gate **8/8 (100%)**. Run the suite as `npx vitest run --exclude
  '**/.claude/worktrees/**' --exclude '**/node_modules/**'` — a bare run picks up nested
  worktrees. Commit `1487ba1`.
