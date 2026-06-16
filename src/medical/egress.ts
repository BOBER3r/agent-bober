/** EgressGuard — two independently opt-in egress axes, both default false (Phase 6, Sprint 6; ADR-6). */
import type { BoberConfig } from "../config/schema.js";

/** The two independent egress axes. Both default FALSE (code-enforced zero-egress, ADR-6). */
export type EgressAxis = "cloud-inference" | "literature-retrieval";

/**
 * Guards outbound egress for the medical pipeline.
 *
 * Two axes operate INDEPENDENTLY — enabling one does NOT enable the other.
 * Both default false when absent from config. assertAllowed throws if the axis
 * is not opted in, providing a hard code-enforced barrier.
 *
 * bober: plain decision object; no network import here; swap for ABAC policy if
 *        per-user granularity is needed.
 */
export class EgressGuard {
  constructor(
    private readonly cloudInference: boolean,
    private readonly literatureRetrieval: boolean,
  ) {}

  /** Build from BoberConfig medical section; both axes default false when absent. */
  static fromConfig(config: BoberConfig): EgressGuard {
    const med = config.medical;
    return new EgressGuard(
      med?.egress?.cloudInference ?? false,
      med?.egress?.literatureRetrieval ?? false,
    );
  }

  /** Returns true only when the axis has been explicitly opted in via config. */
  isAllowed(axis: EgressAxis): boolean {
    return axis === "cloud-inference" ? this.cloudInference : this.literatureRetrieval;
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
