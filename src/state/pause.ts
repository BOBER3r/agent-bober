// ── pause.ts ───────────────────────────────────────────────────────────
//
// Disk-marker helpers for the runId-keyed SOFT-PAUSE channel.
//
// Layout: .bober/runs/<runId>/paused.json  → { pausedAt: string }
//
// Every write is atomic via temp-file + rename
// (mirrors src/state/run-state.ts:41-52 atomic write pattern).
//
// The cooperative poll helper waitWhilePaused models the bounded poll loop
// from DiskCheckpointMechanism.request (disk.ts:104-176) with an injected
// clock so tests never sleep.

import { writeFile, unlink, rename, access } from "node:fs/promises";
import { constants } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { ensureDir } from "./helpers.js";
import { safeSegment } from "./guidance.js";

// ── Constants ─────────────────────────────────────────────────────────

const DEFAULT_POLL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000; // 7 days cap

// ── Path helpers ──────────────────────────────────────────────────────

function runsRoot(projectRoot: string): string {
  return join(projectRoot, ".bober", "runs");
}

function runDir(projectRoot: string, runId: string): string {
  return join(runsRoot(projectRoot), runId);
}

function pausePath(projectRoot: string, runId: string): string {
  return join(runDir(projectRoot, runId), "paused.json");
}

// ── Marker write (atomic) ─────────────────────────────────────────────

/**
 * Write a paused.json marker for the given runId.
 *
 * Security: validates runId is a safe path segment BEFORE building any path.
 * Throws with a clear message if runId is unsafe (caller should surface to user).
 *
 * Write is atomic via temp-file + rename (mirrors run-state.ts:41-52).
 */
export async function setPaused(projectRoot: string, runId: string): Promise<void> {
  if (!safeSegment(runId)) {
    throw new Error(
      `Invalid runId "${runId}": must be a safe path segment (no path separators, no '..').`,
    );
  }
  await ensureDir(runDir(projectRoot, runId));
  const filePath = pausePath(projectRoot, runId);
  const rnd = randomBytes(4).toString("hex");
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${rnd}.tmp`;
  await writeFile(
    tmp,
    JSON.stringify({ pausedAt: new Date().toISOString() }) + "\n",
    { encoding: "utf-8", mode: 0o600 },
  );
  await rename(tmp, filePath);
}

// ── Marker clear (best-effort) ─────────────────────────────────────────

/**
 * Remove the paused.json marker for the given runId.
 *
 * Best-effort: never throws (idempotent — no-op if already gone).
 * Mirrors approval-state.ts:deletePending.
 */
export async function clearPaused(projectRoot: string, runId: string): Promise<void> {
  if (!safeSegment(runId)) return; // best-effort — unsafe id → skip silently
  await unlink(pausePath(projectRoot, runId)).catch(() => {});
}

// ── Existence check ───────────────────────────────────────────────────

/**
 * Return true if paused.json exists for the given runId.
 *
 * Returns false for missing file or unsafe runId — never throws.
 * Mirrors guidance.ts:hasRunDir shape.
 */
export async function isPaused(projectRoot: string, runId: string): Promise<boolean> {
  if (!safeSegment(runId)) return false;
  try {
    await access(pausePath(projectRoot, runId), constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

// ── Cooperative poll interface ────────────────────────────────────────

export interface WaitWhilePausedOptions {
  /** Poll interval in ms. Defaults to 2000. Inject a low value in tests. */
  pollMs?: number;
  /** Maximum wait before resolving (continuing). Capped at MAX_TIMEOUT_MS (7d). */
  timeoutMs?: number;
  /** Clock injection for deterministic tests. Defaults to () => Date.now(). */
  now?: () => number;
}

// ── Cooperative pause gate ────────────────────────────────────────────

/**
 * Block at a checkpoint boundary while paused.json is present for the runId.
 *
 * - First check is INLINE before any setTimeout so the no-marker path
 *   resolves immediately with zero scheduled ticks (sc-5-7 additive no-op).
 * - While the marker is present, polls every pollMs ms (clock-injected so
 *   tests never wait real time — models disk.ts:104-176).
 * - Resolves (continues) on timeout rather than rejecting — a forgotten
 *   paused.json must not hang the pipeline forever.
 *
 * bober: bounded poll; if paused.json is never removed the gate resolves
 *        after timeoutMs (capped at 7d) — upgrade path: expose a resume
 *        event channel instead of polling if sub-second responsiveness needed.
 */
export async function waitWhilePaused(
  projectRoot: string,
  runId: string,
  opts: WaitWhilePausedOptions = {},
): Promise<void> {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const timeoutMs = Math.min(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const now = opts.now ?? (() => Date.now());

  // ── Inline first check (sc-5-7: no-marker → immediate return, zero ticks) ─
  const paused = await isPaused(projectRoot, runId);
  if (!paused) return;

  // ── Poll until the marker is gone or we time out ──────────────────────
  const startedAt = now();
  let pollHandle: ReturnType<typeof setTimeout> | undefined;

  try {
    await new Promise<void>((resolve, reject) => {
      const tick = async (): Promise<void> => {
        try {
          const stillPaused = await isPaused(projectRoot, runId);
          if (!stillPaused) {
            resolve();
            return;
          }
          // Check timeout (clock-injected — deterministic in tests)
          if (now() - startedAt >= timeoutMs) {
            // Resolve rather than reject — a timed-out pause must not crash the pipeline
            resolve();
            return;
          }
          // Schedule next tick
          pollHandle = setTimeout(() => {
            tick().catch(reject);
          }, pollMs);
        } catch (err) {
          reject(err);
        }
      };

      // Start polling
      pollHandle = setTimeout(() => {
        tick().catch(reject);
      }, pollMs);
    });
  } finally {
    // Never leak timers
    if (pollHandle !== undefined) {
      clearTimeout(pollHandle);
    }
  }
}
