/** Read ranked findings from a JSON file for the calendar planner. */

import { z } from "zod";
import { readJson } from "../utils/fs.js";
import type { BusyInterval, Finding } from "./types.js";
import { FindingArraySchema } from "./types.js";

// ── Zod schemas ───────────────────────────────────────────────────────

const BusyIntervalSchema = z.object({
  startIso: z.string().datetime(),
  endIso: z.string().datetime(),
});

const BusyIntervalArraySchema = z.array(BusyIntervalSchema);

// ── File readers ──────────────────────────────────────────────────────

/**
 * Read a ranked Finding[] from a JSON file.
 *
 * Order is preserved (= priority order from the hub).
 * Throws if the file does not exist, contains invalid JSON, or fails Zod validation.
 * The caller (runCalendarPlan core) wraps this in try/catch → process.exitCode = 1.
 *
 * Pattern: src/cli/commands/task.ts:256-258 + src/hub/finding-source.ts:43-48.
 */
export async function readFindingsFromFile(path: string): Promise<Finding[]> {
  const raw = await readJson<unknown>(path);
  return FindingArraySchema.parse(raw);
}

/**
 * Read a BusyInterval[] from a JSON file.
 *
 * Each entry must have { startIso, endIso } (ISO-8601 datetime strings).
 * Throws on I/O or validation error — same fail-closed policy as readFindingsFromFile.
 */
export async function readBusyIntervalsFromFile(path: string): Promise<BusyInterval[]> {
  const raw = await readJson<unknown>(path);
  return BusyIntervalArraySchema.parse(raw);
}
