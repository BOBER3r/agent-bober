/**
 * Risky-action mechanism resolver (Sprint 20).
 *
 * Wraps the 6-tier resolver from Sprint 14 (resolveCheckpointMechanismName)
 * with a FORCED FLOOR for risky actions:
 *
 *   Tier 0 (Sprint 20): if isRisky && !allowAutopilotRiskyActions && resolved==='noop'
 *   → override to 'disk'.
 *
 * This is the unconditional gate (s20-c6): even mode='autopilot' +
 * checkpointMechanism='noop' cannot bypass the gate for risky actions.
 *
 * The escape hatch (allowAutopilotRiskyActions=true) lets fully-automated
 * environments (CI, batch jobs) skip interactive approval WHILE preserving
 * the audit trail (ChangeEntry is always written). Document this as a footgun.
 */

import {
  resolveCheckpointMechanismName,
  getCheckpointMechanism,
  type CheckpointMechanism,
  type CheckpointOverrideConfig,
} from "../checkpoints/index.js";

/**
 * Extended config shape: pipeline.allowAutopilotRiskyActions is a Sprint 20 field.
 * Other pipeline fields are passed through to the underlying resolver unchanged.
 */
export interface RiskyActionConfig extends CheckpointOverrideConfig {
  pipeline?: CheckpointOverrideConfig["pipeline"] & {
    allowAutopilotRiskyActions?: boolean;
  };
}

/**
 * Pure name resolver for risky-action mechanism.
 *
 * Tier 0 (Sprint 20 FORCED FLOOR):
 *   if isRisky && !allowAutopilotRiskyActions && underlying resolves to 'noop'
 *   → return 'disk'.
 *
 * Tiers 1-6: defer to resolveCheckpointMechanismName (Sprint 14).
 *
 * The checkpointId is dynamic: 'risky-action-<actionId>'. Passing it through
 * to the underlying resolver allows per-checkpoint overrides to target a specific
 * action id (rare; not a documented feature; semantically correct).
 *
 * @param config   - Pipeline config, may include allowAutopilotRiskyActions.
 * @param isRisky  - True when the action is classified as risky.
 * @param actionId - Optional action id; used to form the checkpoint id.
 */
export function resolveRiskyActionMechanismName(
  config: RiskyActionConfig | undefined,
  isRisky: boolean,
  actionId?: string,
): string {
  const checkpointId = `risky-action-${actionId ?? "default"}`;
  const resolved = resolveCheckpointMechanismName(checkpointId, config);
  const allow = config?.pipeline?.allowAutopilotRiskyActions === true;

  // Forced floor: risky + !allow + resolved==='noop' → 'disk'.
  if (isRisky && !allow && resolved === "noop") {
    return "disk";
  }
  return resolved;
}

/**
 * Impure wrapper: resolves the mechanism NAME and returns the registered
 * CheckpointMechanism implementation. Tests may call resolveRiskyActionMechanismName
 * directly (pure, no side effects) and assert the returned name.
 */
export function getRiskyActionMechanism(
  config: RiskyActionConfig | undefined,
  isRisky: boolean,
  actionId?: string,
): CheckpointMechanism {
  return getCheckpointMechanism(resolveRiskyActionMechanismName(config, isRisky, actionId));
}
