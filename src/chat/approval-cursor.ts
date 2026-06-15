// ── approval-cursor.ts ────────────────────────────────────────────────
//
// Tracks which pending markers have already been announced in chat, by
// key `${checkpointId}@${requestedAt}`. Persists at
// .bober/chat/<sessionId>.approvals-cursor.json. Mirrors cursor-store.ts.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ensureDir } from "../utils/fs.js";
import type { PendingMarker } from "../state/approval-state.js";

// ── Types ─────────────────────────────────────────────────────────────

interface AnnouncedFile {
  announced: string[];
}

const EMPTY: AnnouncedFile = { announced: [] };

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Stable identity key for a pending marker.
 * Changes when a gate is re-requested in a later round (different requestedAt),
 * but is stable while the gate remains at the same requestedAt.
 */
export function markerKey(m: PendingMarker): string {
  return `${m.checkpointId}@${m.requestedAt}`;
}

// ── ApprovalCursor ────────────────────────────────────────────────────

export class ApprovalCursor {
  constructor(
    private readonly projectRoot: string,
    private readonly sessionId: string,
  ) {}

  private path(): string {
    return join(
      this.projectRoot,
      ".bober",
      "chat",
      `${this.sessionId}.approvals-cursor.json`,
    );
  }

  /**
   * Read the set of already-announced marker keys.
   * Returns empty set on missing file or malformed JSON — never throws.
   */
  private async readFile(): Promise<AnnouncedFile> {
    try {
      return JSON.parse(await readFile(this.path(), "utf-8")) as AnnouncedFile;
    } catch {
      return { ...EMPTY };
    }
  }

  /**
   * Return the subset of markers not yet announced, and atomically record
   * them as announced for this session. Idempotent: calling again with
   * the same markers returns [].
   */
  async filterNew(markers: PendingMarker[]): Promise<PendingMarker[]> {
    const file = await this.readFile();
    const seen = new Set(file.announced);
    const fresh = markers.filter((m) => !seen.has(markerKey(m)));

    if (fresh.length > 0) {
      for (const m of fresh) {
        seen.add(markerKey(m));
      }
      await ensureDir(join(this.projectRoot, ".bober", "chat"));
      await writeFile(
        this.path(),
        JSON.stringify({ announced: [...seen] }, null, 2) + "\n",
        { encoding: "utf-8", mode: 0o600 },
      );
    }

    return fresh;
  }
}
