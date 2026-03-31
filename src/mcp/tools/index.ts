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
import { registerArchitectTool } from "./architect.js";
import { registerResearchTool } from "./research.js";
import { registerBrownfieldTool } from "./brownfield.js";
import { registerReactTool } from "./react.js";
import { registerSolidityTool } from "./solidity.js";
import { registerAnchorTool } from "./anchor.js";
import { registerPlaywrightTool } from "./playwright.js";

/**
 * Registers all built-in agent-bober MCP tools into the global registry.
 * Call this once before starting the MCP server.
 *
 * Registered tools (17 total):
 *   1. bober_init        – Initialise a project
 *   2. bober_plan        – Generate a sprint plan
 *   3. bober_sprint      – Execute the next sprint cycle
 *   4. bober_eval        – Evaluate a sprint
 *   5. bober_run         – Start the full pipeline asynchronously
 *   6. bober_status      – Poll pipeline status
 *   7. bober_contracts   – List/read sprint contracts
 *   8. bober_spec        – Read the latest plan spec
 *   9. bober_principles  – Read/write .bober/principles.md
 *  10. bober_config      – Read/update bober.config.json
 *  11. bober_architect   – Solution architecture (5-checkpoint flow + ADRs)
 *  12. bober_research    – Two-phase codebase research (fact-only)
 *  13. bober_brownfield  – Brownfield pipeline (existing codebase)
 *  14. bober_react       – React web application pipeline
 *  15. bober_solidity    – EVM smart contract pipeline
 *  16. bober_anchor      – Solana program pipeline (Anchor)
 *  17. bober_playwright  – Playwright E2E setup and runner
 */
export function registerAllTools(): void {
  // ── Core workflow tools ─────────────────────────────────────────
  registerInitTool();
  registerPlanTool();
  registerSprintTool();
  registerEvalTool();
  registerArchitectTool();
  registerResearchTool();

  // ── Async pipeline tools ────────────────────────────────────────
  registerRunTool();
  registerBrownfieldTool();
  registerReactTool();
  registerSolidityTool();
  registerAnchorTool();
  registerStatusTool();

  // ── Utility tools ──────────────────────────────────────────────
  registerPlaywrightTool();

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
