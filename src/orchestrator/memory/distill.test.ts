/**
 * Unit tests for src/orchestrator/memory/distill.ts
 *
 * C1 — pure distill returns a deterministic, stable LessonEntry set from a fixed fixture.
 * C2 — distill + appendLesson is idempotent: second run adds zero new INDEX.md lines.
 * C3 — distill constructs no LLM provider client and performs no network call.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { distill } from "./distill.js";
import type { HistoryEntry } from "../../state/history.js";
import type { SprintContract } from "../../contracts/sprint-contract.js";
import { appendLesson } from "../../state/memory.js";

// ── Fixtures ──────────────────────────────────────────────────────────

const BASE_TIMESTAMP = "2026-01-01T00:00:00.000Z";

const historyFixture: HistoryEntry[] = [
  {
    timestamp: BASE_TIMESTAMP,
    event: "sprint_failed",
    phase: "failed",
    sprintId: "sprint-abc-1",
    details: {},
  },
  {
    timestamp: "2026-01-02T00:00:00.000Z",
    event: "sprint_failed",
    phase: "failed",
    sprintId: "sprint-abc-2",
    details: {},
  },
  {
    timestamp: "2026-01-03T00:00:00.000Z",
    event: "eval_failed",
    phase: "evaluating",
    sprintId: "sprint-abc-3",
    details: {
      verificationMethod: "unit-test",
      criterionId: "C1",
      result: "fail",
    },
  },
  {
    timestamp: "2026-01-04T00:00:00.000Z",
    event: "eval_failed",
    phase: "evaluating",
    sprintId: "sprint-abc-4",
    details: {
      verificationMethod: "unit-test",
      criterionId: "C2",
      result: "fail",
    },
  },
];

const contractsFixture: SprintContract[] = [
  {
    contractId: "sprint-churn-1",
    specId: "spec-1",
    sprintNumber: 1,
    title: "High-churn sprint",
    description: "A sprint that needed many iterations",
    status: "failed",
    dependsOn: [],
    features: [],
    successCriteria: [
      {
        criterionId: "C1",
        description: "The feature must satisfy the acceptance test with deterministic output",
        verificationMethod: "unit-test",
        required: true,
      },
    ],
    nonGoals: ["Do not add unrelated features"],
    stopConditions: ["Stop when the feature works as determined by the test suite"],
    definitionOfDone: "All criteria pass and the build is green",
    assumptions: [],
    outOfScope: [],
    iterationHistory: [
      { round: 1 },
      { round: 2 },
      { round: 3 }, // >= ITERATION_THRESHOLD (3)
    ],
    lastEvalId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

// ── C1: Determinism ──────────────────────────────────────────────────

describe("C1 — distill is deterministic (pure function)", () => {
  it("returns the same output on two consecutive calls with the same fixture", () => {
    const a = distill(historyFixture, contractsFixture);
    const b = distill(historyFixture, contractsFixture);

    expect(a).toHaveLength(b.length);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("returns non-empty lessons for non-trivial input", () => {
    const lessons = distill(historyFixture, contractsFixture);
    expect(lessons.length).toBeGreaterThan(0);
  });

  it("every lesson has a non-empty sourceEntryRefs array", () => {
    const lessons = distill(historyFixture, contractsFixture);
    for (const lesson of lessons) {
      expect(lesson.sourceEntryRefs.length).toBeGreaterThan(0);
    }
  });

  it("every lesson has a deterministic lessonId (no Date.now, stable hash)", () => {
    const lessons1 = distill(historyFixture, contractsFixture);
    const lessons2 = distill(historyFixture, contractsFixture);
    for (let i = 0; i < lessons1.length; i++) {
      expect(lessons1[i]!.lessonId).toBe(lessons2[i]!.lessonId);
    }
  });

  it("returns empty array for empty input", () => {
    const lessons = distill([], []);
    expect(lessons).toEqual([]);
  });

  it("output is sorted by lessonId (stable ordering)", () => {
    const lessons = distill(historyFixture, contractsFixture);
    const sorted = [...lessons].sort((a, b) => a.lessonId.localeCompare(b.lessonId));
    expect(JSON.stringify(lessons)).toBe(JSON.stringify(sorted));
  });

  it("flags high-churn contracts (iterationHistory.length >= 3)", () => {
    const lessons = distill([], contractsFixture);
    const churnLesson = lessons.find((l) => l.category === "high-churn-sprint");
    expect(churnLesson).toBeDefined();
    expect(churnLesson!.sourceEntryRefs).toContain("sprint-churn-1:iteration-history");
  });

  it("does not flag contracts with fewer than 3 iterations", () => {
    const shortChurnContracts: SprintContract[] = [
      {
        ...contractsFixture[0]!,
        contractId: "sprint-short-1",
        iterationHistory: [{ round: 1 }, { round: 2 }], // length 2 — below threshold
      },
    ];
    const lessons = distill([], shortChurnContracts);
    const churnLesson = lessons.find((l) => l.category === "high-churn-sprint");
    expect(churnLesson).toBeUndefined();
  });
});

// ── C2: Idempotency ──────────────────────────────────────────────────

describe("C2 — distill + appendLesson is idempotent", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bober-distill-idem-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("second run adds zero new INDEX.md lines", async () => {
    const now = "2026-06-05T12:00:00.000Z";
    const drafts = distill(historyFixture, contractsFixture);

    // First run — persist all lessons
    for (const draft of drafts) {
      await appendLesson(tmpDir, { ...draft, createdAt: now });
    }

    const indexPath = join(tmpDir, ".bober", "memory", "INDEX.md");
    const before = await readFile(indexPath, "utf-8");
    const lineCountBefore = before.split("\n").filter((l) => l.trim().length > 0).length;

    // Second run — same input, same lessonIds (content-hash idempotency)
    const drafts2 = distill(historyFixture, contractsFixture);
    for (const draft of drafts2) {
      await appendLesson(tmpDir, { ...draft, createdAt: now });
    }

    const after = await readFile(indexPath, "utf-8");
    const lineCountAfter = after.split("\n").filter((l) => l.trim().length > 0).length;

    expect(lineCountAfter).toBe(lineCountBefore);
  });
});

// ── C3: No LLM / no network ──────────────────────────────────────────

describe("C3 — distill uses no LLM provider and no network", () => {
  it("distill.ts source does not import from providers", async () => {
    const src = await readFile(
      new URL("./distill.ts", import.meta.url),
      "utf-8",
    );
    // Ensure no import from providers path
    expect(src).not.toMatch(/from ["'].*providers/);
    // Ensure no raw fetch or http/https imports
    expect(src).not.toMatch(/fetch\(/);
    expect(src).not.toMatch(/from ["']node:https?["']/);
  });

  it("distill.ts source does not CALL Date.now() or new Date() (comments allowed)", async () => {
    const src = await readFile(
      new URL("./distill.ts", import.meta.url),
      "utf-8",
    );
    // Strip single-line comments and block comments before checking, so that
    // phrases like "no Date.now()" in documentation don't cause false positives.
    // We check that there is no actual Date.now() or new Date() CALL in the code lines.
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

    distill(historyFixture, contractsFixture);

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
