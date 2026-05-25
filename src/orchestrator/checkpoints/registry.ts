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
 * Structural subset of BoberConfig — passing a real BoberConfig works without a cast.
 *
 * Sprint 14: added mode field and extended checkpointOverrides type.
 */
export interface CheckpointOverrideConfig {
  pipeline?: {
    /** Global default checkpoint mechanism name (e.g., "noop", "cli", "disk", "pr"). */
    checkpointMechanism?: string;
    /** Per-checkpoint overrides: { "<checkpointId>": "<mechanismName>" } */
    checkpointOverrides?: Record<string, string>;
    /** Pipeline execution mode — determines mechanism default when checkpointMechanism is unset. */
    mode?: "autopilot" | "careful";
    /** Allow any additional pipeline fields (e.g., maxCheckpointIterations) from BoberConfig. */
    [key: string]: unknown;
  };
}

/**
 * Pure resolution function — returns the mechanism name string without doing a registry lookup.
 * Sprint 14: implements 6-tier resolution order:
 *   1. cliOverrideAll && cliOverride → cliOverride (force-all CLI flag)
 *   2. config.pipeline.checkpointOverrides[checkpointId] (most specific per-checkpoint config)
 *   3. cliOverride (per-run CLI flag, deferred to after per-checkpoint config override)
 *   4. config.pipeline.checkpointMechanism (global config default, if set)
 *   5. mode default: mode='careful' → 'disk', mode='autopilot' or unset → 'noop'
 *   6. fallback param (back-compat hatch for callers that supply one)
 *
 * Exported so that pipeline.ts can snapshot the resolved name once per run for audit logging.
 */
export function resolveCheckpointMechanismName(
  checkpointId: string,
  config: CheckpointOverrideConfig | undefined,
  cliOverride?: string,
  cliOverrideAll?: boolean,
  fallback = "noop",
): string {
  // Tier 1: CLI force-all overrides everything
  if (cliOverrideAll && cliOverride) return cliOverride;

  // Tier 2: per-checkpoint config override
  const perCheckpoint = config?.pipeline?.checkpointOverrides?.[checkpointId];
  if (perCheckpoint) return perCheckpoint;

  // Tier 3: per-run CLI flag (deferred — per-checkpoint config wins)
  if (cliOverride) return cliOverride;

  // Tier 4: global config default
  const global = config?.pipeline?.checkpointMechanism;
  if (global) return global;

  // Tier 5: mode-based default
  if (config?.pipeline?.mode === "careful") return "disk";

  // Tier 6: caller-supplied fallback (back-compat)
  return fallback;
}

/**
 * Resolve the mechanism for a specific checkpoint. Resolution order:
 *   1. (cliOverrideAll && cliOverride) → cliOverride (force-all CLI flag)
 *   2. config.pipeline.checkpointOverrides[checkpointId] (per-checkpoint config)
 *   3. cliOverride (per-run CLI flag, after per-checkpoint config)
 *   4. config.pipeline.checkpointMechanism (global config default)
 *   5. mode default: 'careful' → 'disk', 'autopilot'/unset → 'noop'
 *   6. fallback param (back-compat; e.g., "noop")
 *
 * Sprint 14: extended with optional cliOverride + cliOverrideAll trailing params.
 * All existing 3-arg and 2-arg call-sites continue to work unchanged.
 */
export function getCheckpointMechanismFor(
  checkpointId: string,
  config: CheckpointOverrideConfig | undefined,
  fallback?: string,
  cliOverride?: string,
  cliOverrideAll?: boolean,
): CheckpointMechanism {
  const name = resolveCheckpointMechanismName(
    checkpointId,
    config,
    cliOverride,
    cliOverrideAll,
    fallback ?? "noop",
  );
  return getCheckpointMechanism(name);
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
