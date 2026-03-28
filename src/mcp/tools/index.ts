// ── Tool Registration ───────────────────────────────────────────────
//
// This file is the central place where all MCP tools are registered.
// Sprint 1 registers a placeholder bober_ping tool to validate the system
// end-to-end. Real workflow tools will be added in Sprint 2.

import { registerTool } from "./registry.js";

/**
 * Registers all built-in agent-bober MCP tools into the global registry.
 * Call this once before starting the MCP server.
 */
export function registerAllTools(): void {
  // ── bober_ping ─────────────────────────────────────────────────
  // Placeholder tool to verify the MCP server is reachable and that the
  // tool dispatch path works. Useful for smoke-testing IDE integrations.
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
}

export { registerTool, getAllTools, getTool } from "./registry.js";
export type {
  BoberToolDefinition,
  JsonSchemaObject,
  JsonSchemaProperty,
} from "./registry.js";
