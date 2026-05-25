// ── bober_incident_* tools ────────────────────────────────────────────
//
// Four thin adapters over src/incident/timeline.ts and src/incident/orchestrator.ts.
// No business logic lives here — all logic is delegated to the underlying helpers.
//
// Sprint 6 (cockpit-integration)

import { cwd } from "node:process";
import { isAbsolute } from "node:path";

import { registerTool } from "./registry.js";
import {
  createIncident,
  listIncidents,
  setIncidentStatus,
} from "../../incident/timeline.js";
import { abort, readIncidentMetadata } from "../../incident/orchestrator.js";

export function registerIncidentTools(): void {
  // ── bober_incident_start ────────────────────────────────────────────
  registerTool({
    name: "bober_incident_start",
    description:
      "Create a new incident from a symptom and optional severity. " +
      "Delegates to createIncident from src/incident/timeline.ts. " +
      "Returns { incidentId, status, createdAt, severity? }.",
    inputSchema: {
      type: "object",
      properties: {
        symptom: {
          type: "string",
          description: "Human-readable symptom description.",
        },
        severity: {
          type: "string",
          enum: ["S1", "S2", "S3", "S4"],
          description: "Optional severity level.",
        },
        projectPath: {
          type: "string",
          description: "Absolute project root (defaults to cwd).",
        },
      },
      required: ["symptom"],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>): Promise<string> => {
      const symptom = typeof args.symptom === "string" ? args.symptom.trim() : "";
      if (!symptom) {
        return JSON.stringify({ error: "symptom is required and must be a non-empty string." });
      }

      const projectPath = typeof args.projectPath === "string" ? args.projectPath : cwd();
      if (typeof args.projectPath === "string" && !isAbsolute(args.projectPath)) {
        return JSON.stringify({ error: "projectPath must be absolute" });
      }

      const severity = typeof args.severity === "string" ? args.severity : undefined;
      if (severity !== undefined && !["S1", "S2", "S3", "S4"].includes(severity)) {
        return JSON.stringify({
          error: `Invalid severity '${severity}'. Must be one of: S1, S2, S3, S4`,
        });
      }

      let incidentId: string;
      try {
        incidentId = await createIncident(symptom, projectPath);
      } catch (err) {
        return JSON.stringify({
          error: `Failed to create incident: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      if (severity) {
        try {
          await setIncidentStatus(projectPath, incidentId, "investigating", {
            severity: severity as "S1" | "S2" | "S3" | "S4",
          });
        } catch (err) {
          return JSON.stringify({
            error: `Failed to set severity: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }

      let meta;
      try {
        meta = await readIncidentMetadata(projectPath, incidentId);
      } catch (err) {
        return JSON.stringify({
          error: `Failed to read incident metadata: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      return JSON.stringify(
        {
          incidentId,
          status: meta.status,
          createdAt: meta.createdAt,
          ...(meta.severity ? { severity: meta.severity } : {}),
        },
        null,
        2,
      );
    },
  });

  // ── bober_incident_status ───────────────────────────────────────────
  registerTool({
    name: "bober_incident_status",
    description:
      "Read the current status of an incident. " +
      "Delegates to readIncidentMetadata from src/incident/orchestrator.ts. " +
      "Returns { incidentId, symptom, status, severity?, createdAt, resolvedAt?, resolutionEvidence? }.",
    inputSchema: {
      type: "object",
      properties: {
        incidentId: {
          type: "string",
          description: "Incident ID to query.",
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

      let meta;
      try {
        meta = await readIncidentMetadata(projectPath, incidentId);
      } catch (err) {
        if ((err as { code?: string }).code === "ENOENT") {
          return JSON.stringify({ error: `Incident not found: ${incidentId}` });
        }
        return JSON.stringify({
          error: `Failed to read incident: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      return JSON.stringify(
        {
          incidentId: meta.incidentId,
          symptom: meta.symptom,
          status: meta.status,
          ...(meta.severity !== undefined ? { severity: meta.severity } : {}),
          createdAt: meta.createdAt,
          ...(meta.resolvedAt !== undefined ? { resolvedAt: meta.resolvedAt } : {}),
          ...(meta.resolutionEvidence !== undefined
            ? { resolutionEvidence: meta.resolutionEvidence }
            : {}),
        },
        null,
        2,
      );
    },
  });

  // ── bober_incident_list ─────────────────────────────────────────────
  registerTool({
    name: "bober_incident_list",
    description:
      "List all incidents sorted by createdAt descending. " +
      "Delegates to listIncidents from src/incident/timeline.ts. " +
      "Returns [{ incidentId, symptom, createdAt, status, resolvedAt? }].",
    inputSchema: {
      type: "object",
      properties: {
        projectPath: {
          type: "string",
          description: "Absolute project root (defaults to cwd).",
        },
      },
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>): Promise<string> => {
      const projectPath = typeof args.projectPath === "string" ? args.projectPath : cwd();
      if (typeof args.projectPath === "string" && !isAbsolute(args.projectPath)) {
        return JSON.stringify({ error: "projectPath must be absolute" });
      }

      let summaries;
      try {
        summaries = await listIncidents(projectPath);
      } catch (err) {
        return JSON.stringify({
          error: `Failed to list incidents: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      return JSON.stringify(summaries, null, 2);
    },
  });

  // ── bober_incident_abort ────────────────────────────────────────────
  registerTool({
    name: "bober_incident_abort",
    description:
      "Abort an incident at any phase. " +
      "Delegates to abort from src/incident/orchestrator.ts. " +
      "Writes abort-report.md and transitions the incident to aborted (terminal). " +
      "Returns { incidentId, status: 'aborted', abortReportPath, rollback? }.",
    inputSchema: {
      type: "object",
      properties: {
        incidentId: {
          type: "string",
          description: "Incident to abort.",
        },
        reason: {
          type: "string",
          description: "Required reason for aborting.",
        },
        confirmRollback: {
          type: "boolean",
          description: "If true, plan and execute rollback for executed-not-rolled-back changes.",
        },
        projectPath: {
          type: "string",
          description: "Absolute project root (defaults to cwd).",
        },
      },
      required: ["incidentId", "reason"],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>): Promise<string> => {
      const incidentId = typeof args.incidentId === "string" ? args.incidentId.trim() : "";
      if (!incidentId) {
        return JSON.stringify({ error: "incidentId is required and must be a non-empty string." });
      }

      const reason = typeof args.reason === "string" ? args.reason.trim() : "";
      if (!reason) {
        return JSON.stringify({ error: "reason is required and must be a non-empty string." });
      }

      const projectPath = typeof args.projectPath === "string" ? args.projectPath : cwd();
      if (typeof args.projectPath === "string" && !isAbsolute(args.projectPath)) {
        return JSON.stringify({ error: "projectPath must be absolute" });
      }

      const confirmRollback = args.confirmRollback === true;

      let result;
      try {
        result = await abort(projectPath, incidentId, { reason, confirmRollback });
      } catch (err) {
        if (
          err instanceof Error &&
          err.message.includes("already aborted")
        ) {
          return JSON.stringify({ error: err.message });
        }
        return JSON.stringify({
          error: `Failed to abort incident: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      return JSON.stringify(
        {
          incidentId,
          status: "aborted",
          abortReportPath: result.abortReportPath,
          ...(result.rollback !== undefined ? { rollback: result.rollback } : {}),
        },
        null,
        2,
      );
    },
  });
}
