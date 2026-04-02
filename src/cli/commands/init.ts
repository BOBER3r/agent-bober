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
import { scanProject } from "../../discovery/scanner.js";
import { generateEvalConfig } from "../../discovery/config-generator.js";
import { synthesizePrinciples } from "../../discovery/synthesizer.js";

// ── Provider types ────────────────────────────────────────────────

type SupportedProvider = "anthropic" | "openai" | "google" | "openai-compat";

interface ProviderModelOptions {
  planner: Array<{ title: string; value: string }>;
  generator: Array<{ title: string; value: string }>;
  defaultPlanner: number;
  defaultGenerator: number;
}

function getProviderModelOptions(provider: SupportedProvider): ProviderModelOptions {
  switch (provider) {
    case "openai":
      return {
        planner: [
          { title: "GPT-4.1 (best quality)", value: "gpt-4.1" },
          { title: "o3 (reasoning)", value: "o3" },
          { title: "o4-mini (fast reasoning)", value: "o4-mini" },
          { title: "GPT-4.1-mini (faster, cheaper)", value: "gpt-4.1-mini" },
        ],
        generator: [
          { title: "GPT-4.1 (best quality)", value: "gpt-4.1" },
          { title: "GPT-4.1-mini (recommended)", value: "gpt-4.1-mini" },
          { title: "o4-mini (fast reasoning)", value: "o4-mini" },
          { title: "o3 (reasoning)", value: "o3" },
        ],
        defaultPlanner: 0,
        defaultGenerator: 1,
      };
    case "google":
      return {
        planner: [
          { title: "Gemini Pro (best quality)", value: "gemini-pro" },
          { title: "Gemini Flash (faster, cheaper)", value: "gemini-flash" },
        ],
        generator: [
          { title: "Gemini Pro (best quality)", value: "gemini-pro" },
          { title: "Gemini Flash (recommended)", value: "gemini-flash" },
        ],
        defaultPlanner: 0,
        defaultGenerator: 1,
      };
    case "openai-compat":
      return {
        // Free-form text input — no preset list
        planner: [],
        generator: [],
        defaultPlanner: 0,
        defaultGenerator: 0,
      };
    case "anthropic":
    default:
      return {
        planner: [
          { title: "Opus (best quality)", value: "opus" },
          { title: "Sonnet (balanced)", value: "sonnet" },
        ],
        generator: [
          { title: "Opus (best quality)", value: "opus" },
          { title: "Sonnet (recommended)", value: "sonnet" },
          { title: "Haiku (faster, cheaper)", value: "haiku" },
        ],
        defaultPlanner: 0,
        defaultGenerator: 1,
      };
  }
}

/**
 * Ask provider-appropriate model questions.
 *
 * For openai-compat the user types a free-form model name.
 * For all other providers, a select list is shown.
 */
async function askModelPreferences(
  provider: SupportedProvider,
): Promise<{ plannerModel: string; generatorModel: string }> {
  const opts = getProviderModelOptions(provider);

  if (provider === "openai-compat") {
    const answers = await prompts([
      {
        type: "text",
        name: "plannerModel",
        message: "Planner model (e.g. llama3, mistral):",
        initial: "llama3",
        validate: (v: string) => v.trim().length > 0 || "Model name is required",
      },
      {
        type: "text",
        name: "generatorModel",
        message: "Generator model (e.g. llama3, mistral):",
        initial: "llama3",
        validate: (v: string) => v.trim().length > 0 || "Model name is required",
      },
    ]);
    return {
      plannerModel: (answers.plannerModel as string | undefined) ?? "llama3",
      generatorModel: (answers.generatorModel as string | undefined) ?? "llama3",
    };
  }

  const answers = await prompts([
    {
      type: "select",
      name: "plannerModel",
      message: "Planner model:",
      choices: opts.planner,
      initial: opts.defaultPlanner,
    },
    {
      type: "select",
      name: "generatorModel",
      message: "Generator model:",
      choices: opts.generator,
      initial: opts.defaultGenerator,
    },
  ]);

  return {
    plannerModel: (answers.plannerModel as string | undefined) ?? opts.planner[opts.defaultPlanner]?.value ?? "sonnet",
    generatorModel: (answers.generatorModel as string | undefined) ?? opts.generator[opts.defaultGenerator]?.value ?? "sonnet",
  };
}

/**
 * Ask the user which AI provider they want to use.
 * Returns null if the user cancels.
 */
async function askProvider(): Promise<SupportedProvider | null> {
  const { provider } = await prompts({
    type: "select",
    name: "provider",
    message: "Which AI provider?",
    choices: [
      {
        title: "Anthropic (Claude)",
        description: "Opus, Sonnet, Haiku — requires ANTHROPIC_API_KEY",
        value: "anthropic",
      },
      {
        title: "OpenAI",
        description: "GPT-4.1, o3, o4-mini — requires OPENAI_API_KEY",
        value: "openai",
      },
      {
        title: "Google Gemini",
        description: "Gemini Pro, Flash — requires GOOGLE_API_KEY or GEMINI_API_KEY",
        value: "google",
      },
      {
        title: "OpenAI-Compatible / Ollama",
        description: "Any OpenAI-compatible server (Ollama, vLLM, etc.) — no API key needed",
        value: "openai-compat",
      },
    ],
    initial: 0,
  });

  if (provider === undefined) return null;
  return provider as SupportedProvider;
}

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
  // ── Step 1: Deep scan ──────────────────────────────────────────
  process.stdout.write(chalk.cyan("  Analyzing codebase..."));
  const report = await scanProject(projectRoot);
  process.stdout.write(" " + chalk.green("done\n"));

  const evalConfig = generateEvalConfig(report);
  const stack = report.detectedStack;
  const pm = report.packageManager;
  const git = report.gitConventions;
  const tests = report.testConventions;

  // ── Step 2: Display discovery summary ─────────────────────────
  console.log();
  console.log(chalk.bold("Discovery results:"));
  console.log();

  // Stack
  const stackItems: string[] = [];
  if (stack) {
    if (stack.hasTypescript) stackItems.push("TypeScript");
    if (stack.hasReact) stackItems.push("React");
    if (stack.hasNext) stackItems.push("Next.js");
    if (stack.hasVite) stackItems.push("Vite");
    if (stack.hasEslint) stackItems.push("ESLint");
    if (stack.hasPlaywright) stackItems.push("Playwright");
    if (stack.hasVitest) stackItems.push("Vitest");
    if (stack.hasJest) stackItems.push("Jest");
    if (stack.hasNestjs) stackItems.push("NestJS");
    if (stack.hasFastify) stackItems.push("Fastify");
    if (stack.hasExpress) stackItems.push("Express");
    if (stack.hasPython) stackItems.push("Python");
    if (stack.hasRust) stackItems.push("Rust");
  }
  console.log(
    `  ${chalk.bold("Stack:")}          ${stackItems.length > 0 ? chalk.cyan(stackItems.join(", ")) : chalk.gray("(not detected)")}`,
  );

  // Package manager
  console.log(
    `  ${chalk.bold("Package manager:")} ${pm ? chalk.cyan(pm) : chalk.gray("(not detected)")}`,
  );

  // Git conventions
  if (git) {
    const commitStyle = git.usesConventionalCommits
      ? "conventional commits"
      : git.mostCommonPrefix
        ? `prefix: "${git.mostCommonPrefix}"`
        : "no consistent pattern";
    console.log(`  ${chalk.bold("Git commits:")}    ${chalk.cyan(commitStyle)}`);
    if (git.branchPatterns.length > 0) {
      console.log(`  ${chalk.bold("Branch pattern:")} ${chalk.cyan(git.branchPatterns[0])}`);
    }
  }

  // Test framework
  if (tests) {
    console.log(
      `  ${chalk.bold("Test framework:")} ${chalk.cyan(tests.framework)} (${tests.testFileCount} test files)`,
    );
  }

  // Commands
  console.log();
  console.log(chalk.bold("Auto-configured commands:"));
  const cmds = evalConfig.commands;
  if (cmds.install) console.log(`  install:   ${chalk.cyan(cmds.install)}`);
  if (cmds.build) console.log(`  build:     ${chalk.cyan(cmds.build)}`);
  if (cmds.test) console.log(`  test:      ${chalk.cyan(cmds.test)}`);
  if (cmds.lint) console.log(`  lint:      ${chalk.cyan(cmds.lint)}`);
  if (cmds.typecheck) console.log(`  typecheck: ${chalk.cyan(cmds.typecheck)}`);

  // Strategies
  console.log();
  console.log(chalk.bold("Auto-configured strategies:"));
  for (const strat of evalConfig.strategies) {
    const req = strat.required ? chalk.red(" (required)") : chalk.gray(" (optional)");
    const cmd = strat.command ? chalk.gray(` → ${strat.command}`) : "";
    console.log(`  - ${chalk.cyan(strat.type)}${req}${cmd}`);
  }

  // ── Step 3: Confirmation ───────────────────────────────────────
  console.log();
  const { confirmed } = await prompts({
    type: "confirm",
    name: "confirmed",
    message: "Look good?",
    initial: true,
  });

  if (!confirmed) {
    logger.info("Falling back to manual configuration...");
    await brownfieldManualFlow(projectRoot);
    return;
  }

  // ── Step 4: Project name ───────────────────────────────────────
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

  // ── Step 5: Provider + model selection ────────────────────────
  const provider = await askProvider();
  if (provider === null) {
    logger.info("Init cancelled.");
    return;
  }

  const { plannerModel, generatorModel } = await askModelPreferences(provider);

  // ── Step 6: Build config using discovered strategies/commands ─
  const mode: ProjectMode = "brownfield";
  const defaults = getDefaults(mode);

  const config = createDefaultConfig(projectName, mode, undefined, {
    planner: {
      ...(defaults.planner ?? { maxClarifications: 5, model: "opus" }),
      model: plannerModel,
      provider,
    },
    generator: {
      ...(defaults.generator ?? {
        model: "sonnet",
        maxTurnsPerSprint: 50,
        autoCommit: true,
        branchPattern: "bober/{feature-name}",
      }),
      model: generatorModel,
      provider,
    },
    evaluator: {
      model: generatorModel,
      strategies: evalConfig.strategies,
      maxIterations: defaults.evaluator?.maxIterations ?? 3,
      provider,
    },
    commands: evalConfig.commands,
  });

  // Write bober.config.json first (synthesizePrinciples needs a BoberConfig)
  await writeConfig(projectRoot, config, mode, evalConfig.strategies, undefined, provider);

  // ── Step 7: Synthesize principles ─────────────────────────────
  console.log();
  process.stdout.write(chalk.cyan("  Synthesizing project principles..."));
  let principles: string | null = null;
  try {
    principles = await synthesizePrinciples(report, projectRoot, config);
    process.stdout.write(" " + chalk.green("done\n"));
  } catch (err) {
    process.stdout.write(" " + chalk.yellow("skipped (LLM unavailable)\n"));
    logger.warn(
      `Could not synthesize principles: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (principles) {
    const principlesPath = join(projectRoot, ".bober", "principles.md");
    await writeFile(principlesPath, principles, "utf-8");
    logger.success(`Generated .bober/principles.md`);

    // Show a brief preview
    const lines = principles.split("\n").slice(0, 10);
    console.log();
    console.log(chalk.bold("Principles preview:"));
    console.log(chalk.gray(lines.join("\n")));
    if (principles.split("\n").length > 10) {
      console.log(chalk.gray("  ... (see .bober/principles.md for full document)"));
    }
    console.log();
  }
}

// ── Brownfield manual fallback flow ──────────────────────────────

async function brownfieldManualFlow(projectRoot: string): Promise<void> {
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

  // Ask provider selection
  const provider = await askProvider();
  if (provider === null) {
    logger.info("Init cancelled.");
    return;
  }

  // Ask model preferences (conditional on provider)
  const { plannerModel, generatorModel } = await askModelPreferences(provider);

  // Ask strategies separately so multiselect works properly
  console.log(chalk.gray("\n  ↑↓ Navigate  ⎵ Space = toggle  ⏎ Enter = confirm\n"));
  const stratAnswer = await prompts({
    type: "multiselect",
    name: "strategies",
    message: "Evaluation strategies:",
    choices: buildStrategyChoices(suggestedStrats),
    instructions: false,
  });

  const mode: ProjectMode = "brownfield";
  const strategies = (stratAnswer.strategies as EvalStrategyType[]).map(
    (type: EvalStrategyType) => ({
      type,
      required: type === "typecheck" || type === "build" || type === "lint",
    }),
  );

  const defaults = getDefaults(mode);
  const config = createDefaultConfig(projectName, mode, undefined, {
    planner: {
      ...(defaults.planner ?? { maxClarifications: 5, model: "opus" }),
      model: plannerModel,
      provider,
    },
    generator: {
      ...(defaults.generator ?? {
        model: "sonnet",
        maxTurnsPerSprint: 50,
        autoCommit: true,
        branchPattern: "bober/{feature-name}",
      }),
      model: generatorModel,
      provider,
    },
    evaluator: {
      model: generatorModel,
      strategies,
      maxIterations: defaults.evaluator?.maxIterations ?? 3,
      provider,
    },
  });

  await writeConfig(projectRoot, config, mode, strategies, undefined, provider);
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

  // Ask provider selection
  const provider = await askProvider();
  if (provider === null) {
    logger.info("Init cancelled.");
    return;
  }

  // Ask model preferences (conditional on provider)
  const { plannerModel, generatorModel } = await askModelPreferences(provider);

  // Ask strategies separately so multiselect works properly
  const stratAnswer = await prompts({
    type: "multiselect",
    name: "strategies",
    message: "Evaluation strategies (Space to toggle, Enter when done):",
    choices: buildStrategyChoices(defaultStrats),
    instructions: false,
    hint: "Use arrow keys to move, Space to select/deselect, Enter to confirm",
  });

  const strategies = (stratAnswer.strategies as EvalStrategyType[]).map(
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
        model: plannerModel,
        provider,
      },
      generator: {
        ...(defaults.generator ?? {
          model: "sonnet",
          maxTurnsPerSprint: 50,
          autoCommit: true,
          branchPattern: "bober/{feature-name}",
        }),
        model: generatorModel,
        provider,
      },
      evaluator: {
        model: generatorModel,
        strategies,
        maxIterations: defaults.evaluator?.maxIterations ?? 3,
        provider,
      },
    },
  );

  // Attach description if provided
  if (description) {
    config.project.description = description;
  }

  await writeConfig(projectRoot, config, mode, strategies, selectedPreset, provider);
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
    "bober.principles": "bober-principles.md",
    "bober.playwright": "bober-playwright.md",
    "bober.research": "bober-research.md",
    "bober.architect": "bober-architect.md",
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

  const agentFiles = ["bober-planner.md", "bober-generator.md", "bober-evaluator.md", "bober-researcher.md", "bober-architect.md", "bober-curator.md"];
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
  planner: { model: string; provider?: string };
  generator: { model: string; provider?: string };
  evaluator: { strategies: Array<{ type: string }>; provider?: string };
}

async function writeConfig(
  projectRoot: string,
  config: ConfigShape,
  mode: ProjectMode,
  strategies: Array<{ type: string; required: boolean }>,
  preset?: string,
  provider?: SupportedProvider,
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
  if (provider) {
    console.log(`  Provider:    ${chalk.cyan(provider)}`);
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
