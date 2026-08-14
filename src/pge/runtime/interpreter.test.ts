import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PhaseSchema } from "../../state/history.js";
import { checksumTopology } from "../topology/canonical.js";
import { validateTopology } from "../topology/validate.js";
import { compile } from "../compile/compiler.js";
import {
  CommandSchema,
  DEADLOCK_ERROR_CLASS,
  GRACEFUL_FAILURE_NODE_ID,
  SuperstepLimitExceededError,
  computeFanOutRegion,
  isolatedSnapshot,
  resolveDestination,
} from "./interpreter.js";
import {
  GOLDEN_NODES,
  goldenContract,
  goldenContracts,
  goldenInitialState,
  goldenRegistries,
  goldenSpec,
} from "./__fixtures__/golden-graph.js";
import { runGolden } from "./__fixtures__/run-harness.js";
import type { GoldenRun } from "./__fixtures__/run-harness.js";
import type { Span } from "./trace.js";

/**
 * The interpreter, exercised end to end against the golden topology.
 *
 * Every assertion here reads a RECORDED fact — a span from `.bober/traces/<runId>.jsonl`,
 * a commit record, or the committed state — rather than a callback the test itself
 * installed. Nothing asserts elapsed time.
 */

const N = GOLDEN_NODES;

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bober-pge-interp-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function executed(spans: readonly Span[]): Span[] {
  return spans.filter((s) => s.status === "ok" || s.status === "failed");
}

function order(spans: readonly Span[]): string[] {
  return executed(spans).map((s) => (s.branchKey === null ? s.nodeId : `${s.nodeId}@${s.branchKey}`));
}

// ── The artifact itself ──────────────────────────────────────────────

describe("the golden topology is a real artifact", () => {
  it("passes the shipped validator with zero diagnostics", () => {
    const report = validateTopology(goldenSpec());
    expect(report.diagnostics).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("compiles against the fixture registries in both directions", () => {
    const graph = compile(goldenSpec(), goldenRegistries({ contracts: goldenContracts(1) }));
    expect([...graph.nodes.keys()].sort()).toEqual(goldenSpec().nodes.map((n) => n.id).sort());
    expect(graph.subgraphs.has("sprint")).toBe(true);
  });

  it("derives the fan-out region as exactly the sprint branch nodes", () => {
    expect([...computeFanOutRegion(goldenSpec())].sort()).toEqual(
      [N.sprintBody, N.sprintIn, N.generate, N.evaluate, N.route, N.correct, N.sprintOut].sort(),
    );
  });
});

// ── sc-7-1 ───────────────────────────────────────────────────────────

describe("one recorded run exhibits order, dynamic routing, a loop re-entry and a merge (sc-7-1)", () => {
  let run: GoldenRun;

  beforeEach(async () => {
    run = await runGolden({
      projectRoot: root,
      behaviour: { contracts: goldenContracts(3), reworkBranches: ["sprint-golden-2"] },
      concurrency: 3,
    });
  });

  it("records the scheduled node order", () => {
    expect(run.result.status).toBe("completed");
    expect(order(run.spans)).toEqual([
      N.planDraft,
      N.supervisor,
      N.fanout,
      `${N.sprintBody}@sprint-golden-1`,
      `${N.sprintBody}@sprint-golden-2`,
      `${N.sprintBody}@sprint-golden-3`,
      `${N.sprintIn}@sprint-golden-1`,
      `${N.sprintIn}@sprint-golden-2`,
      `${N.sprintIn}@sprint-golden-3`,
      `${N.generate}@sprint-golden-1`,
      `${N.generate}@sprint-golden-2`,
      `${N.generate}@sprint-golden-3`,
      `${N.evaluate}@sprint-golden-1`,
      `${N.evaluate}@sprint-golden-2`,
      `${N.evaluate}@sprint-golden-3`,
      `${N.route}@sprint-golden-1`,
      `${N.route}@sprint-golden-2`,
      `${N.route}@sprint-golden-3`,
      `${N.sprintOut}@sprint-golden-1`,
      `${N.sprintOut}@sprint-golden-3`,
      `${N.correct}@sprint-golden-2`,
      `${N.generate}@sprint-golden-2`,
      `${N.evaluate}@sprint-golden-2`,
      `${N.route}@sprint-golden-2`,
      `${N.sprintOut}@sprint-golden-2`,
      N.supervisor,
      N.evalIn,
      N.evaluateGlobal,
      N.supervisor,
      N.finalize,
    ]);
  });

  it("records at least one DYNAMIC route: the same router chose two different labels", () => {
    const routeLabels = run.spans
      .filter((s) => s.nodeId === N.route && s.route !== undefined)
      .map((s) => `${s.branchKey ?? "-"}:${s.route?.label ?? "<none>"}`);
    expect(routeLabels).toEqual([
      "sprint-golden-1:pass",
      "sprint-golden-2:retry",
      "sprint-golden-3:pass",
      "sprint-golden-2:pass",
    ]);
    // The supervisor likewise chose different labels on different visits.
    expect(
      run.spans.filter((s) => s.nodeId === N.supervisor).map((s) => s.route?.label),
    ).toEqual(["sprints", "evaluate", "done"]);
  });

  it("records at least one LOOP RE-ENTRY: one branch executed the generator twice", () => {
    const regenerated = run.spans.filter(
      (s) => s.nodeId === N.generate && s.branchKey === "sprint-golden-2",
    );
    expect(regenerated).toHaveLength(2);
    expect(regenerated[0].superstep).toBeLessThan(regenerated[1].superstep);
    expect(run.finalState.counters["attempts.sprint-golden-2"]).toBe(2);
    expect(run.finalState.counters["attempts.sprint-golden-1"]).toBe(1);
  });

  it("records at least one SHARED-STATE MERGE: three branches into one channel write", () => {
    const merged = run.result.commits.filter((c) => (c.batchSizePerChannel.messages ?? 0) >= 3);
    expect(merged.length).toBeGreaterThan(0);
    // Three updates, ONE reducer invocation. That is the invariant, not the count of writers.
    expect(merged[0].writesPerChannel.messages).toBe(1);
    for (const key of ["sprint-golden-1", "sprint-golden-2", "sprint-golden-3"]) {
      expect(run.finalState.messages.some((m) => m.id === `m-gen-${key}-1`)).toBe(true);
    }
  });

  it("ends with every contract passed and the run verdict success", () => {
    expect(run.result.status).toBe("completed");
    if (run.result.status !== "completed") return;
    expect(run.result.verdict).toBe("success");
    expect(run.result.deadlocked).toBe(false);
    expect(run.result.failures).toEqual([]);
    expect(run.finalState.sprintContracts.map((c) => c.status)).toEqual([
      "passed",
      "passed",
      "passed",
    ]);
  });
});

// ── sc-7-2 ───────────────────────────────────────────────────────────

describe("a node returns ONE Command: a delta and a destination (sc-7-2)", () => {
  it("accepts an update with a goto and rejects a return with no goto", () => {
    expect(
      CommandSchema.parse({ update: { counters: { a: 1 } }, goto: { kind: "node", node: "x" } }),
    ).toEqual({ update: { counters: { a: 1 } }, goto: { kind: "node", node: "x" } });

    // `update` is optional: a pure router legitimately writes nothing.
    expect(CommandSchema.safeParse({ goto: { kind: "label", label: "pass" } }).success).toBe(true);
    // `goto` is not.
    expect(CommandSchema.safeParse({ update: { counters: { a: 1 } } }).success).toBe(false);
    expect(CommandSchema.safeParse({ goto: { kind: "sideways" } }).success).toBe(false);
    expect(CommandSchema.safeParse({ goto: { kind: "label", label: "" } }).success).toBe(false);
  });

  it("turns a node that returned both into exactly one commit and one routing decision", async () => {
    const run = await runGolden({
      projectRoot: root,
      behaviour: { contracts: goldenContracts(1) },
    });

    const planSpans = run.spans.filter((s) => s.nodeId === N.planDraft);
    expect(planSpans).toHaveLength(1);
    expect(planSpans[0].route?.goto).toEqual({ kind: "node", node: N.supervisor });

    // ONE commit for that superstep, and each channel it wrote was written exactly once.
    const superstepZero = run.result.commits.filter((c) => c.superstep === 0);
    expect(superstepZero).toHaveLength(1);
    expect(superstepZero[0].writesPerChannel).toEqual({
      spec: 1,
      sprintContracts: 1,
      messages: 1,
      counters: 1,
      currentPhase: 1,
    });
  });

  it("has NO static conditional-edge map: outgoing edges equal the declared outcome labels", () => {
    const graph = compile(goldenSpec(), goldenRegistries({ contracts: goldenContracts(1) }));

    // A non-router node carries no target table at all — its destination came from the
    // Command it returned, not from a per-outcome edge fan.
    const planNode = graph.nodes.get(N.planDraft);
    expect(planNode?.spec.kind).toBe("llm");
    expect("targets" in (planNode?.spec ?? {})).toBe(false);
    expect(graph.adjacency.get(N.planDraft)).toHaveLength(1);

    // A router's edges are exactly its declared labels — one edge per OUTCOME, never one
    // edge per reachable destination.
    const supervisor = graph.nodes.get(N.supervisor);
    const labels = supervisor?.spec.kind === "router" ? supervisor.spec.targets.map((t) => t.label) : [];
    expect(labels).toEqual(["sprints", "evaluate", "done"]);
    expect((graph.adjacency.get(N.supervisor) ?? []).map((e) => e.label)).toEqual(labels);
  });
});

// ── sc-7-3 ───────────────────────────────────────────────────────────

describe("scope: leaving a subgraph is a declared move (sc-7-3)", () => {
  it("resumes at the parent supervisor when a nested node returns goto parent", async () => {
    const run = await runGolden({
      projectRoot: root,
      behaviour: { contracts: goldenContracts(1) },
    });

    const exit = run.spans.filter((s) => s.nodeId === N.sprintOut);
    expect(exit).toHaveLength(1);
    expect(exit[0].route?.goto).toEqual({ kind: "parent" });

    // Control genuinely arrived at the supervisor after the branch exited.
    const supervisorSteps = run.spans
      .filter((s) => s.nodeId === N.supervisor)
      .map((s) => s.superstep);
    expect(supervisorSteps.some((step) => step > exit[0].superstep)).toBe(true);
    expect(run.result.status).toBe("completed");
  });

  /**
   * The exact pairing the criterion asks for, on ONE node.
   *
   * `sprint_evaluate` sits inside the `sprint` subgraph and the artifact gives it no edge
   * to the root supervisor, so it is the honest test: `gate_sprint_out` DOES declare that
   * edge, and naming the supervisor from there is legitimately in scope. The only
   * difference between the two runs below is the scope of the goto.
   */
  it("lets a nested node with no declared edge out return through the parent scope", async () => {
    const run = await runGolden({
      projectRoot: root,
      behaviour: {
        contracts: goldenContracts(1),
        handlerOverrides: {
          [N.evaluate]: async (input) => ({
            update: {},
            goto: { kind: "parent" },
            output: input,
          }),
        },
      },
    });

    expect(run.result.failures).toEqual([]);
    const evaluated = run.spans.filter((s) => s.nodeId === N.evaluate);
    expect(evaluated).toHaveLength(1);
    expect(evaluated[0].route?.goto).toEqual({ kind: "parent" });
    expect(
      run.spans.some((s) => s.nodeId === N.supervisor && s.superstep > evaluated[0].superstep),
    ).toBe(true);
    expect(run.result.status).toBe("completed");
  });

  it("fails with UnknownNodeInScope when the SAME node names the supervisor by id", async () => {
    const run = await runGolden({
      projectRoot: root,
      behaviour: {
        contracts: goldenContracts(1),
        handlerOverrides: {
          [N.evaluate]: async (input) => ({
            update: {},
            // Same destination, undeclared route: `supervisor` is at root scope and the
            // artifact gives `sprint_evaluate` no edge naming it.
            goto: { kind: "node", node: N.supervisor },
            output: input,
          }),
        },
      },
    });

    expect(run.result.failures.map((f) => f.errorClass)).toEqual(["UnknownNodeInScopeError"]);
    expect(run.result.failures[0].nodeId).toBe(N.evaluate);
    expect(run.result.failures[0].message).toContain(N.supervisor);
    expect(run.spans.find((s) => s.nodeId === N.evaluate)?.status).toBe("failed");
  });

  it("refuses goto parent at root scope, where there is no parent", () => {
    const graph = compile(goldenSpec(), goldenRegistries({ contracts: goldenContracts(1) }));
    const supervisor = graph.nodes.get(N.supervisor);
    expect(supervisor).toBeDefined();
    if (!supervisor) return;
    expect(() => resolveDestination(graph, supervisor, { kind: "parent" })).toThrow(
      /no parent scope/,
    );
  });

  it("rejects a label the router does not declare", () => {
    const graph = compile(goldenSpec(), goldenRegistries({ contracts: goldenContracts(1) }));
    const supervisor = graph.nodes.get(N.supervisor);
    if (!supervisor) return;
    expect(() => resolveDestination(graph, supervisor, { kind: "label", label: "sideways" })).toThrow(
      /does not declare/,
    );
    expect(resolveDestination(graph, supervisor, { kind: "label", label: "done" })).toEqual({
      kind: "single",
      nodeId: N.finalize,
    });
  });

  it("refuses a fan-out from a node with no fan-out edge, and one with no sends", () => {
    const graph = compile(goldenSpec(), goldenRegistries({ contracts: goldenContracts(1) }));
    const supervisor = graph.nodes.get(N.supervisor);
    const fanout = graph.nodes.get(N.fanout);
    if (!supervisor || !fanout) return;
    expect(() => resolveDestination(graph, supervisor, { kind: "fanout", sends: [] })).toThrow(
      /0 fan-out edges/,
    );
    expect(() => resolveDestination(graph, fanout, { kind: "fanout", sends: [] })).toThrow(
      /no sends/,
    );
    expect(() =>
      resolveDestination(graph, fanout, {
        kind: "fanout",
        sends: [
          { branchKey: "b", input: 1 },
          { branchKey: "b", input: 2 },
        ],
      }),
    ).toThrow(/sent twice/);
  });
});

// ── sc-7-4 ───────────────────────────────────────────────────────────

describe("fan-out cardinality is runtime-determined (sc-7-4)", () => {
  it("dispatches 5 branches from ONE routing decision", async () => {
    const run = await runGolden({
      projectRoot: root,
      behaviour: { contracts: goldenContracts(5) },
      concurrency: 5,
    });

    const fanoutSpans = run.spans.filter((s) => s.nodeId === N.fanout);
    expect(fanoutSpans).toHaveLength(1);
    expect(fanoutSpans[0].route?.goto.kind).toBe("fanout");
    expect(fanoutSpans[0].route?.goto.sends).toHaveLength(5);

    const dispatched = run.spans.filter((s) => s.nodeId === N.sprintBody).map((s) => s.branchKey);
    expect(dispatched).toEqual([
      "sprint-golden-1",
      "sprint-golden-2",
      "sprint-golden-3",
      "sprint-golden-4",
      "sprint-golden-5",
    ]);
  });

  it("leaves the topology checksum and the fan-out edge count unchanged at 3 contracts", async () => {
    const fiveRoot = await mkdtemp(join(tmpdir(), "bober-pge-fanout5-"));
    try {
      const five = await runGolden({
        projectRoot: fiveRoot,
        behaviour: { contracts: goldenContracts(5) },
        concurrency: 5,
      });
      const three = await runGolden({
        projectRoot: root,
        behaviour: { contracts: goldenContracts(3) },
        concurrency: 5,
      });

      expect(checksumTopology(three.graph.spec)).toBe(checksumTopology(five.graph.spec));
      expect(three.graph.spec.checksum).toBe(five.graph.spec.checksum);

      // The artifact still declares exactly ONE fan-out edge either way: cardinality lives
      // in the Command, not in the topology.
      expect(three.graph.spec.edges.filter((e) => e.kind === "fanout")).toHaveLength(1);
      expect(five.graph.spec.edges.filter((e) => e.kind === "fanout")).toHaveLength(1);

      expect(three.spans.filter((s) => s.nodeId === N.sprintBody)).toHaveLength(3);
      expect(five.spans.filter((s) => s.nodeId === N.sprintBody)).toHaveLength(5);
    } finally {
      await rm(fiveRoot, { recursive: true, force: true });
    }
  });
});

// ── sc-7-11 ──────────────────────────────────────────────────────────

describe("the phase sequence is pinned (sc-7-11)", () => {
  it("matches the expected sequence and leaves no routing decision phase-less", async () => {
    const run = await runGolden({
      projectRoot: root,
      behaviour: { contracts: goldenContracts(2) },
      concurrency: 2,
    });

    const phases = executed(run.spans).map((s) => s.phase);
    const collapsed = phases.filter((phase, i) => i === 0 || phases[i - 1] !== phase);
    expect(collapsed).toEqual(["init", "planning", "generating", "evaluating"]);

    // The terminal phase is committed even though no later span observes it.
    expect(run.finalState.currentPhase).toBe("complete");

    // Every span carrying a routing decision carries a legal phase.
    const legal = new Set(PhaseSchema.options);
    for (const span of run.spans) {
      if (span.route === undefined) continue;
      expect(legal.has(span.phase), `${span.nodeId} routed with phase ${span.phase}`).toBe(true);
    }
  });
});

// ── sc-7-12 ──────────────────────────────────────────────────────────

describe("a fully blocked frontier is a deadlock, not a spin (sc-7-12)", () => {
  it("routes to the graceful-failure terminal and marks the trace distinguishably", async () => {
    const run = await runGolden({
      projectRoot: root,
      behaviour: {
        // A dependency that no branch can ever commit: the frontier can never clear.
        contracts: [goldenContract({ index: 1, dependsOn: ["contract-that-never-runs"] })],
      },
      maxSupersteps: 40,
    });

    expect(run.result.status).toBe("completed");
    if (run.result.status !== "completed") return;
    expect(run.result.deadlocked).toBe(true);
    expect(run.result.verdict).toBe("failed");

    const deadlockSpan = run.spans.find((s) => s.errorClass === DEADLOCK_ERROR_CLASS);
    expect(deadlockSpan).toBeDefined();
    expect(deadlockSpan?.status).toBe("failed");
    expect(deadlockSpan?.nodeId).toBe(N.sprintBody);
    expect(deadlockSpan?.blockedBy).toEqual(["contract-that-never-runs"]);

    // It reached the terminal rather than hanging or spinning.
    expect(run.spans.some((s) => s.nodeId === GRACEFUL_FAILURE_NODE_ID)).toBe(true);
    expect(run.finalState.verdict).toBe("failed");
    expect(run.result.supersteps).toBeLessThan(12);
  });

  it("distinguishes deadlock from a normal completion in the trace", async () => {
    const healthy = await runGolden({
      projectRoot: root,
      behaviour: { contracts: goldenContracts(1) },
    });
    expect(healthy.spans.some((s) => s.errorClass === DEADLOCK_ERROR_CLASS)).toBe(false);
    expect(healthy.spans.some((s) => s.nodeId === GRACEFUL_FAILURE_NODE_ID)).toBe(false);
    expect(healthy.result.status === "completed" && healthy.result.deadlocked).toBe(false);
  });
});

// ── sc-7-9, end to end ───────────────────────────────────────────────

describe("a refused oversized update is LOST WORK the run reports (sc-7-9)", () => {
  /**
   * The boundary rejects an oversized update rather than throwing, so the interpreter is
   * the only place that can turn "the commit lost work" into a fact the caller sees.
   *
   * Asserted against a REAL node in the golden topology, not against the boundary in
   * isolation: what makes offloading ENFORCED rather than advised is that a node which
   * fails to offload cannot produce a successful run.
   */
  const FIVE_MB = "x".repeat(5 * 1024 * 1024);

  async function runWith(oversized: boolean): Promise<GoldenRun> {
    return runGolden({
      projectRoot: root,
      behaviour: {
        contracts: goldenContracts(1),
        ...(oversized ? { oversizedMessageText: FIVE_MB } : {}),
      },
    });
  }

  it("records the rejection as a failure, so the run cannot report success", async () => {
    const run = await runWith(true);

    expect(run.result.status).toBe("completed");
    if (run.result.status !== "completed") return;

    const bloat = run.result.failures.filter((f) => f.errorClass === "StateBloatError");
    expect(bloat).toHaveLength(1);
    expect(bloat[0].nodeId).toBe(N.generate);
    expect(bloat[0].branchKey).toBe("sprint-golden-1");
    // The failure names the channel, the size and the cap — the three facts an operator
    // needs to know WHICH write was lost and by how much it overshot.
    expect(bloat[0].message).toContain("messages");
    expect(bloat[0].message).toContain("maxInlineBytes of 4096");
    const measured = /serialises to (\d+) bytes/.exec(bloat[0].message);
    expect(measured).not.toBeNull();
    expect(Number(measured?.[1])).toBeGreaterThan(5 * 1024 * 1024);

    // The whole point: a run that dropped a node's write is not a success.
    expect(run.result.verdict).not.toBe("success");
    expect(run.result.verdict).toBe("partial");
  });

  it("closes the PRODUCING span failed — one span, not an ok span plus a note", async () => {
    const run = await runWith(true);

    const generatorSpans = run.spans.filter((s) => s.nodeId === N.generate);
    expect(generatorSpans).toHaveLength(1);
    expect(generatorSpans[0].status).toBe("failed");
    expect(generatorSpans[0].errorClass).toBe("StateBloatError");
    // It still recorded what the node decided: the loss is on the write, not the routing.
    expect(generatorSpans[0].route?.goto).toEqual({ kind: "node", node: N.evaluate });

    // Every other node in the same run is untouched by one branch's refused write.
    expect(run.spans.filter((s) => s.status === "failed")).toHaveLength(1);
  });

  it("loses only the refused channel, and the loss is visible in state and commits", async () => {
    const run = await runWith(true);
    if (run.result.status !== "completed") return;

    // The message never became state...
    expect(run.finalState.messages.some((m) => m.id === "m-gen-sprint-golden-1-1")).toBe(false);
    // ...while the same node's small sibling update in the SAME command did.
    expect(run.finalState.counters["attempts.sprint-golden-1"]).toBe(1);

    const withRejections = run.result.commits.filter((c) => c.rejected.length > 0);
    expect(withRejections).toHaveLength(1);
    expect(withRejections[0].rejected[0].channel).toBe("messages");
    expect(withRejections[0].rejected[0].limit).toBe(4096);
    expect(withRejections[0].writesPerChannel.messages).toBeUndefined();
  });

  it("is not vacuous: the same run offloading nothing oversized succeeds cleanly", async () => {
    const run = await runWith(false);
    if (run.result.status !== "completed") return;

    expect(run.result.failures).toEqual([]);
    expect(run.result.verdict).toBe("success");
    expect(run.result.commits.every((c) => c.rejected.length === 0)).toBe(true);

    const generatorSpans = run.spans.filter((s) => s.nodeId === N.generate);
    expect(generatorSpans).toHaveLength(1);
    expect(generatorSpans[0].status).toBe("ok");
    expect(generatorSpans[0].errorClass).toBeUndefined();
    expect(run.finalState.messages.some((m) => m.id === "m-gen-sprint-golden-1-1")).toBe(true);
  });
});

// ── Guards ───────────────────────────────────────────────────────────

describe("run guards", () => {
  it("returns aborted when the signal is already raised", async () => {
    const controller = new AbortController();
    controller.abort();
    const run = await runGolden({
      projectRoot: root,
      behaviour: { contracts: goldenContracts(1) },
      signal: controller.signal,
    });
    expect(run.result.status).toBe("aborted");
    expect(run.spans).toEqual([]);
  });

  it("throws rather than looping forever when the superstep bound is reached", async () => {
    await expect(
      runGolden({
        projectRoot: root,
        behaviour: { contracts: goldenContracts(1) },
        maxSupersteps: 3,
      }),
    ).rejects.toBeInstanceOf(SuperstepLimitExceededError);
  });

  it("records a failing node as a failed span and keeps its siblings running", async () => {
    const run = await runGolden({
      projectRoot: root,
      behaviour: { contracts: goldenContracts(3), failingBranches: ["sprint-golden-2"] },
      concurrency: 3,
    });

    expect(run.result.failures.map((f) => f.branchKey)).toEqual(["sprint-golden-2"]);
    expect(run.spans.find((s) => s.nodeId === N.generate && s.branchKey === "sprint-golden-2")?.status).toBe(
      "failed",
    );
    // The siblings still reached the exit gate and the run still finished.
    expect(
      run.spans.filter((s) => s.nodeId === N.sprintOut).map((s) => s.branchKey).sort(),
    ).toEqual(["sprint-golden-1", "sprint-golden-3"]);
    expect(run.result.status).toBe("completed");
    if (run.result.status !== "completed") return;
    expect(run.result.verdict).toBe("partial");
  });
});

// ── State snapshots ──────────────────────────────────────────────────

describe("isolatedSnapshot", () => {
  it("hands out a deeply frozen clone, not the state object", () => {
    const state = goldenInitialState("run-x", root);
    const snapshot = isolatedSnapshot(state);
    expect(snapshot).not.toBe(state);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.messages)).toBe(true);
    expect(() => (snapshot.messages as unknown as unknown[]).push({})).toThrow(TypeError);
    expect(state.messages).toEqual([]);
  });
});
