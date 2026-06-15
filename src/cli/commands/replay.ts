/**
 * `bober replay <capture|list|show>` — manage the frozen replay corpus.
 *
 * Subcommands:
 *   capture   — Ingest .bober/eval-results/eval-*.json into immutable fixtures
 *               and baseline rows in .bober/replay/replay.db.
 *   list      — Print all captured replay cases.
 *   show <id> — Print one case with provenance (contractId, iteration, verdict, path).
 *
 * Error handling: CLI handlers MUST NOT throw. They set process.exitCode=1 and
 * return on all errors. Pattern mirrors src/cli/commands/facts.ts.
 */

import chalk from "chalk";
import type { Command } from "commander";
import { join } from "node:path";
import { writeFile, readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

import { findProjectRoot } from "../../utils/fs.js";
import { ensureDir } from "../../state/helpers.js";
import { ReplayStore } from "../../orchestrator/selfimprove/replay-store.js";

// ── Root resolver ─────────────────────────────────────────────────────

async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}

// ── Eval-result payload shape (from eval-persist.ts) ──────────────────

interface EvalResultPayload {
  evalId?: string;
  contractId: string;
  iteration: number;
  passed: boolean;
  results: unknown[];
}

// ── registerReplayCommand ─────────────────────────────────────────────

export function registerReplayCommand(program: Command): void {
  const replayCmd = program
    .command("replay")
    .description("Frozen replay corpus (capture, list, show)");

  // ── replay capture ───────────────────────────────────────────────
  replayCmd
    .command("capture")
    .description(
      "Ingest .bober/eval-results/eval-*.json into immutable case fixtures and baseline DB",
    )
    .option("--replay-dir <dir>", "Replay directory (default: .bober/replay)", ".bober/replay")
    .action(async (opts: { replayDir: string }) => {
      const projectRoot = await resolveRoot();
      try {
        const replayDir = join(projectRoot, opts.replayDir);
        const casesDir = join(replayDir, "cases");
        const dbPath = join(replayDir, "replay.db");
        const evalResultsDir = join(projectRoot, ".bober", "eval-results");

        await ensureDir(replayDir);
        await ensureDir(casesDir);

        // Read all eval-*.json files
        let evalFiles: string[] = [];
        try {
          const entries = await readdir(evalResultsDir);
          evalFiles = entries.filter((f) => f.startsWith("eval-") && f.endsWith(".json"));
        } catch {
          process.stdout.write(
            chalk.gray("No .bober/eval-results directory found — nothing to capture.\n"),
          );
          return;
        }

        if (evalFiles.length === 0) {
          process.stdout.write(chalk.gray("No eval-*.json files found — nothing to capture.\n"));
          return;
        }

        const store = new ReplayStore(dbPath);
        let captured = 0;
        try {
          for (const fname of evalFiles) {
            const filePath = join(evalResultsDir, fname);
            let payload: EvalResultPayload;
            try {
              const raw = await readFile(filePath, "utf-8");
              payload = JSON.parse(raw) as EvalResultPayload;
            } catch {
              // Skip files that fail JSON.parse without crashing the whole capture
              process.stderr.write(
                chalk.yellow(`Skipping invalid JSON file: ${fname}\n`),
              );
              continue;
            }

            // Validate required fields leniently
            if (
              typeof payload.contractId !== "string" ||
              typeof payload.iteration !== "number" ||
              typeof payload.passed !== "boolean" ||
              !Array.isArray(payload.results)
            ) {
              process.stderr.write(
                chalk.yellow(`Skipping ${fname} — missing required fields.\n`),
              );
              continue;
            }

            // Stamp wall-clock time at handler boundary — NEVER inside the store
            const tCaptured = new Date().toISOString();

            const baselineVerdict = payload.passed ? "pass" : "fail";
            const resultsJson = JSON.stringify(payload.results);
            const diffDigest = createHash("sha256").update(resultsJson).digest("hex").slice(0, 32);
            const evalDetailsJson = resultsJson;

            const rec = store.putCase({
              contractId: payload.contractId,
              iteration: payload.iteration,
              baselineVerdict: baselineVerdict as "pass" | "fail",
              diffDigest,
              evalDetailsJson,
              tCaptured,
            });

            // Write immutable fixture to .bober/replay/cases/<caseId>.json
            const fixturePath = join(casesDir, `${rec.caseId}.json`);
            await writeFile(
              fixturePath,
              JSON.stringify(
                {
                  caseId: rec.caseId,
                  contractId: rec.contractId,
                  iteration: rec.iteration,
                  baselineVerdict: rec.baselineVerdict,
                  diffDigest: rec.diffDigest,
                  tCaptured: rec.tCaptured,
                  sourceFile: filePath,
                },
                null,
                2,
              ),
              "utf-8",
            );

            captured += 1;
            process.stdout.write(
              chalk.green(`Captured`) +
                ` ${rec.caseId} — ${rec.contractId} iter ${rec.iteration} (${rec.baselineVerdict})\n`,
            );
          }
        } finally {
          store.close();
        }

        if (captured === 0) {
          process.stdout.write(chalk.gray("No new cases captured.\n"));
        } else {
          process.stdout.write(
            chalk.bold(`\nCaptured ${captured} case(s) into ${replayDir}\n`),
          );
        }
      } catch (err) {
        process.stderr.write(
          chalk.red(
            `Failed to capture replay cases: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
        process.exitCode = 1;
      }
    });

  // ── replay list ──────────────────────────────────────────────────
  replayCmd
    .command("list")
    .description("Print all captured replay cases")
    .option("--replay-dir <dir>", "Replay directory (default: .bober/replay)", ".bober/replay")
    .action(async (opts: { replayDir: string }) => {
      const projectRoot = await resolveRoot();
      try {
        const dbPath = join(projectRoot, opts.replayDir, "replay.db");

        const store = new ReplayStore(dbPath);
        try {
          const cases = store.listCases();

          if (cases.length === 0) {
            process.stdout.write(chalk.gray("No replay cases found.\n"));
            return;
          }

          process.stdout.write(
            chalk.bold(
              `${"ID".padEnd(18)} ${"CONTRACT".padEnd(40)} ${"ITER".padEnd(6)} ${"VERDICT".padEnd(8)} CAPTURED\n`,
            ),
          );
          process.stdout.write(`${"-".repeat(100)}\n`);

          for (const c of cases) {
            process.stdout.write(
              `${c.caseId.padEnd(18)} ${c.contractId.padEnd(40)} ${String(c.iteration).padEnd(6)} ${c.baselineVerdict.padEnd(8)} ${c.tCaptured}\n`,
            );
          }
        } finally {
          store.close();
        }
      } catch (err) {
        process.stderr.write(
          chalk.red(
            `Failed to list replay cases: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
        process.exitCode = 1;
      }
    });

  // ── replay show <id> ─────────────────────────────────────────────
  replayCmd
    .command("show <id>")
    .description("Print one replay case with full provenance")
    .option("--replay-dir <dir>", "Replay directory (default: .bober/replay)", ".bober/replay")
    .action(async (id: string, opts: { replayDir: string }) => {
      const projectRoot = await resolveRoot();
      try {
        const replayDir = join(projectRoot, opts.replayDir);
        const dbPath = join(replayDir, "replay.db");

        const store = new ReplayStore(dbPath);
        try {
          const rec = store.getCase(id);

          if (rec === null) {
            process.stderr.write(chalk.yellow(`Replay case not found: ${id}\n`));
            process.exitCode = 1;
            return;
          }

          const fixturePath = join(replayDir, "cases", `${rec.caseId}.json`);

          process.stdout.write(chalk.bold(`Replay case: ${rec.caseId}\n`));
          process.stdout.write(`  contractId:      ${rec.contractId}\n`);
          process.stdout.write(`  iteration:       ${rec.iteration}\n`);
          process.stdout.write(`  baselineVerdict: ${rec.baselineVerdict}\n`);
          process.stdout.write(`  diffDigest:      ${rec.diffDigest}\n`);
          process.stdout.write(`  tCaptured:       ${rec.tCaptured}\n`);
          process.stdout.write(`  source:          ${fixturePath}\n`);
        } finally {
          store.close();
        }
      } catch (err) {
        process.stderr.write(
          chalk.red(
            `Failed to show replay case: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
        process.exitCode = 1;
      }
    });
}
