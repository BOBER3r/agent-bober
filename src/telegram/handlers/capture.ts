/**
 * handlers/capture.ts — Route whitelisted plain text into the task inbox (zero-friction).
 * No side effects in the handler itself — the inbox sink is injected so unit tests
 * can pass a fake with no FactStore.
 */

import { captureTask } from "../../hub/task-inbox.js";
import { FactStore, factsDbPath, ensureFactsDir } from "../../state/facts.js";
import { findProjectRoot } from "../../utils/fs.js";

// ── Types ─────────────────────────────────────────────────────────────

/**
 * Injected inbox sink.
 * Production default: opens a FactStore and persists via captureTask.
 * Tests: pass a fake that records calls without touching the filesystem.
 */
export type InboxCapture = (text: string) => Promise<{ id?: string; title: string }>;

// ── defaultCapture ────────────────────────────────────────────────────

/**
 * Production InboxCapture implementation.
 * Opens a FactStore for the current project, stamps wall-clock time at
 * this boundary (captureTask is PURE — never calls Date.now()), persists
 * the task via captureTask, then closes the store.
 *
 * Per the hybrid rule in the briefing: captureTask IS exported from
 * src/hub/task-inbox.ts, so we import it directly (Option A).
 *
 * bober: opens a new FactStore per capture message; swap for a long-lived
 *        store + connection pool if bot throughput grows beyond a few
 *        messages per second.
 */
export async function defaultCapture(text: string): Promise<{ id?: string; title: string }> {
  const projectRoot = (await findProjectRoot()) ?? process.cwd();
  await ensureFactsDir(projectRoot); // namespace omitted → default pool (.bober/memory/)
  const now = new Date().toISOString(); // clock at boundary — NEVER inside captureTask
  const store = new FactStore(factsDbPath(projectRoot));
  try {
    const f = await captureTask(store, text, { now }); // domain omitted → "inbox" pool
    return { id: f.id, title: f.title };
  } finally {
    store.close();
  }
}

// ── handleCapture ─────────────────────────────────────────────────────

/**
 * Capture `text` as one open task and return a one-line confirmation.
 *
 * Zero-friction: the raw message text becomes the task title verbatim.
 * The handler NEVER prompts for a due date, domain, or any other field
 * before capturing (nonGoal #3, evaluatorNotes).
 *
 * The confirmation string always contains the captured title (sc-2-3).
 * Callers pass the reply to sendSafe — this function has no transport access.
 */
export async function handleCapture(text: string, capture: InboxCapture): Promise<string> {
  const { title, id } = await capture(text);
  return id !== undefined ? `Captured: ${title} (#${id})` : `Captured: ${title}`;
}
