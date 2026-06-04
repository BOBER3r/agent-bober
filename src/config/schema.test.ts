import { describe, it, expect } from "vitest";
import {
  PipelineSectionSchema,
  EvaluatorSectionSchema,
  ArchitectSectionSchema,
  BoberConfigSchema,
  HistorySectionSchema,
} from "./schema.js";

describe("EvaluatorSectionSchema.panel", () => {
  it("defaults panel to disabled/empty/4 when omitted", () => {
    const parsed = EvaluatorSectionSchema.parse({ strategies: [] });
    expect(parsed.panel).toEqual({ enabled: false, lenses: [], maxConcurrent: 4 });
  });

  it("rejects maxConcurrent < 1", () => {
    expect(() =>
      EvaluatorSectionSchema.parse({ strategies: [], panel: { maxConcurrent: 0 } }),
    ).toThrow();
  });

  it("accepts a fully-specified enabled panel", () => {
    const parsed = EvaluatorSectionSchema.parse({
      strategies: [],
      panel: { enabled: true, lenses: ["correctness", "security"], maxConcurrent: 2 },
    });
    expect(parsed.panel.enabled).toBe(true);
    expect(parsed.panel.lenses).toEqual(["correctness", "security"]);
    expect(parsed.panel.maxConcurrent).toBe(2);
  });

  it("parses a config that omits the panel field entirely — panel resolves to the default", () => {
    // This verifies C1: a config without panel still parses successfully
    const parsed = EvaluatorSectionSchema.parse({ strategies: [] });
    expect(parsed.panel.enabled).toBe(false);
    expect(parsed.panel.lenses).toEqual([]);
    expect(parsed.panel.maxConcurrent).toBe(4);
  });
});

describe("ArchitectSectionSchema.panel (C3)", () => {
  it("defaults panel to disabled/empty/4 when section omitted (parse empty object)", () => {
    const parsed = ArchitectSectionSchema.parse({});
    expect(parsed.panel).toEqual({ enabled: false, lenses: [], maxConcurrent: 4 });
  });

  it("rejects maxConcurrent < 1", () => {
    expect(() =>
      ArchitectSectionSchema.parse({ panel: { maxConcurrent: 0 } }),
    ).toThrow();
  });

  it("accepts a fully-specified enabled panel", () => {
    const parsed = ArchitectSectionSchema.parse({
      panel: { enabled: true, lenses: ["scalability", "security"], maxConcurrent: 2 },
    });
    expect(parsed.panel.enabled).toBe(true);
    expect(parsed.panel.lenses).toEqual(["scalability", "security"]);
    expect(parsed.panel.maxConcurrent).toBe(2);
  });

  it("parses when panel field is omitted — resolves to defaults", () => {
    const parsed = ArchitectSectionSchema.parse({});
    expect(parsed.panel.enabled).toBe(false);
    expect(parsed.panel.lenses).toEqual([]);
    expect(parsed.panel.maxConcurrent).toBe(4);
  });
});

describe("BoberConfigSchema — architect is optional (C3)", () => {
  it("parses a valid config that omits the architect section entirely", () => {
    // Minimal valid config — architect is optional so its absence is fine
    const result = BoberConfigSchema.safeParse({
      project: { name: "test-project", mode: "greenfield" },
      planner: {},
      generator: {},
      evaluator: { strategies: [] },
      sprint: {},
      pipeline: {},
      commands: {},
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.architect).toBeUndefined();
    }
  });

  it("parses a config with architect.panel present", () => {
    const result = BoberConfigSchema.safeParse({
      project: { name: "test-project", mode: "greenfield" },
      planner: {},
      generator: {},
      evaluator: { strategies: [] },
      sprint: {},
      pipeline: {},
      commands: {},
      architect: { panel: { enabled: true, lenses: ["scalability"], maxConcurrent: 2 } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.architect?.panel.enabled).toBe(true);
      expect(result.data.architect?.panel.lenses).toEqual(["scalability"]);
    }
  });
});

describe("HistorySectionSchema", () => {
  it("defaults maxActiveLines to 2000 on empty config", () => {
    expect(HistorySectionSchema.parse({}).maxActiveLines).toBe(2000);
  });

  it("rejects a non-positive maxActiveLines (0)", () => {
    expect(() => HistorySectionSchema.parse({ maxActiveLines: 0 })).toThrow();
  });

  it("rejects a non-positive maxActiveLines (-1)", () => {
    expect(() => HistorySectionSchema.parse({ maxActiveLines: -1 })).toThrow();
  });

  it("accepts a positive integer maxActiveLines", () => {
    expect(HistorySectionSchema.parse({ maxActiveLines: 500 }).maxActiveLines).toBe(500);
  });
});

describe("PipelineSectionSchema.engine", () => {
  it("defaults engine to 'ts' when omitted", () => {
    expect(PipelineSectionSchema.parse({}).engine).toBe("ts");
  });

  it("rejects an unknown engine string", () => {
    expect(() => PipelineSectionSchema.parse({ engine: "bogus" })).toThrow();
  });

  it("accepts 'workflow'", () => {
    expect(PipelineSectionSchema.parse({ engine: "workflow" }).engine).toBe("workflow");
  });

  it("accepts 'skill'", () => {
    expect(PipelineSectionSchema.parse({ engine: "skill" }).engine).toBe("skill");
  });

  it("accepts 'ts' explicitly", () => {
    expect(PipelineSectionSchema.parse({ engine: "ts" }).engine).toBe("ts");
  });
});
