/**
 * `agent-bober impact <symbol|file>` — analyse the impact radius of a symbol or file.
 *
 * Calls GraphClient.impact + GraphClient.query('tests_for'), formats as markdown,
 * and writes to .bober/graph/impact/<slug>.md.
 *
 * Slug derivation: lowercase, non-alphanumeric → '-', collapse consecutive '-',
 * strip leading/trailing '-', truncate to 40 chars.
 */
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

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
import type { NodeRef } from "../../graph/types.js";

// ── Architecture doc link ──────────────────────────────────────────

const ARCH_DOC_PATH =
  ".bober/architecture/arch-20260524-port-code-review-graph-architecture.md";

const DISABLED_MSG =
  "Graph integration is disabled. Enable via `graph.enabled: true` in bober.config.json." +
  ` See: ${ARCH_DOC_PATH}`;

// ── Slug derivation ───────────────────────────────────────────────

/**
 * Derive a filesystem-safe slug from an impact target string.
 *
 * Rules:
 *   1. Lowercase
 *   2. Replace every non-alphanumeric char with '-'
 *   3. Collapse consecutive '-' into one
 *   4. Strip leading and trailing '-'
 *   5. Truncate to 40 characters
 *
 * Examples:
 *   'sandboxPath'                       → 'sandboxpath'
 *   'src/orchestrator/tools/handlers.ts' → 'src-orchestrator-tools-handlers-ts'
 *   'MyClass.doThing'                   → 'myclass-dothing'
 */
export function deriveSlug(target: string): string {
  return target
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

// ── Helpers ───────────────────────────────────────────────────────

async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}

function nodeRefToMd(node: NodeRef): string {
  return `- \`${node.symbol}\` (${node.kind}) — ${node.file}:${node.line}`;
}

// ── Command ───────────────────────────────────────────────────────

export function registerImpactCommand(program: Command): void {
  program
    .command("impact <target>")
    .description(
      "Analyse the impact radius of a symbol or file in the code graph",
    )
    .action(async (target: string) => {
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

      // Spawn a short-lived MCP client
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

        process.stdout.write(chalk.cyan(`Analysing impact for: ${target}\n`));

        // Build a NodeRef for the target (best-effort; use symbol kind)
        const targetRef: NodeRef = {
          id: target,
          kind: "symbol",
          file: target.includes("/") ? target : "",
          line: 0,
          symbol: target,
        };

        // Run impact + tests_for concurrently
        const [impactResult, testsResult] = await Promise.all([
          graphClient.impact(target),
          graphClient.query("tests_for", targetRef),
        ]);

        // Build markdown output
        const lines: string[] = [];
        lines.push(`# Impact: ${target}`);
        lines.push("");

        lines.push("## Affected symbols");
        lines.push("");
        if (impactResult.ok) {
          if (impactResult.data.affected.length === 0) {
            lines.push("_No affected symbols found._");
          } else {
            for (const node of impactResult.data.affected) {
              lines.push(nodeRefToMd(node));
            }
          }
        } else {
          lines.push(
            `_Graph unavailable: ${impactResult.reason} — ${impactResult.detail}_`,
          );
        }
        lines.push("");

        lines.push("## Tests covering this symbol");
        lines.push("");
        if (testsResult.ok) {
          if (testsResult.data.length === 0) {
            lines.push("_No test coverage found._");
          } else {
            for (const node of testsResult.data) {
              lines.push(nodeRefToMd(node));
            }
          }
        } else {
          // Also try tests from impact result
          if (impactResult.ok && impactResult.data.testsAffected.length > 0) {
            for (const node of impactResult.data.testsAffected) {
              lines.push(nodeRefToMd(node));
            }
          } else {
            lines.push(
              `_Graph unavailable: ${testsResult.reason} — ${testsResult.detail}_`,
            );
          }
        }
        lines.push("");

        const markdown = lines.join("\n");

        // Write to .bober/graph/impact/<slug>.md
        const slug = deriveSlug(target);
        const impactDir = join(projectRoot, ".bober", "graph", "impact");
        await mkdir(impactDir, { recursive: true });

        const outputPath = join(impactDir, `${slug}.md`);
        await writeFile(outputPath, markdown, "utf-8");

        process.stdout.write(
          chalk.green(`Impact report written: .bober/graph/impact/${slug}.md\n`),
        );

        // Print brief summary
        const affectedCount = impactResult.ok ? impactResult.data.affected.length : 0;
        const testCount =
          testsResult.ok
            ? testsResult.data.length
            : impactResult.ok
              ? impactResult.data.testsAffected.length
              : 0;

        process.stdout.write(
          `  Affected symbols: ${affectedCount}\n`,
        );
        process.stdout.write(`  Test coverage:    ${testCount}\n`);
      } finally {
        try {
          await mcpClient.stop();
        } catch {
          // Best-effort cleanup
        }
      }
    });
}
