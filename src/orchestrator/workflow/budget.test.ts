/**
 * Unit tests for the workflow run budget (token + agent ceilings).
 */

import { describe, it, expect } from "vitest";

import { Budget, BudgetExceededError } from "./budget.js";

describe("Budget", () => {
  it("accumulates token usage across charges", () => {
    const b = new Budget();
    b.chargeTokens({ inputTokens: 100, outputTokens: 50 });
    b.chargeTokens({ inputTokens: 10, outputTokens: 5 });
    expect(b.tokensSpent).toBe(165);
  });

  it("accumulates agent charges", () => {
    const b = new Budget();
    b.chargeAgents();
    b.chargeAgents(3);
    expect(b.agentsSpent).toBe(4);
  });

  it("reports Infinity remaining when uncapped", () => {
    const b = new Budget();
    b.chargeTokens({ inputTokens: 1_000_000, outputTokens: 0 });
    expect(b.remainingTokens()).toBe(Infinity);
    expect(b.remainingAgents()).toBe(Infinity);
    expect(b.exceeded()).toBe(false);
  });

  it("computes remaining token headroom against a ceiling", () => {
    const b = new Budget({ maxTokens: 1000 });
    b.chargeTokens({ inputTokens: 300, outputTokens: 200 });
    expect(b.remainingTokens()).toBe(500);
    expect(b.exceeded()).toBe(false);
  });

  it("clamps remaining at 0 and flags exceeded when the token ceiling is passed", () => {
    const b = new Budget({ maxTokens: 100 });
    b.chargeTokens({ inputTokens: 80, outputTokens: 40 });
    expect(b.remainingTokens()).toBe(0);
    expect(b.exceeded()).toBe(true);
  });

  it("flags exceeded when the agent ceiling is reached", () => {
    const b = new Budget({ maxAgents: 2 });
    b.chargeAgents();
    expect(b.exceeded()).toBe(false);
    b.chargeAgents();
    expect(b.remainingAgents()).toBe(0);
    expect(b.exceeded()).toBe(true);
  });

  it("assertWithinBudget throws BudgetExceededError tagged by kind", () => {
    const tokenBudget = new Budget({ maxTokens: 10 });
    tokenBudget.chargeTokens({ inputTokens: 10, outputTokens: 1 });
    expect(() => tokenBudget.assertWithinBudget()).toThrow(BudgetExceededError);
    try {
      tokenBudget.assertWithinBudget();
    } catch (e) {
      expect(e).toBeInstanceOf(BudgetExceededError);
      expect((e as BudgetExceededError).kind).toBe("tokens");
    }

    const agentBudget = new Budget({ maxAgents: 1 });
    agentBudget.chargeAgents();
    try {
      agentBudget.assertWithinBudget();
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(BudgetExceededError);
      expect((e as BudgetExceededError).kind).toBe("agents");
    }
  });

  it("assertWithinBudget is a no-op while within budget", () => {
    const b = new Budget({ maxTokens: 100, maxAgents: 5 });
    b.chargeTokens({ inputTokens: 10, outputTokens: 10 });
    b.chargeAgents();
    expect(() => b.assertWithinBudget()).not.toThrow();
  });

  // ── USD axis (sc-2-4) ──────────────────────────────────────────────

  it("accumulates USD charges across calls", () => {
    const b = new Budget();
    b.chargeUsd(0.5);
    b.chargeUsd(1.25);
    expect(b.usdSpent).toBe(1.75);
  });

  it("reports Infinity remainingUsd when uncapped", () => {
    const b = new Budget();
    b.chargeUsd(1_000_000);
    expect(b.remainingUsd()).toBe(Infinity);
    expect(b.exceeded()).toBe(false);
  });

  it("computes remaining USD headroom against a ceiling", () => {
    const b = new Budget({ maxUsd: 10 });
    b.chargeUsd(4);
    expect(b.remainingUsd()).toBe(6);
    expect(b.exceeded()).toBe(false);
  });

  it("clamps remainingUsd at 0 and flags exceeded when the USD ceiling is crossed", () => {
    const b = new Budget({ maxUsd: 1 });
    b.chargeUsd(0.6);
    expect(b.exceeded()).toBe(false);
    b.chargeUsd(0.6);
    expect(b.remainingUsd()).toBe(0);
    expect(b.exceeded()).toBe(true);
  });

  it("assertWithinBudget throws BudgetExceededError tagged kind 'usd' when the USD ceiling is passed", () => {
    const b = new Budget({ maxUsd: 1 });
    b.chargeUsd(1.5);
    expect(() => b.assertWithinBudget()).toThrow(BudgetExceededError);
    try {
      b.assertWithinBudget();
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(BudgetExceededError);
      expect((e as BudgetExceededError).kind).toBe("usd");
    }
  });

  it("treats NaN and negative chargeUsd values as 0 (usdSpent unchanged)", () => {
    const b = new Budget({ maxUsd: 10 });
    b.chargeUsd(2);
    b.chargeUsd(NaN);
    b.chargeUsd(-5);
    b.chargeUsd(Infinity);
    b.chargeUsd(-Infinity);
    expect(b.usdSpent).toBe(2);
    expect(b.remainingUsd()).toBe(8);
  });

  it("does not affect the token/agent axes when only maxUsd is set (additive, source-compatible)", () => {
    const b = new Budget({ maxUsd: 5 });
    b.chargeTokens({ inputTokens: 100, outputTokens: 50 });
    b.chargeAgents(2);
    expect(b.remainingTokens()).toBe(Infinity);
    expect(b.remainingAgents()).toBe(Infinity);
    expect(() => b.assertWithinBudget()).not.toThrow();
  });
});
