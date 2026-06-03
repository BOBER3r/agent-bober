import type { BoberConfig } from "../../config/schema.js";
import { logger } from "../../utils/logger.js";
import type { PipelineEngine, PipelineEngineName } from "./engine.js";
import { isWorkflowEligible } from "./eligibility.js";
import { TsPipelineEngine } from "./ts-engine.js";

// ── Resolver ───────────────────────────────────────────────────────

/**
 * Pure resolver — returns the engine name without instantiating an engine.
 *
 * Resolution branches:
 *   - engine unset                        → 'ts'
 *   - engine === 'workflow' && ineligible  → 'ts'  (one downgrade log line)
 *   - engine === 'workflow' && mode === 'careful' → 'ts'  (one downgrade log line)
 *   - else                                → engine verbatim ('ts' | 'skill' | 'workflow')
 *
 * Mirrors the pure-resolver pattern of resolveCheckpointMechanismName
 * (src/orchestrator/checkpoints/registry.ts:65).
 */
export function resolveEngineName(config: BoberConfig): PipelineEngineName {
  const requested: PipelineEngineName = config.pipeline?.engine ?? "ts";

  if (requested === "workflow") {
    const eligible = isWorkflowEligible(config);
    const careful = config.pipeline?.mode === "careful";
    if (!eligible || careful) {
      logger.info(
        `Workflow engine requested but ${!eligible ? "ineligible" : "mode='careful'"}; downgrading to 'ts'.`,
      );
      return "ts";
    }
  }

  return requested;
}

// ── Selector ───────────────────────────────────────────────────────

/**
 * Resolve config.pipeline.engine to a PipelineEngine instance.
 * 'skill' and 'workflow' engines are not implemented this sprint (sprint 6);
 * resolveEngineName makes them unreachable via the default-ineligible probe.
 * TODO(sprint-6): map 'skill' and 'workflow' to their respective engines.
 */
export function selectPipelineEngine(config: BoberConfig): PipelineEngine {
  const name = resolveEngineName(config);
  switch (name) {
    case "ts":
      return new TsPipelineEngine();
    case "skill":
    case "workflow":
      // Sprint 6: real engine implementations go here.
      // For now, fall back to TS engine (unreachable via default-ineligible probe).
      return new TsPipelineEngine();
  }
}
