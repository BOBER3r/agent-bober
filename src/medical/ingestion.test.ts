import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IngestionNormalizer, StoreObservationSink } from "./ingestion.js";
import { HealthDataStore } from "./health-store.js";
import { AppleHealthAdapter } from "./adapters/apple-health.js";
import type { HealthObservation, LabResult } from "./types.js";

// ── Fixture ────────────────────────────────────────────────────────────

const FIXTURE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <Record type="HKQuantityTypeIdentifierBodyMass" unit="kg" value="70.0" startDate="2026-01-01 06:00:00 +0000" endDate="2026-01-01 06:00:00 +0000" sourceName="Health"/>
  <Record type="HKQuantityTypeIdentifierBodyMass" unit="kg" value="70.5" startDate="2026-01-02 06:00:00 +0000" endDate="2026-01-02 06:00:00 +0000" sourceName="Health"/>
  <Record type="HKQuantityTypeIdentifierHeartRate" unit="count/min" value="62" startDate="2026-01-01 07:00:00 +0000" endDate="2026-01-01 07:00:00 +0000" sourceName="Health"/>
</HealthData>`;

// ── Temp dir setup ─────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-ingest-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ── StoreObservationSink ───────────────────────────────────────────────

describe("StoreObservationSink", () => {
  it("accumulates newRows across multiple writeBatch calls", async () => {
    const store = new HealthDataStore(":memory:");
    try {
      const sink = new StoreObservationSink(store);
      const obs1: HealthObservation[] = [
        { metric: "weight", value: 70, unit: "kg", tStart: "2026-01-01 06:00:00 +0000", source: "apple-health" },
      ];
      const obs2: HealthObservation[] = [
        { metric: "weight", value: 71, unit: "kg", tStart: "2026-01-02 06:00:00 +0000", source: "apple-health" },
      ];

      await sink.writeBatch(obs1, []);
      expect(sink.newRows).toBe(1);

      await sink.writeBatch(obs2, []);
      expect(sink.newRows).toBe(2);
    } finally {
      store.close();
    }
  });

  it("newRows counts only truly new rows (dedup from store)", async () => {
    const store = new HealthDataStore(":memory:");
    try {
      const sink = new StoreObservationSink(store);
      const obs: HealthObservation[] = [
        { metric: "weight", value: 70, unit: "kg", tStart: "2026-01-01 06:00:00 +0000", source: "apple-health" },
      ];

      await sink.writeBatch(obs, []);
      expect(sink.newRows).toBe(1);

      // Re-insert same observation — store uses INSERT OR IGNORE.
      await sink.writeBatch(obs, []);
      expect(sink.newRows).toBe(1); // unchanged
    } finally {
      store.close();
    }
  });

  it("writeBatch handles labs via upsertLabResult", async () => {
    const store = new HealthDataStore(":memory:");
    try {
      const sink = new StoreObservationSink(store);
      const lab: LabResult = {
        biomarker: "glucose",
        value: 5.4,
        unit: "mmol/L",
        collectedAtIso: "2026-01-01T07:00:00.000Z",
      };
      await sink.writeBatch([], [lab]);
      expect(sink.newRows).toBe(1);
    } finally {
      store.close();
    }
  });
});

// ── IngestionNormalizer ────────────────────────────────────────────────

describe("IngestionNormalizer", () => {
  it("register() and importFile() dispatch to a matching adapter (sc-5-7)", async () => {
    const xmlFile = join(tmpDir, "export.xml");
    await writeFile(xmlFile, FIXTURE_XML, "utf-8");

    const store = new HealthDataStore(":memory:");
    try {
      const sink = new StoreObservationSink(store);
      const normalizer = new IngestionNormalizer(sink);
      normalizer.register(new AppleHealthAdapter());

      const result = await normalizer.importFile(xmlFile);
      expect(result.recordsParsed).toBe(3);
      expect(result.newRows).toBe(3);
    } finally {
      store.close();
    }
  });

  it("importFile throws a clear error with the path when no adapter matches (sc-5-7)", async () => {
    const binFile = join(tmpDir, "x.bin");
    await writeFile(binFile, "not-xml", "utf-8");

    const store = new HealthDataStore(":memory:");
    try {
      const sink = new StoreObservationSink(store);
      const normalizer = new IngestionNormalizer(sink);
      // No adapters registered — should throw.

      await expect(normalizer.importFile(binFile)).rejects.toThrow(/x\.bin/);
    } finally {
      store.close();
    }
  });

  it("importFile error message contains the full path (sc-5-7)", async () => {
    const store = new HealthDataStore(":memory:");
    try {
      const sink = new StoreObservationSink(store);
      const normalizer = new IngestionNormalizer(sink);
      normalizer.register(new AppleHealthAdapter()); // only handles .xml

      const binFile = join(tmpDir, "data.csv");
      await writeFile(binFile, "a,b,c", "utf-8");

      await expect(normalizer.importFile(binFile)).rejects.toThrow(
        /data\.csv/,
      );
    } finally {
      store.close();
    }
  });

  it("idempotent re-import: second import adds 0 new rows (sc-5-6)", async () => {
    const xmlFile = join(tmpDir, "export.xml");
    await writeFile(xmlFile, FIXTURE_XML, "utf-8");

    // Use a FILE-backed store (same DB across both imports).
    const dbPath = join(tmpDir, "health.db");
    const store = new HealthDataStore(dbPath);
    try {
      // First import.
      const sink1 = new StoreObservationSink(store);
      const norm1 = new IngestionNormalizer(sink1);
      norm1.register(new AppleHealthAdapter());
      const result1 = await norm1.importFile(xmlFile);
      expect(result1.recordsParsed).toBe(3);
      expect(result1.newRows).toBe(3);

      // Second import of the SAME file.
      const sink2 = new StoreObservationSink(store);
      const norm2 = new IngestionNormalizer(sink2);
      norm2.register(new AppleHealthAdapter());
      const result2 = await norm2.importFile(xmlFile);
      expect(result2.recordsParsed).toBe(3);
      expect(result2.newRows).toBe(0); // all rows already exist
    } finally {
      store.close();
    }
  });
});

// ── CLI wiring (sc-5-8) ────────────────────────────────────────────────

describe("bober medical import CLI wiring (sc-5-8)", () => {
  it("registerMedicalCommand is callable and reports counts on stdout", async () => {
    const xmlFile = join(tmpDir, "export.xml");
    await writeFile(xmlFile, FIXTURE_XML, "utf-8");

    const writes: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    // Silence stderr (error output from chalk) if any.
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const fsUtils = await import("../utils/fs.js");
    const rootSpy = vi
      .spyOn(fsUtils, "findProjectRoot")
      .mockResolvedValue(tmpDir);

    try {
      const { Command } = await import("commander");
      const { registerMedicalCommand } = await import("../cli/commands/medical.js");
      const program = new Command();
      program.exitOverride();
      registerMedicalCommand(program);

      await program.parseAsync(["node", "bober", "medical", "import", xmlFile]);
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      rootSpy.mockRestore();
    }

    const output = writes.join("");
    expect(output).toMatch(/new rows/);
    expect(output).toMatch(/records parsed/);
  });

  it("registerMedicalCommand sets exitCode=1 and writes to stderr on bad file", async () => {
    const stderrWrites: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const fsUtils = await import("../utils/fs.js");
    const rootSpy = vi
      .spyOn(fsUtils, "findProjectRoot")
      .mockResolvedValue(tmpDir);

    const originalExitCode = process.exitCode;
    process.exitCode = 0;

    try {
      const { Command } = await import("commander");
      const { registerMedicalCommand } = await import("../cli/commands/medical.js");
      const program = new Command();
      program.exitOverride();
      registerMedicalCommand(program);

      // A .csv file with no matching adapter.
      const badFile = join(tmpDir, "bad.csv");
      await writeFile(badFile, "a,b", "utf-8");

      await program.parseAsync(["node", "bober", "medical", "import", badFile]);
    } finally {
      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
      rootSpy.mockRestore();
    }

    expect(stderrWrites.join("")).toMatch(/Failed to import/);
    expect(process.exitCode).toBe(1);
    process.exitCode = originalExitCode as number | undefined;
  });
});
