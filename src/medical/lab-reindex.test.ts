import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HealthDataStore } from "./health-store.js";
import { writeLabNote } from "./lab-note.js";
import { reindexLabNotes } from "./lab-reindex.js";
import type { LabNoteMeta } from "./lab-note.js";
import type { ParsedLabMarker } from "./lab-types.js";

// -- Fixtures ---------------------------------------------------------------

const META_JAN: LabNoteMeta = {
  panel: "Basic Metabolic Panel",
  collectedAtIso: "2026-01-15T08:30:00.000Z",
  source: "quest-labs",
};

const META_FEB: LabNoteMeta = {
  panel: "Basic Metabolic Panel",
  collectedAtIso: "2026-02-10T09:00:00.000Z",
  source: "quest-labs",
};

const MARKER_GLUCOSE_JAN: ParsedLabMarker = {
  name: "Glucose",
  value: 95,
  unit: "mg/dL",
  referenceLow: 70,
  referenceHigh: 100,
};

const MARKER_GLUCOSE_FEB: ParsedLabMarker = {
  name: "Glucose",
  value: 102,
  unit: "mg/dL",
  referenceLow: 70,
  referenceHigh: 100,
};

const MARKER_HBAC1: ParsedLabMarker = {
  name: "HbA1c",
  value: 5.7,
  unit: "%",
  referenceLow: 4.0,
  referenceHigh: 5.6,
};

// -- Tests ------------------------------------------------------------------

describe("reindexLabNotes", () => {
  let tmpDir: string;
  let store: HealthDataStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bober-lab-reindex-"));
    store = new HealthDataStore(":memory:");

    // Write three lab notes to the vault:
    // - Glucose Jan, Glucose Feb (same marker, different dates)
    // - HbA1c Jan (different marker)
    await writeLabNote(tmpDir, MARKER_GLUCOSE_JAN, META_JAN);
    await writeLabNote(tmpDir, MARKER_GLUCOSE_FEB, META_FEB);
    await writeLabNote(tmpDir, MARKER_HBAC1, META_JAN);
  });

  afterEach(async () => {
    store.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("sc-2-4: upserts all notes; getLabSeries returns matching value, unit, collectedAtIso", async () => {
    const newRows = await reindexLabNotes(tmpDir, store);

    // 3 notes written, all should be new
    expect(newRows).toBe(3);

    // Glucose series: 2 results, ASC order
    const glucoseSeries = store.getLabSeries("Glucose");
    expect(glucoseSeries).toHaveLength(2);
    expect(glucoseSeries[0].value).toBe(95);
    expect(glucoseSeries[0].unit).toBe("mg/dL");
    expect(glucoseSeries[0].collectedAtIso).toBe("2026-01-15T08:30:00.000Z");
    expect(glucoseSeries[1].value).toBe(102);
    expect(glucoseSeries[1].unit).toBe("mg/dL");
    expect(glucoseSeries[1].collectedAtIso).toBe("2026-02-10T09:00:00.000Z");

    // HbA1c series: 1 result
    const hba1cSeries = store.getLabSeries("HbA1c");
    expect(hba1cSeries).toHaveLength(1);
    expect(hba1cSeries[0].value).toBe(5.7);
    expect(hba1cSeries[0].unit).toBe("%");
    expect(hba1cSeries[0].collectedAtIso).toBe("2026-01-15T08:30:00.000Z");
  });

  it("sc-2-4: upserts preserve reference range fields", async () => {
    await reindexLabNotes(tmpDir, store);

    const glucoseSeries = store.getLabSeries("Glucose");
    expect(glucoseSeries[0].referenceLow).toBe(70);
    expect(glucoseSeries[0].referenceHigh).toBe(100);
  });

  it("sc-2-5: second reindexLabNotes run reports 0 new rows (dedup via labResultId)", async () => {
    const firstRunNewRows = await reindexLabNotes(tmpDir, store);
    expect(firstRunNewRows).toBe(3);

    // Second run over identical vault — all three notes are duplicates
    const secondRunNewRows = await reindexLabNotes(tmpDir, store);
    expect(secondRunNewRows).toBe(0);
  });

  it("sc-2-5: getLabSeries length is unchanged after the second reindex run", async () => {
    await reindexLabNotes(tmpDir, store);

    const glucoseLengthBefore = store.getLabSeries("Glucose").length;
    const hba1cLengthBefore = store.getLabSeries("HbA1c").length;

    await reindexLabNotes(tmpDir, store); // second run

    expect(store.getLabSeries("Glucose")).toHaveLength(glucoseLengthBefore);
    expect(store.getLabSeries("HbA1c")).toHaveLength(hba1cLengthBefore);
  });

  it("returns 0 when the labs directory contains no notes", async () => {
    // Fresh vault with no notes written
    const emptyDir = await mkdtemp(join(tmpdir(), "bober-empty-vault-"));
    try {
      const result = await reindexLabNotes(emptyDir, store);
      expect(result).toBe(0);
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });
});
