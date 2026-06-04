/**
 * Unit tests for the architect.panel feature (sprint-spec-20260604-architect-lens-panel-2/3).
 *
 * C1: panel undefined/disabled/<2 lenses → exactly ONE runAgenticLoop call (off path, single-loop)
 * C2: panel enabled + >=2 lenses → generate-approaches (1) + per-lens scoring (lenses.length) +
 *     continuation (1) + per-lens reviews (lenses.length) = 2 + 2N total calls;
 *     scoring/review phase peak concurrency <= maxConcurrent; selected == synthesize().winner
 * C3: ArchitectResult shape is valid with and without lensScores/lensReviews (additive optional fields)
 *
 * Colocated with architect-agent.ts per project convention.
 * createClient and runAgenticLoop are mocked — no real LLM/network calls.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { synthesize } from "./workflow/synthesizer.js";
import { createDefaultConfig } from "../config/schema.js";
import type { BoberConfig } from "../config/schema.js";

// ── Mock heavy dependencies ───────────────────────────────────────────

// Track concurrency across per-lens scoring calls
let active = 0;
let peak = 0;
// Track how many runAgenticLoop calls have been made (unused in assertions — kept for debugging)
let _callCount = 0;

const loopSpy = vi.fn(async () => {
  active++;
  peak = Math.max(peak, active);
  _callCount++;
  // Force a small async gap so concurrent calls can overlap (observable concurrency)
  await new Promise<void>((r) => setTimeout(r, 5));
  active--;
  return {
    finalText: JSON.stringify({
      architectureId: "arch-test",
      approaches: ["approach-A", "approach-B"],
      lens: "scalability",
      scores: { "approach-A": 80, "approach-B": 60 },
      componentCount: 2,
      decisionCount: 1,
      title: "Test Architecture",
      summary: "A test architecture.",
      adrPaths: [],
      documentPath: ".bober/architecture/arch-test-architecture.md",
      // Review phase keys (CP5): parsed by reviewLens closure
      passed: true,
      feedback: "Architecture passes this lens criterion.",
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
vi.mock("../state/index.js", () => ({
  saveArchitecture: vi.fn().mockResolvedValue(undefined),
  readArchitecture: vi.fn().mockResolvedValue("# Architecture Document"),
  readADRs: vi.fn().mockResolvedValue([]),
}));
vi.mock("../graph/token-usage.js", () => ({
  TokenUsageLog: class {
    async append() {}
  },
}));

// ── Fixtures ──────────────────────────────────────────────────────────

/**
 * Build a full BoberConfig with the given architect.panel override.
 * Uses createDefaultConfig so all required fields have values.
 * Pass undefined to omit the architect section entirely (off path).
 */
function makeConfig(
  panelOverride?: { enabled: boolean; lenses: string[]; maxConcurrent: number },
): BoberConfig {
  const base = createDefaultConfig("test-project", "brownfield");
  return panelOverride === undefined
    ? base
    : { ...base, architect: { panel: panelOverride } };
}

// ── Tests ─────────────────────────────────────────────────────────────

beforeEach(() => {
  active = 0;
  peak = 0;
  _callCount = 0;
  loopSpy.mockClear();
  clientSpy.mockClear();
});

describe("architect panel — C1 off path", () => {
  it("panel undefined (no architect section) → exactly one runAgenticLoop call", async () => {
    const config = makeConfig(undefined);
    const { runArchitect } = await import("./architect-agent.js");
    await runArchitect("build a thing", "/tmp/test-proj", config);
    expect(loopSpy).toHaveBeenCalledTimes(1);
  });

  it("panel disabled → exactly one runAgenticLoop call", async () => {
    const config = makeConfig({ enabled: false, lenses: [], maxConcurrent: 4 });
    const { runArchitect } = await import("./architect-agent.js");
    await runArchitect("build a thing", "/tmp/test-proj", config);
    expect(loopSpy).toHaveBeenCalledTimes(1);
  });

  it("panel enabled but lenses.length < 2 (one lens) → exactly one runAgenticLoop call", async () => {
    const config = makeConfig({ enabled: true, lenses: ["scalability"], maxConcurrent: 4 });
    const { runArchitect } = await import("./architect-agent.js");
    await runArchitect("build a thing", "/tmp/test-proj", config);
    expect(loopSpy).toHaveBeenCalledTimes(1);
  });

  it("panel enabled but lenses.length === 0 → exactly one runAgenticLoop call", async () => {
    const config = makeConfig({ enabled: true, lenses: [], maxConcurrent: 4 });
    const { runArchitect } = await import("./architect-agent.js");
    await runArchitect("build a thing", "/tmp/test-proj", config);
    expect(loopSpy).toHaveBeenCalledTimes(1);
  });

  it("off path result has no lensScores field", async () => {
    const config = makeConfig(undefined);
    const { runArchitect } = await import("./architect-agent.js");
    const result = await runArchitect("build a thing", "/tmp/test-proj", config);
    expect(result.lensScores).toBeUndefined();
  });
});

describe("architect panel — C2 on path", () => {
  it("3 lenses → generate(1)+scoring(3)+continuation(1)+reviews(3)=8 total calls, peak concurrency <= maxConcurrent=2", async () => {
    const config = makeConfig({
      enabled: true,
      lenses: ["scalability", "security", "cost"],
      maxConcurrent: 2,
    });
    // Reset peak tracking (scoring and review phases run concurrently within their batches)
    // The generate + continuation calls are sequential so peak comes from scoring/review.
    const { runArchitect } = await import("./architect-agent.js");
    await runArchitect("build a thing", "/tmp/test-proj", config);
    // Total calls: 1 (generate) + 3 (scoring) + 1 (continuation) + 3 (reviews) = 8 = 2 + 2*3
    expect(loopSpy).toHaveBeenCalledTimes(8);
    // Peak concurrency comes from scoring/review phases (maxConcurrent=2, 3 lenses → batch [2]+[1])
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("2 lenses → generate(1)+scoring(2)+continuation(1)+reviews(2)=6 total calls, peak concurrency <= maxConcurrent=4", async () => {
    const config = makeConfig({
      enabled: true,
      lenses: ["scalability", "security"],
      maxConcurrent: 4,
    });
    const { runArchitect } = await import("./architect-agent.js");
    await runArchitect("build a thing", "/tmp/test-proj", config);
    // Total: 1 + 2 + 1 + 2 = 6 = 2 + 2*2
    expect(loopSpy).toHaveBeenCalledTimes(6);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("4 lenses with maxConcurrent=2 → 10 total calls, peak concurrency <= 2", async () => {
    const config = makeConfig({
      enabled: true,
      lenses: ["scalability", "security", "cost", "operability"],
      maxConcurrent: 2,
    });
    const { runArchitect } = await import("./architect-agent.js");
    await runArchitect("build a thing", "/tmp/test-proj", config);
    // Total: 1 + 4 + 1 + 4 = 10 = 2 + 2*4
    expect(loopSpy).toHaveBeenCalledTimes(10);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("on path result contains lensScores with one entry per lens", async () => {
    const lenses = ["scalability", "security", "cost"];
    const config = makeConfig({ enabled: true, lenses, maxConcurrent: 4 });
    const { runArchitect } = await import("./architect-agent.js");
    const result = await runArchitect("build a thing", "/tmp/test-proj", config);
    expect(result.lensScores).toBeDefined();
    expect(result.lensScores).toHaveLength(lenses.length);
    for (const ls of result.lensScores!) {
      expect(lenses).toContain(ls.lens);
      expect(typeof ls.scores).toBe("object");
    }
  });

  it("C2: on path result contains lensReviews with one entry per lens, all passed=true (happy path)", async () => {
    const lenses = ["scalability", "security", "cost"];
    const config = makeConfig({ enabled: true, lenses, maxConcurrent: 4 });
    const { runArchitect } = await import("./architect-agent.js");
    const result = await runArchitect("build a thing", "/tmp/test-proj", config);
    expect(result.lensReviews).toBeDefined();
    expect(result.lensReviews).toHaveLength(lenses.length);
    for (const lr of result.lensReviews!) {
      expect(lenses).toContain(lr.lens);
      expect(typeof lr.passed).toBe("boolean");
      expect(typeof lr.summary).toBe("string");
      expect(typeof lr.feedback).toBe("string");
    }
    // All lenses pass (mock returns passed: true) → panelReviewPassed = true
    expect(result.panelReviewPassed).toBe(true);
  });

  it("C2: 2 pass + 2 fail → panel verdict reconciles to passed=false (fail-closed)", async () => {
    const lenses = ["scalability", "security", "cost", "operability"];
    const config = makeConfig({ enabled: true, lenses, maxConcurrent: 4 });

    // Override loopSpy to return alternating verdicts for review calls.
    // With 4 lenses: calls 1=generate, 2-5=scoring, 6=continuation, 7-10=reviews.
    // We want reviews 7,8 to pass and 9,10 to fail → 2 pass, 2 fail → fail-closed.
    let callIndex = 0;
    loopSpy.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      _callCount++;
      await new Promise<void>((r) => setTimeout(r, 5));
      active--;
      callIndex++;
      // First 6 calls (generate + 4 scoring + continuation) use the default blob
      // Calls 7-10 are the review calls: alternate pass/fail for 2+2 split
      const isReviewCall = callIndex > 6;
      const reviewPassed = isReviewCall ? callIndex <= 8 : true;
      return {
        finalText: JSON.stringify({
          architectureId: "arch-test",
          approaches: ["approach-A", "approach-B"],
          lens: "scalability",
          scores: { "approach-A": 80, "approach-B": 60 },
          componentCount: 2,
          decisionCount: 1,
          title: "Test Architecture",
          summary: "A test architecture.",
          adrPaths: [],
          documentPath: ".bober/architecture/arch-test-architecture.md",
          passed: reviewPassed,
          feedback: reviewPassed ? "Architecture passes this lens." : "Architecture fails this lens.",
        }),
        turnsUsed: 1,
        toolsCalled: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "end_turn" as const,
      };
    });

    const { runArchitect } = await import("./architect-agent.js");
    const result = await runArchitect("build a thing", "/tmp/test-proj", config);

    // Total: 2 + 2*4 = 10
    expect(loopSpy).toHaveBeenCalledTimes(10);
    expect(result.lensReviews).toHaveLength(4);
    // 2 pass + 2 fail → passCount(2) > failCount(2) is false → fail-closed
    expect(result.panelReviewPassed).toBe(false);

    // Restore default implementation for subsequent tests
    loopSpy.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      _callCount++;
      await new Promise<void>((r) => setTimeout(r, 5));
      active--;
      return {
        finalText: JSON.stringify({
          architectureId: "arch-test",
          approaches: ["approach-A", "approach-B"],
          lens: "scalability",
          scores: { "approach-A": 80, "approach-B": 60 },
          componentCount: 2,
          decisionCount: 1,
          title: "Test Architecture",
          summary: "A test architecture.",
          adrPaths: [],
          documentPath: ".bober/architecture/arch-test-architecture.md",
          passed: true,
          feedback: "Architecture passes this lens criterion.",
        }),
        turnsUsed: 1,
        toolsCalled: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "end_turn" as const,
      };
    });
  });

  it("C2: result.selectedApproach equals synthesize(approaches, lensScores).winner", async () => {
    // The loopSpy mock returns approaches: ["approach-A","approach-B"] and
    // scores: { "approach-A": 80, "approach-B": 60 } for every call.
    // So the generate step gives approaches=["approach-A","approach-B"].
    // Each scoring step gives scores {"approach-A":80,"approach-B":60} per lens.
    const lenses = ["scalability", "security"];
    const config = makeConfig({ enabled: true, lenses, maxConcurrent: 4 });
    const { runArchitect } = await import("./architect-agent.js");
    const result = await runArchitect("build a thing", "/tmp/test-proj", config);

    // Reconstruct the same inputs the panel saw from the mock data
    const expectedApproaches = ["approach-A", "approach-B"];
    const expectedLensScores = lenses.map((lens) => ({
      lens,
      scores: { "approach-A": 80, "approach-B": 60 },
    }));
    const expectedWinner = synthesize(expectedApproaches, expectedLensScores).winner;

    expect(result.selectedApproach).toBeDefined();
    expect(result.selectedApproach).toBe(expectedWinner);
  });
});

describe("architect panel — C3 result shape", () => {
  it("off path ArchitectResult has required fields (id, timestamp, document, adrs, componentCount, decisionCount)", async () => {
    const config = makeConfig(undefined);
    const { runArchitect } = await import("./architect-agent.js");
    const result = await runArchitect("build a thing", "/tmp/test-proj", config);
    expect(typeof result.id).toBe("string");
    expect(result.id.startsWith("arch-")).toBe(true);
    expect(typeof result.timestamp).toBe("string");
    expect(typeof result.document).toBe("string");
    expect(Array.isArray(result.adrs)).toBe(true);
    expect(typeof result.componentCount).toBe("number");
    expect(typeof result.decisionCount).toBe("number");
    expect(result.lensScores).toBeUndefined();
    expect(result.selectedApproach).toBeUndefined();
    // C1: off path has no per-lens review fan-out
    expect(result.lensReviews).toBeUndefined();
    expect(result.panelReviewPassed).toBeUndefined();
  });

  it("on path ArchitectResult has all required fields plus lensScores", async () => {
    const config = makeConfig({
      enabled: true,
      lenses: ["scalability", "security"],
      maxConcurrent: 4,
    });
    const { runArchitect } = await import("./architect-agent.js");
    const result = await runArchitect("build a thing", "/tmp/test-proj", config);
    expect(typeof result.id).toBe("string");
    expect(result.id.startsWith("arch-")).toBe(true);
    expect(typeof result.timestamp).toBe("string");
    expect(typeof result.document).toBe("string");
    expect(Array.isArray(result.adrs)).toBe(true);
    expect(typeof result.componentCount).toBe("number");
    expect(typeof result.decisionCount).toBe("number");
    expect(result.lensScores).toBeDefined();
    expect(Array.isArray(result.lensScores)).toBe(true);
  });

  it("a result without lensScores is still a valid ArchitectResult (optional field)", async () => {
    const config = makeConfig(undefined);
    const { runArchitect } = await import("./architect-agent.js");
    const result = await runArchitect("build a thing", "/tmp/test-proj", config);
    // lensScores is optional — absence is not an error
    const requiredFields: (keyof typeof result)[] = [
      "id", "timestamp", "document", "adrs", "componentCount", "decisionCount",
    ];
    for (const field of requiredFields) {
      expect(result[field]).toBeDefined();
    }
  });
});
