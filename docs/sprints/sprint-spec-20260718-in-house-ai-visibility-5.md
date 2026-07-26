# AiVisibilityScorer + AiVisibilityMetric + analyzer-side wiring (ADR-5)

**Contract:** sprint-spec-20260718-in-house-ai-visibility-5  ·  **Spec:** spec-20260718-in-house-ai-visibility  ·  **Completed:** 2026-07-18

## What this sprint added

The live grounded-API spine (Sprints 1–4) emits **one raw `AiVisibilityRow` per real
sample** — so N probes of the same prompt against the same engine produce N rows, none
aggregated. This sprint adds the **read side**: a pure `AiVisibilityScorer` that folds those
raw rows into a new derived `AiVisibilityMetric` type carrying mention/citation **rates** and
a deterministic **Wilson 95% confidence interval**, grouped strictly by `(prompt, provider)`
and **never merged across arms**. It is wired analyzer-side behind a
`provenance.source === "ai-visibility"` guard (ADR-5), so the LLM prompt now shows rates + CI
for **live** ai-visibility outcomes instead of dumping N raw per-sample rows — while every
non-live outcome (local-export / disabled / abstain / undefined) falls through to the
unchanged `describeDataOutcome` path and is **byte-identical** to pre-change. The metric is a
derived, in-prompt-only projection: the locked `SeoDataBundle.aiVisibility`
(`DataOutcome<AiVisibilityRow[]>`) and `AiVisibilityRow` shapes are untouched.

## Public surface

- `AiVisibilityScorer` (`src/seo/ai-visibility-scorer.ts:120`) — pure aggregator, re-exported from `src/seo/index.ts`. `aggregate(rows: AiVisibilityRow[]): AiVisibilityMetric[]` groups strictly by `(prompt, provider)` — arms are **never** merged even when they share a prompt — via a collision-safe `JSON.stringify([prompt, provider])` composite key (a naive `"::"` delimiter could appear inside a prompt and silently merge two arms). Empty input ⇒ `[]`; first-seen group order preserved; **never throws**, no `Date`, no RNG.
- `AiVisibilityMetric` (`src/seo/ai-visibility-scorer.ts:23`) — the derived type, re-exported from `src/seo/index.ts`: `{ prompt: string; provider: string; samples: number; mentionRate: number; citationRate: number; meanRank?: number; mentionRateCi95: [number, number]; sourceUrls: string[] }`. `meanRank` is **omitted entirely** (never set to `undefined`) when no row in the group carries a `rank`; `sourceUrls` is the deduped union of every row's `sourceUrls` in first-seen order.
- `describeAiVisibility(outcome)` (`src/seo/analyzer.ts:168`, module-internal) — the provenance-guarded analyzer branch. Runs the scorer and serializes `AiVisibilityMetric[]` into the prompt **only** when `outcome.kind === "data" && outcome.provenance.source === "ai-visibility"`; otherwise delegates to the unchanged `describeDataOutcome("AI Visibility", outcome)`. `buildDataBundleSummary` now calls it for the AI-Visibility line in place of the raw `describeDataOutcome`.

## How to use / how it fits

The scorer is a pure transform available to any consumer via the barrel:

```ts
import { AiVisibilityScorer, type AiVisibilityMetric } from "./seo/index.js";

const metrics = new AiVisibilityScorer().aggregate(rows);
// metrics[i].mentionRate / .citationRate / .mentionRateCi95 = [lo, hi]
```

In production it is invoked transparently inside the SEO analyzer. When the run's
`ai-visibility` axis surfaced **live** rows (the live adapter stamps
`provenance.source === "ai-visibility"` at `ai-visibility-adapter.ts:136`),
`buildDataBundleSummary` renders one aggregated line per `(prompt, provider)` — rates and CI —
rather than N raw rows, giving the LLM a compact, statistically-honest signal. The Wilson
score interval is computed deterministically (`z = 1.96`) over the mention indicator across a
group's samples; it was unit-tested against a hand-computed value (`k = 7, n = 10 →
[0.3968, 0.8922]`, cross-checked in Python by the evaluator).

## Notes for maintainers

- **The metric is never persisted.** By contract nonGoal, `SeoDataBundle.aiVisibility` stays
  `DataOutcome<AiVisibilityRow[]>` and `AiVisibilityRow` is unchanged — the `AiVisibilityMetric`
  lives only in the analyzer's prompt string. `describeDataOutcome`, `analyze`, the runner
  data-flow, and the bundle types were not touched.
- **The guard keys on `DataProvenance.source`, not a decoy.** The correct stamp is
  `provenance.source === "ai-visibility"` (set only by the live adapter at
  `ai-visibility-adapter.ts:136`) — **not** the similarly-named `QuotaRequest.source` at
  `ai-visibility-adapter.ts:116`. Keying on the wrong one would either mis-fire on non-live
  outcomes or never fire; the evaluator confirmed the correct one by source read.
- **Single-sample CI is a deliberate degenerate case.** `n <= 1` returns `[rate, rate]` rather
  than the raw Wilson output — a lone `1/1` naturally yields a misleadingly wide `~[0.207, 1.0]`
  interval, so one observation is reported with zero spread instead. The general-case interval
  is clamped defensively to `[0, 1]`.
- **Byte-identical for non-live outcomes.** local-export / disabled / abstain / undefined all
  route through the unchanged `describeDataOutcome`, verified by exact-string tests and a
  zero-diff on lines 138–155.

## Scope

One commit — `989acd5` — matching `estimatedFiles`: new `src/seo/ai-visibility-scorer.ts`
(+ `.test.ts`, 16 tests: grouping/never-merge, empty, degenerate CI, `meanRank` omission,
dedup, hand-checked 7/10 CI, boundedness, determinism, never-throws), modified
`src/seo/analyzer.ts` (the `describeAiVisibility` branch) + `src/seo/analyzer.test.ts`
(+5 tests: live ⇒ rates/CI not raw rows, never-merge two-provider, local-export/disabled/
undefined byte-identical), plus an optional barrel re-export in `src/seo/index.ts`.
**No new dependencies.** All 5 required criteria (sc-5-1..5-5) passed on **iteration 1**;
typecheck/build/lint clean; full suite **4837 passed | 1 skipped | 0 failed**
(+21 new tests, 0 regressions).
