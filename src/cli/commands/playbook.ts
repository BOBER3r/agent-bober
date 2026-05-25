/**
 * `bober playbook <list|show|search>` — playbook library CLI.
 *
 * Subcommands:
 *   list                — Print a table of all playbooks.
 *   show <name>         — Print the raw markdown content of a playbook.
 *   search <symptom>    — Search for playbooks matching the symptom string.
 *
 * Error handling: CLI handlers MUST NOT throw. They set process.exitCode=1 and
 * return on all errors (Pattern C per briefing). Top-level main().catch() is
 * the last-ditch fallback, not the primary error path.
 *
 * Sprint 25 — src/cli/commands/playbook.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";

import { findProjectRoot } from "../../utils/fs.js";
import {
  loadPlaybooks,
  searchPlaybooks,
  HIGH_CONFIDENCE_THRESHOLD,
  LOW_CONFIDENCE_THRESHOLD,
} from "../../incident/playbook-search.js";

async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}

// ── registerPlaybookCommand ───────────────────────────────────────────────────

export function registerPlaybookCommand(program: Command): void {
  const pbCmd = program
    .command("playbook")
    .description("Manage incident response playbooks (list, show, search)");

  // ── playbook list ──
  pbCmd
    .command("list")
    .description("List all available playbooks")
    .action(async () => {
      const projectRoot = await resolveRoot();
      try {
        const playbooks = await loadPlaybooks(projectRoot);
        if (playbooks.length === 0) {
          process.stdout.write(
            chalk.gray("No playbooks found in .bober/playbooks/.\n"),
          );
          return;
        }
        // Header.
        process.stdout.write(
          chalk.bold(
            `${"NAME".padEnd(24)} ${"CLASSIFICATION".padEnd(16)} SYMPTOMS SUMMARY\n`,
          ),
        );
        process.stdout.write(`${"-".repeat(80)}\n`);
        for (const pb of playbooks) {
          const classColored =
            pb.classification === "emergency"
              ? chalk.red(pb.classification)
              : chalk.cyan(pb.classification);
          const symptomSummary = pb.applicableSymptoms.slice(0, 3).join(", ");
          const symptomTrunc =
            symptomSummary.length > 40
              ? `${symptomSummary.slice(0, 37)}...`
              : symptomSummary;
          process.stdout.write(
            `${pb.name.padEnd(24)} ${classColored.padEnd(16 + (classColored.length - pb.classification.length))} ${symptomTrunc}\n`,
          );
        }
      } catch (err) {
        process.stderr.write(
          chalk.red(
            `Failed to list playbooks: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
        process.exitCode = 1;
      }
    });

  // ── playbook show <name> ──
  pbCmd
    .command("show <name>")
    .description("Show the full content of a playbook by name")
    .action(async (name: string) => {
      const projectRoot = await resolveRoot();
      const filePath = join(projectRoot, ".bober", "playbooks", `${name}.md`);
      try {
        const content = await readFile(filePath, "utf-8");
        process.stdout.write(content);
      } catch (err) {
        if ((err as { code?: string }).code === "ENOENT") {
          process.stderr.write(
            chalk.yellow(
              `Playbook '${name}' not found at .bober/playbooks/${name}.md\n`,
            ),
          );
          process.exitCode = 1;
          return;
        }
        process.stderr.write(
          chalk.red(
            `Failed to read playbook '${name}': ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
        process.exitCode = 1;
      }
    });

  // ── playbook search <symptom> ──
  pbCmd
    .command("search <symptom>")
    .description("Search for playbooks matching a symptom string")
    .action(async (symptom: string) => {
      const projectRoot = await resolveRoot();
      try {
        const matches = await searchPlaybooks(symptom, projectRoot);
        if (matches.length === 0) {
          process.stdout.write(
            chalk.gray(`No playbooks matched '${symptom}'.\n`),
          );
          return;
        }
        // Header.
        process.stdout.write(
          chalk.bold(
            `${"NAME".padEnd(24)} ${"CONFIDENCE".padEnd(12)} ${"TIER".padEnd(12)} MATCHED TOKENS\n`,
          ),
        );
        process.stdout.write(`${"-".repeat(80)}\n`);
        for (const m of matches) {
          const confidenceStr = m.confidence.toFixed(2);
          let tier: string;
          let tierColored: string;
          if (m.confidence >= HIGH_CONFIDENCE_THRESHOLD) {
            tier = "high";
            tierColored = chalk.green(tier);
          } else if (m.confidence >= LOW_CONFIDENCE_THRESHOLD) {
            tier = "suggestion";
            tierColored = chalk.yellow(tier);
          } else {
            tier = "low";
            tierColored = chalk.gray(tier);
          }
          const tokensStr = m.matchedTokens.join(", ");
          const tokensTrunc =
            tokensStr.length > 30 ? `${tokensStr.slice(0, 27)}...` : tokensStr;
          process.stdout.write(
            `${m.playbook.name.padEnd(24)} ${confidenceStr.padEnd(12)} ${tierColored.padEnd(12 + (tierColored.length - tier.length))} ${tokensTrunc}\n`,
          );
        }
      } catch (err) {
        process.stderr.write(
          chalk.red(
            `Failed to search playbooks: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
        process.exitCode = 1;
      }
    });
}
