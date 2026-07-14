import { describe, expect, it } from "vitest";
import { tierPolicy } from "./tier-policy.js";

describe("tierPolicy.resolveTier()", () => {
  it("returns undefined for 'default'", () => {
    expect(tierPolicy.resolveTier("default")).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(tierPolicy.resolveTier(undefined)).toBeUndefined();
  });

  it("maps cheap -> DeepSeek openai-compat at api.deepseek.com", () => {
    const b = tierPolicy.resolveTier("cheap");
    expect(b?.planner.provider).toBe("openai-compat");
    expect(b?.planner.endpoint).toBe("https://api.deepseek.com");
    expect(b?.planner.model).toBe("deepseek");
    expect(b?.generator.provider).toBe("openai-compat");
    expect(b?.generator.endpoint).toBe("https://api.deepseek.com");
    expect(b?.generator.model).toBe("deepseek");
    expect(b?.evaluator.provider).toBe("openai-compat");
    expect(b?.evaluator.endpoint).toBe("https://api.deepseek.com");
    expect(b?.evaluator.model).toBe("deepseek");
  });

  it("maps standard -> Grok openai-compat at api.x.ai/v1", () => {
    const b = tierPolicy.resolveTier("standard");
    expect(b?.planner.provider).toBe("openai-compat");
    expect(b?.planner.endpoint).toBe("https://api.x.ai/v1");
    expect(b?.planner.model).toBe("grok");
    expect(b?.generator.provider).toBe("openai-compat");
    expect(b?.generator.endpoint).toBe("https://api.x.ai/v1");
    expect(b?.generator.model).toBe("grok");
    expect(b?.evaluator.provider).toBe("openai-compat");
    expect(b?.evaluator.endpoint).toBe("https://api.x.ai/v1");
    expect(b?.evaluator.model).toBe("grok");
  });

  it("maps hard -> anthropic Sonnet with endpoint null", () => {
    const b = tierPolicy.resolveTier("hard");
    expect(b?.planner.provider).toBe("anthropic");
    expect(b?.planner.model).toBe("sonnet");
    expect(b?.planner.endpoint).toBeNull();
    expect(b?.generator.provider).toBe("anthropic");
    expect(b?.generator.model).toBe("sonnet");
    expect(b?.generator.endpoint).toBeNull();
    expect(b?.evaluator.provider).toBe("anthropic");
    expect(b?.evaluator.model).toBe("sonnet");
    expect(b?.evaluator.endpoint).toBeNull();
  });

  it("maps frontier -> anthropic Opus with endpoint null", () => {
    const b = tierPolicy.resolveTier("frontier");
    expect(b?.planner.provider).toBe("anthropic");
    expect(b?.planner.model).toBe("opus");
    expect(b?.planner.endpoint).toBeNull();
    expect(b?.generator.provider).toBe("anthropic");
    expect(b?.generator.model).toBe("opus");
    expect(b?.generator.endpoint).toBeNull();
    expect(b?.evaluator.provider).toBe("anthropic");
    expect(b?.evaluator.model).toBe("opus");
    expect(b?.evaluator.endpoint).toBeNull();
  });

  it("never places claude-code on any role for any tier", () => {
    for (const t of ["cheap", "standard", "hard", "frontier"] as const) {
      const b = tierPolicy.resolveTier(t)!;
      for (const role of [b.planner, b.generator, b.evaluator]) {
        expect(role.provider).not.toBe("claude-code");
      }
    }
  });
});

describe("tierPolicy.knownTiers()", () => {
  it("returns all five tiers including default", () => {
    const tiers = tierPolicy.knownTiers();
    expect(tiers).toContain("default");
    expect(tiers).toContain("cheap");
    expect(tiers).toContain("standard");
    expect(tiers).toContain("hard");
    expect(tiers).toContain("frontier");
    expect(tiers).toHaveLength(5);
  });
});
