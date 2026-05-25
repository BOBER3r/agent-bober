/**
 * Deployer spawn-site integration surface (Sprint 20).
 *
 * Sprint 24 (/bober-incident CLI command) will call spawnDeployer() to:
 *   1. Merge observability MCP tools (same pattern as the diagnoser — Sprint 16).
 *   2. Load the bober-deployer agent definition.
 *   3. Register the risky-action checkpoint callback (the gate that calls executeAction).
 *
 * This module exports the spawn helper and the RiskyActionCheckpointCallback type
 * so Sprint 24 can wire without importing from internal deploy/ modules directly.
 *
 * Pattern:
 * - mergeObsTools: from src/orchestrator/observability/merge.ts (Sprint 16)
 * - loadAgentDefinition: from src/orchestrator/agent-loader.ts (Sprint 15 pattern)
 *
 * The deployer's tool list at spawn time:
 *   [Read, Bash, Grep, Glob, ...namespacedObsTools]
 *
 * The risky-action callback:
 *   Called once per ProposedAction that classifyCommand() classifies as risky.
 *   Receives the action description, classification reasoning, and inverse.
 *   Returns the checkpoint outcome (approved, rejected, or operator-edited).
 *
 * Sprint 24 integration point:
 * ```typescript
 * import { spawnDeployer } from "../orchestrator/deploy/spawn.js";
 * const { agentDef, obsTools, stopObs } = await spawnDeployer(config, projectRoot);
 * try {
 *   // pass agentDef + obsTools to the agentic loop
 * } finally {
 *   await stopObs();
 * }
 * ```
 */

import { mergeObsTools, stopAll } from "../observability/index.js";
import { loadAgentDefinition } from "../agent-loader.js";
import type { AgentDefinition } from "../agent-loader.js";
import type { NamespacedTool, ExternalMcpServer } from "../observability/index.js";
import type { RiskyActionConfig } from "./resolve.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface DeployerSpawnContext {
  /** Loaded bober-deployer agent definition (frontmatter + body). */
  agentDef: AgentDefinition;
  /** Observability tools merged from configured providers. Namespaced obs__<provider>__<tool>. */
  obsTools: NamespacedTool[];
  /** Call in finally to stop all started observability MCP servers. */
  stopObs: () => Promise<void>;
}

// ── spawnDeployer ──────────────────────────────────────────────────────────────

/**
 * Prepare the deployer subagent's spawn context.
 *
 * Mirrors the diagnoser spawn pattern (Sprint 15/16):
 *   1. Load the agent definition from agents/bober-deployer.md.
 *   2. Merge observability MCP tools via Promise.allSettled (partial failure safe).
 *   3. Return the spawn context for Sprint 24 to pass into the agentic loop.
 *
 * The caller MUST call stopObs() in a finally block to release observability MCP processes.
 *
 * @param config      - Pipeline config (controls allowAutopilotRiskyActions + mechanism resolution).
 * @param projectRoot - Absolute path to the project root.
 */
export async function spawnDeployer(
  config: RiskyActionConfig | undefined,
  projectRoot: string,
): Promise<DeployerSpawnContext> {
  // Load agent definition in parallel with obs tool merge.
  const [agentDef, obsResult] = await Promise.all([
    loadAgentDefinition("bober-deployer", projectRoot),
    mergeObsTools(
      (config as { observability?: { providers?: Parameters<typeof mergeObsTools>[0] } } | undefined)
        ?.observability?.providers ?? [],
    ),
  ]);

  const { tools: obsTools, servers: obsServers } = obsResult;

  const stopObs = () => stopAll(obsServers as ExternalMcpServer[]);

  return { agentDef, obsTools, stopObs };
}
