// ── bober_plan tool ─────────────────────────────────────────────────
//
// Accepts { task: string }, calls the planner agent, and returns a
// JSON summary of the produced PlanSpec.

import { cwd } from "node:process";

import { configExists, loadConfig } from "../../config/loader.js";
import { runPlanner } from "../../orchestrator/planner-agent.js";
import { ensureBoberDir } from "../../state/index.js";
import { registerTool } from "./registry.js";

// ── Registration ─────────────────────────────────────────────────────

export function registerPlanTool(): void {
  registerTool({
    name: "bober_plan",
    description:
      "Run the Bober planner agent. Accepts a task/feature description and " +
      "produces a PlanSpec with a sprint breakdown saved to .bober/specs/. " +
      "Returns a JSON summary with the plan title, description, and sprint list.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Feature or project description to plan.",
        },
      },
      required: ["task"],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>): Promise<string> => {
      const task = String(args.task ?? "").trim();
      if (!task) {
        return JSON.stringify({ error: "task is required and must be a non-empty string." });
      }

      const projectRoot = cwd();

      // Check config exists before attempting to load
      const hasConfig = await configExists(projectRoot);
      if (!hasConfig) {
        return JSON.stringify({
          error:
            "No bober.config.json found. Run bober_init first to initialise the project.",
          projectRoot,
        });
      }

      let config;
      try {
        config = await loadConfig(projectRoot);
      } catch (err) {
        return JSON.stringify({
          error: `Failed to load config: ${err instanceof Error ? err.message : String(err)}`,
          projectRoot,
        });
      }

      await ensureBoberDir(projectRoot);

      try {
        const spec = await runPlanner(task, projectRoot, config);

        const summary = {
          id: spec.id,
          title: spec.title,
          description: spec.description,
          projectType: spec.projectType,
          techStack: spec.techStack,
          sprintCount: spec.features.length,
          sprints: spec.features.map((f) => ({
            id: f.id,
            feature: f.title,
            description: f.description,
            priority: f.priority,
            estimatedSprints: f.estimatedSprints,
            criteriaCount: f.acceptanceCriteria.length,
            status: "proposed",
          })),
          nonFunctional: spec.nonFunctional,
          constraints: spec.constraints,
          savedTo: `.bober/specs/${spec.id}.json`,
        };

        return JSON.stringify(summary, null, 2);
      } catch (err) {
        return JSON.stringify({
          error: `Planner failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
  });
}
