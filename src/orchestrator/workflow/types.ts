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

/**
 * The eleven artifact FIELDS the conformance harness compares, named as the sprint-13
 * contract names them (sc-13-2).
 *
 * Separate from {@link ConformanceArtifactName} on purpose: the field is what the harness
 * COLLECTS ("evalResults"), the artifact name is what a diff REPORTS ("eval-result"), and
 * the four original artifact names predate this widening and are consumed by existing
 * callers. Collapsing the two would have renamed `"contract"` to `"contracts"` in every
 * diff a caller already reads.
 */
export const CONFORMANCE_FIELDS = [
  "contracts",
  "history",
  "specs",
  "evalResults",
  "briefings",
  "reviews",
  "audits",
  "progress",
  "runState",
  "completionMarker",
  "pipelineResult",
] as const;

export type ConformanceField = (typeof CONFORMANCE_FIELDS)[number];

/**
 * What a {@link ConformanceDiff} is ABOUT.
 *
 * The first four members are the original set and keep their exact spelling, so a caller
 * matching `d.artifact === "contract"` keeps working across this widening.
 */
export type ConformanceArtifactName =
  | "spec"
  | "contract"
  | "eval-result"
  | "history"
  | "briefing"
  | "review"
  | "audit"
  | "progress"
  | "run-state"
  | "completion-marker"
  | "pipeline-result";

/**
 * One structured divergence between two engines.
 *
 * `path` is the LOCATION of the divergence, not merely the directory the artifact lives
 * in: for a keyed collection it names the element (`.bober/contracts/<contractId>`), so a
 * report says which contract diverged rather than that some contract did.
 */
export type ConformanceDiff = {
  artifact: ConformanceArtifactName;
  path: string;
  engines: PipelineEngineName[];
  /**
   * The harness field this diff came from. REQUIRED, and deliberately so.
   *
   * It was optional until the follow-up to `spec-20260814-pge-full-convergence` sprint 11,
   * and the optionality was the whole hole: every consumer that reasons over the reported
   * DIVERGENCE SET has to narrow `field` before it can use it, and the cheapest narrowing —
   * dropping the diffs that have none — silently converts a reported divergence into an
   * absent one. `report.equivalent` counts diffs, not fields, so the two claims could
   * disagree about the very same report. The sole producer (`EngineConformanceHarness`)
   * always set it; nothing was buying the optionality except that disagreement.
   *
   * `equivalentModuloAcceptedDivergences` still checks membership at runtime rather than
   * trusting this type, because a report can reach it from outside the type system.
   */
  field: ConformanceField;
  /** Human-readable statement of what differed at `path`. */
  detail?: string;
};

/**
 * Per-field population, recorded for every field on every engine.
 *
 * Exists because an equivalence over artifacts that are EMPTY on both sides is not an
 * equivalence at all — it is a comparison of nothing with nothing. The harness reports
 * this rather than inferring it, so a caller can assert "and these fields were actually
 * populated" instead of trusting `equivalent: true`.
 */
export type ConformanceFieldReport = {
  field: ConformanceField;
  artifact: ConformanceArtifactName;
  path: string;
  /** engine name -> whether that engine produced anything for this field. */
  populated: Record<string, boolean>;
  /** engine name -> element count (1/0 for the scalar artifacts). */
  counts: Record<string, number>;
};

export type ConformanceReport = {
  equivalent: boolean;
  diffs: ConformanceDiff[];
  /** One entry per member of {@link CONFORMANCE_FIELDS}, in that order. */
  fields: ConformanceFieldReport[];
  /**
   * True when NOT ONE of the eleven fields was populated for ANY engine.
   *
   * A vacuous comparison can never report `equivalent: true`: two engines that wrote
   * nothing at all are indistinguishable, and calling that conformance would make the
   * gate pass hardest exactly when the runs did least.
   */
  vacuous: boolean;
};
