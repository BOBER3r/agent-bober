/**
 * Lab trend analyzer — deterministic reference-range and slope rules.
 *
 * PURE / NO network / NO LLM / NO Date.now() / NO async / NO fs.
 * Identical input => identical output.
 *
 * ADR-3: The LLM NEVER performs arithmetic. All trend math is delegated exclusively to
 * NumericsQueryLayer.getLabTrend (slope + latestValue). No hand-rolled slope arithmetic.
 *
 * Rules:
 *   A. Reference-range crossing: latestValue outside [referenceLow, referenceHigh]
 *      → kind 'watch' (severity 3, urgency 3);
 *        >20% beyond the edge → kind 'risk' (severity 4, urgency 4).
 *   B. Slope-toward-edge: slope != null, value is in range, trending toward the nearer
 *      reference edge with a projected crossing → kind 'watch' (severity 2, urgency 2).
 *
 * Abstains (empty findings) when sampleCount === 0 for a biomarker.
 * Reference range is read from store.getLabSeries (LabTrend does not carry it).
 */

import { NumericsQueryLayer } from "../numerics.js";
import type { HealthDataStore } from "../health-store.js";
import { findingId } from "./finding.js";
import type { MedicalFinding, FindingKind } from "./finding.js";

// -- Internal helpers -----------------------------------------------------

/**
 * Build a MedicalFinding for a detected trend condition.
 * Uses findingId with domain|biomarker|ruleKey (NOT now) for idempotency.
 */
function makeFinding(
  biomarker: string,
  ruleKey: string,
  title: string,
  kind: FindingKind,
  urgency: number,
  severity: number,
  evidence: string[],
  now: string,
): MedicalFinding {
  return {
    id: findingId("medical", biomarker, ruleKey),
    domain: "medical",
    title,
    kind,
    urgency,
    severity,
    evidence,
    surfacedAt: now,
    tags: ["lab-trend", biomarker],
    status: "open",
  };
}

// -- Rule A ---------------------------------------------------------------

/**
 * Apply Rule A: latestValue outside [referenceLow, referenceHigh].
 *   - >20% beyond edge → 'risk', severity 4, urgency 4
 *   - ≤20% beyond edge → 'watch', severity 3, urgency 3
 *
 * Returns a finding or undefined when in range.
 */
function applyRuleA(
  biomarker: string,
  latestValue: number,
  latestUnit: string,
  referenceLow: number | undefined,
  referenceHigh: number | undefined,
  now: string,
): MedicalFinding | undefined {
  // Above referenceHigh
  if (referenceHigh !== undefined && latestValue > referenceHigh) {
    const pctBeyond = referenceHigh !== 0 ? (latestValue - referenceHigh) / referenceHigh : 0;
    const isRisk = pctBeyond > 0.2;
    const kind: FindingKind = isRisk ? "risk" : "watch";
    const severity = isRisk ? 4 : 3;
    const urgency = isRisk ? 4 : 3;
    const ruleKey = isRisk ? "rule-a-high-risk" : "rule-a-high";
    const evidence = [
      `${biomarker} = ${latestValue} ${latestUnit} (reference: ≤${referenceHigh} ${latestUnit})`,
      `${(pctBeyond * 100).toFixed(1)}% above upper reference limit`,
    ];
    return makeFinding(biomarker, ruleKey, `${biomarker}: above reference range`, kind, urgency, severity, evidence, now);
  }

  // Below referenceLow
  if (referenceLow !== undefined && latestValue < referenceLow) {
    const divisor = Math.abs(referenceLow) > 0 ? referenceLow : 1;
    const pctBeyond = (referenceLow - latestValue) / divisor;
    const isRisk = pctBeyond > 0.2;
    const kind: FindingKind = isRisk ? "risk" : "watch";
    const severity = isRisk ? 4 : 3;
    const urgency = isRisk ? 4 : 3;
    const ruleKey = isRisk ? "rule-a-low-risk" : "rule-a-low";
    const evidence = [
      `${biomarker} = ${latestValue} ${latestUnit} (reference: ≥${referenceLow} ${latestUnit})`,
      `${(pctBeyond * 100).toFixed(1)}% below lower reference limit`,
    ];
    return makeFinding(biomarker, ruleKey, `${biomarker}: below reference range`, kind, urgency, severity, evidence, now);
  }

  return undefined;
}

// -- Rule B ---------------------------------------------------------------

/**
 * Apply Rule B: value is in range, slope != null, trending toward the nearer reference edge.
 * The slope direction (positive toward high edge, negative toward low edge) combined with
 * which edge is nearer determines whether there is a projected crossing.
 *
 * Returns a finding or undefined when no projected crossing is detected.
 */
function applyRuleB(
  biomarker: string,
  latestValue: number,
  latestUnit: string,
  slope: number,
  referenceLow: number | undefined,
  referenceHigh: number | undefined,
  now: string,
): MedicalFinding | undefined {
  if (referenceLow === undefined && referenceHigh === undefined) return undefined;

  const distToHigh = referenceHigh !== undefined ? referenceHigh - latestValue : Infinity;
  const distToLow = referenceLow !== undefined ? latestValue - referenceLow : Infinity;

  // Trending upward toward referenceHigh and high edge is nearer (or the only bound)
  if (slope > 0 && referenceHigh !== undefined && distToHigh <= distToLow && distToHigh > 0) {
    const evidence = [
      `${biomarker} = ${latestValue} ${latestUnit}, rising trend (slope > 0)`,
      `Upper reference limit: ${referenceHigh} ${latestUnit} (${distToHigh.toFixed(2)} ${latestUnit} away)`,
    ];
    return makeFinding(
      biomarker,
      "rule-b-high",
      `${biomarker}: rising trend toward upper reference limit`,
      "watch",
      2,
      2,
      evidence,
      now,
    );
  }

  // Trending downward toward referenceLow and low edge is nearer (or the only bound)
  if (slope < 0 && referenceLow !== undefined && distToLow <= distToHigh && distToLow > 0) {
    const evidence = [
      `${biomarker} = ${latestValue} ${latestUnit}, falling trend (slope < 0)`,
      `Lower reference limit: ${referenceLow} ${latestUnit} (${distToLow.toFixed(2)} ${latestUnit} away)`,
    ];
    return makeFinding(
      biomarker,
      "rule-b-low",
      `${biomarker}: falling trend toward lower reference limit`,
      "watch",
      2,
      2,
      evidence,
      now,
    );
  }

  return undefined;
}

// -- Public API -----------------------------------------------------------

/**
 * Analyze lab trends for a set of biomarkers and return detected findings.
 *
 * PURE, synchronous, deterministic. No async, no fs, no network, no LLM.
 * Delegates ALL trend math to NumericsQueryLayer.getLabTrend (ADR-3).
 * Reference ranges are read from store.getLabSeries (LabTrend does not carry them).
 *
 * @param store       HealthDataStore (caller is responsible for lifecycle)
 * @param biomarkers  List of biomarker names to analyze
 * @param opts        { now: ISO 8601 injected timestamp }
 */
export function analyzeTrends(
  store: HealthDataStore,
  biomarkers: string[],
  opts: { now: string },
): MedicalFinding[] {
  const numerics = new NumericsQueryLayer(store);
  const findings: MedicalFinding[] = [];

  for (const biomarker of biomarkers) {
    const trend = numerics.getLabTrend(biomarker);

    // Abstain when no data (sc-1-2, sc-1-3)
    if (trend.sampleCount === 0) continue;
    if (trend.latestValue === null) continue;

    // Read reference range from the latest LabResult (LabTrend does not carry it)
    const series = store.getLabSeries(biomarker);
    const latestResult = series[series.length - 1];
    if (!latestResult) continue;

    const { referenceLow, referenceHigh } = latestResult;
    const { latestValue, latestUnit } = trend;

    // Rule A: reference-range crossing (takes precedence over Rule B)
    const ruleAFinding = applyRuleA(
      biomarker,
      latestValue,
      latestUnit,
      referenceLow,
      referenceHigh,
      opts.now,
    );

    if (ruleAFinding !== undefined) {
      findings.push(ruleAFinding);
      continue; // Rule A takes precedence; Rule B not evaluated for this biomarker
    }

    // Rule B: slope-toward-edge (only when in range and sampleCount >= 2 for valid slope)
    if (trend.slope !== null && trend.sampleCount >= 2) {
      const ruleBFinding = applyRuleB(
        biomarker,
        latestValue,
        latestUnit,
        trend.slope,
        referenceLow,
        referenceHigh,
        opts.now,
      );
      if (ruleBFinding !== undefined) {
        findings.push(ruleBFinding);
      }
    }
  }

  return findings;
}
