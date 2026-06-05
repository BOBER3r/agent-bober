/**
 * Lenient loader for .bober/eval-results/*.json, used to feed distill().
 *
 * This is the IMPURE counterpart to the pure distill() function: it touches the
 * filesystem. It deliberately does NOT validate against the compiled EvalResultSchema,
 * because the on-disk eval-result files use a richer shape
 * ({ overallResult, strategyResults, criteriaResults }) than the compiled schema
 * ({ passed, details, criteriaResults? }). We read every file leniently and project
 * only the fields distill consumes, so distillation is robust to schema drift.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import type { DistillableEval } from "./distill.js";

const EVAL_RESULTS_DIR = ".bober/eval-results";

function evalResultsDir(projectRoot: string): string {
  return join(projectRoot, EVAL_RESULTS_DIR);
}

/** Narrow an unknown value to a string-keyed record. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Project a raw parsed JSON object onto the lenient DistillableEval shape. */
function toDistillable(raw: unknown): DistillableEval | null {
  if (!isRecord(raw)) return null;

  const out: DistillableEval = {};

  if (typeof raw["evalId"] === "string") out.evalId = raw["evalId"];
  if (typeof raw["contractId"] === "string") out.contractId = raw["contractId"];
  if (typeof raw["iteration"] === "number") out.iteration = raw["iteration"];
  if (typeof raw["overallResult"] === "string") out.overallResult = raw["overallResult"];
  if (typeof raw["passed"] === "boolean") out.passed = raw["passed"];

  if (Array.isArray(raw["criteriaResults"])) {
    out.criteriaResults = raw["criteriaResults"]
      .filter(isRecord)
      .map((c) => ({
        criterionId: typeof c["criterionId"] === "string" ? c["criterionId"] : undefined,
        result: typeof c["result"] === "string" ? c["result"] : undefined,
        verificationMethod:
          typeof c["verificationMethod"] === "string" ? c["verificationMethod"] : undefined,
      }));
  }

  if (Array.isArray(raw["strategyResults"])) {
    out.strategyResults = raw["strategyResults"]
      .filter(isRecord)
      .map((s) => ({
        strategy: typeof s["strategy"] === "string" ? s["strategy"] : undefined,
        result: typeof s["result"] === "string" ? s["result"] : undefined,
      }));
  }

  return out;
}

/**
 * Load all eval results from .bober/eval-results/, projected onto DistillableEval.
 *
 * Returns entries sorted by filename for deterministic distill input. A missing
 * directory yields an empty array; malformed JSON files are skipped silently
 * (mirrors listContracts' skip-on-bad-file behaviour).
 */
export async function loadEvalResults(
  projectRoot: string,
): Promise<DistillableEval[]> {
  const dir = evalResultsDir(projectRoot);

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // Directory doesn't exist yet — no eval results.
    return [];
  }

  const jsonFiles = entries.filter((f) => f.endsWith(".json")).sort();

  const results: DistillableEval[] = [];
  for (const file of jsonFiles) {
    try {
      const content = await readFile(join(dir, file), "utf-8");
      const parsed: unknown = JSON.parse(content);
      const projected = toDistillable(parsed);
      if (projected) results.push(projected);
    } catch {
      // Skip malformed files.
    }
  }

  return results;
}
