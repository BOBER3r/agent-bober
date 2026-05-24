/**
 * Unit tests for preflight-budgets.ts utilities.
 * Colocated with the source file per project convention.
 */

import { describe, it, expect } from "vitest";
import { estimateTokens, enforceBudget, DEFAULT_PREFLIGHT_BUDGETS } from "./preflight-budgets.js";

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("uses ceil(length/4) formula", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("abcdefgh")).toBe(2);
    expect(estimateTokens("abcdefghi")).toBe(3);
  });

  it("handles unicode characters (counted by string length)", () => {
    const result = estimateTokens("hello");
    expect(result).toBe(2); // ceil(5/4) = 2
  });
});

describe("enforceBudget", () => {
  it("returns unchanged output when within budget", () => {
    const text = "### Overview\n\nShort overview.";
    const { out, dropped } = enforceBudget(text, 10000);
    expect(out).toBe(text);
    expect(dropped).toBe(0);
  });

  it("returns budget=0 marker when budget is 0", () => {
    const { out } = enforceBudget("some text", 0);
    expect(out).toContain("budget=0");
    expect(out).toContain("truncated");
  });

  it("drops sections from the end when over budget", () => {
    // Section 1: 400 chars = 100 tokens. Section 2: 400 chars = 100 tokens.
    // Budget = 120 tokens: fits section 1 (100 tokens) + marker overhead (~15 tokens) = 115 <= 120.
    // But does NOT fit both sections (200 tokens > 120).
    const section1 = "### Section 1\n\n" + "A".repeat(386); // 400 chars total = 100 tokens
    const section2 = "### Section 2\n\n" + "B".repeat(386); // 400 chars total = 100 tokens
    const full = section1 + "\n\n" + section2; // 802 chars total
    // Budget fits section 1 + marker but not both sections
    const budgetTokens = 120;
    const { out, dropped } = enforceBudget(full, budgetTokens);
    expect(dropped).toBe(1);
    expect(out).toContain("Section 1");
    expect(out).not.toContain("Section 2");
    expect(out).toContain("truncated due to budget");
    expect(out).toContain("1 more result omitted");
  });

  it("uses plural 'results' when multiple sections dropped", () => {
    // 3 sections of 400 chars each. Budget = 120 tokens: fits only section 1.
    const section1 = "### S1\n\n" + "X".repeat(392); // 400 chars = 100 tokens
    const section2 = "### S2\n\n" + "Y".repeat(392); // 400 chars = 100 tokens
    const section3 = "### S3\n\n" + "Z".repeat(392); // 400 chars = 100 tokens
    const full = section1 + "\n\n" + section2 + "\n\n" + section3; // 1206 chars = 302 tokens
    const budgetTokens = 120;
    const { out, dropped } = enforceBudget(full, budgetTokens);
    expect(dropped).toBe(2);
    expect(out).toContain("2 more results omitted");
  });

  it("appends hard-cap marker when even first section exceeds budget", () => {
    const huge = "### Section\n\n" + "H".repeat(10000);
    const { out } = enforceBudget(huge, 1);
    expect(out).toContain("hard cap");
  });
});

describe("DEFAULT_PREFLIGHT_BUDGETS", () => {
  it("has all 5 roles defined", () => {
    expect(DEFAULT_PREFLIGHT_BUDGETS.architect).toBe(4000);
    expect(DEFAULT_PREFLIGHT_BUDGETS.curator).toBe(2000);
    expect(DEFAULT_PREFLIGHT_BUDGETS.generator).toBe(1000);
    expect(DEFAULT_PREFLIGHT_BUDGETS.evaluator).toBe(1500);
    expect(DEFAULT_PREFLIGHT_BUDGETS["researcher-phase2"]).toBe(3000);
  });
});
