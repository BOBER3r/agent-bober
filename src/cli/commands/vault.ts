/**
 * `bober vault reindex` — rebuild the derived FactStore from an Obsidian vault.
 *
 * Walks all `.md` files under a vault directory, parses their YAML frontmatter,
 * and reconcile-at-ingest writes each frontmatter key as a FactInput into the
 * team/namespace FactStore. Mirrors the facts.ts / medical.ts CLI pattern exactly:
 *   - Handler never throws — errors set process.exitCode=1 and write chalk.red.
 *   - Store is always closed in a finally block.
 *   - Wall-clock time is read exactly ONCE at the handler boundary.
 *   - Vault directory defaults to projectRoot when --vault is omitted.
 */

import { stat } from "node:fs/promises";
import chalk from "chalk";
import type { Command } from "commander";

import { findProjectRoot } from "../../utils/fs.js";
import { loadConfig } from "../../config/loader.js";
import { loadTeam } from "../../teams/registry.js";
import { FactStore, factsDbPath, ensureFactsDir } from "../../state/facts.js";
import { listNotes, readNote } from "../../vault/note-io.js";
import { reindexNotes } from "../../vault/reindex.js";
import type { ReindexSummary } from "../../vault/reindex.js";

// ── Root resolver ─────────────────────────────────────────────────────

async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}

// ── Namespace resolver ────────────────────────────────────────────────

/**
 * Resolve the active memory namespace from the default team.
 * Falls back to undefined (-> .bober/memory/) if config is missing.
 * Never throws — config absence is not fatal.
 * NOTE: resolveDefaultNamespace is private in facts.ts — re-implemented here verbatim.
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

// ── Deps injection ────────────────────────────────────────────────────

/** Injectable dependencies for runVaultReindex — production callers pass undefined. */
export interface VaultReindexDeps {
  /** Override the current time ISO string (default: new Date().toISOString()). */
  nowIso?: string;
}

// ── Core ──────────────────────────────────────────────────────────────

/**
 * Core logic for `bober vault reindex`.
 * Extracted so tests can inject a temp projectRoot and assert on the FactStore
 * without spawning a process. The CLI .action() calls this with no deps (production).
 *
 * @param projectRoot Absolute path to the project root (for FactStore namespace resolution).
 * @param opts.scope  Fact scope label passed to reindexNotes (e.g. "medical", "finance").
 * @param opts.vault  Vault directory to read notes from. Defaults to `projectRoot` when omitted.
 * @param deps        Optional injectable deps (nowIso for testing).
 * @returns The ReindexSummary on success, or undefined if an error occurred (exitCode=1).
 */
export async function runVaultReindex(
  projectRoot: string,
  opts: { scope: string; vault?: string },
  deps: VaultReindexDeps = {},
): Promise<ReindexSummary | undefined> {
  // Declare store OUTSIDE try so finally can always close it (medical.ts:48)
  let store: FactStore | undefined;
  try {
    const ns = await resolveDefaultNamespace(projectRoot);
    // ensureFactsDir BEFORE constructing a file-backed FactStore (facts.ts:83)
    await ensureFactsDir(projectRoot, ns);

    // Stamp wall-clock time ONCE at the handler boundary — NEVER inside the store
    // or reindex (mirrors facts.ts:86, medical.ts:89)
    const now = deps.nowIso ?? new Date().toISOString();

    // --vault defaults to projectRoot (no config field for vault path exists)
    const vaultDir = opts.vault ?? projectRoot;

    // Construct store BEFORE the vault dir check so the finally always closes it
    // on the missing-vault error path (store?.close() is safe when store is defined)
    store = new FactStore(factsDbPath(projectRoot, ns));

    // Explicit vault dir existence check: listNotes uses glob which returns []
    // (not throws) for a nonexistent directory — so we must stat explicitly.
    let vaultStat;
    try {
      vaultStat = await stat(vaultDir);
    } catch {
      throw new Error(`Vault directory does not exist: ${vaultDir}`);
    }
    if (!vaultStat.isDirectory()) {
      throw new Error(`Vault path is not a directory: ${vaultDir}`);
    }

    const paths = await listNotes(vaultDir);
    const notes = [];
    for (const p of paths) notes.push(await readNote(p));

    const summary = await reindexNotes(store, notes, { scope: opts.scope, now });

    process.stdout.write(chalk.green(`Reindexed vault (scope: ${opts.scope})\n`));
    process.stdout.write(`  notes parsed:      ${summary.notesParsed}\n`);
    process.stdout.write(`  facts added:       ${summary.factsAdded}\n`);
    process.stdout.write(`  facts superseded:  ${summary.factsSuperseded}\n`);
    process.stdout.write(`  facts unchanged:   ${summary.factsNoop}\n`);

    return summary;
  } catch (err) {
    process.stderr.write(
      chalk.red(
        `Failed to reindex vault: ${err instanceof Error ? err.message : String(err)}\n`,
      ),
    );
    process.exitCode = 1;
    return undefined;
  } finally {
    // ALWAYS close — even if reindex threw mid-walk (mirrors medical.ts:118-120)
    store?.close();
  }
}

// ── registerVaultCommand ──────────────────────────────────────────────

/**
 * Register the `bober vault` command tree.
 * Provides `vault reindex --scope <domain> [--vault <dir>]`.
 * Mirrors registerMedicalCommand / registerFactsCommand shape.
 */
export function registerVaultCommand(program: Command): void {
  const vaultCmd = program
    .command("vault")
    .description(
      "Vault knowledge-base utilities (reindex Obsidian notes into the FactStore)",
    );

  vaultCmd
    .command("reindex")
    .description(
      "Rebuild the derived FactStore from a vault directory's note frontmatter",
    )
    .requiredOption("--scope <domain>", "Fact scope label (e.g. medical, finance)")
    .option(
      "--vault <dir>",
      "Vault directory to read notes from (default: project root)",
    )
    .action(async (opts: { scope: string; vault?: string }) => {
      const projectRoot = await resolveRoot();
      await runVaultReindex(projectRoot, opts);
    });
}
