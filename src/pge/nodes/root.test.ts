import { describe, expect, it } from "vitest";

import type { BoberConfig } from "../../config/schema.js";
import type { SprintContract } from "../../contracts/sprint-contract.js";
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
import type { BranchStatus, OverallState, SprintVerdict } from "../state/overall.js";
import { CODING_GRAPH } from "../topology/coding.graph.js";
import { stubContracts, stubPlanSpec } from "./__fixtures__/region-harness.js";
import { loopBoundOf, nodeSpecOf } from "./gates.js";
import { ROOT_NODE_IDS, evalRouterNode, reworkRoundsTaken, reworkRouterNode } from "./root.js";
import { dispatchableContracts } from "./sprint-fanout.js";
import { EVALUATE_LABEL, SPRINTS_LABEL, supervisorNode } from "./supervisor.js";

/**
 * CLAIM BACKING: `coverage.test.ts`'s `NEVER_EXECUTED` entry for `synthesize`.
 *
 * ── The claim, restated ──
 *
 * `synthesize` is reachable through exactly one edge, `route_after_eval`'s `"partial"`
 * label (`e-eval-partial`, `coding.graph.ts`), and `route_after_eval` (`evalRouterNode`
 * below) selects that label only when `reworkRoundsTaken(spec, state) >= maxIterations`
 * — `rework_route`'s own declared bound, 2. `coverage.test.ts`'s `NEVER_EXECUTED` doc block
 * claims that bound can never be reached inside a single run. This file backs that claim
 * with four pieces, each independently testable against the SHIPPED code rather than
 * asserted in prose, so the claim fails the moment any one of them stops being true:
 *
 *  1. `supervisorNode` never selects its `"evaluate"` label while `dispatchableContracts`
 *     over `sprintContracts` is non-empty — `nodes/supervisor.ts:165` checks `"sprints"`
 *     FIRST. So the only state from which `evaluate_global` can ever be dispatched is one
 *     where every planned contract has already settled `"succeeded"`.
 *  2. `evaluate_global`, `route_after_eval` and `critique` — the whole path between that
 *     dispatch and `rework_route`'s own execution — write neither `sprintContracts` nor
 *     `branchStatus` (read off the committed artifact directly, not the implementation), so
 *     the state claim 1 establishes is EXACTLY what `rework_route` inspects when it runs.
 *  3. `reworkRouterNode`, given that state, always selects `"exhausted"` — never its own
 *     `"rework"` fan-out, the one edge that could loop back to `evaluate_global` a second
 *     time — because its dispatch set (`dispatchableContracts` again) is empty. A negative
 *     control proves the router's own code CAN select `"rework"`; it is the STATE claims 1
 *     and 2 rule out, not a missing branch in this node's body.
 *  4. `evalRouterNode` itself correctly implements `"partial"` and `"exhausted"` once the
 *     rework bound IS spent — proven against a synthetic, injected counter, precisely
 *     because claims 1-3 say no real run ever produces that counter value. This is the fact
 *     that makes `synthesize`'s block a different KIND of block from `context_compact`'s
 *     neighbouring `NEVER_EXECUTED` entry: `context_compact`'s label-selection code does not
 *     exist at all (see `nodes/supervisor.test.ts`'s own CLAIM BACKING block); `synthesize`'s
 *     does, correctly, and is simply never fed the precondition it is written to react to.
 *
 * Read together: `rework_route` can execute AT MOST once per run — claim 3 ends every
 * reachable run at `graceful_failure` on its first pass — so `route_after_eval` is invoked
 * AT MOST once, and its own `reworkRoundsTaken >= maxIterations` branch (claim 4) is
 * therefore dead code by construction, not a missing scenario a golden case could still
 * supply. Sprint 9 of `spec-20260814-pge-full-convergence` added this file: the reasoning
 * was already recorded in `coverage.test.ts` and `docs/pge-graph.md` by sprint 8, but
 * nothing backed it with a test the way `context_compact`'s block is backed.
 */

// ── A context whose every collaborator throws (gates.test.ts / supervisor.test.ts style) ──

const unusable = (what: string): never => {
  throw new Error(`${what} must not be touched by these root-scope router bodies`);
};

function rootContext(overrides: Partial<NodeContext> = {}): NodeContext {
  const clock: Clock = {
    now: () => new Date("2026-08-14T00:00:00.000Z"),
    nowMs: () => Date.parse("2026-08-14T00:00:00.000Z"),
    nowIso: () => "2026-08-14T00:00:00.000Z",
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
    runId: "run-root-claim",
    projectRoot: "/tmp/project",
    config: {} as BoberConfig,
    nodeId: ROOT_NODE_IDS.reworkRoute,
    branchKey: null,
    superstep: 1,
    spanId: "span-root-claim",
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

// ── State builders ───────────────────────────────────────────────────

/** Two distinct sprint contracts, so the dispatch-set claims are not vacuous over one. */
function twoContracts(): [SprintContract, SprintContract] {
  const [first] = stubContracts(stubPlanSpec());
  const second: SprintContract = {
    ...first,
    contractId: `${first.contractId}-second`,
    sprintNumber: first.sprintNumber + 1,
  };
  return [first, second];
}

function baseState(contracts: readonly SprintContract[]): OverallState {
  return {
    ...initialOverallState({
      runId: "run-root-claim",
      projectRoot: "/tmp/project",
      featureRequest: "exercise the root-scope routers",
    }),
    // A ready plan, so `supervisorNode`'s `needsPlan` guard never fires and the digest
    // resolution path (the one place the supervisor body touches `ctx`) is never entered.
    spec: stubPlanSpec(),
    sprintContracts: [...contracts],
  };
}

const succeeded = (attempts = 1): BranchStatus => ({ state: "succeeded", attempts });
const failedBranch = (attempts = 1): BranchStatus => ({
  state: "failed",
  attempts,
  errorClass: "EvaluationFailed",
});

const SUPERVISOR_ID = CODING_GRAPH.defaults.supervisorNodeId;

// ── Claim 1 ─────────────────────────────────────────────────────────

describe("CLAIM 1 — supervisorNode never selects 'evaluate' while a contract is still owed a branch", () => {
  it("picks 'sprints' over 'evaluate' while one of two contracts has not yet succeeded", async () => {
    const [a, b] = twoContracts();
    const state: OverallState = {
      ...baseState([a, b]),
      branchStatus: { [a.contractId]: succeeded() },
    };
    // b has no branchStatus entry at all — never dispatched, still owed a branch.
    expect(dispatchableContracts(state, state.sprintContracts).map((c) => c.contractId)).toEqual([
      b.contractId,
    ]);

    const supervisor = supervisorNode({ spec: CODING_GRAPH });
    const command = await supervisor.handler(
      undefined,
      state,
      rootContext({ nodeId: SUPERVISOR_ID }),
    );
    expect(command.goto).toEqual({ kind: "label", label: SPRINTS_LABEL });
  });

  it("picks 'evaluate' only once EVERY contract has settled succeeded — the one state 'evaluate' can ever be selected from", async () => {
    const [a, b] = twoContracts();
    const state: OverallState = {
      ...baseState([a, b]),
      branchStatus: { [a.contractId]: succeeded(), [b.contractId]: succeeded(2) },
    };
    expect(dispatchableContracts(state, state.sprintContracts)).toEqual([]);

    const supervisor = supervisorNode({ spec: CODING_GRAPH });
    const command = await supervisor.handler(
      undefined,
      state,
      rootContext({ nodeId: SUPERVISOR_ID }),
    );
    expect(command.goto).toEqual({ kind: "label", label: EVALUATE_LABEL });
  });
});

// ── Claim 2 ─────────────────────────────────────────────────────────

describe("CLAIM 2 — nothing between the supervisor's dispatch guard and rework_route's own run changes what dispatchableContracts inspects", () => {
  it("evaluate_global, route_after_eval and critique write neither sprintContracts nor branchStatus", () => {
    for (const id of [
      ROOT_NODE_IDS.evaluateGlobal,
      ROOT_NODE_IDS.routeAfterEval,
      ROOT_NODE_IDS.critique,
    ]) {
      const writes = nodeSpecOf(CODING_GRAPH, id).writes;
      expect(writes, `${id}.writes should not include sprintContracts`).not.toContain(
        "sprintContracts",
      );
      expect(writes, `${id}.writes should not include branchStatus`).not.toContain(
        "branchStatus",
      );
    }
  });
});

// ── Claim 3 ─────────────────────────────────────────────────────────

describe("CLAIM 3 — reworkRouterNode always selects 'exhausted', never 'rework', from the only state claims 1+2 let it see", () => {
  it("selects 'exhausted' with an empty dispatch when every contract has already succeeded", async () => {
    const [a, b] = twoContracts();
    const state: OverallState = {
      ...baseState([a, b]),
      branchStatus: { [a.contractId]: succeeded(), [b.contractId]: succeeded() },
    };

    const router = reworkRouterNode(CODING_GRAPH);
    const command = await router.handler(undefined, state, rootContext());
    expect(command.goto).toEqual({ kind: "label", label: "exhausted" });
    expect(command.output).toEqual([]);
  });

  it("negative control: selects 'rework' and fans out when a contract has NOT succeeded — the router's own code takes that branch; state is what rules it out, not a missing branch", async () => {
    const [a, b] = twoContracts();
    const state: OverallState = {
      ...baseState([a, b]),
      // a failed and b was never dispatched at all — both are still owed a branch.
      branchStatus: { [a.contractId]: failedBranch() },
    };

    const router = reworkRouterNode(CODING_GRAPH);
    const command = await router.handler(undefined, state, rootContext());
    expect(command.goto.kind).toBe("fanout");
    expect(command.goto.label).toBe("rework");
    expect((command.goto.sends ?? []).map((send) => send.branchKey).sort()).toEqual(
      [a.contractId, b.contractId].sort(),
    );
  });
});

// ── Claim 4 ─────────────────────────────────────────────────────────

describe("CLAIM 4 — evalRouterNode's 'partial'/'exhausted' branches are correctly implemented, and reachable only at a counter value claims 1-3 say no real run ever reaches", () => {
  const { maxIterations } = loopBoundOf(CODING_GRAPH, ROOT_NODE_IDS.reworkRoute);

  function failingGlobalVerdict(): SprintVerdict {
    return {
      id: "global:0",
      seq: 0,
      contractId: "n/a",
      sprintNumber: 1,
      iteration: 1,
      verdict: "fail",
      summary: "the global evaluation did not pass",
      evalId: null,
    };
  }

  function passingBranchVerdict(contractId: string): SprintVerdict {
    return {
      id: `${contractId}:1`,
      seq: 0,
      contractId,
      sprintNumber: 1,
      iteration: 1,
      verdict: "pass",
      summary: "the branch passed",
      evalId: null,
    };
  }

  it("still selects 'rework' on the FIRST rework round — reworkRoundsTaken (0) is under the bound, even though something already passed", async () => {
    const [a] = twoContracts();
    const state: OverallState = {
      ...baseState([a]),
      counters: {},
      evaluations: [passingBranchVerdict(a.contractId)],
    };
    expect(reworkRoundsTaken(CODING_GRAPH, state)).toBeLessThan(maxIterations);

    const router = evalRouterNode(CODING_GRAPH);
    const command = await router.handler(failingGlobalVerdict(), state, rootContext());
    expect(command.goto).toEqual({ kind: "label", label: "rework" });
  });

  it("SYNTHETIC STATE (not claimed reachable): would select 'partial' once the rework bound is spent and something passed — proving the label-selection code exists and is correct, unlike context_compact's genuinely missing path", async () => {
    const [a] = twoContracts();
    const state: OverallState = {
      ...baseState([a]),
      // reworkRounds only ever reaches this value if rework_route selected "rework" twice,
      // which claim 3 shows never happens — this counter is injected to exercise the
      // router's OWN logic in isolation, not to assert the state is reachable.
      counters: { reworkRounds: maxIterations },
      evaluations: [passingBranchVerdict(a.contractId)],
    };
    expect(reworkRoundsTaken(CODING_GRAPH, state)).toBeGreaterThanOrEqual(maxIterations);

    const router = evalRouterNode(CODING_GRAPH);
    const command = await router.handler(failingGlobalVerdict(), state, rootContext());
    expect(command.goto).toEqual({ kind: "label", label: "partial" });
  });

  it("SYNTHETIC STATE (not claimed reachable): selects 'exhausted' instead of 'partial' at the same bound when nothing passed", async () => {
    const [a] = twoContracts();
    const state: OverallState = {
      ...baseState([a]),
      counters: { reworkRounds: maxIterations },
      evaluations: [],
    };

    const router = evalRouterNode(CODING_GRAPH);
    const command = await router.handler(failingGlobalVerdict(), state, rootContext());
    expect(command.goto).toEqual({ kind: "label", label: "exhausted" });
  });
});
