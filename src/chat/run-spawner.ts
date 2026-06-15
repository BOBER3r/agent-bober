// ── run-spawner.ts ─────────────────────────────────────────────────────
//
// Launches a DETACHED `agent-bober run <task> --run-id <id>` child that
// survives the REPL exiting. Writes the roster state.json BEFORE spawning
// so the run is visible the same turn; records the pid in a sidecar.

import { execa } from "execa";

import { writeRunState, readRunState } from "../state/run-state.js";
import type { RunState } from "../mcp/run-manager.js";
import { resolveCliEntry } from "../fleet/runner.js";
import { PidSidecar } from "./pid-sidecar.js";

// ── Types ──────────────────────────────────────────────────────────────

export interface StopResult {
  stopped: boolean;
  runId: string;
  killedPid?: number;
  fallbackFlagOnly?: boolean;
}

export interface SpawnAck {
  runId: string;
  task: string;
  pid?: number;
  cwd: string;
  spawnError?: string;
}

/**
 * Injected spawn fn — default wraps execa. Tests pass a fake that records
 * args + returns a fake child without launching a real process.
 */
export type SpawnFn = (
  file: string,
  args: string[],
  options: { cwd: string; detached: boolean; stdio: "ignore" },
) => { pid?: number; unref: () => void };

/** Injected kill function. Defaults to process.kill. Tests pass a fake. */
export type KillFn = (pid: number, signal?: string | number) => void;

export interface RunSpawnerOptions {
  projectRoot: string;
  sessionId: string;
  /** Injected spawn function. Defaults to a thin execa wrapper. */
  spawn?: SpawnFn;
  /** Injected CLI entry path. Defaults to resolveCliEntry(). */
  cliEntry?: string;
  /** Injected Node.js binary path. Defaults to process.execPath. */
  nodeBin?: string;
  /** Injected clock returning ISO string. Defaults to () => new Date().toISOString(). */
  now?: () => string;
  /** Injected kill function. Defaults to process.kill. Tests pass a fake. */
  kill?: KillFn;
}

// ── RunSpawner ─────────────────────────────────────────────────────────

export class RunSpawner {
  private readonly projectRoot: string;
  private readonly sessionId: string;
  private readonly spawnFn: SpawnFn;
  private readonly killFn: KillFn;
  private readonly cliEntry: string;
  private readonly nodeBin: string;
  private readonly now: () => string;
  private readonly sidecar: PidSidecar;

  constructor(opts: RunSpawnerOptions) {
    this.projectRoot = opts.projectRoot;
    this.sessionId = opts.sessionId;
    this.spawnFn =
      opts.spawn ??
      // bober: thin execa wrapper; execa returns a ChildProcess-like w/ .pid and .unref
      ((file, args, options) =>
        execa(file, args, options) as unknown as { pid?: number; unref: () => void });
    this.killFn =
      opts.kill ??
      // bober: default delegates to process.kill; swap for a fake in tests (sc-4-9)
      ((pid, signal) => { process.kill(pid, signal); });
    this.cliEntry = opts.cliEntry ?? resolveCliEntry();
    this.nodeBin = opts.nodeBin ?? process.execPath;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.sidecar = new PidSidecar(this.projectRoot, this.sessionId);
  }

  /**
   * Write the roster state.json, launch a detached child, record the pid,
   * and return an immediate SpawnAck without waiting for the child to finish.
   */
  async spawn(task: string, runId: string): Promise<SpawnAck> {
    const cwd = this.projectRoot;

    // 1. Write roster state.json BEFORE spawning so the run is visible immediately (sc-2-6)
    const state: RunState = {
      runId,
      task,
      status: "running",
      startedAt: this.now(),
      progress: { completed: 0, total: 0 },
      projectRoot: cwd,
    };
    await writeRunState(cwd, state);

    // 2. Launch detached child — do NOT await (sc-2-9, sc-2-6)
    try {
      const child = this.spawnFn(
        this.nodeBin,
        [this.cliEntry, "run", task, "--run-id", runId],
        { cwd, detached: true, stdio: "ignore" },
      );
      child.unref();

      // 3. Record pid in session sidecar (sc-2-7)
      await this.sidecar.record(runId, {
        pid: child.pid,
        task,
        spawnedAt: this.now(),
      });

      return { runId, task, pid: child.pid, cwd };
    } catch (err) {
      return {
        runId,
        task,
        cwd,
        spawnError: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Stop a running run by its runId.
   * Resolves the PID from the session sidecar and sends SIGTERM.
   * If no sidecar entry is found, flips state to 'aborted' on disk only.
   * Tolerates ESRCH (already-dead pid) — treat as already stopped.
   */
  async stop(runId: string, reason: string): Promise<StopResult> {
    const all = await this.sidecar.readAll();
    const entry = all[runId];

    if (entry?.pid !== undefined) {
      // Try to kill the process; tolerate ESRCH (already dead)
      try {
        this.killFn(entry.pid, "SIGTERM");
      } catch {
        // Already gone — not an error (mirrors pipeline-lifecycle.ts:316-320)
      }

      // Flip disk state to aborted
      const s = await readRunState(this.projectRoot, runId);
      if (s) {
        s.status = "aborted";
        s.abortedAt = this.now();
        s.abortReason = reason;
        await writeRunState(this.projectRoot, s);
      }

      return { stopped: true, runId, killedPid: entry.pid };
    }

    // No sidecar entry — fall back to disk-only aborted flip
    const s = await readRunState(this.projectRoot, runId);
    if (s) {
      s.status = "aborted";
      s.abortedAt = this.now();
      s.abortReason = reason;
      await writeRunState(this.projectRoot, s);
      return { stopped: true, runId, fallbackFlagOnly: true };
    }

    // Run not found at all
    return { stopped: false, runId };
  }
}
