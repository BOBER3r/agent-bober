/**
 * PreflightContextInjector performance test (s6-c9).
 *
 * Uses a normal `it()` test with performance.now() measurements.
 * Vitest bench() API is not used because vitest.config.ts is absent
 * and bench runs require `vitest bench` — this test runs with `npm test`.
 *
 * Asserts p99 < 100ms across 100 warm iterations with mocked GraphClient.
 * (Excludes cold engine spawn — this tests formatting overhead only.)
 */

import { describe, it, expect, vi } from "vitest";
import { performance } from "node:perf_hooks";
import { PreflightContextInjector } from "./preflight-injector.js";
import type { GraphClient } from "./client.js";
import type { SprintContract } from "../contracts/sprint-contract.js";

// Mock graphPipelineLifecycle to return "ready"
vi.mock("./pipeline-lifecycle.js", () => ({
  graphPipelineLifecycle: {
    engineHealth: vi.fn().mockReturnValue("ready"),
    getGraphClient: vi.fn().mockReturnValue(null),
    getGraphDeps: vi.fn().mockReturnValue(null),
  },
}));

// ── Fixtures ──────────────────────────────────────────────────────

const benchContract: SprintContract = {
  contractId: "bench-fixture",
  specId: "bench-spec",
  sprintNumber: 1,
  title: "Benchmark Contract for PreflightContextInjector",
  description: "Used to measure wall-clock inject() performance with warm mocked GraphClient.",
  status: "in-progress",
  dependsOn: [],
  features: ["bench-feat"],
  successCriteria: [
    {
      criterionId: "b-c1",
      description: "Performance test verifies inject completes in under 100ms p99.",
      verificationMethod: "unit-test",
      required: true,
    },
  ],
  nonGoals: ["Not a production test"],
  stopConditions: ["p99 < 100ms verified"],
  definitionOfDone: "Sprint done when p99 < 100ms.",
  assumptions: [],
  outOfScope: [],
  estimatedFiles: ["src/graph/preflight-injector.ts", "src/graph/client.ts"],
  iterationHistory: [],
  lastEvalId: null,
};

// Warm mocked GraphClient — simulates fast cached responses
function makeWarmClient(): GraphClient {
  return {
    prefetch: vi.fn().mockResolvedValue({
      search: { ok: true, data: [
        { node: { id: "f1", kind: "function", file: "src/graph/preflight-injector.ts", line: 10, symbol: "PreflightContextInjector" }, score: 0.95, snippet: "..." },
        { node: { id: "f2", kind: "function", file: "src/graph/client.ts", line: 5, symbol: "GraphClient" }, score: 0.90, snippet: "..." },
      ], backend: "mcp", durationMs: 0 },
      "callers-of-0": { ok: true, data: [
        { id: "x", kind: "function", file: "src/orchestrator/curator-agent.ts", line: 100, symbol: "runCurator" },
      ], backend: "mcp", durationMs: 0 },
      "callers-of-1": { ok: true, data: [], backend: "mcp", durationMs: 0 },
      "tests-for-curator-0": { ok: true, data: [
        { id: "t", kind: "function", file: "tests/graph/preflight-injector.test.ts", line: 1, symbol: "it" },
      ], backend: "mcp", durationMs: 0 },
      "tests-for-curator-1": { ok: true, data: [], backend: "mcp", durationMs: 0 },
    }),
  } as unknown as GraphClient;
}

function makeGraphConfig() {
  return {
    enabled: true,
    autoSync: true,
    languageTier: "core" as const,
    manifestPath: ".bober/graph/manifest.json",
    syncTimeoutMs: 2000,
    queryTimeoutMs: 5000,
    debounceMs: 750,
    hookQueueMax: 50,
    maxEngineRssMb: 512,
    exposeOnExternalMcp: true,
    preflightBudgets: {
      architect: 4000,
      curator: 2000,
      generator: 1000,
      evaluator: 1500,
      researcherPhase2: 3000,
    },
  };
}

// ── Performance test ──────────────────────────────────────────────

describe("PreflightContextInjector performance (warm)", () => {
  const ITERATIONS = 100;
  const P99_BUDGET_MS = 100;

  it(`p99 inject() completes in <${P99_BUDGET_MS}ms with warm mocked prefetch across ${ITERATIONS} iterations`, async () => {
    const client = makeWarmClient();
    const injector = new PreflightContextInjector(client, makeGraphConfig());

    // Warm-up run to ensure JIT is stable
    await injector.inject("curator", benchContract, "warm-up message");

    const samples: number[] = [];

    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = performance.now();
      await injector.inject("curator", benchContract, `iteration ${i} message`);
      samples.push(performance.now() - t0);
    }

    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(ITERATIONS * 0.5)]!;
    const p95 = samples[Math.floor(ITERATIONS * 0.95)]!;
    const p99 = samples[98]!; // index 98 of 100 sorted = p99
    const max = samples[ITERATIONS - 1]!;

    // Log for diagnostics (won't fail the test)
    console.log(`PreflightContextInjector warm performance over ${ITERATIONS} iterations:`);
    console.log(`  p50=${p50.toFixed(2)}ms  p95=${p95.toFixed(2)}ms  p99=${p99.toFixed(2)}ms  max=${max.toFixed(2)}ms`);

    // The actual assertion: p99 must be under the budget
    expect(p99).toBeLessThan(P99_BUDGET_MS);
  });

  it("all 5 roles complete under performance budget", async () => {
    const roles = ["architect", "curator", "generator", "evaluator", "researcher-phase2"] as const;

    for (const role of roles) {
      const client = makeWarmClient();
      const injector = new PreflightContextInjector(client, makeGraphConfig());

      const samples: number[] = [];
      const ROLE_ITERATIONS = 20; // Fewer per-role for speed

      for (let i = 0; i < ROLE_ITERATIONS; i++) {
        const t0 = performance.now();
        await injector.inject(
          role,
          role === "researcher-phase2" ? null : benchContract,
          "role perf message",
          role === "researcher-phase2" ? { questionKeywords: ["graph", "preflight"] } : undefined,
        );
        samples.push(performance.now() - t0);
      }

      samples.sort((a, b) => a - b);
      const p95 = samples[Math.floor(ROLE_ITERATIONS * 0.95)]!;

      // Each role should be well under budget (p95 < 100ms)
      expect(p95).toBeLessThan(P99_BUDGET_MS);
    }
  });
});
