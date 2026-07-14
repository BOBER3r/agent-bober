/**
 * Unit tests for the static CostMeter (estimateCostUsd + PRICE_TABLE).
 *
 * `expected` dollar amounts are always derived from PRICE_TABLE itself (never
 * hardcoded), per sc-2-1: exact dollar accuracy is not a correctness gate —
 * prefix-match resolution, undefined-for-unknown, and arithmetic
 * self-consistency are.
 */

import { describe, it, expect } from "vitest";

import { estimateCostUsd, PRICE_TABLE } from "./cost-meter.js";

function expectedUsd(row: keyof typeof PRICE_TABLE, inputTokens: number, outputTokens: number): number {
  const { inputPerMillion, outputPerMillion } = PRICE_TABLE[row];
  return (inputTokens / 1_000_000) * inputPerMillion + (outputTokens / 1_000_000) * outputPerMillion;
}

describe("estimateCostUsd", () => {
  // ── Exact prefix hit ──────────────────────────────────────────────

  it("returns the priced cost for an exact-prefix anthropic model", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 500_000 };
    const result = estimateCostUsd({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      usage,
    });
    expect(result).toBe(expectedUsd("anthropic:claude-haiku-4-5", usage.inputTokens, usage.outputTokens));
  });

  it("returns the priced cost for an exact-prefix openai model", () => {
    const usage = { inputTokens: 200_000, outputTokens: 50_000 };
    const result = estimateCostUsd({ provider: "openai", model: "o3", usage });
    expect(result).toBe(expectedUsd("openai:o3", usage.inputTokens, usage.outputTokens));
  });

  // ── Longer-prefix-wins ────────────────────────────────────────────

  it("picks the more specific gpt-4.1-mini row over the shorter gpt-4.1 row", () => {
    const usage = { inputTokens: 10_000, outputTokens: 2_000 };
    const result = estimateCostUsd({ provider: "openai", model: "gpt-4.1-mini", usage });
    expect(result).toBe(expectedUsd("openai:gpt-4.1-mini", usage.inputTokens, usage.outputTokens));
    // Sanity: must NOT equal the shorter "gpt-4.1" row's price (rows differ).
    expect(result).not.toBe(expectedUsd("openai:gpt-4.1", usage.inputTokens, usage.outputTokens));
  });

  it("resolves the base gpt-4.1 model to the gpt-4.1 row, not gpt-4.1-mini", () => {
    const usage = { inputTokens: 10_000, outputTokens: 2_000 };
    const result = estimateCostUsd({ provider: "openai", model: "gpt-4.1", usage });
    expect(result).toBe(expectedUsd("openai:gpt-4.1", usage.inputTokens, usage.outputTokens));
  });

  it("picks the more specific grok-4-fast row over the shorter grok-4 row", () => {
    const usage = { inputTokens: 100_000, outputTokens: 20_000 };
    const result = estimateCostUsd({ provider: "openai-compat", model: "grok-4-fast", usage });
    expect(result).toBe(expectedUsd("openai-compat:grok-4-fast", usage.inputTokens, usage.outputTokens));
    expect(result).not.toBe(expectedUsd("openai-compat:grok-4", usage.inputTokens, usage.outputTokens));
  });

  it("resolves the base grok-4 model to the grok-4 row, not grok-4-fast", () => {
    const usage = { inputTokens: 100_000, outputTokens: 20_000 };
    const result = estimateCostUsd({ provider: "openai-compat", model: "grok-4", usage });
    expect(result).toBe(expectedUsd("openai-compat:grok-4", usage.inputTokens, usage.outputTokens));
  });

  it("resolves DeepSeek models via the openai-compat provider key (not the openai row)", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    const result = estimateCostUsd({ provider: "openai-compat", model: "deepseek-v4-pro", usage });
    expect(result).toBe(expectedUsd("openai-compat:deepseek-v4-pro", usage.inputTokens, usage.outputTokens));
  });

  // ── Unknown model -> undefined ───────────────────────────────────

  it("returns undefined for an unknown anthropic model", () => {
    const result = estimateCostUsd({
      provider: "anthropic",
      model: "claude-nonexistent-99",
      usage: { inputTokens: 100, outputTokens: 100 },
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined for an unknown openai model", () => {
    const result = estimateCostUsd({
      provider: "openai",
      model: "totally-unpriced-model",
      usage: { inputTokens: 100, outputTokens: 100 },
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined for an unknown google model", () => {
    const result = estimateCostUsd({
      provider: "google",
      model: "gemini-nonexistent",
      usage: { inputTokens: 100, outputTokens: 100 },
    });
    expect(result).toBeUndefined();
  });

  // ── claude-code -> always undefined (ADR-3) ──────────────────────

  it("returns undefined for provider claude-code even when the model string would otherwise match a row", () => {
    const result = estimateCostUsd({
      provider: "claude-code",
      model: "claude-opus-4-8",
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    });
    expect(result).toBeUndefined();
  });

  // ── Arithmetic correctness ────────────────────────────────────────

  it("computes cost as inputTokens/1e6 * inputPerMillion + outputTokens/1e6 * outputPerMillion", () => {
    const row = PRICE_TABLE["anthropic:claude-sonnet-4"];
    const usage = { inputTokens: 123_456, outputTokens: 78_910 };
    const result = estimateCostUsd({ provider: "anthropic", model: "claude-sonnet-4-6", usage });
    const manual =
      (usage.inputTokens / 1_000_000) * row.inputPerMillion +
      (usage.outputTokens / 1_000_000) * row.outputPerMillion;
    expect(result).toBe(manual);
  });

  it("returns 0 (not undefined) for zero usage against a priced model", () => {
    const result = estimateCostUsd({
      provider: "anthropic",
      model: "claude-opus-4-8",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    expect(result).toBe(0);
  });

  // ── Table coverage (sc-2-1: at least one row per family) ─────────

  it("carries at least one price row for each of anthropic, openai, openai-compat, and google", () => {
    const providers = Object.keys(PRICE_TABLE).map((k) => k.split(":")[0]);
    expect(providers).toContain("anthropic");
    expect(providers).toContain("openai");
    expect(providers).toContain("openai-compat");
    expect(providers).toContain("google");
  });
});
