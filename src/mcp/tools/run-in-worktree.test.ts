/**
 * Unit tests for bober_run_in_worktree MCP tool.
 *
 * Tests focus on: registration, input validation, and field passthrough
 * via the RunManager. The runInWorktree helper is tested in detail in
 * src/orchestrator/worktree.test.ts using real git fixtures.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execa } from "execa";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { registerRunInWorktreeTool } from "./run-in-worktree.js";
import { getTool } from "./registry.js";
import { runManager } from "../run-manager.js";
import type { BoberConfig } from "../../config/schema.js";
import type { PipelineResult } from "../../orchestrator/pipeline.js";

// ── Helpers ────────────────────────────────────────────────────────────

// makeFakePipelineResult used in neverResolves patterns below
function _makeFakePipelineResult(success = true): PipelineResult {
  return {
    success,
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
  };
}

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
      worktreeRoot: ".bober/worktrees",
      cleanupWorktreeOnSuccess: true,
    },
    commands: {},
  };
}

// ── Fixtures ────────────────────────────────────────────────────────────

let tmpRepo: string;

beforeEach(async () => {
  tmpRepo = await mkdtemp(join(tmpdir(), "bober-run-in-worktree-test-"));
  // Initialize a real git repo with one commit
  await execa("git", ["init", "-q", "-b", "main"], { cwd: tmpRepo });
  await execa(
    "git",
    ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
    { cwd: tmpRepo },
  );
  registerRunInWorktreeTool();
  // Reset the singleton's internal run map to isolate tests
  (runManager as unknown as { runs: Map<string, unknown> }).runs.clear();
});

afterEach(async () => {
  await rm(tmpRepo, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────

describe("bober_run_in_worktree", () => {
  it("is registered with the correct name", () => {
    expect(getTool("bober_run_in_worktree")).toBeDefined();
  });

  it("returns soft-error JSON when task is empty string", async () => {
    const tool = getTool("bober_run_in_worktree")!;
    const result = JSON.parse(await tool.handler({ task: "" }));
    expect(result.error).toBeTruthy();
    expect(result.error).toContain("task is required");
  });

  it("returns soft-error JSON when task is missing (undefined)", async () => {
    const tool = getTool("bober_run_in_worktree")!;
    // task will be undefined → String(undefined).trim() = "" → soft error
    const result = JSON.parse(await tool.handler({}));
    expect(result.error).toBeTruthy();
  });

  it("RunState populated by startRun with worktreePath and branch reflects in getRun()", async () => {
    // Test that startRun with opts properly populates worktreePath and branch in state.
    // This validates sc-4-5 without needing a real git repo worktree.
    const neverResolves = new Promise<PipelineResult>(() => {/* intentionally hangs */});
    const mockPipeline = vi.fn().mockReturnValue(neverResolves);

    const manager = runManager;
    const runId = await manager.startRun(
      "test task",
      tmpRepo,
      makeFakeConfig(),
      mockPipeline,
      {
        runId: "pre-computed-id",
        worktreePath: "/tmp/worktrees/pre-computed-id",
        branch: "bober/test-task",
      },
    );

    expect(runId).toBe("pre-computed-id");
    const state = manager.getRun(runId);
    expect(state).not.toBeNull();
    expect(state!.worktreePath).toBe("/tmp/worktrees/pre-computed-id");
    expect(state!.branch).toBe("bober/test-task");
    expect(state!.status).toBe("running");
  });

  it("RunState with worktreePath and branch appears in getRun output (sc-4-7 reflection)", async () => {
    // Verify that bober_get_run_status (via getRun) surfaces worktreePath and branch
    const neverResolves = new Promise<PipelineResult>(() => {/* intentionally hangs */});
    const mockPipeline = vi.fn().mockReturnValue(neverResolves);

    await runManager.startRun(
      "worktree task",
      tmpRepo,
      makeFakeConfig(),
      mockPipeline,
      {
        runId: "wt-run-id",
        worktreePath: "/tmp/.bober/worktrees/wt-run-id",
        branch: "bober/worktree-task",
      },
    );

    const state = runManager.getRun("wt-run-id");
    expect(state).not.toBeNull();
    expect(state!.worktreePath).toBe("/tmp/.bober/worktrees/wt-run-id");
    expect(state!.branch).toBe("bober/worktree-task");

    // Simulate what bober_get_run_status returns
    const json = JSON.stringify(state);
    const parsed = JSON.parse(json);
    expect(parsed.worktreePath).toBe("/tmp/.bober/worktrees/wt-run-id");
    expect(parsed.branch).toBe("bober/worktree-task");
  });

  it("does not include worktreePath/branch in RunState for in-place runs (regression guard)", async () => {
    const neverResolves = new Promise<PipelineResult>(() => {/* intentionally hangs */});
    const mockPipeline = vi.fn().mockReturnValue(neverResolves);

    // No opts passed — simulates existing bober_run behavior
    const runId = await runManager.startRun(
      "normal task",
      tmpRepo,
      makeFakeConfig(),
      mockPipeline,
    );

    const state = runManager.getRun(runId);
    expect(state).not.toBeNull();
    expect(state!.worktreePath).toBeUndefined();
    expect(state!.branch).toBeUndefined();
  });
});
