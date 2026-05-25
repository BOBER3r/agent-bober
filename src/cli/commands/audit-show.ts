/**
 * `agent-bober audit show <runId> [--json]` — print the approval audit log for a run.
 *
 * Reads .bober/audits/<runId>.jsonl. Prints a human-readable table by default
 * (timestamp / checkpoint / outcome / approver / iteration / duration), or
 * machine-readable JSON via --json. Exits non-zero with a friendly message
 * if the audit log is missing (ENOENT).
 *
 * Sprint 13 — colocated CLI command per Sprint 9 precedent.
 * Pattern mirrors src/cli/commands/list-approvals.ts.
 */

import { readFile } from "node:fs/promises";

import chalk from "chalk";
import type { Command } from "commander";

import { findProjectRoot } from "../../utils/fs.js";
import { getAuditPath, type ApprovalRecord } from "../../orchestrator/checkpoints/audit.js";
import { formatAge } from "./list-approvals.js";

async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}

/**
 * Map an ApprovalOutcome to a chalk-colored string for display.
 */
function colorizeOutcome(outcome: string): string {
  switch (outcome) {
    case "approved":
      return chalk.green(outcome);
    case "rejected":
      return chalk.red(outcome);
    case "edited":
      return chalk.yellow(outcome);
    case "aborted":
      return chalk.red(outcome);
    default:
      return outcome;
  }
}

export function registerAuditCommand(program: Command): void {
  const auditCmd = program.command("audit").description("Inspect checkpoint audit logs");

  auditCmd
    .command("show <runId>")
    .description("Print the approval audit log for a run")
    .option("--json", "Emit machine-readable JSON instead of a table")
    .action(async (runId: string, opts: { json?: boolean }) => {
      const projectRoot = await resolveRoot();
      const path = getAuditPath(projectRoot, runId);

      let raw: string;
      try {
        raw = await readFile(path, "utf-8");
      } catch (err) {
        if ((err as { code?: string }).code === "ENOENT") {
          process.stderr.write(chalk.yellow(`No audit log found for run ${runId}.\n`));
          process.exitCode = 1;
          return;
        }
        throw err;
      }

      const records = raw
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ApprovalRecord);

      if (opts.json) {
        process.stdout.write(JSON.stringify(records, null, 2) + "\n");
        return;
      }

      if (records.length === 0) {
        process.stdout.write("No audit entries found for this run.\n");
        return;
      }

      // Human-readable table header (mirrors list-approvals.ts:93-107 pattern).
      process.stdout.write(
        chalk.cyan(
          `${"Timestamp".padEnd(28)} ${"Checkpoint".padEnd(28)} ${"Outcome".padEnd(10)} ${"Approver".padEnd(20)} ${"Iter".padEnd(5)} Duration\n`,
        ),
      );
      process.stdout.write(
        chalk.gray(
          `${"-".repeat(28)} ${"-".repeat(28)} ${"-".repeat(10)} ${"-".repeat(20)} ${"-".repeat(5)} ${"-".repeat(10)}\n`,
        ),
      );

      for (const record of records) {
        const ts = record.timestamp ? record.timestamp.slice(0, 23).replace("T", " ") : "unknown";
        const checkpoint = record.checkpointId.padEnd(28).slice(0, 28);
        const outcome = colorizeOutcome(record.outcome).padEnd(10);
        const approver = (record.approverId ?? "unknown").padEnd(20).slice(0, 20);
        const iter = String(record.iteration ?? 0).padEnd(5);
        const duration = formatAge(record.durationMs ?? 0);

        process.stdout.write(
          `${ts.padEnd(28)} ${checkpoint} ${outcome} ${approver} ${iter} ${duration}\n`,
        );
      }
    });
}
