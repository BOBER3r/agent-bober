import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ensureDir } from "./helpers.js";

const DESIGNS_DIR = ".bober/designs";

function designsDir(projectRoot: string): string {
  return join(projectRoot, DESIGNS_DIR);
}

function designPath(projectRoot: string, specId: string): string {
  const safeId = specId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(designsDir(projectRoot), `${safeId}-design.md`);
}

/**
 * Save a design discussion document to disk as a markdown file.
 * Overwrites any existing document with the same specId.
 *
 * The content should be a complete markdown document with sections:
 * - Current State
 * - Desired End State
 * - Patterns to Follow
 * - Resolved Design Decisions
 * - Open Questions
 */
export async function saveDesign(
  projectRoot: string,
  specId: string,
  content: string,
): Promise<void> {
  await ensureDir(designsDir(projectRoot));

  const filePath = designPath(projectRoot, specId);
  await writeFile(filePath, content, "utf-8");
}

/**
 * Read a design discussion document by specId.
 * Returns the raw markdown content.
 * Throws if not found.
 */
export async function readDesign(
  projectRoot: string,
  specId: string,
): Promise<string> {
  const filePath = designPath(projectRoot, specId);

  try {
    return await readFile(filePath, "utf-8");
  } catch (err) {
    throw new Error(
      `Design document for spec "${specId}" not found at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}
