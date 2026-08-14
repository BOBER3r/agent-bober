import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TopologySpec } from "../../../contracts/topology.js";
import { readArtifactTree } from "../__fixtures__/artifact-tree.js";
import { GOLDEN_NODES, goldenContracts, goldenSpec } from "../__fixtures__/golden-graph.js";
import { runGolden } from "../__fixtures__/run-harness.js";
import {
  ChecksumMismatchError,
  NestedCheckpointerError,
  checkpointPath,
  createFsCheckpointer,
  encodeCheckpoint,
  listCheckpointFiles,
} from "../checkpointer.js";
import type { Checkpoint } from "../checkpointer.js";
import { CheckpointerRequiredError, createGraphInterpreter } from "../interpreter.js";

/**
 * DURABILITY TIERS, RESUME IDENTITY AND SKIP-BEFORE-DISPATCH.
 *
 * The cross-process half of the resume invariant lives in
 * `cross-process-resume.invariant.test.ts`, because only a real second process can
 * distinguish this design from the in-process store ADR-5 rejected. What is asserted HERE
 * is everything that is decidable without leaving the process:
 *
 *  - `durability: "superstep"` writes one checkpoint per superstep; `"exit"` writes only at
 *    phase boundaries; both produce the SAME final artifact (sc-8-10);
 *  - a checkpoint carries the graph identity, and resuming against a moved artifact throws
 *    `ChecksumMismatch` rather than replaying task keys into a different graph (sc-8-3);
 *  - resume filters completed task keys off the frontier BEFORE dispatch, proved by a spy
 *    that counts what was handed to the scheduler, not what executed (sc-8-4);
 *  - a subgraph declaring its own checkpointer is refused before any node runs (sc-8-9).
 *
 * ── Mutation-proven ──
 *
 * This suite was run against five deliberate breakages and failed on each:
 *
 *  - the checkpoint condition widened to `|| true`, so the durability tier is ignored and
 *    `"exit"` becomes indistinguishable from `"superstep"`;
 *  - `resume` no longer calling `assertCheckpointMatchesGraph`, so a checkpoint written
 *    against a moved artifact resumes silently;
 *  - the skip filter in `resume` short-circuited to `if (true) pending.push(task)`, so a
 *    completed task key is dispatched again;
 *  - `resolveSubgraphCheckpointers` removed from `run`, so a nested checkpointer is never
 *    caught;
 *  - `enqueue` no longer removing a re-enqueued key from `done`, so a mid-rework
 *    checkpoint lists its own pending task as already completed.
 */

const RUN = "run-durability";

let root = "";
let otherRoot = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bober-pge-dur-"));
  otherRoot = await mkdtemp(join(tmpdir(), "bober-pge-dur-exit-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(otherRoot, { recursive: true, force: true });
});

// ── Durability tiers (sc-8-10) ──────────────────────────────────────

describe("DURABILITY: superstep writes every superstep, exit only at phase boundaries (sc-8-10)", () => {
  it("writes exactly one checkpoint per superstep under 'superstep'", async () => {
    const run = await runGolden({
      projectRoot: root,
      runId: RUN,
      behaviour: { contracts: goldenContracts(2) },
      checkpointer: createFsCheckpointer(root),
      durability: "superstep",
    });

    expect(run.result.status).toBe("completed");
    const written = await listCheckpointFiles(root, RUN);
    expect(written).toEqual(
      Array.from({ length: run.result.supersteps }, (_, i) => i),
    );
    expect(written.length).toBeGreaterThan(10);
  });

  it("writes under 'exit' at EXACTLY the phase boundaries and the run's end", async () => {
    // The reference: one checkpoint per superstep, so the committed phase of every
    // superstep is readable. The expected "exit" set is DERIVED from it rather than
    // hard-coded, so a fixture whose phases move cannot make this assertion vacuous.
    const reference = createFsCheckpointer(root);
    const dense = await runGolden({
      projectRoot: root,
      runId: RUN,
      behaviour: { contracts: goldenContracts(2) },
      checkpointer: reference,
      durability: "superstep",
    });
    expect(dense.result.status).toBe("completed");

    const phases: string[] = [];
    for (const superstep of await listCheckpointFiles(root, RUN)) {
      phases.push((await reference.get({ runId: RUN, superstep })).state.currentPhase);
    }
    const last = phases.length - 1;
    const expected = phases
      .map((phase, superstep) => ({ phase, superstep }))
      .filter(
        ({ phase, superstep }) =>
          superstep === last || phase !== (superstep === 0 ? "init" : phases[superstep - 1]),
      )
      .map(({ superstep }) => superstep);

    const sparse = await runGolden({
      projectRoot: otherRoot,
      runId: RUN,
      behaviour: { contracts: goldenContracts(2) },
      checkpointer: createFsCheckpointer(otherRoot),
      durability: "exit",
    });
    expect(sparse.result.status).toBe("completed");

    const written = await listCheckpointFiles(otherRoot, RUN);
    expect(written).toEqual(expected);
    expect(written.length).toBeGreaterThan(1);
    expect(written.length).toBeLessThan(phases.length);
  });

  it("produces the SAME final artifact under both tiers", async () => {
    const superstep = await runGolden({
      projectRoot: root,
      runId: RUN,
      behaviour: { contracts: goldenContracts(2) },
      checkpointer: createFsCheckpointer(root),
      durability: "superstep",
      finalize: true,
    });
    const exit = await runGolden({
      projectRoot: otherRoot,
      runId: RUN,
      behaviour: { contracts: goldenContracts(2) },
      checkpointer: createFsCheckpointer(otherRoot),
      durability: "exit",
      finalize: true,
    });

    expect(superstep.result.status).toBe("completed");
    expect(exit.result.status).toBe("completed");
    // `projectRoot` is the one legitimately different key: two temp directories.
    expect({ ...exit.finalState, projectRoot: "<ROOT>" }).toEqual({
      ...superstep.finalState,
      projectRoot: "<ROOT>",
    });

    // Byte-for-byte over the committed artifacts. Checkpoints are excluded here precisely
    // because their COUNT is what this group is about; their content is compared by the
    // resume tests, which read them back.
    const exclude = [".bober/traces/", ".bober/checkpoints/"];
    const a = await readArtifactTree(root, { exclude });
    const b = await readArtifactTree(otherRoot, { exclude });
    expect([...a.keys()]).toEqual([...b.keys()]);
    for (const [path, bytes] of a) expect(b.get(path), `artifact ${path}`).toBe(bytes);
  });

  it("writes nothing at all when no checkpointer is supplied", async () => {
    const run = await runGolden({
      projectRoot: root,
      runId: RUN,
      behaviour: { contracts: goldenContracts(2) },
    });
    expect(run.result.status).toBe("completed");
    expect(await listCheckpointFiles(root, RUN)).toEqual([]);
  });
});

// ── Graph identity on resume (sc-8-3) ───────────────────────────────

describe("RESUME: refuses a checkpoint written against a different artifact (sc-8-3)", () => {
  it("carries graphId, graphVersion and checksum on every checkpoint", async () => {
    const checkpointer = createFsCheckpointer(root);
    await runGolden({
      projectRoot: root,
      runId: RUN,
      behaviour: { contracts: goldenContracts(2) },
      checkpointer,
    });

    const spec = goldenSpec();
    for (const superstep of await listCheckpointFiles(root, RUN)) {
      const checkpoint = await checkpointer.get({ runId: RUN, superstep });
      expect(checkpoint.graphId).toBe(spec.graphId);
      expect(checkpoint.graphVersion).toBe(spec.graphVersion);
      expect(checkpoint.checksum).toBe(spec.checksum);
    }
  });

  it("throws ChecksumMismatch instead of replaying completed task keys into a changed graph", async () => {
    const checkpointer = createFsCheckpointer(root);
    const first = await runGolden({
      projectRoot: root,
      runId: RUN,
      behaviour: { contracts: goldenContracts(2) },
      checkpointer,
    });
    expect(first.result.status).toBe("completed");

    // The artifact moved under the checkpoint: same nodes, different declared version.
    const moved: TopologySpec = { ...goldenSpec(), graphVersion: "2.0.0" };

    await expect(
      runGolden({
        projectRoot: root,
        runId: RUN,
        behaviour: { contracts: goldenContracts(2) },
        checkpointer,
        spec: moved,
        resumeFrom: { ref: { runId: RUN, superstep: 2 } },
      }),
    ).rejects.toThrow(ChecksumMismatchError);
  });

  it("refuses to resume at all without a checkpointer", async () => {
    expect(typeof createGraphInterpreter().resume).toBe("function");
    await expect(
      runGolden({
        projectRoot: root,
        runId: RUN,
        behaviour: { contracts: goldenContracts(1) },
        resumeFrom: { ref: { runId: RUN, superstep: 0 } },
      }),
    ).rejects.toThrow(CheckpointerRequiredError);
  });
});

// ── Skip before dispatch (sc-8-4) ───────────────────────────────────

describe("RESUME: completed task keys are skipped BEFORE dispatch (sc-8-4)", () => {
  /**
   * A checkpoint whose frontier overlaps its own `completedTaskKeys`.
   *
   * A checkpoint is a plain JSON file — that readability is the whole reason ADR-5 chose
   * the filesystem — so an operator editing one, or a future durability tier that
   * snapshots the frontier before dispatch, can produce exactly this overlap. The
   * discipline that has to hold is the one at `workflow/resume-cursor.ts:12`, generalised
   * from sprint numbers to task keys: a key already committed is not dispatched again.
   */
  async function seedOverlappingCheckpoint(): Promise<{ superstep: number; taskKeys: string[] }> {
    const checkpointer = createFsCheckpointer(root);
    await runGolden({
      projectRoot: root,
      runId: RUN,
      behaviour: { contracts: goldenContracts(2) },
      checkpointer,
    });

    // Pick a checkpoint whose frontier holds work that has not run yet, then declare that
    // work already complete.
    let superstep = -1;
    for (const candidate of await listCheckpointFiles(root, RUN)) {
      const cp = await checkpointer.get({ runId: RUN, superstep: candidate });
      if (cp.pending.length > 0) {
        superstep = candidate;
        break;
      }
    }
    expect(superstep).toBeGreaterThanOrEqual(0);
    const checkpoint = await checkpointer.get({ runId: RUN, superstep });
    expect(checkpoint.pending.length).toBeGreaterThan(0);

    const taskKeys = checkpoint.pending.map((task) => task.taskKey);
    const edited: Checkpoint = {
      ...checkpoint,
      completedTaskKeys: [...checkpoint.completedTaskKeys, ...taskKeys],
    };
    await writeFile(checkpointPath(root, RUN, superstep), encodeCheckpoint(edited), "utf8");
    return { superstep, taskKeys };
  }

  it("never hands a completed task to the scheduler, and records it as a skipped span", async () => {
    const { superstep, taskKeys } = await seedOverlappingCheckpoint();
    const checkpointer = createFsCheckpointer(root);

    const resumed = await runGolden({
      projectRoot: root,
      runId: RUN,
      behaviour: { contracts: goldenContracts(2) },
      checkpointer,
      resumeFrom: { ref: { runId: RUN, superstep } },
    });

    // The frontier was emptied by the skip, so the loop had nothing to run at all.
    expect(resumed.dispatchLog.total()).toBe(0);
    expect(Object.keys(resumed.handlerLog.calls)).toEqual([]);

    // And the skip is a RECORDED fact, not an absence.
    const skipped = resumed.spans.filter((span) => span.status === "skipped");
    expect(skipped.length).toBe(taskKeys.length);
    expect(skipped.map((span) => span.inputHash).sort()).toEqual([...taskKeys].sort());
  });

  it("proves the spy really distinguishes dispatch from execution", async () => {
    // Control: an ordinary run dispatches exactly as many thunks as handler bodies it
    // enters. If the interpreter ever dispatched-then-skipped, this equality would break
    // and the assertion above would no longer mean what it claims.
    const run = await runGolden({
      projectRoot: root,
      runId: RUN,
      behaviour: { contracts: goldenContracts(2) },
      checkpointer: createFsCheckpointer(root),
    });
    const executed = Object.values(run.handlerLog.calls).reduce((a, b) => a + b, 0);
    expect(run.dispatchLog.total()).toBe(executed);
    expect(executed).toBeGreaterThan(10);
  });

  it("does NOT skip a bounded rework cycle that re-enters a node with the same task key", async () => {
    // `taskKey = sha256(nodeId + branchKey + inputHash)`, so a rework loop re-enters
    // `sprint_generate` with a key it already carried. Treating `completedTaskKeys` as
    // "every key ever completed" would silently prune the second iteration.
    const run = await runGolden({
      projectRoot: root,
      runId: RUN,
      behaviour: {
        contracts: goldenContracts(2),
        reworkBranches: ["sprint-golden-1"],
      },
      checkpointer: createFsCheckpointer(root),
    });

    expect(run.result.status).toBe("completed");
    expect(run.handlerLog.calls[GOLDEN_NODES.generate]).toBe(3);
    expect(run.finalState.counters["attempts.sprint-golden-1"]).toBe(2);
    expect(run.spans.filter((s) => s.status === "skipped")).toEqual([]);
  });

  it("drops a re-enqueued key from completedTaskKeys, so a mid-rework checkpoint stays resumable", async () => {
    // The consequence of the rule above, ON DISK. If `completedTaskKeys` still named the
    // generate task while the SAME key sat in `pending`, resuming from that checkpoint
    // would skip the rework iteration and the branch would never be corrected — silently,
    // and only on the resume path.
    const checkpointer = createFsCheckpointer(root);
    await runGolden({
      projectRoot: root,
      runId: RUN,
      behaviour: {
        contracts: goldenContracts(2),
        reworkBranches: ["sprint-golden-1"],
      },
      checkpointer,
    });

    let inspected = 0;
    for (const superstep of await listCheckpointFiles(root, RUN)) {
      const checkpoint = await checkpointer.get({ runId: RUN, superstep });
      const completed = new Set(checkpoint.completedTaskKeys);
      for (const task of checkpoint.pending) {
        expect(
          completed.has(task.taskKey),
          `checkpoint ${String(superstep)} lists pending ${task.nodeId} as already completed`,
        ).toBe(false);
        inspected += 1;
      }
    }
    expect(inspected).toBeGreaterThan(10);

    // And the rework really did re-enter the generator with a key it had carried before.
    const generateKeys = new Set<string>();
    for (const superstep of await listCheckpointFiles(root, RUN)) {
      const checkpoint = await checkpointer.get({ runId: RUN, superstep });
      for (const task of checkpoint.pending) {
        if (task.nodeId === GOLDEN_NODES.generate && task.branchKey === "sprint-golden-1") {
          generateKeys.add(task.taskKey);
        }
      }
    }
    expect(generateKeys.size).toBe(1);
  });
});

// ── Nested checkpointer (sc-8-9) ────────────────────────────────────

describe("NESTED CHECKPOINTER: refused before any node executes (sc-8-9)", () => {
  it("runs the golden graph, whose one subgraph inherits the parent handle", async () => {
    const run = await runGolden({
      projectRoot: root,
      runId: RUN,
      behaviour: { contracts: goldenContracts(1) },
      checkpointer: createFsCheckpointer(root),
    });
    expect(goldenSpec().subgraphs[0].persistence).toBe("inherit");
    expect(run.result.status).toBe("completed");
  });

  it("refuses a hand-edited artifact with NestedCheckpointer, with zero handler invocations", async () => {
    const handEdited = {
      ...goldenSpec(),
      subgraphs: [{ ...goldenSpec().subgraphs[0], persistence: "own" }],
    } as unknown as TopologySpec;

    let handlerCalls: Record<string, number> = {};
    await expect(
      runGolden({
        projectRoot: root,
        runId: RUN,
        behaviour: { contracts: goldenContracts(1) },
        checkpointer: createFsCheckpointer(root),
        spec: handEdited,
        onCompiled: (info) => {
          handlerCalls = info.handlerLog.calls;
        },
      }),
    ).rejects.toThrow(NestedCheckpointerError);

    // BEFORE any node executed, and before any checkpoint existed.
    expect(handlerCalls).toEqual({});
    expect(await listCheckpointFiles(root, RUN)).toEqual([]);
  });

  it("refuses the same artifact on the resume path too", async () => {
    const checkpointer = createFsCheckpointer(root);
    await runGolden({
      projectRoot: root,
      runId: RUN,
      behaviour: { contracts: goldenContracts(1) },
      checkpointer,
    });
    const handEdited = {
      ...goldenSpec(),
      subgraphs: [{ ...goldenSpec().subgraphs[0], persistence: "own" }],
    } as unknown as TopologySpec;

    await expect(
      runGolden({
        projectRoot: root,
        runId: RUN,
        behaviour: { contracts: goldenContracts(1) },
        checkpointer,
        spec: handEdited,
        resumeFrom: { ref: { runId: RUN, superstep: 0 } },
      }),
    ).rejects.toThrow(NestedCheckpointerError);
  });
});

// ── Readability (ADR-5's stated reason for the filesystem) ──────────

describe("a checkpoint stays inspectable", () => {
  it("can be read with a plain readFile and JSON.parse", async () => {
    await runGolden({
      projectRoot: root,
      runId: RUN,
      behaviour: { contracts: goldenContracts(1) },
      checkpointer: createFsCheckpointer(root),
    });
    const raw = await readFile(checkpointPath(root, RUN, 0), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.runId).toBe(RUN);
    expect(parsed.graphId).toBe("golden");
    expect(raw).toContain('\n  "');
  });
});
