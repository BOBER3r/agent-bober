/**
 * Calendar approval gate — propose (write pending marker, ZERO events) →
 * approve out-of-band → apply (writeEvents exactly once) → adjust (pure re-slot).
 *
 * Reuses src/state/approval-state.ts for marker storage — no new approval mechanism.
 * checkpointId convention: `calendar-${planId}` mirrors do-bridge's `promote-${findingId}`
 * so the existing `bober approve calendar-<id>` / `/approve calendar-<id>` flows work
 * with zero new wiring.
 *
 * ALL filesystem writes (pending marker, plan sidecar) live in this module.
 * src/cli/commands/calendar.ts MUST NOT import writeFile — the Sprint-1 source-scan
 * test (calendar.test.ts:129-141) enforces this.
 */

import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { savePending, deletePending } from "../state/approval-state.js";
import { ensureDir } from "../state/helpers.js";
import { planSlots } from "./slotter.js";
import type { CalendarConnector } from "./connector.js";
import type { Finding, BusyInterval, SlotConstraints, ProposedPlan } from "./types.js";
import type { RejectedMarker } from "../state/approval-state.js";

// ── Sidecar format ────────────────────────────────────────────────────

/**
 * Persisted sidecar JSON for a proposed calendar plan.
 * Stored at .bober/calendar/<checkpointId>.plan.json.
 * artifact.path in the PendingMarker points here so applyPlan can reload the items.
 */
interface PlanSidecar {
  plan: ProposedPlan;
  connectorName: string;
}

// ── ProposeArgs ───────────────────────────────────────────────────────

/** Arguments for proposePlan — all I/O dependencies are injected for testability. */
export interface ProposeArgs {
  /** Absolute project root (used for .bober/approvals and .bober/calendar paths). */
  projectRoot: string;
  /** Plan id — checkpointId = `calendar-${planId}`. */
  planId: string;
  /** The proposed plan from planSlots. */
  plan: ProposedPlan;
  /** Name of the chosen connector (informational; stored in sidecar). */
  connectorName: string;
  /** Clock injection — returns an ISO string. */
  now: () => string;
  /** Timeout in ms before the pending marker expires. Default 24 hours. */
  timeoutMs?: number;
}

// ── ApplyOutcome ──────────────────────────────────────────────────────

export type ApplyOutcome =
  | { status: "applied"; writtenCount: number }
  | { status: "rejected"; feedback?: string }
  | { status: "pending" };

// ── ConstraintDelta ───────────────────────────────────────────────────

/**
 * A constraint delta for adjustPlan — models a /tell-style user correction.
 * Note: SlotConstraints has no `excludeInterval` field; model exclusions by appending
 * a BusyInterval to the busy[] array (do NOT add new fields to SlotConstraints).
 */
export interface ConstraintDelta {
  /** Appended to busy[] to model an excluded interval. */
  excludeInterval?: BusyInterval;
  /** Shift the planning window start. */
  windowStartIso?: string;
  /** Shift the planning window end. */
  windowEndIso?: string;
}

// ── Internal path helpers ─────────────────────────────────────────────

function planSidecarPath(projectRoot: string, checkpointId: string): string {
  return join(projectRoot, ".bober", "calendar", `${checkpointId}.plan.json`);
}

function approvalsDirPath(projectRoot: string): string {
  return join(projectRoot, ".bober", "approvals");
}

// ── proposePlan ───────────────────────────────────────────────────────

/**
 * Write a pending approval marker + plan sidecar for the proposed schedule.
 * Calls ZERO connector.writeEvents — approval is strictly out-of-band.
 *
 * All filesystem writes live here:
 *   1. Plan sidecar (.bober/calendar/<id>.plan.json) — holds ProposedPlan + connectorName.
 *   2. Pending marker (.bober/approvals/<id>.pending.json) — artifact.path → sidecar.
 */
export async function proposePlan(args: ProposeArgs): Promise<{ checkpointId: string }> {
  const {
    projectRoot,
    planId,
    plan,
    connectorName,
    now,
    timeoutMs = 24 * 60 * 60 * 1_000,
  } = args;

  const checkpointId = `calendar-${planId}`;
  const requestedAt = now();
  const timeoutAt = new Date(Date.parse(requestedAt) + timeoutMs).toISOString();

  // ── 1. Write plan sidecar (proposal-gate owns ALL fs writes) ─────────
  const calendarDir = join(projectRoot, ".bober", "calendar");
  await ensureDir(calendarDir);
  const sidecarPath = planSidecarPath(projectRoot, checkpointId);
  const sidecar: PlanSidecar = { plan, connectorName };
  await writeFile(sidecarPath, JSON.stringify(sidecar, null, 2) + "\n", "utf-8");

  // ── 2. Write the pending marker ───────────────────────────────────────
  const scheduledCount = plan.scheduled.length;
  const unscheduledCount = plan.unscheduled.length;
  await savePending(projectRoot, {
    checkpointId,
    artifact: {
      type: "calendar-plan",
      path: sidecarPath,
      summary: `${scheduledCount} event(s) scheduled via ${connectorName}; ${unscheduledCount} unscheduled`,
      lines: scheduledCount,
    },
    prompt: `Calendar plan ready: ${scheduledCount} finding(s) scheduled. Run: bober calendar apply ${checkpointId}`,
    requestedAt,
    timeoutAt,
  });

  return { checkpointId };
}

// ── applyPlan ─────────────────────────────────────────────────────────

/**
 * Gate on the approval marker; on approval reload the plan sidecar and call
 * connector.writeEvents exactly once; on rejection skip the write entirely.
 *
 * There is no readApproved/readRejected export from approval-state.ts.
 * We detect the marker by building the path inline — mirrors the approach in
 * src/cli/commands/approve.ts:41 and src/do-bridge/promote.ts:140-146.
 *
 * Note: deletePending is best-effort (never throws); gate control is based on
 * the presence of the approved/rejected marker, not on the pending marker.
 */
export async function applyPlan(
  projectRoot: string,
  checkpointId: string,
  connector: CalendarConnector,
): Promise<ApplyOutcome> {
  const approvalsDir = approvalsDirPath(projectRoot);

  const entries = new Set(
    await readdir(approvalsDir).catch(() => [] as string[]),
  );

  // ── Approved branch: writeEvents exactly once ─────────────────────
  if (entries.has(`${checkpointId}.approved.json`)) {
    // Reload the plan sidecar to recover the scheduled PlanItems
    let sidecar: PlanSidecar;
    try {
      const raw = await readFile(planSidecarPath(projectRoot, checkpointId), "utf-8");
      sidecar = JSON.parse(raw) as PlanSidecar;
    } catch (err) {
      throw new Error(
        `Failed to reload plan sidecar for ${checkpointId}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    // Write events EXACTLY once
    const result = await connector.writeEvents(sidecar.plan.scheduled);

    // Clean up the pending marker (mirrors promote.ts:141)
    await deletePending(projectRoot, checkpointId);

    return { status: "applied", writtenCount: result.writtenCount };
  }

  // ── Rejected branch: no write ─────────────────────────────────────
  if (entries.has(`${checkpointId}.rejected.json`)) {
    try {
      const raw = await readFile(
        join(approvalsDir, `${checkpointId}.rejected.json`),
        "utf-8",
      );
      const marker = JSON.parse(raw) as RejectedMarker;
      return { status: "rejected", feedback: marker.feedback };
    } catch {
      return { status: "rejected" };
    }
  }

  // ── Neither: still pending ────────────────────────────────────────
  return { status: "pending" };
}

// ── adjustPlan ────────────────────────────────────────────────────────

/**
 * PURE re-slot under a constraint delta — models a /tell-style user correction.
 * Re-runs the Sprint-1 planSlots with a modified busy[] or window; writes NOTHING.
 *
 * Model an "exclude interval" by appending a BusyInterval (SlotConstraints has
 * no excludeInterval field — do NOT add one).
 */
export function adjustPlan(
  findings: Finding[],
  busy: BusyInterval[],
  constraints: SlotConstraints,
  delta: ConstraintDelta,
): ProposedPlan {
  const newBusy =
    delta.excludeInterval !== undefined ? [...busy, delta.excludeInterval] : busy;

  const newConstraints: SlotConstraints = {
    ...constraints,
    ...(delta.windowStartIso !== undefined ? { windowStartIso: delta.windowStartIso } : {}),
    ...(delta.windowEndIso !== undefined ? { windowEndIso: delta.windowEndIso } : {}),
  };

  return planSlots(findings, newBusy, newConstraints);
}
