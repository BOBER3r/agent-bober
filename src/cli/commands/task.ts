/**
 * `bober task <add>` — zero-friction personal task capture.
 *
 * Subcommands:
 *   add <text>  — Capture a plain task as an open action Finding in the hub pool.
 *
 * Error handling: CLI handlers MUST NOT throw. They set process.exitCode=1 and
 * return on all errors. Pattern mirrors src/cli/commands/facts.ts.
 */

import chalk from "chalk";
import type { Command } from "commander";

import { findProjectRoot } from "../../utils/fs.js";
import { loadConfig } from "../../config/loader.js";
import { loadTeam } from "../../teams/registry.js";
import {
  FactStore,
  factsDbPath,
  ensureFactsDir,
} from "../../state/facts.js";
import { captureTask } from "../../hub/task-inbox.js";

// ── Root resolver ─────────────────────────────────────────────────────

async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}

// ── Namespace resolver ────────────────────────────────────────────────

/**
 * Resolve the active memory namespace from the default team.
 * Falls back to undefined (current .bober/memory/ path) if config is missing.
 * Never throws — config absence is not fatal for task commands.
 */
async function resolveDefaultNamespace(
  projectRoot: string,
): Promise<string | undefined> {
  try {
    const config = await loadConfig(projectRoot);
    return loadTeam(config, undefined).memoryNamespace || undefined;
  } catch {
    return undefined;
  }
}

// ── runTaskAdd (DI core) ──────────────────────────────────────────────

/**
 * DI core for `task add` — accepts an already-open store + injected `now`
 * so tests can drive it without spawning the CLI or opening a real DB.
 *
 * Never throws: empty input and persistence errors are caught, reported to
 * stderr, and communicated via process.exitCode=1.
 */
export async function runTaskAdd(
  store: FactStore,
  text: string,
  opts: { domain?: string },
  now: string,
): Promise<void> {
  const title = text.trim();
  if (title.length === 0) {
    process.stderr.write(chalk.red("task add: text must not be empty\n"));
    process.exitCode = 1;
    return;
  }
  try {
    const finding = await captureTask(store, title, { domain: opts.domain, now });
    process.stdout.write(chalk.green(`Captured task ${chalk.bold(finding.id)}\n`));
    process.stdout.write(`  title:  ${finding.title}\n`);
    process.stdout.write(`  domain: ${finding.domain}\n`);
  } catch (err) {
    process.stderr.write(
      chalk.red(
        `Failed to add task: ${err instanceof Error ? err.message : String(err)}\n`,
      ),
    );
    process.exitCode = 1;
  }
}

// ── registerTaskCommand ───────────────────────────────────────────────

export function registerTaskCommand(program: Command): void {
  const taskCmd = program
    .command("task")
    .description("Personal task inbox (capture tasks as hub findings)");

  // ── task add ────────────────────────────────────────────────────
  taskCmd
    .command("add <text>")
    .description("Capture a plain task into the unified hub pool")
    .option("--domain <domain>", "Optional domain tag (e.g. medical)")
    .action(async (text: string, opts: { domain?: string }) => {
      const projectRoot = await resolveRoot();
      try {
        const ns = await resolveDefaultNamespace(projectRoot);
        await ensureFactsDir(projectRoot, ns);

        // Stamp wall-clock time at handler boundary — NEVER inside the store
        const now = new Date().toISOString();

        const store = new FactStore(factsDbPath(projectRoot, ns));
        try {
          await runTaskAdd(store, text, opts, now);
        } finally {
          store.close();
        }
      } catch (err) {
        process.stderr.write(
          chalk.red(
            `task add failed: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
        process.exitCode = 1;
      }
    });
}
