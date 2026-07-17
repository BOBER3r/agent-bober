/**
 * DamcrawlerCrawlEngine — the `CrawlEngine` implementation backed by the
 * optional `damcrawler` peer dependency (spec-20260717-seo-improver-builder,
 * Sprint 6 + Sprint 7; ADR-6, ADR-9, ADR-11).
 *
 * Mirrors `AiVisibilityAdapter`'s guard-first/never-throw/injected-port
 * shape (`./ai-visibility-adapter.ts:106-143`) with two differences: the
 * injected seam is a damcrawler MODULE LOADER (not an `HttpClient`/vendor
 * provider), and there is no quota governor — local crawling has no USD
 * cost (ADR-9 Options table; do not book anything here). `CrawlSource`
 * (Sprint 7) books the GSC url-inspection ledger counter, not this class.
 *
 * ADR-9's decision is that `damcrawler` (+ its `playwright` peer) stay
 * OPTIONAL/PEER dependencies, loaded ONLY via a lazy `import()` behind the
 * `site-crawl` egress axis:
 *   1. `this.egress.assertAllowed("site-crawl")` — the FIRST statement of
 *      EVERY method, before any import runs. Throws when the axis is off;
 *      caught immediately and converted to `abstain` WITHOUT ever loading
 *      damcrawler — this is what keeps the offline/all-axes-off path
 *      byte-identical (damcrawler/playwright are never required there).
 *   2. `this.load()` — the injected `DamcrawlerLoader`. The default
 *      implementation performs the actual dynamic `import()`; when the
 *      real dependency is not installed the import rejects and resolves to
 *      `undefined`, which this class maps to
 *      `{ kind: "abstain", reason: "damcrawler-not-installed" }`.
 *   3. An engine-boundary SSRF guard (`dam.assertSafeUrl`, Sprint 7 F2) on
 *      every caller-supplied URL — AFTER `load()`, BEFORE any damcrawler
 *      network call. A rejection (`SsrfError` or anything else) degrades
 *      to `{ kind: "abstain", reason: "ssrf-blocked" }` — protection no
 *      longer relies solely on the optional dep's own internal guard.
 *   4. Any OTHER error thrown by the loaded module (a `BrowserError` when
 *      Chromium is absent, a `TimeoutError`, a `CrawlError`, or anything
 *      else) degrades to `{ kind: "abstain", reason: "source-error" }` —
 *      this class NEVER throws to its caller.
 *
 * Crawled page free-text (body, title, URL) is attacker-controlled. Per
 * ADR-11 it is sanitized HERE, at the network->in-process boundary, via
 * `ContentSanitizer` wrapping the already-loaded module's `sanitize` export
 * — BEFORE any row reaches `SeoAnalyzer`'s prompt-serialization. Sprint 7
 * (F1) widens this from body-only to EVERY free-text field on
 * `CrawlPageRow` (`title`, `url`, `content`) — `CrawlPageRow`'s docstring
 * asserts the row is fully sanitized, and `SeoAnalyzer` serializes the
 * whole row verbatim.
 *
 * `linkGraph()` (Sprint 7) resolves the markdown-vs-HTML gap left by
 * Sprint 6: `crawl()` yields page bodies as Markdown with no link data, so
 * this method uses damcrawler's `scrape(urls, { formats: ["links"] })`
 * instead, which internally fetches HTML and extracts real
 * `LinkGraphRow` edges. Row free-text (`anchor`) is re-sanitized by
 * `CrawlSource` (sc-7-3, defense-in-depth) — this engine may leave it raw.
 */
import type { SeoEgressGuard } from "../egress.js";
import type { DataOutcome } from "../types.js";
import type { UrlInspectionQuery, UrlInspectionRow, LinkGraphQuery, LinkGraphRow, CrawlPageRow } from "../data-source.js";
import type { CrawlEngine, CrawlQuery } from "../crawl-engine.js";
import { ContentSanitizer } from "../content-sanitizer.js";

/**
 * NARROW local view of the ONLY damcrawler surface this engine calls —
 * confirmed against the real damcrawler source (sprint briefing §2):
 *   - `crawl(startUrl, options)` — `options` is a REQUIRED parameter
 *     (`damcrawler/src/commands/crawl.ts:158`); page body is `.markdown`,
 *     NOT `.content` (`crawl.ts:90-96`).
 *   - `probeVisibility(url, rootUrl, opts?)` (`damcrawler/src/lib/visibility-probe.ts:66`).
 *   - `sanitize(raw, options?)` — the ONLY damcrawler sanitize export that
 *     yields `hadThreats` (`damcrawler/src/lib/sanitize.ts:68-79,89`);
 *     `sanitizeWithReport` returns a bare `string` and must NOT be used
 *     here (briefing §0/§9.1).
 *   - `assertSafeUrl(urlString)` (Sprint 7, F2) — damcrawler's own SSRF
 *     guard, exported `damcrawler/src/index.ts:259`; short-circuits WITHOUT
 *     a DNS lookup for a literal private/link-local IP or a non-http(s)
 *     scheme (`ssrf.ts:79-81,94-99`).
 *   - `scrape(urls, options)` (Sprint 7, linkGraph) — internally fetches
 *     HTML and runs `extractLinks` over it, returning `ScrapeResult.links`
 *     (`damcrawler/src/commands/scrape.ts:36-37,112,366-373`).
 */
export interface DamcrawlerModule {
  crawl(
    startUrl: string,
    options: { limit?: number; maxDepth?: number },
  ): Promise<{
    startUrl: string;
    pages: Array<{ url: string; title: string; depth: number; markdown: string }>;
    stats: { pages: number; errors: number };
  }>;
  probeVisibility(url: string, rootUrl: string): Promise<"visible" | "hidden">;
  sanitize(raw: string, options?: { sourceUrl?: string }): { content: string; hadThreats: boolean };
  /** SSRF guard (F2) — throws (typically a named `SsrfError`) for a disallowed URL, resolves void otherwise. */
  assertSafeUrl(urlString: string): Promise<void>;
  /** Link extraction (linkGraph) — `formats: ["links"]` yields `page.links` per fetched URL. */
  scrape(
    urls: string[],
    options: { formats?: string[]; limit?: number },
  ): Promise<Array<{ url: string; title: string; links?: Array<{ url: string; text: string; rel?: string }>; error?: string }>>;
}

/** Loader seam — the default performs the lazy dynamic import; tests inject a FAKE module (or `undefined` to simulate the dep being absent). */
export type DamcrawlerLoader = () => Promise<DamcrawlerModule | undefined>;

const defaultLoader: DamcrawlerLoader = async () => {
  // Indirection through a variable: under `moduleResolution: NodeNext` a
  // LITERAL `import("damcrawler")` is statically resolved by tsc and fails
  // with TS2307 when the dep is absent. Routing the specifier through a
  // `string` variable makes tsc treat the result as `any`, so `tsc --noEmit`
  // stays clean whether or not damcrawler is installed (sprint briefing
  // Pattern D / Pitfall #4).
  const mod = "damcrawler";
  return (await import(mod).catch(() => undefined)) as DamcrawlerModule | undefined;
};

/** `try { return new URL(u).origin } catch { return "" }` — URL parsing must never throw here. */
function safeOrigin(u: string): string {
  try {
    return new URL(u).origin;
  } catch {
    return "";
  }
}

/**
 * `CrawlEngine` backed by damcrawler. Serves `crawl`/`urlVisibility`/
 * `linkGraph` fully; every method is guard-first, lazy-load, SSRF-guarded,
 * and never-throw.
 */
export class DamcrawlerCrawlEngine implements CrawlEngine {
  constructor(
    private readonly egress: SeoEgressGuard,
    private readonly load: DamcrawlerLoader = defaultLoader,
    // Injected clock for provenance.retrievedAt — deterministic in tests.
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /** Site crawl -> sanitized `CrawlPageRow[]`. Guard, load, SSRF-guard, crawl+sanitize, degrade — never throws. */
  async crawl(q: CrawlQuery): Promise<DataOutcome<CrawlPageRow[]>> {
    try {
      this.egress.assertAllowed("site-crawl");
    } catch {
      return { kind: "abstain", reason: "egress-site-crawl-disabled" };
    }

    const dam = await this.load();
    if (!dam) return { kind: "abstain", reason: "damcrawler-not-installed" };

    try {
      await dam.assertSafeUrl(q.rootUrl); // F2: engine-boundary SSRF guard, before any damcrawler network call
    } catch {
      return { kind: "abstain", reason: "ssrf-blocked" };
    }

    try {
      const result = await dam.crawl(q.rootUrl, { limit: q.limit, maxDepth: q.maxDepth });
      const sanitizer = new ContentSanitizer(dam.sanitize); // ADR-11: sanitize at the network->in-process boundary
      const rows: CrawlPageRow[] = result.pages.map((p) => ({
        // F1: title/url are attacker-controlled free text just like the body
        // — every field CrawlPageRow exposes to SeoAnalyzer's prompt must be
        // sanitized, not only `.markdown`.
        url: sanitizer.clean(p.url, p.url).content,
        title: sanitizer.clean(p.title, p.url).content,
        content: sanitizer.clean(p.markdown, p.url).content, // page body field is `markdown`, not `content`
      }));
      return { kind: "data", rows, provenance: { source: "damcrawler", retrievedAt: this.now() } };
    } catch {
      return { kind: "abstain", reason: "source-error" }; // BrowserError/TimeoutError/CrawlError all land here
    }
  }

  /** URL indexability probe -> single-row `UrlInspectionRow[]`. Guard, load, SSRF-guard, probe, degrade — never throws. */
  async urlVisibility(q: UrlInspectionQuery): Promise<DataOutcome<UrlInspectionRow[]>> {
    try {
      this.egress.assertAllowed("site-crawl");
    } catch {
      return { kind: "abstain", reason: "egress-site-crawl-disabled" };
    }

    const dam = await this.load();
    if (!dam) return { kind: "abstain", reason: "damcrawler-not-installed" };

    try {
      // F2: guard BOTH caller-supplied URLs before any damcrawler network call.
      await dam.assertSafeUrl(q.inspectionUrl);
      await dam.assertSafeUrl(q.siteUrl);
    } catch {
      return { kind: "abstain", reason: "ssrf-blocked" };
    }

    try {
      const visibility = await dam.probeVisibility(q.inspectionUrl, q.siteUrl);
      const row: UrlInspectionRow = {
        url: q.inspectionUrl,
        indexingState: visibility === "visible" ? "indexed" : "not-indexed",
      };
      return { kind: "data", rows: [row], provenance: { source: "damcrawler", retrievedAt: this.now() } };
    } catch {
      return { kind: "abstain", reason: "source-error" };
    }
  }

  /**
   * Internal link graph -> flat `LinkGraphRow[]` edges (ADR-6). Guard,
   * load, SSRF-guard, scrape+extract, degrade — never throws. Uses
   * `scrape(formats:["links"])` rather than `crawl()`, which yields
   * Markdown with no link data (see class docstring).
   */
  async linkGraph(q: LinkGraphQuery): Promise<DataOutcome<LinkGraphRow[]>> {
    try {
      this.egress.assertAllowed("site-crawl");
    } catch {
      return { kind: "abstain", reason: "egress-site-crawl-disabled" };
    }

    const dam = await this.load();
    if (!dam) return { kind: "abstain", reason: "damcrawler-not-installed" };

    try {
      await dam.assertSafeUrl(q.rootUrl); // F2
    } catch {
      return { kind: "abstain", reason: "ssrf-blocked" };
    }

    try {
      const results = await dam.scrape([q.rootUrl], { formats: ["links"], limit: q.limit });
      const rootOrigin = safeOrigin(q.rootUrl);
      const rows: LinkGraphRow[] = [];
      for (const page of results) {
        if (page.error) continue; // a failed fetch for this page yields no reliable link data
        for (const link of page.links ?? []) {
          rows.push({
            fromUrl: page.url,
            toUrl: link.url,
            anchor: link.text ? link.text : undefined,
            internal: safeOrigin(link.url) === rootOrigin, // same-origin => internal edge
          });
        }
      }
      // A partial/empty graph is a valid `data` outcome (ADR-6) — never fabricate, never throw.
      return { kind: "data", rows, provenance: { source: "damcrawler", retrievedAt: this.now() } };
    } catch {
      return { kind: "abstain", reason: "source-error" };
    }
  }
}
