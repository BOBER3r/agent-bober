/**
 * Unit tests for src/orchestrator/memory/distill.ts
 *
 * These fixtures use the REAL data shapes the pipeline produces — NOT an invented
 * vocabulary. A dedicated drift-guard test asserts that the OLD invented shapes
 * (phase:"failed", event:"eval_failed", iterationHistory:[{round}]) now yield ZERO
 * lessons, so distill can never silently regress to matching fantasy data again.
 *
 * Signals under test:
 *   (a) failed-criterion categories — eval criteriaResults[].result==="fail", grouped by verificationMethod
 *   (b) failing eval strategies     — eval strategyResults[].result==="fail", grouped by strategy
 *   (c) sprint rework               — contract.iterationHistory[].result==="fail" (+ history rework fallback)
 *   (d) fail→pass contrast          — contract.iterationHistory with fail(s) followed by a pass
 *   determinism, idempotency, and purity (no LLM / no clock).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { distill, type DistillableEval } from "./distill.js";
import type { HistoryEntry } from "../../state/history.js";
import type { SprintContract } from "../../contracts/sprint-contract.js";
import { appendLesson } from "../../state/memory.js";

// ── Fixtures (REAL shapes) ────────────────────────────────────────────

const TS = "2026-01-01T00:00:00.000Z";

/** Build a SprintContract with the real iterationHistory shape. */
function contract(
  contractId: string,
  iterationHistory: unknown[],
): SprintContract {
  return {
    contractId,
    specId: "spec-real",
    sprintNumber: 1,
    title: "Real sprint",
    description: "A sprint that exercises the real distill data shapes",
    status: "completed",
    dependsOn: [],
    features: [],
    successCriteria: [
      {
        criterionId: "C1",
        description: "The acceptance test passes deterministically against the suite",
        verificationMethod: "unit-test",
        required: true,
      },
      {
        criterionId: "C2",
        description: "The project build compiles cleanly with no type errors",
        verificationMethod: "build",
        required: true,
      },
    ],
    nonGoals: ["Do not add unrelated features"],
    stopConditions: ["Stop when the suite is green and the build compiles"],
    definitionOfDone: "All criteria pass and the build is green",
    assumptions: [],
    outOfScope: [],
    iterationHistory,
    lastEvalId: null,
    createdAt: TS,
    updatedAt: TS,
  } as SprintContract;
}

// sprint-real-1: needed rework (iteration 1 failed, iteration 2 passed).
const contractsFixture: SprintContract[] = [
  contract("sprint-real-1", [
    { iteration: 1, evalId: "eval-sprint-real-1-1", result: "fail", timestamp: TS },
    { iteration: 2, evalId: "eval-sprint-real-1-2", result: "pass", timestamp: TS },
  ]),
];

// Eval results in the on-disk shape: the failing iteration recorded a failed
// unit-test strategy and a failed C1 criterion (C1's verificationMethod === "unit-test").
const evalResultsFixture: DistillableEval[] = [
  {
    evalId: "eval-sprint-real-1-1",
    contractId: "sprint-real-1",
    iteration: 1,
    overallResult: "fail",
    strategyResults: [
      { strategy: "unit-test", result: "fail" },
      { strategy: "build", result: "pass" },
    ],
    criteriaResults: [
      { criterionId: "C1", result: "fail" },
      { criterionId: "C2", result: "pass" },
    ],
  },
];

// History carries a rework event for a DIFFERENT sprint that has no contract
// iterationHistory — exercises the history fallback in signal (c).
const historyFixture: HistoryEntry[] = [
  {
    timestamp: TS,
    event: "evaluation-failed",
    phase: "rework",
    sprintId: "sprint-real-2",
    details: { iteration: 1, feedback: "criterion C3 failed" },
  },
  {
    timestamp: "2026-01-02T00:00:00.000Z",
    event: "sprint-passed",
    phase: "complete",
    sprintId: "sprint-real-2",
    details: {},
  },
];

function categories(lessons: { category: string }[]): string[] {
  return lessons.map((l) => l.category).sort();
}

// ── Real-vocabulary extraction ────────────────────────────────────────

describe("distill extracts lessons from the real pipeline data shapes", () => {
  it("produces exactly the five expected lessons from the fixture", () => {
    const lessons = distill(historyFixture, contractsFixture, evalResultsFixture);
    expect(lessons).toHaveLength(5);
    expect(categories(lessons)).toEqual([
      "eval-strategy-failure:unit-test",
      "failed-criterion:unit-test",
      "fix-contrast:sprint-real-1",
      "sprint-rework",
      "sprint-rework",
    ]);
  });

  it("(b) groups a failing eval strategy by strategy name", () => {
    const lessons = distill([], [], evalResultsFixture);
    const strat = lessons.find((l) => l.category === "eval-strategy-failure:unit-test");
    expect(strat).toBeDefined();
    expect(strat!.tags).toContain("strategy:unit-test");
    expect(strat!.sourceEntryRefs).toContain("eval-sprint-real-1-1");
  });

  it("(a) groups a failed criterion by its verificationMethod resolved from the contract", () => {
    const lessons = distill([], contractsFixture, evalResultsFixture);
    const crit = lessons.find((l) => l.category === "failed-criterion:unit-test");
    expect(crit).toBeDefined();
    expect(crit!.tags).toContain("verificationMethod:unit-test");
    expect(crit!.sourceEntryRefs).toContain("eval-sprint-real-1-1:C1");
  });

  it("(c) flags a sprint that needed rework from its iterationHistory", () => {
    const lessons = distill([], contractsFixture, []);
    const rework = lessons.find((l) => l.category === "sprint-rework");
    expect(rework).toBeDefined();
    expect(rework!.tags).toContain("sprintId:sprint-real-1");
    expect(rework!.sourceEntryRefs).toContain("sprint-real-1:iteration-1");
  });

  it("(c, fallback) flags rework from a history evaluation-failed/rework event", () => {
    const lessons = distill(historyFixture, [], []);
    const rework = lessons.find(
      (l) => l.category === "sprint-rework" && l.tags.includes("sprintId:sprint-real-2"),
    );
    expect(rework).toBeDefined();
  });

  it("(c) does not double-count a sprint present in both iterationHistory and history rework events", () => {
    const dualHistory: HistoryEntry[] = [
      {
        timestamp: TS,
        event: "evaluation-failed",
        phase: "rework",
        sprintId: "sprint-real-1", // SAME sprint as the contract's iterationHistory
        details: { iteration: 1 },
      },
    ];
    const lessons = distill(dualHistory, contractsFixture, []);
    const reworkForReal1 = lessons.filter(
      (l) => l.category === "sprint-rework" && l.tags.includes("sprintId:sprint-real-1"),
    );
    expect(reworkForReal1).toHaveLength(1);
    // Counted once (from iterationHistory), not twice.
    expect(reworkForReal1[0]!.occurrences).toBe(1);
  });
});

// ── Signal (d): fail→pass contrast ───────────────────────────────────

describe("distill signal (d): fail→pass contrast extractor", () => {
  it("(d) emits a fix-contrast lesson for a fail→fail→pass transition", () => {
    const c = [
      contract("flip-1", [
        { iteration: 1, evalId: "e1", result: "fail", timestamp: TS },
        { iteration: 2, evalId: "e2", result: "fail", timestamp: TS },
        { iteration: 3, evalId: "e3", result: "pass", timestamp: TS },
      ]),
    ];
    const lessons = distill([], c, []);
    const fix = lessons.filter((l) => l.category.startsWith("fix-contrast:"));
    expect(fix).toHaveLength(1);
    expect(fix[0]!.category).toBe("fix-contrast:flip-1");
    expect(fix[0]!.tags).toContain("phase:fix-contrast");
    expect(fix[0]!.tags).toContain("sprintId:flip-1");
    expect(fix[0]!.sourceEntryRefs).toContain("flip-1:iteration-1");
    expect(fix[0]!.sourceEntryRefs).toContain("flip-1:iteration-2");
    expect(fix[0]!.sourceEntryRefs).toContain("flip-1:iteration-3"); // the pass
  });

  it("(d) does not emit fix-contrast when the sprint passed on its first iteration", () => {
    const c = [
      contract("clean-1", [
        { iteration: 1, evalId: "e1", result: "pass", timestamp: TS },
      ]),
    ];
    const lessons = distill([], c, []);
    expect(lessons.filter((l) => l.category.startsWith("fix-contrast:"))).toHaveLength(0);
  });

  it("(d) does not emit fix-contrast when the sprint never passed", () => {
    const c = [
      contract("stuck-1", [
        { iteration: 1, evalId: "e1", result: "fail", timestamp: TS },
        { iteration: 2, evalId: "e2", result: "fail", timestamp: TS },
      ]),
    ];
    const lessons = distill([], c, []);
    expect(lessons.filter((l) => l.category.startsWith("fix-contrast:"))).toHaveLength(0);
  });

  it("(d) does not emit fix-contrast when pass precedes fail with no later pass", () => {
    const c = [
      contract("reverse-1", [
        { iteration: 1, evalId: "e1", result: "pass", timestamp: TS },
        { iteration: 2, evalId: "e2", result: "fail", timestamp: TS },
      ]),
    ];
    const lessons = distill([], c, []);
    expect(lessons.filter((l) => l.category.startsWith("fix-contrast:"))).toHaveLength(0);
  });
});

// ── Drift guard: the OLD invented vocabulary must yield ZERO lessons ──

describe("drift guard — invented vocabulary produces no lessons", () => {
  const inventedHistory: HistoryEntry[] = [
    { timestamp: TS, event: "sprint_failed", phase: "failed", sprintId: "x-1", details: {} },
    {
      timestamp: TS,
      event: "eval_failed",
      phase: "evaluating",
      sprintId: "x-2",
      details: { verificationMethod: "unit-test", criterionId: "C1", result: "fail" },
    },
  ];
  const inventedContracts: SprintContract[] = [
    contract("x-churn", [{ round: 1 }, { round: 2 }, { round: 3 }]),
  ];

  it("does not match phase:'failed' / event:'eval_failed' / details.result:'fail'", () => {
    const lessons = distill(inventedHistory, [], []);
    expect(lessons).toEqual([]);
  });

  it("does not flag iterationHistory entries that lack a real result:'fail' field", () => {
    const lessons = distill([], inventedContracts, []);
    expect(lessons).toEqual([]);
  });
});

// ── Determinism ───────────────────────────────────────────────────────

describe("distill is deterministic (pure function)", () => {
  it("returns byte-identical output on two consecutive calls", () => {
    const a = distill(historyFixture, contractsFixture, evalResultsFixture);
    const b = distill(historyFixture, contractsFixture, evalResultsFixture);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("output is sorted by lessonId", () => {
    const lessons = distill(historyFixture, contractsFixture, evalResultsFixture);
    const sorted = [...lessons].sort((a, b) => a.lessonId.localeCompare(b.lessonId));
    expect(JSON.stringify(lessons)).toBe(JSON.stringify(sorted));
  });

  it("every lesson has a non-empty sourceEntryRefs array", () => {
    const lessons = distill(historyFixture, contractsFixture, evalResultsFixture);
    for (const lesson of lessons) {
      expect(lesson.sourceEntryRefs.length).toBeGreaterThan(0);
    }
  });

  it("returns an empty array for empty input", () => {
    expect(distill([], [], [])).toEqual([]);
  });

  it("evalResults defaults to [] when omitted (backward-compatible 2-arg call)", () => {
    const lessons = distill(historyFixture, contractsFixture);
    // Signals (c) and (d) fire without eval results: rework for real-1 + real-2, plus fix-contrast for real-1.
    expect(categories(lessons)).toEqual([
      "fix-contrast:sprint-real-1",
      "sprint-rework",
      "sprint-rework",
    ]);
  });
});

// ── Idempotency ───────────────────────────────────────────────────────

describe("distill + appendLesson is idempotent", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bober-distill-idem-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("second run adds zero new INDEX.md lines", async () => {
    const now = "2026-06-05T12:00:00.000Z";
    const drafts = distill(historyFixture, contractsFixture, evalResultsFixture);
    for (const draft of drafts) {
      await appendLesson(tmpDir, { ...draft, createdAt: now });
    }

    const indexPath = join(tmpDir, ".bober", "memory", "INDEX.md");
    const before = await readFile(indexPath, "utf-8");
    const lineCountBefore = before.split("\n").filter((l) => l.trim().length > 0).length;

    const drafts2 = distill(historyFixture, contractsFixture, evalResultsFixture);
    for (const draft of drafts2) {
      await appendLesson(tmpDir, { ...draft, createdAt: now });
    }

    const after = await readFile(indexPath, "utf-8");
    const lineCountAfter = after.split("\n").filter((l) => l.trim().length > 0).length;
    expect(lineCountAfter).toBe(lineCountBefore);
  });
});

// ── No LLM / no network / no clock ────────────────────────────────────

describe("distill uses no LLM provider, no network, and no clock", () => {
  it("distill.ts source does not import from providers and makes no fetch/http call", async () => {
    const src = await readFile(new URL("./distill.ts", import.meta.url), "utf-8");
    expect(src).not.toMatch(/from ["'].*providers/);
    expect(src).not.toMatch(/fetch\(/);
    expect(src).not.toMatch(/from ["']node:https?["']/);
  });

  it("distill.ts source does not CALL Date.now() or new Date() (comments allowed)", async () => {
    const src = await readFile(new URL("./distill.ts", import.meta.url), "utf-8");
    const noComments = src
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
      .join("\n");
    expect(noComments).not.toMatch(/Date\.now\(\)/);
    expect(noComments).not.toMatch(/new Date\(\)/);
  });

  it("calling distill() does not invoke createClient from providers/factory", async () => {
    const factory = await import("../../providers/factory.js");
    const spy = vi.spyOn(factory, "createClient");
    distill(historyFixture, contractsFixture, evalResultsFixture);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
