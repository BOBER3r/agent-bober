/**
 * Tests for persistEvalResult — writes per-evaluator eval detail to
 * .bober/eval-results/ so failing rounds are inspectable.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { persistEvalResult } from "./eval-persist.js";
import type { EvaluationRunResult } from "../evaluators/registry.js";

function evaluation(
  overrides: Partial<EvaluationRunResult> = {},
): EvaluationRunResult {
  return {
    passed: false,
    score: 100,
    summary: "Evaluation complete: 4/5 evaluators passed. Score: 100/100",
    timestamp: "2026-06-08T03:00:00.000Z",
    results: [
      {
        evaluator: "typecheck",
        passed: true,
        score: 100,
        details: [],
        summary: "ok",
        feedback: "no issues",
        timestamp: "2026-06-08T03:00:00.000Z",
      },
      {
        evaluator: "panel",
        passed: false,
        summary: "Panel verdict: 2/4 lenses passed",
        feedback: "two lenses dissented",
        timestamp: "2026-06-08T03:00:00.000Z",
        details: [
          {
            criterion: "e2e",
            passed: false,
            message: "no end-to-end coverage found",
            severity: "error",
          },
        ],
        lensVerdicts: [
          { lens: "correctness", passed: true, summary: "ok" },
          { lens: "completeness", passed: false, summary: "missing e2e" },
        ],
      },
    ],
    ...overrides,
  } as EvaluationRunResult;
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bober-eval-persist-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("persistEvalResult", () => {
  it("writes eval-<contractId>-<iteration>.json under .bober/eval-results", async () => {
    const file = await persistEvalResult(root, "sprint-42", 3, evaluation());
    expect(file).toBeDefined();
    const entries = await readdir(join(root, ".bober", "eval-results"));
    expect(entries).toContain("eval-sprint-42-3.json");
  });

  it("records the failing evaluator and its lens verdicts", async () => {
    const file = await persistEvalResult(root, "sprint-42", 1, evaluation());
    const parsed = JSON.parse(await readFile(file!, "utf-8"));

    expect(parsed.contractId).toBe("sprint-42");
    expect(parsed.iteration).toBe(1);
    expect(parsed.passed).toBe(false);
    expect(parsed.overallResult).toBe("fail");

    const panel = parsed.results.find((r: any) => r.evaluator === "panel");
    expect(panel.passed).toBe(false);
    expect(panel.feedback).toBe("two lenses dissented"); // failing → feedback kept
    expect(panel.lensVerdicts).toHaveLength(2);
    expect(panel.failures).toHaveLength(1);
    expect(panel.failures[0].criterion).toBe("e2e");
  });

  it("omits feedback for passing evaluators (keeps files lean)", async () => {
    const file = await persistEvalResult(root, "sprint-42", 1, evaluation());
    const parsed = JSON.parse(await readFile(file!, "utf-8"));
    const tc = parsed.results.find((r: any) => r.evaluator === "typecheck");
    expect(tc.passed).toBe(true);
    expect(tc.feedback).toBeUndefined();
  });

  it("writes a distinct file per round", async () => {
    await persistEvalResult(root, "sprint-42", 1, evaluation());
    await persistEvalResult(root, "sprint-42", 2, evaluation({ passed: true }));
    const entries = (
      await readdir(join(root, ".bober", "eval-results"))
    ).sort();
    expect(entries).toEqual(["eval-sprint-42-1.json", "eval-sprint-42-2.json"]);
  });

  it("never throws; returns undefined on an unwritable root", async () => {
    // A NUL byte makes the path invalid on every platform → mkdir rejects.
    const result = await persistEvalResult(
      "\0invalid",
      "sprint-x",
      1,
      evaluation(),
    );
    expect(result).toBeUndefined();
  });
});
