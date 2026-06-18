import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeManifestWithProvenance } from "./manifest-write.js";
import type { ManifestProvenance } from "./manifest-write.js";
import { FleetManifestSchema } from "./manifest.js";
import type { FleetManifest } from "./manifest.js";

// ── Fixtures ──────────────────────────────────────────────────────────

const FIXED_TS = "2026-01-15T10:00:00.000Z";
const FIXED_MS = Date.parse(FIXED_TS); // 1736935200000

const SAMPLE_MANIFEST: FleetManifest = {
  rootDir: ".",
  concurrency: 3,
  children: [
    { folder: "api-server", task: "Build a REST API server" },
    { folder: "web-frontend", task: "Build a React frontend" },
  ],
};

const SAMPLE_MANIFEST_B: FleetManifest = {
  rootDir: ".",
  concurrency: 3,
  children: [
    { folder: "worker-service", task: "Build a background worker" },
  ],
};

// ── Tests ─────────────────────────────────────────────────────────────

describe("writeManifestWithProvenance", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bober-manifest-write-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // AC1 — sidecar is created with correct fields
  it("AC1: creates a sidecar .meta.json with correct provenance fields", async () => {
    const outPath = join(tmpDir, "fleet-expand.json");
    const logged: string[] = [];

    await writeManifestWithProvenance({
      outPath,
      manifest: SAMPLE_MANIFEST,
      provenance: {
        command: "fleet expand",
        goal: "Build a full-stack platform",
        critique: false,
        childCount: SAMPLE_MANIFEST.children.length,
      },
      log: (m) => logged.push(m),
      now: () => FIXED_MS,
    });

    const sidecarPath = `${outPath}.meta.json`;
    const rawSidecar = await readFile(sidecarPath, "utf-8");
    const sidecar = JSON.parse(rawSidecar) as ManifestProvenance;

    expect(sidecar.command).toBe("fleet expand");
    expect(sidecar.goal).toBe("Build a full-stack platform");
    expect(sidecar.critique).toBe(false);
    expect(sidecar.childCount).toBe(2);
    expect(sidecar.timestamp).toBe(FIXED_TS);
  });

  // AC1 (fleet expand-deep variant) — critique field reflects --critique
  it("AC1: fleet expand-deep with critique=true records critique correctly", async () => {
    const outPath = join(tmpDir, "fleet-expand-deep.json");
    const logged: string[] = [];

    await writeManifestWithProvenance({
      outPath,
      manifest: SAMPLE_MANIFEST,
      provenance: {
        command: "fleet expand-deep",
        goal: "Build something complex",
        critique: true,
        childCount: SAMPLE_MANIFEST.children.length,
      },
      log: (m) => logged.push(m),
      now: () => FIXED_MS,
    });

    const sidecarPath = `${outPath}.meta.json`;
    const rawSidecar = await readFile(sidecarPath, "utf-8");
    const sidecar = JSON.parse(rawSidecar) as ManifestProvenance;

    expect(sidecar.command).toBe("fleet expand-deep");
    expect(sidecar.critique).toBe(true);
    expect(sidecar.childCount).toBe(2);
    expect(sidecar.timestamp).toBe(FIXED_TS);
  });

  // AC2 — first write: no notice, no .bak
  it("AC2: first write produces no notice and no .bak file", async () => {
    const outPath = join(tmpDir, "fleet-expand.json");
    const logged: string[] = [];

    await writeManifestWithProvenance({
      outPath,
      manifest: SAMPLE_MANIFEST,
      provenance: {
        command: "fleet expand",
        goal: "Build a platform",
        critique: false,
        childCount: SAMPLE_MANIFEST.children.length,
      },
      log: (m) => logged.push(m),
      now: () => FIXED_MS,
    });

    // No notice logged
    expect(logged).toHaveLength(0);

    // No .bak created
    const bakPath = `${outPath}.bak`;
    await expect(access(bakPath)).rejects.toThrow();

    // Manifest written
    const raw = await readFile(outPath, "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  // AC3 — overwrite moves prior bytes to .bak and writes new manifest atomically
  it("AC3: overwrite moves prior manifest bytes to .bak and writes new manifest", async () => {
    const outPath = join(tmpDir, "fleet-expand.json");
    const logged: string[] = [];

    // First write
    await writeManifestWithProvenance({
      outPath,
      manifest: SAMPLE_MANIFEST,
      provenance: {
        command: "fleet expand",
        goal: "First goal",
        critique: false,
        childCount: SAMPLE_MANIFEST.children.length,
      },
      log: (m) => logged.push(m),
      now: () => FIXED_MS,
    });

    const firstBytes = await readFile(outPath, "utf-8");

    // Second write
    const FIXED_MS_LATER = FIXED_MS + 5 * 60 * 1000; // 5 minutes later
    await writeManifestWithProvenance({
      outPath,
      manifest: SAMPLE_MANIFEST_B,
      provenance: {
        command: "fleet expand",
        goal: "Second goal",
        critique: false,
        childCount: SAMPLE_MANIFEST_B.children.length,
      },
      log: (m) => logged.push(m),
      now: () => FIXED_MS_LATER,
    });

    // .bak must contain the FIRST manifest bytes
    const bakPath = `${outPath}.bak`;
    const bakBytes = await readFile(bakPath, "utf-8");
    expect(bakBytes).toBe(firstBytes);

    // outPath must contain the SECOND manifest
    const newBytes = await readFile(outPath, "utf-8");
    const parsed = JSON.parse(newBytes) as FleetManifest;
    expect(parsed.children[0]?.folder).toBe("worker-service");
  });

  // AC4 — informative notice with fixed clock is deterministic and exact
  it("AC4: overwrite notice with prior sidecar is deterministic and contains all expected fields", async () => {
    const outPath = join(tmpDir, "fleet-expand.json");
    const logged: string[] = [];

    // First write at FIXED_MS
    await writeManifestWithProvenance({
      outPath,
      manifest: SAMPLE_MANIFEST,
      provenance: {
        command: "fleet expand",
        goal: "Build a full-stack platform",
        critique: false,
        childCount: 2,
      },
      log: (m) => logged.push(m),
      now: () => FIXED_MS,
    });

    // Second write 90 seconds later (should say "1m ago")
    const FIXED_MS_90S = FIXED_MS + 90 * 1000;
    await writeManifestWithProvenance({
      outPath,
      manifest: SAMPLE_MANIFEST_B,
      provenance: {
        command: "fleet expand-deep",
        goal: "New goal",
        critique: false,
        childCount: 1,
      },
      log: (m) => logged.push(m),
      now: () => FIXED_MS_90S,
    });

    // The notice is the last logged message (first write logged nothing, second logged notice)
    const notice = logged[logged.length - 1];
    expect(notice).toBeDefined();
    expect(notice).toContain("[fleet expand-deep]");
    expect(notice).toContain("Replacing manifest from `fleet expand`");
    expect(notice).toContain('for goal "Build a full-stack platform"');
    expect(notice).toContain("2 children");
    expect(notice).toContain("1m ago");
    expect(notice).toContain("kept as");
    expect(notice).toContain(".bak");
  });

  // AC4 — relative age: "just now" for < 60 seconds
  it("AC4: relative age shows 'just now' when delta < 60 seconds", async () => {
    const outPath = join(tmpDir, "fleet-expand.json");
    const logged: string[] = [];

    await writeManifestWithProvenance({
      outPath,
      manifest: SAMPLE_MANIFEST,
      provenance: { command: "fleet expand", goal: "goal A", critique: false, childCount: 2 },
      log: (m) => logged.push(m),
      now: () => FIXED_MS,
    });

    const FIXED_MS_30S = FIXED_MS + 30 * 1000;
    await writeManifestWithProvenance({
      outPath,
      manifest: SAMPLE_MANIFEST_B,
      provenance: { command: "fleet expand", goal: "goal B", critique: false, childCount: 1 },
      log: (m) => logged.push(m),
      now: () => FIXED_MS_30S,
    });

    const notice = logged[logged.length - 1];
    expect(notice).toContain("just now");
  });

  // AC4 — relative age: hours
  it("AC4: relative age shows 'Nh ago' when delta >= 60 minutes", async () => {
    const outPath = join(tmpDir, "fleet-expand.json");
    const logged: string[] = [];

    await writeManifestWithProvenance({
      outPath,
      manifest: SAMPLE_MANIFEST,
      provenance: { command: "fleet expand", goal: "goal A", critique: false, childCount: 2 },
      log: (m) => logged.push(m),
      now: () => FIXED_MS,
    });

    const FIXED_MS_3H = FIXED_MS + 3 * 60 * 60 * 1000;
    await writeManifestWithProvenance({
      outPath,
      manifest: SAMPLE_MANIFEST_B,
      provenance: { command: "fleet expand", goal: "goal B", critique: false, childCount: 1 },
      log: (m) => logged.push(m),
      now: () => FIXED_MS_3H,
    });

    const notice = logged[logged.length - 1];
    expect(notice).toContain("3h ago");
  });

  // AC4 — relative age: days
  it("AC4: relative age shows 'Nd ago' when delta >= 24 hours", async () => {
    const outPath = join(tmpDir, "fleet-expand.json");
    const logged: string[] = [];

    await writeManifestWithProvenance({
      outPath,
      manifest: SAMPLE_MANIFEST,
      provenance: { command: "fleet expand", goal: "goal A", critique: false, childCount: 2 },
      log: (m) => logged.push(m),
      now: () => FIXED_MS,
    });

    const FIXED_MS_2D = FIXED_MS + 2 * 24 * 60 * 60 * 1000;
    await writeManifestWithProvenance({
      outPath,
      manifest: SAMPLE_MANIFEST_B,
      provenance: { command: "fleet expand", goal: "goal B", critique: false, childCount: 1 },
      log: (m) => logged.push(m),
      now: () => FIXED_MS_2D,
    });

    const notice = logged[logged.length - 1];
    expect(notice).toContain("2d ago");
  });

  // AC5 — missing prior sidecar: does NOT throw, prints generic notice
  it("AC5: missing prior sidecar does not throw and prints generic overwrite notice", async () => {
    const outPath = join(tmpDir, "fleet-expand.json");
    const logged: string[] = [];

    // Write manifest without a sidecar (manually, to simulate legacy state)
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(outPath, JSON.stringify(SAMPLE_MANIFEST, null, 2), { encoding: "utf-8" });
    // No sidecar file — simulates a manifest written before provenance was added

    await expect(
      writeManifestWithProvenance({
        outPath,
        manifest: SAMPLE_MANIFEST_B,
        provenance: {
          command: "fleet expand",
          goal: "New goal",
          critique: false,
          childCount: 1,
        },
        log: (m) => logged.push(m),
        now: () => FIXED_MS,
      }),
    ).resolves.toBeUndefined();

    // Must have logged generic notice
    expect(logged.length).toBeGreaterThan(0);
    const notice = logged[0];
    expect(notice).toContain("[fleet expand]");
    expect(notice).toContain("Overwriting existing manifest at");
    expect(notice).toContain(outPath);
    expect(notice).toContain("kept as");
    expect(notice).toContain(".bak");

    // New sidecar must have been written
    const sidecarPath = `${outPath}.meta.json`;
    const rawSidecar = await readFile(sidecarPath, "utf-8");
    const sidecar = JSON.parse(rawSidecar) as ManifestProvenance;
    expect(sidecar.command).toBe("fleet expand");
  });

  // AC5 — corrupt prior sidecar: does NOT throw, prints generic notice
  it("AC5: corrupt prior sidecar does not throw and prints generic notice + writes new sidecar", async () => {
    const outPath = join(tmpDir, "fleet-expand.json");
    const sidecarPath = `${outPath}.meta.json`;
    const logged: string[] = [];

    // Write manifest + corrupt sidecar
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(outPath, JSON.stringify(SAMPLE_MANIFEST, null, 2), { encoding: "utf-8" });
    await wf(sidecarPath, "not valid json {{{{", { encoding: "utf-8" });

    await expect(
      writeManifestWithProvenance({
        outPath,
        manifest: SAMPLE_MANIFEST_B,
        provenance: {
          command: "fleet expand-deep",
          goal: "Recovery goal",
          critique: false,
          childCount: 1,
        },
        log: (m) => logged.push(m),
        now: () => FIXED_MS,
      }),
    ).resolves.toBeUndefined();

    // Generic notice (no prior info)
    const notice = logged[0];
    expect(notice).toContain("[fleet expand-deep]");
    expect(notice).toContain("Overwriting existing manifest at");

    // New sidecar overwritten with valid data
    const rawNewSidecar = await readFile(sidecarPath, "utf-8");
    const newSidecar = JSON.parse(rawNewSidecar) as ManifestProvenance;
    expect(newSidecar.command).toBe("fleet expand-deep");
    expect(newSidecar.goal).toBe("Recovery goal");
  });

  // AC6 — custom outPath derives .meta.json and .bak, default path untouched
  it("AC6: custom outPath derives .meta.json/.bak and does not touch default fleet-expand.json", async () => {
    const customOut = join(tmpDir, "custom-manifest.json");
    const defaultPath = join(tmpDir, ".bober", "fleet-expand.json");
    const logged: string[] = [];

    await writeManifestWithProvenance({
      outPath: customOut,
      manifest: SAMPLE_MANIFEST,
      provenance: {
        command: "fleet expand",
        goal: "Custom path goal",
        critique: false,
        childCount: 2,
      },
      log: (m) => logged.push(m),
      now: () => FIXED_MS,
    });

    // Custom manifest written
    const raw = await readFile(customOut, "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();

    // Custom sidecar written at <custom>.meta.json
    const customSidecarPath = `${customOut}.meta.json`;
    const rawSidecar = await readFile(customSidecarPath, "utf-8");
    const sidecar = JSON.parse(rawSidecar) as ManifestProvenance;
    expect(sidecar.command).toBe("fleet expand");

    // Default path must NOT exist
    await expect(access(defaultPath)).rejects.toThrow();

    // Custom .bak must NOT exist (first write)
    const customBakPath = `${customOut}.bak`;
    await expect(access(customBakPath)).rejects.toThrow();
  });

  // AC6 — second write to custom path creates <custom>.bak, not <default>.bak
  it("AC6: second write to custom outPath creates <custom>.bak not <default>.bak", async () => {
    const customOut = join(tmpDir, "my-manifest.json");
    const logged: string[] = [];

    // First write
    await writeManifestWithProvenance({
      outPath: customOut,
      manifest: SAMPLE_MANIFEST,
      provenance: { command: "fleet expand", goal: "First", critique: false, childCount: 2 },
      log: (m) => logged.push(m),
      now: () => FIXED_MS,
    });

    // Second write
    await writeManifestWithProvenance({
      outPath: customOut,
      manifest: SAMPLE_MANIFEST_B,
      provenance: { command: "fleet expand", goal: "Second", critique: false, childCount: 1 },
      log: (m) => logged.push(m),
      now: () => FIXED_MS + 60 * 1000,
    });

    // .bak should be at the custom path, not at the default
    const customBakPath = `${customOut}.bak`;
    await expect(access(customBakPath)).resolves.toBeUndefined();

    const defaultBakPath = join(tmpDir, ".bober", "fleet-expand.json.bak");
    await expect(access(defaultBakPath)).rejects.toThrow();
  });

  // AC7 — written manifest passes FleetManifestSchema.safeParse and has NO provenance keys
  it("AC7: written manifest passes FleetManifestSchema.safeParse and has no provenance keys", async () => {
    const outPath = join(tmpDir, "fleet-expand.json");
    const logged: string[] = [];

    await writeManifestWithProvenance({
      outPath,
      manifest: SAMPLE_MANIFEST,
      provenance: {
        command: "fleet expand",
        goal: "Schema check goal",
        critique: false,
        childCount: SAMPLE_MANIFEST.children.length,
      },
      log: (m) => logged.push(m),
      now: () => FIXED_MS,
    });

    const raw = await readFile(outPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;

    // Must pass schema validation
    const result = FleetManifestSchema.safeParse(parsed);
    expect(result.success).toBe(true);

    // Must NOT contain any provenance keys
    const obj = parsed as Record<string, unknown>;
    expect(obj).not.toHaveProperty("command");
    expect(obj).not.toHaveProperty("goal");
    expect(obj).not.toHaveProperty("critique");
    expect(obj).not.toHaveProperty("childCount");
    expect(obj).not.toHaveProperty("timestamp");
  });

  // AC7 — manifest ONLY has the schema keys (rootDir, concurrency, children)
  it("AC7: written manifest contains only rootDir, concurrency, children", async () => {
    const outPath = join(tmpDir, "fleet-expand.json");
    const logged: string[] = [];

    await writeManifestWithProvenance({
      outPath,
      manifest: SAMPLE_MANIFEST,
      provenance: {
        command: "fleet expand",
        goal: "Key check goal",
        critique: false,
        childCount: 2,
      },
      log: (m) => logged.push(m),
      now: () => FIXED_MS,
    });

    const raw = await readFile(outPath, "utf-8");
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    expect(keys).toEqual(["children", "concurrency", "rootDir"]);
  });

  // AC8 — ensureDir: helper creates the output directory if it does not exist
  it("AC8: creates output directory recursively if it does not exist", async () => {
    const outPath = join(tmpDir, "nested", "deep", "fleet-expand.json");
    const logged: string[] = [];

    await expect(
      writeManifestWithProvenance({
        outPath,
        manifest: SAMPLE_MANIFEST,
        provenance: { command: "fleet expand", goal: "Nested path", critique: false, childCount: 2 },
        log: (m) => logged.push(m),
        now: () => FIXED_MS,
      }),
    ).resolves.toBeUndefined();

    const raw = await readFile(outPath, "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});
