import type { Finding } from "../hub/finding.js";
import type { PromotionPlan } from "./types.js";

// ── Coding domains ────────────────────────────────────────────────────

/**
 * Domains the coding promoter handles.
 * Finding.domain is a free string (not an enum), so we match literals here.
 * Contract assumption 3: coding/projects Findings are promoted to bober-run tasks.
 */
const CODING_DOMAINS = new Set<string>(["coding", "projects"]);

// ── codingPromoter ────────────────────────────────────────────────────

/**
 * Converts a coding or projects Finding into a bober-run PromotionPlan.
 *
 * task derivation (one-line, non-empty):
 *  1. Base: finding.title (always present and non-empty per FindingSchema).
 *  2. Evidence: up to 2 evidence lines appended as context (dash-separated).
 *  3. teamId: extracted from the first "team:<id>" tag, or undefined (default team).
 *
 * PURE: no I/O, no clock read, no side effects.
 */
export function codingPromoter(finding: Finding): PromotionPlan {
  // Extract optional teamId from a "team:<id>" tag
  const teamTag = finding.tags.find((t) => t.startsWith("team:"));
  const teamId = teamTag !== undefined ? teamTag.slice("team:".length) : undefined;

  // Build the one-line task from title + optional evidence context
  let task = finding.title;
  if (finding.evidence.length > 0) {
    const evidenceSummary = finding.evidence.slice(0, 2).join("; ");
    task = `${task} — ${evidenceSummary}`;
  }

  return {
    kind: "bober-run",
    task,
    teamId,
  };
}

// ── Domain guard ──────────────────────────────────────────────────────

/**
 * Returns true when the finding's domain is one the coding promoter handles.
 * Used by the CLI registration to register the promoter under all applicable domains.
 */
export function isCodingDomain(domain: string): boolean {
  return CODING_DOMAINS.has(domain);
}
