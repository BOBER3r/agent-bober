import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { ensureDir } from "./helpers.js";

const ARCHITECTURE_DIR = ".bober/architecture";

function architectureDir(projectRoot: string): string {
  return join(projectRoot, ARCHITECTURE_DIR);
}

function architecturePath(projectRoot: string, id: string): string {
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(architectureDir(projectRoot), `${safeId}-architecture.md`);
}

function adrPath(projectRoot: string, id: string, adrNumber: number): string {
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(architectureDir(projectRoot), `${safeId}-adr-${adrNumber}.md`);
}

/**
 * Save an architecture document to disk.
 * Overwrites any existing document with the same id.
 */
export async function saveArchitecture(
  projectRoot: string,
  id: string,
  content: string,
): Promise<void> {
  await ensureDir(architectureDir(projectRoot));

  const filePath = architecturePath(projectRoot, id);
  await writeFile(filePath, content, "utf-8");
}

/**
 * Read an architecture document by id.
 * Throws if not found.
 */
export async function readArchitecture(
  projectRoot: string,
  id: string,
): Promise<string> {
  const filePath = architecturePath(projectRoot, id);

  try {
    return await readFile(filePath, "utf-8");
  } catch (err) {
    throw new Error(
      `Architecture document "${id}" not found: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

/**
 * Save an individual ADR file for an architecture.
 * ADRs are saved as separate files: <id>-adr-<N>.md
 */
export async function saveADR(
  projectRoot: string,
  id: string,
  adrNumber: number,
  content: string,
): Promise<void> {
  await ensureDir(architectureDir(projectRoot));

  const filePath = adrPath(projectRoot, id, adrNumber);
  await writeFile(filePath, content, "utf-8");
}

/**
 * Read all ADR files for an architecture, sorted by ADR number.
 * Returns an empty array if none exist.
 */
export async function readADRs(
  projectRoot: string,
  id: string,
): Promise<string[]> {
  const dir = architectureDir(projectRoot);
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  const prefix = `${safeId}-adr-`;

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // Directory doesn't exist yet
    return [];
  }

  const adrFiles = entries
    .filter((f) => f.startsWith(prefix) && f.endsWith(".md"))
    .sort((a, b) => {
      // Sort numerically by ADR number
      const numA = parseInt(a.slice(prefix.length, -3), 10);
      const numB = parseInt(b.slice(prefix.length, -3), 10);
      return numA - numB;
    });

  const adrs: string[] = [];
  for (const file of adrFiles) {
    const content = await readFile(join(dir, file), "utf-8");
    adrs.push(content);
  }

  return adrs;
}

/**
 * List all saved architecture IDs, sorted by filename.
 */
export async function listArchitectures(projectRoot: string): Promise<string[]> {
  const dir = architectureDir(projectRoot);

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // Directory doesn't exist yet
    return [];
  }

  return entries
    .filter((f) => f.endsWith("-architecture.md"))
    .sort()
    .map((f) => f.slice(0, -"-architecture.md".length));
}
