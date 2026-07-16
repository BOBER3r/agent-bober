/**
 * DataForSeoAdapter — the SECOND live network `SeoDataSource`
 * (spec-20260715-ultimate-seo-suite, Sprint 9). Serves `serp` + `keywords` +
 * `backlinks` from the real DataForSEO v3 API, behind the `"serp-provider"`
 * egress axis. Near-verbatim clone of `GscAdapter` (Sprint 8) — SAME ADR-5
 * shape, six diffs: axis, which methods serve data, endpoints/auth, and
 * (the load-bearing new behavior) real USD cost booking.
 *
 * ADR-5 (the load-bearing invariant of this file, reused verbatim from
 * `GscAdapter`): EVERY capability method that would open a socket begins
 * with these two gates, IN ORDER, before any network work:
 *   1. `this.egress.assertAllowed("serp-provider")` — throws when the axis
 *      is off; caught immediately and converted to `abstain` WITHOUT opening
 *      a socket (never hoisted into a caller/runner — see `src/seo/egress.ts`).
 *   2. `this.governor.admit(req)` — synchronous, never throws, no side
 *      effect; refused admission also aborts before any socket opens.
 * Only after BOTH gates pass does the injected `HttpClient` make a request.
 * Any HTTP/network/parse error (including 402/429/5xx) degrades to
 * `{ kind: "abstain", reason }` — this method NEVER throws to the caller.
 *
 * DataForSEO differs from GSC in that it is PAY-AS-YOU-GO: unlike GSC's
 * `estCostUsd: 0` (free), every serving method here computes a real USD
 * cost (research §4 price ladder), passes it as `estCostUsd` to `admit()`
 * (worst-case pre-emption), books the ACTUAL USD via `governor.record()`
 * only after a successful round-trip, and stamps `provenance.costUsd`.
 * A 402/429/5xx means DataForSEO did NOT charge — abstain BEFORE any
 * `record()` call, so nothing is ever booked for a failed request.
 *
 * The real global `fetch` is referenced NOWHERE in this file — the injected
 * `HttpClient` (`../adapters/http.js`) is the sole transport, defaulting to
 * `defaultHttpClient` (production) or a fixture/spy client (tests), so CI
 * never opens a real socket.
 */
import { Buffer } from "node:buffer";
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

// -- DataForSEO endpoint + price constants (research S4) --------------------

const DFS_BASE = "https://api.dataforseo.com/v3";
const DFS_SERP_URL = `${DFS_BASE}/serp/google/organic/live/advanced`;
const DFS_KEYWORDS_URL = `${DFS_BASE}/dataforseo_labs/google/keyword_ideas/live`;
const DFS_BACKLINKS_URL = `${DFS_BASE}/backlinks/backlinks/live`;

/** SERP price ladder, per task — research §4 (research-...-research.md:98). DO NOT approximate. */
const SERP_PRICE_USD: Record<NonNullable<SerpQuery["priority"]>, number> = {
  standard: 0.0006,
  priority: 0.0012,
  live: 0.002,
};

/** Backlinks pricing — research §4: `$0.02/req + $0.00003/row`. */
const BACKLINKS_BASE_USD = 0.02;
const BACKLINKS_PER_ROW_USD = 0.00003;

/**
 * bober: research §4 prices only SERP + backlinks, not the keyword_ideas
 *        endpoint. Using the same per-task price as standard SERP ($0.0006)
 *        as a documented placeholder — this is an ASSUMPTION, not a pinned
 *        research number. Revisit if/when a keywords price is confirmed.
 */
const KEYWORDS_TASK_USD = 0.0006;

// -- Response parsers (pure, total — [] on any shape mismatch) --------------

/** Walk a DataForSEO v3 envelope's `tasks[0].result[0].items[]`; `[]` on any shape mismatch. */
function firstResultItems(raw: unknown): unknown[] {
  if (!raw || typeof raw !== "object") return [];
  const tasks = (raw as Record<string, unknown>)["tasks"];
  if (!Array.isArray(tasks) || tasks.length === 0) return [];
  const task0 = tasks[0];
  if (!task0 || typeof task0 !== "object") return [];
  const result = (task0 as Record<string, unknown>)["result"];
  if (!Array.isArray(result) || result.length === 0) return [];
  const result0 = result[0];
  if (!result0 || typeof result0 !== "object") return [];
  const items = (result0 as Record<string, unknown>)["items"];
  return Array.isArray(items) ? items : [];
}

/** Parse a DataForSEO `serp/google/organic/live/advanced` response into typed rows. */
function parseSerp(raw: unknown, keyword: string, location: string): SerpRow[] {
  const rows: SerpRow[] = [];
  for (const item of firstResultItems(raw)) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r["rank_absolute"] !== "number" || typeof r["url"] !== "string") continue;
    const row: SerpRow = { keyword, position: r["rank_absolute"], url: r["url"], location };
    if (typeof r["title"] === "string") row.title = r["title"];
    rows.push(row);
  }
  return rows;
}

/** Parse a DataForSEO `dataforseo_labs/google/keyword_ideas/live` response into typed rows. */
function parseKeywords(raw: unknown, location: string): KeywordRow[] {
  const rows: KeywordRow[] = [];
  for (const item of firstResultItems(raw)) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r["keyword"] !== "string") continue;
    const row: KeywordRow = { keyword: r["keyword"], location };
    const info = r["keyword_info"];
    if (info && typeof info === "object") {
      const i = info as Record<string, unknown>;
      if (typeof i["search_volume"] === "number") row.searchVolume = i["search_volume"];
      if (typeof i["cpc"] === "number") row.cpc = i["cpc"];
      if (typeof i["competition"] === "number") row.competition = i["competition"];
    }
    rows.push(row);
  }
  return rows;
}

/** Parse a DataForSEO `backlinks/backlinks/live` response into typed rows. */
function parseBacklinks(raw: unknown): BacklinkRow[] {
  const rows: BacklinkRow[] = [];
  for (const item of firstResultItems(raw)) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r["url_from"] !== "string" || typeof r["url_to"] !== "string") continue;
    const row: BacklinkRow = { sourceUrl: r["url_from"], targetUrl: r["url_to"] };
    if (typeof r["anchor"] === "string") row.anchor = r["anchor"];
    if (typeof r["dofollow"] === "boolean") row.dofollow = r["dofollow"];
    rows.push(row);
  }
  return rows;
}

// -- DataForSeoAdapter --------------------------------------------------------

/**
 * Live DataForSEO `SeoDataSource`. Serves `serp` + `keywords` + `backlinks`;
 * `search-analytics`/`url-inspection` are NOT DataForSEO capabilities
 * (`{ kind: "disabled" }` unconditionally — GscAdapter serves those).
 *
 * bober: no OAuth/refresh flow here — the HTTP Basic credential is injected
 *        fully-formed via `getBasicAuth`; add credential rotation only if a
 *        credential store is wired in a later sprint.
 */
export class DataForSeoAdapter implements SeoDataSource {
  constructor(
    private readonly egress: SeoEgressGuard,
    private readonly governor: SeoQuotaGovernor,
    // Injectable transport — default = the ONE global-fetch wrapper
    // (`../adapters/http.js`). Tests inject a fake `HttpClient`.
    private readonly http: HttpClient = defaultHttpClient,
    // HTTP Basic credential provider — injected, NEVER hardcoded. Tests stub
    // it (`async () => "dGVzdDp0ZXN0"`); production defaults to base64
    // `login:password` read from env.
    private readonly getBasicAuth: () => Promise<string> = () =>
      Promise.resolve(
        Buffer.from(
          `${process.env["DATAFORSEO_LOGIN"] ?? ""}:${process.env["DATAFORSEO_PASSWORD"] ?? ""}`,
        ).toString("base64"),
      ),
  ) {}

  capabilities(): SeoCapability[] {
    return ["serp", "keywords", "backlinks"];
  }

  /**
   * SERP query. ADR-5 preamble (egress gate, then quota gate) runs before
   * any network work; USD cost is the fixed per-task price for `q.priority`
   * (default `"standard"`) — booked in `admit()` (estimate) and `record()`
   * (actual, identical since SERP is a fixed-price task, sc-9-3).
   */
  async serp(q: SerpQuery): Promise<DataOutcome<SerpRow[]>> {
    // -- STATEMENT 1: egress gate (ADR-5) --
    try {
      this.egress.assertAllowed("serp-provider");
    } catch {
      return { kind: "abstain", reason: "egress-serp-provider-disabled" };
    }

    // -- STATEMENT 2: quota gate (ADR-5); synchronous, never throws --
    const price = SERP_PRICE_USD[q.priority ?? "standard"];
    const admitReq: QuotaRequest = {
      source: "dataforseo",
      capability: "serp",
      scope: {},
      estRows: 1, // one task per call; inert for dataforseo (quota-governor.ts:158,179)
      estCostUsd: price,
    };
    const decision = this.governor.admit(admitReq);
    if (!decision.admit) {
      return { kind: "abstain", reason: decision.reason };
    }

    // -- Only now may a socket open. --
    try {
      const cred = await this.getBasicAuth();
      const res = await this.http.request(DFS_SERP_URL, {
        method: "POST",
        headers: { Authorization: `Basic ${cred}`, "Content-Type": "application/json" },
        body: JSON.stringify([{ keyword: q.keyword, location_name: q.location, priority: q.priority }]),
      });
      if (!res.ok) {
        return { kind: "abstain", reason: `dataforseo-http-${res.status}` }; // 402/429/5xx -> abstain, NEVER throw
      }
      const rows = parseSerp(await res.json(), q.keyword, q.location);

      // SERP is a fixed-price task — the actual charge equals the estimate.
      const actualCostUsd = price;
      await this.governor.record(admitReq, actualCostUsd);

      const provenance: DataProvenance = {
        source: "dataforseo",
        retrievedAt: new Date().toISOString(),
        costUsd: actualCostUsd,
      };
      return { kind: "data", rows, provenance };
    } catch {
      return { kind: "abstain", reason: "source-error" }; // network/parse error -> abstain, NEVER throw
    }
  }

  /**
   * Keyword ideas query. Same ADR-5 preamble as `serp`; USD cost uses the
   * documented `KEYWORDS_TASK_USD` placeholder (research §4 does not pin a
   * keywords price — see the constant's `bober:` comment).
   */
  async keywords(q: KeywordQuery): Promise<DataOutcome<KeywordRow[]>> {
    // -- STATEMENT 1: egress gate (ADR-5) --
    try {
      this.egress.assertAllowed("serp-provider");
    } catch {
      return { kind: "abstain", reason: "egress-serp-provider-disabled" };
    }

    // -- STATEMENT 2: quota gate (ADR-5); synchronous, never throws --
    const admitReq: QuotaRequest = {
      source: "dataforseo",
      capability: "keywords",
      scope: {},
      estRows: q.keywords.length,
      estCostUsd: KEYWORDS_TASK_USD,
    };
    const decision = this.governor.admit(admitReq);
    if (!decision.admit) {
      return { kind: "abstain", reason: decision.reason };
    }

    // -- Only now may a socket open. --
    try {
      const cred = await this.getBasicAuth();
      const res = await this.http.request(DFS_KEYWORDS_URL, {
        method: "POST",
        headers: { Authorization: `Basic ${cred}`, "Content-Type": "application/json" },
        body: JSON.stringify([{ keywords: q.keywords, location_name: q.location }]),
      });
      if (!res.ok) {
        return { kind: "abstain", reason: `dataforseo-http-${res.status}` }; // 402/429/5xx -> abstain, NEVER throw
      }
      const rows = parseKeywords(await res.json(), q.location);

      const actualCostUsd = KEYWORDS_TASK_USD;
      await this.governor.record({ ...admitReq, estRows: rows.length }, actualCostUsd);

      const provenance: DataProvenance = {
        source: "dataforseo",
        retrievedAt: new Date().toISOString(),
        costUsd: actualCostUsd,
      };
      return { kind: "data", rows, provenance };
    } catch {
      return { kind: "abstain", reason: "source-error" }; // network/parse error -> abstain, NEVER throw
    }
  }

  /**
   * Backlinks query. Same ADR-5 preamble; USD cost is `$0.02/req` plus
   * `$0.00003/row` — `admit()` uses the worst-case `q.limit` estimate,
   * `record()`/`provenance.costUsd` use the ACTUAL returned row count.
   */
  async backlinks(q: BacklinkQuery): Promise<DataOutcome<BacklinkRow[]>> {
    // -- STATEMENT 1: egress gate (ADR-5) --
    try {
      this.egress.assertAllowed("serp-provider");
    } catch {
      return { kind: "abstain", reason: "egress-serp-provider-disabled" };
    }

    // -- STATEMENT 2: quota gate (ADR-5); synchronous, never throws --
    const admitReq: QuotaRequest = {
      source: "dataforseo",
      capability: "backlinks",
      scope: {},
      estRows: q.limit ?? 0,
      estCostUsd: BACKLINKS_BASE_USD + (q.limit ?? 0) * BACKLINKS_PER_ROW_USD, // worst-case pre-emption
    };
    const decision = this.governor.admit(admitReq);
    if (!decision.admit) {
      return { kind: "abstain", reason: decision.reason };
    }

    // -- Only now may a socket open. --
    try {
      const cred = await this.getBasicAuth();
      const res = await this.http.request(DFS_BACKLINKS_URL, {
        method: "POST",
        headers: { Authorization: `Basic ${cred}`, "Content-Type": "application/json" },
        body: JSON.stringify([{ target: q.target, limit: q.limit }]),
      });
      if (!res.ok) {
        return { kind: "abstain", reason: `dataforseo-http-${res.status}` }; // 402/429/5xx -> abstain, NEVER throw
      }
      const rows = parseBacklinks(await res.json());

      // Actual charge is recomputed from the rows actually returned, not the worst-case estimate.
      const actualCostUsd = BACKLINKS_BASE_USD + rows.length * BACKLINKS_PER_ROW_USD;
      await this.governor.record({ ...admitReq, estRows: rows.length }, actualCostUsd);

      const provenance: DataProvenance = {
        source: "dataforseo",
        retrievedAt: new Date().toISOString(),
        costUsd: actualCostUsd,
      };
      return { kind: "data", rows, provenance };
    } catch {
      return { kind: "abstain", reason: "source-error" }; // network/parse error -> abstain, NEVER throw
    }
  }

  // -- Capabilities DataForSEO does not serve; GscAdapter covers these --

  async searchAnalytics(_q: SearchAnalyticsQuery): Promise<DataOutcome<SearchAnalyticsRow[]>> {
    return { kind: "disabled" };
  }

  async urlInspection(_q: UrlInspectionQuery): Promise<DataOutcome<UrlInspectionRow[]>> {
    return { kind: "disabled" };
  }
}
