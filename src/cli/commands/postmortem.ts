/**
 * `bober postmortem generate <incidentId>` — synthesize (or re-synthesize)
 *   the postmortem.md for an incident from its artifacts.
 * `bober postmortem show <incidentId>` — print the postmortem.md to stdout.
 *
 * Nested subcommand pattern mirrors src/cli/commands/audit-show.ts.
 *
 * Sprint 23 — src/cli/commands/postmortem.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";

import { findProjectRoot } from "../../utils/fs.js";
import { generatePostmortem } from "../../incident/postmortem.js";

async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}

export function registerPostmortemCommand(program: Command): void {
  const pmCmd = program
    .command("postmortem")
    .description("Inspect or (re)generate incident postmortems");

  // ── postmortem generate <incidentId> ──
  pmCmd
    .command("generate <incidentId>")
    .description("(Re)synthesize postmortem.md for an incident from its artifacts")
    .action(async (incidentId: string) => {
      const projectRoot = await resolveRoot();
      try {
        const result = await generatePostmortem(projectRoot, incidentId);
        process.stdout.write(
          chalk.green(`Postmortem written: ${result.path}\n`) +
            chalk.gray(
              `  citations: ${result.citationCount}, redactions: ${result.redactionCount}` +
                (result.shallowWarning ? ", 5-Whys: SHALLOW (review required)" : "") +
                "\n",
            ),
        );
      } catch (err) {
        if ((err as { code?: string }).code === "ENOENT") {
          process.stderr.write(
            chalk.yellow(
              `No incident found at .bober/incidents/${incidentId}/.\n`,
            ),
          );
          process.exitCode = 1;
          return;
        }
        process.stderr.write(
          chalk.red(
            `Failed to generate postmortem: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
        process.exitCode = 1;
      }
    });

  // ── postmortem show <incidentId> ──
  pmCmd
    .command("show <incidentId>")
    .description("Print the postmortem.md for an incident to stdout")
    .action(async (incidentId: string) => {
      const projectRoot = await resolveRoot();
      const path = join(projectRoot, ".bober", "incidents", incidentId, "postmortem.md");
      try {
        const content = await readFile(path, "utf-8");
        process.stdout.write(content);
      } catch (err) {
        if ((err as { code?: string }).code === "ENOENT") {
          process.stderr.write(
            chalk.yellow(
              `No postmortem found at ${path}. Generate it first with: bober postmortem generate ${incidentId}\n`,
            ),
          );
          process.exitCode = 1;
          return;
        }
        throw err;
      }
    });
}
