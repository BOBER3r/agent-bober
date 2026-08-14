import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDefaultConfig } from "../../../config/schema.js";
import type { BoberConfig } from "../../../config/schema.js";
import { compile } from "../../compile/compiler.js";
import { createCommitBoundary } from "../commit.js";
import type { ChannelUpdate } from "../commit.js";
import {
  GOLDEN_NODES,
  goldenContractId,
  goldenContracts,
  goldenInitialState,
  goldenRegistries,
  goldenSpec,
} from "../__fixtures__/golden-graph.js";
import { runGolden } from "../__fixtures__/run-harness.js";

/**
 * BLOCKING INVARIANT SUITE 4 — BARRIER CORRECTNESS.
 *
 * Two claims, and the second is the one that is easy to get silently wrong:
 *
 *  1. The stage after a fan-out runs only once the LAST branch has committed, and observes
 *     every branch exactly once.
 *  2. The reduction of that batch is INDEPENDENT OF ARRIVAL ORDER. The reducers are a
 *     join-semilattice (associative, commutative, idempotent) and `reducers.test.ts` proves
 *     those laws in isolation; what is exercised HERE is that the commit boundary actually
 *     relies on them — one invocation with the whole batch — rather than folding pairwise
 *     and reintroducing order dependence one layer up.
 *
 * Ordering assertions read the injected MONOTONIC LOGICAL CLOCK. Nothing asserts elapsed
 * time, and nothing would change meaning on a slower machine.
 *
 * ── Mutation-proven ──
 *
 * This suite was run against two deliberate breakages and failed on each:
 *  - the interpreter flushing the join buffer whenever it was non-empty, instead of only
 *    when `activeBranches` had drained (the evaluator then observed 1 result, not N);
 *  - `CommitBoundary.commit` folding the batch update-by-update, which broke the
 *    shuffle-invariance assertion below.
 */

let root = "";

function referenceConfig(): BoberConfig {
  return createDefaultConfig("barrier-fixture", "brownfield");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bober-pge-barrier-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("BARRIER: the fan-in stage waits for every branch (sc-7-6)", () => {
  it("runs the evaluator strictly after the last branch, observing exactly N results", async () => {
    const completionOrder: string[] = [];
    const branchCount = 6;

    const run = await runGolden({
      projectRoot: root,
      concurrency: 8,
      behaviour: {
        contracts: goldenContracts(branchCount),
        reworkBranches: [goldenContractId(2), goldenContractId(5)],
        // Deliberately staggered: the branches finish in an order unrelated to their index.
        stagger: (key) => [3, 0, 4, 1, 5, 2][Number(key.slice(-1)) - 1] ?? 0,
        onBranchNode: (event, nodeId, branchKey) => {
          if (event === "end" && nodeId === GOLDEN_NODES.sprintOut) completionOrder.push(branchKey);
        },
      },
    });

    expect(run.result.status).toBe("completed");
    expect(completionOrder).toHaveLength(branchCount);
    // The stagger really did scramble completion — otherwise the barrier is untested.
    expect(completionOrder).not.toEqual(
      goldenContracts(branchCount).map((c) => c.contractId),
    );

    const branchEnds = run.spans
      .filter((s) => s.branchKey !== null && s.status === "ok")
      .map((s) => s.endedAt);
    const evaluator = run.spans.find((s) => s.nodeId === GOLDEN_NODES.evaluateGlobal);
    expect(evaluator).toBeDefined();
    if (!evaluator) return;

    // FIRST invocation of the evaluator stage is after the LAST branch completion.
    const lastBranchEnd = branchEnds.sort().at(-1) as string;
    expect(evaluator.startedAt > lastBranchEnd).toBe(true);
    expect(evaluator.superstep).toBeGreaterThan(
      Math.max(...run.spans.filter((s) => s.branchKey !== null).map((s) => s.superstep)),
    );

    // It observed EXACTLY N branches — one verdict per branch attempt, one status per branch.
    expect(Object.keys(run.finalState.branchStatus)).toHaveLength(branchCount);
    const observed = run.finalState.messages.find((m) => m.id === "m-eval-global");
    // The message carries the ORDER the join delivered the branches in — sorted by branch
    // key, never by which finished first — so a regression in the join reaches a committed
    // artifact instead of hiding inside an in-memory value.
    expect(observed?.text).toBe(
      `observed ${String(branchCount + 2)} verdicts from [${goldenContracts(branchCount)
        .map((c) => c.contractId)
        .join(",")}]`,
    );
    expect(run.spans.filter((s) => s.nodeId === GOLDEN_NODES.evaluateGlobal)).toHaveLength(1);
  });

  it("joins the branches ONCE, not once per branch", async () => {
    const run = await runGolden({
      projectRoot: root,
      concurrency: 8,
      behaviour: { contracts: goldenContracts(4) },
    });

    // The supervisor is the join target. It ran three times in total — dispatch, evaluate,
    // done — and never four extra times, one per returning branch.
    const supervisorSpans = run.spans.filter((s) => s.nodeId === GOLDEN_NODES.supervisor);
    expect(supervisorSpans.map((s) => s.route?.label)).toEqual(["sprints", "evaluate", "done"]);
    expect(run.spans.filter((s) => s.nodeId === GOLDEN_NODES.evalIn)).toHaveLength(1);
  });

  it("reduces each channel exactly once per superstep, whatever the branch count", async () => {
    for (const branches of [2, 5, 8]) {
      const perRunRoot = await mkdtemp(join(tmpdir(), "bober-pge-barrier-n-"));
      try {
        const run = await runGolden({
          projectRoot: perRunRoot,
          concurrency: 8,
          behaviour: { contracts: goldenContracts(branches) },
        });
        for (const commit of run.result.commits) {
          for (const writes of Object.values(commit.writesPerChannel)) expect(writes).toBe(1);
        }
        const widest = Math.max(
          ...run.result.commits.map((c) => Math.max(0, ...Object.values(c.batchSizePerChannel))),
        );
        expect(widest).toBe(branches);
      } finally {
        await rm(perRunRoot, { recursive: true, force: true });
      }
    }
  });
});

describe("BARRIER: the reduction is independent of arrival order", () => {
  const graph = (): ReturnType<typeof compile> =>
    compile(goldenSpec(), goldenRegistries({ contracts: goldenContracts(1) }));

  function branchBatch(): ChannelUpdate[] {
    return goldenContracts(6).flatMap((contract, index) => [
      {
        channel: "messages",
        nodeId: GOLDEN_NODES.generate,
        branchKey: contract.contractId,
        value: [
          {
            id: `m-${contract.contractId}`,
            seq: index,
            role: "assistant",
            nodeId: GOLDEN_NODES.generate,
            text: `branch ${contract.contractId}`,
            tokens: 4,
          },
        ],
      },
      {
        channel: "branchStatus",
        nodeId: GOLDEN_NODES.sprintOut,
        branchKey: contract.contractId,
        value: { [contract.contractId]: { state: "succeeded", attempts: 1 } },
      },
      {
        channel: "counters",
        nodeId: GOLDEN_NODES.route,
        branchKey: contract.contractId,
        value: { [`iterations.${contract.contractId}`]: index + 1 },
      },
      {
        channel: "testAnchors",
        nodeId: GOLDEN_NODES.evaluate,
        branchKey: contract.contractId,
        value: [`anchor:${contract.contractId}`],
      },
    ]);
  }

  /** A deterministic shuffle, so a failure is reproducible from the seed alone. */
  function shuffle<T>(items: readonly T[], seed: number): T[] {
    const out = [...items];
    let state = seed;
    for (let i = out.length - 1; i > 0; i -= 1) {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      const j = state % (i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  it("commits identical bytes for 24 shuffles of the same batch", async () => {
    const compiled = graph();
    const initial = goldenInitialState("run-barrier", root);
    const reference = await createCommitBoundary().commit(compiled, initial, branchBatch(), {
      runId: "run-barrier",
      projectRoot: root,
      config: referenceConfig(),
      superstep: 0,
      startedAtMs: 0,
    });
    const expected = JSON.stringify(reference.state);

    for (let seed = 1; seed <= 24; seed += 1) {
      const shuffled = shuffle(branchBatch(), seed);
      const result = await createCommitBoundary().commit(compiled, initial, shuffled, {
        runId: "run-barrier",
        projectRoot: root,
        config: referenceConfig(),
        superstep: 0,
        startedAtMs: 0,
      });
      expect(JSON.stringify(result.state), `shuffle seed ${String(seed)}`).toBe(expected);
      expect(result.writesPerChannel).toEqual(reference.writesPerChannel);
    }
  });

  it("commits the same bytes whether the batch arrives whole or in two halves", async () => {
    const compiled = graph();
    const initial = goldenInitialState("run-barrier", root);
    const batch = branchBatch();

    const whole = await createCommitBoundary().commit(compiled, initial, batch, {
      runId: "run-barrier",
      projectRoot: root,
      config: referenceConfig(),
      superstep: 0,
      startedAtMs: 0,
    });

    const halves = createCommitBoundary();
    const first = await halves.commit(compiled, initial, batch.slice(0, 12), {
      runId: "run-barrier",
      projectRoot: root,
      config: referenceConfig(),
      superstep: 0,
      startedAtMs: 0,
    });
    const second = await halves.commit(compiled, first.state, batch.slice(12), {
      runId: "run-barrier",
      projectRoot: root,
      config: referenceConfig(),
      superstep: 1,
      startedAtMs: 0,
    });

    // Batching invariance: merge(merge(s, xs), ys) === merge(s, [...xs, ...ys]).
    // This is what makes concurrency 1 (many small batches) and concurrency 8 (one large
    // batch) commit the same state.
    expect(JSON.stringify(second.state)).toBe(JSON.stringify(whole.state));
  });

  it("is idempotent: re-delivering the same batch changes nothing", async () => {
    const compiled = graph();
    const boundary = createCommitBoundary();
    const first = await boundary.commit(
      compiled,
      goldenInitialState("run-barrier", root),
      branchBatch(),
      { runId: "run-barrier", projectRoot: root, config: referenceConfig(), superstep: 0, startedAtMs: 0 },
    );
    const again = await boundary.commit(compiled, first.state, branchBatch(), {
      runId: "run-barrier",
      projectRoot: root,
      config: referenceConfig(),
      superstep: 1,
      startedAtMs: 0,
    });
    expect(JSON.stringify(again.state)).toBe(JSON.stringify(first.state));
  });
});
