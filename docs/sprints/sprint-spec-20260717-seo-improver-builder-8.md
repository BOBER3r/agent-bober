# SerpProvider port + DataForSEO + damcrawler SERP providers

**Contract:** sprint-spec-20260717-seo-improver-builder-8  ·  **Spec:** spec-20260717-seo-improver-builder  ·  **Completed:** 2026-07-17

## What this sprint added

This sprint introduces a **provider-agnostic `SerpProvider` port** (mirroring the
ADR-5 `AiVisibilityProvider` shape) so the `serp` capability can be served either by
the licensed, USD-metered DataForSEO API or by a zero-cost damcrawler scrape — selected
by `config.seo.serp.provider` (default `"dataforseo"`, byte-identical to today). Two
implementations ship: **`DataForSeoSerpProvider`**, a single-line delegate over the
existing already-gated `DataForSeoAdapter.serp` path (USD is booked **inside** the
wrapped adapter — never re-booked here, so no double-charge), and
**`DamcrawlerSerpProvider`**, a zero-USD scrape via damcrawler's `search()` that is
gated by the **`site-crawl`** axis (ADR-10 — the same Playwright/anti-bot/ToS risk
surface as the crawler, deliberately **not** `serp-provider`).

Per **ADR-11**, the scraped `title` and `url` (both attacker-influenced free-text) pass
through `ContentSanitizer` at the network→in-process boundary before any row can reach
the analyzer prompt. The factory is **not yet wired into the runner's
`selectSource`/router** (Sprint 9, an explicit nonGoal) — `schema.ts` and `runner.ts`
are byte-identical this sprint, so with everything off a `bober seo` run is unchanged.

## Public surface

- `SerpProvider` interface (`src/seo/serp-provider.ts:36`) — the port:
  `{ readonly name: "dataforseo" | "damcrawler"; readonly estCostUsdPerResult: number;
  serp(keyword: string, location: string): Promise<DataOutcome<SerpRow[]>> }`. The
  method is degrade-safe (`disabled`/`abstain`/`data`) and **never throws** — both
  implementers uphold this. `estCostUsdPerResult` is metadata only (a caller reading it
  never books anything).
- `resolveSerpProvider(config, dataForSeoAdapter, egress)` (`src/seo/serp-provider.ts:55`)
  — the `config.seo.serp.provider` selection factory (default `"dataforseo"`). Does **no**
  gating itself; each returned provider self-asserts its own egress axis on `.serp()`.
  Mirrors `selectSource` in shape but is not wired into it (Sprint 9); callers construct
  and inject it directly.
- `DataForSeoSerpProvider` (`src/seo/sources/dataforseo-serp-provider.ts:31`) —
  `name="dataforseo"`, `estCostUsdPerResult=0.0006`. Constructed with a
  `DataForSeoAdapter`; `serp()` is a single delegating call to `adapter.serp({keyword,
  location})`. Does no HTTP, no egress check, and **no USD booking of its own** — the
  wrapped adapter already asserts the `serp-provider` axis, gates the governor, and books
  the actual USD (`0.0006`) only after a successful round-trip. Output is byte-identical
  to calling the adapter directly.
- `DamcrawlerSerpProvider` (`src/seo/sources/damcrawler-serp-provider.ts:69`) —
  `name="damcrawler"`, `estCostUsdPerResult=0`. Constructed with just a `SeoEgressGuard`
  (plus injectable loader/clock/limit seams for tests). `serp()` is guard-first
  (`egress.assertAllowed("site-crawl")` **before any import**), lazy-imports damcrawler,
  calls `search(keyword, {limit, country: location})`, sanitizes each result's `url` and
  `title` via `ContentSanitizer`, and maps to `SerpRow` (`position = index + 1`, `title`
  set only when non-empty). Books **zero USD** — no governor is injected or consulted.
- `DamcrawlerSearchModule` / `DamcrawlerSearchLoader`
  (`src/seo/sources/damcrawler-serp-provider.ts:43,52`) — the narrow local view of the
  only damcrawler surface this provider calls (`search` + `sanitize`), plus the loader
  seam whose default performs the lazy `import()` via a `string`-variable specifier
  (so `tsc --noEmit` stays clean whether or not the optional dep is installed).

## How to use / how it fits

Nothing new to invoke on the CLI, and both axes stay inert end-to-end — the runner does
not select these providers until Sprint 9. `config.seo.serp.provider` already parses
(`"dataforseo" | "damcrawler"`, default `"dataforseo"`; `src/config/schema.ts:708`) but
naming `"damcrawler"` does not change a `bober seo` run yet. The providers are usable
only when constructed directly (as the tests do). Note the **cross-axis gating**: the
DataForSEO provider is gated by `serp-provider`, but the damcrawler provider is gated by
`site-crawl` (ADR-10) — so `resolveSerpProvider(configWithProvider:"damcrawler", …)`
returns `data` with `serp-provider` **off** and `site-crawl` **on**. Live use of the
damcrawler path additionally needs the optional `damcrawler`/`playwright` peer deps
(see `docs/seo.md` → *Optional site-crawl deps*).

## Notes for maintainers

- **Never re-book USD in the DataForSEO wrapper.** The adapter books `0.0006` per SERP
  internally; the wrapper's `serp()` body is a single delegating call by design. A second
  `governor.record` here would double-charge and break the byte-identical-to-today
  invariant (the evaluator asserts `spentUsd` advances by exactly `0.0006`, not
  `0.0012`).
- **Axis choice is a security decision (ADR-10).** Routing un-licensed scraping through
  `serp-provider` (which means "licensed, USD-metered DataForSEO egress") would silently
  authorize ToS-gray scraping the operator never consented to. The damcrawler provider is
  therefore on `site-crawl` — same risk surface as the crawler.
- **Sanitize both `title` and `url` (ADR-11).** SERP result text is attacker-influenced
  (the page being ranked controls both), so both fields are cleaned at the
  network→in-process boundary before any row reaches `SeoAnalyzer`'s prompt. The URLs are
  returned as **data** (never fetched by this class), so sanitization — not an SSRF guard
  — is the defense here.
- **Abstain reasons.** axis-off ⇒ `abstain{egress-site-crawl-disabled}` (zero sockets,
  loader never called); optional dep absent ⇒ `abstain{damcrawler-not-installed}`; any
  anti-bot/search/parse error ⇒ `abstain{serp-scrape-error}`. Never throws.
- **Not router-wired (Sprint 9).** Provider selection is not yet threaded into
  `selectSource`; `schema.ts` and `runner.ts` are byte-identical this sprint.

## Scope

One commit — `9810ef6` — six files, +601/−0: new `src/seo/serp-provider.ts` (+64) and
its test (+68); new `src/seo/sources/dataforseo-serp-provider.ts` (+41) and its test
(+130); new `src/seo/sources/damcrawler-serp-provider.ts` (+107) and its test (+191).
All 5 required criteria (sc-8-1..8-5) passed on **iteration 1** (21 new tests): DataForSEO
output byte-identical to direct `adapter.serp`; no USD double-booking; ADR-10 site-crawl
gating proven (serp-provider OFF / site-crawl ON ⇒ `data`); `title` **and** `url`
sanitized; `schema.ts` + `runner.ts` byte-identical (git diff empty); no static damcrawler
import. Build/typecheck clean **with damcrawler/playwright confirmed absent**; lint clean
(2 pre-existing warnings); full suite **4638 passed | 1 skipped | 0 failed**.
