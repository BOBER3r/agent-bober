/**
 * Checkpoint type definitions for Tier 2 careful-flow plumbing.
 *
 * Sprint 7: establishes the type infrastructure used by Sprints 8-10
 * to plug in real mechanisms (cli, disk, pr). Only the noop mechanism
 * is registered in this sprint.
 */

/**
 * One of the 9 pipeline decision points. Sprints 8-14 may add overrides per id;
 * the registry resolves an id → mechanism.
 */
export type CheckpointId =
  | "post-research"
  | "post-plan"
  | "post-sprint-contract"
  | "pre-curator"
  | "pre-generator"
  | "pre-evaluator"
  | "pre-code-reviewer"
  | "post-sprint"
  | "end-of-pipeline";

/**
 * Opaque artifact passed to a mechanism. The shape varies per CheckpointId.
 * Sprints 8-10 may narrow this via the id discriminator; this sprint treats it
 * as `unknown` because the only mechanism (noop) ignores it.
 */
export type CheckpointArtifact = unknown;

/**
 * Discriminated union of the three outcomes a mechanism can return.
 *
 * - approved:true                        → proceed unchanged (autopilot / accept)
 * - approved:false + feedback            → reject; Sprint 12 will propagate
 *                                          `feedback` back into the prior agent
 * - edit:true + editDelta                → user mutated the artifact in place
 *                                          (CLI edit, disk file rewrite, PR commit)
 *                                          and the coordinator must consume the
 *                                          delta before proceeding.
 *
 * Why all three exist now (per evaluatorNotes): "The Checkpoint types must be
 * exhaustive enough to support all three mechanisms (CLI/disk/PR) without
 * re-shaping in Sprints 8-10."
 */
export type CheckpointOutcome =
  | { approved: true; editDelta?: unknown }
  | { approved: false; feedback: string }
  | { edit: true; editDelta: unknown };

/**
 * A pluggable approval mechanism. Sprints 8-10 implement `cli`, `disk`, `pr`.
 * This sprint registers ONLY `noop`.
 */
export interface CheckpointMechanism {
  request(
    checkpoint: CheckpointId,
    artifact: CheckpointArtifact,
  ): Promise<CheckpointOutcome>;
}
