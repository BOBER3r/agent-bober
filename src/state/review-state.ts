import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { ensureDir } from "./helpers.js";

const REVIEW_DIR = ".bober/reviews";

function reviewDir(projectRoot: string): string {
  return join(projectRoot, REVIEW_DIR);
}

function reviewPath(projectRoot: string, contractId: string): string {
  const safeId = contractId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(reviewDir(projectRoot), `${safeId}-review.md`);
}

/**
 * Save a sprint review markdown file to disk.
 * Uses mkdir -p semantics (idempotent). Overwrites any existing review for the same contract.
 */
export async function saveReview(
  projectRoot: string,
  contractId: string,
  content: string,
): Promise<void> {
  await ensureDir(reviewDir(projectRoot));
  const filePath = reviewPath(projectRoot, contractId);
  await writeFile(filePath, content, "utf-8");
}

/**
 * Read a sprint review by contract ID.
 * Returns null if not found (reviews may not exist for all sprints).
 */
export async function readReview(
  projectRoot: string,
  contractId: string,
): Promise<string | null> {
  const filePath = reviewPath(projectRoot, contractId);

  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * List all saved review contract IDs, sorted by filename.
 */
export async function listReviews(projectRoot: string): Promise<string[]> {
  const dir = reviewDir(projectRoot);

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  return entries
    .filter((f) => f.endsWith("-review.md"))
    .sort()
    .map((f) => f.slice(0, -("-review.md".length)));
}
