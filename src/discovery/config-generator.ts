/**
 * Config Generator
 *
 * Generates evaluator strategies and commands from a DiscoveryReport,
 * enabling auto-configuration of bober.config.json for a scanned project.
 *
 * generateEvalConfig() is the main entry point. It reads the detected
 * package scripts, CI checks, and stack information from the report and
 * produces a CommandsSection and an array of EvalStrategy objects ready
 * to be written into the evaluator config.
 */

import type { DiscoveryReport, CIStep } from "./types.js";
import type { EvalStrategy, CommandsSection } from "../config/schema.js";

// ── Package manager install commands ─────────────────────────────

function buildInstallCommand(pm: string | null): string {
  switch (pm) {
    case "yarn":
      return "yarn";
    case "pnpm":
      return "pnpm install";
    case "bun":
      return "bun install";
    case "npm":
    default:
      return "npm install";
  }
}

// ── Commands section generation ───────────────────────────────────

/**
 * Produce a CommandsSection from the package scripts portion of a
 * DiscoveryReport.  Each bober command category maps 1-to-1 to the
 * CommandsSection fields, using the pre-built runCommand strings that
 * the package-scripts scanner already computed.
 */
function generateCommands(report: DiscoveryReport): CommandsSection {
  const categorized = report.packageScripts?.categorized ?? {};

  return {
    install: buildInstallCommand(report.packageManager),
    build: categorized.build?.runCommand,
    test: categorized.test?.runCommand,
    lint: categorized.lint?.runCommand,
    typecheck: categorized.typecheck?.runCommand,
    dev: categorized.dev?.runCommand,
  };
}

// ── Core strategy generation ──────────────────────────────────────

/**
 * Map the detected package script categories to evaluator strategies.
 * The ordering reflects typical CI pipeline order (typecheck -> lint -> build -> test).
 */
function generateCoreStrategies(report: DiscoveryReport): EvalStrategy[] {
  const categorized = report.packageScripts?.categorized ?? {};
  const strategies: EvalStrategy[] = [];

  if (categorized.typecheck) {
    strategies.push({ type: "typecheck", required: true });
  }

  if (categorized.lint) {
    strategies.push({ type: "lint", required: true });
  }

  if (categorized.build) {
    strategies.push({ type: "build", required: true });
  }

  if (categorized.test) {
    strategies.push({ type: "unit-test", required: true });
  }

  return strategies;
}

// ── Playwright strategy generation ───────────────────────────────

/**
 * Playwright requires both the @playwright/test dependency AND a
 * playwright config file to be considered fully configured.
 *
 * - Both present: required: true
 * - Only one of the two present: required: false (partial setup)
 * - Neither present: no strategy added
 */
function generatePlaywrightStrategy(report: DiscoveryReport): EvalStrategy | null {
  const stack = report.detectedStack;
  if (!stack) return null;

  const hasDep = stack.hasPlaywright;

  // Check for playwright config file presence by scanning allScripts or relying
  // on the stack report. The stack scanner checks @playwright/test in deps.
  // For config file detection we look at the CI commands or documentation heuristic.
  // Since DiscoveryReport doesn't have a dedicated playwright config field, we
  // determine "has config" by checking if any documented playwright config
  // patterns appear in the scanned project files. We use a conservative
  // approach: treat it as "config present" if the dep is detected (the most
  // common signal) and additionally check CI commands for playwright references.
  const hasPlaywrightInCI = report.ciChecks.allRunCommands.some(
    (cmd) => cmd.toLowerCase().includes("playwright"),
  );

  // A playwright config file is inferred from its dep being present AND
  // either a CI reference or a test script that mentions playwright.
  const testScript = report.packageScripts?.categorized.test?.command ?? "";
  const hasPlaywrightInTestScript = testScript.toLowerCase().includes("playwright");

  const hasConfig = hasDep && (hasPlaywrightInCI || hasPlaywrightInTestScript);

  if (!hasDep && !hasConfig) return null;

  // required: true only when both dep and config evidence are present
  return {
    type: "playwright",
    required: hasDep && hasConfig,
  };
}

// ── API framework strategy generation ────────────────────────────

/**
 * When an API framework is detected in the stack, add an api-check strategy.
 * Always required: false since not all projects expose a live server during CI.
 */
function generateApiStrategy(report: DiscoveryReport): EvalStrategy | null {
  const stack = report.detectedStack;
  if (!stack) return null;

  const hasApiFramework =
    stack.hasNestjs || stack.hasFastify || stack.hasExpress;

  if (!hasApiFramework) return null;

  return { type: "api-check", required: false };
}

// ── CI-derived strategy generation ───────────────────────────────

/**
 * Convert a CI run command into a safe strategy type name.
 *
 * Examples:
 *   "cargo clippy" -> "cargo-clippy"
 *   "npx prettier --check ." -> "prettier"
 *   "python -m pytest" -> "pytest"
 */
function ciCommandToStrategyType(cmd: string): string {
  // Strip common prefixes that don't add type identity
  const stripped = cmd
    .replace(/^(npx|python\s+-m|\.\/node_modules\/.bin\/)\s*/i, "")
    .trim();

  // Take the first two tokens for compound commands (e.g. "cargo clippy")
  const tokens = stripped.split(/\s+/).filter(Boolean);
  const base = tokens.slice(0, 2).join("-");

  // Sanitize to produce a valid type name: lowercase alphanumeric and hyphens
  return base
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Build a human-readable label from the strategy type (derived from CI command).
 * E.g., "cargo-clippy" -> "Cargo-Clippy (from CI)"
 */
function ciStrategyLabel(type: string): string {
  const formatted = type
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("-");
  return `${formatted} (from CI)`;
}

/**
 * Determine which CI step run commands don't already have coverage from
 * the core strategies and generate inline-command strategies for them.
 *
 * A CI command is "already covered" if its inferred category matches one
 * of the core strategy types we already emitted.
 */
function generateCIStrategies(
  report: DiscoveryReport,
  coveredTypes: Set<string>,
): EvalStrategy[] {
  const strategies: EvalStrategy[] = [];
  const seenTypes = new Set<string>();

  // Gather all unique CI steps across all workflows
  const allSteps: CIStep[] = report.ciChecks.workflows.flatMap((w) => w.steps);

  for (const step of allSteps) {
    const cmd = step.runCommand.trim();
    if (!cmd) continue;

    // Map CI category to bober strategy type
    const ciCategoryToStrategyType: Record<string, string> = {
      test: "unit-test",
      lint: "lint",
      build: "build",
      deploy: "deploy",
      other: "",
    };

    const mappedType = ciCategoryToStrategyType[step.category] ?? "";

    // Skip if this category is already covered by a core strategy
    if (mappedType && coveredTypes.has(mappedType)) continue;

    // Derive a unique type name from the command itself
    const type = ciCommandToStrategyType(cmd);
    if (!type || seenTypes.has(type)) continue;
    seenTypes.add(type);

    strategies.push({
      type,
      command: cmd,
      required: false,
      label: ciStrategyLabel(type),
    });
  }

  return strategies;
}

// ── Main entry point ──────────────────────────────────────────────

export interface EvalConfig {
  strategies: EvalStrategy[];
  commands: CommandsSection;
}

/**
 * Generate evaluator strategies and commands from a DiscoveryReport.
 *
 * The returned object is ready to be merged into a bober.config.json:
 *   config.evaluator.strategies = result.strategies
 *   config.commands = result.commands
 *
 * @param report The DiscoveryReport produced by scanProject().
 */
export function generateEvalConfig(report: DiscoveryReport): EvalConfig {
  const commands = generateCommands(report);
  const coreStrategies = generateCoreStrategies(report);

  // Track which strategy types are already covered to avoid duplicating
  // them when processing CI-derived commands
  const coveredTypes = new Set(coreStrategies.map((s) => s.type));

  const playwrightStrategy = generatePlaywrightStrategy(report);
  if (playwrightStrategy) {
    coveredTypes.add(playwrightStrategy.type);
  }

  const apiStrategy = generateApiStrategy(report);
  if (apiStrategy) {
    coveredTypes.add(apiStrategy.type);
  }

  const ciStrategies = generateCIStrategies(report, coveredTypes);

  const strategies: EvalStrategy[] = [
    ...coreStrategies,
    ...(playwrightStrategy ? [playwrightStrategy] : []),
    ...(apiStrategy ? [apiStrategy] : []),
    ...ciStrategies,
  ];

  return { strategies, commands };
}
