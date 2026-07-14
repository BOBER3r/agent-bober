import { readFile, writeFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { ensureDir } from "../state/helpers.js";
import { ResearchJobSchema, type ResearchJob } from "./types.js";

// ── Path helpers ──────────────────────────────────────────────────────

const JOBS_DIR = ".bober/research/jobs";

function jobsDir(projectRoot: string): string {
  return join(projectRoot, JOBS_DIR);
}

function jobPath(projectRoot: string, id: string): string {
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(jobsDir(projectRoot), `${safeId}.json`);
}

// ── Deterministic id ──────────────────────────────────────────────────

/**
 * Derive a deterministic 16-char hex job id from a question slug + createdAt.
 * Mirrors factId in src/state/facts.ts:58-69 — no wall-clock dependency.
 * The CLI stamps createdAt at the handler boundary and passes it here.
 */
export function jobId(question: string, createdAt: string): string {
  return createHash("sha256")
    .update(`${question}|${createdAt}`)
    .digest("hex")
    .slice(0, 16);
}

// ── Store operations ──────────────────────────────────────────────────

/**
 * Persist a research job as a JSON file.
 * Validates with ResearchJobSchema before writing so an invalid job never
 * reaches disk (mirrors plan-state.ts:22-38).
 */
export async function addJob(
  projectRoot: string,
  job: ResearchJob,
): Promise<void> {
  await ensureDir(jobsDir(projectRoot));

  const validation = ResearchJobSchema.safeParse(job);
  if (!validation.success) {
    const issues = validation.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid research job:\n${issues}`);
  }

  await writeFile(
    jobPath(projectRoot, job.id),
    JSON.stringify(validation.data, null, 2) + "\n",
    "utf-8",
  );
}

/**
 * List all persisted research jobs, sorted by filename.
 * Returns [] if the jobs directory does not exist yet.
 * Malformed JSON files are silently skipped (mirrors plan-state.ts:106-140).
 */
export async function listJobs(
  projectRoot: string,
): Promise<ResearchJob[]> {
  let entries: string[];
  try {
    entries = await readdir(jobsDir(projectRoot));
  } catch {
    // Directory absent — no jobs yet.
    return [];
  }

  const jobs: ResearchJob[] = [];
  for (const file of entries.filter((f) => f.endsWith(".json")).sort()) {
    try {
      const raw: unknown = JSON.parse(
        await readFile(join(jobsDir(projectRoot), file), "utf-8"),
      );
      const result = ResearchJobSchema.safeParse(raw);
      if (result.success) {
        jobs.push(result.data);
      }
    } catch {
      // Skip malformed files
    }
  }
  return jobs;
}

/**
 * Read a single research job by id.
 * Returns null if not found or malformed.
 */
export async function readJob(
  projectRoot: string,
  id: string,
): Promise<ResearchJob | null> {
  try {
    const raw: unknown = JSON.parse(
      await readFile(jobPath(projectRoot, id), "utf-8"),
    );
    const result = ResearchJobSchema.safeParse(raw);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Delete a research job by id. Returns true if deleted, false if not found.
 * Mirrors approval-state.ts:138-140.
 */
export async function removeJob(
  projectRoot: string,
  id: string,
): Promise<boolean> {
  try {
    await unlink(jobPath(projectRoot, id));
    return true;
  } catch {
    return false;
  }
}
