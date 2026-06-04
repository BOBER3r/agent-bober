// ── conformance.test.ts ─────────────────────────────────────────────
//
// Unit tests for EngineConformanceHarness.assertEquivalent (C3 — CI gate).
// Uses real mkdtemp/.bober/ fixtures (no mock fs — house style).
// Injects DETERMINISTIC stub runners — NOT real engines. No LLM agents run.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../utils/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
  },
}));

import { EngineConformanceHarness } from "./conformance.js";
import type { EngineRunner } from "./conformance.js";
import { updateContract } from "../../state/sprint-state.js";
import { saveSpec, ensureBoberDir } from "../../state/index.js";
import type { PipelineEngineName } from "./engine.js";
import type { SprintContract } from "../../contracts/sprint-contract.js";
import type { PlanSpec } from "../../contracts/spec.js";

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Build a precision-clean SprintContract that passes saveContract's quality gate.
 * All text fields avoid banned vague phrases and meet minimum lengths.
 */
function makeSyntheticContract(overrides: Partial<SprintContract> = {}): SprintContract {
  const now = new Date().toISOString();
  return {
    contractId: "conformance-sprint-1",
    specId: "conformance-spec-1",
    sprintNumber: 1,
    title: "Add EngineConformanceHarness for artifact equivalence gating",
    description:
      "Implement the EngineConformanceHarness that asserts ts and skill engines " +
      "produce equivalent .bober/ artifacts for a fixture spec by normalizing " +
      "volatile fields (timestamps, durations) and deep-comparing the results.",
    status: "in-progress",
    dependsOn: [],
    features: ["feat-conformance"],
    successCriteria: [
      {
        criterionId: "SC1",
        description:
          "assertEquivalent returns equivalent:true when both engine runners " +
          "write identical normalized .bober/ artifacts to separate temp roots.",
        verificationMethod: "unit-test",
        required: true,
      },
    ],
    nonGoals: [
      "Do not run real LLM engines — use deterministic stub runners only.",
      "Do not implement the live workflow invoke transport in this sprint.",
    ],
    stopConditions: [
      "Stop when the conformance unit tests pass and typecheck exits with zero errors.",
      "Stop when changes are confined to conformance.ts and its test file.",
    ],
    definitionOfDone:
      "EngineConformanceHarness.assertEquivalent gates ts/skill artifact " +
      "equivalence, running as part of npm run test with deterministic stubs " +
      "and returning correct ConformanceReport shapes for both match and diverge cases.",
    assumptions: ["Stub runners write fixed normalized artifact sets deterministically."],
    outOfScope: ["live engine runs", "workflow invoke"],
    ambiguityScore: 3,
    estimatedFiles: ["src/orchestrator/workflow/conformance.ts"],
    estimatedDuration: "small",
    iterationHistory: [],
    lastEvalId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * Build a minimal valid PlanSpec for the synthetic run.
 */
function makeSyntheticSpec(): PlanSpec {
  const now = new Date().toISOString();
  return {
    specId: "conformance-spec-1",
    version: 1,
    title: "Workflow Engine Sprint 6",
    description: "Add the WorkflowEngine and EngineConformanceHarness for CI gating.",
    status: "in-progress",
    mode: "brownfield",
    features: [
      {
        featureId: "feat-conformance",
        title: "EngineConformanceHarness",
        description: "Host-side harness that gates ts/skill artifact equivalence.",
        priority: "must-have",
        acceptanceCriteria: [
          "assertEquivalent returns equivalent:true for matching artifacts",
          "assertEquivalent returns equivalent:false with diffs for diverging artifacts",
        ],
      },
    ],
    assumptions: [],
    outOfScope: [],
    clarificationQuestions: [],
    resolvedClarifications: [],
    techStack: ["TypeScript", "Node.js", "Vitest"],
    nonFunctionalRequirements: [],
    constraints: [],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * A deterministic stub EngineRunner that writes a fixed artifact set:
 * one contract + one spec, with timestamps that will be stripped by normalization.
 */
function makeFixedRunner(contractOverrides: Partial<SprintContract> = {}): EngineRunner {
  return async (root: string) => {
    await ensureBoberDir(root);
    const contract = makeSyntheticContract(contractOverrides);
    await updateContract(root, contract);
    const spec = makeSyntheticSpec();
    await saveSpec(root, spec);
  };
}

// ── Temp dir setup ─────────────────────────────────────────────────

let tmpRoots: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  tmpRoots = [];
});

afterEach(async () => {
  await Promise.all(
    tmpRoots.map((r) => rm(r, { recursive: true, force: true })),
  );
  tmpRoots = [];
});

/** Factory: creates a fresh temp dir, tracks it for cleanup. */
async function mkTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bober-conformance-test-"));
  tmpRoots.push(dir);
  return dir;
}

// ── C3: equal artifacts → equivalent:true ─────────────────────────────────

describe("EngineConformanceHarness (C3 — equivalent case)", () => {
  it("returns equivalent:true when both engines write identical normalized artifacts", async () => {
    const harness = new EngineConformanceHarness();

    // Both ts and skill runners write the same fixed artifact set
    const fixedRunner = makeFixedRunner();
    const runnerFor = (_engine: PipelineEngineName) => fixedRunner;

    const report = await harness.assertEquivalent(
      "conformance-spec-1",
      ["ts", "skill"],
      mkTmp,
      runnerFor,
    );

    expect(report.equivalent).toBe(true);
    expect(report.diffs).toEqual([]);
  });

  it("returns equivalent:true even when timestamps differ (volatile fields stripped)", async () => {
    const harness = new EngineConformanceHarness();

    // Each runner call produces fresh timestamps (different createdAt/updatedAt),
    // but normalization strips them — so they should still be equivalent.
    // Two separate runner instances, each writing same logical contract.
    let callCount = 0;
    const timestampVariantRunner: EngineRunner = async (root: string) => {
      await ensureBoberDir(root);
      // Vary timestamps between calls to prove normalization strips them
      const tsOverride = callCount++ === 0
        ? { createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }
        : { createdAt: "2026-06-04T12:00:00.000Z", updatedAt: "2026-06-04T12:00:00.000Z" };
      const contract = makeSyntheticContract(tsOverride);
      await updateContract(root, contract);
    };

    const report = await harness.assertEquivalent(
      "conformance-spec-1",
      ["ts", "skill"],
      mkTmp,
      () => timestampVariantRunner,
    );

    expect(report.equivalent).toBe(true);
    expect(report.diffs).toEqual([]);
  });
});

// ── C3: injected divergence → equivalent:false with populated diffs ────────────

describe("EngineConformanceHarness (C3 — divergence case)", () => {
  it("returns equivalent:false with diffs when engines write different contract titles", async () => {
    const harness = new EngineConformanceHarness();

    // ts runner writes the standard title; skill runner writes a DIFFERENT non-volatile field
    const tsRunner = makeFixedRunner({
      title: "Add EngineConformanceHarness for artifact equivalence gating",
    });
    const skillRunner = makeFixedRunner({
      title: "Add EngineConformanceHarness for artifact equivalence gating DIVERGED",
      description:
        "This contract title intentionally differs from the ts runner to exercise " +
        "the divergence detection path in EngineConformanceHarness for the C3 test.",
    });

    const runnerFor = (engine: PipelineEngineName): EngineRunner => {
      if (engine === "skill") return skillRunner;
      return tsRunner;
    };

    const report = await harness.assertEquivalent(
      "conformance-spec-1",
      ["ts", "skill"],
      mkTmp,
      runnerFor,
    );

    expect(report.equivalent).toBe(false);
    expect(report.diffs.length).toBeGreaterThan(0);
    // Should report the contracts artifact as diverging
    const contractDiff = report.diffs.find((d) => d.artifact === "contract");
    expect(contractDiff).toBeDefined();
    expect(contractDiff?.engines).toContain("ts");
    expect(contractDiff?.engines).toContain("skill");
  });

  it("returns equivalent:false when one engine writes no contracts but the other does", async () => {
    const harness = new EngineConformanceHarness();

    // ts runner writes a contract; skill runner writes nothing
    const tsRunner = makeFixedRunner();
    const emptySkillRunner: EngineRunner = async (root: string) => {
      await ensureBoberDir(root);
      // Writes no contracts — empty .bober/contracts/ dir
    };

    const runnerFor = (engine: PipelineEngineName): EngineRunner => {
      if (engine === "skill") return emptySkillRunner;
      return tsRunner;
    };

    const report = await harness.assertEquivalent(
      "conformance-spec-1",
      ["ts", "skill"],
      mkTmp,
      runnerFor,
    );

    expect(report.equivalent).toBe(false);
    expect(report.diffs.length).toBeGreaterThan(0);
  });

  it("returns the diverging engine pair in diffs[].engines", async () => {
    const harness = new EngineConformanceHarness();

    const tsRunner = makeFixedRunner({
      title: "Add EngineConformanceHarness for artifact equivalence gating",
    });
    const skillRunner = makeFixedRunner({
      title: "Completely different sprint title for divergence testing only",
      description:
        "This description is intentionally different from the ts runner contract " +
        "to verify that diffs correctly reports the engine pair that diverged.",
    });

    const runnerFor = (engine: PipelineEngineName): EngineRunner =>
      engine === "skill" ? skillRunner : tsRunner;

    const report = await harness.assertEquivalent(
      "conformance-spec-1",
      ["ts", "skill"],
      mkTmp,
      runnerFor,
    );

    expect(report.equivalent).toBe(false);
    const diff = report.diffs[0];
    expect(diff).toBeDefined();
    expect(diff?.engines).toEqual(expect.arrayContaining(["ts", "skill"]));
  });
});

// ── C3: fresh projectRoot per engine (isolation) ───────────────────────────────

describe("EngineConformanceHarness (C3 — isolation)", () => {
  it("calls projectRootFactory once per engine, giving each a distinct root", async () => {
    const harness = new EngineConformanceHarness();
    const roots: string[] = [];

    const trackingFactory = async (): Promise<string> => {
      const dir = await mkdtemp(join(tmpdir(), "bober-isolation-test-"));
      tmpRoots.push(dir);
      roots.push(dir);
      return dir;
    };

    const fixedRunner = makeFixedRunner();
    await harness.assertEquivalent(
      "conformance-spec-1",
      ["ts", "skill"],
      trackingFactory,
      () => fixedRunner,
    );

    // Each engine gets its own root
    expect(roots).toHaveLength(2);
    expect(roots[0]).not.toBe(roots[1]);
  });
});
