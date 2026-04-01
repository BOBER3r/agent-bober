import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { ensureDir } from "./helpers.js";

const BRIEFING_DIR = ".bober/briefings";

function briefingDir(projectRoot: string): string {
  return join(projectRoot, BRIEFING_DIR);
}

function briefingPath(projectRoot: string, contractId: string): string {
  const safeId = contractId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(briefingDir(projectRoot), `${safeId}-briefing.md`);
}

/**
 * Save a Sprint Briefing to disk as a markdown file.
 * Overwrites any existing briefing for the same contract.
 */
export async function saveBriefing(
  projectRoot: string,
  contractId: string,
  content: string,
): Promise<void> {
  await ensureDir(briefingDir(projectRoot));
  const filePath = briefingPath(projectRoot, contractId);
  await writeFile(filePath, content, "utf-8");
}

/**
 * Read a Sprint Briefing by contract ID.
 * Returns null if not found (briefings are optional).
 */
export async function readBriefing(
  projectRoot: string,
  contractId: string,
): Promise<string | null> {
  const filePath = briefingPath(projectRoot, contractId);

  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * List all saved briefing contract IDs, sorted by filename.
 */
export async function listBriefings(projectRoot: string): Promise<string[]> {
  const dir = briefingDir(projectRoot);

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  return entries
    .filter((f) => f.endsWith("-briefing.md"))
    .sort()
    .map((f) => f.slice(0, -("-briefing.md".length)));
}
