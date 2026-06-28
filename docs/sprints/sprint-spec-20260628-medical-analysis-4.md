# Test-gap (cadence) suggestions + cross-marker dig-deeper offers in the proactive pass

**Contract:** sprint-spec-20260628-medical-analysis-4  ·  **Spec:** spec-20260628-medical-analysis  ·  **Completed:** 2026-06-28

## What this sprint added

Sprint 4 extends the Sprint-1 **deterministic, fully offline** proactive review pass with **two
new analyzers**, both pure-except-store-reads and **zero-LLM / zero-network**. `cadence.ts` flags
biomarkers **overdue for re-testing** against a CLOSED `RECOMMENDED_CADENCE_DAYS` table; `cross-marker.ts`
emits an **"want me to dig deeper?" OFFER Finding** (never auto-runs analysis) when both markers of a
configured pair are out of reference range. `runProactiveReview` now writes **trend + gap +
cross-marker-offer** findings in one offline pass, and a new `digDeeper()` dispatcher plus a
`bober medical review --dig-deeper <findingId>` flag route the (only) deep, gated analysis through the
Sprint-3 `generateRecommendation` — **delegated, not re-implemented**. `src/medical/engine.ts` is
untouched.

## Public surface

- `RECOMMENDED_CADENCE_DAYS` (`src/medical/analysis/cadence.ts:23`) — a **CLOSED**, code-reviewed
  `Readonly<Record<string, number>>` of recommended re-test cadence in days, keyed by biomarker:
  `ldl: 365`, `hba1c: 180`, `tsh: 365`, `vitamin_d: 365`, `ferritin: 365`. Mirrors the closed-whitelist
  discipline of `NumericPrimitive` (`src/medical/types.ts:142`) — extending it is a code-review event,
  not a runtime decision.
- `detectTestGaps(store, biomarkers, opts)` (`src/medical/analysis/cadence.ts:70`) — pure, zero-LLM.
  For each biomarker, looks up its latest `collectedAt` via `getLabSeries` and emits a `kind: "question"`
  gap Finding when `(now − latest) / 86_400_000 > cadenceDays`. Biomarkers **absent** from the table are
  **skipped** — no guessed cadence. `now` is an injected ISO-8601 string (no `Date.now()`); the gap
  Finding id uses ruleKey `"cadence-gap"` and excludes `now` so it is idempotent.
- `CROSS_MARKER_PAIRS` (`src/medical/analysis/cross-marker.ts:24`) — a **CLOSED**
  `ReadonlyArray<readonly [string, string]>` of related-marker pairs: `["ldl", "triglycerides"]`,
  `["hba1c", "triglycerides"]`. Code-review to extend.
- `detectCrossMarkerPatterns(store, opts)` (`src/medical/analysis/cross-marker.ts:77`) — pure, zero-LLM.
  When **both** markers of a pair are out of reference range (latest value outside
  `[referenceLow, referenceHigh]`), emits **one** `kind: "question"` OFFER Finding referencing both
  names. The marker pair is persisted in `tags = ["cross-marker", markerA, markerB]` so the dig-deeper
  path can recover it from the note frontmatter. Offer-finding id uses ruleKey
  `"cross-marker-<a>-<b>"` and excludes `now`.
- `runProactiveReview(projectRoot, config, opts)` (`src/medical/analysis/review-pass.ts:72`) — now merges
  `[...analyzeTrends, ...detectTestGaps, ...detectCrossMarkerPatterns]` in **one deterministic offline
  pass**. Each analyzer uses a DISTINCT ruleKey, so ids never collide and Sprint-1 idempotency (sc-1-4)
  is preserved.
- `digDeeper(projectRoot, config, offerId, opts, deps?)` (`src/medical/analysis/review-pass.ts:148`) —
  the **only LLM step** in the module. Reads the offer Finding note from disk, recovers the marker pair
  from its frontmatter `tags` (filtering out the `"cross-marker"` sentinel), frames a question, and
  **delegates** to `generateRecommendation` (Sprint 3). Returns the Sprint-3 `RecommendOutcome`. Does
  NOT re-implement the judge loop.
- `DigDeeperDeps` (`src/medical/analysis/review-pass.ts:50`) — injectable deps for `digDeeper`
  (`generateRecommendation?`, `recommendDeps?`); production callers pass none.
- `bober medical review --dig-deeper <id>` (`src/cli/commands/medical.ts:357`) — additive option on the
  existing `medical review` command. With the flag, routes to `digDeeper` (the gated LLM path) and prints
  the outcome (accepted / flagged-for-review / escalated / refused). Without it, plain `bober medical
  review` runs the offline pass whose printed counts now include gap + offer findings. Clock read **only**
  at the CLI boundary; on error sets `process.exitCode = 1` without throwing.

## How to use / how it fits

```bash
# Offline, deterministic pass — now also reports cadence gaps + cross-marker offers:
bober medical review
#   findings written: 4          # e.g. ldl trend + ldl cadence-gap + triglycerides trend + ldl/triglycerides offer
#   dashboard:        /abs/.bober/medical/vault/findings/dashboard.md

# Explicitly accept a cross-marker offer — the ONLY path that crosses the LLM gate:
bober medical review --dig-deeper <offer-finding-id>
#   Deep analysis accepted
#     finding: /abs/.bober/medical/vault/findings/<id>.md
```

This is the proactive analysis leg, layered on Sprint 1's pass and Sprint 3's recommendation path:

1. **Offline detection (zero-LLM).** `runProactiveReview` runs `analyzeTrends` + `detectTestGaps` +
   `detectCrossMarkerPatterns` over the seeded `HealthDataStore` in one pass and writes one Finding note
   per detection. A cross-marker hit produces an **offer** ("want me to dig deeper?"), it does **not**
   auto-run any analysis.
2. **Explicit dig-deeper (gated LLM).** Only when you pass `--dig-deeper <id>` does `digDeeper` load that
   offer's note, recover the marker pair from `tags`, and call `generateRecommendation` — which inherits
   all Sprint-3 gating (red-flag short-circuit, cloud-inference fail-closed model selection, audit
   entry). The deep analysis is **gated and reused, not re-implemented**.

## Notes for maintainers

- **CLOSED-table discipline.** Both `RECOMMENDED_CADENCE_DAYS` and `CROSS_MARKER_PAIRS` are closed,
  code-reviewed tables that mirror `NumericPrimitive` (`types.ts:142`). A biomarker with no cadence entry
  is **skipped** (no default/guessed cadence — sc-4-3, evaluator-confirmed). Adding a cadence or a pair is
  a source change, never a runtime inference.
- **Zero-LLM-detection invariant.** The detection analyzers import **no** provider/network/`fetch`/
  `EgressGuard`/`createClient` and never read the wall clock (`now` is injected). The evaluator confirmed
  this independently by **grep of `cadence.ts` + `cross-marker.ts` (empty match)**; `generateRecommendation`
  is confined to `digDeeper`. The guarantee holds **by source inspection**, not by any test spy (see the
  follow-up below).
- **Dig-deeper delegates, not duplicates.** `digDeeper` calls Sprint-3 `generateRecommendation` via
  `deps.generateRecommendation ?? generateRecommendation`; the judge loop is not copied. The marker pair
  round-trips offer-Finding `tags` → frontmatter → recovered question, which is why the offer writer must
  keep `tags[0] === "cross-marker"` with the pair in positions 1+.
- **Idempotency preserved.** Distinct ruleKeys (`"cadence-gap"`, `"cross-marker-<a>-<b>"`) avoid id
  collisions with trend findings, and all ids exclude `now`, so re-running over an unchanged store
  overwrites the same notes — Sprint-1 sc-1-4 idempotency tests stay green.
- **`engine.ts` is no-touch.** The reactive medical SOP / Q&A engine is not in commit `92a0481`
  (evaluator-confirmed).
- **Known non-blocking follow-up (sc-4-4 test hygiene).** The zero-LLM assertion in
  `src/medical/analysis/cross-marker.test.ts` (~line 37) uses a **free-floating `vi.fn()` `llmSpy` that is
  never passed into `detectCrossMarkerPatterns`** (the function has no LLM injection point), so
  `expect(llmSpy).not.toHaveBeenCalled()` is **tautologically true**. The zero-LLM guarantee is real but
  enforced by source/grep inspection, **not** by that spy. A later cleanup should either remove the spy,
  document it as illustrative, or convert it into a real injection-point assertion. Non-blocking — flagged
  by the evaluator's `generatorFeedback` (priority: medium, category: quality); no code/behavior change
  was made here.

## Scope

Commit `92a0481`: 2 new analyzer modules (`cadence.ts`, `cross-marker.ts`) + 2 collocated `*.test.ts`,
`review-pass.ts` extended (single-pass merge + `digDeeper` + `DigDeeperDeps`) with `+sc-4-5`/`sc-4-6`
tests, and the additive `medical review --dig-deeper` CLI branch. No new deps. All 6 required criteria
(sc-4-1..sc-4-6) + the optional manual sc-4-7 passed iteration 1; full suite **3114** green (+17,
baseline 3097), no regressions. Eval `eval-sprint-spec-20260628-medical-analysis-4-1` → **pass** (7/7).
