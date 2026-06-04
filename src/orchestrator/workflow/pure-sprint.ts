/**
 * Pure (side-effect-free) sprint cycle for the workflow interpreter.
 *
 * The TS pipeline's `runSprintCycle` (pipeline.ts:131) writes contracts, history,
 * and audit checkpoints to `.bober/` inline. The workflow engine makes
 * `RunResultFlusher` the SOLE clock/commit source — so the interpreter needs a
 * sprint cycle that produces a result WITHOUT touching disk. This is that cycle:
 * a generate→evaluate retry loop that returns a {@link SprintOutcome} and writes
 * nothing. The flusher commits it afterward.
 *
 * The curate / generate / evaluate steps are INJECTED ({@link PureSprintDeps}):
 * Sprint 3 ships the loop + its tests with fakes; the real wiring (runCurator /
 * runGenerator / panel evaluator) is attached in the interpreter's default deps
 * (Sprint 5, when eligibility flips). EvalResult timestamps come from the
 * evaluator (real evaluation data) — never synthesized here — so this stays
 * clock-free for the host's history stamping.
 */

import type { SprintContract } from "../../contracts/sprint-contract.js";
import type { EvalResult } from "../../contracts/eval-result.js";
import type { PlanSpec } from "../../contracts/spec.js";
import { reconcile } from "./reconciler.js";

export type SprintOutcomeKind = "passed" | "needs-rework" | "failed";

export interface SprintInput {
  contract: SprintContract;
  spec: PlanSpec;
  /** Max generate→evaluate iterations for this sprint. */
  maxIterations: number;
  /** Contracts that already passed — context for the generator/curator. */
  priorPassed: SprintContract[];
}

export interface SprintOutcome {
  contract: SprintContract;
  finalVerdict: EvalResult;
  iterationsUsed: number;
  outcome: SprintOutcomeKind;
  /** The per-lens verdicts from the final iteration (length >= 1). */
  lensVerdicts: EvalResult[];
}

/** One generation attempt's result (provider-agnostic, side-effect-free). */
export interface GenerationResult {
  /** True if the generator hit a hard blocker it could not resolve. */
  blocked: boolean;
  /** Free-form summary, threaded into the next iteration's feedback. */
  summary: string;
}

export type ReconcileFn = (
  contractId: string,
  iteration: number,
  verdicts: EvalResult[],
  timestamp: string,
) => EvalResult;

export interface PureSprintDeps {
  /** Optional one-shot context curation; returns a briefing string. */
  curate?: (input: SprintInput) => Promise<string>;
  /** Run one generation attempt. `feedback` is empty on the first iteration. */
  generate: (
    input: SprintInput,
    briefing: string,
    feedback: string,
  ) => Promise<GenerationResult>;
  /** Evaluate current state → one or more lens verdicts for this iteration. */
  evaluate: (input: SprintInput, iteration: number) => Promise<EvalResult[]>;
  /** Reduce lens verdicts to one verdict. Defaults to the majority-vote reconciler. */
  reconcile?: ReconcileFn;
}

/** Use a verdict's own timestamp (evaluation data); epoch fallback if none. */
function pickTimestamp(verdicts: EvalResult[]): string {
  return verdicts[0]?.timestamp ?? new Date(0).toISOString();
}

function buildFeedback(verdict: EvalResult, gen: GenerationResult): string {
  return [verdict.feedback, gen.summary]
    .filter((s) => s.length > 0)
    .join("\n");
}

/**
 * Run a single sprint's generate→evaluate retry loop, side-effect-free.
 *
 * Each iteration: (curate once) → generate → evaluate → reconcile. Returns
 * `passed` as soon as a verdict passes (and the generator isn't blocked);
 * `failed` if the generator reports a hard blocker; `needs-rework` if the
 * iteration budget is exhausted without passing.
 */
export async function runPureSprint(
  input: SprintInput,
  deps: PureSprintDeps,
): Promise<SprintOutcome> {
  const reduce = deps.reconcile ?? reconcile;
  const contractId = input.contract.contractId;
  const briefing = deps.curate ? await deps.curate(input) : "";

  const maxIter = Math.max(1, input.maxIterations);
  let feedback = "";
  let lastVerdict: EvalResult | undefined;
  let lastLensVerdicts: EvalResult[] = [];

  for (let iter = 1; iter <= maxIter; iter += 1) {
    const gen = await deps.generate(input, briefing, feedback);
    const lensVerdicts = await deps.evaluate(input, iter);
    lastLensVerdicts = lensVerdicts;

    const verdict =
      lensVerdicts.length === 1 && lensVerdicts[0] !== undefined
        ? lensVerdicts[0]
        : reduce(contractId, iter, lensVerdicts, pickTimestamp(lensVerdicts));
    lastVerdict = verdict;

    if (verdict.passed && !gen.blocked) {
      return {
        contract: input.contract,
        finalVerdict: verdict,
        iterationsUsed: iter,
        outcome: "passed",
        lensVerdicts,
      };
    }

    if (gen.blocked) {
      return {
        contract: input.contract,
        finalVerdict: verdict,
        iterationsUsed: iter,
        outcome: "failed",
        lensVerdicts,
      };
    }

    feedback = buildFeedback(verdict, gen);
  }

  // Iteration budget exhausted without passing → retryable rework.
  const finalVerdict = lastVerdict ?? reduce(contractId, maxIter, [], new Date(0).toISOString());
  return {
    contract: input.contract,
    finalVerdict,
    iterationsUsed: maxIter,
    outcome: "needs-rework",
    lensVerdicts: lastLensVerdicts,
  };
}
