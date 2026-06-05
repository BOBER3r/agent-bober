/**
 * Workflow interpreter — the live body of the (currently dormant) WorkflowEngine
 * invoke() seam.
 *
 * Reproduces the TS pipeline's plan → sprint-loop orchestration as PURE
 * computation: it produces a {@link WorkflowRunResult} and writes nothing.
 * `RunResultFlusher.flush()` commits the result afterward (the sole clock/commit
 * source). Plan / contract-derivation / sprint-cycle are injected
 * ({@link WorkflowDeps}) so the interpreter is hermetically testable; the real
 * agent wiring (default deps) and the invoke() rewire + eligibility flip land in
 * Sprint 5.
 *
 * Resume: contracts whose `sprintNumber` is in `args.resumeCursor.completed-
 * SprintNumbers` are filtered out BEFORE dispatch, so the result only contains
 * newly-run sprints — the flusher then appends only their history (no
 * double-write on re-run).
 */

import type { WorkflowArgs, WorkflowRunResult } from "./types.js";
import type { PlanSpec } from "../../contracts/spec.js";
import type { SprintContract } from "../../contracts/sprint-contract.js";
import type { HistoryEntry } from "../../state/history.js";
import { Scheduler } from "./scheduler.js";
import type { SprintInput, SprintOutcome } from "./pure-sprint.js";

type PendingHistory = Omit<HistoryEntry, "timestamp">;

export interface PlanResult {
  spec: PlanSpec;
  needsClarification: boolean;
}

export interface WorkflowDeps {
  /** Produce or load the plan spec for the run. */
  plan: (args: WorkflowArgs, projectRoot: string) => Promise<PlanResult>;
  /** Derive sprint contracts from a spec (used when preloadedContracts is empty). */
  buildContracts: (spec: PlanSpec, args: WorkflowArgs) => SprintContract[];
  /** Run one sprint's pure (side-effect-free) generate→evaluate cycle. */
  runSprint: (input: SprintInput) => Promise<SprintOutcome>;
}

export interface RunWorkflowOptions {
  /**
   * Scheduler used to run the sprint loop. Defaults to a sequential scheduler
   * (maxConcurrent 1) for TS-pipeline parity. Sprint 5 raises the cap and adds
   * dependsOn-aware ordering for true cross-sprint parallelism.
   */
  scheduler?: Scheduler;
}

/**
 * Run the workflow: plan → derive contracts → (skip completed) → sprint loop →
 * aggregate into a {@link WorkflowRunResult}. Writes nothing.
 */
export async function runWorkflow(
  args: WorkflowArgs,
  projectRoot: string,
  deps: WorkflowDeps,
  opts: RunWorkflowOptions = {},
): Promise<WorkflowRunResult> {
  const scheduler = opts.scheduler ?? new Scheduler({ maxConcurrent: 1 });
  const pendingHistory: PendingHistory[] = [];

  // ── Plan (or reuse preloaded spec on resume) ───────────────────────
  let spec: PlanSpec;
  let needsClarification = false;
  if (args.preloadedSpec) {
    spec = args.preloadedSpec;
  } else {
    const planned = await deps.plan(args, projectRoot);
    spec = planned.spec;
    needsClarification = planned.needsClarification;
  }

  pendingHistory.push({
    event: "workflow-planning-complete",
    phase: "planning",
    details: { specId: spec.specId },
  });

  if (needsClarification) {
    pendingHistory.push({
      event: "planning-needs-clarification",
      phase: "planning",
      details: { specId: spec.specId },
    });
    return { spec, perSprint: [], needsClarification: true, pendingHistory };
  }

  // ── Contracts (preloaded on resume, else derived from the spec) ────
  const allContracts =
    args.preloadedContracts.length > 0
      ? args.preloadedContracts
      : deps.buildContracts(spec, args);

  const capped = allContracts.slice(
    0,
    Math.min(allContracts.length, args.knobs.maxSprints),
  );

  // ── Skip-completed (resume) — filter BEFORE dispatch ───────────────
  const completed = new Set(args.resumeCursor.completedSprintNumbers);
  const pending = capped.filter((c) => !completed.has(c.sprintNumber));

  // ── Sprint loop (scheduler-bounded; results index-aligned) ─────────
  const outcomes = await scheduler.parallel(
    pending.map((contract) => () =>
      deps.runSprint({
        contract,
        spec,
        maxIterations: args.knobs.maxIterations,
        priorPassed: [],
      }),
    ),
  );

  const perSprint = outcomes.map((o) => ({
    contract: o.contract,
    finalVerdict: o.finalVerdict,
    iterationsUsed: o.iterationsUsed,
    outcome: o.outcome,
    lensVerdicts: o.lensVerdicts,
  }));

  for (const o of outcomes) {
    pendingHistory.push({
      event: "workflow-sprint-evaluated",
      phase: o.outcome === "passed" ? "complete" : "evaluating",
      sprintId: o.contract.contractId,
      details: { outcome: o.outcome, iterations: o.iterationsUsed },
    });
  }

  const allPassed = perSprint.length > 0 && perSprint.every((p) => p.outcome === "passed");
  pendingHistory.push({
    event: "workflow-complete",
    phase: allPassed ? "complete" : "failed",
    details: {
      total: perSprint.length,
      passed: perSprint.filter((p) => p.outcome === "passed").length,
      failed: perSprint.filter((p) => p.outcome !== "passed").length,
    },
  });

  return { spec, perSprint, needsClarification: false, pendingHistory };
}
