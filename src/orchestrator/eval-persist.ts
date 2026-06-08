/**
 * Persist a sprint evaluation to `.bober/eval-results/` so failures are
 * inspectable after the fact.
 *
 * The standalone TS pipeline previously kept evaluation results only in memory:
 * a sprint could fail with "4/5 evaluators passed. Score: 100/100" and there was
 * no on-disk record of WHICH evaluator (or panel lens) returned `passed: false`.
 * This writes one file per evaluation round capturing the per-evaluator and
 * per-lens verdicts.
 *
 * The file shape is a superset of what `loadEvalResults` (memory/eval-source.ts)
 * leniently reads — it carries `contractId`, `iteration`, `passed`, and
 * `overallResult` for distillation, plus a `results[]` array with the per-lens
 * detail for human debugging.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { EvaluationRunResult } from "../evaluators/registry.js";
import { logger } from "../utils/logger.js";

const EVAL_RESULTS_DIR = ".bober/eval-results";

/**
 * Write an evaluation round to `.bober/eval-results/eval-<contractId>-<iteration>.json`.
 *
 * Best-effort: any failure is logged at debug level and swallowed so persistence
 * never blocks or fails the pipeline. Returns the written path, or `undefined`
 * if the write failed.
 */
export async function persistEvalResult(
  projectRoot: string,
  contractId: string,
  iteration: number,
  evaluation: EvaluationRunResult,
): Promise<string | undefined> {
  try {
    const dir = join(projectRoot, EVAL_RESULTS_DIR);
    await mkdir(dir, { recursive: true });

    const evalId = `${contractId}-${iteration}`;
    const file = join(dir, `eval-${evalId}.json`);

    const payload = {
      evalId,
      contractId,
      iteration,
      passed: evaluation.passed,
      // String mirror of `passed` for the lenient distill reader.
      overallResult: evaluation.passed ? "pass" : "fail",
      score: evaluation.score,
      summary: evaluation.summary,
      timestamp: evaluation.timestamp,
      // Per-evaluator detail — the bit that answers "which evaluator failed?".
      // Only failing evaluators carry their full feedback to keep files lean.
      results: evaluation.results.map((r) => ({
        evaluator: r.evaluator,
        passed: r.passed,
        score: r.score,
        summary: r.summary,
        ...(r.passed ? {} : { feedback: r.feedback }),
        ...(r.lensVerdicts ? { lensVerdicts: r.lensVerdicts } : {}),
        failures: r.details.filter((d) => !d.passed),
      })),
    };

    await writeFile(file, JSON.stringify(payload, null, 2), "utf-8");

    if (!evaluation.passed) {
      const failed = evaluation.results
        .filter((r) => !r.passed)
        .map((r) => r.evaluator);
      logger.info(
        `Eval detail written to ${file}` +
          (failed.length ? ` — failing: ${failed.join(", ")}` : ""),
      );
    } else {
      logger.debug(`Eval detail written to ${file}`);
    }

    return file;
  } catch (err) {
    logger.debug(
      `Could not persist eval result for ${contractId} round ${iteration}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}
