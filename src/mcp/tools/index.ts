// ── Tool Registration ───────────────────────────────────────────────
//
// This file is the central place where all MCP tools are registered.
// Import each tool module's register function here and call it once.

import { registerTool } from "./registry.js";
import { registerInitTool } from "./init.js";
import { registerPlanTool } from "./plan.js";
import { registerSprintTool } from "./sprint.js";
import { registerEvalTool } from "./eval.js";
import { registerRunTool } from "./run.js";
import { registerStatusTool } from "./status.js";

/**
 * Registers all built-in agent-bober MCP tools into the global registry.
 * Call this once before starting the MCP server.
 */
export function registerAllTools(): void {
  // ── bober_ping ─────────────────────────────────────────────────
  // Lightweight health-check tool. Useful for smoke-testing IDE integrations.
  registerTool({
    name: "bober_ping",
    description:
      "Ping the agent-bober MCP server. Returns 'pong' to confirm the server is running and reachable.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    handler: async (_args: Record<string, unknown>): Promise<string> => {
      return "pong";
    },
  });

  // ── Core workflow tools ─────────────────────────────────────────
  registerInitTool();
  registerPlanTool();
  registerSprintTool();
  registerEvalTool();

  // ── Async pipeline tools ────────────────────────────────────────
  registerRunTool();
  registerStatusTool();
}

export { registerTool, getAllTools, getTool } from "./registry.js";
export type {
  BoberToolDefinition,
  JsonSchemaObject,
  JsonSchemaProperty,
} from "./registry.js";
