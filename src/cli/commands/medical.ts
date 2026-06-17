/** `bober medical import <file>` — stream-ingest a health export (Phase 6, Sprint 5). */
/** `bober medical whoop sync` — WHOOP device-connection sync (Phase 6, Sprint 3). */
import { join } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";

import { findProjectRoot, ensureDir } from "../../utils/fs.js";
import { loadConfig } from "../../config/loader.js";
import { HealthDataStore } from "../../medical/health-store.js";
import {
  IngestionNormalizer,
  StoreObservationSink,
} from "../../medical/ingestion.js";
import { AppleHealthAdapter } from "../../medical/adapters/apple-health.js";
import { EgressGuard } from "../../medical/egress.js";
import { WhoopTokenStore } from "../../medical/whoop/whoop-token.js";
import { WhoopClient } from "../../medical/whoop/whoop-client.js";
import { WhoopSyncAdapter } from "../../medical/whoop/whoop-sync.js";
import { AuditLog } from "../../medical/audit.js";

// ── Root resolver ─────────────────────────────────────────────────────

async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}

// ── WhoopSync deps injection (for testability) ────────────────────────

/** Injectable dependencies for runWhoopSync — production callers pass undefined. */
export interface WhoopSyncDeps {
  /** Override the WhoopClient (e.g. fixture client in tests). */
  client?: WhoopClient;
  /** Override the current time ISO string (default: new Date().toISOString()). */
  nowIso?: string;
}

/**
 * Core logic for `bober medical whoop sync`.
 * Extracted so tests can inject fixture deps without module-level mocking.
 * The CLI .action() calls this with no deps (production).
 */
export async function runWhoopSync(
  projectRoot: string,
  opts: { since?: string },
  deps: WhoopSyncDeps = {},
): Promise<void> {
  let store: HealthDataStore | undefined;
  try {
    const config = await loadConfig(projectRoot);
    const egress = EgressGuard.fromConfig(config);

    // axis-off branch: clear message, exit 1, NEVER construct WhoopClient (sc-3-5)
    if (!egress.isAllowed("device-connection")) {
      process.stderr.write(
        chalk.red(
          "device-connection egress not enabled — set medical.egress.deviceConnection: true in bober.config.json\n",
        ),
      );
      process.exitCode = 1;
      return;
    }

    const tokenStore = new WhoopTokenStore(projectRoot);

    // credential check: throws "set WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET" (sc-3-6)
    try {
      tokenStore.clientCredentials();
    } catch (e) {
      process.stderr.write(
        chalk.red(`${e instanceof Error ? e.message : String(e)}\n`),
      );
      process.exitCode = 1;
      return;
    }

    // refresh-token check (sc-3-6)
    if ((await tokenStore.readRefreshToken()) === undefined) {
      process.stderr.write(
        chalk.red(
          "WHOOP not yet authorised — run `bober medical whoop authorize` first.\n",
        ),
      );
      process.exitCode = 1;
      return;
    }

    // window: --since or now-7d; clock read ONLY here at the CLI boundary
    const nowIso = deps.nowIso ?? new Date().toISOString();
    const endIso = nowIso;
    const startIso =
      opts.since ??
      new Date(new Date(nowIso).getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const medicalDir = join(projectRoot, ".bober", "medical");
    await ensureDir(medicalDir);

    store = new HealthDataStore(join(medicalDir, "health.db"));
    const client = deps.client ?? new WhoopClient(egress, tokenStore);
    const adapter = new WhoopSyncAdapter(client);
    const sink = new StoreObservationSink(store);

    const result = await adapter.sync({ startIso, endIso }, sink);

    // Audit entry — IDs/enums only (never record counts or health values — PHI rule)
    await new AuditLog(projectRoot).append({ tIso: endIso, event: "ingest" });

    process.stdout.write(chalk.green("WHOOP sync complete\n"));
    process.stdout.write(`  records parsed: ${result.recordsParsed}\n`);
    process.stdout.write(`  new rows:       ${result.newRows}\n`);
  } catch (err) {
    process.stderr.write(
      chalk.red(
        `Failed to sync WHOOP: ${err instanceof Error ? err.message : String(err)}\n`,
      ),
    );
    process.exitCode = 1;
  } finally {
    store?.close(); // always close — even if sync threw mid-pagination (sc-3-8)
  }
}

// ── registerMedicalCommand ────────────────────────────────────────────

/**
 * Register the `bober medical` command tree.
 * Provides `medical import <file>` and `medical whoop sync [--since <iso>]`.
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

  // ── medical whoop sync ────────────────────────────────────────────
  const whoopCmd = medicalCmd
    .command("whoop")
    .description("WHOOP device-connection sync (ADR-1)");

  whoopCmd
    .command("sync")
    .description(
      "Sync WHOOP recovery/sleep/cycle/workout into the medical health store",
    )
    .option("--since <iso>", "ISO-8601 window start (default: last 7 days)")
    .action(async (opts: { since?: string }) => {
      const projectRoot = await resolveRoot();
      await runWhoopSync(projectRoot, opts);
    });
}
