/**
 * `agent-bober blackboard publish|read` — inter-agent fleet blackboard CLI (Phase B).
 *
 * Subcommands:
 *   publish <value> [--round N]  — Publish a finding to the shared fleet blackboard.
 *   read [--all]                 — Print findings from the shared fleet blackboard.
 *
 * Error handling: CLI handlers MUST NOT throw. They set process.exitCode=1 and
 * return on all errors. Pattern mirrors src/cli/commands/facts.ts.
 *
 * The db path is read from config.fleet.blackboardDbPath ONLY — never re-derived
 * from cwd. This is the child-visible seam: the scaffolder wrote the absolute path
 * into each child's bober.config.json so children in different cwds can share one db.
 */

import chalk from "chalk";
import type { Command } from "commander";

import { findProjectRoot } from "../../utils/fs.js";
import { loadConfig } from "../../config/loader.js";
import { SharedBlackboard } from "../../fleet/shared-blackboard.js";

// ── Root resolver ─────────────────────────────────────────────────────

async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}

// ── runBlackboardPublish ──────────────────────────────────────────────

/**
 * Core for `blackboard publish` — DI'd projectRoot + nowIso for tests.
 * Reads the absolute db path from config.fleet only (never re-derives from cwd).
 * Clean exit-1 (no throw) when no fleet section is present.
 */
export async function runBlackboardPublish(
  projectRoot: string,
  value: string,
  opts: { round?: string },
  nowIso: string = new Date().toISOString(),
): Promise<void> {
  let bb: SharedBlackboard | undefined;
  try {
    const config = await loadConfig(projectRoot);
    if (!config.fleet) {
      process.stderr.write(
        chalk.red(
          "No fleet section in bober.config.json — this child is not part of a fleet blackboard run.\n",
        ),
      );
      process.exitCode = 1;
      return;
    }
    bb = await SharedBlackboard.open({
      dbPath: config.fleet.blackboardDbPath,
      namespace: config.fleet.blackboardNamespace,
      maxRounds: config.fleet.maxRounds,
    });
    bb.publish(
      {
        childFolder: config.fleet.blackboardSubject,
        round: opts.round !== undefined ? Number(opts.round) : 1,
        payload: value,
      },
      nowIso,
    );
    process.stdout.write(
      chalk.green(`Published finding for ${config.fleet.blackboardSubject}\n`),
    );
  } catch (err) {
    process.stderr.write(
      chalk.red(
        `Failed to publish: ${err instanceof Error ? err.message : String(err)}\n`,
      ),
    );
    process.exitCode = 1;
  } finally {
    bb?.close();
  }
}

// ── runBlackboardRead ─────────────────────────────────────────────────

/**
 * Core for `blackboard read [--all]` — DI'd projectRoot for tests.
 * Reads the absolute db path from config.fleet only (never re-derives from cwd).
 * Clean exit-1 (no throw) when no fleet section is present.
 */
export async function runBlackboardRead(
  projectRoot: string,
  opts: { all?: boolean },
): Promise<void> {
  let bb: SharedBlackboard | undefined;
  try {
    const config = await loadConfig(projectRoot);
    if (!config.fleet) {
      process.stderr.write(
        chalk.red(
          "No fleet section in bober.config.json — this child is not part of a fleet blackboard run.\n",
        ),
      );
      process.exitCode = 1;
      return;
    }
    bb = await SharedBlackboard.open({
      dbPath: config.fleet.blackboardDbPath,
      namespace: config.fleet.blackboardNamespace,
      maxRounds: config.fleet.maxRounds,
    });
    const findings = opts.all
      ? bb.readAll()
      : bb.readSiblings(config.fleet.blackboardSubject);
    for (const f of findings) {
      process.stdout.write(`[${f.subject}] ${f.value}\n`);
    }
  } catch (err) {
    process.stderr.write(
      chalk.red(
        `Failed to read: ${err instanceof Error ? err.message : String(err)}\n`,
      ),
    );
    process.exitCode = 1;
  } finally {
    bb?.close();
  }
}

// ── registerBlackboardCommand ─────────────────────────────────────────

export function registerBlackboardCommand(program: Command): void {
  const bbCmd = program
    .command("blackboard")
    .description("Inter-agent fleet blackboard (publish/read findings)");

  bbCmd
    .command("publish <value>")
    .description("Publish a finding to the shared fleet blackboard")
    .option("--round <n>", "Round number (default 1)")
    .action(async (value: string, opts: { round?: string }) => {
      await runBlackboardPublish(await resolveRoot(), value, opts);
    });

  bbCmd
    .command("read")
    .description("Read findings from the shared fleet blackboard")
    .option("--all", "Show all findings (default: siblings only)")
    .action(async (opts: { all?: boolean }) => {
      await runBlackboardRead(await resolveRoot(), opts);
    });
}
