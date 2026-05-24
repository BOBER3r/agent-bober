/**
 * `agent-bober onboard` — generate onboarding documentation from the code graph.
 *
 * Instantiates a short-lived GraphClient + OnboardingComposer, queries the
 * code graph for all required data, renders 5 markdown artifacts, and writes
 * them to .bober/onboarding/. Prints a summary table on success.
 */
import { join, relative } from "node:path";
import { stat } from "node:fs/promises";

import chalk from "chalk";
import type { Command } from "commander";

import { loadConfig } from "../../config/loader.js";
import { findProjectRoot } from "../../utils/fs.js";
import { TokensavePrereqCheck } from "../../graph/prereq.js";
import { GraphArtifactStore } from "../../graph/artifact-store.js";
import { TokensaveMcpClient } from "../../graph/mcp-client.js";
import { IncidentLog } from "../../graph/incidents.js";
import { GraphFallback } from "../../graph/fallback.js";
import { GraphClient } from "../../graph/client.js";
import { OnboardingComposer } from "../../graph/onboarding-composer.js";
import type { OnboardingInputs } from "../../graph/types.js";

// ── Architecture doc link ──────────────────────────────────────────

const ARCH_DOC_PATH =
  ".bober/architecture/arch-20260524-port-code-review-graph-architecture.md";

const DISABLED_MSG =
  "Graph integration is disabled. Enable via `graph.enabled: true` in bober.config.json." +
  ` See: ${ARCH_DOC_PATH}`;

// ── Helper ────────────────────────────────────────────────────────

async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}

// ── Command ───────────────────────────────────────────────────────

export function registerOnboardCommand(program: Command): void {
  program
    .command("onboard")
    .description(
      "Generate onboarding documentation from the code graph (.bober/onboarding/)",
    )
    .action(async () => {
      const projectRoot = await resolveRoot();

      // Load config
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

      const incidents = new IncidentLog(projectRoot);
      const fallback = new GraphFallback("dual");

      // Spawn a short-lived MCP client for the duration of this command
      const mcpClient = new TokensaveMcpClient(
        projectRoot,
        graphCfg,
        incidents,
        graphCfg.tokensavePath ?? "tokensave",
      );

      process.stdout.write(chalk.cyan("Starting graph engine...\n"));

      try {
        await mcpClient.start();
      } catch (err) {
        process.stderr.write(
          `Failed to start graph engine: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = 1;
        return;
      }

      try {
        const graphClient = new GraphClient(
          projectRoot,
          mcpClient,
          store,
          fallback,
          incidents,
          graphCfg,
        );

        process.stdout.write(chalk.cyan("Querying code graph...\n"));

        // Gather all inputs for the onboarding composer
        const [hotspotsResult, deadCodeResult, circularResult, largestResult, filesResult] =
          await Promise.all([
            graphClient.search("hotspots", { limit: 20 }),
            graphClient.search("dead code unused", { limit: 20 }),
            graphClient.search("circular dependency", { limit: 10 }),
            graphClient.search("largest complex", { limit: 20, kind: "function" }),
            graphClient.search("module public api", { limit: 50 }),
          ]);

        // Get manifest for status
        const manifest = await store.readManifest();

        // Build onboarding inputs from graph results
        const inputs: OnboardingInputs = {
          status: {
            tokensaveVersion: manifest?.tokensaveVersion ?? prereq.version ?? "",
            indexedFileCount: manifest?.indexedFileCount ?? 0,
          },
          hotspots: hotspotsResult.ok
            ? hotspotsResult.data.map((h) => ({
                symbol: h.node.symbol,
                file: h.node.file,
                line: h.node.line,
                score: h.score,
                reason: h.snippet || undefined,
              }))
            : [],
          deadCode: deadCodeResult.ok
            ? deadCodeResult.data.map((h) => ({
                symbol: h.node.symbol,
                file: h.node.file,
                line: h.node.line,
              }))
            : [],
          circular: circularResult.ok
            ? circularResult.data.map((h) => ({
                cycle: [h.node.symbol],
              }))
            : [],
          largest: largestResult.ok
            ? largestResult.data.map((h) => ({
                symbol: h.node.symbol,
                file: h.node.file,
                line: h.node.line,
                loc: 0,
              }))
            : [],
          moduleApis: filesResult.ok
            ? [
                {
                  module: "default",
                  symbols: filesResult.data.map((h) => ({
                    name: h.node.symbol,
                    file: h.node.file,
                    line: h.node.line,
                    hasInternalCallers: true,
                  })),
                },
              ]
            : [],
          files: filesResult.ok
            ? filesResult.data.map((h) => ({
                path: h.node.file,
                symbols: 1,
              }))
            : [],
        };

        // Render and write artifacts
        const composer = new OnboardingComposer();
        const artifacts = composer.render(inputs);

        const outputDir = join(projectRoot, ".bober", "onboarding");
        process.stdout.write(chalk.cyan(`Writing artifacts to ${outputDir}...\n`));

        await composer.writeAll(artifacts, outputDir);

        // Print summary table
        const files: Array<[string, string]> = [
          ["README.md", artifacts.readme],
          ["architecture-overview.md", artifacts.architectureOverview],
          ["hotspots.md", artifacts.hotspots],
          ["knowledge-gaps.md", artifacts.knowledgeGaps],
          ["communities.md", artifacts.communities],
        ];

        process.stdout.write("\n");
        process.stdout.write(chalk.bold("Onboarding artifacts written:\n"));
        process.stdout.write("\n");

        let totalBytes = 0;
        for (const [filename, content] of files) {
          const filePath = join(outputDir, filename);
          let sizeStr = `${content.length} bytes`;
          try {
            const s = await stat(filePath);
            sizeStr = `${s.size} bytes`;
            totalBytes += s.size;
          } catch {
            totalBytes += content.length;
          }
          const relPath = relative(projectRoot, filePath);
          process.stdout.write(
            `  ${chalk.green(relPath.padEnd(45))}  ${sizeStr}\n`,
          );
        }

        process.stdout.write("\n");
        process.stdout.write(
          chalk.green(`5 files written (${totalBytes} bytes total)\n`),
        );
        process.stdout.write(
          chalk.gray(`  Run: open ${outputDir}/README.md\n`),
        );
      } finally {
        // Always stop the MCP client
        try {
          await mcpClient.stop();
        } catch {
          // Best-effort cleanup
        }
      }
    });
}
