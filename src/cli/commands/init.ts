import { writeFile, readFile, appendFile, readdir } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import prompts from "prompts";
import chalk from "chalk";

import type { EvalStrategyType, ProjectMode } from "../../config/schema.js";
import { createDefaultConfig } from "../../config/schema.js";
import { configExists } from "../../config/loader.js";
import { getDefaults, getPresetNames } from "../../config/defaults.js";
import { ensureBoberDir } from "../../state/index.js";
import { fileExists, ensureDir } from "../../utils/fs.js";
import { logger } from "../../utils/logger.js";

// ── Preset metadata ──────────────────────────────────────────────

interface PresetInfo {
  name: string;
  label: string;
  description: string;
}

const PRESET_INFO: PresetInfo[] = [
  { name: "nextjs", label: "nextjs", description: "Next.js full-stack app" },
  {
    name: "react-vite",
    label: "react-vite",
    description: "React + Vite + any backend",
  },
  {
    name: "solidity",
    label: "solidity",
    description: "EVM smart contracts (Hardhat/Foundry)",
  },
  {
    name: "anchor",
    label: "anchor",
    description: "Solana programs (Anchor/Rust)",
  },
  {
    name: "api-node",
    label: "api-node",
    description: "Node.js API (Express/NestJS/Fastify)",
  },
  {
    name: "python-api",
    label: "python-api",
    description: "Python API (FastAPI/Django)",
  },
];

// ── Tech stack detection ─────────────────────────────────────────

interface DetectedStack {
  hasTypescript: boolean;
  hasReact: boolean;
  hasNext: boolean;
  hasVite: boolean;
  hasPlaywright: boolean;
  hasEslint: boolean;
  hasVitest: boolean;
  hasJest: boolean;
  hasHardhat: boolean;
  hasFoundry: boolean;
  hasAnchor: boolean;
  hasPython: boolean;
  hasRust: boolean;
  hasNestjs: boolean;
  hasFastify: boolean;
  hasExpress: boolean;
  packageManager: "npm" | "yarn" | "pnpm" | "bun" | null;
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
    hasHardhat: false,
    hasFoundry: false,
    hasAnchor: false,
    hasPython: false,
    hasRust: false,
    hasNestjs: false,
    hasFastify: false,
    hasExpress: false,
    packageManager: null,
  };

  // Check tsconfig
  result.hasTypescript = await fileExists(join(projectRoot, "tsconfig.json"));

  // Check Hardhat
  result.hasHardhat =
    (await fileExists(join(projectRoot, "hardhat.config.ts"))) ||
    (await fileExists(join(projectRoot, "hardhat.config.js")));

  // Check Foundry
  result.hasFoundry = await fileExists(join(projectRoot, "foundry.toml"));

  // Check Anchor / Solana
  result.hasAnchor = await fileExists(join(projectRoot, "Anchor.toml"));

  // Check Python
  result.hasPython =
    (await fileExists(join(projectRoot, "pyproject.toml"))) ||
    (await fileExists(join(projectRoot, "requirements.txt"))) ||
    (await fileExists(join(projectRoot, "Pipfile")));

  // Check Rust
  result.hasRust = await fileExists(join(projectRoot, "Cargo.toml"));

  // Check Next.js config files
  const nextConfigs = [
    "next.config.js",
    "next.config.ts",
    "next.config.mjs",
  ];
  for (const cfg of nextConfigs) {
    if (await fileExists(join(projectRoot, cfg))) {
      result.hasNext = true;
      break;
    }
  }

  // Detect package manager
  if (await fileExists(join(projectRoot, "bun.lockb"))) {
    result.packageManager = "bun";
  } else if (await fileExists(join(projectRoot, "pnpm-lock.yaml"))) {
    result.packageManager = "pnpm";
  } else if (await fileExists(join(projectRoot, "yarn.lock"))) {
    result.packageManager = "yarn";
  } else if (await fileExists(join(projectRoot, "package-lock.json"))) {
    result.packageManager = "npm";
  }

  // Check package.json deps
  const pkgPath = join(projectRoot, "package.json");
  if (await fileExists(pkgPath)) {
    // Default to npm if no lockfile detected but package.json exists
    if (!result.packageManager) {
      result.packageManager = "npm";
    }

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
      if (!result.hasNext) {
        result.hasNext = "next" in allDeps;
      }
      result.hasVite = "vite" in allDeps;
      result.hasPlaywright = "@playwright/test" in allDeps;
      result.hasEslint = "eslint" in allDeps;
      result.hasVitest = "vitest" in allDeps;
      result.hasJest = "jest" in allDeps;
      result.hasNestjs = "@nestjs/core" in allDeps;
      result.hasFastify = "fastify" in allDeps;
      result.hasExpress = "express" in allDeps;
    } catch {
      // Ignore parse errors
    }
  }

  return result;
}

function formatDetections(stack: DetectedStack): string[] {
  const detections: string[] = [];
  if (stack.hasTypescript) detections.push("TypeScript");
  if (stack.hasReact) detections.push("React");
  if (stack.hasNext) detections.push("Next.js");
  if (stack.hasVite) detections.push("Vite");
  if (stack.hasEslint) detections.push("ESLint");
  if (stack.hasPlaywright) detections.push("Playwright");
  if (stack.hasVitest) detections.push("Vitest");
  if (stack.hasJest) detections.push("Jest");
  if (stack.hasHardhat) detections.push("Hardhat");
  if (stack.hasFoundry) detections.push("Foundry");
  if (stack.hasAnchor) detections.push("Anchor");
  if (stack.hasPython) detections.push("Python");
  if (stack.hasRust) detections.push("Rust");
  if (stack.hasNestjs) detections.push("NestJS");
  if (stack.hasFastify) detections.push("Fastify");
  if (stack.hasExpress) detections.push("Express");
  if (stack.packageManager) {
    detections.push(`pkg manager: ${stack.packageManager}`);
  }
  return detections;
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

  // Always suggest build for frontend frameworks
  if (stack.hasReact || stack.hasNext || stack.hasVite) {
    if (!strategies.includes("typecheck")) {
      strategies.push("typecheck");
    }
    strategies.push("build");
  }

  // Suggest build for smart contracts
  if (stack.hasHardhat || stack.hasFoundry || stack.hasAnchor) {
    strategies.push("build");
  }

  // Suggest api-check for API frameworks
  if (stack.hasNestjs || stack.hasFastify || stack.hasExpress) {
    strategies.push("api-check");
  }

  if (strategies.length === 0) {
    strategies.push("build");
  }

  return strategies;
}

// ── Main ─────────────────────────────────────────────────────────

export interface InitCommandOptions {
  preset?: string;
}

export async function runInitCommand(
  projectRoot: string,
  options: InitCommandOptions = {},
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

  // Resolve preset from CLI shortcut
  const cliPreset = options.preset;
  const knownPresets = getPresetNames();

  // If a preset was passed directly (e.g. `agent-bober init --preset nextjs`),
  // validate it and jump to greenfield preset flow.
  if (cliPreset && cliPreset !== "brownfield") {
    if (!knownPresets.includes(cliPreset)) {
      logger.error(
        `Unknown preset "${cliPreset}". Available presets: ${knownPresets.join(", ")}`,
      );
      return;
    }
    await greenfieldFlow(projectRoot, cliPreset);
    return;
  }

  // If the positional arg is "brownfield", jump straight there.
  if (cliPreset === "brownfield") {
    await brownfieldFlow(projectRoot);
    return;
  }

  // ── Step 1: Ask greenfield or brownfield ──────────────────────

  const { projectKind } = await prompts({
    type: "select",
    name: "projectKind",
    message: "Are you starting a new project or working with existing code?",
    choices: [
      {
        title: "New project (greenfield)",
        description: "Start from scratch with optional preset",
        value: "greenfield",
      },
      {
        title: "Existing codebase (brownfield)",
        description: "Auto-detect stack and use conservative settings",
        value: "brownfield",
      },
    ],
    initial: 0,
  });

  if (!projectKind) {
    logger.info("Init cancelled.");
    return;
  }

  if (projectKind === "brownfield") {
    await brownfieldFlow(projectRoot);
  } else {
    await greenfieldFlow(projectRoot);
  }
}

// ── Brownfield flow ──────────────────────────────────────────────

async function brownfieldFlow(projectRoot: string): Promise<void> {
  logger.info("Detecting project tech stack...");
  const stack = await detectTechStack(projectRoot);
  const detections = formatDetections(stack);

  if (detections.length > 0) {
    logger.success(`Detected: ${detections.join(", ")}`);
  } else {
    logger.info("No specific tech stack detected.");
  }

  const suggestedStrats = suggestStrategies(stack);

  // Ask project name first
  const nameAnswer = await prompts({
    type: "text",
    name: "name",
    message: `Project name: (default: ${basename(projectRoot)})`,
  });

  const projectName = (nameAnswer.name as string | undefined)?.trim() || basename(projectRoot);
  if (!projectName) {
    logger.info("Init cancelled.");
    return;
  }

  // Ask model preferences
  const modelAnswers = await prompts([
    {
      type: "select",
      name: "plannerModel",
      message: "Planner model:",
      choices: [
        { title: "Opus (best quality)", value: "opus" },
        { title: "Sonnet (balanced)", value: "sonnet" },
      ],
      initial: 0,
    },
    {
      type: "select",
      name: "generatorModel",
      message: "Generator model:",
      choices: [
        { title: "Opus (best quality)", value: "opus" },
        { title: "Sonnet (recommended)", value: "sonnet" },
        { title: "Haiku (faster, cheaper)", value: "haiku" },
      ],
      initial: 1,
    },
  ]);

  // Ask strategies separately so multiselect works properly
  console.log(chalk.gray("\n  ↑↓ Navigate  ⎵ Space = toggle  ⏎ Enter = confirm\n"));
  const stratAnswer = await prompts({
    type: "multiselect",
    name: "strategies",
    message: "Evaluation strategies:",
    choices: buildStrategyChoices(suggestedStrats),
    instructions: false,
  });

  const answers = { ...modelAnswers, ...stratAnswer };

  const mode: ProjectMode = "brownfield";
  const strategies = (answers.strategies as EvalStrategyType[]).map(
    (type: EvalStrategyType) => ({
      type,
      required: type === "typecheck" || type === "build" || type === "lint",
    }),
  );

  const defaults = getDefaults(mode);
  const config = createDefaultConfig(projectName, mode, undefined, {
    planner: {
      ...(defaults.planner ?? { maxClarifications: 5, model: "opus" }),
      model: answers.plannerModel as "opus" | "sonnet" | "haiku",
    },
    generator: {
      ...(defaults.generator ?? {
        model: "sonnet",
        maxTurnsPerSprint: 50,
        autoCommit: true,
        branchPattern: "bober/{feature-name}",
      }),
      model: answers.generatorModel as "sonnet" | "opus" | "haiku",
    },
    evaluator: {
      model: "sonnet",
      strategies,
      maxIterations: defaults.evaluator?.maxIterations ?? 3,
    },
  });

  await writeConfig(projectRoot, config, mode, strategies);
}

// ── Greenfield flow ──────────────────────────────────────────────

async function greenfieldFlow(
  projectRoot: string,
  preselectedPreset?: string,
): Promise<void> {
  let selectedPreset = preselectedPreset;
  let description: string | undefined;

  // Ask what they are building (skip if preset was pre-selected via CLI)
  if (!selectedPreset) {
    const { desc } = await prompts({
      type: "text",
      name: "desc",
      message: "What are you building? (stored as project description)",
      initial: "",
    });

    if (desc === undefined) {
      logger.info("Init cancelled.");
      return;
    }
    description = (desc as string) || undefined;

    // Show preset choices
    const presetChoices = PRESET_INFO.map((p, i) => ({
      title: `${String.fromCharCode(65 + i)}) ${p.label}`,
      description: p.description,
      value: p.name,
    }));
    presetChoices.push({
      title: `${String.fromCharCode(65 + PRESET_INFO.length)}) skip`,
      description: "No preset, the planner will decide the stack",
      value: "skip",
    });

    console.log();
    console.log(chalk.bold("Available presets (optional):"));

    const { preset } = await prompts({
      type: "select",
      name: "preset",
      message: "Choose a preset:",
      choices: presetChoices,
      initial: presetChoices.length - 1,
    });

    if (preset === undefined) {
      logger.info("Init cancelled.");
      return;
    }

    selectedPreset = preset === "skip" ? undefined : (preset as string);
  }

  // Load preset defaults for strategies display
  const mode: ProjectMode = "greenfield";
  const defaults = getDefaults(mode, selectedPreset);
  const defaultStrats =
    defaults.evaluator?.strategies?.map((s) => s.type) ?? [];

  // Ask project name first
  const nameAnswer = await prompts({
    type: "text",
    name: "name",
    message: `Project name: (default: ${basename(projectRoot)})`,
  });

  const projectName = (nameAnswer.name as string | undefined)?.trim() || basename(projectRoot);
  if (!projectName) {
    logger.info("Init cancelled.");
    return;
  }

  // Ask model preferences
  const modelAnswers = await prompts([
    {
      type: "select",
      name: "plannerModel",
      message: "Planner model:",
      choices: [
        { title: "Opus (best quality)", value: "opus" },
        { title: "Sonnet (balanced)", value: "sonnet" },
      ],
      initial: 0,
    },
    {
      type: "select",
      name: "generatorModel",
      message: "Generator model:",
      choices: [
        { title: "Opus (best quality)", value: "opus" },
        { title: "Sonnet (recommended)", value: "sonnet" },
        { title: "Haiku (faster, cheaper)", value: "haiku" },
      ],
      initial: 1,
    },
  ]);

  // Ask strategies separately so multiselect works properly
  const stratAnswer = await prompts({
    type: "multiselect",
    name: "strategies",
    message: "Evaluation strategies (Space to toggle, Enter when done):",
    choices: buildStrategyChoices(defaultStrats),
    instructions: false,
    hint: "Use arrow keys to move, Space to select/deselect, Enter to confirm",
  });

  const answers = { ...modelAnswers, ...stratAnswer };

  const strategies = (answers.strategies as EvalStrategyType[]).map(
    (type: EvalStrategyType) => ({
      type,
      required: type === "typecheck" || type === "build",
    }),
  );

  const config = createDefaultConfig(
    projectName,
    mode,
    selectedPreset,
    {
      planner: {
        ...(defaults.planner ?? { maxClarifications: 5, model: "opus" }),
        model: answers.plannerModel as "opus" | "sonnet" | "haiku",
      },
      generator: {
        ...(defaults.generator ?? {
          model: "sonnet",
          maxTurnsPerSprint: 50,
          autoCommit: true,
          branchPattern: "bober/{feature-name}",
        }),
        model: answers.generatorModel as "sonnet" | "opus" | "haiku",
      },
      evaluator: {
        model: "sonnet",
        strategies,
        maxIterations: defaults.evaluator?.maxIterations ?? 3,
      },
    },
  );

  // Attach description if provided
  if (description) {
    config.project.description = description;
  }

  await writeConfig(projectRoot, config, mode, strategies, selectedPreset);
}

// ── Shared helpers ───────────────────────────────────────────────

function buildStrategyChoices(
  suggestedStrats: EvalStrategyType[],
): Array<{ title: string; value: EvalStrategyType; selected: boolean }> {
  const suggested = new Set(suggestedStrats);
  return [
    {
      title: `TypeScript Check${suggested.has("typecheck") ? " (recommended)" : ""}`,
      value: "typecheck" as EvalStrategyType,
      selected: suggested.has("typecheck"),
    },
    {
      title: `Lint${suggested.has("lint") ? " (recommended)" : ""}`,
      value: "lint" as EvalStrategyType,
      selected: suggested.has("lint"),
    },
    {
      title: `Unit Tests${suggested.has("unit-test") ? " (recommended)" : ""}`,
      value: "unit-test" as EvalStrategyType,
      selected: suggested.has("unit-test"),
    },
    {
      title: `Build${suggested.has("build") ? " (recommended)" : ""}`,
      value: "build" as EvalStrategyType,
      selected: suggested.has("build"),
    },
    {
      title: `Playwright E2E${suggested.has("playwright") ? " (recommended)" : ""}`,
      value: "playwright" as EvalStrategyType,
      selected: suggested.has("playwright"),
    },
    {
      title: `API Check${suggested.has("api-check") ? " (recommended)" : ""}`,
      value: "api-check" as EvalStrategyType,
      selected: suggestedStrats.includes("api-check"),
    },
  ];
}

// ── Install Claude Code slash commands ───────────────────────────

/**
 * Copy SKILL.md files from the package's skills/ directory into
 * the project's .claude/commands/ directory so they appear as
 * /bober-plan, /bober-sprint, etc. in Claude Code.
 *
 * Also copies agent definitions into .claude/agents/.
 */
async function installClaudeCommands(projectRoot: string): Promise<void> {
  const __filename = fileURLToPath(import.meta.url);
  // From dist/cli/commands/init.js → go up to package root
  const packageRoot = join(dirname(__filename), "..", "..", "..");

  const commandsDir = join(projectRoot, ".claude", "commands");
  await ensureDir(commandsDir);

  // Map skill directories to command file names
  const skillMap: Record<string, string> = {
    "bober.plan": "bober-plan.md",
    "bober.sprint": "bober-sprint.md",
    "bober.eval": "bober-eval.md",
    "bober.run": "bober-run.md",
    "bober.react": "bober-react.md",
    "bober.brownfield": "bober-brownfield.md",
    "bober.solidity": "bober-solidity.md",
    "bober.anchor": "bober-anchor.md",
  };

  const skillsRoot = join(packageRoot, "skills");
  let installed = 0;

  for (const [skillDir, cmdFile] of Object.entries(skillMap)) {
    const srcSkill = join(skillsRoot, skillDir, "SKILL.md");
    const destCmd = join(commandsDir, cmdFile);
    if (await fileExists(srcSkill)) {
      const content = await readFile(srcSkill, "utf-8");

      // Also append reference docs inline if they exist
      const refsDir = join(skillsRoot, skillDir, "references");
      let refs = "";
      try {
        const refFiles = await readdir(refsDir);
        for (const refFile of refFiles) {
          if (refFile.endsWith(".md")) {
            const refContent = await readFile(join(refsDir, refFile), "utf-8");
            refs += `\n\n---\n\n<!-- Reference: ${refFile} -->\n\n${refContent}`;
          }
        }
      } catch {
        // No references directory — that's fine
      }

      await writeFile(destCmd, content + refs, "utf-8");
      installed++;
    }
  }

  // Copy agent definitions
  const agentsDir = join(projectRoot, ".claude", "agents");
  await ensureDir(agentsDir);

  const agentFiles = ["bober-planner.md", "bober-generator.md", "bober-evaluator.md"];
  const agentsSrc = join(packageRoot, "agents");

  for (const agentFile of agentFiles) {
    const src = join(agentsSrc, agentFile);
    const dest = join(agentsDir, agentFile);
    if (await fileExists(src)) {
      const content = await readFile(src, "utf-8");
      await writeFile(dest, content, "utf-8");
    }
  }

  if (installed > 0) {
    logger.success(
      `Installed ${installed} slash commands in .claude/commands/`,
    );
    logger.success(`Installed agent definitions in .claude/agents/`);
  }
}

interface ConfigShape {
  project: {
    name: string;
    mode: string;
    preset?: string;
    description?: string;
  };
  planner: { model: string };
  generator: { model: string };
  evaluator: { strategies: Array<{ type: string }> };
}

async function writeConfig(
  projectRoot: string,
  config: ConfigShape,
  mode: ProjectMode,
  strategies: Array<{ type: string; required: boolean }>,
  preset?: string,
): Promise<void> {
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

  // Install Claude Code slash commands into .claude/commands/
  await installClaudeCommands(projectRoot);

  // Print summary
  console.log();
  console.log(chalk.bold("Setup complete!"));
  console.log();
  console.log(`  Project:     ${chalk.cyan(config.project.name)}`);
  console.log(`  Mode:        ${chalk.cyan(mode)}`);
  if (preset) {
    console.log(`  Preset:      ${chalk.cyan(preset)}`);
  }
  console.log(`  Planner:     ${chalk.cyan(config.planner.model)}`);
  console.log(`  Generator:   ${chalk.cyan(config.generator.model)}`);
  console.log(
    `  Strategies:  ${chalk.cyan(strategies.map((s) => s.type).join(", "))}`,
  );
  console.log();
  console.log("Next steps:");
  console.log(`  ${chalk.gray("$")} ${chalk.green("claude")}                    ${chalk.gray("# Open Claude Code in this dir")}`);
  console.log(`  ${chalk.green("/bober-plan")}                  ${chalk.gray("# Describe your feature")}`);
  console.log(`  ${chalk.green("/bober-run")}                   ${chalk.gray("# Full autonomous pipeline")}`);
  console.log();
  console.log(`  ${chalk.gray("Or via CLI:")} ${chalk.green("npx agent-bober plan")} ${chalk.gray('"your feature"')}`);
  console.log();
}
