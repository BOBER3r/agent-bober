import { copyFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { getCheckpointMechanism } from "../../orchestrator/checkpoints/registry.js";
import { parseGoldenCase } from "./case-schema.js";
import type { GoldenCase } from "./case-schema.js";
import {
  GOLDEN_APPROVED_CONFIG_INPUT,
  GOLDEN_RUN_ID,
  UnsupportedGoldenInputError,
  createGoldenExecutor,
  goldenApprovedConfig,
  goldenConfig,
  resolveGoldenConfig,
} from "./executor.js";
import { runGoldenGate } from "./gate.js";
import {
  GOLDEN_EXIT,
  compareGoldenArtifacts,
  loadGoldenDataset,
  runGoldenRegression,
} from "./runner.js";
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
   * A case whose pins do not cover the run does not PASS. That is the rule under test, and
   * (sc-8-3, sprint 8 of spec-20260812-pge-real-workload-errors) it is no longer the same
   * thing as "the executor throws".
   *
   * `createReplayEffectRegistry` throws `MissingRecordingError` at the first call it
   * cannot answer, the interpreter treats that as a failed node and routes onwards — and
   * how the run ENDS now depends on how much of the pipeline the truncation left standing,
   * because sprint 7 taught `CommitBoundary.finalize` a second ending:
   *
   *  - truncated during research (this test, `slice(0, 1)`, before `plan_draft` ever runs),
   *    neither `state.spec` nor `state.specDraft` is ever written, so `finalize` still
   *    THROWS `FinalizeWithoutSpecError` — unchanged since before sprint 7.
   *  - truncated once `plan_draft` has answered but before `plan_materialize` does,
   *    `state.specDraft` IS written, so sprint 7's fallback now RESOLVES instead, with
   *    `success: false`, `needsClarification: true`, and an `errors` entry naming the
   *    `MissingRecordingError` that ended the run (verified by hand against this exact
   *    truncation depth while diagnosing this sprint; not asserted here because pinning it
   *    would make this test a test of where the truncation happens to land).
   *
   * A test asserting `rejects.toThrow()` pinned the FIRST ending only, which sprint 7 made
   * one of two rather than the only one. This assertion instead runs the SAME per-case
   * logic the CI job runs — `runGoldenRegression`, imported rather than reimplemented — so
   * it is indifferent to which ending a truncation produces: a throw and a resolved
   * mismatch both leave `results[0].passed` `false`, which is the rule the module header
   * above already states and the only claim either ending was ever entitled to make.
   */
  it(
    "fails the case when a pinned response is missing, rather than answering from anywhere else",
    async () => {
      const goldenCase = replayCases[0];
      const short: GoldenCase = {
        ...goldenCase,
        pinnedResponses: goldenCase.pinnedResponses.slice(0, 1),
      };
      const report = await runGoldenRegression({ cases: [short], execute });
      expect(report.results).toHaveLength(1);
      expect(report.results[0].passed).toBe(false);
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

// ── The one config input this executor DOES accept (sc-2-3, sc-2-5) ────

describe("resolveGoldenConfig — the ONE enumerated exception to the config pin", () => {
  it("resolves to the byte-identical autopilot config when input.config is absent", () => {
    expect(resolveGoldenConfig(undefined)).toEqual(goldenConfig());
  });

  it("resolves to goldenApprovedConfig() for the approved marker, and nothing else moved", () => {
    const resolved = resolveGoldenConfig(GOLDEN_APPROVED_CONFIG_INPUT);
    expect(resolved).toEqual(goldenApprovedConfig());
    // Confined to end-of-pipeline: the OTHER hitl gate in the graph (`plan_clarify` at
    // `post-plan`) is not in this override, so it stays on the autopilot default — this
    // sprint's territory is the commit gate, not every gate in the graph (sc-2-5).
    expect(resolved.pipeline.checkpointOverrides).toEqual({ "end-of-pipeline": "disk" });
    expect(resolved.pipeline.checkpointOverrides?.["post-plan"]).toBeUndefined();
    // Still a code constant: nothing about it reads bober.config.json, which is exactly
    // what makes it reproducible on a contributor's machine and on a CI runner.
    expect(resolved.pipeline.researchPhase).toBe(false);
    expect(resolved.pipeline.maxIterations).toBe(2);
  });

  it("accepts { approved: true } into a case's input.config, unlike every other key", async () => {
    const approved: GoldenCase = {
      ...replayCases[0],
      input: { ...replayCases[0].input, config: { ...GOLDEN_APPROVED_CONFIG_INPUT } },
    };
    // Refuses neither with UnsupportedGoldenInputError nor any other throw — the whole
    // point of the allowlist is that this ONE shape is honoured rather than rejected.
    await expect(execute(approved)).resolves.toBeDefined();
  }, 120_000);

  /**
   * `assertExecutable` already refuses a malformed `input.config` before a REPLAY ever
   * reaches this function, so this specifically protects the OTHER caller — `capture.ts`,
   * which calls `resolveGoldenConfig` directly with no such guard in front of it. One
   * predicate (`isApprovedConfigInput`), not two: this must reject exactly what
   * `assertExecutable`'s own check rejects.
   */
  it("throws for a defined config input that is not exactly { approved: true }", () => {
    expect(() => resolveGoldenConfig({ autopilot: true })).toThrow(/unsupported config input/);
    expect(() => resolveGoldenConfig({ approved: false })).toThrow(/unsupported config input/);
    expect(() => resolveGoldenConfig({ approved: true, extra: 1 })).toThrow(
      /unsupported config input/,
    );
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

  /**
   * THE safety property this sprint's briefing named as the one thing not to get wrong: the
   * `disk` mechanism the shipped registry serves is rooted at `process.cwd()`
   * (`registry.ts:126-132`) — the real checkout when this suite runs. A durable-approval
   * golden case resolves `end-of-pipeline` to `disk`, so without `withGoldenApproval`
   * re-rooting it for the run's duration, this exact test would `mkdir` and write
   * `.bober/approvals/` into THIS repository.
   *
   * Run through `createGoldenExecutor`'s DEFAULT `runRootParent` (the OS temp directory,
   * the same call shape `scripts/run-golden-regression.mjs` uses) rather than a scoped one,
   * so this is the representative case, not a best-case one.
   */
  it(
    "never touches this checkout's .bober/approvals/, and restores the disk mechanism afterward",
    async () => {
      const approvalsInRepo = join(REPO_ROOT, ".bober", "approvals");
      await expect(stat(approvalsInRepo)).rejects.toThrow();

      const before = getCheckpointMechanism("disk");
      const { stdout: headBefore } = await execa("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT });

      const approved: GoldenCase = {
        ...replayCases[0],
        input: { ...replayCases[0].input, config: { ...GOLDEN_APPROVED_CONFIG_INPUT } },
      };
      await execute(approved);

      // The checkout is exactly as it was: no approvals directory, and no new commit.
      await expect(stat(approvalsInRepo)).rejects.toThrow();
      const { stdout: headAfter } = await execa("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT });
      expect(headAfter).toBe(headBefore);
      const status = await execa("git", ["status", "--porcelain", "--", ".bober/approvals"], {
        cwd: REPO_ROOT,
      });
      expect(status.stdout.trim()).toBe("");

      // The registry is module state, restored to the EXACT reference it held before —
      // not merely "a" disk mechanism, but the one the rest of this suite (and any other
      // file sharing this worker) already had.
      expect(getCheckpointMechanism("disk")).toBe(before);
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
   *
   * SCALED at sc-8-4 (sprint 8 of spec-20260812-pge-real-workload-errors). The previous
   * revision mutated exactly the two `replay-full-run-evaluation-*` cases and claimed that
   * was safe "regardless of how many more cases the replay set grows to hold" — false:
   * `(n-2)/n` crosses the 80 percent threshold at `n = 11` (see docs/pge-graph.md, "A
   * negative control can stop biting as the dataset grows"), so a fixed count of 2 would
   * have silently stopped failing the moment the replay set reached 11 cases, with nothing
   * anywhere reporting it. `dataset.test.ts` and `gate.test.ts` hit the identical shape of
   * bug at `1.4.0` and fixed it by injecting a FRACTION (`seen % 3`) rather than a count;
   * this control adopts the same fraction.
   *
   * The mutated FIELD changed for the same reason. `contracts[0].title` is not available on
   * every case — `replay-plan-clarify-rounds-exhausted` never reaches `sprint_exit`, so its
   * `expected.artifacts.contracts` is empty — but `pipelineResult` is one of
   * `SCALAR_ARTIFACT_FIELDS` (`case-schema.ts`) and every `replay` case's expectation
   * carries exactly one element of it with a `success` key always present
   * (`PipelineResult.success` is required, never optional). Flipping it is a mutation every
   * case, present and future, can take, which a per-caseId allow-list cannot promise.
   *
   * At the dataset's current 6 replay cases `(index + 1) % 3 === 0` drifts indices 2 and 5
   * — 2 of 6, a ~67 percent pass rate, the SAME failure count the fixed-count version
   * produced. This is a scaling fix, not a change in what today's run catches, and it keeps
   * failing at any replay count from the floor upward — `dataset.test.ts`'s identical
   * control states why: at most one third of any n >= GOLDEN_MIN_REPLAY_CASES clears an 80
   * percent bar only when two thirds pass, and two thirds is comfortably under 80.
   */
  it(
    "exits non-zero when a committed replay case stops reproducing its expectation",
    async () => {
      const dir = await tempDir("golden-executor-dataset-");
      const files = (await readdir(GOLDEN_DIR)).sort();
      for (const file of files) await copyFile(join(GOLDEN_DIR, file), join(dir, file));

      const drifted = replayCases.filter((_, index) => (index + 1) % 3 === 0);
      expect(drifted.length).toBeGreaterThan(0);
      for (const goldenCase of drifted) {
        const target = join(dir, `${goldenCase.caseId}.json`);
        const draft = JSON.parse(await readFile(target, "utf-8")) as GoldenCase;
        const pipelineResult = draft.expected.artifacts.pipelineResult as
          | Array<Record<string, unknown>>
          | undefined;
        expect(pipelineResult).toHaveLength(1);
        const pinned = (pipelineResult as Array<Record<string, unknown>>)[0];
        expect(typeof pinned.success).toBe("boolean");
        pinned.success = !pinned.success;
        await writeFile(target, JSON.stringify(draft, null, 2), "utf-8");
        // Still a valid case — only its expectation changed, which is what a runtime
        // regression looks like from the dataset's side.
        expect(parseGoldenCase(draft, target).ok).toBe(true);
      }

      const result = await runGoldenGate({ projectRoot: REPO_ROOT, dir });
      expect(result.exitCode).toBe(GOLDEN_EXIT.belowThreshold);
      expect(result.lines.join("\n")).toContain(`FAIL ${drifted[0].caseId}`);
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
