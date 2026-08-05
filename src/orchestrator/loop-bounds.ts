// ── loop-bounds.ts ───────────────────────────────────────────────────
//
// Enforced maxima for the LIVE cyclic paths.
//
// Every loop that can burn budget must exit by a CONFIGURED maximum and must
// say so when it does — a silent `break` is indistinguishable from a normal
// finish in the logs, so a runaway retry loop is only visible on the invoice.
//
// The shape follows the existing Scheduler.maxAgents → AgentCapError precedent
// (workflow/scheduler.ts): a named error plus an emitted event, never a silent
// break. The difference is WHO throws: the scheduler's cap is a hard invariant,
// while the sprint retry loop's exhaustion is an expected outcome that already
// has a defined result (`needs-rework`). Throwing there would change what a run
// does, so on that path the bound emits the event and returns as before, and
// LoopBoundExceededError is reserved for callers that genuinely cannot continue.

import type { BoberConfig } from "../config/schema.js";
import { emit } from "../telemetry/emit.js";
import { logger } from "../utils/logger.js";

// ── Loop identity ────────────────────────────────────────────────────

/**
 * Closed set of bounded cyclic paths. Enum-only by construction so the value is
 * safe to place in telemetry (see the privacy note in telemetry/emit.ts).
 */
export const LOOP_IDS = ["sprint-retry", "pure-sprint"] as const;
export type LoopId = (typeof LOOP_IDS)[number];

/** Everything known at the moment a loop exits because it hit its bound. */
export interface LoopBoundInfo {
  loopId: LoopId;
  /** The configured maximum this loop read (never a hardcoded literal). */
  maxIterations: number;
  /** Iterations actually executed. Equals maxIterations on a bounded exit. */
  iterationsUsed: number;
  /** Contract/sprint the loop was working on, when there is one. */
  contractId?: string;
  /** Run the loop belongs to, when there is one. */
  runId?: string;
}

// ── Named error ──────────────────────────────────────────────────────

/**
 * Raised by callers for whom exhausting the bound is unrecoverable.
 *
 * Mirrors AgentCapError (workflow/scheduler.ts): named, carries the numbers,
 * and is distinguishable from an arbitrary failure by `instanceof`.
 */
export class LoopBoundExceededError extends Error {
  readonly loopId: LoopId;
  readonly maxIterations: number;
  readonly iterationsUsed: number;

  constructor(info: LoopBoundInfo) {
    super(
      `Loop '${info.loopId}' exhausted its configured maximum of ${info.maxIterations} iteration(s)` +
        (info.contractId ? ` on ${info.contractId}` : ""),
    );
    this.name = "LoopBoundExceededError";
    this.loopId = info.loopId;
    this.maxIterations = info.maxIterations;
    this.iterationsUsed = info.iterationsUsed;
  }
}

// ── Bounded-exit event ───────────────────────────────────────────────

/**
 * Record a bounded exit: one warning line plus one `loop-bound-exhausted`
 * telemetry event through the existing emit() helper (never a direct
 * history.jsonl write — the terminal history stream is finalize.ts's).
 *
 * Never throws: emit() already swallows its own IO failures, and a telemetry
 * problem must not be able to change a run's outcome.
 */
export async function emitLoopBoundExhausted(
  projectRoot: string,
  config: BoberConfig,
  info: LoopBoundInfo,
): Promise<void> {
  logger.warn(
    `Loop '${info.loopId}' exited by bound after ${info.iterationsUsed}/${info.maxIterations} iteration(s)` +
      (info.contractId ? ` on ${info.contractId}` : "") +
      ".",
  );
  await emit(projectRoot, config, "loop-bound-exhausted", {
    loopId: info.loopId,
    limit: info.maxIterations,
    iteration: info.iterationsUsed,
    ...(info.contractId ? { contractId: info.contractId, sprintId: info.contractId } : {}),
    ...(info.runId ? { runId: info.runId } : {}),
  });
}
