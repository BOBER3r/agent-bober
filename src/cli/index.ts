#!/usr/bin/env node

import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";

import { findProjectRoot } from "../utils/fs.js";
import { logger } from "../utils/logger.js";
import { runInitCommand } from "./commands/init.js";
import {
  runPlanCommand,
  runPlanAnswerCommand,
  runPlanAnswerInteractive,
} from "./commands/plan.js";
import { runSprintCommand } from "./commands/sprint.js";
import { runEvalCommand } from "./commands/eval.js";
import { runRunCommand } from "./commands/run.js";
import { createBoberMCPServer } from "../mcp/server.js";

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
      // Init always uses cwd — the user is in the directory they want to init
      const projectRoot = process.cwd();
      await runInitCommand(projectRoot, { preset });
    });

  // ── plan ────────────────────────────────────────────────────────
  const planCmd = program
    .command("plan [task]")
    .description("Create a plan for a task")
    .option(
      "--provider <name>",
      "Override AI provider for all roles (anthropic, openai, google, openai-compat)",
    )
    .action(async (task?: string, cmdOpts?: { provider?: string }) => {
      const opts = program.opts<{
        verbose?: boolean;
        config?: string;
        model?: string;
      }>();

      const projectRoot = await resolveProjectRoot(opts.config);
      await runPlanCommand(task, projectRoot, {
        verbose: opts.verbose,
        provider: cmdOpts?.provider,
      });
    });

  // `plan answer <specId> [questionId] [answer]` — resolve clarifications.
  // - With all three args: record the answer non-interactively.
  // - With only specId: walk every open question with prompts.
  planCmd
    .command("answer <specId> [questionId] [answer]")
    .description(
      "Resolve one or all open clarification questions on a spec. " +
        "If questionId/answer are omitted, prompts interactively for each open question.",
    )
    .action(async (specId: string, questionId?: string, answer?: string) => {
      const opts = program.opts<{ verbose?: boolean; config?: string }>();
      const projectRoot = await resolveProjectRoot(opts.config);
      if (questionId && answer) {
        await runPlanAnswerCommand(specId, questionId, answer, projectRoot, {
          verbose: opts.verbose,
        });
      } else {
        await runPlanAnswerInteractive(specId, projectRoot, {
          verbose: opts.verbose,
        });
      }
    });

  // ── sprint ──────────────────────────────────────────────────────
  program
    .command("sprint")
    .description("Run the next sprint")
    .option("--continue", "Continue to subsequent sprints after completion")
    .option(
      "--provider <name>",
      "Override AI provider for all roles (anthropic, openai, google, openai-compat)",
    )
    .action(async (cmdOpts: { continue?: boolean; provider?: string }) => {
      const opts = program.opts<{ verbose?: boolean; config?: string }>();

      const projectRoot = await resolveProjectRoot(opts.config);
      await runSprintCommand(projectRoot, {
        verbose: opts.verbose,
        continue: cmdOpts.continue,
        provider: cmdOpts.provider,
      });
    });

  // ── eval ────────────────────────────────────────────────────────
  program
    .command("eval")
    .description("Run evaluation on the current sprint")
    .option("-s, --sprint <id>", "Sprint ID to evaluate")
    .option(
      "--provider <name>",
      "Override AI provider for all roles (anthropic, openai, google, openai-compat)",
    )
    .action(async (cmdOpts: { sprint?: string; provider?: string }) => {
      const opts = program.opts<{ verbose?: boolean; config?: string }>();

      const projectRoot = await resolveProjectRoot(opts.config);
      await runEvalCommand(projectRoot, {
        verbose: opts.verbose,
        sprint: cmdOpts.sprint,
        provider: cmdOpts.provider,
      });
    });

  // ── run ─────────────────────────────────────────────────────────
  program
    .command("run [task]")
    .description("Run the full autonomous pipeline (plan + sprint loop)")
    .option(
      "--provider <name>",
      "Override AI provider for all roles (anthropic, openai, google, openai-compat)",
    )
    .action(async (task?: string, cmdOpts?: { provider?: string }) => {
      const opts = program.opts<{ verbose?: boolean; config?: string }>();

      const projectRoot = await resolveProjectRoot(opts.config);
      await runRunCommand(task, projectRoot, {
        verbose: opts.verbose,
        provider: cmdOpts?.provider,
      });
    });

  // ── mcp ─────────────────────────────────────────────────────────
  program
    .command("mcp")
    .description(
      "Start the agent-bober MCP server (stdio transport for Cursor/Windsurf)",
    )
    .action(async () => {
      const opts = program.opts<{ config?: string }>();
      const projectRoot = await resolveProjectRoot(opts.config);
      // stdout is reserved for MCP JSON-RPC — do NOT use logger or console.log
      await createBoberMCPServer(projectRoot);
      // Keep the process alive; the server holds an open stdin reader
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
