// ── bober_list_active_runs tool ──────────────────────────────────────
//
// Returns all known runs tracked by the RunManager, optionally filtered
// by status. When no status filter is provided, all runs are returned
// regardless of their current status.

import { registerTool } from "./registry.js";
import { runManager } from "../run-manager.js";

// ── Registration ─────────────────────────────────────────────────────

export function registerListActiveRunsTool(): void {
  registerTool({
    name: "bober_list_active_runs",
    description:
      "List all runs tracked by the multi-run RunManager. " +
      "Optionally filter by status. Returns an array of RunState objects.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["running", "completed", "failed", "aborted"],
          description: "Optional status filter. Omit to return all runs.",
        },
      },
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>): Promise<string> => {
      const statusFilter =
        typeof args.status === "string" ? args.status : undefined;

      const all = runManager.listAllRuns();
      const filtered = statusFilter
        ? all.filter((s) => s.status === statusFilter)
        : all;

      return JSON.stringify(filtered, null, 2);
    },
  });
}
