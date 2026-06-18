import { describe, it, expect } from "vitest";
import {
  PipelineSectionSchema,
  EvaluatorSectionSchema,
  ArchitectSectionSchema,
  BoberConfigSchema,
  HistorySectionSchema,
  FleetSectionSchema,
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

describe("BoberConfigSchema — fleet section is optional (sc-2-3)", () => {
  const minimalBase = {
    project: { name: "test-project", mode: "greenfield" },
    planner: {},
    generator: {},
    evaluator: { strategies: [] },
    sprint: {},
    pipeline: {},
    commands: {},
  };

  it("parses a config without a fleet section (fleet is undefined)", () => {
    const result = BoberConfigSchema.safeParse(minimalBase);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fleet).toBeUndefined();
    }
  });

  it("parses a config with a complete fleet section", () => {
    const result = BoberConfigSchema.safeParse({
      ...minimalBase,
      fleet: {
        blackboardDbPath: "/abs/path/.bober/memory/run-1/facts.db",
        blackboardNamespace: "run-1",
        blackboardSubject: "child-a",
        maxRounds: 2,
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fleet?.blackboardDbPath).toBe("/abs/path/.bober/memory/run-1/facts.db");
      expect(result.data.fleet?.blackboardNamespace).toBe("run-1");
      expect(result.data.fleet?.blackboardSubject).toBe("child-a");
      expect(result.data.fleet?.maxRounds).toBe(2);
    }
  });

  it("rejects fleet.maxRounds > 3 (ZodError)", () => {
    const result = BoberConfigSchema.safeParse({
      ...minimalBase,
      fleet: {
        blackboardDbPath: "/abs/path/facts.db",
        blackboardNamespace: "run-1",
        blackboardSubject: "child-a",
        maxRounds: 4,
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects fleet.maxRounds < 1 (ZodError)", () => {
    const result = BoberConfigSchema.safeParse({
      ...minimalBase,
      fleet: {
        blackboardDbPath: "/abs/path/facts.db",
        blackboardNamespace: "run-1",
        blackboardSubject: "child-a",
        maxRounds: 0,
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("FleetSectionSchema — standalone validation (sc-2-3)", () => {
  it("parses a valid fleet section with maxRounds=1", () => {
    const result = FleetSectionSchema.safeParse({
      blackboardDbPath: "/abs/path/facts.db",
      blackboardNamespace: "ns",
      blackboardSubject: "folder-x",
      maxRounds: 1,
    });
    expect(result.success).toBe(true);
  });

  it("parses a valid fleet section with maxRounds=3", () => {
    const result = FleetSectionSchema.safeParse({
      blackboardDbPath: "/abs/path/facts.db",
      blackboardNamespace: "ns",
      blackboardSubject: "folder-x",
      maxRounds: 3,
    });
    expect(result.success).toBe(true);
  });

  it("rejects maxRounds=4", () => {
    expect(() =>
      FleetSectionSchema.parse({
        blackboardDbPath: "/abs/path/facts.db",
        blackboardNamespace: "ns",
        blackboardSubject: "folder-x",
        maxRounds: 4,
      }),
    ).toThrow();
  });

  it("rejects non-integer maxRounds", () => {
    expect(() =>
      FleetSectionSchema.parse({
        blackboardDbPath: "/abs/path/facts.db",
        blackboardNamespace: "ns",
        blackboardSubject: "folder-x",
        maxRounds: 1.5,
      }),
    ).toThrow();
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
