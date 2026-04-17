import prompts from "prompts";
import chalk from "chalk";
import ora from "ora";

import { loadConfig } from "../../config/loader.js";
import { configExists } from "../../config/loader.js";
import { runPipeline } from "../../orchestrator/pipeline.js";
import { ensureBoberDir } from "../../state/index.js";
import { logger } from "../../utils/logger.js";

// ── Types ──────────────────────────────────────────────────────────

export interface RunCommandOptions {
  verbose?: boolean;
  /** Override AI provider for all roles. Overrides config.planner/generator/evaluator.provider. */
  provider?: string;
}

// ── Formatting helpers ─────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

// ── Main ───────────────────────────────────────────────────────────

export async function runRunCommand(
  taskDescription: string | undefined,
  projectRoot: string,
  options: RunCommandOptions,
): Promise<void> {
  if (options.verbose) {
    logger.verbose = true;
  }

  // Check for config
  const hasConfig = await configExists(projectRoot);
  if (!hasConfig) {
    logger.error("No bober configuration found.");
    logger.info(
      'Run "npx agent-bober init" to set up your project, or provide a config path with --config.',
    );
    return;
  }

  // If no task description provided, prompt for one
  let task = taskDescription;
  if (!task) {
    const answer = await prompts({
      type: "text",
      name: "task",
      message: "What do you want to build?",
      validate: (value: string) =>
        value.trim().length > 0 ? true : "Please describe your task",
    });

    if (!answer.task) {
      logger.info("Run cancelled.");
      return;
    }
    task = answer.task as string;
  }

  // Load config
  let config;
  try {
    config = await loadConfig(projectRoot);
  } catch (err) {
    logger.error(
      `Failed to load config: ${err instanceof Error ? err.message : String(err)}`,
    );
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

  // Ensure .bober directory
  await ensureBoberDir(projectRoot);

  // Show start banner
  console.log();
  console.log(chalk.bold.blue("  agent-bober"));
  console.log(chalk.gray(`  Project: ${config.project.name}`));
  console.log(chalk.gray(`  Mode: ${config.project.mode}`));
  console.log(chalk.gray(`  Task: ${task.slice(0, 80)}${task.length > 80 ? "..." : ""}`));
  console.log();

  const spinner = ora("Starting pipeline...").start();

  try {
    spinner.stop();

    const result = await runPipeline(task, projectRoot, config);

    // Display final summary
    console.log();
    console.log(chalk.bold("═══ Pipeline Summary ═══"));
    console.log();

    const statusIcon = result.success
      ? chalk.green("[SUCCESS]")
      : chalk.red("[FAILED]");
    console.log(`  Status:     ${statusIcon}`);
    console.log(
      `  Duration:   ${chalk.cyan(formatDuration(result.duration))}`,
    );
    console.log(`  Plan:       ${chalk.cyan(result.spec.title)}`);
    console.log(
      `  Features:   ${chalk.cyan(String(result.spec.features.length))}`,
    );
    console.log(
      `  Completed:  ${chalk.green(String(result.completedSprints.length))} sprints`,
    );
    if (result.failedSprints.length > 0) {
      console.log(
        `  Failed:     ${chalk.red(String(result.failedSprints.length))} sprints`,
      );
    }
    if (result.totalCost !== undefined) {
      console.log(
        `  Est. cost:  ${chalk.yellow(`$${result.totalCost.toFixed(2)}`)}`,
      );
    }

    // List completed sprints
    if (result.completedSprints.length > 0) {
      console.log();
      console.log(chalk.bold("Completed sprints:"));
      for (const sprint of result.completedSprints) {
        console.log(`  ${chalk.green("  ✓")} ${sprint.title}`);
      }
    }

    // List failed sprints
    if (result.failedSprints.length > 0) {
      console.log();
      console.log(chalk.bold("Failed sprints:"));
      for (const sprint of result.failedSprints) {
        console.log(`  ${chalk.red("  x")} ${sprint.title}`);
        if (sprint.evaluatorFeedback) {
          console.log(
            chalk.gray(`      ${sprint.evaluatorFeedback.slice(0, 100)}`),
          );
        }
      }
    }

    console.log();

    if (!result.success) {
      process.exitCode = 1;
    }
  } catch (err) {
    spinner.stop();
    logger.error(
      `Pipeline failed: ${err instanceof Error ? err.message : String(err)}`,
    );

    if (logger.verbose && err instanceof Error && err.stack) {
      console.error(chalk.gray(err.stack));
    }

    process.exitCode = 1;
  }
}
