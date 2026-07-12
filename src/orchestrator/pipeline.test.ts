/**
 * Unit tests for the fail-closed SecurityAuditGate wired into runSprintCycle
 * (spec-20260712-security-audit-agent-team, sprint 3).
 *
 * Covers:
 * - sc-3-2: a critical finding blocks the sprint (no sprint-passed event,
 *   security-audit-blocked event with reason/critical/findings), and defers
 *   to the existing retry path (retry when iterations remain, needs-rework
 *   at maxIterations).
 * - sc-3-3: on a blocked round, the NEXT generator iteration's handoff.issues
 *   contains the rendered security findings.
 * - sc-3-4: with config.security absent, a paired run (vs. config.security =
 *   {enabled:false}) is deep-equal in both the returned result AND the full
 *   appendHistory event-call sequence — proven with a frozen clock so the
 *   only real-timestamp fields (contract.updatedAt/startedAt/completedAt,
 *   the generated handoff/history timestamps) are identical across runs.
 * - sc-3-5: a clean enabled round appends security-audit-clean and still
 *   proceeds to sprint-passed, code-review, and documenter; a blocked round
 *   never reaches either advisory stage.
 *
 * Follows the mock-heavy-agent convention established in
 * code-reviewer-agent.test.ts / documenter-agent.test.ts.
 */

import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SprintContract } from "../contracts/sprint-contract.js";
import type { PlanSpec } from "../contracts/spec.js";
import type { ProjectContext } from "./context-handoff.js";
import type { SecurityAuditResult } from "./security-audit-types.js";

// ── Mock heavy dependencies that runSprintCycle pulls in ──────────────

vi.mock("../graph/pipeline-lifecycle.js", () => ({
  graphPipelineLifecycle: {
    engineHealth: vi.fn().mockReturnValue("disabled"),
    getGraphClient: vi.fn().mockReturnValue(null),
    getGraphDeps: vi.fn().mockReturnValue(null),
  },
}));

vi.mock("../state/index.js", () => ({
  ensureBoberDir: vi.fn().mockResolvedValue(undefined),
  saveContract: vi.fn().mockResolvedValue(undefined),
  updateContract: vi.fn().mockResolvedValue(undefined),
  appendHistory: vi.fn().mockResolvedValue(undefined),
  readDesign: vi.fn().mockRejectedValue(new Error("no design")),
  readOutline: vi.fn().mockRejectedValue(new Error("no outline")),
}));

vi.mock("../utils/git.js", () => ({
  commitAll: vi.fn().mockResolvedValue("abc1234"),
  getCurrentBranch: vi.fn().mockResolvedValue("bober/test"),
  getChangedFiles: vi.fn().mockResolvedValue(["src/orchestrator/security-gate.ts"]),
}));

vi.mock("./curator-agent.js", () => ({
  runCurator: vi.fn().mockResolvedValue({
    contractId: "test-contract",
    timestamp: "2026-01-01T00:00:00.000Z",
    briefing: "",
    filesAnalyzed: [],
    patternsFound: 0,
    utilsIdentified: 0,
  }),
}));

vi.mock("./generator-agent.js", () => ({
  runGenerator: vi.fn().mockResolvedValue({
    success: true,
    notes: "Generated successfully.",
    filesChanged: ["src/orchestrator/security-gate.ts"],
    turnsUsed: 3,
    toolsCalled: [],
  }),
}));

vi.mock("./evaluator-agent.js", () => ({
  runEvaluatorAgent: vi.fn(),
}));

vi.mock("./code-reviewer-agent.js", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actual = await importOriginal<any>();
  return {
    ...actual,
    runCodeReviewer: vi.fn().mockResolvedValue({
      reviewId: "review-test-contract",
      contractId: "test-contract",
      specId: "test-spec",
      timestamp: "2026-01-01T00:00:00.000Z",
      summary: "Looks clean.",
      critical: [],
      important: [],
      minor: [],
      approvedAreas: [],
    }),
  };
});

vi.mock("./documenter-agent.js", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actual = await importOriginal<any>();
  return {
    ...actual,
    runDocumenter: vi.fn().mockResolvedValue({
      contractId: "test-contract",
      sprintDocPath: "docs/sprints/test-contract.md",
      relatedDocsUpdated: [],
      concerns: [],
      summary: "Documented the sprint.",
    }),
  };
});

// NEW for this sprint — the audit core is mocked so no real LLM runs.
vi.mock("./security-auditor-agent.js", () => ({
  runSecurityAudit: vi.fn(),
}));

// ── Fixtures ──────────────────────────────────────────────────────────

const testContract: SprintContract = {
  contractId: "test-contract",
  specId: "test-spec",
  sprintNumber: 3,
  title: "Security Gate Pipeline Integration",
  description: "Test that the security gate is spawned after evaluator pass.",
  status: "proposed",
  dependsOn: [],
  features: ["feat-3"],
  successCriteria: [
    {
      criterionId: "sc-3-2",
      description: "Security gate blocks the sprint on a critical finding.",
      verificationMethod: "unit-test",
      required: true,
    },
  ],
  nonGoals: ["Not a real pipeline test"],
  stopConditions: ["All assertions verified"],
  definitionOfDone: "Done when the blocked/clean/disabled paths are all verified.",
  assumptions: [],
  outOfScope: [],
  estimatedFiles: ["src/orchestrator/security-gate.ts"],
  iterationHistory: [],
  lastEvalId: null,
};

const testSpec: PlanSpec = {
  specId: "test-spec",
  version: 1,
  title: "Test Plan",
  description: "A test plan spec for unit testing the pipeline.",
  status: "ready",
  mode: "brownfield",
  features: [],
  assumptions: [],
  outOfScope: [],
  clarificationQuestions: [],
  resolvedClarifications: [],
  techStack: [],
  nonFunctionalRequirements: [],
  constraints: [],
};

const testProjectContext: ProjectContext = {
  name: "test-project",
  type: "brownfield",
  techStack: [],
  entryPoints: [],
  currentBranch: "bober/test",
};

const baseConfig = {
  project: { name: "test-project", mode: "brownfield" as const },
  planner: { maxClarifications: 5, model: "opus" },
  curator: { model: "opus", maxTurns: 25, enabled: false },
  generator: {
    model: "sonnet",
    maxTurnsPerSprint: 50,
    autoCommit: false,
    branchPattern: "bober/{feature-name}",
  },
  evaluator: {
    model: "sonnet",
    strategies: [{ type: "typecheck", required: true }],
    maxIterations: 1,
  },
  sprint: { maxSprints: 10, requireContracts: true, sprintSize: "medium" as const },
  pipeline: {
    maxIterations: 1,
    requireApproval: false,
    contextReset: "always" as const,
    researchPhase: false,
    architectPhase: false,
  },
  commands: {},
  codeReview: { timeoutMs: 300_000, enabled: true, model: "sonnet", maxTurns: 15 },
  documenter: { timeoutMs: 300_000, enabled: true, model: "sonnet", maxTurns: 20 },
};

const securityDefaults = {
  enabled: true,
  failClosed: true,
  timeoutMs: 5_000,
  model: "opus",
  maxTurns: 5,
  scanners: [],
  standaloneBlockOn: "critical" as const,
  hub: true,
};

const cleanAuditResult: SecurityAuditResult = {
  review: {
    reviewId: "r-clean",
    contractId: "test-contract",
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

const criticalAuditResult: SecurityAuditResult = {
  review: {
    reviewId: "r-critical",
    contractId: "test-contract",
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

async function makeTmpRoot(prefix: string): Promise<string> {
  const tmpRoot = path.join(os.tmpdir(), `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(tmpRoot, { recursive: true });
  return tmpRoot;
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("security audit gate — pipeline integration", () => {
  const tmpDirs: string[] = [];

  afterAll(async () => {
    for (const dir of tmpDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── sc-3-2 / sc-3-3: blocked round with iterations remaining ────────

  it("sc-3-2/sc-3-3: a critical finding blocks the sprint, retries, and feeds findings into the next generator handoff", async () => {
    const tmpRoot = await makeTmpRoot("secgate_block_retry");
    tmpDirs.push(tmpRoot);

    const { runSprintCycle } = await import("./pipeline.js");
    const { runEvaluatorAgent } = await import("./evaluator-agent.js");
    const { runSecurityAudit } = await import("./security-auditor-agent.js");
    const { runGenerator } = await import("./generator-agent.js");
    const { runCodeReviewer } = await import("./code-reviewer-agent.js");
    const { runDocumenter } = await import("./documenter-agent.js");
    const { appendHistory } = await import("../state/index.js");

    vi.mocked(runEvaluatorAgent).mockResolvedValue({
      passed: true,
      score: 90,
      results: [],
      summary: "All passed.",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    vi.mocked(runSecurityAudit)
      .mockResolvedValueOnce(criticalAuditResult) // iteration 1 — blocked
      .mockResolvedValueOnce(cleanAuditResult); // iteration 2 — clean, sprint passes

    const config = {
      ...baseConfig,
      evaluator: { ...baseConfig.evaluator, maxIterations: 2 },
      security: securityDefaults,
    };

    const result = await runSprintCycle({
      contract: testContract,
      spec: testSpec,
      completedContracts: [],
      projectRoot: tmpRoot,
      config,
      projectContext: testProjectContext,
    });

    // Sprint eventually passes on the retry (iteration 2, audit clean).
    expect(result.contract.status).toBe("passed");

    const events = vi.mocked(appendHistory).mock.calls.map((c) => (c[1] as { event: string }).event);
    const sprintPassedCount = events.filter((e) => e === "sprint-passed").length;
    expect(sprintPassedCount).toBe(1); // only on the clean iteration-2 round
    expect(events).toContain("security-audit-blocked");
    expect(events).toContain("security-audit-clean");

    // The blocked-round history entry carries reason/critical/findings.
    const blockedCall = vi
      .mocked(appendHistory)
      .mock.calls.find((c) => (c[1] as { event: string }).event === "security-audit-blocked");
    expect(blockedCall).toBeDefined();
    const blockedDetails = (blockedCall as unknown as [unknown, { details: Record<string, unknown> }])[1].details;
    expect(blockedDetails.reason).toBe("critical-finding");
    expect(blockedDetails.critical).toBe(1);
    expect(blockedDetails.findings).toEqual([
      { path: "src/db.ts", line: 88, vulnClass: "injection" },
    ]);

    // sc-3-3: the SECOND runGenerator call (iteration 2's handoff) carries the
    // rendered security feedback via the same channel evaluator feedback uses.
    expect(vi.mocked(runGenerator)).toHaveBeenCalledTimes(2);
    const secondHandoff = vi.mocked(runGenerator).mock.calls[1][0] as { issues: string[] };
    expect(secondHandoff.issues.some((i) => i.includes("[CRITICAL] injection:"))).toBe(true);
    expect(
      secondHandoff.issues.some((i) => i.includes("SQL injection via unescaped string concatenation")),
    ).toBe(true);
    expect(secondHandoff.issues.some((i) => i.includes("at src/db.ts:88"))).toBe(true);

    // Blocked round never reaches code-review/documenter (ADR-6); the clean
    // round DOES (checked more thoroughly in the sc-3-5 clean test below),
    // but here we confirm the advisory stages fired exactly once overall —
    // never on the blocked iteration.
    expect(vi.mocked(runCodeReviewer)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runDocumenter)).toHaveBeenCalledTimes(1);
  });

  // ── sc-3-2: needs-rework at maxIterations ───────────────────────────

  it("sc-3-2: a critical finding at maxIterations marks the sprint needs-rework, never sprint-passed", async () => {
    const tmpRoot = await makeTmpRoot("secgate_block_maxiter");
    tmpDirs.push(tmpRoot);

    const { runSprintCycle } = await import("./pipeline.js");
    const { runEvaluatorAgent } = await import("./evaluator-agent.js");
    const { runSecurityAudit } = await import("./security-auditor-agent.js");
    const { runCodeReviewer } = await import("./code-reviewer-agent.js");
    const { runDocumenter } = await import("./documenter-agent.js");
    const { appendHistory } = await import("../state/index.js");

    vi.mocked(runEvaluatorAgent).mockResolvedValue({
      passed: true,
      score: 90,
      results: [],
      summary: "All passed.",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    vi.mocked(runSecurityAudit).mockResolvedValue(criticalAuditResult);

    const config = {
      ...baseConfig,
      evaluator: { ...baseConfig.evaluator, maxIterations: 1 },
      security: securityDefaults,
    };

    const result = await runSprintCycle({
      contract: testContract,
      spec: testSpec,
      completedContracts: [],
      projectRoot: tmpRoot,
      config,
      projectContext: testProjectContext,
    });

    expect(result.contract.status).toBe("needs-rework");

    const events = vi.mocked(appendHistory).mock.calls.map((c) => (c[1] as { event: string }).event);
    expect(events).not.toContain("sprint-passed");
    expect(events).toContain("security-audit-blocked");

    // ADR-6: documenter/code-reviewer are never reached on a blocked round.
    expect(vi.mocked(runCodeReviewer)).not.toHaveBeenCalled();
    expect(vi.mocked(runDocumenter)).not.toHaveBeenCalled();

    // Contract feedback is populated with the security findings, not empty.
    expect(result.contract.evaluatorFeedback).toContain("injection");
  });

  // ── sc-3-5: clean round proceeds exactly as before ──────────────────

  it("sc-3-5: a clean security round appends security-audit-clean and still runs code-review + documenter", async () => {
    const tmpRoot = await makeTmpRoot("secgate_clean");
    tmpDirs.push(tmpRoot);

    const { runSprintCycle } = await import("./pipeline.js");
    const { runEvaluatorAgent } = await import("./evaluator-agent.js");
    const { runSecurityAudit } = await import("./security-auditor-agent.js");
    const { runCodeReviewer } = await import("./code-reviewer-agent.js");
    const { runDocumenter } = await import("./documenter-agent.js");
    const { appendHistory } = await import("../state/index.js");

    vi.mocked(runEvaluatorAgent).mockResolvedValue({
      passed: true,
      score: 90,
      results: [],
      summary: "All passed.",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    vi.mocked(runSecurityAudit).mockResolvedValue(cleanAuditResult);

    const config = { ...baseConfig, security: securityDefaults };

    const result = await runSprintCycle({
      contract: testContract,
      spec: testSpec,
      completedContracts: [],
      projectRoot: tmpRoot,
      config,
      projectContext: testProjectContext,
    });

    expect(result.contract.status).toBe("passed");

    const events = vi.mocked(appendHistory).mock.calls.map((c) => (c[1] as { event: string }).event);
    expect(events).toContain("security-audit-clean");
    expect(events).toContain("sprint-passed");
    expect(events).not.toContain("security-audit-blocked");

    expect(vi.mocked(runCodeReviewer)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runDocumenter)).toHaveBeenCalledTimes(1);
  });

  // ── sc-3-4: byte-identical when config.security is absent ───────────

  it("sc-3-4: config.security absent vs {enabled:false} produce deep-equal results and identical history event sequences", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));

    try {
      const { runSprintCycle } = await import("./pipeline.js");
      const { runEvaluatorAgent } = await import("./evaluator-agent.js");
      const { runSecurityAudit } = await import("./security-auditor-agent.js");
      const { appendHistory } = await import("../state/index.js");

      // Advisory stages disabled to isolate the comparison to the security
      // gate's contribution only.
      const pairedConfig = {
        ...baseConfig,
        codeReview: { ...baseConfig.codeReview, enabled: false },
        documenter: { ...baseConfig.documenter, enabled: false },
      };
      const configAbsent = pairedConfig;
      const configDisabled = { ...pairedConfig, security: { ...securityDefaults, enabled: false } };

      const runOnce = async (cfg: typeof configAbsent) => {
        vi.clearAllMocks();
        vi.mocked(runEvaluatorAgent).mockResolvedValue({
          passed: true,
          score: 90,
          results: [],
          summary: "All passed.",
          timestamp: "2026-01-01T00:00:00.000Z",
        });

        const tmpRoot = await makeTmpRoot("secgate_paired");
        tmpDirs.push(tmpRoot);

        const res = await runSprintCycle({
          contract: testContract,
          spec: testSpec,
          completedContracts: [],
          projectRoot: tmpRoot,
          config: cfg,
          projectContext: testProjectContext,
        });

        const historyCalls = vi.mocked(appendHistory).mock.calls.map((c) => c[1]);
        const auditCallCount = vi.mocked(runSecurityAudit).mock.calls.length;
        return { result: res, historyCalls, auditCallCount };
      };

      const a = await runOnce(configAbsent);
      const b = await runOnce(configDisabled);

      expect(a.auditCallCount).toBe(0);
      expect(b.auditCallCount).toBe(0);
      expect(a.result).toEqual(b.result);
      expect(a.historyCalls).toEqual(b.historyCalls);

      const eventsA = a.historyCalls.map((c) => (c as { event: string }).event);
      expect(eventsA).not.toContain("security-audit-clean");
      expect(eventsA).not.toContain("security-audit-blocked");
    } finally {
      vi.useRealTimers();
    }
  });
});
