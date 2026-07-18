# perplexity-ui parser + production wiring (scrape arm + judge) + benchmark — Hybrid complete (11 of 11)

**Contract:** sprint-spec-20260718-in-house-ai-visibility-11  ·  **Spec:** spec-20260718-in-house-ai-visibility  ·  **Completed:** 2026-07-18

## What this sprint added

The **final** sprint of the in-house AI-visibility Hybrid. It closes the two
`KNOWN LIMITATION` boxes the earlier sprints left open — the Sprint-8 **judge** and the
Sprint-10 **scrape arm** were both fully built + unit-tested but **inert in a real run** because
`runner.ts`'s `defaultAiVisibilityDeps()` supplied neither a `ScrapeThrottle` nor a judge-llm
builder. This sprint lands both **production wirings** (config flags are now live at ship), adds
the scrape arm's **second live engine** (`perplexity-ui`) via a new pure `PerplexityUiScrapeParser`,
and proves every load-bearing invariant end-to-end through the **real** `resolveAiVisibilityProvider`/
`selectSource` factory with an adversarial benchmark. `docs/seo.md` was finalized in the **same
commit** (see below). With this the Hybrid is complete: **3 grounded-API engines** (anthropic /
openai / perplexity) + a **gated damcrawler scrape arm** with **2 engines** (chatgpt-ui /
perplexity-ui), all behind two default-off egress axes, signals never merged.

## Public surface

- `class PerplexityUiScrapeParser implements EngineScrapeParser` (`src/seo/sources/engine-scrape-parser-perplexity.ts:120`) —
  a **PURE, synchronous, dependency-free** `RawScrape -> ParsedAnswer{answerText, citations}`,
  mirroring `ChatgptUiScrapeParser`'s contract for Perplexity-UI answer-page markdown. Never
  throws; empty/whitespace/malformed input ⇒ `{answerText: "", citations: []}` — never fabricates
  a positive observation. `ScrapeArmEngineProvider` is its only caller and invokes `.parse()`
  strictly **after** the raw markdown has passed the fail-closed `ContentSanitizer`.
- `function scrapeUrlFor(engine: ScrapeEngine, prompt: string): string` (`src/seo/sources/scrape-arm-provider.ts:96`) —
  replaces Sprint 10's `chatgptUiUrlFor`. An **exhaustive `switch`** over `ScrapeEngine`
  (`chatgpt-ui` ⇒ `https://chatgpt.com/?q=…`, `perplexity-ui` ⇒
  `https://www.perplexity.ai/search?q=…`; `never`-typed default surfaces any future unhandled
  engine at compile time). Target is provider-constructed from the prompt text alone (no
  caller-supplied URL, hence no SSRF guard — the `DamcrawlerSerpProvider` rationale).
- `interface AiVisibilityDeps` (`src/seo/ai-visibility-provider.ts:174`) — gains **two optional**
  fields: `makeJudgeLlm?: () => { client: LLMClient; model: string } | undefined` (the judge-llm
  builder seam) and `scrapeLoad?: DamcrawlerScrapeLoader` (test-only injection of the scrape
  loader; `undefined` in production ⇒ each `ScrapeArmEngineProvider` uses its own real lazy
  `damcrawler` import). Both absent ⇒ existing callers byte-identical.
- `function defaultAiVisibilityDeps(config: BoberConfig, projectRoot: string): AiVisibilityDeps` (`src/seo/runner.ts:225`) —
  the production deps builder, **now signature-changed** to take `config` + `projectRoot` (was
  zero-arg). Builds `scrapeThrottle` from `config.seo.aiVisibility.scrape` (path under
  `projectRoot`, caps from config) **only when that section is present** (no-config-safe), and a
  no-key-safe `makeJudgeLlm` **only when `config.seo.aiVisibility.judge?.enabled`** (returns
  `undefined` before `createClient` when `ANTHROPIC_API_KEY` is absent).
- `function scrapeThrottleLedgerPath(projectRoot: string): string` (`src/seo/runner.ts:203`) —
  `.bober/seo/scrape-throttle-ledger.json`, a **distinct path** from `quotaLedgerPath`'s
  `quota-ledger.json` (the arch's two-independent-ledgers cost model; never cross-reconciled).

## How to use / how it fits

Both wirings are driven purely by config — no new CLI, no new deps. The factory
(`resolveAiVisibilityProvider`) now composes:

- **Judge (API arms only):** when `config.seo.aiVisibility.judge.enabled` **and**
  `deps.makeJudgeLlm()` resolves an llm, every API arm's extractor is a **shared**
  `LlmJudgeMentionCitationExtractor` wrapping a fresh `DeterministicMentionCitationExtractor` (the
  judge always *composes* the deterministic pass, never replaces it). Judge-disabled / no-llm ⇒
  `apiExtractor` stays exactly `deps.extractor` — **byte-identical**, no judge constructed at all.
  The scrape arm(s) are **never** judge-wrapped (contract: "for each API arm").
- **Scrape arms:** when the `ai-visibility-scrape` axis is on **and** `deps.scrapeThrottle` is
  present **and** `cfg.scrape` exists, one `ScrapeArmEngineProvider` is composed **per engine** in
  `cfg.scrape.engines` (`chatgpt-ui` and/or `perplexity-ui`), each with its matching
  `EngineScrapeParser` (`parserFor`).

```ts
// the two composition sites in resolveAiVisibilityProvider (src/seo/ai-visibility-provider.ts)
let apiExtractor: MentionCitationExtractor = deps.extractor;
if (cfg.judge?.enabled) {
  const judge = deps.makeJudgeLlm?.();
  if (judge) apiExtractor = new LlmJudgeMentionCitationExtractor(
    new DeterministicMentionCitationExtractor(), judge.client, judge.model, sanitizer);
}
// ...
if (scrapeAxisOn && deps.scrapeThrottle && cfg.scrape) {
  for (const engine of cfg.scrape.engines) {
    arms.push(new ScrapeArmEngineProvider(egress, engine, parserFor(engine), /* … */));
  }
}
```

**Pitfall 1 (unchanged, now load-bearing in prod):** the scrape arm is routed through the LOCKED
`AiVisibilityAdapter`'s `ai-visibility` gate, so **both** `ai-visibility` **and**
`ai-visibility-scrape` must be on for a scrape arm to produce rows in a real run — turning on
`ai-visibility-scrape` alone still abstains at the adapter.

The full user-facing reference (both arms, both engines, the two axes, metric definitions +
Wilson CIs, tracked-prompt file format, judge + scrape config, the honest "API-view vs
what-users-see" caveat) was updated in **this same commit** in
[`docs/seo.md`](../seo.md) — see its `#### Production wiring — scrape arm + LLM judge (Sprint 11)`
and `#### Honest caveat — API-view vs what users see (never mix signals)` subsections. This sprint
record does not duplicate that content.

## Notes for maintainers

- **`defaultAiVisibilityDeps` is no longer zero-arg.** Its sole caller is `selectSource`, which now
  passes `defaultAiVisibilityDeps(config, projectRoot)` when no test `deps` are injected. The
  all-off byte-identical predicate + the offline `LocalExportSource` fallback are **unchanged** —
  with both axes off, `selectSource` returns `LocalExportSource` with zero sockets before any of
  this construction runs.
- **`tsc` stays clean without `damcrawler`.** Verified by the evaluator with the peer dep genuinely
  absent (`tsc --noEmit` + `tsc -p tsconfig.test.json`, both exit 0). The scrape loader remains a
  variable-indirection lazy `import(mod)`; production never sets `scrapeLoad` (tests inject a fake
  module).
- **Adversarial benchmark** — `src/seo/benchmark/ai-visibility-benchmark.test.ts` (new, 6 tests)
  drives the **real** factory/`selectSource` (not mocks) and asserts the five invariants:
  (a) byte-identical-when-off ⇒ `LocalExportSource`, zero fetch/createClient; (b) no-key-safe
  fallback; (c) fail-closed `ContentSanitizer` on **both** API and scrape content (role-marker /
  `<system>` stripped before extract ⇒ `mentioned:false`); (d) API + 2 scrape arms on the same
  prompt keep **3 distinct `(prompt, provider)` groups** through the scorer — signals never merged;
  (e) fail-closed `CitationVerifier` (site-crawl off ⇒ `sourceUrls: []`).
- **Judge is API-arms-only and fail-safe.** A judge verdict can only flip a deterministic
  `mentioned:false` → `true` on a non-empty answer; `citationPresent`/`sourceUrls` always come from
  the deterministic pass. All the Sprint-8 fail-safe paths (thrown `chat`, unparseable verdict,
  empty answer) still fall back to the deterministic result verbatim.
- **One pre-existing test updated (not scope creep):** a Sprint-10 test (`sc-10-4`) asserted
  `perplexity-ui` composed nothing; `sc-11-1` makes it live, so that single premise was corrected —
  a direct consequence of this sprint's scope.
- **Follow-up (out of scope, deferred):** no live browser/API smoke run for the scrape endpoints or
  the grounded-API spine — everything is fixture-tested. A live run needs real provider keys +
  `damcrawler` installed + operator-supplied `authSession`/`proxy`.

## Scope

One commit — `3180a3c` — 9 files, +1144/−113. New: `engine-scrape-parser-perplexity.ts` (+ 12
fixture tests), `benchmark/ai-visibility-benchmark.test.ts` (6 adversarial tests through the real
factory). Modified: `scrape-arm-provider.ts` (`scrapeUrlFor` exhaustive switch),
`ai-visibility-provider.ts` (+ optional `makeJudgeLlm`/`scrapeLoad` deps, judge-wrap + per-engine
scrape loop, + 5 judge-wiring tests), `runner.ts` (`defaultAiVisibilityDeps(config, projectRoot)`
builds a real `ScrapeThrottle` + no-key-safe `makeJudgeLlm`; all-off predicate + entry untouched),
`runner.test.ts` (real-`selectSource` production-wiring tests), `docs/seo.md` (finalized; 0
`deferred`/`INERT`/`not yet wired` hits). All 7 required criteria (sc-11-1..11-7) passed on
**iteration 1**; typecheck/build clean **with `damcrawler` genuinely absent**, eslint 0 errors;
`npm run update-all` **0 drift across 5 projects**; full suite **4959 passed | 1 skipped | 0
failed** (+27 new, 0 regressions). **Final sprint — the in-house AI-visibility Hybrid is 11 of 11
complete.**
