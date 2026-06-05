/**
 * Unit tests for src/orchestrator/memory/eval-source.ts (loadEvalResults).
 *
 * Verifies the lenient loader: missing dir -> [], real on-disk shape projected
 * onto DistillableEval, malformed files skipped, deterministic filename order.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadEvalResults } from "./eval-source.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-eval-source-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function writeEval(name: string, body: unknown): Promise<void> {
  const dir = join(tmpDir, ".bober", "eval-results");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), JSON.stringify(body), "utf-8");
}

describe("loadEvalResults", () => {
  it("returns [] when the eval-results directory does not exist", async () => {
    const results = await loadEvalResults(tmpDir);
    expect(results).toEqual([]);
  });

  it("projects the real on-disk eval shape onto DistillableEval", async () => {
    await writeEval("eval-a-1.json", {
      evalId: "eval-a-1",
      contractId: "sprint-a",
      iteration: 1,
      overallResult: "fail",
      // extraneous fields the loader should ignore:
      summary: "two criteria failed",
      score: { criteriaPassed: 0 },
      strategyResults: [
        { strategy: "unit-test", required: true, result: "fail", output: "..." },
        { strategy: "build", required: true, result: "pass" },
      ],
      criteriaResults: [
        { criterionId: "C1", required: true, result: "fail", evidence: "x" },
      ],
    });

    const results = await loadEvalResults(tmpDir);
    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.evalId).toBe("eval-a-1");
    expect(r.contractId).toBe("sprint-a");
    expect(r.overallResult).toBe("fail");
    expect(r.strategyResults).toEqual([
      { strategy: "unit-test", result: "fail" },
      { strategy: "build", result: "pass" },
    ]);
    expect(r.criteriaResults).toEqual([
      { criterionId: "C1", result: "fail", verificationMethod: undefined },
    ]);
  });

  it("skips malformed JSON files but loads the valid ones", async () => {
    await writeEval("eval-good.json", { evalId: "eval-good", overallResult: "pass" });
    const dir = join(tmpDir, ".bober", "eval-results");
    await writeFile(join(dir, "eval-bad.json"), "{ not valid json", "utf-8");

    const results = await loadEvalResults(tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0]!.evalId).toBe("eval-good");
  });

  it("returns results in deterministic filename order", async () => {
    await writeEval("eval-c.json", { evalId: "c" });
    await writeEval("eval-a.json", { evalId: "a" });
    await writeEval("eval-b.json", { evalId: "b" });

    const results = await loadEvalResults(tmpDir);
    expect(results.map((r) => r.evalId)).toEqual(["a", "b", "c"]);
  });
});
