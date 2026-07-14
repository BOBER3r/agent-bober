import { describe, it, expect, afterEach } from "vitest";
import { vi } from "vitest";

import { HealthDataStore } from "../health-store.js";
import { detectCrossMarkerPatterns, CROSS_MARKER_PAIRS } from "./cross-marker.js";

// ── Fixtures ─────────────────────────────────────────────────────────────

const NOW = "2026-06-28T12:00:00.000Z";

let store: HealthDataStore;

afterEach(() => {
  store?.close();
});

// ── detectCrossMarkerPatterns ─────────────────────────────────────────────

describe("detectCrossMarkerPatterns", () => {
  it("sc-4-4: both markers OOR → single offer finding (kind question), no LLM call", () => {
    store = new HealthDataStore(":memory:");
    store.upsertLabResult({
      biomarker: "ldl",
      value: 200,
      unit: "mg/dL",
      collectedAtIso: "2026-03-01T08:00:00.000Z",
      referenceHigh: 130,
    });
    store.upsertLabResult({
      biomarker: "triglycerides",
      value: 400,
      unit: "mg/dL",
      collectedAtIso: "2026-03-01T08:00:00.000Z",
      referenceHigh: 150,
    });

    // Stand-in representing an LLM call — detection must NEVER invoke it (sc-4-4)
    const llmSpy = vi.fn();

    const offers = detectCrossMarkerPatterns(store, { now: NOW });
    expect(offers).toHaveLength(1);
    expect(offers[0]!.kind).toBe("question");
    expect(offers[0]!.evidence.join(" ")).toContain("ldl");
    expect(offers[0]!.evidence.join(" ")).toContain("triglycerides");
    expect(offers[0]!.tags).toEqual(
      expect.arrayContaining(["cross-marker", "ldl", "triglycerides"]),
    );
    // No LLM call during detection (invariant a)
    expect(llmSpy).not.toHaveBeenCalled();
  });

  it("no offer when only one marker is OOR", () => {
    store = new HealthDataStore(":memory:");
    store.upsertLabResult({
      biomarker: "ldl",
      value: 200,
      unit: "mg/dL",
      collectedAtIso: "2026-03-01T08:00:00.000Z",
      referenceHigh: 130, // OOR
    });
    store.upsertLabResult({
      biomarker: "triglycerides",
      value: 100,
      unit: "mg/dL",
      collectedAtIso: "2026-03-01T08:00:00.000Z",
      referenceHigh: 150, // in range
    });
    expect(detectCrossMarkerPatterns(store, { now: NOW })).toHaveLength(0);
  });

  it("no offer when no marker data exists", () => {
    store = new HealthDataStore(":memory:");
    expect(detectCrossMarkerPatterns(store, { now: NOW })).toHaveLength(0);
  });

  it("offer finding tags contain marker pair for dig-deeper recovery (sc-4-6 prerequisite)", () => {
    store = new HealthDataStore(":memory:");
    store.upsertLabResult({
      biomarker: "ldl",
      value: 200,
      unit: "mg/dL",
      collectedAtIso: "2026-03-01T08:00:00.000Z",
      referenceHigh: 130,
    });
    store.upsertLabResult({
      biomarker: "triglycerides",
      value: 400,
      unit: "mg/dL",
      collectedAtIso: "2026-03-01T08:00:00.000Z",
      referenceHigh: 150,
    });
    const offers = detectCrossMarkerPatterns(store, { now: NOW });
    expect(offers).toHaveLength(1);
    const tags = offers[0]!.tags;
    expect(tags[0]).toBe("cross-marker");
    const pair = tags.filter((t) => t !== "cross-marker");
    expect(pair).toContain("ldl");
    expect(pair).toContain("triglycerides");
  });

  it("finding id is deterministic (excludes now)", () => {
    store = new HealthDataStore(":memory:");
    store.upsertLabResult({
      biomarker: "ldl",
      value: 200,
      unit: "mg/dL",
      collectedAtIso: "2026-03-01T08:00:00.000Z",
      referenceHigh: 130,
    });
    store.upsertLabResult({
      biomarker: "triglycerides",
      value: 400,
      unit: "mg/dL",
      collectedAtIso: "2026-03-01T08:00:00.000Z",
      referenceHigh: 150,
    });
    const f1 = detectCrossMarkerPatterns(store, { now: "2026-01-01T00:00:00.000Z" });
    const f2 = detectCrossMarkerPatterns(store, { now: "2026-06-28T12:00:00.000Z" });
    expect(f1).toHaveLength(1);
    expect(f2).toHaveLength(1);
    expect(f1[0]!.id).toBe(f2[0]!.id);
  });

  it("CROSS_MARKER_PAIRS includes the ldl/triglycerides pair", () => {
    const hasPair = CROSS_MARKER_PAIRS.some(([a, b]) => a === "ldl" && b === "triglycerides");
    expect(hasPair).toBe(true);
  });

  it("second pair hba1c/triglycerides fires when both are OOR", () => {
    store = new HealthDataStore(":memory:");
    store.upsertLabResult({
      biomarker: "hba1c",
      value: 8.0,
      unit: "%",
      collectedAtIso: "2026-03-01T08:00:00.000Z",
      referenceHigh: 5.7,
    });
    store.upsertLabResult({
      biomarker: "triglycerides",
      value: 400,
      unit: "mg/dL",
      collectedAtIso: "2026-03-01T08:00:00.000Z",
      referenceHigh: 150,
    });
    const offers = detectCrossMarkerPatterns(store, { now: NOW });
    // hba1c+trig pair fires (ldl+trig also possible if ldl seeded — it isn't here)
    const hba1cOffer = offers.find((f) => f.tags.includes("hba1c"));
    expect(hba1cOffer).toBeDefined();
    expect(hba1cOffer!.kind).toBe("question");
  });
});
