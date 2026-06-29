/**
 * Tests for computeNextDue (sc-4-1) — deterministic, clock-free cadence math.
 *
 * All assertions use fixed ISO inputs; no wall clock is involved.
 * Mirrors the pure-function test style in src/calendar/slotter.test.ts.
 */

import { describe, it, expect } from "vitest";
import { computeNextDue } from "./cadence.js";

// ── Standard cadence tests ─────────────────────────────────────────────

describe("computeNextDue — sc-4-1 (deterministic, clock-free)", () => {
  const BASE = "2026-06-15T12:00:00.000Z";

  it("daily adds exactly one UTC day", () => {
    expect(computeNextDue("daily", BASE)).toBe("2026-06-16T12:00:00.000Z");
  });

  it("weekly adds exactly seven UTC days", () => {
    expect(computeNextDue("weekly", BASE)).toBe("2026-06-22T12:00:00.000Z");
  });

  it("monthly adds one calendar month", () => {
    expect(computeNextDue("monthly", BASE)).toBe("2026-07-15T12:00:00.000Z");
  });

  it("is deterministic — identical inputs always yield identical output", () => {
    expect(computeNextDue("weekly", BASE)).toBe(computeNextDue("weekly", BASE));
    expect(computeNextDue("daily", BASE)).toBe(computeNextDue("daily", BASE));
    expect(computeNextDue("monthly", BASE)).toBe(computeNextDue("monthly", BASE));
  });

  it("returns a valid ISO-8601 datetime string (parseable by Date.parse)", () => {
    for (const cadence of ["daily", "weekly", "monthly"] as const) {
      const result = computeNextDue(cadence, BASE);
      expect(typeof result).toBe("string");
      expect(Number.isFinite(Date.parse(result))).toBe(true);
    }
  });
});

// ── Month-length rollover edge case ───────────────────────────────────

describe("computeNextDue — month-length rollover (documented behaviour)", () => {
  it("Jan 31 + 1 month overflows into March (Feb has 28 days in 2026, non-leap)", () => {
    // JS setUTCMonth(1) on Jan 31 → Feb 31 which does not exist → Mar 3
    const result = computeNextDue("monthly", "2026-01-31T00:00:00.000Z");
    // Document the actual deterministic output (contract says: do NOT clamp)
    expect(result).toBe("2026-03-03T00:00:00.000Z");
  });

  it("Jan 30 + 1 month overflows into March (Feb has 28 days in 2026, non-leap)", () => {
    // JS setUTCMonth(1) on Jan 30 → Feb 30 which does not exist → Mar 2
    const result = computeNextDue("monthly", "2026-01-30T00:00:00.000Z");
    expect(result).toBe("2026-03-02T00:00:00.000Z");
  });

  it("Jan 28 + 1 month stays in February (no overflow)", () => {
    const result = computeNextDue("monthly", "2026-01-28T00:00:00.000Z");
    expect(result).toBe("2026-02-28T00:00:00.000Z");
  });

  it("Dec 31 + 1 month advances to January of next year", () => {
    const result = computeNextDue("monthly", "2026-12-31T00:00:00.000Z");
    // Dec=11, setUTCMonth(12) → Jan of next year; day 31 in Jan is valid
    expect(result).toBe("2027-01-31T00:00:00.000Z");
  });
});
