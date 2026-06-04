/**
 * Unit tests for ResumeCursorReconstructor.
 *
 * All disk operations use a mkdtemp fixture so tests are isolated and
 * do not pollute the repo or /tmp with .bober/ debris.
 */

import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { ResumeCursorReconstructor } from "./resume-cursor.js";

// ── Fixture ───────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-resume-cursor-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────

async function writeContract(
  dir: string,
  contractId: string,
  specId: string,
  sprintNumber: number,
  status: string,
): Promise<void> {
  const contract = {
    contractId,
    specId,
    sprintNumber,
    title: `Sprint ${sprintNumber} title`,
    description: "Modify the system to accept new parameters and filter entries before use.",
    status,
    dependsOn: [],
    features: ["feat-1"],
    successCriteria: [
      {
        criterionId: "sc-1-1",
        description: "The implementation satisfies all required integration points with zero regressions.",
        verificationMethod: "typecheck",
        required: true,
      },
    ],
    nonGoals: ["Do not refactor unrelated modules or change the public API surface."],
    stopConditions: ["Stop when all success criteria pass and typecheck is green."],
    definitionOfDone: "All success criteria are verified and typecheck exits zero.",
    assumptions: [],
    outOfScope: [],
    iterationHistory: [],
    lastEvalId: null,
    createdAt: "2026-06-04T00:00:00.000Z",
    updatedAt: "2026-06-04T00:00:00.000Z",
  };

  await writeFile(join(dir, `${contractId}.json`), JSON.stringify(contract, null, 2), "utf-8");
}

async function setupContractsDir(projectRoot: string): Promise<string> {
  const dir = join(projectRoot, ".bober", "contracts");
  await mkdir(dir, { recursive: true });
  return dir;
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("ResumeCursorReconstructor", () => {
  describe("reconstruct", () => {
    it("returns completedSprintNumbers containing only passed and completed statuses", async () => {
      const dir = await setupContractsDir(tmpDir);
      const specId = "spec-test-mixed";

      await writeContract(dir, "contract-1", specId, 1, "passed");
      await writeContract(dir, "contract-2", specId, 2, "completed");
      await writeContract(dir, "contract-3", specId, 3, "in-progress");
      await writeContract(dir, "contract-4", specId, 4, "failed");
      await writeContract(dir, "contract-other", "spec-other", 1, "passed");

      const reconstructor = new ResumeCursorReconstructor();
      const cursor = await reconstructor.reconstruct(tmpDir, specId);

      expect(cursor.specId).toBe(specId);
      expect(cursor.completedSprintNumbers).toEqual([1, 2]);
      expect(cursor.lastObservedSprintNumber).toBe(4);
    });

    it("returns completedSprintNumbers:[] and lastObservedSprintNumber:0 when contracts dir is empty", async () => {
      await setupContractsDir(tmpDir);

      const reconstructor = new ResumeCursorReconstructor();
      const cursor = await reconstructor.reconstruct(tmpDir, "spec-empty");

      expect(cursor.specId).toBe("spec-empty");
      expect(cursor.completedSprintNumbers).toEqual([]);
      expect(cursor.lastObservedSprintNumber).toBe(0);
    });

    it("returns completedSprintNumbers:[] when contracts dir does not exist", async () => {
      const reconstructor = new ResumeCursorReconstructor();
      const cursor = await reconstructor.reconstruct(tmpDir, "spec-no-dir");

      expect(cursor.specId).toBe("spec-no-dir");
      expect(cursor.completedSprintNumbers).toEqual([]);
      expect(cursor.lastObservedSprintNumber).toBe(0);
    });

    it("trusts contract status over history on conflict (status wins)", async () => {
      const dir = await setupContractsDir(tmpDir);
      const specId = "spec-conflict";

      // Contract says "in-progress" but we write a history entry claiming it passed
      await writeContract(dir, "contract-conflict-1", specId, 1, "in-progress");

      // Write history that claims sprint 1 is done — contract status should win
      const boberDir = join(tmpDir, ".bober");
      const historyEntry = JSON.stringify({
        timestamp: "2026-06-04T00:00:00.000Z",
        event: "sprint_passed",
        phase: "complete",
        sprintId: "contract-conflict-1",
        details: { status: "passed" },
      });
      await writeFile(join(boberDir, "history.jsonl"), historyEntry + "\n", "utf-8");

      const reconstructor = new ResumeCursorReconstructor();
      const cursor = await reconstructor.reconstruct(tmpDir, specId);

      // Contract says in-progress → should NOT appear in completedSprintNumbers
      expect(cursor.completedSprintNumbers).toEqual([]);
      expect(cursor.lastObservedSprintNumber).toBe(1);
    });

    it("returns completedSprintNumbers sorted ascending", async () => {
      const dir = await setupContractsDir(tmpDir);
      const specId = "spec-sort";

      // Write in reverse order
      await writeContract(dir, "contract-s3", specId, 3, "passed");
      await writeContract(dir, "contract-s1", specId, 1, "passed");
      await writeContract(dir, "contract-s2", specId, 2, "passed");

      const reconstructor = new ResumeCursorReconstructor();
      const cursor = await reconstructor.reconstruct(tmpDir, specId);

      expect(cursor.completedSprintNumbers).toEqual([1, 2, 3]);
      expect(cursor.lastObservedSprintNumber).toBe(3);
    });

    it("filters contracts by specId — does not include contracts from other specs", async () => {
      const dir = await setupContractsDir(tmpDir);

      await writeContract(dir, "contract-mine", "spec-mine", 1, "passed");
      await writeContract(dir, "contract-other", "spec-other", 1, "passed");

      const reconstructor = new ResumeCursorReconstructor();
      const cursor = await reconstructor.reconstruct(tmpDir, "spec-mine");

      expect(cursor.completedSprintNumbers).toEqual([1]);
      expect(cursor.lastObservedSprintNumber).toBe(1);
    });
  });
});
