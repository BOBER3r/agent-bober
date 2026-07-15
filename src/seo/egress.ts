/** SeoEgressGuard — two independently opt-in live-data egress axes, both default false (spec-20260715-ultimate-seo-suite, Sprint 1; mirrors medical/egress.ts:17-59, ADR-6). */
import type { BoberConfig } from "../config/schema.js";

/** The two independent live-data egress axes. Both default FALSE (code-enforced zero-egress). */
export type SeoEgressAxis = "search-console" | "serp-provider";

/**
 * Guards outbound egress for the SEO pipeline's two live-data adapters
 * (Google Search Console, DataForSEO).
 *
 * The two axes operate INDEPENDENTLY — opting in one does NOT opt in the
 * other. Both default false when absent from config. `assertAllowed` throws
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
  ) {}

  /** Build from BoberConfig seo section; both axes default false when absent. */
  static fromConfig(config: BoberConfig): SeoEgressGuard {
    const seo = config.seo;
    return new SeoEgressGuard(
      seo?.egress?.["search-console"] ?? false,
      seo?.egress?.["serp-provider"] ?? false,
    );
  }

  /** Returns true only when the axis has been explicitly opted in via config. */
  isAllowed(axis: SeoEgressAxis): boolean {
    switch (axis) {
      case "search-console":
        return this.searchConsole;
      case "serp-provider":
        return this.serpProvider;
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
