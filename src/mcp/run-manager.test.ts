/**
 * Unit tests for RunManager.
 *
 * The RunManager tracks a single in-memory pipeline run.
 * Tests cover:
 * - Initial state (no run)
 * - isRunning() transitions
 * - startRun() returns a runId immediately and marks state as 'running'
 * - Concurrent run rejection
 * - .then() path: stores 'completed' result
 * - .catch() path: stores 'failed' error
 */

import { describe, it, expect, vi } from "vitest";
import { RunManager } from "./run-manager.js";
import type { PipelineResult } from "../orchestrator/pipeline.js";

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
    it("returns a non-empty runId string immediately", () => {
      const manager = new RunManager();
      // Use a pipeline function that never resolves during this test
      const neverResolves = new Promise<PipelineResult>(() => {/* intentionally hangs */});
      const mockPipeline = vi.fn().mockReturnValue(neverResolves);

      const runId = manager.startRun("build a thing", "/tmp", makeFakeConfig(), mockPipeline);
      expect(typeof runId).toBe("string");
      expect(runId.length).toBeGreaterThan(0);
    });

    it("sets status to 'running' after start", () => {
      const manager = new RunManager();
      const neverResolves = new Promise<PipelineResult>(() => {/* intentionally hangs */});
      const mockPipeline = vi.fn().mockReturnValue(neverResolves);

      manager.startRun("task", "/tmp", makeFakeConfig(), mockPipeline);
      const state = manager.getStatus();

      expect(state).not.toBeNull();
      expect(state!.status).toBe("running");
    });

    it("isRunning() returns true while pipeline is pending", () => {
      const manager = new RunManager();
      const neverResolves = new Promise<PipelineResult>(() => {/* intentionally hangs */});
      const mockPipeline = vi.fn().mockReturnValue(neverResolves);

      manager.startRun("task", "/tmp", makeFakeConfig(), mockPipeline);
      expect(manager.isRunning()).toBe(true);
    });

    it("stores task and startedAt in state", () => {
      const manager = new RunManager();
      const neverResolves = new Promise<PipelineResult>(() => {/* intentionally hangs */});
      const mockPipeline = vi.fn().mockReturnValue(neverResolves);

      const task = "build something cool";
      manager.startRun(task, "/tmp", makeFakeConfig(), mockPipeline);
      const state = manager.getStatus();

      expect(state!.task).toBe(task);
      expect(state!.startedAt).toBeTruthy();
    });

    it("throws when called while already running", () => {
      const manager = new RunManager();
      const neverResolves = new Promise<PipelineResult>(() => {/* intentionally hangs */});
      const mockPipeline = vi.fn().mockReturnValue(neverResolves);

      manager.startRun("first task", "/tmp", makeFakeConfig(), mockPipeline);

      expect(() =>
        manager.startRun("second task", "/tmp", makeFakeConfig(), mockPipeline),
      ).toThrow(/already running/);
    });

    it("error message for concurrent run includes the runId", () => {
      const manager = new RunManager();
      const neverResolves = new Promise<PipelineResult>(() => {/* intentionally hangs */});
      const mockPipeline = vi.fn().mockReturnValue(neverResolves);

      const runId = manager.startRun("first task", "/tmp", makeFakeConfig(), mockPipeline);

      expect(() =>
        manager.startRun("second task", "/tmp", makeFakeConfig(), mockPipeline),
      ).toThrow(new RegExp(runId));
    });
  });

  describe("pipeline completion (.then path)", () => {
    it("transitions to 'completed' when pipeline resolves", async () => {
      const manager = new RunManager();
      const result = makeFakePipelineResult({ success: true });
      const mockPipeline = vi.fn().mockResolvedValue(result);

      manager.startRun("task", "/tmp", makeFakeConfig(), mockPipeline);

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

      manager.startRun("task", "/tmp", makeFakeConfig(), mockPipeline);
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

      manager.startRun("task", "/tmp", makeFakeConfig(), mockPipeline);
      await new Promise((resolve) => setTimeout(resolve, 0));

      const state = manager.getStatus();
      expect(state!.completedAt).toBeTruthy();
    });

    it("isRunning() returns false after pipeline resolves", async () => {
      const manager = new RunManager();
      const mockPipeline = vi.fn().mockResolvedValue(makeFakePipelineResult());

      manager.startRun("task", "/tmp", makeFakeConfig(), mockPipeline);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(manager.isRunning()).toBe(false);
    });
  });

  describe("pipeline failure (.catch path)", () => {
    it("transitions to 'failed' when pipeline rejects", async () => {
      const manager = new RunManager();
      const mockPipeline = vi.fn().mockRejectedValue(new Error("pipeline exploded"));

      manager.startRun("task", "/tmp", makeFakeConfig(), mockPipeline);
      await new Promise((resolve) => setTimeout(resolve, 0));

      const state = manager.getStatus();
      expect(state!.status).toBe("failed");
    });

    it("stores the error message on failure", async () => {
      const manager = new RunManager();
      const errorMessage = "Something went terribly wrong";
      const mockPipeline = vi.fn().mockRejectedValue(new Error(errorMessage));

      manager.startRun("task", "/tmp", makeFakeConfig(), mockPipeline);
      await new Promise((resolve) => setTimeout(resolve, 0));

      const state = manager.getStatus();
      expect(state!.error).toBe(errorMessage);
    });

    it("sets completedAt on failure", async () => {
      const manager = new RunManager();
      const mockPipeline = vi.fn().mockRejectedValue(new Error("boom"));

      manager.startRun("task", "/tmp", makeFakeConfig(), mockPipeline);
      await new Promise((resolve) => setTimeout(resolve, 0));

      const state = manager.getStatus();
      expect(state!.completedAt).toBeTruthy();
    });

    it("isRunning() returns false after pipeline rejects", async () => {
      const manager = new RunManager();
      const mockPipeline = vi.fn().mockRejectedValue(new Error("boom"));

      manager.startRun("task", "/tmp", makeFakeConfig(), mockPipeline);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(manager.isRunning()).toBe(false);
    });

    it("handles non-Error rejections gracefully", async () => {
      const manager = new RunManager();
      const mockPipeline = vi.fn().mockRejectedValue("string rejection");

      manager.startRun("task", "/tmp", makeFakeConfig(), mockPipeline);
      await new Promise((resolve) => setTimeout(resolve, 0));

      const state = manager.getStatus();
      expect(state!.status).toBe("failed");
      expect(state!.error).toBe("string rejection");
    });
  });
});
