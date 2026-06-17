/** Tests for WhoopSyncAdapter — fixture client, temp-dir real HealthDataStore, NO real network. */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HealthDataStore } from "../health-store.js";
import { StoreObservationSink } from "../ingestion.js";
import { WhoopSyncAdapter } from "./whoop-sync.js";
import type { WhoopClient, WhoopCollection, WhoopPage, SyncWindow } from "./whoop-client.js";

// ── Fake WhoopClient ─────────────────────────────────────────────────

/**
 * Duck-typed fake client that serves pre-loaded pages per collection.
 * throwOnNthCall: if set, throws on the Nth call to fetchPage (1-based).
 */
function fakeClient(
  pages: Partial<Record<WhoopCollection, WhoopPage[]>>,
  throwOnNthCall?: number,
): WhoopClient {
  let call = 0;
  const cursors: Partial<Record<WhoopCollection, number>> = {};

  return {
    async fetchPage(collection: WhoopCollection, _window: SyncWindow, _cursor?: string): Promise<WhoopPage> {
      call++;
      if (throwOnNthCall !== undefined && call === throwOnNthCall) {
        throw new Error("simulated mid-pagination failure");
      }
      const idx = cursors[collection] ?? 0;
      cursors[collection] = idx + 1;
      const collectionPages = pages[collection] ?? [];
      // Return the page at this index, or an empty page if exhausted
      return collectionPages[idx] ?? { records: [] };
    },
  } as unknown as WhoopClient; // duck-typed: sync only calls fetchPage
}

// ── Shared fixture window ────────────────────────────────────────────

const WINDOW: SyncWindow = {
  startIso: "2026-06-15T00:00:00Z",
  endIso: "2026-06-17T00:00:00Z",
};

// ── Lifecycle ────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-whoop-sync-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── sc-3-2: mapping, source, counts ─────────────────────────────────

describe("WhoopSyncAdapter mapping (sc-3-2)", () => {
  it("maps recovery records to source='whoop' rows and reports correct counts", async () => {
    const store = new HealthDataStore(join(tmpDir, "health.db"));
    try {
      const sink = new StoreObservationSink(store);
      const client = fakeClient({
        recovery: [
          {
            records: [
              {
                id: "r1",
                tStartIso: "2026-06-16T08:00:00Z",
                metrics: { recovery_score: 85, resting_heart_rate: 52 },
              },
            ],
          },
        ],
      });
      const adapter = new WhoopSyncAdapter(client);
      const result = await adapter.sync(WINDOW, sink);

      // 2 mapped fields from the one record
      expect(result.recordsParsed).toBe(2);
      expect(result.newRows).toBe(2);
      expect(result.newRows).toBe(result.recordsParsed);

      const scoreRows = store.getObservations("whoop_recovery_score", "2026-06-15", "2026-06-17");
      expect(scoreRows).toHaveLength(1);
      expect(scoreRows[0]).toMatchObject({ source: "whoop", unit: "%", value: 85 });

      const hrRows = store.getObservations("whoop_resting_heart_rate", "2026-06-15", "2026-06-17");
      expect(hrRows).toHaveLength(1);
      expect(hrRows[0]).toMatchObject({ source: "whoop", unit: "bpm", value: 52 });
    } finally {
      store.close();
    }
  });

  it("maps all four collections and skips unmapped fields", async () => {
    const store = new HealthDataStore(join(tmpDir, "health.db"));
    try {
      const sink = new StoreObservationSink(store);
      const client = fakeClient({
        recovery: [
          {
            records: [
              {
                id: "r1",
                tStartIso: "2026-06-16T08:00:00Z",
                metrics: { recovery_score: 75, unknown_field: 999 },
              },
            ],
          },
        ],
        sleep: [
          {
            records: [
              {
                id: "s1",
                tStartIso: "2026-06-16T00:00:00Z",
                metrics: { sleep_performance_percentage: 80 },
              },
            ],
          },
        ],
        cycle: [
          {
            records: [
              {
                id: "c1",
                tStartIso: "2026-06-16T06:00:00Z",
                metrics: { strain: 12.5 },
              },
            ],
          },
        ],
        workout: [
          {
            records: [
              {
                id: "w1",
                tStartIso: "2026-06-16T07:00:00Z",
                metrics: { strain: 8.2 },
              },
            ],
          },
        ],
      });

      const adapter = new WhoopSyncAdapter(client);
      const result = await adapter.sync(WINDOW, sink);

      // recovery: 1 mapped (unknown_field skipped), sleep: 1, cycle: 1, workout: 1 = 4 total
      expect(result.recordsParsed).toBe(4);
      expect(result.newRows).toBe(4);

      // Verify source and unit for each collection
      const recoveryRows = store.getObservations("whoop_recovery_score", "2026-06-15", "2026-06-17");
      expect(recoveryRows[0]).toMatchObject({ source: "whoop", unit: "%" });

      const sleepRows = store.getObservations("whoop_sleep_performance", "2026-06-15", "2026-06-17");
      expect(sleepRows[0]).toMatchObject({ source: "whoop", unit: "%" });

      const cycleRows = store.getObservations("whoop_strain", "2026-06-15", "2026-06-17");
      expect(cycleRows[0]).toMatchObject({ source: "whoop", unit: "score" });

      const workoutRows = store.getObservations("whoop_workout_strain", "2026-06-15", "2026-06-17");
      expect(workoutRows[0]).toMatchObject({ source: "whoop", unit: "score" });
    } finally {
      store.close();
    }
  });

  it("pages within a collection following nextCursor until exhausted", async () => {
    const store = new HealthDataStore(join(tmpDir, "health.db"));
    try {
      const sink = new StoreObservationSink(store);
      const client = fakeClient({
        recovery: [
          // page 1 has a cursor -> more pages
          {
            records: [{ id: "r1", tStartIso: "2026-06-15T08:00:00Z", metrics: { recovery_score: 60 } }],
            nextCursor: "page2token",
          },
          // page 2 has no cursor -> last page
          {
            records: [{ id: "r2", tStartIso: "2026-06-16T08:00:00Z", metrics: { recovery_score: 70 } }],
          },
        ],
      });

      const adapter = new WhoopSyncAdapter(client);
      const result = await adapter.sync(WINDOW, sink);

      expect(result.recordsParsed).toBe(2);
      expect(result.newRows).toBe(2);

      const rows = store.getObservations("whoop_recovery_score", "2026-06-15", "2026-06-17");
      expect(rows).toHaveLength(2);
    } finally {
      store.close();
    }
  });
});

// ── sc-3-3: idempotent resume ────────────────────────────────────────

describe("WhoopSyncAdapter idempotent resume (sc-3-3)", () => {
  it("second sync over the same window inserts zero new rows and leaves no duplicates", async () => {
    const store = new HealthDataStore(join(tmpDir, "health.db"));
    try {
      // Run 1
      const sink1 = new StoreObservationSink(store);
      const client1 = fakeClient({
        recovery: [
          {
            records: [
              { id: "r1", tStartIso: "2026-06-16T08:00:00Z", metrics: { recovery_score: 85, resting_heart_rate: 52 } },
            ],
          },
        ],
      });
      const adapter1 = new WhoopSyncAdapter(client1);
      const result1 = await adapter1.sync(WINDOW, sink1);
      expect(result1.newRows).toBeGreaterThan(0);

      // Run 2 — same data, same window
      const sink2 = new StoreObservationSink(store);
      const client2 = fakeClient({
        recovery: [
          {
            records: [
              { id: "r1", tStartIso: "2026-06-16T08:00:00Z", metrics: { recovery_score: 85, resting_heart_rate: 52 } },
            ],
          },
        ],
      });
      const adapter2 = new WhoopSyncAdapter(client2);
      const result2 = await adapter2.sync(WINDOW, sink2);
      expect(result2.newRows).toBe(0);

      // Row count in store unchanged
      const scoreRows = store.getObservations("whoop_recovery_score", "2026-06-15", "2026-06-17");
      expect(scoreRows).toHaveLength(1); // no duplicates
    } finally {
      store.close();
    }
  });
});

// ── sc-3-4: partial-failure safety ──────────────────────────────────

describe("WhoopSyncAdapter partial-failure safety (sc-3-4)", () => {
  it("page-1 rows survive when page-2 fetch throws, and a clean re-run completes", async () => {
    const store = new HealthDataStore(join(tmpDir, "health.db"));
    try {
      // throwOnNthCall=2 means: first fetchPage succeeds (recovery page 1), second throws.
      // Because collections loop recovery->sleep->cycle->workout, and recovery has 2 pages
      // (first has nextCursor), call 1 = recovery page 1, call 2 = recovery page 2 (throws).
      const throwingClient = fakeClient(
        {
          recovery: [
            {
              records: [{ id: "r1", tStartIso: "2026-06-16T08:00:00Z", metrics: { recovery_score: 85 } }],
              nextCursor: "page2token", // request page 2
            },
            {
              records: [{ id: "r2", tStartIso: "2026-06-16T10:00:00Z", metrics: { recovery_score: 70 } }],
            },
          ],
        },
        2, // throw on the 2nd call (page 2 of recovery)
      );

      const sink1 = new StoreObservationSink(store);
      const adapter1 = new WhoopSyncAdapter(throwingClient);

      // Sync should reject (propagate the error — fail-closed)
      await expect(adapter1.sync(WINDOW, sink1)).rejects.toThrow("simulated mid-pagination failure");

      // Page-1 rows must be present and well-formed (committed via per-batch txn, ADR-4)
      const rows = store.getObservations("whoop_recovery_score", "2026-06-15", "2026-06-17");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ source: "whoop", metric: "whoop_recovery_score", value: 85 });

      // Clean re-run with a non-throwing client should reach the full expected state
      const cleanClient = fakeClient({
        recovery: [
          {
            records: [
              { id: "r1", tStartIso: "2026-06-16T08:00:00Z", metrics: { recovery_score: 85 } },
              { id: "r2", tStartIso: "2026-06-16T10:00:00Z", metrics: { recovery_score: 70 } },
            ],
          },
        ],
      });

      const sink2 = new StoreObservationSink(store);
      const adapter2 = new WhoopSyncAdapter(cleanClient);
      const result2 = await adapter2.sync(WINDOW, sink2);

      // 2 mapped observations; row r1 already existed (newRows=1 for r2 only)
      expect(result2.recordsParsed).toBe(2);
      expect(result2.newRows).toBe(1); // r1 was a dup, r2 is new

      const finalRows = store.getObservations("whoop_recovery_score", "2026-06-15", "2026-06-17");
      expect(finalRows).toHaveLength(2); // full state reached
    } finally {
      store.close();
    }
  });
});
