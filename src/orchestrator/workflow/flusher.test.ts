// ── flusher.test.ts ──────────────────────────────────────────────────
//
// Unit tests for RunResultFlusher.flush.
// Uses real mkdtemp/.bober/ fixtures (no mock fs — house style).

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { RunResultFlusher } from "./flusher.js";
import { loadContract, listContracts } from "../../state/sprint-state.js";
import { loadHistory } from "../../state/history.js";
import { createDefaultConfig } from "../../config/schema.js";
import {
  COMPLETION_MARKER_SUFFIX,
  PIPELINE_COMPLETE_EVENT,
  completionMarkerPath,
} from "../finalize.js";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";

import type { SprintContract } from "../../contracts/sprint-contract.js";
import type { PlanSpec } from "../../contracts/spec.js";
import type { WorkflowRunResult } from "./types.js";
import type { EvalResult } from "../../contracts/eval-result.js";

// ── Fixture ───────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-flusher-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Build a precision-clean SprintContract that passes saveContract's quality gate.
 * All text fields avoid banned vague phrases and meet minimum lengths.
 */
function makeSyntheticContract(overrides: Partial<SprintContract> = {}): SprintContract {
  const now = new Date().toISOString();
  return {
    contractId: "synthetic-sprint-1",
    specId: "synthetic-spec-1",
    sprintNumber: 1,
    title: "Add RunResultFlusher host commit layer",
    description:
      "Implement the RunResultFlusher class that commits a WorkflowRunResult " +
      "to durable .bober/ state by calling updateContract, appendHistory, and " +
      "updateProgress, stamping ISO timestamps as the sole clock source.",
    status: "in-progress",
    dependsOn: [],
    features: ["feat-flusher"],
    successCriteria: [
      {
        criterionId: "SC1",
        description:
          "flush() persists each contract to .bober/contracts/ with a stamped " +
          "completedAt field when the outcome is 'passed'.",
        verificationMethod: "unit-test",
        required: true,
      },
    ],
    nonGoals: [
      "Do not execute the workflow script against the live runtime in this sprint.",
      "Do not implement WorkflowEngine.run — that is deferred to the next sprint.",
    ],
    stopConditions: [
      "Stop when the flusher unit tests pass and typecheck exits with zero errors.",
      "Stop when changes are confined to flusher.ts and its test file.",
    ],
    definitionOfDone:
      "The RunResultFlusher commits WorkflowRunResult to .bober/ state with " +
      "stamped timestamps, flushing after each contract for crash-safety, and " +
      "returns a valid PipelineResult.",
    assumptions: ["saveContract validates the precision gate before writing."],
    outOfScope: ["WorkflowEngine wiring", "live agent dispatch"],
    ambiguityScore: 3,
    estimatedFiles: ["src/orchestrator/workflow/flusher.ts"],
    estimatedDuration: "medium",
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
    specId: "synthetic-spec-1",
    version: 1,
    title: "Workflow Engine Sprint 5",
    description: "Add the RunResultFlusher and the bober-pipeline.js workflow script.",
    status: "in-progress",
    mode: "brownfield",
    features: [
      {
        featureId: "feat-flusher",
        title: "RunResultFlusher",
        description: "Host-side flusher that commits WorkflowRunResult to .bober/.",
        priority: "must-have",
        acceptanceCriteria: [
          "flush() writes contracts with stamped completedAt",
          "flush() appends history entries with ISO timestamps",
          "flush() updates progress.md after each contract",
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
 * Build a minimal valid EvalResult as returned by reconcile().
 */
function makeEvalResult(passed: boolean): EvalResult {
  return {
    evaluator: "panel",
    passed,
    score: passed ? 100 : 0,
    details: [],
    summary: passed ? "Panel verdict: 1/1 lenses passed" : "Panel verdict: 0/1 lenses failed",
    feedback: passed ? "All lenses passed." : "One or more lenses failed.",
    timestamp: "",  // host will re-stamp; "" is valid for EvalResult schema (not z.datetime())
  };
}

/**
 * Build a synthetic WorkflowRunResult with one passed sprint.
 */
function makeSyntheticResult(contract: SprintContract, spec: PlanSpec): WorkflowRunResult {
  return {
    spec,
    perSprint: [
      {
        contract,
        finalVerdict: makeEvalResult(true),
        iterationsUsed: 1,
        outcome: "passed",
        lensVerdicts: [makeEvalResult(true)],
      },
    ],
    needsClarification: false,
    pendingHistory: [
      {
        event: "sprint-passed",
        phase: "complete",
        sprintId: contract.contractId,
        details: { iteration: 1, feedback: "All evaluations passed." },
      },
    ],
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("RunResultFlusher.flush (C3 + C4)", () => {
  it("returns a PipelineResult with correct shape and timing", async () => {
    const flusher = new RunResultFlusher();
    const config = createDefaultConfig("test", "brownfield");
    const contract = makeSyntheticContract();
    const spec = makeSyntheticSpec();
    const result = makeSyntheticResult(contract, spec);

    const before = Date.now();
    const pipelineResult = await flusher.flush(tmpDir, config, result);
    const after = Date.now();

    expect(typeof pipelineResult.success).toBe("boolean");
    expect(pipelineResult.success).toBe(true);
    expect(pipelineResult.completedSprints).toHaveLength(1);
    expect(pipelineResult.failedSprints).toHaveLength(0);
    expect(typeof pipelineResult.duration).toBe("number");
    expect(pipelineResult.duration).toBeGreaterThanOrEqual(0);
    expect(pipelineResult.duration).toBeLessThanOrEqual(after - before + 100);
    expect(pipelineResult.needsClarification).toBe(false);
    expect(pipelineResult.spec).toBe(result.spec);
  });

  it("writes contract with stamped completedAt (C3 — passed outcome)", async () => {
    const flusher = new RunResultFlusher();
    const config = createDefaultConfig("test", "brownfield");
    const contract = makeSyntheticContract();
    const spec = makeSyntheticSpec();
    const result = makeSyntheticResult(contract, spec);

    await flusher.flush(tmpDir, config, result);

    const loaded = await loadContract(tmpDir, contract.contractId);
    expect(loaded.status).toBe("completed");
    expect(typeof loaded.completedAt).toBe("string");
    // completedAt must be a valid ISO 8601 datetime
    expect(() => new Date(loaded.completedAt!).toISOString()).not.toThrow();
  });

  /**
   * CHANGED in the PGE sprint-4 extraction, and deliberately so.
   *
   * This assertion used to be `toHaveLength(result.pendingHistory.length)`,
   * which encoded the pre-existing DEFECT that the flusher emitted no terminal
   * event at all — a workflow-engine run was invisible to
   * src/chat/completion-tailer.ts. The flusher now shares finalizePipelineRun
   * with the TS engine, so the expected history is the pendingHistory entries
   * PLUS exactly one PIPELINE_COMPLETE_EVENT, appended last. The count is still
   * exact (nothing is loosened) and the extra line is named, not tolerated.
   */
  it("appends pendingHistory entries with stamped timestamps, then exactly one terminal event (C3)", async () => {
    const flusher = new RunResultFlusher();
    const config = createDefaultConfig("test", "brownfield");
    const contract = makeSyntheticContract();
    const spec = makeSyntheticSpec();
    const result = makeSyntheticResult(contract, spec);

    await flusher.flush(tmpDir, config, result);

    const history = await loadHistory(tmpDir);
    expect(history).toHaveLength(result.pendingHistory.length + 1);

    for (const entry of history) {
      expect(typeof entry.timestamp).toBe("string");
      expect(() => new Date(entry.timestamp).toISOString()).not.toThrow();
    }

    // The pendingHistory entries come first, in order, unchanged.
    expect(history.slice(0, result.pendingHistory.length).map((h) => h.event)).toEqual(
      result.pendingHistory.map((h) => h.event),
    );

    // ...and the terminal event is last, exactly once.
    const terminal = history.filter((h) => h.event === PIPELINE_COMPLETE_EVENT);
    expect(terminal).toHaveLength(1);
    expect(history[history.length - 1]!.event).toBe(PIPELINE_COMPLETE_EVENT);
    expect(terminal[0]!.phase).toBe("complete");
    expect(terminal[0]!.details["completed"]).toBe(1);
    expect(terminal[0]!.details["failed"]).toBe(0);
    expect(typeof terminal[0]!.details["durationMs"]).toBe("number");
  });

  it("writes progress.generated.md containing the contract title (C3)", async () => {
    const flusher = new RunResultFlusher();
    const config = createDefaultConfig("test", "brownfield");
    const contract = makeSyntheticContract();
    const spec = makeSyntheticSpec();
    const result = makeSyntheticResult(contract, spec);

    await flusher.flush(tmpDir, config, result);

    const progressPath = join(tmpDir, ".bober", "progress.generated.md");
    expect(existsSync(progressPath)).toBe(true);
    const content = await readFile(progressPath, "utf-8");
    expect(content).toContain(contract.title);
  });

  it("success=false when all sprints failed", async () => {
    const flusher = new RunResultFlusher();
    const config = createDefaultConfig("test", "brownfield");
    const contract = makeSyntheticContract();
    const spec = makeSyntheticSpec();

    const result: WorkflowRunResult = {
      spec,
      perSprint: [
        {
          contract,
          finalVerdict: makeEvalResult(false),
          iterationsUsed: 3,
          outcome: "failed",
          lensVerdicts: [makeEvalResult(false)],
        },
      ],
      needsClarification: false,
      pendingHistory: [],
    };

    const pipelineResult = await flusher.flush(tmpDir, config, result);
    expect(pipelineResult.success).toBe(false);
    expect(pipelineResult.failedSprints).toHaveLength(1);
    expect(pipelineResult.completedSprints).toHaveLength(0);
  });

  it("'needs-rework' outcome does not stamp completedAt (C3 — updateContractStatus invariant)", async () => {
    const flusher = new RunResultFlusher();
    const config = createDefaultConfig("test", "brownfield");
    const contract = makeSyntheticContract();
    const spec = makeSyntheticSpec();

    const result: WorkflowRunResult = {
      spec,
      perSprint: [
        {
          contract,
          finalVerdict: makeEvalResult(false),
          iterationsUsed: 2,
          outcome: "needs-rework",
          lensVerdicts: [makeEvalResult(false)],
        },
      ],
      needsClarification: false,
      pendingHistory: [],
    };

    await flusher.flush(tmpDir, config, result);

    const loaded = await loadContract(tmpDir, contract.contractId);
    expect(loaded.status).toBe("needs-rework");
    // updateContractStatus only stamps completedAt for passed|failed|completed
    expect(loaded.completedAt).toBeUndefined();
  });

  describe("C4 — crash-safety: idempotent re-flush", () => {
    it("re-flushing does not corrupt the contract (loadContract still parses)", async () => {
      const flusher = new RunResultFlusher();
      const config = createDefaultConfig("test", "brownfield");
      const contract = makeSyntheticContract();
      const spec = makeSyntheticSpec();
      const result = makeSyntheticResult(contract, spec);

      // First flush
      await flusher.flush(tmpDir, config, result);

      // Second flush with the same result
      await flusher.flush(tmpDir, config, result);

      // Contract must still be loadable and valid
      const loaded = await loadContract(tmpDir, contract.contractId);
      expect(loaded.status).toBe("completed");
      expect(loaded.contractId).toBe(contract.contractId);
    });

    it("re-flushing does not change the contract count in .bober/contracts/", async () => {
      const flusher = new RunResultFlusher();
      const config = createDefaultConfig("test", "brownfield");
      const contract = makeSyntheticContract();
      const spec = makeSyntheticSpec();
      const result = makeSyntheticResult(contract, spec);

      await flusher.flush(tmpDir, config, result);
      const countAfterFirst = (await listContracts(tmpDir)).length;

      await flusher.flush(tmpDir, config, result);
      const countAfterSecond = (await listContracts(tmpDir)).length;

      expect(countAfterSecond).toBe(countAfterFirst);
    });
  });

  it("handles multiple sprints with mixed outcomes", async () => {
    const flusher = new RunResultFlusher();
    const config = createDefaultConfig("test", "brownfield");
    const spec = makeSyntheticSpec();
    const contract1 = makeSyntheticContract({ contractId: "sprint-multi-1", sprintNumber: 1 });
    const contract2 = makeSyntheticContract({
      contractId: "sprint-multi-2",
      sprintNumber: 2,
      title: "Add second feature endpoint",
      description:
        "Implement a second REST endpoint that returns structured JSON data, " +
        "including input validation and typed error responses.",
    });

    const result: WorkflowRunResult = {
      spec,
      perSprint: [
        {
          contract: contract1,
          finalVerdict: makeEvalResult(true),
          iterationsUsed: 1,
          outcome: "passed",
          lensVerdicts: [makeEvalResult(true)],
        },
        {
          contract: contract2,
          finalVerdict: makeEvalResult(false),
          iterationsUsed: 3,
          outcome: "failed",
          lensVerdicts: [makeEvalResult(false)],
        },
      ],
      needsClarification: false,
      pendingHistory: [],
    };

    const pipelineResult = await flusher.flush(tmpDir, config, result);

    expect(pipelineResult.success).toBe(false);
    expect(pipelineResult.completedSprints).toHaveLength(1);
    expect(pipelineResult.failedSprints).toHaveLength(1);

    const loaded1 = await loadContract(tmpDir, contract1.contractId);
    expect(loaded1.status).toBe("completed");

    const loaded2 = await loadContract(tmpDir, contract2.contractId);
    expect(loaded2.status).toBe("failed");
  });

  it("resolve absolute path consistency — tmpDir is resolved", () => {
    // Sanity: ensure tmpDir is an absolute path (required by all state helpers)
    expect(tmpDir.startsWith("/")).toBe(true);
    expect(resolve(tmpDir)).toBe(tmpDir);
  });
});

// ── Terminal side effects (PGE sprint 4) ──────────────────────────────
//
// Before this sprint the flusher wrote NEITHER the pipeline-complete history
// event NOR the .completed.json marker, so a workflow-engine run never reached
// src/chat/completion-tailer.ts. These tests pin the repaired behaviour by
// COUNTING writes — an "it exists" assertion would pass just as happily on a
// double emission, which is the other way to break the tailer's dedupe.

describe("RunResultFlusher.flush — terminal side effects", () => {
  /** Count files in .bober/runs/ whose name ends with the marker suffix. */
  async function countMarkers(root: string): Promise<string[]> {
    const entries = await readdir(join(root, ".bober", "runs"));
    return entries.filter((e) => e.endsWith(COMPLETION_MARKER_SUFFIX));
  }

  it("writes exactly ONE completion marker, named <runId>.completed.json", async () => {
    const config = createDefaultConfig("test", "brownfield");
    const contract = makeSyntheticContract();
    const spec = makeSyntheticSpec();

    await new RunResultFlusher().flush(
      tmpDir,
      config,
      makeSyntheticResult(contract, spec),
      { runId: "run-flusher-marker" },
    );

    const markers = await countMarkers(tmpDir);
    expect(markers).toEqual(["run-flusher-marker.completed.json"]);

    const raw = JSON.parse(
      await readFile(completionMarkerPath(tmpDir, "run-flusher-marker"), "utf-8"),
    ) as Record<string, unknown>;
    expect(raw["runId"]).toBe("run-flusher-marker");
    expect(raw["success"]).toBe(true);
    expect(raw["completedSprints"]).toBe(1);
    expect(raw["failedSprints"]).toBe(0);
    expect(typeof raw["completedAt"]).toBe("string");
    expect(typeof raw["duration"]).toBe("number");
  });

  it("emits exactly ONE pipeline-complete line and ONE marker per flush (counted)", async () => {
    const config = createDefaultConfig("test", "brownfield");
    const contract = makeSyntheticContract();
    const spec = makeSyntheticSpec();

    await new RunResultFlusher().flush(
      tmpDir,
      config,
      makeSyntheticResult(contract, spec),
      { runId: "run-once" },
    );

    const history = await loadHistory(tmpDir);
    expect(history.filter((h) => h.event === PIPELINE_COMPLETE_EVENT)).toHaveLength(1);
    expect(await countMarkers(tmpDir)).toHaveLength(1);
  });

  it("two flushes with DISTINCT runIds produce two markers and two terminal lines", async () => {
    const config = createDefaultConfig("test", "brownfield");
    const spec = makeSyntheticSpec();

    await new RunResultFlusher().flush(
      tmpDir,
      config,
      makeSyntheticResult(makeSyntheticContract(), spec),
      { runId: "run-a" },
    );
    await new RunResultFlusher().flush(
      tmpDir,
      config,
      makeSyntheticResult(makeSyntheticContract(), spec),
      { runId: "run-b" },
    );

    expect((await countMarkers(tmpDir)).sort()).toEqual([
      "run-a.completed.json",
      "run-b.completed.json",
    ]);
    const history = await loadHistory(tmpDir);
    expect(history.filter((h) => h.event === PIPELINE_COMPLETE_EVENT)).toHaveLength(2);
  });

  it("phase is 'failed' and success=false when no sprint passed", async () => {
    const config = createDefaultConfig("test", "brownfield");
    const contract = makeSyntheticContract();
    const spec = makeSyntheticSpec();

    const pipelineResult = await new RunResultFlusher().flush(
      tmpDir,
      config,
      {
        spec,
        perSprint: [
          {
            contract,
            finalVerdict: makeEvalResult(false),
            iterationsUsed: 3,
            outcome: "failed",
            lensVerdicts: [makeEvalResult(false)],
          },
        ],
        needsClarification: false,
        pendingHistory: [],
      },
      { runId: "run-failed" },
    );

    expect(pipelineResult.success).toBe(false);

    const history = await loadHistory(tmpDir);
    const terminal = history.filter((h) => h.event === PIPELINE_COMPLETE_EVENT);
    expect(terminal).toHaveLength(1);
    expect(terminal[0]!.phase).toBe("failed");
    expect(terminal[0]!.details["completed"]).toBe(0);
    expect(terminal[0]!.details["failed"]).toBe(1);

    const marker = JSON.parse(
      await readFile(completionMarkerPath(tmpDir, "run-failed"), "utf-8"),
    ) as Record<string, unknown>;
    expect(marker["success"]).toBe(false);
  });

  it("self-generates a run-<timestamp> runId when none is supplied", async () => {
    const config = createDefaultConfig("test", "brownfield");
    await new RunResultFlusher().flush(
      tmpDir,
      config,
      makeSyntheticResult(makeSyntheticContract(), makeSyntheticSpec()),
    );

    const markers = await countMarkers(tmpDir);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatch(/^run-\d+\.completed\.json$/);
  });
});
