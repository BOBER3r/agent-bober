// ── bober_spec tool ───────────────────────────────────────────────────
//
// Returns the latest PlanSpec JSON.
// If no plans exist, returns a descriptive error object.

import { cwd } from "node:process";

import { loadLatestSpec } from "../../state/index.js";
import { registerTool } from "./registry.js";

// ── Registration ─────────────────────────────────────────────────────

export function registerSpecTool(): void {
  registerTool({
    name: "bober_spec",
    description:
      "Return the latest PlanSpec JSON. " +
      "The spec contains the project overview, feature breakdown, and sprint contracts. " +
      "If no plan exists yet, returns an error message.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: async (_args: Record<string, unknown>): Promise<string> => {
      const projectRoot = cwd();

      const spec = await loadLatestSpec(projectRoot);
      if (spec === null) {
        return JSON.stringify(
          {
            error: "No plans found. Run bober_plan first.",
          },
          null,
          2,
        );
      }

      return JSON.stringify(spec, null, 2);
    },
  });
}
