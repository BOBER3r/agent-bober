// ── conformance.test.ts ─────────────────────────────────────────────
//
// Unit tests for EngineConformanceHarness.assertEquivalent (C3 — CI gate).
// Uses real mkdtemp/.bober/ fixtures (no mock fs — house style).
// Injects DETERMINISTIC stub runners — NOT real engines. No LLM agents run.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

import {
  EngineConformanceHarness,
  emptyOnAllEnginesFields,
  fullyPopulatedFields,
} from "./conformance.js";
import type { EngineRunner } from "./conformance.js";
import { CONFORMANCE_FIELDS } from "./types.js";
import { updateContract } from "../../state/sprint-state.js";
import { saveSpec, ensureBoberDir } from "../../state/index.js";
import { appendHistory, updateProgress } from "../../state/history.js";
import { saveBriefing } from "../../state/briefing-state.js";
import { saveReview } from "../../state/review-state.js";
import { writeRunState } from "../../state/run-state.js";
import { writeCompletionMarker } from "../finalize.js";
import type { PipelineEngineName } from "./engine.js";
import type { PipelineResult } from "../pipeline.js";
import type { RunState } from "../../mcp/run-manager.js";
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

// ══════════════════════════════════════════════════════════════════════
// sc-13-2 — the ELEVEN-field widening
//
// The harness half of sc-13-2: the harness compares eleven fields with an
// order-tolerant structured diff, and cannot report equivalence over nothing.
// The two-engine comparison itself is asserted elsewhere; these cases pin the
// COMPARATOR, with deterministic runners so a failure names the comparator.
// ══════════════════════════════════════════════════════════════════════

// ── Writers for the seven fields the original harness never read ──────

async function writeEvalResult(root: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const dir = join(root, ".bober", "eval-results");
  await mkdir(dir, { recursive: true });
  const payload = {
    evalId: "eval-conformance-1",
    contractId: "conformance-sprint-1",
    iteration: 1,
    overallResult: "pass",
    passed: true,
    criteriaResults: [
      { criterionId: "SC1", result: "pass", verificationMethod: "unit-test" },
    ],
    strategyResults: [{ strategy: "tests", result: "pass" }],
    ...overrides,
  };
  await writeFile(join(dir, `${String(payload.evalId)}-1.json`), JSON.stringify(payload), "utf-8");
}

async function writeAudit(root: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const dir = join(root, ".bober", "audits");
  await mkdir(dir, { recursive: true });
  const record = {
    timestamp: "2026-08-05T00:00:00.000Z",
    runId: "run-fixed",
    checkpointId: "post-plan",
    mechanism: "noop",
    outcome: "approved",
    approverId: "conformance-approver",
    iteration: 1,
    durationMs: 17,
    ...overrides,
  };
  await writeFile(join(dir, "run-fixed.jsonl"), JSON.stringify(record) + "\n", "utf-8");
}

function makeRunState(root: string, overrides: Partial<RunState> = {}): RunState {
  return {
    runId: "run-fixed",
    task: "Add EngineConformanceHarness widening",
    status: "completed",
    startedAt: "2026-08-05T00:00:00.000Z",
    progress: { phase: "complete", completedSprints: 1, totalSprints: 1 },
    projectRoot: root,
    specId: "conformance-spec-1",
    ...overrides,
  } as RunState;
}

/** A runner that populates ALL ELEVEN fields, so equivalence is never vacuous. */
function makeElevenFieldRunner(
  overrides: {
    contract?: Partial<SprintContract>;
    briefing?: string;
    review?: string;
    evalResult?: Record<string, unknown>;
    audit?: Record<string, unknown>;
    runState?: Partial<RunState>;
    marker?: Record<string, unknown>;
    result?: Partial<PipelineResult>;
    historyEvent?: string;
  } = {},
): EngineRunner {
  return async (root: string): Promise<PipelineResult> => {
    await ensureBoberDir(root);
    const contract = makeSyntheticContract(overrides.contract ?? {});
    const spec = makeSyntheticSpec();

    await updateContract(root, contract);
    await saveSpec(root, spec);
    await appendHistory(root, {
      timestamp: "2026-08-05T00:00:00.000Z",
      event: overrides.historyEvent ?? "pipeline-start",
      phase: "init",
      details: { engine: "fixture" },
    });
    await writeEvalResult(root, overrides.evalResult);
    await saveBriefing(root, contract.contractId, overrides.briefing ?? "# Briefing\n\nfixed body\n");
    await saveReview(root, contract.contractId, overrides.review ?? "# Review\n\nfixed body\n");
    await writeAudit(root, overrides.audit);
    await updateProgress(root, [contract], spec);
    await writeRunState(root, makeRunState(root, overrides.runState ?? {}));
    await writeCompletionMarker(root, "run-fixed", {
      phase: "complete",
      success: true,
      completedSprints: 1,
      failedSprints: 0,
      duration: 42,
      ...(overrides.marker ?? {}),
    });

    return {
      success: true,
      spec,
      completedSprints: [contract],
      failedSprints: [],
      duration: 1234,
      ...(overrides.result ?? {}),
    };
  };
}

describe("EngineConformanceHarness — eleven fields (sc-13-2)", () => {
  it("collects all eleven fields, reports each as populated, and is not vacuous", async () => {
    const harness = new EngineConformanceHarness();
    const runner = makeElevenFieldRunner();

    const report = await harness.assertEquivalent(
      "conformance-spec-1",
      ["ts", "pge"],
      mkTmp,
      () => runner,
    );

    expect(report.fields.map((f) => f.field)).toEqual([...CONFORMANCE_FIELDS]);
    expect(report.fields).toHaveLength(11);
    expect(report.vacuous).toBe(false);
    expect(report.diffs).toEqual([]);
    expect(report.equivalent).toBe(true);

    // Every one of the eleven is populated for BOTH engines — the evaluator's
    // "not empty on both sides" requirement, asserted rather than assumed.
    expect(fullyPopulatedFields(report)).toEqual([...CONFORMANCE_FIELDS]);
    expect(emptyOnAllEnginesFields(report)).toEqual([]);
    for (const field of report.fields) {
      expect(field.populated).toEqual({ ts: true, pge: true });
    }
  });

  it("reports equivalent:false and vacuous:true when neither engine writes anything", async () => {
    const harness = new EngineConformanceHarness();
    const emptyRunner: EngineRunner = async (root: string) => {
      await ensureBoberDir(root);
    };

    const report = await harness.assertEquivalent(
      "conformance-spec-1",
      ["ts", "pge"],
      mkTmp,
      () => emptyRunner,
    );

    // Nothing DIFFERS — and that is exactly why the naive answer is wrong.
    expect(report.diffs).toEqual([]);
    expect(report.vacuous).toBe(true);
    expect(report.equivalent).toBe(false);
    expect(emptyOnAllEnginesFields(report)).toEqual([...CONFORMANCE_FIELDS]);
  });

  it("records a field that is empty on both sides as known-empty without failing the run", async () => {
    const harness = new EngineConformanceHarness();
    // Contracts only: ten of the eleven fields are empty on both sides.
    const runner = makeFixedRunner();

    const report = await harness.assertEquivalent(
      "conformance-spec-1",
      ["ts", "pge"],
      mkTmp,
      () => runner,
    );

    expect(report.equivalent).toBe(true);
    expect(report.vacuous).toBe(false);
    expect(fullyPopulatedFields(report)).toEqual(["contracts", "specs"]);
    expect(emptyOnAllEnginesFields(report)).toContain("audits");
    expect(emptyOnAllEnginesFields(report)).toContain("completionMarker");
  });
});

// ── Order tolerance ───────────────────────────────────────────────────

describe("EngineConformanceHarness — order-tolerant diff (sc-13-2)", () => {
  function threeContractRunner(order: readonly number[]): EngineRunner {
    return async (root: string) => {
      await ensureBoberDir(root);
      for (const n of order) {
        await updateContract(
          root,
          makeSyntheticContract({
            contractId: `conformance-sprint-${String(n)}`,
            sprintNumber: n,
          }),
        );
      }
    };
  }

  it("treats the same contract set written in a different order as equivalent", async () => {
    const harness = new EngineConformanceHarness();
    const runnerFor = (engine: PipelineEngineName): EngineRunner =>
      engine === "pge" ? threeContractRunner([3, 1, 2]) : threeContractRunner([1, 2, 3]);

    const report = await harness.assertEquivalent(
      "conformance-spec-1",
      ["ts", "pge"],
      mkTmp,
      runnerFor,
    );

    expect(report.diffs).toEqual([]);
    expect(report.equivalent).toBe(true);
  });

  it("still detects a CONTENT difference at the same cardinality — order tolerance is not blindness", async () => {
    const harness = new EngineConformanceHarness();
    const divergent: EngineRunner = async (root: string) => {
      await ensureBoberDir(root);
      for (const n of [3, 1, 2]) {
        await updateContract(
          root,
          makeSyntheticContract({
            contractId: `conformance-sprint-${String(n)}`,
            sprintNumber: n,
            // Same three contract ids, same count, one different field.
            ambiguityScore: n === 2 ? 9 : 3,
          }),
        );
      }
    };
    const runnerFor = (engine: PipelineEngineName): EngineRunner =>
      engine === "pge" ? divergent : threeContractRunner([1, 2, 3]);

    const report = await harness.assertEquivalent(
      "conformance-spec-1",
      ["ts", "pge"],
      mkTmp,
      runnerFor,
    );

    expect(report.equivalent).toBe(false);
    const diff = report.diffs.find((d) => d.artifact === "contract");
    expect(diff).toBeDefined();
    // The diff NAMES the element, not just the directory.
    expect(diff?.path).toBe(".bober/contracts/conformance-sprint-2.json");
    expect(diff?.field).toBe("contracts");
    expect(diff?.engines).toEqual(["ts", "pge"]);
  });

  it("is insensitive to JSON key order but not to key VALUES", async () => {
    const harness = new EngineConformanceHarness();
    const dir = ".bober/eval-results";
    const keyOrderRunner = (reversed: boolean): EngineRunner => {
      return async (root: string) => {
        await ensureBoberDir(root);
        await mkdir(join(root, dir), { recursive: true });
        const entries: Array<[string, unknown]> = [
          ["evalId", "eval-keyorder"],
          ["contractId", "conformance-sprint-1"],
          ["passed", true],
        ];
        const payload = Object.fromEntries(reversed ? [...entries].reverse() : entries);
        await writeFile(
          join(root, dir, "eval-keyorder-1.json"),
          JSON.stringify(payload),
          "utf-8",
        );
      };
    };
    const report = await harness.assertEquivalent(
      "conformance-spec-1",
      ["ts", "pge"],
      mkTmp,
      (engine) => keyOrderRunner(engine === "pge"),
    );
    expect(report.equivalent).toBe(true);
  });
});

// ── Per-field divergence detection ────────────────────────────────────

describe("EngineConformanceHarness — every new field diverges loudly (sc-13-2)", () => {
  const cases: Array<{
    name: string;
    artifact: string;
    field: string;
    diverge: Parameters<typeof makeElevenFieldRunner>[0];
  }> = [
    {
      name: "briefings",
      artifact: "briefing",
      field: "briefings",
      diverge: { briefing: "# Briefing\n\nDIVERGED body\n" },
    },
    {
      name: "reviews",
      artifact: "review",
      field: "reviews",
      diverge: { review: "# Review\n\nDIVERGED body\n" },
    },
    {
      name: "audits",
      artifact: "audit",
      field: "audits",
      diverge: { audit: { outcome: "rejected" } },
    },
    {
      name: "evalResults",
      artifact: "eval-result",
      field: "evalResults",
      diverge: { evalResult: { overallResult: "fail", passed: false } },
    },
    {
      name: "runState",
      artifact: "run-state",
      field: "runState",
      diverge: { runState: { status: "failed" } },
    },
    {
      name: "completionMarker",
      artifact: "completion-marker",
      field: "completionMarker",
      diverge: { marker: { phase: "failed", success: false } },
    },
    {
      name: "pipelineResult",
      artifact: "pipeline-result",
      field: "pipelineResult",
      diverge: { result: { success: false } },
    },
    {
      name: "history",
      artifact: "history",
      field: "history",
      diverge: { historyEvent: "pipeline-diverged" },
    },
  ];

  for (const testCase of cases) {
    it(`reports a structured diff for ${testCase.name}`, async () => {
      const harness = new EngineConformanceHarness();
      const base = makeElevenFieldRunner();
      const diverged = makeElevenFieldRunner(testCase.diverge);

      const report = await harness.assertEquivalent(
        "conformance-spec-1",
        ["ts", "pge"],
        mkTmp,
        (engine) => (engine === "pge" ? diverged : base),
      );

      expect(report.equivalent).toBe(false);
      const diff = report.diffs.find((d) => d.field === testCase.field);
      expect(diff, `no diff reported for ${testCase.field}`).toBeDefined();
      expect(diff?.artifact).toBe(testCase.artifact);
      expect(diff?.engines).toEqual(["ts", "pge"]);
      expect(typeof diff?.path).toBe("string");
      expect(diff?.detail).toBeTruthy();
    });
  }

  it("reports a diff for progress.md body changes", async () => {
    const harness = new EngineConformanceHarness();
    const base = makeElevenFieldRunner();
    const diverged = makeElevenFieldRunner({
      contract: { title: "A completely different sprint title for the progress body" },
    });

    const report = await harness.assertEquivalent(
      "conformance-spec-1",
      ["ts", "pge"],
      mkTmp,
      (engine) => (engine === "pge" ? diverged : base),
    );

    expect(report.equivalent).toBe(false);
    const diff = report.diffs.find((d) => d.field === "progress");
    expect(diff).toBeDefined();
    expect(diff?.artifact).toBe("progress");
    expect(diff?.path).toBe(".bober/progress.md");
  });
});

// ── Normalization: what is stripped, and what is NOT ──────────────────

describe("EngineConformanceHarness — normalization boundaries (sc-13-2)", () => {
  it("ignores progress.md's `Last updated:` line, which no VOLATILE_KEY can reach", async () => {
    const harness = new EngineConformanceHarness();
    // `updateProgress` stamps `Last updated: <new Date().toISOString()>` into MARKDOWN,
    // which `normalize()` cannot see because it only walks objects. The stamp is written
    // explicitly here so the two engines PROVABLY differ on that line and on nothing else
    // — calling updateProgress twice could land in the same millisecond and assert nothing.
    const progressRunner = (stamp: string): EngineRunner => {
      return async (root: string) => {
        await ensureBoberDir(root);
        await writeFile(
          join(root, ".bober", "progress.md"),
          `# Bober Progress\n\nLast updated: ${stamp}\n\n## Plan\n\nidentical body\n`,
          "utf-8",
        );
      };
    };

    const report = await harness.assertEquivalent(
      "conformance-spec-1",
      ["ts", "pge"],
      mkTmp,
      (engine) =>
        progressRunner(
          engine === "pge" ? "2026-08-05T11:11:11.111Z" : "2026-01-01T00:00:00.000Z",
        ),
    );

    expect(report.fields.find((f) => f.field === "progress")?.populated).toEqual({
      ts: true,
      pge: true,
    });
    expect(report.diffs).toEqual([]);
    expect(report.equivalent).toBe(true);

    // And a real body change is still a divergence — the filter drops one line, not content.
    const bodyDiff = await harness.assertEquivalent(
      "conformance-spec-1",
      ["ts", "pge"],
      mkTmp,
      (engine) =>
        engine === "pge"
          ? async (root: string) => {
              await ensureBoberDir(root);
              await writeFile(
                join(root, ".bober", "progress.md"),
                "# Bober Progress\n\nLast updated: 2026-01-01T00:00:00.000Z\n\n## Plan\n\nDIFFERENT body\n",
                "utf-8",
              );
            }
          : progressRunner("2026-01-01T00:00:00.000Z"),
    );
    expect(bodyDiff.equivalent).toBe(false);
    expect(bodyDiff.diffs.some((d) => d.field === "progress")).toBe(true);
  });

  it("ignores an audit's durationMs and approverId, and NOTHING else about it", async () => {
    const harness = new EngineConformanceHarness();
    const base = makeElevenFieldRunner();

    // Volatile-only difference → equivalent.
    const volatileOnly = makeElevenFieldRunner({
      audit: { durationMs: 999_999, approverId: "some-other-machine-user" },
    });
    const tolerant = await harness.assertEquivalent(
      "conformance-spec-1",
      ["ts", "pge"],
      mkTmp,
      (engine) => (engine === "pge" ? volatileOnly : base),
    );
    expect(tolerant.equivalent).toBe(true);

    // The neighbouring fields are still compared: `mechanism` and `iteration` are
    // engine-observable and must NOT have been swept into the volatile set.
    for (const nonVolatile of [{ mechanism: "cli" }, { iteration: 4 }] as const) {
      const report = await harness.assertEquivalent(
        "conformance-spec-1",
        ["ts", "pge"],
        mkTmp,
        (engine) =>
          engine === "pge" ? makeElevenFieldRunner({ audit: { ...nonVolatile } }) : base,
      );
      expect(report.equivalent, `audit.${Object.keys(nonVolatile)[0]} was swept up`).toBe(false);
      expect(report.diffs.some((d) => d.field === "audits")).toBe(true);
    }
  });

  it("redacts each engine's own project root instead of stripping the field", async () => {
    const harness = new EngineConformanceHarness();
    // RunState.projectRoot is the engine's own fresh temp root — different by
    // construction. It is REDACTED, so this is equivalent...
    const runner = makeElevenFieldRunner();
    const tolerant = await harness.assertEquivalent(
      "conformance-spec-1",
      ["ts", "pge"],
      mkTmp,
      () => runner,
    );
    expect(tolerant.diffs.some((d) => d.field === "runState")).toBe(false);

    // ...but an engine that records SOMEONE ELSE'S root still diverges, which a
    // VOLATILE_KEYS entry for `projectRoot` would have hidden.
    const wrongRoot = makeElevenFieldRunner({
      runState: { projectRoot: "/somewhere/else/entirely" },
    });
    const report = await harness.assertEquivalent(
      "conformance-spec-1",
      ["ts", "pge"],
      mkTmp,
      (engine) => (engine === "pge" ? wrongRoot : runner),
    );
    expect(report.equivalent).toBe(false);
    expect(report.diffs.some((d) => d.field === "runState")).toBe(true);
  });

  it("does not strip `phase`, `status`, `success` or `verdict` — engine-observable facts", async () => {
    const harness = new EngineConformanceHarness();
    const base = makeElevenFieldRunner();

    const observable: Array<Parameters<typeof makeElevenFieldRunner>[0]> = [
      { marker: { phase: "failed" } },
      { runState: { status: "aborted" } },
      { result: { success: false } },
      { contract: { status: "failed" } },
    ];

    for (const diverge of observable) {
      const report = await harness.assertEquivalent(
        "conformance-spec-1",
        ["ts", "pge"],
        mkTmp,
        (engine) => (engine === "pge" ? makeElevenFieldRunner(diverge) : base),
      );
      expect(report.equivalent, `${JSON.stringify(diverge)} was treated as volatile`).toBe(false);
    }
  });
});
