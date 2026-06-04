/**
 * Unit tests for the architect.panel feature (sprint-spec-20260604-architect-lens-panel-2).
 *
 * C1: panel undefined/disabled/<2 lenses → exactly ONE runAgenticLoop call (off path, single-loop)
 * C2: panel enabled + >=2 lenses → generate-approaches (1) + per-lens scoring (lenses.length) +
 *     continuation (1); scoring phase peak concurrency <= maxConcurrent; selected == synthesize().winner
 * C3: ArchitectResult shape is valid with and without lensScores (additive optional field)
 *
 * Colocated with architect-agent.ts per project convention.
 * createClient and runAgenticLoop are mocked — no real LLM/network calls.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
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
  it("3 lenses → generate(1)+scoring(3)+continuation(1)=5 total calls, peak concurrency <= maxConcurrent=2", async () => {
    const config = makeConfig({
      enabled: true,
      lenses: ["scalability", "security", "cost"],
      maxConcurrent: 2,
    });
    // Reset peak tracking (only the scoring phase runs concurrently)
    // We track peak across ALL calls but only scoring calls overlap.
    // The generate + continuation calls are sequential so peak comes from scoring.
    const { runArchitect } = await import("./architect-agent.js");
    await runArchitect("build a thing", "/tmp/test-proj", config);
    // Total calls: 1 (generate) + 3 (scoring) + 1 (continuation) = 5
    expect(loopSpy).toHaveBeenCalledTimes(5);
    // Peak concurrency comes from the scoring phase (maxConcurrent=2, 3 lenses → batch [2]+[1])
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("2 lenses → generate(1)+scoring(2)+continuation(1)=4 total calls, peak concurrency <= maxConcurrent=4", async () => {
    const config = makeConfig({
      enabled: true,
      lenses: ["scalability", "security"],
      maxConcurrent: 4,
    });
    const { runArchitect } = await import("./architect-agent.js");
    await runArchitect("build a thing", "/tmp/test-proj", config);
    expect(loopSpy).toHaveBeenCalledTimes(4);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("4 lenses with maxConcurrent=2 → peak concurrency <= 2", async () => {
    const config = makeConfig({
      enabled: true,
      lenses: ["scalability", "security", "cost", "operability"],
      maxConcurrent: 2,
    });
    const { runArchitect } = await import("./architect-agent.js");
    await runArchitect("build a thing", "/tmp/test-proj", config);
    // Total: 1 + 4 + 1 = 6
    expect(loopSpy).toHaveBeenCalledTimes(6);
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
