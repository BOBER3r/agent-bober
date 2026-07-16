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

export { SeoQuotaGovernor } from "./quota-governor.js";
export type { QuotaRequest, QuotaDecision, QuotaRefusalReason } from "./quota-governor.js";

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
export { GscAdapter } from "./sources/gsc-adapter.js";
export { DataForSeoAdapter } from "./sources/dataforseo-adapter.js";

export type { HttpClient, HttpResponse, HttpRequestInit } from "./adapters/http.js";

export { SeoAnalyzer } from "./analyzer.js";
export type { SeoAnalyzeInput, SeoAnalysis, SeoDataBundle } from "./analyzer.js";

export { SeoCitationGate } from "./citation-gate.js";
export type { SeoBlockThreshold, CitationGateResult } from "./citation-gate.js";

export { SeoReportStore, deriveReportId } from "./report-store.js";

export { SeoHubEmitter } from "./hub-emitter.js";
export type { SeoFindingSink } from "./hub-emitter.js";

export { SeoWorkflowRunner, selectSource } from "./runner.js";
export type { SeoRunInput, SeoRunOutcome } from "./runner.js";

export { SeoRecommendationVerifier } from "./verifier.js";
export type { SeoVerifier, SeoVerifyParams, SeoVerifyResult } from "./verifier.js";

export { registerSeoCommand } from "./command.js";
export type { SeoCommandOverrides } from "./command.js";

export { runBenchmark } from "./benchmark/harness.js";
export type { SeoBenchmarkCase, CorpusMetrics } from "./benchmark/harness.js";
