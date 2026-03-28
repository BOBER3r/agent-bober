// ── bober_sprint tool ────────────────────────────────────────────────
//
// Executes the next pending sprint cycle (generate + evaluate).
// Accepts { continue?: boolean }. Returns a JSON summary of the result.

import { cwd } from "node:process";

import { configExists, loadConfig } from "../../config/loader.js";
import type { SprintContract } from "../../contracts/sprint-contract.js";
import { updateContractStatus } from "../../contracts/sprint-contract.js";
import {
  createHandoff,
  summarizeOlderSprints,
} from "../../orchestrator/context-handoff.js";
import type { ProjectContext } from "../../orchestrator/context-handoff.js";
import { runGenerator } from "../../orchestrator/generator-agent.js";
import { runEvaluatorAgent } from "../../orchestrator/evaluator-agent.js";
import {
  ensureBoberDir,
  listContracts,
  updateContract,
  loadLatestSpec,
  appendHistory,
} from "../../state/index.js";
import { getCurrentBranch, getChangedFiles, commitAll } from "../../utils/git.js";
import { registerTool } from "./registry.js";

// ── Helpers ──────────────────────────────────────────────────────────

const PENDING_STATUSES = new Set([
  "proposed",
  "negotiating",
  "agreed",
  "needs-rework",
]);

function findNextPendingSprint(contracts: SprintContract[]): SprintContract | null {
  return contracts.find((c) => PENDING_STATUSES.has(c.status)) ?? null;
}

async function buildProjectContext(
  projectRoot: string,
  config: { project: { name: string; mode: string } },
): Promise<ProjectContext> {
  let currentBranch: string;
  try {
    currentBranch = await getCurrentBranch(projectRoot);
  } catch {
    currentBranch = "unknown";
  }

  return {
    name: config.project.name,
    type: config.project.mode,
    techStack: [],
    entryPoints: [],
    currentBranch,
  };
}

// ── Registration ─────────────────────────────────────────────────────

export function registerSprintTool(): void {
  registerTool({
    name: "bober_sprint",
    description:
      "Execute the next pending sprint in the Bober pipeline (generate + evaluate). " +
      "Finds the first contract in 'proposed' or 'needs-rework' status, runs the " +
      "generate-evaluate-iterate cycle, and returns a JSON result with pass/fail status " +
      "and evaluator feedback. Requires a plan to exist (run bober_plan first).",
    inputSchema: {
      type: "object",
      properties: {
        continue: {
          type: "boolean",
          description:
            "If true, keep running sprints until all are complete or one fails.",
          default: false,
        },
      },
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>): Promise<string> => {
      const shouldContinue = Boolean(args.continue ?? false);
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
          error: "No plan found. Run bober_plan first to generate a plan.",
        });
      }

      const contracts = await listContracts(projectRoot);
      if (contracts.length === 0) {
        return JSON.stringify({
          error: "No sprint contracts found. Run bober_plan first.",
        });
      }

      const projectContext = await buildProjectContext(projectRoot, config);
      const results: unknown[] = [];

      let continueLoop = true;
      while (continueLoop) {
        const nextSprint = findNextPendingSprint(contracts);
        if (!nextSprint) {
          if (results.length === 0) {
            return JSON.stringify({
              status: "all-complete",
              message: "All sprints are already completed.",
              contracts: contracts.map((c) => ({
                id: c.id,
                feature: c.feature,
                status: c.status,
              })),
            });
          }
          break;
        }

        process.stderr.write(
          `[bober_sprint] Starting sprint: ${nextSprint.feature} (${nextSprint.id})\n`,
        );

        const completedContracts = contracts.filter((c) => c.status === "passed");
        const maxIterations = config.evaluator.maxIterations;
        let currentContract = updateContractStatus(nextSprint, "in-progress");
        await updateContract(projectRoot, currentContract);

        const contractIndex = contracts.findIndex((c) => c.id === currentContract.id);
        if (contractIndex !== -1) {
          contracts[contractIndex] = currentContract;
        }

        let sprintPassed = false;
        let lastEvalSummary: string | undefined;
        let lastEvalScore: number | undefined;

        for (let iteration = 1; iteration <= maxIterations; iteration++) {
          process.stderr.write(
            `[bober_sprint] Iteration ${iteration}/${maxIterations} for ${currentContract.id}\n`,
          );

          const handoff = createHandoff({
            from: iteration === 1 ? "planner" : "evaluator",
            to: "generator",
            projectContext,
            spec,
            currentContract,
            sprintHistory: completedContracts,
            instructions: `Implement sprint: ${currentContract.feature}\n\n${currentContract.description}`,
            issues: currentContract.evaluatorFeedback
              ? [currentContract.evaluatorFeedback]
              : [],
          });

          const compactedHandoff = summarizeOlderSprints(handoff, 3);

          // Generate
          await appendHistory(projectRoot, {
            timestamp: new Date().toISOString(),
            event: "generator-start",
            phase: "generating",
            sprintId: currentContract.id,
            details: { iteration },
          });

          const generatorResult = await runGenerator(compactedHandoff, projectRoot, config);

          if (!generatorResult.success) {
            process.stderr.write(
              `[bober_sprint] Generator failed: ${generatorResult.notes}\n`,
            );
            currentContract = {
              ...currentContract,
              generatorNotes: generatorResult.notes,
            };
            await updateContract(projectRoot, currentContract);

            if (iteration < maxIterations) {
              continue;
            }

            currentContract = updateContractStatus(currentContract, "needs-rework");
            await updateContract(projectRoot, currentContract);
            break;
          }

          // Auto-commit
          if (config.generator.autoCommit) {
            try {
              const hash = await commitAll(
                projectRoot,
                `bober: ${currentContract.feature} (round ${iteration})`,
              );
              process.stderr.write(`[bober_sprint] Committed: ${hash}\n`);
            } catch (err) {
              process.stderr.write(
                `[bober_sprint] Auto-commit skipped: ${err instanceof Error ? err.message : String(err)}\n`,
              );
            }
          }

          // Evaluate
          currentContract = updateContractStatus(currentContract, "evaluating");
          await updateContract(projectRoot, currentContract);

          let changedFiles: string[];
          try {
            changedFiles = await getChangedFiles(projectRoot);
          } catch {
            changedFiles = generatorResult.filesChanged;
          }

          const evalHandoff = createHandoff({
            from: "generator",
            to: "evaluator",
            projectContext,
            spec,
            currentContract,
            sprintHistory: completedContracts,
            instructions: `Evaluate sprint: ${currentContract.feature}`,
            changedFiles,
          });

          const evaluation = await runEvaluatorAgent(evalHandoff, projectRoot, config);
          lastEvalSummary = evaluation.summary;
          lastEvalScore = evaluation.score;

          if (evaluation.passed) {
            currentContract = updateContractStatus(currentContract, "passed");
            currentContract = {
              ...currentContract,
              evaluatorFeedback: evaluation.summary,
            };
            await updateContract(projectRoot, currentContract);
            sprintPassed = true;
            break;
          }

          // Failed
          currentContract = {
            ...currentContract,
            evaluatorFeedback: evaluation.summary,
          };
          await updateContract(projectRoot, currentContract);

          if (iteration >= maxIterations) {
            currentContract = updateContractStatus(currentContract, "needs-rework");
            await updateContract(projectRoot, currentContract);
          }
        }

        // Update local array
        if (contractIndex !== -1) {
          contracts[contractIndex] = currentContract;
        }

        results.push({
          contractId: currentContract.id,
          feature: currentContract.feature,
          status: currentContract.status,
          passed: sprintPassed,
          score: lastEvalScore,
          iteration: maxIterations,
          evaluatorFeedback: lastEvalSummary ?? currentContract.evaluatorFeedback ?? null,
        });

        if (!shouldContinue) {
          continueLoop = false;
        } else if (!sprintPassed && config.sprint.requireContracts) {
          continueLoop = false;
        }
      }

      // Return single result if only one sprint ran, otherwise array
      if (results.length === 1) {
        return JSON.stringify(results[0], null, 2);
      }

      return JSON.stringify(
        {
          sprintsRun: results.length,
          results,
        },
        null,
        2,
      );
    },
  });
}
