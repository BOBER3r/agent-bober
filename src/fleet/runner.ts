import { execa } from "execa";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ── Entry resolution (ADR-4) ─────────────────────────────────────────
// At runtime this file is dist/fleet/runner.js → CLI is dist/cli/index.js.
// From dirname(runner.js) = dist/fleet, go ".." to dist, then "cli/index.js".

export function resolveCliEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // dist/fleet
  return join(here, "..", "cli", "index.js"); // dist/cli/index.js
}

// ── Types ────────────────────────────────────────────────────────────

export interface ChildRunSpec {
  cwd: string;
  task: string;
  timeoutMs?: number;
}

export interface ChildSpawnResult {
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  spawnError?: string;
}

// ── Constants ────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const MAX_BUFFER = 10 * 1024 * 1024; // 10 MiB

// ── Version probe (ADR-4) ────────────────────────────────────────────

/**
 * Probe the CLI binary for a successful --version response.
 * Returns true if the entry file responds with exitCode 0, false otherwise.
 * Never throws.
 */
export async function probeCliVersion(cliEntry: string): Promise<boolean> {
  try {
    const r = await execa(process.execPath, [cliEntry, "--version"], {
      reject: false,
      timeout: 5_000,
    });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

// ── Runner ───────────────────────────────────────────────────────────

export class ChildRunner {
  /**
   * Optional override for the CLI entry path.
   * Production code leaves this undefined (defaults to resolveCliEntry()).
   * Tests inject the stub fixture path via the constructor to avoid
   * requiring a built dist/cli/index.js during unit testing.
   */
  private readonly _cliEntry?: string;

  /**
   * Optional override for the Node.js binary path.
   * Production code leaves this undefined (defaults to process.execPath).
   * Tests may inject a bad path to exercise the spawn-failure / ENOENT path.
   */
  private readonly _nodeBin?: string;

  constructor(options?: { cliEntry?: string; nodeBin?: string }) {
    this._cliEntry = options?.cliEntry;
    this._nodeBin = options?.nodeBin;
  }

  /**
   * Spawn one `agent-bober run <task>` child process in spec.cwd.
   * Uses process.execPath (the current Node binary) + the parent's own
   * dist/cli/index.js — never a bare PATH lookup.
   *
   * Never throws: spawn errors are captured in spawnError.
   */
  async run(spec: ChildRunSpec): Promise<ChildSpawnResult> {
    const cliEntry = this._cliEntry ?? resolveCliEntry();
    const nodeBin = this._nodeBin ?? process.execPath;
    const timeout = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    try {
      const result = await execa(
        nodeBin,
        [cliEntry, "run", spec.task],
        {
          cwd: spec.cwd,
          reject: false,
          timeout,
          maxBuffer: MAX_BUFFER,
        },
      );

      // With reject:false, execa resolves even on spawn-level failures (e.g. ENOENT).
      // Detect a spawn failure by checking whether exitCode is absent and the process
      // did not actually start (originalMessage contains the spawn error details).
      if (result.exitCode === undefined && result.failed && result.originalMessage) {
        return {
          cwd: spec.cwd,
          exitCode: null,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
          spawnError: result.originalMessage,
        };
      }

      const spawnResult: ChildSpawnResult = {
        cwd: spec.cwd,
        exitCode: result.exitCode ?? null,
        stdout: result.stdout,
        stderr: result.stderr,
      };
      if (result.timedOut) {
        spawnResult.timedOut = true;
      }
      return spawnResult;
    } catch (err) {
      // Fallback: if execa throws despite reject:false (older execa versions)
      return {
        cwd: spec.cwd,
        exitCode: null,
        stdout: "",
        stderr: "",
        spawnError: (err as Error).message,
      };
    }
  }
}
