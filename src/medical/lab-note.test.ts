import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deriveLabStatus, writeLabNote, parseLabNote, slugify } from "./lab-note.js";
import type { LabNoteMeta } from "./lab-note.js";
import type { ParsedLabMarker } from "./lab-types.js";

// -- Fixtures ---------------------------------------------------------------

const MARKER_GLUCOSE: ParsedLabMarker = {
  name: "Glucose",
  value: 95,
  unit: "mg/dL",
  referenceLow: 70,
  referenceHigh: 100,
};

const META: LabNoteMeta = {
  panel: "Basic Metabolic Panel",
  collectedAtIso: "2026-01-15T08:30:00.000Z",
  source: "quest-labs",
};

// -- slugify ----------------------------------------------------------------

describe("slugify", () => {
  it("lowercases and replaces non-alphanumeric with hyphens", () => {
    expect(slugify("Basic Metabolic Panel")).toBe("basic-metabolic-panel");
    expect(slugify("HbA1c")).toBe("hba1c");
    expect(slugify("  leading-trailing  ")).toBe("leading-trailing");
  });

  it("collapses multiple separators into a single hyphen", () => {
    expect(slugify("a--b___c")).toBe("a-b-c");
  });
});

// -- deriveLabStatus (sc-2-3) -----------------------------------------------

describe("deriveLabStatus", () => {
  it("returns 'normal' when value is within the reference range", () => {
    expect(deriveLabStatus(95, 70, 100)).toBe("normal");
  });

  it("returns 'low' when value is strictly below ref_low", () => {
    expect(deriveLabStatus(65, 70, 100)).toBe("low");
  });

  it("returns 'high' when value is strictly above ref_high", () => {
    expect(deriveLabStatus(110, 70, 100)).toBe("high");
  });

  it("boundary: value equal to ref_low is 'normal'", () => {
    expect(deriveLabStatus(70, 70, 100)).toBe("normal");
  });

  it("boundary: value equal to ref_high is 'normal'", () => {
    expect(deriveLabStatus(100, 70, 100)).toBe("normal");
  });

  it("returns 'critical' when critical flag is true, regardless of range position", () => {
    // critical below range
    expect(deriveLabStatus(20, 70, 100, true)).toBe("critical");
    // critical within range
    expect(deriveLabStatus(90, 70, 100, true)).toBe("critical");
    // critical above range
    expect(deriveLabStatus(150, 70, 100, true)).toBe("critical");
  });

  it("returns 'normal' when ref bounds are absent and critical is false", () => {
    expect(deriveLabStatus(95)).toBe("normal");
    expect(deriveLabStatus(0, undefined, undefined, false)).toBe("normal");
  });

  it("handles only ref_low set (no upper bound)", () => {
    expect(deriveLabStatus(50, 70, undefined)).toBe("low");
    expect(deriveLabStatus(90, 70, undefined)).toBe("normal");
  });

  it("handles only ref_high set (no lower bound)", () => {
    expect(deriveLabStatus(110, undefined, 100)).toBe("high");
    expect(deriveLabStatus(80, undefined, 100)).toBe("normal");
  });
});

// -- writeLabNote / parseLabNote round-trip (sc-2-2) ------------------------

describe("writeLabNote / parseLabNote", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bober-lab-note-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("sc-2-2: all 10 frontmatter keys are present and round-trip correctly", async () => {
    const notePath = await writeLabNote(tmpDir, MARKER_GLUCOSE, META);
    const raw = await readFile(notePath, "utf-8");

    expect(raw.startsWith("---\n")).toBe(true);

    const fm = parseLabNote(raw);

    expect(fm.marker).toBe("Glucose");
    expect(fm.value).toBe(95);
    expect(fm.unit).toBe("mg/dL");
    expect(fm.ref_low).toBe(70);
    expect(fm.ref_high).toBe(100);
    expect(fm.ref_range).toBe("70-100");
    expect(fm.date).toBe("2026-01-15T08:30:00.000Z");
    expect(fm.status).toBe("normal");
    expect(fm.panel).toBe("Basic Metabolic Panel");
    expect(fm.source).toBe("quest-labs");
  });

  it("note path is deterministic: <vaultDir>/labs/<panel-slug>/<marker-slug>-<date>.md", async () => {
    const notePath = await writeLabNote(tmpDir, MARKER_GLUCOSE, META);
    expect(notePath).toBe(
      join(tmpDir, "labs", "basic-metabolic-panel", "glucose-2026-01-15.md"),
    );
  });

  it("writes 'low' status when value is below ref_low", async () => {
    const lowMarker: ParsedLabMarker = { ...MARKER_GLUCOSE, name: "GlucoseLow", value: 55 };
    const notePath = await writeLabNote(tmpDir, lowMarker, META);
    const raw = await readFile(notePath, "utf-8");
    expect(parseLabNote(raw).status).toBe("low");
  });

  it("writes 'high' status when value is above ref_high", async () => {
    const highMarker: ParsedLabMarker = { ...MARKER_GLUCOSE, name: "GlucoseHigh", value: 130 };
    const notePath = await writeLabNote(tmpDir, highMarker, META);
    const raw = await readFile(notePath, "utf-8");
    expect(parseLabNote(raw).status).toBe("high");
  });

  it("writes 'critical' status when critical flag is set", async () => {
    const critMarker: ParsedLabMarker = {
      ...MARKER_GLUCOSE,
      name: "GlucoseCrit",
      value: 55,
      critical: true,
    };
    const notePath = await writeLabNote(tmpDir, critMarker, META);
    const raw = await readFile(notePath, "utf-8");
    expect(parseLabNote(raw).status).toBe("critical");
  });

  it("round-trips undefined ref bounds as undefined (no ref bounds case)", async () => {
    const noRefMarker: ParsedLabMarker = {
      name: "HbA1c",
      value: 5.7,
      unit: "%",
    };
    const notePath = await writeLabNote(tmpDir, noRefMarker, META);
    const raw = await readFile(notePath, "utf-8");
    const fm = parseLabNote(raw);

    expect(fm.ref_low).toBeUndefined();
    expect(fm.ref_high).toBeUndefined();
    expect(fm.ref_range).toBe("");
    expect(fm.status).toBe("normal");
  });

  it("note file is UTF-8 text starting and ending with --- fences", async () => {
    const notePath = await writeLabNote(tmpDir, MARKER_GLUCOSE, META);
    const raw = await readFile(notePath, "utf-8");
    const lines = raw.split("\n");
    expect(lines[0]).toBe("---");
    // Find the closing fence (after the opening)
    const closingIdx = lines.indexOf("---", 1);
    expect(closingIdx).toBeGreaterThan(0);
  });
});
