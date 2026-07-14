/**
 * CalendarSlotter — deterministic LLM-free slot-fill (spec-20260628-calendar-planner Sprint 1).
 *
 * PURITY CONTRACT: pure synchronous only — no fs, no network, no LLM import, no subprocess, no dynamic eval.
 * Identical input => identical output.
 *
 * Algorithm:
 *   1. Derive free intervals from (window minus busy intervals), clamped to workingHours if set.
 *   2. Iterate findings in INPUT ORDER (pre-ranked by the hub — the LLM NEVER packs slots).
 *   3. Place each finding into the earliest free interval that fits estDurationMin before dueBy.
 *   4. On placement, split the consumed free interval in-place.
 *   5. If no interval fits, push to unscheduled with an exhaustive-switch reason.
 *
 * Time math uses Date.parse(iso) → epoch-ms arithmetic (pure — same ISO always yields same ms).
 * new Date(ms).toISOString() converts back to ISO-8601 (also pure — deterministic).
 */

import type {
  Finding,
  BusyInterval,
  FreeInterval,
  SlotConstraints,
  ProposedPlan,
  PlanItem,
  UnscheduledReason,
} from "./types.js";

// ── Internal helpers ──────────────────────────────────────────────────

/** Default duration when a finding lacks estDurationMin (minutes). */
const DEFAULT_DURATION_MIN = 30;

/** sentinel for "no deadline" (findings without dueBy). */
const NO_DEADLINE = Infinity;

/**
 * Derive the free intervals in the window by subtracting busy intervals.
 * Busy intervals are clipped to the window boundary before subtraction.
 * If workingHours is provided, free intervals are further clamped per-day.
 */
function deriveFreeIntervals(
  constraints: SlotConstraints,
  busy: BusyInterval[],
): FreeInterval[] {
  const windowStart = Date.parse(constraints.windowStartIso);
  const windowEnd = Date.parse(constraints.windowEndIso);

  // Clip and sort busy intervals to the window
  const clippedBusy = busy
    .map((b) => ({
      start: Math.max(Date.parse(b.startIso), windowStart),
      end: Math.min(Date.parse(b.endIso), windowEnd),
    }))
    .filter((b) => b.start < b.end) // discard intervals fully outside window
    .sort((a, b) => a.start - b.start);

  // Build free gaps by walking the sorted busy list
  const free: FreeInterval[] = [];
  let cursor = windowStart;

  for (const b of clippedBusy) {
    if (b.start > cursor) {
      free.push({
        startIso: new Date(cursor).toISOString(),
        endIso: new Date(b.start).toISOString(),
      });
    }
    if (b.end > cursor) {
      cursor = b.end;
    }
  }

  if (cursor < windowEnd) {
    free.push({
      startIso: new Date(cursor).toISOString(),
      endIso: new Date(windowEnd).toISOString(),
    });
  }

  if (constraints.workingHours === undefined) {
    return free;
  }

  return clampToWorkingHours(free, constraints.workingHours.startHour, constraints.workingHours.endHour);
}

/**
 * Clamp each free interval to the daily working hours window (UTC hours).
 * Intervals that span multiple days are clamped per-day.
 * A clamp that yields start >= end is discarded.
 *
 * Note: bober: single-day clamping; a free interval spanning midnight is split only
 * for that calendar day. Multi-day spanning is handled by iterating days.
 * Upgrade path: replace with a per-day iterator if multi-day windows become common.
 */
function clampToWorkingHours(
  intervals: FreeInterval[],
  startHour: number,
  endHour: number,
): FreeInterval[] {
  const result: FreeInterval[] = [];

  for (const interval of intervals) {
    const iStart = Date.parse(interval.startIso);
    const iEnd = Date.parse(interval.endIso);

    // Iterate day by day for multi-day intervals
    let dayBase = iStart - (iStart % 86_400_000); // truncate to midnight UTC

    while (dayBase < iEnd) {
      const dayWorkStart = dayBase + startHour * 3_600_000;
      const dayWorkEnd = dayBase + endHour * 3_600_000;

      const clampedStart = Math.max(iStart, dayWorkStart);
      const clampedEnd = Math.min(iEnd, dayWorkEnd);

      if (clampedStart < clampedEnd) {
        result.push({
          startIso: new Date(clampedStart).toISOString(),
          endIso: new Date(clampedEnd).toISOString(),
        });
      }

      dayBase += 86_400_000; // advance one day
    }
  }

  return result;
}

/**
 * Produce a human-readable label for an UnscheduledReason.
 *
 * The exhaustive switch + never guard ensures that adding a new UnscheduledReason
 * variant without a case here causes a TypeScript compile error (ADR-3 code-review gate).
 */
function labelUnscheduledReason(reason: UnscheduledReason): string {
  switch (reason) {
    case "does-not-fit":
      return "no free slot large enough for the required duration";
    case "no-free-slot-before-dueBy":
      return "all free slots start at or after the due-by deadline";
    default: {
      // Exhaustive never guard: TypeScript will raise a compile error if a new
      // UnscheduledReason variant is added without a matching case (ADR-3).
      const _exhaustive: never = reason;
      throw new Error(`Unhandled UnscheduledReason: ${String(_exhaustive)}`);
    }
  }
}

// ── Public entry (pure, synchronous) ──────────────────────────────────

/**
 * Place ranked findings into free calendar slots deterministically.
 *
 * - findings are processed in INPUT ORDER (= priority order from the hub).
 * - Each finding is placed into the earliest free interval that can accommodate
 *   its estDurationMin (default: 30 min) entirely before its dueBy.
 * - On placement the consumed portion is removed from the free-interval list.
 * - Findings that cannot be placed are returned in unscheduled[] with a reason.
 * - No LLM, no network, no fs, no clock — deterministic across identical inputs.
 *
 * @param findings  - Pre-ranked Finding array (index 0 = highest priority).
 * @param busy      - Known busy intervals for the planning window.
 * @param constraints - Window bounds (and optional working-hours clamp).
 * @returns ProposedPlan with scheduled PlanItems and unscheduled entries.
 */
export function planSlots(
  findings: Finding[],
  busy: BusyInterval[],
  constraints: SlotConstraints,
): ProposedPlan {
  const freeIntervals = deriveFreeIntervals(constraints, busy);

  const scheduled: PlanItem[] = [];
  const unscheduled: Array<{ findingId: string; reason: UnscheduledReason }> = [];

  // Mutable epoch-ms copy of free intervals for in-place splitting
  const free: Array<{ start: number; end: number }> = freeIntervals.map((f) => ({
    start: Date.parse(f.startIso),
    end: Date.parse(f.endIso),
  }));

  for (const finding of findings) {
    const durationMs = (finding.estDurationMin ?? DEFAULT_DURATION_MIN) * 60_000;
    const dueByMs = finding.dueBy !== undefined ? Date.parse(finding.dueBy) : NO_DEADLINE;

    let placed = false;

    for (let i = 0; i < free.length; i++) {
      const slot = free[i];

      // Free intervals are sorted; once we pass dueBy no later slot can help
      if (slot.start >= dueByMs) {
        break;
      }

      // Effective end: the slot end clamped to dueBy so the event finishes before deadline
      const effectiveEnd = dueByMs === NO_DEADLINE ? slot.end : Math.min(slot.end, dueByMs);
      const available = effectiveEnd - slot.start;

      if (available >= durationMs) {
        const itemStart = slot.start;
        const itemEnd = itemStart + durationMs;

        const planItem: PlanItem = {
          findingId: finding.id,
          title: finding.calendarSafeTitle ?? finding.title,
          startIso: new Date(itemStart).toISOString(),
          endIso: new Date(itemEnd).toISOString(),
          // calendarSafeTitle threaded for cloud connectors (Sprint 3); undefined when absent.
          calendarSafeTitle: finding.calendarSafeTitle,
        };
        scheduled.push(planItem);

        // Split the consumed interval in-place
        if (itemEnd < slot.end) {
          // Shrink: shift the slot start forward
          free[i] = { start: itemEnd, end: slot.end };
        } else {
          // Slot exactly consumed — remove it
          free.splice(i, 1);
        }

        placed = true;
        break;
      }
    }

    if (!placed) {
      // Determine reason: all free slots before dueBy were too small vs no slot before dueBy
      let reason: UnscheduledReason;

      if (dueByMs !== NO_DEADLINE && !free.some((s) => s.start < dueByMs)) {
        // There are free slots but none start before the deadline
        reason = "no-free-slot-before-dueBy";
      } else {
        // Either no deadline, or slots exist before dueBy but none are large enough
        reason = "does-not-fit";
      }

      // Validate via the exhaustive switch (also surfaces the human-readable label for tests)
      labelUnscheduledReason(reason);

      unscheduled.push({ findingId: finding.id, reason });
    }
  }

  return { scheduled, unscheduled };
}
