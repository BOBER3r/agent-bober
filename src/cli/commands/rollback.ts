/**
 * `bober rollback <incidentId>` — roll back executed changes for an incident.
 *
 * Each rollback step is itself a risky action that passes through the Sprint 20
 * gate independently. Plan presentation is unconditional (even in autopilot mode)
 * because rollback is destructive and requires explicit user consent.
 *
 * Flags:
 *   --since <changeId>  Roll back only changes executed after this changeId.
 *   --dry-run           Print the plan without executing anything.
 *   --json              Emit plan as JSON instead of human-readable table.
 *
 * Exit codes:
 *   0 — rollback completed (all steps succeeded) or --dry-run.
 *   1 — rollback halted (a step failed) or planning error.
 *
 * Sprint 21 — src/cli/commands/rollback.ts
 */

import chalk from "chalk";
import prompts from "prompts";
import type { Command } from "commander";

import { findProjectRoot } from "../../utils/fs.js";
import {
  planRollback,
  executeRollback,
  presentPlan,
} from "../../incident/rollback.js";

async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}

export function registerRollbackCommand(program: Command): void {
  program
    .command("rollback <incidentId>")
    .description(
      "Roll back executed changes for an incident — each step gated as a risky action",
    )
    .option(
      "--since <changeId>",
      "Roll back only changes executed after this changeId",
    )
    .option("--dry-run", "Print the plan without executing anything")
    .option("--json", "Emit plan as JSON instead of a human-readable table")
    .action(
      async (
        incidentId: string,
        opts: { since?: string; dryRun?: boolean; json?: boolean },
      ) => {
        const projectRoot = await resolveRoot();

        // Plan phase.
        let plan;
        try {
          plan = await planRollback(
            projectRoot,
            incidentId,
            opts.since !== undefined ? { since: opts.since } : {},
          );
        } catch (err) {
          process.stderr.write(
            chalk.red(
              `Failed to plan rollback: ${err instanceof Error ? err.message : String(err)}\n`,
            ),
          );
          process.exitCode = 1;
          return;
        }

        // Presentation phase — always, even in autopilot mode.
        if (opts.json) {
          process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
        } else {
          process.stdout.write(presentPlan(plan));
          // Surface unrollbackable warnings loudly on stderr too.
          for (const w of plan.warnings) {
            process.stderr.write(chalk.yellow(`WARN: ${w}\n`));
          }
        }

        // --dry-run: print plan, then stop. No execution, no confirmation prompt.
        if (opts.dryRun) {
          process.stdout.write(chalk.cyan("(--dry-run) No changes executed.\n"));
          return;
        }

        // No steps → nothing to do.
        if (plan.steps.length === 0) {
          process.stdout.write(chalk.yellow("No rollbackable steps. Nothing to do.\n"));
          return;
        }

        // Confirmation prompt (unconditional unless --dry-run).
        const { confirm } = await prompts({
          type: "confirm",
          name: "confirm",
          message: `Proceed with ${plan.steps.length}-step rollback? Each step still requires individual approval.`,
          initial: false,
        });
        if (!confirm) {
          process.stdout.write(chalk.yellow("Rollback cancelled.\n"));
          return;
        }

        // Execution phase.
        const result = await executeRollback(projectRoot, incidentId, plan);

        if (result.failed > 0) {
          process.stderr.write(
            chalk.red(
              `Rollback HALTED. Succeeded: ${result.succeeded}/${plan.steps.length}. ` +
                `Remaining unrolled: ${result.remaining.map((s) => s.originalChangeId).join(", ")}\n`,
            ),
          );
          process.exitCode = 1;
        } else {
          process.stdout.write(
            chalk.green(`Rollback complete: ${result.succeeded}/${plan.steps.length} steps.\n`),
          );
        }
      },
    );
}
