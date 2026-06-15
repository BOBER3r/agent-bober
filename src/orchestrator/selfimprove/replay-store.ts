import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";

import {
  ReplayCaseSchema,
  type ReplayCaseInput,
  type ReplayCaseRecord,
} from "./replay-types.js";

// ── Deterministic id ──────────────────────────────────────────────────

/**
 * Derive a deterministic 16-char hex case id from the case signature.
 * caseId = sha256(`${contractId}|${iteration}|${diffDigest}`).slice(0,16)
 * MIRRORS factId at src/state/facts.ts:58-69.
 *
 * NOTE: tCaptured is intentionally EXCLUDED from the hash so the id stays
 * stable across captures — only a change in diffDigest changes the id.
 * Identical inputs always produce the same id — no wall-clock dependency.
 */
export function caseId(
  contractId: string,
  iteration: number,
  diffDigest: string,
): string {
  return createHash("sha256")
    .update(`${contractId}|${iteration}|${diffDigest}`)
    .digest("hex")
    .slice(0, 16);
}

// ── Row mapper ────────────────────────────────────────────────────────

interface RawRow {
  case_id: string;
  contract_id: string;
  iteration: number;
  baseline_verdict: string;
  diff_digest: string;
  eval_details_json: string;
  t_captured: string;
}

function rowToRecord(row: RawRow): ReplayCaseRecord {
  return {
    caseId: row.case_id,
    contractId: row.contract_id,
    iteration: row.iteration,
    baselineVerdict: row.baseline_verdict as "pass" | "fail",
    diffDigest: row.diff_digest,
    evalDetailsJson: row.eval_details_json,
    tCaptured: row.t_captured,
  };
}

// ── ReplayStore ───────────────────────────────────────────────────────

/**
 * SQLite-backed replay case store.
 *
 * PURE: Never calls Date.now() or new Date() — every timestamp is a parameter.
 * Hidden behind this interface so the driver (better-sqlite3) is swappable.
 *
 * bober: in-memory or file-backed via better-sqlite3 (synchronous); swap for
 * node:sqlite when engines.node is raised to >=22.5.
 */
export class ReplayStore {
  private db: DatabaseType;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS replay_cases (
        case_id TEXT PRIMARY KEY,
        contract_id TEXT NOT NULL,
        iteration INTEGER NOT NULL,
        baseline_verdict TEXT NOT NULL,
        diff_digest TEXT NOT NULL,
        eval_details_json TEXT NOT NULL,
        t_captured TEXT NOT NULL
      );
    `);
  }

  /**
   * Insert or replace a replay case. Validates input with ReplayCaseSchema and
   * derives the deterministic caseId. Returns the persisted ReplayCaseRecord.
   */
  putCase(input: ReplayCaseInput): ReplayCaseRecord {
    const result = ReplayCaseSchema.safeParse(input);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
        .join("\n");
      throw new Error(`Invalid replay case input:\n${issues}`);
    }
    const data = result.data;
    const id = caseId(data.contractId, data.iteration, data.diffDigest);

    this.db
      .prepare(
        `INSERT OR REPLACE INTO replay_cases
          (case_id, contract_id, iteration, baseline_verdict, diff_digest, eval_details_json, t_captured)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        data.contractId,
        data.iteration,
        data.baselineVerdict,
        data.diffDigest,
        data.evalDetailsJson,
        data.tCaptured,
      );

    return {
      caseId: id,
      contractId: data.contractId,
      iteration: data.iteration,
      baselineVerdict: data.baselineVerdict,
      diffDigest: data.diffDigest,
      evalDetailsJson: data.evalDetailsJson,
      tCaptured: data.tCaptured,
    };
  }

  /**
   * Return a single replay case by its id.
   * Returns null if not found.
   */
  getCase(id: string): ReplayCaseRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM replay_cases WHERE case_id = ?`)
      .get(id) as RawRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  /**
   * Return all replay cases ordered by t_captured ascending.
   */
  listCases(): ReplayCaseRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM replay_cases ORDER BY t_captured ASC`)
      .all() as RawRow[];
    return rows.map(rowToRecord);
  }

  /**
   * Return the baseline verdict for a case id, or null if not found.
   */
  getBaselineVerdict(id: string): string | null {
    const row = this.db
      .prepare(`SELECT baseline_verdict FROM replay_cases WHERE case_id = ?`)
      .get(id) as Pick<RawRow, "baseline_verdict"> | undefined;
    return row?.baseline_verdict ?? null;
  }

  /** Close the underlying database connection. */
  close(): void {
    this.db.close();
  }
}
