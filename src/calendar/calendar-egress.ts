/** CalendarEgressGuard — cloud-calendar egress axis, default false (Sprint 3, ADR-6 lineage). */
import type { BoberConfig } from "../config/schema.js";

// ── CalendarEgressGuard ───────────────────────────────────────────────

/**
 * Guards outbound cloud-calendar egress.
 *
 * A single axis — cloudCalendar — defaults to false.
 * assertCloudCalendarAllowed throws naming the config flag so users know
 * exactly which key to set; returns void when allowed.
 *
 * bober: plain decision object; no network import here; swap for ABAC policy
 *        if per-user granularity is needed.
 */
export class CalendarEgressGuard {
  constructor(private readonly cloudCalendar: boolean) {}

  /** Build from BoberConfig calendar section; axis defaults false when absent. */
  static fromConfig(config: BoberConfig): CalendarEgressGuard {
    return new CalendarEgressGuard(
      config.calendar?.egress?.cloudCalendar ?? false,
    );
  }

  /** Returns true only when cloud-calendar egress has been explicitly opted in. */
  isCloudCalendarAllowed(): boolean {
    return this.cloudCalendar;
  }

  /**
   * Throws an Error naming the config flag when the axis is off.
   * Returns void (does not throw) when the axis is allowed.
   */
  assertCloudCalendarAllowed(): void {
    if (!this.cloudCalendar) {
      throw new Error(
        "cloud-calendar egress not enabled — set calendar.egress.cloudCalendar: true in bober.config.json",
      );
    }
  }
}
