import { describe, it, expect } from "vitest";
import { PipelineSectionSchema, EvaluatorSectionSchema } from "./schema.js";

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
