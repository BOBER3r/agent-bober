import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { EFFECTS } from "../nodes/effects.js";
import {
  GOLDEN_CASE_FILE_EXTENSION,
  GOLDEN_DATASET_MAX_CASES,
  GOLDEN_DATASET_MIN_CASES,
  GOLDEN_MIN_REPLAY_CASES,
  checkCaseAgainstGraph,
  isReplayCase,
  parseGoldenCase,
} from "./case-schema.js";
import type { GoldenCase, GoldenGraphFacts } from "./case-schema.js";
import {
  GOLDEN_EXIT,
  datasetShapeProblems,
  loadGoldenDataset,
  runGoldenRegressionFromDir,
  validateGoldenDataset,
} from "./runner.js";

/**
 * The COMMITTED dataset, checked against the COMMITTED graph.
 *
 * Two rules govern this file. The count is taken by reading the directory, never from a
 * list written down here — a hardcoded list is a list that drifts, and the first thing it
 * hides is a case someone deleted. And every gate it asserts is driven from both sides:
 * each positive assertion about the real dataset has a negative control that breaks the
 * same precondition on a TEMP COPY and proves the check fails. The committed artifact and
 * the committed dataset are never mutated.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GOLDEN_DIR = join(REPO_ROOT, ".bober", "golden");
const TOPOLOGY_PATH = join(REPO_ROOT, ".bober", "topology", "coding.json");

interface TopologyArtifact {
  graphId: string;
  graphVersion: string;
  nodes: { id: string }[];
}

let facts: GoldenGraphFacts;
let files: string[];
let cases: GoldenCase[];

beforeAll(async () => {
  const artifact = JSON.parse(await readFile(TOPOLOGY_PATH, "utf-8")) as TopologyArtifact;
  facts = {
    graphId: artifact.graphId,
    graphVersion: artifact.graphVersion,
    nodeIds: new Set(artifact.nodes.map((node) => node.id)),
    effectNames: new Set(Object.values(EFFECTS)),
  };

  files = (await readdir(GOLDEN_DIR)).sort();
  const loaded = await loadGoldenDataset(GOLDEN_DIR);
  expect(loaded.errors).toEqual([]);
  cases = [...loaded.cases];
});

const tempDirs: string[] = [];

/** A writable copy of the committed dataset. The committed one is never touched. */
async function copyDataset(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "golden-dataset-"));
  tempDirs.push(dir);
  for (const file of files) await copyFile(join(GOLDEN_DIR, file), join(dir, file));
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

// ── sc-14-1: the committed dataset ──────────────────────────────────

describe("the committed golden dataset", () => {
  it("holds between 20 and 50 files, counted by reading the directory", () => {
    expect(files.length).toBeGreaterThanOrEqual(GOLDEN_DATASET_MIN_CASES);
    expect(files.length).toBeLessThanOrEqual(GOLDEN_DATASET_MAX_CASES);
  });

  it("holds nothing but cases, so the file count IS the case count", () => {
    expect(files.every((file) => file.endsWith(GOLDEN_CASE_FILE_EXTENSION))).toBe(true);
    expect(cases).toHaveLength(files.length);
  });

  it("parses every case against the schema", () => {
    // Re-parsed from the raw bytes rather than trusting the loader, so this assertion
    // fails on its own if the schema and the files ever disagree.
    expect(cases.length).toBe(files.length);
    for (const goldenCase of cases) {
      const round = parseGoldenCase(JSON.parse(JSON.stringify(goldenCase)), goldenCase.caseId);
      expect(round.ok).toBe(true);
    }
  });

  it("names every file for its own caseId, with no duplicate ids", () => {
    const ids = cases.map((goldenCase) => goldenCase.caseId);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(
      files.map((file) => file.slice(0, -GOLDEN_CASE_FILE_EXTENSION.length)).sort(),
    );
  });

  it("agrees with the committed topology artifact on every node and effect it pins", () => {
    const violations = cases.flatMap((goldenCase) => checkCaseAgainstGraph(goldenCase, facts));
    expect(violations).toEqual([]);
  });

  it("covers a broad slice of the graph rather than one path many times", () => {
    const nodes = new Set(
      cases.flatMap((goldenCase) => goldenCase.pinnedResponses.map((call) => call.nodeId)),
    );
    const effects = new Set(
      cases.flatMap((goldenCase) => goldenCase.pinnedResponses.map((call) => call.effectName)),
    );
    const terminals = new Set(cases.map((goldenCase) => goldenCase.expected.terminalNodeId));

    expect(nodes.size).toBeGreaterThanOrEqual(12);
    expect(effects.size).toBeGreaterThanOrEqual(10);
    expect(terminals.size).toBeGreaterThanOrEqual(5);
  });

  it("pins real artifacts in a meaningful share of cases, not empty maps throughout", () => {
    const withArtifacts = cases.filter(
      (goldenCase) => Object.keys(goldenCase.expected.artifacts).length > 0,
    );
    expect(withArtifacts.length).toBeGreaterThanOrEqual(8);
  });

  it("keeps at least the floor of EXECUTED cases, counted off the files", () => {
    const replay = cases.filter(isReplayCase);
    expect(replay.length).toBeGreaterThanOrEqual(GOLDEN_MIN_REPLAY_CASES);
    // Every one of them is executed against the real engine by `executor.test.ts` and by
    // the blocking CI job. The rest declare `integrity` and make no runtime claim, which
    // is a statement each file has to make for itself — there is no default.
    for (const goldenCase of cases) {
      expect(["replay", "integrity"]).toContain(goldenCase.enforcement);
    }
  });

  it("explains every expectation in prose", () => {
    for (const goldenCase of cases) {
      expect(goldenCase.expected.notes ?? "").not.toBe("");
      expect(goldenCase.intent.length).toBeGreaterThan(20);
    }
  });

  it("validates as a whole against the committed graph", async () => {
    const validation = await validateGoldenDataset({ dir: GOLDEN_DIR, facts });
    expect(validation.problems).toEqual([]);
    expect(validation.exitCode).toBe(GOLDEN_EXIT.pass);
  });
});

// ── Negative controls: every gate above, broken on a temp copy ──────

describe("the dataset gates bite", () => {
  it("fails when the directory holds fewer than 20 files", async () => {
    const dir = await copyDataset();
    const present = (await readdir(dir)).sort();
    for (const file of present.slice(0, present.length - (GOLDEN_DATASET_MIN_CASES - 1))) {
      await rm(join(dir, file));
    }
    expect((await readdir(dir)).length).toBe(GOLDEN_DATASET_MIN_CASES - 1);

    const validation = await validateGoldenDataset({ dir, facts });
    expect(validation.exitCode).toBe(GOLDEN_EXIT.usage);
    expect(validation.problems.join(" ")).toContain("must hold between 20 and 50");
  });

  it("fails when the directory holds more than 50 files", async () => {
    const dir = await copyDataset();
    const template = JSON.parse(
      await readFile(join(GOLDEN_DIR, files[0]), "utf-8"),
    ) as Record<string, unknown>;

    let index = 0;
    while ((await readdir(dir)).length <= GOLDEN_DATASET_MAX_CASES) {
      index += 1;
      const caseId = `synthetic-overflow-${String(index)}`;
      await writeFile(
        join(dir, `${caseId}.json`),
        JSON.stringify({ ...template, caseId }, null, 2),
        "utf-8",
      );
    }
    expect((await readdir(dir)).length).toBe(GOLDEN_DATASET_MAX_CASES + 1);

    const validation = await validateGoldenDataset({ dir, facts });
    expect(validation.exitCode).toBe(GOLDEN_EXIT.usage);
    expect(validation.problems.join(" ")).toContain("must hold between 20 and 50");
  });

  it("fails when the executed cases are relabelled away", async () => {
    const dir = await copyDataset();
    for (const file of await readdir(dir)) {
      const draft = JSON.parse(await readFile(join(dir, file), "utf-8")) as Record<string, unknown>;
      if (draft.enforcement !== "replay") continue;
      draft.enforcement = "integrity";
      await writeFile(join(dir, file), JSON.stringify(draft, null, 2), "utf-8");
    }

    const validation = await validateGoldenDataset({ dir, facts });
    expect(validation.exitCode).toBe(GOLDEN_EXIT.usage);
    expect(validation.problems.join(" ")).toContain('enforcement "replay"');
  });

  it("fails when a stray file is dropped into the directory", async () => {
    const dir = await copyDataset();
    await writeFile(join(dir, "NOTES.md"), "# how to add a case\n", "utf-8");

    const problems = datasetShapeProblems(await loadGoldenDataset(dir));
    expect(problems.join(" ")).toContain("is not a golden case");
  });

  it("fails when a case pins a node the graph no longer has", async () => {
    const dir = await copyDataset();
    const target = files[0];
    const draft = JSON.parse(await readFile(join(dir, target), "utf-8")) as Record<string, unknown>;
    const pinned = draft.pinnedResponses as Record<string, unknown>[];
    pinned[0].nodeId = "node_that_was_renamed";
    await writeFile(join(dir, target), JSON.stringify(draft, null, 2), "utf-8");

    const validation = await validateGoldenDataset({ dir, facts });
    expect(validation.exitCode).toBe(GOLDEN_EXIT.usage);
    expect(validation.problems.join(" ")).toContain("no such node");
  });

  it("fails when a case pins an effect the registry no longer has", async () => {
    const dir = await copyDataset();
    const target = files[0];
    const draft = JSON.parse(await readFile(join(dir, target), "utf-8")) as Record<string, unknown>;
    const pinned = draft.pinnedResponses as Record<string, unknown>[];
    pinned[0].effectName = "research.hallucinate";
    await writeFile(join(dir, target), JSON.stringify(draft, null, 2), "utf-8");

    const validation = await validateGoldenDataset({ dir, facts });
    expect(validation.exitCode).toBe(GOLDEN_EXIT.usage);
    expect(validation.problems.join(" ")).toContain("no such effect");
  });

  it("fails when an expectation is stored with a volatile key on it", async () => {
    const dir = await copyDataset();
    const target = files.find((file) => file.startsWith("full-run-")) ?? files[0];
    const draft = JSON.parse(await readFile(join(dir, target), "utf-8")) as Record<string, unknown>;
    const expected = draft.expected as Record<string, unknown>;
    const artifacts = expected.artifacts as Record<string, unknown[]>;
    artifacts.contracts = [{ contractId: "c-1", createdAt: "2026-08-05T00:00:00.000Z" }];
    await writeFile(join(dir, target), JSON.stringify(draft, null, 2), "utf-8");

    const validation = await validateGoldenDataset({ dir, facts });
    expect(validation.exitCode).toBe(GOLDEN_EXIT.usage);
    expect(validation.problems.join(" ")).toContain("not canonical");
  });

  it("fails when a case file is truncated", async () => {
    const dir = await copyDataset();
    await writeFile(join(dir, files[0]), "{ \"formatVersion\": 1,", "utf-8");

    const validation = await validateGoldenDataset({ dir, facts });
    expect(validation.exitCode).toBe(GOLDEN_EXIT.usage);
    expect(validation.problems.join(" ")).toContain("not JSON");
  });
});

// ── The runner over the committed dataset ───────────────────────────

describe("the regression runner over the committed dataset", () => {
  /**
   * The executor here answers each case with its OWN expectation, so this exercises the
   * loader, the comparison and the threshold over the real files — the plumbing, and only
   * the plumbing. It is NOT evidence that the runtime is correct: no engine ran. The
   * executor that drives a real engine over a case's pinned responses is supplied by the
   * caller and is not part of this test.
   */
  it("runs the EXECUTED cases and only those", async () => {
    const replay = cases.filter(isReplayCase);
    const report = await runGoldenRegressionFromDir({
      dir: GOLDEN_DIR,
      execute: (goldenCase) => goldenCase.expected.artifacts,
      facts,
    });
    expect(report.exitCode).toBe(GOLDEN_EXIT.pass);
    expect(report.total).toBe(replay.length);
    expect(report.passed).toBe(replay.length);
    expect(report.dataset).toEqual({
      total: files.length,
      replay: replay.length,
      integrity: files.length - replay.length,
    });
  });

  it("fails when a third of the executed cases stop reproducing their expectation", async () => {
    let seen = 0;
    const report = await runGoldenRegressionFromDir({
      dir: GOLDEN_DIR,
      execute: (goldenCase) => {
        seen += 1;
        // Every third case regresses — a ~33 percent fail rate. At the dataset's floor of
        // GOLDEN_MIN_REPLAY_CASES (5) that is one failure and an 80 percent pass rate,
        // which the threshold's strict `>` already refuses; from six cases up it is at
        // least two failures and a pass rate at or below 75 percent. Either way it cannot
        // clear the default threshold of 80, however many cases the replay set grows to.
        return seen % 3 === 0
          ? { contracts: [{ contractId: "drifted" }] }
          : goldenCase.expected.artifacts;
      },
      facts,
    });
    expect(report.exitCode).toBe(GOLDEN_EXIT.belowThreshold);
    expect(report.failed).toBeGreaterThan(0);
  });
});
