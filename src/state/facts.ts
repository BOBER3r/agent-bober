import { join } from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { z } from "zod";

import { ensureDir } from "./helpers.js";
import { memoryDir } from "./memory.js";

// ── Re-exports from reconcile layer ──────────────────────────────────────
// writeFact lives in reconcile.ts (to avoid a runtime import cycle) but is
// re-exported here so consumers can import it from the facts module.
export { writeFact } from "../orchestrator/memory/reconcile.js";
export type { ReconcileAction } from "../orchestrator/memory/reconcile.js";

// ── Schema ────────────────────────────────────────────────────────────

/**
 * Zod schema for a fact input — mirrors LessonEntrySchema in memory.ts.
 * All timestamps are ISO 8601 strings; the store never reads the clock.
 */
export const FactSchema = z.object({
  scope: z.string(),
  subject: z.string().min(1),
  predicate: z.string().min(1),
  value: z.string().min(1),
  confidence: z.number().min(0).max(1).default(1),
  sourceRunId: z.string().nullable().default(null),
  tValid: z.string().datetime(),
  tCreated: z.string().datetime(),
});

export type FactInput = z.infer<typeof FactSchema>;

// ── Record ────────────────────────────────────────────────────────────

export interface FactRecord {
  id: string;
  scope: string;
  subject: string;
  predicate: string;
  value: string;
  confidence: number;
  sourceRunId: string | null;
  tValid: string;
  tInvalid: string | null;
  tCreated: string;
  tInvalidated: string | null;
}

// ── Deterministic id ──────────────────────────────────────────────────

/**
 * Derive a deterministic 16-char hex fact id from the fact signature.
 * Mirrors lessonIdFromSignature in src/orchestrator/memory/distill.ts:88-99.
 * Identical inputs always produce the same id — no wall-clock dependency.
 */
export function factId(
  scope: string,
  subject: string,
  predicate: string,
  value: string,
  tCreated: string,
): string {
  return createHash("sha256")
    .update(`${scope}|${subject}|${predicate}|${value}|${tCreated}`)
    .digest("hex")
    .slice(0, 16);
}

// ── Path helpers ──────────────────────────────────────────────────────

/**
 * Resolve the absolute path to facts.db for the given project root and namespace.
 * Uses the same memoryDir mapping rule as memory.ts (no duplication).
 */
export function factsDbPath(projectRoot: string, namespace?: string): string {
  return join(memoryDir(projectRoot, namespace), "facts.db");
}

/**
 * Ensure the directory that will hold the DB file exists.
 * Must be called by the CLI handler before constructing a file-backed FactStore.
 * Not needed for ':memory:' paths.
 */
export async function ensureFactsDir(
  projectRoot: string,
  namespace?: string,
): Promise<void> {
  await ensureDir(memoryDir(projectRoot, namespace));
}

// ── Row mapper ────────────────────────────────────────────────────────

interface RawRow {
  id: string;
  scope: string;
  subject: string;
  predicate: string;
  value: string;
  confidence: number;
  source_run_id: string | null;
  t_valid: string;
  t_invalid: string | null;
  t_created: string;
  t_invalidated: string | null;
}

function rowToRecord(row: RawRow): FactRecord {
  return {
    id: row.id,
    scope: row.scope,
    subject: row.subject,
    predicate: row.predicate,
    value: row.value,
    confidence: row.confidence,
    sourceRunId: row.source_run_id,
    tValid: row.t_valid,
    tInvalid: row.t_invalid,
    tCreated: row.t_created,
    tInvalidated: row.t_invalidated,
  };
}

// ── FactStore ─────────────────────────────────────────────────────────

/**
 * Bi-temporal SQLite-backed fact store.
 *
 * PURE: Never calls Date.now() or new Date() — every timestamp is a parameter.
 * Hidden behind this interface so the driver (better-sqlite3) is swappable.
 *
 * bober: in-memory or file-backed via better-sqlite3 (synchronous); swap for
 * node:sqlite when engines.node is raised to >=22.5.
 */
export class FactStore {
  private db: DatabaseType;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS semantic_facts (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        value TEXT NOT NULL,
        confidence REAL NOT NULL,
        source_run_id TEXT,
        t_valid TEXT NOT NULL,
        t_invalid TEXT,
        t_created TEXT NOT NULL,
        t_invalidated TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_facts_sp ON semantic_facts(scope, subject, predicate);
      CREATE INDEX IF NOT EXISTS idx_facts_active ON semantic_facts(scope, t_invalidated);
    `);
  }

  /**
   * Insert a new fact. Validates input with FactSchema and derives the
   * deterministic id. Returns the persisted FactRecord.
   */
  insertFact(input: FactInput): FactRecord {
    const result = FactSchema.safeParse(input);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
        .join("\n");
      throw new Error(`Invalid fact input:\n${issues}`);
    }
    const data = result.data;
    const id = factId(data.scope, data.subject, data.predicate, data.value, data.tCreated);

    this.db
      .prepare(
        `INSERT OR REPLACE INTO semantic_facts
          (id, scope, subject, predicate, value, confidence, source_run_id, t_valid, t_invalid, t_created, t_invalidated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
      )
      .run(
        id,
        data.scope,
        data.subject,
        data.predicate,
        data.value,
        data.confidence,
        data.sourceRunId,
        data.tValid,
        data.tCreated,
      );

    return {
      id,
      scope: data.scope,
      subject: data.subject,
      predicate: data.predicate,
      value: data.value,
      confidence: data.confidence,
      sourceRunId: data.sourceRunId,
      tValid: data.tValid,
      tInvalid: null,
      tCreated: data.tCreated,
      tInvalidated: null,
    };
  }

  /**
   * Return all active (non-invalidated) facts matching the given scope.
   * Optionally filtered by subject and/or predicate.
   * Active = t_invalidated IS NULL.
   */
  getActiveFacts(scope: string, subject?: string, predicate?: string): FactRecord[] {
    if (subject !== undefined && predicate !== undefined) {
      const rows = this.db
        .prepare(
          `SELECT * FROM semantic_facts
           WHERE scope = ? AND subject = ? AND predicate = ? AND t_invalidated IS NULL`,
        )
        .all(scope, subject, predicate) as RawRow[];
      return rows.map(rowToRecord);
    }
    if (subject !== undefined) {
      const rows = this.db
        .prepare(
          `SELECT * FROM semantic_facts
           WHERE scope = ? AND subject = ? AND t_invalidated IS NULL`,
        )
        .all(scope, subject) as RawRow[];
      return rows.map(rowToRecord);
    }
    if (predicate !== undefined) {
      const rows = this.db
        .prepare(
          `SELECT * FROM semantic_facts
           WHERE scope = ? AND predicate = ? AND t_invalidated IS NULL`,
        )
        .all(scope, predicate) as RawRow[];
      return rows.map(rowToRecord);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM semantic_facts
         WHERE scope = ? AND t_invalidated IS NULL`,
      )
      .all(scope) as RawRow[];
    return rows.map(rowToRecord);
  }

  /**
   * Return a single fact by its id regardless of invalidation status.
   * Returns null if not found.
   */
  getFact(id: string): FactRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM semantic_facts WHERE id = ?`)
      .get(id) as RawRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  /**
   * Soft-delete a fact by setting t_invalidated.
   * Returns true if the fact was invalidated, false if it was already invalidated or not found.
   * Never deletes rows.
   */
  invalidateFact(id: string, tInvalidated: string): boolean {
    const info = this.db
      .prepare(
        `UPDATE semantic_facts
         SET t_invalidated = ?
         WHERE id = ? AND t_invalidated IS NULL`,
      )
      .run(tInvalidated, id);
    return info.changes > 0;
  }

  /**
   * Supersede a fact: set BOTH t_invalidated (record-time) AND t_invalid (world-time end).
   * Used by reconcile on UPDATE to carry both bi-temporal closure fields.
   * Returns true if the row was updated; false if not found or already invalidated.
   */
  supersedeFact(id: string, tInvalidated: string, tInvalid: string): boolean {
    const info = this.db
      .prepare(
        `UPDATE semantic_facts
         SET t_invalidated = ?, t_invalid = ?
         WHERE id = ? AND t_invalidated IS NULL`,
      )
      .run(tInvalidated, tInvalid, id);
    return info.changes > 0;
  }

  /** Close the underlying database connection. */
  close(): void {
    this.db.close();
  }
}
