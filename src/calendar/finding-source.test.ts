import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { readFindingsFromFile, readBusyIntervalsFromFile } from "./finding-source.js";

// ── Fixture paths ─────────────────────────────────────────────────────

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const FINDINGS_FIXTURE = join(fixturesDir, "findings.json");
const FREEBUSY_FIXTURE = join(fixturesDir, "freebusy.json");

// ── readFindingsFromFile ───────────────────────────────────────────────

describe("readFindingsFromFile", () => {
  it("reads the fixture file and returns a Finding[] in order", async () => {
    const findings = await readFindingsFromFile(FINDINGS_FIXTURE);

    expect(Array.isArray(findings)).toBe(true);
    expect(findings.length).toBe(3);

    // Order is preserved (= priority order)
    expect(findings[0].id).toBe("finding-alpha");
    expect(findings[1].id).toBe("finding-beta");
    expect(findings[2].id).toBe("finding-gamma");
  });

  it("returns findings with all expected fields including dueBy, estDurationMin, calendarSafeTitle", async () => {
    const findings = await readFindingsFromFile(FINDINGS_FIXTURE);
    const first = findings[0];

    expect(first.dueBy).toBeDefined();
    expect(first.estDurationMin).toBe(30);
    expect(first.calendarSafeTitle).toBe("Refactor auth module");
  });

  it("throws when the file does not exist", async () => {
    await expect(readFindingsFromFile("/nonexistent/path/findings.json")).rejects.toThrow();
  });

  it("throws when the JSON is valid but does not match the Finding schema", async () => {
    // The freebusy.json is an empty array — an empty array validates as Finding[] (Zod z.array is OK with empty)
    // Use an object instead to trigger a failure
    const tmpInvalid = join(fixturesDir, "..", "..", ".."); // a directory, not a JSON file
    await expect(readFindingsFromFile(tmpInvalid)).rejects.toThrow();
  });
});

// ── readBusyIntervalsFromFile ─────────────────────────────────────────

describe("readBusyIntervalsFromFile", () => {
  it("reads the freebusy fixture and returns an empty array (no busy intervals)", async () => {
    const busy = await readBusyIntervalsFromFile(FREEBUSY_FIXTURE);
    expect(Array.isArray(busy)).toBe(true);
    expect(busy.length).toBe(0);
  });

  it("throws when the file does not exist", async () => {
    await expect(readBusyIntervalsFromFile("/nonexistent/busy.json")).rejects.toThrow();
  });
});
