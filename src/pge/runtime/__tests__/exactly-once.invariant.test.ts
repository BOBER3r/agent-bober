import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CONTROL_KEYS } from "../commit.js";
import { readArtifactTree } from "../__fixtures__/artifact-tree.js";
import { GOLDEN_NODES, goldenContracts } from "../__fixtures__/golden-graph.js";
import { runGolden } from "../__fixtures__/run-harness.js";
import type { GoldenRun } from "../__fixtures__/run-harness.js";

/**
 * BLOCKING INVARIANT SUITE 2 of 3 — EXACTLY-ONCE COMMIT.
 *
 * ADR-1's stated risk is that commit semantics fail SILENTLY: a double-applied side effect
 * does not throw, it just makes the artifact wrong in a way that is later attributed to
 * the model. So nothing here asserts that a file exists — "the contract is on disk" is
 * equally true after one write and after four. Every assertion counts REAL invocations:
 *
 *  - `reducerLog` counts calls to `Reducer.merge`, taken at the commit boundary, which is
 *    where a channel is actually written. Counting node returns instead would count how
 *    many updates were produced, not how many times state was written.
 *  - `artifactLog` counts calls to `saveContract` / `saveSpec`, taken by wrapping the SAME
 *    `src/state/` functions the shipped engines use, and then performing the write.
 *
 * ── Mutation-proven ──
 *
 * This suite was run against two deliberate breakages and failed on each:
 *  - `CommitBoundary.commit` folding the batch pairwise (`for (const u of updates) state =
 *    merge(state, [u])`), which turns one write per channel into one per update;
 *  - the boundary's `persistIfChanged` memo removed, so a rework loop re-writing an
 *    identical contract performs a second real `saveContract`.
 */

const CONTROL = new Set<string>(CONTROL_KEYS);

let root = "";
let otherRoot = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bober-pge-once-"));
  otherRoot = await mkdtemp(join(tmpdir(), "bober-pge-once-seq-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(otherRoot, { recursive: true, force: true });
});

function eightBranches(projectRoot: string, concurrency: number): Promise<GoldenRun> {
  return runGolden({
    projectRoot,
    runId: "run-exactly-once",
    concurrency,
    finalize: true,
    behaviour: {
      contracts: goldenContracts(8),
      reworkBranches: ["sprint-golden-3", "sprint-golden-7"],
      stagger: (key) => (key.charCodeAt(key.length - 1) * 3) % 4,
    },
  });
}

describe("EXACTLY-ONCE: one write per channel per superstep across 8 branches (sc-7-7)", () => {
  it("reports writesPerChannel === 1 for every touched channel of every superstep", async () => {
    const run = await eightBranches(root, 8);
    expect(run.result.status).toBe("completed");
    expect(run.result.commits.length).toBeGreaterThan(5);

    let touched = 0;
    for (const commit of run.result.commits) {
      for (const [channel, writes] of Object.entries(commit.writesPerChannel)) {
        expect(writes, `${channel} at superstep ${String(commit.superstep)}`).toBe(1);
        touched += 1;
      }
    }
    expect(touched).toBeGreaterThan(15);

    // At least one superstep really did merge eight branch updates into ONE write; without
    // that the assertion above is satisfied by a run that never fanned out.
    const widest = Math.max(
      ...run.result.commits.map((c) => Math.max(0, ...Object.values(c.batchSizePerChannel))),
    );
    expect(widest).toBe(8);
  });

  it("invokes the reducers exactly as many times as there are channel writes", async () => {
    const run = await eightBranches(root, 8);

    // Every non-control channel write is one — and only one — `Reducer.merge` call.
    const reducedWrites = run.result.commits.flatMap((commit) =>
      Object.keys(commit.writesPerChannel).filter((channel) => !CONTROL.has(channel)),
    );
    expect(run.reducerLog.invocations).toHaveLength(reducedWrites.length);

    // And every invocation was handed a whole batch, never a single update at a time when
    // several were available.
    const batches = run.reducerLog.invocations.map((i) => i.batchSize);
    expect(Math.min(...batches)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...batches)).toBe(8);
    expect(batches.reduce((a, b) => a + b, 0)).toBe(
      run.result.commits.reduce(
        (total, commit) =>
          total +
          Object.entries(commit.batchSizePerChannel)
            .filter(([channel]) => !CONTROL.has(channel))
            .reduce((sum, [, size]) => sum + size, 0),
        0,
      ),
    );
  });

  it("writes each domain artifact once per DISTINCT value, and never twice for the same bytes", async () => {
    const run = await eightBranches(root, 8);

    // The spec is written exactly once: one writer, one value, one write for the whole run.
    expect(run.artifactLog.specs).toEqual(["spec-golden-1"]);

    // Each contract is written twice and no more: once when the planner emits it, once when
    // its branch flips the status to passed. Two DIFFERENT values, therefore two writes.
    const perContract = new Map<string, number>();
    for (const id of run.artifactLog.contracts) perContract.set(id, (perContract.get(id) ?? 0) + 1);
    expect([...perContract.keys()].sort()).toEqual(goldenContracts(8).map((c) => c.contractId).sort());
    for (const [id, count] of perContract) {
      expect(count, `contract ${id} was written ${String(count)} times`).toBe(2);
    }

    const onDisk = await readdir(join(root, ".bober", "contracts"));
    expect(onDisk).toHaveLength(8);
  });

  it("does not double-apply through a REWORK LOOP", async () => {
    const run = await eightBranches(root, 8);

    // Two branches genuinely re-entered the generator.
    const regenerated = run.spans.filter((s) => s.nodeId === GOLDEN_NODES.generate);
    expect(regenerated).toHaveLength(10);
    expect(run.finalState.counters["attempts.sprint-golden-3"]).toBe(2);

    // The reworked branch's messages are distinct rows, not duplicated ones, and the
    // rework did not produce a second contract write for a value that had not changed.
    const reworkMessages = run.finalState.messages.filter((m) =>
      m.id.startsWith("m-gen-sprint-golden-3-"),
    );
    expect(reworkMessages.map((m) => m.id)).toEqual([
      "m-gen-sprint-golden-3-1",
      "m-gen-sprint-golden-3-2",
    ]);
    expect(run.artifactLog.contracts.filter((id) => id === "sprint-golden-3")).toHaveLength(2);

    // The evaluations channel holds one row per (branch, attempt) — the reducer's identity
    // union, not an append that grew with every re-delivery.
    expect(run.finalState.evaluations).toHaveLength(10);
    expect(new Set(run.finalState.evaluations.map((e) => e.id)).size).toBe(10);
  });

  it("does not double-apply after a SIBLING FAILS", async () => {
    const run = await runGolden({
      projectRoot: root,
      runId: "run-exactly-once",
      concurrency: 8,
      behaviour: {
        contracts: goldenContracts(8),
        failingBranches: ["sprint-golden-4"],
        reworkBranches: ["sprint-golden-2"],
      },
    });

    expect(run.result.failures.map((f) => f.branchKey)).toEqual(["sprint-golden-4"]);
    for (const commit of run.result.commits) {
      for (const writes of Object.values(commit.writesPerChannel)) expect(writes).toBe(1);
    }

    // The seven survivors each wrote their contract exactly twice; the failed branch's
    // contract was written once, by the planner, and never updated.
    const perContract = new Map<string, number>();
    for (const id of run.artifactLog.contracts) perContract.set(id, (perContract.get(id) ?? 0) + 1);
    expect(perContract.get("sprint-golden-4")).toBe(1);
    expect(perContract.get("sprint-golden-1")).toBe(2);
    expect(run.finalState.sprintContracts.filter((c) => c.status === "passed")).toHaveLength(7);
  });

  it("produces artifacts byte-identical to the sequential run of the same inputs", async () => {
    await eightBranches(root, 8);
    await eightBranches(otherRoot, 1);

    const concurrent = await readArtifactTree(root);
    const sequential = await readArtifactTree(otherRoot);
    expect([...concurrent.keys()]).toEqual([...sequential.keys()]);
    for (const [path, bytes] of concurrent) {
      expect(sequential.get(path), `artifact ${path}`).toBe(bytes);
    }
  });
});
