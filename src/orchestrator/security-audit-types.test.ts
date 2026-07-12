import { describe, it, expect } from "vitest";
import type { ReviewResult } from "./code-reviewer-agent.js";
import { deriveVerdict, type SecurityFinding, type SecurityAuditResult } from "./security-audit-types.js";

// ── Fixture ───────────────────────────────────────────────────────────

const baseReview: ReviewResult = {
  reviewId: "r",
  contractId: "c",
  specId: "s",
  timestamp: "2026-01-01T00:00:00.000Z",
  summary: "",
  critical: [],
  important: [],
  minor: [],
  approvedAreas: [],
};

// ── deriveVerdict ─────────────────────────────────────────────────────

describe("deriveVerdict", () => {
  it.each<[ReviewResult["critical"], ReviewResult["important"], "pass" | "blocked"]>([
    [[], [], "pass"],
    [[{ description: "SQL injection", evidence: [] }], [], "blocked"],
    [[], [{ description: "weak validation", evidence: [] }], "pass"],
    [
      [
        { description: "SQLi", evidence: [] },
        { description: "path traversal", evidence: [] },
      ],
      [{ description: "important-only", evidence: [] }],
      "blocked",
    ],
  ])("critical=%j important=%j -> %s", (critical, important, expected) => {
    const review: ReviewResult = { ...baseReview, critical, important };
    expect(deriveVerdict(review)).toBe(expected);
  });

  it("is pure — does not mutate the input review", () => {
    const review: ReviewResult = {
      ...baseReview,
      critical: [{ description: "x", evidence: [] }],
    };
    const snapshot = JSON.stringify(review);
    deriveVerdict(review);
    expect(JSON.stringify(review)).toBe(snapshot);
  });
});

// ── Type shape checks ─────────────────────────────────────────────────

describe("SecurityFinding", () => {
  it("allows vulnClass to be omitted (optional)", () => {
    const finding: SecurityFinding = { description: "x", evidence: [] };
    expect(finding.vulnClass).toBeUndefined();
  });

  it("allows a valid vulnClass value", () => {
    const finding: SecurityFinding = {
      description: "SQL injection via string concat",
      evidence: [{ path: "src/db.ts", line: 10, snippet: "query(`SELECT ${x}`)" }],
      vulnClass: "injection",
    };
    expect(finding.vulnClass).toBe("injection");
  });
});

describe("SecurityAuditResult", () => {
  it("derives verdict consistently with deriveVerdict for a blocked case", () => {
    const review: ReviewResult = {
      ...baseReview,
      critical: [{ description: "secret leaked", evidence: [] }],
    };
    const result: SecurityAuditResult = {
      review,
      stack: "node",
      scannerRan: false,
      parsed: true,
      verdict: deriveVerdict(review),
    };
    expect(result.verdict).toBe("blocked");
  });

  it("derives verdict consistently with deriveVerdict for a pass case", () => {
    const review: ReviewResult = { ...baseReview };
    const result: SecurityAuditResult = {
      review,
      stack: "node",
      scannerRan: true,
      parsed: true,
      verdict: deriveVerdict(review),
    };
    expect(result.verdict).toBe("pass");
  });
});
