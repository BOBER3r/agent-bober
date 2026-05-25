/**
 * `bober config migrate` — write all new schema fields with default values into
 *   bober.config.json. Informative; back-compat parsing handles missing fields
 *   transparently. Useful for users who want their config file to be self-documenting.
 *
 * Sprint 28 — src/cli/commands/config.ts
 */

import { readFile, writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";

import { findProjectRoot } from "../../utils/fs.js";

async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}

export function registerConfigCommand(program: Command): void {
  const cfgCmd = program
    .command("config")
    .description("Inspect and migrate bober.config.json");

  cfgCmd
    .command("migrate")
    .description("Add all new schema fields with default values to bober.config.json")
    .option("--dry-run", "Print the merged config without writing")
    .action(async (opts: { dryRun?: boolean }) => {
      const projectRoot = await resolveRoot();
      const configPath = join(projectRoot, "bober.config.json");
      try {
        const raw = await readFile(configPath, "utf-8");
        const parsed = JSON.parse(raw) as Record<string, unknown>;

        // Add new sections explicitly, preserving any existing values.
        const migrated: Record<string, unknown> = {
          ...parsed,
          pipeline: {
            mode: "autopilot",
            checkpointOverrides: {},
            allowAutopilotRiskyActions: false,
            ...((parsed.pipeline as object) ?? {}),
          },
          observability: {
            providers: [],
            ...((parsed.observability as object) ?? {}),
          },
          incident: {
            autoPostmortem: true,
            ...((parsed.incident as object) ?? {}),
          },
          telemetry: {
            enabled: false,
            ...((parsed.telemetry as object) ?? {}),
          },
        };

        const out = JSON.stringify(migrated, null, 2) + "\n";

        if (opts.dryRun) {
          process.stdout.write(out);
          return;
        }

        // Backup then write.
        await copyFile(configPath, configPath + ".bak");
        await writeFile(configPath, out, "utf-8");
        process.stdout.write(
          chalk.green(`Migrated ${configPath} (backup: ${configPath}.bak)\n`),
        );
      } catch (err) {
        if ((err as { code?: string }).code === "ENOENT") {
          process.stderr.write(
            chalk.yellow(`No bober.config.json found at ${configPath}.\n`),
          );
          process.exitCode = 1;
          return;
        }
        process.stderr.write(
          chalk.red(
            `Failed to migrate: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
        process.exitCode = 1;
      }
    });
}
