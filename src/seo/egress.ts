/** SeoEgressGuard — four independently opt-in live-data egress axes, all default false (spec-20260715-ultimate-seo-suite, Sprint 1; widened spec-20260717-seo-improver-builder, Sprint 1; mirrors medical/egress.ts:17-59, ADR-6). */
import type { BoberConfig } from "../config/schema.js";

/** The four independent live-data egress axes. All default FALSE (code-enforced zero-egress). */
export type SeoEgressAxis = "search-console" | "serp-provider" | "ai-visibility" | "site-crawl";

/**
 * Guards outbound egress for the SEO pipeline's live-data adapters (Google
 * Search Console, DataForSEO, AI-visibility provider, damcrawler site-crawl).
 *
 * The four axes operate INDEPENDENTLY — opting in one does NOT opt in any
 * other. All default false when absent from config. `assertAllowed` throws
 * if the axis is not opted in, providing a hard code-enforced barrier that
 * every network-opening adapter method must call first (ADR-5).
 *
 * bober: plain decision object; no network import here; swap for a shared
 *        policy engine if per-scope granularity is ever needed.
 */
export class SeoEgressGuard {
  constructor(
    private readonly searchConsole: boolean,
    private readonly serpProvider: boolean,
    // NEW axes, DEFAULTED so the ~28 existing 2-arg `new SeoEgressGuard(a, b)`
    // call sites across the two adapter test files keep compiling untouched.
    private readonly aiVisibility: boolean = false,
    private readonly siteCrawl: boolean = false,
  ) {}

  /** Build from BoberConfig seo section; all four axes default false when absent. */
  static fromConfig(config: BoberConfig): SeoEgressGuard {
    const seo = config.seo;
    return new SeoEgressGuard(
      seo?.egress?.["search-console"] ?? false,
      seo?.egress?.["serp-provider"] ?? false,
      seo?.egress?.["ai-visibility"] ?? false,
      seo?.egress?.["site-crawl"] ?? false,
    );
  }

  /** Returns true only when the axis has been explicitly opted in via config. */
  isAllowed(axis: SeoEgressAxis): boolean {
    switch (axis) {
      case "search-console":
        return this.searchConsole;
      case "serp-provider":
        return this.serpProvider;
      case "ai-visibility":
        return this.aiVisibility;
      case "site-crawl":
        return this.siteCrawl;
      default: {
        const _exhaustive: never = axis; // compile error if a SeoEgressAxis value is unhandled
        return _exhaustive;
      }
    }
  }

  /**
   * Throws an Error when the axis is not enabled.
   * Returns void (not throws) when the axis is allowed.
   */
  assertAllowed(axis: SeoEgressAxis): void {
    if (!this.isAllowed(axis)) {
      throw new Error(`Egress axis '${axis}' not enabled`);
    }
  }
}
