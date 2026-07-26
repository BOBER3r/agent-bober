# ScrapeArmEngineProvider + EngineScrapeParser (chatgpt-ui) — gated scrape arm live

**Contract:** sprint-spec-20260718-in-house-ai-visibility-10  ·  **Spec:** spec-20260718-in-house-ai-visibility  ·  **Completed:** 2026-07-18

## What this sprint added

The Hybrid AI-visibility signal has two arms: the **BYOK grounded-API spine** (live since
Sprint 3) and a separately-gated **damcrawler UI-scrape arm**. This sprint delivers the scrape
arm's **first live engine** end-to-end: a **`ScrapeArmEngineProvider`** that self-asserts the
`ai-visibility-scrape` egress axis as `probe()`'s **first statement**, lazy-loads `damcrawler`
via variable indirection (so `tsc` stays clean without the peer dep), scrapes the ChatGPT UI *N*
times per prompt, **sanitizes** the raw markdown through the fail-closed `ContentSanitizer`
**before** a pure **`ChatgptUiScrapeParser`** runs, extracts + verifies, meters proxy spend
through the Sprint-9 `ScrapeThrottle`, and emits rows labeled **`"chatgpt-ui"`** — never mixed
with the API arms. `resolveAiVisibilityProvider` now composes this arm into the **same**
multiplexer as the API spine, triple-gated behind an **optional** `AiVisibilityDeps.scrapeThrottle`
+ the scrape axis + `config.seo.aiVisibility.scrape.engines`. The config schema gains an optional
`scrape` sub-object. This is the first live consumer of the `ai-visibility-scrape` axis, which was
axis-only from Sprint 3.

## Public surface

- `class ScrapeArmEngineProvider implements AiVisibilityProvider` (`src/seo/sources/scrape-arm-provider.ts:103`) —
  guard-first / lazy-load / throttle-metered / sanitize-before-parse / never-throw scrape arm.
  `estCostUsdPerPrompt = 0` (books **zero** USD to the `SeoQuotaGovernor`; real proxy cost lives
  in the `ScrapeThrottle` ledger). `probe(target, prompts, locale?)` returns `AiVisibilityRow[]`,
  each stamped `provider = "chatgpt-ui"`.
- `type ScrapeEngine = "chatgpt-ui" | "perplexity-ui"` (`src/seo/sources/scrape-arm-provider.ts:55`) —
  scrape-arm engine labels. This sprint constructs **only** `"chatgpt-ui"`; `"perplexity-ui"` is a
  valid enum value with **no live parser yet** (Sprint 11).
- `interface DamcrawlerScrapeModule` (`src/seo/sources/scrape-arm-provider.ts:65`) — the narrow,
  locally-defined view of the only `damcrawler` surface the arm calls (`scrape` + `sanitize`);
  never imported from the real dep, so tests never need the package.
- `type DamcrawlerScrapeLoader` (`src/seo/sources/scrape-arm-provider.ts:74`) — the loader seam;
  `defaultLoader` performs the lazy `import(mod)` (variable-indirection, `tsc`-clean without the
  dep); tests inject a fake module or `undefined` to simulate the dep being absent.
- `class ChatgptUiScrapeParser implements EngineScrapeParser` (`src/seo/sources/engine-scrape-parser-chatgpt.ts:119`) —
  **PURE, synchronous, dependency-free** `RawScrape -> ParsedAnswer{answerText, citations}`.
  Strips a trailing `Sources`/`Citations`/`References` block for `answerText`; extracts markdown
  links, autolinks, then bare URLs (deduped by URL, first-seen title wins) for `citations`. Never
  throws; empty/whitespace/malformed input yields `{ answerText: "", citations: [] }` — never
  fabricates a positive observation.
- `type RawScrape` (`:42`), `type ParsedAnswer` (`:45`), `interface EngineScrapeParser` (`:47`) —
  the parser port + its I/O shapes; `citations` reuses the locked `GroundedCitation` shape.
- `interface AiVisibilityDeps` (`src/seo/ai-visibility-provider.ts`) — gains an **optional**
  `scrapeThrottle?: ScrapeThrottle`. Absent ⇒ the scrape arm never composes (existing callers
  byte-identical).
- `config.seo.aiVisibility.scrape` (`src/config/schema.ts`) — new **optional, no-outer-default**
  sub-object: `engines: ("chatgpt-ui" | "perplexity-ui")[]` (default `[]`), `authSession?: string`,
  `proxy?: string`, `proxyUsdPerScrape: number` (default `0`), `maxPerWindow: number` (default `10`),
  `windowMs: number` (default `60000`), `maxProxyUsd: number` (default `0`). Omitting `scrape`
  entirely is byte-identical; the object being present does **not** itself enable scraping (the
  `ai-visibility-scrape` axis does).

## How to use / how it fits

`ScrapeArmEngineProvider` implements the same `AiVisibilityProvider` port as
`ApiSpineEngineProvider`, so `resolveAiVisibilityProvider` drops it into the **same** `arms` array
and the **one** `AiVisibilityMultiplexer` — the rows stay unmixable because each carries its own
`provider` label and the multiplexer only ever concatenates. The compose gate is triple:

```ts
// in resolveAiVisibilityProvider (src/seo/ai-visibility-provider.ts)
if (scrapeAxisOn && deps.scrapeThrottle && cfg.scrape?.engines.includes("chatgpt-ui")) {
  arms.push(new ScrapeArmEngineProvider(
    egress, "chatgpt-ui", new ChatgptUiScrapeParser(),
    deps.extractor, verifier, deps.scrapeThrottle,
    cfg.samplesPerPrompt, scrapeCfg.authSession, scrapeCfg.proxyUsdPerScrape, scrapeCfg.proxy,
  ));
}
```

Per sample, `probe()` runs: `throttle.acquire(name)` → `dam.scrape([chatgptUiUrlFor(prompt)])` →
`ContentSanitizer.clean(markdown)` **before** `parser.parse` → `extractor.extract` →
`verifier.verify` (retains only `live` URLs) → `throttle.recordProxyCost` (only after a
row-producing scrape) → push one `"chatgpt-ui"` row. The scrape arm builds its **own** sanitizer
from the loaded `damcrawler` module's `sanitize`, not the shared `defaultGroundedTextSanitizeFn`
the API arms use. The `DamcrawlerCitationVerifier` (self-gates `site-crawl`, stateless) is shared
across both arms.

Failure/skip behaviour (never throws): axis off ⇒ `[]` (zero sockets, no loader, no throttle
call); dep absent ⇒ `[]`; a `throttle.acquire` denial skips that one sample; a scrape `.error` /
throw / zero-row drops that sample. On total failure the arm returns `[]` (abstain) rather than
throwing — justified because it books `$0`, so there is no over-book risk (this is a deliberate
divergence from `ApiSpineEngineProvider`, which throws-on-all-fail to protect its non-zero USD).

## Notes for maintainers

- **KNOWN LIMITATION — the arm is composed + tested but NOT yet wired into the production run
  path.** `runner.ts` is **byte-identical** this sprint (verified: `git diff` empty). The
  production `defaultAiVisibilityDeps()` still builds only `{ makeClient, extractor }` and supplies
  **no** `ScrapeThrottle`, so in a real run `config.seo.aiVisibility.scrape` + the
  `ai-visibility-scrape` axis do **not** compose the scrape arm — it is exercised only via
  injected test deps. A `ScrapeThrottle` needs an absolute ledger path this factory has no
  `projectRoot` to construct, so it must arrive already-built via the `AiVisibilityDeps` seam. The
  evaluator flagged this (medium-priority `missing-feature`): the **scrape-arm production wiring**
  (a real `ScrapeThrottle` from `projectRoot`/`config` + a damcrawler scrape loader + auth-session)
  is deferred to **Sprint 11**, alongside the **Sprint-8 judge wiring** (also inert pending its
  runner wiring). Both land production-live at ship.
- **`perplexity-ui` is not live.** The config `engines` enum accepts `"perplexity-ui"`, but the
  factory only ever constructs the `chatgpt-ui` arm; the perplexity-ui parser is a Sprint-11
  nonGoal. Configuring `"perplexity-ui"` alone composes nothing.
- **Sanitize-before-parse is load-bearing, not cosmetic.** Reversing the order (parsing raw
  scraped markdown before it passes the fail-closed `ContentSanitizer`) re-opens the Sprint-9 F1
  prompt-injection regression. The order is spy-asserted (`['sanitize','parse']`).
- **No SSRF guard by design.** The scrape target is provider-constructed from the prompt
  (`chatgptUiUrlFor`), not caller-supplied free text, mirroring `DamcrawlerSerpProvider`'s
  documented rationale. Contrast `DamcrawlerCitationVerifier`, which *does* `assertSafeUrl` its
  caller-supplied candidate URLs.
- **No CAPTCHA-solving / proxy sourcing / auth harvesting / live browser.** The operator supplies
  `authSession`/`proxy` opaquely via config; the arm passes them straight through to
  `dam.scrape` (all nonGoals). Tests fixture the scrape output — no live browser.

## Scope

One commit — `8807c47` — 8 files, +1147/−21. New: `scrape-arm-provider.ts` (+ 15 tests),
`engine-scrape-parser-chatgpt.ts` (+ 12 fixture tests). Modified: `ai-visibility-provider.ts`
(optional `scrapeThrottle` dep; relaxed top-level early-return so a scrape-only config composes;
triple-gated arm push; + 7 compose/no-compose tests incl. API+scrape co-compose no-label-bleed),
`config/schema.ts` (optional `scrape` sub-object; + 6 tests). All 5 required criteria
(sc-10-1..10-5) passed on **iteration 1**; typecheck/build clean **with `damcrawler` genuinely
absent** (real dep-absent abstain test), eslint 0 errors; full suite **4932 passed | 1 skipped |
0 failed** (+40 new, 0 regressions). `runner.ts` + `package.json` byte-identical. No new
dependency.
