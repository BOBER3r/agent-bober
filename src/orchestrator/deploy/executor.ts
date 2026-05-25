/**
 * Default executor seam for the deploy module (Sprint 20).
 *
 * Production code uses defaultExecutor (execa wrapper).
 * Tests inject a fake ExecutorSeam to avoid real shell execution.
 *
 * Every Bash command the deployer sends MUST route through this seam.
 * The seam runs AFTER classifyCommand() approves the command — the
 * classification gate is the caller's responsibility (see execute.ts).
 *
 * Pattern mirrors src/orchestrator/tools/handlers.ts:70 (execa usage).
 */

import { execa } from "execa";
import type { ExecutorSeam } from "./types.js";

/**
 * Default execa-backed executor.
 *
 * Runs the command via `sh -c <command>`. Captures stdout, stderr, exitCode.
 * Does NOT reject on non-zero exit code (reject: false) — the caller in
 * execute.ts decides whether a non-zero exit is a failure.
 */
export const defaultExecutor: ExecutorSeam = {
  async run(command: string) {
    const r = await execa("sh", ["-c", command], { reject: false });
    return {
      exitCode: r.exitCode ?? 1,
      stdout: r.stdout,
      stderr: r.stderr,
    };
  },
};
