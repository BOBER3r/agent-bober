/**
 * DamcrawlerCrawlEngine — the `CrawlEngine` implementation backed by the
 * optional `damcrawler` peer dependency (spec-20260717-seo-improver-builder,
 * Sprint 6; ADR-9, ADR-11).
 *
 * Mirrors `AiVisibilityAdapter`'s guard-first/never-throw/injected-port
 * shape (`./ai-visibility-adapter.ts:106-143`) with two differences: the
 * injected seam is a damcrawler MODULE LOADER (not an `HttpClient`/vendor
 * provider), and there is no quota governor — local crawling has no USD
 * cost (ADR-9 Options table; do not book anything here).
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
 *   3. Any error thrown by the loaded module itself (a `BrowserError` when
 *      Chromium is absent, a `TimeoutError`, a `CrawlError`, an `SsrfError`,
 *      or anything else) degrades to `{ kind: "abstain", reason:
 *      "source-error" }` — this class NEVER throws to its caller.
 *
 * Crawled page bodies are attacker-controlled free text. Per ADR-11 they
 * are sanitized HERE, at the network→in-process boundary, via
 * `ContentSanitizer` wrapping the already-loaded module's `sanitize`
 * export — BEFORE any row reaches `SeoAnalyzer`'s prompt-serialization.
 *
 * `linkGraph()` cannot build a real link graph this sprint: `crawl()`
 * yields page bodies as Markdown, but damcrawler's `extractPageLinks`
 * needs raw HTML (sprint briefing §9 Pitfall #5). Rich link-graph wiring
 * is deferred to Sprint 7; this method stays guard-first/lazy-load/
 * never-throw and abstains with a dedicated reason rather than fabricate
 * a partial or empty graph.
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
 *
 * Link-graph helpers (`extractPageLinks`/`filterLinks`/`canonicalizeUrl`)
 * are deliberately NOT declared — this engine never calls them this
 * sprint (Pitfall #5), and `noUnusedLocals`/dead interface members would
 * flag an unused declaration.
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

/**
 * `CrawlEngine` backed by damcrawler. Serves `crawl`/`urlVisibility` fully;
 * `linkGraph` abstains this sprint (see class docstring).
 */
export class DamcrawlerCrawlEngine implements CrawlEngine {
  constructor(
    private readonly egress: SeoEgressGuard,
    private readonly load: DamcrawlerLoader = defaultLoader,
    // Injected clock for provenance.retrievedAt — deterministic in tests.
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /** Site crawl → sanitized `CrawlPageRow[]`. Guard, load, crawl+sanitize, degrade — never throws. */
  async crawl(q: CrawlQuery): Promise<DataOutcome<CrawlPageRow[]>> {
    try {
      this.egress.assertAllowed("site-crawl");
    } catch {
      return { kind: "abstain", reason: "egress-site-crawl-disabled" };
    }

    const dam = await this.load();
    if (!dam) return { kind: "abstain", reason: "damcrawler-not-installed" };

    try {
      const result = await dam.crawl(q.rootUrl, { limit: q.limit, maxDepth: q.maxDepth });
      const sanitizer = new ContentSanitizer(dam.sanitize); // ADR-11: sanitize at the network->in-process boundary
      const rows: CrawlPageRow[] = result.pages.map((p) => ({
        url: p.url,
        title: p.title,
        content: sanitizer.clean(p.markdown, p.url).content, // page body field is `markdown`, not `content`
      }));
      return { kind: "data", rows, provenance: { source: "damcrawler", retrievedAt: this.now() } };
    } catch {
      return { kind: "abstain", reason: "source-error" }; // BrowserError/TimeoutError/CrawlError/SsrfError all land here
    }
  }

  /** URL indexability probe → single-row `UrlInspectionRow[]`. Guard, load, probe, degrade — never throws. */
  async urlVisibility(q: UrlInspectionQuery): Promise<DataOutcome<UrlInspectionRow[]>> {
    try {
      this.egress.assertAllowed("site-crawl");
    } catch {
      return { kind: "abstain", reason: "egress-site-crawl-disabled" };
    }

    const dam = await this.load();
    if (!dam) return { kind: "abstain", reason: "damcrawler-not-installed" };

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
   * Internal link-graph. Deferred (see class docstring, Pitfall #5): a
   * real graph needs HTML, `crawl()` yields Markdown. Still guard-first +
   * lazy-load + never-throw so the axis-off/dep-absent paths behave
   * identically to `crawl`/`urlVisibility`.
   *
   * bober: abstains rather than fabricating a partial graph; swap for a
   * real HTML-based link extraction (`extractPageLinks`/`filterLinks`)
   * when Sprint 7 wires `CrawlSource`.
   */
  async linkGraph(_q: LinkGraphQuery): Promise<DataOutcome<LinkGraphRow[]>> {
    try {
      this.egress.assertAllowed("site-crawl");
    } catch {
      return { kind: "abstain", reason: "egress-site-crawl-disabled" };
    }

    const dam = await this.load();
    if (!dam) return { kind: "abstain", reason: "damcrawler-not-installed" };

    return { kind: "abstain", reason: "link-graph-unavailable" };
  }
}
