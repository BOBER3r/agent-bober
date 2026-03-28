// ── Tool Registration ───────────────────────────────────────────────
//
// This file is the central place where all MCP tools are registered.
// Import each tool module's register function here and call it once.

import { registerInitTool } from "./init.js";
import { registerPlanTool } from "./plan.js";
import { registerSprintTool } from "./sprint.js";
import { registerEvalTool } from "./eval.js";
import { registerRunTool } from "./run.js";
import { registerStatusTool } from "./status.js";
import { registerContractsTool } from "./contracts.js";
import { registerSpecTool } from "./spec.js";
import { registerPrinciplesTool } from "./principles.js";
import { registerConfigTool } from "./config.js";

/**
 * Registers all built-in agent-bober MCP tools into the global registry.
 * Call this once before starting the MCP server.
 *
 * Registered tools (10 total):
 *   1. bober_init       – Initialise a project
 *   2. bober_plan       – Generate a sprint plan
 *   3. bober_sprint     – Execute the next sprint cycle
 *   4. bober_eval       – Evaluate a sprint
 *   5. bober_run        – Start the full pipeline asynchronously
 *   6. bober_status     – Poll pipeline status
 *   7. bober_contracts  – List/read sprint contracts
 *   8. bober_spec       – Read the latest plan spec
 *   9. bober_principles – Read/write .bober/principles.md
 *  10. bober_config     – Read/update bober.config.json
 */
export function registerAllTools(): void {
  // ── Core workflow tools ─────────────────────────────────────────
  registerInitTool();
  registerPlanTool();
  registerSprintTool();
  registerEvalTool();

  // ── Async pipeline tools ────────────────────────────────────────
  registerRunTool();
  registerStatusTool();

  // ── Read / configuration tools ──────────────────────────────────
  registerContractsTool();
  registerSpecTool();
  registerPrinciplesTool();
  registerConfigTool();
}

export { registerTool, getAllTools, getTool } from "./registry.js";
export type {
  BoberToolDefinition,
  JsonSchemaObject,
  JsonSchemaProperty,
} from "./registry.js";
