import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { glob } from "glob";
import { BoberConfigSchema, PartialBoberConfigSchema } from "../../src/config/schema.js";
import { loadConfig } from "../../src/config/loader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");

/**
 * Templates use `"name": ""` as a placeholder for the user to fill in.
 * The loader handles this via `?? "unnamed"`. For schema-parse tests we
 * substitute a valid name so we test graph-backcompat, not the name placeholder.
 */
function fixTemplateName(raw: unknown): unknown {
  if (
    typeof raw === "object" &&
    raw !== null &&
    "project" in raw
  ) {
    const obj = raw as Record<string, unknown>;
    const project = obj.project as Record<string, unknown> | undefined;
    if (project && (project["name"] === "" || project["name"] === undefined)) {
      return { ...obj, project: { ...project, name: "test-project" } };
    }
  }
  return raw;
}

describe("template configs validate against extended BoberConfigSchema", () => {
  it("brownfield template parses without graph section", async () => {
    const raw = await readFile(
      resolve(repoRoot, "templates/brownfield/bober.config.json"),
      "utf-8",
    );
    const parsed = fixTemplateName(JSON.parse(raw));
    // Use PartialBoberConfigSchema (the same schema path as the real loader)
    const result = PartialBoberConfigSchema.safeParse(parsed);
    expect(result.success, `brownfield failed: ${JSON.stringify(result.error?.issues)}`).toBe(true);
    // Also verify graph field is absent and accepted by BoberConfigSchema when merged with defaults
    expect(result.data?.graph).toBeUndefined();
  });

  it("every preset template parses without graph section", async () => {
    const presets = await glob("templates/presets/*/bober.config.json", { cwd: repoRoot });
    expect(presets.length).toBeGreaterThan(0);
    for (const rel of presets) {
      const raw = await readFile(resolve(repoRoot, rel), "utf-8");
      const parsed = fixTemplateName(JSON.parse(raw));
      const result = PartialBoberConfigSchema.safeParse(parsed);
      expect(
        result.success,
        `${rel} failed: ${JSON.stringify(result.error?.issues)}`,
      ).toBe(true);
      // Verify the graph field is absent (no accidental injection)
      expect(result.data?.graph).toBeUndefined();
    }
  });

  it("BoberConfigSchema accepts graph section when provided", () => {
    // Verify the graph field is truly optional and accepted when present
    const minimalWithGraph = {
      project: { name: "test", mode: "brownfield" },
      planner: {},
      generator: {},
      evaluator: { strategies: [] },
      sprint: {},
      pipeline: {},
      commands: {},
      graph: {
        enabled: true,
        autoSync: false,
        languageTier: "extended",
      },
    };
    const result = BoberConfigSchema.safeParse(minimalWithGraph);
    expect(result.success, `graph section parse failed: ${JSON.stringify(result.error?.issues)}`).toBe(true);
    if (result.success) {
      expect(result.data.graph?.enabled).toBe(true);
      expect(result.data.graph?.autoSync).toBe(false);
      expect(result.data.graph?.languageTier).toBe("extended");
      // Verify defaults filled in
      expect(result.data.graph?.syncTimeoutMs).toBe(2000);
      expect(result.data.graph?.queryTimeoutMs).toBe(5000);
      expect(result.data.graph?.debounceMs).toBe(750);
      expect(result.data.graph?.hookQueueMax).toBe(50);
      expect(result.data.graph?.maxEngineRssMb).toBe(512);
    }
  });

  it("BoberConfigSchema accepts no graph section (backcompat invariant)", () => {
    const minimalNoGraph = {
      project: { name: "test", mode: "brownfield" },
      planner: {},
      generator: {},
      evaluator: { strategies: [] },
      sprint: {},
      pipeline: {},
      commands: {},
    };
    const result = BoberConfigSchema.safeParse(minimalNoGraph);
    expect(result.success, `no-graph parse failed: ${JSON.stringify(result.error?.issues)}`).toBe(true);
    if (result.success) {
      expect(result.data.graph).toBeUndefined();
    }
  });
});

// ── Sprint 14 backward-compat invariant (s14-c7) ─────────────────────────

describe("Sprint 14 — backward-compat: existing bober.config.json parses with new pipeline defaults (s14-c7)", () => {
  it("repo's bober.config.json (no pipeline.mode etc.) parses successfully via BoberConfigSchema", async () => {
    // Read the actual on-disk bober.config.json from the repo root.
    // This file has pipeline.maxIterations, requireApproval, contextReset, researchPhase, architectPhase
    // but NO mode/checkpointMechanism/checkpointOverrides/approvalTimeoutMs/prPollMs.
    const raw = await readFile(resolve(repoRoot, "bober.config.json"), "utf-8");
    const parsed = JSON.parse(raw) as unknown;

    // Must parse successfully — all new fields have defaults.
    const result = BoberConfigSchema.safeParse(parsed);
    expect(
      result.success,
      `bober.config.json parse failed: ${JSON.stringify(result.error?.issues)}`,
    ).toBe(true);

    if (result.success) {
      // New fields should have defaults applied.
      expect(result.data.pipeline.mode).toBe("autopilot");
      expect(result.data.pipeline.checkpointMechanism).toBeUndefined();
      expect(result.data.pipeline.checkpointOverrides).toEqual({});
      expect(result.data.pipeline.approvalTimeoutMs).toBe(86_400_000);
      expect(result.data.pipeline.prPollMs).toBe(30_000);
      // Existing fields should be preserved.
      expect(result.data.pipeline.maxIterations).toBe(40);
      expect(result.data.pipeline.requireApproval).toBe(false);
    }
  });

  it("loadConfig on repo's bober.config.json returns autopilot mode with noop defaults", async () => {
    // Full load path: partial parse → deep-merge defaults → full schema validation.
    const config = await loadConfig(repoRoot);

    // Backward-compat: existing pipeline fields are preserved.
    expect(config.pipeline.maxIterations).toBe(40);
    expect(config.pipeline.requireApproval).toBe(false);
    expect(config.pipeline.contextReset).toBe("always");

    // Sprint 14 defaults: mode=autopilot, checkpointMechanism=undefined → noop at runtime.
    expect(config.pipeline.mode).toBe("autopilot");
    expect(config.pipeline.checkpointMechanism).toBeUndefined();
    expect(config.pipeline.checkpointOverrides).toEqual({});
    expect(config.pipeline.approvalTimeoutMs).toBe(86_400_000);
    expect(config.pipeline.prPollMs).toBe(30_000);
    // maxCheckpointIterations should be present (Sprint 12 default = 3).
    expect(config.pipeline.maxCheckpointIterations).toBe(3);
  });

  it("BoberConfigSchema accepts pipeline:{} with all Sprint 14 fields defaulted", () => {
    // Minimal pipeline:{}  — same shape as the graph-schema backcompat test above.
    const minimalPipeline = {
      project: { name: "test", mode: "brownfield" },
      planner: {},
      generator: {},
      evaluator: { strategies: [] },
      sprint: {},
      pipeline: {},
      commands: {},
    };
    const result = BoberConfigSchema.safeParse(minimalPipeline);
    expect(result.success, `pipeline:{} parse failed: ${JSON.stringify(result.error?.issues)}`).toBe(true);
    if (result.success) {
      // All Sprint 14 fields should be defaulted.
      expect(result.data.pipeline.mode).toBe("autopilot");
      expect(result.data.pipeline.checkpointMechanism).toBeUndefined();
      expect(result.data.pipeline.checkpointOverrides).toEqual({});
      expect(result.data.pipeline.approvalTimeoutMs).toBe(86_400_000);
      expect(result.data.pipeline.prPollMs).toBe(30_000);
    }
  });
});
