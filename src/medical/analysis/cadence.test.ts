import { describe, it, expect, afterEach } from "vitest";

import { HealthDataStore } from "../health-store.js";
import { detectTestGaps, RECOMMENDED_CADENCE_DAYS } from "./cadence.js";

// ── Fixtures ─────────────────────────────────────────────────────────────

const NOW = "2026-06-28T12:00:00.000Z";

let store: HealthDataStore;

afterEach(() => {
  store?.close();
});

// ── detectTestGaps ────────────────────────────────────────────────────────

describe("detectTestGaps", () => {
  it("sc-4-2: flags ldl overdue vs cadence (>365d old)", () => {
    store = new HealthDataStore(":memory:");
    store.upsertLabResult({
      biomarker: "ldl",
      value: 100,
      unit: "mg/dL",
      collectedAtIso: "2024-01-01T08:00:00.000Z", // >365d before NOW
      referenceHigh: 130,
    });
    const findings = detectTestGaps(store, ["ldl"], { now: NOW });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind === "question" || findings[0]!.kind === "watch").toBe(true);
    expect(findings[0]!.title.toLowerCase()).toContain("ldl");
    // sc-4-2: finding names the recommended interval
    expect(findings[0]!.title).toContain(`${RECOMMENDED_CADENCE_DAYS["ldl"]!}`);
  });

  it("sc-4-2: biomarker tested within cadence yields no gap finding", () => {
    store = new HealthDataStore(":memory:");
    store.upsertLabResult({
      biomarker: "ldl",
      value: 100,
      unit: "mg/dL",
      // ~178d before NOW — within the 365d cadence
      collectedAtIso: "2026-01-01T08:00:00.000Z",
      referenceHigh: 130,
    });
    const findings = detectTestGaps(store, ["ldl"], { now: NOW });
    expect(findings).toHaveLength(0);
  });

  it("sc-4-3: biomarker absent from closed cadence table yields no gap finding", () => {
    store = new HealthDataStore(":memory:");
    store.upsertLabResult({
      biomarker: "some_obscure_marker",
      value: 1,
      unit: "x",
      collectedAtIso: "2000-01-01T00:00:00.000Z", // very old
    });
    expect(detectTestGaps(store, ["some_obscure_marker"], { now: NOW })).toHaveLength(0);
  });

  it("yields no finding when no data exists for an in-table biomarker", () => {
    store = new HealthDataStore(":memory:");
    const findings = detectTestGaps(store, ["ldl"], { now: NOW });
    expect(findings).toHaveLength(0);
  });

  it("finding id is deterministic (excludes now)", () => {
    store = new HealthDataStore(":memory:");
    store.upsertLabResult({
      biomarker: "ldl",
      value: 100,
      unit: "mg/dL",
      collectedAtIso: "2024-01-01T08:00:00.000Z",
      referenceHigh: 130,
    });
    const f1 = detectTestGaps(store, ["ldl"], { now: "2026-01-01T00:00:00.000Z" });
    const f2 = detectTestGaps(store, ["ldl"], { now: "2026-06-28T12:00:00.000Z" });
    expect(f1).toHaveLength(1);
    expect(f2).toHaveLength(1);
    expect(f1[0]!.id).toBe(f2[0]!.id);
  });

  it("evidence references the biomarker and cadence interval", () => {
    store = new HealthDataStore(":memory:");
    store.upsertLabResult({
      biomarker: "hba1c",
      value: 6.5,
      unit: "%",
      collectedAtIso: "2025-01-01T08:00:00.000Z", // >180d before NOW
    });
    const findings = detectTestGaps(store, ["hba1c"], { now: NOW });
    expect(findings).toHaveLength(1);
    const evidenceText = findings[0]!.evidence.join(" ");
    expect(evidenceText.toLowerCase()).toContain("hba1c");
    expect(evidenceText).toContain("180"); // cadence days for hba1c
  });

  it("flags hba1c at 180d boundary correctly", () => {
    store = new HealthDataStore(":memory:");
    // Exactly 181 days before NOW → overdue (cadence = 180)
    store.upsertLabResult({
      biomarker: "hba1c",
      value: 6.5,
      unit: "%",
      collectedAtIso: "2025-12-29T12:00:00.000Z",
    });
    const findings = detectTestGaps(store, ["hba1c"], { now: NOW });
    expect(findings).toHaveLength(1);
  });

  it("returns empty findings for an empty biomarkers list", () => {
    store = new HealthDataStore(":memory:");
    expect(detectTestGaps(store, [], { now: NOW })).toHaveLength(0);
  });
});
