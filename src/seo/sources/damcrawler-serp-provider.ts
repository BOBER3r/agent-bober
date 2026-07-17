/**
 * DamcrawlerSerpProvider — the `SerpProvider` (`../serp-provider.js`)
 * implementation backed by damcrawler's `search()` command
 * (spec-20260717-seo-improver-builder, Sprint 8; ADR-10).
 *
 * Mirrors `DamcrawlerCrawlEngine`'s guard-first/lazy-load/never-throw shape
 * (`./damcrawler-crawl-engine.ts:133-165`) with three differences:
 *   1. ADR-10: gated by the `"site-crawl"` axis (SAME Playwright-scrape/
 *      anti-bot/ToS risk surface as the crawler), NOT `"serp-provider"`
 *      (that axis means "licensed, USD-metered DataForSEO egress" — routing
 *      un-licensed scraping through it would silently authorize ToS-gray
 *      scraping the operator never consented to).
 *   2. Zero USD — no `SeoQuotaGovernor` is injected or consulted at all.
 *   3. No `assertSafeUrl` SSRF guard — the input is a search keyword, and
 *      the result URLs are returned as DATA (never fetched by this class),
 *      unlike `crawl()`'s `rootUrl`/`urlVisibility()`'s inspection URLs
 *      which damcrawler itself fetches. Sanitization is the required
 *      defense here (see below), not SSRF.
 *
 * SERP result `title` and `url` are attacker-influenced free-text (the
 * page being ranked controls both) — per ADR-11 both are sanitized through
 * `ContentSanitizer` (`../content-sanitizer.js`) at the network->in-process
 * boundary, BEFORE the row ever reaches `SeoAnalyzer`'s prompt
 * serialization. Any anti-bot/search/parse error degrades to
 * `{ kind: "abstain", reason: "serp-scrape-error" }` — this class NEVER
 * throws to its caller.
 */
import type { SeoEgressGuard } from "../egress.js";
import type { DataOutcome } from "../types.js";
import type { SerpRow } from "../data-source.js";
import type { SerpProvider } from "../serp-provider.js";
import { ContentSanitizer } from "../content-sanitizer.js";

/**
 * NARROW view of the ONLY damcrawler surface this provider calls (mirrors
 * `DamcrawlerModule`, `./damcrawler-crawl-engine.ts:77-95`):
 *   - `search(query, options)` — `damcrawler/src/commands/search.ts:481`;
 *     returns `{ results: SearchResultItem[{title,url,description}] }`.
 *   - `sanitize(raw, options?)` — the ONLY damcrawler sanitize export that
 *     yields `hadThreats` (`damcrawler/src/lib/sanitize.ts:68-79,89`);
 *     `sanitizeWithReport` returns a bare `string` and must NOT be used.
 */
export interface DamcrawlerSearchModule {
  search(
    query: string,
    options: { limit?: number; country?: string },
  ): Promise<{ results: Array<{ title: string; url: string; description: string }> }>;
  sanitize(raw: string, options?: { sourceUrl?: string }): { content: string; hadThreats: boolean };
}

/** Loader seam — the default performs the lazy dynamic import; tests inject a FAKE module (or `undefined` to simulate the dep being absent). */
export type DamcrawlerSearchLoader = () => Promise<DamcrawlerSearchModule | undefined>;

const defaultLoader: DamcrawlerSearchLoader = async () => {
  // Indirection through a variable: a LITERAL `import("damcrawler")` is
  // statically resolved by tsc under `moduleResolution: NodeNext` and fails
  // with TS2307 when the dep is absent. Routing the specifier through a
  // `string` variable makes tsc treat the result as `any`, so
  // `tsc --noEmit` stays clean whether or not damcrawler is installed
  // (mirrors `damcrawler-crawl-engine.ts:100-109`, Pattern B).
  const mod = "damcrawler";
  return (await import(mod).catch(() => undefined)) as DamcrawlerSearchModule | undefined;
};

/**
 * `SerpProvider` backed by damcrawler's search scrape. Guard-first,
 * lazy-load, sanitize, never-throw; books zero USD (no governor at all).
 */
export class DamcrawlerSerpProvider implements SerpProvider {
  readonly name = "damcrawler" as const;
  readonly estCostUsdPerResult = 0; // zero-USD scrape (ADR-10)

  constructor(
    private readonly egress: SeoEgressGuard,
    private readonly load: DamcrawlerSearchLoader = defaultLoader,
    // Injected clock for provenance.retrievedAt — deterministic in tests.
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly limit = 10,
  ) {}

  async serp(keyword: string, location: string): Promise<DataOutcome<SerpRow[]>> {
    // -- STATEMENT 1: egress gate (ADR-10) — FIRST, before any import --
    try {
      this.egress.assertAllowed("site-crawl");
    } catch {
      return { kind: "abstain", reason: "egress-site-crawl-disabled" };
    }

    const dam = await this.load();
    if (!dam) return { kind: "abstain", reason: "damcrawler-not-installed" };

    try {
      const { results } = await dam.search(keyword, { limit: this.limit, country: location });
      const sanitizer = new ContentSanitizer(dam.sanitize); // ADR-11: sanitize at the network->in-process boundary
      const rows: SerpRow[] = results.map((r, i) => {
        const url = sanitizer.clean(r.url, r.url).content;
        const row: SerpRow = { keyword, position: i + 1, url, location };
        const title = sanitizer.clean(r.title, r.url).content;
        if (title) row.title = title; // SerpRow.title is optional — set only when non-empty (mirrors parseSerp)
        return row;
      });
      return { kind: "data", rows, provenance: { source: "damcrawler", retrievedAt: this.now() } };
    } catch {
      return { kind: "abstain", reason: "serp-scrape-error" }; // anti-bot/search/parse error -> abstain, NEVER throw
    }
  }
}
