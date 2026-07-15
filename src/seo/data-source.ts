/**
 * SeoDataSource seam (spec-20260715-ultimate-seo-suite, Sprint 6).
 *
 * The unified interface every data provider (offline `LocalExportSource`,
 * this sprint; live `gsc`/`dataforseo` adapters, sprints 8-9) implements.
 * Capability/query/row shapes are quoted from the architecture Component
 * Breakdown / Data Model (.bober/architecture/
 * arch-20260715-ultimate-seo-agents-skills-architecture.md:143-212).
 *
 * `DataOutcome`/`DataProvenance` are the canonical outcome union defined in
 * `./types.js` (Sprint 1) — RE-EXPORTED here, never redefined.
 */
import type { DataOutcome } from "./types.js";

export type { DataOutcome, DataProvenance } from "./types.js";

// -- Capability ---------------------------------------------------------

/** The five data capabilities a `SeoDataSource` may serve. */
export type SeoCapability =
  | "search-analytics"
  | "url-inspection"
  | "serp"
  | "keywords"
  | "backlinks";

// -- Query types (architecture lines 183-212) ----------------------------

export type SearchAnalyticsQuery = {
  siteUrl: string;
  startDate: string;
  endDate: string;
  dimensions: Array<"query" | "page" | "country" | "device">;
  rowLimit?: number;
};

export type UrlInspectionQuery = { siteUrl: string; inspectionUrl: string };

export type SerpQuery = {
  keyword: string;
  location: string;
  priority?: "standard" | "priority" | "live";
};

export type KeywordQuery = { keywords: string[]; location: string };

export type BacklinkQuery = { target: string; limit?: number };

// -- Row types (designed this sprint; keys mirror the CSV headers in
//    `.bober/seo/imports/<capability>.csv` — keep in lockstep, a header
//    typo silently drops a column) --------------------------------------

/** GSC Search-Analytics export, flattened. */
export type SearchAnalyticsRow = {
  query?: string;
  page?: string;
  country?: string;
  device?: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

/** GSC URL-Inspection export or local crawl output. */
export type UrlInspectionRow = {
  url: string;
  coverageState?: string;
  indexingState?: string;
  lastCrawlTime?: string;
  robotsTxtState?: string;
  pageFetchState?: string;
};

export type SerpRow = {
  keyword: string;
  position: number;
  url: string;
  title?: string;
  location?: string;
};

export type KeywordRow = {
  keyword: string;
  searchVolume?: number;
  cpc?: number;
  competition?: number;
  location?: string;
};

export type BacklinkRow = {
  sourceUrl: string;
  targetUrl: string;
  anchor?: string;
  dofollow?: boolean;
};

// -- Interface ------------------------------------------------------------

/**
 * Implemented by every SEO data provider (offline or live). Each method
 * returns a `DataOutcome` and — per the discipline mirrored from
 * `RetrievalOutcome` (`src/medical/retrieval/medline-source.ts:25-28`) —
 * NEVER throws to the caller: absent/unsupported capability maps to
 * `{ kind: "disabled" }`, a parseable-but-empty result maps to
 * `{ kind: "abstain", reason }`.
 */
export interface SeoDataSource {
  /** The capabilities this source can currently serve (advertises only what it can). */
  capabilities(): SeoCapability[];
  searchAnalytics(q: SearchAnalyticsQuery): Promise<DataOutcome<SearchAnalyticsRow[]>>;
  urlInspection(q: UrlInspectionQuery): Promise<DataOutcome<UrlInspectionRow[]>>;
  serp(q: SerpQuery): Promise<DataOutcome<SerpRow[]>>;
  keywords(q: KeywordQuery): Promise<DataOutcome<KeywordRow[]>>;
  backlinks(q: BacklinkQuery): Promise<DataOutcome<BacklinkRow[]>>;
}
