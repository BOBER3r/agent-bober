// ── bober_get_run_status tool ────────────────────────────────────────
//
// Returns the full RunState for a specific run identified by runId.
// Returns a soft-error JSON when the runId is not found.
// Throws McpError(InvalidRequest) when runId arg is missing or empty.

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

import { registerTool } from "./registry.js";
import { runManager } from "../run-manager.js";

// ── Registration ─────────────────────────────────────────────────────

export function registerGetRunStatusTool(): void {
  registerTool({
    name: "bober_get_run_status",
    description:
      "Get the full state of a specific run by runId. " +
      "Returns the complete RunState object including status, progress, result, and error. " +
      "Returns a soft-error JSON when the runId is not found.",
    inputSchema: {
      type: "object",
      properties: {
        runId: {
          type: "string",
          description: "The unique identifier of the run to look up.",
        },
      },
      required: ["runId"],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>): Promise<string> => {
      const runId = typeof args.runId === "string" ? args.runId.trim() : "";
      if (!runId) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          "runId is required and must be a non-empty string.",
        );
      }

      const state = runManager.getRun(runId);
      if (state === null) {
        return JSON.stringify({ error: `Run not found: ${runId}` }, null, 2);
      }

      return JSON.stringify(state, null, 2);
    },
  });
}
