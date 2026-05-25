/**
 * Unit tests for bober_get_run_status tool.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

import { registerGetRunStatusTool } from "./get-run-status.js";
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
      eventQueueBound: 1000,
    },
    commands: {},
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-get-run-test-"));
  registerGetRunStatusTool();
  // Reset the singleton's internal run map to isolate tests
  (runManager as unknown as { runs: Map<string, unknown> }).runs.clear();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────────

describe("bober_get_run_status", () => {
  it("is registered with the correct name", () => {
    expect(getTool("bober_get_run_status")).toBeDefined();
  });

  it("returns full RunState JSON for a known runId", async () => {
    const neverResolves = new Promise<PipelineResult>(() => {/* intentionally hangs */});
    const mockPipeline = vi.fn().mockReturnValue(neverResolves);

    const runId = await runManager.startRun("my task", tmpDir, makeFakeConfig(), mockPipeline);

    const tool = getTool("bober_get_run_status")!;
    const result = JSON.parse(await tool.handler({ runId }));

    expect(result.runId).toBe(runId);
    expect(result.status).toBe("running");
    expect(result.task).toBe("my task");
    expect(result.startedAt).toBeTruthy();
    expect(result.progress).toMatchObject({ completed: 0, total: 0 });
  });

  it("returns soft-error JSON for an unknown runId", async () => {
    const tool = getTool("bober_get_run_status")!;
    const result = JSON.parse(await tool.handler({ runId: "non-existent-id" }));

    expect(result.error).toBe("Run not found: non-existent-id");
  });

  it("throws McpError(InvalidRequest) when runId arg is missing", async () => {
    const tool = getTool("bober_get_run_status")!;

    await expect(tool.handler({})).rejects.toThrow(McpError);
    await expect(tool.handler({})).rejects.toMatchObject({
      code: ErrorCode.InvalidRequest,
    });
  });

  it("throws McpError(InvalidRequest) when runId is an empty string", async () => {
    const tool = getTool("bober_get_run_status")!;

    await expect(tool.handler({ runId: "" })).rejects.toThrow(McpError);
    await expect(tool.handler({ runId: "   " })).rejects.toThrow(McpError);
  });

  it("throws McpError(InvalidRequest) when runId is not a string", async () => {
    const tool = getTool("bober_get_run_status")!;

    await expect(tool.handler({ runId: 123 })).rejects.toThrow(McpError);
  });

  it("returns aborted run state correctly", async () => {
    const neverResolves = new Promise<PipelineResult>(() => {/* intentionally hangs */});
    const mockPipeline = vi.fn().mockReturnValue(neverResolves);

    const runId = await runManager.startRun("abort task", tmpDir, makeFakeConfig(), mockPipeline);
    runManager.abortRun(runId, "stopped by user");

    const tool = getTool("bober_get_run_status")!;
    const result = JSON.parse(await tool.handler({ runId }));

    expect(result.runId).toBe(runId);
    expect(result.status).toBe("aborted");
    expect(result.abortReason).toBe("stopped by user");
    expect(result.abortedAt).toBeTruthy();
  });
});
