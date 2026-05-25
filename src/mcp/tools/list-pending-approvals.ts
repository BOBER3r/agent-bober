// ── bober_list_pending_approvals tool ────────────────────────────────
//
// Returns all pending checkpoints in cockpit-row shape:
//   [{ checkpointId, ageMs, prompt }]
// Optional projectPath (must be absolute when supplied).
//
// Sprint 5 (cockpit-integration)

import { cwd } from "node:process";
import { isAbsolute } from "node:path";

import { registerTool } from "./registry.js";
import { listPendingApprovals } from "../../state/approval-state.js";

// ── Registration ─────────────────────────────────────────────────────

export function registerListPendingApprovalsTool(): void {
  registerTool({
    name: "bober_list_pending_approvals",
    description:
      "List all pending careful-flow checkpoints awaiting human approval. " +
      "Returns an array of { checkpointId, ageMs, prompt } — the same shape " +
      "as `bober list-approvals --json`. Optional projectPath defaults to cwd; " +
      "when supplied it MUST be absolute.",
    inputSchema: {
      type: "object",
      properties: {
        projectPath: {
          type: "string",
          description:
            "Absolute path to the project root. Defaults to cwd when omitted.",
        },
      },
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>): Promise<string> => {
      const projectPath =
        typeof args.projectPath === "string" ? args.projectPath : cwd();
      if (typeof args.projectPath === "string" && !isAbsolute(args.projectPath)) {
        return JSON.stringify({ error: "projectPath must be absolute" });
      }
      const rows = await listPendingApprovals(projectPath);
      return JSON.stringify(rows, null, 2);
    },
  });
}
