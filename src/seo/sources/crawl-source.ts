/**
 * CrawlSource — the `url-inspection` + `link-graph` `SeoDataSource` adapter
 * over `CrawlEngine` (spec-20260717-seo-improver-builder, Sprint 7; ADR-6,
 * ADR-8).
 *
 * Wraps the Sprint-6 `DamcrawlerCrawlEngine` (which self-guards the
 * `site-crawl` egress axis, the optional-dependency load, the F2
 * engine-boundary SSRF check, and F1 title/url/body sanitization). This
 * adapter adds two things on top:
 *
 *   1. The GSC url-inspection LEDGER GATE (ADR-6): every crawl call books
 *      against the SAME `governor.admit({ source:"gsc",
 *      capability:"url-inspection", estRows:pageBudget })` ceiling the
 *      live GSC adapter uses (2,000 queries/day/property) — crawling is
 *      free (`estCostUsd:0`, ADR-9) but is NOT free of the daily-quantity
 *      ceiling, so a crawl that would exceed it abstains instead of
 *      over-crawling (sc-7-2). `admit()` gates BEFORE the engine is ever
 *      called; `record()` runs ONLY after the engine returns `data`.
 *   2. DEFENSE-IN-DEPTH row sanitization (sc-7-3): this adapter holds its
 *      OWN `ContentSanitizer` and cleans every free-text field it emits
 *      (url-inspection `url`; link-graph `fromUrl`/`toUrl`/`anchor`) even
 *      though the engine already sanitizes what it controls — an injected
 *      test double standing in for a future/alternate `CrawlEngine`
 *      implementation might not.
 *
 * Serves ONLY `url-inspection` and `link-graph` (sc-7-1); every other
 * capability is `{ kind: "disabled" }` unconditionally. Precedence between
 * this source and `GscAdapter` for `url-inspection` (when both `site-crawl`
 * and `search-console` are on) is the router's job (ADR-8, Sprint 9,
 * nonGoal here) — this class is not wired into `selectSource` this sprint.
 */
import type { SeoQuotaGovernor, QuotaRequest } from "../quota-governor.js";
import type { CrawlEngine } from "../crawl-engine.js";
import type { ContentSanitizer } from "../content-sanitizer.js";
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
  AiVisibilityQuery,
  AiVisibilityRow,
  LinkGraphQuery,
  LinkGraphRow,
} from "../data-source.js";
import type { DataOutcome } from "../types.js";

export class CrawlSource implements SeoDataSource {
  constructor(
    private readonly governor: SeoQuotaGovernor,
    private readonly engine: CrawlEngine,
    private readonly sanitizer: ContentSanitizer,
  ) {}

  capabilities(): SeoCapability[] {
    return ["url-inspection", "link-graph"];
  }

  /**
   * URL indexability via `CrawlEngine.urlVisibility` (damcrawler
   * `probeVisibility`). Ledger-gated (sc-7-2), then defense-in-depth
   * sanitized (sc-7-3) before it reaches the caller/analyzer.
   */
  async urlInspection(q: UrlInspectionQuery): Promise<DataOutcome<UrlInspectionRow[]>> {
    const pageBudget = 1; // one probe per inspection URL
    const req: QuotaRequest = {
      source: "gsc",
      capability: "url-inspection",
      scope: { siteUrl: q.siteUrl },
      estRows: pageBudget,
      estCostUsd: 0, // crawling is free (ADR-9) — only the daily-quantity ceiling applies
    };
    const decision = this.governor.admit(req);
    if (!decision.admit) return { kind: "abstain", reason: decision.reason }; // over-budget => abstain, NO engine call

    const out = await this.engine.urlVisibility(q);
    if (out.kind !== "data") return out; // propagate the engine's own abstain/disabled unchanged

    const rows: UrlInspectionRow[] = out.rows.map((r) => ({
      ...r,
      url: this.sanitizer.clean(r.url, r.url).content,
    }));
    await this.governor.record(req, 0); // ONLY after a successful engine call
    return { kind: "data", rows, provenance: out.provenance };
  }

  /**
   * Internal link graph via `CrawlEngine.linkGraph`. Ledger-gated against
   * the SAME url-inspection ceiling (ADR-6 — the crawl consumes the same
   * ledger counter regardless of which capability it serves), then
   * defense-in-depth sanitized.
   */
  async linkGraph(q: LinkGraphQuery): Promise<DataOutcome<LinkGraphRow[]>> {
    const pageBudget = q.limit ?? 1;
    const req: QuotaRequest = {
      source: "gsc",
      capability: "url-inspection",
      scope: {},
      estRows: pageBudget,
      estCostUsd: 0,
    };
    const decision = this.governor.admit(req);
    if (!decision.admit) return { kind: "abstain", reason: decision.reason };

    const out = await this.engine.linkGraph(q);
    if (out.kind !== "data") return out;

    const rows: LinkGraphRow[] = out.rows.map((r) => ({
      fromUrl: this.sanitizer.clean(r.fromUrl, r.fromUrl).content,
      toUrl: this.sanitizer.clean(r.toUrl, r.fromUrl).content,
      anchor: r.anchor === undefined ? undefined : this.sanitizer.clean(r.anchor, r.fromUrl).content,
      internal: r.internal,
    }));
    await this.governor.record(req, 0);
    return { kind: "data", rows, provenance: out.provenance };
  }

  // -- Every other capability is unserved by CrawlSource (sc-7-1) ---------

  async searchAnalytics(_q: SearchAnalyticsQuery): Promise<DataOutcome<SearchAnalyticsRow[]>> {
    return { kind: "disabled" };
  }

  async serp(_q: SerpQuery): Promise<DataOutcome<SerpRow[]>> {
    return { kind: "disabled" };
  }

  async keywords(_q: KeywordQuery): Promise<DataOutcome<KeywordRow[]>> {
    return { kind: "disabled" };
  }

  async backlinks(_q: BacklinkQuery): Promise<DataOutcome<BacklinkRow[]>> {
    return { kind: "disabled" };
  }

  async aiVisibility(_q: AiVisibilityQuery): Promise<DataOutcome<AiVisibilityRow[]>> {
    return { kind: "disabled" };
  }
}
