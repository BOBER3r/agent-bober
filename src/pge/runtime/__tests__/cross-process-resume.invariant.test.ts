import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readArtifactTree } from "../__fixtures__/artifact-tree.js";
import { GOLDEN_NODES } from "../__fixtures__/golden-graph.js";
import { CHILD_ENTRY_FLAG, parseChildArgs } from "../__fixtures__/resume-child.js";
import type { ChildReport } from "../__fixtures__/resume-child.js";
import { createFsCheckpointer, listCheckpointFiles } from "../checkpointer.js";

/**
 * BLOCKING INVARIANT SUITE 3 of 3 — CROSS-PROCESS RESUME.
 *
 * ADR-5 chose a filesystem checkpointer over an in-process one on the strength of exactly
 * one success criterion: "a run killed after node 3 and restarted in a FRESH PROCESS
 * re-invokes zero of nodes 1-3 and yields the uninterrupted run's artifact". That criterion
 * is the discriminator, and it is only a discriminator if the second run really is a second
 * process — a `MemorySaver`-shaped store passes any same-process simulation, because the
 * state never left the heap. So this suite spawns REAL child processes with `execa`, this
 * repository's spawner, and the first of them terminates itself with `SIGKILL`: no
 * `finally`, no flush, no unwind.
 *
 * Three children, one script (`__fixtures__/resume-child.ts`), so all three execute
 * identical code:
 *
 *   full  — the control. Runs the golden graph end to end.
 *   part1 — SIGKILLs itself the instant the checkpoint for superstep 2 lands, by which
 *           point exactly three node bodies (plan_draft, supervisor, fanout_sprints) have
 *           executed and committed.
 *   part2 — resumes from `latest(runId)` knowing nothing about part1 beyond `.bober/`.
 *
 * ── What is asserted ──
 *
 *  (a) part2 re-invokes ZERO of the three completed nodes;
 *  (b) per-node handler counts summed across part1 and part2 EQUAL the uninterrupted run's,
 *      so each body executed exactly once in total rather than once per process;
 *  (c) the resumed run's whole `.bober/` tree is byte-identical to the uninterrupted run's.
 *
 * ── Mutation-proven ──
 *
 * This suite was run against three deliberate breakages and failed on each:
 *
 *  - `resume` seeding the ENTRY task alongside the restored frontier (6 of 12 red):
 *    `plan_draft` is re-invoked in part2, so (a) and (b) both fail and the artifact
 *    diverges;
 *  - `resume` restarting the superstep counter at 0 instead of `checkpoint.nextSuperstep`
 *    (4 of 12 red): the resumed run reports fewer supersteps than the control and its
 *    checkpoint files land at the wrong indices;
 *  - the post-commit checkpoint declaring `nextSuperstep: superstep` instead of
 *    `superstep + 1` (4 of 12 red): the resumed run re-executes the superstep that already
 *    committed, so the per-node totals exceed the control's.
 */

const RUN = "run-resume";
const KILL_AFTER = 2;
const CONTRACTS = 2;

const require_ = createRequire(import.meta.url);
/** vite-node ships with vitest, which is this repository's test runner. */
const VITE_NODE = join(dirname(require_.resolve("vite-node/package.json")), "vite-node.mjs");
const CHILD = fileURLToPath(new URL("../__fixtures__/resume-child.ts", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

interface ChildOutcome {
  report: ChildReport;
  exitCode: number | undefined;
  signal: string | undefined;
}

async function spawnChild(args: {
  mode: "full" | "part1" | "part2";
  root: string;
  out: string;
}): Promise<ChildOutcome> {
  const result = await execa(
    process.execPath,
    [
      VITE_NODE,
      CHILD,
      CHILD_ENTRY_FLAG,
      `--mode=${args.mode}`,
      `--root=${args.root}`,
      `--runId=${RUN}`,
      `--out=${args.out}`,
      `--killAfter=${String(KILL_AFTER)}`,
      `--contracts=${String(CONTRACTS)}`,
    ],
    { cwd: REPO_ROOT, reject: false, all: true },
  );
  let report: ChildReport;
  try {
    report = JSON.parse(await readFile(args.out, "utf8")) as ChildReport;
  } catch (error) {
    throw new Error(
      `child ${args.mode} wrote no report (exit ${String(result.exitCode)}, signal ${String(result.signal)})\n${String(result.all).slice(-2000)}`,
      { cause: error },
    );
  }
  return {
    report,
    exitCode: result.exitCode ?? undefined,
    signal: typeof result.signal === "string" ? result.signal : undefined,
  };
}

let fullRoot = "";
let splitRoot = "";
let reports = "";
let full: ChildOutcome;
let part1: ChildOutcome;
let part2: ChildOutcome;
let checkpointsAfterKill: number[] = [];

beforeAll(async () => {
  fullRoot = await mkdtemp(join(tmpdir(), "bober-pge-xproc-full-"));
  splitRoot = await mkdtemp(join(tmpdir(), "bober-pge-xproc-split-"));
  reports = await mkdtemp(join(tmpdir(), "bober-pge-xproc-out-"));

  full = await spawnChild({ mode: "full", root: fullRoot, out: join(reports, "full.json") });
  part1 = await spawnChild({ mode: "part1", root: splitRoot, out: join(reports, "part1.json") });
  checkpointsAfterKill = await listCheckpointFiles(splitRoot, RUN);
  part2 = await spawnChild({ mode: "part2", root: splitRoot, out: join(reports, "part2.json") });
}, 180_000);

afterAll(async () => {
  for (const dir of [fullRoot, splitRoot, reports]) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("the harness itself", () => {
  it("parses the child's arguments", () => {
    expect(
      parseChildArgs(["--mode=part2", "--root=/tmp/x", "--runId=r", "--out=/tmp/o", "--killAfter=5"]),
    ).toEqual({ mode: "part2", root: "/tmp/x", runId: "r", out: "/tmp/o", killAfter: 5, contracts: 2 });
    expect(() => parseChildArgs(["--mode=nonsense"])).toThrow(/full\|part1\|part2/);
  });

  it("really did kill the first process, rather than letting it exit", () => {
    // If this ever becomes a clean exit, every assertion below is about an in-process
    // simulation and proves nothing that a MemorySaver would not also pass.
    expect(part1.signal).toBe("SIGKILL");
    expect(part1.exitCode).toBeUndefined();
    expect(part1.report.status).toBe("killed");
  });

  it("left exactly the checkpoints of the supersteps that committed before the kill", () => {
    expect(checkpointsAfterKill).toEqual([0, 1, 2]);
  });

  it("ran the control and the resumed halves to completion", () => {
    expect(full.report.status).toBe("completed");
    expect(full.report.verdict).toBe("success");
    expect(part2.report.status).toBe("completed");
    expect(part2.report.verdict).toBe("success");
    expect(part2.exitCode).toBe(0);
  });
});

describe("CROSS-PROCESS RESUME: zero re-invocations of completed nodes (sc-8-1)", () => {
  it("executed exactly nodes 1-3 before the kill", () => {
    expect(part1.report.handlerCalls).toEqual({
      [GOLDEN_NODES.planDraft]: 1,
      [GOLDEN_NODES.supervisor]: 1,
      [GOLDEN_NODES.fanout]: 1,
    });
  });

  it("re-invokes NONE of them in the fresh process", () => {
    for (const nodeId of [GOLDEN_NODES.planDraft, GOLDEN_NODES.fanout]) {
      expect(part2.report.handlerCalls[nodeId], nodeId).toBeUndefined();
    }
    // `supervisor` is genuinely re-entered later in the graph — three times in the control
    // run — so the claim is not "it never runs again" but "it does not run again for the
    // superstep that already committed".
    expect(full.report.handlerCalls[GOLDEN_NODES.supervisor]).toBe(3);
    expect(part2.report.handlerCalls[GOLDEN_NODES.supervisor]).toBe(2);
  });

  it("restarted at the superstep AFTER the last checkpoint, not at zero", () => {
    expect(part2.report.resumedAt).toBe(KILL_AFTER + 1);
    expect(part2.report.supersteps).toBe(full.report.supersteps);
  });
});

describe("NO NODE RE-RUN: the write-counter spy totals to the uninterrupted run (sc-8-1)", () => {
  it("sums part1 + part2 to exactly the control run, per node", () => {
    const total: Record<string, number> = { ...part1.report.handlerCalls };
    for (const [nodeId, count] of Object.entries(part2.report.handlerCalls)) {
      total[nodeId] = (total[nodeId] ?? 0) + count;
    }
    expect(total).toEqual(full.report.handlerCalls);

    // Non-vacuous: the control run really did execute more than a handful of bodies.
    const executed = Object.values(full.report.handlerCalls).reduce((a, b) => a + b, 0);
    expect(executed).toBeGreaterThan(15);
  });

  it("never double-counts a node across the kill boundary", () => {
    for (const [nodeId, count] of Object.entries(part1.report.handlerCalls)) {
      const after = part2.report.handlerCalls[nodeId] ?? 0;
      const control = full.report.handlerCalls[nodeId] ?? 0;
      expect(count + after, `${nodeId} ran ${String(count + after)} times, control ${String(control)}`).toBe(
        control,
      );
    }
  });
});

describe("CROSS-PROCESS RESUME: the artifact is byte-identical (sc-8-1)", () => {
  it("produces the same .bober/ tree as the uninterrupted run — checkpoints included", async () => {
    const control = await readArtifactTree(fullRoot);
    const resumed = await readArtifactTree(splitRoot);

    expect([...resumed.keys()]).toEqual([...control.keys()]);
    expect(control.size).toBeGreaterThan(15);
    for (const [path, bytes] of control) {
      expect(resumed.get(path), `artifact ${path}`).toBe(bytes);
    }
  });

  it("leaves the same checkpoint set behind in both roots", async () => {
    const control = await listCheckpointFiles(fullRoot, RUN);
    const resumed = await listCheckpointFiles(splitRoot, RUN);
    expect(resumed).toEqual(control);
    expect(control.length).toBe(full.report.supersteps);
  });

  it("wrote the SAME committed state at the checkpoint the kill landed on", async () => {
    const control = createFsCheckpointer(fullRoot);
    const resumed = createFsCheckpointer(splitRoot);
    const a = await control.get({ runId: RUN, superstep: KILL_AFTER });
    const b = await resumed.get({ runId: RUN, superstep: KILL_AFTER });

    expect({ ...b.state, projectRoot: "<ROOT>" }).toEqual({ ...a.state, projectRoot: "<ROOT>" });
    expect(b.completedTaskKeys).toEqual(a.completedTaskKeys);
    expect(b.pending.map((t) => t.nodeId)).toEqual(a.pending.map((t) => t.nodeId));
  });
});
