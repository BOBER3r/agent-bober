/**
 * ScrapeArmEngineProvider — the damcrawler UI-scrape `AiVisibilityProvider`
 * arm (in-house-ai-visibility, Sprint 10; arch-20260717-in-house-oss-ai-
 * visibility-architecture.md:101-114,307-310; ADR-4).
 *
 * A near-fusion of TWO existing templates, deliberately mirrored rather than
 * reinvented:
 *   - `DamcrawlerSerpProvider` (`./damcrawler-serp-provider.ts:69-106`) —
 *     guard-first/lazy-load/never-throw shape, and its docstring's rationale
 *     for omitting an `assertSafeUrl` SSRF guard (`:14-18`): the scrape
 *     target is PROVIDER-constructed (the ChatGPT-UI endpoint for a given
 *     prompt), not caller-supplied free-text, so there is no SSRF surface
 *     here the way there is for `DamcrawlerCitationVerifier`'s
 *     caller-supplied candidate urls.
 *   - `ApiSpineEngineProvider` (`./api-spine-provider.ts:72-125`) — the
 *     N-samples-per-prompt loop: sanitize -> extract -> verify -> emit one
 *     raw `AiVisibilityRow` per real observation, never a pre-aggregate.
 *
 * This class is the FIRST live consumer of the `"ai-visibility-scrape"`
 * egress axis (previously axis-only, `../egress.ts:6-7`). The axis is
 * self-asserted as the FIRST statement inside `probe()` — the load-bearing
 * barrier per ADR-4 — so axis-off means zero sockets AND zero damcrawler
 * import AND zero `ScrapeThrottle.acquire` calls (sc-10-1,
 * byte-identical-when-off).
 *
 * When the axis is ON, each sample runs:
 *   `throttle.acquire` -> `dam.scrape` -> `ContentSanitizer.clean` (BEFORE
 *   the parser — the Sprint-9 F1 prompt-injection lesson: an unsanitized
 *   scraped answer reaching the extractor/verifier/builder would re-open
 *   that regression, arch:346 "critical") -> `EngineScrapeParser.parse`
 *   (PURE) -> `MentionCitationExtractor.extract` -> `CitationVerifier.verify`
 *   -> `ScrapeThrottle.recordProxyCost` (only after a row is produced) ->
 *   push a row labeled `this.name` (`"chatgpt-ui"` (Sprint 10) or
 *   `"perplexity-ui"` (Sprint 11) — distinct from every API-arm provider
 *   label, sc-10-4/sc-11-1 unmixable-by-label).
 *
 * `estCostUsdPerPrompt = 0` — the scrape arm books ZERO USD to the
 * `SeoQuotaGovernor`; its real proxy cost lives entirely in the
 * `ScrapeThrottle`'s independent ledger (Sprint 9). Unlike
 * `ApiSpineEngineProvider.probe` (which THROWS when every attempted sample
 * fails, so its non-zero USD is never over-booked, `api-spine-provider.ts
 * :117-122`), this arm books $0 — a total failure has no over-book risk, so
 * it returns `[]` (abstain) instead of throwing (sc-10-3, "a scrape error
 * degrades to abstain (never throws)", read literally).
 */
import type { SeoEgressGuard } from "../egress.js";
import type { AiVisibilityRow } from "../data-source.js";
import type { AiVisibilityProvider } from "./ai-visibility-adapter.js";
import type { MentionCitationExtractor } from "./mention-citation-extractor.js";
import type { CitationVerifier } from "./citation-verifier.js";
import type { ScrapeThrottle } from "../scrape-throttle.js";
import type { EngineScrapeParser, RawScrape } from "./engine-scrape-parser-chatgpt.js";
import { ContentSanitizer } from "../content-sanitizer.js";

/** The scrape arm's engine labels (net-new; `AiVisibilityRow.provider` is a plain string). Both `"chatgpt-ui"` (Sprint 10) and `"perplexity-ui"` (Sprint 11) are live — see `scrapeUrlFor` below. */
export type ScrapeEngine = "chatgpt-ui" | "perplexity-ui";

/**
 * NARROW view of the ONLY damcrawler surface this arm calls — mirrors
 * `DamcrawlerSearchModule` (`./damcrawler-serp-provider.ts:43-49`) and
 * `DamcrawlerVerifyModule` (`./citation-verifier.ts:62-69`). Defined LOCALLY
 * (never imported from the real dep) so tests never need the package.
 * `options` carries the operator-supplied auth session / proxy opaquely —
 * this class does no auth harvesting or proxy sourcing (nonGoals).
 */
export interface DamcrawlerScrapeModule {
  scrape(
    urls: string[],
    options: { formats?: string[]; proxy?: string; authSession?: unknown },
  ): Promise<Array<{ url: string; title: string; markdown: string; links?: Array<{ url: string; text?: string }>; error?: string }>>;
  sanitize(raw: string, options?: { sourceUrl?: string }): { content: string; hadThreats: boolean };
}

/** Loader seam — the default performs the lazy dynamic import; tests inject a FAKE module (or `undefined` to simulate the dep being absent). */
export type DamcrawlerScrapeLoader = () => Promise<DamcrawlerScrapeModule | undefined>;

const defaultLoader: DamcrawlerScrapeLoader = async () => {
  // Indirection through a variable: under `moduleResolution: NodeNext` a
  // LITERAL `import("damcrawler")` is statically resolved by tsc and fails
  // with TS2307 when the dep is absent. Routing the specifier through a
  // `string` variable makes tsc treat the result as `any`, so `tsc --noEmit`
  // stays clean whether or not damcrawler is installed (mirrors
  // `damcrawler-serp-provider.ts:54-63`, `citation-verifier.ts:74-83`).
  const mod = "damcrawler";
  return (await import(mod).catch(() => undefined)) as DamcrawlerScrapeModule | undefined;
};

/**
 * Builds the target URL for one prompt, per configured `ScrapeEngine`
 * (Sprint 11 — generalized from the Sprint-10 ChatGPT-only builder). Each
 * engine's scrape target is provider-constructed from the prompt text alone
 * (no per-target routing) — mirrors the `DamcrawlerSerpProvider` "no SSRF
 * guard needed" rationale (this class never fetches a caller-supplied URL).
 * The `switch` is exhaustive over `ScrapeEngine` (a compile error surfaces
 * any future engine value left unhandled).
 */
function scrapeUrlFor(engine: ScrapeEngine, prompt: string): string {
  switch (engine) {
    case "chatgpt-ui":
      return `https://chatgpt.com/?q=${encodeURIComponent(prompt)}`;
    case "perplexity-ui":
      return `https://www.perplexity.ai/search?q=${encodeURIComponent(prompt)}`;
    default: {
      const _exhaustive: never = engine;
      return _exhaustive;
    }
  }
}

/**
 * `AiVisibilityProvider` backed by a gated damcrawler UI scrape.
 * Guard-first, lazy-load, throttle-metered, sanitize-before-parse,
 * never-throw; books zero USD to the governor (proxy cost is tracked
 * independently by the injected `ScrapeThrottle`).
 */
export class ScrapeArmEngineProvider implements AiVisibilityProvider {
  readonly name: ScrapeEngine;
  readonly estCostUsdPerPrompt = 0;

  constructor(
    private readonly egress: SeoEgressGuard,
    engine: ScrapeEngine,
    private readonly parser: EngineScrapeParser,
    private readonly extractor: MentionCitationExtractor,
    private readonly verifier: CitationVerifier,
    private readonly throttle: ScrapeThrottle,
    private readonly samplesPerPrompt: number,
    // Operator-supplied auth session (storageState path / profile name /
    // cookie blob) from `config.seo.aiVisibility.scrape.authSession` — opaque
    // to this class, passed straight through to `dam.scrape` options. NOT
    // hardcoded (nonGoal: no auth harvesting).
    private readonly authSession: unknown,
    private readonly proxyUsdPerScrape: number,
    private readonly proxy: string | undefined = undefined,
    private readonly load: DamcrawlerScrapeLoader = defaultLoader,
  ) {
    this.name = engine;
  }

  async probe(target: string, prompts: string[], _locale?: string): Promise<AiVisibilityRow[]> {
    // -- STATEMENT 1: self-assert the axis FIRST, before any import (ADR-4, load-bearing barrier, sc-10-1) --
    try {
      this.egress.assertAllowed("ai-visibility-scrape");
    } catch {
      return []; // axis off => abstain, zero sockets, NO loader call, NO throttle call
    }

    const dam = await this.load();
    if (!dam) return []; // damcrawler-not-installed (optional peer dep) => abstain, never throw

    const sanitizer = new ContentSanitizer(dam.sanitize); // ADR-11: sanitize at the network->in-process boundary
    const rows: AiVisibilityRow[] = [];

    for (const prompt of prompts) {
      for (let i = 0; i < this.samplesPerPrompt; i++) {
        const decision = await this.throttle.acquire(this.name); // BEFORE scrape
        if (!decision.proceed) continue; // throttle denial => skip this sample (sc-10-3), no ledger side effect

        try {
          const [result] = await dam.scrape([scrapeUrlFor(this.name, prompt)], {
            formats: ["markdown"],
            proxy: this.proxy,
            authSession: this.authSession,
          });
          if (!result || result.error) continue; // scrape error/missing row => drop sample, never throw (sc-10-3)

          // sc-10-2: sanitize the raw scraped markdown BEFORE the parser runs
          // (Sprint-9 F1 lesson — reversing this order re-opens the
          // prompt-injection regression).
          const cleanMarkdown = sanitizer.clean(result.markdown, result.url).content;
          const raw: RawScrape = { url: result.url, markdown: cleanMarkdown };
          const parsed = this.parser.parse(raw); // PURE: RawScrape -> {answerText, citations}

          const obs = await this.extractor.extract({
            target,
            answerText: parsed.answerText,
            citations: parsed.citations,
          });

          const verified = await this.verifier.verify(target, obs.sourceUrls);
          const sourceUrls = verified.filter((v) => v.live).map((v) => v.url);

          const row: AiVisibilityRow = {
            prompt,
            provider: this.name,
            mentioned: obs.mentioned,
            citationPresent: obs.citationPresent,
            sourceUrls,
          };
          if (obs.rank !== undefined) row.rank = obs.rank; // never `rank: undefined`
          rows.push(row);

          await this.throttle.recordProxyCost(this.name, this.proxyUsdPerScrape); // AFTER a successful, row-producing scrape
        } catch {
          continue; // any error mid-sample => drop that sample, NEVER throw (sc-10-3)
        }
      }
    }

    return rows; // sc-10-3: never throws; [] is a valid abstain (zero booked, zero over-book risk at $0/prompt)
  }
}
