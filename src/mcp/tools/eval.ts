// ── bober_eval tool ──────────────────────────────────────────────────
//
// Runs the evaluator agent against a specific sprint or the most
// recent in-progress sprint.
// Accepts { sprintId?: string }. Returns a JSON eval result summary.

import { cwd } from "node:process";

import { configExists, loadConfig } from "../../config/loader.js";
import { createHandoff } from "../../orchestrator/context-handoff.js";
import type { ProjectContext } from "../../orchestrator/context-handoff.js";
import { runEvaluatorAgent } from "../../orchestrator/evaluator-agent.js";
import {
  ensureBoberDir,
  listContracts,
  loadLatestSpec,
} from "../../state/index.js";
import { getCurrentBranch, getChangedFiles } from "../../utils/git.js";
import { registerTool } from "./registry.js";

// ── Registration ─────────────────────────────────────────────────────

export function registerEvalTool(): void {
  registerTool({
    name: "bober_eval",
    description:
      "Run the Bober evaluator agent against a sprint. " +
      "If sprintId is omitted the most recent in-progress, evaluating, or " +
      "needs-rework sprint is targeted (falls back to the last contract). " +
      "Returns a JSON object with pass/fail, score, per-criterion details, " +
      "and actionable feedback.",
    inputSchema: {
      type: "object",
      properties: {
        sprintId: {
          type: "string",
          description:
            "ID of the sprint contract to evaluate. Omit to target the most " +
            "recent active sprint.",
        },
      },
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>): Promise<string> => {
      const sprintId =
        typeof args.sprintId === "string" && args.sprintId.trim()
          ? args.sprintId.trim()
          : undefined;

      const projectRoot = cwd();

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
        });
      }

      await ensureBoberDir(projectRoot);

      const spec = await loadLatestSpec(projectRoot);
      if (!spec) {
        return JSON.stringify({
          error: "No plan found. Run bober_plan first.",
        });
      }

      const contracts = await listContracts(projectRoot);
      if (contracts.length === 0) {
        return JSON.stringify({
          error: "No sprint contracts found. Run bober_plan first.",
        });
      }

      // Resolve target contract
      let targetContract;
      if (sprintId) {
        targetContract = contracts.find((c) => c.id === sprintId);
        if (!targetContract) {
          return JSON.stringify({
            error: `Sprint "${sprintId}" not found.`,
            available: contracts.map((c) => c.id),
          });
        }
      } else {
        targetContract = contracts.find(
          (c) =>
            c.status === "in-progress" ||
            c.status === "evaluating" ||
            c.status === "needs-rework",
        );

        if (!targetContract) {
          // Fall back to the last contract
          targetContract = contracts[contracts.length - 1];
        }
      }

      process.stderr.write(
        `[bober_eval] Evaluating: ${targetContract.feature} (${targetContract.id})\n`,
      );

      // Build project context
      let currentBranch: string;
      try {
        currentBranch = await getCurrentBranch(projectRoot);
      } catch {
        currentBranch = "unknown";
      }

      const projectContext: ProjectContext = {
        name: config.project.name,
        type: config.project.mode,
        techStack: spec.techStack,
        entryPoints: [],
        currentBranch,
      };

      // Get changed files
      let changedFiles: string[];
      try {
        changedFiles = await getChangedFiles(projectRoot);
      } catch {
        changedFiles = [];
      }

      const completedContracts = contracts.filter((c) => c.status === "passed");

      const handoff = createHandoff({
        from: "generator",
        to: "evaluator",
        projectContext,
        spec,
        currentContract: targetContract,
        sprintHistory: completedContracts,
        instructions: `Evaluate sprint: ${targetContract.feature}`,
        changedFiles,
      });

      try {
        const evaluation = await runEvaluatorAgent(handoff, projectRoot, config);

        return JSON.stringify(
          {
            contractId: targetContract.id,
            feature: targetContract.feature,
            passed: evaluation.passed,
            score: evaluation.score,
            summary: evaluation.summary,
            feedback: evaluation.results
              .filter((r) => !r.passed && r.feedback)
              .map((r) => ({ evaluator: r.evaluator, feedback: r.feedback })),
            results: evaluation.results.map((r) => ({
              evaluator: r.evaluator,
              passed: r.passed,
              score: r.score,
              summary: r.summary,
              failedCriteria: r.details
                .filter((d) => !d.passed)
                .map((d) => ({
                  message: d.message,
                  severity: d.severity,
                  ...(d.file ? { file: d.file, line: d.line } : {}),
                })),
            })),
            timestamp: evaluation.timestamp,
          },
          null,
          2,
        );
      } catch (err) {
        return JSON.stringify({
          error: `Evaluation failed: ${err instanceof Error ? err.message : String(err)}`,
          contractId: targetContract.id,
          feature: targetContract.feature,
        });
      }
    },
  });
}
