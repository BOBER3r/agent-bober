/**
 * Unit tests for runSprintCommand — spec scoping, needs-clarification guard,
 * empty-contracts message, and single-spec happy path.
 *
 * S3-C2: only the active spec's contracts are executed when two specs exist.
 * S3-C3: needs-clarification spec is refused without invoking the generator.
 * S3-C4: zero matching contracts prints a message referencing re-plan/run.
 * S3-C5: single-spec happy path selects/runs the pending contract as before.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { saveSpec, saveContract } from "../../state/index.js";
import { createSpec, type PlanSpec } from "../../contracts/spec.js";
import { createContract } from "../../contracts/sprint-contract.js";

// ── Stubs ─────────────────────────────────────────────────────────────────

// Mock the two agents so no real LLM/network call happens and we can assert
// invocation. Shapes must match GeneratorResult and EvaluationRunResult exactly.
vi.mock("../../orchestrator/generator-agent.js", () => ({
  runGenerator: vi.fn(async () => ({
    success: true,
    notes: "ok",
    filesChanged: [],
  })),
}));

vi.mock("../../orchestrator/evaluator-agent.js", () => ({
  runEvaluatorAgent: vi.fn(async () => ({
    passed: true,
    score: 100,
    results: [],
    summary: "all passed",
    timestamp: new Date().toISOString(),
  })),
}));

// Config mock — must provide all fields read by runSprintCommand.
vi.mock("../../config/loader.js", () => ({
  loadConfig: vi.fn(async () => ({
    project: { name: "test", mode: "brownfield" },
    planner: { provider: "anthropic" },
    generator: { provider: "anthropic", autoCommit: false },
    evaluator: { provider: "anthropic", maxIterations: 1 },
    sprint: { requireContracts: false },
  })),
}));

// git utils shell out — stub to keep tests hermetic and fast.
vi.mock("../../utils/git.js", () => ({
  getCurrentBranch: vi.fn(async () => "main"),
  getChangedFiles: vi.fn(async () => []),
  commitAll: vi.fn(async () => "deadbeef"),
}));

// ── Fixtures ───────────────────────────────────────────────────────────────

const oneFeature = {
  title: "Feature A",
  description: "Description for feature A that is long enough to be valid.",
  priority: "must-have" as const,
  acceptanceCriteria: ["AC1: the feature is implemented and verified."],
};

const crit = {
  criterionId: "sc-1-1",
  description: "The feature is implemented per the spec and verified by the evaluator.",
  verificationMethod: "unit-test" as const,
};

// ── Tmp directory lifecycle ────────────────────────────────────────────────

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "bober-sprint-cmd-"));
  vi.clearAllMocks();
  // Silence console.log noise from chalk-prefixed output
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmpRoot, { recursive: true, force: true });
});

// ── S3-C2: only the active spec's contracts run ────────────────────────────

describe("S3-C2 — filter to active spec", () => {
  it("executes only the latest spec's contracts when two specs exist", async () => {
    // Create two specs with distinct createdAt to make "latest" deterministic.
    const oldSpec: PlanSpec = {
      ...createSpec("Old plan", "An older plan that should not run.", [oneFeature], {
        status: "ready" as const,
      }),
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const activeSpec: PlanSpec = {
      ...createSpec("Active plan", "The active plan that should run.", [oneFeature], {
        status: "ready" as const,
      }),
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    };

    await saveSpec(tmpRoot, oldSpec);
    await saveSpec(tmpRoot, activeSpec);

    // Seed one contract per spec
    await saveContract(
      tmpRoot,
      createContract("Old sprint", "Sprint for the old spec.", [crit], {
        specId: oldSpec.specId,
      }),
    );
    await saveContract(
      tmpRoot,
      createContract("Active sprint", "Sprint for the active spec.", [crit], {
        specId: activeSpec.specId,
      }),
    );

    const { runGenerator } = await import("../../orchestrator/generator-agent.js");
    const { runSprintCommand } = await import("./sprint.js");
    await runSprintCommand(tmpRoot, {});

    // Generator must have been called exactly once
    expect(runGenerator).toHaveBeenCalledTimes(1);

    // The handoff passed to the generator must reference the ACTIVE spec's contract
    const handoff = (runGenerator as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(handoff.currentContract.specId).toBe(activeSpec.specId);
  });
});

// ── S3-C3: needs-clarification guard ──────────────────────────────────────

describe("S3-C3 — needs-clarification refusal", () => {
  it("refuses to run and never calls the generator when spec needs clarification", async () => {
    const spec = createSpec(
      "Blocked plan",
      "A plan that requires clarification before sprints can begin.",
      [oneFeature],
      {
        clarificationQuestions: [
          { questionId: "Q1", category: "scope", question: "Should this include mobile support?" },
        ],
      },
    );
    await saveSpec(tmpRoot, spec);
    await saveContract(
      tmpRoot,
      createContract("Blocked sprint", "Sprint for blocked spec.", [crit], {
        specId: spec.specId,
      }),
    );

    // Spy on console.error to capture the clarification message
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { runGenerator } = await import("../../orchestrator/generator-agent.js");
    const { runSprintCommand } = await import("./sprint.js");
    await runSprintCommand(tmpRoot, {});

    // Generator MUST NOT be called
    expect(runGenerator).not.toHaveBeenCalled();

    // The error output must mention the plan title and clarification
    const errOutput = errSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(errOutput).toContain("needs clarification");

    errSpy.mockRestore();
  });
});

// ── S3-C4: empty-contracts message references re-plan / run ───────────────

describe("S3-C4 — empty-contracts improved message", () => {
  it("prints a message instructing re-plan or run when no contracts match the active spec", async () => {
    // Seed only the spec (no contracts for it)
    const spec: PlanSpec = {
      ...createSpec("Ready plan", "A plan with no contracts on disk yet.", [oneFeature], {
        status: "ready" as const,
      }),
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    };
    await saveSpec(tmpRoot, spec);

    // Seed a contract from a DIFFERENT spec so listContracts isn't completely empty
    const otherSpec: PlanSpec = {
      ...createSpec("Other plan", "Another plan that should not be run.", [oneFeature], {
        status: "ready" as const,
      }),
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await saveSpec(tmpRoot, otherSpec);
    await saveContract(
      tmpRoot,
      createContract("Other sprint", "Sprint from a different spec.", [crit], {
        specId: otherSpec.specId,
      }),
    );

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { runGenerator } = await import("../../orchestrator/generator-agent.js");
    const { runSprintCommand } = await import("./sprint.js");
    await runSprintCommand(tmpRoot, {});

    // Generator must not be called
    expect(runGenerator).not.toHaveBeenCalled();

    // Error output must reference re-running plan or run
    const errOutput = errSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(errOutput).toContain("plan");
    expect(errOutput).toContain("run");

    errSpy.mockRestore();
  });
});

// ── S3-C5: single-spec happy path unchanged ────────────────────────────────

describe("S3-C5 — single-spec happy path", () => {
  it("selects and executes the pending contract when only one spec exists", async () => {
    const spec: PlanSpec = {
      ...createSpec("Single spec", "The one and only spec.", [oneFeature], {
        status: "ready" as const,
      }),
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    };
    await saveSpec(tmpRoot, spec);

    const contract = createContract("Sprint 1", "The first and only sprint.", [crit], {
      specId: spec.specId,
    });
    await saveContract(tmpRoot, contract);

    const { runGenerator } = await import("../../orchestrator/generator-agent.js");
    const { runEvaluatorAgent } = await import("../../orchestrator/evaluator-agent.js");
    const { runSprintCommand } = await import("./sprint.js");
    await runSprintCommand(tmpRoot, {});

    // Both generator and evaluator must have run once (one iteration, pass)
    expect(runGenerator).toHaveBeenCalledTimes(1);
    expect(runEvaluatorAgent).toHaveBeenCalledTimes(1);

    // The contract handed to the generator must be the one we seeded
    const handoff = (runGenerator as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(handoff.currentContract.specId).toBe(spec.specId);
  });
});
