/**
 * Unit tests for bober_list_active_runs tool.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { registerListActiveRunsTool } from "./list-active-runs.js";
import { getTool } from "./registry.js";
import { runManager } from "../run-manager.js";
import type { PipelineResult } from "../../orchestrator/pipeline.js";
import type { BoberConfig } from "../../config/schema.js";

// ── Helpers ──────────────────────────────────────────────────────────

function makeFakeConfig(): BoberConfig {
  return {
    project: { name: "test", mode: "brownfield" as const },
    planner: { maxClarifications: 5, model: "opus" as const },
    generator: {
      model: "sonnet" as const,
      maxTurnsPerSprint: 50,
      autoCommit: false,
      branchPattern: "bober/{feature-name}",
    },
    evaluator: {
      model: "sonnet" as const,
      strategies: [],
      maxIterations: 3,
    },
    sprint: {
      maxSprints: 10,
      requireContracts: true,
      sprintSize: "medium" as const,
    },
    pipeline: {
      maxIterations: 20,
      requireApproval: false,
      contextReset: "always" as const,
    },
    commands: {},
  };
}

function makeFakePipelineResult(overrides?: Partial<PipelineResult>): PipelineResult {
  return {
    success: true,
    spec: {
      id: "spec-1",
      title: "Test spec",
      description: "desc",
      projectType: "api",
      techStack: [],
      features: [],
      nonFunctional: [],
      constraints: [],
      createdAt: new Date().toISOString(),
    },
    completedSprints: [],
    failedSprints: [],
    duration: 1000,
    ...overrides,
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-list-test-"));
  registerListActiveRunsTool();
  // Reset the singleton's internal run map to isolate tests
  (runManager as unknown as { runs: Map<string, unknown> }).runs.clear();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────────

describe("bober_list_active_runs", () => {
  it("is registered with the correct name", () => {
    expect(getTool("bober_list_active_runs")).toBeDefined();
  });

  it("returns an empty array when no runs exist", async () => {
    const tool = getTool("bober_list_active_runs")!;
    const result = JSON.parse(await tool.handler({}));
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it("returns all runs when no status filter is given", async () => {
    const neverResolves = new Promise<PipelineResult>(() => {/* intentionally hangs */});
    const mockPipeline = vi.fn().mockReturnValue(neverResolves);

    await runManager.startRun("task one", tmpDir, makeFakeConfig(), mockPipeline);

    const tool = getTool("bober_list_active_runs")!;
    const result = JSON.parse(await tool.handler({}));
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("running");
    expect(result[0].task).toBe("task one");
  });

  it("filters runs by status='running'", async () => {
    const neverResolves = new Promise<PipelineResult>(() => {/* intentionally hangs */});
    const mockPipeline = vi.fn().mockReturnValue(neverResolves);
    const resolvesPipeline = vi.fn().mockResolvedValue(makeFakePipelineResult());

    await runManager.startRun("running task", tmpDir, makeFakeConfig(), mockPipeline);
    await runManager.startRun("completed task", tmpDir, makeFakeConfig(), resolvesPipeline);

    // Wait for the completed run to resolve
    await new Promise((resolve) => setTimeout(resolve, 0));

    const tool = getTool("bober_list_active_runs")!;
    const result = JSON.parse(await tool.handler({ status: "running" }));
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("running");
  });

  it("filters runs by status='completed'", async () => {
    const resolvesPipeline = vi.fn().mockResolvedValue(makeFakePipelineResult());
    await runManager.startRun("done task", tmpDir, makeFakeConfig(), resolvesPipeline);

    await new Promise((resolve) => setTimeout(resolve, 0));

    const tool = getTool("bober_list_active_runs")!;
    const result = JSON.parse(await tool.handler({ status: "completed" }));
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("completed");
  });

  it("filters runs by status='aborted' after abortRun", async () => {
    const neverResolves = new Promise<PipelineResult>(() => {/* intentionally hangs */});
    const mockPipeline = vi.fn().mockReturnValue(neverResolves);

    const runId = await runManager.startRun("abortable task", tmpDir, makeFakeConfig(), mockPipeline);
    runManager.abortRun(runId, "test abort");

    const tool = getTool("bober_list_active_runs")!;
    const result = JSON.parse(await tool.handler({ status: "aborted" }));
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("aborted");
    expect(result[0].abortReason).toBe("test abort");
  });

  it("filters runs by status='failed'", async () => {
    const failPipeline = vi.fn().mockRejectedValue(new Error("pipeline error"));
    await runManager.startRun("failing task", tmpDir, makeFakeConfig(), failPipeline);

    await new Promise((resolve) => setTimeout(resolve, 0));

    const tool = getTool("bober_list_active_runs")!;
    const result = JSON.parse(await tool.handler({ status: "failed" }));
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("failed");
  });

  it("returns empty array when status filter matches no runs", async () => {
    const resolvesPipeline = vi.fn().mockResolvedValue(makeFakePipelineResult());
    await runManager.startRun("done task", tmpDir, makeFakeConfig(), resolvesPipeline);

    await new Promise((resolve) => setTimeout(resolve, 0));

    const tool = getTool("bober_list_active_runs")!;
    const result = JSON.parse(await tool.handler({ status: "running" }));
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it("returns all runs regardless of status when no filter given", async () => {
    const neverResolves = new Promise<PipelineResult>(() => {/* intentionally hangs */});
    const mockPipeline = vi.fn().mockReturnValue(neverResolves);
    const resolvesPipeline = vi.fn().mockResolvedValue(makeFakePipelineResult());

    const runId1 = await runManager.startRun("running", tmpDir, makeFakeConfig(), mockPipeline);
    await runManager.startRun("completed", tmpDir, makeFakeConfig(), resolvesPipeline);

    await new Promise((resolve) => setTimeout(resolve, 0));

    runManager.abortRun(runId1, "abort");

    const tool = getTool("bober_list_active_runs")!;
    const result = JSON.parse(await tool.handler({}));
    expect(result).toHaveLength(2);
    const statuses = result.map((r: { status: string }) => r.status);
    expect(statuses).toContain("aborted");
    expect(statuses).toContain("completed");
  });
});
