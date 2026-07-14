import { describe, it, expect } from "vitest";
import type { Finding } from "./finding.js";
import { parseScope, applyFilter } from "./scope.js";

// ── Fixtures ──────────────────────────────────────────────────────────

const T = "2026-06-28T00:00:00.000Z";

function makeFinding(over: Partial<Finding> = {}): Finding {
  return {
    id: "f-001",
    domain: "medical",
    title: "Test finding",
    kind: "action",
    urgency: 3,
    severity: 4,
    evidence: ["evidence 1"],
    surfacedAt: T,
    tags: [],
    status: "open",
    ...over,
  };
}

const NOW = new Date("2026-06-28T00:00:00.000Z");

// ── parseScope ────────────────────────────────────────────────────────

describe("parseScope", () => {
  it("parses general scope", () => {
    expect(parseScope({ mode: "general" })).toEqual({ mode: "general" });
  });

  it("parses decision scope with both options", () => {
    const result = parseScope({
      mode: "decision",
      optionA: "buy a house",
      optionB: "rent an apartment",
    });
    expect(result).toEqual({
      mode: "decision",
      optionA: "buy a house",
      optionB: "rent an apartment",
    });
  });

  it("parses filtered scope with domain only", () => {
    const result = parseScope({ mode: "filtered", domain: "medical" });
    expect(result).toEqual({ mode: "filtered", domain: "medical" });
  });

  it("parses filtered scope with tag only", () => {
    const result = parseScope({ mode: "filtered", tag: "urgent" });
    expect(result).toEqual({ mode: "filtered", tag: "urgent" });
  });

  it("parses filtered scope with dueWithinDays only", () => {
    const result = parseScope({ mode: "filtered", dueWithinDays: 7 });
    expect(result).toEqual({ mode: "filtered", dueWithinDays: 7 });
  });

  it("parses filtered scope with all optional fields", () => {
    const result = parseScope({
      mode: "filtered",
      domain: "finance",
      dueWithinDays: 14,
      tag: "high-priority",
    });
    expect(result).toEqual({
      mode: "filtered",
      domain: "finance",
      dueWithinDays: 14,
      tag: "high-priority",
    });
  });

  it("falls back to general on null input", () => {
    expect(parseScope(null)).toEqual({ mode: "general" });
  });

  it("falls back to general on unknown mode", () => {
    expect(parseScope({ mode: "unknown" })).toEqual({ mode: "general" });
  });

  it("falls back to general on missing optionA for decision scope", () => {
    expect(parseScope({ mode: "decision", optionB: "B" })).toEqual({ mode: "general" });
  });

  it("falls back to general on non-object input", () => {
    expect(parseScope("general")).toEqual({ mode: "general" });
    expect(parseScope(42)).toEqual({ mode: "general" });
  });
});

// ── applyFilter ───────────────────────────────────────────────────────

describe("applyFilter", () => {
  it("returns findings unchanged for general scope", () => {
    const findings = [makeFinding({ id: "f-1" }), makeFinding({ id: "f-2" })];
    const result = applyFilter(findings, { mode: "general" }, NOW);
    expect(result).toHaveLength(2);
    expect(result).toBe(findings); // exact same array reference for non-filtered
  });

  it("returns findings unchanged for decision scope", () => {
    const findings = [makeFinding()];
    const scope = parseScope({ mode: "decision", optionA: "A", optionB: "B" });
    const result = applyFilter(findings, scope, NOW);
    expect(result).toBe(findings);
  });

  it("filters by domain (sc-3-1)", () => {
    const findings = [
      makeFinding({ id: "f-1", domain: "medical" }),
      makeFinding({ id: "f-2", domain: "finance" }),
      makeFinding({ id: "f-3", domain: "medical" }),
    ];
    const scope = parseScope({ mode: "filtered", domain: "medical" });
    const result = applyFilter(findings, scope, NOW);
    expect(result).toHaveLength(2);
    expect(result.map((f) => f.id)).toEqual(["f-1", "f-3"]);
  });

  it("filters by tag (sc-3-1)", () => {
    const findings = [
      makeFinding({ id: "f-1", tags: ["urgent", "medical"] }),
      makeFinding({ id: "f-2", tags: ["low-priority"] }),
      makeFinding({ id: "f-3", tags: ["urgent"] }),
    ];
    const scope = parseScope({ mode: "filtered", tag: "urgent" });
    const result = applyFilter(findings, scope, NOW);
    expect(result).toHaveLength(2);
    expect(result.map((f) => f.id)).toEqual(["f-1", "f-3"]);
  });

  it("filters by dueWithinDays (sc-3-1)", () => {
    // NOW = 2026-06-28; dueWithinDays=7 → deadline = 2026-07-05
    const findings = [
      makeFinding({ id: "f-1", dueBy: "2026-07-01T00:00:00.000Z" }), // within 7 days ✓
      makeFinding({ id: "f-2", dueBy: "2026-07-10T00:00:00.000Z" }), // past 7 days ✗
      makeFinding({ id: "f-3" }), // no dueBy → does NOT satisfy dueWithinDays ✗
    ];
    const scope = parseScope({ mode: "filtered", dueWithinDays: 7 });
    const result = applyFilter(findings, scope, NOW);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("f-1");
  });

  it("dueBy undefined does NOT satisfy dueWithinDays constraint (sc-3-1)", () => {
    const findings = [makeFinding({ id: "f-1" })]; // no dueBy
    const scope = parseScope({ mode: "filtered", dueWithinDays: 30 });
    const result = applyFilter(findings, scope, NOW);
    expect(result).toHaveLength(0);
  });

  it("dueBy exactly at deadline boundary is included", () => {
    // deadline = NOW + 7 days = 2026-07-05T00:00:00.000Z
    const findings = [
      makeFinding({ id: "f-1", dueBy: "2026-07-05T00:00:00.000Z" }), // exactly at deadline
    ];
    const scope = parseScope({ mode: "filtered", dueWithinDays: 7 });
    const result = applyFilter(findings, scope, NOW);
    expect(result).toHaveLength(1);
  });

  it("combines domain AND tag constraints (AND logic)", () => {
    const findings = [
      makeFinding({ id: "f-1", domain: "medical", tags: ["urgent"] }), // both match ✓
      makeFinding({ id: "f-2", domain: "medical", tags: ["low"] }),    // domain match only ✗
      makeFinding({ id: "f-3", domain: "finance", tags: ["urgent"] }), // tag match only ✗
    ];
    const scope = parseScope({ mode: "filtered", domain: "medical", tag: "urgent" });
    const result = applyFilter(findings, scope, NOW);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("f-1");
  });

  it("combines domain AND dueWithinDays constraints (AND logic)", () => {
    const findings = [
      makeFinding({ id: "f-1", domain: "medical", dueBy: "2026-07-01T00:00:00.000Z" }), // both ✓
      makeFinding({ id: "f-2", domain: "medical" }),                                      // no dueBy ✗
      makeFinding({ id: "f-3", domain: "finance", dueBy: "2026-07-01T00:00:00.000Z" }), // domain ✗
    ];
    const scope = parseScope({ mode: "filtered", domain: "medical", dueWithinDays: 7 });
    const result = applyFilter(findings, scope, NOW);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("f-1");
  });

  it("returns all findings when filtered scope has no constraints specified", () => {
    const findings = [makeFinding({ id: "f-1" }), makeFinding({ id: "f-2" })];
    const scope = parseScope({ mode: "filtered" });
    const result = applyFilter(findings, scope, NOW);
    expect(result).toHaveLength(2);
  });

  it("returns empty array when no findings match", () => {
    const findings = [makeFinding({ domain: "finance" })];
    const scope = parseScope({ mode: "filtered", domain: "medical" });
    const result = applyFilter(findings, scope, NOW);
    expect(result).toHaveLength(0);
  });

  it("uses injected now for dueWithinDays (deterministic)", () => {
    const findingDue = "2026-07-01T00:00:00.000Z";
    const findings = [makeFinding({ id: "f-1", dueBy: findingDue })];
    const scope = parseScope({ mode: "filtered", dueWithinDays: 7 });

    // now = 2026-06-28 → deadline = 2026-07-05 → finding is within range ✓
    const resultWithin = applyFilter(findings, scope, new Date("2026-06-28T00:00:00.000Z"));
    expect(resultWithin).toHaveLength(1);

    // now = 2026-07-01 → deadline = 2026-07-08 → still within ✓
    const resultLater = applyFilter(findings, scope, new Date("2026-07-01T00:00:00.000Z"));
    expect(resultLater).toHaveLength(1);

    // now = 2026-06-26 → deadline = 2026-07-03 → finding due 2026-07-01 is within ✓
    const resultEarlier = applyFilter(findings, scope, new Date("2026-06-26T00:00:00.000Z"));
    expect(resultEarlier).toHaveLength(1);

    // now = 2026-06-20 → deadline = 2026-06-27 → finding due 2026-07-01 is PAST ✗
    const resultTooEarly = applyFilter(findings, scope, new Date("2026-06-20T00:00:00.000Z"));
    expect(resultTooEarly).toHaveLength(0);
  });
});
