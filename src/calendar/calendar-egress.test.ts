/**
 * CalendarEgressGuard unit tests — sc-3-1 / sc-3-3.
 * Verifies that the guard reads the calendar.egress.cloudCalendar flag from BoberConfig,
 * throws naming the flag when off, and returns without throwing when on.
 */

import { describe, it, expect } from "vitest";
import type { BoberConfig } from "../config/schema.js";
import { CalendarEgressGuard } from "./calendar-egress.js";

// ── Helpers ───────────────────────────────────────────────────────────

/** Minimal BoberConfig stub — only the fields tested in this file. */
function makeConfig(cloudCalendar: boolean): BoberConfig {
  return {
    calendar: { egress: { cloudCalendar }, connector: "ics" },
  } as unknown as BoberConfig;
}

function makeConfigNoCalendar(): BoberConfig {
  return {} as BoberConfig;
}

// ── fromConfig — axis off (default) ──────────────────────────────────

describe("CalendarEgressGuard — axis off", () => {
  it("isCloudCalendarAllowed() returns false when cloudCalendar is false", () => {
    const guard = CalendarEgressGuard.fromConfig(makeConfig(false));
    expect(guard.isCloudCalendarAllowed()).toBe(false);
  });

  it("assertCloudCalendarAllowed() throws when axis is off", () => {
    const guard = CalendarEgressGuard.fromConfig(makeConfig(false));
    expect(() => guard.assertCloudCalendarAllowed()).toThrow(
      /calendar\.egress\.cloudCalendar/,
    );
  });

  it("thrown message names the config flag exactly", () => {
    const guard = CalendarEgressGuard.fromConfig(makeConfig(false));
    let msg = "";
    try {
      guard.assertCloudCalendarAllowed();
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toContain("calendar.egress.cloudCalendar");
  });
});

// ── fromConfig — axis on ─────────────────────────────────────────────

describe("CalendarEgressGuard — axis on", () => {
  it("isCloudCalendarAllowed() returns true when cloudCalendar is true", () => {
    const guard = CalendarEgressGuard.fromConfig(makeConfig(true));
    expect(guard.isCloudCalendarAllowed()).toBe(true);
  });

  it("assertCloudCalendarAllowed() does not throw when axis is on", () => {
    const guard = CalendarEgressGuard.fromConfig(makeConfig(true));
    expect(() => guard.assertCloudCalendarAllowed()).not.toThrow();
  });
});

// ── fromConfig — no calendar section (additive proof) ────────────────

describe("CalendarEgressGuard — no calendar section in config", () => {
  it("defaults to false when no calendar key present", () => {
    const guard = CalendarEgressGuard.fromConfig(makeConfigNoCalendar());
    expect(guard.isCloudCalendarAllowed()).toBe(false);
  });

  it("throws when no calendar key present (axis defaults off)", () => {
    const guard = CalendarEgressGuard.fromConfig(makeConfigNoCalendar());
    expect(() => guard.assertCloudCalendarAllowed()).toThrow(
      /calendar\.egress\.cloudCalendar/,
    );
  });
});

// ── direct constructor ────────────────────────────────────────────────

describe("CalendarEgressGuard — direct constructor", () => {
  it("new CalendarEgressGuard(false) refuses", () => {
    const guard = new CalendarEgressGuard(false);
    expect(() => guard.assertCloudCalendarAllowed()).toThrow();
  });

  it("new CalendarEgressGuard(true) allows", () => {
    const guard = new CalendarEgressGuard(true);
    expect(() => guard.assertCloudCalendarAllowed()).not.toThrow();
  });
});
