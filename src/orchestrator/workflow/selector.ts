import type { BoberConfig } from "../../config/schema.js";
import { logger } from "../../utils/logger.js";
import type { PipelineEngine, PipelineEngineName } from "./engine.js";
import { isWorkflowEligible } from "./eligibility.js";
import { TsPipelineEngine } from "./ts-engine.js";
import { WorkflowEngine } from "./workflow-engine.js";

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
 *
 * Belt-and-suspenders per ADR-6:
 *   - resolveEngineName (above) ALREADY downgrades workflow→ts when ineligible/careful.
 *   - In the eligible case, WorkflowEngine is returned; its run() has a second guard
 *     that catches WorkflowUnavailableError from the dormant invoke and re-dispatches TS.
 *   - 'skill' remains on TsPipelineEngine (no skill engine this sprint — non-goal).
 */
export function selectPipelineEngine(config: BoberConfig): PipelineEngine {
  const name = resolveEngineName(config);
  switch (name) {
    case "ts":
      return new TsPipelineEngine();
    case "skill":
      // Skill engine deferred (non-goal this sprint); falls through to TS.
      return new TsPipelineEngine();
    case "workflow":
      // Reachable only when resolveEngineName returns 'workflow' (eligible + not careful).
      // WorkflowEngine.run has a belt-and-suspenders catch for WorkflowUnavailableError.
      return new WorkflowEngine();
  }
}
