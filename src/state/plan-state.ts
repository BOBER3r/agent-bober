import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { PlanSpecSchema, type PlanSpec } from "../contracts/spec.js";
import { ensureDir } from "./helpers.js";

const SPECS_DIR = ".bober/specs";

function specsDir(projectRoot: string): string {
  return join(projectRoot, SPECS_DIR);
}

function specPath(projectRoot: string, id: string): string {
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(specsDir(projectRoot), `${safeId}.json`);
}

/**
 * Save a plan spec to disk.
 * Overwrites any existing spec with the same id.
 */
export async function saveSpec(
  projectRoot: string,
  spec: PlanSpec,
): Promise<void> {
  await ensureDir(specsDir(projectRoot));

  const validation = PlanSpecSchema.safeParse(spec);
  if (!validation.success) {
    const issues = validation.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid spec:\n${issues}`);
  }

  const filePath = specPath(projectRoot, spec.specId);
  await writeFile(filePath, JSON.stringify(spec, null, 2), "utf-8");
}

/**
 * Load a plan spec by id.
 * Throws if not found or invalid.
 */
export async function loadSpec(
  projectRoot: string,
  id: string,
): Promise<PlanSpec> {
  const filePath = specPath(projectRoot, id);

  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (err) {
    throw new Error(
      `Spec "${id}" not found: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(
      `Invalid JSON in spec file for "${id}": ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const result = PlanSpecSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Spec "${id}" failed validation:\n${issues}`);
  }

  return result.data;
}

/**
 * Load the most recently created spec (by `createdAt` field).
 * Returns null if no specs exist.
 */
export async function loadLatestSpec(
  projectRoot: string,
): Promise<PlanSpec | null> {
  const specs = await listSpecs(projectRoot);
  if (specs.length === 0) {
    return null;
  }

  // Sort by createdAt descending and return the newest
  specs.sort((a, b) => {
    const dateA = new Date(a.createdAt).getTime();
    const dateB = new Date(b.createdAt).getTime();
    return dateB - dateA;
  });

  return specs[0];
}

/**
 * List all saved specs, sorted by filename.
 */
export async function listSpecs(
  projectRoot: string,
): Promise<PlanSpec[]> {
  const dir = specsDir(projectRoot);

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // Directory doesn't exist yet
    return [];
  }

  const jsonFiles = entries
    .filter((f) => f.endsWith(".json"))
    .sort();

  const specs: PlanSpec[] = [];

  for (const file of jsonFiles) {
    const filePath = join(dir, file);
    try {
      const content = await readFile(filePath, "utf-8");
      const parsed: unknown = JSON.parse(content);
      const result = PlanSpecSchema.safeParse(parsed);
      if (result.success) {
        specs.push(result.data);
      }
    } catch {
      // Skip malformed files
    }
  }

  return specs;
}
