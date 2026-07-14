/**
 * computeNextDue — deterministic cadence math (Sprint 4).
 *
 * PURE, clock-free: never calls new Date() with no argument or Date.now().
 * The fromIso base instant is always injected from the CLI boundary
 * (mirrors the clock discipline in src/state/facts.ts:18-21 and
 * src/calendar/slotter.ts:14-16).
 *
 * new Date(Date.parse(iso)) parses the INJECTED string — that is pure, not
 * a wall-clock read. The wall clock is read only at the CLI .action() boundary.
 */

import type { Cadence } from "./types.js";

// ── computeNextDue ────────────────────────────────────────────────────

/**
 * Return the next-due ISO-8601 timestamp for a job with the given cadence,
 * computed from the injected `fromIso` instant.
 *
 * Cadence mapping:
 *   - "daily"   → +1 UTC day  (setUTCDate + 1)
 *   - "weekly"  → +7 UTC days (setUTCDate + 7)
 *   - "monthly" → +1 UTC month (setUTCMonth + 1)
 *
 * Month-length rollover note: JavaScript's setUTCMonth overflows into the
 * next month when the source day exceeds the destination month's length.
 * E.g. 2026-01-31 + 1 month → 2026-03-03 (Feb has 28 days in 2026).
 * This deterministic behaviour is intentional — callers MUST NOT rely on
 * the result landing on the last day of the month.
 *
 * @param cadence  - One of "daily", "weekly", "monthly".
 * @param fromIso  - Injected ISO-8601 base instant (e.g. the current `now`).
 * @returns         ISO-8601 string satisfying z.string().datetime().
 */
export function computeNextDue(cadence: Cadence, fromIso: string): string {
  // Parsing an injected string is pure — no wall-clock dependency.
  const base = new Date(Date.parse(fromIso));

  switch (cadence) {
    case "daily":
      base.setUTCDate(base.getUTCDate() + 1);
      return base.toISOString();

    case "weekly":
      base.setUTCDate(base.getUTCDate() + 7);
      return base.toISOString();

    case "monthly":
      // setUTCMonth overflows into the next month on day > last-day-of-month.
      // This is deterministic and acceptable for a monthly cadence (contract
      // outOfScope: no clamp-to-end-of-month behaviour).
      base.setUTCMonth(base.getUTCMonth() + 1);
      return base.toISOString();

    default: {
      // TypeScript exhaustive-switch guard — new cadences cause a compile error.
      const _exhaustive: never = cadence;
      throw new Error(`Unhandled cadence: ${String(_exhaustive)}`);
    }
  }
}
