/** ResearchEgressGuard — online-research egress axis, default false (Sprint 3, ADR-6 lineage). */
import type { BoberConfig } from "../config/schema.js";

/** The single research egress axis. Defaults FALSE (code-enforced zero-egress). */
export type EgressAxis = "online-research";

/**
 * Guards outbound online-research egress.
 *
 * A single axis — onlineResearch — defaults to false.
 * isAllowed returns false by default; assertAllowed throws when off.
 * All default false when absent from config (fail-closed, ADR-6 lineage).
 *
 * bober: plain decision object; no network import here; swap for ABAC policy if
 *        per-user granularity is needed.
 */
export class ResearchEgressGuard {
  constructor(private readonly onlineResearch: boolean) {}

  /** Build from BoberConfig research section; axis defaults false when absent. */
  static fromConfig(config: BoberConfig): ResearchEgressGuard {
    return new ResearchEgressGuard(config.research?.egress?.onlineResearch ?? false);
  }

  /** Returns true only when the axis has been explicitly opted in via config. */
  isAllowed(axis: EgressAxis): boolean {
    switch (axis) {
      case "online-research":
        return this.onlineResearch;
      default: {
        const _exhaustive: never = axis; // compile error if an EgressAxis value is unhandled
        return _exhaustive;
      }
    }
  }

  /**
   * Throws an Error when the axis is not enabled.
   * Returns void (not throws) when the axis is allowed.
   */
  assertAllowed(axis: EgressAxis): void {
    if (!this.isAllowed(axis)) {
      throw new Error(`Egress axis '${axis}' not enabled`);
    }
  }
}
