/** AuditLog — append-only IDs/enums-only medical audit log (Phase 6, Sprint 2). */
import { open, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { AuditEntry } from "./types.js";

// ── AuditLog ────────────────────────────────────────────────────────

/**
 * Appends structured audit entries to .bober/medical/audit-<date>.jsonl.
 *
 * File is opened O_APPEND|O_CREAT with mode 0600. The date in the filename
 * is derived from the INJECTED tIso field of each entry — never the wall clock.
 *
 * PHI rule: entries hold IDs/enums ONLY (tIso, event, rulesetVersion?,
 * patternsetVersion?, ruleId?). NEVER serialize prompt text or health values.
 *
 * bober: single-process append; if multi-process concurrent writes are needed,
 *        swap for a SQLite WAL or a locking file-writer.
 */
export class AuditLog {
  constructor(private readonly projectRoot: string) {}

  // ── Path helpers ──────────────────────────────────────────────────

  /**
   * Filename derives from the INJECTED tIso (YYYY-MM-DD slice).
   * Never Date.now().
   */
  private path(tIso: string): string {
    const date = tIso.slice(0, 10); // "2026-06-16"
    return join(this.projectRoot, ".bober", "medical", `audit-${date}.jsonl`);
  }

  // ── append ────────────────────────────────────────────────────────

  /**
   * Append one AuditEntry as a newline-terminated JSON line.
   *
   * Uses O_APPEND|O_CREAT with mode 0600 and an explicit fh.chmod(0600)
   * to guarantee the file mode even if umask would reduce it.
   * NEVER uses appendFile — it does not reliably honour the mode argument.
   */
  async append(entry: AuditEntry): Promise<void> {
    const dir = join(this.projectRoot, ".bober", "medical");
    await mkdir(dir, { recursive: true, mode: 0o700 });

    const line = JSON.stringify(entry) + "\n";
    const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT;
    const fh = await open(this.path(entry.tIso), flags, 0o600);
    try {
      // Guarantee mode 0600 even if umask would have reduced it.
      await fh.chmod(0o600);
      await fh.write(line);
    } finally {
      await fh.close();
    }
  }
}
