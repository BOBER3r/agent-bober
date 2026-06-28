/** `bober medical import <file>` — stream-ingest a health export (Phase 6, Sprint 5). */
/** `bober medical whoop sync` — WHOOP device-connection sync (Phase 6, Sprint 3). */
/** `bober medical import-labs <pdf>` — lab PDF ingest: fail-closed cloud-inference gate + vault + audit (Sprint 3). */
/** `bober medical review` — deterministic proactive trend review pass (spec-20260628-medical-analysis Sprint 1). */
import { readFile } from "node:fs/promises";
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
import { parseLabPdf } from "../../medical/lab-pdf-parser.js";
import { writeLabNote } from "../../medical/lab-note.js";
import { reindexLabNotes } from "../../medical/lab-reindex.js";
import { buildMedicalInferenceClient } from "../../medical/inference.js";
import { runSupplementAdd, runSupplementList } from "../../medical/supplements.js";
import { runProfileShow, runProfileSet } from "../../medical/profile.js";
import { runProactiveReview } from "../../medical/analysis/review-pass.js";
import { generateRecommendation } from "../../medical/recommend/recommend.js";

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

// ── ImportLabs deps injection (for testability) ───────────────────────

/** Injectable dependencies for runImportLabs — production callers pass undefined. */
export interface ImportLabsDeps {
  /** Override the PDF parser (e.g. fixture parser in tests). */
  parse?: typeof parseLabPdf;
  /** Override the current time ISO string (default: new Date().toISOString()). */
  nowIso?: string;
}

/**
 * Core logic for `bober medical import-labs <pdf>`.
 * Extracted so tests can inject fixture deps without module-level mocking.
 * The CLI .action() calls this with no deps (production).
 *
 * LOAD-BEARING ORDER (ADR-6 / sc-3-3):
 *   1. loadConfig + EgressGuard.fromConfig
 *   2. cloud-inference axis check — exits 1 BEFORE any readFile or client build
 *   3. buildMedicalInferenceClient
 *   4. readFile(pdfPath) + parse(pdfBytes)
 *   5. writeLabNote per marker + reindexLabNotes into HealthDataStore (dedup)
 *   6. AuditLog.append (IDs/enums only — PHI rule)
 *   7. finally: store?.close()
 */
export async function runImportLabs(
  projectRoot: string,
  pdfPath: string,
  deps: ImportLabsDeps = {},
  opts: { vault?: string } = {},
): Promise<void> {
  let store: HealthDataStore | undefined;
  try {
    const config = await loadConfig(projectRoot);
    const egress = EgressGuard.fromConfig(config);

    // axis-off branch: clear message, exit 1, NEVER read the PDF or build any client (FAIL CLOSED — sc-3-3)
    if (!egress.isAllowed("cloud-inference")) {
      process.stderr.write(
        chalk.red(
          "cloud-inference egress not enabled — set medical.egress.cloudInference: true in bober.config.json\n",
        ),
      );
      process.exitCode = 1;
      return;
    }

    const { client, model } = buildMedicalInferenceClient(config, egress);

    const pdfBytes = await readFile(pdfPath);
    const parse = deps.parse ?? parseLabPdf;
    const report = await parse(pdfBytes, { client, model });

    const nowIso = deps.nowIso ?? new Date().toISOString();
    const medicalDir = join(projectRoot, ".bober", "medical");
    await ensureDir(medicalDir);
    const vaultDir = opts.vault ?? medicalDir;

    store = new HealthDataStore(join(medicalDir, "health.db"));

    for (const marker of report.markers) {
      await writeLabNote(vaultDir, marker, {
        panel: report.panel,
        collectedAtIso: report.collectedAtIso,
        source: "lab-pdf",
      });
    }
    const newRows = await reindexLabNotes(vaultDir, store);

    // Audit entry — IDs/enums only (no values, panel names, counts, or PHI — audit.ts:1)
    await new AuditLog(projectRoot).append({ tIso: nowIso, event: "ingest" });

    process.stdout.write(chalk.green("Lab import complete\n"));
    process.stdout.write(`  records parsed: ${report.markers.length}\n`);
    process.stdout.write(`  new rows:       ${newRows}\n`);
  } catch (err) {
    process.stderr.write(
      chalk.red(
        `Failed to import labs: ${err instanceof Error ? err.message : String(err)}\n`,
      ),
    );
    process.exitCode = 1;
  } finally {
    store?.close();
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

  // ── medical import-labs ──────────────────────────────────────────
  medicalCmd
    .command("import-labs <pdf>")
    .description("Parse a lab PDF and ingest results into the medical health store")
    .option("--vault <dir>", "vault dir (default: under .bober/medical)")
    .action(async (pdf: string, opts: { vault?: string }) => {
      const projectRoot = await resolveRoot();
      await runImportLabs(projectRoot, pdf, {}, opts);
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

  // ── medical supplements ───────────────────────────────────────────────
  const suppCmd = medicalCmd
    .command("supplements")
    .description("Manage supplements list in FactStore (scope: medical)");

  suppCmd
    .command("add <name>")
    .description(
      "Reconcile a supplement into FactStore (creates or noops on duplicate)",
    )
    .option("--dose <d>", "dose string (default: unspecified)")
    .action(async (name: string, opts: { dose?: string }) => {
      const projectRoot = await resolveRoot();
      await runSupplementAdd(projectRoot, name, opts);
    });

  suppCmd
    .command("list")
    .description("Print supplements from the markdown-frontmatter file")
    .option(
      "--file <path>",
      "supplements markdown file (default: .bober/medical/supplements.md)",
    )
    .action(async (opts: { file?: string }) => {
      const projectRoot = await resolveRoot();
      await runSupplementList(projectRoot, opts);
    });

  // ── medical profile ───────────────────────────────────────────────────
  const profileCmd = medicalCmd
    .command("profile")
    .description(
      "Manage personalization profile (SOPS-encrypted profile.yaml)",
    );

  profileCmd
    .command("show")
    .description("Decrypt and display the current personalization profile")
    .option("--vault <dir>", "vault dir (default: .bober/medical under project root)")
    .action(async (opts: { vault?: string }) => {
      const projectRoot = await resolveRoot();
      await runProfileShow(projectRoot, opts);
    });

  profileCmd
    .command("set <key> <value>")
    .description("Update one profile field after Zod validation")
    .option("--vault <dir>", "vault dir (default: .bober/medical under project root)")
    .action(async (key: string, value: string, opts: { vault?: string }) => {
      const projectRoot = await resolveRoot();
      await runProfileSet(projectRoot, key, value, opts);
    });

  // ── medical review ────────────────────────────────────────────────────
  medicalCmd
    .command("review")
    .description(
      "Run the deterministic proactive trend review pass and write Finding notes + dashboard",
    )
    .action(async () => {
      const projectRoot = await resolveRoot();
      try {
        const config = await loadConfig(projectRoot);
        // Clock read ONLY here at the CLI boundary (mirrors medical.ts:97)
        const now = new Date().toISOString();
        const result = await runProactiveReview(projectRoot, config, { now });
        process.stdout.write(chalk.green(`Proactive review complete\n`));
        process.stdout.write(`  findings written: ${result.findingsWritten}\n`);
        process.stdout.write(`  dashboard:        ${result.dashboardPath}\n`);
      } catch (err) {
        process.stderr.write(
          chalk.red(
            `Failed to run review: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
        process.exitCode = 1; // MUST NOT throw (mirrors import action pattern at line 257-265)
      }
    });

  // ── medical recommend ─────────────────────────────────────────────────
  medicalCmd
    .command("recommend <question>")
    .description(
      "Generate a medical recommendation through the 4-lens judge panel and write a Finding note",
    )
    .option("--goal <g>", "optional health goal to include in the recommendation context")
    .action(async (question: string, opts: { goal?: string }) => {
      const projectRoot = await resolveRoot();
      try {
        const config = await loadConfig(projectRoot);
        // Clock read ONLY here at the CLI boundary (sc-3-7)
        const now = new Date().toISOString();
        const result = await generateRecommendation(projectRoot, config, {
          question,
          goal: opts.goal,
          now,
        });
        if (result.kind === "accepted") {
          process.stdout.write(chalk.green(`Recommendation accepted\n`));
          if (result.findingPath !== undefined) {
            process.stdout.write(`  finding: ${result.findingPath}\n`);
          }
        } else if (result.kind === "question") {
          process.stdout.write(chalk.yellow(`Recommendation flagged for review\n`));
          if (result.findingPath !== undefined) {
            process.stdout.write(`  finding: ${result.findingPath}\n`);
          }
        } else if (result.kind === "escalated") {
          process.stdout.write(chalk.red(`Escalated: ${result.cannedResponse ?? ""}\n`));
        } else {
          // refused
          process.stdout.write(
            chalk.yellow(`Recommendation refused: ${result.reason ?? ""}\n`),
          );
        }
      } catch (err) {
        process.stderr.write(
          chalk.red(
            `Failed to generate recommendation: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
        process.exitCode = 1; // MUST NOT throw — sc-3-7 exit 0 on normal outcomes
      }
    });
}
