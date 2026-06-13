import type { ScaffoldResult } from "./scaffolder.js";
import type { ChildSpawnResult } from "./runner.js";
import type { RunState } from "../mcp/run-manager.js";

// ── ChildExecution ────────────────────────────────────────────────────

/** Result of fanning one child through scaffold → run. Produced by FleetCoordinator. */
export interface ChildExecution {
  folder: string;
  scaffold: ScaffoldResult;
  spawn?: ChildSpawnResult;
}

// ── ChildOutcome ──────────────────────────────────────────────────────

export type ChildStatus = "completed" | "failed" | "other";
export type OutcomeSource = "disk" | "exit-code";

/** Resolved status for one child, produced by OutcomeAggregator. */
export interface ChildOutcome {
  folder: string;
  status: ChildStatus;
  source: OutcomeSource;
  exitCode?: number;
  runId?: string;
  runState?: RunState;
}
