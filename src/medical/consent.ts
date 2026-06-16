/** ConsentGate — fail-closed first-run consent (Phase 6, Sprint 2). */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir } from "../utils/fs.js";
import type { AuditLog } from "./audit.js";
import type { ConsentRecord } from "./types.js";

// ── ConsentGate ─────────────────────────────────────────────────────

/**
 * Manages consent persistence at .bober/medical/consent.json.
 *
 * Fail-closed: a missing or corrupt consent.json returns false/undefined —
 * the engine refuses rather than proceeding without consent.
 *
 * Depends on AuditLog to record a 'consent' entry on recordConsent().
 *
 * bober: JSON file sidecar; if multi-session concurrent access is needed,
 *        migrate to the SQLite FactStore (see src/state/facts.ts).
 */
export class ConsentGate {
  constructor(
    private readonly projectRoot: string,
    private readonly audit: AuditLog,
  ) {}

  // ── Path ──────────────────────────────────────────────────────────

  private path(): string {
    return join(this.projectRoot, ".bober", "medical", "consent.json");
  }

  // ── Read ──────────────────────────────────────────────────────────

  /**
   * Fail-closed: missing or corrupt file returns false. Never throws.
   * Reads .bober/medical/consent.json via node:fs/promises.
   */
  async hasConsent(): Promise<boolean> {
    return (await this.current()) !== undefined;
  }

  /**
   * Returns the parsed ConsentRecord, or undefined if missing/corrupt.
   * Validates required fields — a partial/corrupt record returns undefined.
   */
  async current(): Promise<ConsentRecord | undefined> {
    try {
      const data = JSON.parse(
        await readFile(this.path(), "utf-8"),
      ) as ConsentRecord;
      // Validate required fields for fail-closed behaviour on partial records.
      if (
        typeof data.consentVersion !== "string" ||
        typeof data.acceptedAtIso !== "string" ||
        typeof data.rulesetVersion !== "string" ||
        typeof data.disclaimerVersion !== "string"
      ) {
        return undefined;
      }
      return data;
    } catch {
      return undefined;
    }
  }

  // ── Write ─────────────────────────────────────────────────────────

  /**
   * Persist a ConsentRecord (mode 0600) AND append a 'consent' audit entry.
   *
   * @param record - The consent record to persist.
   * @param nowIso - INJECTED ISO 8601 timestamp — never wall-clock.
   */
  async recordConsent(record: ConsentRecord, nowIso: string): Promise<void> {
    await ensureDir(join(this.projectRoot, ".bober", "medical"));
    await writeFile(
      this.path(),
      JSON.stringify(record, null, 2) + "\n",
      { encoding: "utf-8", mode: 0o600 },
    );
    await this.audit.append({
      tIso: nowIso,
      event: "consent",
      rulesetVersion: record.rulesetVersion,
    });
  }
}
