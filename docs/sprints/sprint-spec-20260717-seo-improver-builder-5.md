# AI-visibility: provider-agnostic port + axis + offline arm + adapter

**Contract:** sprint-spec-20260717-seo-improver-builder-5  ·  **Spec:** spec-20260717-seo-improver-builder  ·  **Completed:** 2026-07-17

## What this sprint added

This sprint makes the `ai-visibility` (AI-answer / GEO) capability actually
servable — previously it was a placeholder `disabled` arm. Two things landed.
First, a **provider-agnostic live adapter**: the `AiVisibilityProvider` port plus
`AiVisibilityAdapter`, a `SeoDataSource` that serves `ai-visibility` behind the
`ai-visibility` egress axis with the same guard→admit→probe→record→degrade shape
as `DataForSeoAdapter.serp`. Per **ADR-5**, the concrete AI-visibility vendor is
**deliberately unpinned** (Stage-1 research found no evidence pinning Perplexity,
Profound, or any other provider), so the adapter depends on an *injected* port and
imports **no vendor SDK anywhere under `src/seo/`**. Second, the offline
`LocalExportSource` now serves `ai-visibility` from `.bober/seo/imports/ai-visibility.csv|json`
at zero egress (it was `disabled` before). The adapter is **not yet wired into the
runner's `selectSource`/router** — that is Sprint 9 — so a `bober seo ai-visibility`
run today still resolves through the offline source; with the axis off the run is
byte-identical to before this sprint.

## Public surface

- `AiVisibilityProvider` (`src/seo/sources/ai-visibility-adapter.ts:73`) — the
  provider-agnostic port. Shape: `readonly name: string`, `readonly estCostUsdPerPrompt: number`,
  `probe(target: string, prompts: string[], locale?: string): Promise<AiVisibilityRow[]>`.
  Concrete implementations live **outside `src/seo/`** and map their own vendor
  response into the already-typed `AiVisibilityRow[]`; the adapter does no
  vendor-specific parsing.
- `AiVisibilityAdapter` (`src/seo/sources/ai-visibility-adapter.ts:86`) — a
  `SeoDataSource` constructed with `(egress, governor, provider)`. The provider is a
  **required** constructor argument (ADR-5: no vendor is pinned, so there is no sane
  default). `capabilities()` returns exactly `['ai-visibility']`; every other
  capability method returns `{ kind: "disabled" }` unconditionally.
- `AiVisibilityAdapter.aiVisibility(q)` (`src/seo/sources/ai-visibility-adapter.ts:105`)
  — the gated probe. In order: `egress.assertAllowed("ai-visibility")` (axis-off ⇒
  `abstain{egress-ai-visibility-disabled}`, zero sockets, `probe()` never called);
  then `governor.admit()` with `estCostUsd = estCostUsdPerPrompt * prompts.length`
  (refused ⇒ `abstain{decision.reason}`); only then `provider.probe()`;
  `governor.record()` runs **only after a successful probe**; any probe error ⇒
  `abstain{source-error}` (never throws, nothing booked).
- `QuotaRequest.source` widened to `"gsc" | "dataforseo" | "ai-visibility"`
  (`src/seo/quota-governor.ts:57`) — additive. `admit()`/`record()` only special-case
  `"gsc"`, so `"ai-visibility"` naturally takes the USD-only budget branch (no GSC
  daily-rows / rate-window cap).
- `LocalExportSource` ai-visibility arm (`src/seo/sources/local-export.ts:303`) —
  `ai-visibility` added to `FileBackedCapability` and reads `.bober/seo/imports/ai-visibility.csv|json`
  via the shared `readCapability` path (missing file ⇒ `disabled`; empty ⇒ `abstain`).
  `mapAiVisibilityRow` (`local-export.ts:217`) maps the CSV columns
  `prompt,provider,mentioned,rank,citationPresent,sourceUrls` into `AiVisibilityRow`;
  `sourceUrls` is a single space-delimited cell (URLs never contain spaces).

## How to use / how it fits

Nothing new to invoke on the CLI. The offline arm is live now: drop an
`.bober/seo/imports/ai-visibility.csv` (header
`prompt,provider,mentioned,rank,citationPresent,sourceUrls`) or `.json` array, and a
`bober seo ai-visibility` run's data-gather step returns those rows instead of
`disabled`. See `src/seo/__fixtures__/imports/ai-visibility.csv` for the shape.

The live `AiVisibilityAdapter` exists but is not yet selected by the runner. To use
it before Sprint 9 wires it, you must construct it directly with a concrete
`AiVisibilityProvider` implementation (written outside `src/seo/`) and turn on the
`seo.egress.ai-visibility` axis. Swapping providers means writing a new
`AiVisibilityProvider` — the adapter, the seam, and the egress model are untouched.

## Notes for maintainers

- **No vendor is pinned — keep it that way (ADR-5).** Do not import a Perplexity /
  Profound / any provider SDK under `src/seo/`; that constraint is evaluator-checked
  (grep for vendor SDK imports must stay empty). New providers are injected via the
  constructor.
- **Single `ai-visibility` axis, no per-vendor axes (ADR-5).** A per-provider egress
  axis would explode `selectSource`'s all-off predicate and threaten the
  byte-identical-when-off invariant. One axis gates every provider.
- **Cost is booked only on success.** `governor.record()` runs after a successful
  `probe()` only; a failed/rejected probe books nothing and yields `abstain`. The
  actual charge equals the estimate because the price is a fixed per-prompt rate.
- **Follow-up (Sprint 9):** wire `AiVisibilityAdapter` into `selectSource`/router so
  the axis drives a real run; until then enabling the axis alone changes no CLI path.

## Scope

One commit — `c913739` — six files: new `src/seo/sources/ai-visibility-adapter.ts`
(+171) and its test (+210); `src/seo/quota-governor.ts` (+6, additive source
widening); `src/seo/sources/local-export.ts` (+38/−13, the offline arm) and its test
(+35); new fixture `src/seo/__fixtures__/imports/ai-visibility.csv` (+3).
`runner.ts` / `selectSource` / `data-source.ts` / `command.ts` untouched (router
byte-identical). All 5 required criteria (sc-5-1..5-5) passed on **iteration 1**;
build/typecheck/lint clean; full suite **4562 passed | 1 skipped | 0 failed**, zero
regressions.
