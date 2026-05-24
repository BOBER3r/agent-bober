/**
 * Pre-flight graph context injection — token budget constants and enforcement.
 *
 * Token counting uses Math.ceil(text.length / 4) as a conservative estimate.
 * Anthropic models average ~3.5–4.0 chars/token for English markdown.
 * Over-estimation is intentional — the cap is firm.
 *
 * TODO(phase-2): swap estimateTokens() to tiktoken when the dep is approved.
 */

// ── Per-role budget constants ──────────────────────────────────────

/**
 * Default token budgets for pre-flight graph context injection (ADR-9).
 * These match the defaults in GraphPreflightBudgetsSchema in schema.ts.
 * Runtime code reads budgets from config.graph.preflightBudgets; these
 * constants exist for reference and testing.
 */
export const DEFAULT_PREFLIGHT_BUDGETS = {
  architect: 4000,
  curator: 2000,
  generator: 1000,
  evaluator: 1500,
  "researcher-phase2": 3000,
} as const satisfies Record<string, number>;

// ── Token estimator ────────────────────────────────────────────────

/**
 * Estimate token count for a string.
 *
 * Uses a conservative chars/4 heuristic. Anthropic models average ~3.5–4.0
 * chars per token for English markdown. Over-estimation is intentional: the
 * pre-flight budget cap is hard, so rounding up prevents silent overruns.
 *
 * TODO(phase-2): replace chars/4 with tiktoken when available.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── Budget enforcement ─────────────────────────────────────────────

/**
 * Enforce a token budget on a markdown string composed of `### Section` blocks.
 *
 * Algorithm:
 * 1. If under budget, return unchanged.
 * 2. Split on `\n### ` boundaries (whole-section granularity).
 * 3. Drop sections from the END until under budget.
 * 4. Append `[truncated due to budget — N more results omitted]` marker.
 * 5. Hard-cap fallback: if even header + first section exceeds budget,
 *    truncate by character count.
 *
 * @param markdown Full formatted markdown string.
 * @param budget   Token budget (positive integer).
 * @returns Object with the capped output string and the number of sections dropped.
 */
export function enforceBudget(
  markdown: string,
  budget: number,
): { out: string; dropped: number } {
  if (budget <= 0) {
    return { out: "[truncated due to budget — budget=0]", dropped: 0 };
  }
  if (estimateTokens(markdown) <= budget) {
    return { out: markdown, dropped: 0 };
  }

  // Split preserving the delimiter so each part starts with "### " except the first.
  const parts = markdown.split(/(?=^### )/m);
  let dropped = 0;

  while (parts.length > 1 && estimateTokens(parts.join("")) > budget) {
    parts.pop();
    dropped++;
  }

  let out = parts.join("");

  if (dropped > 0) {
    out += `\n\n[truncated due to budget — ${dropped} more result${dropped === 1 ? "" : "s"} omitted]\n`;
  }

  // Hard cap fallback: if even header + first section exceeds budget, truncate by chars.
  if (estimateTokens(out) > budget) {
    const maxChars = budget * 4;
    out = out.slice(0, maxChars) + "\n\n[truncated due to budget — hard cap]\n";
  }

  return { out, dropped };
}
