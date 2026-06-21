import { readFile } from "node:fs/promises";
import { join } from "node:path";

const OUTLINES_DIR = ".bober/outlines";

function outlinesDir(projectRoot: string): string {
  return join(projectRoot, OUTLINES_DIR);
}

function outlinePath(projectRoot: string, specId: string): string {
  const safeId = specId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(outlinesDir(projectRoot), `${safeId}-outline.md`);
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
