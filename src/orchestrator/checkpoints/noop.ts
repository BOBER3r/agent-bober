import type { CheckpointArtifact, CheckpointId, CheckpointMechanism, CheckpointOutcome } from "./types.js";

/**
 * The auto-approve mechanism used in autopilot mode (the default).
 * Every request resolves synchronously to { approved: true } — preserves
 * pipeline behavior identical to pre-Tier-2.
 *
 * Sprints 8-10 register real mechanisms (cli, disk, pr) alongside this one.
 */
export class NoopCheckpointMechanism implements CheckpointMechanism {
  async request(
    _checkpoint: CheckpointId,
    _artifact: CheckpointArtifact,
  ): Promise<CheckpointOutcome> {
    return { approved: true };
  }
}
