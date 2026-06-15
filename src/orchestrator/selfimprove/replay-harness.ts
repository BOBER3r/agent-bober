/**
 * PURE deterministic regression gate for the replay corpus.
 *
 * PURE — compareToBaseline must not import from ../providers; no network, no
 * Date.now(), no side effects, no filesystem access. All inputs are parameters.
 * Fresh verdicts are re-derived from frozen eval_details_json — NOT by
 * re-running the generator or evaluator LLM.
 *
 * Regression / improvement classification:
 *   baseline 'pass' + fresh 'fail' → regression
 *   baseline 'fail' + fresh 'pass' → improvement
 *   same verdict                   → unchanged
 *
 * A regression is STRICTLY pass→fail. CaseIds present only in fresh (not in
 * baseline) are not classified at all — the baseline corpus defines the gate.
 *
 * Fresh-verdict derivation rule (deterministic, no LLM):
 *   Parse evalDetailsJson (JSON array of result objects). The fresh verdict is
 *   'fail' iff any element's failures[] contains an entry with
 *   passed === false AND severity === 'error'. Otherwise 'pass'.
 *   Malformed / missing fields → treated as 'pass' (no error-severity failure).
 */

import { join } from "node:path";

import type { BoberConfig } from "../../config/schema.js";
import { ReplayStore } from "./replay-store.js";

// ── Types ─────────────────────────────────────────────────────────────

export type Verdict = "pass" | "fail";

export interface ReplayComparison {
  /** caseIds where baseline was 'pass' and fresh is 'fail'. */
  regressions: string[];
  /** caseIds where baseline was 'fail' and fresh is 'pass'. */
  improvements: string[];
  /** caseIds where verdict did not change. */
  unchanged: string[];
}

/** Extended comparison result returned by runReplayHarness. */
export interface ReplayHarnessResult extends ReplayComparison {
  /** Total number of cases in the corpus. */
  total: number;
  /** Fresh verdicts keyed by caseId (for CLI table rendering). */
  fresh: Map<string, Verdict>;
  /** Baseline verdicts keyed by caseId (for CLI table rendering). */
  baseline: Map<string, Verdict>;
}

// ── Helpers ───────────────────────────────────────────────────────────

/** Lenient record narrowing — mirrors distill.ts:83-85. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ── PURE: compareToBaseline ───────────────────────────────────────────

/**
 * PURE comparator. Classifies each caseId present in `baseline` as regression,
 * improvement, or unchanged based on the transition of verdict.
 *
 * PURE — no clock, no fs, no LLM. All inputs are parameters.
 *
 * @param baseline  Map<caseId, Verdict> from the captured corpus.
 * @param fresh     Map<caseId, Verdict> re-derived from frozen evalDetailsJson.
 * @returns         Sorted arrays for deterministic, byte-identical output.
 */
export function compareToBaseline(
  baseline: Map<string, Verdict>,
  fresh: Map<string, Verdict>,
): ReplayComparison {
  const regressions: string[] = [];
  const improvements: string[] = [];
  const unchanged: string[] = [];

  for (const [caseId, baselineVerdict] of baseline) {
    // CaseIds absent from fresh use the baseline verdict (treat as unchanged).
    const freshVerdict = fresh.get(caseId) ?? baselineVerdict;

    if (baselineVerdict === "pass" && freshVerdict === "fail") {
      regressions.push(caseId);
    } else if (baselineVerdict === "fail" && freshVerdict === "pass") {
      improvements.push(caseId);
    } else {
      unchanged.push(caseId);
    }
  }

  // Sort for deterministic, byte-identical output — mirrors distill.ts:286.
  regressions.sort((a, b) => a.localeCompare(b));
  improvements.sort((a, b) => a.localeCompare(b));
  unchanged.sort((a, b) => a.localeCompare(b));

  return { regressions, improvements, unchanged };
}

// ── Fresh-verdict derivation (deterministic, NO LLM) ─────────────────

/**
 * Re-derive a single fresh verdict from the frozen evalDetailsJson string.
 *
 * Rule: parse the JSON array; verdict is 'fail' iff any element's failures[]
 * contains an entry with passed === false AND severity === 'error'.
 * Any malformed / absent field is treated permissively → 'pass'.
 *
 * @param evalDetailsJson  JSON.stringify(payload.results) captured at record time.
 */
function deriveFreshVerdict(evalDetailsJson: string): Verdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(evalDetailsJson);
  } catch {
    return "pass"; // Malformed JSON → no error-severity failure found.
  }

  if (!Array.isArray(parsed)) {
    return "pass";
  }

  for (const element of parsed) {
    if (!isRecord(element)) continue;

    const failures = element["failures"];
    if (!Array.isArray(failures)) continue;

    for (const detail of failures) {
      if (!isRecord(detail)) continue;

      if (detail["passed"] === false && detail["severity"] === "error") {
        return "fail";
      }
    }
  }

  return "pass";
}

// ── async: runReplayHarness ───────────────────────────────────────────

/**
 * Open the Sprint-1 ReplayStore, re-derive fresh verdicts deterministically
 * from each case's frozen evalDetailsJson, and return a regression/improvement
 * breakdown via compareToBaseline.
 *
 * NEVER re-runs the generator or evaluator LLM — fresh verdicts come only from
 * the frozen captured eval_details_json (the deterministic fresh-verdict rule).
 *
 * @param projectRoot  Absolute path to the project root.
 * @param config       Already-loaded BoberConfig. config.selfImprove is OPTIONAL.
 */
export async function runReplayHarness(
  projectRoot: string,
  config: BoberConfig,
): Promise<ReplayHarnessResult> {
  // bober: default replayDir so missing selfImprove section is non-fatal.
  const replayDir = config.selfImprove?.replayDir ?? ".bober/replay";
  const dbPath = join(projectRoot, replayDir, "replay.db");

  const store = new ReplayStore(dbPath);
  try {
    const cases = store.listCases();
    const total = cases.length;

    const baseline = new Map<string, Verdict>();
    const fresh = new Map<string, Verdict>();

    for (const record of cases) {
      baseline.set(record.caseId, record.baselineVerdict);
      fresh.set(record.caseId, deriveFreshVerdict(record.evalDetailsJson));
    }

    const comparison = compareToBaseline(baseline, fresh);
    return { ...comparison, total, baseline, fresh };
  } finally {
    store.close();
  }
}
