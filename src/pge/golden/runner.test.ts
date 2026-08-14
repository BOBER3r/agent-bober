import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GOLDEN_CASE_FORMAT_VERSION, parseGoldenCase } from "./case-schema.js";
import type { GoldenCase, GoldenEnforcement, GoldenGraphFacts } from "./case-schema.js";
import {
  DEFAULT_MIN_PASS_RATE_PERCENT,
  GOLDEN_EXIT,
  compareGoldenArtifacts,
  datasetShapeProblems,
  loadGoldenDataset,
  runGoldenRegression,
  runGoldenRegressionFromDir,
  thresholdProblem,
  validateGoldenDataset,
} from "./runner.js";
import type { GoldenRunArtifacts } from "./runner.js";

// ── Fixtures ────────────────────────────────────────────────────────

/**
 * A parsed case whose expectation is one contract carrying `caseId`.
 *
 * `replay` by default, because most tests here drive the runner and only `replay` cases are
 * executed — a fixture set of `integrity` cases would make every pass-rate assertion below
 * a statement about an empty run.
 */
function fixtureCase(caseId: string, enforcement: GoldenEnforcement = "replay"): GoldenCase {
  const raw = {
    formatVersion: GOLDEN_CASE_FORMAT_VERSION,
    caseId,
    title: `Case ${caseId}`,
    intent: "Drive the runner.",
    tags: ["fixture"],
    enforcement,
    graph: { graphId: "coding", graphVersion: "1.2.0" },
    input: { featureRequest: "Do the thing.", entryNodeId: "research_body" },
    pinnedResponses: [
      {
        nodeId: "research_reflect",
        branchKey: null,
        effectName: "research.reflect",
        callIndex: 0,
        request: { featureRequest: "Do the thing." },
        response: { coreProblem: caseId },
      },
    ],
    expected: {
      terminalNodeId: "research_collect",
      artifacts: { contracts: [{ contractId: caseId, status: "passed" }] },
    },
  };
  const parsed = parseGoldenCase(raw, `${caseId}.json`);
  if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.errors.join("; ")}`);
  return parsed.goldenCase;
}

/** `total` cases, of which the first `passing` are answered correctly. */
function dataset(total: number): GoldenCase[] {
  return Array.from({ length: total }, (_, index) => fixtureCase(`case-${String(index + 1)}`));
}

function executorPassingFirst(passing: number) {
  let seen = 0;
  return (goldenCase: GoldenCase): GoldenRunArtifacts => {
    seen += 1;
    if (seen <= passing) return goldenCase.expected.artifacts;
    return { contracts: [{ contractId: "wrong", status: "failed" }] };
  };
}

const tempDirs: string[] = [];

async function tempDataset(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "golden-runner-"));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, "utf-8");
  }
  return dir;
}

/** The JSON text of a fixture case, so a temp dataset is made of real cases. */
function fixtureJson(caseId: string, mutate: (draft: Record<string, unknown>) => void = () => undefined): string {
  const draft = JSON.parse(JSON.stringify(fixtureCase(caseId))) as Record<string, unknown>;
  mutate(draft);
  return JSON.stringify(draft, null, 2);
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

// ── The boundary the contract pins ──────────────────────────────────

describe("the exit codes", () => {
  /**
   * Pinned as literals, because every negative control in this file and in dataset.test.ts
   * asserts a SYMBOL. If `usage` were ever redefined to 0, all of those tests would keep
   * passing while the gate stopped failing — the exact silent-decoration failure mode the
   * sprint forbids. This test is what makes the symbols mean "non-zero".
   */
  it("maps pass to 0 and every failure to a non-zero code", () => {
    expect(GOLDEN_EXIT.pass).toBe(0);
    expect(GOLDEN_EXIT.belowThreshold).toBe(1);
    expect(GOLDEN_EXIT.usage).toBe(2);
  });
});

describe("the minimum pass-rate threshold", () => {
  /**
   * sc-14-2, verbatim: 79, 80 and 81 percent against a threshold of 80 must exit fail,
   * fail and pass. The middle one is the whole point — "minimum 80" read as `>=` would let
   * a suite sit on its floor forever, so the comparison is strictly greater than.
   */
  it("fails at 79 percent against a threshold of 80", async () => {
    const report = await runGoldenRegression({
      cases: dataset(100),
      execute: executorPassingFirst(79),
      minPassRatePercent: 80,
    });
    expect(report.passed).toBe(79);
    expect(report.passRatePercent).toBe(79);
    expect(report.exitCode).toBe(GOLDEN_EXIT.belowThreshold);
    expect(report.exitCode).not.toBe(GOLDEN_EXIT.pass);
  });

  it("fails at exactly 80 percent against a threshold of 80", async () => {
    const report = await runGoldenRegression({
      cases: dataset(100),
      execute: executorPassingFirst(80),
      minPassRatePercent: 80,
    });
    expect(report.passed).toBe(80);
    expect(report.passRatePercent).toBe(80);
    expect(report.exitCode).toBe(GOLDEN_EXIT.belowThreshold);
    expect(report.exitCode).not.toBe(GOLDEN_EXIT.pass);
  });

  it("passes at 81 percent against a threshold of 80", async () => {
    const report = await runGoldenRegression({
      cases: dataset(100),
      execute: executorPassingFirst(81),
      minPassRatePercent: 80,
    });
    expect(report.passed).toBe(81);
    expect(report.passRatePercent).toBe(81);
    expect(report.exitCode).toBe(GOLDEN_EXIT.pass);
  });

  it("defaults to 80 when the caller names no threshold", () => {
    expect(DEFAULT_MIN_PASS_RATE_PERCENT).toBe(80);
  });

  it("refuses a threshold no run could ever clear", () => {
    expect(thresholdProblem(100)).not.toBeNull();
    expect(thresholdProblem(-1)).not.toBeNull();
    expect(thresholdProblem(Number.NaN)).not.toBeNull();
    expect(thresholdProblem(80)).toBeNull();
    expect(thresholdProblem(99.9)).toBeNull();
  });

  it("exits usage rather than running when the threshold is unusable", async () => {
    let executed = 0;
    const report = await runGoldenRegression({
      cases: dataset(10),
      execute: () => {
        executed += 1;
        return {};
      },
      minPassRatePercent: 100,
    });
    expect(report.exitCode).toBe(GOLDEN_EXIT.usage);
    expect(executed).toBe(0);
  });

  it("cannot pass over an empty dataset", async () => {
    const report = await runGoldenRegression({ cases: [], execute: () => ({}) });
    expect(report.exitCode).not.toBe(GOLDEN_EXIT.pass);
    expect(report.errors.join(" ")).toContain("empty");
  });
});

// ── Case execution ──────────────────────────────────────────────────

describe("running cases", () => {
  it("fails the case whose executor threw, and keeps running the rest", async () => {
    const cases = dataset(3);
    const report = await runGoldenRegression({
      cases,
      execute: (goldenCase) => {
        if (goldenCase.caseId === "case-2") throw new Error("interpreter exploded");
        return goldenCase.expected.artifacts;
      },
      minPassRatePercent: 50,
    });
    expect(report.total).toBe(3);
    expect(report.passed).toBe(2);
    const failed = report.results.find((result) => result.caseId === "case-2");
    expect(failed?.failures.join(" ")).toContain("interpreter exploded");
  });

  it("names every failing case in the formatted report", async () => {
    const report = await runGoldenRegression({
      cases: dataset(2),
      execute: executorPassingFirst(1),
      minPassRatePercent: 80,
    });
    expect(report.exitCode).toBe(GOLDEN_EXIT.belowThreshold);
  });
});

// ── The comparison ──────────────────────────────────────────────────

describe("compareGoldenArtifacts", () => {
  it("accepts artifacts that differ only by a volatile key", () => {
    const expected: GoldenRunArtifacts = { contracts: [{ contractId: "c-1", status: "passed" }] };
    const actual: GoldenRunArtifacts = {
      contracts: [
        { contractId: "c-1", status: "passed", createdAt: "2026-08-05T00:00:00Z", runId: "r-1" },
      ],
    };
    expect(compareGoldenArtifacts(expected, actual)).toEqual([]);
  });

  it("accepts elements in a different order", () => {
    const expected: GoldenRunArtifacts = { contracts: [{ contractId: "a" }, { contractId: "b" }] };
    const actual: GoldenRunArtifacts = { contracts: [{ contractId: "b" }, { contractId: "a" }] };
    expect(compareGoldenArtifacts(expected, actual)).toEqual([]);
  });

  it("reports an artifact the case does not pin", () => {
    const expected: GoldenRunArtifacts = { contracts: [{ contractId: "c-1" }] };
    const actual: GoldenRunArtifacts = {
      contracts: [{ contractId: "c-1" }],
      specs: [{ specId: "s-1" }],
    };
    const failures = compareGoldenArtifacts(expected, actual);
    expect(failures.some((failure) => failure.startsWith("specs:"))).toBe(true);
  });

  it("reports a missing element", () => {
    const failures = compareGoldenArtifacts(
      { contracts: [{ contractId: "a" }, { contractId: "b" }] },
      { contracts: [{ contractId: "a" }] },
    );
    expect(failures.some((failure) => failure.includes("expected 2 element(s)"))).toBe(true);
  });

  it("reports a changed field", () => {
    const failures = compareGoldenArtifacts(
      { contracts: [{ contractId: "a", status: "passed" }] },
      { contracts: [{ contractId: "a", status: "failed" }] },
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("contracts[0]");
  });
});

// ── Loading a directory ─────────────────────────────────────────────

describe("loadGoldenDataset", () => {
  it("reads every case in the directory", async () => {
    const dir = await tempDataset({
      "case-1.json": fixtureJson("case-1"),
      "case-2.json": fixtureJson("case-2"),
    });
    const loaded = await loadGoldenDataset(dir);
    expect(loaded.errors).toEqual([]);
    expect(loaded.cases.map((c) => c.caseId).sort()).toEqual(["case-1", "case-2"]);
  });

  it("reports a file that is not JSON", async () => {
    const dir = await tempDataset({ "case-1.json": "{ not json" });
    const loaded = await loadGoldenDataset(dir);
    expect(loaded.errors.join(" ")).toContain("not JSON");
    expect(loaded.cases).toEqual([]);
  });

  it("reports a file whose name disagrees with its caseId", async () => {
    const dir = await tempDataset({ "renamed.json": fixtureJson("case-1") });
    const loaded = await loadGoldenDataset(dir);
    expect(loaded.errors.join(" ")).toContain("must be named case-1.json");
    expect(loaded.cases).toEqual([]);
  });

  it("reports a missing directory rather than reporting an empty dataset", async () => {
    const loaded = await loadGoldenDataset(join(tmpdir(), "golden-does-not-exist-12345"));
    expect(loaded.errors.join(" ")).toContain("cannot read");
  });
});

describe("datasetShapeProblems", () => {
  it("rejects a directory holding fewer files than the floor", async () => {
    const dir = await tempDataset({ "case-1.json": fixtureJson("case-1") });
    const problems = datasetShapeProblems(await loadGoldenDataset(dir), { min: 2, max: 5 });
    expect(problems.join(" ")).toContain("holds 1 file(s)");
  });

  it("rejects a directory holding more files than the ceiling", async () => {
    const files: Record<string, string> = {};
    for (let index = 1; index <= 6; index += 1) {
      files[`case-${String(index)}.json`] = fixtureJson(`case-${String(index)}`);
    }
    const dir = await tempDataset(files);
    const problems = datasetShapeProblems(await loadGoldenDataset(dir), { min: 2, max: 5 });
    expect(problems.join(" ")).toContain("holds 6 file(s)");
  });

  it("rejects a stray non-case file, so the file count and the case count agree", async () => {
    const dir = await tempDataset({
      "case-1.json": fixtureJson("case-1"),
      "README.md": "# notes",
    });
    const problems = datasetShapeProblems(await loadGoldenDataset(dir), { min: 1, max: 5 });
    expect(problems.join(" ")).toContain("is not a golden case");
  });

  it("accepts a directory inside its bounds", async () => {
    const dir = await tempDataset({
      "case-1.json": fixtureJson("case-1"),
      "case-2.json": fixtureJson("case-2"),
    });
    expect(datasetShapeProblems(await loadGoldenDataset(dir), { min: 1, max: 5 })).toEqual([]);
  });
});

// ── The composed entry points ───────────────────────────────────────

const FACTS: GoldenGraphFacts = {
  graphId: "coding",
  graphVersion: "1.2.0",
  nodeIds: new Set(["research_body", "research_reflect", "research_collect"]),
  effectNames: new Set(["research.reflect"]),
};

describe("runGoldenRegressionFromDir", () => {
  it("runs a valid dataset and passes", async () => {
    const dir = await tempDataset({
      "case-1.json": fixtureJson("case-1"),
      "case-2.json": fixtureJson("case-2"),
    });
    const report = await runGoldenRegressionFromDir({
      dir,
      execute: (goldenCase) => goldenCase.expected.artifacts,
      bounds: { min: 1, max: 5 },
      facts: FACTS,
    });
    expect(report.exitCode).toBe(GOLDEN_EXIT.pass);
    expect(report.total).toBe(2);
  });

  it("exits usage WITHOUT running when a case is malformed", async () => {
    let executed = 0;
    const dir = await tempDataset({
      "case-1.json": fixtureJson("case-1"),
      "case-2.json": "{ not json",
    });
    const report = await runGoldenRegressionFromDir({
      dir,
      execute: () => {
        executed += 1;
        return {};
      },
      bounds: { min: 1, max: 5 },
    });
    expect(report.exitCode).toBe(GOLDEN_EXIT.usage);
    expect(executed).toBe(0);
  });

  it("exits usage when a case names a node the graph does not have", async () => {
    const dir = await tempDataset({
      "case-1.json": fixtureJson("case-1", (draft) => {
        const pinned = draft.pinnedResponses as Record<string, unknown>[];
        pinned[0].nodeId = "renamed_node";
      }),
    });
    const report = await runGoldenRegressionFromDir({
      dir,
      execute: (goldenCase) => goldenCase.expected.artifacts,
      bounds: { min: 1, max: 5 },
      facts: FACTS,
    });
    expect(report.exitCode).toBe(GOLDEN_EXIT.usage);
    expect(report.errors.join(" ")).toContain("no such node");
  });
});

describe("validateGoldenDataset", () => {
  it("passes on a well-formed dataset without running anything", async () => {
    const dir = await tempDataset({ "case-1.json": fixtureJson("case-1") });
    const validation = await validateGoldenDataset({
      dir,
      bounds: { min: 1, max: 5 },
      facts: FACTS,
    });
    expect(validation.exitCode).toBe(GOLDEN_EXIT.pass);
    expect(validation.caseCount).toBe(1);
  });

  it("fails when the dataset drifts from the graph", async () => {
    const dir = await tempDataset({
      "case-1.json": fixtureJson("case-1", (draft) => {
        (draft.expected as Record<string, unknown>).terminalNodeId = "renamed_node";
      }),
    });
    const validation = await validateGoldenDataset({
      dir,
      bounds: { min: 1, max: 5 },
      facts: FACTS,
    });
    expect(validation.exitCode).toBe(GOLDEN_EXIT.usage);
    expect(validation.problems.join(" ")).toContain("terminalNodeId");
  });
});
