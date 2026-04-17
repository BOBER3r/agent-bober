import prompts from "prompts";
import chalk from "chalk";

import { loadConfig } from "../../config/loader.js";
import {
  getOpenClarifications,
  resolveClarification,
  type ClarificationQuestion,
  type PlanSpec,
} from "../../contracts/spec.js";
import { runPlanner } from "../../orchestrator/planner-agent.js";
import {
  ensureBoberDir,
  loadSpec,
  saveSpec,
} from "../../state/index.js";
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
    const result = await runPlanner(task, projectRoot, config);
    const spec = result.spec;

    // Branch: clarification needed → display questions and exit
    if (result.kind === "needs-clarification") {
      printClarificationPrompt(spec);
      process.exitCode = 2; // distinct exit code so /loop can detect parking
      return;
    }

    // Display normal plan results
    printPlan(spec);
  } catch (err) {
    logger.error(
      `Planning failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  }
}

// ── Plan display ───────────────────────────────────────────────────

function priorityColor(priority: PlanSpec["features"][number]["priority"]): typeof chalk.red {
  if (priority === "must-have") return chalk.red;
  if (priority === "should-have") return chalk.yellow;
  return chalk.gray;
}

function printPlan(spec: PlanSpec): void {
  console.log();
  console.log(chalk.bold("Plan: ") + chalk.cyan(spec.title));
  console.log(chalk.gray(spec.description));
  console.log();

  console.log(chalk.bold("Features:"));
  for (const feature of spec.features) {
    const color = priorityColor(feature.priority);

    console.log(
      `  ${color(`[${feature.priority.toUpperCase()}]`)} ${chalk.bold(feature.title)}`,
    );
    console.log(`    ${chalk.gray(feature.description)}`);
    const sizing = feature.estimatedComplexity
      ? `Complexity: ${feature.estimatedComplexity}`
      : `Sprints: ~${feature.estimatedSprints ?? "?"}`;
    console.log(
      `    ${sizing} | Criteria: ${feature.acceptanceCriteria.length}`,
    );

    if (logger.verbose) {
      for (const criterion of feature.acceptanceCriteria) {
        console.log(`      - ${criterion}`);
      }
    }
  }

  if (spec.assumptions.length > 0) {
    console.log();
    console.log(chalk.bold("Assumptions:"));
    for (const a of spec.assumptions) {
      console.log(`  - ${a}`);
    }
  }

  if (spec.outOfScope.length > 0) {
    console.log();
    console.log(chalk.bold("Out of scope:"));
    for (const o of spec.outOfScope) {
      console.log(`  - ${o}`);
    }
  }

  if (spec.constraints.length > 0) {
    console.log();
    console.log(chalk.bold("Constraints:"));
    for (const c of spec.constraints) {
      console.log(`  - ${c}`);
    }
  }

  console.log();
  console.log(
    chalk.gray(
      `Tech stack: ${spec.techStack.join(", ") || "not specified"}  |  Mode: ${spec.mode}`,
    ),
  );
  console.log(chalk.gray(`Saved to .bober/specs/${spec.specId}.json`));
  console.log();
  console.log(
    `Next: ${chalk.green("npx agent-bober sprint")} to start the first sprint`,
  );
}

// ── Clarification display ──────────────────────────────────────────

function printClarificationPrompt(spec: PlanSpec): void {
  console.log();
  console.log(
    chalk.yellow.bold("⚠ Plan needs clarification before sprints can run."),
  );
  console.log(chalk.gray(`Spec: ${spec.title}`));
  if (spec.ambiguityScore !== undefined) {
    console.log(chalk.gray(`Ambiguity score: ${spec.ambiguityScore}/10`));
  }
  console.log();

  const open = getOpenClarifications(spec);
  console.log(
    chalk.bold(
      `${open.length} open question${open.length === 1 ? "" : "s"}:`,
    ),
  );
  for (const q of open) {
    console.log();
    console.log(chalk.cyan(`  ${q.questionId} [${q.category}]`));
    console.log(`    ${q.question}`);
    if (q.options && q.options.length > 0) {
      for (const opt of q.options) {
        console.log(chalk.gray(`      ${opt.label}) ${opt.description}`));
      }
    }
    if (q.recommendation) {
      console.log(chalk.gray(`    💡 Suggested: ${q.recommendation}`));
    }
  }

  console.log();
  console.log(chalk.bold("Resolve via either:"));
  console.log(
    `  ${chalk.green(
      `npx agent-bober plan answer ${spec.specId} <questionId> "<answer>"`,
    )}`,
  );
  console.log(
    `  Or edit ${chalk.cyan(`.bober/specs/${spec.specId}.json`)} directly and flip status to "ready".`,
  );
  console.log();
}

// ── Answer subcommand ─────────────────────────────────────────────

export interface PlanAnswerOptions {
  verbose?: boolean;
}

/**
 * Resolve a single clarification question on a spec.
 *
 * Loads the spec, applies the answer, persists. If this answer was the last
 * open question, the spec status flips from `needs-clarification` to `ready`
 * (handled inside `resolveClarification`).
 */
export async function runPlanAnswerCommand(
  specId: string,
  questionId: string,
  answer: string,
  projectRoot: string,
  options: PlanAnswerOptions = {},
): Promise<void> {
  if (options.verbose) {
    logger.verbose = true;
  }

  let spec: PlanSpec;
  try {
    spec = await loadSpec(projectRoot, specId);
  } catch (err) {
    logger.error(
      `Failed to load spec "${specId}": ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
    return;
  }

  let updated: PlanSpec;
  try {
    updated = resolveClarification(spec, questionId, answer, "user");
  } catch (err) {
    logger.error(
      err instanceof Error ? err.message : String(err),
    );
    process.exitCode = 1;
    return;
  }

  try {
    await saveSpec(projectRoot, updated);
  } catch (err) {
    logger.error(
      `Failed to save updated spec: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    chalk.green(`✓ Recorded answer for ${questionId} on ${spec.specId}`),
  );

  const remaining = getOpenClarifications(updated);
  if (remaining.length === 0) {
    console.log(
      chalk.green.bold(
        `All clarifications resolved. Spec is now status: ${updated.status}.`,
      ),
    );
    if (updated.status === "ready") {
      console.log(
        `Next: ${chalk.green(`npx agent-bober run`)} to execute the plan.`,
      );
    }
  } else {
    console.log(
      chalk.yellow(
        `${remaining.length} question${remaining.length === 1 ? "" : "s"} still open:`,
      ),
    );
    for (const q of remaining) {
      console.log(chalk.gray(`  - ${q.questionId}: ${q.question}`));
    }
  }
}

// ── Interactive resolution helper (used by `bober plan answer` w/o args) ──

export async function runPlanAnswerInteractive(
  specId: string,
  projectRoot: string,
  options: PlanAnswerOptions = {},
): Promise<void> {
  if (options.verbose) {
    logger.verbose = true;
  }

  let spec: PlanSpec;
  try {
    spec = await loadSpec(projectRoot, specId);
  } catch (err) {
    logger.error(
      `Failed to load spec "${specId}": ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
    return;
  }

  const open = getOpenClarifications(spec);
  if (open.length === 0) {
    console.log(
      chalk.green(
        `Spec ${specId} has no open clarifications. Status: ${spec.status}.`,
      ),
    );
    return;
  }

  // Walk through each open question and prompt for an answer
  let working = spec;
  for (const q of open) {
    const answer = await promptForAnswer(q);
    if (answer === null) {
      console.log(chalk.yellow("Cancelled. Partial answers were saved."));
      break;
    }
    working = resolveClarification(working, q.questionId, answer, "user");
  }

  try {
    await saveSpec(projectRoot, working);
  } catch (err) {
    logger.error(
      `Failed to save updated spec: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
    return;
  }

  const remaining = getOpenClarifications(working);
  if (remaining.length === 0) {
    console.log(
      chalk.green.bold(
        `All clarifications resolved. Spec is now status: ${working.status}.`,
      ),
    );
  } else {
    console.log(
      chalk.yellow(
        `${remaining.length} question${remaining.length === 1 ? "" : "s"} still open.`,
      ),
    );
  }
}

async function promptForAnswer(
  q: ClarificationQuestion,
): Promise<string | null> {
  console.log();
  console.log(chalk.cyan(`${q.questionId} [${q.category}]`));
  console.log(q.question);
  if (q.recommendation) {
    console.log(chalk.gray(`💡 Suggested: ${q.recommendation}`));
  }

  if (q.options && q.options.length > 0) {
    const answer = await prompts({
      type: "select",
      name: "value",
      message: "Choose an option (or pick 'Other' to type your own):",
      choices: [
        ...q.options.map((opt) => ({
          title: `${opt.label}: ${opt.description}`,
          value: opt.label,
        })),
        { title: "Other (type your own)", value: "__other__" },
      ],
    });

    if (answer.value === undefined) return null;
    if (answer.value === "__other__") {
      const typed = await prompts({
        type: "text",
        name: "value",
        message: "Your answer:",
        validate: (v: string) => (v.trim().length > 0 ? true : "Required"),
      });
      return (typed.value as string | undefined) ?? null;
    }
    // Find the matching option to return its description as the recorded answer
    const matched = q.options.find((o) => o.label === answer.value);
    return matched ? `${matched.label}: ${matched.description}` : String(answer.value);
  }

  const typed = await prompts({
    type: "text",
    name: "value",
    message: "Your answer:",
    validate: (v: string) => (v.trim().length > 0 ? true : "Required"),
  });
  return (typed.value as string | undefined) ?? null;
}
