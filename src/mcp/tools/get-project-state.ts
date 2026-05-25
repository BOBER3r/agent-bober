// ── bober_get_project_state tool ──────────────────────────────────────
//
// Aggregates per-project state counts for the cockpit sidebar.
// Returns:
//   { configExists, activeRunCount, lastRunAt?, openIncidentCount,
//     pendingApprovalCount, specCount, mode? }
//
// Does NOT instantiate RunManager; reads disk state directly.
// Open incidents = incidents whose status is NOT 'resolved' or 'aborted'.
//
// Sprint 5 (cockpit-integration)

import { cwd } from "node:process";
import { isAbsolute, join } from "node:path";
import { readFile, access } from "node:fs/promises";
import { constants } from "node:fs";

import { registerTool } from "./registry.js";
import { readRunStatesFromDisk } from "../../state/run-state.js";
import { listIncidents } from "../../incident/timeline.js";
import { listPendingApprovals } from "../../state/approval-state.js";
import { listSpecs } from "../../state/plan-state.js";

// ── Helpers ───────────────────────────────────────────────────────────

/** Open = NOT one of {resolved, aborted} — per contract assumption #2. */
function isOpenIncident(status: string): boolean {
  return status !== "resolved" && status !== "aborted";
}

// ── Registration ─────────────────────────────────────────────────────

export function registerGetProjectStateTool(): void {
  registerTool({
    name: "bober_get_project_state",
    description:
      "Aggregate per-project state counts for the cockpit sidebar. " +
      "Returns { configExists, activeRunCount, lastRunAt?, openIncidentCount, " +
      "pendingApprovalCount, specCount, mode? }. " +
      "Does not instantiate RunManager — reads .bober/runs/*/state.json directly. " +
      "projectPath must be absolute.",
    inputSchema: {
      type: "object",
      properties: {
        projectPath: {
          type: "string",
          description: "Absolute path to the project root.",
        },
      },
      required: ["projectPath"],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>): Promise<string> => {
      const projectPath =
        typeof args.projectPath === "string" ? args.projectPath : cwd();
      if (typeof args.projectPath === "string" && !isAbsolute(args.projectPath)) {
        return JSON.stringify({ error: "projectPath must be absolute" });
      }

      // configExists
      let configExistsValue = false;
      try {
        await access(join(projectPath, "bober.config.json"), constants.R_OK);
        configExistsValue = true;
      } catch {
        // no config
      }

      // mode — read directly from bober.config.json (not loadConfig — too strict)
      let mode: string | undefined;
      if (configExistsValue) {
        try {
          const raw = await readFile(join(projectPath, "bober.config.json"), "utf-8");
          const parsed = JSON.parse(raw) as { project?: { mode?: string } };
          if (parsed.project?.mode) mode = parsed.project.mode;
        } catch {
          // mode stays undefined
        }
      }

      // activeRunCount and lastRunAt from disk
      const runs = await readRunStatesFromDisk(projectPath);
      const activeRunCount = runs.filter((r) => r.status === "running").length;
      const lastRunAt =
        runs.length > 0
          ? runs.map((r) => r.startedAt).sort().slice(-1)[0]
          : undefined;

      // openIncidentCount
      let openIncidentCount = 0;
      try {
        const incidents = await listIncidents(projectPath);
        openIncidentCount = incidents.filter((i) => isOpenIncident(i.status)).length;
      } catch {
        // incidents dir may not exist; treat as 0
      }

      // pendingApprovalCount
      const pendingApprovals = await listPendingApprovals(projectPath);
      const pendingApprovalCount = pendingApprovals.length;

      // specCount
      const specs = await listSpecs(projectPath);
      const specCount = specs.length;

      const result = {
        configExists: configExistsValue,
        activeRunCount,
        ...(lastRunAt !== undefined ? { lastRunAt } : {}),
        openIncidentCount,
        pendingApprovalCount,
        specCount,
        ...(mode !== undefined ? { mode } : {}),
      };

      return JSON.stringify(result, null, 2);
    },
  });
}
