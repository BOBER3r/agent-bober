// ── steer-cleanup.ts ──────────────────────────────────────────────────
//
// Best-effort hygiene: when the chat process observes a run reach a terminal
// status (completed/aborted), remove its stale pending approval marker(s),
// guidance.jsonl, and paused.json, and clear RunState pending/paused fields.
// NEVER throws — a cleanup failure must not break a chat turn.

import { unlink } from "node:fs/promises";
import { join } from "node:path";

import { deletePending, listPending } from "../state/approval-state.js";
import { readRunState, writeRunState } from "../state/run-state.js";
import { safeSegment } from "../state/guidance.js";

/**
 * Remove all disk + RunState steer artifacts for a run that has gone terminal.
 * Best-effort: each step is individually guarded; the function never throws.
 *
 * Steps:
 * 1. Delete pending approval marker(s) correlated to this runId (by runId field).
 * 2. Unlink .bober/runs/<runId>/guidance.jsonl + paused.json (tolerate ENOENT).
 * 3. Clear RunState pending/paused fields (pendingCheckpointId, pendingPrompt,
 *    pendingSince, pausedAt) while leaving the terminal status (completed/aborted) as-is.
 */
export async function cleanupTerminalRun(
  projectRoot: string,
  runId: string,
): Promise<void> {
  if (!safeSegment(runId)) return; // unsafe id → skip silently (mirrors pause.ts:79)

  // 1. Delete pending markers correlated to this runId (checkpointId-keyed dir).
  try {
    const pending = await listPending(projectRoot);
    for (const m of pending) {
      if (m.runId === runId) {
        await deletePending(projectRoot, m.checkpointId); // already best-effort (:138)
      }
    }
  } catch {
    // never throw into a turn
  }

  // 2. Unlink guidance.jsonl + paused.json under .bober/runs/<runId>/ (tolerate ENOENT).
  const runDir = join(projectRoot, ".bober", "runs", runId);
  await unlink(join(runDir, "guidance.jsonl")).catch(() => {});
  await unlink(join(runDir, "paused.json")).catch(() => {});

  // 3. Clear RunState pending/paused fields (only if a state file exists).
  //    Preserve the terminal status (completed/aborted) — do NOT force back to running.
  try {
    const state = await readRunState(projectRoot, runId);
    if (state) {
      // Destructure out optional fields — established idiom from chat-session.ts:441-447
      const { pendingCheckpointId, pendingPrompt, pendingSince, pausedAt, ...rest } = state;
      // Suppress unused-variable warnings in strict mode
      void pendingCheckpointId;
      void pendingPrompt;
      void pendingSince;
      void pausedAt;
      await writeRunState(projectRoot, rest);
    }
  } catch {
    // never throw into a turn
  }
}
