# damcrawler CrawlEngine + ContentSanitizer (optional/peer dep)

**Contract:** sprint-spec-20260717-seo-improver-builder-6  ·  **Spec:** spec-20260717-seo-improver-builder  ·  **Completed:** 2026-07-17

## What this sprint added

This sprint gives the reserved `site-crawl` axis its first backing engine. Two
things landed. First, the **`CrawlEngine` port** (`crawl` / `urlVisibility` /
`linkGraph`, all returning `DataOutcome`) and its **`DamcrawlerCrawlEngine`**
implementation, backed by the `damcrawler` scraper (+ its `playwright` peer) as an
**OPTIONAL peer dependency** loaded only through a lazy `import()` behind the
`site-crawl` egress axis (**ADR-9**). Second, **`ContentSanitizer`**, a fail-closed
wrapper around damcrawler's `sanitize()` that neutralizes prompt-injection in
attacker-controlled crawled page bodies at the network→in-process boundary
(**ADR-11**), before any row can reach `SeoAnalyzer`'s prompt serialization. The
engine is **not yet wired into the runner's `selectSource`/router** — `CrawlSource`
wiring is Sprint 7 (an explicit nonGoal here) — so turning the `site-crawl` axis on
today still changes no `bober seo` run. The whole change is additive: `tsc`/build stay
clean **without** damcrawler/playwright installed, and every existing run path is
byte-identical.

## Public surface

- `CrawlEngine` (`src/seo/crawl-engine.ts:28`) — the ADR-9 port. Three methods:
  `crawl(q: CrawlQuery)`, `urlVisibility(q: UrlInspectionQuery)`,
  `linkGraph(q: LinkGraphQuery)`, each returning a `DataOutcome`. Pure interface +
  the new `CrawlQuery` type (`{ rootUrl; limit?; maxDepth? }`,
  `src/seo/crawl-engine.ts:21`); no runtime code, mirroring `data-source.ts`.
- `DamcrawlerCrawlEngine` (`src/seo/sources/damcrawler-crawl-engine.ts:96`) — the
  `CrawlEngine` impl. Constructed with `(egress, load?, now?)`: `egress` is the
  `SeoEgressGuard`, `load` is an injectable `DamcrawlerLoader` (defaults to the lazy
  dynamic import; tests inject a fake module or `undefined`), `now` is an injectable
  clock for `provenance.retrievedAt`. Guard-first, never-throw. `crawl` serves
  sanitized `CrawlPageRow[]`; `urlVisibility` serves a single `UrlInspectionRow`
  (`visible`→`indexed`, else `not-indexed`); `linkGraph` abstains this sprint
  (`link-graph-unavailable`) because a real graph needs raw HTML but `crawl()` yields
  Markdown (deferred to Sprint 7).
- `DamcrawlerModule` (`src/seo/sources/damcrawler-crawl-engine.ts:65`) — the **narrow**
  local view of the only damcrawler surface this engine calls (`crawl`,
  `probeVisibility`, `sanitize`). Link-graph helpers are deliberately not declared.
- `DamcrawlerLoader` (`src/seo/sources/damcrawler-crawl-engine.ts:79`) — the loader
  seam type `() => Promise<DamcrawlerModule | undefined>`; the default performs the
  variable-indirected dynamic import.
- `ContentSanitizer` (`src/seo/content-sanitizer.ts:37`) — fail-closed sanitizer.
  `clean(text, url)` wraps an injected `SanitizeFn`, returns
  `{ content, hadThreats }`, logs (warn) and strips when `hadThreats`, and on a
  sanitize **throw** returns `{ content: "", hadThreats: true }` (fail-closed drop —
  never passes raw text through). Never throws.
- `SanitizeFn` (`src/seo/content-sanitizer.ts:29`) — the narrow injected sanitize
  signature `(raw, options?) => { content; hadThreats }`. Must be damcrawler's
  `sanitize` (which yields `hadThreats`), **not** `sanitizeWithReport` (returns a bare
  `string`).
- `package.json` — `damcrawler` (`>=0.3.0`) and `playwright` (`>=1.40.0`) added to
  `peerDependencies`, both marked `optional: true` in `peerDependenciesMeta`. **Not**
  in `dependencies` (that would pull Chromium into every install and break
  byte-identical-when-off).

## How to use / how it fits

Nothing new to invoke on the CLI, and the axis is still inert end-to-end (Sprint 7
wires it). To actually crawl, the optional peer deps must be installed and their
browser provisioned:

```bash
npm i damcrawler playwright   # optional peers — absent by default
damcrawler setup              # installs Playwright Chromium (npx playwright install chromium --with-deps) + patchright stealth
```

With the deps absent every `DamcrawlerCrawlEngine` method returns
`abstain{damcrawler-not-installed}` and never throws. With the deps present but the
`site-crawl` axis off, `assertAllowed("site-crawl")` throws on the first line and the
engine returns `abstain{egress-site-crawl-disabled}` **without ever loading**
damcrawler — that is what keeps the offline/all-axes-off path byte-identical (the deps
are never `import()`-ed there). A damcrawler runtime error (BrowserError when Chromium
is absent, TimeoutError, CrawlError, SsrfError) degrades to `abstain{source-error}`.

## Notes for maintainers

- **tsc-clean-without-the-dep technique (ADR-9, briefing Pattern D / Pitfall #4).** A
  literal `import("damcrawler")` is statically resolved by tsc under
  `moduleResolution: NodeNext` and fails with **TS2307** when the dep is absent. The
  loader routes the specifier through a `string` variable
  (`const mod = "damcrawler"; await import(mod)`), which makes tsc treat the result as
  `any`, so `tsc --noEmit` stays green whether or not damcrawler is installed. This is
  the make-or-break invariant the evaluator confirmed (build + typecheck passed with
  the deps confirmed **absent**). There must be **zero** static `from "damcrawler"` /
  `from "playwright"` imports anywhere under `src/seo/`.
- **Do not `instanceof BrowserError` / `import { BrowserError }`.** The typed error
  classes cannot be imported without the dep. The catch-all `→ abstain{source-error}`
  covers every failure mode; if you must differentiate, branch on
  `(err as {name?: string}).name` — no import.
- **Two LATENT security findings were carried into Sprint 7 as HARD requirements**
  (audit: `.bober/security/sprint-spec-20260717-seo-improver-builder-6-security-audit.md`).
  Both are unreachable end-to-end today (nothing wires `CrawlSource` into the analyzer
  until Sprint 7) and were accepted as non-blocking for Sprint 6:
  - **F1 — injection (sev 3): unsanitized `title`/`url` in `CrawlPageRow`.** `crawl()`
    sanitizes only the page body (`markdown`→`content`); it copies `title` and `url`
    **verbatim**, yet `CrawlPageRow`'s docstring asserts the row is fully sanitized and
    `SeoAnalyzer` `JSON.stringify`s the whole row into its LLM prompt. Sprint 7 must
    run `title`/`url` through `ContentSanitizer.clean()` too.
  - **F2 — SSRF (sev 2): protection delegated entirely to the optional dep.**
    Caller-supplied crawl/probe URLs go straight to `dam.crawl`/`dam.probeVisibility`
    with no engine-boundary check; protection relies solely on damcrawler throwing
    `SsrfError`. Sprint 7 must add an engine-boundary `assertSafeUrl` (or an in-repo
    private/link-local/loopback/metadata + non-http(s) guard) before crawl/probe.
- **`linkGraph` intentionally abstains this sprint** rather than fabricate a partial or
  empty graph — swap for real HTML-based extraction
  (`extractPageLinks`/`filterLinks`) when Sprint 7 wires `CrawlSource`.
- **No quota governor here.** Local crawling has no USD cost (ADR-9), so unlike the
  DataForSEO / AI-visibility adapters this engine books nothing.

## Scope

One commit — `b2bd459` — six files, +633/−1: new `src/seo/crawl-engine.ts` (+32),
`src/seo/sources/damcrawler-crawl-engine.ts` (+174) and its test (+292),
`src/seo/content-sanitizer.ts` (+61) and its test (+65); `package.json` (+10/−1, the
optional peer-dep entries). All 5 required criteria (sc-6-1..6-5) passed on
**iteration 1**; build/typecheck clean **with damcrawler/playwright confirmed absent**;
lint clean; full suite **4592 passed | 1 skipped | 0 failed** (30 new sprint-6 tests,
zero regressions).
