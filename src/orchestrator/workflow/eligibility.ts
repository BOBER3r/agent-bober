import type { BoberConfig } from "../../config/schema.js";

// ── Eligibility ────────────────────────────────────────────────────

/**
 * Conservative default-ineligible workflow probe.
 * TODO(sprint-6): contact the runtime and return true only when
 * Claude Code >= 2.1.154 with Dynamic Workflows is available.
 */
export function isWorkflowEligible(_config: BoberConfig): boolean {
  return false;
}
