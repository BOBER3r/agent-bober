/**
 * `bober facts <add|list|show|invalidate>` — manage semantic bi-temporal facts.
 *
 * Subcommands:
 *   add         — Insert a new fact into the store.
 *   list        — Print active (non-invalidated) facts.
 *   show <id>   — Print one fact including provenance and temporal fields.
 *   invalidate  — Soft-delete a fact (sets t_invalidated; never removes the row).
 *
 * Error handling: CLI handlers MUST NOT throw. They set process.exitCode=1 and
 * return on all errors. Pattern mirrors src/cli/commands/memory.ts.
 */

import chalk from "chalk";
import type { Command } from "commander";

import { findProjectRoot } from "../../utils/fs.js";
import { loadConfig } from "../../config/loader.js";
import { loadTeam } from "../../teams/registry.js";
import {
  FactStore,
  factsDbPath,
  ensureFactsDir,
  writeFact,
} from "../../state/facts.js";

// ── Root resolver ─────────────────────────────────────────────────────

async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}

// ── Namespace resolver ────────────────────────────────────────────────

/**
 * Resolve the active memory namespace from the default team.
 * Falls back to undefined (current .bober/memory/ path) if config is missing.
 * Never throws — config absence is not fatal for facts commands.
 */
async function resolveDefaultNamespace(
  projectRoot: string,
): Promise<string | undefined> {
  try {
    const config = await loadConfig(projectRoot);
    return loadTeam(config, undefined).memoryNamespace || undefined;
  } catch {
    return undefined;
  }
}

// ── registerFactsCommand ──────────────────────────────────────────────

export function registerFactsCommand(program: Command): void {
  const factsCmd = program
    .command("facts")
    .description(
      "Inspect and manage semantic bi-temporal facts (add, list, show, invalidate)",
    );

  // ── facts add ────────────────────────────────────────────────────
  factsCmd
    .command("add")
    .description("Insert a new semantic fact into the store")
    .requiredOption("--scope <scope>", "Fact scope (e.g. programming)", "programming")
    .requiredOption("--subject <subject>", "Fact subject (e.g. project)")
    .requiredOption("--predicate <predicate>", "Fact predicate (e.g. testCommand)")
    .requiredOption("--value <value>", "Fact value (e.g. vitest)")
    .option("--confidence <n>", "Confidence score 0.0-1.0", "1")
    .option("--run-id <runId>", "Source run id")
    .action(
      async (opts: {
        scope: string;
        subject: string;
        predicate: string;
        value: string;
        confidence: string;
        runId?: string;
      }) => {
        const projectRoot = await resolveRoot();
        try {
          const ns = await resolveDefaultNamespace(projectRoot);
          await ensureFactsDir(projectRoot, ns);

          // Stamp wall-clock time at handler boundary — NEVER inside the store
          const now = new Date().toISOString();

          const input = {
            scope: opts.scope,
            subject: opts.subject,
            predicate: opts.predicate,
            value: opts.value,
            confidence: Math.max(0, Math.min(1, Number(opts.confidence) || 1)),
            sourceRunId: opts.runId ?? null,
            tValid: now,
            tCreated: now,
          };

          const store = new FactStore(factsDbPath(projectRoot, ns));
          try {
            // Route through writeFact so duplicate/supersede reconciliation runs.
            // No judge wired here — deterministic ADD/UPDATE/NOOP only.
            const action = await writeFact(store, input, { now });
            if (action === "noop") {
              process.stdout.write(
                chalk.gray(`Fact unchanged (identical value already active).\n`),
              );
              process.stdout.write(`  scope:     ${input.scope}\n`);
              process.stdout.write(`  subject:   ${input.subject}\n`);
              process.stdout.write(`  predicate: ${input.predicate}\n`);
              process.stdout.write(`  value:     ${input.value}\n`);
            } else if (action === "update") {
              process.stdout.write(
                chalk.yellow(`Superseded — prior fact invalidated.\n`),
              );
              process.stdout.write(`  scope:     ${input.scope}\n`);
              process.stdout.write(`  subject:   ${input.subject}\n`);
              process.stdout.write(`  predicate: ${input.predicate}\n`);
              process.stdout.write(`  value:     ${input.value}\n`);
              process.stdout.write(`  t_created: ${input.tCreated}\n`);
            } else {
              // "add" (including deterministic fallback from ambiguity branch)
              process.stdout.write(
                chalk.green(`Added fact\n`),
              );
              process.stdout.write(`  scope:     ${input.scope}\n`);
              process.stdout.write(`  subject:   ${input.subject}\n`);
              process.stdout.write(`  predicate: ${input.predicate}\n`);
              process.stdout.write(`  value:     ${input.value}\n`);
              process.stdout.write(`  t_created: ${input.tCreated}\n`);
            }
          } finally {
            store.close();
          }
        } catch (err) {
          process.stderr.write(
            chalk.red(
              `Failed to add fact: ${err instanceof Error ? err.message : String(err)}\n`,
            ),
          );
          process.exitCode = 1;
        }
      },
    );

  // ── facts list ───────────────────────────────────────────────────
  factsCmd
    .command("list")
    .description("Print active (non-invalidated) facts")
    .option("--scope <scope>", "Filter by scope", "programming")
    .option("--subject <subject>", "Filter by subject")
    .option("--predicate <predicate>", "Filter by predicate")
    .action(
      async (opts: {
        scope: string;
        subject?: string;
        predicate?: string;
      }) => {
        const projectRoot = await resolveRoot();
        try {
          const ns = await resolveDefaultNamespace(projectRoot);
          await ensureFactsDir(projectRoot, ns);

          const store = new FactStore(factsDbPath(projectRoot, ns));
          try {
            const records = store.getActiveFacts(
              opts.scope,
              opts.subject,
              opts.predicate,
            );

            if (records.length === 0) {
              process.stdout.write(
                chalk.gray("No active facts found.\n"),
              );
              return;
            }

            process.stdout.write(
              chalk.bold(
                `${"ID".padEnd(18)} ${"SUBJECT".padEnd(20)} ${"PREDICATE".padEnd(22)} VALUE\n`,
              ),
            );
            process.stdout.write(`${"-".repeat(90)}\n`);

            for (const r of records) {
              const valueSnippet =
                r.value.length > 30 ? `${r.value.slice(0, 27)}...` : r.value;
              process.stdout.write(
                `${r.id.padEnd(18)} ${r.subject.padEnd(20)} ${r.predicate.padEnd(22)} ${valueSnippet}\n`,
              );
            }
          } finally {
            store.close();
          }
        } catch (err) {
          process.stderr.write(
            chalk.red(
              `Failed to list facts: ${err instanceof Error ? err.message : String(err)}\n`,
            ),
          );
          process.exitCode = 1;
        }
      },
    );

  // ── facts show <id> ──────────────────────────────────────────────
  factsCmd
    .command("show <id>")
    .description("Print one fact with full provenance and temporal fields")
    .action(async (id: string) => {
      const projectRoot = await resolveRoot();
      try {
        const ns = await resolveDefaultNamespace(projectRoot);
        await ensureFactsDir(projectRoot, ns);

        const store = new FactStore(factsDbPath(projectRoot, ns));
        try {
          const rec = store.getFact(id);

          if (rec === null) {
            process.stderr.write(chalk.yellow(`Fact not found: ${id}\n`));
            process.exitCode = 1;
            return;
          }

          process.stdout.write(chalk.bold(`Fact: ${rec.id}\n`));
          process.stdout.write(`  scope:        ${rec.scope}\n`);
          process.stdout.write(`  subject:      ${rec.subject}\n`);
          process.stdout.write(`  predicate:    ${rec.predicate}\n`);
          process.stdout.write(`  value:        ${rec.value}\n`);
          process.stdout.write(`  confidence:   ${rec.confidence}\n`);
          process.stdout.write(
            `  source_run:   ${rec.sourceRunId ?? "(none)"}\n`,
          );
          process.stdout.write(`  t_valid:      ${rec.tValid}\n`);
          process.stdout.write(
            `  t_invalid:    ${rec.tInvalid ?? "(none)"}\n`,
          );
          process.stdout.write(`  t_created:    ${rec.tCreated}\n`);
          process.stdout.write(
            `  t_invalidated: ${rec.tInvalidated ?? chalk.green("(active)")}\n`,
          );
        } finally {
          store.close();
        }
      } catch (err) {
        process.stderr.write(
          chalk.red(
            `Failed to show fact: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
        process.exitCode = 1;
      }
    });

  // ── facts invalidate <id> ────────────────────────────────────────
  factsCmd
    .command("invalidate <id>")
    .description("Soft-delete a fact (sets t_invalidated; row is kept)")
    .action(async (id: string) => {
      const projectRoot = await resolveRoot();
      try {
        const ns = await resolveDefaultNamespace(projectRoot);
        await ensureFactsDir(projectRoot, ns);

        // Stamp wall-clock time at handler boundary — NEVER inside the store
        const now = new Date().toISOString();

        const store = new FactStore(factsDbPath(projectRoot, ns));
        try {
          const changed = store.invalidateFact(id, now);

          if (!changed) {
            process.stderr.write(
              chalk.yellow(
                `Fact ${id} not found or already invalidated.\n`,
              ),
            );
            process.exitCode = 1;
            return;
          }

          process.stdout.write(
            chalk.green(
              `Fact ${chalk.bold(id)} invalidated at ${now}\n`,
            ),
          );
        } finally {
          store.close();
        }
      } catch (err) {
        process.stderr.write(
          chalk.red(
            `Failed to invalidate fact: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
        process.exitCode = 1;
      }
    });
}
