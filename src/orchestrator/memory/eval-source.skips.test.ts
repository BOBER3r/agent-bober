import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadEvalResults, loadEvalResultsWithSkips } from "./eval-source.js";

/**
 * The same silent-skip defect `listContractsWithSkips` closes for
 * `.bober/contracts/`, in the corpus this loader owns. `loadEvalResults` fed
 * `bober memory distill`, which prints "distilled N lessons" — so a file it
 * could not read produced no lesson and no complaint, indistinguishable from
 * there being no lesson to draw.
 *
 * Unlike the contracts corpus, `.bober/eval-results/` is CLEAN today (234 of
 * 234 files project). That is exactly why the synthetic controls below carry
 * the weight: the real-corpus test can only prove the accounting holds, not
 * that the skip branch works, because nothing is currently being skipped.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bober-evals-"));
  const dir = join(root, ".bober", "eval-results");
  await mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, name), body, "utf-8");
  }
  return root;
}

describe("loadEvalResultsWithSkips reports what it could not read", () => {
  it("separates projectable files from unreadable ones, with a reason each", async () => {
    const root = await fixture({
      "a-ok.json": JSON.stringify({ evalId: "e1", contractId: "c1", passed: true }),
      "b-bad-json.json": "{ not json",
      "c-array.json": JSON.stringify([1, 2, 3]),
      "d-scalar.json": JSON.stringify("a string"),
      "e-ignored.txt": "not json at all",
    });

    const { results, skipped } = await loadEvalResultsWithSkips(root);

    expect(results.map((r) => r.evalId)).toEqual(["e1"]);
    expect(skipped.map((s) => s.file)).toEqual([
      "b-bad-json.json",
      "c-array.json",
      "d-scalar.json",
    ]);
    expect(skipped[0].reason).toContain("invalid JSON");
    // An array and a bare scalar are both valid JSON but project to nothing —
    // the distinct reason is what tells a human which problem they have.
    expect(skipped[1].reason).toContain("not a JSON object");
    expect(skipped[2].reason).toContain("not a JSON object");
  });

  it("reports no skips for a directory that is entirely projectable", async () => {
    const root = await fixture({
      "a.json": JSON.stringify({ evalId: "e1" }),
      "b.json": JSON.stringify({ evalId: "e2" }),
    });

    const { results, skipped } = await loadEvalResultsWithSkips(root);
    expect(results).toHaveLength(2);
    expect(skipped).toEqual([]);
  });

  it("returns both halves empty when the directory does not exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "bober-evals-empty-"));
    await expect(loadEvalResultsWithSkips(root)).resolves.toEqual({
      results: [],
      skipped: [],
    });
  });

  it("loadEvalResults is exactly the results half — no change for its callers", async () => {
    const root = await fixture({
      "a-ok.json": JSON.stringify({ evalId: "e1" }),
      "b-bad.json": "{ not json",
    });

    const [plain, listing] = await Promise.all([
      loadEvalResults(root),
      loadEvalResultsWithSkips(root),
    ]);
    expect(plain).toEqual(listing.results);
    expect(plain).toHaveLength(1);
  });
});

describe("loadEvalResultsWithSkips against the real committed corpus", () => {
  it("accounts for every eval-result file on disk", async () => {
    const { results, skipped } = await loadEvalResultsWithSkips(REPO_ROOT);
    const onDisk = (
      await readdir(join(REPO_ROOT, ".bober", "eval-results"))
    ).filter((f) => f.endsWith(".json")).length;

    // Liveness: an empty corpus would make this vacuous.
    expect(onDisk).toBeGreaterThan(0);

    // Every file is either projected or named. Self-adjusting: no hardcoded
    // count, so it keeps holding as eval results accumulate.
    expect(results.length + skipped.length).toBe(onDisk);
  });
});
