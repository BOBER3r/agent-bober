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

/**
 * The seven data capabilities a `SeoDataSource` may serve. Widened from five
 * to seven (spec-20260717-seo-improver-builder, Sprint 1) with
 * `"ai-visibility"` and `"link-graph"` — a closed union, so every
 * implementer + any exhaustive `Record<SeoCapability, ...>` map is forced by
 * the compiler to account for the two new members.
 */
export type SeoCapability =
  | "search-analytics"
  | "url-inspection"
  | "serp"
  | "keywords"
  | "backlinks"
  | "ai-visibility"
  | "link-graph";

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

/**
 * AI-visibility/GEO probe query — one batch of prompts against a target
 * (architecture Data Model, arch-20260716-...-architecture.md:64; F5).
 */
export type AiVisibilityQuery = { target: string; prompts: string[]; locale?: string };

/** Site-crawl internal-link-graph query (architecture:65; F7). */
export type LinkGraphQuery = { rootUrl: string; limit?: number };

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

/**
 * One AI-answer probe result — one row per (prompt, provider) pair
 * (architecture:64; F5). `citationPresent`/`sourceUrls` capture whether the
 * AI answer cited the target at all, distinct from `mentioned` (brand
 * mentioned in the answer text without a citation).
 */
export type AiVisibilityRow = {
  prompt: string;
  provider: string;
  mentioned: boolean;
  rank?: number;
  citationPresent: boolean;
  sourceUrls: string[];
};

/**
 * One internal/external link edge from a site crawl — flat rows, not a
 * nested graph (architecture:65, ADR-6; F7).
 */
export type LinkGraphRow = { fromUrl: string; toUrl: string; anchor?: string; internal: boolean };

/**
 * One crawled page's sanitized content (architecture:66, ADR-11; F6/F7).
 * `content` has already been passed through `ContentSanitizer` by the time
 * it reaches this row — no further sanitization is required downstream. No
 * `Query` pair this sprint (the crawl query lives on `CrawlEngine`, a later
 * sprint).
 */
export type CrawlPageRow = { url: string; title?: string; content: string };

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
  // REQUIRED (not optional — spec-20260717-seo-improver-builder, Sprint 1) so
  // a future missing implementer is a compile error, not a silent gap.
  aiVisibility(q: AiVisibilityQuery): Promise<DataOutcome<AiVisibilityRow[]>>;
  linkGraph(q: LinkGraphQuery): Promise<DataOutcome<LinkGraphRow[]>>;
}
