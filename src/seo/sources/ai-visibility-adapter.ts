/**
 * AiVisibilityAdapter — the AI-visibility/GEO `SeoDataSource`
 * (spec-20260717-seo-improver-builder, Sprint 5). Near-verbatim clone of
 * `DataForSeoAdapter.serp` (`./dataforseo-adapter.ts:190-238`) — SAME ADR-5
 * guard→admit→call→record→degrade shape — except the injected transport is
 * an `AiVisibilityProvider` port (not an `HttpClient`), the axis is
 * `"ai-visibility"` (not `"serp-provider"`), and `QuotaRequest.source` is
 * `"ai-visibility"`.
 *
 * ADR-5 (`.bober/architecture/arch-20260716-seo-improver-builder-extension-adr-5.md`)
 * is the load-bearing decision here: the concrete AI-visibility provider is
 * DELIBERATELY unpinned (Stage-1 found no evidence pinning Perplexity,
 * Profound, or any other vendor). This adapter therefore depends on an
 * injected `AiVisibilityProvider` port, never a vendor SDK — swapping
 * providers means writing a new `AiVisibilityProvider` implementation
 * OUTSIDE `src/seo/`, with zero changes to this adapter, the seam, or the
 * egress model. A single `ai-visibility` egress axis gates every provider
 * (no per-vendor axis — that would explode `selectSource`'s all-off
 * predicate and threaten the byte-identical-when-off invariant).
 *
 * `aiVisibility()` begins with the same two gates, IN ORDER, before any
 * network work:
 *   1. `this.egress.assertAllowed("ai-visibility")` — throws when the axis
 *      is off; caught immediately and converted to `abstain` WITHOUT ever
 *      calling `this.provider.probe()`.
 *   2. `this.governor.admit(req)` — synchronous, never throws, no side
 *      effect; refused admission also aborts before `probe()` runs.
 * Only after BOTH gates pass does the injected provider run its probe. Any
 * probe error degrades to `{ kind: "abstain", reason: "source-error" }` —
 * this method NEVER throws to the caller, and `governor.record()` is called
 * ONLY after a successful `probe()` (nothing is ever booked for a failed
 * probe).
 *
 * The real global `fetch` is referenced NOWHERE in this file — the injected
 * `AiVisibilityProvider` is the sole transport, and no vendor SDK is
 * imported anywhere under `src/seo/` (sc-5-4). Tests inject a hand-rolled
 * fake provider; production wiring for a real provider is a later sprint
 * (Sprint 9, nonGoal here).
 */
import type { SeoEgressGuard } from "../egress.js";
import type { SeoQuotaGovernor, QuotaRequest } from "../quota-governor.js";
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
import type { DataOutcome, DataProvenance } from "../types.js";

/**
 * Provider-agnostic AI-visibility port (ADR-5). The concrete vendor
 * (Perplexity, a self-hosted probe harness, a future provider) lives
 * OUTSIDE `src/seo/` and is injected via the `AiVisibilityAdapter`
 * constructor — this interface is the ONLY provider surface this module
 * knows about.
 *
 * `probe()` returns already-typed `AiVisibilityRow[]` — each concrete
 * provider is responsible for mapping its own vendor response shape into
 * this row type; the adapter does no vendor-specific parsing.
 */
export interface AiVisibilityProvider {
  /** Provider identifier (surfaced in `AiVisibilityRow.provider` by the concrete implementation, not by this adapter). */
  readonly name: string;
  /** Fixed per-prompt USD price — the adapter computes `estCostUsd = estCostUsdPerPrompt * prompts.length`. */
  readonly estCostUsdPerPrompt: number;
  probe(target: string, prompts: string[], locale?: string): Promise<AiVisibilityRow[]>;
}

/**
 * AI-visibility `SeoDataSource`. Serves ONLY `ai-visibility` — every other
 * capability is `{ kind: "disabled" }` unconditionally (this adapter is not
 * a GSC/DataForSEO/crawl source).
 */
export class AiVisibilityAdapter implements SeoDataSource {
  constructor(
    private readonly egress: SeoEgressGuard,
    private readonly governor: SeoQuotaGovernor,
    // Injectable, provider-agnostic port — REQUIRED, no default (ADR-5: no
    // vendor is pinned, so there is no sane default to fall back to).
    private readonly provider: AiVisibilityProvider,
  ) {}

  capabilities(): SeoCapability[] {
    return ["ai-visibility"];
  }

  /**
   * AI-visibility probe. ADR-5 preamble (egress gate, then quota gate) runs
   * before any network work; USD cost is `estCostUsdPerPrompt * prompts.length`
   * — booked in `admit()` (estimate) and `record()` (actual, identical since
   * the price is a fixed per-prompt rate).
   */
  async aiVisibility(q: AiVisibilityQuery): Promise<DataOutcome<AiVisibilityRow[]>> {
    // -- STATEMENT 1: egress gate (ADR-5) --
    try {
      this.egress.assertAllowed("ai-visibility");
    } catch {
      return { kind: "abstain", reason: "egress-ai-visibility-disabled" };
    }

    // -- STATEMENT 2: quota gate (ADR-5); synchronous, never throws --
    const estCostUsd = this.provider.estCostUsdPerPrompt * q.prompts.length;
    const admitReq: QuotaRequest = {
      source: "ai-visibility",
      capability: "ai-visibility",
      scope: {},
      estRows: q.prompts.length, // inert for non-gsc sources (quota-governor.ts admit()/record())
      estCostUsd,
    };
    const decision = this.governor.admit(admitReq);
    if (!decision.admit) {
      return { kind: "abstain", reason: decision.reason };
    }

    // -- Only now may the provider open a socket. --
    try {
      const rows = await this.provider.probe(q.target, q.prompts, q.locale);

      // Fixed per-prompt price — the actual charge equals the estimate.
      const actualCostUsd = estCostUsd;
      await this.governor.record(admitReq, actualCostUsd); // ONLY after success

      const provenance: DataProvenance = {
        source: "ai-visibility",
        retrievedAt: new Date().toISOString(),
        costUsd: actualCostUsd,
      };
      return { kind: "data", rows, provenance };
    } catch {
      return { kind: "abstain", reason: "source-error" }; // provider error -> abstain, NEVER throw, NOTHING booked
    }
  }

  // -- Capabilities this adapter does not serve (all { kind: "disabled" }) --

  async searchAnalytics(_q: SearchAnalyticsQuery): Promise<DataOutcome<SearchAnalyticsRow[]>> {
    return { kind: "disabled" };
  }

  async urlInspection(_q: UrlInspectionQuery): Promise<DataOutcome<UrlInspectionRow[]>> {
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

  async linkGraph(_q: LinkGraphQuery): Promise<DataOutcome<LinkGraphRow[]>> {
    return { kind: "disabled" };
  }
}
