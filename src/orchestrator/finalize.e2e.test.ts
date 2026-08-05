// ── finalize.e2e.test.ts ─────────────────────────────────────────────
//
// sc-4-5: the two engine paths must be indistinguishable to the consumers of a
// run's terminal side-effect set.
//
//   1. Drive a REAL run through TsPipelineEngine (agents mocked, filesystem
//      real) and assert CompletionTailer.poll() yields the runId — the exact
//      predicate src/chat/completion-tailer.ts uses, asserted rather than
//      assumed. ChatSession.handleTurn() calls poll() once per turn, so a
//      completion the tailer cannot see is a run that never appears to finish.
//   2. Drive RunResultFlusher.flush and assert the emitted history line and the
//      emitted marker are BYTE-IDENTICAL to the TS engine's, modulo the three
//      unavoidably volatile values (timestamp, runId, elapsed ms).
//
// Only the agent boundary is mocked. Every .bober/ write here is a real write.

import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import type { PlanSpec } from "../contracts/spec.js";
import type { SprintContract } from "../contracts/sprint-contract.js";
import type { EvalResult } from "../contracts/eval-result.js";
import type { BoberConfig } from "../config/schema.js";
import type { WorkflowRunResult } from "./workflow/types.js";

// ── Agent-boundary mocks (nothing below the agents is faked) ──────────

vi.mock("../graph/pipeline-lifecycle.js", () => ({
  graphPipelineLifecycle: {
    engineHealth: vi.fn().mockReturnValue("disabled"),
    getGraphClient: vi.fn().mockReturnValue(null),
    getGraphDeps: vi.fn().mockReturnValue(null),
  },
}));

vi.mock("../utils/git.js", () => ({
  commitAll: vi.fn().mockResolvedValue("abc1234"),
  getCurrentBranch: vi.fn().mockResolvedValue("bober/test"),
  getChangedFiles: vi.fn().mockResolvedValue(["src/orchestrator/finalize.ts"]),
}));

vi.mock("./planner-agent.js", () => ({
  runPlanner: vi.fn(),
}));

vi.mock("./contract-materialization.js", () => ({
  materializeContracts: vi.fn(),
}));

vi.mock("./generator-agent.js", () => ({
  runGenerator: vi.fn().mockResolvedValue({
    success: true,
    notes: "Implemented the extraction.",
    filesChanged: ["src/orchestrator/finalize.ts"],
    turnsUsed: 2,
    toolsCalled: [],
  }),
}));

vi.mock("./evaluator-agent.js", () => ({
  runEvaluatorAgent: vi.fn(),
}));

import { TsPipelineEngine } from "./workflow/ts-engine.js";
import { RunResultFlusher } from "./workflow/flusher.js";
import { runPlanner } from "./planner-agent.js";
import { materializeContracts } from "./contract-materialization.js";
import { runEvaluatorAgent } from "./evaluator-agent.js";
import { CompletionTailer } from "../chat/completion-tailer.js";
import { COMPLETION_MARKER_SUFFIX, PIPELINE_COMPLETE_EVENT } from "./finalize.js";
import { createDefaultConfig } from "../config/schema.js";

// ── Fixtures ─────────────────────────────────────────────────────────

const ISO = "2026-08-05T00:00:00.000Z";

function makeSpec(): PlanSpec {
  return {
    specId: "spec-e2e-1",
    version: 1,
    title: "Single terminal side-effect owner",
    description:
      "Extract the terminal block so the TS engine and the flusher emit one set.",
    status: "in-progress",
    mode: "brownfield",
    features: [
      {
        featureId: "feat-3",
        title: "finalizePipelineRun",
        description: "One emitter for the completion event and the marker.",
        priority: "must-have",
        acceptanceCriteria: [
          "The tailer resolves the runId",
          "Exactly one marker per run",
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
    createdAt: ISO,
    updatedAt: ISO,
  };
}

/** Precision-clean contract that passes saveContract's quality gate. */
function makeContract(overrides: Partial<SprintContract> = {}): SprintContract {
  return {
    contractId: "e2e-sprint-1",
    specId: "spec-e2e-1",
    sprintNumber: 1,
    title: "Extract the terminal side-effect block",
    description:
      "Move the pipeline-complete history event, the end-of-pipeline checkpoint " +
      "and the completion marker out of runTsPipeline into a shared finalize " +
      "module that the workflow flusher also calls.",
    status: "proposed",
    dependsOn: [],
    features: ["feat-3"],
    successCriteria: [
      {
        criterionId: "sc-4-5",
        description:
          "CompletionTailer.poll() returns the runId after a TsPipelineEngine run.",
        verificationMethod: "unit-test",
        required: true,
      },
    ],
    nonGoals: [
      "Do not implement PgeEngine in this sprint.",
      "Do not change the observable stage sequence of a run.",
    ],
    stopConditions: [
      "Stop when the terminal set has exactly one emitter.",
      "Stop when the tailer matches an imported constant, not a literal.",
    ],
    definitionOfDone:
      "Both engine paths emit an identical pipeline-complete event and marker.",
    assumptions: ["The flusher emitting neither artifact was a latent defect."],
    outOfScope: ["Graph, topology and superstep concepts."],
    ambiguityScore: 2,
    estimatedFiles: ["src/orchestrator/finalize.ts"],
    estimatedDuration: "medium",
    iterationHistory: [],
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

function passingEvaluation(): {
  passed: boolean;
  summary: string;
  results: Array<{
    evaluator: string;
    passed: boolean;
    summary: string;
    details: never[];
    feedback: string;
  }>;
} {
  return {
    passed: true,
    summary: "All evaluators passed.",
    results: [
      {
        evaluator: "typecheck",
        passed: true,
        summary: "0 errors",
        details: [],
        feedback: "",
      },
    ],
  };
}

function makeEvalResult(passed: boolean): EvalResult {
  return {
    evaluator: "panel",
    passed,
    score: passed ? 100 : 0,
    details: [],
    summary: passed ? "Panel verdict: 1/1 lenses passed" : "Panel verdict: failed",
    feedback: passed ? "All lenses passed." : "One or more lenses failed.",
    timestamp: "",
  };
}

/** Config with every optional agent stage off so only the terminal block runs. */
function makeConfig(): BoberConfig {
  const base = createDefaultConfig("test", "brownfield");
  return {
    ...base,
    curator: { ...base.curator, enabled: false },
    codeReview: { enabled: false },
    documenter: { enabled: false },
    pipeline: { ...base.pipeline, researchPhase: false, architectPhase: false },
    generator: { ...base.generator, autoCommit: false },
  } as BoberConfig;
}

// ── Normalisation for the byte-equality comparison ───────────────────

/**
 * Blank out ONLY the three values that cannot be equal across two runs:
 * the ISO timestamp, the runId, and the elapsed-milliseconds figures.
 * Everything else — key names, key ORDER, punctuation, indentation — must
 * survive untouched, so this is a byte comparison of the emitted text.
 */
function normalise(raw: string): string {
  return raw
    .replace(/"timestamp":"[^"]*"/g, '"timestamp":"<ISO>"')
    .replace(/"completedAt": "[^"]*"/g, '"completedAt": "<ISO>"')
    .replace(/"runId": "[^"]*"/g, '"runId": "<RUNID>"')
    .replace(/"durationMs":\d+/g, '"durationMs":<MS>')
    .replace(/"duration": \d+/g, '"duration": <MS>');
}

async function terminalHistoryLine(root: string): Promise<string> {
  const raw = await readFile(join(root, ".bober", "history.jsonl"), "utf-8");
  const lines = raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .filter((l) => (JSON.parse(l) as { event: string }).event === PIPELINE_COMPLETE_EVENT);
  expect(lines).toHaveLength(1);
  return lines[0]!;
}

async function markerFiles(root: string): Promise<string[]> {
  const entries = await readdir(join(root, ".bober", "runs"));
  return entries.filter((e) => e.endsWith(COMPLETION_MARKER_SUFFIX)).sort();
}

// ── Test roots ───────────────────────────────────────────────────────

let tsRoot = "";
let flushRoot = "";

beforeEach(async () => {
  tsRoot = await mkdtemp(join(tmpdir(), "bober-final-ts-"));
  flushRoot = await mkdtemp(join(tmpdir(), "bober-final-fl-"));
  vi.mocked(runPlanner).mockResolvedValue({
    kind: "ready",
    spec: makeSpec(),
  } as unknown as Awaited<ReturnType<typeof runPlanner>>);
  vi.mocked(materializeContracts).mockResolvedValue([makeContract()]);
  vi.mocked(runEvaluatorAgent).mockResolvedValue(
    passingEvaluation() as unknown as Awaited<ReturnType<typeof runEvaluatorAgent>>,
  );
});

afterEach(async () => {
  await rm(tsRoot, { recursive: true, force: true });
  await rm(flushRoot, { recursive: true, force: true });
});

// ── sc-4-5 (a): TS engine → CompletionTailer terminates with the runId ──

describe("TsPipelineEngine end-to-end → CompletionTailer", () => {
  it("emits a terminal set the tailer resolves to the run's own runId", async () => {
    const result = await new TsPipelineEngine().run(
      "extract the terminal block",
      tsRoot,
      makeConfig(),
      { runId: "run-e2e-ts" },
    );

    expect(result.success).toBe(true);
    expect(result.completedSprints).toHaveLength(1);

    // Exactly one of each artifact — counted, not merely present.
    expect(await markerFiles(tsRoot)).toEqual(["run-e2e-ts.completed.json"]);
    const history = (await readFile(join(tsRoot, ".bober", "history.jsonl"), "utf-8"))
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { event: string });
    expect(history.filter((h) => h.event === PIPELINE_COMPLETE_EVENT)).toHaveLength(1);

    // The consumer's real predicate, run against the real emission, with an
    // explicit deadline so a hang is a failure rather than a timeout mystery.
    const events = await Promise.race([
      new CompletionTailer(tsRoot, "session-e2e").poll(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("CompletionTailer.poll() did not settle")), 5000),
      ),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]!.runId).toBe("run-e2e-ts");
    expect(events[0]!.phase).toBe("complete");
    expect(events[0]!.completed).toBe(1);
    expect(events[0]!.failed).toBe(0);
    expect(typeof events[0]!.durationMs).toBe("number");
  });

  it("a second poll returns nothing — the completion is not re-delivered", async () => {
    await new TsPipelineEngine().run("extract the terminal block", tsRoot, makeConfig(), {
      runId: "run-e2e-dedupe",
    });

    const tailer = new CompletionTailer(tsRoot, "session-dedupe");
    expect(await tailer.poll()).toHaveLength(1);
    expect(await tailer.poll()).toEqual([]);
  });

  it("still resolves a marker written in the pre-sprint filename shape", async () => {
    // Hand-written with literals — deliberately NOT using the new constants —
    // so this reproduces an on-disk artifact from a run started before the
    // extraction landed.
    const runsDir = join(tsRoot, ".bober", "runs");
    await mkdir(join(tsRoot, ".bober"), { recursive: true });
    await mkdir(runsDir, { recursive: true });
    await writeFile(
      join(runsDir, "run-legacy-1970.completed.json"),
      JSON.stringify(
        {
          runId: "run-legacy-1970",
          completedAt: "2026-01-01T00:00:00.000Z",
          success: true,
          completedSprints: 2,
          failedSprints: 0,
          duration: 4242,
        },
        null,
        2,
      ) + "\n",
      "utf-8",
    );
    await writeFile(
      join(tsRoot, ".bober", "history.jsonl"),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00.000Z",
        event: "pipeline-complete",
        phase: "complete",
        details: { completed: 2, failed: 0, durationMs: 4242 },
      }) + "\n",
      "utf-8",
    );

    const events = await new CompletionTailer(tsRoot, "session-legacy").poll();
    expect(events).toHaveLength(1);
    expect(events[0]!.runId).toBe("run-legacy-1970");
    expect(events[0]!.durationMs).toBe(4242);
  });
});

// ── sc-4-5 (b): the two engine paths emit byte-identical artifacts ────

describe("TsPipelineEngine vs RunResultFlusher — identical terminal artifacts", () => {
  it("emits byte-identical history lines and byte-identical markers", async () => {
    const config = makeConfig();

    await new TsPipelineEngine().run("extract the terminal block", tsRoot, config, {
      runId: "run-cmp-ts",
    });

    // The flusher path: one passed sprint, so the derived facts match the TS
    // run exactly (1 completed, 0 failed) and the emissions must too.
    const flushResult: WorkflowRunResult = {
      spec: makeSpec(),
      perSprint: [
        {
          contract: makeContract(),
          finalVerdict: makeEvalResult(true),
          iterationsUsed: 1,
          outcome: "passed",
          lensVerdicts: [makeEvalResult(true)],
        },
      ],
      needsClarification: false,
      pendingHistory: [],
    };
    await new RunResultFlusher().flush(flushRoot, config, flushResult, {
      runId: "run-cmp-flush",
    });

    // History line — compared as raw JSONL text, so key ORDER is part of the
    // assertion, not just the key set.
    const tsLine = normalise(await terminalHistoryLine(tsRoot));
    const flushLine = normalise(await terminalHistoryLine(flushRoot));
    expect(flushLine).toBe(tsLine);
    expect(tsLine).toBe(
      '{"timestamp":"<ISO>","event":"pipeline-complete","phase":"complete","details":{"completed":1,"failed":0,"durationMs":<MS>}}',
    );

    // Marker — compared as raw file text (JSON.stringify(_, null, 2) + "\n").
    const tsMarker = normalise(
      await readFile(join(tsRoot, ".bober", "runs", "run-cmp-ts.completed.json"), "utf-8"),
    );
    const flushMarker = normalise(
      await readFile(
        join(flushRoot, ".bober", "runs", "run-cmp-flush.completed.json"),
        "utf-8",
      ),
    );
    expect(flushMarker).toBe(tsMarker);
    // Pinned as literal text: two-space indentation, key order, and the
    // trailing newline are all part of what a consumer reads off disk.
    expect(tsMarker).toBe(
      [
        "{",
        '  "runId": "<RUNID>",',
        '  "completedAt": "<ISO>",',
        '  "success": true,',
        '  "completedSprints": 1,',
        '  "failedSprints": 0,',
        '  "duration": <MS>',
        "}",
        "",
      ].join("\n"),
    );
  });

  it("the flusher's emission is resolvable by CompletionTailer too", async () => {
    await new RunResultFlusher().flush(
      flushRoot,
      makeConfig(),
      {
        spec: makeSpec(),
        perSprint: [
          {
            contract: makeContract(),
            finalVerdict: makeEvalResult(true),
            iterationsUsed: 1,
            outcome: "passed",
            lensVerdicts: [makeEvalResult(true)],
          },
        ],
        needsClarification: false,
        pendingHistory: [],
      },
      { runId: "run-flush-tailed" },
    );

    const events = await new CompletionTailer(flushRoot, "session-flush").poll();
    expect(events).toHaveLength(1);
    expect(events[0]!.runId).toBe("run-flush-tailed");
    expect(events[0]!.phase).toBe("complete");
  });
});
