import type { CheckpointMechanism } from "./types.js";
import { NoopCheckpointMechanism } from "./noop.js";

/**
 * Module-level registry mapping mechanism names to CheckpointMechanism implementations.
 *
 * Pattern matches ROLE_TOOLS in src/orchestrator/tools/index.ts:
 * a module-level Map, not a class. Noop is self-registered at module init.
 *
 * Sprints 8-10 will call registerCheckpointMechanism("cli" | "disk" | "pr", impl)
 * before the pipeline starts. The coordinator never imports noop directly — it
 * calls getCheckpointMechanism("noop") via the registry.
 */
const mechanisms = new Map<string, CheckpointMechanism>();

export function registerCheckpointMechanism(name: string, impl: CheckpointMechanism): void {
  mechanisms.set(name, impl);
}

export function getCheckpointMechanism(name: string): CheckpointMechanism {
  const impl = mechanisms.get(name);
  if (!impl) {
    throw new Error(
      `Unknown checkpoint mechanism: ${name}. Registered: ${[...mechanisms.keys()].join(", ") || "(none)"}`,
    );
  }
  return impl;
}

// Self-register the noop mechanism at module init.
// This mirrors how src/evaluators/registry.ts:41-50 populates built-ins.
registerCheckpointMechanism("noop", new NoopCheckpointMechanism());
