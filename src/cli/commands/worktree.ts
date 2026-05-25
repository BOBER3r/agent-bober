/**
 * `bober worktree run <task> [--allow-dirty] [--keep-on-success]` — launch a
 * pipeline run in an isolated git worktree.
 *
 * Error handling: CLI handlers MUST NOT throw. They set process.exitCode=1 and
 * return on all errors (Pattern C per briefing).
 *
 * Sprint 4 (cockpit-integration)
 */

import chalk from "chalk";
import type { Command } from "commander";

import { findProjectRoot } from "../../utils/fs.js";
import { loadConfig, configExists } from "../../config/loader.js";
import { runInWorktree } from "../../orchestrator/worktree.js";

async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}

export function registerWorktreeCommand(program: Command): void {
  const wtCmd = program
    .command("worktree")
    .description("Launch and manage worktree-isolated pipeline runs");

  wtCmd
    .command("run <task>")
    .description(
      "Run the full Bober pipeline in an isolated git worktree on a new branch",
    )
    .option(
      "--allow-dirty",
      "Allow worktree creation even when the working tree has uncommitted changes",
    )
    .option(
      "--keep-on-success",
      "Retain the worktree after a successful pipeline run (default is to clean up)",
    )
    .action(
      async (task: string, opts: { allowDirty?: boolean; keepOnSuccess?: boolean }) => {
        const projectRoot = await resolveRoot();

        const hasConfig = await configExists(projectRoot);
        if (!hasConfig) {
          process.stderr.write(
            chalk.red("No bober.config.json found. Run `bober init` first.\n"),
          );
          process.exitCode = 1;
          return;
        }

        let config;
        try {
          config = await loadConfig(projectRoot);
        } catch (err) {
          process.stderr.write(
            chalk.red(
              `Failed to load config: ${err instanceof Error ? err.message : String(err)}\n`,
            ),
          );
          process.exitCode = 1;
          return;
        }

        try {
          const result = await runInWorktree(task, projectRoot, config, {
            allowDirty: opts.allowDirty,
            keepOnSuccess: opts.keepOnSuccess,
          });
          process.stdout.write(
            JSON.stringify({ ...result, projectRoot }, null, 2) + "\n",
          );
        } catch (err) {
          process.stderr.write(
            chalk.red(
              `Worktree run failed: ${err instanceof Error ? err.message : String(err)}\n`,
            ),
          );
          process.exitCode = 1;
        }
      },
    );
}
