import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { BoberConfig } from "../../config/schema.js";
import { SprintContractSchema } from "../../contracts/sprint-contract.js";
import type { SprintContract } from "../../contracts/sprint-contract.js";
import type { TopologySpec } from "../../contracts/topology.js";
import { createEffectRegistry } from "../registry/effects.js";
import type { EffectTag } from "../registry/effects.js";
import type {
  ArchiveHandle,
  BudgetLedger,
  Clock,
  ModelBinder,
  NodeContext,
  PromptStore,
  ScratchStore,
  SemanticCache,
  TraceWriter,
} from "../registry/nodes.js";
import { initialOverallState } from "../state/overall.js";
import type { OverallState } from "../state/overall.js";
import { readFailureArtifact } from "../runtime/graceful-failure.js";
import { CODING_GRAPH } from "../topology/coding.graph.js";
import {
  deepSnapshot,
  runRegion,
  seedResearchDigest,
  stubContracts,
  stubDigest,
  stubPlanSpec,
} from "./__fixtures__/region-harness.js";
import type { RegionRun } from "./__fixtures__/region-harness.js";
import {
  NODE_REFUSAL_KIND,
  NodeSpecMismatchError,
  describeRefusal,
  isNodeRefusal,
  loopBoundOf,
  nodeSpecOf,
  portOf,
  preconditionIssue,
  refuse,
  schemaGate,
  soleSuccessor,
} from "./gates.js";
import type { NodeRefusal } from "./gates.js";
import { PLAN_NODE_IDS, PlanContractsSchema, planExitGate } from "./plan.js";
import { PLAN_REGION, RESEARCH_REGION, regionSpec } from "./regions.js";
import { RESEARCH_NODE_IDS } from "./research.js";

/**
 * The fail-closed boundary gates.
 *
 * What each test here exists to catch:
 *
 *  - a gate that rejects a payload and then MERGES IT ANYWAY, whole or in part, or parks it
 *    in a quarantine key inside `OverallState` so that "state was not corrupted" is true of
 *    one key and false of the object (sc-11-5, nonGoal #6). The assertion is a whole-state
 *    structural comparison of the gate's own superstep, not the absence of one key;
 *  - a gate whose refusal ECHOES the payload — a leak through the diagnostic rather than
 *    through the channel, which a key-by-key check would never see;
 *  - a gate that routes onward regardless, so a malformed sprint contract reaches the node
 *    after it (sc-11-4). Asserted three ways: the `goto` the gate returned, the route the
 *    TRACE recorded, and the downstream node's handler never being entered;
 *  - a gate that THROWS instead of returning a `Command`, which would move the fail-closed
 *    hop out of the topology and into a `catch` inside the interpreter, where a structural
 *    diff of the artifact can no longer see it;
 *  - a gate that reaches for a collaborator a pure validator has no business touching. The
 *    unit-level context below throws on every one of them.
 *
 * Every structural fact — ports, the declared `gate.check`, the `gate.onFail` endpoint, the
 * admit-path successor — is read off `CODING_GRAPH`, so a test that agreed with the
 * implementation while both disagreed with the artifact cannot pass.
 */

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bober-pge-gates-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const PLAN_SPEC = regionSpec(CODING_GRAPH, PLAN_REGION);
const RESEARCH_SPEC = regionSpec(CODING_GRAPH, RESEARCH_REGION);

/**
 * A marker that must never survive a refusal.
 *
 * Carried on the invalid contract, then searched for across the whole serialized final
 * state, every artifact write and the refusal itself. A single `toContain` over the
 * serialized state catches quarantining into ANY key, which is what nonGoal #6 forbids and
 * what an assertion about one named key would miss.
 */
const INVALID_PAYLOAD_MARKER = "INVALID-PAYLOAD-MUST-NOT-PROPAGATE-7f3a";

// ── A context a pure validator cannot misuse ────────────────────────

const unusable = (what: string): never => {
  throw new Error(`${what} must not be touched by a boundary gate: a gate is a pure validator`);
};

/**
 * A `NodeContext` whose every collaborator throws.
 *
 * The only members a gate may legitimately read are `nodeId`, `superstep` and `clock` — the
 * three facts a refusal records about itself. Everything else is wired to explode, so "the
 * gate performed no effect, wrote no scratch and charged no ledger" is enforced rather than
 * asserted after the fact.
 */
function gateContext(overrides: Partial<NodeContext> = {}): NodeContext {
  const clock: Clock = {
    now: () => new Date("2026-08-05T00:00:00.000Z"),
    nowMs: () => Date.parse("2026-08-05T00:00:00.000Z"),
    nowIso: () => "2026-08-05T00:00:00.000Z",
  };
  const scratch: ScratchStore = {
    put: async () => unusable("ScratchStore.put"),
    get: async () => unusable("ScratchStore.get"),
    text: async () => unusable("ScratchStore.text"),
  };
  const archive: ArchiveHandle = {
    dir: "/dev/null",
    writeSnapshot: async () => unusable("ArchiveHandle.writeSnapshot"),
    appendStdout: async () => unusable("ArchiveHandle.appendStdout"),
    writeOutputs: async () => unusable("ArchiveHandle.writeOutputs"),
    seal: async () => unusable("ArchiveHandle.seal"),
  };
  const cache: SemanticCache = {
    key: () => unusable("SemanticCache.key"),
    get: async () => unusable("SemanticCache.get"),
    put: async () => unusable("SemanticCache.put"),
  };
  const trace: TraceWriter = {
    begin: () => unusable("TraceWriter.begin"),
    path: () => "/dev/null",
  };
  const ledger: BudgetLedger = {
    charge: () => unusable("BudgetLedger.charge"),
    totals: () => unusable("BudgetLedger.totals"),
    perNode: () => unusable("BudgetLedger.perNode"),
  };
  const prompts: PromptStore = {
    has: () => false,
    get: async () => unusable("PromptStore.get"),
  };
  const models: ModelBinder = {
    bind: () => unusable("ModelBinder.bind"),
    profile: () => unusable("ModelBinder.profile"),
  };

  return {
    runId: "run-gate",
    projectRoot: "/tmp/project",
    config: {} as BoberConfig,
    nodeId: PLAN_NODE_IDS.exitGate,
    branchKey: null,
    superstep: 4,
    spanId: "span-gate",
    priv: new Map<string, unknown>(),
    declaredEffects: [] satisfies EffectTag[],
    clock,
    signal: new AbortController().signal,
    effects: createEffectRegistry(),
    scratch,
    archive,
    cache,
    trace,
    ledger,
    prompts,
    models,
    ...overrides,
  };
}

function emptyState(): OverallState {
  return initialOverallState({
    runId: "run-gate",
    projectRoot: "/tmp/project",
    featureRequest: "exercise the boundary gates",
  });
}

// ── Invalid payloads ────────────────────────────────────────────────

/** A contract with `successCriteria: []` — present, and empty. */
function contractWithEmptyCriteria(): unknown {
  const [valid] = stubContracts(stubPlanSpec());
  return { ...valid, title: INVALID_PAYLOAD_MARKER, successCriteria: [] };
}

/** A contract with no `successCriteria` key at all. */
function contractWithoutCriteria(): unknown {
  const [valid] = stubContracts(stubPlanSpec());
  const { successCriteria: _dropped, ...rest } = valid;
  return { ...rest, title: INVALID_PAYLOAD_MARKER };
}

// ── sc-11-4: the gate returns a typed failure naming the field ──────

describe("PLAN EXIT GATE: a sprint contract missing successCriteria is refused, typed, and routed away (sc-11-4)", () => {
  it("declares the gate the artifact declares, with the artifact's own ports and check", () => {
    const gate = planExitGate(PLAN_SPEC);
    const declared = nodeSpecOf(CODING_GRAPH, PLAN_NODE_IDS.exitGate);

    expect(gate.id).toBe(PLAN_NODE_IDS.exitGate);
    expect(gate.kind).toBe("gate");
    expect(gate.inputPort).toEqual({ key: "contracts", schemaRef: "SprintContract" });
    expect(gate.outputPort).toEqual({ key: "contracts", schemaRef: "SprintContract" });
    expect(declared.gate?.check).toBe("spec-and-contracts-persisted");
    expect(declared.gate?.onFail).toBe("graceful_failure");
  });

  it("returns a typed refusal carrying the Zod path that names successCriteria", async () => {
    const gate = planExitGate(PLAN_SPEC);
    const command = await gate.handler([contractWithEmptyCriteria()], emptyState(), gateContext());

    expect(isNodeRefusal(command.output)).toBe(true);
    const refusal = command.output as NodeRefusal;
    expect(refusal.kind).toBe(NODE_REFUSAL_KIND);
    expect(refusal.nodeId).toBe(PLAN_NODE_IDS.exitGate);
    expect(refusal.check).toBe("spec-and-contracts-persisted");
    expect(refusal.onFail).toBe("graceful_failure");
    // The payload is an ARRAY of contracts, so the failing member is named by index.
    expect(refusal.issues.map((issue) => issue.path)).toEqual(["0.successCriteria"]);
    expect(refusal.issues[0].pathSegments).toEqual([0, "successCriteria"]);
    expect(refusal.issues[0].code).toBe("too_small");
  });

  it("names the same path when the field is ABSENT rather than empty", async () => {
    const gate = planExitGate(PLAN_SPEC);
    const command = await gate.handler([contractWithoutCriteria()], emptyState(), gateContext());

    const refusal = command.output as NodeRefusal;
    expect(refusal.issues.map((issue) => issue.path)).toEqual(["0.successCriteria"]);
    expect(refusal.issues[0].code).toBe("invalid_type");
  });

  it("routes to the artifact's declared onFail endpoint, NEVER to the admit-path successor", async () => {
    const gate = planExitGate(PLAN_SPEC);
    const successor = soleSuccessor(PLAN_SPEC, PLAN_NODE_IDS.exitGate);
    expect(successor).toBe(CODING_GRAPH.defaults.supervisorNodeId);

    const command = await gate.handler([contractWithEmptyCriteria()], emptyState(), gateContext());
    expect(command.goto).toEqual({ kind: "node", node: "graceful_failure" });
    expect(command.goto.node).not.toBe(successor);
  });

  it("RETURNS the refusal rather than throwing, so the fail-closed hop stays in the topology", async () => {
    const gate = planExitGate(PLAN_SPEC);
    await expect(
      gate.handler([contractWithEmptyCriteria()], emptyState(), gateContext()),
    ).resolves.toBeDefined();
    // Every shape a malformed payload can take, and none of them throws.
    for (const payload of [null, undefined, "prose", 42, {}, [], [{}], [contractWithoutCriteria()]]) {
      await expect(gate.handler(payload, emptyState(), gateContext())).resolves.toMatchObject({
        goto: { kind: "node", node: "graceful_failure" },
      });
    }
  });

  it("ADMITS a well-formed contract set and routes to the successor the artifact declares", async () => {
    // The negative control. Without this the tests above would pass for a gate that
    // refuses everything, which is fail-closed and also useless.
    const spec = stubPlanSpec();
    const contracts = stubContracts(spec);
    const state: OverallState = { ...emptyState(), spec, sprintContracts: contracts };
    const gate = planExitGate(PLAN_SPEC);
    const command = await gate.handler(contracts, state, gateContext());

    expect(isNodeRefusal(command.output)).toBe(false);
    expect(command.output).toEqual(contracts);
    expect(command.goto).toEqual({
      kind: "node",
      node: soleSuccessor(PLAN_SPEC, PLAN_NODE_IDS.exitGate),
    });
  });

  it("refuses a well-formed contract set whose STATE precondition is unmet, after the schema passed", () => {
    // The declared check is `spec-and-contracts-persisted`, and the two halves fail
    // differently: this one parses cleanly and is still not admissible.
    const spec = stubPlanSpec();
    const contracts = stubContracts(spec);
    const gate = planExitGate(PLAN_SPEC);
    return gate.handler(contracts, emptyState(), gateContext()).then((command) => {
      const refusal = command.output as NodeRefusal;
      expect(isNodeRefusal(refusal)).toBe(true);
      expect(refusal.issues.map((issue) => issue.path).sort()).toEqual([
        "spec",
        "sprintContracts",
      ]);
      expect(refusal.issues.every((issue) => issue.code === "custom")).toBe(true);
      expect(command.goto).toEqual({ kind: "node", node: "graceful_failure" });
    });
  });
});

// ── sc-11-5: nothing of the payload survives the refusal ────────────

describe("REFUSAL CONTENT: the diagnostic diagnoses, it does not carry the payload (sc-11-5)", () => {
  it("quotes no part of the refused contract anywhere in the refusal", async () => {
    const gate = planExitGate(PLAN_SPEC);
    const command = await gate.handler([contractWithEmptyCriteria()], emptyState(), gateContext());
    expect(JSON.stringify(command.output)).not.toContain(INVALID_PAYLOAD_MARKER);
  });

  it("returns NO update at all, so there is nothing for the commit boundary to merge", async () => {
    const gate = planExitGate(PLAN_SPEC);
    const command = await gate.handler([contractWithEmptyCriteria()], emptyState(), gateContext());
    // Not "the update omits the payload" — there is no update. The artifact declares
    // `writes: []` on this gate and the implementation honours it.
    expect(command.update).toBeUndefined();
  });

  it("describes a refusal by node, check and failing paths — and by nothing else", () => {
    const refusal = refuse(gateContext(), {
      check: "spec-and-contracts-persisted",
      onFail: "graceful_failure",
      issues: [preconditionIssue("sprintContracts", "never reached the channel")],
    });
    expect(describeRefusal(refusal)).toBe(
      `${PLAN_NODE_IDS.exitGate} refused "spec-and-contracts-persisted": sprintContracts [custom]`,
    );
    expect(refusal.refusedAt).toBe("2026-08-05T00:00:00.000Z");
    expect(refusal.superstep).toBe(4);
  });

  it("renders a ROOT-level failing path as `<root>` rather than an empty string", () => {
    const refusal = refuse(gateContext(), {
      check: "spec-and-contracts-persisted",
      onFail: "graceful_failure",
      issues: [preconditionIssue("", "the payload was not an object")],
    });
    expect(describeRefusal(refusal)).toContain("<root>");
  });

  it("recognises only a real refusal, never a domain payload that happens to carry `kind`", () => {
    // `PlannerResult` is discriminated on `kind`. A bare `"refusal"` literal would make a
    // planner result that said `kind: "refusal"` indistinguishable from one.
    expect(isNodeRefusal({ kind: "ready", spec: {} })).toBe(false);
    expect(isNodeRefusal({ kind: "refusal" })).toBe(false);
    expect(isNodeRefusal(null)).toBe(false);
    expect(isNodeRefusal("refusal")).toBe(false);
    expect(isNodeRefusal({ kind: NODE_REFUSAL_KIND })).toBe(true);
  });
});

// ── sc-11-4 / sc-11-5, end to end on the committed artifact ─────────

describe("PLAN REGION: a refused contract set reaches no downstream node and no state key (sc-11-4, sc-11-5)", () => {
  /**
   * Run the plan region with ONE producer changed: `plan_materialize` emits a contract set
   * missing `successCriteria` on its output port.
   *
   * Two deliberate choices in the override, both load-bearing:
   *
   *  1. it writes NO channel. The failure being reproduced is "the materialiser produced
   *     something malformed", and a run that had already merged the malformed value would
   *     be testing the commit boundary rather than the gate. The gate is the first and only
   *     thing standing between the bad payload and the rest of the run;
   *  2. it relaxes the MATERIALISER'S OWN `outputSchema`. The interpreter parses a
   *     handler's return value with the producing node's output schema before it routes
   *     (`interpreter.ts:958`), and `plan_materialize` binds `PlanContractsSchema` — so
   *     against the shipped implementation the malformed set never leaves the materialiser
   *     and `gate_plan_out` is never dispatched at all. A test that stopped there would
   *     have proved something about the materialiser while claiming something about the
   *     gate. Nothing about the GATE is overridden, and the last test in this block re-runs
   *     the identical region with no override at all.
   */
  async function runWithBadContracts(): Promise<RegionRun> {
    return runRegion({
      projectRoot: root,
      region: PLAN_REGION,
      runId: "run-gate-region",
      bindings: {
        reflect: async () => ({}),
        critique: async () => ({ critique: null }),
        planner: async () => ({ kind: "ready" as const, spec: stubPlanSpec() }),
        materialize: async (spec) => stubContracts(spec),
        implOverrides: {
          [PLAN_NODE_IDS.materialize]: (impl) => ({
            ...impl,
            outputSchema: z.unknown(),
            handler: async () => ({
              goto: { kind: "node", node: PLAN_NODE_IDS.exitGate },
              output: [contractWithEmptyCriteria()],
            }),
          }),
        },
      },
      seed: (state) => seedResearchDigest(root, "run-gate-region", state, stubDigest()),
    });
  }

  /** The superstep the exit gate executed in, read off the trace rather than guessed. */
  function gateSuperstep(run: RegionRun): number {
    const span = run.spans.find((entry) => entry.nodeId === PLAN_NODE_IDS.exitGate);
    if (span === undefined) throw new Error("the exit gate never executed");
    return span.superstep;
  }

  it("never dispatches the node the admit-path edge names", async () => {
    const run = await runWithBadContracts();

    expect(run.handlerLog.calls[PLAN_NODE_IDS.exitGate]).toBe(1);

    // The admit-path successor is the supervisor, and the artifact's `e-plan-exit` edge is
    // the only way back to it from here. It was entered exactly once — dispatching the
    // plan phase at the start of the run — and never a second time by this gate.
    const successor = soleSuccessor(PLAN_SPEC, PLAN_NODE_IDS.exitGate);
    expect(run.handlerLog.calls[successor]).toBe(1);
    expect((run.inputLog.inputs[successor] ?? []).filter(isNodeRefusal)).toEqual([]);

    // The trace agrees: the route the gate actually took was the declared failure endpoint.
    const span = run.spans.find((entry) => entry.nodeId === PLAN_NODE_IDS.exitGate);
    expect(span?.route?.goto).toEqual({ kind: "node", node: "graceful_failure" });
    expect(run.handlerLog.calls.graceful_failure).toBe(1);
  });

  it("carries the Zod path naming successCriteria into the failure the terminal records", async () => {
    const run = await runWithBadContracts();

    const refusal = (run.inputLog.inputs.graceful_failure ?? [])[0] as NodeRefusal;
    expect(isNodeRefusal(refusal)).toBe(true);
    expect(refusal.nodeId).toBe(PLAN_NODE_IDS.exitGate);
    expect(refusal.issues.map((issue) => issue.path)).toEqual(["0.successCriteria"]);

    const artifact = await readFailureArtifact(root, run.runId);
    expect(artifact?.reason).toContain("spec-and-contracts-persisted");
  });

  it("commits a state at the gate's superstep that is STRUCTURALLY IDENTICAL to the one before it", async () => {
    const run = await runWithBadContracts();
    const superstep = gateSuperstep(run);
    const snapshot = run.snapshots.find((entry) => entry.superstep === superstep);
    if (snapshot === undefined) throw new Error("the gate's superstep was never committed");

    // The whole object, both directions. Not "the payload is absent from `sprintContracts`"
    // — a quarantine key anywhere in `OverallState` would satisfy that and fail this.
    expect(deepSnapshot(snapshot.after)).toEqual(deepSnapshot(snapshot.before));
    expect(Object.keys(snapshot.after).sort()).toEqual(Object.keys(snapshot.before).sort());

    // Positive control: the recorder really is capturing differing states elsewhere in the
    // same run, so the equality above is a fact about the GATE and not about the harness.
    const changing = run.snapshots.filter(
      (entry) => JSON.stringify(entry.before) !== JSON.stringify(entry.after),
    );
    expect(changing.length).toBeGreaterThan(0);
  });

  it("leaves the invalid payload in NO state key, NO artifact and NO file", async () => {
    const run = await runWithBadContracts();

    // The whole serialized state, so a quarantine key under any name is caught.
    expect(JSON.stringify(run.finalState)).not.toContain(INVALID_PAYLOAD_MARKER);
    for (const snapshot of run.snapshots) {
      expect(JSON.stringify(snapshot.after)).not.toContain(INVALID_PAYLOAD_MARKER);
    }

    expect(run.finalState.sprintContracts).toEqual([]);
    expect(run.finalState.spec).toBeNull();
    expect(run.artifactLog.contracts).toEqual([]);
    expect(run.artifactLog.specs).toEqual([]);
    await expect(readdir(join(root, ".bober", "contracts"))).rejects.toThrow();
  });

  it("positive control: the SAME region admits a well-formed contract set and materialises it", async () => {
    // Proves the four assertions above are about the payload and not about a plan region
    // that cannot produce contracts at all.
    const run = await runRegion({
      projectRoot: root,
      region: PLAN_REGION,
      runId: "run-gate-region-ok",
      bindings: {
        reflect: async () => ({}),
        critique: async () => ({ critique: null }),
        planner: async () => ({ kind: "ready" as const, spec: stubPlanSpec() }),
        materialize: async (spec) => stubContracts(spec),
      },
      seed: (state) => seedResearchDigest(root, "run-gate-region-ok", state, stubDigest()),
    });

    expect(run.result.status).toBe("completed");
    expect(run.handlerLog.calls.graceful_failure).toBeUndefined();
    expect(run.finalState.sprintContracts.length).toBeGreaterThan(0);
    expect(run.artifactLog.contracts.length).toBeGreaterThan(0);
    for (const contract of run.finalState.sprintContracts) {
      expect(() => SprintContractSchema.parse(contract)).not.toThrow();
    }
  });
});

// ── The subgraph-scope fail route ───────────────────────────────────

describe("SCOPE: a subgraph gate fails through its parent, a root gate straight to the terminal", () => {
  it("gives a research-scope gate `{ kind: \"parent\" }` and a root gate the declared node", async () => {
    // `gate.onFail` is a POLICY endpoint the VALIDATOR folds into reachability
    // (`validate.ts:189-213`); the COMPILED adjacency comes from `spec.edges` alone
    // (`compiler.ts:373-379`). A research-scope gate that returned `{ kind: "node", node:
    // "graceful_failure" }` is refused at runtime with `UnknownNodeInScopeError`, so it
    // leaves through the boundary the artifact already declares.
    expect(nodeSpecOf(CODING_GRAPH, RESEARCH_NODE_IDS.entryGate).subgraph).toBe(RESEARCH_REGION);
    expect(nodeSpecOf(CODING_GRAPH, PLAN_NODE_IDS.exitGate).subgraph).toBeNull();

    const inner = schemaGate({
      spec: RESEARCH_SPEC,
      nodeId: RESEARCH_NODE_IDS.entryGate,
      admitted: z.object({ featureRequest: z.string().min(1) }),
    });
    const innerCommand = await inner.handler(
      { featureRequest: "" },
      emptyState(),
      gateContext({ nodeId: RESEARCH_NODE_IDS.entryGate }),
    );
    expect(innerCommand.goto).toEqual({ kind: "parent" });

    const outer = planExitGate(PLAN_SPEC);
    const outerCommand = await outer.handler([], emptyState(), gateContext());
    expect(outerCommand.goto).toEqual({ kind: "node", node: "graceful_failure" });
  });
});

// ── Artifact-derived construction ───────────────────────────────────

describe("GATE CONSTRUCTION: every declaration is read off the artifact, never restated", () => {
  it("refuses to build a gate for a node the artifact does not declare", () => {
    expect(() =>
      schemaGate({ spec: PLAN_SPEC, nodeId: "gate_that_does_not_exist", admitted: z.unknown() }),
    ).toThrow(NodeSpecMismatchError);
  });

  it("refuses to build a gate for a node the artifact declares as something else", () => {
    expect(() =>
      schemaGate({ spec: PLAN_SPEC, nodeId: PLAN_NODE_IDS.draft, admitted: z.unknown() }),
    ).toThrow(/declared as kind "llm", not "gate"/);
  });

  it("reads each port off the artifact, and `null` when the artifact declares none", () => {
    const supervisor = nodeSpecOf(CODING_GRAPH, CODING_GRAPH.defaults.supervisorNodeId);
    expect(portOf(supervisor, "input")).toBeNull();
    expect(portOf(supervisor, "output")).toBeNull();

    const route = nodeSpecOf(CODING_GRAPH, RESEARCH_NODE_IDS.route);
    expect(portOf(route, "input")).toEqual({ key: "digest", schemaRef: "ResearchDigest" });
    // Declared `outputPorts: []`, which is why the implementation binds `null` — and why
    // the value its handler returns is forwarded by the interpreter rather than by a port.
    expect(portOf(route, "output")).toBeNull();
  });

  it("refuses a node declaring more than one port on a side", () => {
    const twoPorted: TopologySpec = {
      ...PLAN_SPEC,
      nodes: PLAN_SPEC.nodes.map((node) =>
        node.id === PLAN_NODE_IDS.exitGate
          ? {
              ...node,
              inputPorts: [
                { key: "contracts", schemaRef: "SprintContract", required: true },
                { key: "extra", schemaRef: "SprintContract", required: true },
              ],
            }
          : node,
      ),
    };
    expect(() => portOf(nodeSpecOf(twoPorted, PLAN_NODE_IDS.exitGate), "input")).toThrow(
      /declares 2 input ports/,
    );
  });

  it("reads the admit-path successor off the artifact's own NORMAL edges", () => {
    expect(soleSuccessor(PLAN_SPEC, PLAN_NODE_IDS.draft)).toBe(PLAN_NODE_IDS.clarifyCheck);
    // A router's outgoing edges are conditional and belong to its label set, so there is
    // no unlabelled successor to read.
    expect(() => soleSuccessor(PLAN_SPEC, PLAN_NODE_IDS.clarifyCheck)).toThrow(
      /declares 0 normal outgoing edge/,
    );
  });

  it("reads a loop bound off the artifact, and refuses to invent one", () => {
    expect(loopBoundOf(CODING_GRAPH, RESEARCH_NODE_IDS.route)).toEqual({
      counterKey: "researchReflexions",
      maxIterations: 3,
    });
    expect(() => loopBoundOf(CODING_GRAPH, PLAN_NODE_IDS.materialize)).toThrow(
      /declares no loop bound/,
    );
  });

  it("keeps the plan contract payload as the SHIPPED SprintContract, with no parallel type", () => {
    // sc-11-9's runtime companion: the compile-time `Exact` guards in `plan.ts` and
    // `state/overall.ts` fail `tsc` on a parallel type, and this asserts the two schemas
    // accept and reject the same value.
    const [valid] = stubContracts(stubPlanSpec());
    expect(PlanContractsSchema.parse([valid])).toEqual([SprintContractSchema.parse(valid)]);
    expect(PlanContractsSchema.safeParse([contractWithEmptyCriteria()]).success).toBe(false);
    expect(SprintContractSchema.safeParse(contractWithEmptyCriteria()).success).toBe(false);
  });

  it("builds a precondition issue with matching dotted and segmented paths", () => {
    expect(preconditionIssue("sprintContracts", "missing")).toEqual({
      path: "sprintContracts",
      pathSegments: ["sprintContracts"],
      code: "custom",
      message: "missing",
    });
    expect(preconditionIssue("", "root").pathSegments).toEqual([]);
  });
});

// ── A refusal is a value, and it type-checks as one ─────────────────

describe("REFUSAL TYPE: a refusal is the shipped SprintContract's alternative, not a look-alike", () => {
  it("parses through its own schema and carries no contract fields", () => {
    const refusal: NodeRefusal = refuse(gateContext(), {
      check: "spec-and-contracts-persisted",
      onFail: "graceful_failure",
      issues: [preconditionIssue("successCriteria", "missing")],
    });
    const asRecord = refusal as unknown as Record<string, unknown>;
    for (const contractKey of ["contractId", "specId", "successCriteria", "definitionOfDone"]) {
      expect(asRecord[contractKey]).toBeUndefined();
    }
    const notAContract: SprintContract | undefined =
      SprintContractSchema.safeParse(refusal).success === true
        ? (refusal as unknown as SprintContract)
        : undefined;
    expect(notAContract).toBeUndefined();
  });
});
