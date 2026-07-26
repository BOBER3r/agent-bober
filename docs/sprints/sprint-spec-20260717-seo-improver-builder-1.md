# Config axes + core types + seam widening (byte-identical-when-off)

**Contract:** sprint-spec-20260717-seo-improver-builder-1  ·  **Spec:** spec-20260717-seo-improver-builder  ·  **Completed:** 2026-07-17

## What this sprint added

The **typed foundation** for the SEO improver+builder extension (arch-20260716-seo-improver-builder-extension, Approach B) that grows the existing offline-first `src/seo/` suite. Four additive pieces landed, all **default-off and provably byte-identical when the `seo` config section is omitted**: (1) two new independent live-data egress axes — `ai-visibility` and `site-crawl` — bringing `SeoEgressGuard` from two axes to four; (2) a new optional `seo.serp.provider` config key selecting which SERP implementation serves the `serp` capability; (3) a widened `SeoCapability` (5 → 7, adding `ai-visibility` and `link-graph`) plus new query/row types and widened `DataProvenance` / `SeoReport`; and (4) two new **required** `SeoDataSource` seam methods (`aiVisibility`, `linkGraph`) with `{ kind: 'disabled' }` arms on every existing implementer. No AI-visibility adapter, crawler, SERP router, never-encode filter, or builder ships this sprint — those are later sprints (nonGoal). This is pure typed plumbing; nothing new runs and no network client was added.

## Public surface

- `SeoEgressAxis` (`src/seo/egress.ts:5`) — widened to the four-member union `"search-console" | "serp-provider" | "ai-visibility" | "site-crawl"`.
- `SeoEgressGuard` (`src/seo/egress.ts:19`) — `constructor` gains two new **defaulted** params (`aiVisibility = false`, `siteCrawl = false`) so the ~28 existing 2-arg call sites keep compiling untouched; `fromConfig` reads all four axes from `config.seo?.egress?.[axis] ?? false`; `isAllowed`/`assertAllowed` keep the exhaustive `never`-typed switch covering all four.
- `seo.egress["ai-visibility"]` (`src/config/schema.ts:682`) — `z.boolean().default(false)`; gates live AI-visibility/GEO provider egress.
- `seo.egress["site-crawl"]` (`src/config/schema.ts:684`) — `z.boolean().default(false)`; gates damcrawler-backed crawl / URL-coverage / link-graph / SERP-scrape egress.
- `seo.serp.provider` (`src/config/schema.ts:708-711`) — optional `{ provider: z.enum(["dataforseo","damcrawler"]).default("dataforseo") }`. The **inner** default on `provider` (not an outer default on the whole `serp` object) keeps a config that omits `serp` byte-identical.
- `SeoCapability` (`src/seo/data-source.ts:26`) — widened 5 → 7 (`+ "ai-visibility" | "link-graph"`); a closed union, so any exhaustive `Record<SeoCapability, …>` is forced to account for both new members.
- `AiVisibilityQuery` (`src/seo/data-source.ts:61`) — `{ target; prompts[]; locale? }`; one batch of AI-answer probe prompts against a target.
- `LinkGraphQuery` (`src/seo/data-source.ts:64`) — `{ rootUrl; limit? }`; a site-crawl internal-link-graph query.
- `AiVisibilityRow` (`src/seo/data-source.ts:121`) — one AI-answer probe result per (prompt, provider): `{ prompt; provider; mentioned; rank?; citationPresent; sourceUrls[] }` (`citationPresent`/`sourceUrls` distinct from a bare `mentioned`).
- `LinkGraphRow` (`src/seo/data-source.ts:134`) — one flat link edge `{ fromUrl; toUrl; anchor?; internal }` (flat rows, not a nested graph).
- `CrawlPageRow` (`src/seo/data-source.ts:143`) — one crawled page's already-sanitized content `{ url; title?; content }` (no `Query` pair this sprint).
- `SeoDataSource.aiVisibility(q)` / `SeoDataSource.linkGraph(q)` (`src/seo/data-source.ts:165-166`) — **required** interface members returning `Promise<DataOutcome<…[]>>`. Required (not optional) so a future missing implementer is a compile error, not a silent gap.
- `DataProvenance.source` (`src/seo/types.ts:41`) — widened with `"ai-visibility"` and `"damcrawler"` (additive; no consumer exhaustively switches on `source`).
- `SeoReport.droppedNeverEncode` (`src/seo/types.ts:112`) — new **required** `number` counter mirroring `droppedUncited`. The `NeverEncodeFilter` that populates it ships in a later sprint (F2); every `SeoReport` built this sprint sets it to `0`.

## How to use / how it fits

This sprint only widens seams; nothing new runs on its own and no adapter serves the two new capabilities yet. Every existing implementer of the seam — `LocalExportSource`, `GscAdapter`, `DataForSeoAdapter`, and the runner's private `CompositeSeoSource` — returns `{ kind: 'disabled' }` from both new methods, so a call resolves to the same three-arm `DataOutcome` idiom the rest of the pipeline already handles:

```ts
const guard = SeoEgressGuard.fromConfig(config);
guard.assertAllowed("ai-visibility"); // throws unless config.seo.egress["ai-visibility"] === true
// ...
const out = await source.linkGraph({ rootUrl: target }); // { kind: "disabled" } this sprint
```

`LocalExportSource` deliberately narrows its file-backed set to a `FileBackedCapability` alias (the original five) rather than an exhaustive `Record<SeoCapability, …>`, so `CAPABILITIES` / `FILE_BASENAME` still compile after the union widened to seven — `ai-visibility`/`link-graph` have no local file/mapper yet (F5/F7 wire the offline arms). The offline default path is unchanged: omit `seo` and every workflow runs byte-identically to before.

## Notes for maintainers

- **Byte-identical-when-off is the load-bearing invariant and is enforced by test, not eyeballing.** Both new egress keys are `z.boolean().default(false)` nested inside the already-`.optional()` `egress` object, and the new `serp` object is `.optional()` with the default on the *inner* `provider` field — so a config omitting `seo` still resolves deep-equal to the pre-change golden snapshot (`SeoConfigSchema.parse({})` leaks only `blockThreshold`; assertion at `schema.test.ts:978-985`). Do not add an outer default to `serp` or move a default up to the `seo` top level — that would break the snapshot (that is the point).
- **The four axes are independent and all fail closed.** Opting one in never opts another in; `assertAllowed` throws for any not-opted-in axis. The two new axes are wired into the guard/schema but **no adapter consumes them yet** — enabling `ai-visibility`/`site-crawl` today is inert (no network path exists until later sprints).
- **`aiVisibility`/`linkGraph` are REQUIRED seam members on purpose.** A future data source that forgets them is a compile error. Any new implementer must add both, even if only as a `{ kind: 'disabled' }` arm.
- **`droppedNeverEncode` is a placeholder this sprint.** Every `SeoReport` literal (notably in `runner.ts`) hardcodes `droppedNeverEncode: 0`; the real `NeverEncodeFilter` (F2) wires the counter in a later sprint. The `report-store` test fixture was updated to include the new required field.
- **No network, no new deps, no damcrawler import.** The evaluator grepped `src/seo/` and confirmed zero http/damcrawler imports; `selectSource`'s predicate was left as-is (its 4-axis rewrite is Sprint 9).

## Scope

One commit — `d4581b6` — touching `src/config/schema.ts`, `src/seo/egress.ts`, `src/seo/data-source.ts`, `src/seo/types.ts`, `src/seo/runner.ts` (the private `CompositeSeoSource` disabled-arms + the `droppedNeverEncode: 0` placeholder), the three source adapters (`local-export.ts`, `gsc-adapter.ts`, `dataforseo-adapter.ts`), and the collocated tests (`schema.test.ts`, `egress.test.ts`, `report-store.test.ts`). All 5 required criteria (sc-1-1..1-5) passed on **iteration 1**; build/typecheck/lint clean; full suite **4518 passed | 1 skipped | 0 failed**, zero regressions.
