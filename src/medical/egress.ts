/** EgressGuard — three independently opt-in egress axes, all default false (Phase 6, Sprint 6; ADR-6). */
import type { BoberConfig } from "../config/schema.js";

/** The three independent egress axes. All default FALSE (code-enforced zero-egress, ADR-6). */
export type EgressAxis = "cloud-inference" | "literature-retrieval" | "device-connection";

/**
 * Guards outbound egress for the medical pipeline.
 *
 * Three axes operate INDEPENDENTLY — enabling one does NOT enable the others.
 * All default false when absent from config. assertAllowed throws if the axis
 * is not opted in, providing a hard code-enforced barrier.
 *
 * bober: plain decision object; no network import here; swap for ABAC policy if
 *        per-user granularity is needed.
 */
export class EgressGuard {
  constructor(
    private readonly cloudInference: boolean,
    private readonly literatureRetrieval: boolean,
    private readonly deviceConnection: boolean = false,
  ) {}

  /** Build from BoberConfig medical section; all axes default false when absent. */
  static fromConfig(config: BoberConfig): EgressGuard {
    const med = config.medical;
    return new EgressGuard(
      med?.egress?.cloudInference ?? false,
      med?.egress?.literatureRetrieval ?? false,
      med?.egress?.deviceConnection ?? false,
    );
  }

  /** Returns true only when the axis has been explicitly opted in via config. */
  isAllowed(axis: EgressAxis): boolean {
    switch (axis) {
      case "cloud-inference":
        return this.cloudInference;
      case "literature-retrieval":
        return this.literatureRetrieval;
      case "device-connection":
        return this.deviceConnection;
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
