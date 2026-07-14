/** IngestionNormalizer + StoreObservationSink — streaming health import (Phase 6, Sprint 5). */
import type { HealthDataStore } from "./health-store.js";
import type {
  HealthObservation,
  IngestionAdapter,
  IngestionResult,
  LabResult,
  ObservationSink,
} from "./types.js";

/**
 * ObservationSink implementation that batches writes into HealthDataStore.
 * Accumulates newRows across all writeBatch calls for the final IngestionResult.
 * writeBatch is async so the adapter can await it and apply backpressure.
 */
export class StoreObservationSink implements ObservationSink {
  /** Accumulates the total count of NEW rows inserted across all batches. */
  public newRows = 0;

  constructor(private readonly store: HealthDataStore) {}

  async writeBatch(obs: HealthObservation[], labs: LabResult[]): Promise<void> {
    // upsertObservations is synchronous (better-sqlite3); returns NEW-row count.
    if (obs.length > 0) {
      this.newRows += this.store.upsertObservations(obs);
    }
    for (const lab of labs) {
      this.newRows += this.store.upsertLabResult(lab);
    }
    // async signature lets the adapter await this call and pause/resume around it.
  }
}

/**
 * Registry of IngestionAdapters.
 * register() adds adapters; importFile() dispatches to the first matching one.
 * Throws a clear Error naming the file if no adapter canHandle it (sc-5-7).
 */
export class IngestionNormalizer {
  private readonly adapters: IngestionAdapter[] = [];
  // bober: linear scan; swap for Map<ext, adapter> when adapter count grows large
  private readonly sink: ObservationSink;

  constructor(sink: ObservationSink) {
    this.sink = sink;
  }

  /** Add an adapter to the registry. */
  register(adapter: IngestionAdapter): void {
    this.adapters.push(adapter);
  }

  /**
   * Import a file using the first matching adapter.
   * Throws if no adapter canHandle the file (message contains the file path).
   */
  async importFile(filePath: string): Promise<IngestionResult> {
    const adapter = this.adapters.find((a) => a.canHandle(filePath));
    if (!adapter) {
      throw new Error(`No ingestion adapter can handle '${filePath}'`);
    }
    return adapter.ingest(filePath, this.sink);
  }
}
