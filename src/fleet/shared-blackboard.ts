import { dirname } from "node:path";

import { ensureDir } from "../state/helpers.js";
import { FactStore } from "../state/facts.js";
import type { FactRecord } from "../state/facts.js";

// ── Constants ────────────────────────────────────────────────────────

export const BLACKBOARD_MAX_ROUNDS = 3;

// ── Types ────────────────────────────────────────────────────────────

export interface BlackboardFinding {
  childFolder: string;
  round: number;
  payload: string;
  confidence?: number;
}

export interface SharedBlackboardOpts {
  dbPath: string;
  namespace: string;
  busyTimeoutMs?: number;
  maxRounds?: number;
}

// ── SharedBlackboard ─────────────────────────────────────────────────

/**
 * Bounded inter-agent exchange wrapper over one shared facts.db.
 * Opens the db in WAL mode with a busy_timeout so concurrent fleet
 * children can publish findings without SQLITE_BUSY deadlocks.
 *
 * bober: single-file SQLite WAL (better-sqlite3 synchronous writes);
 * swap for a network WAL (e.g. Turso/libSQL) if fleet grows beyond
 * one host or requires cross-machine exchange.
 */
export class SharedBlackboard {
  private store: FactStore;
  private namespace: string;
  private maxRounds: number;

  private constructor(store: FactStore, namespace: string, maxRounds: number) {
    this.store = store;
    this.namespace = namespace;
    this.maxRounds = maxRounds;
  }

  /**
   * Open (or create) a shared WAL facts.db at dbPath.
   * Ensures the parent directory exists before opening.
   * Returns a ready-to-use SharedBlackboard instance.
   */
  static async open(opts: SharedBlackboardOpts): Promise<SharedBlackboard> {
    if (opts.dbPath !== ":memory:") {
      await ensureDir(dirname(opts.dbPath));
    }
    const store = new FactStore(opts.dbPath, {
      journalModeWal: opts.dbPath !== ":memory:",
      busyTimeoutMs: opts.busyTimeoutMs ?? 5000,
    });
    const maxRounds = Math.min(
      opts.maxRounds ?? BLACKBOARD_MAX_ROUNDS,
      BLACKBOARD_MAX_ROUNDS,
    );
    return new SharedBlackboard(store, opts.namespace, maxRounds);
  }

  /**
   * Publish a finding from one fleet child.
   * Throws when finding.round exceeds the effective maxRounds cap.
   * Returns the persisted FactRecord.
   */
  publish(finding: BlackboardFinding, now: string): FactRecord {
    if (finding.round > this.maxRounds) {
      throw new Error(
        `blackboard round ${finding.round} exceeds cap ${this.maxRounds}`,
      );
    }
    return this.store.insertFact({
      scope: this.namespace,
      subject: finding.childFolder,
      predicate: "finding",
      value: finding.payload,
      confidence: finding.confidence ?? 1,
      sourceRunId: null,
      tValid: now,
      tCreated: now,
    });
  }

  /**
   * Return all active 'finding' facts in this namespace published by
   * children OTHER than selfFolder.
   */
  readSiblings(selfFolder: string): FactRecord[] {
    return this.store
      .getActiveFacts(this.namespace, undefined, "finding")
      .filter((f) => f.subject !== selfFolder);
  }

  /** Return ALL active 'finding' facts in this namespace. */
  readAll(): FactRecord[] {
    return this.store.getActiveFacts(this.namespace, undefined, "finding");
  }

  /** Close the underlying database connection. */
  close(): void {
    this.store.close();
  }
}
