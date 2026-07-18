/**
 * AiVisibilityScorer — PURE aggregation of raw AiVisibilityRow observations
 * into per-(prompt,provider) rates + a deterministic Wilson 95% CI
 * (in-house-ai-visibility, Sprint 5; ADR-5).
 *
 * PURE, synchronous, network-free transform: groups the raw per-sample
 * `AiVisibilityRow[]` STRICTLY by (prompt, provider) — arms are NEVER
 * merged, even when they share a prompt — and folds each group into one
 * `AiVisibilityMetric` carrying mention/citation rates, an optional mean
 * rank, a deduped `sourceUrls` union (first-seen order), and a
 * deterministic Wilson 95% score interval over the mention indicator
 * (z=1.96, no RNG, no `Date`). Never throws.
 *
 * This module is consumed ANALYZER-SIDE (`analyzer.ts`'s
 * `describeAiVisibility`, gated on `provenance.source === "ai-visibility"`)
 * to fold N raw rows into rates+CI for the LLM prompt — the metric is a
 * derived, in-prompt-only projection and is never persisted to the locked
 * `SeoDataBundle.aiVisibility` (`DataOutcome<AiVisibilityRow[]>`).
 */
import type { AiVisibilityRow } from "./data-source.js";

/** Derived, in-analyzer projection — NOT persisted to the locked SeoDataBundle. */
export type AiVisibilityMetric = {
  prompt: string;
  provider: string;
  samples: number;
  mentionRate: number;
  citationRate: number;
  /** OMITTED (never `undefined`) when no row in the group carries a `rank`. */
  meanRank?: number;
  /** Wilson 95% score interval over the mention indicator (z=1.96). */
  mentionRateCi95: [number, number];
  /** Deduped union of every row's `sourceUrls`, first-seen order preserved. */
  sourceUrls: string[];
};

const Z = 1.96; // 95% two-sided; hard-coded, no config, no RNG
const Z_SQUARED = Z * Z;

/**
 * Wilson 95% score interval for `successes` out of `n` Bernoulli trials.
 *
 * `n <= 1` is a SPECIAL CASE returning the degenerate `[rate, rate]` — the
 * raw Wilson formula does NOT naturally collapse to a point interval for a
 * single sample (e.g. 1/1 yields roughly `[0.207, 1.0]`), so a single
 * observation is reported with zero spread instead of a misleadingly wide
 * one-sample interval.
 */
function wilsonCi95(successes: number, n: number): [number, number] {
  if (n <= 1) {
    const rate = n === 1 ? successes / n : 0;
    return [rate, rate];
  }

  const p = successes / n;
  const denom = 1 + Z_SQUARED / n;
  const center = (p + Z_SQUARED / (2 * n)) / denom;
  const margin = (Z * Math.sqrt(p * (1 - p) / n + Z_SQUARED / (4 * n * n))) / denom;

  // The Wilson interval is naturally bounded in [0, 1]; clamp defensively.
  const lower = Math.max(0, center - margin);
  const upper = Math.min(1, center + margin);
  return [lower, upper];
}

/**
 * Collision-safe composite grouping key — `JSON.stringify` of the tuple
 * rather than naive string concatenation (a delimiter like `"::"` could
 * appear inside a prompt or provider string and silently merge two arms).
 */
function groupKey(prompt: string, provider: string): string {
  return JSON.stringify([prompt, provider]);
}

/** Mean of every row's `rank`, or `undefined` when no row carries one. */
function computeMeanRank(rows: AiVisibilityRow[]): number | undefined {
  const ranks = rows.map((r) => r.rank).filter((r): r is number => typeof r === "number");
  if (ranks.length === 0) return undefined;
  return ranks.reduce((sum, r) => sum + r, 0) / ranks.length;
}

/** Deduped union of every row's `sourceUrls`, preserving first-seen order. */
function dedupeSourceUrls(rows: AiVisibilityRow[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const row of rows) {
    const urls = Array.isArray(row.sourceUrls) ? row.sourceUrls : [];
    for (const url of urls) {
      if (!seen.has(url)) {
        seen.add(url);
        result.push(url);
      }
    }
  }
  return result;
}

/** Folds one (prompt,provider) group's rows into a single `AiVisibilityMetric`. */
function scoreGroup(rows: AiVisibilityRow[]): AiVisibilityMetric {
  const { prompt, provider } = rows[0];
  const n = rows.length;
  const mentionedCount = rows.filter((r) => r.mentioned === true).length;
  const citedCount = rows.filter((r) => r.citationPresent === true).length;
  const meanRank = computeMeanRank(rows);

  const metric: AiVisibilityMetric = {
    prompt,
    provider,
    samples: n,
    mentionRate: mentionedCount / n,
    citationRate: citedCount / n,
    mentionRateCi95: wilsonCi95(mentionedCount, n),
    sourceUrls: dedupeSourceUrls(rows),
  };

  // Pattern B: OMIT the key entirely rather than setting `meanRank: undefined`.
  return meanRank === undefined ? metric : { ...metric, meanRank };
}

export class AiVisibilityScorer {
  /**
   * Groups `rows` strictly by `(prompt, provider)` — arms are NEVER merged,
   * even when they share a prompt. Empty input yields `[]`. Preserves
   * first-seen group order. Never throws.
   */
  aggregate(rows: AiVisibilityRow[]): AiVisibilityMetric[] {
    if (!Array.isArray(rows) || rows.length === 0) return [];

    const groups = new Map<string, AiVisibilityRow[]>();
    for (const row of rows) {
      const key = groupKey(row.prompt, row.provider);
      const existing = groups.get(key);
      if (existing) {
        existing.push(row);
      } else {
        groups.set(key, [row]);
      }
    }

    const metrics: AiVisibilityMetric[] = [];
    for (const groupRows of groups.values()) {
      metrics.push(scoreGroup(groupRows));
    }
    return metrics;
  }
}
