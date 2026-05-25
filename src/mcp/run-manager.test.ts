/**
 * Unit tests for RunManager.
 *
 * The RunManager tracks pipeline runs in memory, backed by
 * per-run state files at .bober/runs/<runId>/state.json.
 *
 * Tests cover:
 * - Initial state (no run)
 * - isRunning() transitions
 * - startRun() returns a runId and persists state to disk
 * - Concurrent runs (no longer throws)
 * - .then() path: stores 'completed' result + persists
 * - .catch() path: stores 'failed' error + persists
 * - getRun(), listActiveRuns(), abortRun()
 * - load() reconciles orphaned 'running' entries to 'failed'
 * - Back-compat shims: isRunning() / getStatus()
 */

import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { RunManager } from "./run-manager.js";
import { writeRunState } from "../state/run-state.js";
import type { PipelineResult } from "../orchestrator/pipeline.js";
import type { RunState } from "./run-manager.js";

// ── Disk fixture ──────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-runmanager-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Helpers ──────────────────────────────────────────────────────────

function makeFakeConfig() {
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

function stateFilePath(runId: string): string {
  return join(tmpDir, ".bober", "runs", runId, "state.json");
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("RunManager", () => {
  describe("initial state", () => {
    it("returns null from getStatus() when no run has started", () => {
      const manager = new RunManager();
      expect(manager.getStatus()).toBeNull();
    });

    it("returns false from isRunning() when no run has started", () => {
      const manager = new RunManager();
      expect(manager.isRunning()).toBe(false);
    });
  });

  describe("startRun()", () => {
    it("returns a non-empty runId string immediately", async () => {
      const manager = new RunManager();
      const neverResolves = new Promise<PipelineResult>(() => {/* intentionally hangs */});
      const mockPipeline = vi.fn().mockReturnValue(neverResolves);

      const runId = await manager.startRun("build a thing", tmpDir, makeFakeConfig(), mockPipeline);
      expect(typeof runId).toBe("string");
      expect(runId.length).toBeGreaterThan(0);
    });

    it("sets status to 'running' after start", async () => {
      const manager = new RunManager();
      const neverResolves = new Promise<PipelineResult>(() => {/* intentionally hangs */});
      const mockPipeline = vi.fn().mockReturnValue(neverResolves);

      await manager.startRun("task", tmpDir, makeFakeConfig(), mockPipeline);
      const state = manager.getStatus();

      expect(state).not.toBeNull();
      expect(state!.status).toBe("running");
    });

    it("isRunning() returns true while pipeline is pending", async () => {
      const manager = new RunManager();
      const neverResolves = new Promise<PipelineResult>(() => {/* intentionally hangs */});
      const mockPipeline = vi.fn().mockReturnValue(neverResolves);

      await manager.startRun("task", tmpDir, makeFakeConfig(), mockPipeline);
      expect(manager.isRunning()).toBe(true);
    });

    it("stores task and startedAt in state", async () => {
      const manager = new RunManager();
      const neverResolves = new Promise<PipelineResult>(() => {/* intentionally hangs */});
      const mockPipeline = vi.fn().mockReturnValue(neverResolves);

      const task = "build something cool";
      await manager.startRun(task, tmpDir, makeFakeConfig(), mockPipeline);
      const state = manager.getStatus();

      expect(state!.task).toBe(task);
      expect(state!.startedAt).toBeTruthy();
    });

    it("two concurrent startRun calls succeed without throwing (sc-1-5 concurrent)", async () => {
      const manager = new RunManager();
      const neverResolves = new Promise<PipelineResult>(() => {/* intentionally hangs */});
      const mockPipeline = vi.fn().mockReturnValue(neverResolves);

      // Both must succeed — no throw
      const [runId1, runId2] = await Promise.all([
        manager.startRun("first task", tmpDir, makeFakeConfig(), mockPipeline),
        manager.startRun("second task", tmpDir, makeFakeConfig(), mockPipeline),
      ]);

      expect(typeof runId1).toBe("string");
      expect(typeof runId2).toBe("string");
      expect(runId1).not.toBe(runId2);
      expect(manager.isRunning()).toBe(true);
    });
  });

  describe("sc-1-2: state.json on disk synchronously after startRun", () => {
    it("state.json exists immediately when startRun returns", async () => {
      const manager = new RunManager();
      const neverResolves = new Promise<PipelineResult>(() => {/* intentionally hangs */});
      const mockPipeline = vi.fn().mockReturnValue(neverResolves);

      const runId = await manager.startRun("task", tmpDir, makeFakeConfig(), mockPipeline);

      // No awaiting needed — state.json must be on disk synchronously
      const info = await stat(stateFilePath(runId));
      expect(info.isFile()).toBe(true);
    });

    it("state.json contains required fields: runId, task, status, startedAt, progress, projectRoot", async () => {
      const manager = new RunManager();
      const neverResolves = new Promise<PipelineResult>(() => {/* intentionally hangs */});
      const mockPipeline = vi.fn().mockReturnValue(neverResolves);

      const runId = await manager.startRun("check fields", tmpDir, makeFakeConfig(), mockPipeline);

      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(stateFilePath(runId), "utf-8");
      const parsed = JSON.parse(raw) as RunState;

      expect(parsed.runId).toBe(runId);
      expect(parsed.task).toBe("check fields");
      expect(parsed.status).toBe("running");
      expect(parsed.startedAt).toBeTruthy();
      expect(parsed.progress).toMatchObject({ completed: 0, total: 0 });
      expect(parsed.projectRoot).toBe(tmpDir);
    });
  });

  describe("sc-1-3: post-resolution disk state matches in-memory", () => {
    it("state.json transitions to 'completed' after pipeline resolves", async () => {
      const manager = new RunManager();
      const result = makeFakePipelineResult({ success: true });
      const mockPipeline = vi.fn().mockResolvedValue(result);

      const runId = await manager.startRun("task", tmpDir, makeFakeConfig(), mockPipeline);

      // Flush .then microtask + allow persistence write
      await new Promise((resolve) => setTimeout(resolve, 50));

      const state = manager.getStatus();
      expect(state!.status).toBe("completed");

      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(stateFilePath(runId), "utf-8");
      const parsed = JSON.parse(raw) as RunState;
      expect(parsed.status).toBe("completed");
      expect(parsed.result).toMatchObject({ success: true });
    });

    it("state.json transitions to 'failed' after pipeline rejects", async () => {
      const manager = new RunManager();
      const mockPipeline = vi.fn().mockRejectedValue(new Error("pipeline exploded"));

      const runId = await manager.startRun("task", tmpDir, makeFakeConfig(), mockPipeline);

      await new Promise((resolve) => setTimeout(resolve, 50));

      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(stateFilePath(runId), "utf-8");
      const parsed = JSON.parse(raw) as RunState;
      expect(parsed.status).toBe("failed");
      expect(parsed.error).toBe("pipeline exploded");
    });
  });

  describe("pipeline completion (.then path)", () => {
    it("transitions to 'completed' when pipeline resolves", async () => {
      const manager = new RunManager();
      const result = makeFakePipelineResult({ success: true });
      const mockPipeline = vi.fn().mockResolvedValue(result);

      await manager.startRun("task", tmpDir, makeFakeConfig(), mockPipeline);

      // Allow microtasks to flush
      await new Promise((resolve) => setTimeout(resolve, 0));

      const state = manager.getStatus();
      expect(state!.status).toBe("completed");
    });

    it("stores result with completedSprints and failedSprints counts", async () => {
      const manager = new RunManager();
      const result = makeFakePipelineResult({
        success: true,
        completedSprints: [
          { id: "c1", feature: "f1", description: "", status: "passed", successCriteria: [], startedAt: "", completedAt: "" },
        ],
        failedSprints: [],
        duration: 5000,
      });
      const mockPipeline = vi.fn().mockResolvedValue(result);

      await manager.startRun("task", tmpDir, makeFakeConfig(), mockPipeline);
      await new Promise((resolve) => setTimeout(resolve, 0));

      const state = manager.getStatus();
      expect(state!.result).toMatchObject({
        success: true,
        completedSprints: 1,
        failedSprints: 0,
        duration: 5000,
      });
    });

    it("sets completedAt when pipeline resolves", async () => {
      const manager = new RunManager();
      const mockPipeline = vi.fn().mockResolvedValue(makeFakePipelineResult());

      await manager.startRun("task", tmpDir, makeFakeConfig(), mockPipeline);
      await new Promise((resolve) => setTimeout(resolve, 0));

      const state = manager.getStatus();
      expect(state!.completedAt).toBeTruthy();
    });

    it("isRunning() returns false after pipeline resolves", async () => {
      const manager = new RunManager();
      const mockPipeline = vi.fn().mockResolvedValue(makeFakePipelineResult());

      await manager.startRun("task", tmpDir, makeFakeConfig(), mockPipeline);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(manager.isRunning()).toBe(false);
    });
  });

  describe("pipeline failure (.catch path)", () => {
    it("transitions to 'failed' when pipeline rejects", async () => {
      const manager = new RunManager();
      const mockPipeline = vi.fn().mockRejectedValue(new Error("pipeline exploded"));

      await manager.startRun("task", tmpDir, makeFakeConfig(), mockPipeline);

      // Allow microtasks to flush
      await new Promise((resolve) => setTimeout(resolve, 0));

      const state = manager.getStatus();
      expect(state!.status).toBe("failed");
    });

    it("stores the error message on failure", async () => {
      const manager = new RunManager();
      const errorMessage = "Something went terribly wrong";
      const mockPipeline = vi.fn().mockRejectedValue(new Error(errorMessage));

      await manager.startRun("task", tmpDir, makeFakeConfig(), mockPipeline);
      await new Promise((resolve) => setTimeout(resolve, 0));

      const state = manager.getStatus();
      expect(state!.error).toBe(errorMessage);
    });

    it("sets completedAt on failure", async () => {
      const manager = new RunManager();
      const mockPipeline = vi.fn().mockRejectedValue(new Error("boom"));

      await manager.startRun("task", tmpDir, makeFakeConfig(), mockPipeline);
      await new Promise((resolve) => setTimeout(resolve, 0));

      const state = manager.getStatus();
      expect(state!.completedAt).toBeTruthy();
    });

    it("isRunning() returns false after pipeline rejects", async () => {
      const manager = new RunManager();
      const mockPipeline = vi.fn().mockRejectedValue(new Error("boom"));

      await manager.startRun("task", tmpDir, makeFakeConfig(), mockPipeline);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(manager.isRunning()).toBe(false);
    });

    it("handles non-Error rejections gracefully", async () => {
      const manager = new RunManager();
      const mockPipeline = vi.fn().mockRejectedValue("string rejection");

      await manager.startRun("task", tmpDir, makeFakeConfig(), mockPipeline);
      await new Promise((resolve) => setTimeout(resolve, 0));

      const state = manager.getStatus();
      expect(state!.status).toBe("failed");
      expect(state!.error).toBe("string rejection");
    });
  });

  describe("sc-1-1: new methods — getRun, listActiveRuns, abortRun", () => {
    it("getRun returns the RunState for a known runId", async () => {
      const manager = new RunManager();
      const neverResolves = new Promise<PipelineResult>(() => {/* intentionally hangs */});
      const mockPipeline = vi.fn().mockReturnValue(neverResolves);

      const runId = await manager.startRun("task", tmpDir, makeFakeConfig(), mockPipeline);
      const state = manager.getRun(runId);

      expect(state).not.toBeNull();
      expect(state!.runId).toBe(runId);
      expect(state!.status).toBe("running");
    });

    it("getRun returns null for an unknown runId", () => {
      const manager = new RunManager();
      expect(manager.getRun("non-existent-run-id")).toBeNull();
    });

    it("listActiveRuns returns only runs with status='running'", async () => {
      const manager = new RunManager();
      const neverResolves = new Promise<PipelineResult>(() => {/* intentionally hangs */});
      const mockPipeline = vi.fn().mockReturnValue(neverResolves);
      const resolvesPipeline = vi.fn().mockResolvedValue(makeFakePipelineResult());

      // Start two: one that never resolves, one that completes
      await manager.startRun("active task", tmpDir, makeFakeConfig(), mockPipeline);
      await manager.startRun("completed task", tmpDir, makeFakeConfig(), resolvesPipeline);

      await new Promise((resolve) => setTimeout(resolve, 0));

      const active = manager.listActiveRuns();
      expect(active).toHaveLength(1);
      expect(active[0].task).toBe("active task");
    });

    it("abortRun sets status to 'aborted' with the given reason", async () => {
      const manager = new RunManager();
      const neverResolves = new Promise<PipelineResult>(() => {/* intentionally hangs */});
      const mockPipeline = vi.fn().mockReturnValue(neverResolves);

      const runId = await manager.startRun("task", tmpDir, makeFakeConfig(), mockPipeline);

      manager.abortRun(runId, "user requested abort");

      const state = manager.getRun(runId);
      expect(state!.status).toBe("aborted");
      expect(state!.abortReason).toBe("user requested abort");
      expect(state!.abortedAt).toBeTruthy();
    });

    it("abortRun is a no-op for unknown runIds", () => {
      const manager = new RunManager();
      // Should not throw
      expect(() => manager.abortRun("non-existent", "reason")).not.toThrow();
    });

    it("listAllRuns returns all runs regardless of status", async () => {
      const manager = new RunManager();
      const neverResolves = new Promise<PipelineResult>(() => {/* intentionally hangs */});
      const mockPipeline = vi.fn().mockReturnValue(neverResolves);
      const resolvesPipeline = vi.fn().mockResolvedValue(makeFakePipelineResult());

      // Start two runs: one stays running, one completes
      const runId1 = await manager.startRun("active task", tmpDir, makeFakeConfig(), mockPipeline);
      await manager.startRun("completed task", tmpDir, makeFakeConfig(), resolvesPipeline);

      await new Promise((resolve) => setTimeout(resolve, 0));

      // Abort the first run
      manager.abortRun(runId1, "test abort");

      const all = manager.listAllRuns();
      expect(all).toHaveLength(2);
      const statuses = all.map((s) => s.status);
      expect(statuses).toContain("aborted");
      expect(statuses).toContain("completed");
    });
  });

  describe("sc-1-4: load() reconciles orphaned 'running' entries", () => {
    it("flips orphaned 'running' entries to 'failed' on load", async () => {
      const orphanState: RunState = {
        runId: "orphan-run-123",
        task: "crashed task",
        status: "running",
        startedAt: new Date(Date.now() - 60000).toISOString(),
        progress: { completed: 2, total: 10 },
        projectRoot: tmpDir,
      };

      // Write an orphaned 'running' state to disk as if from a previous crash
      await writeRunState(tmpDir, orphanState);

      const manager = new RunManager();
      await manager.load(tmpDir);

      const state = manager.getRun(orphanState.runId);
      expect(state).not.toBeNull();
      expect(state!.status).toBe("failed");
      expect(state!.error).toBe("orchestrator crashed before completion");
      expect(state!.completedAt).toBeTruthy();
    });

    it("does not modify already-completed entries on load", async () => {
      const completedState: RunState = {
        runId: "completed-run-456",
        task: "done task",
        status: "completed",
        startedAt: new Date(Date.now() - 60000).toISOString(),
        completedAt: new Date(Date.now() - 30000).toISOString(),
        progress: { completed: 5, total: 5 },
        projectRoot: tmpDir,
        result: { success: true, completedSprints: 5, failedSprints: 0, duration: 30000 },
      };

      await writeRunState(tmpDir, completedState);

      const manager = new RunManager();
      await manager.load(tmpDir);

      const state = manager.getRun(completedState.runId);
      expect(state!.status).toBe("completed");
    });

    it("populates the in-memory map from disk on load", async () => {
      const states: RunState[] = [
        { runId: "run-a", task: "task A", status: "completed", startedAt: new Date().toISOString(), progress: { completed: 1, total: 1 }, projectRoot: tmpDir },
        { runId: "run-b", task: "task B", status: "failed", startedAt: new Date().toISOString(), progress: { completed: 0, total: 1 }, projectRoot: tmpDir, error: "exploded" },
      ];

      for (const s of states) {
        await writeRunState(tmpDir, s);
      }

      const manager = new RunManager();
      await manager.load(tmpDir);

      expect(manager.getRun("run-a")).not.toBeNull();
      expect(manager.getRun("run-b")).not.toBeNull();
    });

    it("returns empty state when .bober/runs/ does not exist (fresh project)", async () => {
      const manager = new RunManager();
      // Should not throw even if .bober/runs/ directory is absent
      await expect(manager.load(tmpDir)).resolves.toBeUndefined();
      expect(manager.getStatus()).toBeNull();
    });

    it("persists the reconciled 'failed' state to disk after load", async () => {
      const orphanState: RunState = {
        runId: "orphan-persist-run",
        task: "task",
        status: "running",
        startedAt: new Date().toISOString(),
        progress: { completed: 0, total: 0 },
        projectRoot: tmpDir,
      };
      await writeRunState(tmpDir, orphanState);

      const manager = new RunManager();
      await manager.load(tmpDir);

      // The disk state should also be updated to 'failed'
      const { readRunState } = await import("../state/run-state.js");
      const diskState = await readRunState(tmpDir, orphanState.runId);
      expect(diskState!.status).toBe("failed");
      expect(diskState!.error).toBe("orchestrator crashed before completion");
    });
  });

  describe("sc-1-5: back-compat shims — isRunning and getStatus", () => {
    it("isRunning() returns true when ANY run has status='running'", async () => {
      const manager = new RunManager();
      const neverResolves = new Promise<PipelineResult>(() => {/* intentionally hangs */});
      const resolvesPipeline = vi.fn().mockResolvedValue(makeFakePipelineResult());

      // One completed run, one still running
      await manager.startRun("first task", tmpDir, makeFakeConfig(), vi.fn().mockReturnValue(neverResolves));
      await manager.startRun("second task", tmpDir, makeFakeConfig(), resolvesPipeline);

      // Let second complete
      await new Promise((resolve) => setTimeout(resolve, 0));

      // First is still running
      expect(manager.isRunning()).toBe(true);
    });

    it("getStatus() returns the most-recently-started run", async () => {
      const manager = new RunManager();
      const neverResolves = new Promise<PipelineResult>(() => {/* intentionally hangs */});
      const mockPipeline = vi.fn().mockReturnValue(neverResolves);

      await manager.startRun("older task", tmpDir, makeFakeConfig(), mockPipeline);
      // Small delay to ensure different startedAt timestamps
      await new Promise((resolve) => setTimeout(resolve, 10));
      const runId2 = await manager.startRun("newer task", tmpDir, makeFakeConfig(), mockPipeline);

      const status = manager.getStatus();
      expect(status).not.toBeNull();
      expect(status!.runId).toBe(runId2);
      expect(status!.task).toBe("newer task");
    });

    it("single startRun followed by getStatus returns the same data (single-run back-compat)", async () => {
      const manager = new RunManager();
      const neverResolves = new Promise<PipelineResult>(() => {/* intentionally hangs */});
      const mockPipeline = vi.fn().mockReturnValue(neverResolves);

      const runId = await manager.startRun("my task", tmpDir, makeFakeConfig(), mockPipeline);
      const state = manager.getStatus();

      expect(state).not.toBeNull();
      expect(state!.runId).toBe(runId);
      expect(state!.task).toBe("my task");
      expect(state!.status).toBe("running");
    });
  });
});
