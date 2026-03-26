import { writeFile, readFile, appendFile } from "node:fs/promises";
import { join, basename } from "node:path";
import prompts from "prompts";
import chalk from "chalk";

import type { ProjectType, EvalStrategyType } from "../../config/schema.js";
import { createDefaultConfig } from "../../config/schema.js";
import { configExists } from "../../config/loader.js";
import { ensureBoberDir } from "../../state/index.js";
import { fileExists } from "../../utils/fs.js";
import { logger } from "../../utils/logger.js";

// ── Tech stack detection ───────────────────────────────────────────

interface DetectedStack {
  hasTypescript: boolean;
  hasReact: boolean;
  hasNext: boolean;
  hasVite: boolean;
  hasPlaywright: boolean;
  hasEslint: boolean;
  hasVitest: boolean;
  hasJest: boolean;
}

async function detectTechStack(projectRoot: string): Promise<DetectedStack> {
  const result: DetectedStack = {
    hasTypescript: false,
    hasReact: false,
    hasNext: false,
    hasVite: false,
    hasPlaywright: false,
    hasEslint: false,
    hasVitest: false,
    hasJest: false,
  };

  // Check tsconfig
  result.hasTypescript = await fileExists(join(projectRoot, "tsconfig.json"));

  // Check package.json deps
  const pkgPath = join(projectRoot, "package.json");
  if (await fileExists(pkgPath)) {
    try {
      const raw = await readFile(pkgPath, "utf-8");
      const pkg = JSON.parse(raw) as Record<string, unknown>;
      const allDeps = {
        ...(typeof pkg.dependencies === "object" && pkg.dependencies !== null
          ? (pkg.dependencies as Record<string, string>)
          : {}),
        ...(typeof pkg.devDependencies === "object" &&
        pkg.devDependencies !== null
          ? (pkg.devDependencies as Record<string, string>)
          : {}),
      };

      result.hasReact = "react" in allDeps;
      result.hasNext = "next" in allDeps;
      result.hasVite = "vite" in allDeps;
      result.hasPlaywright = "@playwright/test" in allDeps;
      result.hasEslint = "eslint" in allDeps;
      result.hasVitest = "vitest" in allDeps;
      result.hasJest = "jest" in allDeps;
    } catch {
      // Ignore parse errors
    }
  }

  return result;
}

function suggestProjectType(stack: DetectedStack): ProjectType {
  if (stack.hasReact || stack.hasNext || stack.hasVite) {
    return "react-fullstack";
  }
  if (stack.hasTypescript) {
    return "brownfield";
  }
  return "generic";
}

function suggestStrategies(stack: DetectedStack): EvalStrategyType[] {
  const strategies: EvalStrategyType[] = [];

  if (stack.hasTypescript) {
    strategies.push("typecheck");
  }
  if (stack.hasEslint) {
    strategies.push("lint");
  }
  if (stack.hasVitest || stack.hasJest) {
    strategies.push("unit-test");
  }
  if (stack.hasPlaywright) {
    strategies.push("playwright");
  }

  // Always suggest build for react-fullstack
  if (stack.hasReact || stack.hasNext || stack.hasVite) {
    if (!strategies.includes("typecheck")) {
      strategies.push("typecheck");
    }
    strategies.push("build");
  }

  if (strategies.length === 0) {
    strategies.push("build");
  }

  return strategies;
}

// ── Main ───────────────────────────────────────────────────────────

export async function runInitCommand(
  projectRoot: string,
): Promise<void> {
  logger.phase("Initialize Bober");

  // Check if already initialized
  if (await configExists(projectRoot)) {
    logger.warn("A bober.config.json already exists in this project.");
    const { overwrite } = await prompts({
      type: "confirm",
      name: "overwrite",
      message: "Overwrite existing configuration?",
      initial: false,
    });

    if (!overwrite) {
      logger.info("Init cancelled.");
      return;
    }
  }

  // Detect tech stack
  logger.info("Detecting project tech stack...");
  const stack = await detectTechStack(projectRoot);
  const suggestedType = suggestProjectType(stack);
  const suggestedStrategies = suggestStrategies(stack);

  const detections: string[] = [];
  if (stack.hasTypescript) detections.push("TypeScript");
  if (stack.hasReact) detections.push("React");
  if (stack.hasNext) detections.push("Next.js");
  if (stack.hasVite) detections.push("Vite");
  if (stack.hasEslint) detections.push("ESLint");
  if (stack.hasPlaywright) detections.push("Playwright");
  if (stack.hasVitest) detections.push("Vitest");
  if (stack.hasJest) detections.push("Jest");

  if (detections.length > 0) {
    logger.success(`Detected: ${detections.join(", ")}`);
  }

  // Interactive prompts
  const answers = await prompts([
    {
      type: "text",
      name: "name",
      message: "Project name:",
      initial: basename(projectRoot),
    },
    {
      type: "select",
      name: "type",
      message: "Project type:",
      choices: [
        {
          title: "React Fullstack",
          description: "React/Next.js/Vite fullstack app",
          value: "react-fullstack",
        },
        {
          title: "Brownfield",
          description: "Existing codebase with established patterns",
          value: "brownfield",
        },
        {
          title: "Generic",
          description: "General purpose project",
          value: "generic",
        },
      ],
      initial: ["react-fullstack", "brownfield", "generic"].indexOf(
        suggestedType,
      ),
    },
    {
      type: "multiselect",
      name: "strategies",
      message: "Evaluation strategies to enable:",
      choices: [
        {
          title: "TypeScript Check",
          value: "typecheck",
          selected: suggestedStrategies.includes("typecheck"),
        },
        {
          title: "Lint",
          value: "lint",
          selected: suggestedStrategies.includes("lint"),
        },
        {
          title: "Unit Tests",
          value: "unit-test",
          selected: suggestedStrategies.includes("unit-test"),
        },
        {
          title: "Build",
          value: "build",
          selected: suggestedStrategies.includes("build"),
        },
        {
          title: "Playwright E2E",
          value: "playwright",
          selected: suggestedStrategies.includes("playwright"),
        },
        {
          title: "API Check",
          value: "api-check",
          selected: false,
        },
      ],
      hint: "Space to toggle, Enter to confirm",
    },
    {
      type: "select",
      name: "plannerModel",
      message: "Planner model:",
      choices: [
        { title: "Opus (best quality)", value: "opus" },
        { title: "Sonnet (balanced)", value: "sonnet" },
        { title: "Haiku (fastest)", value: "haiku" },
      ],
      initial: 0,
    },
    {
      type: "select",
      name: "generatorModel",
      message: "Generator model:",
      choices: [
        { title: "Sonnet (recommended)", value: "sonnet" },
        { title: "Opus (higher quality)", value: "opus" },
        { title: "Haiku (faster)", value: "haiku" },
      ],
      initial: 0,
    },
  ]);

  // User cancelled
  if (!answers.name || !answers.type) {
    logger.info("Init cancelled.");
    return;
  }

  // Build config
  const strategies = (answers.strategies as EvalStrategyType[]).map(
    (type: EvalStrategyType) => ({
      type,
      required: type === "typecheck" || type === "build",
    }),
  );

  const config = createDefaultConfig(
    answers.name as string,
    answers.type as ProjectType,
    {
      planner: {
        maxClarifications: 5,
        model: answers.plannerModel as "opus" | "sonnet" | "haiku",
      },
      generator: {
        model: answers.generatorModel as "sonnet" | "opus" | "haiku",
        maxTurnsPerSprint: 50,
        autoCommit: true,
        branchPattern: "bober/{feature-name}",
      },
      evaluator: {
        model: "sonnet",
        strategies,
        maxIterations: 3,
      },
    },
  );

  // Write config
  const configPath = join(projectRoot, "bober.config.json");
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  logger.success(`Created ${configPath}`);

  // Create .bober/ directory structure
  await ensureBoberDir(projectRoot);
  logger.success("Created .bober/ directory");

  // Add .bober/ to .gitignore if it exists
  const gitignorePath = join(projectRoot, ".gitignore");
  if (await fileExists(gitignorePath)) {
    const content = await readFile(gitignorePath, "utf-8");
    if (!content.includes(".bober/")) {
      await appendFile(gitignorePath, "\n# Bober agent state\n.bober/\n");
      logger.success("Added .bober/ to .gitignore");
    }
  } else {
    await writeFile(
      gitignorePath,
      "# Bober agent state\n.bober/\n",
      "utf-8",
    );
    logger.success("Created .gitignore with .bober/");
  }

  // Print summary
  console.log();
  console.log(chalk.bold("Setup complete!"));
  console.log();
  console.log(`  Project:     ${chalk.cyan(config.project.name)}`);
  console.log(`  Type:        ${chalk.cyan(config.project.type)}`);
  console.log(`  Planner:     ${chalk.cyan(config.planner.model)}`);
  console.log(`  Generator:   ${chalk.cyan(config.generator.model)}`);
  console.log(
    `  Strategies:  ${chalk.cyan(strategies.map((s) => s.type).join(", "))}`,
  );
  console.log();
  console.log("Next steps:");
  console.log(`  ${chalk.gray("$")} ${chalk.green("npx agent-bober run")} ${chalk.gray('"build a todo app"')}`);
  console.log(`  ${chalk.gray("$")} ${chalk.green("npx agent-bober plan")} ${chalk.gray('"add user authentication"')}`);
  console.log();
}
