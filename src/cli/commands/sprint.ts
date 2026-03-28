import chalk from "chalk";

import { loadConfig } from "../../config/loader.js";
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
import { logger } from "../../utils/logger.js";

// ── Types ──────────────────────────────────────────────────────────

export interface SprintCommandOptions {
  verbose?: boolean;
  continue?: boolean;
  /** Override AI provider for all roles. Overrides config.planner/generator/evaluator.provider. */
  provider?: string;
}

// ── Helpers ────────────────────────────────────────────────────────

function findNextPendingSprint(
  contracts: SprintContract[],
): SprintContract | null {
  // Find the first contract that hasn't been completed
  const pendingStatuses = new Set([
    "proposed",
    "negotiating",
    "agreed",
    "needs-rework",
  ]);

  return (
    contracts.find((c) => pendingStatuses.has(c.status)) ?? null
  );
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

// ── Main ───────────────────────────────────────────────────────────

export async function runSprintCommand(
  projectRoot: string,
  options: SprintCommandOptions,
): Promise<void> {
  if (options.verbose) {
    logger.verbose = true;
  }

  // Load config
  let config;
  try {
    config = await loadConfig(projectRoot);
  } catch (err) {
    logger.error(
      `Failed to load config: ${err instanceof Error ? err.message : String(err)}`,
    );
    logger.info('Run "npx agent-bober init" to create a configuration.');
    return;
  }

  // Apply --provider override for all roles
  if (options.provider) {
    config = {
      ...config,
      planner: { ...config.planner, provider: options.provider },
      generator: { ...config.generator, provider: options.provider },
      evaluator: { ...config.evaluator, provider: options.provider },
    };
    logger.info(`Provider override: ${options.provider}`);
  }

  await ensureBoberDir(projectRoot);

  // Load current spec
  const spec = await loadLatestSpec(projectRoot);
  if (!spec) {
    logger.error("No plan found. Run 'npx agent-bober plan' first.");
    return;
  }

  // Load contracts
  const contracts = await listContracts(projectRoot);
  if (contracts.length === 0) {
    logger.error("No sprint contracts found. Run 'npx agent-bober plan' first.");
    return;
  }

  const projectContext = await buildProjectContext(projectRoot, config);

  let continueLoop = true;

  while (continueLoop) {
    // Find next pending sprint
    const nextSprint = findNextPendingSprint(contracts);
    if (!nextSprint) {
      logger.success("All sprints completed!");
      break;
    }

    logger.phase(`Sprint: ${nextSprint.feature}`);
    logger.sprint(nextSprint.id, `Starting: ${nextSprint.description}`);

    // Get completed sprints
    const completedContracts = contracts.filter(
      (c) => c.status === "passed",
    );

    const maxIterations = config.evaluator.maxIterations;
    let currentContract = updateContractStatus(nextSprint, "in-progress");
    await updateContract(projectRoot, currentContract);

    // Update the contract in our local array
    const contractIndex = contracts.findIndex(
      (c) => c.id === currentContract.id,
    );
    if (contractIndex !== -1) {
      contracts[contractIndex] = currentContract;
    }

    let sprintPassed = false;

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      logger.progress(
        iteration,
        maxIterations,
        `Iteration ${iteration}`,
      );

      // Build handoff
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
      logger.info("Running generator...");
      await appendHistory(projectRoot, {
        timestamp: new Date().toISOString(),
        event: "generator-start",
        phase: "generating",
        sprintId: currentContract.id,
        details: { iteration },
      });

      const generatorResult = await runGenerator(
        compactedHandoff,
        projectRoot,
        config,
      );

      if (!generatorResult.success) {
        logger.warn(`Generator failed: ${generatorResult.notes}`);
        currentContract = {
          ...currentContract,
          generatorNotes: generatorResult.notes,
        };
        await updateContract(projectRoot, currentContract);

        if (iteration < maxIterations) {
          continue;
        }

        currentContract = updateContractStatus(
          currentContract,
          "needs-rework",
        );
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
          logger.success(`Committed: ${hash}`);
        } catch (err) {
          logger.debug(
            `Auto-commit skipped: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Evaluate
      logger.info("Running evaluator...");
      currentContract = updateContractStatus(
        currentContract,
        "evaluating",
      );
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

      const evaluation = await runEvaluatorAgent(
        evalHandoff,
        projectRoot,
        config,
      );

      if (evaluation.passed) {
        logger.success(`Sprint passed! Score: ${evaluation.score}/100`);
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
      logger.warn(
        `Evaluation failed (${iteration}/${maxIterations}): ${evaluation.summary.slice(0, 150)}`,
      );
      currentContract = {
        ...currentContract,
        evaluatorFeedback: evaluation.summary,
      };
      await updateContract(projectRoot, currentContract);

      if (iteration >= maxIterations) {
        currentContract = updateContractStatus(
          currentContract,
          "needs-rework",
        );
        await updateContract(projectRoot, currentContract);
        logger.error("Max iterations reached. Sprint needs rework.");
      }
    }

    // Update local array
    if (contractIndex !== -1) {
      contracts[contractIndex] = currentContract;
    }

    // Display result
    console.log();
    const statusIcon = sprintPassed
      ? chalk.green("[PASS]")
      : chalk.red("[FAIL]");
    console.log(
      `${statusIcon} ${chalk.bold(currentContract.feature)} (${currentContract.id})`,
    );

    if (currentContract.generatorNotes) {
      console.log(chalk.gray(`  Notes: ${currentContract.generatorNotes.slice(0, 200)}`));
    }

    // Continue to next sprint?
    if (!options.continue) {
      continueLoop = false;
    } else if (!sprintPassed && config.sprint.requireContracts) {
      logger.warn("Sprint failed and contracts are required. Stopping.");
      continueLoop = false;
    }
  }
}
