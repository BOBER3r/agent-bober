/**
 * CrawlEngine port (spec-20260717-seo-improver-builder, Sprint 6; ADR-9).
 *
 * Pure `interface` + query `type` only — no runtime code, mirroring
 * `data-source.ts`'s structure. `DamcrawlerCrawlEngine` (Sprint 6) is the
 * first implementer; `CrawlSource`/`SeoDataSource` wiring is deferred to
 * Sprint 7 (nonGoal here).
 *
 * `UrlInspectionQuery`/`UrlInspectionRow`, `LinkGraphQuery`/`LinkGraphRow`,
 * and `CrawlPageRow` already exist on `data-source.ts` (Sprint 1) — imported
 * here, never redefined.
 */
import type { DataOutcome } from "./types.js";
import type { UrlInspectionQuery, UrlInspectionRow, LinkGraphQuery, LinkGraphRow, CrawlPageRow } from "./data-source.js";

/**
 * Site-crawl query (rootUrl + optional bounds). No `Query` pair exists yet
 * in `data-source.ts` for crawl pages — `CrawlPageRow` has none (see its
 * docstring, `data-source.ts:136-143`) since the crawl query lives here.
 */
export type CrawlQuery = { rootUrl: string; limit?: number; maxDepth?: number };

/**
 * ADR-9 port. Every method: guard `site-crawl` FIRST (before any import),
 * lazy-load damcrawler, and degrade to `{ kind: "abstain", reason }` —
 * never throw to the caller.
 */
export interface CrawlEngine {
  crawl(q: CrawlQuery): Promise<DataOutcome<CrawlPageRow[]>>;
  urlVisibility(q: UrlInspectionQuery): Promise<DataOutcome<UrlInspectionRow[]>>;
  linkGraph(q: LinkGraphQuery): Promise<DataOutcome<LinkGraphRow[]>>;
}
