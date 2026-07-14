import { describe, it, expect } from "vitest";
import type { ReviewResult } from "./code-reviewer-agent.js";
import {
  deriveVerdict,
  type SecurityFinding,
  type SecurityAuditResult,
  type VulnClass,
} from "./security-audit-types.js";
import { ALL_VULN_CLASSES } from "./stack-knowledge.js";

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

  it("allows all 5 new optional metadata fields to be omitted", () => {
    const finding: SecurityFinding = { description: "x", evidence: [] };
    expect(finding.cwe).toBeUndefined();
    expect(finding.severity).toBeUndefined();
    expect(finding.confidence).toBeUndefined();
    expect(finding.taint).toBeUndefined();
    expect(finding.signatureId).toBeUndefined();
  });

  it("round-trips cwe, severity, confidence, taint, and signatureId when present", () => {
    const finding: SecurityFinding = {
      description: "SSRF via unvalidated outbound URL",
      evidence: [{ path: "src/fetch.ts", line: 20, snippet: "fetch(userUrl)" }],
      vulnClass: "ssrf",
      cwe: "CWE-918",
      severity: "high",
      confidence: "firm",
      taint: { source: "req.query.url", sink: "fetch()", sanitizerPresent: false },
      signatureId: "sig-ssrf-001",
    };
    expect(finding.cwe).toBe("CWE-918");
    expect(finding.severity).toBe("high");
    expect(finding.confidence).toBe("firm");
    expect(finding.taint).toEqual({ source: "req.query.url", sink: "fetch()", sanitizerPresent: false });
    expect(finding.signatureId).toBe("sig-ssrf-001");
  });
});

// ── sc-1-1: VulnClass union ⇄ ALL_VULN_CLASSES lockstep ────────────────

// A Record<VulnClass, true> forces TypeScript to list every union member —
// omitting any member here is a compile-time error, catching drift before
// the runtime assertion below even runs.
const PRESENCE: Record<VulnClass, true> = {
  injection: true,
  "authn-authz": true,
  "secret-handling": true,
  "input-validation": true,
  "path-traversal": true,
  "privilege-escalation": true,
  "race-condition": true,
  "money-integrity": true,
  ssrf: true,
  xss: true,
  "insecure-randomness": true,
  "crypto-weakness": true,
  deserialization: true,
  "supply-chain": true,
  "idor-bola": true,
  "denial-of-service": true,
  "audit-logging": true,
};

describe("VulnClass ⇄ ALL_VULN_CLASSES lockstep", () => {
  it("ALL_VULN_CLASSES stays in lockstep with the VulnClass union (no drift)", () => {
    expect([...ALL_VULN_CLASSES].sort()).toEqual(Object.keys(PRESENCE).sort());
    expect(new Set(ALL_VULN_CLASSES).size).toBe(ALL_VULN_CLASSES.length);
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
