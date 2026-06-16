import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { HealthDataStore } from "./health-store.js";
import { NumericsQueryLayer } from "./numerics.js";
import type { HealthObservation, LabResult } from "./types.js";

// ── Test fixtures ─────────────────────────────────────────────────────

/**
 * Fixture series: values [10, 20, 30, 40] at increasing timestamps (evenly spaced by 1 day).
 * Hand-computed expected values for each primitive (from the briefing):
 *   mean       = 25
 *   min        = 10
 *   max        = 40
 *   latest     = 40  (last element of ASC-ordered array)
 *   delta      = 30  (40 − 10)
 *   slope      > 0   (values increase over time)
 *   percentile = 25  (p50: rank=1.5 → 20 + 0.5·(30−20) = 25)
 *   zscore     ≈ 1.3416 (mean=25, popStd=√125, z=(40−25)/√125)
 */
const FIXTURE_SERIES: HealthObservation[] = [
  { metric: "glucose", value: 10, unit: "mg/dL", tStart: "2026-01-01T00:00:00.000Z", source: "lab" },
  { metric: "glucose", value: 20, unit: "mg/dL", tStart: "2026-01-02T00:00:00.000Z", source: "lab" },
  { metric: "glucose", value: 30, unit: "mg/dL", tStart: "2026-01-03T00:00:00.000Z", source: "lab" },
  { metric: "glucose", value: 40, unit: "mg/dL", tStart: "2026-01-04T00:00:00.000Z", source: "lab" },
];

const WINDOW = {
  metric: "glucose",
  fromIso: "2026-01-01T00:00:00.000Z",
  toIso: "2026-12-31T23:59:59.999Z",
};

// ── Helper to set up an in-memory store with fixture data ─────────────

function makeQueryLayer(obs: HealthObservation[] = FIXTURE_SERIES): {
  numerics: NumericsQueryLayer;
  store: HealthDataStore;
} {
  const store = new HealthDataStore(":memory:");
  store.upsertObservations(obs);
  const numerics = new NumericsQueryLayer(store);
  return { numerics, store };
}

// ── Tests for all 8 primitives (sc-4-5) ──────────────────────────────

describe("NumericsQueryLayer — 8 primitive correctness (sc-4-5)", () => {
  let store: HealthDataStore;

  afterEach(() => {
    store?.close();
  });

  it("mean = 25 for [10,20,30,40]", () => {
    const { numerics, store: s } = makeQueryLayer();
    store = s;
    const result = numerics.getMetric(WINDOW, "mean");
    expect(result.primitive).toBe("mean");
    expect(result.value).toBe(25);
    expect(result.unit).toBe("mg/dL");
    expect(result.sampleCount).toBe(4);
  });

  it("min = 10 for [10,20,30,40]", () => {
    const { numerics, store: s } = makeQueryLayer();
    store = s;
    const result = numerics.getMetric(WINDOW, "min");
    expect(result.value).toBe(10);
    expect(result.sampleCount).toBe(4);
  });

  it("max = 40 for [10,20,30,40]", () => {
    const { numerics, store: s } = makeQueryLayer();
    store = s;
    const result = numerics.getMetric(WINDOW, "max");
    expect(result.value).toBe(40);
    expect(result.sampleCount).toBe(4);
  });

  it("latest = 40 for [10,20,30,40] (last element of ASC-ordered series)", () => {
    const { numerics, store: s } = makeQueryLayer();
    store = s;
    const result = numerics.getMetric(WINDOW, "latest");
    expect(result.value).toBe(40);
    expect(result.sampleCount).toBe(4);
  });

  it("delta = 30 for [10,20,30,40] (latest − earliest = 40 − 10)", () => {
    const { numerics, store: s } = makeQueryLayer();
    store = s;
    const result = numerics.getMetric(WINDOW, "delta");
    expect(result.value).toBe(30);
    expect(result.sampleCount).toBe(4);
  });

  it("slope > 0 for increasing values over increasing timestamps", () => {
    const { numerics, store: s } = makeQueryLayer();
    store = s;
    const result = numerics.getMetric(WINDOW, "slope");
    expect(result.sampleCount).toBe(4);
    expect(result.value).not.toBeNull();
    expect(result.value as number).toBeGreaterThan(0);
    // Verify slope units: (mg/dL) per millisecond → convert to per-day for sanity
    // Per day = (10 mg/dL) / (86400000 ms) ≈ 1.1574e-7 per ms
    const slopePerMs = result.value as number;
    const slopePerDay = slopePerMs * 86_400_000;
    expect(slopePerDay).toBeCloseTo(10, 5); // 10 mg/dL per day
  });

  it("percentile p50 = 25 for [10,20,30,40] (linear interpolation)", () => {
    const { numerics, store: s } = makeQueryLayer();
    store = s;
    // p50: rank = 0.5 · (4-1) = 1.5 → v[1] + 0.5 · (v[2]-v[1]) = 20 + 0.5·10 = 25
    const result = numerics.getMetric(WINDOW, "percentile", 50);
    expect(result.value).toBe(25);
    expect(result.sampleCount).toBe(4);
  });

  it("percentile p25 = 17.5 for [10,20,30,40] (linear interpolation)", () => {
    const { numerics, store: s } = makeQueryLayer();
    store = s;
    // p25: rank = 0.25 · (4-1) = 0.75 → v[0] + 0.75 · (v[1]-v[0]) = 10 + 0.75·10 = 17.5
    const result = numerics.getMetric(WINDOW, "percentile", 25);
    expect(result.value).toBeCloseTo(17.5, 10);
  });

  it("percentile p100 = 40 for [10,20,30,40] (maximum)", () => {
    const { numerics, store: s } = makeQueryLayer();
    store = s;
    const result = numerics.getMetric(WINDOW, "percentile", 100);
    expect(result.value).toBe(40);
  });

  it("zscore ≈ 1.3416 for [10,20,30,40] (population stddev formula)", () => {
    const { numerics, store: s } = makeQueryLayer();
    store = s;
    // mean=25, popVar=((10-25)²+(20-25)²+(30-25)²+(40-25)²)/4 = (225+25+25+225)/4 = 125
    // popStd = √125 ≈ 11.1803
    // zscore = (40-25)/√125 ≈ 1.3416
    const result = numerics.getMetric(WINDOW, "zscore");
    expect(result.value).not.toBeNull();
    expect(result.value as number).toBeCloseTo(1.3416, 3);
    expect(result.sampleCount).toBe(4);
  });
});

// ── Empty window abstain (sc-4-6) ────────────────────────────────────

describe("NumericsQueryLayer — empty window abstain (sc-4-6)", () => {
  let store: HealthDataStore;

  afterEach(() => {
    store?.close();
  });

  it("getMetric on an empty window returns { value: null, sampleCount: 0 } without throwing", () => {
    store = new HealthDataStore(":memory:");
    const numerics = new NumericsQueryLayer(store);

    // No data in DB — all 8 primitives must abstain
    const primitives = ["mean", "min", "max", "latest", "delta", "slope", "percentile", "zscore"] as const;
    for (const primitive of primitives) {
      const result = numerics.getMetric(WINDOW, primitive);
      expect(result.value, `${primitive} should abstain`).toBeNull();
      expect(result.sampleCount, `${primitive} sampleCount should be 0`).toBe(0);
    }
  });

  it("getMetric outside date range returns abstain (no data in window)", () => {
    const { numerics, store: s } = makeQueryLayer();
    store = s;
    // Fixture is Jan 2026; query in 2020 finds nothing
    const result = numerics.getMetric(
      { metric: "glucose", fromIso: "2020-01-01T00:00:00.000Z", toIso: "2020-12-31T23:59:59.999Z" },
      "mean",
    );
    expect(result.value).toBeNull();
    expect(result.sampleCount).toBe(0);
  });

  it("getLabTrend on unknown biomarker abstains with { sampleCount: 0, latestValue: null }", () => {
    store = new HealthDataStore(":memory:");
    const numerics = new NumericsQueryLayer(store);
    const trend = numerics.getLabTrend("unknown-biomarker");
    expect(trend.sampleCount).toBe(0);
    expect(trend.latestValue).toBeNull();
    expect(trend.latestCollectedAt).toBeNull();
    expect(trend.slope).toBeNull();
  });
});

// ── zscore n<2 abstain ────────────────────────────────────────────────

describe("NumericsQueryLayer — zscore n<2 abstain", () => {
  let store: HealthDataStore;

  afterEach(() => {
    store?.close();
  });

  it("zscore with n=1 abstains (value: null) but sampleCount is 1", () => {
    const single: HealthObservation[] = [
      { metric: "bp", value: 120, unit: "mmHg", tStart: "2026-01-01T00:00:00.000Z", source: "manual" },
    ];
    const { numerics, store: s } = makeQueryLayer(single);
    store = s;
    const result = numerics.getMetric(
      { metric: "bp", fromIso: "2026-01-01T00:00:00.000Z", toIso: "2026-12-31T23:59:59.999Z" },
      "zscore",
    );
    expect(result.value).toBeNull();
    // n=1 is not empty (rows exist), so sampleCount = 1
    expect(result.sampleCount).toBe(1);
  });
});

// ── Cross-unit refusal (sc-4-7) ───────────────────────────────────────

describe("NumericsQueryLayer — cross-unit refusal (sc-4-7)", () => {
  let store: HealthDataStore;

  afterEach(() => {
    store?.close();
  });

  it("refuses to aggregate when metric 'weight' has mixed units kg and lb", () => {
    const mixedObs: HealthObservation[] = [
      { metric: "weight", value: 70.0, unit: "kg", tStart: "2026-01-01T06:00:00.000Z", source: "apple-health" },
      { metric: "weight", value: 154.0, unit: "lb", tStart: "2026-01-02T06:00:00.000Z", source: "whoop" },
    ];
    store = new HealthDataStore(":memory:");
    store.upsertObservations(mixedObs);
    const numerics = new NumericsQueryLayer(store);

    // All primitives must abstain on cross-unit data
    const result = numerics.getMetric(
      { metric: "weight", fromIso: "2026-01-01T00:00:00.000Z", toIso: "2026-12-31T23:59:59.999Z" },
      "mean",
    );
    expect(result.value).toBeNull();
    // sampleCount reflects the rows found (not 0 — we distinguish "empty" from "refused")
    expect(result.sampleCount).toBe(2);
    expect(result.unit).toBe("");
  });

  it("does NOT refuse when all units in a window are identical", () => {
    const sameUnitObs: HealthObservation[] = [
      { metric: "weight", value: 70.0, unit: "kg", tStart: "2026-01-01T06:00:00.000Z", source: "apple-health" },
      { metric: "weight", value: 71.0, unit: "kg", tStart: "2026-01-02T06:00:00.000Z", source: "apple-health" },
    ];
    store = new HealthDataStore(":memory:");
    store.upsertObservations(sameUnitObs);
    const numerics = new NumericsQueryLayer(store);

    const result = numerics.getMetric(
      { metric: "weight", fromIso: "2026-01-01T00:00:00.000Z", toIso: "2026-12-31T23:59:59.999Z" },
      "mean",
    );
    expect(result.value).toBe(70.5);
    expect(result.unit).toBe("kg");
    expect(result.sampleCount).toBe(2);
  });
});

// ── getLabTrend correctness ───────────────────────────────────────────

describe("NumericsQueryLayer — getLabTrend", () => {
  let store: HealthDataStore;

  afterEach(() => {
    store?.close();
  });

  it("returns correct trend from a lab series with 2+ points", () => {
    store = new HealthDataStore(":memory:");
    const labs: LabResult[] = [
      { biomarker: "cholesterol", value: 180, unit: "mg/dL", collectedAtIso: "2026-01-01T08:00:00.000Z" },
      { biomarker: "cholesterol", value: 200, unit: "mg/dL", collectedAtIso: "2026-02-01T08:00:00.000Z" },
    ];
    for (const lab of labs) {
      store.upsertLabResult(lab);
    }
    const numerics = new NumericsQueryLayer(store);
    const trend = numerics.getLabTrend("cholesterol");
    expect(trend.sampleCount).toBe(2);
    expect(trend.latestValue).toBe(200);
    expect(trend.latestUnit).toBe("mg/dL");
    expect(trend.latestCollectedAt).toBe("2026-02-01T08:00:00.000Z");
    expect(trend.slope).not.toBeNull();
    expect(trend.slope as number).toBeGreaterThan(0); // increasing
  });

  it("slope is null for a single lab result (n<2)", () => {
    store = new HealthDataStore(":memory:");
    store.upsertLabResult({
      biomarker: "hba1c",
      value: 5.7,
      unit: "%",
      collectedAtIso: "2026-01-01T08:00:00.000Z",
    });
    const numerics = new NumericsQueryLayer(store);
    const trend = numerics.getLabTrend("hba1c");
    expect(trend.sampleCount).toBe(1);
    expect(trend.latestValue).toBe(5.7);
    expect(trend.slope).toBeNull();
  });
});

// ── Slope degenerate case (all same timestamp) ────────────────────────

describe("NumericsQueryLayer — slope degenerate (same timestamp)", () => {
  let store: HealthDataStore;

  afterEach(() => {
    store?.close();
  });

  it("slope abstains (value: null) when all observations have the same timestamp", () => {
    // Different sources / values but same tStart → different ids (source differs)
    const sameTimeObs: HealthObservation[] = [
      { metric: "bp", value: 120, unit: "mmHg", tStart: "2026-01-01T00:00:00.000Z", source: "device-a" },
      { metric: "bp", value: 125, unit: "mmHg", tStart: "2026-01-01T00:00:00.000Z", source: "device-b" },
    ];
    store = new HealthDataStore(":memory:");
    store.upsertObservations(sameTimeObs);
    const numerics = new NumericsQueryLayer(store);
    const result = numerics.getMetric(
      { metric: "bp", fromIso: "2026-01-01T00:00:00.000Z", toIso: "2026-12-31T23:59:59.999Z" },
      "slope",
    );
    // Degenerate: denominator = 0 → slope abstains
    expect(result.value).toBeNull();
    expect(result.sampleCount).toBe(2);
  });
});

// ── No eval/codegen/subprocess in src/medical numerics files (sc-4-8) ─

describe("sc-4-8: no eval/codegen/subprocess in numerics code", () => {
  it("numerics.ts and health-store.ts contain no eval/Function/vm/child_process/execa", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const numericsSrc = readFileSync(join(dir, "numerics.ts"), "utf8");
    const storeSrc = readFileSync(join(dir, "health-store.ts"), "utf8");
    const combined = numericsSrc + storeSrc;

    expect(combined).not.toMatch(/\beval\b/);
    expect(combined).not.toMatch(/new Function/);
    expect(combined).not.toMatch(/\bvm\b/);
    expect(combined).not.toMatch(/child_process/);
    expect(combined).not.toMatch(/\bexeca\b/);
  });
});
