// ── fleet/index.ts ────────────────────────────────────────────────────
//
// runFleet: orchestrates load → credential fail-fast → coordinate →
//           aggregate → report → write, and always resolves with a
//           PortfolioReport (per-child failures are data, not throws).
//
// registerFleetCommand: wires `agent-bober fleet <manifest>` into the
//           commander program (mirrors registerWorktreeCommand pattern).

import chalk from "chalk";
import type { Command } from "commander";

import { load } from "./manifest.js";
import { buildChildConfig } from "./child-config.js";
import { FleetCoordinator } from "./coordinator.js";
import { OutcomeAggregator } from "./aggregator.js";
import { PortfolioReporter } from "./reporter.js";
import { validateApiKey } from "../providers/factory.js";
import { logger } from "../utils/logger.js";
import type { FleetManifest } from "./manifest.js";
import type { ChildOutcome } from "./types.js";
import type { PortfolioReport } from "./reporter.js";

export type { PortfolioReport };

// ── DI seam ───────────────────────────────────────────────────────────

export interface FleetDeps {
  coordinator?: FleetCoordinator;
  aggregator?: OutcomeAggregator;
  reporter?: PortfolioReporter;
}

// ── Credential fail-fast ──────────────────────────────────────────────

/**
 * Validate DeepSeek credentials for every child BEFORE spawning anything.
 * Reuses validateApiKey from providers/factory.ts for identical semantics.
 * Throws on the first child whose effective config is missing a required key.
 */
function validateManifestCredentials(manifest: FleetManifest): void {
  for (const child of manifest.children) {
    const cfg = buildChildConfig(child);

    const roleCfgs = [
      { role: "Planner", section: cfg.planner },
      { role: "Generator", section: cfg.generator },
      { role: "Evaluator", section: cfg.evaluator },
    ] as const;

    for (const { role, section } of roleCfgs) {
      if (!section) continue;
      const s = section as {
        provider?: string;
        endpoint?: string | null;
        providerConfig?: Record<string, unknown>;
      };
      const apiKey =
        typeof s.providerConfig?.["apiKey"] === "string"
          ? s.providerConfig["apiKey"]
          : undefined;
      validateApiKey(s.provider ?? "anthropic", role, apiKey, s.endpoint ?? undefined);
    }
  }
}

// ── runFleet ──────────────────────────────────────────────────────────

export interface FleetOptions {
  /** Override manifest.concurrency */
  concurrency?: number;
  /** Override manifest.rootDir */
  rootDir?: string;
}

/**
 * Load a fleet manifest, fail fast on missing credentials, fan-out all
 * children through the coordinator, aggregate outcomes, build a portfolio
 * report, write it to <rootDir>/.bober/fleet-report.json, and return it.
 *
 * Per-child failures are data in the report — this function only throws on
 * batch-setup errors (bad manifest, missing credentials, report-write IO).
 *
 * @param manifestPath - Absolute or relative path to the fleet manifest JSON.
 * @param options      - Optional overrides for concurrency and rootDir.
 * @param deps         - Optional DI for testing (coordinator / aggregator / reporter).
 */
export async function runFleet(
  manifestPath: string,
  options?: FleetOptions,
  deps?: FleetDeps,
): Promise<PortfolioReport> {
  // 1. Load + validate manifest
  const manifest = await load(manifestPath);

  // 2. Apply options overrides (shallow copy to avoid mutating the parsed object)
  const effectiveManifest = {
    ...manifest,
    ...(options?.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
    ...(options?.rootDir !== undefined ? { rootDir: options.rootDir } : {}),
  };

  // 3. Credential fail-fast BEFORE any spawn
  validateManifestCredentials(effectiveManifest);

  // 4. Execute → aggregate
  const coordinator = deps?.coordinator ?? new FleetCoordinator();
  const aggregator = deps?.aggregator ?? new OutcomeAggregator();
  const reporter = deps?.reporter ?? new PortfolioReporter();

  const executions = await coordinator.execute(effectiveManifest);
  const outcomes: ChildOutcome[] = await Promise.all(
    executions.map((e) => aggregator.aggregate(e)),
  );

  // 5. Build + write report
  const report = reporter.build(outcomes);
  await reporter.write(effectiveManifest.rootDir, report);

  return report;
}

// ── registerFleetCommand ──────────────────────────────────────────────

/**
 * Register `agent-bober fleet <manifest>` with the commander program.
 *
 * Exit codes:
 *   0 — always on per-child failures (failures are reported, not fatal)
 *   1 — only on batch-setup errors (bad manifest, missing credentials,
 *        report IO failure)
 */
export function registerFleetCommand(program: Command): void {
  program
    .command("fleet <manifest>")
    .description("Run a fleet of agent-bober children from a manifest")
    .option("--concurrency <n>", "Override manifest concurrency")
    .option("--root <dir>", "Override manifest rootDir")
    .action(async (manifest: string, opts: { concurrency?: string; root?: string }) => {
      try {
        const report = await runFleet(manifest, {
          concurrency: opts.concurrency ? Number(opts.concurrency) : undefined,
          rootDir: opts.root,
        });

        console.log();
        console.log(chalk.bold("═══ Fleet Summary ═══"));
        console.log();
        console.log(`  Total:      ${chalk.cyan(String(report.total))} children`);
        console.log(`  Completed:  ${chalk.green(String(report.completed))}`);
        if (report.failed > 0) {
          console.log(`  Failed:     ${chalk.red(String(report.failed))}`);
        }
        if (report.other > 0) {
          console.log(`  Other:      ${chalk.yellow(String(report.other))}`);
        }
        console.log();

        process.exitCode = 0;
      } catch (err) {
        logger.error(`Fleet failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });
}
