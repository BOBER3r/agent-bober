// ── Synthesizer ─────────────────────────────────────────────────────

/**
 * SynthesisResult: the ranked output of synthesize() (ranking shape, not
 * pass/fail — contrast with EvalResult returned by reconcile()).
 */
export interface SynthesisResult {
  /** The approach with the highest aggregate score across all lenses. */
  winner: string;
  /**
   * All approaches ordered descending by total score.
   * Deterministic tie-break: lower original index in `approaches` wins
   * when two approaches have equal totals (i.e. the approach that appeared
   * earlier in the caller's list is ranked higher).
   */
  ranking: Array<{
    approach: string;
    perLensScores: Record<string, number>;
    total: number;
  }>;
  /**
   * Placeholder collection slot for cross-approach ideas worth grafting into
   * the winner. This sprint uses runner-up approach names as a simple default;
   * future sprints may populate this with extracted proposal fragments.
   */
  graftedIdeas: string[];
  /**
   * Lenses whose individual top-scored approach differs from the overall winner.
   * Each entry is a human-readable string identifying the lens and its preferred
   * approach, e.g. "scalability: prefers approach-B".
   */
  dissent: string[];
}

// ── synthesize ──────────────────────────────────────────────────────

/**
 * Pure ranking reducer over per-lens approach scores (sibling of reconcile()).
 * No Date.now / new Date / Math.random / fs — this function is deterministic
 * given the same inputs.
 *
 * Tie-break rule (documented): when two approaches have equal aggregate totals,
 * the approach whose index is LOWER in the original `approaches` array wins.
 * This is achieved by capturing original indices before sorting and using them
 * as a stable comparator secondary key.
 *
 * @param approaches - Ordered list of approach identifiers to rank.
 * @param lensScores - Per-lens score maps: each entry has a lens name and a
 *   `scores` record mapping approach → numeric score. Missing approach keys
 *   contribute 0 for that lens.
 * @throws {Error} if `approaches` is empty (mirrors reconcile() guard).
 */
export function synthesize(
  approaches: string[],
  lensScores: Array<{ lens: string; scores: Record<string, number> }>,
): SynthesisResult {
  if (approaches.length === 0) {
    throw new Error("synthesize: approaches must be non-empty");
  }

  // ── Build per-approach aggregates ───────────────────────────────────

  // Capture original indices for deterministic tie-breaking before sort
  const indexed = approaches.map((approach, originalIndex) => {
    const perLensScores: Record<string, number> = {};
    let total = 0;

    for (const { lens, scores } of lensScores) {
      const s = scores[approach] ?? 0;
      perLensScores[lens] = s;
      total = total + s;
    }

    return { approach, perLensScores, total, originalIndex };
  });

  // ── Sort descending by total; tie-break: lower original index wins ──

  const sorted = indexed.slice().sort((a, b) => {
    if (b.total !== a.total) {
      return b.total - a.total; // higher total ranks first
    }
    return a.originalIndex - b.originalIndex; // lower index ranks first on tie
  });

  const ranking = sorted.map(({ approach, perLensScores, total }) => ({
    approach,
    perLensScores,
    total,
  }));

  const winner = ranking[0].approach;

  // ── Compute dissent ─────────────────────────────────────────────────
  // A lens dissents when its own top-scored approach differs from winner.
  // Tie-break within a single lens also uses lower original index.

  const approachToIndex = new Map<string, number>(
    approaches.map((a, i) => [a, i]),
  );

  const dissent: string[] = [];

  for (const { lens, scores } of lensScores) {
    let lensWinner: string | undefined;
    let lensMax = -Infinity;

    for (const approach of approaches) {
      const s = scores[approach] ?? 0;
      const idx = approachToIndex.get(approach) ?? 0;
      if (
        s > lensMax ||
        (s === lensMax &&
          lensWinner !== undefined &&
          idx < (approachToIndex.get(lensWinner) ?? 0))
      ) {
        lensMax = s;
        lensWinner = approach;
      }
    }

    if (lensWinner !== undefined && lensWinner !== winner) {
      dissent.push(`${lens}: prefers ${lensWinner}`);
    }
  }

  // ── Compute graftedIdeas (runner-up approaches as placeholder) ──────

  const graftedIdeas = ranking.slice(1).map((r) => r.approach);

  return { winner, ranking, graftedIdeas, dissent };
}
