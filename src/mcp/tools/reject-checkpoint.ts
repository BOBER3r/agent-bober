// ── bober_reject_checkpoint tool ─────────────────────────────────────
//
// Rejects a pending checkpoint by writing
// .bober/approvals/<id>.rejected.json with the same payload shape as
// the `bober reject` CLI command. Guards with pendingExists before
// writing to prevent dangling rejected markers.
//
// feedback is required and must be non-empty.
// Returns { rejectedAt, checkpointId } on success.
// Soft errors for: missing pending, empty feedback, relative projectPath.
//
// Sprint 5 (cockpit-integration)

import { cwd } from "node:process";
import { isAbsolute } from "node:path";

import { registerTool } from "./registry.js";
import {
  pendingExists,
  saveRejected,
  type RejectedMarker,
} from "../../state/approval-state.js";
import { resolveRejecter } from "../../cli/commands/reject.js";

// ── Registration ─────────────────────────────────────────────────────

export function registerRejectCheckpointTool(): void {
  registerTool({
    name: "bober_reject_checkpoint",
    description:
      "Reject a pending checkpoint by writing .bober/approvals/<id>.rejected.json. " +
      "Shares the marker-file shape with the `bober reject` CLI command. " +
      "feedback is required and must be non-empty. " +
      "Returns { rejectedAt, checkpointId } on success.",
    inputSchema: {
      type: "object",
      properties: {
        checkpointId: {
          type: "string",
          description: "Checkpoint to reject.",
        },
        projectPath: {
          type: "string",
          description: "Absolute project root (defaults to cwd).",
        },
        feedback: {
          type: "string",
          description: "Why the checkpoint is rejected. Required and must be non-empty.",
        },
      },
      required: ["checkpointId", "feedback"],
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

      const feedback =
        typeof args.feedback === "string" ? args.feedback.trim() : "";
      if (!feedback) {
        return JSON.stringify({
          error: "feedback is required and must be a non-empty string.",
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

      const rejectedAt = new Date().toISOString();
      const marker: RejectedMarker = {
        rejectedAt,
        rejecterId: resolveRejecter(),
        feedback,
      };
      await saveRejected(projectPath, checkpointId, marker);

      return JSON.stringify({ rejectedAt, checkpointId }, null, 2);
    },
  });
}
