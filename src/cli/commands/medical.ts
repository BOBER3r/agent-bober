/** `bober medical import <file>` — stream-ingest a health export (Phase 6, Sprint 5). */
import { join } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";

import { findProjectRoot, ensureDir } from "../../utils/fs.js";
import { HealthDataStore } from "../../medical/health-store.js";
import {
  IngestionNormalizer,
  StoreObservationSink,
} from "../../medical/ingestion.js";
import { AppleHealthAdapter } from "../../medical/adapters/apple-health.js";

// ── Root resolver ─────────────────────────────────────────────────────

async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}

// ── registerMedicalCommand ────────────────────────────────────────────

/**
 * Register the `bober medical` command tree.
 * Currently provides `medical import <file>`.
 * Mirrors registerFactsCommand (src/cli/commands/facts.ts).
 */
export function registerMedicalCommand(program: Command): void {
  const medicalCmd = program
    .command("medical")
    .description("Medical team utilities (health data import)");

  // ── medical import ────────────────────────────────────────────────
  medicalCmd
    .command("import <file>")
    .description(
      "Stream-import a health export file into the medical health store",
    )
    .action(async (file: string) => {
      const projectRoot = await resolveRoot();
      try {
        const medicalDir = join(projectRoot, ".bober", "medical");
        await ensureDir(medicalDir);
        const dbPath = join(medicalDir, "health.db");

        const store = new HealthDataStore(dbPath);
        try {
          const sink = new StoreObservationSink(store);
          const normalizer = new IngestionNormalizer(sink);
          normalizer.register(new AppleHealthAdapter());

          const result = await normalizer.importFile(file);

          process.stdout.write(chalk.green(`Imported ${file}\n`));
          process.stdout.write(`  records parsed: ${result.recordsParsed}\n`);
          process.stdout.write(`  new rows:       ${result.newRows}\n`);
        } finally {
          // Always close — mirrors facts.ts:132-134.
          store.close();
        }
      } catch (err) {
        process.stderr.write(
          chalk.red(
            `Failed to import: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
        // CLI handlers MUST NOT throw — set exitCode and return (facts.ts:135-142).
        process.exitCode = 1;
      }
    });
}
