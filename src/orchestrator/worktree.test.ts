/**
 * Unit tests for runInWorktree() and deriveWorktreeSlug().
 *
 * Uses a real git fixture repo to verify that worktree commands are
 * actually shelled out to git CLI (not stubbed).
 */

import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { runInWorktree, deriveWorktreeSlug } from "./worktree.js";
import { runManager } from "../mcp/run-manager.js";
import type { PipelineResult } from "./pipeline.js";
import type { BoberConfig } from "../config/schema.js";

// ── Helpers ────────────────────────────────────────────────────────────

let tmpRepo: string;

function makeFakeConfig(overrides: Partial<{ worktreeRoot: string; cleanupWorktreeOnSuccess: boolean }> = {}): BoberConfig {
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
      worktreeRoot: overrides.worktreeRoot ?? ".bober/worktrees",
      cleanupWorktreeOnSuccess: overrides.cleanupWorktreeOnSuccess ?? true,
    },
    commands: {},
  };
}

function makeFakePipelineResult(success = true): PipelineResult {
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

beforeEach(async () => {
  tmpRepo = await mkdtemp(join(tmpdir(), "bober-worktree-test-"));
  // Initialize a real git repo with one commit so worktree commands work
  await execa("git", ["init", "-q", "-b", "main"], { cwd: tmpRepo });
  await execa(
    "git",
    ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
    { cwd: tmpRepo },
  );
  // Reset the singleton's internal run map to isolate tests
  (runManager as unknown as { runs: Map<string, unknown> }).runs.clear();
});

afterEach(async () => {
  await rm(tmpRepo, { recursive: true, force: true });
});

// ── deriveWorktreeSlug ─────────────────────────────────────────────────

describe("deriveWorktreeSlug", () => {
  it("lowercases and replaces non-alphanumeric with dash", () => {
    expect(deriveWorktreeSlug("Add OAuth login!")).toBe("add-oauth-login");
  });

  it("truncates to 60 chars before slugifying", () => {
    const long = "x".repeat(100);
    const result = deriveWorktreeSlug(long);
    expect(result.length).toBeLessThanOrEqual(60);
  });

  it("strips leading and trailing dashes", () => {
    expect(deriveWorktreeSlug("...hello...")).toBe("hello");
  });

  it("falls back to 'run' for empty/all-emoji task", () => {
    expect(deriveWorktreeSlug("")).toBe("run");
    expect(deriveWorktreeSlug("...")).toBe("run");
  });

  it("handles a simple alphanumeric task without modification", () => {
    expect(deriveWorktreeSlug("fix bug")).toBe("fix-bug");
  });
});

// ── runInWorktree ──────────────────────────────────────────────────────

describe("runInWorktree", () => {
  it("creates a git worktree at .bober/worktrees/<runId> on the configured branch", async () => {
    const mockPipeline = vi.fn().mockResolvedValue(makeFakePipelineResult(true));

    const result = await runInWorktree("trivial task", tmpRepo, makeFakeConfig(), {
      pipelineFn: mockPipeline,
      keepOnSuccess: true, // retain for inspection
    });

    expect(result.branch).toMatch(/^bober\/trivial-task/);
    expect(result.worktreePath).toContain(join(tmpRepo, ".bober", "worktrees"));
    expect(result.runId).toBeTruthy();

    // Verify the worktree dir physically existed (the mock pipeline did nothing so
    // cleanup won't have run when keepOnSuccess=true)
    const info = await stat(result.worktreePath);
    expect(info.isDirectory()).toBe(true);
  });

  it("rejects with dirty-files error when working tree has uncommitted changes", async () => {
    await writeFile(join(tmpRepo, "dirty.txt"), "uncommitted");
    await execa("git", ["add", "dirty.txt"], { cwd: tmpRepo });

    await expect(
      runInWorktree("x", tmpRepo, makeFakeConfig(), {
        pipelineFn: vi.fn(),
      }),
    ).rejects.toThrow(/uncommitted changes/);
  });

  it("allowDirty=true bypasses the dirty-tree check", async () => {
    await writeFile(join(tmpRepo, "dirty.txt"), "uncommitted");
    await execa("git", ["add", "dirty.txt"], { cwd: tmpRepo });

    const mockPipeline = vi.fn().mockResolvedValue(makeFakePipelineResult(true));
    const result = await runInWorktree("x", tmpRepo, makeFakeConfig(), {
      pipelineFn: mockPipeline,
      allowDirty: true,
      keepOnSuccess: true,
    });

    expect(result.runId).toBeTruthy();
    expect(result.branch).toContain("bober/x");
  });

  it("populates RunState.worktreePath and RunState.branch", async () => {
    const mockPipeline = vi.fn().mockResolvedValue(makeFakePipelineResult(true));

    const result = await runInWorktree("task", tmpRepo, makeFakeConfig(), {
      pipelineFn: mockPipeline,
      keepOnSuccess: true,
    });

    const state = runManager.getRun(result.runId);
    expect(state).not.toBeNull();
    expect(state!.worktreePath).toBe(result.worktreePath);
    expect(state!.branch).toBe(result.branch);
  });

  it("removes the worktree on success when cleanupWorktreeOnSuccess is true (default)", async () => {
    const mockPipeline = vi.fn().mockImplementation(async () => {
      return makeFakePipelineResult(true);
    });

    const result = await runInWorktree("clean task", tmpRepo, makeFakeConfig(), {
      pipelineFn: mockPipeline,
    });


    // Wait for the fire-and-forget pipeline to complete
    await new Promise<void>((resolve) => {
      const check = async () => {
        const state = runManager.getRun(result.runId);
        if (state && (state.status === "completed" || state.status === "failed")) {
          resolve();
        } else {
          setTimeout(() => { void check(); }, 20);
        }
      };
      void check();
    });

    // After successful completion with cleanupWorktreeOnSuccess=true, directory should be gone
    let exists = true;
    try {
      await stat(result.worktreePath);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it("retains the worktree on failure", async () => {
    const mockPipeline = vi.fn().mockResolvedValue(makeFakePipelineResult(false));

    const result = await runInWorktree("failing task", tmpRepo, makeFakeConfig(), {
      pipelineFn: mockPipeline,
    });

    // Wait for completion
    await new Promise<void>((resolve) => {
      const check = async () => {
        const state = runManager.getRun(result.runId);
        if (state && (state.status === "completed" || state.status === "failed")) {
          resolve();
        } else {
          setTimeout(() => { void check(); }, 20);
        }
      };
      void check();
    });

    // Worktree should be retained on failure
    const info = await stat(result.worktreePath);
    expect(info.isDirectory()).toBe(true);
  });

  it("retains the worktree when keepOnSuccess=true", async () => {
    const mockPipeline = vi.fn().mockResolvedValue(makeFakePipelineResult(true));

    const result = await runInWorktree("keep task", tmpRepo, makeFakeConfig(), {
      pipelineFn: mockPipeline,
      keepOnSuccess: true,
    });

    // Wait for completion
    await new Promise<void>((resolve) => {
      const check = async () => {
        const state = runManager.getRun(result.runId);
        if (state && (state.status === "completed" || state.status === "failed")) {
          resolve();
        } else {
          setTimeout(() => { void check(); }, 20);
        }
      };
      void check();
    });

    const info = await stat(result.worktreePath);
    expect(info.isDirectory()).toBe(true);
  });

  it("pipeline runs inside the worktree (commits land on worktree branch, not main)", async () => {
    let capturedRoot = "";
    const mockPipeline = vi.fn().mockImplementation(async (_t: string, wPath: string) => {
      capturedRoot = wPath;
      // Make a commit inside the worktree to verify isolation
      await writeFile(join(wPath, "commit-test.txt"), "test content");
      await execa("git", ["add", "commit-test.txt"], { cwd: wPath });
      await execa(
        "git",
        ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-m", "worktree commit"],
        { cwd: wPath },
      );
      return makeFakePipelineResult(true);
    });

    const result = await runInWorktree("pipeline root task", tmpRepo, makeFakeConfig(), {
      pipelineFn: mockPipeline,
      keepOnSuccess: true,
    });

    // Wait for completion
    await new Promise<void>((resolve) => {
      const check = async () => {
        const state = runManager.getRun(result.runId);
        if (state && (state.status === "completed" || state.status === "failed")) {
          resolve();
        } else {
          setTimeout(() => { void check(); }, 20);
        }
      };
      void check();
    });

    // Verify pipelineFn was called with the worktree path, not the original projectRoot
    expect(capturedRoot).toBe(result.worktreePath);
    expect(capturedRoot).not.toBe(tmpRepo);

    // Verify the commit landed on the worktree's branch, not main
    const { stdout: mainLog } = await execa("git", ["log", "--oneline", "main"], { cwd: tmpRepo });
    const { stdout: branchLog } = await execa("git", ["log", "--oneline", result.branch], { cwd: tmpRepo });

    // main should only have the init commit
    expect(mainLog.split("\n").length).toBe(1);
    // branch should have the init commit + worktree commit
    expect(branchLog.split("\n").length).toBe(2);
  });

  it("two concurrent worktree runs both succeed on the same repo without conflict", async () => {
    const mockPipeline = vi.fn().mockResolvedValue(makeFakePipelineResult(true));

    const [a, b] = await Promise.all([
      runInWorktree("task one", tmpRepo, makeFakeConfig(), {
        pipelineFn: mockPipeline,
        keepOnSuccess: true,
      }),
      runInWorktree("task two", tmpRepo, makeFakeConfig(), {
        pipelineFn: mockPipeline,
        keepOnSuccess: true,
      }),
    ]);

    expect(a.worktreePath).not.toBe(b.worktreePath);
    expect(a.branch).not.toBe(b.branch);
    expect(a.runId).not.toBe(b.runId);

    // Both worktrees should exist
    const infoA = await stat(a.worktreePath);
    const infoB = await stat(b.worktreePath);
    expect(infoA.isDirectory()).toBe(true);
    expect(infoB.isDirectory()).toBe(true);
  });
});
