import { describe, expect, it } from "vitest";
import { BoberConfigSchema, createDefaultConfig } from "../config/schema.js";
import type { BoberConfig } from "../config/schema.js";
import { buildChildConfig } from "./child-config.js";

// ── Helpers ──────────────────────────────────────────────────────────

function expectedDeepSeekConfig(folder: string): BoberConfig {
  const base = createDefaultConfig(folder, "greenfield");
  for (const role of ["planner", "generator", "evaluator"] as const) {
    base[role] = {
      ...base[role],
      model: "deepseek-v4-pro",
      provider: "openai-compat",
      endpoint: "https://api.deepseek.com",
    };
  }
  return BoberConfigSchema.parse({ ...base });
}

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

// ── Tier overlay — byte-identical guarantee (sc-2-5) ─────────────────

describe("buildChildConfig() — byte-identical when tier absent", () => {
  it("produces output deep-equal to the expected DeepSeek-default config when no tier is set", () => {
    const folder = "test-proj";
    const result = buildChildConfig({ folder, task: "do something" });
    const expected = expectedDeepSeekConfig(folder);
    expect(result).toEqual(expected);
  });

  it("produces the same output when tier is undefined vs omitted", () => {
    const r1 = buildChildConfig({ folder: "x", task: "t" });
    const r2 = buildChildConfig({ folder: "x", task: "t", tier: undefined });
    expect(r1).toEqual(r2);
  });
});

// ── Tier overlay — per-tier provider blocks (sc-2-6) ─────────────────

describe("buildChildConfig() — tier='cheap'", () => {
  it("sets all roles to DeepSeek openai-compat at api.deepseek.com", () => {
    const r = buildChildConfig({ folder: "x", task: "t", tier: "cheap" });
    expect(r.planner.provider).toBe("openai-compat");
    expect(r.planner.endpoint).toBe("https://api.deepseek.com");
    expect(r.planner.model).toBe("deepseek");
    expect(r.generator.provider).toBe("openai-compat");
    expect(r.generator.endpoint).toBe("https://api.deepseek.com");
    expect(r.generator.model).toBe("deepseek");
    expect(r.evaluator.provider).toBe("openai-compat");
    expect(r.evaluator.endpoint).toBe("https://api.deepseek.com");
    expect(r.evaluator.model).toBe("deepseek");
  });
});

describe("buildChildConfig() — tier='standard'", () => {
  it("sets all roles to Grok openai-compat at api.x.ai/v1", () => {
    const r = buildChildConfig({ folder: "x", task: "t", tier: "standard" });
    expect(r.planner.provider).toBe("openai-compat");
    expect(r.planner.endpoint).toBe("https://api.x.ai/v1");
    expect(r.planner.model).toBe("grok");
    expect(r.generator.provider).toBe("openai-compat");
    expect(r.generator.endpoint).toBe("https://api.x.ai/v1");
    expect(r.generator.model).toBe("grok");
    expect(r.evaluator.provider).toBe("openai-compat");
    expect(r.evaluator.endpoint).toBe("https://api.x.ai/v1");
    expect(r.evaluator.model).toBe("grok");
  });
});

describe("buildChildConfig() — tier='hard'", () => {
  it("sets all roles to anthropic Sonnet with endpoint null", () => {
    const r = buildChildConfig({ folder: "x", task: "t", tier: "hard" });
    expect(r.planner.provider).toBe("anthropic");
    expect(r.planner.model).toBe("sonnet");
    expect(r.planner.endpoint).toBeNull();
    expect(r.generator.provider).toBe("anthropic");
    expect(r.generator.model).toBe("sonnet");
    expect(r.generator.endpoint).toBeNull();
    expect(r.evaluator.provider).toBe("anthropic");
    expect(r.evaluator.model).toBe("sonnet");
    expect(r.evaluator.endpoint).toBeNull();
  });
});

describe("buildChildConfig() — tier='frontier'", () => {
  it("sets all roles to anthropic Opus with endpoint null", () => {
    const r = buildChildConfig({ folder: "x", task: "t", tier: "frontier" });
    expect(r.planner.provider).toBe("anthropic");
    expect(r.planner.model).toBe("opus");
    expect(r.planner.endpoint).toBeNull();
    expect(r.generator.provider).toBe("anthropic");
    expect(r.generator.model).toBe("opus");
    expect(r.generator.endpoint).toBeNull();
    expect(r.evaluator.provider).toBe("anthropic");
    expect(r.evaluator.model).toBe("opus");
    expect(r.evaluator.endpoint).toBeNull();
  });
});

// ── Tier overlay — child.config precedence (sc-2-7) ──────────────────

describe("buildChildConfig() — child.config wins over tier", () => {
  it("child.config.generator overrides the tier block for generator only", () => {
    const r = buildChildConfig({
      folder: "x",
      task: "t",
      tier: "standard",
      config: { generator: { provider: "anthropic", model: "sonnet" } },
    });
    // child.config wins for generator
    expect(r.generator.provider).toBe("anthropic");
    // planner and evaluator still use the tier block
    expect(r.planner.provider).toBe("openai-compat");
    expect(r.evaluator.provider).toBe("openai-compat");
  });

  it("child.config with no role keys still uses the tier block", () => {
    const r = buildChildConfig({
      folder: "x",
      task: "t",
      tier: "hard",
      config: { commands: { build: "make" } },
    });
    expect(r.planner.provider).toBe("anthropic");
    expect(r.generator.provider).toBe("anthropic");
    expect(r.evaluator.provider).toBe("anthropic");
    expect((r.commands as Record<string, unknown>).build).toBe("make");
  });
});
