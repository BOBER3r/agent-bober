import prompts from "prompts";
import chalk from "chalk";

import { loadConfig } from "../../config/loader.js";
import { runPlanner } from "../../orchestrator/planner-agent.js";
import { ensureBoberDir } from "../../state/index.js";
import { logger } from "../../utils/logger.js";

// ── Main ───────────────────────────────────────────────────────────

export interface PlanCommandOptions {
  verbose?: boolean;
  /** Override AI provider for all roles. Overrides config.planner/generator/evaluator.provider. */
  provider?: string;
}

export async function runPlanCommand(
  taskDescription: string | undefined,
  projectRoot: string,
  options: PlanCommandOptions,
): Promise<void> {
  if (options.verbose) {
    logger.verbose = true;
  }

  // If no task description provided, prompt for one
  let task = taskDescription;
  if (!task) {
    const answer = await prompts({
      type: "text",
      name: "task",
      message: "Describe what you want to build:",
      validate: (value: string) =>
        value.trim().length > 0 ? true : "Please enter a task description",
    });

    if (!answer.task) {
      logger.info("Plan cancelled.");
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

  // Ensure .bober directory exists
  await ensureBoberDir(projectRoot);

  // Run planner
  try {
    const spec = await runPlanner(task, projectRoot, config);

    // Display results
    console.log();
    console.log(chalk.bold("Plan: ") + chalk.cyan(spec.title));
    console.log(chalk.gray(spec.description));
    console.log();

    console.log(chalk.bold("Features:"));
    for (const feature of spec.features) {
      const priorityColor =
        feature.priority === "must"
          ? chalk.red
          : feature.priority === "should"
            ? chalk.yellow
            : chalk.gray;

      console.log(
        `  ${priorityColor(`[${feature.priority.toUpperCase()}]`)} ${chalk.bold(feature.title)}`,
      );
      console.log(`    ${chalk.gray(feature.description)}`);
      console.log(
        `    Sprints: ~${feature.estimatedSprints} | Criteria: ${feature.acceptanceCriteria.length}`,
      );

      if (logger.verbose) {
        for (const criterion of feature.acceptanceCriteria) {
          console.log(`      - ${criterion}`);
        }
      }
    }

    if (spec.nonFunctional.length > 0) {
      console.log();
      console.log(chalk.bold("Non-functional requirements:"));
      for (const nfr of spec.nonFunctional) {
        console.log(`  - ${nfr}`);
      }
    }

    if (spec.constraints.length > 0) {
      console.log();
      console.log(chalk.bold("Constraints:"));
      for (const constraint of spec.constraints) {
        console.log(`  - ${constraint}`);
      }
    }

    console.log();
    console.log(
      chalk.gray(`Tech stack: ${spec.techStack.join(", ") || "not specified"}`),
    );
    console.log(chalk.gray(`Saved to .bober/specs/${spec.id}.json`));
    console.log();
    console.log(
      `Next: ${chalk.green("npx agent-bober sprint")} to start the first sprint`,
    );
  } catch (err) {
    logger.error(
      `Planning failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  }
}
