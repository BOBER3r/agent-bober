# CitationVerifier + fail-closed sanitization boundary

**Contract:** sprint-spec-20260718-in-house-ai-visibility-4  ·  **Spec:** spec-20260718-in-house-ai-visibility  ·  **Completed:** 2026-07-18

## What this sprint added

Two fail-closed safety boundaries on the live grounded-API spine (Sprint 3's first live
slice). First, a damcrawler-backed **`DamcrawlerCitationVerifier`** that — gated by the
existing `site-crawl` axis — live-scrapes each candidate cited URL a grounded answer
surfaced, and **fail-closed drops any URL it cannot verify**, so only URLs that scraped
without error (`live === true`) reach an `AiVisibilityRow.sourceUrls`. Second, every piece
of grounded free-text (the LLM's `answerText` **and** every candidate citation URL) is now
routed through the fail-closed **`ContentSanitizer`** at the network→in-process boundary
**before** any row is constructed — closing the same prompt-injection surface the Sprint-9
F1 lesson forbids leaving open. Both are wired into `ApiSpineEngineProvider`, and a single
shared verifier + sanitizer pair is injected from the sole production construction site,
`resolveAiVisibilityProvider`. The build stays `tsc`-clean without `damcrawler` installed
(the verifier uses the same variable-indirection lazy loader as the other damcrawler
adapters).

## Public surface

- `DamcrawlerCitationVerifier` (`src/seo/sources/citation-verifier.ts:134`) — `implements CitationVerifier`. `verify(target, urls)` is guard-first (egress `site-crawl` gate → lazy `import("damcrawler")` → per-url `assertSafeUrl` SSRF guard → `scrape`), sanitizes the scraped title/body via `ContentSanitizer(dam.sanitize)`, and returns exactly one `VerifiedCitation` per input url, in order. **Never throws, never fabricates a live citation** — every fail path degrades to `{ live:false, brandOnPage:false }`.
- `CitationVerifier` (`src/seo/sources/citation-verifier.ts:41`) — the port: `verify(target: string, urls: string[]): Promise<VerifiedCitation[]>`.
- `VerifiedCitation` (`src/seo/sources/citation-verifier.ts:39`) — `{ url: string; live: boolean; brandOnPage: boolean }`. `live` means "scrape succeeded without an `.error`" (damcrawler's `ScrapeResult` exposes no numeric HTTP status), not literally HTTP 200. `brandOnPage` is a word-boundary brand-token match computed over the **sanitized** body/title only.
- `DamcrawlerVerifyLoader` (`src/seo/sources/citation-verifier.ts:72`) — the loader seam; the default performs the variable-indirection lazy `import("damcrawler")` (returns `undefined` when the optional peer dep is absent), tests inject a fake module.
- `defaultGroundedTextSanitizeFn(raw)` (`src/seo/ai-visibility-provider.ts:72`) — exported `SanitizeFn`. A **real, dependency-free, synchronous** injection-stripper (NOT an identity/no-op) that removes recognized role-marker tags (`<system>`/`<|im_start|>`-style) and "ignore previous instructions" phrasing, returning `{ content, hadThreats }`. This is what `ContentSanitizer` wraps at the grounded-text boundary.
- `ApiSpineEngineProvider` constructor (`src/seo/sources/api-spine-provider.ts:62`) — gains two **required** deps: `verifier: CitationVerifier` and `sanitizer: ContentSanitizer` (after the existing `client`, `extractor`, `samplesPerPrompt`, `perCallUsd`). Its `probe()` now sanitizes `answerText` + each candidate URL, then verifies URLs and retains only `live === true` ones in `row.sourceUrls`.

## How to use / how it fits

No new config or CLI surface — this sprint hardens the existing `ai-visibility` axis. The
wiring is transparent to the operator: `resolveAiVisibilityProvider(config, egress, deps)`
(`src/seo/ai-visibility-provider.ts`) constructs **one** `DamcrawlerCitationVerifier(egress)`
and **one** `ContentSanitizer(defaultGroundedTextSanitizeFn)` and injects the same pair
into every `ApiSpineEngineProvider` arm (the verifier self-gates `site-crawl` on each
`verify()` call and holds no per-arm state, so sharing is safe).

Two boundaries then apply inside `probe()`, in order, **before** any row is emitted:

1. **Sanitize** (always on): `answerText` and every candidate citation URL pass through the
   `ContentSanitizer`. A thrown sanitize function fails closed (empty text ⇒ the extractor
   sees nothing to match). Spy-order assertion: `[sanitize:text, sanitize:url, verify, row]`.
2. **Verify** (gated by `site-crawl`): each sanitized candidate URL is scraped; only
   `live === true` URLs survive into `row.sourceUrls`. With `site-crawl` off, `damcrawler`
   absent, or a scrape error, the URL is dropped — `mentioned`/`citationPresent` can still
   be `true` from the offline extractor, but `sourceUrls` narrows (e.g. site-crawl off ⇒
   `sourceUrls === []`).

So a citation only ever ships a `sourceUrl` if the `ai-visibility` axis surfaced it **and**
the `site-crawl` axis re-verified it live — a URL that cannot be independently confirmed
never reaches a row.

## Notes for maintainers

- **The grounded-text sanitizer is deliberately a second, separate boundary — not damcrawler's.** `answerText` + citation URLs come straight from `GroundedSearchClient.search()` (not scraped), and `ContentSanitizer` requires a **synchronous** `SanitizeFn` while any damcrawler `sanitize` export is only reachable via an async lazy `import()` — and `resolveAiVisibilityProvider` is itself synchronous. So `defaultGroundedTextSanitizeFn` is dependency-free and always on. damcrawler's real async `sanitize` stays load-bearing for the actual scraped citation **body** inside `DamcrawlerCitationVerifier`. Making this an identity/no-op sanitizer would be exactly the fake-ceiling the Sprint-9 F1 lesson forbids at a named security boundary.
- **`live` ≠ HTTP 200 literally.** damcrawler's batch-mode `ScrapeResult` has no numeric status field; a missing result row or a non-empty `.error` string is the only failure signal, so `live` means "scraped without an `.error`".
- **Cost accounting is unaffected by verification.** Verifier errors stay inside `probe` (fail-closed, `live:false`) and never throw out of the sample loop, so the adapter's book-only-after-successful-probe USD accounting is unchanged.
- **Reused the existing `site-crawl` axis** for verification (a contract nonGoal was to *not* add a new egress axis) and reused the guard-first/lazy-load/never-throw damcrawler-adapter pattern.
- **Follow-up — citation TITLE text is not yet sanitized.** sc-4-3 scopes the grounded-text boundary to `answerText` + citation **URLs** only. A citation's `title` is LLM-echoable free text; extending the sanitize boundary to `citation.title` in `api-spine-provider.ts` is an in-contract, later-sprint candidate (evaluator `generatorFeedback`, priority low; report note). Not a defect — deliberately out of this sprint's scope.
- **Follow-up — no automated live smoke coverage.** Every test injects fake deps / a fake grounded client, keeping the suite network-free; the live grounded-API-spine egress path (and the live damcrawler scrape in the verifier) has no automated smoke test yet and needs real engine keys + `damcrawler` installed to exercise end-to-end.

## Scope

One commit — `7a5702f` — matching `estimatedFiles`: new `src/seo/sources/citation-verifier.ts`
(+ `.test.ts`, 16 tests), `src/seo/sources/api-spine-provider.ts` (+ `.test.ts`, +7 tests),
plus the sole production construction site `src/seo/ai-visibility-provider.ts` (+ `.test.ts`,
+5 tests: an e2e fail-closed `sourceUrls` test through the real factory + 4 for
`defaultGroundedTextSanitizeFn`). **No new dependencies** (`git diff` on deps empty). All 4
required criteria (sc-4-1..4-4) passed on **iteration 1**; typecheck/build/lint clean;
`tsc` clean **without** `damcrawler` installed; full suite **4816 passed | 1 skipped | 0
failed** (+28 new tests, 0 regressions; the 4 touched files 86/86 green).
