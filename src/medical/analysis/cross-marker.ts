/**
 * Cross-marker pattern detector — OFFERS a dig-deeper finding when related markers are both OOR.
 *
 * PURE except store reads. NO LLM / NO network / NO Date.now().
 * All timestamps are injected parameters; the wall clock is read ONLY at the CLI boundary.
 *
 * ADR-3: CROSS_MARKER_PAIRS is a CLOSED code-reviewed list (mirror of NumericPrimitive
 * at src/medical/types.ts:142). Extending it is a code-review event, not a runtime decision.
 *
 * The offer finding persists its marker pair in tags (["cross-marker", a, b]) so the
 * dig-deeper path can recover the pair from the note frontmatter (sc-4-6).
 */

import type { HealthDataStore } from "../health-store.js";
import { findingId } from "./finding.js";
import type { MedicalFinding } from "./finding.js";

// -- CLOSED cross-marker pairs table ---------------------------------------

/**
 * Closed list of related-marker pairs (code-review to extend).
 * When BOTH markers are out of reference range, an offer Finding is emitted.
 */
export const CROSS_MARKER_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["ldl", "triglycerides"],
  ["hba1c", "triglycerides"],
];

// -- Internal helpers -----------------------------------------------------

/**
 * True when the marker's LATEST result is outside [referenceLow, referenceHigh].
 * Returns false when no data is available (missing series → cannot be OOR).
 */
function isOutOfRange(store: HealthDataStore, marker: string): boolean {
  const series = store.getLabSeries(marker);
  const latest = series[series.length - 1];
  if (latest === undefined) return false;
  const { value, referenceLow, referenceHigh } = latest;
  if (referenceHigh !== undefined && value > referenceHigh) return true;
  if (referenceLow !== undefined && value < referenceLow) return true;
  return false;
}

function makeOfferFinding(a: string, b: string, now: string): MedicalFinding {
  return {
    id: findingId("medical", a, `cross-marker-${a}-${b}`),
    domain: "medical",
    title: `Cross-marker pattern: ${a} and ${b} both out of reference range — want me to dig deeper?`,
    kind: "question",
    urgency: 2,
    severity: 2,
    evidence: [
      `${a} is outside its reference range`,
      `${b} is outside its reference range`,
      `Both ${a} and ${b} being out of range may indicate a combined pattern worth investigating`,
    ],
    surfacedAt: now,
    // (c) INVARIANT: tags carry the marker pair in positions 1+ for dig-deeper recovery (sc-4-6)
    tags: ["cross-marker", a, b],
    status: "open",
  };
}

// -- Public API -----------------------------------------------------------

/**
 * Detect cross-marker patterns and OFFER (not auto-run) deeper analysis.
 *
 * PURE except store reads. NO LLM / NO network. OFFERS only — never runs analysis.
 * When BOTH markers of a configured pair are out of reference range, emits a single
 * kind="question" finding with the marker pair persisted in tags for dig-deeper (sc-4-6).
 *
 * @param store  HealthDataStore (caller owns lifecycle)
 * @param opts   { now: ISO 8601 injected timestamp }
 */
export function detectCrossMarkerPatterns(
  store: HealthDataStore,
  opts: { now: string },
): MedicalFinding[] {
  const findings: MedicalFinding[] = [];
  for (const [a, b] of CROSS_MARKER_PAIRS) {
    if (isOutOfRange(store, a) && isOutOfRange(store, b)) {
      findings.push(makeOfferFinding(a, b, opts.now));
    }
  }
  return findings;
}
