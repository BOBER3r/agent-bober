/**
 * `bober memory <distill|list|show>` — inspect and distill self-improvement lessons.
 *
 * Subcommands:
 *   distill       — Distill sprint history into deterministic lessons (idempotent).
 *   list          — Print the bounded lesson index.
 *   show <id>     — Print one lesson with its sourceEntryRefs provenance.
 *
 * Error handling: CLI handlers MUST NOT throw. They set process.exitCode=1 and
 * return on all errors. Pattern mirrors src/cli/commands/incident.ts.
 */

import { join } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";

import { findProjectRoot } from "../../utils/fs.js";
import { loadHistory } from "../../state/history.js";
import { listContracts } from "../../state/sprint-state.js";
import {
  appendLesson,
  loadLessonIndex,
  loadLesson,
} from "../../state/memory.js";
import { distill } from "../../orchestrator/memory/distill.js";
import { loadEvalResults } from "../../orchestrator/memory/eval-source.js";

// ── Root resolver ─────────────────────────────────────────────────────

async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}

// ── registerMemoryCommand ─────────────────────────────────────────────

export function registerMemoryCommand(program: Command): void {
  const memCmd = program
    .command("memory")
    .description("Inspect and distill self-improvement lessons (distill, list, show)");

  // ── memory distill ────────────────────────────────────────────────
  memCmd
    .command("distill")
    .description("Distill sprint history into deterministic lessons (idempotent)")
    .action(async () => {
      const projectRoot = await resolveRoot();
      try {
        const history = await loadHistory(projectRoot);
        const contracts = await listContracts(projectRoot);
        const evalResults = await loadEvalResults(projectRoot);
        const drafts = distill(history, contracts, evalResults);

        // Stamp createdAt at persist time — never inside the pure distill fn
        const now = new Date().toISOString();

        // Count new lessons by comparing against the pre-existing index
        const beforeIndex = await loadLessonIndex(projectRoot, {
          limit: Number.MAX_SAFE_INTEGER,
        });
        const seen = new Set(beforeIndex.map((r) => r.lessonId));

        let added = 0;
        for (const draft of drafts) {
          const lesson = { ...draft, createdAt: now };
          if (!seen.has(lesson.lessonId)) added++;
          // appendLesson already UPSERTS — re-running same lessonId = no new index line
          await appendLesson(projectRoot, lesson);
        }

        process.stdout.write(
          chalk.green(`distilled ${drafts.length} lessons (${added} new)\n`),
        );
      } catch (err) {
        process.stderr.write(
          chalk.red(
            `Failed to distill: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
        process.exitCode = 1;
      }
    });

  // ── memory list ───────────────────────────────────────────────────
  memCmd
    .command("list")
    .description("Print the bounded lesson index")
    .option("--limit <n>", "Maximum number of lessons to show", "50")
    .action(async (opts: { limit: string }) => {
      const projectRoot = await resolveRoot();
      try {
        const limit = Math.max(1, Number(opts.limit) || 50);
        const records = await loadLessonIndex(projectRoot, { limit });

        if (records.length === 0) {
          process.stdout.write(chalk.gray("No lessons found. Run `bober memory distill` first.\n"));
          return;
        }

        process.stdout.write(
          chalk.bold(
            `${"LESSON ID".padEnd(18)} ${"CATEGORY".padEnd(22)} ${"SEV".padEnd(6)} ${"OCC".padEnd(5)} SUMMARY\n`,
          ),
        );
        process.stdout.write(`${"-".repeat(100)}\n`);

        for (const r of records) {
          const sevColored =
            r.severity === "high"
              ? chalk.red(r.severity)
              : r.severity === "warn"
                ? chalk.yellow(r.severity)
                : chalk.gray(r.severity);
          const snippet =
            r.summarySnippet.length > 60
              ? `${r.summarySnippet.slice(0, 57)}...`
              : r.summarySnippet;
          process.stdout.write(
            `${r.lessonId.padEnd(18)} ${r.category.padEnd(22)} ${(sevColored + " ".repeat(Math.max(0, 6 - r.severity.length))).padEnd(6 + (sevColored.length - r.severity.length))} ${String(r.occurrences).padEnd(5)} ${snippet}\n`,
          );
        }
      } catch (err) {
        process.stderr.write(
          chalk.red(
            `Failed to list lessons: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
        process.exitCode = 1;
      }
    });

  // ── memory show <lessonId> ─────────────────────────────────────────
  memCmd
    .command("show <lessonId>")
    .description("Print one lesson with its sourceEntryRefs provenance")
    .action(async (lessonId: string) => {
      const projectRoot = await resolveRoot();
      try {
        const lesson = await loadLesson(projectRoot, lessonId);

        process.stdout.write(chalk.bold(`Lesson: ${lesson.lessonId}\n`));
        process.stdout.write(`Category:    ${lesson.category}\n`);
        process.stdout.write(`Severity:    ${lesson.severity}\n`);
        process.stdout.write(`Occurrences: ${lesson.occurrences}\n`);
        process.stdout.write(`Created at:  ${lesson.createdAt}\n`);

        if (lesson.tags.length > 0) {
          process.stdout.write(`Tags:        ${lesson.tags.join(", ")}\n`);
        }

        process.stdout.write(`\nSummary:\n${lesson.summary}\n`);

        process.stdout.write(`\nSource References (${lesson.sourceEntryRefs.length}):\n`);
        for (const ref of lesson.sourceEntryRefs) {
          process.stdout.write(`  - ${ref}\n`);
        }

        // Re-export the lesson path for reference
        process.stdout.write(
          chalk.gray(`\nLesson file: ${join(projectRoot, ".bober", "memory", `${lesson.lessonId}.md`)}\n`),
        );
      } catch (err) {
        const isNotFound =
          err instanceof Error && err.message.includes("Lesson not found");
        if (isNotFound) {
          process.stderr.write(
            chalk.yellow(`Lesson not found: ${lessonId}\n`),
          );
        } else {
          process.stderr.write(
            chalk.red(
              `Failed to show lesson: ${err instanceof Error ? err.message : String(err)}\n`,
            ),
          );
        }
        process.exitCode = 1;
      }
    });
}
