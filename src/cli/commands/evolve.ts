/**
 * `bober evolve` — offline replay-gated prompt evolution.
 *
 * Reads the generator or evaluator agent prompt, proposes deterministic variants,
 * scores each ONLY via the Sprint 2 runReplayHarness gate (never live LLM runs),
 * keeps the Pareto frontier, and writes a promoted prompt under
 * .bober/evolve/<runId>/promoted/ ONLY when a variant beats the baseline with
 * zero regressions.
 *
 * SAFETY: this command NEVER writes under the live agent definitions directory.
 * All outputs are confined to .bober/evolve/<runId>/.
 *
 * Error handling: handler MUST NOT throw. Sets process.exitCode=1 and returns
 * on all errors. Pattern mirrors src/cli/commands/facts.ts and replay.ts.
 */

import chalk from "chalk";
import type { Command } from "commander";

import { findProjectRoot } from "../../utils/fs.js";
import { loadConfig } from "../../config/loader.js";
import { evolve } from "../../orchestrator/selfimprove/gepa.js";

// ── Root resolver ─────────────────────────────────────────────────────────────

async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}

// ── registerEvolveCommand ─────────────────────────────────────────────────────

export function registerEvolveCommand(program: Command): void {
  program
    .command("evolve")
    .description(
      "Offline replay-gated prompt evolution (scores via frozen corpus, never writes live agent definitions, never live)",
    )
    .requiredOption("--role <role>", "Agent role to evolve: generator | evaluator")
    .option("--seed <n>", "Deterministic PRNG seed for variant generation", "0")
    .option("--dry-run", "Score and report variants without writing any promoted file")
    .action(
      async (opts: { role: string; seed: string; dryRun?: boolean }) => {
        const projectRoot = await resolveRoot();
        try {
          // Tolerant config load — absence of bober.config.json is non-fatal.
          // Mirror replay.ts:278-293.
          let config: Awaited<ReturnType<typeof loadConfig>>;
          try {
            config = await loadConfig(projectRoot);
          } catch {
            config = {
              project: { name: "evolve", mode: "greenfield" as const },
              selfImprove: {
                deterministicGate: false,
                rubricIsolation: false,
                requireCitedArtifact: false,
                replayDir: ".bober/replay",
              },
            } as unknown as Awaited<ReturnType<typeof loadConfig>>;
          }

          const role = opts.role as "generator" | "evaluator";
          const seed = Number(opts.seed) || 0;
          const dryRun = Boolean(opts.dryRun);

          process.stdout.write(
            chalk.bold(`bober evolve: role=${role} seed=${seed} dryRun=${dryRun}\n`),
          );

          const result = await evolve(projectRoot, config, { role, seed, dryRun });

          process.stdout.write(
            chalk.bold(`Variants tried: ${result.variantsTried}\n`),
          );

          if (result.promoted) {
            process.stdout.write(
              chalk.green(`Promoted → ${result.winnerPath ?? "(path unavailable)"}\n`),
            );
          } else {
            process.stdout.write(
              chalk.gray(
                `No variant beat the baseline (zero-regression + strictly-more-improvements). Nothing promoted.\n`,
              ),
            );
          }
        } catch (err) {
          process.stderr.write(
            chalk.red(
              `Failed to evolve: ${err instanceof Error ? err.message : String(err)}\n`,
            ),
          );
          process.exitCode = 1;
        }
      },
    );
}
