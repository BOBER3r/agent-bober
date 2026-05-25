// ── bober_abort_run tool ─────────────────────────────────────────────
//
// Aborts a running pipeline run by runId. Flips the run's status to
// 'aborted', persists { reason, abortedAt } to state.json, and returns
// { runId, status: 'aborted', abortedAt }.
//
// Soft errors (not found, not active) return JSON { error: '...' }.
// Hard errors (missing runId arg) throw McpError(InvalidRequest).
//
// Note: this sprint flips the in-memory and disk state only. Forceful
// in-flight subprocess termination (SIGTERM propagation) is deferred to
// a future hardening sprint.

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

import { registerTool } from "./registry.js";
import { runManager } from "../run-manager.js";

// ── Registration ─────────────────────────────────────────────────────

export function registerAbortRunTool(): void {
  registerTool({
    name: "bober_abort_run",
    description:
      "Abort a running pipeline run by runId. " +
      "Flips the run's status to 'aborted' and persists the abort reason. " +
      "Returns the runId, status, and abortedAt timestamp. " +
      "Returns a soft-error JSON when the run is not found or not currently running.",
    inputSchema: {
      type: "object",
      properties: {
        runId: {
          type: "string",
          description: "The unique identifier of the run to abort.",
        },
        reason: {
          type: "string",
          description: "Optional reason for aborting the run. Defaults to 'Aborted by user'.",
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
      const reason =
        typeof args.reason === "string" ? args.reason : "Aborted by user";

      const state = runManager.getRun(runId);
      if (state === null) {
        return JSON.stringify({ error: `Run not found: ${runId}` }, null, 2);
      }
      if (state.status !== "running") {
        return JSON.stringify({ error: "Run is not active" }, null, 2);
      }

      runManager.abortRun(runId, reason);
      const updated = runManager.getRun(runId)!;
      return JSON.stringify(
        {
          runId: updated.runId,
          status: updated.status,
          abortedAt: updated.abortedAt,
        },
        null,
        2,
      );
    },
  });
}
