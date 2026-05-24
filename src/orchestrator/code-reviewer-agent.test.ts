/**
 * Unit tests for the code-reviewer advisory integration (sprint-spec-20260524-bober-vision-5).
 *
 * Tests three contract assertions (s5-c6):
 * (a) pipeline.ts spawns runCodeReviewer with the contract+evaluation that the pipeline
 *     propagated — verified by calling runSprintCycle with a passing evaluator stub.
 * (b) renderReviewMarkdown produces all 6 required H1/H2 sections in order — unit test
 *     of the renderer directly.
 * (c) when runCodeReviewer throws, runSprintCycle does NOT throw, the returned contract
 *     status is still "passed", and logger.warn was called — real coverage of
 *     pipeline.ts lines 370-382 (the advisory try/catch).
 *
 * Colocated with code-reviewer-agent.ts per the project convention:
 * src/orchestrator/agent-loader.test.ts and src/orchestrator/model-resolver.test.ts
 * both live next to the modules they test.
 */

import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SprintContract } from "../contracts/sprint-contract.js";
import type { PlanSpec } from "../contracts/spec.js";
import type { ProjectContext } from "./context-handoff.js";

// ── Mock heavy dependencies that runSprintCycle pulls in ──────────────

// graph / lifecycle — no real MCP subprocess
vi.mock("../graph/pipeline-lifecycle.js", () => ({
  graphPipelineLifecycle: {
    engineHealth: vi.fn().mockReturnValue("disabled"),
    getGraphClient: vi.fn().mockReturnValue(null),
    getGraphDeps: vi.fn().mockReturnValue(null),
  },
}));

// State layer — pure filesystem, redirect to no-ops so we don't need real dirs
vi.mock("../state/index.js", () => ({
  ensureBoberDir: vi.fn().mockResolvedValue(undefined),
  saveContract: vi.fn().mockResolvedValue(undefined),
  updateContract: vi.fn().mockResolvedValue(undefined),
  appendHistory: vi.fn().mockResolvedValue(undefined),
  readDesign: vi.fn().mockRejectedValue(new Error("no design")),
  readOutline: vi.fn().mockRejectedValue(new Error("no outline")),
}));

// Git utils — avoid real git calls
vi.mock("../utils/git.js", () => ({
  commitAll: vi.fn().mockResolvedValue("abc1234"),
  getCurrentBranch: vi.fn().mockResolvedValue("bober/test"),
  getChangedFiles: vi.fn().mockResolvedValue(["src/orchestrator/code-reviewer-agent.ts"]),
}));

// Agents — stub out everything except the code-reviewer (tested separately below)
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
    filesChanged: ["src/orchestrator/code-reviewer-agent.ts"],
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

// code-reviewer spy — controlled per test below
vi.mock("./code-reviewer-agent.js", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actual = await importOriginal<any>();
  return {
    ...actual,
    runCodeReviewer: vi.fn().mockResolvedValue({
      reviewId: "review-test-contract-ts",
      contractId: "test-contract",
      specId: "test-spec",
      timestamp: new Date().toISOString(),
      summary: "Looks clean.",
      critical: [],
      important: [],
      minor: [],
      approvedAreas: ["src/orchestrator/code-reviewer-agent.ts"],
    }),
  };
});

// ── Fixtures ──────────────────────────────────────────────────────────

const testContract: SprintContract = {
  contractId: "test-contract",
  specId: "test-spec",
  sprintNumber: 5,
  title: "Code Reviewer Integration",
  description: "Test that code reviewer is spawned after evaluator pass.",
  status: "proposed",
  dependsOn: [],
  features: ["feat-5"],
  successCriteria: [
    {
      criterionId: "s5-c6",
      description: "Code reviewer is spawned with correct inputs when evaluator returns pass.",
      verificationMethod: "unit-test",
      required: true,
    },
  ],
  nonGoals: ["Not a real pipeline test"],
  stopConditions: ["All three assertions verified"],
  definitionOfDone: "Done when spawn inputs, file write, and error resilience are all verified.",
  assumptions: [],
  outOfScope: [],
  estimatedFiles: ["src/orchestrator/code-reviewer-agent.ts"],
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

const minimalConfig = {
  project: { name: "test-project", mode: "brownfield" as const },
  planner: { maxClarifications: 5, model: "opus" },
  curator: { model: "opus", maxTurns: 25, enabled: false }, // disabled — skip curator
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
  codeReview: {
    timeoutMs: 300_000,
    enabled: true,
    model: "sonnet",
    maxTurns: 15,
  },
};

// ── Tests ─────────────────────────────────────────────────────────────

describe("code-reviewer pipeline integration (s5-c6)", () => {
  const tmpDirs: string[] = [];

  afterAll(async () => {
    for (const dir of tmpDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── (a) Pipeline spawns runCodeReviewer with correct inputs ────────

  it("(a) runSprintCycle spawns runCodeReviewer with contract+evaluation from the pipeline", async () => {
    const tmpRoot = path.join(os.tmpdir(), `codeReview_pipeline_a_${Date.now()}`);
    tmpDirs.push(tmpRoot);
    await fs.mkdir(path.join(tmpRoot, ".bober/reviews"), { recursive: true });

    // Import the pipeline function and the code-reviewer spy
    const { runSprintCycle } = await import("./pipeline.js");
    const { runCodeReviewer } = await import("./code-reviewer-agent.js");
    const reviewerSpy = vi.mocked(runCodeReviewer);

    // Also get the evaluator mock so we can confirm what it returns
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
      minimalConfig,
      testProjectContext,
    );

    // Pipeline returned a passed contract
    expect(result.contract.status).toBe("passed");

    // runCodeReviewer was called once — inside the if (evaluation.passed) branch
    expect(reviewerSpy).toHaveBeenCalledTimes(1);

    // Assert it was called with the contract the pipeline updated (status=passed)
    // and with the EvaluationRunResult that runEvaluatorAgent returned (passed:true)
    expect(reviewerSpy).toHaveBeenCalledWith(
      expect.objectContaining({ contractId: "test-contract", status: "passed" }),
      expect.objectContaining({ passed: true, score: 91 }),
      tmpRoot,
      expect.objectContaining({ codeReview: expect.objectContaining({ enabled: true }) }),
    );
  });

  // ── (b) renderReviewMarkdown produces all 6 sections in order ─────

  it("(b) renderReviewMarkdown produces all 6 required headings in order", async () => {
    // Import the renderer directly — unit tests the renderer, not the full agent loop
    const { renderReviewMarkdown } = await import("./code-reviewer-agent.js");

    const fixture = {
      reviewId: "review-test-render-2026",
      contractId: "render-contract",
      specId: "render-spec",
      timestamp: "2026-01-01T00:00:00.000Z",
      summary: "Two critical findings. One approved area.",
      critical: [
        {
          description: "Silent error swallow in catch block",
          evidence: [{ path: "src/foo.ts", line: 42, snippet: "} catch {}" }],
        },
      ],
      important: [],
      minor: [
        {
          description: "Unused import",
          evidence: [{ path: "src/bar.ts", line: 5, snippet: "import { unused } from './x'" }],
        },
      ],
      approvedAreas: ["src/orchestrator/code-reviewer-agent.ts"],
    };

    const markdown = renderReviewMarkdown(fixture);

    // Verify all 6 required headings are present
    const requiredHeadings = [
      "# Code Review:",
      "## Summary",
      "## Critical",
      "## Important",
      "## Minor",
      "## Approved Areas",
    ];
    for (const heading of requiredHeadings) {
      expect(markdown).toContain(heading);
    }

    // Verify headings appear in the correct order
    const positions = requiredHeadings.map((h) => markdown.indexOf(h));
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }

    // Verify content is rendered
    expect(markdown).toContain("render-contract");
    expect(markdown).toContain("Two critical findings");
    expect(markdown).toContain("src/foo.ts:42");
    expect(markdown).toContain("No important findings.");
    expect(markdown).toContain("src/orchestrator/code-reviewer-agent.ts");
  });

  // ── (c) Reviewer error does not block sprint completion ───────────

  it("(c) runSprintCycle does NOT throw when runCodeReviewer throws — advisory pipeline.ts L370-382", async () => {
    const tmpRoot = path.join(os.tmpdir(), `codeReview_pipeline_c_${Date.now()}`);
    tmpDirs.push(tmpRoot);
    await fs.mkdir(path.join(tmpRoot, ".bober/reviews"), { recursive: true });

    const { runSprintCycle } = await import("./pipeline.js");
    const { runCodeReviewer } = await import("./code-reviewer-agent.js");
    const reviewerSpy = vi.mocked(runCodeReviewer);

    // Make the reviewer throw — this exercises pipeline.ts L370-382
    reviewerSpy.mockRejectedValueOnce(new Error("reviewer crashed — boom"));

    // Spy on logger.warn to capture the advisory warning
    const { logger } = await import("../utils/logger.js");
    const warnSpy = vi.spyOn(logger, "warn");

    // runSprintCycle must NOT throw — the catch swallows it
    let result: Awaited<ReturnType<typeof runSprintCycle>>;
    await expect(
      (async () => {
        result = await runSprintCycle(
          testContract,
          testSpec,
          [],
          tmpRoot,
          minimalConfig,
          testProjectContext,
        );
      })(),
    ).resolves.toBeUndefined();

    // (1) Sprint status is still "passed" — reviewer failure doesn't downgrade it
    expect(result!.contract.status).toBe("passed");

    // (2) logger.warn was called with the "Code review skipped:" message
    const warnCalls = warnSpy.mock.calls.map((args) => args[0] as string);
    const skippedWarn = warnCalls.find((msg) => msg.includes("Code review skipped"));
    expect(skippedWarn).toBeDefined();
    expect(skippedWarn).toContain("reviewer crashed — boom");

    warnSpy.mockRestore();
  });
});

// ── saveReview idempotency ─────────────────────────────────────────────

describe("saveReview idempotency (mkdir -p semantics)", () => {
  const tmpDirs: string[] = [];

  afterAll(async () => {
    for (const dir of tmpDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("creates .bober/reviews/ directory if it does not exist", async () => {
    const tmpRoot = path.join(os.tmpdir(), `codeReview_mkdir_${Date.now()}`);
    tmpDirs.push(tmpRoot);
    // Do NOT pre-create the reviews directory — saveReview must handle that
    await fs.mkdir(tmpRoot, { recursive: true });

    const { saveReview } = await import("../state/review-state.js");
    await saveReview(tmpRoot, "idempotency-contract", "# Code Review: idempotency-contract\n");

    const filePath = path.join(tmpRoot, ".bober/reviews/idempotency-contract-review.md");
    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toContain("# Code Review: idempotency-contract");
  });

  it("overwrites existing review without error (second call wins)", async () => {
    const tmpRoot = path.join(os.tmpdir(), `codeReview_overwrite_${Date.now()}`);
    tmpDirs.push(tmpRoot);
    await fs.mkdir(tmpRoot, { recursive: true });

    const { saveReview } = await import("../state/review-state.js");
    await saveReview(tmpRoot, "overwrite-contract", "# Code Review: overwrite-contract\nFirst version\n");
    await saveReview(tmpRoot, "overwrite-contract", "# Code Review: overwrite-contract\nSecond version\n");

    const filePath = path.join(tmpRoot, ".bober/reviews/overwrite-contract-review.md");
    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toContain("Second version");
    expect(content).not.toContain("First version");
  });
});
