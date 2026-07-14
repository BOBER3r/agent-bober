/**
 * Test-gap (cadence) analyzer — flags biomarkers overdue for re-testing.
 *
 * PURE except store reads. NO network / NO LLM / NO Date.now().
 * All timestamps are injected parameters; the wall clock is read ONLY at the CLI boundary.
 *
 * ADR-3: RECOMMENDED_CADENCE_DAYS is a CLOSED code-reviewed table (mirror of NumericPrimitive
 * at src/medical/types.ts:142). Extending it is a code-review event, not a runtime decision.
 * Biomarkers ABSENT from the table are SKIPPED — no guessed cadence (sc-4-3).
 */

import type { HealthDataStore } from "../health-store.js";
import { findingId } from "./finding.js";
import type { MedicalFinding } from "./finding.js";

// -- CLOSED cadence table -------------------------------------------------

/**
 * Recommended re-test cadence in days, keyed by biomarker.
 * Extending this is a code-review event (mirror NumericPrimitive at types.ts:142).
 * Biomarkers absent here are SKIPPED — no guessed cadence (sc-4-3).
 */
export const RECOMMENDED_CADENCE_DAYS: Readonly<Record<string, number>> = {
  ldl: 365,
  hba1c: 180,
  tsh: 365,
  vitamin_d: 365,
  ferritin: 365,
};

const MS_PER_DAY = 86_400_000;

// -- Internal helper ------------------------------------------------------

function makeGapFinding(
  biomarker: string,
  cadenceDays: number,
  ageDays: number,
  now: string,
): MedicalFinding {
  return {
    id: findingId("medical", biomarker, "cadence-gap"),
    domain: "medical",
    title: `${biomarker}: re-test overdue (recommended every ${cadenceDays} days)`,
    kind: "question",
    urgency: 2,
    severity: 2,
    evidence: [
      `${biomarker} was last tested ${Math.floor(ageDays)} days ago`,
      `Recommended re-test cadence: every ${cadenceDays} days`,
    ],
    surfacedAt: now,
    tags: ["cadence-gap", biomarker],
    status: "open",
  };
}

// -- Public API -----------------------------------------------------------

/**
 * Detect biomarkers that are overdue for re-testing based on the CLOSED cadence table.
 *
 * PURE except store reads. NO network / NO LLM / NO Date.now(). 'now' is injected.
 * Biomarkers absent from RECOMMENDED_CADENCE_DAYS are SKIPPED (sc-4-3).
 *
 * @param store      HealthDataStore (caller owns lifecycle)
 * @param biomarkers List of biomarker names to check
 * @param opts       { now: ISO 8601 injected timestamp }
 */
export function detectTestGaps(
  store: HealthDataStore,
  biomarkers: string[],
  opts: { now: string },
): MedicalFinding[] {
  const findings: MedicalFinding[] = [];
  for (const biomarker of biomarkers) {
    const cadenceDays = RECOMMENDED_CADENCE_DAYS[biomarker];
    if (cadenceDays === undefined) continue; // (b) CLOSED — skip unknown

    const series = store.getLabSeries(biomarker); // ASC by collected_at
    const latest = series[series.length - 1];
    if (latest === undefined) continue; // no data → no gap

    const ageDays = (Date.parse(opts.now) - Date.parse(latest.collectedAtIso)) / MS_PER_DAY;
    if (ageDays > cadenceDays) {
      findings.push(makeGapFinding(biomarker, cadenceDays, ageDays, opts.now));
    }
  }
  return findings;
}
