// ── bober_list_specs tool ─────────────────────────────────────────────
//
// Reads .bober/specs/*.json and returns an array of SpecRow objects.
// Uses listSpecs() from plan-state.ts which already does loose-parsing
// (safeParse + skip invalid files) — perfect for cockpit listing.
//
// Sprint 5 (cockpit-integration)

import { cwd } from "node:process";
import { isAbsolute } from "node:path";

import { registerTool } from "./registry.js";
import { listSpecs } from "../../state/plan-state.js";

// ── Types ─────────────────────────────────────────────────────────────

interface SpecRow {
  specId: string;
  title: string;
  status: string;
  sprintCount: number;
  completedAt?: string;
}

// ── Registration ─────────────────────────────────────────────────────

export function registerListSpecsTool(): void {
  registerTool({
    name: "bober_list_specs",
    description:
      "List all PlanSpecs in a project's .bober/specs/ directory. " +
      "Returns [{ specId, title, status, sprintCount, completedAt? }]. " +
      "Tolerates version mismatches — invalid spec files are silently skipped. " +
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

      const specs = await listSpecs(projectPath);
      const rows: SpecRow[] = specs.map((s) => ({
        specId: s.specId,
        title: s.title,
        status: s.status,
        sprintCount: Array.isArray(s.sprints) ? s.sprints.length : 0,
        ...(s.completedAt ? { completedAt: s.completedAt } : {}),
      }));

      return JSON.stringify(rows, null, 2);
    },
  });
}
