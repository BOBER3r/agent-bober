import type { BoberConfig } from "../../config/schema.js";
import { logger } from "../../utils/logger.js";
import type { PipelineEngine, PipelineEngineName } from "./engine.js";
import { isWorkflowEligible } from "./eligibility.js";
import { TsPipelineEngine } from "./ts-engine.js";
import { WorkflowEngine } from "./workflow-engine.js";
import type { Team } from "../../teams/types.js";

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

// ── Team-aware selection ───────────────────────────────────────────

/**
 * Pure resolver — returns the engine name for a team, using team.pipelineShape
 * as the requested engine, then applying the SAME downgrade pipeline as
 * resolveEngineName (ineligible or mode='careful' → 'ts').
 *
 * The downgrade log line is byte-identical to resolveEngineName's (selector.ts:29-31).
 */
export function resolveEngineNameForTeam(
  team: Team,
  config: BoberConfig,
): PipelineEngineName {
  const requested = team.pipelineShape;

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

/**
 * Resolve a Team's pipelineShape to a PipelineEngine instance.
 *
 * Applies the same downgrade rules as selectPipelineEngine (via resolveEngineNameForTeam),
 * and uses the same exhaustive switch over PipelineEngineName. The programming team's
 * pipelineShape === resolveEngineName(config) by construction (registry.ts:68), so this
 * is byte-for-byte identical to selectPipelineEngine(config) for the programming team.
 */
export function selectPipelineEngineForTeam(
  team: Team,
  config: BoberConfig,
): PipelineEngine {
  const name = resolveEngineNameForTeam(team, config);
  switch (name) {
    case "ts":
      return new TsPipelineEngine();
    case "skill":
      // Skill engine deferred (non-goal); falls through to TS.
      return new TsPipelineEngine();
    case "workflow":
      // Reachable only when resolveEngineNameForTeam returns 'workflow' (eligible + not careful).
      return new WorkflowEngine();
  }
}
