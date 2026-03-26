#!/usr/bin/env node

import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";

import { findProjectRoot } from "../utils/fs.js";
import { logger } from "../utils/logger.js";
import { runInitCommand } from "./commands/init.js";
import { runPlanCommand } from "./commands/plan.js";
import { runSprintCommand } from "./commands/sprint.js";
import { runEvalCommand } from "./commands/eval.js";
import { runRunCommand } from "./commands/run.js";

// ── Version loader ─────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadVersion(): Promise<string> {
  try {
    // In the dist/ output the package.json is two levels up from dist/cli/
    const pkgPath = join(__dirname, "..", "..", "package.json");
    const raw = await readFile(pkgPath, "utf-8");
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// ── Project root resolution ────────────────────────────────────────

async function resolveProjectRoot(configPath?: string): Promise<string> {
  if (configPath) {
    // If a specific config path was provided, use its parent
    return dirname(configPath);
  }

  const root = await findProjectRoot();
  if (!root) {
    // Fall back to cwd
    return process.cwd();
  }
  return root;
}

// ── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const version = await loadVersion();

  const program = new Command();

  program
    .name("agent-bober")
    .description(
      "Generator-Evaluator multi-agent harness for building applications autonomously with Claude",
    )
    .version(version)
    .option("-v, --verbose", "Enable verbose debug output")
    .option("-c, --config <path>", "Path to bober config file")
    .option(
      "-m, --model <model>",
      "Override model choice (sonnet, opus, haiku)",
    );

  // ── init ────────────────────────────────────────────────────────
  program
    .command("init [preset]")
    .description("Initialize bober in the current project")
    .option("-p, --preset <name>", "Use a specific stack preset")
    .action(async (presetArg?: string, cmdOpts?: { preset?: string }) => {
      const opts = program.opts<{ verbose?: boolean; config?: string }>();
      if (opts.verbose) logger.verbose = true;

      const preset = cmdOpts?.preset ?? presetArg;
      const projectRoot = await resolveProjectRoot(opts.config);
      await runInitCommand(projectRoot, { preset });
    });

  // ── plan ────────────────────────────────────────────────────────
  program
    .command("plan [task]")
    .description("Create a plan for a task")
    .action(async (task?: string) => {
      const opts = program.opts<{
        verbose?: boolean;
        config?: string;
        model?: string;
      }>();

      const projectRoot = await resolveProjectRoot(opts.config);
      await runPlanCommand(task, projectRoot, {
        verbose: opts.verbose,
      });
    });

  // ── sprint ──────────────────────────────────────────────────────
  program
    .command("sprint")
    .description("Run the next sprint")
    .option("--continue", "Continue to subsequent sprints after completion")
    .action(async (cmdOpts: { continue?: boolean }) => {
      const opts = program.opts<{ verbose?: boolean; config?: string }>();

      const projectRoot = await resolveProjectRoot(opts.config);
      await runSprintCommand(projectRoot, {
        verbose: opts.verbose,
        continue: cmdOpts.continue,
      });
    });

  // ── eval ────────────────────────────────────────────────────────
  program
    .command("eval")
    .description("Run evaluation on the current sprint")
    .option("-s, --sprint <id>", "Sprint ID to evaluate")
    .action(async (cmdOpts: { sprint?: string }) => {
      const opts = program.opts<{ verbose?: boolean; config?: string }>();

      const projectRoot = await resolveProjectRoot(opts.config);
      await runEvalCommand(projectRoot, {
        verbose: opts.verbose,
        sprint: cmdOpts.sprint,
      });
    });

  // ── run ─────────────────────────────────────────────────────────
  program
    .command("run [task]")
    .description("Run the full autonomous pipeline (plan + sprint loop)")
    .action(async (task?: string) => {
      const opts = program.opts<{ verbose?: boolean; config?: string }>();

      const projectRoot = await resolveProjectRoot(opts.config);
      await runRunCommand(task, projectRoot, {
        verbose: opts.verbose,
      });
    });

  // ── Parse ───────────────────────────────────────────────────────
  await program.parseAsync(process.argv);
}

// ── Entry point ────────────────────────────────────────────────────

main().catch((err: unknown) => {
  console.error(
    chalk.red(
      `Fatal error: ${err instanceof Error ? err.message : String(err)}`,
    ),
  );
  if (err instanceof Error && err.stack) {
    console.error(chalk.gray(err.stack));
  }
  process.exitCode = 1;
});
