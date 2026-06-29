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
import { readFindings, transitionFinding } from "../../hub/finding-store.js";
import type { Finding } from "../../hub/finding.js";

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

// ── Task status constants ─────────────────────────────────────────────

const ACTIVE_STATUSES: ReadonlyArray<Finding["status"]> = ["open", "in-progress"];

// ── runTaskList (DI core) ─────────────────────────────────────────────

/**
 * DI core for `task list`. Read-only; no `now` needed.
 * Default filter: status in {open, in-progress}. Never throws.
 */
export function runTaskList(
  store: FactStore,
  opts: { all?: boolean; status?: string },
): void {
  try {
    let findings = readFindings(store);
    if (opts.status) {
      findings = findings.filter((f) => f.status === opts.status);
    } else if (!opts.all) {
      findings = findings.filter((f) => ACTIVE_STATUSES.includes(f.status));
    }
    if (findings.length === 0) {
      process.stdout.write(chalk.gray("No tasks found.\n"));
      return;
    }
    process.stdout.write(
      chalk.bold(`${"ID".padEnd(18)} ${"STATUS".padEnd(12)} ${"DOMAIN".padEnd(12)} TITLE\n`),
    );
    process.stdout.write(`${"-".repeat(80)}\n`);
    for (const f of findings) {
      const title = f.title.length > 36 ? `${f.title.slice(0, 33)}...` : f.title;
      process.stdout.write(
        `${f.id.padEnd(18)} ${f.status.padEnd(12)} ${f.domain.padEnd(12)} ${title}\n`,
      );
    }
  } catch (err) {
    process.stderr.write(
      chalk.red(
        `Failed to list tasks: ${err instanceof Error ? err.message : String(err)}\n`,
      ),
    );
    process.exitCode = 1;
  }
}

// ── runTaskTransition (DI core) ───────────────────────────────────────

/**
 * DI core for start/done/drop. Missing id → chalk.yellow + exitCode=1 + return.
 * Never throws.
 */
export async function runTaskTransition(
  store: FactStore,
  id: string,
  newStatus: Finding["status"],
  now: string,
): Promise<void> {
  try {
    const updated = await transitionFinding(store, id, newStatus, { now });
    if (updated === null) {
      process.stderr.write(chalk.yellow(`task: no task found with id ${id}\n`));
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      chalk.green(`Task ${chalk.bold(id)} → ${chalk.bold(newStatus)}\n`),
    );
  } catch (err) {
    process.stderr.write(
      chalk.red(
        `Failed to update task: ${err instanceof Error ? err.message : String(err)}\n`,
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

  // ── task list ────────────────────────────────────────────────────
  taskCmd
    .command("list")
    .description("List tasks (open + in-progress by default)")
    .option("--all", "Show tasks in every status, including done/dropped")
    .option("--status <status>", "Show only tasks with this status")
    .action(async (opts: { all?: boolean; status?: string }) => {
      const projectRoot = await resolveRoot();
      try {
        const ns = await resolveDefaultNamespace(projectRoot);
        await ensureFactsDir(projectRoot, ns);
        const store = new FactStore(factsDbPath(projectRoot, ns));
        try {
          runTaskList(store, opts);
        } finally {
          store.close();
        }
      } catch (err) {
        process.stderr.write(
          chalk.red(
            `task list failed: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
        process.exitCode = 1;
      }
    });

  // ── task start / done / drop ─────────────────────────────────────
  for (const [name, status, desc] of [
    ["start", "in-progress", "Mark a task in-progress"],
    ["done", "done", "Mark a task done"],
    ["drop", "dropped", "Abandon a task (supersede to dropped — never deleted)"],
  ] as const) {
    taskCmd
      .command(`${name} <id>`)
      .description(desc)
      .action(async (id: string) => {
        const projectRoot = await resolveRoot();
        try {
          const ns = await resolveDefaultNamespace(projectRoot);
          await ensureFactsDir(projectRoot, ns);
          // Stamp wall-clock time at handler boundary — NEVER inside the helper
          const now = new Date().toISOString();
          const store = new FactStore(factsDbPath(projectRoot, ns));
          try {
            await runTaskTransition(store, id, status, now);
          } finally {
            store.close();
          }
        } catch (err) {
          process.stderr.write(
            chalk.red(
              `task ${name} failed: ${err instanceof Error ? err.message : String(err)}\n`,
            ),
          );
          process.exitCode = 1;
        }
      });
  }
}
