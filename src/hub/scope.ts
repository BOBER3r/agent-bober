import { z } from "zod";
import type { Finding } from "./finding.js";

// ── Types ─────────────────────────────────────────────────────────────

/**
 * Discriminated union representing the query scope for hub prioritization.
 *
 * - general: no constraint; LLM relevance-filters the full pool.
 * - decision: keep findings relevant to either named option (drop "neither").
 * - filtered: pure JS structural filter on domain, tag, and/or dueWithinDays.
 */
export type Scope =
  | { mode: "general" }
  | { mode: "decision"; optionA: string; optionB: string }
  | { mode: "filtered"; domain?: string; dueWithinDays?: number; tag?: string };

// ── parseScope ────────────────────────────────────────────────────────

const ScopeInputSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("general") }),
  z.object({
    mode: z.literal("decision"),
    optionA: z.string(),
    optionB: z.string(),
  }),
  z.object({
    mode: z.literal("filtered"),
    domain: z.string().optional(),
    dueWithinDays: z.number().int().optional(),
    tag: z.string().optional(),
  }),
]);

/**
 * Parse an unknown value into a Scope discriminated union.
 * Falls back to { mode: "general" } on any parse failure — never throws.
 */
export function parseScope(raw: unknown): Scope {
  const result = ScopeInputSchema.safeParse(raw);
  if (result.success) return result.data;
  return { mode: "general" };
}

// ── applyFilter ───────────────────────────────────────────────────────

/**
 * Pure structural filter — NO LLM, NO async, NO side effects.
 *
 * For filtered scope: returns findings matching ALL specified constraints
 * (domain AND tag AND dueBy within dueWithinDays of now).
 * A finding with no dueBy does NOT satisfy a dueWithinDays constraint.
 * For non-filtered scopes: returns findings unchanged (the LLM pass-1 handles those).
 *
 * @param findings  Pool of findings to filter.
 * @param scope     The parsed query scope.
 * @param now       Injected clock — used for dueWithinDays calculation.
 */
export function applyFilter(findings: Finding[], scope: Scope, now: Date): Finding[] {
  if (scope.mode !== "filtered") return findings;

  const { domain, tag, dueWithinDays } = scope;

  return findings.filter((f) => {
    // Domain constraint: finding.domain must match if specified
    if (domain !== undefined && f.domain !== domain) return false;

    // Tag constraint: finding.tags must include the tag if specified
    if (tag !== undefined && !f.tags.includes(tag)) return false;

    // dueWithinDays constraint: finding.dueBy must exist and be within N days of now
    if (dueWithinDays !== undefined) {
      if (!f.dueBy) return false; // no dueBy → does NOT satisfy dueWithinDays
      const deadline = new Date(now.getTime() + dueWithinDays * 24 * 60 * 60 * 1000);
      if (Date.parse(f.dueBy) > deadline.getTime()) return false;
    }

    return true;
  });
}
