/**
 * HealthDataStore — SQLite-backed health observation store (Phase 6, Sprint 4).
 *
 * Mirrors FactStore (src/state/facts.ts) exactly:
 *   - better-sqlite3 SYNC (no await anywhere)
 *   - Single generic `health_observations` events table + `lab_results` + `kv_store`
 *   - CREATE TABLE IF NOT EXISTS in constructor
 *   - INSERT OR IGNORE on deterministic SHA-256 id
 *   - upsertObservations returns NEW-row count only (sum of info.changes)
 *
 * PURE: Never calls Date.now() or new Date() — every timestamp is an injected parameter.
 * ADR-4: Generic single-table pattern, deterministic id = SHA-256(metric|tStart|source|value).
 *
 * bober: in-memory or file-backed via better-sqlite3 (synchronous); swap for node:sqlite
 *        when engines.node is raised to >=22.5.
 */

import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";

import type { HealthObservation, LabResult, Baseline } from "./types.js";

// ── Deterministic id helper ───────────────────────────────────────────

/**
 * Derive a deterministic 16-char hex id for a health observation.
 * Mirrors factId at src/state/facts.ts:58-69.
 * Signature: metric|tStart|source|value (ADR-4 contract line 73).
 * Identical inputs always produce the same id — no wall-clock dependency.
 */
export function observationId(
  metric: string,
  tStart: string,
  source: string,
  value: number,
): string {
  return createHash("sha256")
    .update(`${metric}|${tStart}|${source}|${value}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Derive a deterministic 16-char hex id for a lab result.
 * Signature: biomarker|collectedAtIso|value.
 */
export function labResultId(biomarker: string, collectedAtIso: string, value: number): string {
  return createHash("sha256")
    .update(`${biomarker}|${collectedAtIso}|${value}`)
    .digest("hex")
    .slice(0, 16);
}

// ── Raw row interfaces (snake_case DB columns) ────────────────────────

interface RawObsRow {
  id: string;
  metric: string;
  value: number;
  unit: string;
  t_start: string;
  t_end: string | null;
  source: string;
}

interface RawLabRow {
  id: string;
  biomarker: string;
  value: number;
  unit: string;
  collected_at: string;
  ref_low: number | null;
  ref_high: number | null;
}

// ── Row mappers (snake_case → camelCase) ──────────────────────────────

function rowToObservation(row: RawObsRow): HealthObservation {
  return {
    id: row.id,
    metric: row.metric,
    value: row.value,
    unit: row.unit,
    tStart: row.t_start,
    tEnd: row.t_end ?? undefined,
    source: row.source,
  };
}

function rowToLabResult(row: RawLabRow): LabResult {
  return {
    id: row.id,
    biomarker: row.biomarker,
    value: row.value,
    unit: row.unit,
    collectedAtIso: row.collected_at,
    referenceLow: row.ref_low ?? undefined,
    referenceHigh: row.ref_high ?? undefined,
  };
}

// ── HealthDataStore ───────────────────────────────────────────────────

/**
 * SQLite-backed health observation store.
 *
 * Tables:
 *   health_observations — generic single-table for metric time series (ADR-4)
 *   lab_results         — laboratory biomarker results with reference ranges
 *   kv_store            — key/value backing for getBaseline/putBaseline + getPreference
 *
 * All methods are SYNCHRONOUS (better-sqlite3 API). No await anywhere.
 */
export class HealthDataStore {
  private db: DatabaseType;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS health_observations (
        id TEXT PRIMARY KEY,
        metric TEXT NOT NULL,
        value REAL NOT NULL,
        unit TEXT NOT NULL,
        t_start TEXT NOT NULL,
        t_end TEXT,
        source TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_obs_metric ON health_observations(metric, t_start);

      CREATE TABLE IF NOT EXISTS lab_results (
        id TEXT PRIMARY KEY,
        biomarker TEXT NOT NULL,
        value REAL NOT NULL,
        unit TEXT NOT NULL,
        collected_at TEXT NOT NULL,
        ref_low REAL,
        ref_high REAL
      );
      CREATE INDEX IF NOT EXISTS idx_lab_biomarker ON lab_results(biomarker, collected_at);

      CREATE TABLE IF NOT EXISTS kv_store (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      );
    `);
  }

  /**
   * Insert observations, ignoring duplicates (INSERT OR IGNORE on the deterministic id).
   * Returns the count of NEW rows only (0 for duplicates, 1 per genuinely new row).
   * ADR-4: id = SHA-256(metric|tStart|source|value).slice(0,16).
   */
  upsertObservations(rows: HealthObservation[]): number {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO health_observations
         (id, metric, value, unit, t_start, t_end, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    // better-sqlite3 .transaction returns the fn's return value synchronously.
    const insertAll = this.db.transaction((obs: HealthObservation[]) => {
      let inserted = 0;
      for (const o of obs) {
        const id = o.id ?? observationId(o.metric, o.tStart, o.source, o.value);
        const info = stmt.run(id, o.metric, o.value, o.unit, o.tStart, o.tEnd ?? null, o.source);
        // INSERT OR IGNORE => info.changes is 0 for a dup, 1 for a new row.
        inserted += info.changes;
      }
      return inserted;
    });

    return insertAll(rows);
  }

  /**
   * Return observations for a metric within [fromIso, toIso], ordered by t_start ASC.
   * ISO-8601 strings sort lexicographically == chronologically.
   */
  getObservations(metric: string, fromIso: string, toIso: string): HealthObservation[] {
    const rows = this.db
      .prepare(
        `SELECT id, metric, value, unit, t_start, t_end, source
           FROM health_observations
          WHERE metric = ? AND t_start >= ? AND t_start <= ?
          ORDER BY t_start ASC`,
      )
      .all(metric, fromIso, toIso) as RawObsRow[];
    return rows.map(rowToObservation);
  }

  /**
   * Return all lab results for a biomarker, ordered by collected_at ASC.
   */
  getLabSeries(biomarker: string): LabResult[] {
    const rows = this.db
      .prepare(
        `SELECT id, biomarker, value, unit, collected_at, ref_low, ref_high
           FROM lab_results
          WHERE biomarker = ?
          ORDER BY collected_at ASC`,
      )
      .all(biomarker) as RawLabRow[];
    return rows.map(rowToLabResult);
  }

  /**
   * Insert a lab result, ignoring duplicates.
   * Returns the count of NEW rows inserted (0 or 1).
   */
  upsertLabResult(result: LabResult): number {
    const id = result.id ?? labResultId(result.biomarker, result.collectedAtIso, result.value);
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO lab_results
           (id, biomarker, value, unit, collected_at, ref_low, ref_high)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        result.biomarker,
        result.value,
        result.unit,
        result.collectedAtIso,
        result.referenceLow ?? null,
        result.referenceHigh ?? null,
      );
    return info.changes;
  }

  /**
   * Read a stored baseline for a metric from the kv_store.
   * Returns undefined if no baseline has been stored.
   */
  getBaseline(metric: string): Baseline | undefined {
    const row = this.db
      .prepare(`SELECT v FROM kv_store WHERE k = ?`)
      .get(`baseline:${metric}`) as { v: string } | undefined;
    if (!row) return undefined;
    return JSON.parse(row.v) as Baseline;
  }

  /**
   * Persist a baseline value to the kv_store (INSERT OR REPLACE).
   */
  putBaseline(b: Baseline): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO kv_store (k, v) VALUES (?, ?)`)
      .run(`baseline:${b.metric}`, JSON.stringify(b));
  }

  /**
   * Read a preference string from the kv_store.
   * Returns undefined if the key is not set.
   */
  getPreference(key: string): string | undefined {
    const row = this.db
      .prepare(`SELECT v FROM kv_store WHERE k = ?`)
      .get(`pref:${key}`) as { v: string } | undefined;
    return row?.v;
  }

  /**
   * Return all distinct biomarker names present in the lab_results table, ordered alphabetically.
   * Returns an empty array when no lab results have been loaded.
   */
  listBiomarkers(): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT biomarker FROM lab_results ORDER BY biomarker ASC`)
      .all() as { biomarker: string }[];
    return rows.map((r) => r.biomarker);
  }

  /** Close the underlying database connection. */
  close(): void {
    this.db.close();
  }
}
