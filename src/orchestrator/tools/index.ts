import type { ToolDef } from "../../providers/types.js";

import { TOOL_SCHEMAS } from "./schemas.js";
import { createToolHandlers } from "./handlers.js";
import type { ToolHandler } from "./handlers.js";
import type { GraphClient } from "../../graph/client.js";
import type { GraphFallback } from "../../graph/fallback.js";
import { createGraphTools } from "../../mcp/tools/graph.js";
import type { BoberToolDefinition } from "../../mcp/tools/registry.js";

export type { ToolHandler } from "./handlers.js";

// ── Types ──────────────────────────────────────────────────────────

export type AgentRole = "planner" | "generator" | "evaluator";

export interface ToolSet {
  /** Tool schemas to pass to the LLM client. Provider-agnostic ToolDef format. */
  schemas: ToolDef[];
  /** Handler functions keyed by tool name. */
  handlers: Map<string, ToolHandler>;
}

// ── Role → tool mapping ────────────────────────────────────────────

const ROLE_TOOLS: Record<AgentRole, string[]> = {
  planner: ["read_file", "glob", "grep"],
  generator: ["bash", "read_file", "write_file", "edit_file", "glob", "grep"],
  evaluator: ["bash", "read_file", "glob", "grep"],
};

// ── Builder ────────────────────────────────────────────────────────

/**
 * Build a tool set for a specific agent role.
 *
 * Returns only the tools appropriate for that role:
 * - **planner**: read_file, glob, grep (read-only, no execution)
 * - **generator**: all 6 tools (full filesystem + bash access)
 * - **evaluator**: bash, read_file, glob, grep (can run commands, cannot write/edit files)
 */
export function buildToolSet(
  role: AgentRole,
  projectRoot: string,
): ToolSet {
  const toolNames = ROLE_TOOLS[role];
  const allHandlers = createToolHandlers(projectRoot);

  const schemas: ToolDef[] = [];
  const handlers = new Map<string, ToolHandler>();

  for (const name of toolNames) {
    const schema = TOOL_SCHEMAS[name];
    const handler = allHandlers.get(name);

    if (schema && handler) {
      schemas.push(schema);
      handlers.set(name, handler);
    }
  }

  return { schemas, handlers };
}

// ── Graph tool helper (used by sprint 5's GraphToolGate) ──────────

/**
 * Returns the 6 graph_* tool definitions for use by the internal
 * orchestrator. DRY: consumes the same factory as the external MCP server.
 * NOT yet wired into ROLE_TOOLS — that happens in sprint 5 (GraphToolGate).
 */
export function getGraphInternalTools(
  client: GraphClient,
  fallback: GraphFallback,
): BoberToolDefinition[] {
  return createGraphTools({ client, fallback });
}
