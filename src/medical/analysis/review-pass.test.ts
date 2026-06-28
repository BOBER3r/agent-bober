import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HealthDataStore } from "../health-store.js";
import { ensureDir } from "../../utils/fs.js";
import type { BoberConfig } from "../../config/schema.js";
import { runProactiveReview } from "./review-pass.js";

// ── Fixtures ─────────────────────────────────────────────────────────────

const NOW = "2026-06-28T12:00:00.000Z";

// Minimal BoberConfig for tests — only config.medical?.vaultDir is read by review-pass.
const MINIMAL_CONFIG = {} as BoberConfig;

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "bober-review-pass-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Seed a file-backed HealthDataStore in tmpRoot and close it.
 * Returns the db path for reference.
 */
async function seedFileStore(): Promise<string> {
  const medicalDir = join(tmpRoot, ".bober", "medical");
  await ensureDir(medicalDir);
  const dbPath = join(medicalDir, "health.db");
  const s = new HealthDataStore(dbPath);
  s.upsertLabResult({
    biomarker: "ldl",
    value: 160,
    unit: "mg/dL",
    collectedAtIso: "2026-01-01T08:00:00.000Z",
    referenceHigh: 130,
  });
  s.close();
  return dbPath;
}

// ── runProactiveReview ────────────────────────────────────────────────────

describe("runProactiveReview", () => {
  it("returns findingsWritten, dashboardPath, findingPaths", async () => {
    const store = new HealthDataStore(":memory:");
    store.upsertLabResult({
      biomarker: "ldl",
      value: 160,
      unit: "mg/dL",
      collectedAtIso: "2026-01-01T08:00:00.000Z",
      referenceHigh: 130,
    });

    const result = await runProactiveReview(tmpRoot, MINIMAL_CONFIG, {
      now: NOW,
      biomarkers: ["ldl"],
      store,
    });

    store.close();

    expect(result.findingsWritten).toBeGreaterThanOrEqual(1);
    expect(result.dashboardPath).toContain("dashboard.md");
    expect(result.findingPaths.length).toBe(result.findingsWritten);
  });

  it("writes findings into the default vault dir when config.medical is absent", async () => {
    const store = new HealthDataStore(":memory:");
    store.upsertLabResult({
      biomarker: "ldl",
      value: 160,
      unit: "mg/dL",
      collectedAtIso: "2026-01-01T08:00:00.000Z",
      referenceHigh: 130,
    });

    const result = await runProactiveReview(tmpRoot, MINIMAL_CONFIG, {
      now: NOW,
      biomarkers: ["ldl"],
      store,
    });

    store.close();

    const defaultVaultDir = join(tmpRoot, ".bober", "medical", "vault");
    expect(result.dashboardPath.startsWith(defaultVaultDir)).toBe(true);
  });

  it("uses config.medical.vaultDir when provided", async () => {
    const customVault = join(tmpRoot, "custom-vault");
    const config = { medical: { vaultDir: customVault } } as BoberConfig;

    const store = new HealthDataStore(":memory:");
    store.upsertLabResult({
      biomarker: "ldl",
      value: 160,
      unit: "mg/dL",
      collectedAtIso: "2026-01-01T08:00:00.000Z",
      referenceHigh: 130,
    });

    const result = await runProactiveReview(tmpRoot, config, {
      now: NOW,
      biomarkers: ["ldl"],
      store,
    });

    store.close();

    expect(result.dashboardPath.startsWith(customVault)).toBe(true);
  });

  it("returns findingsWritten = 0 when no biomarker data is available", async () => {
    const store = new HealthDataStore(":memory:");

    const result = await runProactiveReview(tmpRoot, MINIMAL_CONFIG, {
      now: NOW,
      biomarkers: ["no-such-biomarker"],
      store,
    });

    store.close();

    expect(result.findingsWritten).toBe(0);
    // Dashboard is always written (sc-1-5)
    expect(result.dashboardPath).toContain("dashboard.md");
  });

  it("sc-1-4: calling twice with same now against same seeded store produces identical file count", async () => {
    await seedFileStore();

    // First call: opens the file-backed store, writes findings + dashboard, closes
    const result1 = await runProactiveReview(tmpRoot, MINIMAL_CONFIG, {
      now: NOW,
      biomarkers: ["ldl"],
    });

    const vaultDir = join(tmpRoot, ".bober", "medical", "vault");
    const files1 = await readdir(join(vaultDir, "findings"));

    // Second call: same args → deterministic ids → overwrites same files
    const result2 = await runProactiveReview(tmpRoot, MINIMAL_CONFIG, {
      now: NOW,
      biomarkers: ["ldl"],
    });

    const files2 = await readdir(join(vaultDir, "findings"));

    expect(files1.length).toBe(files2.length);
    expect(result1.findingsWritten).toBe(result2.findingsWritten);
  });

  it("sc-1-4: finding paths contain deterministic ids (same on second run)", async () => {
    await seedFileStore();

    const result1 = await runProactiveReview(tmpRoot, MINIMAL_CONFIG, {
      now: NOW,
      biomarkers: ["ldl"],
    });

    const result2 = await runProactiveReview(tmpRoot, MINIMAL_CONFIG, {
      now: NOW,
      biomarkers: ["ldl"],
    });

    // Sorted paths must match exactly
    expect(result1.findingPaths.sort()).toEqual(result2.findingPaths.sort());
  });
});
