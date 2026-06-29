import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { planSlots } from "./slotter.js";
import type { Finding, BusyInterval, SlotConstraints } from "./types.js";

// ── Test fixtures ─────────────────────────────────────────────────────

/**
 * Three findings ranked by priority (urgency desc): 30-min, 60-min, 90-min.
 * Window is exactly 90 minutes, so only the first two fit.
 */
const FINDING_30: Finding = {
  id: "f-30",
  domain: "coding",
  title: "Quick task — 30 min",
  kind: "action",
  urgency: 5,
  severity: 4,
  evidence: ["evidence A"],
  surfacedAt: "2026-06-29T00:00:00.000Z",
  tags: [],
  estDurationMin: 30,
  status: "open",
};

const FINDING_60: Finding = {
  id: "f-60",
  domain: "coding",
  title: "Medium task — 60 min",
  kind: "action",
  urgency: 4,
  severity: 3,
  evidence: ["evidence B"],
  surfacedAt: "2026-06-29T00:00:00.000Z",
  tags: [],
  estDurationMin: 60,
  status: "open",
};

const FINDING_90: Finding = {
  id: "f-90",
  domain: "coding",
  title: "Long task — 90 min",
  kind: "watch",
  urgency: 3,
  severity: 2,
  evidence: ["evidence C"],
  surfacedAt: "2026-06-29T00:00:00.000Z",
  tags: [],
  estDurationMin: 90,
  status: "open",
};

/** Findings in pre-ranked priority order: f-30, f-60, f-90. */
const FINDINGS_30_60_90: Finding[] = [FINDING_30, FINDING_60, FINDING_90];

/** No busy intervals — the full window is free. */
const NO_BUSY: BusyInterval[] = [];

/**
 * A 90-minute planning window: 08:00–09:30 UTC.
 * Room for exactly the first two findings (30 + 60 = 90 min).
 * The 90-min finding does not fit (0 remaining after the first two).
 */
const WINDOW_ROOM_FOR_TWO: SlotConstraints = {
  windowStartIso: "2026-06-29T08:00:00.000Z",
  windowEndIso: "2026-06-29T09:30:00.000Z",
};

/** A 4-hour window with room for all three findings. */
const WIDE_WINDOW: SlotConstraints = {
  windowStartIso: "2026-06-29T08:00:00.000Z",
  windowEndIso: "2026-06-29T12:00:00.000Z",
};

// ── sc-1-3: fit/overflow — two scheduled, one unscheduled ─────────────

describe("CalendarSlotter — fit/overflow (sc-1-3)", () => {
  it("schedules the two highest-priority findings that fit in the 90-min window", () => {
    const plan = planSlots(FINDINGS_30_60_90, NO_BUSY, WINDOW_ROOM_FOR_TWO);

    expect(plan.scheduled).toHaveLength(2);
    expect(plan.scheduled[0].findingId).toBe("f-30");
    expect(plan.scheduled[1].findingId).toBe("f-60");
  });

  it("returns the third finding in unscheduled with a recognised reason", () => {
    const plan = planSlots(FINDINGS_30_60_90, NO_BUSY, WINDOW_ROOM_FOR_TWO);

    expect(plan.unscheduled).toHaveLength(1);
    expect(plan.unscheduled[0]).toMatchObject({
      findingId: "f-90",
      reason: expect.stringMatching(/^(does-not-fit|no-free-slot-before-dueBy)$/),
    });
  });

  it("scheduled items have ISO start/end inside the free window with no busy overlap", () => {
    const plan = planSlots(FINDINGS_30_60_90, NO_BUSY, WINDOW_ROOM_FOR_TWO);

    const windowStart = Date.parse(WINDOW_ROOM_FOR_TWO.windowStartIso);
    const windowEnd = Date.parse(WINDOW_ROOM_FOR_TWO.windowEndIso);

    for (const item of plan.scheduled) {
      const itemStart = Date.parse(item.startIso);
      const itemEnd = Date.parse(item.endIso);
      expect(itemStart).toBeGreaterThanOrEqual(windowStart);
      expect(itemEnd).toBeLessThanOrEqual(windowEnd);
      expect(itemStart).toBeLessThan(itemEnd);
    }
  });

  it("places findings in input order — f-30 starts before f-60", () => {
    const plan = planSlots(FINDINGS_30_60_90, NO_BUSY, WINDOW_ROOM_FOR_TWO);

    const start30 = Date.parse(plan.scheduled[0].startIso);
    const start60 = Date.parse(plan.scheduled[1].startIso);
    expect(start30).toBeLessThan(start60);
  });

  it("schedules all three when the window is wide enough", () => {
    const plan = planSlots(FINDINGS_30_60_90, NO_BUSY, WIDE_WINDOW);
    expect(plan.scheduled).toHaveLength(3);
    expect(plan.unscheduled).toHaveLength(0);
  });

  it("uses calendarSafeTitle when present", () => {
    const findingWithSafeTitle: Finding = {
      ...FINDING_30,
      calendarSafeTitle: "Safe title for calendar",
    };
    const plan = planSlots([findingWithSafeTitle], NO_BUSY, WIDE_WINDOW);
    expect(plan.scheduled[0].title).toBe("Safe title for calendar");
  });

  it("falls back to title when calendarSafeTitle is absent", () => {
    const plan = planSlots([FINDING_30], NO_BUSY, WIDE_WINDOW);
    expect(plan.scheduled[0].title).toBe(FINDING_30.title);
  });

  it("returns 'no-free-slot-before-dueBy' when all free slots start after dueBy", () => {
    const dueByInPast = "2026-06-29T07:00:00.000Z"; // before window starts at 08:00
    const findingWithPastDueBy: Finding = {
      ...FINDING_30,
      dueBy: dueByInPast,
    };
    const plan = planSlots([findingWithPastDueBy], NO_BUSY, WINDOW_ROOM_FOR_TWO);
    expect(plan.unscheduled).toHaveLength(1);
    expect(plan.unscheduled[0].reason).toBe("no-free-slot-before-dueBy");
  });

  it("handles busy intervals by scheduling around them", () => {
    // Block 08:00-08:30 → only 08:30-09:30 (60 min) is free
    const busy: BusyInterval[] = [
      { startIso: "2026-06-29T08:00:00.000Z", endIso: "2026-06-29T08:30:00.000Z" },
    ];
    const plan = planSlots(FINDINGS_30_60_90, busy, WINDOW_ROOM_FOR_TWO);

    // 60-min free slot: fits f-30 (30 min) but not f-60 after that (30 min remaining vs 60 needed)
    // So f-30 is scheduled, f-60 not, f-90 not
    // Wait: free is 08:30-09:30 (60 min). f-30 (30 min) fits → 08:30-09:00 taken.
    // Remaining: 09:00-09:30 (30 min). f-60 (60 min) does not fit. f-90 (90 min) does not fit.
    expect(plan.scheduled[0].findingId).toBe("f-30");
    expect(plan.scheduled[0].startIso).toBe("2026-06-29T08:30:00.000Z");
    expect(plan.unscheduled.some((u) => u.findingId === "f-60")).toBe(true);
    expect(plan.unscheduled.some((u) => u.findingId === "f-90")).toBe(true);
  });

  it("uses default duration of 30 min when estDurationMin is absent", () => {
    const findingNoEstimate: Finding = {
      ...FINDING_30,
      id: "f-no-estimate",
      estDurationMin: undefined,
    };
    const plan = planSlots([findingNoEstimate], NO_BUSY, WINDOW_ROOM_FOR_TWO);
    expect(plan.scheduled).toHaveLength(1);
    const durationMs = Date.parse(plan.scheduled[0].endIso) - Date.parse(plan.scheduled[0].startIso);
    expect(durationMs).toBe(30 * 60 * 1000);
  });
});

// ── sc-1-4: determinism — identical input => deep-equal output ────────

describe("CalendarSlotter — determinism (sc-1-4)", () => {
  it("calling planSlots twice with identical input returns deep-equal output", () => {
    const a = planSlots(FINDINGS_30_60_90, NO_BUSY, WINDOW_ROOM_FOR_TWO);
    const b = planSlots(FINDINGS_30_60_90, NO_BUSY, WINDOW_ROOM_FOR_TWO);
    expect(a).toEqual(b);
  });

  it("is deterministic with a wide window and multiple findings", () => {
    const a = planSlots(FINDINGS_30_60_90, NO_BUSY, WIDE_WINDOW);
    const b = planSlots(FINDINGS_30_60_90, NO_BUSY, WIDE_WINDOW);
    expect(a).toEqual(b);
  });

  it("is deterministic with busy intervals", () => {
    const busy: BusyInterval[] = [
      { startIso: "2026-06-29T08:15:00.000Z", endIso: "2026-06-29T08:45:00.000Z" },
    ];
    const a = planSlots(FINDINGS_30_60_90, busy, WIDE_WINDOW);
    const b = planSlots(FINDINGS_30_60_90, busy, WIDE_WINDOW);
    expect(a).toEqual(b);
  });

  it("empty input returns empty plan deterministically", () => {
    const a = planSlots([], NO_BUSY, WINDOW_ROOM_FOR_TWO);
    const b = planSlots([], NO_BUSY, WINDOW_ROOM_FOR_TWO);
    expect(a).toEqual(b);
    expect(a.scheduled).toHaveLength(0);
    expect(a.unscheduled).toHaveLength(0);
  });
});

// ── sc-1-5: purity boundary scan — no await / node:fs / provider import

describe("sc-1-5: slotter.ts purity boundary", () => {
  it("slotter.ts contains no await, no node:fs import, no provider/LLM import", async () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const src = await readFile(join(dir, "slotter.ts"), "utf8");

    expect(src).not.toMatch(/\bawait\b/);
    expect(src).not.toMatch(/node:fs/);
    expect(src).not.toMatch(/providers\//); // no provider/LLM client import
    expect(src).not.toMatch(/child_process|execa/);
    // Also assert no async function signatures
    expect(src).not.toMatch(/\basync\b/);
  });
});
