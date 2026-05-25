/**
 * Unit tests for bober_abort_run tool.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

import { registerAbortRunTool } from "./abort-run.js";
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
  tmpDir = await mkdtemp(join(tmpdir(), "bober-abort-test-"));
  registerAbortRunTool();
  // Reset the singleton's internal run map to isolate tests
  (runManager as unknown as { runs: Map<string, unknown> }).runs.clear();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────────

describe("bober_abort_run", () => {
  it("is registered with the correct name", () => {
    expect(getTool("bober_abort_run")).toBeDefined();
  });

  it("throws McpError(InvalidRequest) when runId arg is missing", async () => {
    const tool = getTool("bober_abort_run")!;

    await expect(tool.handler({})).rejects.toThrow(McpError);
    await expect(tool.handler({})).rejects.toMatchObject({
      code: ErrorCode.InvalidRequest,
    });
  });

  it("throws McpError(InvalidRequest) when runId is an empty string", async () => {
    const tool = getTool("bober_abort_run")!;

    await expect(tool.handler({ runId: "" })).rejects.toThrow(McpError);
    await expect(tool.handler({ runId: "   " })).rejects.toThrow(McpError);
  });

  it("returns soft-error JSON for an unknown runId", async () => {
    const tool = getTool("bober_abort_run")!;
    const result = JSON.parse(await tool.handler({ runId: "non-existent-id" }));

    expect(result.error).toBe("Run not found: non-existent-id");
  });

  it("flips running run to aborted and returns { runId, status, abortedAt }", async () => {
    const neverResolves = new Promise<PipelineResult>(() => {/* intentionally hangs */});
    const mockPipeline = vi.fn().mockReturnValue(neverResolves);

    const runId = await runManager.startRun("running task", tmpDir, makeFakeConfig(), mockPipeline);

    const tool = getTool("bober_abort_run")!;
    const result = JSON.parse(await tool.handler({ runId, reason: "user stopped it" }));

    expect(result.runId).toBe(runId);
    expect(result.status).toBe("aborted");
    expect(result.abortedAt).toBeTruthy();
  });

  it("uses default reason 'Aborted by user' when reason is not provided", async () => {
    const neverResolves = new Promise<PipelineResult>(() => {/* intentionally hangs */});
    const mockPipeline = vi.fn().mockReturnValue(neverResolves);

    const runId = await runManager.startRun("running task", tmpDir, makeFakeConfig(), mockPipeline);

    const tool = getTool("bober_abort_run")!;
    await tool.handler({ runId });

    const state = runManager.getRun(runId);
    expect(state!.abortReason).toBe("Aborted by user");
  });

  it("subsequent getRun reflects aborted state (atomicity check)", async () => {
    const neverResolves = new Promise<PipelineResult>(() => {/* intentionally hangs */});
    const mockPipeline = vi.fn().mockReturnValue(neverResolves);

    const runId = await runManager.startRun("task", tmpDir, makeFakeConfig(), mockPipeline);

    const tool = getTool("bober_abort_run")!;
    await tool.handler({ runId, reason: "test" });

    const state = runManager.getRun(runId);
    expect(state!.status).toBe("aborted");
    expect(state!.abortReason).toBe("test");
    expect(state!.abortedAt).toBeTruthy();
  });

  it("returns soft-error JSON when run is already completed (not active)", async () => {
    const resolvesPipeline = vi.fn().mockResolvedValue(makeFakePipelineResult());
    const runId = await runManager.startRun("done task", tmpDir, makeFakeConfig(), resolvesPipeline);

    await new Promise((resolve) => setTimeout(resolve, 0));

    const tool = getTool("bober_abort_run")!;
    const result = JSON.parse(await tool.handler({ runId }));

    expect(result.error).toBe("Run is not active");
  });

  it("returns soft-error JSON when run is already failed (not active)", async () => {
    const failPipeline = vi.fn().mockRejectedValue(new Error("pipeline crashed"));
    const runId = await runManager.startRun("fail task", tmpDir, makeFakeConfig(), failPipeline);

    await new Promise((resolve) => setTimeout(resolve, 0));

    const tool = getTool("bober_abort_run")!;
    const result = JSON.parse(await tool.handler({ runId }));

    expect(result.error).toBe("Run is not active");
  });

  it("abort idempotency: aborting an already-aborted run returns soft-error (not active)", async () => {
    const neverResolves = new Promise<PipelineResult>(() => {/* intentionally hangs */});
    const mockPipeline = vi.fn().mockReturnValue(neverResolves);

    const runId = await runManager.startRun("task", tmpDir, makeFakeConfig(), mockPipeline);

    const tool = getTool("bober_abort_run")!;

    // First abort - should succeed
    const first = JSON.parse(await tool.handler({ runId, reason: "first abort" }));
    expect(first.status).toBe("aborted");

    // Second abort - should return soft-error gracefully
    const second = JSON.parse(await tool.handler({ runId, reason: "second abort" }));
    expect(second.error).toBe("Run is not active");

    // State should still reflect the first abort
    const state = runManager.getRun(runId);
    expect(state!.abortReason).toBe("first abort");
  });
});
