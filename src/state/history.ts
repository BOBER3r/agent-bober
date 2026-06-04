import { readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import type { SprintContract } from "../contracts/sprint-contract.js";
import type { PlanSpec } from "../contracts/spec.js";
import { ensureDir } from "./helpers.js";
import { rotateIfNeeded, historyArchivePath } from "./history-rotation.js";

// ── Constants ───────────────────────────────────────────────────────

const BOBER_DIR = ".bober";
const HISTORY_FILE = "history.jsonl";
const PROGRESS_FILE = "progress.md";

function historyPath(projectRoot: string): string {
  return join(projectRoot, BOBER_DIR, HISTORY_FILE);
}

function progressPath(projectRoot: string): string {
  return join(projectRoot, BOBER_DIR, PROGRESS_FILE);
}

// ── History Entry ───────────────────────────────────────────────────

export const PhaseSchema = z.enum([
  "init",
  "planning",
  "curating",
  "generating",
  "evaluating",
  "rework",
  "complete",
  "failed",
]);
export type Phase = z.infer<typeof PhaseSchema>;

export const HistoryEntrySchema = z.object({
  timestamp: z.string().datetime(),
  event: z.string().min(1),
  phase: PhaseSchema,
  sprintId: z.string().optional(),
  details: z.record(z.string(), z.unknown()),
});
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

// ── Parse Helpers ───────────────────────────────────────────────────

/**
 * Parse a JSONL content string into HistoryEntry objects.
 * Skips malformed or invalid lines without throwing.
 */
function parseEntries(content: string): HistoryEntry[] {
  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  const entries: HistoryEntry[] = [];

  for (const line of lines) {
    try {
      const parsed: unknown = JSON.parse(line);
      const result = HistoryEntrySchema.safeParse(parsed);
      if (result.success) {
        entries.push(result.data);
      }
    } catch {
      // Skip malformed lines
    }
  }

  return entries;
}

// ── History Operations ──────────────────────────────────────────────

/**
 * Append a history entry to the JSONL log file.
 * After appending, triggers rotation if active history exceeds maxActiveLines.
 * Rotation uses a hardcoded default of 2000 — do NOT call loadConfig here
 * (loadConfig throws when no bober.config.json exists in test fixtures).
 */
export async function appendHistory(
  projectRoot: string,
  entry: HistoryEntry,
): Promise<void> {
  const boberDir = join(projectRoot, BOBER_DIR);
  await ensureDir(boberDir);

  const validation = HistoryEntrySchema.safeParse(entry);
  if (!validation.success) {
    const issues = validation.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid history entry:\n${issues}`);
  }

  const line = JSON.stringify(entry) + "\n";
  await appendFile(historyPath(projectRoot), line, "utf-8");

  // Rotate if needed — default limit 2000; no loadConfig call (would throw in test fixtures)
  await rotateIfNeeded(projectRoot, 2000);
}

/**
 * Load all history entries from both archive (if present) and active JSONL logs.
 * Returns entries in chronological order: archive (oldest) first, then active (newest).
 * Skips malformed lines. Signature is unchanged — always returns the full stream.
 */
export async function loadHistory(
  projectRoot: string,
): Promise<HistoryEntry[]> {
  // Read archive (ENOENT is normal on first run — treat as empty)
  let archiveContent = "";
  try {
    archiveContent = await readFile(historyArchivePath(projectRoot), "utf-8");
  } catch {
    // Archive does not exist yet — normal, treat as empty
  }

  // Read active file (ENOENT is normal before first append — treat as empty)
  let activeContent = "";
  try {
    activeContent = await readFile(historyPath(projectRoot), "utf-8");
  } catch {
    // Active file does not exist yet
  }

  // Concatenate: archive (older) first, active (newer) second
  return [...parseEntries(archiveContent), ...parseEntries(activeContent)];
}

/**
 * Load at most `limit` of the most-recent history entries from the ACTIVE log only.
 * Does NOT read from history.archive.jsonl — use loadHistory for the full stream.
 * Returns entries newest-last (ascending chronological order within the tail).
 */
export async function loadRecentHistory(
  projectRoot: string,
  { limit }: { limit: number },
): Promise<HistoryEntry[]> {
  let activeContent = "";
  try {
    activeContent = await readFile(historyPath(projectRoot), "utf-8");
  } catch {
    // Active file does not exist yet
    return [];
  }

  const entries = parseEntries(activeContent);
  // Return the newest `limit` entries (tail of the array), preserving ascending order
  return entries.slice(-limit);
}

// ── Progress Markdown ───────────────────────────────────────────────

/**
 * Update the human-readable progress.md file with current state.
 */
export async function updateProgress(
  projectRoot: string,
  contracts: SprintContract[],
  spec: PlanSpec | null,
): Promise<void> {
  const boberDir = join(projectRoot, BOBER_DIR);
  await ensureDir(boberDir);

  const lines: string[] = [];

  lines.push("# Bober Progress");
  lines.push("");
  lines.push(`Last updated: ${new Date().toISOString()}`);
  lines.push("");

  // Plan summary
  if (spec) {
    lines.push("## Plan");
    lines.push("");
    lines.push(`**${spec.title}**`);
    lines.push("");
    lines.push(spec.description);
    lines.push("");
    lines.push(`- Features: ${spec.features.length}`);
    lines.push(`- Tech stack: ${spec.techStack.join(", ") || "not specified"}`);
    lines.push("");
  }

  // Sprint summary
  lines.push("## Sprints");
  lines.push("");

  if (contracts.length === 0) {
    lines.push("No sprints yet.");
    lines.push("");
  } else {
    const passed = contracts.filter((c) => c.status === "passed").length;
    const failed = contracts.filter((c) => c.status === "failed").length;
    const inProgress = contracts.filter(
      (c) => c.status === "in-progress" || c.status === "evaluating",
    ).length;
    const pending = contracts.filter(
      (c) =>
        c.status === "proposed" ||
        c.status === "negotiating" ||
        c.status === "agreed",
    ).length;

    lines.push(
      `| Status | Count |`,
    );
    lines.push(`| --- | --- |`);
    lines.push(`| Passed | ${passed} |`);
    lines.push(`| Failed | ${failed} |`);
    lines.push(`| In Progress | ${inProgress} |`);
    lines.push(`| Pending | ${pending} |`);
    lines.push(`| **Total** | **${contracts.length}** |`);
    lines.push("");

    // Individual sprint status
    lines.push("### Sprint Details");
    lines.push("");

    for (const contract of contracts) {
      const statusIcon = getStatusIcon(contract.status);
      lines.push(
        `- ${statusIcon} **${contract.title}** (${contract.contractId})`,
      );
      lines.push(`  - Status: ${contract.status}`);

      const criteriaTotal = contract.successCriteria.length;
      const requiredCount = contract.successCriteria.filter(
        (c) => c.required,
      ).length;
      if (criteriaTotal > 0) {
        lines.push(
          `  - Criteria: ${criteriaTotal} (${requiredCount} required)`,
        );
      }

      if (contract.startedAt) {
        lines.push(`  - Started: ${contract.startedAt}`);
      }
      if (contract.completedAt) {
        lines.push(`  - Completed: ${contract.completedAt}`);
      }
    }
    lines.push("");
  }

  await writeFile(progressPath(projectRoot), lines.join("\n"), "utf-8");
}

function getStatusIcon(status: string): string {
  switch (status) {
    case "passed":
      return "[PASS]";
    case "failed":
      return "[FAIL]";
    case "in-progress":
    case "evaluating":
      return "[WIP]";
    case "needs-rework":
      return "[REWORK]";
    default:
      return "[PENDING]";
  }
}
