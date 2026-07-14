import { describe, it, expect, afterEach } from "vitest";

import { HealthDataStore } from "../health-store.js";
import { analyzeTrends } from "./trends.js";

// ── Fixtures ─────────────────────────────────────────────────────────────

const NOW = "2026-06-28T12:00:00.000Z";

let store: HealthDataStore;

afterEach(() => {
  store?.close();
});

// ── analyzeTrends ─────────────────────────────────────────────────────────

describe("analyzeTrends", () => {
  it("sc-1-2: returns a finding with domain 'medical' when ldl latest value exceeds referenceHigh", () => {
    store = new HealthDataStore(":memory:");
    store.upsertLabResult({
      biomarker: "ldl",
      value: 95,
      unit: "mg/dL",
      collectedAtIso: "2026-01-01T08:00:00.000Z",
      referenceHigh: 130,
    });
    store.upsertLabResult({
      biomarker: "ldl",
      value: 160,
      unit: "mg/dL",
      collectedAtIso: "2026-03-01T08:00:00.000Z",
      referenceHigh: 130,
    });

    const findings = analyzeTrends(store, ["ldl"], { now: NOW });

    expect(findings.length).toBeGreaterThanOrEqual(1);
    const f = findings[0]!;
    expect(f.domain).toBe("medical");
    expect(f.kind === "watch" || f.kind === "risk").toBe(true);
    expect(f.title.toLowerCase()).toContain("ldl");
  });

  it("sc-1-2: finding has 'ldl' present in its title", () => {
    store = new HealthDataStore(":memory:");
    store.upsertLabResult({
      biomarker: "ldl",
      value: 160,
      unit: "mg/dL",
      collectedAtIso: "2026-03-01T08:00:00.000Z",
      referenceHigh: 130,
    });

    const findings = analyzeTrends(store, ["ldl"], { now: NOW });
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0]!.title.toLowerCase()).toContain("ldl");
  });

  it("sc-1-3: flat in-range biomarker series produces zero trend findings", () => {
    store = new HealthDataStore(":memory:");
    // Same value at different timestamps — slope = 0, in range — no finding
    store.upsertLabResult({
      biomarker: "glucose",
      value: 90,
      unit: "mg/dL",
      collectedAtIso: "2026-01-01T08:00:00.000Z",
      referenceLow: 70,
      referenceHigh: 100,
    });
    store.upsertLabResult({
      biomarker: "glucose",
      value: 90,
      unit: "mg/dL",
      collectedAtIso: "2026-02-01T08:00:00.000Z",
      referenceLow: 70,
      referenceHigh: 100,
    });

    const findings = analyzeTrends(store, ["glucose"], { now: NOW });
    expect(findings).toHaveLength(0);
  });

  it("sc-1-3: strictly rising series crossing referenceHigh produces exactly one finding", () => {
    store = new HealthDataStore(":memory:");
    store.upsertLabResult({
      biomarker: "triglycerides",
      value: 100,
      unit: "mg/dL",
      collectedAtIso: "2026-01-01T08:00:00.000Z",
      referenceHigh: 150,
    });
    store.upsertLabResult({
      biomarker: "triglycerides",
      value: 125,
      unit: "mg/dL",
      collectedAtIso: "2026-02-01T08:00:00.000Z",
      referenceHigh: 150,
    });
    store.upsertLabResult({
      biomarker: "triglycerides",
      value: 180,
      unit: "mg/dL",
      collectedAtIso: "2026-03-01T08:00:00.000Z",
      referenceHigh: 150,
    });

    const findings = analyzeTrends(store, ["triglycerides"], { now: NOW });
    expect(findings).toHaveLength(1);
  });

  it("abstains (empty findings) when sampleCount is 0 for a biomarker", () => {
    store = new HealthDataStore(":memory:");
    const findings = analyzeTrends(store, ["nonexistent-biomarker"], { now: NOW });
    expect(findings).toHaveLength(0);
  });

  it("is deterministic — same input produces identical output", () => {
    store = new HealthDataStore(":memory:");
    store.upsertLabResult({
      biomarker: "ldl",
      value: 160,
      unit: "mg/dL",
      collectedAtIso: "2026-03-01T08:00:00.000Z",
      referenceHigh: 130,
    });

    const findings1 = analyzeTrends(store, ["ldl"], { now: NOW });
    const findings2 = analyzeTrends(store, ["ldl"], { now: NOW });

    expect(findings1).toEqual(findings2);
  });

  it("emits kind 'risk' (severity 4) when latestValue is >20% above referenceHigh", () => {
    store = new HealthDataStore(":memory:");
    // 200 is >20% above 130 (distance = 70, 70/130 ≈ 53.8%)
    store.upsertLabResult({
      biomarker: "ldl",
      value: 200,
      unit: "mg/dL",
      collectedAtIso: "2026-03-01T08:00:00.000Z",
      referenceHigh: 130,
    });

    const findings = analyzeTrends(store, ["ldl"], { now: NOW });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe("risk");
    expect(findings[0]!.severity).toBe(4);
  });

  it("emits kind 'watch' (severity 3) when latestValue is ≤20% above referenceHigh", () => {
    store = new HealthDataStore(":memory:");
    // 145 is ~11.5% above 130 (≤20%)
    store.upsertLabResult({
      biomarker: "ldl",
      value: 145,
      unit: "mg/dL",
      collectedAtIso: "2026-03-01T08:00:00.000Z",
      referenceHigh: 130,
    });

    const findings = analyzeTrends(store, ["ldl"], { now: NOW });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe("watch");
    expect(findings[0]!.severity).toBe(3);
  });

  it("returns empty findings for an empty biomarkers list", () => {
    store = new HealthDataStore(":memory:");
    const findings = analyzeTrends(store, [], { now: NOW });
    expect(findings).toHaveLength(0);
  });

  it("finding ids are deterministic and exclude now", () => {
    store = new HealthDataStore(":memory:");
    store.upsertLabResult({
      biomarker: "ldl",
      value: 160,
      unit: "mg/dL",
      collectedAtIso: "2026-03-01T08:00:00.000Z",
      referenceHigh: 130,
    });

    const findings1 = analyzeTrends(store, ["ldl"], { now: "2026-01-01T00:00:00.000Z" });
    const findings2 = analyzeTrends(store, ["ldl"], { now: "2026-06-28T12:00:00.000Z" });

    // Different now values must NOT produce different ids
    expect(findings1[0]!.id).toBe(findings2[0]!.id);
  });
});
