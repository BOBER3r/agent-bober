/** WhoopSyncAdapter — network sync of WHOOP v2 records into the ObservationSink (ADR-1). NO network import. */
import type { ObservationSink, HealthObservation, IngestionResult } from "../types.js";
import type { WhoopClient, WhoopCollection, WhoopRecord, SyncWindow } from "./whoop-client.js";

// ── Mapping table ────────────────────────────────────────────────────
// Per-collection: WHOOP score-field name -> fixed (metric, unit). Unmapped fields are SKIPPED.
const WHOOP_FIELD_MAP: Record<WhoopCollection, Record<string, { metric: string; unit: string }>> = {
  recovery: {
    recovery_score:      { metric: "whoop_recovery_score",     unit: "%"    },
    resting_heart_rate:  { metric: "whoop_resting_heart_rate", unit: "bpm"  },
    hrv_rmssd_milli:     { metric: "whoop_hrv",                unit: "ms"   },
    spo2_percentage:     { metric: "whoop_spo2",               unit: "%"    },
    skin_temp_celsius:   { metric: "whoop_skin_temp",          unit: "degC" },
  },
  sleep: {
    sleep_performance_percentage: { metric: "whoop_sleep_performance", unit: "%"   },
    total_in_bed_time_milli:      { metric: "whoop_sleep_in_bed",      unit: "ms"  },
    respiratory_rate:             { metric: "whoop_respiratory_rate",  unit: "rpm" },
  },
  cycle: {
    strain:              { metric: "whoop_strain",         unit: "score" },
    average_heart_rate:  { metric: "whoop_avg_heart_rate", unit: "bpm"   },
    kilojoule:           { metric: "whoop_kilojoule",      unit: "kJ"    },
  },
  workout: {
    strain:              { metric: "whoop_workout_strain",    unit: "score" },
    average_heart_rate:  { metric: "whoop_workout_avg_hr",   unit: "bpm"   },
    kilojoule:           { metric: "whoop_workout_kilojoule", unit: "kJ"   },
  },
};

const COLLECTIONS: WhoopCollection[] = ["recovery", "sleep", "cycle", "workout"];

// ── Record mapping ───────────────────────────────────────────────────

/**
 * Map a list of WhoopRecords from one collection into HealthObservations.
 * Only fields present in WHOOP_FIELD_MAP are emitted — unmapped fields are skipped.
 * id is left UNSET so the store derives the content-derived SHA-256 dedup key.
 */
function mapWhoopRecords(collection: WhoopCollection, records: WhoopRecord[]): HealthObservation[] {
  const table = WHOOP_FIELD_MAP[collection];
  const out: HealthObservation[] = [];
  for (const rec of records) {
    for (const [field, value] of Object.entries(rec.metrics)) {
      const mapped = table[field];
      if (!mapped) continue; // unmapped fields skipped, never guessed
      out.push({
        // id left UNSET — store derives content-derived SHA-256 (do NOT use rec.id)
        metric: mapped.metric,
        value,
        unit: mapped.unit,
        tStart: rec.tStartIso,
        tEnd: rec.tEndIso,
        source: "whoop",
      });
    }
  }
  return out;
}

// ── WhoopSyncAdapter ─────────────────────────────────────────────────

/**
 * Adapts WhoopClient pagination into the ObservationSink interface (ADR-1).
 *
 * NOT an IngestionAdapter — its entry point is sync(window, sink), not ingest(filePath, sink).
 * All HTTP is confined to WhoopClient (injected dependency).
 *
 * On any fetchPage throw, the error PROPAGATES (fail-closed).
 * Prior batches are already committed via per-batch better-sqlite3 transactions (ADR-4).
 * A failed sync is recovered by re-running — idempotent dedup via INSERT OR IGNORE.
 */
export class WhoopSyncAdapter {
  readonly source = "whoop";

  constructor(private readonly client: WhoopClient) {}

  /**
   * Sync all four WHOOP collections over the given window into the sink.
   * Pages each collection following nextCursor until the last page (undefined cursor).
   * Returns IngestionResult { recordsParsed, newRows }.
   */
  async sync(window: SyncWindow, sink: ObservationSink): Promise<IngestionResult> {
    let recordsParsed = 0;

    for (const collection of COLLECTIONS) {
      let cursor: string | undefined;
      do {
        // Any throw PROPAGATES — fail-closed; committed batches already persisted (ADR-4)
        const page = await this.client.fetchPage(collection, window, cursor);
        const obs = mapWhoopRecords(collection, page.records);
        recordsParsed += obs.length; // counts mapped observations only (not raw records)
        if (obs.length > 0) {
          await sink.writeBatch(obs, []); // per-batch txn commits here; await = backpressure
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined);
    }

    // Read newRows off the sink (mirrors apple-health.ts:115-117); writeBatch returns void.
    const newRows = "newRows" in sink ? (sink as { newRows: number }).newRows : 0;
    return { recordsParsed, newRows };
  }
}
