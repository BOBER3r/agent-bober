import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { vi } from "vitest";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HealthDataStore } from "../health-store.js";
import { ensureDir } from "../../utils/fs.js";
import type { BoberConfig } from "../../config/schema.js";
import { runProactiveReview, digDeeper } from "./review-pass.js";
import { findingId } from "./finding.js";
import { parseFrontmatter } from "../../vault/frontmatter.js";

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

  it("sc-4-5: one offline pass emits trend + gap + cross-marker-offer findings", async () => {
    // Seed ldl OOR and >365d old → trend finding + gap finding
    // Seed triglycerides OOR → trend finding
    // ldl + triglycerides both OOR → cross-marker offer finding
    const store = new HealthDataStore(":memory:");
    store.upsertLabResult({
      biomarker: "ldl",
      value: 200,
      unit: "mg/dL",
      // 2024-01-01 is >365d before NOW (2026-06-28) → gap finding fires
      collectedAtIso: "2024-01-01T08:00:00.000Z",
      referenceHigh: 130,
    });
    store.upsertLabResult({
      biomarker: "triglycerides",
      value: 400,
      unit: "mg/dL",
      collectedAtIso: "2026-03-01T08:00:00.000Z",
      referenceHigh: 150,
    });

    const result = await runProactiveReview(tmpRoot, MINIMAL_CONFIG, {
      now: NOW,
      store,
    });

    store.close();

    // Expect: ldl trend + ldl gap + triglycerides trend + ldl-triglycerides offer = 4
    // (triglycerides not in cadence table → no gap finding for it)
    expect(result.findingsWritten).toBeGreaterThanOrEqual(3);

    // Verify at least one kind="question" cross-marker offer is among the written notes
    const vaultDir = join(tmpRoot, ".bober", "medical", "vault");
    const findingFiles = await readdir(join(vaultDir, "findings"));
    const noteContents = await Promise.all(
      findingFiles
        .filter((f) => f.endsWith(".md") && f !== "dashboard.md")
        .map(async (f) => readFile(join(vaultDir, "findings", f), "utf-8")),
    );
    const crossMarkerNotes = noteContents.filter((content) => {
      const { frontmatter } = parseFrontmatter(content);
      const tags = (frontmatter["tags"] as string[] | undefined) ?? [];
      return (
        frontmatter["kind"] === "question" && tags.includes("cross-marker")
      );
    });
    expect(crossMarkerNotes.length).toBeGreaterThanOrEqual(1);
  });

  it("sc-4-6: dig-deeper delegates to generateRecommendation with the marker pair", async () => {
    // 1. Seed store so cross-marker offer is written to disk
    const store = new HealthDataStore(":memory:");
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

    await runProactiveReview(tmpRoot, MINIMAL_CONFIG, { now: NOW, store });
    store.close();

    // 2. Compute the offer finding id (deterministic: domain|biomarker|ruleKey)
    const offerId = findingId("medical", "ldl", "cross-marker-ldl-triglycerides");

    // 3. Inject a spy in place of generateRecommendation
    const genSpy = vi.fn(async () => ({
      kind: "accepted" as const,
      findingPath: "/spy-output/finding.md",
    }));

    const outcome = await digDeeper(tmpRoot, MINIMAL_CONFIG, offerId, { now: NOW }, {
      generateRecommendation: genSpy,
    });

    // 4. Assert the spy was called exactly once with the marker pair in the question
    expect(genSpy).toHaveBeenCalledTimes(1);
    const callArgs = genSpy.mock.calls[0]!;
    const callOpts = callArgs[2] as { question: string; now: string };
    expect(callOpts.question).toContain("ldl");
    expect(callOpts.question).toContain("triglycerides");
    expect(outcome.kind).toBe("accepted");
  });
});
