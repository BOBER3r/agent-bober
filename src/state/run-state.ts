// ── run-state.ts ─────────────────────────────────────────────────────
//
// Disk-persistence helpers for RunState objects.
//
// Layout: .bober/runs/<runId>/state.json
//
// Every write is atomic via temp-file + rename
// (mirrors src/incident/timeline.ts:86-92 atomicWriteJson pattern).

import { readFile, writeFile, readdir, rename } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { ensureDir } from "./helpers.js";
import type { RunState } from "../mcp/run-manager.js";

// ── Path helpers ─────────────────────────────────────────────────────

function runsRoot(projectRoot: string): string {
  return join(projectRoot, ".bober", "runs");
}

function runDir(projectRoot: string, runId: string): string {
  return join(runsRoot(projectRoot), runId);
}

function statePath(projectRoot: string, runId: string): string {
  return join(runDir(projectRoot, runId), "state.json");
}

// ── Atomic write ─────────────────────────────────────────────────────

/**
 * Atomically write a RunState to .bober/runs/<runId>/state.json
 * via a temp-file + rename to prevent partial-write corruption.
 *
 * Uses process.pid + Date.now() in the temp filename to avoid collisions
 * when multiple writes to the same runId race (e.g. concurrent progress
 * updates in tests).
 */
export async function writeRunState(projectRoot: string, state: RunState): Promise<void> {
  await ensureDir(runDir(projectRoot, state.runId));
  const filePath = statePath(projectRoot, state.runId);
  // Include a random hex suffix to avoid collisions when two writes
  // for the same runId race within the same millisecond (same pid + timestamp).
  const rnd = randomBytes(4).toString("hex");
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${rnd}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  await rename(tmp, filePath);
}

// ── Read ─────────────────────────────────────────────────────────────

/**
 * Read a RunState from disk. Returns null if the file does not exist
 * or contains invalid JSON — never throws.
 */
export async function readRunState(projectRoot: string, runId: string): Promise<RunState | null> {
  try {
    const raw = await readFile(statePath(projectRoot, runId), "utf-8");
    return JSON.parse(raw) as RunState;
  } catch {
    return null;
  }
}

// ── List ─────────────────────────────────────────────────────────────

/**
 * Enumerate all RunState files under .bober/runs/.
 *
 * Returns an empty array if the directory does not exist.
 * Silently skips any entry whose state.json is missing or malformed.
 */
export async function listRunStateFiles(projectRoot: string): Promise<RunState[]> {
  let entries: string[];
  try {
    entries = await readdir(runsRoot(projectRoot));
  } catch {
    return [];
  }

  const out: RunState[] = [];
  for (const id of entries) {
    const s = await readRunState(projectRoot, id);
    if (s) out.push(s);
    // malformed / missing state.json → skip silently
  }
  return out;
}

/**
 * Cross-project read-only RunState enumeration for the cockpit
 * discovery tools (get-project-state, list-projects).
 *
 * UNLIKE the RunManager-backed APIs, this helper does NOT use the
 * in-memory singleton — it always walks .bober/runs/<runId>/state.json
 * on the supplied projectRoot. The discovery tools call it with
 * arbitrary projectPath values; we cannot assume RunManager has been
 * load()'d for that root.
 *
 * Implementation: delegates to listRunStateFiles. Provided as a named
 * alias because:
 *   1. It documents the cockpit intent (cross-project, read-only).
 *   2. Future call sites can filter without touching listRunStateFiles.
 */
export async function readRunStatesFromDisk(
  projectRoot: string,
): Promise<RunState[]> {
  return listRunStateFiles(projectRoot);
}
