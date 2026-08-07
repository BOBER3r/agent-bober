import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { EFFECTS } from "../nodes/effects.js";
import { readGoldenGraphFacts, runGoldenGate } from "./gate.js";
import { GOLDEN_EXIT } from "./runner.js";
import type { GoldenExecutor } from "./runner.js";

/**
 * The decision the blocking CI step makes, driven from both sides.
 *
 * `scripts/run-golden-regression.mjs` is a shim over `runGoldenGate` precisely so this
 * file can exist: a rule implemented in a `.mjs` script is a rule Vitest cannot reach, and
 * the six-gate audit this sprint owes requires a NEGATIVE CONTROL for every gate — a test
 * that breaks the precondition and asserts a non-zero exit. Every passing assertion below
 * has one.
 *
 * The committed dataset and the committed topology artifact are never mutated; each
 * negative control works on a `mkdtemp` copy.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GOLDEN_DIR = join(REPO_ROOT, ".bober", "golden");

/**
 * Answers each case with its own expectation.
 *
 * A DELIBERATE FAKE, and the module note in `gate.ts` explains why one like it must never
 * be the gate's default: it makes every case pass for ever. It is used here to drive the
 * gate's own plumbing — the threshold, the ordering of the two halves, the refusal to run
 * an invalid dataset — WITHOUT paying for a real engine run per assertion. The real
 * executor is driven end to end in `executor.test.ts`, which is where the runtime claim is
 * proven; nothing in this file may be read as evidence that any engine ran.
 */
const reproducing: GoldenExecutor = (goldenCase) => goldenCase.expected.artifacts;

let files: string[] = [];
/** How many committed cases declare `enforcement: "replay"` — the ones a run executes. */
let replayCount = 0;
const tempDirs: string[] = [];

beforeAll(async () => {
  files = (await readdir(GOLDEN_DIR)).sort();
  for (const file of files) {
    const raw = JSON.parse(await readFile(join(GOLDEN_DIR, file), "utf-8")) as {
      enforcement?: string;
    };
    if (raw.enforcement === "replay") replayCount += 1;
  }
});

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** A writable copy of the committed dataset. */
async function copyDataset(): Promise<string> {
  const dir = await tempDir("golden-gate-dataset-");
  for (const file of files) await copyFile(join(GOLDEN_DIR, file), join(dir, file));
  return dir;
}

/** Rewrite one committed case inside a copied dataset. */
async function mutateCase(
  dir: string,
  file: string,
  edit: (draft: Record<string, unknown>) => void,
): Promise<void> {
  const draft = JSON.parse(await readFile(join(dir, file), "utf-8")) as Record<string, unknown>;
  edit(draft);
  await writeFile(join(dir, file), JSON.stringify(draft, null, 2), "utf-8");
}

// ── The facts the dataset is checked against ────────────────────────

describe("readGoldenGraphFacts", () => {
  it("reads the committed artifact's graph id, version, nodes and the effect catalog", async () => {
    const read = await readGoldenGraphFacts(REPO_ROOT);
    expect(read.ok).toBe(true);
    if (!read.ok) return;

    expect(read.facts.graphId).toBe("coding");
    expect(read.facts.graphVersion).toMatch(/^\d+\.\d+\.\d+$/);
    // Derived from the artifact, never written down here.
    expect(read.facts.nodeIds.size).toBeGreaterThan(0);
    expect(read.facts.nodeIds.has("supervisor")).toBe(true);
    expect(read.facts.effectNames).toEqual(new Set(Object.values(EFFECTS)));
  });

  /** NEGATIVE CONTROL — no artifact at all is a refusal, never an empty node set. */
  it("refuses when the committed artifact is absent", async () => {
    const root = await tempDir("golden-gate-noroot-");
    const read = await readGoldenGraphFacts(root);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problem).toContain("cannot read the committed topology artifact");
  });

  /** NEGATIVE CONTROL — a file that is JSON but not a topology. */
  it("refuses JSON that is not a topology artifact", async () => {
    const root = await tempDir("golden-gate-badroot-");
    await mkdir(join(root, ".bober", "topology"), { recursive: true });
    await writeFile(join(root, ".bober", "topology", "coding.json"), '{"nodes":[]}', "utf-8");

    const read = await readGoldenGraphFacts(root);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problem).toContain("not a topology artifact");
  });

  /** NEGATIVE CONTROL — a truncated artifact must not read as a graph with no nodes. */
  it("refuses a truncated artifact", async () => {
    const root = await tempDir("golden-gate-truncroot-");
    await mkdir(join(root, ".bober", "topology"), { recursive: true });
    await writeFile(join(root, ".bober", "topology", "coding.json"), '{"graphId": "cod', "utf-8");

    const read = await readGoldenGraphFacts(root);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problem).toContain("not JSON");
  });
});

// ── The dataset half: integrity against the committed graph ─────────
//
// Every negative control below fails BEFORE anything is executed, which is the rule
// `runGoldenRegressionFromDir` enforces: a dataset that failed its own validation is never
// run, because a pass rate over unknown contents means nothing. The fake executor is
// therefore never invoked in this block; it is passed so the assertions are about the
// dataset half rather than about how long a real run takes.

describe("runGoldenGate's dataset half", () => {
  it("states the split between executed and integrity-only cases in a GREEN run", async () => {
    const result = await runGoldenGate({ projectRoot: REPO_ROOT, execute: reproducing });

    expect(result.exitCode).toBe(GOLDEN_EXIT.pass);
    expect(result.runtimeEnforced).toBe(true);
    expect(result.lines.join("\n")).toContain(
      `${String(replayCount)} of ${String(files.length)} committed case(s) are enforcement="replay"`,
    );
  });

  /** NEGATIVE CONTROL — the check with teeth over time: a renamed node. */
  it("exits non-zero when a case pins a node the graph no longer has", async () => {
    const dir = await copyDataset();
    await mutateCase(dir, files[0], (draft) => {
      (draft.pinnedResponses as Record<string, unknown>[])[0].nodeId = "node_that_was_renamed";
    });

    const result = await runGoldenGate({ projectRoot: REPO_ROOT, dir, execute: reproducing });
    expect(result.exitCode).toBe(GOLDEN_EXIT.usage);
    expect(result.lines.join("\n")).toContain("no such node");
  });

  /** NEGATIVE CONTROL — a dropped effect. */
  it("exits non-zero when a case pins an effect the registry no longer has", async () => {
    const dir = await copyDataset();
    await mutateCase(dir, files[0], (draft) => {
      (draft.pinnedResponses as Record<string, unknown>[])[0].effectName = "research.hallucinate";
    });

    const result = await runGoldenGate({ projectRoot: REPO_ROOT, dir, execute: reproducing });
    expect(result.exitCode).toBe(GOLDEN_EXIT.usage);
    expect(result.lines.join("\n")).toContain("no such effect");
  });

  /** NEGATIVE CONTROL — an emptied dataset is the loudest possible failure, not a pass. */
  it("exits non-zero when the dataset directory is empty", async () => {
    const dir = await tempDir("golden-gate-empty-");
    const result = await runGoldenGate({ projectRoot: REPO_ROOT, dir, execute: reproducing });
    expect(result.exitCode).toBe(GOLDEN_EXIT.usage);
    expect(result.lines.join("\n")).toContain("must hold between 20 and 50");
  });

  /** NEGATIVE CONTROL — an absent directory cannot read as "nothing wrong". */
  it("exits non-zero when the dataset directory does not exist", async () => {
    const parent = await tempDir("golden-gate-absent-");
    const result = await runGoldenGate({
      projectRoot: REPO_ROOT,
      dir: join(parent, "nope"),
      execute: reproducing,
    });
    expect(result.exitCode).toBe(GOLDEN_EXIT.usage);
    expect(result.lines.join("\n")).toContain("cannot read the golden dataset directory");
  });

  /** NEGATIVE CONTROL — a malformed case file. */
  it("exits non-zero when a case file is truncated", async () => {
    const dir = await copyDataset();
    await writeFile(join(dir, files[0]), '{ "formatVersion": 1,', "utf-8");

    const result = await runGoldenGate({ projectRoot: REPO_ROOT, dir, execute: reproducing });
    expect(result.exitCode).toBe(GOLDEN_EXIT.usage);
    expect(result.lines.join("\n")).toContain("not JSON");
  });

  /** NEGATIVE CONTROL — the gate cannot run at all without a graph to check against. */
  it("exits non-zero when the project root has no committed topology artifact", async () => {
    const root = await tempDir("golden-gate-rootless-");
    const result = await runGoldenGate({ projectRoot: root, dir: GOLDEN_DIR, execute: reproducing });
    expect(result.exitCode).toBe(GOLDEN_EXIT.usage);
    expect(result.runtimeEnforced).toBe(false);
    expect(result.lines.join("\n")).toContain("cannot read the committed topology artifact");
  });
});

// ── The pass-rate half, driven through the fake ─────────────────────

describe("runGoldenGate's pass-rate half", () => {
  it("runs every executed case and reports the half as enforced", async () => {
    const result = await runGoldenGate({ projectRoot: REPO_ROOT, execute: reproducing });

    expect(result.exitCode).toBe(GOLDEN_EXIT.pass);
    expect(result.runtimeEnforced).toBe(true);
    // The denominator is the EXECUTED half, not the directory: a pass rate printed over
    // the whole dataset would claim a runtime for cases that never ran.
    expect(result.lines.join("\n")).toContain(
      `${String(replayCount)}/${String(replayCount)} passed`,
    );
  });

  /** NEGATIVE CONTROL — the pass-rate branch, below the bar. */
  it("exits non-zero when a quarter of the dataset stops reproducing its expectation", async () => {
    let seen = 0;
    const result = await runGoldenGate({
      projectRoot: REPO_ROOT,
      execute: (goldenCase) => {
        seen += 1;
        return seen % 4 === 0
          ? { contracts: [{ contractId: "drifted" }] }
          : goldenCase.expected.artifacts;
      },
    });

    expect(result.exitCode).toBe(GOLDEN_EXIT.belowThreshold);
    expect(result.runtimeEnforced).toBe(true);
  });

  /** NEGATIVE CONTROL — an executor that throws fails its case rather than the process. */
  it("exits non-zero when the executor throws for every case", async () => {
    const result = await runGoldenGate({
      projectRoot: REPO_ROOT,
      execute: () => {
        throw new Error("engine unavailable");
      },
    });

    expect(result.exitCode).toBe(GOLDEN_EXIT.belowThreshold);
    expect(result.lines.join("\n")).toContain("executor threw: engine unavailable");
  });

  /**
   * The threshold is FORWARDED, not defaulted away. 100 can never be satisfied because
   * the comparison is strictly greater than, so it is a usage error rather than a gate
   * that always fails — and this proves the gate passes the caller's number through.
   */
  it("reports an unsatisfiable threshold as a usage error", async () => {
    const result = await runGoldenGate({
      projectRoot: REPO_ROOT,
      execute: reproducing,
      minPassRatePercent: 100,
    });

    expect(result.exitCode).toBe(GOLDEN_EXIT.usage);
    expect(result.lines.join("\n")).toContain("can never be satisfied");
  });

  /** A dataset that failed validation is never RUN: a pass rate over unknown contents. */
  it("refuses to run a dataset that failed validation, and never calls the executor", async () => {
    const dir = await copyDataset();
    await mutateCase(dir, files[0], (draft) => {
      (draft.pinnedResponses as Record<string, unknown>[])[0].nodeId = "node_that_was_renamed";
    });

    let calls = 0;
    const result = await runGoldenGate({
      projectRoot: REPO_ROOT,
      dir,
      execute: (goldenCase) => {
        calls += 1;
        return goldenCase.expected.artifacts;
      },
    });

    expect(result.exitCode).toBe(GOLDEN_EXIT.usage);
    expect(calls).toBe(0);
  });
});
