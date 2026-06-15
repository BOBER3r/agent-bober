// ── approval-reader.ts ────────────────────────────────────────────────
//
// Read-only wrapper over listPending for chat context.
// NEVER writes approval markers (Sprint 3 owns the write path).

import { listPending } from "../state/approval-state.js";
import type { PendingMarker } from "../state/approval-state.js";

// ── ApprovalReader ────────────────────────────────────────────────────

export class ApprovalReader {
  constructor(private readonly projectRoot: string) {}

  /**
   * Read all pending markers from .bober/approvals/*.pending.json.
   * Missing dir => []; corrupt files skipped silently (delegated to listPending).
   */
  async read(): Promise<PendingMarker[]> {
    return listPending(this.projectRoot);
  }
}
