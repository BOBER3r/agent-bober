import { describe, it, expect } from "vitest";
import { FindingSchema } from "./finding.js";

// ── Fixtures ─────────────────────────────────────────────────────────

const VALID_FINDING = {
  id: "f-001",
  domain: "medical",
  title: "Review cholesterol levels",
  kind: "action" as const,
  urgency: 3,
  severity: 4,
  evidence: ["Lab result 2026-06-28: LDL 145 mg/dL"],
  surfacedAt: "2026-06-28T00:00:00.000Z",
  dueBy: "2026-07-28T00:00:00.000Z",
  tags: ["cholesterol", "cardiology"],
  estDurationMin: 30,
  calendarSafeTitle: "Review cholesterol",
  status: "open" as const,
  promotesTo: undefined,
};

// ── Tests: sc-1-2 ────────────────────────────────────────────────────

describe("FindingSchema", () => {
  it("accepts a fully-populated valid finding", () => {
    expect(FindingSchema.safeParse(VALID_FINDING).success).toBe(true);
  });

  it("accepts a minimal valid finding (only required fields)", () => {
    const minimal = {
      id: "f-002",
      domain: "health",
      title: "Watch vitamin D",
      kind: "watch",
      urgency: 1,
      severity: 1,
      evidence: [],
      surfacedAt: "2026-06-28T00:00:00.000Z",
      tags: [],
      status: "open",
    };
    expect(FindingSchema.safeParse(minimal).success).toBe(true);
  });

  it("rejects urgency of 6 (above max 5)", () => {
    const bad = { ...VALID_FINDING, urgency: 6 };
    const result = FindingSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects urgency of 0 (below min 1)", () => {
    const bad = { ...VALID_FINDING, urgency: 0 };
    expect(FindingSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects kind of 'todo' (not in enum)", () => {
    const bad = { ...VALID_FINDING, kind: "todo" };
    expect(FindingSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects kind of 'info' (not in enum)", () => {
    const bad = { ...VALID_FINDING, kind: "info" };
    expect(FindingSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects status of 'pending' (not in enum)", () => {
    const bad = { ...VALID_FINDING, status: "pending" };
    expect(FindingSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a finding with empty id", () => {
    const bad = { ...VALID_FINDING, id: "" };
    expect(FindingSchema.safeParse(bad).success).toBe(false);
  });

  it("accepts all valid kind enum values", () => {
    for (const kind of ["action", "watch", "risk", "question"] as const) {
      expect(FindingSchema.safeParse({ ...VALID_FINDING, kind }).success).toBe(true);
    }
  });

  it("accepts all valid status enum values", () => {
    for (const status of ["open", "in-progress", "snoozed", "done", "dropped"] as const) {
      expect(FindingSchema.safeParse({ ...VALID_FINDING, status }).success).toBe(true);
    }
  });

  it("rejects non-integer urgency (float)", () => {
    const bad = { ...VALID_FINDING, urgency: 2.5 };
    expect(FindingSchema.safeParse(bad).success).toBe(false);
  });

  it("optional fields can be omitted", () => {
    const { dueBy: _dueBy, estDurationMin: _estDuration, calendarSafeTitle: _cal, promotesTo: _pt, ...minimal } = VALID_FINDING;
    expect(FindingSchema.safeParse(minimal).success).toBe(true);
  });
});
