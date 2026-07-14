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
 * Structured ref written to Finding.promotesTo after a real launch.
 *
 * On-disk: serialized to a JSON string (Finding.promotesTo is z.string()).
 * In-process (via FindingStore port): callers receive this object shape.
 * Use serializePromotionRef / parsePromotionRef to cross the boundary.
 */
export interface PromotionRef {
  kind: "bober-run";
  runId: string;
  launchedAt: string;
  status: "launched" | "completed" | "aborted";
}

/** Serialize a PromotionRef to a JSON string for on-disk storage. */
export function serializePromotionRef(ref: PromotionRef): string {
  return JSON.stringify(ref);
}

/**
 * Parse a PromotionRef from a JSON string.
 * Returns null on parse failure or missing required fields.
 */
export function parsePromotionRef(s: string): PromotionRef | null {
  try {
    return JSON.parse(s) as PromotionRef;
  } catch {
    return null;
  }
}

// ── Promoter ──────────────────────────────────────────────────────────

/**
 * A Promoter converts a Finding into a PromotionPlan.
 * PURE: no I/O — all input comes from the finding.
 */
export type Promoter = (finding: Finding) => PromotionPlan;
