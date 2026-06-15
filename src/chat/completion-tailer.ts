// ── completion-tailer.ts ─────────────────────────────────────────────────
//
// Tails .bober/history.jsonl from a persisted byte cursor and returns new
// pipeline-complete events. Rotation-safe: detects shrink (stat.size < cursor)
// and resets the cursor to 0 before re-scanning. Dedupes by runId across polls
// and across session restarts via CursorStore.
//
// When the pipeline-complete line itself omits runId (pipeline.ts:925-934),
// the tailer falls back to scanning .bober/runs/<id>.completed.json markers.

import { readFile, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Buffer } from "node:buffer";

import { HistoryEntrySchema } from "../state/history.js";
import { historyActivePath } from "../state/history-rotation.js";
import { fileExists } from "../utils/fs.js";
import { CursorStore } from "./cursor-store.js";

// ── Types ──────────────────────────────────────────────────────────────

export interface CompletionEvent {
  runId?: string;
  phase: "complete" | "failed";
  completed: number;
  failed: number;
  durationMs: number;
  timestamp: string;
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Extract runId from a parsed JSONL record (mirrors event-stream.ts:47-58).
 * Returns undefined when the record does not carry a runId — callers must
 * fall back to the .completed.json marker.
 */
function extractRunId(rec: unknown): string | undefined {
  if (typeof rec !== "object" || rec === null) return undefined;
  const r = rec as Record<string, unknown>;
  if (typeof r.runId === "string") return r.runId;
  if (typeof r.details === "object" && r.details !== null) {
    const d = r.details as Record<string, unknown>;
    if (typeof d.runId === "string") return d.runId;
  }
  return undefined;
}

/**
 * Scan .bober/runs/ for any .completed.json markers that are NOT already in
 * seenRunIds. Returns the first unmatched runId found, or undefined.
 * Used as a fallback when the pipeline-complete history line omits runId.
 */
async function findUnseenMarkerRunId(
  projectRoot: string,
  seenRunIds: Set<string>,
  timestamp: string,
): Promise<string | undefined> {
  const runsDir = join(projectRoot, ".bober", "runs");
  let entries: string[];
  try {
    entries = await readdir(runsDir);
  } catch {
    return undefined;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".completed.json")) continue;
    const runId = entry.slice(0, -".completed.json".length);
    if (seenRunIds.has(runId)) continue;

    // Verify the file actually exists and contains a matching runId
    const markerPath = join(runsDir, entry);
    if (!(await fileExists(markerPath))) continue;

    try {
      const raw = await readFile(markerPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const markerRunId =
        typeof parsed.runId === "string" ? parsed.runId : runId;

      // Cross-correlate by proximity: use if not yet seen.
      // bober: uses first-unseen marker; for multi-run sessions this may
      // mis-assign. Upgrade path: embed runId in the pipeline-complete line.
      void timestamp; // parameter kept for future timestamp-based correlation
      return markerRunId;
    } catch {
      // Malformed marker — skip
    }
  }

  return undefined;
}

// ── CompletionTailer ───────────────────────────────────────────────────

export class CompletionTailer {
  private readonly store: CursorStore;

  constructor(
    private readonly projectRoot: string,
    sessionId: string,
  ) {
    this.store = new CursorStore(projectRoot, sessionId);
  }

  /**
   * Poll .bober/history.jsonl for new pipeline-complete events since the last
   * persisted byte cursor. Returns only newly-seen completions.
   *
   * Algorithm:
   * 1. stat the file; ENOENT → return [].
   * 2. If stat.size < cursor (rotation/shrink) → readFrom = 0.
   * 3. Read bytes [readFrom, EOF) via Buffer slice.
   * 4. Parse complete lines only (skip partial trailing line).
   * 5. Filter for event === "pipeline-complete"; extract runId via marker.
   * 6. Dedupe against seenRunIds; persist updated cursor + seenRunIds.
   */
  async poll(): Promise<CompletionEvent[]> {
    const cursor = await this.store.read();
    const seenSet = new Set<string>(cursor.seenRunIds);

    const histPath = historyActivePath(this.projectRoot);

    // Step 1: stat — ENOENT → graceful empty
    let fileSize: number;
    try {
      const s = await stat(histPath);
      fileSize = s.size;
    } catch {
      // File missing — return empty, do NOT alter the stored cursor
      return [];
    }

    // Step 2: Rotation/shrink detection
    const readFrom = fileSize < cursor.byteCursor ? 0 : cursor.byteCursor;

    // Step 3: Read bytes [readFrom, EOF)
    let buf: Buffer;
    try {
      const full = await readFile(histPath);
      buf = full.subarray(readFrom);
    } catch {
      return [];
    }

    // Step 4: Keep only complete lines (up to last \n)
    // Find the last newline byte position
    let lastNewline = -1;
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i] === 0x0a) {
        // '\n'
        lastNewline = i;
        break;
      }
    }

    // If there are no complete lines at all, persist potentially-reset cursor
    // but return empty. Advance cursor only over complete lines.
    const consumedBuf = lastNewline >= 0 ? buf.subarray(0, lastNewline + 1) : Buffer.alloc(0);
    const newByteCursor = readFrom + consumedBuf.length;

    const events: CompletionEvent[] = [];

    if (consumedBuf.length > 0) {
      const text = consumedBuf.toString("utf-8");
      const lines = text.split("\n").filter((l) => l.trim().length > 0);

      for (const line of lines) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue; // Skip malformed JSON
        }

        const result = HistoryEntrySchema.safeParse(parsed);
        if (!result.success) continue;
        const entry = result.data;

        if (entry.event !== "pipeline-complete") continue;

        const phase = entry.phase as "complete" | "failed";
        const details = entry.details as Record<string, unknown>;
        const completed = typeof details.completed === "number" ? details.completed : 0;
        const failed = typeof details.failed === "number" ? details.failed : 0;
        const durationMs = typeof details.durationMs === "number" ? details.durationMs : 0;

        // Resolve runId: line-level first, then .completed.json marker fallback
        let runId = extractRunId(parsed);
        if (!runId) {
          runId = await findUnseenMarkerRunId(
            this.projectRoot,
            seenSet,
            entry.timestamp,
          );
        }

        // Build synthetic dedupe key for completions with no resolvable runId
        const dedupeKey = runId ?? `${entry.timestamp}:${durationMs}`;

        if (seenSet.has(dedupeKey)) continue;
        seenSet.add(dedupeKey);

        events.push({
          runId,
          phase,
          completed,
          failed,
          durationMs,
          timestamp: entry.timestamp,
        });
      }
    }

    // Step 6: Persist updated cursor + seenRunIds
    await this.store.write({
      byteCursor: newByteCursor,
      lastSize: fileSize,
      seenRunIds: Array.from(seenSet),
    });

    return events;
  }
}
