/**
 * Unit tests for the evaluator.panel feature (sprint-spec-20260604-evaluator-lens-panel-1).
 *
 * Tests the three panel path assertions (C2/C3/C4):
 * (C2) panel disabled / <2 lenses → exactly ONE judge call (off path, single-call)
 * (C3) panel enabled + >=2 lenses → one call per lens, peak concurrency <= maxConcurrent
 * (C4) 2 pass + 2 fail lenses → EvaluationRunResult.passed === false (fail-closed)
 *
 * Colocated with evaluator-agent.ts per project convention.
 * createClient and runAgenticLoop are mocked — no real LLM/network calls.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SprintContract } from "../contracts/sprint-contract.js";
import type { PlanSpec } from "../contracts/spec.js";
import type { ContextHandoff } from "./context-handoff.js";
import { createDefaultConfig } from "../config/schema.js";
import type { BoberConfig } from "../config/schema.js";

// ── Mock heavy dependencies ───────────────────────────────────────────

// Track concurrency across lens calls
let active = 0;
let peak = 0;
// Queue of per-lens pass/fail verdicts (FIFO)
const verdicts: boolean[] = [];

// Spy for appendHistory — declared at module top so vi.mock hoisting can close over it
const appendHistorySpy = vi.fn().mockResolvedValue(undefined);

const loopSpy = vi.fn(async () => {
  active++;
  peak = Math.max(peak, active);
  // Force a small async gap so concurrent calls can overlap (observable concurrency)
  await new Promise<void>((r) => setTimeout(r, 5));
  const passed = verdicts.shift() ?? true;
  active--;
  return {
    finalText: JSON.stringify({
      evaluator: "Agent Evaluation",
      passed,
      score: passed ? 90 : 10,
      details: [],
      summary: passed ? "ok" : "bad",
      feedback: passed ? "no issues" : "failing",
      timestamp: new Date().toISOString(),
    }),
    turnsUsed: 1,
    toolsCalled: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    stopReason: "end_turn" as const,
  };
});

const clientSpy = vi.fn(() => ({} as never));

vi.mock("./agentic-loop.js", () => ({ runAgenticLoop: loopSpy }));
vi.mock("../providers/factory.js", () => ({ createClient: clientSpy }));
vi.mock("./model-resolver.js", () => ({ resolveModel: () => "claude-test" }));
vi.mock("./agent-loader.js", () => ({
  assembleSystemPrompt: vi.fn().mockResolvedValue("SYS"),
}));
vi.mock("./tools/index.js", () => ({
  resolveRoleTools: () => ({ schemas: [], handlers: new Map() }),
  getGraphState: () => ({ enabled: false, engineHealth: "disabled" }),
  getGraphDeps: () => undefined,
}));
vi.mock("../graph/preflight-injector.js", () => ({
  PreflightContextInjector: class {
    async inject(_r: string, _c: unknown, m: string) {
      return m;
    }
  },
}));
vi.mock("../graph/pipeline-lifecycle.js", () => ({
  graphPipelineLifecycle: {
    getGraphClient: () => null,
    engineHealth: () => "disabled",
    getGraphDeps: () => null,
  },
}));
vi.mock("../telemetry/emit.js", () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../state/history.js", () => ({
  appendHistory: appendHistorySpy,
}));
vi.mock("../evaluators/registry.js", () => ({
  createDefaultRegistry: vi.fn().mockResolvedValue({}),
  runEvaluation: vi.fn().mockResolvedValue({
    passed: true,
    results: [],
  }),
}));
vi.mock("../utils/git.js", () => ({
  getChangedFiles: vi.fn().mockResolvedValue([]),
}));

// ── Fixtures ──────────────────────────────────────────────────────────

const testContract: SprintContract = {
  contractId: "evaluator-lens-panel-test",
  specId: "test-spec",
  sprintNumber: 1,
  title: "Panel lens test contract",
  description: "Contract used as fixture for the evaluator panel unit tests.",
  status: "in-progress",
  dependsOn: [],
  features: ["feat-1"],
  successCriteria: [
    {
      criterionId: "C1",
      description: "Panel config exists in EvaluatorSectionSchema with correct defaults.",
      verificationMethod: "unit-test",
      required: true,
    },
  ],
  nonGoals: ["Not a real sprint"],
  stopConditions: ["All assertions pass"],
  definitionOfDone: "Panel config and lens-aware reconcile wiring are verified.",
  assumptions: [],
  outOfScope: [],
  estimatedFiles: [],
  iterationHistory: [],
  lastEvalId: null,
};

const testSpec: PlanSpec = {
  specId: "test-spec",
  version: 1,
  title: "Test Plan",
  description: "A test plan spec for evaluator panel unit tests.",
  status: "ready",
  mode: "brownfield",
  features: [],
  assumptions: [],
  outOfScope: [],
  clarificationQuestions: [],
  resolvedClarifications: [],
  techStack: [],
  nonFunctionalRequirements: [],
  constraints: [],
};

const handoff: ContextHandoff = {
  timestamp: new Date().toISOString(),
  from: "generator",
  to: "evaluator",
  projectContext: {
    name: "test-project",
    type: "brownfield",
    techStack: [],
    entryPoints: [],
    currentBranch: "bober/evaluator-lens-panel",
  },
  spec: testSpec,
  currentContract: testContract,
  sprintHistory: [],
  instructions: "Evaluate the sprint.",
  changedFiles: [],
  decisions: [],
  issues: [],
};

/**
 * Build a full BoberConfig with the given evaluator.panel override.
 * Uses createDefaultConfig so all required fields have values.
 */
function makeConfig(panelOverride: BoberConfig["evaluator"]["panel"]): BoberConfig {
  const base = createDefaultConfig("test-project", "brownfield");
  return {
    ...base,
    evaluator: {
      ...base.evaluator,
      panel: panelOverride,
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

beforeEach(() => {
  active = 0;
  peak = 0;
  verdicts.length = 0;
  loopSpy.mockClear();
  clientSpy.mockClear();
  appendHistorySpy.mockClear();
});

describe("evaluator panel — C2 off path", () => {
  it("panel disabled → exactly one judge LLM call", async () => {
    const config = makeConfig({ enabled: false, lenses: [], maxConcurrent: 4 });
    const { runEvaluatorAgent } = await import("./evaluator-agent.js");
    await runEvaluatorAgent(handoff, "/tmp/test-proj", config);
    expect(loopSpy).toHaveBeenCalledTimes(1);
  });

  it("panel enabled but lenses.length < 2 → exactly one judge LLM call", async () => {
    const config = makeConfig({ enabled: true, lenses: ["correctness"], maxConcurrent: 4 });
    const { runEvaluatorAgent } = await import("./evaluator-agent.js");
    await runEvaluatorAgent(handoff, "/tmp/test-proj", config);
    expect(loopSpy).toHaveBeenCalledTimes(1);
  });

  it("panel unset (uses schema default: disabled) → exactly one judge LLM call", async () => {
    // createDefaultConfig already sets panel.enabled=false
    const config = createDefaultConfig("test-project", "brownfield");
    const { runEvaluatorAgent } = await import("./evaluator-agent.js");
    await runEvaluatorAgent(handoff, "/tmp/test-proj", config);
    expect(loopSpy).toHaveBeenCalledTimes(1);
  });
});

describe("evaluator panel — C3 on path", () => {
  it("3 lenses → 3 judge calls, peak concurrency <= maxConcurrent=2", async () => {
    verdicts.push(true, true, true);
    const config = makeConfig({
      enabled: true,
      lenses: ["correctness", "security", "regression"],
      maxConcurrent: 2,
    });
    const { runEvaluatorAgent } = await import("./evaluator-agent.js");
    await runEvaluatorAgent(handoff, "/tmp/test-proj", config);
    expect(loopSpy).toHaveBeenCalledTimes(3);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("2 lenses → 2 judge calls, peak concurrency <= maxConcurrent=4", async () => {
    verdicts.push(true, true);
    const config = makeConfig({
      enabled: true,
      lenses: ["correctness", "quality"],
      maxConcurrent: 4,
    });
    const { runEvaluatorAgent } = await import("./evaluator-agent.js");
    await runEvaluatorAgent(handoff, "/tmp/test-proj", config);
    expect(loopSpy).toHaveBeenCalledTimes(2);
    expect(peak).toBeLessThanOrEqual(4);
  });
});

describe("evaluator panel — C4 fail-closed reconciliation", () => {
  it("2 pass + 2 fail lenses → EvaluationRunResult.passed === false (tie → fail-closed)", async () => {
    // programmaticEval is mocked to pass (runEvaluation returns passed:true)
    // Panel decides: 2 pass + 2 fail = tie = reconcile → false
    verdicts.push(true, true, false, false);
    const config = makeConfig({
      enabled: true,
      lenses: ["correctness", "quality", "security", "regression"],
      maxConcurrent: 4,
    });
    const { runEvaluatorAgent } = await import("./evaluator-agent.js");
    const out = await runEvaluatorAgent(handoff, "/tmp/test-proj", config);
    // combine: programmaticEval.passed (true) && agentResult.passed (false) = false
    expect(out.passed).toBe(false);
  });

  it("3 fail + 1 pass lenses → EvaluationRunResult.passed === false (minority)", async () => {
    verdicts.push(false, false, false, true);
    const config = makeConfig({
      enabled: true,
      lenses: ["a", "b", "c", "d"],
      maxConcurrent: 4,
    });
    const { runEvaluatorAgent } = await import("./evaluator-agent.js");
    const out = await runEvaluatorAgent(handoff, "/tmp/test-proj", config);
    expect(out.passed).toBe(false);
  });

  it("3 pass + 1 fail lenses → EvaluationRunResult.passed === true (majority)", async () => {
    verdicts.push(true, true, true, false);
    const config = makeConfig({
      enabled: true,
      lenses: ["a", "b", "c", "d"],
      maxConcurrent: 4,
    });
    const { runEvaluatorAgent } = await import("./evaluator-agent.js");
    const out = await runEvaluatorAgent(handoff, "/tmp/test-proj", config);
    // combine: programmaticEval.passed (true) && agentResult.passed (true) = true
    expect(out.passed).toBe(true);
  });
});

describe("evaluator panel — C3 per-lens verdict telemetry", () => {
  it("ON path: 3 lenses → 3 appendHistory calls with event 'eval-lens-verdict' in lens order", async () => {
    verdicts.push(true, false, true);
    const lenses = ["correctness", "security", "regression"];
    const config = makeConfig({
      enabled: true,
      lenses,
      maxConcurrent: 4,
    });
    const { runEvaluatorAgent } = await import("./evaluator-agent.js");
    await runEvaluatorAgent(handoff, "/tmp/test-proj", config);

    // Filter only the eval-lens-verdict calls (appendHistory may be called for other events by other code)
    const verdictCalls = appendHistorySpy.mock.calls.filter(
      (args) =>
        typeof args[1] === "object" &&
        args[1] !== null &&
        (args[1] as Record<string, unknown>).event === "eval-lens-verdict",
    );

    expect(verdictCalls).toHaveLength(3);

    // Verify each call has correct lens name and pass/fail in order
    const expectedPassFail = [true, false, true];
    for (let i = 0; i < lenses.length; i++) {
      const entry = verdictCalls[i][1] as Record<string, unknown>;
      const details = entry.details as Record<string, unknown>;
      expect(details.lens).toBe(lenses[i]);
      expect(details.passed).toBe(expectedPassFail[i]);
    }
  });

  it("ON path: 2 lenses → 2 appendHistory calls, both with event 'eval-lens-verdict'", async () => {
    verdicts.push(false, true);
    const lenses = ["correctness", "quality"];
    const config = makeConfig({
      enabled: true,
      lenses,
      maxConcurrent: 4,
    });
    const { runEvaluatorAgent } = await import("./evaluator-agent.js");
    await runEvaluatorAgent(handoff, "/tmp/test-proj", config);

    const verdictCalls = appendHistorySpy.mock.calls.filter(
      (args) =>
        typeof args[1] === "object" &&
        args[1] !== null &&
        (args[1] as Record<string, unknown>).event === "eval-lens-verdict",
    );

    expect(verdictCalls).toHaveLength(2);
    const entry0 = verdictCalls[0][1] as Record<string, unknown>;
    const details0 = entry0.details as Record<string, unknown>;
    expect(details0.lens).toBe("correctness");
    expect(details0.passed).toBe(false);

    const entry1 = verdictCalls[1][1] as Record<string, unknown>;
    const details1 = entry1.details as Record<string, unknown>;
    expect(details1.lens).toBe("quality");
    expect(details1.passed).toBe(true);
  });

  it("OFF path (panel disabled): NO eval-lens-verdict appendHistory calls", async () => {
    const config = makeConfig({ enabled: false, lenses: [], maxConcurrent: 4 });
    const { runEvaluatorAgent } = await import("./evaluator-agent.js");
    await runEvaluatorAgent(handoff, "/tmp/test-proj", config);

    const verdictCalls = appendHistorySpy.mock.calls.filter(
      (args) =>
        typeof args[1] === "object" &&
        args[1] !== null &&
        (args[1] as Record<string, unknown>).event === "eval-lens-verdict",
    );

    expect(verdictCalls).toHaveLength(0);
  });

  it("OFF path (panel enabled but <2 lenses): NO eval-lens-verdict appendHistory calls", async () => {
    const config = makeConfig({ enabled: true, lenses: ["correctness"], maxConcurrent: 4 });
    const { runEvaluatorAgent } = await import("./evaluator-agent.js");
    await runEvaluatorAgent(handoff, "/tmp/test-proj", config);

    const verdictCalls = appendHistorySpy.mock.calls.filter(
      (args) =>
        typeof args[1] === "object" &&
        args[1] !== null &&
        (args[1] as Record<string, unknown>).event === "eval-lens-verdict",
    );

    expect(verdictCalls).toHaveLength(0);
  });
});
