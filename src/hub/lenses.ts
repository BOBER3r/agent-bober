import { z } from "zod";

// ── Hub lens catalog ─────────────────────────────────────────────────

/**
 * Hub prioritization lens focus fragments.
 *
 * Each lens evaluates a Finding through a distinct prioritization axis.
 * These are hub-specific lenses — do NOT reuse the eval-lenses catalog
 * (correctness/security/regression/quality/simplicity), which is pinned
 * by a drift gate at src/orchestrator/lens-panel-parity.test.ts.
 */
const HUB_LENS_CATALOG: Record<string, string> = {
  urgency:
    "Focus on how time-sensitive this finding is. Evaluate the immediacy of required action: whether delay causes irreversible harm, significant cost increase, or missed opportunity. A finding requiring action within hours scores higher than one that can wait weeks.",
  impact:
    "Focus on the magnitude of effect this finding has on the person's goals, health, finances, or productivity. Evaluate how many downstream decisions or outcomes depend on resolving this finding. High-impact findings affect multiple domains or have compounding consequences.",
  effort:
    "Focus on the effort-to-ROI ratio for addressing this finding. Evaluate whether the required action is proportionate to the benefit gained. Low-effort high-benefit findings score highest; high-effort low-benefit findings score lowest. Include complexity, time, and resource cost.",
  "deadline-risk":
    "Focus on whether this finding is at risk of becoming unactionable due to an approaching deadline, time-sensitive window, or compounding delay penalty. Evaluate explicit due dates, implicit time constraints, and whether missing the window closes off future options.",
};

// ── Hub lens names ────────────────────────────────────────────────────

export const HUB_LENS_NAMES = [
  "urgency",
  "impact",
  "effort",
  "deadline-risk",
] as const;

export type HubLensName = (typeof HUB_LENS_NAMES)[number];

// ── Resolver ──────────────────────────────────────────────────────────

/**
 * Resolve a hub lens name to its focus fragment.
 * Returns the catalog entry for a known lens, or a generic non-empty
 * fallback for any unknown custom string — never throws.
 */
export function resolveHubLensFocus(lens: string): string {
  return (
    HUB_LENS_CATALOG[lens] ??
    `Evaluate this finding specifically through the '${lens}' lens.`
  );
}

// ── Zod schemas ───────────────────────────────────────────────────────

/**
 * Schema for pass-1 relevance verdict (general and decision scopes).
 * For decision scope: relevantTo disambiguates which option the finding supports.
 */
export const RelevanceVerdictSchema = z.object({
  relevant: z.boolean(),
  relevantTo: z.enum(["optionA", "optionB", "both", "neither"]).optional(),
  reason: z.string().optional(),
});

export type RelevanceVerdict = z.infer<typeof RelevanceVerdictSchema>;

/**
 * Schema for pass-2 per-lens score/vote.
 * include=true counts as a pass-vote; include=false counts as fail-vote.
 * score (0-10) contributes to aggregate score for final ordering.
 * An unparseable lens response is treated as { include: false, score: 0 } (fail-closed).
 */
export const LensScoreSchema = z.object({
  include: z.boolean(),
  score: z.number().min(0).max(10),
  reason: z.string().optional(),
});

export type LensScore = z.infer<typeof LensScoreSchema>;

// ── Four-tier JSON extraction (NEVER throws) ──────────────────────────

/**
 * Shared four-tier JSON extraction strategy: direct parse → fenced JSON →
 * first { } block → fail. Mirrors validateLensVerdict (medical/recommend/lenses.ts:65-113).
 * NEVER throws. Returns the parsed unknown on success, null on failure.
 */
function extractJson(rawText: string): unknown | null {
  // Tier 1: direct parse
  try {
    return JSON.parse(rawText.trim());
  } catch {
    // fall through to tier 2
  }

  // Tier 2: extract from markdown code fences
  const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/.exec(rawText);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      // fall through to tier 3
    }
  }

  // Tier 3: find first { ... } block
  const braceStart = rawText.indexOf("{");
  const braceEnd = rawText.lastIndexOf("}");
  if (braceStart !== -1 && braceEnd > braceStart) {
    try {
      return JSON.parse(rawText.slice(braceStart, braceEnd + 1));
    } catch {
      // fall through to tier 4
    }
  }

  // Tier 4: unparseable
  return null;
}

// ── validateRelevanceVerdict ──────────────────────────────────────────

/**
 * Parse a raw LLM text into a RelevanceVerdict.
 * Returns null on parse failure (fail-closed: treated as irrelevant / no-vote).
 * NEVER throws.
 */
export function validateRelevanceVerdict(rawText: string): RelevanceVerdict | null {
  const parsed = extractJson(rawText);
  if (parsed === null) return null;

  const result = RelevanceVerdictSchema.safeParse(parsed);
  if (!result.success) return null;

  return result.data;
}

// ── validateLensScore ─────────────────────────────────────────────────

/**
 * Parse a raw LLM text into a LensScore.
 * Returns null on parse failure (fail-closed: contributes to failCount, score=0).
 * NEVER throws.
 */
export function validateLensScore(rawText: string): LensScore | null {
  const parsed = extractJson(rawText);
  if (parsed === null) return null;

  const result = LensScoreSchema.safeParse(parsed);
  if (!result.success) return null;

  return result.data;
}
