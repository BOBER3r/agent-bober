import { z } from "zod";

// ── Local Finding schema ──────────────────────────────────────────────

/**
 * Local calendar-module copy of the Finding type.
 * Field names mirror src/hub/finding.ts:10-27 EXACTLY.
 * Do NOT import from src/hub — this module is a forward dependency on the
 * priority-hub spec. The hub is a sibling spec; importing it would create a
 * compile-time coupling that the planner explicitly avoided.
 */
export const FindingSchema = z.object({
  id: z.string().min(1),
  domain: z.string().min(1),
  title: z.string().min(1),
  kind: z.enum(["action", "watch", "risk", "question"]),
  urgency: z.number().int().min(1).max(5),
  severity: z.number().int().min(1).max(5),
  evidence: z.array(z.string()),
  surfacedAt: z.string().datetime(),
  dueBy: z.string().datetime().optional(),
  tags: z.array(z.string()),
  estDurationMin: z.number().int().optional(),
  calendarSafeTitle: z.string().optional(),
  status: z.enum(["open", "in-progress", "snoozed", "done", "dropped"]),
  promotesTo: z.string().optional(),
});

export type Finding = z.infer<typeof FindingSchema>;

/** Zod schema for an ordered ranked-findings array (calendar input). */
export const FindingArraySchema = z.array(FindingSchema);

// ── Calendar data types ───────────────────────────────────────────────

/** A busy (blocked) calendar interval. */
export interface BusyInterval {
  startIso: string;
  endIso: string;
}

/** A free (available) calendar interval derived from the window minus busy intervals. */
export interface FreeInterval {
  startIso: string;
  endIso: string;
}

/** Working-hours constraint applied when clamping free intervals per-day. */
export interface WorkingHours {
  /** Hour of day (0-23) when work begins, UTC. */
  startHour: number;
  /** Hour of day (0-23) when work ends, UTC. */
  endHour: number;
}

/** Constraints that bound the planning window passed to planSlots. */
export interface SlotConstraints {
  /** ISO-8601 start of the planning window (inclusive). */
  windowStartIso: string;
  /** ISO-8601 end of the planning window (exclusive). */
  windowEndIso: string;
  /** Optional working-hours clamp (UTC hours). */
  workingHours?: WorkingHours;
  /** IANA timezone identifier (informational only; not used in epoch-ms math). */
  timezone?: string;
}

/** A scheduled finding slot in the proposed plan. */
export interface PlanItem {
  findingId: string;
  title: string;
  startIso: string;
  endIso: string;
}

/**
 * Closed string-literal union of reasons a finding was not placed.
 *
 * "does-not-fit"              — No free slot large enough for estDurationMin exists.
 * "no-free-slot-before-dueBy" — Free slots exist but all start at or after dueBy.
 *
 * Adding a new reason requires updating the exhaustive switch in slotter.ts (ADR-3 gate).
 */
export type UnscheduledReason = "does-not-fit" | "no-free-slot-before-dueBy";

/** The output of planSlots: placed items + unplaced items with reasons. */
export interface ProposedPlan {
  scheduled: PlanItem[];
  unscheduled: Array<{ findingId: string; reason: UnscheduledReason }>;
}
