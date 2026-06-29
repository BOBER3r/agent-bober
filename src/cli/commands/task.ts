/**
 * `bober task <add>` — zero-friction personal task capture.
 *
 * Subcommands:
 *   add <text>  — Capture a plain task as an open action Finding in the hub pool.
 *
 * Error handling: CLI handlers MUST NOT throw. They set process.exitCode=1 and
 * return on all errors. Pattern mirrors src/cli/commands/facts.ts.
 */

import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";

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
import {
  readFindings,
  transitionFinding,
  isVisibleInDefaultList,
  SNOOZE_TAG_PREFIX,
  ingestFinding,
} from "../../hub/finding-store.js";
import type { Finding } from "../../hub/finding.js";
import type { ObservabilityProvider } from "../../config/schema.js";
import { ExternalMcpServer } from "../../mcp/external-client.js";
import {
  fromGmailTask,
  sanitizeConnectorError,
} from "../../hub/gmail-to-task.js";
import type { GmailMcpLike } from "../../hub/gmail-to-task.js";

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

// ── runTaskList (DI core) ─────────────────────────────────────────────

/**
 * DI core for `task list`. Default filter: wake-aware visibility (open,
 * in-progress, or snoozed tasks whose wake time has passed). Never throws.
 *
 * `now` is injected at the CLI handler boundary so tests can pass a fixed
 * clock. No Date.now() or new Date() inside this function.
 */
export function runTaskList(
  store: FactStore,
  opts: { all?: boolean; status?: string },
  now: string,
): void {
  try {
    let findings = readFindings(store);
    if (opts.status) {
      findings = findings.filter((f) => f.status === opts.status);
    } else if (!opts.all) {
      findings = findings.filter((f) => isVisibleInDefaultList(f, now));
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

// ── runTaskSnooze (DI core) ───────────────────────────────────────────

/** Terminal statuses that cannot be re-snoozed. */
const TERMINAL_STATUSES: ReadonlyArray<Finding["status"]> = ["done", "dropped"];

/**
 * DI core for `task snooze`. Parses `until` as an ISO date at the boundary
 * (NaN → chalk.red + exitCode=1 + return), reads the active Finding, strips
 * any prior snooze-until tag, appends the new one, and transitions to snoozed.
 *
 * Never throws: all errors use chalk + process.exitCode=1 + return.
 */
export async function runTaskSnooze(
  store: FactStore,
  id: string,
  until: string,
  now: string,
): Promise<void> {
  const d = new Date(until);
  if (Number.isNaN(d.getTime())) {
    process.stderr.write(
      chalk.red(`task snooze: invalid --until value: ${until}\n`),
    );
    process.exitCode = 1;
    return;
  }
  const untilIso = d.toISOString();
  try {
    const current = readFindings(store).find((f) => f.id === id);
    if (current === undefined) {
      process.stderr.write(chalk.yellow(`task: no task found with id ${id}\n`));
      process.exitCode = 1;
      return;
    }
    if (TERMINAL_STATUSES.includes(current.status)) {
      process.stderr.write(
        chalk.yellow(`task: cannot snooze a ${current.status} task\n`),
      );
      process.exitCode = 1;
      return;
    }
    const tags = [
      ...current.tags.filter((t) => !t.startsWith(SNOOZE_TAG_PREFIX)),
      `${SNOOZE_TAG_PREFIX}${untilIso}`,
    ];
    const updated = await transitionFinding(store, id, "snoozed", {
      now,
      mutate: { tags },
    });
    if (updated === null) {
      process.stderr.write(chalk.yellow(`task: no task found with id ${id}\n`));
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      chalk.green(
        `Task ${chalk.bold(id)} snoozed until ${chalk.bold(untilIso)}\n`,
      ),
    );
  } catch (err) {
    process.stderr.write(
      chalk.red(
        `Failed to snooze task: ${err instanceof Error ? err.message : String(err)}\n`,
      ),
    );
    process.exitCode = 1;
  }
}

// ── readIngestInput (file or stdin) ───────────────────────────────────

/**
 * Read the raw JSON payload from a file path, or stdin when omitted.
 * File path uses node:fs/promises readFile (no sync fs per principles).
 * Stdin uses async iteration over process.stdin (no file descriptor cast needed).
 */
async function readIngestInput(file?: string): Promise<string> {
  if (file !== undefined) {
    return await readFile(file, "utf-8");
  }
  // bober: async-iterate stdin; swap for readFile(fh,"utf-8") on a FileHandle if Node typings expose fd as PathLike
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

// ── runTaskIngest (DI core) ───────────────────────────────────────────

/**
 * Parse the raw JSON, ingest it, print the reconcile action. Never throws:
 * bad JSON or schema-invalid payload → chalk.red + exitCode=1 + return, no write.
 */
export async function runTaskIngest(
  store: FactStore,
  raw: string,
  now: string,
): Promise<void> {
  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch {
    process.stderr.write(chalk.red("task ingest: input is not valid JSON\n"));
    process.exitCode = 1;
    return;
  }
  try {
    const action = await ingestFinding(store, payload, { now });
    process.stdout.write(chalk.green(`Ingested finding (${chalk.bold(action)})\n`));
  } catch (err) {
    process.stderr.write(
      chalk.red(
        `task ingest: invalid finding: ${err instanceof Error ? err.message : String(err)}\n`,
      ),
    );
    process.exitCode = 1;
  }
}

// ── runTaskFromGmail (DI core) ────────────────────────────────────────

/**
 * DI core for `task from-gmail`. egressAllowed is resolved at the CLI boundary.
 *
 * When disabled → opt-in error from fromGmailTask is caught, written to stderr,
 * exitCode=1, return. When enabled → fromGmailTask runs with the injected mcp.
 * Connector errors are caught, sanitized (KEY=VALUE stripped), set exitCode=1.
 *
 * Never throws. mcp.stop() is always attempted in a finally block.
 */
export async function runTaskFromGmail(
  store: FactStore,
  mcp: GmailMcpLike,
  threadRef: string,
  egressAllowed: boolean,
  now: string,
): Promise<void> {
  try {
    const finding = await fromGmailTask({ egressAllowed, mcp, threadRef, store, now });
    process.stdout.write(chalk.green(`Captured task ${chalk.bold(finding.id)} from Gmail\n`));
    process.stdout.write(`  title: ${finding.title}\n`);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    process.stderr.write(chalk.red(`task from-gmail: ${sanitizeConnectorError(raw)}\n`));
    process.exitCode = 1;
  } finally {
    await mcp.stop().catch(() => {
      // ignore stop errors
    });
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
        // Stamp wall-clock time at handler boundary — NEVER inside the filter
        const now = new Date().toISOString();
        const store = new FactStore(factsDbPath(projectRoot, ns));
        try {
          runTaskList(store, opts, now);
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

  // ── task snooze ──────────────────────────────────────────────────
  taskCmd
    .command("snooze <id>")
    .description("Snooze a task until a future time (hides it from the default list)")
    .requiredOption("--until <when>", "Wake time (ISO date or datetime, e.g. 2026-12-01)")
    .action(async (id: string, opts: { until: string }) => {
      const projectRoot = await resolveRoot();
      try {
        const ns = await resolveDefaultNamespace(projectRoot);
        await ensureFactsDir(projectRoot, ns);
        // Stamp wall-clock time at handler boundary — NEVER inside the helper
        const now = new Date().toISOString();
        const store = new FactStore(factsDbPath(projectRoot, ns));
        try {
          await runTaskSnooze(store, id, opts.until, now);
        } finally {
          store.close();
        }
      } catch (err) {
        process.stderr.write(
          chalk.red(
            `task snooze failed: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
        process.exitCode = 1;
      }
    });

  // ── task ingest ──────────────────────────────────────────────────
  taskCmd
    .command("ingest [file]")
    .description("Ingest a Finding JSON (file path, or stdin when omitted) into the hub pool")
    .action(async (file?: string) => {
      const projectRoot = await resolveRoot();
      try {
        const ns = await resolveDefaultNamespace(projectRoot);
        await ensureFactsDir(projectRoot, ns);
        // Stamp wall-clock time at handler boundary — NEVER inside the store
        const now = new Date().toISOString();
        const raw = await readIngestInput(file);
        const store = new FactStore(factsDbPath(projectRoot, ns));
        try {
          await runTaskIngest(store, raw, now);
        } finally {
          store.close();
        }
      } catch (err) {
        process.stderr.write(
          chalk.red(
            `task ingest failed: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
        process.exitCode = 1;
      }
    });

  // ── task from-gmail ──────────────────────────────────────────────
  taskCmd
    .command("from-gmail <thread>")
    .description("Capture a Gmail thread as a task (requires opt-in taskInbox.gmailEgress)")
    .action(async (thread: string) => {
      const projectRoot = await resolveRoot();
      try {
        // Resolve the gmail axis fail-closed: any config error => disabled.
        let gmailAllowed = false;
        let gmailProvider: ObservabilityProvider | undefined;
        try {
          const config = await loadConfig(projectRoot);
          gmailAllowed = config.taskInbox?.gmailEgress ?? false;
          gmailProvider = (config.observability?.providers ?? []).find(
            (p) => p.name === "gmail" && p.enabled,
          );
        } catch {
          gmailAllowed = false; // missing/invalid config => fail-closed
        }

        if (!gmailAllowed) {
          process.stderr.write(
            chalk.yellow(
              "task from-gmail: Gmail egress not enabled — set taskInbox.gmailEgress: true in bober.config.json to opt in.\n",
            ),
          );
          process.exitCode = 1;
          return; // NO MCP construction (sc-6-2)
        }

        if (!gmailProvider) {
          process.stderr.write(
            chalk.red(
              "task from-gmail: no enabled observability provider named 'gmail' configured.\n",
            ),
          );
          process.exitCode = 1;
          return;
        }

        const ns = await resolveDefaultNamespace(projectRoot);
        await ensureFactsDir(projectRoot, ns);
        // Stamp wall-clock time at handler boundary — NEVER inside the core
        const now = new Date().toISOString();
        const store = new FactStore(factsDbPath(projectRoot, ns));
        // ExternalMcpServer satisfies GmailMcpLike structurally
        const mcp = new ExternalMcpServer(gmailProvider);
        try {
          await runTaskFromGmail(store, mcp, thread, gmailAllowed, now);
        } finally {
          store.close();
        }
      } catch (err) {
        process.stderr.write(
          chalk.red(
            `task from-gmail failed: ${err instanceof Error ? sanitizeConnectorError(err.message) : String(err)}\n`,
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
