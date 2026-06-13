/**
 * Unit tests for the per-sprint documenter integration.
 *
 * Tests:
 * (a) pipeline.ts spawns runDocumenter (with the passed contract + evaluation +
 *     generator result) after the evaluator returns pass — verified by running
 *     runSprintCycle with a passing evaluator stub.
 * (b) when runDocumenter throws, runSprintCycle does NOT throw, the returned
 *     contract status is still "passed", and logger.warn was called — covers the
 *     advisory try/catch in pipeline.ts.
 * (c) config.documenter.enabled === false skips the documenter entirely.
 * (d) parseDocumentationResult is resilient to fenced / noisy / unparseable output.
 *
 * Colocated with documenter-agent.ts per the project convention.
 */

import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SprintContract } from "../contracts/sprint-contract.js";
import type { PlanSpec } from "../contracts/spec.js";
import type { ProjectContext } from "./context-handoff.js";

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
  getChangedFiles: vi.fn().mockResolvedValue(["src/orchestrator/documenter-agent.ts"]),
}));

vi.mock("./curator-agent.js", () => ({
  runCurator: vi.fn().mockResolvedValue({
    contractId: "test-contract",
    timestamp: new Date().toISOString(),
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
    filesChanged: ["src/orchestrator/documenter-agent.ts"],
    turnsUsed: 3,
    toolsCalled: [],
  }),
}));

vi.mock("./evaluator-agent.js", () => ({
  runEvaluatorAgent: vi.fn().mockResolvedValue({
    passed: true,
    score: 90,
    results: [],
    summary: "All criteria passed.",
    timestamp: new Date().toISOString(),
  }),
}));

// Code reviewer disabled in config below, but stub it so nothing real runs.
vi.mock("./code-reviewer-agent.js", () => ({
  runCodeReviewer: vi.fn().mockResolvedValue({
    reviewId: "review-test-contract-ts",
    contractId: "test-contract",
    specId: "test-spec",
    timestamp: new Date().toISOString(),
    summary: "Looks clean.",
    critical: [],
    important: [],
    minor: [],
    approvedAreas: [],
  }),
}));

// documenter spy — controlled per test below
vi.mock("./documenter-agent.js", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actual = await importOriginal<any>();
  return {
    ...actual,
    runDocumenter: vi.fn().mockResolvedValue({
      contractId: "test-contract",
      sprintDocPath: "docs/sprints/test-contract.md",
      relatedDocsUpdated: [{ path: "README.md", reason: "added new CLI flag" }],
      docsCommit: "def5678 - bober(test-contract): docs",
      concerns: [],
      summary: "Documented the sprint and updated README.",
    }),
  };
});

// ── Fixtures ──────────────────────────────────────────────────────────

const testContract: SprintContract = {
  contractId: "test-contract",
  specId: "test-spec",
  sprintNumber: 5,
  title: "Documenter Integration",
  description: "Test that the documenter is spawned after evaluator pass.",
  status: "proposed",
  dependsOn: [],
  features: ["feat-5"],
  successCriteria: [
    {
      criterionId: "d-c1",
      description: "Documenter is spawned with correct inputs when evaluator returns pass.",
      verificationMethod: "unit-test",
      required: true,
    },
  ],
  nonGoals: ["Not a real pipeline test"],
  stopConditions: ["Assertions verified"],
  definitionOfDone: "Done when spawn inputs and error resilience are verified.",
  assumptions: [],
  outOfScope: [],
  estimatedFiles: ["src/orchestrator/documenter-agent.ts"],
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
  // Disable code review so only the documenter path is exercised.
  codeReview: { timeoutMs: 300_000, enabled: false, model: "sonnet", maxTurns: 15 },
  documenter: { timeoutMs: 300_000, enabled: true, model: "sonnet", maxTurns: 20 },
};

// ── Tests ─────────────────────────────────────────────────────────────

describe("documenter pipeline integration", () => {
  const tmpDirs: string[] = [];

  afterAll(async () => {
    for (const dir of tmpDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("(a) runSprintCycle spawns runDocumenter with the passed contract + evaluation + generator result", async () => {
    const tmpRoot = path.join(os.tmpdir(), `documenter_pipeline_a_${Date.now()}`);
    tmpDirs.push(tmpRoot);
    await fs.mkdir(tmpRoot, { recursive: true });

    const { runSprintCycle } = await import("./pipeline.js");
    const { runDocumenter } = await import("./documenter-agent.js");
    const documenterSpy = vi.mocked(runDocumenter);

    const { runEvaluatorAgent } = await import("./evaluator-agent.js");
    vi.mocked(runEvaluatorAgent).mockResolvedValue({
      passed: true,
      score: 91,
      results: [],
      summary: "All passed.",
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    const result = await runSprintCycle(
      testContract,
      testSpec,
      [],
      tmpRoot,
      baseConfig,
      testProjectContext,
    );

    expect(result.contract.status).toBe("passed");
    expect(documenterSpy).toHaveBeenCalledTimes(1);
    expect(documenterSpy).toHaveBeenCalledWith(
      expect.objectContaining({ contractId: "test-contract", status: "passed" }),
      expect.objectContaining({ passed: true, score: 91 }),
      expect.objectContaining({ success: true }),
      tmpRoot,
      expect.objectContaining({ documenter: expect.objectContaining({ enabled: true }) }),
    );
  });

  it("(b) runSprintCycle does NOT throw when runDocumenter throws — advisory path", async () => {
    const tmpRoot = path.join(os.tmpdir(), `documenter_pipeline_b_${Date.now()}`);
    tmpDirs.push(tmpRoot);
    await fs.mkdir(tmpRoot, { recursive: true });

    const { runSprintCycle } = await import("./pipeline.js");
    const { runDocumenter } = await import("./documenter-agent.js");
    const documenterSpy = vi.mocked(runDocumenter);
    documenterSpy.mockRejectedValueOnce(new Error("documenter crashed — boom"));

    const { logger } = await import("../utils/logger.js");
    const warnSpy = vi.spyOn(logger, "warn");

    let result: Awaited<ReturnType<typeof runSprintCycle>>;
    await expect(
      (async () => {
        result = await runSprintCycle(
          testContract,
          testSpec,
          [],
          tmpRoot,
          baseConfig,
          testProjectContext,
        );
      })(),
    ).resolves.toBeUndefined();

    expect(result!.contract.status).toBe("passed");
    const warnCalls = warnSpy.mock.calls.map((args) => args[0] as string);
    const skippedWarn = warnCalls.find((msg) => msg.includes("Documentation skipped"));
    expect(skippedWarn).toBeDefined();
    expect(skippedWarn).toContain("documenter crashed — boom");

    warnSpy.mockRestore();
  });

  it("(c) documenter.enabled === false skips runDocumenter", async () => {
    const tmpRoot = path.join(os.tmpdir(), `documenter_pipeline_c_${Date.now()}`);
    tmpDirs.push(tmpRoot);
    await fs.mkdir(tmpRoot, { recursive: true });

    const { runSprintCycle } = await import("./pipeline.js");
    const { runDocumenter } = await import("./documenter-agent.js");
    const documenterSpy = vi.mocked(runDocumenter);

    const disabledConfig = {
      ...baseConfig,
      documenter: { ...baseConfig.documenter, enabled: false },
    };

    const result = await runSprintCycle(
      testContract,
      testSpec,
      [],
      tmpRoot,
      disabledConfig,
      testProjectContext,
    );

    expect(result.contract.status).toBe("passed");
    expect(documenterSpy).not.toHaveBeenCalled();
  });
});

// ── parser unit tests ──────────────────────────────────────────────────

describe("parseDocumentationResult", () => {
  it("parses a clean JSON object", async () => {
    const { parseDocumentationResult } = await import("./documenter-agent.js");
    const text = JSON.stringify({
      contractId: "c1",
      sprintDocPath: "docs/sprints/c1.md",
      relatedDocsUpdated: [{ path: "README.md", reason: "added flag" }],
      docsCommit: "abc - docs",
      concerns: ["typo in foo.ts comment"],
      summary: "Wrote docs.",
    });
    const result = parseDocumentationResult(text, "c1", "docs/sprints/c1.md");
    expect(result.sprintDocPath).toBe("docs/sprints/c1.md");
    expect(result.relatedDocsUpdated).toEqual([{ path: "README.md", reason: "added flag" }]);
    expect(result.docsCommit).toBe("abc - docs");
    expect(result.concerns).toEqual(["typo in foo.ts comment"]);
  });

  it("extracts JSON from a fenced block with surrounding prose", async () => {
    const { parseDocumentationResult } = await import("./documenter-agent.js");
    const text = "Here is the result:\n```json\n" +
      JSON.stringify({ contractId: "c2", sprintDocPath: "docs/sprints/c2.md", relatedDocsUpdated: [], concerns: [], summary: "ok" }) +
      "\n```\nDone.";
    const result = parseDocumentationResult(text, "c2", "docs/sprints/c2.md");
    expect(result.contractId).toBe("c2");
    expect(result.relatedDocsUpdated).toEqual([]);
  });

  it("falls back to defaults on unparseable output", async () => {
    const { parseDocumentationResult } = await import("./documenter-agent.js");
    const result = parseDocumentationResult("totally not json", "c3", "docs/sprints/c3.md");
    expect(result.contractId).toBe("c3");
    expect(result.sprintDocPath).toBe("docs/sprints/c3.md");
    expect(result.relatedDocsUpdated).toEqual([]);
    expect(result.concerns).toEqual([]);
    expect(result.summary).toContain("could not be parsed");
  });

  it("drops malformed relatedDocsUpdated entries defensively", async () => {
    const { parseDocumentationResult } = await import("./documenter-agent.js");
    const text = JSON.stringify({
      contractId: "c4",
      sprintDocPath: "docs/sprints/c4.md",
      relatedDocsUpdated: ["not-an-object", { path: "docs/x.md", reason: "stale" }, 42],
      concerns: "not-an-array",
      summary: "ok",
    });
    const result = parseDocumentationResult(text, "c4", "docs/sprints/c4.md");
    expect(result.relatedDocsUpdated).toEqual([{ path: "docs/x.md", reason: "stale" }]);
    expect(result.concerns).toEqual([]);
  });
});
