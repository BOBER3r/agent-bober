// ── RunManager ───────────────────────────────────────────────────────
//
// Tracks active and historical pipeline runs in memory, backed by
// per-run state files at .bober/runs/<runId>/state.json.
//
// Back-compat: the singleton `runManager` export, isRunning(), and
// getStatus() preserve existing bober_run / bober_status behavior.
// New callers use keyed methods: getRun(), listActiveRuns(), abortRun(),
// load().

import { randomUUID } from "node:crypto";

import type { BoberConfig } from "../config/schema.js";
import { runPipeline } from "../orchestrator/pipeline.js";
import type { PipelineResult } from "../orchestrator/pipeline.js";
import { writeRunState, listRunStateFiles } from "../state/run-state.js";
import { logger } from "../utils/logger.js";

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
  projectRoot: string;
  specId?: string;
}

// ── RunManager ───────────────────────────────────────────────────────

export class RunManager {
  private runs = new Map<string, RunState>();

  /**
   * Check whether ANY pipeline run is currently in 'running' status.
   *
   * Back-compat: preserves the existing boolean contract used by
   * bober_run and all other tool callers.
   */
  isRunning(): boolean {
    return Array.from(this.runs.values()).some((s) => s.status === "running");
  }

  /**
   * Return the most-recently-started run, or null if no runs exist.
   *
   * Back-compat: when only one run exists this is identical to the
   * old `return this.activeRun` behavior. When multiple runs exist
   * the most-recently-started one is returned (sorted by startedAt desc).
   */
  getStatus(): RunState | null {
    if (this.runs.size === 0) return null;
    let newest: RunState | null = null;
    for (const s of this.runs.values()) {
      if (!newest || s.startedAt > newest.startedAt) {
        newest = s;
      }
    }
    return newest;
  }

  /**
   * Return the RunState for a specific runId, or null if not found.
   */
  getRun(runId: string): RunState | null {
    return this.runs.get(runId) ?? null;
  }

  /**
   * Return all runs currently in 'running' status.
   */
  listActiveRuns(): RunState[] {
    return Array.from(this.runs.values()).filter((s) => s.status === "running");
  }

  /**
   * Abort a run by setting its status to 'failed' with the given reason.
   * Persists the new state to disk (best-effort; logs on failure).
   */
  abortRun(runId: string, reason: string): void {
    const state = this.runs.get(runId);
    if (!state) return;
    state.status = "failed";
    state.completedAt = new Date().toISOString();
    state.error = reason;
    writeRunState(state.projectRoot, state).catch((err: unknown) => {
      logger.warn(
        `[RunManager.abortRun] Failed to persist aborted state for ${runId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }

  /**
   * Start a new pipeline run as a fire-and-forget promise.
   *
   * Does NOT throw when another run is already in progress — concurrent
   * runs are now supported. Callers that want to enforce one-at-a-time
   * behavior should check isRunning() themselves (bober_run tool does
   * this to preserve existing UX).
   *
   * Writes the initial state.json synchronously (await) before returning
   * so disk state is visible immediately after startRun() returns.
   *
   * Returns the new runId.
   *
   * The optional `pipelineFn` parameter exists for testing only.
   */
  async startRun(
    task: string,
    projectRoot: string,
    config: BoberConfig,
    pipelineFn: (
      task: string,
      projectRoot: string,
      config: BoberConfig,
    ) => Promise<PipelineResult> = runPipeline,
  ): Promise<string> {
    const runId = randomUUID();
    const now = new Date().toISOString();

    const state: RunState = {
      runId,
      task,
      status: "running",
      startedAt: now,
      progress: { completed: 0, total: 0 },
      projectRoot,
    };

    this.runs.set(runId, state);

    // Persist initial state synchronously before returning (sc-1-2)
    await writeRunState(projectRoot, state);

    // Fire-and-forget: do NOT await this promise
    const promise: Promise<PipelineResult> = pipelineFn(task, projectRoot, config);

    promise
      .then((result) => {
        const s = this.runs.get(runId);
        if (s) {
          s.status = "completed";
          s.completedAt = new Date().toISOString();
          s.result = {
            success: result.success,
            completedSprints: result.completedSprints.length,
            failedSprints: result.failedSprints.length,
            duration: result.duration,
          };
          s.progress = {
            completed: result.completedSprints.length,
            total: result.completedSprints.length + result.failedSprints.length,
          };
          writeRunState(projectRoot, s).catch((err: unknown) => {
            logger.warn(
              `[RunManager] Failed to persist completed state for ${runId}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          });
        }
      })
      .catch((err: unknown) => {
        const s = this.runs.get(runId);
        if (s) {
          s.status = "failed";
          s.completedAt = new Date().toISOString();
          s.error = err instanceof Error ? err.message : String(err);
          writeRunState(projectRoot, s).catch((writeErr: unknown) => {
            logger.warn(
              `[RunManager] Failed to persist failed state for ${runId}: ${
                writeErr instanceof Error ? writeErr.message : String(writeErr)
              }`,
            );
          });
        }
      });

    return runId;
  }

  /**
   * Load all run state files from .bober/runs/ on startup.
   *
   * Populates the in-memory map from disk. Any run with status='running'
   * is reconciled to status='failed' with error='orchestrator crashed
   * before completion' — it cannot still be running if the process just
   * started.
   *
   * Skips malformed state.json files with a warn log (does not throw).
   */
  async load(projectRoot: string): Promise<void> {
    const states = await listRunStateFiles(projectRoot);
    for (const s of states) {
      if (s.status === "running") {
        s.status = "failed";
        s.completedAt = new Date().toISOString();
        s.error = "orchestrator crashed before completion";
        try {
          await writeRunState(projectRoot, s);
        } catch (err: unknown) {
          logger.warn(
            `[RunManager.load] Failed to persist reconciled state for ${s.runId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      this.runs.set(s.runId, s);
    }
  }
}

// ── Module-scoped singleton ──────────────────────────────────────────

export const runManager = new RunManager();
