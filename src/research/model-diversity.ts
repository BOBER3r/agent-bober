/**
 * Model diversity resolver — returns >=2 distinct provider/model blocks by
 * enumerating DIFFERENT tiers from fleet tier-policy.
 *
 * PURE: no fs, no network, no clock. Reads only the static tier table.
 *
 * Distinctness comes from DIFFERENT tiers (within one tier planner==generator
 * ==evaluator all point at the same block, so deduplication must cross tiers).
 */

import { tierPolicy } from "../fleet/tier-policy.js";
import type { RoleProviderBlock, DifficultyTier } from "../fleet/tier-policy.js";

// ── Label ─────────────────────────────────────────────────────────────

/**
 * Canonical label for a block — used in notes and Finding evidence fields.
 * Stable: derived purely from the block's provider and model fields.
 */
export function modelLabel(b: RoleProviderBlock): string {
  return `${b.provider}/${b.model}`;
}

// ── Diversity resolver ────────────────────────────────────────────────

/**
 * Return >=2 DISTINCT provider/model blocks for a multi-model research run.
 *
 * Strategy: enumerate the non-default tiers in a fixed priority order and
 * dedup by `provider/model` label. The optional `tier` parameter seeds the
 * first block by placing that tier at the front of the scan order.
 *
 * Returns all 4 distinct blocks (cheap/standard/hard/frontier) in the
 * current tier-policy table; the runner takes the first >=2.
 */
export function diverseBlocks(tier?: string): RoleProviderBlock[] {
  const order: DifficultyTier[] = ["cheap", "standard", "hard", "frontier"];
  const tiers =
    tier !== undefined && order.includes(tier as DifficultyTier)
      ? [tier as DifficultyTier, ...order.filter((t) => t !== tier)]
      : order;

  const seen = new Set<string>();
  const out: RoleProviderBlock[] = [];

  for (const t of tiers) {
    const block = tierPolicy.resolveTier(t)?.generator;
    if (block !== undefined) {
      const label = modelLabel(block);
      if (!seen.has(label)) {
        seen.add(label);
        out.push(block);
      }
    }
  }

  // bober: returns up to 4 distinct blocks; runner takes >=2. If tier-policy
  // ever collapses tiers to a single block this falls back to whatever is
  // available. A future upgrade path is to expose a configurable model list.
  return out;
}
