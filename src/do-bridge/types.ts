import type { Finding } from "../hub/finding.js";

// ── FindingKind ───────────────────────────────────────────────────────

/** Mirror of Finding["kind"] — derived, never redefined. */
export type FindingKind = Finding["kind"];

// ── PromoterKey ───────────────────────────────────────────────────────

/**
 * Registry lookup key for a Promoter.
 * domain is required; kind is optional so domain-only registrations
 * serve as a fallback for any kind within that domain.
 */
export interface PromoterKey {
  domain: string;
  kind?: FindingKind;
}

// ── PromotionPlan ─────────────────────────────────────────────────────

/**
 * Rich plan returned by a Promoter — what would be launched.
 * kind='bober-run' is a discriminant; Sprint 2 may add more plan kinds.
 * PURE: no I/O encoded here — just data.
 */
export interface PromotionPlan {
  kind: "bober-run";
  /** The one-line task string that bober run would receive. */
  task: string;
  /** Optional target team id; undefined means the default team. */
  teamId?: string;
}

// ── PromotionRef ──────────────────────────────────────────────────────

/**
 * Stable string id for a planned or recorded promotion.
 * This is the value later written to Finding.promotesTo after real launch.
 * Kept as a plain string alias this sprint; Sprint 3 may add structure.
 */
export type PromotionRef = string;

// ── Promoter ──────────────────────────────────────────────────────────

/**
 * A Promoter converts a Finding into a PromotionPlan.
 * PURE: no I/O — all input comes from the finding.
 */
export type Promoter = (finding: Finding) => PromotionPlan;
