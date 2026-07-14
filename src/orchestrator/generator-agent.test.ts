/**
 * Unit tests for generator-agent's fail-closed refusal guard (sprint-1: sc-1-4, sc-1-5)
 * and the effort/budget loop wiring (sprint-3: sc-3-6).
 *
 * `parseGeneratorResult` is exported specifically so this guard can be
 * unit-tested directly without mocking the whole agentic loop.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SprintContract } from "../contracts/sprint-contract.js";
import type { PlanSpec } from "../contracts/spec.js";
import type { ContextHandoff } from "./context-handoff.js";
import { createDefaultConfig } from "../config/schema.js";
import type { BoberConfig } from "../config/schema.js";
import { parseGeneratorResult, runGenerator } from "./generator-agent.js";

// ── Mock heavy dependencies (used only by the sc-3-6 loop-wiring suite below;
// parseGeneratorResult is a pure function and is unaffected by these mocks).
// `vi.hoisted` avoids the TDZ error that a plain top-level `const` would hit
// once `vi.mock` factories (which are always hoisted above all imports) close
// over it — see https://vitest.dev/api/vi.html#vi-mock. ──

const { loopSpy, clientSpy } = vi.hoisted(() => ({
  loopSpy: vi.fn(async () => ({
    finalText: JSON.stringify({ status: "complete", notes: "ok", filesChanged: [] }),
    turnsUsed: 1,
    toolsCalled: [],
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "end",
  })),
  clientSpy: vi.fn(() => ({} as never)),
}));

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

const loop = { turnsUsed: 1, toolsCalled: [], usage: { inputTokens: 0, outputTokens: 0 } };

describe("parseGeneratorResult — refusal fail-closed guard", () => {
  it("sc-1-4: refused overrides the filesWritten success shortcut", () => {
    const files = new Set(["src/a.ts"]); // non-empty → would be success:true without the guard
    const res = parseGeneratorResult("I refuse to do this.", files, { ...loop, refused: true });

    expect(res.success).toBe(false);
    expect(res.notes.toLowerCase()).toContain("refus");
    expect(res.filesChanged).toEqual(["src/a.ts"]);
  });

  it("sc-1-4: refused overrides even a well-formed success report", () => {
    const files = new Set<string>();
    const reportText = JSON.stringify({ success: true, notes: "all good", filesChanged: [] });
    const res = parseGeneratorResult(reportText, files, { ...loop, refused: true });

    expect(res.success).toBe(false);
    expect(res.notes.toLowerCase()).toContain("refus");
  });

  it("sc-1-5: without refused, filesWritten still yields success:true (byte-identical)", () => {
    const files = new Set(["src/a.ts"]);
    const res = parseGeneratorResult("not json", files, loop); // no refused key present
    expect(res.success).toBe(true);
  });

  it("sc-1-5: without refused, a well-formed report still parses as before", () => {
    const files = new Set<string>();
    const reportText = JSON.stringify({ success: true, notes: "done", filesChanged: ["src/b.ts"] });
    const res = parseGeneratorResult(reportText, files, loop);

    expect(res.success).toBe(true);
    expect(res.notes).toBe("done");
    expect(res.filesChanged).toEqual(["src/b.ts"]);
  });

  it("sc-1-5: refused explicitly false behaves the same as absent", () => {
    const files = new Set(["src/a.ts"]);
    const res = parseGeneratorResult("not json", files, { ...loop, refused: false });
    expect(res.success).toBe(true);
  });
});

describe("parseGeneratorResult — costUsd surfacing (sprint-3: sc-3-6)", () => {
  it("surfaces costUsd on the returned GeneratorResult when the loop reported one", () => {
    const files = new Set<string>();
    const reportText = JSON.stringify({ success: true, notes: "done", filesChanged: [] });
    const res = parseGeneratorResult(reportText, files, { ...loop, costUsd: 1.23 });
    expect(res.costUsd).toBe(1.23);
  });

  it("omits costUsd entirely when the loop fixture carries none (byte-identical)", () => {
    const files = new Set(["src/a.ts"]);
    const res = parseGeneratorResult("not json", files, loop);
    expect(Object.hasOwn(res, "costUsd")).toBe(false);
  });
});

// ── sc-3-6: generator loop-wiring — effort/budget passed conditionally ──────

const testContract: SprintContract = {
  contractId: "generator-loop-wiring-test",
  specId: "test-spec",
  sprintNumber: 1,
  title: "Loop wiring test contract",
  description: "Contract used as fixture for the generator effort/budget wiring unit tests.",
  status: "in-progress",
  dependsOn: [],
  features: ["feat-1"],
  successCriteria: [
    {
      criterionId: "sc-3-6",
      description: "Generator constructs Budget from config.generator.budget.maxUsd.",
      verificationMethod: "unit-test",
      required: true,
    },
  ],
  nonGoals: ["Not a real sprint"],
  stopConditions: ["All assertions pass"],
  definitionOfDone: "Effort/budget loop wiring is verified.",
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
  description: "A test plan spec for generator loop-wiring unit tests.",
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

const testHandoff: ContextHandoff = {
  timestamp: new Date().toISOString(),
  from: "planner",
  to: "generator",
  projectContext: {
    name: "test-project",
    type: "brownfield",
    techStack: [],
    entryPoints: [],
    currentBranch: "bober/generator-loop-wiring",
  },
  spec: testSpec,
  currentContract: testContract,
  sprintHistory: [],
  instructions: "Implement the sprint.",
  changedFiles: [],
  decisions: [],
  issues: [],
};

/** Build a full BoberConfig with the given generator section override. */
function makeConfig(generatorOverride: Partial<BoberConfig["generator"]>): BoberConfig {
  const base = createDefaultConfig("test-project", "brownfield");
  return {
    ...base,
    generator: {
      ...base.generator,
      ...generatorOverride,
    },
  };
}

describe("runGenerator — effort/budget loop wiring (sc-3-6)", () => {
  beforeEach(() => {
    loopSpy.mockClear();
    clientSpy.mockClear();
  });

  it("passes NEITHER effort NOR budget when config lacks both (byte-identical invocation)", async () => {
    const config = makeConfig({});

    await runGenerator(testHandoff, "/tmp/test-proj", config);

    expect(loopSpy).toHaveBeenCalledTimes(1);
    const passedParams = loopSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.hasOwn(passedParams, "effort")).toBe(false);
    expect(Object.hasOwn(passedParams, "budget")).toBe(false);
  });

  it("passes effort when config.generator.effort is set", async () => {
    const config = makeConfig({ effort: "high" });

    await runGenerator(testHandoff, "/tmp/test-proj", config);

    const passedParams = loopSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(passedParams.effort).toBe("high");
    expect(Object.hasOwn(passedParams, "budget")).toBe(false);
  });

  it("constructs and passes a Budget when config.generator.budget.maxUsd is set", async () => {
    const config = makeConfig({ budget: { maxUsd: 3 } });

    await runGenerator(testHandoff, "/tmp/test-proj", config);

    const passedParams = loopSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.hasOwn(passedParams, "effort")).toBe(false);
    expect(passedParams.budget).toBeDefined();
    expect((passedParams.budget as { remainingUsd(): number }).remainingUsd()).toBe(3);
  });

  it("does NOT construct a Budget when config.generator.budget.maxUsd is null", async () => {
    const config = makeConfig({ budget: { maxUsd: null } });

    await runGenerator(testHandoff, "/tmp/test-proj", config);

    const passedParams = loopSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.hasOwn(passedParams, "budget")).toBe(false);
  });
});

// ── sc-4-5: parallelReadOnlyTools per-role config flag reaches AgenticLoopParams ──

describe("runGenerator — parallelReadOnlyTools loop wiring (sc-4-5)", () => {
  beforeEach(() => {
    loopSpy.mockClear();
    clientSpy.mockClear();
  });

  it("omits parallelReadOnlyTools entirely when config lacks it (byte-identical invocation)", async () => {
    const config = makeConfig({});

    await runGenerator(testHandoff, "/tmp/test-proj", config);

    const passedParams = loopSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.hasOwn(passedParams, "parallelReadOnlyTools")).toBe(false);
  });

  it("passes parallelReadOnlyTools:true when config.generator.parallelReadOnlyTools is true", async () => {
    const config = makeConfig({ parallelReadOnlyTools: true });

    await runGenerator(testHandoff, "/tmp/test-proj", config);

    const passedParams = loopSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(passedParams.parallelReadOnlyTools).toBe(true);
  });

  it("passes parallelReadOnlyTools:false explicitly when config sets it false", async () => {
    const config = makeConfig({ parallelReadOnlyTools: false });

    await runGenerator(testHandoff, "/tmp/test-proj", config);

    const passedParams = loopSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(passedParams.parallelReadOnlyTools).toBe(false);
  });

  it("existing configs without the field still parse via createDefaultConfig (sc-4-5)", () => {
    const config = createDefaultConfig("x", "brownfield");
    expect(Object.hasOwn(config.generator, "parallelReadOnlyTools")).toBe(false);
  });
});
