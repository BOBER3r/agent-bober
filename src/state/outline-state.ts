import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ensureDir } from "./helpers.js";

const OUTLINES_DIR = ".bober/outlines";

function outlinesDir(projectRoot: string): string {
  return join(projectRoot, OUTLINES_DIR);
}

function outlinePath(projectRoot: string, specId: string): string {
  const safeId = specId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(outlinesDir(projectRoot), `${safeId}-outline.md`);
}

/**
 * Save a structure outline document to disk as a markdown file.
 * Overwrites any existing outline with the same specId.
 *
 * The content should be a complete markdown document with sections per phase:
 * - Phase title
 * - Key Changes (types, signatures, interfaces)
 * - Files affected
 * - Test Checkpoint (how to verify independently)
 * - Depends On (prior phases)
 */
export async function saveOutline(
  projectRoot: string,
  specId: string,
  content: string,
): Promise<void> {
  await ensureDir(outlinesDir(projectRoot));

  const filePath = outlinePath(projectRoot, specId);
  await writeFile(filePath, content, "utf-8");
}

/**
 * Read a structure outline document by specId.
 * Returns the raw markdown content.
 * Throws if not found.
 */
export async function readOutline(
  projectRoot: string,
  specId: string,
): Promise<string> {
  const filePath = outlinePath(projectRoot, specId);

  try {
    return await readFile(filePath, "utf-8");
  } catch (err) {
    throw new Error(
      `Structure outline for spec "${specId}" not found at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}
