import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TopologySpecSchema } from "../../../contracts/topology.js";
import type { LoopBound, TopologySpec } from "../../../contracts/topology.js";
import { canonicalJson } from "../../registry/reducers.js";
import type { NodeImpl } from "../../registry/nodes.js";
import { checksumTopology } from "../../topology/canonical.js";
import { createFsCheckpointer } from "../checkpointer.js";
import type { CheckpointRef, GraphCheckpointer } from "../checkpointer.js";
import { readFailureArtifact, synthesizeBranchOutcomes } from "../graceful-failure.js";
import {
  GRACEFUL_FAILURE_NODE_ID,
  LOOP_EXHAUSTED_ERROR_CLASS,
  RETRIES_EXHAUSTED_ERROR_CLASS,
  loopCounterKey,
} from "../interpreter.js";
import { createRetryPlanner } from "../retry-planner.js";
import type { RetryPolicy } from "../retry-planner.js";
import { GOLDEN_NODES, goldenContractId, goldenContracts, goldenSpec } from "../__fixtures__/golden-graph.js";
import type { GoldenBehaviour } from "../__fixtures__/golden-graph.js";
import { runGolden } from "../__fixtures__/run-harness.js";
import type { GoldenRun } from "../__fixtures__/run-harness.js";

/**
 * BLOCKING INVARIANT SUITE — PARTIAL-FAILURE RESILIENCE.
 *
 * sc-9-1 cached branch results across a re-run; sc-9-2 failed-branch-only retry on the
 * jittered schedule; sc-9-3 the attempt budget, the graceful terminal and its artifact;
 * sc-9-4 loop bounds read off the artifact; sc-9-5 a counter that survives a replayed
 * superstep; sc-9-6 a qualified synthesis and a `partial` verdict; sc-9-7 concurrent
 * per-branch `branchStatus` merges.
 *
 * ── What "the executor did not re-run" is asserted against ──
 *
 * `GoldenBehaviour.onBranchNode` fires INSIDE the node body, once per entry, so a retried
 * attempt is a real second entry and a skipped task is a real absence. It is counted
 * across BOTH runs of the resume pair, not just the second, because "branch 1 ran once in
 * total" is the claim and a count taken only after the resume would be satisfied by a
 * first run that ran it five times.
 *
 * ── No test here waits ──
 *
 * Every retry policy is built with an injected `sleep` that advances a virtual clock and
 * resolves immediately. The intervals asserted are the intervals the policy ASKED for, and
 * they are asserted as membership in the envelope `[0.5 * raw, raw]` rather than as pinned
 * values, because the jitter source is deliberately not pinned.
 *
 * ── Mutation-proven ──
 *
 * Run against seven deliberate breakages, and failed on each:
 *  - the `ctx.retry.run` wrapper removed from `executeTask`, so a handler is entered once
 *    (sc-9-2, sc-9-3, sc-9-6 and sc-9-7 all fail);
 *  - `maxRetries: maxAttempts` rather than `maxAttempts - 1` (four attempts, not three);
 *  - `boundedDestination` returning `result.destination` unconditionally, which turns the
 *    always-retry fixture into a `SuperstepLimitExceededError` at the ceiling;
 *  - the loop counter held in an interpreter-local `Map` instead of the `counters` channel,
 *    which resets on resume and lets the replayed run take three MORE iterations;
 *  - `verdictFrom` returning a declared `"failed"` verbatim, which reports a run with two
 *    committed contracts as a total failure;
 *  - the graceful-failure enqueue removed, so an exhausted branch is dropped, the terminal
 *    never runs and no artifact is written;
 *  - the `branchStatus` failure record removed, so the synthesis cannot name what failed.
 */

const RUN_ID = "run-partial-failure";
const BRANCH_1 = goldenContractId(1);
const BRANCH_2 = goldenContractId(2);
const BRANCH_3 = goldenContractId(3);

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bober-pge-partial-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// ── Injected backoff clock ──────────────────────────────────────────

interface VirtualBackoff {
  readonly delays: number[];
  readonly stamps: number[];
  sleep(ms: number): Promise<void>;
  jitter(): number;
}

/** Advances a virtual now, resolves at once, schedules no timer. */
function virtualBackoff(jitter = 0.5): VirtualBackoff {
  const delays: number[] = [];
  const stamps: number[] = [];
  let now = 0;
  return {
    delays,
    stamps,
    sleep(ms: number): Promise<void> {
      delays.push(ms);
      now += ms;
      stamps.push(now);
      return Promise.resolve();
    },
    jitter: () => jitter,
  };
}

const BASE_DELAY_MS = 100;
const FACTOR = 2;

function policyWith(clock: VirtualBackoff, maxAttempts = 3): RetryPolicy {
  return createRetryPlanner({
    maxAttempts,
    baseDelayMs: BASE_DELAY_MS,
    factor: FACTOR,
    sleep: (ms) => clock.sleep(ms),
    jitter: () => clock.jitter(),
  });
}

// ── Branch-node spy ─────────────────────────────────────────────────

interface BranchEntry {
  readonly run: number;
  readonly node: string;
  readonly branch: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The checkpoint whose frontier holds the fan-in JOIN task, i.e. every branch has settled. */
async function joinCheckpoint(
  checkpointer: GraphCheckpointer,
  runId: string,
): Promise<CheckpointRef> {
  const refs: CheckpointRef[] = [];
  for await (const ref of checkpointer.list(runId)) refs.push(ref);
  for (const ref of refs) {
    const checkpoint = await checkpointer.get(ref);
    const joined = checkpoint.pending.some(
      (task) =>
        task.nodeId === GOLDEN_NODES.supervisor &&
        isRecord(task.input) &&
        Array.isArray(task.input.fanIn),
    );
    if (joined) return ref;
  }
  throw new Error("the run wrote no post-join checkpoint");
}

// ── sc-9-1 / sc-9-2 ──────────────────────────────────────────────────

interface ResumePair {
  readonly first: GoldenRun;
  readonly second: GoldenRun;
  readonly entries: readonly BranchEntry[];
  readonly policy: RetryPolicy;
  readonly clock: VirtualBackoff;
  /** Spans the RESUMED run wrote; the trace file is append-only across both. */
  readonly secondSpans: GoldenRun["spans"];
}

/**
 * Three branches, branch 2 permanently failing on a transient provider error, run to
 * completion and then resumed from the checkpoint taken once every branch had settled.
 */
async function runResumePair(projectRoot: string): Promise<ResumePair> {
  const entries: BranchEntry[] = [];
  let phase = 1;
  const contracts = goldenContracts(3);
  const clock = virtualBackoff();
  const policy = policyWith(clock);
  const checkpointer = createFsCheckpointer(projectRoot);

  const behaviour = (): GoldenBehaviour => ({
    contracts,
    transientFailures: { [BRANCH_2]: 99 },
    recordFailureArtifact: true,
    onBranchNode: (event, nodeId, branchKey) => {
      if (event === "start") entries.push({ run: phase, node: nodeId, branch: branchKey });
    },
  });

  const first = await runGolden({
    projectRoot,
    runId: RUN_ID,
    concurrency: 3,
    maxSupersteps: 40,
    checkpointer,
    durability: "superstep",
    retry: policy,
    behaviour: behaviour(),
  });

  phase = 2;
  const ref = await joinCheckpoint(checkpointer, RUN_ID);
  const second = await runGolden({
    projectRoot,
    runId: RUN_ID,
    concurrency: 3,
    maxSupersteps: 40,
    checkpointer,
    durability: "superstep",
    retry: policy,
    behaviour: behaviour(),
    resumeFrom: { ref },
  });

  return {
    first,
    second,
    entries,
    policy,
    clock,
    secondSpans: second.spans.slice(first.spans.length),
  };
}

function starts(entries: readonly BranchEntry[], branch: string, node: string): BranchEntry[] {
  return entries.filter((e) => e.branch === branch && e.node === node);
}

describe("a failed branch is a local event: siblings persist and are reused (sc-9-1)", () => {
  it("commits branch 1 and 3 while branch 2 fails, and the run still finishes", async () => {
    const { first } = await runResumePair(root);

    expect(first.result.status).toBe("completed");
    if (first.result.status !== "completed") return;
    expect(first.result.failures.map((f) => f.branchKey)).toEqual([BRANCH_2]);
    expect(first.finalState.sprintContracts.filter((c) => c.status === "passed")).toHaveLength(2);
    expect(
      first.spans.filter((s) => s.nodeId === GOLDEN_NODES.sprintOut).map((s) => s.branchKey).sort(),
    ).toEqual([BRANCH_1, BRANCH_3]);
    expect(first.result.supersteps).toBeLessThan(40);
  });

  it("re-runs from the checkpoint with ZERO further branch-executor invocations", async () => {
    const { first, entries, second, secondSpans } = await runResumePair(root);

    expect(second.result.status).toBe("completed");
    // Not a vacuous resume: it really did execute the tail of the run.
    expect(secondSpans.length).toBeGreaterThan(3);
    expect(second.dispatchLog.total()).toBeGreaterThan(3);

    // ...and every one of those executions was root-scope. No branch body ran again.
    expect(entries.filter((e) => e.run === 2)).toEqual([]);
    expect(secondSpans.every((s) => s.branchKey === null)).toBe(true);
    expect(second.handlerLog.calls[GOLDEN_NODES.generate]).toBeUndefined();
    expect(second.handlerLog.calls[GOLDEN_NODES.sprintBody]).toBeUndefined();

    // The CACHED results are what the resumed run finished on: it re-derived nothing.
    expect(second.finalState.sprintContracts.filter((c) => c.status === "passed")).toHaveLength(2);
    expect(Object.keys(second.finalState.branchStatus).sort()).toEqual(
      [BRANCH_1, BRANCH_2, BRANCH_3].sort(),
    );
    expect(second.result.status === "completed" && second.result.verdict).toBe("partial");
    expect(first.result.status === "completed" && first.result.verdict).toBe("partial");
  });
});

describe("only the failed branch is retried, on the declared schedule (sc-9-2)", () => {
  it("retries branch 2 and NOTHING else", async () => {
    const { policy } = await runResumePair(root);

    const history = policy.history();
    expect(history.length).toBeGreaterThan(0);
    expect([...new Set(history.map((a) => a.branchKey))]).toEqual([BRANCH_2]);
    expect([...new Set(history.map((a) => a.nodeId))]).toEqual([GOLDEN_NODES.generate]);
    expect([...new Set(history.map((a) => a.errorClass))]).toEqual(["TransientProviderError"]);
  });

  it("invokes the branch 1 and branch 3 generators exactly ONCE IN TOTAL across both runs", async () => {
    const { entries } = await runResumePair(root);

    expect(starts(entries, BRANCH_1, GOLDEN_NODES.generate)).toHaveLength(1);
    expect(starts(entries, BRANCH_3, GOLDEN_NODES.generate)).toHaveLength(1);
    // Every other node of those two branches likewise ran once and only once.
    for (const branch of [BRANCH_1, BRANCH_3]) {
      for (const node of [
        GOLDEN_NODES.sprintBody,
        GOLDEN_NODES.sprintIn,
        GOLDEN_NODES.evaluate,
        GOLDEN_NODES.route,
        GOLDEN_NODES.sprintOut,
      ]) {
        expect(starts(entries, branch, node), `${branch}/${node}`).toHaveLength(1);
      }
    }
    // The failed branch, by contrast, entered its generator once per attempt.
    expect(starts(entries, BRANCH_2, GOLDEN_NODES.generate)).toHaveLength(3);
  });

  it("spaces the retries inside the policy's jittered exponential envelope", async () => {
    const { clock, policy } = await runResumePair(root);

    expect(clock.delays).toHaveLength(policy.history().length);
    expect(clock.delays).toHaveLength(2);

    const intervals = clock.stamps.map((stamp, i) => (i === 0 ? stamp : stamp - clock.stamps[i - 1]));
    intervals.forEach((interval, n) => {
      const ceiling = BASE_DELAY_MS * FACTOR ** n;
      expect(interval, `retry ${String(n + 1)} lower bound`).toBeGreaterThanOrEqual(
        0.5 * ceiling - 1e-9,
      );
      expect(interval, `retry ${String(n + 1)} upper bound`).toBeLessThanOrEqual(ceiling + 1e-9);
    });
    // The schedule grew rather than repeating one delay.
    expect(intervals[1]).toBeGreaterThan(intervals[0]);
  });
});

// ── sc-9-3 ───────────────────────────────────────────────────────────

describe("an exhausted branch reaches the graceful terminal and is recorded (sc-9-3)", () => {
  it("attempts exactly three times, writes .bober/failures/<runId>.json and ends cleanly", async () => {
    const clock = virtualBackoff();
    const policy = policyWith(clock, 3);
    const entries: BranchEntry[] = [];

    const run = await runGolden({
      projectRoot: root,
      runId: RUN_ID,
      concurrency: 3,
      maxSupersteps: 40,
      retry: policy,
      behaviour: {
        contracts: goldenContracts(3),
        transientFailures: { [BRANCH_1]: 99 },
        recordFailureArtifact: true,
        onBranchNode: (event, nodeId, branchKey) => {
          if (event === "start") entries.push({ run: 1, node: nodeId, branch: branchKey });
        },
      },
    });

    expect(run.result.status).toBe("completed");
    expect(starts(entries, BRANCH_1, GOLDEN_NODES.generate)).toHaveLength(3);
    expect(policy.attemptsFor(policy.history()[0].taskKey)).toBe(3);

    // It REACHED the terminal, rather than the run merely surviving the branch.
    expect(run.spans.some((s) => s.nodeId === GRACEFUL_FAILURE_NODE_ID)).toBe(true);
    expect(run.handlerLog.calls[GRACEFUL_FAILURE_NODE_ID]).toBe(1);

    const artifact = await readFailureArtifact(root, RUN_ID);
    expect(artifact).toBeDefined();
    expect(artifact?.reason).toBe(RETRIES_EXHAUSTED_ERROR_CLASS);
    expect(artifact?.branches.map((b) => b.branchKey)).toEqual([BRANCH_1]);
    expect(artifact?.branches[0].attempts).toBe(3);
    expect(artifact?.branches[0].errorClass).toBe("TransientProviderError");
    expect(artifact?.branches[0].contractId).toBe(BRANCH_1);
    expect(artifact?.branches[0].nodeId).toBe(GOLDEN_NODES.generate);

    // The test's own ceiling was never reached: it terminated by decision, not by guard.
    expect(run.result.supersteps).toBeLessThan(40);
    expect(run.result.status === "completed" && run.result.verdict).toBe("partial");
  });

  it("writes ONE terminal task however many branches exhaust in the same superstep", async () => {
    const clock = virtualBackoff();
    const run = await runGolden({
      projectRoot: root,
      runId: RUN_ID,
      concurrency: 4,
      maxSupersteps: 40,
      retry: policyWith(clock, 2),
      behaviour: {
        contracts: goldenContracts(4),
        transientFailures: { [BRANCH_1]: 99, [BRANCH_2]: 99, [BRANCH_3]: 99 },
        recordFailureArtifact: true,
      },
    });

    expect(run.handlerLog.calls[GRACEFUL_FAILURE_NODE_ID]).toBe(1);
    const artifact = await readFailureArtifact(root, RUN_ID);
    expect(artifact?.branches.map((b) => b.branchKey)).toEqual([BRANCH_1, BRANCH_2, BRANCH_3]);
    expect(artifact?.branches.every((b) => b.attempts === 2)).toBe(true);
    expect(run.result.status).toBe("completed");
  });

  it("leaves the terminal unreached, and no artifact behind, when nothing exhausts", async () => {
    const clock = virtualBackoff();
    const run = await runGolden({
      projectRoot: root,
      runId: RUN_ID,
      concurrency: 3,
      retry: policyWith(clock),
      behaviour: {
        contracts: goldenContracts(3),
        // One transient failure, inside the budget: retry absorbs it.
        transientFailures: { [BRANCH_2]: 1 },
        recordFailureArtifact: true,
      },
    });

    expect(run.result.status).toBe("completed");
    if (run.result.status !== "completed") return;
    expect(run.result.verdict).toBe("success");
    expect(run.result.failures).toEqual([]);
    expect(run.spans.some((s) => s.nodeId === GRACEFUL_FAILURE_NODE_ID)).toBe(false);
    expect(await readFailureArtifact(root, RUN_ID)).toBeUndefined();
    expect(clock.delays).toHaveLength(1);
  });
});

// ── sc-9-4 ───────────────────────────────────────────────────────────

/** A router body that ALWAYS re-enters the cycle, and whose own counter never grows. */
const ALWAYS_RETRY: NodeImpl["handler"] = async (input, _state, ctx) => ({
  update: { counters: { [`routeCalls.${ctx.branchKey ?? "-"}`]: 1 } },
  goto: { kind: "label", label: "retry" },
  output: input,
});

/** The golden artifact with one node's `loop` declaration replaced. */
function specWithLoop(nodeId: string, loop: LoopBound): TopologySpec {
  const base = goldenSpec();
  const draft = TopologySpecSchema.parse({
    ...base,
    nodes: base.nodes.map((node) => (node.id === nodeId ? { ...node, loop } : node)),
  });
  return { ...draft, checksum: checksumTopology(draft) };
}

async function runUnboundedRouter(
  projectRoot: string,
  loop?: LoopBound,
): Promise<GoldenRun> {
  return runGolden({
    projectRoot,
    runId: RUN_ID,
    maxSupersteps: 60,
    ...(loop === undefined ? {} : { spec: specWithLoop(GOLDEN_NODES.route, loop) }),
    behaviour: {
      contracts: goldenContracts(1),
      handlerOverrides: { [GOLDEN_NODES.route]: ALWAYS_RETRY },
    },
  });
}

describe("a cycle that would run forever exits by its DECLARED bound (sc-9-4)", () => {
  it("terminates at maxIterations with a bounded-exit span, not at the superstep ceiling", async () => {
    const run = await runUnboundedRouter(root);

    expect(run.result.status).toBe("completed");
    // The declared bound of the golden `sprint_route` node is 3.
    expect(run.handlerLog.calls[GOLDEN_NODES.route]).toBe(3);
    expect(run.handlerLog.calls[GOLDEN_NODES.generate]).toBe(3);
    expect(run.result.supersteps).toBeLessThan(60);

    const key = loopCounterKey("sprintIterations", BRANCH_1);
    expect(run.finalState.counters[key]).toBe(3);
    // The node's OWN counter never grew, so nothing but the runtime could have bounded it.
    expect(run.finalState.counters[`routeCalls.${BRANCH_1}`]).toBe(1);

    const exit = run.spans.filter((s) => s.errorClass === LOOP_EXHAUSTED_ERROR_CLASS);
    expect(exit).toHaveLength(1);
    expect(exit[0].status).toBe("failed");
    expect(exit[0].nodeId).toBe(GOLDEN_NODES.route);
    expect(exit[0].branchKey).toBe(BRANCH_1);
    expect(exit[0].blockedBy).toEqual([key]);

    if (run.result.status !== "completed") return;
    const failure = run.result.failures.find((f) => f.errorClass === LOOP_EXHAUSTED_ERROR_CLASS);
    expect(failure?.branchKey).toBe(BRANCH_1);
    expect(failure?.message).toContain("declared bound of 3");
    expect(failure?.message).toContain(GOLDEN_NODES.sprintOut);
  });

  it("reads maxIterations off the ARTIFACT: the same body bounded at 6 runs six times", async () => {
    const run = await runUnboundedRouter(root, {
      counterKey: "sprintIterations",
      maxIterations: 6,
      onExhausted: GOLDEN_NODES.sprintOut,
    });

    expect(run.result.status).toBe("completed");
    expect(run.handlerLog.calls[GOLDEN_NODES.route]).toBe(6);
    expect(run.finalState.counters[loopCounterKey("sprintIterations", BRANCH_1)]).toBe(6);
    expect(run.result.supersteps).toBeLessThan(60);
  });

  it("reads counterKey off the ARTIFACT: a renamed counter is the one that fills up", async () => {
    const run = await runUnboundedRouter(root, {
      counterKey: "customReworkBudget",
      maxIterations: 2,
      onExhausted: GOLDEN_NODES.sprintOut,
    });

    const key = loopCounterKey("customReworkBudget", BRANCH_1);
    expect(run.handlerLog.calls[GOLDEN_NODES.route]).toBe(2);
    expect(run.finalState.counters[key]).toBe(2);
    expect(run.finalState.counters[loopCounterKey("sprintIterations", BRANCH_1)]).toBeUndefined();
    expect(run.spans.find((s) => s.errorClass === LOOP_EXHAUSTED_ERROR_CLASS)?.blockedBy).toEqual([
      key,
    ]);
  });

  it("does not fire on a cycle that leaves of its own accord", async () => {
    const run = await runGolden({
      projectRoot: root,
      runId: RUN_ID,
      behaviour: { contracts: goldenContracts(1), reworkBranches: [BRANCH_1] },
    });
    expect(run.spans.some((s) => s.errorClass === LOOP_EXHAUSTED_ERROR_CLASS)).toBe(false);
    expect(run.handlerLog.calls[GOLDEN_NODES.route]).toBe(2);
    expect(run.result.status === "completed" && run.result.verdict).toBe("success");
  });
});

// ── sc-9-5 ───────────────────────────────────────────────────────────

describe("the loop counter survives a REPLAYED superstep unchanged (sc-9-5)", () => {
  const KEY = loopCounterKey("sprintIterations", BRANCH_1);

  /** The checkpoint taken while the loop was mid-flight, at counter value `at`. */
  async function checkpointAtCounter(
    checkpointer: GraphCheckpointer,
    value: number,
  ): Promise<CheckpointRef> {
    const refs: CheckpointRef[] = [];
    for await (const ref of checkpointer.list(RUN_ID)) refs.push(ref);
    for (const ref of refs) {
      const checkpoint = await checkpointer.get(ref);
      if (checkpoint.state.counters[KEY] === value && checkpoint.pending.length > 0) return ref;
    }
    throw new Error(`no checkpoint with ${KEY} === ${String(value)}`);
  }

  it("re-executes real supersteps and neither exhausts early nor gains an iteration", async () => {
    const checkpointer = createFsCheckpointer(root);
    const behaviour: GoldenBehaviour = {
      contracts: goldenContracts(1),
      handlerOverrides: { [GOLDEN_NODES.route]: ALWAYS_RETRY },
    };

    const control = await runGolden({
      projectRoot: root,
      runId: RUN_ID,
      maxSupersteps: 60,
      checkpointer,
      durability: "superstep",
      behaviour,
    });
    expect(control.result.status).toBe("completed");
    expect(control.finalState.counters[KEY]).toBe(3);
    expect(control.handlerLog.calls[GOLDEN_NODES.route]).toBe(3);

    // Resume from mid-loop: the tail of the run is executed a SECOND time, from the same
    // committed state, exactly as a crash-and-restart would replay it.
    const ref = await checkpointAtCounter(checkpointer, 1);
    const replayed = await runGolden({
      projectRoot: root,
      runId: RUN_ID,
      maxSupersteps: 60,
      checkpointer,
      durability: "superstep",
      behaviour,
      resumeFrom: { ref },
    });

    expect(replayed.result.status).toBe("completed");
    // It genuinely re-ran supersteps rather than short-circuiting to the end.
    expect(replayed.handlerLog.calls[GOLDEN_NODES.route]).toBe(2);
    expect(replayed.handlerLog.calls[GOLDEN_NODES.generate]).toBe(2);

    // NEITHER an extra iteration NOR an early exhaustion: the same counter, the same
    // bound, the same superstep index the uninterrupted run finished at.
    expect(replayed.finalState.counters[KEY]).toBe(3);
    expect(replayed.finalState.counters[KEY]).toBe(control.finalState.counters[KEY]);
    expect(replayed.result.supersteps).toBe(control.result.supersteps);
    expect(
      replayed.spans
        .slice(control.spans.length)
        .filter((s) => s.errorClass === LOOP_EXHAUSTED_ERROR_CLASS),
    ).toHaveLength(1);
  });

  it("is bound to maxNumber, whose merge is the idempotence the replay relies on", async () => {
    const run = await runUnboundedRouter(root);
    const channel = run.graph.channels.get("counters");
    expect(channel?.reducer.id).toBe("maxNumber");
    expect(channel?.reducer.idempotent).toBe(true);

    const merge = channel?.reducer.merge;
    expect(merge).toBeDefined();
    if (merge === undefined) return;
    const once = merge({}, [{ [KEY]: 2 }]);
    const twice = merge(once, [{ [KEY]: 2 }]);
    expect(canonicalJson(twice)).toBe(canonicalJson(once));
    expect(canonicalJson(merge({}, [{ [KEY]: 2 }, { [KEY]: 2 }]))).toBe(canonicalJson(once));
  });
});

// ── sc-9-6 ───────────────────────────────────────────────────────────

describe("a partially failed run reports every branch and a 'partial' verdict (sc-9-6)", () => {
  /** The global evaluator, replaced with one that COMMITS the qualified synthesis. */
  const SYNTHESISING_EVALUATOR: NodeImpl["handler"] = async (input, state) => ({
    update: {
      messages: [
        {
          id: "m-synthesis",
          seq: 150,
          role: "assistant" as const,
          nodeId: GOLDEN_NODES.evaluateGlobal,
          text: synthesizeBranchOutcomes(state.branchStatus).summary,
          tokens: 0,
        },
      ],
    },
    phase: "evaluating" as const,
    goto: { kind: "node" as const, node: GOLDEN_NODES.supervisor },
    output: { echo: input },
  });

  async function runQualified(recordFailureArtifact: boolean): Promise<GoldenRun> {
    return runGolden({
      projectRoot: root,
      runId: RUN_ID,
      concurrency: 3,
      maxSupersteps: 40,
      retry: policyWith(virtualBackoff()),
      behaviour: {
        contracts: goldenContracts(3),
        transientFailures: { [BRANCH_2]: 99 },
        recordFailureArtifact,
        handlerOverrides: { [GOLDEN_NODES.evaluateGlobal]: SYNTHESISING_EVALUATOR },
      },
    });
  }

  it("commits a synthesis naming every branch, its status and the failure's error class", async () => {
    const run = await runQualified(true);

    // Read off the COMMITTED message, not off a helper call in the test: what the run
    // recorded is the artifact, and a synthesis nobody committed is not a report.
    const committed = run.finalState.messages.find((m) => m.id === "m-synthesis");
    expect(committed).toBeDefined();
    const summary = committed?.text ?? "";
    for (const branch of [BRANCH_1, BRANCH_2, BRANCH_3]) expect(summary).toContain(branch);
    expect(summary).toContain("1 of 3 branches failed");
    expect(summary).toContain(`${BRANCH_2}: failed after 3 attempts (TransientProviderError)`);
    expect(summary).toContain(`${BRANCH_1}: succeeded`);
    expect(summary).toContain(`${BRANCH_3}: succeeded`);
  });

  it("carries the per-branch facts in state, so synthesis needs no trace file", async () => {
    const run = await runQualified(true);

    expect(Object.keys(run.finalState.branchStatus).sort()).toEqual(
      [BRANCH_1, BRANCH_2, BRANCH_3].sort(),
    );
    expect(run.finalState.branchStatus[BRANCH_2]).toEqual({
      state: "failed",
      attempts: 3,
      errorClass: "TransientProviderError",
    });
    expect(run.finalState.branchStatus[BRANCH_1].state).toBe("succeeded");
    expect(run.finalState.branchStatus[BRANCH_3].state).toBe("succeeded");
  });

  it("verdicts the run 'partial' — never 'success', and never an uncaught exception", async () => {
    const run = await runQualified(true);
    expect(run.result.status).toBe("completed");
    if (run.result.status !== "completed") return;
    expect(run.result.verdict).not.toBe("success");
    expect(run.result.verdict).toBe("partial");
    expect(run.result.failures.map((f) => f.branchKey)).toEqual([BRANCH_2]);
  });

  it("still verdicts 'partial' when the graceful terminal ran but finalize also did", async () => {
    // The graceful terminal here is the fixture's original body, which writes
    // `verdict: "failed"` as a control key at its own superstep. `finalize` writes
    // `"partial"` later, and the two never share a superstep, so the unanimity rule at the
    // commit boundary is not violated and the run still reports what it actually did.
    const run = await runQualified(false);

    expect(run.finalState.verdict).toBe("partial");
    expect(run.result.status).toBe("completed");
    if (run.result.status !== "completed") return;
    expect(run.result.verdict).toBe("partial");
    expect(run.finalState.sprintContracts.filter((c) => c.status === "passed")).toHaveLength(2);
  });

  it("downgrades a run that ENDED at the failure terminal, when branches had passed", async () => {
    // The supervisor runs out of its declared rounds AFTER both sprints committed, so the
    // loop bound routes the run to the graceful terminal and `finalize` never executes.
    // `state.verdict` is therefore the terminal's own `"failed"` — the only verdict any
    // node declared — while two contracts are on disk, passed. Reporting that run as a
    // total failure tells an operator to redo committed work.
    const run = await runGolden({
      projectRoot: root,
      runId: RUN_ID,
      concurrency: 2,
      maxSupersteps: 40,
      spec: specWithLoop(GOLDEN_NODES.supervisor, {
        counterKey: "supervisorRounds",
        maxIterations: 2,
        onExhausted: GRACEFUL_FAILURE_NODE_ID,
      }),
      behaviour: { contracts: goldenContracts(2) },
    });

    expect(run.result.status).toBe("completed");
    if (run.result.status !== "completed") return;
    expect(run.handlerLog.calls[GOLDEN_NODES.finalize]).toBeUndefined();
    expect(run.handlerLog.calls[GRACEFUL_FAILURE_NODE_ID]).toBe(1);
    expect(run.finalState.sprintContracts.filter((c) => c.status === "passed")).toHaveLength(2);

    // What the terminal DECLARED, and what the interpreter reports having seen.
    expect(run.finalState.verdict).toBe("failed");
    expect(run.result.verdict).toBe("partial");
    expect(run.result.verdict).not.toBe("success");
    expect(
      run.result.failures.some((f) => f.errorClass === LOOP_EXHAUSTED_ERROR_CLASS),
    ).toBe(true);
  });

  it("does NOT downgrade a run that ended at the terminal with nothing committed", async () => {
    // The same bound, exhausted before any branch could pass. Nothing landed, so `failed`
    // is the truth and the downgrade must not fire.
    const run = await runGolden({
      projectRoot: root,
      runId: RUN_ID,
      concurrency: 2,
      maxSupersteps: 40,
      spec: specWithLoop(GOLDEN_NODES.supervisor, {
        counterKey: "supervisorRounds",
        maxIterations: 1,
        onExhausted: GRACEFUL_FAILURE_NODE_ID,
      }),
      behaviour: { contracts: goldenContracts(2) },
    });

    expect(run.result.status).toBe("completed");
    if (run.result.status !== "completed") return;
    expect(run.finalState.sprintContracts.filter((c) => c.status === "passed")).toHaveLength(0);
    expect(run.finalState.verdict).toBe("failed");
    expect(run.result.verdict).toBe("failed");
  });

  it("is not vacuous: the same graph with no failure verdicts 'success'", async () => {
    const run = await runGolden({
      projectRoot: root,
      runId: RUN_ID,
      concurrency: 3,
      retry: policyWith(virtualBackoff()),
      behaviour: {
        contracts: goldenContracts(3),
        recordFailureArtifact: true,
        handlerOverrides: { [GOLDEN_NODES.evaluateGlobal]: SYNTHESISING_EVALUATOR },
      },
    });
    expect(run.result.status === "completed" && run.result.verdict).toBe("success");
    expect(run.finalState.messages.find((m) => m.id === "m-synthesis")?.text).toContain(
      "all 3 branches succeeded",
    );
  });
});

// ── sc-9-7 ───────────────────────────────────────────────────────────

describe("branchStatus merges eight concurrent branches over disjoint keys (sc-9-7)", () => {
  const TRANSIENT_BRANCHES = [1, 2, 3, 4].map(goldenContractId);
  const HARD_BRANCHES = [5, 6, 7, 8].map(goldenContractId);

  async function runEightFailures(): Promise<GoldenRun> {
    const transientFailures: Record<string, number> = {};
    for (const key of TRANSIENT_BRANCHES) transientFailures[key] = 99;
    return runGolden({
      projectRoot: root,
      runId: RUN_ID,
      concurrency: 8,
      maxSupersteps: 40,
      retry: policyWith(virtualBackoff(), 3),
      behaviour: {
        contracts: goldenContracts(8),
        transientFailures,
        failingBranches: HARD_BRANCHES,
        recordFailureArtifact: true,
      },
    });
  }

  it("writes the channel ONCE for a batch of eight, one update per branch", async () => {
    const run = await runEightFailures();
    if (run.result.status !== "completed") throw new Error("run did not complete");

    // The superstep in which all eight generators rejected — identified from the trace, so
    // the commit under assertion is provably the concurrent-failure one and not the
    // earlier superstep in which eight branches merely announced themselves.
    const failed = run.spans.filter(
      (s) => s.nodeId === GOLDEN_NODES.generate && s.status === "failed",
    );
    expect(failed).toHaveLength(8);
    expect(new Set(failed.map((s) => s.superstep)).size).toBe(1);

    const commit = run.result.commits.find((c) => c.superstep === failed[0].superstep);
    expect(commit).toBeDefined();
    expect(commit?.batchSizePerChannel.branchStatus).toBe(8);
    expect(commit?.writesPerChannel.branchStatus).toBe(1);
    // Eight rejected tasks contributed no node update at all, so the whole superstep is
    // the eight failure records merged by ONE reducer call.
    expect(Object.keys(commit?.writesPerChannel ?? {})).toEqual(["branchStatus"]);
    expect(run.graph.channels.get("branchStatus")?.reducer.id).toBe("lastWriteWinsByKey");
  });

  it("keeps every branch's own state, attempts and error class", async () => {
    const run = await runEightFailures();

    expect(Object.keys(run.finalState.branchStatus).sort()).toEqual(
      [...TRANSIENT_BRANCHES, ...HARD_BRANCHES].sort(),
    );
    for (const key of TRANSIENT_BRANCHES) {
      expect(run.finalState.branchStatus[key], key).toEqual({
        state: "failed",
        attempts: 3,
        errorClass: "TransientProviderError",
      });
    }
    for (const key of HARD_BRANCHES) {
      // A non-transient error is not retried, so it costs exactly one attempt — the two
      // failure shapes have to survive the SAME merge without contaminating each other.
      expect(run.finalState.branchStatus[key], key).toEqual({
        state: "failed",
        attempts: 1,
        errorClass: "Error",
      });
    }
    expect(run.result.status === "completed" && run.result.verdict).toBe("failed");
  });

  it("merges the same batch to the same bytes in any order", async () => {
    const run = await runEightFailures();
    const channel = run.graph.channels.get("branchStatus");
    expect(channel).toBeDefined();
    if (channel === undefined) return;

    const updates = Object.keys(run.finalState.branchStatus)
      .sort()
      .map((key) => ({ [key]: run.finalState.branchStatus[key] }));
    expect(updates).toHaveLength(8);

    const forward = canonicalJson(channel.reducer.merge({}, updates));
    const reversed = canonicalJson(channel.reducer.merge({}, [...updates].reverse()));
    expect(reversed).toBe(forward);
    expect(forward).toBe(canonicalJson(run.finalState.branchStatus));
  });

  it("names every failed branch in the artifact the terminal wrote", async () => {
    await runEightFailures();
    const artifact = await readFailureArtifact(root, RUN_ID);
    expect(artifact?.branches.map((b) => b.branchKey)).toEqual(
      [...TRANSIENT_BRANCHES, ...HARD_BRANCHES].sort(),
    );
    expect(artifact?.branches.filter((b) => b.attempts === 3)).toHaveLength(4);
    expect(artifact?.branches.filter((b) => b.attempts === 1)).toHaveLength(4);
  });
});
