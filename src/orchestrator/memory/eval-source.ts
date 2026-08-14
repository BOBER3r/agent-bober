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

/** An eval-result file {@link loadEvalResultsWithSkips} could not project. */
export interface SkippedEvalFile {
  /** Basename within `.bober/eval-results/`. */
  file: string;
  /** Why it was skipped — unreadable, bad JSON, or not a JSON object. */
  reason: string;
}

/** What {@link loadEvalResultsWithSkips} returns: both halves of the directory. */
export interface EvalResultListing {
  /** Files that projected, sorted by filename. */
  results: DistillableEval[];
  /** Files that did not, sorted by filename. Never silently dropped. */
  skipped: SkippedEvalFile[];
}

/**
 * Load eval results AND the files that could not be read.
 *
 * ── Why both halves ─────────────────────────────────────────────────
 *
 * The same defect `listContractsWithSkips` fixes for `.bober/contracts/`, in
 * the corpus this loader owns. Skipping an unreadable file is right — one bad
 * file must not stop distillation — but skipping it silently means
 * `bober memory distill` reports "distilled N lessons" from a smaller input
 * set than the one on disk, with nothing to indicate the shortfall. A lesson
 * that never got distilled because its eval file was unreadable is
 * indistinguishable, from the outside, from a lesson there was no evidence for.
 *
 * Unlike the contracts corpus (52 of 248 files unreadable when this was
 * written), `.bober/eval-results/` was clean at 234 of 234 — so this closes a
 * LATENT hole rather than an active one. That is the point of doing it now:
 * the skip is only invisible while nothing is being skipped.
 *
 * Note this loader is deliberately LENIENT — it does not validate against
 * `EvalResultSchema` (see the module header), so the only things that can put
 * a file in `skipped` are an unreadable file, unparseable JSON, or JSON that
 * is not an object. Schema drift alone never lands here, by design.
 */
export async function loadEvalResultsWithSkips(
  projectRoot: string,
): Promise<EvalResultListing> {
  const dir = evalResultsDir(projectRoot);

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // Directory doesn't exist yet — no eval results, and nothing was skipped.
    return { results: [], skipped: [] };
  }

  const jsonFiles = entries.filter((f) => f.endsWith(".json")).sort();

  const results: DistillableEval[] = [];
  const skipped: SkippedEvalFile[] = [];

  for (const file of jsonFiles) {
    let content: string;
    try {
      content = await readFile(join(dir, file), "utf-8");
    } catch (err) {
      skipped.push({
        file,
        reason: `unreadable: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      skipped.push({
        file,
        reason: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    const projected = toDistillable(parsed);
    if (projected) {
      results.push(projected);
    } else {
      skipped.push({
        file,
        reason: "not a JSON object — nothing to project onto DistillableEval",
      });
    }
  }

  return { results, skipped };
}

/**
 * Load all eval results from .bober/eval-results/, projected onto DistillableEval.
 *
 * Returns entries sorted by filename for deterministic distill input. A missing
 * directory yields an empty array; unreadable files are skipped. This is the
 * results-only projection of {@link loadEvalResultsWithSkips} — callers that
 * report a count to a human should prefer that one, so a short read is visible
 * rather than being reported as a complete one.
 */
export async function loadEvalResults(
  projectRoot: string,
): Promise<DistillableEval[]> {
  return (await loadEvalResultsWithSkips(projectRoot)).results;
}
