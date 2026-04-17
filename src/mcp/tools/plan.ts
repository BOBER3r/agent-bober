// ── bober_plan tool ─────────────────────────────────────────────────
//
// Accepts { task: string }, calls the planner agent, and returns a
// JSON summary of the produced PlanSpec.

import { cwd } from "node:process";

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

import { configExists, loadConfig } from "../../config/loader.js";
import { createContract } from "../../contracts/sprint-contract.js";
import type { SprintContract } from "../../contracts/sprint-contract.js";
import { runPlanner } from "../../orchestrator/planner-agent.js";
import { ensureBoberDir, saveContract } from "../../state/index.js";
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
        throw new McpError(
          ErrorCode.InvalidRequest,
          "No bober.config.json found. Run bober_init first.",
        );
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
        const plannerResult = await runPlanner(task, projectRoot, config);
        const spec = plannerResult.spec;

        // If the planner refused (high ambiguity), surface the open
        // questions instead of running sprints. The MCP caller decides
        // what to do — typically prompt the user for answers.
        if (plannerResult.kind === "needs-clarification") {
          return JSON.stringify(
            {
              specId: spec.specId,
              status: spec.status,
              title: spec.title,
              description: spec.description,
              ambiguityScore: spec.ambiguityScore,
              clarificationQuestions: spec.clarificationQuestions,
              savedTo: `.bober/specs/${spec.specId}.json`,
              message:
                "Planner needs clarification before sprint contracts can be generated. " +
                `Resolve via 'bober plan answer ${spec.specId} <questionId> "<answer>"' or edit the spec file directly.`,
            },
            null,
            2,
          );
        }

        // Generate sprint contracts from features (same as pipeline.ts).
        // These auto-generated contracts are placeholders; planner-authored
        // contracts (saved by the bober-planner subagent) are richer.
        const contracts: SprintContract[] = [];
        for (let i = 0; i < spec.features.length; i++) {
          const feature = spec.features[i];
          const contract = createContract(
            feature.title,
            feature.description,
            feature.acceptanceCriteria.map((ac, idx) => ({
              criterionId: `${feature.featureId}-criterion-${idx + 1}`,
              description: ac,
              verificationMethod: "agent-evaluation",
            })),
            {
              specId: spec.specId,
              sprintNumber: i + 1,
              features: [feature.featureId],
            },
          );
          contracts.push(contract);
          await saveContract(projectRoot, contract);
        }

        const summary = {
          specId: spec.specId,
          title: spec.title,
          description: spec.description,
          mode: spec.mode,
          status: spec.status,
          techStack: spec.techStack,
          sprintCount: spec.features.length,
          sprints: spec.features.map((f, idx) => ({
            featureId: f.featureId,
            contractId: contracts[idx]?.contractId,
            title: f.title,
            description: f.description,
            priority: f.priority,
            estimatedComplexity: f.estimatedComplexity,
            criteriaCount: f.acceptanceCriteria.length,
            status: "proposed",
          })),
          contractIds: contracts.map((c) => c.contractId),
          assumptions: spec.assumptions,
          outOfScope: spec.outOfScope,
          constraints: spec.constraints,
          savedTo: `.bober/specs/${spec.specId}.json`,
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
