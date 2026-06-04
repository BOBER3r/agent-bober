import { join } from "node:path";
import type { Command } from "commander";
import chalk from "chalk";

import { loadConfig } from "../../config/loader.js";
import { findProjectRoot } from "../../utils/fs.js";
import { TokensavePrereqCheck } from "../../graph/prereq.js";
import { TokensaveCli } from "../../graph/cli.js";
import { GraphArtifactStore } from "../../graph/artifact-store.js";

// ── Architecture doc link ──────────────────────────────────────────

const ARCH_DOC_PATH =
  ".bober/architecture/arch-20260524-port-code-review-graph-architecture.md";

// ── Disabled guard ────────────────────────────────────────────────

const DISABLED_MSG =
  "Graph integration is disabled. Enable via `graph.enabled: true` in bober.config.json." +
  ` See: ${ARCH_DOC_PATH}`;

// ── Helpers ───────────────────────────────────────────────────────

async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}

/**
 * Register the `graph` subcommand on the given root program.
 * Phase 1 (sprint 1): `check-prereq`
 * Phase 2 (sprint 10): `init`, `sync`, `status`
 */
export function registerGraphCommand(program: Command): void {
  const graph = program
    .command("graph")
    .description("Code-graph (tokensave) integration commands");

  // ── check-prereq ─────────────────────────────────────────────────
  graph
    .command("check-prereq")
    .description("Detect tokensave and report version compatibility (JSON)")
    .action(async () => {
      const checker = new TokensavePrereqCheck();
      const result = await checker.check();
      // Plain JSON to stdout — no chalk, no logger
      process.stdout.write(JSON.stringify(result) + "\n");
      if (!result.ok) process.exitCode = 1;
    });

  // ── init ─────────────────────────────────────────────────────────
  graph
    .command("init")
    .description("Initialise the code graph for this project (runs tokensave init)")
    .action(async () => {
      const projectRoot = await resolveRoot();

      // Load config
      let config;
      try {
        config = await loadConfig(projectRoot);
      } catch {
        // No config — treat as disabled
        process.stderr.write(DISABLED_MSG + "\n");
        process.exitCode = 1;
        return;
      }

      const graphCfg = config.graph;
      if (!graphCfg || graphCfg.enabled === false) {
        process.stderr.write(DISABLED_MSG + "\n");
        process.exitCode = 1;
        return;
      }

      // Prereq check
      const checker = new TokensavePrereqCheck(graphCfg.tokensavePath ?? "tokensave");
      const prereq = await checker.check();
      if (!prereq.ok) {
        process.stderr.write(
          `tokensave is not available. To install:\n  ${prereq.hint}\n`,
        );
        process.exitCode = 2;
        return;
      }

      const store = new GraphArtifactStore(projectRoot);
      await store.ensureLayout();

      const cli = new TokensaveCli(
        projectRoot,
        store,
        graphCfg.tokensavePath ?? "tokensave",
      );

      try {
        await cli.init({
          cwd: projectRoot,
          languageTier: graphCfg.languageTier ?? "core",
        });
      } catch (err) {
        process.stderr.write(
          `Graph init failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = 1;
        return;
      }

      // Write initial manifest
      const existingManifest = await store.readManifest();
      const now = new Date().toISOString();
      await store.writeManifest({
        schemaVersion: 1,
        createdAt: existingManifest?.createdAt ?? now,
        indexedFileCount: existingManifest?.indexedFileCount ?? 0,
        languageTier: existingManifest?.languageTier ?? graphCfg.languageTier ?? "core",
        lastSyncedHeadSha: existingManifest?.lastSyncedHeadSha ?? null,
        pendingFiles: existingManifest?.pendingFiles ?? [],
        // always overwrite with fresh values
        tokensaveVersion: prereq.version,
        lastSyncAt: now,
      });

      process.stdout.write(
        chalk.green("Graph initialised successfully.\n"),
      );
      process.stdout.write(
        `  Manifest written to: ${join(projectRoot, graphCfg.manifestPath ?? ".bober/graph/manifest.json")}\n`,
      );
    });

  // ── sync ──────────────────────────────────────────────────────────
  graph
    .command("sync")
    .description("Sync the code graph index (re-indexes changed files)")
    .option("--force", "Full re-index regardless of changes")
    .action(async (opts: { force?: boolean }) => {
      const projectRoot = await resolveRoot();

      let config;
      try {
        config = await loadConfig(projectRoot);
      } catch {
        process.stderr.write(DISABLED_MSG + "\n");
        process.exitCode = 1;
        return;
      }

      const graphCfg = config.graph;
      if (!graphCfg || graphCfg.enabled === false) {
        process.stderr.write(DISABLED_MSG + "\n");
        process.exitCode = 1;
        return;
      }

      // Prereq check
      const checker = new TokensavePrereqCheck(graphCfg.tokensavePath ?? "tokensave");
      const prereq = await checker.check();
      if (!prereq.ok) {
        process.stderr.write(
          `tokensave is not available. To install:\n  ${prereq.hint}\n`,
        );
        process.exitCode = 1;
        return;
      }

      const store = new GraphArtifactStore(projectRoot);
      await store.ensureLayout();

      const cli = new TokensaveCli(
        projectRoot,
        store,
        graphCfg.tokensavePath ?? "tokensave",
      );

      // --force → `tokensave sync --force .` re-indexes everything;
      // otherwise an incremental sync of the project root.
      const paths: string[] = opts.force ? ["--force", "."] : ["."];

      try {
        const result = await cli.sync(paths, graphCfg.syncTimeoutMs ?? 2000);

        // Update manifest
        const existing = await store.readManifest();
        const now = new Date().toISOString();
        await store.writeManifest({
          schemaVersion: 1,
          createdAt: existing?.createdAt ?? now,
          languageTier: existing?.languageTier ?? graphCfg.languageTier ?? "core",
          lastSyncedHeadSha: existing?.lastSyncedHeadSha ?? null,
          // always overwrite with fresh sync values
          tokensaveVersion: prereq.version,
          lastSyncAt: now,
          indexedFileCount: result.indexed,
          pendingFiles: [],
        });

        process.stdout.write(
          chalk.green(`Graph sync complete. Indexed: ${result.indexed} files.\n`),
        );
      } catch (err) {
        process.stderr.write(
          `Graph sync failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = 1;
      }
    });

  // ── status ────────────────────────────────────────────────────────
  graph
    .command("status")
    .description("Show code graph status")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const projectRoot = await resolveRoot();

      let config;
      try {
        config = await loadConfig(projectRoot);
      } catch {
        process.stderr.write(DISABLED_MSG + "\n");
        process.exitCode = 1;
        return;
      }

      const graphCfg = config.graph;
      if (!graphCfg || graphCfg.enabled === false) {
        process.stderr.write(DISABLED_MSG + "\n");
        process.exitCode = 1;
        return;
      }

      // Prereq check (non-fatal — just note it in status)
      const checker = new TokensavePrereqCheck(graphCfg.tokensavePath ?? "tokensave");
      const prereq = await checker.check();

      const store = new GraphArtifactStore(projectRoot);
      const manifest = await store.readManifest();
      const staleness = await store.staleness();

      // Attempt to get live status from tokensave binary
      let liveStatus = { ready: false, indexedFileCount: 0, tokensaveVersion: "" };
      if (prereq.ok) {
        const cli = new TokensaveCli(
          projectRoot,
          null,
          graphCfg.tokensavePath ?? "tokensave",
        );
        try {
          liveStatus = await cli.status();
        } catch {
          // Best-effort; fall through to manifest data
        }
      }

      const output = {
        ready: liveStatus.ready,
        indexedFileCount: liveStatus.indexedFileCount || manifest?.indexedFileCount || 0,
        tokensaveVersion: liveStatus.tokensaveVersion || manifest?.tokensaveVersion || "",
        lastSyncedHeadSha: manifest?.lastSyncedHeadSha ?? null,
        stale: staleness.stale,
      };

      if (opts.json) {
        process.stdout.write(JSON.stringify(output, null, 2) + "\n");
        return;
      }

      // Human-readable
      const readyStr = output.ready ? chalk.green("ready") : chalk.yellow("not ready");
      const staleStr = output.stale ? chalk.yellow(" (stale)") : "";
      process.stdout.write(`Status:          ${readyStr}${staleStr}\n`);
      process.stdout.write(`Indexed files:   ${output.indexedFileCount}\n`);
      process.stdout.write(
        `Tokensave:       ${output.tokensaveVersion || chalk.gray("(unknown)")}\n`,
      );
      process.stdout.write(
        `Last HEAD SHA:   ${output.lastSyncedHeadSha ?? chalk.gray("(none)")}\n`,
      );
    });
}
