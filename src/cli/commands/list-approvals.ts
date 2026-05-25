/**
 * `agent-bober list-approvals [--json]` — list all pending checkpoints awaiting approval.
 *
 * Stateless: reads .bober/approvals/*.pending.json from the project root.
 * Works from any cwd inside the project (findProjectRoot() walks upward).
 * Output: human-readable table by default, machine-readable JSON via --json flag.
 *
 * Sprint 9 — colocated CLI command per Sprint 8/10 precedent.
 */

import chalk from "chalk";
import type { Command } from "commander";

import { findProjectRoot } from "../../utils/fs.js";
import { listPendingApprovals } from "../../state/approval-state.js";

async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}

/**
 * Format a duration in milliseconds as a human-readable string (e.g. "2h 15m").
 */
export function formatAge(ageMs: number): string {
  const totalSeconds = Math.floor(ageMs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${totalSeconds}s`;
}

export function registerListApprovalsCommand(program: Command): void {
  program
    .command("list-approvals")
    .description("List all pending checkpoints awaiting approval")
    .option("--json", "Emit machine-readable JSON instead of a table")
    .action(async (opts: { json?: boolean }) => {
      const projectRoot = await resolveRoot();
      const rows = await listPendingApprovals(projectRoot);

      if (opts.json) {
        process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
        return;
      }

      if (rows.length === 0) {
        process.stdout.write("No pending checkpoints.\n");
        return;
      }

      // Human-readable table header
      process.stdout.write(
        chalk.cyan(
          `${"Checkpoint ID".padEnd(48)} ${"Age".padEnd(10)} Prompt\n`,
        ),
      );
      process.stdout.write(
        chalk.gray(`${"-".repeat(48)} ${"-".repeat(10)} ${"-".repeat(40)}\n`),
      );

      for (const r of rows) {
        process.stdout.write(
          `${r.checkpointId.padEnd(48)} ${formatAge(r.ageMs).padEnd(10)} ${r.prompt}\n`,
        );
      }
    });
}
