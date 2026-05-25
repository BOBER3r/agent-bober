/**
 * Public API for the deploy module (Sprint 20).
 *
 * Sprint 24 (/bober-incident CLI command) will import from this barrel
 * to wire the deployer spawn with the risky-action checkpoint callback.
 *
 * Usage:
 *   import { executeAction, classifyCommand, resolveRiskyActionMechanismName,
 *            type ProposedAction } from "../orchestrator/deploy/index.js";
 *
 * Observability MCP tools are merged at spawn time via mergeObsTools() from
 * src/orchestrator/observability/merge.ts — the same pattern used for the
 * diagnoser agent (Sprint 16). The deployer's tool list at spawn is:
 *   [Read, Bash, Grep, Glob, ...namespacedObsTools]
 */

export { executeAction, type ExecuteActionDeps, type ExecuteActionResult } from "./execute.js";
export { classifyCommand } from "./classify.js";
export { resolveRiskyActionMechanismName, getRiskyActionMechanism, type RiskyActionConfig } from "./resolve.js";
export { defaultExecutor } from "./executor.js";
export { ProposedActionSchema, type ProposedAction, type ExecutorSeam, type DeployResult } from "./types.js";
