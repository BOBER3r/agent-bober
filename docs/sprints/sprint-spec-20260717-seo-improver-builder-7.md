# CrawlSource: url-inspection (probeVisibility) + link-graph

**Contract:** sprint-spec-20260717-seo-improver-builder-7  ·  **Spec:** spec-20260717-seo-improver-builder  ·  **Completed:** 2026-07-17

## What this sprint added

This sprint wires the Sprint-6 crawl engine one layer toward the analyzer with
**`CrawlSource`**, a `SeoDataSource` adapter over `CrawlEngine` that serves two
capabilities and **only** two: `url-inspection` (crawl-native index coverage via
damcrawler `probeVisibility`, no GSC required) and the new `link-graph`
(internal-link edges). Both are **ledger-bounded to the GSC url-inspection
ceiling** (2,000/day/property) — crawling is free of USD cost (**ADR-9**) but
not free of the daily-quantity ceiling, so an over-budget crawl **abstains
instead of over-crawling** — and every free-text field the adapter emits is
**re-sanitized** (defense-in-depth). It also resolves the Sprint-6 `linkGraph`
markdown-vs-HTML gap by switching the engine to damcrawler's
`scrape(formats:["links"])` path, and gives `LocalExportSource` an **offline
link-graph arm** (`link-graph.csv|json`) with a fixture.

Critically, this is the sprint where the Sprint-6 crawl surface becomes
reachable toward `SeoAnalyzer`, so it **closes the two latent security findings**
carried from Sprint 6 (F1 injection, F2 SSRF) — both evaluator-confirmed. The
adapter is **not yet wired into the runner's `selectSource`/router** (GSC-vs-crawl
precedence is Sprint 9 / **ADR-8**, an explicit nonGoal here), so with `site-crawl`
off a `bober seo` run stays byte-identical.

## Public surface

- `CrawlSource` (`src/seo/sources/crawl-source.ts:55`) — `SeoDataSource` adapter
  constructed with `(governor: SeoQuotaGovernor, engine: CrawlEngine, sanitizer:
  ContentSanitizer)`. `capabilities()` returns exactly `["url-inspection",
  "link-graph"]`; `searchAnalytics`/`serp`/`keywords`/`backlinks`/`aiVisibility`
  all return `{ kind: "disabled" }` unconditionally (sc-7-1).
- `CrawlSource.urlInspection(q)` (`src/seo/sources/crawl-source.ts:71`) — books
  `governor.admit({ source:"gsc", capability:"url-inspection", estRows:1,
  estCostUsd:0 })` **before** any engine call; an over-budget decision returns
  `abstain{<reason>}` with **no crawl** (sc-7-2). On engine `data` it re-sanitizes
  each row's `url`, calls `governor.record(req, 0)` **only after** the successful
  engine call, and propagates the engine's own `abstain`/`disabled` unchanged.
- `CrawlSource.linkGraph(q)` (`src/seo/sources/crawl-source.ts:100`) — same GSC
  url-inspection ledger gate (`estRows = q.limit ?? 1`; the crawl consumes the
  same counter regardless of capability, **ADR-6**), then maps to flat
  `LinkGraphRow` edges `{ fromUrl, toUrl, anchor?, internal }` with `fromUrl` /
  `toUrl` / `anchor` re-sanitized.
- `DamcrawlerCrawlEngine.linkGraph` (`src/seo/sources/damcrawler-crawl-engine.ts:204`)
  — **no longer abstains** `link-graph-unavailable`. It now calls
  `scrape([rootUrl], { formats:["links"], limit })`, which internally fetches HTML
  and extracts links, and builds `LinkGraphRow` edges (`internal` = same-origin as
  `rootUrl`). A per-page fetch `error` is skipped; a partial/empty graph is a valid
  `data` outcome (never fabricated, never thrown).
- `DamcrawlerModule` surface widened (`src/seo/sources/damcrawler-crawl-engine.ts:77`)
  — adds `assertSafeUrl(urlString): Promise<void>` (F2 SSRF guard) and
  `scrape(urls, options)` (link extraction) to the narrow local view; `crawl` /
  `probeVisibility` / `sanitize` unchanged.
- `LocalExportSource.linkGraph(q)` (`src/seo/sources/local-export.ts:319`) — the
  offline arm: reads `link-graph.csv|json`, maps via `mapLinkGraphRow`
  (`local-export.ts:232`, header `fromUrl,toUrl,anchor,internal`). Missing file =>
  `disabled`; header-only/empty => `abstain{empty-export}`; the url-inspection
  offline arm is untouched (sc-7-4). `link-graph` is added to `FileBackedCapability`
  / `CAPABILITIES` / `FILE_BASENAME`.
- `src/seo/__fixtures__/imports/link-graph.csv` — offline link-graph fixture
  (header + one internal edge + one external edge).

## How to use / how it fits

Nothing new to invoke on the CLI, and the `site-crawl` axis is **still inert
end-to-end** — the runner does not select `CrawlSource` until Sprint 9 (ADR-8).
`CrawlSource` is usable only when constructed directly (as the tests do) with a
governor, an engine, and a sanitizer. Live use additionally needs the optional
`damcrawler`/`playwright` peer deps installed (see `docs/seo.md` → *Optional
site-crawl deps*). Offline, dropping a `link-graph.csv` (or `.json`) into
`.bober/seo/imports/` now makes `LocalExportSource.linkGraph` serve it with zero
egress, exactly like the other capability files.

## Notes for maintainers — security closure (Sprint-6 F1/F2, evaluator-confirmed)

This sprint's higher-value outcome is closing the two latent findings the Sprint-6
audit deferred here as **hard requirements** (audit:
`.bober/security/sprint-spec-20260717-seo-improver-builder-6-security-audit.md`,
now carrying a `RESOLVED — Sprint 7` section). The lesson is worth keeping:

- **F1 — injection (sev 3): sanitize *every* attacker-controlled free-text field,
  not just the body.** Sprint 6 sanitized only the page body (`markdown`→`content`)
  and copied `title`/`url` verbatim, yet `CrawlPageRow`'s docstring asserts the row
  is fully sanitized and `SeoAnalyzer` `JSON.stringify`s the *whole* row into its
  LLM prompt. **Closed** by sanitizing `url` + `title` + `content` at the engine
  boundary (`damcrawler-crawl-engine.ts:157-159`) **and** re-sanitizing every
  free-text field `CrawlSource` emits (`url`, `fromUrl`, `toUrl`, `anchor`). The
  re-sanitization is deliberate **defense-in-depth**: `CrawlSource` holds its own
  `ContentSanitizer` so an injected/alternate `CrawlEngine` that forgets to clean a
  field still cannot leak a payload into the prompt. Regression tests inject a
  `<system>` payload into `title`/`url` and assert it is stripped from the emitted
  row.
- **F2 — SSRF (sev 2): never delegate the trust boundary to an optional dep.**
  Sprint 6 passed caller-supplied URLs straight to damcrawler, relying solely on
  its internal guard throwing `SsrfError`. **Closed** by an engine-boundary
  `dam.assertSafeUrl(...)` call **after `load()` and before every damcrawler
  network call** in all three methods — `crawl` guards `q.rootUrl`
  (`damcrawler-crawl-engine.ts:145`), `urlVisibility` guards **both** `q.inspectionUrl`
  and `q.siteUrl` (`:180-181`), `linkGraph` guards `q.rootUrl` (`:215`). Any
  rejection degrades to `abstain{ssrf-blocked}`. Regression tests prove
  `http://169.254.169.254/` and `file://` abstain with **zero underlying damcrawler
  calls**, and a safe-URL control confirms the guard is selective (not a blanket
  block). Evaluator `securityVerification`: `F1_injection = closed`,
  `F2_ssrf = closed`.

## Notes for maintainers — general

- **Ledger semantics.** `admit()` gates before the engine is ever touched;
  `record()` runs **only** after the engine returns `data` (an engine abstain books
  nothing). Both `urlInspection` and `linkGraph` book against the **same** GSC
  url-inspection counter (ADR-6) — the crawl consumes that ceiling regardless of
  which capability it serves.
- **Precedence is not decided here.** When both `site-crawl` and `search-console`
  are on, GSC-vs-crawl `url-inspection` precedence is the router's job (Sprint 9 /
  ADR-8). `CrawlSource` is intentionally not in `selectSource` yet.
- **No native graph store (ADR-6).** `link-graph` is flat `LinkGraphRow[]` edges,
  both live and offline — no adjacency structure, by design.

## Scope

One commit — `c87f890` — seven files, +767/−55: new `src/seo/sources/crawl-source.ts`
(+146) and its test (+246); modified `damcrawler-crawl-engine.ts` (F1/F2 + `scrape`
link-graph) and its test (+201); modified `local-export.ts` (offline link-graph arm)
and its test (+50); new `src/seo/__fixtures__/imports/link-graph.csv` (+3). All 5
required criteria (sc-7-1..7-5) passed on **iteration 1**; both carried Sprint-6
security findings independently confirmed **closed**; `tsc`/typecheck/build clean
**with damcrawler/playwright confirmed absent**; lint clean (2 pre-existing warnings);
full suite **4617 passed | 1 skipped | 0 failed**; `runner.ts` untouched, `CrawlSource`
never constructed, byte-identical when `site-crawl` is off.
