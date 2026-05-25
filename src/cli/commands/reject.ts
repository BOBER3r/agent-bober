/**
 * `agent-bober reject <checkpointId> --feedback <text>` — reject a pending
 * disk-marker checkpoint by writing .bober/approvals/<id>.rejected.json.
 *
 * Stateless: does not talk to the orchestrator; communicates via filesystem.
 * Works from any cwd inside the project (findProjectRoot() walks upward).
 *
 * Sprint 9 — colocated CLI command per Sprint 8/10 precedent.
 */

import { writeFile } from "node:fs/promises";
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
 * Resolve the rejector identity from the environment.
 * Uses $USER (macOS/Linux) or $USERNAME (Windows), falling back to "unknown".
 */
export function resolveRejecter(): string {
  return process.env["USER"] ?? process.env["USERNAME"] ?? "unknown";
}

export function registerRejectCommand(program: Command): void {
  program
    .command("reject <checkpointId>")
    .description("Reject a pending checkpoint by writing the .rejected.json marker")
    .requiredOption("--feedback <text>", "Why the checkpoint is rejected")
    .action(async (checkpointId: string, opts: { feedback: string }) => {
      const projectRoot = await resolveRoot();
      const approvalsDir = join(projectRoot, ".bober", "approvals");
      const rejectedPath = join(approvalsDir, `${checkpointId}.rejected.json`);

      // Guard: pending file must exist — never write a dangling .rejected.json
      const exists = await pendingExists(projectRoot, checkpointId);
      if (!exists) {
        process.stderr.write(
          chalk.red(`No pending checkpoint found: ${checkpointId}\n`) +
            `  Expected: .bober/approvals/${checkpointId}.pending.json\n`,
        );
        process.exitCode = 1;
        return;
      }

      const payload = {
        rejectedAt: new Date().toISOString(),
        rejecterId: resolveRejecter(),
        feedback: opts.feedback,
      };

      await writeFile(
        rejectedPath,
        JSON.stringify(payload, null, 2) + "\n",
        "utf-8",
      );

      process.stdout.write(
        chalk.green(`Rejected checkpoint: ${checkpointId}\n`),
      );
    });
}
