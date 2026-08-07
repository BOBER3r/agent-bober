import { copyFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { parseGoldenCase } from "./case-schema.js";
import type { GoldenCase } from "./case-schema.js";
import { GOLDEN_RUN_ID, UnsupportedGoldenInputError, createGoldenExecutor } from "./executor.js";
import { runGoldenGate } from "./gate.js";
import { GOLDEN_EXIT, compareGoldenArtifacts, loadGoldenDataset } from "./runner.js";
import type { GoldenExecutor } from "./runner.js";

/**
 * The RUNTIME half of the blocking gate, driven from both sides.
 *
 * Every assertion here runs the real `PgeEngine` over the real committed artifact. That is
 * the point: this file is the negative control the previous revision of this sprint could
 * not have — its pass-rate branch was reachable only from a fake executor, so nothing
 * proved a regression in the ENGINE would be caught.
 *
 * The committed dataset and the committed artifact are never mutated; every negative
 * control works on a `mkdtemp` copy.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GOLDEN_DIR = join(REPO_ROOT, ".bober", "golden");

let replayCases: GoldenCase[] = [];
let execute: GoldenExecutor;

const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

beforeAll(async () => {
  const dataset = await loadGoldenDataset(GOLDEN_DIR);
  expect(dataset.errors).toEqual([]);
  replayCases = dataset.cases.filter((goldenCase) => goldenCase.enforcement === "replay");
  execute = await createGoldenExecutor({ projectRoot: REPO_ROOT });
}, 60_000);

// ── The positive claim ──────────────────────────────────────────────

describe("the committed replay cases against the real engine", () => {
  it("exist, so the assertions below are not vacuous", () => {
    expect(replayCases.length).toBeGreaterThan(0);
  });

  for (const index of [0, 1, 2, 3]) {
    it(
      `reproduces its expectation exactly (case ${String(index)})`,
      async () => {
        const goldenCase = replayCases[index];
        expect(goldenCase, `the dataset holds fewer than ${String(index + 1)} replay cases`).toBeDefined();
        const produced = await execute(goldenCase);
        expect(compareGoldenArtifacts(goldenCase.expected.artifacts, produced)).toEqual([]);
      },
      120_000,
    );
  }

  it(
    "produces artifacts at all — an empty comparison would pass vacuously",
    async () => {
      const produced = await execute(replayCases[0]);
      const populated = Object.entries(produced).filter(([, values]) => (values ?? []).length > 0);
      expect(populated.map(([field]) => field).sort()).toContain("contracts");
      expect(populated.length).toBeGreaterThanOrEqual(4);
    },
    120_000,
  );
});

// ── Negative controls on the comparison ─────────────────────────────

describe("the runtime comparison bites", () => {
  it(
    "reports a divergence when the expectation is changed under it",
    async () => {
      const goldenCase = replayCases[0];
      const produced = await execute(goldenCase);

      const tampered = JSON.parse(JSON.stringify(goldenCase.expected.artifacts)) as Record<
        string,
        unknown[]
      >;
      const contracts = tampered.contracts as Record<string, unknown>[];
      expect(contracts.length).toBeGreaterThan(0);
      contracts[0].title = "a title no run produces";

      const failures = compareGoldenArtifacts(tampered, produced);
      expect(failures.length).toBeGreaterThan(0);
      expect(failures.join("\n")).toContain("contracts[0]");
    },
    120_000,
  );

  it(
    "reports a divergence when the expectation gains an artifact the run does not write",
    async () => {
      const goldenCase = replayCases[0];
      const produced = await execute(goldenCase);
      const tampered = {
        ...JSON.parse(JSON.stringify(goldenCase.expected.artifacts)),
        briefings: [{ contractId: "a briefing no replay writes" }],
      } as Record<string, unknown[]>;

      expect(compareGoldenArtifacts(tampered, produced).join("\n")).toContain("briefings:");
    },
    120_000,
  );

  /**
   * A case whose pins do not cover the run FAILS. It never answers from anywhere else.
   *
   * The error class is not asserted, and that is deliberate: the replay registry throws
   * `MissingRecordingError` at the call it cannot answer, the interpreter treats that as a
   * failed node and routes onwards, and what finally reaches the caller is whichever
   * failure the truncated run ends on — here `FinalizeWithoutSpecError`, because the plan
   * never happened. Pinning one class would be pinning the routing rather than the rule,
   * and the rule is: an unpinned call cannot produce a passing case.
   */
  it(
    "fails the case when a pinned response is missing, rather than answering from anywhere else",
    async () => {
      const goldenCase = replayCases[0];
      const short: GoldenCase = {
        ...goldenCase,
        pinnedResponses: goldenCase.pinnedResponses.slice(0, 1),
      };
      await expect(execute(short)).rejects.toThrow();
    },
    120_000,
  );
});

// ── Negative controls on what may be executed at all ────────────────

describe("the executor refuses an input it cannot honour", () => {
  it("refuses a case that declares enforcement integrity", async () => {
    const dataset = await loadGoldenDataset(GOLDEN_DIR);
    const curated = dataset.cases.find((goldenCase) => goldenCase.enforcement === "integrity");
    expect(curated).toBeDefined();
    if (curated === undefined) return;
    await expect(execute(curated)).rejects.toBeInstanceOf(UnsupportedGoldenInputError);
  });

  it("refuses a case that starts anywhere but the graph's entry", async () => {
    const off: GoldenCase = {
      ...replayCases[0],
      input: { ...replayCases[0].input, entryNodeId: "sprint_body" },
    };
    await expect(execute(off)).rejects.toThrow(/runs the graph from its own entry/);
  });

  it("refuses a case that seeds channels or overrides config", async () => {
    const seeded: GoldenCase = {
      ...replayCases[0],
      input: { ...replayCases[0].input, seed: { spec: null } },
    };
    await expect(execute(seeded)).rejects.toThrow(/seeds channel values/);

    const configured: GoldenCase = {
      ...replayCases[0],
      input: { ...replayCases[0].input, config: { autopilot: true } },
    };
    await expect(execute(configured)).rejects.toThrow(/overrides config keys/);
  });
});

// ── The run is offline, and it lands in its own root ────────────────

describe("a golden run", () => {
  it(
    "writes into its throwaway root and reaches no collaborator",
    async () => {
      const parent = await tempDir("golden-executor-roots-");
      const scoped = await createGoldenExecutor({
        projectRoot: REPO_ROOT,
        runRootParent: parent,
        keepRunRoots: true,
      });
      await scoped(replayCases[0]);

      const roots = await readdir(parent);
      expect(roots).toHaveLength(1);
      const root = join(parent, roots[0]);

      // The commit boundary's writes are there…
      await expect(stat(join(root, ".bober", "contracts"))).resolves.toBeDefined();
      await expect(stat(join(root, ".bober", "traces", `${GOLDEN_RUN_ID}.jsonl`))).resolves.toBeDefined();

      // …and the writes that happen INSIDE a collaborator are not, because no collaborator
      // ran. `.bober/briefings/` is written by the curator itself, so its absence is the
      // proof that the effect boundary answered from the recording rather than falling
      // through to an agent.
      await expect(stat(join(root, ".bober", "briefings"))).rejects.toThrow();
      await expect(stat(join(root, ".bober", "reviews"))).rejects.toThrow();
    },
    120_000,
  );
});

// ── The whole gate, end to end, with the real executor ──────────────

describe("runGoldenGate with its own default executor", () => {
  it(
    "passes over the committed dataset and reports the runtime half as enforced",
    async () => {
      const result = await runGoldenGate({ projectRoot: REPO_ROOT });
      expect(result.lines.join("\n")).toContain("were EXECUTED against the engine");
      expect(result.exitCode).toBe(GOLDEN_EXIT.pass);
      expect(result.runtimeEnforced).toBe(true);
    },
    180_000,
  );

  /**
   * THE negative control this sprint owes: a case that stops reproducing its artifacts
   * fails the gate the CI job runs, with no executor injected by the test.
   */
  it(
    "exits non-zero when a committed replay case stops reproducing its expectation",
    async () => {
      const dir = await tempDir("golden-executor-dataset-");
      const files = (await readdir(GOLDEN_DIR)).sort();
      for (const file of files) await copyFile(join(GOLDEN_DIR, file), join(dir, file));

      const target = join(dir, `${replayCases[0].caseId}.json`);
      const draft = JSON.parse(await readFile(target, "utf-8")) as GoldenCase;
      const contracts = draft.expected.artifacts.contracts as Record<string, unknown>[];
      contracts[0].title = "a title no run produces";
      await writeFile(target, JSON.stringify(draft, null, 2), "utf-8");
      // Still a valid case — only its expectation changed, which is what a runtime
      // regression looks like from the dataset's side.
      expect(parseGoldenCase(draft, target).ok).toBe(true);

      const result = await runGoldenGate({ projectRoot: REPO_ROOT, dir });
      expect(result.exitCode).toBe(GOLDEN_EXIT.belowThreshold);
      expect(result.lines.join("\n")).toContain(`FAIL ${replayCases[0].caseId}`);
    },
    180_000,
  );

  /** NEGATIVE CONTROL — relabelling the executed cases away cannot buy a green gate. */
  it(
    "exits non-zero when the replay cases are relabelled as integrity",
    async () => {
      const dir = await tempDir("golden-executor-relabel-");
      const files = (await readdir(GOLDEN_DIR)).sort();
      for (const file of files) await copyFile(join(GOLDEN_DIR, file), join(dir, file));

      for (const goldenCase of replayCases) {
        const target = join(dir, `${goldenCase.caseId}.json`);
        const draft = JSON.parse(await readFile(target, "utf-8")) as GoldenCase;
        await writeFile(
          target,
          JSON.stringify({ ...draft, enforcement: "integrity" }, null, 2),
          "utf-8",
        );
      }

      const result = await runGoldenGate({ projectRoot: REPO_ROOT, dir });
      expect(result.exitCode).toBe(GOLDEN_EXIT.usage);
      expect(result.lines.join("\n")).toContain('enforcement "replay"');
    },
    180_000,
  );
});
