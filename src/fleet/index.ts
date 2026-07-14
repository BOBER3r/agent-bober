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
import { join, resolve, dirname } from "node:path";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";

import { load } from "./manifest.js";
import { buildChildConfig } from "./child-config.js";
import { assertManifest } from "./tool-role-guard.js";
import { FleetCoordinator } from "./coordinator.js";
import { OutcomeAggregator } from "./aggregator.js";
import { PortfolioReporter } from "./reporter.js";
import { SharedBlackboard } from "./shared-blackboard.js";
import { collect } from "./synthesis.js";
import { validateApiKey, createClient } from "../providers/factory.js";
import { logger } from "../utils/logger.js";
import { decomposeGoal } from "./decomposer.js";
import { decomposeGoalDeep } from "./decomposer-deep.js";
import { writeManifestWithProvenance } from "./manifest-write.js";
import { ensureDir } from "../state/helpers.js";
import type { FleetManifest } from "./manifest.js";
import type { ChildOutcome, ChildExecution } from "./types.js";
import type { PortfolioReport } from "./reporter.js";
import type { SynthesisBundle } from "./synthesis.js";
import type { LLMClient } from "../providers/types.js";

export type { PortfolioReport };

// ── resolveBlackboardPath ─────────────────────────────────────────────

/**
 * Resolve the ABSOLUTE shared blackboard path for a fleet run.
 * Returns undefined when no blackboard is configured.
 *
 * ADR-5: the caller bears the absolute-path responsibility — resolve() is
 * applied here so downstream modules receive an absolute path directly.
 */
export function resolveBlackboardPath(manifest: FleetManifest): string | undefined {
  if (!manifest.blackboard) return undefined;
  return join(resolve(manifest.rootDir), ".bober", "memory", manifest.blackboard.namespace, "facts.db");
}

// ── writeSynthesis ────────────────────────────────────────────────────

/**
 * Atomically write a SynthesisBundle to <rootDir>/.bober/fleet-synthesis.json.
 * Mirrors PortfolioReporter.write (reporter.ts:76-91): tmp+rename with a
 * randomBytes suffix, mode 0o600, and trailing newline.
 *
 * @returns The absolute path of the written file.
 */
async function writeSynthesis(rootDir: string, bundle: SynthesisBundle): Promise<string> {
  const dir = resolve(join(rootDir, ".bober"));
  await mkdir(dir, { recursive: true });

  const filePath = join(dir, "fleet-synthesis.json");
  const rnd = randomBytes(4).toString("hex");
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${rnd}.tmp`;

  await writeFile(tmp, JSON.stringify(bundle, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  await rename(tmp, filePath);

  return filePath;
}

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

  // 3. Build-time + credential fail-fast BEFORE any spawn
  assertManifest(effectiveManifest);                // throws if claude-code on a tool role
  validateManifestCredentials(effectiveManifest);

  // 4. Execute → aggregate
  const coordinator = deps?.coordinator ?? new FleetCoordinator();
  const aggregator = deps?.aggregator ?? new OutcomeAggregator();
  const reporter = deps?.reporter ?? new PortfolioReporter();

  // ── Blackboard-aware execution branch ────────────────────────────
  const dbPath = resolveBlackboardPath(effectiveManifest);
  let executions: ChildExecution[];
  let bb: SharedBlackboard | null = null; // hoisted so it survives the if-block
  let roundsRun = 0; // capture the configured round cap

  try {
    if (dbPath) {
      // Blackboard path: open a shared WAL facts.db, run bounded rounds.
      // bb is hoisted to the outer scope so collect() can call bb.readAll()
      // BEFORE bb.close() (which moves to the outer finally below).
      await ensureDir(dirname(dbPath));
      bb = await SharedBlackboard.open({
        dbPath,
        namespace: effectiveManifest.blackboard!.namespace,
        maxRounds: effectiveManifest.blackboard!.maxRounds,
      });
      const { executions: roundExecutions, roundsRun: rr } = await coordinator.executeRounds(effectiveManifest, bb, {
        maxRounds: effectiveManifest.blackboard!.maxRounds,
        dbPath,
      });
      executions = roundExecutions;
      roundsRun = rr;
    } else {
      // No-blackboard path: single mapBounded pass, byte-identical to pre-Phase-B.
      executions = await coordinator.execute(effectiveManifest);
    }

    const outcomes: ChildOutcome[] = await Promise.all(
      executions.map((e) => aggregator.aggregate(e)),
    );

    // 5. Build + write report (UNCHANGED — always written on every run)
    const report = reporter.build(outcomes, bb ? { rounds: roundsRun } : undefined);
    await reporter.write(effectiveManifest.rootDir, report);

    // 6. Synthesis (ADDITIVE — only on a blackboard run; AFTER the report write)
    // bb is still OPEN here so collect() → bb.readAll() works correctly.
    if (bb) {
      const bundle = collect(bb, report, roundsRun);
      await writeSynthesis(effectiveManifest.rootDir, bundle);
    }

    return report;
  } finally {
    // Close moved here: runs AFTER synthesis collect+write, and on any error path.
    if (bb) bb.close();
  }
}

// ── runFleetExpand ────────────────────────────────────────────────────

export interface FleetExpandOptions {
  /** Soft target for number of children to decompose */
  count?: string;
  /** Override the decomposer LLM provider (default: "openai-compat") */
  provider?: string;
  /** Override the decomposer LLM model (default: "deepseek-v4-pro") */
  model?: string;
  /** Override the manifest rootDir (default: ".") */
  root?: string;
  /** Override manifest concurrency (default: 3) */
  concurrency?: string;
  /** Override the output path for the written manifest */
  out?: string;
  /** When true, chain into runFleet(outPath) after writing */
  yes?: boolean;
}

export interface FleetExpandDeps {
  decompose?: typeof decomposeGoal;
  runFleet?: typeof runFleet;
  createClient?: typeof createClient;
}

/**
 * Core logic for `fleet expand <goal>`:
 *
 * 1. Build the DeepSeek LLMClient (credential fail-fast BEFORE any IO).
 * 2. Call decomposeGoal to get a children-only FleetManifest.
 * 3. Assemble { rootDir, concurrency, children }.
 * 4. Atomically write the manifest to outPath (overwrite with notice).
 * 5. Print the manifest + a review hint.
 * 6. If --yes, chain into runFleet(outPath) and print Fleet Summary.
 *    Otherwise stop (exit 0).
 *
 * @param goal  - The high-level goal to decompose into children.
 * @param opts  - Parsed Commander options.
 * @param deps  - Optional DI seams for testing (decompose, runFleet, createClient).
 */
export async function runFleetExpand(
  goal: string,
  opts: FleetExpandOptions,
  deps?: FleetExpandDeps,
): Promise<void> {
  // ── Step 1: build the decomposer LLM client (credential fail-fast) ──
  // This MUST run before any filesystem write. createClient/validateApiKey
  // throws synchronously when DEEPSEEK_API_KEY is missing for api.deepseek.com.
  const model = opts.model ?? "deepseek-v4-pro";
  const clientBuilder = deps?.createClient ?? createClient;
  const client: LLMClient = clientBuilder(
    opts.provider ?? "openai-compat",
    "https://api.deepseek.com",
    undefined,
    model,
    "FleetDecomposer",
  );

  // ── Step 2: decompose the goal ────────────────────────────────────
  // Fold --count hint into the goal as a soft target for the decomposer.
  const goalWithHint =
    opts.count !== undefined
      ? `${goal}\n\n(Decompose into approximately ${opts.count} independent sub-projects.)`
      : goal;

  const decomposeFn = deps?.decompose ?? decomposeGoal;
  const decomposed = await decomposeFn({ goal: goalWithHint, client, model, maxRetries: 1 });

  // ── Step 3: assemble the manifest ────────────────────────────────
  const root = opts.root ?? ".";
  const concurrency = opts.concurrency ? Number(opts.concurrency) : 3;
  const manifest: FleetManifest = {
    rootDir: root,
    concurrency,
    children: decomposed.children,
  };

  // ── Step 4: atomic write with provenance + recoverable overwrite ──
  const outPath = opts.out ?? join(root, ".bober", "fleet-expand.json");
  await writeManifestWithProvenance({
    outPath,
    manifest,
    provenance: {
      command: "fleet expand",
      goal,
      critique: false,
      childCount: manifest.children.length,
    },
  });

  // ── Step 5: print the manifest + review hint ──────────────────────
  console.log();
  console.log(chalk.bold("═══ Fleet Expand Manifest ═══"));
  console.log();
  console.log(JSON.stringify(manifest, null, 2));
  console.log();
  console.log(`Manifest written to: ${outPath}`);
  console.log(`Review then run: agent-bober fleet "${outPath}"`);
  console.log();

  // ── Step 6: --yes gate ────────────────────────────────────────────
  // runFleet is ONLY reachable when opts.yes is true. Default exits 0.
  if (opts.yes) {
    const runFleetFn = deps?.runFleet ?? runFleet;
    const report = await runFleetFn(outPath);

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
  } else {
    process.exitCode = 0;
  }
}

// ── runFleetExpandDeep ────────────────────────────────────────────────

export interface FleetExpandDeepOptions {
  /** Soft target for number of children to decompose */
  count?: string;
  /** Override the decomposer LLM provider (default: "openai-compat") */
  provider?: string;
  /** Override the decomposer LLM model (default: "deepseek-v4-pro") */
  model?: string;
  /** Override the manifest rootDir (default: ".") */
  root?: string;
  /** Override manifest concurrency (default: 3) */
  concurrency?: string;
  /** Override the output path for the written manifest */
  out?: string;
  /** When true, chain into runFleet(outPath) after writing */
  yes?: boolean;
  /** When true, run a fresh-context critic gate that re-expands degenerate manifests */
  critique?: boolean;
}

export interface FleetExpandDeepDeps {
  decomposeDeep?: typeof decomposeGoalDeep;
  runFleet?: typeof runFleet;
  createClient?: typeof createClient;
}

/**
 * Core logic for `fleet expand-deep <goal>`:
 *
 * 1. Build the DeepSeek LLMClient (credential fail-fast BEFORE any IO).
 * 2. Call decomposeGoalDeep to get a children-only FleetManifest (two-stage plan→expand).
 * 3. Assemble { rootDir, concurrency, children }.
 * 4. Atomically write the manifest to outPath (overwrite with notice).
 * 5. Print the manifest + a review hint.
 * 6. If --yes, chain into runFleet(outPath) and print Fleet Summary.
 *    Otherwise stop (exit 0).
 *
 * @param goal  - The high-level goal to decompose into children.
 * @param opts  - Parsed Commander options.
 * @param deps  - Optional DI seams for testing (decomposeDeep, runFleet, createClient).
 */
export async function runFleetExpandDeep(
  goal: string,
  opts: FleetExpandDeepOptions,
  deps?: FleetExpandDeepDeps,
): Promise<void> {
  // ── Step 1: build the decomposer LLM client (credential fail-fast) ──
  // This MUST run before any filesystem write. createClient/validateApiKey
  // throws synchronously when DEEPSEEK_API_KEY is missing for api.deepseek.com.
  const model = opts.model ?? "deepseek-v4-pro";
  const clientBuilder = deps?.createClient ?? createClient;
  const client: LLMClient = clientBuilder(
    opts.provider ?? "openai-compat",
    "https://api.deepseek.com",
    undefined,
    model,
    "FleetDecomposer",
  );

  // ── Step 2: decompose the goal ────────────────────────────────────
  // Fold --count hint into the goal as a soft target for the decomposer.
  const goalWithHint =
    opts.count !== undefined
      ? `${goal}\n\n(Decompose into approximately ${opts.count} independent sub-projects.)`
      : goal;

  const decomposeDeepFn = deps?.decomposeDeep ?? decomposeGoalDeep;
  const decomposed = await decomposeDeepFn({
    goal: goalWithHint,
    client,
    model,
    ...(opts.critique ? { critique: true } : {}),
  });

  // ── Step 3: assemble the manifest ────────────────────────────────
  const root = opts.root ?? ".";
  const concurrency = opts.concurrency ? Number(opts.concurrency) : 3;
  const manifest: FleetManifest = {
    rootDir: root,
    concurrency,
    children: decomposed.children,
  };

  // ── Step 4: atomic write with provenance + recoverable overwrite ──
  const outPath = opts.out ?? join(root, ".bober", "fleet-expand.json");
  await writeManifestWithProvenance({
    outPath,
    manifest,
    provenance: {
      command: "fleet expand-deep",
      goal,
      critique: opts.critique === true,
      childCount: manifest.children.length,
    },
  });

  // ── Step 5: print the manifest + review hint ──────────────────────
  console.log();
  console.log(chalk.bold("═══ Fleet Expand-Deep Manifest ═══"));
  console.log();
  console.log(JSON.stringify(manifest, null, 2));
  console.log();
  console.log(`Manifest written to: ${outPath}`);
  console.log(`Review then run: agent-bober fleet "${outPath}"`);
  console.log();

  // ── Step 6: --yes gate ────────────────────────────────────────────
  // runFleet is ONLY reachable when opts.yes is true. Default exits 0.
  if (opts.yes) {
    const runFleetFn = deps?.runFleet ?? runFleet;
    const report = await runFleetFn(outPath);

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
  } else {
    process.exitCode = 0;
  }
}

// ── registerFleetExpandDeepSubcommand ─────────────────────────────────

/**
 * Attach `expand-deep <goal>` as a child subcommand of the existing `fleet` command.
 * Options: --count, --provider, --model, --root, --concurrency, --out, --yes.
 *
 * The action body is a thin wrapper around runFleetExpandDeep for testability.
 */
export function registerFleetExpandDeepSubcommand(fleet: Command): void {
  fleet
    .command("expand-deep <goal>")
    .description(
      "Robustly decompose a large/ambiguous goal (two-stage plan-then-expand) into a fleet manifest and optionally run it",
    )
    .option("--count <n>", "Soft target for number of sub-projects")
    .option("--provider <p>", "Override the decomposer LLM provider (default: openai-compat)")
    .option("--model <m>", "Override the decomposer LLM model (default: deepseek-v4-pro)")
    .option("--root <dir>", "Override the manifest rootDir (default: .)")
    .option("--concurrency <c>", "Override manifest concurrency (default: 3)")
    .option("--out <path>", "Override the output path for the written manifest")
    .option("--yes", "Chain into fleet run after writing the manifest")
    .option("--critique", "Run a fresh-context critic gate that re-expands degenerate manifests")
    .action(
      async (
        goal: string,
        opts: {
          count?: string;
          provider?: string;
          model?: string;
          root?: string;
          concurrency?: string;
          out?: string;
          yes?: boolean;
          critique?: boolean;
        },
      ) => {
        try {
          await runFleetExpandDeep(goal, opts);
        } catch (err) {
          logger.error(
            `Fleet expand-deep failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          process.exitCode = 1;
        }
      },
    );
}

// ── registerFleetExpandSubcommand ─────────────────────────────────────

/**
 * Attach `expand <goal>` as a child subcommand of the existing `fleet` command.
 * Options: --count, --provider, --model, --root, --concurrency, --out, --yes.
 *
 * The action body is a thin wrapper around runFleetExpand for testability.
 */
export function registerFleetExpandSubcommand(fleet: Command): void {
  fleet
    .command("expand <goal>")
    .description("Decompose a goal into a fleet manifest and optionally run it")
    .option("--count <n>", "Soft target for number of sub-projects")
    .option("--provider <p>", "Override the decomposer LLM provider (default: openai-compat)")
    .option("--model <m>", "Override the decomposer LLM model (default: deepseek-v4-pro)")
    .option("--root <dir>", "Override the manifest rootDir (default: .)")
    .option("--concurrency <c>", "Override manifest concurrency (default: 3)")
    .option("--out <path>", "Override the output path for the written manifest")
    .option("--yes", "Chain into fleet run after writing the manifest")
    .action(
      async (
        goal: string,
        opts: {
          count?: string;
          provider?: string;
          model?: string;
          root?: string;
          concurrency?: string;
          out?: string;
          yes?: boolean;
        },
      ) => {
        try {
          await runFleetExpand(goal, opts);
        } catch (err) {
          logger.error(
            `Fleet expand failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          process.exitCode = 1;
        }
      },
    );
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
  const fleet = program
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

  registerFleetExpandSubcommand(fleet);
  registerFleetExpandDeepSubcommand(fleet);
}
