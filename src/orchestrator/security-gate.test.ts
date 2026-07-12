/**
 * Unit tests for the fail-closed SecurityAuditGate
 * (spec-20260712-security-audit-agent-team, sprint 3).
 *
 * Covers sc-3-1 (all five SecurityGateVerdict reasons, table-tested,
 * including the disabled short-circuit invoking zero audit calls), the
 * fake-timer timeout test (reason:'timeout', not 'audit-error'), the
 * parsed:false→'audit-error' elevation, the sc-3-6 store-persistence-failure
 * guard (verdict unchanged in both a clean and a blocked scenario), and
 * renderSecurityFeedback's pure rendering (sc-3-3).
 *
 * Mocks runSecurityAudit and saveSecurityAudit directly — the gate is a
 * thin wrapper, so its own unit tests never invoke a real agentic loop.
 * Colocated with security-gate.ts per the project convention
 * (security-auditor-agent.test.ts / code-reviewer-agent.test.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SprintContract } from "../contracts/sprint-contract.js";
import type { EvaluationRunResult } from "../evaluators/registry.js";
import { createDefaultConfig } from "../config/schema.js";
import type { BoberConfig, SecuritySection } from "../config/schema.js";
import type { SecurityAuditResult } from "./security-audit-types.js";

// ── Mocks ────────────────────────────────────────────────────────────

const runSecurityAuditSpy = vi.fn();
const saveSecurityAuditSpy = vi.fn().mockResolvedValue(undefined);

vi.mock("./security-auditor-agent.js", () => ({
  runSecurityAudit: runSecurityAuditSpy,
}));
vi.mock("../state/security-audit-state.js", () => ({
  saveSecurityAudit: saveSecurityAuditSpy,
}));

const { evaluateSecurityGate, renderSecurityFeedback } = await import(
  "./security-gate.js"
);
const { logger } = await import("../utils/logger.js");

// ── Fixtures ──────────────────────────────────────────────────────────

const testContract: SprintContract = {
  contractId: "sec-gate-test",
  specId: "test-spec",
  sprintNumber: 3,
  title: "Security gate fixture contract",
  description: "Contract used as a fixture for security-gate unit tests.",
  status: "in-progress",
  dependsOn: [],
  features: ["feat-3"],
  successCriteria: [
    {
      criterionId: "sc-3-1",
      description: "Fixture criterion — not exercised directly by these unit tests.",
      verificationMethod: "unit-test",
      required: true,
    },
  ],
  nonGoals: ["Not a real sprint"],
  stopConditions: ["All assertions pass"],
  definitionOfDone: "Fixture contract for the security gate unit tests.",
  assumptions: [],
  outOfScope: [],
  estimatedFiles: [],
  iterationHistory: [],
  lastEvalId: null,
};

const testEvaluation: EvaluationRunResult = {
  passed: true,
  score: 95,
  results: [],
  summary: "All required strategies passed.",
  timestamp: "2026-01-01T00:00:00.000Z",
};

const securityDefaults: SecuritySection = {
  enabled: true,
  failClosed: true,
  timeoutMs: 300_000,
  model: "opus",
  maxTurns: 5,
  scanners: [],
  standaloneBlockOn: "critical",
  hub: true,
};

function makeConfig(overrides?: Partial<SecuritySection>): BoberConfig {
  const base = createDefaultConfig("test-project", "brownfield");
  return { ...base, security: { ...securityDefaults, ...overrides } };
}

function withTimeout(ms: number): BoberConfig {
  return makeConfig({ timeoutMs: ms });
}

const cleanResult: SecurityAuditResult = {
  review: {
    reviewId: "r-clean",
    contractId: "sec-gate-test",
    specId: "test-spec",
    timestamp: "2026-01-01T00:00:00.000Z",
    summary: "no exploitable vulnerabilities found",
    critical: [],
    important: [],
    minor: [],
    approvedAreas: ["src/db.ts"],
  },
  stack: "node",
  scannerRan: false,
  parsed: true,
  verdict: "pass",
};

const criticalResult: SecurityAuditResult = {
  review: {
    reviewId: "r-critical",
    contractId: "sec-gate-test",
    specId: "test-spec",
    timestamp: "2026-01-01T00:00:00.000Z",
    summary: "one critical injection finding",
    critical: [
      {
        description: "SQL injection via unescaped string concatenation",
        evidence: [{ path: "src/db.ts", line: 88, snippet: "`SELECT * FROM x WHERE id=${id}`" }],
        vulnClass: "injection",
      },
    ],
    important: [],
    minor: [],
    approvedAreas: [],
  },
  stack: "node",
  scannerRan: false,
  parsed: true,
  verdict: "blocked",
};

const parseFailureResult: SecurityAuditResult = {
  review: {
    reviewId: "r-unparsed",
    contractId: "sec-gate-test",
    specId: "test-spec",
    timestamp: "2026-01-01T00:00:00.000Z",
    summary: "Security auditor output could not be parsed.",
    critical: [],
    important: [],
    minor: [],
    approvedAreas: [],
  },
  stack: "node",
  scannerRan: false,
  parsed: false,
  // runSecurityAudit already forces verdict:'blocked' on a parse failure.
  verdict: "blocked",
};

beforeEach(() => {
  runSecurityAuditSpy.mockReset();
  saveSecurityAuditSpy.mockClear();
  saveSecurityAuditSpy.mockResolvedValue(undefined);
});

// ── sc-3-1: table-test all five reasons ────────────────────────────────

describe("evaluateSecurityGate — sc-3-1 all five reasons", () => {
  it("reason:'disabled' when config.security is absent — never invokes the audit", async () => {
    const base = createDefaultConfig("test-project", "brownfield");
    expect(base.security).toBeUndefined();

    const verdict = await evaluateSecurityGate({
      contract: testContract,
      evaluation: testEvaluation,
      projectRoot: "/tmp/project",
      config: base,
    });

    expect(verdict).toEqual({ blocked: false, reason: "disabled" });
    expect(runSecurityAuditSpy).not.toHaveBeenCalled();
  });

  it("reason:'disabled' when config.security.enabled is explicitly false — never invokes the audit", async () => {
    const config = makeConfig({ enabled: false });

    const verdict = await evaluateSecurityGate({
      contract: testContract,
      evaluation: testEvaluation,
      projectRoot: "/tmp/project",
      config,
    });

    expect(verdict).toEqual({ blocked: false, reason: "disabled" });
    expect(runSecurityAuditSpy).not.toHaveBeenCalled();
  });

  it("reason:'clean' when the audit resolves parsed:true, verdict:'pass'", async () => {
    runSecurityAuditSpy.mockResolvedValueOnce(cleanResult);
    const config = makeConfig();

    const verdict = await evaluateSecurityGate({
      contract: testContract,
      evaluation: testEvaluation,
      projectRoot: "/tmp/project",
      config,
    });

    expect(verdict).toEqual({ blocked: false, reason: "clean", result: cleanResult });
  });

  it("reason:'critical-finding' when the audit resolves parsed:true, verdict:'blocked'", async () => {
    runSecurityAuditSpy.mockResolvedValueOnce(criticalResult);
    const config = makeConfig();

    const verdict = await evaluateSecurityGate({
      contract: testContract,
      evaluation: testEvaluation,
      projectRoot: "/tmp/project",
      config,
    });

    expect(verdict).toEqual({ blocked: true, reason: "critical-finding", result: criticalResult });
  });

  it("reason:'audit-error' when result.parsed===false — NOT 'critical-finding', even though verdict is already 'blocked'", async () => {
    runSecurityAuditSpy.mockResolvedValueOnce(parseFailureResult);
    const config = makeConfig();

    const verdict = await evaluateSecurityGate({
      contract: testContract,
      evaluation: testEvaluation,
      projectRoot: "/tmp/project",
      config,
    });

    expect(verdict.blocked).toBe(true);
    expect(verdict.reason).toBe("audit-error");
    expect(verdict.reason).not.toBe("critical-finding");
    expect(verdict.result).toEqual(parseFailureResult);
  });

  it("reason:'audit-error' when runSecurityAudit rejects with a non-timeout error", async () => {
    runSecurityAuditSpy.mockRejectedValueOnce(new Error("provider request failed"));
    const config = makeConfig();
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const verdict = await evaluateSecurityGate({
      contract: testContract,
      evaluation: testEvaluation,
      projectRoot: "/tmp/project",
      config,
    });

    expect(verdict).toEqual({ blocked: true, reason: "audit-error" });
    expect(verdict.result).toBeUndefined();
    warnSpy.mockRestore();
  });
});

// ── Fake-timer timeout test (reason:'timeout', not 'audit-error') ──────

describe("evaluateSecurityGate — timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves reason:'timeout' (not 'audit-error') when the audit never settles before timeoutMs", async () => {
    vi.useFakeTimers();
    // Never resolves — forces the race to settle via the timeout branch.
    runSecurityAuditSpy.mockReturnValueOnce(new Promise(() => {}));
    const config = withTimeout(50);
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const pending = evaluateSecurityGate({
      contract: testContract,
      evaluation: testEvaluation,
      projectRoot: "/tmp/project",
      config,
    });

    await vi.runAllTimersAsync();
    const verdict = await pending;

    expect(verdict).toEqual({ blocked: true, reason: "timeout" });
    expect(verdict.reason).not.toBe("audit-error");
    warnSpy.mockRestore();
  });
});

// ── sc-3-6: store persistence failure never flips the verdict ─────────

describe("evaluateSecurityGate — sc-3-6 store persistence failure", () => {
  it("a saveSecurityAudit throw does NOT change a clean verdict", async () => {
    runSecurityAuditSpy.mockResolvedValueOnce(cleanResult);
    saveSecurityAuditSpy.mockRejectedValueOnce(new Error("disk full"));
    const config = makeConfig();
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const verdict = await evaluateSecurityGate({
      contract: testContract,
      evaluation: testEvaluation,
      projectRoot: "/tmp/project",
      config,
    });

    expect(verdict).toEqual({ blocked: false, reason: "clean", result: cleanResult });
    const warnCalls = warnSpy.mock.calls.map((args) => args[0] as string);
    expect(warnCalls.some((m) => m.includes("Security audit persistence failed"))).toBe(true);
    warnSpy.mockRestore();
  });

  it("a saveSecurityAudit throw does NOT change a blocked verdict", async () => {
    runSecurityAuditSpy.mockResolvedValueOnce(criticalResult);
    saveSecurityAuditSpy.mockRejectedValueOnce(new Error("disk full"));
    const config = makeConfig();
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const verdict = await evaluateSecurityGate({
      contract: testContract,
      evaluation: testEvaluation,
      projectRoot: "/tmp/project",
      config,
    });

    expect(verdict).toEqual({ blocked: true, reason: "critical-finding", result: criticalResult });
    const warnCalls = warnSpy.mock.calls.map((args) => args[0] as string);
    expect(warnCalls.some((m) => m.includes("Security audit persistence failed"))).toBe(true);
    warnSpy.mockRestore();
  });
});

// ── renderSecurityFeedback — pure rendering (sc-3-3) ───────────────────

describe("renderSecurityFeedback", () => {
  it("returns [] for a non-blocked verdict", () => {
    expect(renderSecurityFeedback({ blocked: false, reason: "clean", result: cleanResult })).toEqual([]);
    expect(renderSecurityFeedback({ blocked: false, reason: "disabled" })).toEqual([]);
  });

  it("returns a generic message (not []) for a blocked verdict with no result (timeout)", () => {
    const parts = renderSecurityFeedback({ blocked: true, reason: "timeout" });
    expect(parts.length).toBeGreaterThan(0);
    expect(parts[0]).toContain("[SECURITY]");
    expect(parts[0]).toContain("timed out");
  });

  it("returns a generic message for a blocked verdict with no result (audit-error)", () => {
    const parts = renderSecurityFeedback({ blocked: true, reason: "audit-error" });
    expect(parts.length).toBeGreaterThan(0);
    expect(parts[0]).toContain("[SECURITY]");
  });

  it("renders one [CRITICAL] line per finding, phrased for a fixer, with vulnClass when present", () => {
    const verdict = { blocked: true, reason: "critical-finding" as const, result: criticalResult };
    const parts = renderSecurityFeedback(verdict);

    expect(parts.length).toBe(2); // summary line + 1 finding
    expect(parts[0]).toContain("[SECURITY]");
    expect(parts[0]).toContain("1 critical finding");
    expect(parts[1]).toMatch(/^\[CRITICAL\] injection: /);
    expect(parts[1]).toContain("SQL injection via unescaped string concatenation");
    expect(parts[1]).toContain("at src/db.ts:88");
    expect(parts[1]).toContain("remediate by");
  });

  it("omits the vulnClass prefix when a finding has no vulnClass", () => {
    const resultNoVulnClass: SecurityAuditResult = {
      ...criticalResult,
      review: {
        ...criticalResult.review,
        critical: [
          {
            description: "Hardcoded API key",
            evidence: [{ path: "src/config.ts", line: 3, snippet: "const key = 'sk-live-...'" }],
          },
        ],
      },
    };
    const parts = renderSecurityFeedback({
      blocked: true,
      reason: "critical-finding",
      result: resultNoVulnClass,
    });

    expect(parts[1]).toMatch(/^\[CRITICAL\] Hardcoded API key at src\/config\.ts:3/);
  });

  it("falls back to path 'unknown'/line 0 when a finding has no evidence", () => {
    const resultNoEvidence: SecurityAuditResult = {
      ...criticalResult,
      review: {
        ...criticalResult.review,
        critical: [{ description: "Finding with no evidence array populated", evidence: [] }],
      },
    };
    const parts = renderSecurityFeedback({
      blocked: true,
      reason: "critical-finding",
      result: resultNoEvidence,
    });

    expect(parts[1]).toContain("at unknown:0");
  });

  it("caps rendered findings to 20", () => {
    const manyFindings = Array.from({ length: 25 }, (_, i) => ({
      description: `Finding ${i}`,
      evidence: [{ path: "src/x.ts", line: i, snippet: "" }],
    }));
    const resultMany: SecurityAuditResult = {
      ...criticalResult,
      review: { ...criticalResult.review, critical: manyFindings },
    };
    const parts = renderSecurityFeedback({ blocked: true, reason: "critical-finding", result: resultMany });

    // 1 summary line + 20 capped finding lines
    expect(parts.length).toBe(21);
  });
});
