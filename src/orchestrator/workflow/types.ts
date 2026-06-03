// ── Workflow host types ─────────────────────────────────────────────

import type { PlanSpec } from "../../contracts/spec.js";
import type { SprintContract } from "../../contracts/sprint-contract.js";
import type { EvalResult } from "../../contracts/eval-result.js";
import type { HistoryEntry } from "../../state/history.js";
import type { PipelineEngineName } from "./engine.js";

// Re-export PipelineEngineName from its single source of truth
export type { PipelineEngineName } from "./engine.js";

// ── WorkflowArgs ────────────────────────────────────────────────────

export type WorkflowArgs = {
  userPrompt: string;
  knobs: {
    maxIterations: number;
    maxSprints: number;
    researchPhase: boolean;
    architectPhase: boolean;
    curatorEnabled: boolean;
    codeReviewEnabled: boolean;
    requireContracts: boolean;
  };
  models: { planner: string; curator: string; generator: string; evaluator: string };
  evaluatorLenses: string[];
  principles: string;
  preloadedSpec?: PlanSpec;
  preloadedContracts: SprintContract[];
  resumeCursor: ResumeCursor;
};

// ── WorkflowRunResult ───────────────────────────────────────────────

export type WorkflowRunResult = {
  spec: PlanSpec;
  perSprint: Array<{
    contract: SprintContract;
    finalVerdict: EvalResult;
    iterationsUsed: number;
    outcome: "passed" | "needs-rework" | "failed";
    lensVerdicts: EvalResult[];
  }>;
  needsClarification: boolean;
  pendingHistory: Array<Omit<HistoryEntry, "timestamp">>;
};

// ── ResumeCursor ────────────────────────────────────────────────────

export type ResumeCursor = {
  specId: string;
  completedSprintNumbers: number[];
  lastObservedSprintNumber: number;
};

// ── ConformanceReport ───────────────────────────────────────────────

export type ConformanceReport = {
  equivalent: boolean;
  diffs: Array<{
    artifact: "spec" | "contract" | "eval-result" | "history";
    path: string;
    engines: PipelineEngineName[];
  }>;
};
