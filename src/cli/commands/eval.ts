import chalk from "chalk";

import { loadConfig } from "../../config/loader.js";
import { createHandoff } from "../../orchestrator/context-handoff.js";
import type { ProjectContext } from "../../orchestrator/context-handoff.js";
import { runEvaluatorAgent } from "../../orchestrator/evaluator-agent.js";
import {
  ensureBoberDir,
  listContracts,
  loadLatestSpec,
} from "../../state/index.js";
import { getCurrentBranch, getChangedFiles } from "../../utils/git.js";
import { logger } from "../../utils/logger.js";

// ── Types ──────────────────────────────────────────────────────────

export interface EvalCommandOptions {
  verbose?: boolean;
  sprint?: string;
  /** Override AI provider for all roles. Overrides config.planner/generator/evaluator.provider. */
  provider?: string;
}

// ── Main ───────────────────────────────────────────────────────────

export async function runEvalCommand(
  projectRoot: string,
  options: EvalCommandOptions,
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

  // Load spec and contracts
  const spec = await loadLatestSpec(projectRoot);
  if (!spec) {
    logger.error("No plan found. Run 'npx agent-bober plan' first.");
    return;
  }

  const contracts = await listContracts(projectRoot);
  if (contracts.length === 0) {
    logger.error("No sprint contracts found.");
    return;
  }

  // Find the target contract
  let targetContract;
  if (options.sprint) {
    targetContract = contracts.find((c) => c.contractId === options.sprint);
    if (!targetContract) {
      logger.error(`Sprint "${options.sprint}" not found.`);
      logger.info(
        `Available sprints: ${contracts.map((c) => c.contractId).join(", ")}`,
      );
      return;
    }
  } else {
    // Find the most recent in-progress or evaluating sprint
    targetContract = contracts.find(
      (c) =>
        c.status === "in-progress" ||
        c.status === "evaluating" ||
        c.status === "needs-rework",
    );

    if (!targetContract) {
      // Fall back to the most recent sprint
      targetContract = contracts[contracts.length - 1];
    }
  }

  logger.phase(`Evaluating: ${targetContract.title}`);
  logger.sprint(targetContract.contractId, `Status: ${targetContract.status}`);

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

  // Build handoff for evaluator
  const completedContracts = contracts.filter(
    (c) => c.status === "passed",
  );

  const handoff = createHandoff({
    from: "generator",
    to: "evaluator",
    projectContext,
    spec,
    currentContract: targetContract,
    sprintHistory: completedContracts,
    instructions: `Re-evaluate sprint: ${targetContract.title}`,
    changedFiles,
  });

  // Run evaluation
  const evaluation = await runEvaluatorAgent(
    handoff,
    projectRoot,
    config,
  );

  // Display results
  console.log();
  const statusIcon = evaluation.passed
    ? chalk.green("[PASS]")
    : chalk.red("[FAIL]");
  console.log(
    `${statusIcon} ${chalk.bold(targetContract.title)} - Score: ${evaluation.score}/100`,
  );
  console.log();

  for (const result of evaluation.results) {
    const icon = result.passed ? chalk.green("  PASS") : chalk.red("  FAIL");
    const scoreStr =
      result.score !== undefined ? ` (${result.score}/100)` : "";
    console.log(`${icon} ${chalk.bold(result.evaluator)}${scoreStr}`);
    console.log(`       ${chalk.gray(result.summary)}`);

    if (!result.passed) {
      const failures = result.details.filter((d: { passed: boolean }) => !d.passed);
      for (const detail of failures.slice(0, 5)) {
        const severityColor =
          detail.severity === "error" ? chalk.red : chalk.yellow;
        const location = detail.file
          ? ` at ${detail.file}${detail.line !== undefined ? `:${detail.line}` : ""}`
          : "";
        console.log(
          `       ${severityColor(`[${detail.severity.toUpperCase()}]`)} ${detail.message}${location}`,
        );
      }
      if (failures.length > 5) {
        console.log(
          chalk.gray(`       ... and ${failures.length - 5} more issues`),
        );
      }

      if (result.feedback) {
        console.log(chalk.yellow(`       Feedback: ${result.feedback.slice(0, 200)}`));
      }
    }
    console.log();
  }

  console.log(chalk.gray(`Summary: ${evaluation.summary}`));

  if (!evaluation.passed) {
    process.exitCode = 1;
  }
}
