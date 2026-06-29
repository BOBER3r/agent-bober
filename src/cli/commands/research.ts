/**
 * `bober research job add|list|remove` — manage recurring multi-model research jobs.
 *
 * Subcommands:
 *   research job add --question "..." [--cadence daily|weekly|monthly] [--tier <t>]
 *                    [--domain <d>] [--target-repo <r>] [--online-research]
 *   research job list
 *   research job remove <jobId>
 *
 * Error handling: CLI handlers MUST NOT throw. They set process.exitCode=1 and
 * return on all errors. Pattern mirrors src/cli/commands/task.ts:360-367.
 *
 * Clock discipline: new Date().toISOString() is called ONLY at the .action()
 * boundary — never inside the store (mirrors task.ts:352 "stamp wall-clock time
 * at handler boundary").
 */

import chalk from "chalk";
import type { Command } from "commander";

import { findProjectRoot } from "../../utils/fs.js";
import { addJob, listJobs, removeJob, jobId } from "../../research/job-store.js";
import { ResearchJobSchema } from "../../research/types.js";

// ── Root resolver ─────────────────────────────────────────────────────

async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}

// ── registerResearchCommand ───────────────────────────────────────────

export function registerResearchCommand(program: Command): void {
  const researchCmd = program
    .command("research")
    .description("Recurring multi-model research jobs");

  const jobCmd = researchCmd
    .command("job")
    .description("Define and manage recurring research jobs (JSON store under .bober/research/jobs)");

  // ── research job add ─────────────────────────────────────────────

  jobCmd
    .command("add")
    .description("Add a recurring research job")
    .requiredOption("--question <q>", "The research question (non-empty)")
    .option("--cadence <c>", "Recurrence cadence: daily | weekly | monthly", "weekly")
    .option("--tier <t>", "Difficulty tier hint (e.g. hard) — used by executor (Sprint 2)")
    .option("--domain <d>", "Domain tag (e.g. medical, coding)")
    .option("--target-repo <r>", "Repository slug to scope the research against")
    .option("--online-research", "Store onlineResearch=true (egress is not active until Sprint 3)")
    .action(
      async (opts: {
        question: string;
        cadence?: string;
        tier?: string;
        domain?: string;
        targetRepo?: string;
        onlineResearch?: boolean;
      }) => {
        const projectRoot = await resolveRoot();
        try {
          // Stamp wall-clock time ONLY here — never inside the store
          const now = new Date().toISOString();
          const id = jobId(opts.question, now);

          const job = ResearchJobSchema.parse({
            id,
            question: opts.question,
            cadence: opts.cadence ?? "weekly",
            tier: opts.tier,
            domain: opts.domain,
            targetRepo: opts.targetRepo,
            onlineResearch: opts.onlineResearch ?? false,
            createdAt: now,
          });

          await addJob(projectRoot, job);
          process.stdout.write(
            chalk.green(`Added research job ${chalk.bold(job.id)}\n`) +
              `  question: ${job.question}\n` +
              `  cadence:  ${job.cadence}\n`,
          );
        } catch (err) {
          process.stderr.write(
            chalk.red(
              `research job add failed: ${err instanceof Error ? err.message : String(err)}\n`,
            ),
          );
          process.exitCode = 1;
        }
      },
    );

  // ── research job list ────────────────────────────────────────────

  jobCmd
    .command("list")
    .description("List all recurring research jobs")
    .action(async () => {
      const projectRoot = await resolveRoot();
      try {
        const jobs = await listJobs(projectRoot);
        if (jobs.length === 0) {
          process.stdout.write("No research jobs defined.\n");
          return;
        }
        for (const job of jobs) {
          process.stdout.write(
            `${chalk.bold(job.id)}  ${job.cadence}  ${job.question}` +
              (job.domain ? `  [${job.domain}]` : "") +
              "\n",
          );
        }
      } catch (err) {
        process.stderr.write(
          chalk.red(
            `research job list failed: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
        process.exitCode = 1;
      }
    });

  // ── research job remove ──────────────────────────────────────────

  jobCmd
    .command("remove <jobId>")
    .description("Remove a recurring research job by id")
    .action(async (id: string) => {
      const projectRoot = await resolveRoot();
      try {
        const removed = await removeJob(projectRoot, id);
        if (removed) {
          process.stdout.write(chalk.green(`Removed research job ${chalk.bold(id)}\n`));
        } else {
          process.stderr.write(
            chalk.yellow(`Research job not found: ${id}\n`),
          );
          process.exitCode = 1;
        }
      } catch (err) {
        process.stderr.write(
          chalk.red(
            `research job remove failed: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
        process.exitCode = 1;
      }
    });
}
