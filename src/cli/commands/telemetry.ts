/**
 * `bober telemetry <status|purge|export>` — local telemetry inspection CLI.
 *
 * Subcommands:
 *   status  — print whether telemetry is enabled and recent event counts
 *   purge   — delete all .bober/telemetry/ files (requires confirmation)
 *   export  — concatenate every .bober/telemetry/*.jsonl to stdout
 *
 * Error handling: CLI handlers MUST NOT throw. They set process.exitCode=1
 * and return on all errors (Pattern C).
 *
 * Sprint 28 — src/cli/commands/telemetry.ts
 */

import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import prompts from "prompts";
import type { Command } from "commander";

import { findProjectRoot } from "../../utils/fs.js";
import { loadConfig } from "../../config/loader.js";

async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}

export function registerTelemetryCommand(program: Command): void {
  const telCmd = program
    .command("telemetry")
    .description("Inspect, export, or purge local telemetry events (opt-in, local-only)");

  // ── telemetry status ────────────────────────────────────────────────────
  telCmd
    .command("status")
    .description("Print whether telemetry is enabled and recent event counts by type")
    .action(async () => {
      const projectRoot = await resolveRoot();
      try {
        const config = await loadConfig(projectRoot);
        const enabled = config.telemetry?.enabled === true;
        process.stdout.write(
          `telemetry.enabled: ${enabled ? chalk.green("true") : chalk.gray("false")}\n`,
        );

        const telDir = join(projectRoot, ".bober", "telemetry");
        let files: string[];
        try {
          files = await readdir(telDir);
        } catch (err) {
          if ((err as { code?: string }).code === "ENOENT") {
            process.stdout.write(chalk.gray("No telemetry files found.\n"));
            return;
          }
          throw err;
        }

        const jsonlFiles = files.filter((f) => f.endsWith(".jsonl")).sort().reverse();
        if (jsonlFiles.length === 0) {
          process.stdout.write(chalk.gray("No telemetry files found.\n"));
          return;
        }

        // Tally event counts across all files.
        const counts = new Map<string, number>();
        let totalLines = 0;
        for (const file of jsonlFiles) {
          try {
            const raw = await readFile(join(telDir, file), "utf-8");
            const lines = raw.split("\n").filter(Boolean);
            for (const line of lines) {
              try {
                const parsed = JSON.parse(line) as { eventType?: string };
                const et = parsed.eventType ?? "<unknown>";
                counts.set(et, (counts.get(et) ?? 0) + 1);
                totalLines++;
              } catch {
                // Skip malformed lines
              }
            }
          } catch {
            // Skip unreadable files
          }
        }

        process.stdout.write(
          chalk.bold(`\nEvent counts (${totalLines} total across ${jsonlFiles.length} file(s)):\n`),
        );
        const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
        for (const [eventType, count] of sorted) {
          process.stdout.write(`  ${chalk.cyan(eventType)}: ${count}\n`);
        }
      } catch (err) {
        process.stderr.write(
          chalk.red(
            `Failed to read telemetry status: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
        process.exitCode = 1;
      }
    });

  // ── telemetry purge ─────────────────────────────────────────────────────
  telCmd
    .command("purge")
    .description("Delete all .bober/telemetry/ files (requires confirmation)")
    .action(async () => {
      const projectRoot = await resolveRoot();
      const telDir = join(projectRoot, ".bober", "telemetry");
      try {
        const answer = await prompts({
          type: "confirm",
          name: "ok",
          message: `Delete all telemetry files in ${telDir}?`,
          initial: false,
        });
        // prompts returns { ok: undefined } on SIGINT — treat as abort.
        if (!answer.ok) {
          process.stdout.write(chalk.gray("Aborted.\n"));
          return;
        }
        await rm(telDir, { recursive: true, force: true });
        process.stdout.write(chalk.yellow(`Purged ${telDir}.\n`));
      } catch (err) {
        process.stderr.write(
          chalk.red(
            `Failed to purge telemetry: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
        process.exitCode = 1;
      }
    });

  // ── telemetry export ────────────────────────────────────────────────────
  telCmd
    .command("export")
    .description("Print all telemetry events as JSONL to stdout for offline analysis")
    .action(async () => {
      const projectRoot = await resolveRoot();
      const telDir = join(projectRoot, ".bober", "telemetry");
      try {
        let files: string[];
        try {
          files = await readdir(telDir);
        } catch (err) {
          if ((err as { code?: string }).code === "ENOENT") {
            // No telemetry directory — nothing to export, that's OK.
            return;
          }
          throw err;
        }

        const jsonlFiles = files.filter((f) => f.endsWith(".jsonl")).sort();
        for (const file of jsonlFiles) {
          try {
            const raw = await readFile(join(telDir, file), "utf-8");
            process.stdout.write(raw);
          } catch {
            // Skip unreadable files silently
          }
        }
      } catch (err) {
        process.stderr.write(
          chalk.red(
            `Failed to export telemetry: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
        process.exitCode = 1;
      }
    });
}
