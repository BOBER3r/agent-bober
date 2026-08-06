import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { canonicalJson } from "../registry/reducers.js";
import {
  FAILURE_ARTIFACT_FORMAT_VERSION,
  FailureArtifactSchema,
  canonicaliseFailureArtifact,
  failureArtifactPath,
  failuresRoot,
  readFailureArtifact,
  synthesizeBranchOutcomes,
  writeFailureArtifact,
} from "./graceful-failure.js";
import type { FailureArtifact } from "./graceful-failure.js";
import { UnsafePathSegmentError } from "./scratch.js";

/**
 * sc-9-3 (the failure artifact) and sc-9-6 (the qualified synthesis), at the level of the
 * module the graceful-failure NODE BODY calls.
 *
 * Real temp directories and real writes throughout: `.bober/failures/` is inside the
 * byte-comparison surface `readArtifactTree` walks, so "the artifact is deterministic" has
 * to be a claim about bytes on disk rather than about a return value.
 *
 * ── Mutation-proven ──
 *
 * Run against three deliberate breakages, and failed on each:
 *  - `canonicaliseFailureArtifact` returning its input unsorted, which lets the branch
 *    order follow the order the branches happened to reject in;
 *  - `JSON.stringify` in place of `canonicalJson`, which makes two logically identical
 *    artifacts differ in bytes;
 *  - `synthesizeBranchOutcomes` filtering its enumeration to the successful branches,
 *    which is exactly the disappearance sc-9-6 exists to prevent.
 */

const RUN_ID = "run-graceful-1";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bober-pge-graceful-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function artifact(overrides: Partial<FailureArtifact> = {}): FailureArtifact {
  return FailureArtifactSchema.parse({
    formatVersion: FAILURE_ARTIFACT_FORMAT_VERSION,
    runId: RUN_ID,
    reason: "RetriesExhausted",
    supersteps: 7,
    createdAt: "2026-08-05T00:00:00.000Z",
    branches: [
      {
        branchKey: "sprint-golden-2",
        contractId: "sprint-golden-2",
        nodeId: "sprint_generate",
        attempts: 3,
        errorClass: "TransientProviderError",
        message: "golden fixture: branch sprint-golden-2 hit an overloaded provider",
      },
    ],
    ...overrides,
  });
}

describe("the failure artifact lands at .bober/failures/<runId>.json (sc-9-3)", () => {
  it("writes exactly that path and round-trips through its own schema", async () => {
    const path = await writeFailureArtifact(root, artifact());
    expect(path).toBe(join(root, ".bober", "failures", `${RUN_ID}.json`));
    expect(failuresRoot(root)).toBe(join(root, ".bober", "failures"));
    expect(failureArtifactPath(root, RUN_ID)).toBe(path);

    const raw = await readFile(path, "utf8");
    const parsed = FailureArtifactSchema.parse(JSON.parse(raw) as unknown);
    expect(parsed.runId).toBe(RUN_ID);
    expect(parsed.reason).toBe("RetriesExhausted");
    expect(parsed.branches).toHaveLength(1);
    expect(parsed.branches[0].attempts).toBe(3);
    expect(parsed.branches[0].errorClass).toBe("TransientProviderError");

    const readBack = await readFailureArtifact(root, RUN_ID);
    expect(readBack).toEqual(parsed);
  });

  it("sorts branches by branch key, whatever order they were handed in", async () => {
    const keys = ["sprint-golden-9", "sprint-golden-1", "sprint-golden-4"];
    await writeFailureArtifact(
      root,
      artifact({
        branches: keys.map((branchKey) => ({
          branchKey,
          nodeId: "sprint_generate",
          attempts: 3,
          errorClass: "TransientProviderError",
          message: `branch ${branchKey}`,
        })),
      }),
    );
    const parsed = await readFailureArtifact(root, RUN_ID);
    expect(parsed?.branches.map((b) => b.branchKey)).toEqual([
      "sprint-golden-1",
      "sprint-golden-4",
      "sprint-golden-9",
    ]);
  });

  it("produces identical BYTES for the same content presented in a different order", async () => {
    const forward = artifact({
      branches: [
        { branchKey: "b-1", nodeId: "n", attempts: 1, errorClass: "E", message: "one" },
        { branchKey: "b-2", nodeId: "n", attempts: 2, errorClass: "E", message: "two" },
      ],
    });
    const reversed = artifact({ branches: [...forward.branches].reverse() });

    await writeFailureArtifact(root, forward);
    const first = await readFile(failureArtifactPath(root, RUN_ID), "utf8");
    await writeFailureArtifact(root, reversed);
    const second = await readFile(failureArtifactPath(root, RUN_ID), "utf8");

    expect(second).toBe(first);
    expect(first).toBe(`${canonicalJson(canonicaliseFailureArtifact(forward))}\n`);
  });

  it("leaves no readable partial file behind — the write is temp-plus-rename", async () => {
    await writeFailureArtifact(root, artifact());
    const entries = await readdir(failuresRoot(root));
    expect(entries).toEqual([`${RUN_ID}.json`]);
    expect(entries.some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("refuses a runId that would leave the store", () => {
    expect(() => failureArtifactPath(root, "../evil")).toThrow(UnsafePathSegmentError);
    expect(() => failureArtifactPath(root, "a/b")).toThrow(UnsafePathSegmentError);
  });

  it("reports an absent artifact as absent rather than as an empty one", async () => {
    expect(await readFailureArtifact(root, RUN_ID)).toBeUndefined();
  });

  it("refuses to write an artifact that does not satisfy its own schema", () => {
    expect(() =>
      canonicaliseFailureArtifact({
        ...artifact(),
        branches: [
          {
            branchKey: "b-1",
            nodeId: "n",
            // Zero attempts is not a failure anyone made: the branch never ran.
            attempts: 0,
            errorClass: "E",
            message: "",
          },
        ],
      }),
    ).toThrow();
  });
});

// ── sc-9-6 ───────────────────────────────────────────────────────────

describe("synthesis enumerates EVERY branch and names the failed ones (sc-9-6)", () => {
  const MIXED = {
    "sprint-golden-1": { state: "succeeded" as const, attempts: 1 },
    "sprint-golden-2": {
      state: "failed" as const,
      attempts: 3,
      errorClass: "TransientProviderError",
    },
    "sprint-golden-3": { state: "succeeded" as const, attempts: 1 },
  };

  it("lists every branch key, sorted, with its own status, attempts and error class", () => {
    const synthesis = synthesizeBranchOutcomes(MIXED);
    expect(synthesis.branches.map((b) => b.branchKey)).toEqual([
      "sprint-golden-1",
      "sprint-golden-2",
      "sprint-golden-3",
    ]);
    expect(synthesis.branches[1]).toEqual({
      branchKey: "sprint-golden-2",
      status: "failed",
      attempts: 3,
      errorClass: "TransientProviderError",
    });
    expect(synthesis.failed).toEqual(["sprint-golden-2"]);
  });

  it("names the failed branch AND its error class in the one-line summary", () => {
    const { summary } = synthesizeBranchOutcomes(MIXED);
    for (const key of Object.keys(MIXED)) expect(summary).toContain(key);
    expect(summary).toContain("failed");
    expect(summary).toContain("succeeded");
    expect(summary).toContain("TransientProviderError");
    expect(summary).toContain("1 of 3 branches failed");
  });

  it("ranks through the shipped synthesize(), so a healthy branch wins and the failure dissents", () => {
    const synthesis = synthesizeBranchOutcomes(MIXED);
    expect(synthesis.winner).toBe("sprint-golden-1");
    expect(synthesis.ranking.map((r) => r.approach)).toEqual([
      "sprint-golden-1",
      "sprint-golden-3",
      "sprint-golden-2",
    ]);
    // Every branch appears in the ranking; none is dropped for having failed.
    expect(synthesis.ranking).toHaveLength(3);
    expect(synthesis.ranking.at(-1)?.total).toBe(0);
    expect(synthesis.ranking[0].perLensScores).toEqual({ completion: 1, firstPass: 1 });
  });

  it("still enumerates a branch that failed on its FIRST attempt", () => {
    const synthesis = synthesizeBranchOutcomes({
      "sprint-golden-4": { state: "failed", attempts: 1, errorClass: "Error" },
    });
    expect(synthesis.failed).toEqual(["sprint-golden-4"]);
    expect(synthesis.summary).toContain("sprint-golden-4: failed after 1 attempt (Error)");
    expect(synthesis.winner).toBe("sprint-golden-4");
  });

  it("says so when a run dispatched no branches, rather than throwing", () => {
    const synthesis = synthesizeBranchOutcomes({});
    expect(synthesis.branches).toEqual([]);
    expect(synthesis.winner).toBeNull();
    expect(synthesis.summary).toBe("no branches were dispatched");
  });

  it("reports a clean run as clean", () => {
    const synthesis = synthesizeBranchOutcomes({
      "sprint-golden-1": { state: "succeeded", attempts: 1 },
      "sprint-golden-2": { state: "succeeded", attempts: 1 },
    });
    expect(synthesis.failed).toEqual([]);
    expect(synthesis.summary).toContain("all 2 branches succeeded");
  });
});
