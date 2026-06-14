/**
 * `bober update` — refresh this project's installed Claude Code slash commands
 * and agent definitions from the currently-installed agent-bober package.
 *
 * After a user upgrades the package (`npm i -g agent-bober@latest`), the
 * per-project `.claude/commands/` and `.claude/agents/` copies made at `init`
 * time are stale. This command re-emits them from the package — the same
 * inlining `init` uses — WITHOUT touching `bober.config.json`, `.bober/` state,
 * `.gitignore`, or principles. It respects the project's recorded mode/preset so
 * the installed command set matches what `init` originally chose.
 *
 * Error handling: CLI handlers MUST NOT throw. They set process.exitCode=1 and
 * return on all errors. Pattern mirrors src/cli/commands/memory.ts.
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import chalk from "chalk";
import type { Command } from "commander";

import { configExists, loadConfig } from "../../config/loader.js";
import { findProjectRoot } from "../../utils/fs.js";
import { logger } from "../../utils/logger.js";
import { installClaudeCommands } from "./init.js";

// ── Package version (for the success message) ─────────────────────────

async function loadPackageVersion(): Promise<string> {
  try {
    const __filename = fileURLToPath(import.meta.url);
    // dist/cli/commands/update.js → package root is three levels up
    const pkgPath = join(dirname(__filename), "..", "..", "..", "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf-8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// ── runUpdateCommand ──────────────────────────────────────────────────

export async function runUpdateCommand(projectRoot: string): Promise<void> {
  logger.phase("Update Bober commands & agents");

  if (!(await configExists(projectRoot))) {
    logger.error(
      "No bober.config.json found here. Run `agent-bober init` first to set up this project.",
    );
    process.exitCode = 1;
    return;
  }

  let mode: "greenfield" | "brownfield";
  let preset: string | undefined;
  try {
    const config = await loadConfig(projectRoot);
    mode = config.project.mode;
    preset = config.project.preset;
  } catch (err) {
    logger.error(
      `Could not read bober.config.json: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
    return;
  }

  const version = await loadPackageVersion();

  // Re-emit .claude/commands + .claude/agents from the installed package.
  // installClaudeCommands only writes those two directories — it never touches
  // bober.config.json, .bober/ state, or .gitignore.
  await installClaudeCommands(projectRoot, mode, preset);

  console.log();
  logger.success(`Updated bober slash commands & agents to v${version}.`);
  console.log(
    chalk.gray(
      "  Refreshed .claude/commands/ and .claude/agents/ from the installed package.\n" +
        "  Your bober.config.json and .bober/ state were left untouched.",
    ),
  );
}

// ── registerUpdateCommand ─────────────────────────────────────────────

export function registerUpdateCommand(program: Command): void {
  program
    .command("update")
    .description(
      "Refresh this project's .claude/ slash commands and agent definitions from the installed agent-bober package (run after upgrading: npm i -g agent-bober@latest)",
    )
    .action(async () => {
      const opts = program.opts<{ verbose?: boolean; config?: string }>();
      if (opts.verbose) logger.verbose = true;
      const projectRoot = opts.config
        ? dirname(opts.config)
        : ((await findProjectRoot()) ?? process.cwd());
      await runUpdateCommand(projectRoot);
    });
}
