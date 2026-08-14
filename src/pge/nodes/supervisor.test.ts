import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BoberConfig } from "../../config/schema.js";
import { TERMINAL_ENDPOINT } from "../../contracts/topology.js";
import type { NodeSpec, SubgraphDecl, TopologySpec } from "../../contracts/topology.js";
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
import { readFailureArtifact } from "../runtime/graceful-failure.js";
import { initialOverallState } from "../state/overall.js";
import type { GraphMessage, OverallState } from "../state/overall.js";
import { CODING_GRAPH } from "../topology/coding.graph.js";
import {
  compileRegion,
  runRegion,
  seedResearchDigest,
  stubDigest,
  stubContracts,
  stubPlanSpec,
  stubReflection,
  stubResearchDoc,
} from "./__fixtures__/region-harness.js";
import { EFFECTS, gracefulFailureEffect } from "./effects.js";
import { NODE_REFUSAL_KIND, isNodeRefusal, nodeSpecOf, refuse, preconditionIssue } from "./gates.js";
import { PLAN_NODE_IDS } from "./plan.js";
import {
  GRACEFUL_FAILURE_NODE_ID,
  PLAN_REGION,
  RESEARCH_REGION,
  regionEdges,
  regionExitEdges,
  regionNodeIds,
  regionSpec,
  subgraphCallSiteDepths,
  supervisorTarget,
} from "./regions.js";
import { RESEARCH_NODE_IDS } from "./research.js";
import { COMPACT_LABEL, PLAN_LABEL, gracefulFailureNode, supervisorNode } from "./supervisor.js";

/**
 * The two-level tree: the supervisor router, the failure terminal, and the structural
 * claims sc-11-6 makes about the regions hanging off them.
 *
 * ── THE CONTRACT SAYS "plan subgraph". THE ARTIFACT DECLARES NO SUCH THING. ──
 *
 * `coding.graph.ts` declares exactly two subgraphs, `research` and `sprint`, and every plan
 * node carries `subgraph: null`. The artifact's own header states it, the architecture
 * blueprint marks only `{{subgraph research}}` and `{{subgraph sprint}}`, and
 * `coding.graph.test.ts` pins it. sc-11-6 and sc-11-7's "plan subgraph" wording is an error
 * in the contract, and the artifact is right. The first test below asserts the artifact's
 * answer directly, so the discrepancy is settled by the repository rather than by a claim
 * in a completion note, and "plan subgraph" is read everywhere as "plan REGION".
 *
 * What each test here exists to catch:
 *
 *  - a depth assertion that passes because it is computed from the hand-editable `depth`
 *    field on a `SubgraphDecl` rather than from the CALL SITE, which is how an artifact
 *    would be able to lie about how deeply it nests. The computation mirrors
 *    `validate.ts:1033-1052`, and a synthetic three-level nesting below proves it can
 *    actually produce a number greater than 2;
 *  - an exit-edge assertion that passes vacuously because the region has no exit edges at
 *    all — every one below asserts a non-empty set first;
 *  - an exit-edge assertion written against the edge IDs `e-research-exit` and
 *    `e-plan-exit`, which would keep passing after someone retargeted them. They are
 *    derived from `defaults.supervisorNodeId` and only cross-checked against the ids;
 *  - a supervisor that routes by NODE ID, which usually still "works" because the target
 *    happens to be in scope, and silently removes the artifact's routing from the diff
 *    (ADR-3);
 *  - a supervisor that would dispatch a label whose target the projected region does not
 *    contain, which resolves through `node.spec.targets` and then fails looking the node up
 *    in scope.
 */

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bober-pge-supervisor-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const SUPERVISOR_ID = CODING_GRAPH.defaults.supervisorNodeId;
const RESEARCH_SPEC = regionSpec(CODING_GRAPH, RESEARCH_REGION);
const PLAN_SPEC = regionSpec(CODING_GRAPH, PLAN_REGION);

/** The deepest call-site nesting any declared subgraph reaches. 0 when none is declared. */
function maxNestingDepth(spec: TopologySpec): number {
  const depths = [...subgraphCallSiteDepths(spec).values()];
  return depths.length === 0 ? 0 : Math.max(...depths);
}

// ── The discrepancy, settled by the artifact ────────────────────────

describe("SUBGRAPH DECLARATIONS: the artifact declares research and sprint, and no plan subgraph", () => {
  it("declares exactly two subgraphs", () => {
    expect(CODING_GRAPH.subgraphs.map((decl) => decl.id)).toEqual(["research", "sprint"]);
    expect(CODING_GRAPH.subgraphs.map((decl) => decl.id)).not.toContain(PLAN_REGION);
  });

  it("gives every plan-region node `subgraph: null`", () => {
    for (const id of Object.values(PLAN_NODE_IDS)) {
      expect(nodeSpecOf(CODING_GRAPH, id).subgraph).toBeNull();
    }
    // Positive control: the research region's interior really is scoped, so the assertion
    // above is a fact about the plan nodes and not about `subgraph` being null everywhere.
    expect(nodeSpecOf(CODING_GRAPH, RESEARCH_NODE_IDS.reflect).subgraph).toBe(RESEARCH_REGION);
  });

  it("projects the plan REGION with no subgraph declaration of its own", () => {
    expect(PLAN_SPEC.subgraphs).toEqual([]);
    expect(compileRegion(PLAN_REGION, planBindings()).graph.subgraphs.size).toBe(0);
  });

  it("carries the artifact's own `research` declaration into the research projection", () => {
    expect(RESEARCH_SPEC.subgraphs).toEqual([
      CODING_GRAPH.subgraphs.find((decl) => decl.id === RESEARCH_REGION),
    ]);
  });
});

// ── sc-11-6: nesting depth ──────────────────────────────────────────

describe("NESTING DEPTH: at most two levels, computed from the CALL SITE (sc-11-6)", () => {
  it("nests the committed artifact at most 2 deep", () => {
    const depths = subgraphCallSiteDepths(CODING_GRAPH);
    expect([...depths.entries()].sort()).toEqual([
      ["research", 1],
      ["sprint", 1],
    ]);
    expect(maxNestingDepth(CODING_GRAPH)).toBeLessThanOrEqual(2);
  });

  it("nests the compiled research region at most 2 deep", () => {
    const compiled = compileRegion(RESEARCH_REGION, researchBindings());
    expect(maxNestingDepth(compiled.spec)).toBe(1);
    expect(maxNestingDepth(compiled.spec)).toBeLessThanOrEqual(2);

    // The call site is at the ROOT, which is what makes the depth 1: the region's
    // interior is one level below the graph the supervisor lives in.
    const callSite = compiled.spec.nodes.find(
      (node) => node.kind === "subgraph" && node.subgraphRef === RESEARCH_REGION,
    );
    expect(callSite?.id).toBe(RESEARCH_NODE_IDS.body);
    expect(callSite?.subgraph).toBeNull();
  });

  it("nests the compiled plan region at most 2 deep — it declares no subgraph at all", () => {
    const compiled = compileRegion(PLAN_REGION, planBindings());
    expect(maxNestingDepth(compiled.spec)).toBe(0);
    expect(maxNestingDepth(compiled.spec)).toBeLessThanOrEqual(2);
  });

  it("IGNORES the hand-editable `depth` field, so an artifact cannot lie about its nesting", () => {
    // Every declaration in the artifact says `depth: 1`. Rewriting them all to 9 must not
    // move the computed answer, because the answer comes from the call sites.
    const lying: TopologySpec = {
      ...CODING_GRAPH,
      subgraphs: CODING_GRAPH.subgraphs.map((decl) => ({ ...decl, depth: 9 })),
    };
    expect(maxNestingDepth(lying)).toBe(1);
  });

  it("negative control: a genuinely three-level nesting computes to 3, which is NOT at most 2", () => {
    // Without this the `toBeLessThanOrEqual(2)` assertions above could be true of a
    // function that never returns anything greater than 1.
    const callSite = (id: string, ref: string, parent: string | null): NodeSpec => ({
      ...(nodeSpecOf(CODING_GRAPH, RESEARCH_NODE_IDS.body) as NodeSpec),
      id,
      subgraphRef: ref,
      subgraph: parent,
    });
    const decl = (id: string): SubgraphDecl => ({
      ...(CODING_GRAPH.subgraphs[0] as SubgraphDecl),
      id,
      graphId: `coding.${id}`,
    });

    const twoLevels: TopologySpec = {
      ...CODING_GRAPH,
      nodes: [...CODING_GRAPH.nodes, callSite("inner_body", "inner", RESEARCH_REGION)],
      subgraphs: [...CODING_GRAPH.subgraphs, decl("inner")],
    };
    expect(subgraphCallSiteDepths(twoLevels).get("inner")).toBe(2);
    expect(maxNestingDepth(twoLevels)).toBe(2);

    const threeLevels: TopologySpec = {
      ...twoLevels,
      nodes: [...twoLevels.nodes, callSite("deepest_body", "deepest", "inner")],
      subgraphs: [...twoLevels.subgraphs, decl("deepest")],
    };
    expect(subgraphCallSiteDepths(threeLevels).get("deepest")).toBe(3);
    expect(maxNestingDepth(threeLevels)).toBeGreaterThan(2);
  });

  it("reports an infinite depth for a cycle of call sites rather than looping forever", () => {
    const callSite = (id: string, ref: string, parent: string | null): NodeSpec => ({
      ...(nodeSpecOf(CODING_GRAPH, RESEARCH_NODE_IDS.body) as NodeSpec),
      id,
      subgraphRef: ref,
      subgraph: parent,
    });
    const decl = (id: string): SubgraphDecl => ({
      ...(CODING_GRAPH.subgraphs[0] as SubgraphDecl),
      id,
      graphId: `coding.${id}`,
    });
    const cyclic: TopologySpec = {
      ...CODING_GRAPH,
      nodes: [
        ...CODING_GRAPH.nodes,
        callSite("a_body", "a", "b"),
        callSite("b_body", "b", "a"),
      ],
      subgraphs: [...CODING_GRAPH.subgraphs, decl("a"), decl("b")],
    };
    expect(subgraphCallSiteDepths(cyclic).get("a")).toBe(Number.POSITIVE_INFINITY);
    expect(maxNestingDepth(cyclic)).toBeGreaterThan(2);
  });
});

// ── sc-11-6: every region exit edge returns to the supervisor ───────

describe("REGION EXITS: every exit edge targets the supervisor node (sc-11-6)", () => {
  for (const region of [RESEARCH_REGION, PLAN_REGION] as const) {
    it(`returns control from the ${region} region to the supervisor, and nowhere else`, () => {
      const exits = regionExitEdges(CODING_GRAPH, region);
      // Not vacuous: the region has exit edges, and they are the ones asserted on.
      expect(exits.length).toBeGreaterThan(0);
      for (const edge of exits) {
        expect(edge.to).toBe(SUPERVISOR_ID);
      }

      // Every OTHER way out of the region is the terminal. There is no third exit.
      const ids = regionNodeIds(CODING_GRAPH, region);
      const leaving = regionEdges(CODING_GRAPH, region).filter(
        (edge) => edge.from !== SUPERVISOR_ID && (!ids.has(edge.to) || edge.to === SUPERVISOR_ID),
      );
      for (const edge of leaving) {
        expect([SUPERVISOR_ID, TERMINAL_ENDPOINT]).toContain(edge.to);
      }
    });
  }

  it("cross-checks the derived exits against the artifact's own edge ids", () => {
    // Derived from `defaults.supervisorNodeId` above so a retargeted edge is caught; named
    // here so a REMOVED edge is caught too.
    expect(regionExitEdges(CODING_GRAPH, RESEARCH_REGION).map((edge) => edge.id)).toEqual([
      "e-research-exit",
    ]);
    expect(regionExitEdges(CODING_GRAPH, PLAN_REGION).map((edge) => edge.id)).toEqual([
      "e-plan-exit",
    ]);
  });

  it("routes the research subgraph's DECLARED exit gate to the supervisor in the COMPILED graph", () => {
    const compiled = compileRegion(RESEARCH_REGION, researchBindings());
    const decl = CODING_GRAPH.subgraphs.find((entry) => entry.id === RESEARCH_REGION);
    if (decl === undefined) throw new Error("the artifact declares a research subgraph");

    const outgoing = compiled.graph.adjacency.get(decl.exitGate) ?? [];
    expect(outgoing.length).toBeGreaterThan(0);
    for (const edge of outgoing) {
      expect(edge.to).toBe(SUPERVISOR_ID);
    }
  });

  it("routes the plan region's exit gate to the supervisor in the COMPILED graph", () => {
    const compiled = compileRegion(PLAN_REGION, planBindings());
    const outgoing = compiled.graph.adjacency.get(PLAN_NODE_IDS.exitGate) ?? [];
    expect(outgoing.length).toBeGreaterThan(0);
    for (const edge of outgoing) {
      expect(edge.to).toBe(SUPERVISOR_ID);
    }
  });

  it("enters the plan region at whatever the supervisor's own `plan` target names", () => {
    expect(supervisorTarget(CODING_GRAPH, PLAN_LABEL)).toBe(PLAN_NODE_IDS.entryGate);
    expect(() => supervisorTarget(CODING_GRAPH, "no-such-label")).toThrow(
      /declares no "no-such-label" target/,
    );
  });
});

// ── The supervisor body ─────────────────────────────────────────────

const unusable = (what: string): never => {
  throw new Error(`${what} must not be touched by this test's supervisor`);
};

function supervisorContext(overrides: Partial<NodeContext> = {}): NodeContext {
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
  const prompts: PromptStore = { has: () => false, get: async () => unusable("PromptStore.get") };
  const models: ModelBinder = {
    bind: () => unusable("ModelBinder.bind"),
    profile: () => unusable("ModelBinder.profile"),
  };

  return {
    runId: "run-supervisor",
    projectRoot: root,
    config: {} as BoberConfig,
    nodeId: SUPERVISOR_ID,
    branchKey: null,
    superstep: 1,
    spanId: "span-supervisor",
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
    runId: "run-supervisor",
    projectRoot: root,
    featureRequest: "exercise the supervisor",
  });
}

describe("SUPERVISOR: a router that selects a LABEL the artifact declares (ADR-3)", () => {
  it("is declared a router with the four labels the artifact lists", () => {
    const declared = nodeSpecOf(CODING_GRAPH, SUPERVISOR_ID);
    expect(declared.kind).toBe("router");
    if (declared.kind !== "router") return;
    expect(declared.targets.map((target) => target.label).sort()).toEqual([
      "compact",
      "evaluate",
      "plan",
      "sprints",
    ]);
    expect(declared.loop).toEqual({
      counterKey: "supervisorRounds",
      maxIterations: 12,
      onExhausted: GRACEFUL_FAILURE_NODE_ID,
    });
  });

  it("dispatches the plan phase by LABEL, never by node id", async () => {
    const supervisor = supervisorNode({ spec: PLAN_SPEC });
    const command = await supervisor.handler(stubDigest(), emptyState(), supervisorContext());
    expect(command.goto).toEqual({ kind: "label", label: PLAN_LABEL });
    expect(command.goto.node).toBeUndefined();
  });

  it("NEVER selects a label whose target the projected region does not contain", async () => {
    // `RouterNodeSchema.targets` is `.min(1)`, so a projection cannot trim the three
    // targets it does not contain, and `resolveDestination` would resolve one of them
    // through `node.spec.targets` and then fail looking the node up in scope. The
    // dispatchable set is therefore derived from the nodes the graph actually has.
    const declared = nodeSpecOf(PLAN_SPEC, SUPERVISOR_ID);
    if (declared.kind !== "router") throw new Error("the supervisor is a router");
    const outOfRegion = declared.targets
      .map((target) => target.to)
      .filter((to) => !PLAN_SPEC.nodes.some((node) => node.id === to));
    expect(outOfRegion.length).toBeGreaterThan(0);

    // In the RESEARCH projection the plan target is absent, so `plan` is undispatchable
    // and the supervisor ends the run rather than naming it.
    const supervisor = supervisorNode({ spec: RESEARCH_SPEC });
    const command = await supervisor.handler(stubDigest(), emptyState(), supervisorContext());
    expect(command.goto).toEqual({ kind: "node", node: TERMINAL_ENDPOINT });
  });

  it("finishes the hop a subgraph gate started, sending a refusal to the failure terminal", async () => {
    // A research-scope gate leaves its region with `{ kind: "parent" }`, which lands here.
    // The supervisor completes the journey the gate's own `gate.onFail` declared.
    const refusal = refuse(supervisorContext({ nodeId: RESEARCH_NODE_IDS.exitGate }), {
      check: "research-document-written",
      onFail: GRACEFUL_FAILURE_NODE_ID,
      issues: [preconditionIssue("documentId", "no research document was written")],
    });
    const supervisor = supervisorNode({ spec: RESEARCH_SPEC });
    const command = await supervisor.handler(refusal, emptyState(), supervisorContext());

    expect(command.goto).toEqual({ kind: "node", node: GRACEFUL_FAILURE_NODE_ID });
    expect(isNodeRefusal(command.output)).toBe(true);
    expect((command.output as { kind: string }).kind).toBe(NODE_REFUSAL_KIND);
  });

  it("ends the run once the plan is ready, rather than dispatching planning again", async () => {
    const supervisor = supervisorNode({ spec: PLAN_SPEC });
    const ready: OverallState = { ...emptyState(), spec: stubPlanSpec() };
    const command = await supervisor.handler(undefined, ready, supervisorContext());
    expect(command.goto).toEqual({ kind: "node", node: TERMINAL_ENDPOINT });
  });

  it("does not dispatch planning when no brief exists anywhere", async () => {
    // `state.refs` carries no digest and nothing was handed over, so there is no brief to
    // plan from — and a supervisor that fabricated one would send the planner into a
    // phase it cannot perform.
    const supervisor = supervisorNode({ spec: PLAN_SPEC });
    const command = await supervisor.handler(undefined, emptyState(), supervisorContext());
    expect(command.goto).toEqual({ kind: "node", node: TERMINAL_ENDPOINT });
  });

  it("refuses to build a supervisor for a node the artifact does not declare as a router", () => {
    const notARouter: TopologySpec = {
      ...PLAN_SPEC,
      defaults: { ...PLAN_SPEC.defaults, supervisorNodeId: PLAN_NODE_IDS.draft },
    };
    expect(() => supervisorNode({ spec: notARouter })).toThrow(/is not a router node/);
  });
});

// ── CLAIM BACKING: coverage.test.ts's NEVER_EXECUTED entry for `context_compact` ──

/**
 * `coverage.test.ts`'s `NEVER_EXECUTED` doc block claims the shipped supervisor handler has
 * NO code path that returns `COMPACT_LABEL`, across every state the COMMITTED coding graph
 * can produce — not just the projected regions the tests above exercise. This is the test
 * that backs that claim: it fails the moment the claim stops being true, whether that
 * happens by a direct edit to `supervisorNode` or by any state this file did not think to
 * try producing one indirectly.
 */
describe("CLAIM: the shipped supervisor never selects the compact label (coverage.test.ts NEVER_EXECUTED)", () => {
  /** A message window large enough to make a token-threshold heuristic want to compact. */
  function largeMessageWindow(count: number): GraphMessage[] {
    return Array.from({ length: count }, (_, index) => ({
      id: `m-${String(index)}`,
      seq: index,
      role: "assistant" as const,
      nodeId: "sprint_generate",
      text: "x".repeat(400),
      tokens: 200,
    }));
  }

  it("never selects 'compact' across empty, plan-ready, branches-settled and a large message window", async () => {
    const supervisor = supervisorNode({ spec: CODING_GRAPH });
    const states: OverallState[] = [
      emptyState(),
      { ...emptyState(), spec: stubPlanSpec() },
      {
        ...emptyState(),
        spec: stubPlanSpec(),
        branchStatus: { "sprint-spec-a": { state: "succeeded", attempts: 1 } },
      },
      { ...emptyState(), spec: stubPlanSpec(), messages: largeMessageWindow(500) },
    ];

    for (const state of states) {
      const command = await supervisor.handler(undefined, state, supervisorContext());
      expect(command.goto).not.toEqual({ kind: "label", label: COMPACT_LABEL });
    }
  });
});

// ── The failure terminal ────────────────────────────────────────────

describe("GRACEFUL FAILURE: records what it was told, writes the artifact, sets no verdict", () => {
  function terminalContext(): NodeContext {
    const registry = createEffectRegistry();
    registry.register(gracefulFailureEffect());
    return supervisorContext({
      nodeId: GRACEFUL_FAILURE_NODE_ID,
      declaredEffects: ["fs-write"],
      effects: registry,
      superstep: 7,
    });
  }

  it("writes the failure artifact through the effect the artifact authorises", async () => {
    const terminal = gracefulFailureNode({ spec: PLAN_SPEC });
    const command = await terminal.handler(
      { reason: "the region could not continue" },
      emptyState(),
      terminalContext(),
    );

    expect(command.goto).toEqual({ kind: "node", node: TERMINAL_ENDPOINT });
    const artifact = await readFailureArtifact(root, "run-supervisor");
    expect(artifact?.reason).toBe("the region could not continue");
    expect(artifact?.supersteps).toBe(7);
  });

  it("appends exactly ONE message and touches no other channel", async () => {
    const terminal = gracefulFailureNode({ spec: PLAN_SPEC });
    const command = await terminal.handler({ reason: "boom" }, emptyState(), terminalContext());

    expect(Object.keys(command.update ?? {})).toEqual(["messages"]);
    expect(command.update?.messages).toHaveLength(1);
    // `finalize` owns the terminal verdict, so this node sets no phase and no verdict.
    expect(command.phase).toBeUndefined();
    expect(command.update?.verdict).toBeUndefined();
  });

  it("names the refused CHECK when what reached it is a refusal", async () => {
    const terminal = gracefulFailureNode({ spec: PLAN_SPEC });
    const refusal = refuse(supervisorContext({ nodeId: PLAN_NODE_IDS.exitGate }), {
      check: "spec-and-contracts-persisted",
      onFail: GRACEFUL_FAILURE_NODE_ID,
      issues: [preconditionIssue("successCriteria", "missing")],
    });
    const command = await terminal.handler(refusal, emptyState(), terminalContext());

    expect(command.update?.messages?.[0].text).toContain("spec-and-contracts-persisted");
    const artifact = await readFailureArtifact(root, "run-supervisor");
    expect(artifact?.reason).toBe("NodeRefusal:spec-and-contracts-persisted");
  });

  it("records an UNRECOGNISED input rather than throwing on it", async () => {
    // The terminal's job is to keep the account of the failure that brought the run here.
    // A terminal that threw on an unexpected shape would lose exactly that account.
    const terminal = gracefulFailureNode({ spec: PLAN_SPEC });
    const command = await terminal.handler("not a failure record", emptyState(), terminalContext());
    expect(command.goto).toEqual({ kind: "node", node: TERMINAL_ENDPOINT });
    expect((await readFailureArtifact(root, "run-supervisor"))?.reason).toBe("Unknown");
  });

  it("is refused the fs-write effect when the calling node did not declare it", async () => {
    // The declaration in the COMMITTED artifact is what authorises the write, and the
    // effect registry re-checks it at call time however the registry was obtained.
    const registry = createEffectRegistry();
    registry.register(gracefulFailureEffect());
    const terminal = gracefulFailureNode({ spec: PLAN_SPEC });
    await expect(
      terminal.handler(
        { reason: "boom" },
        emptyState(),
        supervisorContext({
          nodeId: GRACEFUL_FAILURE_NODE_ID,
          declaredEffects: [],
          effects: registry,
        }),
      ),
    ).rejects.toThrow(/fs-write|declare/i);
    // And it was refused BEFORE the write, not after: no artifact exists.
    expect(await readFailureArtifact(root, "run-supervisor")).toBeUndefined();
  });

  it("declares fs-write on the artifact node, which is what makes the write legal", () => {
    expect(nodeSpecOf(CODING_GRAPH, GRACEFUL_FAILURE_NODE_ID).effects).toEqual(["fs-write"]);
    expect(nodeSpecOf(CODING_GRAPH, GRACEFUL_FAILURE_NODE_ID).toolRef).toBe(
      EFFECTS.gracefulFailure,
    );
  });
});

// ── The two-level tree, exercised ───────────────────────────────────

describe("TWO-LEVEL TREE: control leaves a region through its exit gate and returns to the supervisor", () => {
  it("runs research -> supervisor and plan -> supervisor against the committed artifact", async () => {
    const research = await runRegion({
      projectRoot: root,
      region: RESEARCH_REGION,
      runId: "run-tree-research",
      bindings: researchBindings(),
    });
    expect(research.result.status).toBe("completed");
    // The supervisor ran AFTER the region's exit gate, which is the exit edge doing its job.
    const order = research.spans
      .filter((span) => span.nodeId === RESEARCH_NODE_IDS.exitGate || span.nodeId === SUPERVISOR_ID)
      .map((span) => span.nodeId);
    expect(order).toEqual([RESEARCH_NODE_IDS.exitGate, SUPERVISOR_ID]);

    const plan = await runRegion({
      projectRoot: root,
      region: PLAN_REGION,
      runId: "run-tree-plan",
      bindings: planBindings(),
      seed: (state) => seedResearchDigest(root, "run-tree-plan", state, stubDigest()),
    });
    expect(plan.result.status).toBe("completed");
    // Entered at the supervisor, out through the plan region, back to the supervisor.
    expect(
      plan.spans.filter((span) => span.nodeId === SUPERVISOR_ID).map((span) => span.superstep),
    ).toHaveLength(2);
    expect(plan.handlerLog.calls[PLAN_NODE_IDS.exitGate]).toBe(1);
    expect(plan.handlerLog.calls[GRACEFUL_FAILURE_NODE_ID]).toBeUndefined();
  });
});

// ── Bindings ────────────────────────────────────────────────────────

function researchBindings(): Parameters<typeof runRegion>[0]["bindings"] {
  return {
    reflect: async () => stubReflection(),
    critique: async () => ({ critique: null }),
    research: async () => stubResearchDoc(1, null),
  };
}

function planBindings(): Parameters<typeof runRegion>[0]["bindings"] {
  return {
    reflect: async () => ({}),
    critique: async () => ({ critique: null }),
    planner: async () => ({ kind: "ready" as const, spec: stubPlanSpec() }),
    // Bound explicitly. The default is the SHIPPED `materializeContracts`, which reaches a
    // model provider for contract precision and persists each contract itself — neither of
    // which belongs in a structural test of the two-level tree.
    materialize: async (spec) => stubContracts(spec),
  };
}
