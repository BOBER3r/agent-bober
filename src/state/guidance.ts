// ── guidance.ts ───────────────────────────────────────────────────────
//
// Disk-persistence helpers for the runId-keyed guidance channel.
//
// Layout: .bober/runs/<runId>/guidance.jsonl
// One JSON object per line: { ts: string, text: string, consumed: boolean }
//
// Every drain rewrite is atomic via temp-file + rename
// (mirrors src/state/run-state.ts:41-52 atomic write pattern).

import { readFile, writeFile, appendFile, rename, access } from "node:fs/promises";
import { constants } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { ensureDir } from "./helpers.js";

// ── Guidance entry shape ──────────────────────────────────────────────

interface GuidanceEntry {
  ts: string;
  text: string;
  consumed: boolean;
}

// ── Path helpers ──────────────────────────────────────────────────────

function runsRoot(projectRoot: string): string {
  return join(projectRoot, ".bober", "runs");
}

function runDir(projectRoot: string, runId: string): string {
  return join(runsRoot(projectRoot), runId);
}

function guidancePath(projectRoot: string, runId: string): string {
  return join(runDir(projectRoot, runId), "guidance.jsonl");
}

// ── Path-traversal guard ──────────────────────────────────────────────

/**
 * Validate that a runId is a safe path segment.
 * Rejects empty strings, strings containing path separators (/ or \),
 * strings containing '..', and absolute paths.
 * This is a security guard: a malicious runId must never escape .bober/runs.
 */
export function safeSegment(runId: string): boolean {
  if (!runId) return false;
  if (runId.includes("/")) return false;
  if (runId.includes("\\")) return false;
  if (runId.includes("..")) return false;
  if (runId.startsWith(".")) return false;
  // Reject if it looks like an absolute path (Unix or Windows)
  if (runId.startsWith("/") || /^[A-Za-z]:[/\\]/.test(runId)) return false;
  return true;
}

// ── Existence guard ───────────────────────────────────────────────────

/**
 * Check whether the run directory exists for the given runId.
 * Returns false if not found — never throws.
 * Mirrors approval-state.ts:pendingExists.
 */
export async function hasRunDir(projectRoot: string, runId: string): Promise<boolean> {
  try {
    await access(runDir(projectRoot, runId), constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

// ── Append ────────────────────────────────────────────────────────────

/**
 * Append a guidance entry to .bober/runs/<runId>/guidance.jsonl.
 *
 * Security: validates runId is a safe path segment BEFORE building any path.
 * Throws with a clear message if runId is unsafe (caller should surface to user).
 *
 * Existence: the run directory must already exist (guard with hasRunDir if
 * you want an unknown-run check; appendGuidance itself creates the dir for
 * robustness, but callers in chat-session.ts should guard first for UX).
 */
export async function appendGuidance(
  projectRoot: string,
  runId: string,
  text: string,
): Promise<void> {
  if (!safeSegment(runId)) {
    throw new Error(
      `Invalid runId "${runId}": must be a safe path segment (no path separators, no '..').`,
    );
  }
  await ensureDir(runDir(projectRoot, runId));
  const entry: GuidanceEntry = {
    ts: new Date().toISOString(),
    text,
    consumed: false,
  };
  // appendFile is safe for JSONL: each call writes exactly one complete line.
  await appendFile(guidancePath(projectRoot, runId), JSON.stringify(entry) + "\n", "utf-8");
}

// ── Drain ─────────────────────────────────────────────────────────────

/**
 * Drain pending (unconsumed) guidance entries for a runId.
 *
 * Reads all lines, collects the text of entries where consumed !== true,
 * then atomically rewrites the file with ALL entries marked consumed:true
 * (temp-file + rename, mirrors run-state.ts:41-52).
 *
 * Returns the drained texts in order.
 * Missing file → returns [] (never throws — safe to call on every pipeline sprint).
 * Second drain → returns [] (all entries already marked consumed).
 */
export async function drainGuidance(
  projectRoot: string,
  runId: string,
): Promise<string[]> {
  const filePath = guidancePath(projectRoot, runId);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch {
    // File does not exist or is unreadable — return empty (no-op)
    return [];
  }

  const lines = raw.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return [];

  const entries: GuidanceEntry[] = [];
  const drained: string[] = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as GuidanceEntry;
      if (entry.consumed !== true) {
        drained.push(entry.text);
      }
      entries.push({ ...entry, consumed: true });
    } catch {
      // Skip malformed lines — do not lose other entries
    }
  }

  if (drained.length === 0) {
    // Nothing unconsumed — still rewrite atomically to normalize the file
    // (all entries stay consumed:true from previous drain)
    const allConsumed = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    const rnd = randomBytes(4).toString("hex");
    const tmp = `${filePath}.${process.pid}.${Date.now()}.${rnd}.tmp`;
    await writeFile(tmp, allConsumed, { encoding: "utf-8", mode: 0o600 });
    await rename(tmp, filePath);
    return [];
  }

  // Atomically rewrite all entries as consumed
  const rewritten = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  const rnd = randomBytes(4).toString("hex");
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${rnd}.tmp`;
  await writeFile(tmp, rewritten, { encoding: "utf-8", mode: 0o600 });
  await rename(tmp, filePath);

  return drained;
}
