import { join } from "node:path";
import type { CheckpointMechanism } from "./types.js";
import { NoopCheckpointMechanism } from "./noop.js";
import { CliCheckpointMechanism } from "./mechanisms/cli.js";
import { DiskCheckpointMechanism } from "./mechanisms/disk.js";
import { PrCheckpointMechanism, createGhClient } from "./mechanisms/pr.js";

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

/**
 * Minimal config shape for per-checkpoint override resolution.
 * Sprint 14 will wire the full BoberConfig pipeline schema; this sprint
 * only provides the resolution hook. The structural subset ensures that
 * passing a real BoberConfig or PartialBoberConfig will work without a cast.
 */
export interface CheckpointOverrideConfig {
  pipeline?: {
    /** Global default checkpoint mechanism name (e.g., "noop", "cli", "disk", "pr"). */
    checkpointMechanism?: string;
    /** Per-checkpoint overrides: { "<checkpointId>": "<mechanismName>" } */
    checkpointOverrides?: Record<string, string>;
  };
}

/**
 * Resolve the mechanism for a specific checkpoint. Resolution order:
 *   1. config.pipeline.checkpointOverrides[checkpointId] (most specific)
 *   2. config.pipeline.checkpointMechanism (global default)
 *   3. fallback param (caller's default; e.g., "noop")
 *
 * Sprint 14 will wire the BoberConfig pipeline schema; this sprint just
 * provides the resolution hook so a future PR can plumb config end-to-end.
 *
 * Preserves back-compat with getCheckpointMechanism(name) — all pipeline.ts
 * call-sites continue to use the simpler form; this is a SIBLING function.
 */
export function getCheckpointMechanismFor(
  checkpointId: string,
  config: CheckpointOverrideConfig | undefined,
  fallback = "noop",
): CheckpointMechanism {
  const override = config?.pipeline?.checkpointOverrides?.[checkpointId];
  const global = config?.pipeline?.checkpointMechanism;
  return getCheckpointMechanism(override ?? global ?? fallback);
}

// Self-register the noop mechanism at module init.
// This mirrors how src/evaluators/registry.ts:41-50 populates built-ins.
registerCheckpointMechanism("noop", new NoopCheckpointMechanism());
registerCheckpointMechanism("cli", new CliCheckpointMechanism());
// Disk mechanism uses process.cwd() at module-load time. If the orchestrator
// ever runs from a different cwd, this path may be wrong; a factory pattern
// (Sprint 14+) can address this. For now this matches the cli registration parity.
registerCheckpointMechanism(
  "disk",
  new DiskCheckpointMechanism(join(process.cwd(), ".bober", "approvals")),
);

// PR mechanism — one instance per process, with disk as fallback.
// The disk fallback is rooted at the same .bober/approvals directory.
const cwd = process.cwd();
const diskForPrFallback = new DiskCheckpointMechanism(join(cwd, ".bober", "approvals"));
registerCheckpointMechanism(
  "pr",
  new PrCheckpointMechanism(createGhClient(cwd), diskForPrFallback),
);
