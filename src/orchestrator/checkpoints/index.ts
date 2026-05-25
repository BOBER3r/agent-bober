/**
 * Public API for the checkpoints module.
 *
 * The coordinator imports from this barrel — never from individual files.
 * The noop mechanism is NOT re-exported here: it is opaque to the coordinator,
 * registered by registry.ts at module init, and retrieved via getCheckpointMechanism("noop").
 */

// Types — re-exported from ./types.js
export type { CheckpointId, CheckpointArtifact, CheckpointMechanism, CheckpointOutcome } from "./types.js";

// Registry API — re-exported from ./registry.js
export { registerCheckpointMechanism, getCheckpointMechanism } from "./registry.js";

// Site enumeration — re-exported from ./sites.js
export { CHECKPOINT_SITES, type CheckpointSite } from "./sites.js";
