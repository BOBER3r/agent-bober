// ── bober_rollback_start tool ─────────────────────────────────────────
//
// Thin adapter over planRollback + executeRollback from src/incident/rollback.ts.
// No business logic — delegates entirely to the underlying helpers.
//
// Returns { planned: { totalChanges, rollbackableChanges, steps }, executed: { attempted, succeeded }, escalated?, remaining? }
//
// Sprint 6 (cockpit-integration)

import { cwd } from "node:process";
import { isAbsolute } from "node:path";

import { registerTool } from "./registry.js";
import { planRollback, executeRollback } from "../../incident/rollback.js";

export function registerRollbackTool(): void {
  registerTool({
    name: "bober_rollback_start",
    description:
      "Plan and execute a rollback for an incident. " +
      "Thin adapter over planRollback + executeRollback from src/incident/rollback.ts. " +
      "Each rollback step passes through the per-step risky-action gate. " +
      "Returns { planned: { totalChanges, rollbackableChanges, steps }, executed: { attempted, succeeded }, escalated?, remaining? }.",
    inputSchema: {
      type: "object",
      properties: {
        incidentId: {
          type: "string",
          description: "Incident to roll back.",
        },
        projectPath: {
          type: "string",
          description: "Absolute project root (defaults to cwd).",
        },
      },
      required: ["incidentId"],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>): Promise<string> => {
      const incidentId = typeof args.incidentId === "string" ? args.incidentId.trim() : "";
      if (!incidentId) {
        return JSON.stringify({ error: "incidentId is required and must be a non-empty string." });
      }

      const projectPath = typeof args.projectPath === "string" ? args.projectPath : cwd();
      if (typeof args.projectPath === "string" && !isAbsolute(args.projectPath)) {
        return JSON.stringify({ error: "projectPath must be absolute" });
      }

      let plan;
      try {
        plan = await planRollback(projectPath, incidentId);
      } catch (err) {
        return JSON.stringify({
          error: `Failed to plan rollback: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      let executed;
      try {
        executed = await executeRollback(projectPath, incidentId, plan);
      } catch (err) {
        return JSON.stringify({
          error: `Failed to execute rollback: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      return JSON.stringify(
        {
          planned: {
            totalChanges: plan.totalChanges,
            rollbackableChanges: plan.rollbackableChanges,
            steps: plan.steps,
          },
          executed: {
            attempted: executed.attempted,
            succeeded: executed.succeeded,
          },
          ...(executed.escalated ? { escalated: true } : {}),
          ...(executed.remaining.length > 0 ? { remaining: executed.remaining } : {}),
        },
        null,
        2,
      );
    },
  });
}
