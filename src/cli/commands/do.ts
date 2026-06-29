/**
 * `bober do <findingId> --dry-run` — preview the promotion plan for a hub Finding.
 *
 * Error handling: CLI handlers MUST NOT throw. Set process.exitCode=1 and return.
 * --dry-run is the only active path this sprint; real launch is Sprint 2.
 *
 * HARD BOUNDARY: this file MUST NOT import execa, node:child_process,
 * or any RunSpawner. The dry-run path reads + prints only.
 */

import chalk from "chalk";
import type { Command } from "commander";

import { findProjectRoot } from "../../utils/fs.js";
import { loadConfig } from "../../config/loader.js";
import { loadTeam } from "../../teams/registry.js";
import { FactStore, factsDbPath, ensureFactsDir } from "../../state/facts.js";
import type { FindingStore } from "../../do-bridge/finding-port.js";
import { FactStoreFindingStore } from "../../do-bridge/finding-port.js";
import { PromoterRegistry } from "../../do-bridge/registry.js";
import { codingPromoter } from "../../do-bridge/coding-promoter.js";

// ── Root resolver ─────────────────────────────────────────────────────

async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}

// ── Namespace resolver ────────────────────────────────────────────────

/**
 * Resolve the active memory namespace from the default team.
 * Falls back to undefined (default .bober/memory/ path) if config is absent.
 * Never throws — config absence is not fatal.
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

// ── runDo (DI core) ───────────────────────────────────────────────────

/**
 * DI core for `bober do` — accepts injected FindingStore + registry so tests
 * can drive it without opening a real DB or spawning anything.
 *
 * Never throws: every failure branch sets process.exitCode=1 and returns.
 *
 * Resolution branches:
 *  1. finding === null          → stderr "no finding with id …" + exitCode 1 + return.
 *  2. promoter === undefined    → stderr naming the unsupported domain + exitCode 1 + return.
 *  3. --dry-run                 → print ONE stdout line containing plan.task + "dry-run"; NO writes.
 *  4. non-dry-run (Sprint 2)   → print a notice; must NOT spawn anything.
 */
export async function runDo(
  store: FindingStore,
  registry: PromoterRegistry,
  findingId: string,
  opts: { dryRun?: boolean },
): Promise<void> {
  // Branch 1: look up the finding
  const finding = await store.readFinding(findingId);
  if (finding === null) {
    process.stderr.write(
      chalk.red(`do: no finding with id '${findingId}'\n`),
    );
    process.exitCode = 1;
    return;
  }

  // Branch 2: resolve the promoter
  const promoter = registry.resolve({ domain: finding.domain, kind: finding.kind });
  if (promoter === undefined) {
    process.stderr.write(
      chalk.red(
        `do: unsupported domain '${finding.domain}' — no promoter registered for this domain\n`,
      ),
    );
    process.exitCode = 1;
    return;
  }

  // Branch 3: build the promotion plan
  const plan = promoter(finding);
  const teamDisplay = plan.teamId !== undefined ? plan.teamId : "default team";

  if (opts.dryRun) {
    // Dry-run: print the plan and return — NO writes, NO spawns (evaluator checks this)
    process.stdout.write(
      chalk.green(
        `[dry-run] would launch: bober run "${plan.task}" (team: ${teamDisplay})\n`,
      ),
    );
    return;
  }

  // Branch 4: non-dry-run (Sprint 2 territory) — real launch not implemented yet
  process.stdout.write(
    chalk.yellow(
      `Real launch is not implemented yet. Use --dry-run to preview the planned task.\n`,
    ),
  );
}

// ── registerDoCommand ─────────────────────────────────────────────────

export function registerDoCommand(program: Command): void {
  program
    .command("do <findingId>")
    .description("Promote a hub Finding into a bober run task")
    .option("--dry-run", "Preview the planned launch without spawning anything", false)
    .action(async (findingId: string, opts: { dryRun?: boolean }) => {
      const projectRoot = await resolveRoot();
      try {
        const ns = await resolveDefaultNamespace(projectRoot);
        await ensureFactsDir(projectRoot, ns);

        const store = new FactStore(factsDbPath(projectRoot, ns));
        const findingStore = new FactStoreFindingStore(store);

        // Build and populate the registry at the CLI boundary
        const registry = new PromoterRegistry();
        registry.register({ domain: "coding" }, codingPromoter);
        registry.register({ domain: "projects" }, codingPromoter);

        try {
          await runDo(findingStore, registry, findingId, opts);
        } finally {
          store.close();
        }
      } catch (err) {
        process.stderr.write(
          chalk.red(
            `do failed: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
        process.exitCode = 1;
      }
    });
}
