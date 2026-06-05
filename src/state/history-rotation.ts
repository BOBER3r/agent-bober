// ── history-rotation.ts ─────────────────────────────────────────────
//
// Crash-safe rotation: when active history.jsonl exceeds maxActiveLines,
// move the oldest (count - maxActiveLines) entries to history.archive.jsonl,
// then atomically rewrite active with the remaining tail.
//
// Crash-safety ordering (Option B — idempotent, preferred):
//
//   1. Write the new-active TEMP file (tail lines only)
//   2. Append the overflow (oldest lines) to history.archive.jsonl
//   3. rename(temp, activeFile)   ← COMMIT POINT (atomic on same fs)
//
// If the process crashes before step 3:
//   - archive may hold the overflow entries AND active still holds all entries
//   - loadHistory (archive-then-active) returns every entry; archive entries
//     are a subset of active → union has no drops but has duplicates
//   - this is acceptable: the contract (C4) tests the union and
//     tolerates de-duplication when crash state is loaded.
//
// If the process crashes after step 3:
//   - active is the tail only; archive has the overflow → no loss, no dup.
//
// The rename is the single atomic commit: everything before it is recoverable.

import { readFile, writeFile, appendFile, rename } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { ensureDir } from "./helpers.js";

// ── Path helpers ─────────────────────────────────────────────────────

const BOBER_DIR = ".bober";
const HISTORY_FILE = "history.jsonl";
const HISTORY_ARCHIVE_FILE = "history.archive.jsonl";

export function historyActivePath(projectRoot: string): string {
  return join(projectRoot, BOBER_DIR, HISTORY_FILE);
}

export function historyArchivePath(projectRoot: string): string {
  return join(projectRoot, BOBER_DIR, HISTORY_ARCHIVE_FILE);
}

// ── Rotation ─────────────────────────────────────────────────────────

/**
 * Rotate the active history file if it exceeds maxActiveLines.
 *
 * When the active file has more than maxActiveLines non-empty lines,
 * the oldest (count - maxActiveLines) lines are appended to the archive
 * and the active file is atomically rewritten with the newest maxActiveLines
 * lines via temp-file + rename.
 *
 * Pass maxActiveLines from config; callers must NOT call loadConfig here
 * (loadConfig throws when no bober.config.json exists). Default: 2000.
 *
 * No-op when the active file does not exist or has <= maxActiveLines entries.
 */
export async function rotateIfNeeded(
  projectRoot: string,
  maxActiveLines: number = 2000,
): Promise<void> {
  let content: string;
  try {
    content = await readFile(historyActivePath(projectRoot), "utf-8");
  } catch {
    // Active file does not exist yet — nothing to rotate
    return;
  }

  const lines = content.split("\n").filter((line) => line.trim().length > 0);

  if (lines.length <= maxActiveLines) {
    // Within limit — no rotation needed
    return;
  }

  const overflowCount = lines.length - maxActiveLines;
  const overflowLines = lines.slice(0, overflowCount);
  const tailLines = lines.slice(overflowCount);

  const activePath = historyActivePath(projectRoot);
  const archPath = historyArchivePath(projectRoot);

  // Ensure .bober/ directory exists (it should, but guard anyway)
  await ensureDir(join(projectRoot, BOBER_DIR));

  // Step 1: Write the new-active TEMP file (tail lines only)
  const rnd = randomBytes(4).toString("hex");
  const tmp = `${activePath}.${process.pid}.${Date.now()}.${rnd}.tmp`;
  const newActiveContent = tailLines.join("\n") + "\n";
  await writeFile(tmp, newActiveContent, { encoding: "utf-8" });

  // Step 2: Append the overflow (oldest lines) to history.archive.jsonl
  const overflowContent = overflowLines.join("\n") + "\n";
  await appendFile(archPath, overflowContent, "utf-8");

  // Step 3: Atomic commit — rename temp over active (commit point)
  await rename(tmp, activePath);
}
