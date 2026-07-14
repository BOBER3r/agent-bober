/**
 * Lab-note reindexer — globs lab vault notes and upserts each result into HealthDataStore.
 *
 * Pure file + SQLite. NO network. NO LLM. NO Date.now().
 *
 * Architecture: vault is canonical; SQLite store is a derived, rebuildable index.
 * Dedup runs at ingest time via the deterministic labResultId (INSERT OR IGNORE).
 * Re-running over unchanged notes returns 0 new rows (idempotent).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { glob } from "glob";

import type { HealthDataStore } from "./health-store.js";
import type { LabResult } from "./types.js";
import { parseLabNote } from "./lab-note.js";

/**
 * Glob all markdown notes under `<vaultDir>/labs/`, parse each note's YAML frontmatter,
 * map the fields to a LabResult, and upsert into the store.
 *
 * Returns the total count of NEW rows inserted (sum of upsertLabResult return values).
 * Duplicate notes produce 0 new rows — dedup is automatic via the deterministic
 * labResultId (biomarker|collectedAtIso|value) under INSERT OR IGNORE.
 *
 * @param vaultDir  Root of the vault directory tree (contains the `labs/` subdirectory).
 * @param store     An open HealthDataStore instance to upsert into.
 * @returns         Number of genuinely new rows inserted in this run.
 */
export async function reindexLabNotes(
  vaultDir: string,
  store: HealthDataStore,
): Promise<number> {
  const labsDir = join(vaultDir, "labs");
  const paths = await glob("**/*.md", { cwd: labsDir, absolute: true, nodir: true });

  let newRows = 0;

  for (const notePath of paths) {
    const raw = await readFile(notePath, "utf-8");
    const fm = parseLabNote(raw);

    const result: LabResult = {
      biomarker: fm.marker,
      value: fm.value,
      unit: fm.unit,
      collectedAtIso: fm.date,
      referenceLow: fm.ref_low,
      referenceHigh: fm.ref_high,
    };

    newRows += store.upsertLabResult(result);
  }

  return newRows;
}
