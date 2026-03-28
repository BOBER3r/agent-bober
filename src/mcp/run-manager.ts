// ── RunManager ───────────────────────────────────────────────────────
//
// Tracks the single active pipeline run in memory.
// bober_run starts a fire-and-forget pipeline; bober_status queries state.

import { randomUUID } from "node:crypto";

import type { BoberConfig } from "../config/schema.js";
import { runPipeline } from "../orchestrator/pipeline.js";
import type { PipelineResult } from "../orchestrator/pipeline.js";

// ── Types ────────────────────────────────────────────────────────────

export interface RunProgress {
  completed: number;
  total: number;
  currentSprint?: string;
  iteration?: number;
}

export interface RunResult {
  success: boolean;
  completedSprints: number;
  failedSprints: number;
  duration: number;
}

export interface RunState {
  runId: string;
  task: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  progress: RunProgress;
  result?: RunResult;
  error?: string;
}

// ── RunManager ───────────────────────────────────────────────────────

export class RunManager {
  private activeRun: RunState | null = null;

  /**
   * Check whether a pipeline is currently running.
   */
  isRunning(): boolean {
    return this.activeRun !== null && this.activeRun.status === "running";
  }

  /**
   * Return the current RunState, or null if no run has ever been started.
   */
  getStatus(): RunState | null {
    return this.activeRun;
  }

  /**
   * Start a new pipeline run as a fire-and-forget promise.
   *
   * Throws if a run is already active (callers should check isRunning first).
   * Returns the new runId immediately.
   *
   * The optional `pipelineFn` parameter exists for testing only. In production
   * it defaults to the real `runPipeline` function.
   */
  startRun(
    task: string,
    projectRoot: string,
    config: BoberConfig,
    pipelineFn: (
      task: string,
      projectRoot: string,
      config: BoberConfig,
    ) => Promise<PipelineResult> = runPipeline,
  ): string {
    if (this.isRunning()) {
      throw new Error(
        `A pipeline is already running (runId: ${this.activeRun!.runId}). Use bober_status to check progress.`,
      );
    }

    const runId = randomUUID();
    const now = new Date().toISOString();

    this.activeRun = {
      runId,
      task,
      status: "running",
      startedAt: now,
      progress: {
        completed: 0,
        total: 0,
      },
    };

    // Fire-and-forget: do NOT await this promise
    const promise: Promise<PipelineResult> = pipelineFn(task, projectRoot, config);

    promise
      .then((result) => {
        if (this.activeRun && this.activeRun.runId === runId) {
          this.activeRun.status = "completed";
          this.activeRun.completedAt = new Date().toISOString();
          this.activeRun.result = {
            success: result.success,
            completedSprints: result.completedSprints.length,
            failedSprints: result.failedSprints.length,
            duration: result.duration,
          };
          this.activeRun.progress = {
            completed: result.completedSprints.length,
            total: result.completedSprints.length + result.failedSprints.length,
          };
        }
      })
      .catch((err: unknown) => {
        if (this.activeRun && this.activeRun.runId === runId) {
          this.activeRun.status = "failed";
          this.activeRun.completedAt = new Date().toISOString();
          this.activeRun.error =
            err instanceof Error ? err.message : String(err);
        }
      });

    return runId;
  }
}

// ── Module-scoped singleton ──────────────────────────────────────────

export const runManager = new RunManager();
