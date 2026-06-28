/**
 * `bober hub list` — print findings held in the project's own FactStore.
 *
 * Error handling: handlers MUST NOT throw. Set process.exitCode=1 and return.
 * Pattern mirrors src/cli/commands/facts.ts and src/cli/commands/blackboard.ts.
 */

import chalk from "chalk";
import type { Command } from "commander";

import { findProjectRoot } from "../../utils/fs.js";
import { loadConfig } from "../../config/loader.js";
import { loadTeam } from "../../teams/registry.js";
import { FactStore, factsDbPath, ensureFactsDir } from "../../state/facts.js";
import { FactStoreFindingSource, HUB_SCOPE } from "../../hub/finding-source.js";
import type { FindingSource } from "../../hub/finding-source.js";

// ── Root resolver ─────────────────────────────────────────────────────

async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}

// ── Namespace resolver ────────────────────────────────────────────────

/**
 * Resolve the active memory namespace from the default team.
 * Falls back to undefined (current .bober/memory/ path) if config is missing.
 * Never throws — config absence is not fatal for hub commands.
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

// ── runHubList ────────────────────────────────────────────────────────

/**
 * DI core for `hub list` — accepts an injected FindingSource so tests can
 * drive it against an in-memory store without spawning the CLI.
 * Prints one line per finding with title, kind, urgency, and severity.
 */
export function runHubList(source: FindingSource): void {
  const findings = source.read();
  if (findings.length === 0) {
    process.stdout.write(chalk.gray("No findings found.\n"));
    return;
  }
  for (const f of findings) {
    process.stdout.write(
      `${f.title}  [${f.kind}]  urgency=${f.urgency}  severity=${f.severity}\n`,
    );
  }
}

// ── registerHubCommand ────────────────────────────────────────────────

export function registerHubCommand(program: Command): void {
  const hubCmd = program
    .command("hub")
    .description("Unified cross-domain priority hub");

  hubCmd
    .command("list")
    .description("Print findings held in the project's own FactStore")
    .action(async () => {
      const projectRoot = await resolveRoot();
      try {
        const ns = await resolveDefaultNamespace(projectRoot);
        await ensureFactsDir(projectRoot, ns);
        const store = new FactStore(factsDbPath(projectRoot, ns));
        try {
          runHubList(new FactStoreFindingSource(store, HUB_SCOPE));
        } finally {
          store.close();
        }
      } catch (err) {
        process.stderr.write(
          chalk.red(
            `Failed to list findings: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
        process.exitCode = 1;
      }
    });
}
