import { resolve, dirname } from "node:path";
import { readdir } from "node:fs/promises";

import { fileExists } from "../utils/fs.js";
import { factsDbPath } from "../state/facts.js";

// ── resolveSiblingRepos ───────────────────────────────────────────────

/**
 * Turn configured hub.repos (if any) OR discovered `kb-*` siblings into
 * absolute repo-root paths whose derived facts.db actually exists.
 * Never throws: a configured path that does not exist is skipped.
 *
 * @param projectRoot  Absolute path to the current project root.
 * @param configuredRepos  Optional list from config hub.repos; pass undefined
 *   to fall through to kb-* sibling discovery.
 */
export async function resolveSiblingRepos(
  projectRoot: string,
  configuredRepos?: string[],
): Promise<string[]> {
  const candidates: string[] =
    configuredRepos && configuredRepos.length > 0
      ? configuredRepos.map((r) => resolve(projectRoot, r))
      : await discoverKbSiblings(projectRoot);

  const out: string[] = [];
  for (const repo of candidates) {
    if (await fileExists(factsDbPath(repo))) out.push(repo);
  }
  return out;
}

// ── discoverKbSiblings ────────────────────────────────────────────────

async function discoverKbSiblings(projectRoot: string): Promise<string[]> {
  const parent = dirname(projectRoot);
  try {
    const entries = await readdir(parent, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && /^kb-/.test(e.name))
      .map((e) => resolve(parent, e.name));
  } catch {
    return [];
  }
}
