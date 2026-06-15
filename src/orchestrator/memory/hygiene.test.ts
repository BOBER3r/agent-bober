/**
 * Unit tests for the PURE pruneLessons function (hygiene.ts).
 *
 * All tests operate on in-memory PrunableLesson literals — no tmpdir or
 * filesystem access needed for the core partition logic.
 *
 * Fixed now: "2026-01-01T00:00:00.000Z" (injected, never read inside pruneLessons).
 */

import { describe, it, expect } from "vitest";
import { pruneLessons, THIRTY_DAYS_MS } from "./hygiene.js";
import type { PrunableLesson } from "./hygiene.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = "2026-01-01T00:00:00.000Z";
const NOW_MS = Date.parse(NOW);

/** ISO timestamp `offsetMs` milliseconds before NOW. */
function ago(offsetMs: number): string {
  return new Date(NOW_MS - offsetMs).toISOString();
}

function makeRec(
  lessonId: string,
  overrides: Partial<PrunableLesson> = {},
): PrunableLesson {
  return {
    lessonId,
    category: "sprint-rework",
    severity: "warn",
    occurrences: 3,
    tags: ["phase:rework", `sprintId:${lessonId}`],
    summarySnippet: `Lesson ${lessonId}: default fixture`,
    createdAt: ago(1000), // recent by default
    ...overrides,
  };
}

// ── C1: decay partition ───────────────────────────────────────────────────────

describe("decay partition", () => {
  it("keeps a high-occurrence recent lesson", () => {
    const rec = makeRec("l-keep", { occurrences: 5, createdAt: ago(1000) });
    const { kept, quarantined } = pruneLessons([rec], { now: NOW });
    expect(kept.map((r) => r.lessonId)).toContain("l-keep");
    expect(quarantined).toHaveLength(0);
  });

  it("quarantines a low-occurrence stale lesson (below minOccurrences + older than maxAgeMs)", () => {
    const staleOld = makeRec("l-stale", {
      occurrences: 1,
      createdAt: ago(THIRTY_DAYS_MS + 1),
    });
    const { kept, quarantined } = pruneLessons([staleOld], { now: NOW });
    expect(quarantined.map((r) => r.lessonId)).toContain("l-stale");
    expect(kept).toHaveLength(0);
  });

  it("keeps a low-occurrence lesson that is still recent (not stale)", () => {
    const recentLow = makeRec("l-recent-low", {
      occurrences: 1,
      createdAt: ago(THIRTY_DAYS_MS - 1000), // just inside the window
    });
    const { kept, quarantined } = pruneLessons([recentLow], { now: NOW });
    expect(kept.map((r) => r.lessonId)).toContain("l-recent-low");
    expect(quarantined).toHaveLength(0);
  });

  it("quarantines a low-occurrence lesson with missing createdAt (maximally stale rule)", () => {
    const noDate = makeRec("l-no-date", { occurrences: 1, createdAt: undefined });
    const { kept: _kept, quarantined } = pruneLessons([noDate], { now: NOW });
    expect(quarantined.map((r) => r.lessonId)).toContain("l-no-date");
  });

  it("keeps a high-occurrence lesson even when createdAt is very old", () => {
    const oldHigh = makeRec("l-old-high", {
      occurrences: 10,
      createdAt: ago(365 * 24 * 60 * 60 * 1000), // 1 year old
    });
    const { kept, quarantined } = pruneLessons([oldHigh], { now: NOW });
    expect(kept.map((r) => r.lessonId)).toContain("l-old-high");
    expect(quarantined).toHaveLength(0);
  });

  it("respects custom minOccurrences threshold", () => {
    const rec = makeRec("l-custom", { occurrences: 3, createdAt: ago(THIRTY_DAYS_MS + 1) });
    // Default minOccurrences=2: occurrences=3 >= 2, so kept
    const defaultResult = pruneLessons([rec], { now: NOW });
    expect(defaultResult.kept.map((r) => r.lessonId)).toContain("l-custom");

    // Custom minOccurrences=5: occurrences=3 < 5 AND stale → quarantined
    const customResult = pruneLessons([rec], { now: NOW, minOccurrences: 5 });
    expect(customResult.quarantined.map((r) => r.lessonId)).toContain("l-custom");
  });

  it("respects custom maxAgeMs threshold", () => {
    const rec = makeRec("l-custom-age", {
      occurrences: 1,
      createdAt: ago(7 * 24 * 60 * 60 * 1000), // 7 days old
    });
    // Default maxAgeMs = 30 days: 7 days < 30 days → kept (recent)
    const defaultResult = pruneLessons([rec], { now: NOW });
    expect(defaultResult.kept.map((r) => r.lessonId)).toContain("l-custom-age");

    // Custom maxAgeMs = 1 day: 7 days > 1 day → stale → quarantined
    const customResult = pruneLessons([rec], {
      now: NOW,
      maxAgeMs: 24 * 60 * 60 * 1000,
    });
    expect(customResult.quarantined.map((r) => r.lessonId)).toContain("l-custom-age");
  });

  it("returns empty kept and quarantined for empty input", () => {
    const { kept, quarantined } = pruneLessons([], { now: NOW });
    expect(kept).toEqual([]);
    expect(quarantined).toEqual([]);
  });
});

// ── C2: conflict detection (sc-3-5) ──────────────────────────────────────────

describe("conflict detection (sc-3-5)", () => {
  it("quarantines BOTH lessons of a deterministically-detected contradictory pair", () => {
    // Same category root + same sprintId discriminator → same contradiction key
    // Opposing polarity: "keep" vs "avoid"
    const a = makeRec("l-a", {
      category: "sprint-rework",
      tags: ["sprintId:s1", "keep"],
      occurrences: 5, // high occurrence — would NOT decay
      createdAt: ago(1000),
    });
    const b = makeRec("l-b", {
      category: "sprint-rework",
      tags: ["sprintId:s1", "avoid"],
      occurrences: 5,
      createdAt: ago(1000),
    });

    const { kept, quarantined } = pruneLessons([a, b], { now: NOW });

    expect(quarantined.map((r) => r.lessonId).sort()).toEqual(["l-a", "l-b"]);
    expect(kept).not.toContainEqual(expect.objectContaining({ lessonId: "l-a" }));
    expect(kept).not.toContainEqual(expect.objectContaining({ lessonId: "l-b" }));
  });

  it("does not quarantine lessons with the same key but neutral polarity (no conflict)", () => {
    // Two lessons with the same contradiction key but no opposing markers
    const a = makeRec("l-neutral-a", {
      category: "sprint-rework",
      tags: ["sprintId:s2"],
      occurrences: 5,
    });
    const b = makeRec("l-neutral-b", {
      category: "sprint-rework",
      tags: ["sprintId:s2"],
      occurrences: 5,
    });

    const { kept, quarantined } = pruneLessons([a, b], { now: NOW });
    expect(quarantined).toHaveLength(0);
    expect(kept.map((r) => r.lessonId).sort()).toEqual(["l-neutral-a", "l-neutral-b"]);
  });

  it("does not quarantine a lesson that only has keep polarity (no opposing partner)", () => {
    const rec = makeRec("l-keep-only", {
      category: "sprint-rework",
      tags: ["sprintId:s3", "keep"],
      occurrences: 5,
    });
    const result = pruneLessons([rec], { now: NOW });
    expect(result.quarantined).toHaveLength(0);
    expect(result.kept.map((r) => r.lessonId)).toContain("l-keep-only");
  });

  it("quarantines conflicting lessons regardless of occurrences or age", () => {
    // Even a very high-occurrence lesson is quarantined if it's in a conflict pair
    const a = makeRec("l-high-keep", {
      category: "eval-strategy-failure:unit-test",
      tags: ["strategy:unit-test", "keep"],
      occurrences: 100,
      createdAt: ago(100),
    });
    const b = makeRec("l-high-avoid", {
      category: "eval-strategy-failure:unit-test",
      tags: ["strategy:unit-test", "avoid"],
      occurrences: 100,
      createdAt: ago(100),
    });

    const { quarantined } = pruneLessons([a, b], { now: NOW });
    expect(quarantined.map((r) => r.lessonId).sort()).toEqual([
      "l-high-avoid",
      "l-high-keep",
    ]);
  });
});

// ── C3: sort stability ────────────────────────────────────────────────────────

describe("output sort stability", () => {
  it("kept array is sorted by lessonId ASC", () => {
    const records = [
      makeRec("l-z", { occurrences: 5 }),
      makeRec("l-a", { occurrences: 5 }),
      makeRec("l-m", { occurrences: 5 }),
    ];
    const { kept } = pruneLessons(records, { now: NOW });
    expect(kept.map((r) => r.lessonId)).toEqual(["l-a", "l-m", "l-z"]);
  });

  it("quarantined array is sorted by lessonId ASC", () => {
    const records = [
      makeRec("l-z", { occurrences: 1, createdAt: ago(THIRTY_DAYS_MS + 1) }),
      makeRec("l-a", { occurrences: 1, createdAt: ago(THIRTY_DAYS_MS + 1) }),
      makeRec("l-m", { occurrences: 1, createdAt: ago(THIRTY_DAYS_MS + 1) }),
    ];
    const { quarantined } = pruneLessons(records, { now: NOW });
    expect(quarantined.map((r) => r.lessonId)).toEqual(["l-a", "l-m", "l-z"]);
  });

  it("mixed kept and quarantined are each sorted by lessonId ASC independently", () => {
    const records = [
      makeRec("l-z", { occurrences: 5 }),                                    // kept
      makeRec("l-b", { occurrences: 1, createdAt: ago(THIRTY_DAYS_MS + 1) }), // quarantined
      makeRec("l-a", { occurrences: 5 }),                                    // kept
      makeRec("l-c", { occurrences: 1, createdAt: ago(THIRTY_DAYS_MS + 1) }), // quarantined
    ];
    const { kept, quarantined } = pruneLessons(records, { now: NOW });
    expect(kept.map((r) => r.lessonId)).toEqual(["l-a", "l-z"]);
    expect(quarantined.map((r) => r.lessonId)).toEqual(["l-b", "l-c"]);
  });
});
