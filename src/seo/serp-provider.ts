/**
 * SerpProvider port (spec-20260717-seo-improver-builder, Sprint 8; ADR-10).
 * Mirrors the ADR-5 `AiVisibilityProvider` port shape
 * (`sources/ai-visibility-adapter.ts:73-79`) — `name`, an `estCostUsd*`
 * metadata field, one async method returning a typed `DataOutcome`.
 *
 * Two implementers this sprint:
 *  - `DataForSeoSerpProvider` (`sources/dataforseo-serp-provider.ts`) — a
 *    thin delegate over the existing, already egress+governor-gated
 *    `DataForSeoAdapter.serp` path. Axis `"serp-provider"`; metered USD
 *    booked INSIDE the wrapped adapter (never re-booked here).
 *  - `DamcrawlerSerpProvider` (`sources/damcrawler-serp-provider.ts`) — a
 *    zero-USD scrape via damcrawler's `search()`. Axis `"site-crawl"`
 *    (ADR-10: SAME risk surface as the crawler, NOT `"serp-provider"`,
 *    which means "licensed metered API").
 *
 * `resolveSerpProvider` below is the `config.seo.serp.provider` selection
 * factory (default `"dataforseo"`, preserving today's serp output
 * byte-identically) — mirrors `selectSource` (`runner.ts:177-195`) in
 * shape, but is NOT wired into `selectSource`/the router this sprint
 * (Sprint 9, nonGoal); callers construct+inject it directly.
 */
import type { BoberConfig } from "../config/schema.js";
import type { DataOutcome } from "./types.js";
import type { SerpRow } from "./data-source.js";
import type { SeoEgressGuard } from "./egress.js";
import type { DataForSeoAdapter } from "./sources/dataforseo-adapter.js";
import { DataForSeoSerpProvider } from "./sources/dataforseo-serp-provider.js";
import { DamcrawlerSerpProvider } from "./sources/damcrawler-serp-provider.js";

/**
 * Provider-agnostic SERP port. `serp(keyword, location)` returns already
 * degrade-safe `DataOutcome<SerpRow[]>` — `disabled`/`abstain`/`data`, NEVER
 * throws (both implementers uphold this, per their own docstrings).
 */
export interface SerpProvider {
  readonly name: "dataforseo" | "damcrawler";
  /**
   * Documented per-result USD price (0.0006 for dataforseo, 0 for
   * damcrawler). Metadata only — actual USD is booked (or not booked) by
   * the concrete implementation, never by a caller reading this field.
   */
  readonly estCostUsdPerResult: number;
  serp(keyword: string, location: string): Promise<DataOutcome<SerpRow[]>>;
}

/**
 * Select which self-gating `SerpProvider` `config.seo.serp.provider` names
 * (default `"dataforseo"`). This factory does NO gating itself — each
 * returned provider asserts its own egress axis on `.serp()` — it only
 * decides which already-constructed dependency to wrap. Callers supply the
 * `DataForSeoAdapter` and `SeoEgressGuard` they already built (mirrors the
 * dependency-injection style used throughout `src/seo/sources/`).
 */
export function resolveSerpProvider(
  config: BoberConfig,
  dataForSeoAdapter: DataForSeoAdapter,
  egress: SeoEgressGuard,
): SerpProvider {
  const providerName = config.seo?.serp?.provider ?? "dataforseo";
  return providerName === "damcrawler"
    ? new DamcrawlerSerpProvider(egress)
    : new DataForSeoSerpProvider(dataForSeoAdapter);
}
