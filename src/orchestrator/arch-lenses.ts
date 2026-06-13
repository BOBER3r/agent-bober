// ── Lens catalog ────────────────────────────────────────────────────

/** Built-in architect lens focus fragments. Each must be distinct and non-empty (C2). */
const ARCH_LENS_CATALOG: Record<string, string> = {
  scalability:
    "Focus on whether the proposed architecture can handle projected load growth. Evaluate horizontal and vertical scaling paths, bottlenecks, stateful vs stateless components, and whether partitioning or sharding strategies are available when needed.",
  security:
    "Focus on the threat surface introduced by this architecture. Evaluate trust boundaries, data flows across zones, authentication and authorisation enforcement points, secrets management, and exposure of internal services.",
  cost:
    "Focus on the total cost of ownership implied by this architecture. Evaluate compute, storage, and egress costs at projected scale, licensing or SaaS subscription expenses, and the operational overhead of running, monitoring, and scaling the system.",
  operability:
    "Focus on how easy it will be to operate this architecture in production. Evaluate observability (metrics, logs, traces), deployment complexity, rollout and rollback procedures, on-call burden, and the blast radius of common failure modes.",
  maintainability:
    "Focus on how easy it will be to change and extend this architecture over time. Evaluate coupling between components, clarity of boundaries, documentation needs, onboarding friction for new contributors, and the risk of accruing technical debt.",
  reversibility:
    "Focus on how difficult or costly it would be to undo or replace this architectural decision. Evaluate lock-in to vendors or proprietary technologies, data migration complexity, and whether a strangler-fig or incremental migration path exists if the approach needs to change.",
  simplicity:
    "Focus on whether this is the simplest architecture that satisfies the Checkpoint 1 constraints. Challenge whether each component needs to exist, whether a native platform feature or an already-present dependency removes a proposed custom layer, whether two components should collapse into one, and whether any abstraction is speculative — added for a use case absent from the problem statement. Reward the smallest design that honours every hard constraint; penalise layers introduced for unproven future flexibility, but never at the expense of a stated constraint.",
};

// ── Resolver ────────────────────────────────────────────────────────

/**
 * Resolve an architect lens name to its focus fragment.
 * Returns the catalog entry for a known lens, or a generic non-empty
 * fallback for any unknown custom string — never throws (C2).
 */
export function resolveArchLensFocus(lens: string): string {
  return (
    ARCH_LENS_CATALOG[lens] ??
    `Evaluate this architecture specifically through the '${lens}' lens.`
  );
}
