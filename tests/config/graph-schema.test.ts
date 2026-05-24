import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { glob } from "glob";
import { BoberConfigSchema, PartialBoberConfigSchema } from "../../src/config/schema.js";

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
