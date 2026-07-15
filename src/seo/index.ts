/**
 * Public surface of `src/seo/` (spec-20260715-ultimate-seo-suite, Sprint 1).
 * Focused local barrel — mirrors `src/config/index.ts` (selective named
 * re-exports, `type` keyword for types). Deliberately does NOT re-export
 * `SeoConfigSchema` from `src/config/schema.js` — that barrel intentionally
 * omits section schemas (`src/config/index.ts:1-58`); consumers import
 * section schemas directly from `./schema.js`.
 */
export type {
  SeoWorkflow,
  DataProvenance,
  DataOutcome,
  SeoSignature,
  SeoFinding,
  SeoReport,
  SeoQuotaLedger,
} from "./types.js";

export { SeoEgressGuard } from "./egress.js";
export type { SeoEgressAxis } from "./egress.js";

export { SeoPlaybookParser } from "./parser.js";
export { SeoPlaybookIndex } from "./playbook-index.js";
export { SeoPlaybookRetriever } from "./retriever.js";
export type { SeoRetrieveInput, SeoRetrieveResult } from "./retriever.js";

export type {
  SeoDataSource,
  SeoCapability,
  SearchAnalyticsQuery,
  SearchAnalyticsRow,
  UrlInspectionQuery,
  UrlInspectionRow,
  SerpQuery,
  SerpRow,
  KeywordQuery,
  KeywordRow,
  BacklinkQuery,
  BacklinkRow,
} from "./data-source.js";
export { LocalExportSource } from "./sources/local-export.js";
