/**
 * `agent-bober research job add|list|remove` — manage recurring multi-model research jobs.
 * `agent-bober research run <jobId>`         — execute a stored research job.
 * `agent-bober research tick [--watch]`      — run every due job (idempotent).
 *
 * Subcommands:
 *   research job add --question "..." [--cadence daily|weekly|monthly] [--tier <t>]
 *                    [--domain <d>] [--target-repo <r>] [--online-research]
 *   research job list
 *   research job remove <jobId>
 *   research run <jobId>
 *   research tick [--watch] [--interval <ms>]
 *
 * Error handling: CLI handlers MUST NOT throw. They set process.exitCode=1 and
 * return on all errors. Pattern mirrors src/cli/commands/task.ts:360-367.
 *
 * Clock discipline: new Date().toISOString() is called ONLY at the .action()
 * boundary — never inside the store (mirrors task.ts:352 "stamp wall-clock time
 * at handler boundary").
 *
 * fs boundary: ALL direct fs work (ensureDir, writeFile) happens inside runner.ts
 * and note-writer.ts. This file only calls readJob (JSON read) and opens FactStore.
 * This keeps the utils/fs.js import surface minimal (only findProjectRoot) so that
 * the research.test.ts whole-module vi.mock of utils/fs.js stays stable.
 */

import chalk from "chalk";
import { join } from "node:path";
import type { Command } from "commander";

import { findProjectRoot } from "../../utils/fs.js";
import { buildDigest, collectRunsFromVault } from "../../research/digest.js";
import type { DigestRun } from "../../research/digest.js";
import {
  addJob,
  listJobs,
  removeJob,
  jobId,
  readJob,
} from "../../research/job-store.js";
import { ResearchJobSchema } from "../../research/types.js";
import {
  FactStore,
  factsDbPath,
  ensureFactsDir,
} from "../../state/facts.js";
import { ingestFinding } from "../../hub/finding-store.js";
import { runResearchJob } from "../../research/runner.js";
import type { QueryModel, FindingSink } from "../../research/runner.js";
import { tick } from "../../research/scheduler.js";
import { createClient } from "../../providers/factory.js";

// ── Root resolver ─────────────────────────────────────────────────────

async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}

// ── Injectable overrides (for testing) ───────────────────────────────

/**
 * Optional overrides injected at registration time.
 * Allows tests to bypass the real LLM provider and hub store without
 * mocking additional modules beyond utils/fs.js.
 */
export interface ResearchRunOverrides {
  queryModel?: QueryModel;
  findingSink?: FindingSink;
  /** Injected collector for `research digest` — skips real vault I/O in tests. */
  digestCollectRuns?: (since: string, now: string) => Promise<DigestRun[]>;
}

// ── registerResearchCommand ───────────────────────────────────────────

export function registerResearchCommand(
  program: Command,
  overrides?: ResearchRunOverrides,
): void {
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

  // ── research run <jobId> ─────────────────────────────────────────

  researchCmd
    .command("run <jobId>")
    .description("Execute a stored research job: query >=2 model blocks, write a vault note, emit a hub Finding")
    .action(async (id: string) => {
      const projectRoot = await resolveRoot();
      try {
        const job = await readJob(projectRoot, id);
        if (job === null) {
          process.stderr.write(
            chalk.red(`Research job not found: ${id}\n`),
          );
          process.exitCode = 1;
          return;
        }

        // Stamp wall-clock time ONLY at the handler boundary (principles L31)
        const now = new Date().toISOString();
        // Vault root: default to projectRoot (same pattern as `bober vault reindex`)
        const vaultRoot = projectRoot;

        // -- queryModel binding --
        // Use override (tests) or build a real provider-agnostic client binding.
        // createClient is the ONLY place where provider SDKs are imported — never here.
        const qm: QueryModel =
          overrides?.queryModel ??
          ((block, prompt) => {
            const client = createClient(
              block.provider,
              block.endpoint ?? null,
              undefined,
              block.model,
              "research",
            );
            return client
              .chat({
                model: block.model,
                system:
                  "You are a research assistant. Answer concisely and accurately.",
                messages: [{ role: "user", content: prompt }],
              })
              .then((r) => r.text);
          });

        // -- findingSink binding --
        // Use override (tests) or bind to the real hub ingestFinding.
        let store: FactStore | null = null;
        const fs: FindingSink =
          overrides?.findingSink ??
          (async (finding) => {
            if (store === null) {
              throw new Error("FactStore was closed before findingSink was called");
            }
            await ingestFinding(store, finding, { now });
          });

        if (overrides?.findingSink === undefined) {
          await ensureFactsDir(projectRoot);
          store = new FactStore(factsDbPath(projectRoot));
        }

        try {
          const res = await runResearchJob(job, {
            queryModel: qm,
            findingSink: fs,
            now,
            vaultRoot,
          });
          process.stdout.write(res.notePath + "\n");
        } finally {
          store?.close();
        }
      } catch (err) {
        process.stderr.write(
          chalk.red(
            `research run failed: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
        process.exitCode = 1;
      }
    });

  // ── research tick [--watch] ──────────────────────────────────────────

  researchCmd
    .command("tick")
    .description(
      "Run every research job that is due as of now (idempotent).\n\n" +
        "Scheduling mechanism tradeoff:\n" +
        "  --watch        in-process setInterval loop — simple, but DIES with the\n" +
        "                 process (not suitable for unattended production use).\n" +
        "  OS cron/launchd calling `agent-bober research tick` — survives reboots;\n" +
        "                 RECOMMENDED for unattended runs. Example crontab entry:\n" +
        "                   0 * * * * /usr/local/bin/agent-bober research tick\n" +
        "  harness scheduler (/schedule) — fires the CLI on a cadence inside the\n" +
        "                 agent harness.\n\n" +
        "Note: hosted-OAuth schedulers are unfit for unattended runs (research\n" +
        "doc L135) — use OS cron/launchd for unattended scheduling.",
    )
    .option("--watch", "Run tick on an in-process interval (loop keeps process alive)")
    .option("--interval <ms>", "Watch interval in milliseconds (default: 3600000 = 1 hour)", "3600000")
    .action(async (opts: { watch?: boolean; interval?: string }) => {
      const projectRoot = await resolveRoot();
      const vaultRoot = projectRoot;

      // Build one runOnce closure that captures the injected deps.
      // clock is stamped ONLY inside runOnce at the .action boundary.
      const runOnce = async (): Promise<void> => {
        // Wall-clock read happens ONLY here (principles L31 / research.ts clock discipline).
        const now = new Date().toISOString();

        // -- queryModel binding (mirrors research run above) --
        const qm: QueryModel =
          overrides?.queryModel ??
          ((block, prompt) => {
            const client = createClient(
              block.provider,
              block.endpoint ?? null,
              undefined,
              block.model,
              "research",
            );
            return client
              .chat({
                model: block.model,
                system:
                  "You are a research assistant. Answer concisely and accurately.",
                messages: [{ role: "user", content: prompt }],
              })
              .then((r) => r.text);
          });

        // -- findingSink binding (open/close FactStore per runOnce for --watch) --
        let store: FactStore | null = null;
        const fs: FindingSink =
          overrides?.findingSink ??
          (async (finding) => {
            if (store === null) {
              throw new Error("FactStore was closed before findingSink was called");
            }
            await ingestFinding(store, finding, { now });
          });

        if (overrides?.findingSink === undefined) {
          await ensureFactsDir(projectRoot);
          store = new FactStore(factsDbPath(projectRoot));
        }

        try {
          const result = await tick({
            now,
            listJobs: () => listJobs(projectRoot),
            saveJob: (j) => addJob(projectRoot, j),
            runJob: (job) =>
              runResearchJob(job, {
                queryModel: qm,
                findingSink: fs,
                now,
                vaultRoot,
              }).then(() => undefined),
          });

          if (result.ran.length > 0) {
            process.stdout.write(
              chalk.green(`research tick: ran ${result.ran.length} job(s): ${result.ran.join(", ")}\n`),
            );
          } else {
            process.stdout.write("research tick: no jobs due.\n");
          }
        } finally {
          // Always close the store — prevents SQLite lock across interval iterations.
          store?.close();
        }
      };

      try {
        await runOnce();

        if (opts.watch === true) {
          const ms = Math.max(1000, Number(opts.interval ?? "3600000"));
          // Do NOT .unref() — the watch loop must keep the process alive.
          // bober: in-memory setInterval; replace with OS cron if the process must
          //        survive reboots or system sleep (contract nonGoal L4 / briefing §9).
          setInterval(() => {
            void runOnce();
          }, ms);
        }
      } catch (err) {
        process.stderr.write(
          chalk.red(
            `research tick failed: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
        process.exitCode = 1;
      }
    });

  // ── research digest [--since <iso>] ─────────────────────────────────

  researchCmd
    .command("digest")
    .description(
      "Aggregate research runs in [since, now] into a dual md+json digest artifact.\n\n" +
        "Writes .bober/research/digests/<YYYY-MM-DD>.{md,json} under the project root.\n" +
        "Empty window: emits an explicit no-new-research digest — never throws.\n" +
        "Consumer: the Telegram bot (sibling spec) reads the JSON for silent scheduled messages.",
    )
    .option("--since <iso>", "Window start ISO string (default: 24h before now)")
    .action(async (opts: { since?: string }) => {
      const projectRoot = await resolveRoot();
      try {
        // Stamp wall-clock ONLY here — never inside digest.ts (clock discipline)
        const now = new Date().toISOString();
        const since =
          opts.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const vaultRoot = projectRoot; // same default as `research run`
        const digestsDir = join(projectRoot, ".bober", "research", "digests");

        const res = await buildDigest(since, now, {
          // Use injected collector (tests) or real vault-note reader (production)
          collectRuns:
            overrides?.digestCollectRuns ??
            ((s, n) => collectRunsFromVault(vaultRoot, s, n)),
          digestsDir,
        });

        process.stdout.write(res.mdPath + "\n" + res.jsonPath + "\n");
      } catch (err) {
        process.stderr.write(
          chalk.red(
            `research digest failed: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
        process.exitCode = 1;
      }
    });
}
