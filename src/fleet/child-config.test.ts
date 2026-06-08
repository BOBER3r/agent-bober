import { describe, expect, it } from "vitest";
import { BoberConfigSchema } from "../config/schema.js";
import { buildChildConfig } from "./child-config.js";

describe("buildChildConfig() — base config", () => {
  it("returns an object that passes BoberConfigSchema validation", () => {
    const result = buildChildConfig({ folder: "x", task: "t" });
    expect(() => BoberConfigSchema.parse(result)).not.toThrow();
  });

  it("sets openai-compat provider on generator", () => {
    const result = buildChildConfig({ folder: "x", task: "t" });
    expect(result.generator.provider).toBe("openai-compat");
    expect(result.generator.endpoint).toBe("https://api.deepseek.com");
  });

  it("sets openai-compat provider on planner", () => {
    const result = buildChildConfig({ folder: "x", task: "t" });
    expect(result.planner.provider).toBe("openai-compat");
    expect(result.planner.endpoint).toBe("https://api.deepseek.com");
  });

  it("sets openai-compat provider on evaluator", () => {
    const result = buildChildConfig({ folder: "x", task: "t" });
    expect(result.evaluator.provider).toBe("openai-compat");
    expect(result.evaluator.endpoint).toBe("https://api.deepseek.com");
  });
});

describe("buildChildConfig() — with config override", () => {
  it("shallow-merges top-level config keys from child", () => {
    const result = buildChildConfig({
      folder: "x",
      task: "t",
      config: { commands: { build: "npm run build" } },
    });

    expect(() => BoberConfigSchema.parse(result)).not.toThrow();
    // The overridden top-level key should be the child's value
    expect((result.commands as Record<string, unknown>).build).toBe(
      "npm run build",
    );
    // Untouched keys should retain base values
    expect(result.generator.provider).toBe("openai-compat");
  });

  it("does not modify base config when no config override is supplied", () => {
    const result1 = buildChildConfig({ folder: "a", task: "task-a" });
    const result2 = buildChildConfig({ folder: "b", task: "task-b" });
    expect(result1.generator.provider).toBe("openai-compat");
    expect(result2.generator.provider).toBe("openai-compat");
    expect(result1.project.name).toBe("a");
    expect(result2.project.name).toBe("b");
  });
});
