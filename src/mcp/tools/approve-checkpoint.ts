// ── bober_approve_checkpoint tool ────────────────────────────────────
//
// Approves a pending checkpoint by writing
// .bober/approvals/<id>.approved.json with the same payload shape as
// the `bober approve` CLI command. Guards with pendingExists before
// writing to prevent dangling approved markers.
//
// Returns { approvedAt, checkpointId } on success.
// Soft errors for: missing pending, relative projectPath.
//
// Sprint 5 (cockpit-integration)

import { cwd } from "node:process";
import { isAbsolute } from "node:path";

import { registerTool } from "./registry.js";
import {
  pendingExists,
  saveApproved,
  type ApprovedMarker,
} from "../../state/approval-state.js";
import { resolveApprover } from "../../cli/commands/approve.js";

// ── Registration ─────────────────────────────────────────────────────

export function registerApproveCheckpointTool(): void {
  registerTool({
    name: "bober_approve_checkpoint",
    description:
      "Approve a pending checkpoint by writing .bober/approvals/<id>.approved.json. " +
      "Shares the marker-file shape with the `bober approve` CLI command. " +
      "Returns { approvedAt, checkpointId } on success.",
    inputSchema: {
      type: "object",
      properties: {
        checkpointId: {
          type: "string",
          description: "Checkpoint to approve.",
        },
        projectPath: {
          type: "string",
          description: "Absolute project root (defaults to cwd).",
        },
        editDelta: {
          description: "Optional override payload (any JSON-serializable value).",
        },
      },
      required: ["checkpointId"],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>): Promise<string> => {
      const checkpointId =
        typeof args.checkpointId === "string" ? args.checkpointId.trim() : "";
      if (!checkpointId) {
        return JSON.stringify({
          error: "checkpointId is required and must be a non-empty string.",
        });
      }

      const projectPath =
        typeof args.projectPath === "string" ? args.projectPath : cwd();
      if (typeof args.projectPath === "string" && !isAbsolute(args.projectPath)) {
        return JSON.stringify({ error: "projectPath must be absolute" });
      }

      const exists = await pendingExists(projectPath, checkpointId);
      if (!exists) {
        return JSON.stringify({
          error: `No pending checkpoint found: ${checkpointId}`,
        });
      }

      const approvedAt = new Date().toISOString();
      const marker: ApprovedMarker = {
        approvedAt,
        approverId: resolveApprover(),
        ...(args.editDelta !== undefined ? { editDelta: args.editDelta } : {}),
      };
      await saveApproved(projectPath, checkpointId, marker);

      return JSON.stringify({ approvedAt, checkpointId }, null, 2);
    },
  });
}
