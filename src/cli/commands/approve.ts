/**
 * `agent-bober approve <checkpointId> [--edit <file>]` — resolve a pending
 * disk-marker checkpoint by writing .bober/approvals/<id>.approved.json.
 *
 * Stateless: does not talk to the orchestrator; communicates via filesystem.
 * Works from any cwd inside the project (findProjectRoot() walks upward).
 *
 * Sprint 9 — colocated CLI command per Sprint 8/10 precedent.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import chalk from "chalk";
import type { Command } from "commander";

import { findProjectRoot } from "../../utils/fs.js";
import { pendingExists } from "../../state/approval-state.js";

async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}

/**
 * Resolve the approver identity from the environment.
 * Uses $USER (macOS/Linux) or $USERNAME (Windows), falling back to "unknown".
 */
export function resolveApprover(): string {
  return process.env["USER"] ?? process.env["USERNAME"] ?? "unknown";
}

export function registerApproveCommand(program: Command): void {
  program
    .command("approve <checkpointId>")
    .description("Approve a pending checkpoint by writing the .approved.json marker")
    .option("--edit <path>", "Path to a file whose contents become the editDelta")
    .action(async (checkpointId: string, opts: { edit?: string }) => {
      const projectRoot = await resolveRoot();
      const approvalsDir = join(projectRoot, ".bober", "approvals");
      const approvedPath = join(approvalsDir, `${checkpointId}.approved.json`);

      // Guard: pending file must exist — never write a dangling .approved.json
      const exists = await pendingExists(projectRoot, checkpointId);
      if (!exists) {
        process.stderr.write(
          chalk.red(`No pending checkpoint found: ${checkpointId}\n`) +
            `  Expected: .bober/approvals/${checkpointId}.pending.json\n`,
        );
        process.exitCode = 1;
        return;
      }

      let editDelta: unknown;
      if (opts.edit) {
        try {
          editDelta = await readFile(opts.edit, "utf-8");
        } catch (err) {
          process.stderr.write(
            chalk.red(`Failed to read --edit file: ${opts.edit}\n`) +
              `  ${err instanceof Error ? err.message : String(err)}\n`,
          );
          process.exitCode = 1;
          return;
        }
      }

      const payload = {
        approvedAt: new Date().toISOString(),
        approverId: resolveApprover(),
        ...(editDelta !== undefined ? { editDelta } : {}),
      };

      await writeFile(
        approvedPath,
        JSON.stringify(payload, null, 2) + "\n",
        "utf-8",
      );

      process.stdout.write(
        chalk.green(`Approved checkpoint: ${checkpointId}\n`),
      );
    });
}
