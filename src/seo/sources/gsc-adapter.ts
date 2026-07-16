/**
 * GscAdapter — the FIRST live network `SeoDataSource` (spec-20260715-ultimate-seo-suite,
 * Sprint 8). Serves `searchAnalytics` + `urlInspection` from the real Google
 * Search Console API, behind the `"search-console"` egress axis.
 *
 * ADR-5 (the load-bearing invariant of this file): EVERY capability method
 * that would open a socket begins with these two gates, IN ORDER, before any
 * network work:
 *   1. `this.egress.assertAllowed("search-console")` — throws when the axis
 *      is off; caught immediately and converted to `abstain` WITHOUT opening
 *      a socket (never hoisted into a caller/runner — see `src/seo/egress.ts`).
 *   2. `this.governor.admit(req)` — synchronous, never throws, no side
 *      effect; refused admission also aborts before any socket opens.
 * Only after BOTH gates pass does the injected `HttpClient` make a request.
 * Any HTTP/network/parse error (including 429/5xx) degrades to
 * `{ kind: "abstain", reason }` — this method NEVER throws to the caller
 * (mirrors `MedlineSource.fetchPassages`,
 * `src/medical/retrieval/medline-source.ts:142-164`).
 *
 * The real global `fetch` is referenced NOWHERE in this file — the injected
 * `HttpClient` (`../adapters/http.js`) is the sole transport, defaulting to
 * `defaultHttpClient` (production) or a fixture/spy client (tests), so CI
 * never opens a real socket.
 */
import type { SeoEgressGuard } from "../egress.js";
import type { SeoQuotaGovernor, QuotaRequest } from "../quota-governor.js";
import type { HttpClient } from "../adapters/http.js";
import { defaultHttpClient } from "../adapters/http.js";
import type {
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
} from "../data-source.js";
import type { DataOutcome, DataProvenance } from "../types.js";

// -- GSC endpoint constants (research S4) ----------------------------------

const GSC_SEARCH_ANALYTICS_BASE = "https://www.googleapis.com/webmasters/v3/sites";
const GSC_URL_INSPECTION_URL = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";

/** GSC Search Analytics hard per-request cap — never send a larger rowLimit. */
const GSC_ROW_LIMIT_CAP = 25_000;

// -- Response parsers (pure, total — [] / {} on any shape mismatch) --------

/**
 * Parse a GSC `searchAnalytics/query` response body into typed rows.
 * `dimensions` gives the order of the `keys[]` array in each response row
 * (GSC echoes dimensions positionally, no field names). Any structural
 * mismatch degrades to `[]` (fail-closed read, never throws).
 */
function parseSearchAnalytics(
  raw: unknown,
  dimensions: SearchAnalyticsQuery["dimensions"],
): SearchAnalyticsRow[] {
  if (!raw || typeof raw !== "object") return [];
  const body = raw as Record<string, unknown>;
  const rawRows = body["rows"];
  if (!Array.isArray(rawRows)) return [];

  const rows: SearchAnalyticsRow[] = [];
  for (const item of rawRows) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const keys = Array.isArray(r["keys"]) ? (r["keys"] as unknown[]) : [];

    const row: SearchAnalyticsRow = {
      clicks: typeof r["clicks"] === "number" ? r["clicks"] : 0,
      impressions: typeof r["impressions"] === "number" ? r["impressions"] : 0,
      ctr: typeof r["ctr"] === "number" ? r["ctr"] : 0,
      position: typeof r["position"] === "number" ? r["position"] : 0,
    };

    dimensions.forEach((dim, idx) => {
      const value = keys[idx];
      if (typeof value !== "string") return;
      row[dim] = value;
    });

    rows.push(row);
  }
  return rows;
}

/**
 * Parse a GSC `urlInspection/index:inspect` response body into a single
 * `UrlInspectionRow` (GSC inspects one URL per call). `[]` when the
 * response shape is unrecognized (fail-closed read, never throws).
 */
function parseUrlInspection(raw: unknown, url: string): UrlInspectionRow[] {
  if (!raw || typeof raw !== "object") return [];
  const body = raw as Record<string, unknown>;
  const inspectionResult = body["inspectionResult"];
  if (!inspectionResult || typeof inspectionResult !== "object") return [];
  const indexStatusResult = (inspectionResult as Record<string, unknown>)["indexStatusResult"];
  if (!indexStatusResult || typeof indexStatusResult !== "object") return [];
  const s = indexStatusResult as Record<string, unknown>;

  const row: UrlInspectionRow = { url };
  if (typeof s["coverageState"] === "string") row.coverageState = s["coverageState"];
  if (typeof s["indexingState"] === "string") row.indexingState = s["indexingState"];
  if (typeof s["lastCrawlTime"] === "string") row.lastCrawlTime = s["lastCrawlTime"];
  if (typeof s["robotsTxtState"] === "string") row.robotsTxtState = s["robotsTxtState"];
  if (typeof s["pageFetchState"] === "string") row.pageFetchState = s["pageFetchState"];
  return [row];
}

// -- GscAdapter --------------------------------------------------------------

/**
 * Live Google Search Console `SeoDataSource`. Serves `search-analytics` +
 * `url-inspection`; `serp`/`keywords`/`backlinks` are NOT GSC capabilities
 * (`{ kind: "disabled" }` unconditionally — DataForSEO serves those in
 * Sprint 9).
 *
 * bober: no OAuth refresh-grant flow here (unlike `WhoopClient`) — the
 *        access token is injected fully-formed via `getAccessToken`; add a
 *        refresh flow only if/when a token store is wired in a later sprint.
 */
export class GscAdapter implements SeoDataSource {
  constructor(
    private readonly egress: SeoEgressGuard,
    private readonly governor: SeoQuotaGovernor,
    // Injectable transport — default = the ONE global-fetch wrapper
    // (`../adapters/http.js`). Tests inject a fake `HttpClient`.
    private readonly http: HttpClient = defaultHttpClient,
    // OAuth bearer token provider — injected, NEVER hardcoded. Tests stub
    // it (`async () => "test-token"`); production defaults to the env var.
    private readonly getAccessToken: () => Promise<string> = () =>
      Promise.resolve(process.env["GSC_OAUTH_TOKEN"] ?? ""),
  ) {}

  capabilities(): SeoCapability[] {
    return ["search-analytics", "url-inspection"];
  }

  /**
   * Search Analytics query. ADR-5 preamble (egress gate, then quota gate)
   * runs before any network work; `rowLimit` is hard-capped at 25,000
   * regardless of what the caller requests (sc-8-3).
   */
  async searchAnalytics(
    q: SearchAnalyticsQuery,
  ): Promise<DataOutcome<SearchAnalyticsRow[]>> {
    // -- STATEMENT 1: egress gate (ADR-5) --
    try {
      this.egress.assertAllowed("search-console");
    } catch {
      return { kind: "abstain", reason: "egress-search-console-disabled" };
    }

    // -- STATEMENT 2: quota gate (ADR-5); synchronous, never throws --
    const rowLimit = Math.min(q.rowLimit ?? GSC_ROW_LIMIT_CAP, GSC_ROW_LIMIT_CAP);
    const admitReq: QuotaRequest = {
      source: "gsc",
      capability: "search-analytics",
      scope: { siteUrl: q.siteUrl }, // per-site (+ per-user, when available) scope threaded into the governor
      estRows: rowLimit, // worst-case pre-emption
      estCostUsd: 0, // GSC Search Analytics is free
    };
    const decision = this.governor.admit(admitReq);
    if (!decision.admit) {
      return { kind: "abstain", reason: decision.reason };
    }

    // -- Only now may a socket open. --
    try {
      const token = await this.getAccessToken();
      const url = `${GSC_SEARCH_ANALYTICS_BASE}/${encodeURIComponent(q.siteUrl)}/searchAnalytics/query`;
      const res = await this.http.request(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          startDate: q.startDate,
          endDate: q.endDate,
          dimensions: q.dimensions,
          rowLimit,
        }),
      });
      if (!res.ok) {
        return { kind: "abstain", reason: `gsc-http-${res.status}` }; // 429/5xx -> abstain, NEVER throw
      }
      const rows = parseSearchAnalytics(await res.json(), q.dimensions);

      // Book ACTUAL rows served (not the worst-case estimate used for admit()).
      await this.governor.record({ ...admitReq, estRows: rows.length }, 0);

      const provenance: DataProvenance = { source: "gsc", retrievedAt: new Date().toISOString() };
      return { kind: "data", rows, provenance };
    } catch {
      return { kind: "abstain", reason: "source-error" }; // network/parse error -> abstain, NEVER throw
    }
  }

  /**
   * URL Inspection query. Same ADR-5 preamble as `searchAnalytics`; GSC
   * inspects exactly one URL per call, so `estRows` is always 1.
   */
  async urlInspection(q: UrlInspectionQuery): Promise<DataOutcome<UrlInspectionRow[]>> {
    // -- STATEMENT 1: egress gate (ADR-5) --
    try {
      this.egress.assertAllowed("search-console");
    } catch {
      return { kind: "abstain", reason: "egress-search-console-disabled" };
    }

    // -- STATEMENT 2: quota gate (ADR-5); synchronous, never throws --
    const admitReq: QuotaRequest = {
      source: "gsc",
      capability: "url-inspection",
      scope: { siteUrl: q.siteUrl },
      estRows: 1,
      estCostUsd: 0,
    };
    const decision = this.governor.admit(admitReq);
    if (!decision.admit) {
      return { kind: "abstain", reason: decision.reason };
    }

    // -- Only now may a socket open. --
    try {
      const token = await this.getAccessToken();
      const res = await this.http.request(GSC_URL_INSPECTION_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ inspectionUrl: q.inspectionUrl, siteUrl: q.siteUrl }),
      });
      if (!res.ok) {
        return { kind: "abstain", reason: `gsc-http-${res.status}` }; // 429/5xx -> abstain, NEVER throw
      }
      const rows = parseUrlInspection(await res.json(), q.inspectionUrl);
      if (rows.length === 0) {
        return { kind: "abstain", reason: "unrecognized-response-shape" };
      }

      await this.governor.record(admitReq, 0);

      const provenance: DataProvenance = { source: "gsc", retrievedAt: new Date().toISOString() };
      return { kind: "data", rows, provenance };
    } catch {
      return { kind: "abstain", reason: "source-error" }; // network/parse error -> abstain, NEVER throw
    }
  }

  // -- Capabilities GSC does not serve; DataForSEO covers these (Sprint 9) --

  async serp(_q: SerpQuery): Promise<DataOutcome<SerpRow[]>> {
    return { kind: "disabled" };
  }

  async keywords(_q: KeywordQuery): Promise<DataOutcome<KeywordRow[]>> {
    return { kind: "disabled" };
  }

  async backlinks(_q: BacklinkQuery): Promise<DataOutcome<BacklinkRow[]>> {
    return { kind: "disabled" };
  }
}
