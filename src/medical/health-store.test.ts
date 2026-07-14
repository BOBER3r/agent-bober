import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HealthDataStore, observationId } from "./health-store.js";
import type { HealthObservation, LabResult, Baseline } from "./types.js";

// ── Fixtures ───────────────────────────────────────────────────────────

const OBS_5: HealthObservation[] = [
  { metric: "weight", value: 70.0, unit: "kg", tStart: "2026-01-01T06:00:00.000Z", source: "apple-health" },
  { metric: "weight", value: 70.5, unit: "kg", tStart: "2026-01-02T06:00:00.000Z", source: "apple-health" },
  { metric: "weight", value: 71.0, unit: "kg", tStart: "2026-01-03T06:00:00.000Z", source: "apple-health" },
  { metric: "weight", value: 70.8, unit: "kg", tStart: "2026-01-04T06:00:00.000Z", source: "apple-health" },
  { metric: "weight", value: 71.2, unit: "kg", tStart: "2026-01-05T06:00:00.000Z", source: "apple-health" },
];

// ── In-memory tests ───────────────────────────────────────────────────

describe("HealthDataStore (in-memory)", () => {
  let store: HealthDataStore;

  afterEach(() => {
    store?.close();
  });

  it("observationId is deterministic for identical (metric|tStart|source|value)", () => {
    const id1 = observationId("weight", "2026-01-01T06:00:00.000Z", "apple-health", 70.0);
    const id2 = observationId("weight", "2026-01-01T06:00:00.000Z", "apple-health", 70.0);
    expect(id1).toBe(id2);
    expect(id1).toHaveLength(16);
  });

  it("observationId differs when any field changes", () => {
    const base = observationId("weight", "2026-01-01T06:00:00.000Z", "apple-health", 70.0);
    expect(observationId("height", "2026-01-01T06:00:00.000Z", "apple-health", 70.0)).not.toBe(base);
    expect(observationId("weight", "2026-01-02T06:00:00.000Z", "apple-health", 70.0)).not.toBe(base);
    expect(observationId("weight", "2026-01-01T06:00:00.000Z", "whoop", 70.0)).not.toBe(base);
    expect(observationId("weight", "2026-01-01T06:00:00.000Z", "apple-health", 71.0)).not.toBe(base);
  });

  it("upsertObservations inserts new rows and returns the correct count", () => {
    store = new HealthDataStore(":memory:");
    const count = store.upsertObservations(OBS_5);
    expect(count).toBe(5);
  });

  it("getObservations returns rows in t_start ASC order within range", () => {
    store = new HealthDataStore(":memory:");
    store.upsertObservations(OBS_5);
    const rows = store.getObservations("weight", "2026-01-01T00:00:00.000Z", "2026-12-31T23:59:59.999Z");
    expect(rows).toHaveLength(5);
    // Verify ascending order
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].tStart >= rows[i - 1].tStart).toBe(true);
    }
  });

  it("getObservations filters by metric correctly", () => {
    store = new HealthDataStore(":memory:");
    store.upsertObservations(OBS_5);
    const hrObs: HealthObservation[] = [
      { metric: "heart_rate", value: 60, unit: "bpm", tStart: "2026-01-01T07:00:00.000Z", source: "apple-health" },
    ];
    store.upsertObservations(hrObs);

    const weightRows = store.getObservations("weight", "2026-01-01T00:00:00.000Z", "2026-12-31T23:59:59.999Z");
    const hrRows = store.getObservations("heart_rate", "2026-01-01T00:00:00.000Z", "2026-12-31T23:59:59.999Z");
    expect(weightRows).toHaveLength(5);
    expect(hrRows).toHaveLength(1);
  });

  it("getObservations respects fromIso/toIso range boundaries (inclusive)", () => {
    store = new HealthDataStore(":memory:");
    store.upsertObservations(OBS_5);
    // Only include Jan 2 and Jan 3
    const rows = store.getObservations("weight", "2026-01-02T00:00:00.000Z", "2026-01-03T23:59:59.999Z");
    expect(rows).toHaveLength(2);
    expect(rows[0].tStart).toBe("2026-01-02T06:00:00.000Z");
    expect(rows[1].tStart).toBe("2026-01-03T06:00:00.000Z");
  });

  it("getLabSeries returns lab results ordered by collected_at ASC", () => {
    store = new HealthDataStore(":memory:");
    const labs: LabResult[] = [
      { biomarker: "glucose", value: 95, unit: "mg/dL", collectedAtIso: "2026-01-03T08:00:00.000Z" },
      { biomarker: "glucose", value: 90, unit: "mg/dL", collectedAtIso: "2026-01-01T08:00:00.000Z" },
    ];
    for (const lab of labs) {
      store.upsertLabResult(lab);
    }
    const series = store.getLabSeries("glucose");
    expect(series).toHaveLength(2);
    expect(series[0].collectedAtIso).toBe("2026-01-01T08:00:00.000Z");
    expect(series[1].collectedAtIso).toBe("2026-01-03T08:00:00.000Z");
  });

  it("getLabSeries returns empty array for unknown biomarker", () => {
    store = new HealthDataStore(":memory:");
    expect(store.getLabSeries("unknown-biomarker")).toEqual([]);
  });

  it("putBaseline and getBaseline round-trip correctly", () => {
    store = new HealthDataStore(":memory:");
    const baseline: Baseline = { metric: "weight", value: 70.0, unit: "kg" };
    store.putBaseline(baseline);
    const retrieved = store.getBaseline("weight");
    expect(retrieved).toEqual(baseline);
  });

  it("getBaseline returns undefined for unknown metric", () => {
    store = new HealthDataStore(":memory:");
    expect(store.getBaseline("unknown-metric")).toBeUndefined();
  });

  it("putBaseline overwrites previous baseline for same metric", () => {
    store = new HealthDataStore(":memory:");
    store.putBaseline({ metric: "weight", value: 70.0, unit: "kg" });
    store.putBaseline({ metric: "weight", value: 72.0, unit: "kg" });
    const retrieved = store.getBaseline("weight");
    expect(retrieved?.value).toBe(72.0);
  });

  it("getPreference returns stored preference string", () => {
    store = new HealthDataStore(":memory:");
    // Insert directly via kv_store pattern via putBaseline-style method
    // (getPreference reads pref: prefix)
    store["db"]
      .prepare("INSERT OR REPLACE INTO kv_store (k, v) VALUES (?, ?)")
      .run("pref:units", "metric");
    expect(store.getPreference("units")).toBe("metric");
  });

  it("getPreference returns undefined for unknown key", () => {
    store = new HealthDataStore(":memory:");
    expect(store.getPreference("nonexistent")).toBeUndefined();
  });
});

// ── File-backed dedup test (sc-4-4) with temp dir ─────────────────────

describe("HealthDataStore (file-backed dedup — sc-4-4)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bober-health-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("INSERT OR IGNORE dedupes by SHA-256 id; returns NEW-row count only (sc-4-4)", () => {
    const store = new HealthDataStore(join(tmpDir, "health.db"));

    // First insert: 5 distinct observations → should return 5
    const first = store.upsertObservations(OBS_5);
    expect(first).toBe(5);

    // Re-insert the same 5 → should return 0 (all are duplicates)
    const second = store.upsertObservations(OBS_5);
    expect(second).toBe(0);

    // Data in DB is still 5 rows (not doubled)
    const rows = store.getObservations("weight", "2026-01-01T00:00:00.000Z", "2026-12-31T23:59:59.999Z");
    expect(rows).toHaveLength(5);

    store.close();
  });

  it("partial duplicate batch: only new rows increment the count", () => {
    const store = new HealthDataStore(join(tmpDir, "partial.db"));

    const first3 = OBS_5.slice(0, 3);
    expect(store.upsertObservations(first3)).toBe(3);

    // Re-insert first 3 + add 2 new → should return 2 (only the new ones)
    expect(store.upsertObservations(OBS_5)).toBe(2);

    const rows = store.getObservations("weight", "2026-01-01T00:00:00.000Z", "2026-12-31T23:59:59.999Z");
    expect(rows).toHaveLength(5);

    store.close();
  });
});
