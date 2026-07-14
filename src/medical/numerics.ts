/**
 * NumericsQueryLayer — deterministic closed-whitelist numeric primitives (Phase 6, Sprint 4).
 *
 * ADR-3: The LLM NEVER performs arithmetic. All numeric computations are pure TypeScript
 * over a CLOSED whitelist: mean | min | max | latest | delta | slope | percentile | zscore.
 * Adding a computation requires extending NumericPrimitive (a code review event), not a
 * model decision. `sampleCount: 0` signals upstream abstention.
 *
 * NO async. NO fs. NO network. NO LLM import. NO dynamic execution. NO subprocess.
 * Identical input => identical output.
 *
 * Primitive formulas documented below (also satisfies contract assumptions line 75):
 *
 * mean        — sum(values) / n
 * min         — Math.min(...values)
 * max         — Math.max(...values)
 * latest      — value at the maximum t_start (last element of ASC-ordered array)
 * delta       — latest − earliest = values[n-1] − values[0]
 * slope       — least-squares slope over (t, value) where t = Date.parse(r.tStart) epoch-ms.
 *               formula: (n·Σ(t·v) − Σt·Σv) / (n·Σ(t²) − (Σt)²)
 *               degenerate: denominator === 0 (all same timestamp) → value: null, sampleCount: n
 * percentile  — linear interpolation between closest ranks (sorted ascending):
 *               rank = (p/100) · (n−1); lo = floor(rank); hi = ceil(rank);
 *               result = v[lo] + (rank − lo) · (v[hi] − v[lo])
 *               (for p50, [10,20,30,40] → rank=1.5 → 20 + 0.5·10 = 25)
 * zscore      — (latest − mean) / populationStddev
 *               populationStddev = sqrt(Σ(v − mean)² / n)
 *               sampleCount < 2 → abstain (stddev undefined for n=1, zero for n=0)
 *               ([10,20,30,40]: mean=25, popStd=√125≈11.1803, z=(40-25)/11.1803≈1.3416)
 */

import type { HealthDataStore } from "./health-store.js";
import type {
  NumericPrimitive,
  NumericResult,
  MetricWindow,
  LabTrend,
  HealthObservation,
  LabResult,
} from "./types.js";

// ── Internal computation helpers ──────────────────────────────────────

/**
 * Compute the least-squares slope over (epoch-ms timestamp, value) pairs.
 * Returns null when the denominator is zero (all observations at the same timestamp).
 */
function leastSquaresSlope(rows: HealthObservation[]): number | null {
  const n = rows.length;
  const ts = rows.map((r) => Date.parse(r.tStart));
  const vs = rows.map((r) => r.value);

  let sumT = 0;
  let sumV = 0;
  let sumTV = 0;
  let sumT2 = 0;

  for (let i = 0; i < n; i++) {
    sumT += ts[i];
    sumV += vs[i];
    sumTV += ts[i] * vs[i];
    sumT2 += ts[i] * ts[i];
  }

  const denom = n * sumT2 - sumT * sumT;
  if (denom === 0) return null; // all same timestamp — slope undefined
  return (n * sumTV - sumT * sumV) / denom;
}

/**
 * Linear interpolation percentile on the sorted-ascending values.
 * rank = (p/100) · (n−1); result = v[lo] + (rank − lo) · (v[hi] − v[lo]).
 * p must be in [0, 100].
 */
function linearPercentile(sortedValues: number[], p: number): number {
  const n = sortedValues.length;
  if (n === 1) return sortedValues[0];
  const rank = (p / 100) * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedValues[lo];
  return sortedValues[lo] + (rank - lo) * (sortedValues[hi] - sortedValues[lo]);
}

/**
 * Population standard deviation: sqrt(Σ(v − mean)² / n).
 */
function populationStddev(values: number[], mean: number): number {
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Dispatch the computation for a single NumericPrimitive over the given rows/values.
 * rows are ordered by t_start ASC from getObservations.
 * values[i] === rows[i].value.
 * Returns null only for zscore (n<2) and slope (degenerate denominator).
 *
 * The exhaustive switch + never guard ensures every new member of the union
 * causes a compile-time error if not handled (ADR-3 code-review gate).
 */
function computePrimitive(
  primitive: NumericPrimitive,
  rows: HealthObservation[],
  values: number[],
  percentile: number,
): number | null {
  const n = values.length;

  switch (primitive) {
    case "mean": {
      const sum = values.reduce((acc, v) => acc + v, 0);
      return sum / n;
    }

    case "min":
      return Math.min(...values);

    case "max":
      return Math.max(...values);

    case "latest":
      // rows are ordered t_start ASC; last element is the most recent.
      return values[n - 1];

    case "delta":
      // latest − earliest (ASC order: first is earliest, last is latest).
      return values[n - 1] - values[0];

    case "slope":
      return leastSquaresSlope(rows);

    case "percentile": {
      const sorted = [...values].sort((a, b) => a - b);
      return linearPercentile(sorted, percentile);
    }

    case "zscore": {
      if (n < 2) return null; // population stddev undefined for n<2
      const mean = values.reduce((acc, v) => acc + v, 0) / n;
      const std = populationStddev(values, mean);
      if (std === 0) return 0; // all values identical → z-score is 0 by definition
      const latest = values[n - 1];
      return (latest - mean) / std;
    }

    default: {
      // Exhaustive never guard: if a new primitive is added to the union without
      // a case here, TypeScript will raise a compile error (ADR-3).
      const _exhaustive: never = primitive;
      throw new Error(`Unhandled NumericPrimitive: ${String(_exhaustive)}`);
    }
  }
}

// ── NumericsQueryLayer ────────────────────────────────────────────────

/**
 * Provides deterministic, LLM-free numeric aggregations over HealthDataStore.
 *
 * All methods are SYNCHRONOUS. No async, no fs, no network, no LLM import.
 * The LLM never performs arithmetic — this layer does.
 */
export class NumericsQueryLayer {
  constructor(private readonly store: HealthDataStore) {}

  /**
   * Compute a numeric primitive over the observations in the given time window.
   *
   * Abstain conditions (return { value: null, sampleCount: 0 } without throwing):
   *   - Empty window (no rows in the time range) — sc-4-6
   *   - Heterogeneous units across rows — sc-4-7 (cross-unit refusal)
   *
   * Partial abstain (value: null, sampleCount: n):
   *   - zscore with sampleCount < 2 (stddev undefined)
   *   - slope with degenerate denominator (all same timestamp)
   *
   * @param window   — metric + ISO-8601 time range
   * @param primitive — one of the 8 whitelisted NumericPrimitive values
   * @param percentile — percentile p ∈ [0,100], used only for "percentile" primitive (default 50)
   */
  getMetric(window: MetricWindow, primitive: NumericPrimitive, percentile = 50): NumericResult {
    const rows = this.store.getObservations(window.metric, window.fromIso, window.toIso);

    // ABSTAIN: empty window (sc-4-6)
    if (rows.length === 0) {
      return { primitive, value: null, unit: window.unit ?? "", sampleCount: 0 };
    }

    // UNIT GUARD (sc-4-7): refuse to aggregate across heterogeneous units (ADR-4).
    // Architecture risk table line 328: "NumericsQueryLayer reads unit per row;
    // refuses cross-unit aggregation."
    const units = new Set(rows.map((r) => r.unit));
    if (units.size > 1) {
      // Abstain — no throw (no-throw contract from architecture API table line 251).
      return { primitive, value: null, unit: "", sampleCount: rows.length };
    }

    const unit = rows[0].unit;
    const values = rows.map((r) => r.value);

    const value = computePrimitive(primitive, rows, values, percentile);
    return { primitive, value, unit, sampleCount: rows.length };
  }

  /**
   * Build a LabTrend summary for a biomarker series.
   *
   * Abstains (latestValue: null, slope: null) when sampleCount === 0 (sc-4-6).
   * slope is null when sampleCount < 2 (not enough data for least-squares).
   */
  getLabTrend(biomarker: string): LabTrend {
    const series: LabResult[] = this.store.getLabSeries(biomarker);

    if (series.length === 0) {
      return {
        biomarker,
        sampleCount: 0,
        latestValue: null,
        latestUnit: "",
        latestCollectedAt: null,
        slope: null,
      };
    }

    // series is ordered collected_at ASC from getLabSeries.
    const latest = series[series.length - 1];

    let slope: number | null = null;
    if (series.length >= 2) {
      // Convert LabResult to pseudo-HealthObservation for slope helper reuse.
      const pseudoRows: HealthObservation[] = series.map((r) => ({
        metric: r.biomarker,
        value: r.value,
        unit: r.unit,
        tStart: r.collectedAtIso,
        source: "lab",
      }));
      slope = leastSquaresSlope(pseudoRows);
    }

    return {
      biomarker,
      sampleCount: series.length,
      latestValue: latest.value,
      latestUnit: latest.unit,
      latestCollectedAt: latest.collectedAtIso,
      slope,
    };
  }
}
