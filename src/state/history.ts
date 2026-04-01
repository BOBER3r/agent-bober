import { readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import type { SprintContract } from "../contracts/sprint-contract.js";
import type { PlanSpec } from "../contracts/spec.js";
import { ensureDir } from "./helpers.js";

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

// ── History Operations ──────────────────────────────────────────────

/**
 * Append a history entry to the JSONL log file.
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
}

/**
 * Load all history entries from the JSONL log.
 * Skips malformed lines.
 */
export async function loadHistory(
  projectRoot: string,
): Promise<HistoryEntry[]> {
  let content: string;
  try {
    content = await readFile(historyPath(projectRoot), "utf-8");
  } catch {
    // File doesn't exist yet
    return [];
  }

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
      lines.push(`- ${statusIcon} **${contract.feature}** (${contract.id})`);
      lines.push(`  - Status: ${contract.status}`);

      const criteriaTotal = contract.successCriteria.length;
      const criteriaPassed = contract.successCriteria.filter(
        (c) => c.passed,
      ).length;
      if (criteriaTotal > 0) {
        lines.push(
          `  - Criteria: ${criteriaPassed}/${criteriaTotal} passed`,
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
