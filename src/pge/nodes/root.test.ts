import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

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
import { BRANCH_STATES, initialOverallState } from "../state/overall.js";
import type { BranchStatus, OverallState, SprintVerdict } from "../state/overall.js";
import { CODING_GRAPH } from "../topology/coding.graph.js";
import { stubContracts, stubPlanSpec } from "./__fixtures__/region-harness.js";
import { SPRINT_GATE_IDS, gatePolicyOf, loopBoundOf, nodeSpecOf, reduceSprintsGate } from "./gates.js";
import {
  ROOT_NODE_IDS,
  evalRouterNode,
  reworkRoundsTaken,
  reworkRouterNode,
  unsucceededBranches,
} from "./root.js";
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
 *
 * ── Claims 5 and 6: the SECOND chain, and the state nobody writes ──
 *
 * Claims 1-4 are chain A. `coverage.test.ts` argues a SECOND, independent chain to the same
 * conclusion — `reduce_sprints`'s gate has already refused every badly-settled state by the
 * time `rework_route` can run — and that one was prose only. Claim 5 encodes it. The two
 * chains fail independently, and chain A alone keeps the `NEVER_EXECUTED` entry correct, so
 * a chain-B regression would otherwise be SILENT.
 *
 * Claim 6 pins the fact both chains lean on: `"abandoned"` is a legal `BranchState` that no
 * shipped code writes. It also records, as an executable fact, that the two rules which READ
 * it disagree about what it would mean — `reduceSprintsGate` demands re-dispatch,
 * `dispatchableContracts` refuses to supply one.
 *
 * ── What this file does NOT prove ──
 *
 * Unreachability is a property of the ROUTERS, and it is not a safety mechanism. The commit
 * boundary does not rely on it: `nodes/commit.ts` refuses on the run's global verdict
 * directly, so a future edge that makes `partial` live cannot turn a failed run into a
 * whole-tree commit. That refusal and these claims are deliberately independent.
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


// ── Claim 5 ─────────────────────────────────────────────────────────

/**
 * CHAIN B, the one sprint 9 argued in prose and never encoded.
 *
 * Chain A (claims 1-4) reaches the same conclusion through `supervisorNode`'s dispatch
 * guard. Chain B reaches it through the SPRINT gate instead: by the time `rework_route` can
 * run at all, `reduce_sprints` has already refused every state in which a branch settled
 * badly, so every branch it can see is `"succeeded"` and `dispatchableContracts` — which
 * excludes exactly `"succeeded"` and `"abandoned"` — is empty.
 *
 * Encoding it matters because the two chains fail INDEPENDENTLY. Chain A alone keeps
 * `coverage.test.ts`'s `NEVER_EXECUTED` entry for `synthesize` correct, so a chain-B
 * regression would be silent: the entry would still be true, for one reason instead of two,
 * and nothing would say the second reason had gone. These tests make that audible.
 */
describe("CLAIM 5 — reduce_sprints is a barrier: rework_route can only run from an all-succeeded state (chain B)", () => {
  const REDUCE_ON_FAIL = gatePolicyOf(CODING_GRAPH, SPRINT_GATE_IDS.reduce).onFail;

  it("REFUSES — routing back to the fan-out, not onward — while any branch is still settled badly", async () => {
    const [a, b] = twoContracts();
    const state: OverallState = {
      ...baseState([a, b]),
      branchStatus: { [a.contractId]: succeeded(), [b.contractId]: failedBranch() },
    };

    const gate = reduceSprintsGate(CODING_GRAPH);
    const command = await gate.handler(
      undefined,
      state,
      rootContext({ nodeId: SPRINT_GATE_IDS.reduce }),
    );
    // The refusal routes to the gate's DECLARED onFail (`fanout_sprints`), read off the
    // artifact rather than written as a literal — so re-pointing the edge fails this test
    // instead of silently changing what the barrier means.
    expect(command.goto).toEqual({ kind: "node", node: REDUCE_ON_FAIL });
  });

  it("ADMITS only when every branch has succeeded — and that state's dispatch set is empty, which is what makes rework_route select 'exhausted'", async () => {
    const [a, b] = twoContracts();
    const state: OverallState = {
      ...baseState([a, b]),
      branchStatus: { [a.contractId]: succeeded(), [b.contractId]: succeeded(2) },
    };

    const gate = reduceSprintsGate(CODING_GRAPH);
    const command = await gate.handler(
      undefined,
      state,
      rootContext({ nodeId: SPRINT_GATE_IDS.reduce }),
    );
    expect(command.goto).not.toEqual({ kind: "node", node: REDUCE_ON_FAIL });

    // The link that makes the barrier mean something downstream: the only states the gate
    // admits are states `dispatchableContracts` reports nothing for.
    expect(dispatchableContracts(state, state.sprintContracts)).toEqual([]);
  });

  it("'succeeded', NOT 'abandoned', is the exclusion that actually bites — the mechanism an earlier analysis got wrong", () => {
    const [a, b] = twoContracts();
    const succeededOnly: OverallState = {
      ...baseState([a, b]),
      branchStatus: { [a.contractId]: succeeded(), [b.contractId]: succeeded() },
    };
    expect(dispatchableContracts(succeededOnly, succeededOnly.sprintContracts)).toEqual([]);

    // Remove `succeeded` from the picture and the set is non-empty again, proving the empty
    // result above is produced by `succeeded` and not by anything to do with `abandoned`.
    const failedInstead: OverallState = {
      ...baseState([a, b]),
      branchStatus: { [a.contractId]: failedBranch(), [b.contractId]: failedBranch() },
    };
    expect(
      dispatchableContracts(failedInstead, failedInstead.sprintContracts).map((c) => c.contractId),
    ).toEqual([a.contractId, b.contractId]);
  });
});

// ── Claim 6 ─────────────────────────────────────────────────────────

/**
 * `"abandoned"` is a legal {@link BranchState} with NO production writer, and until now
 * nothing pinned that absence — not a test, a type, or a lint rule.
 *
 * The absence is load-bearing in two directions, which is why it is worth a test rather than
 * a comment:
 *
 *  1. Chain B above quotes `dispatchableContracts`'s exclusion of `"succeeded"` OR
 *     `"abandoned"`. If a writer ever appeared, that second exclusion would start biting and
 *     the chain would change meaning.
 *  2. The two production rules that READ it DISAGREE about what it means.
 *     `reduceSprintsGate` (`gates.ts`) classes it with `"failed"` — settled badly, must be
 *     re-dispatched — while `dispatchableContracts` (`sprint-fanout.ts`) excludes it from
 *     re-dispatch entirely. A branch in that state would therefore be demanded by the gate
 *     and supplied by nothing: silently dropped from every dispatch set, with no record that
 *     it was skipped. The third test below pins that disagreement as a FACT about today's
 *     code, so whoever adds the first writer meets it as a failing test rather than as a
 *     production stall.
 *
 * It can enter through any path that reconstitutes state without going through the writers —
 * including a checkpoint deserialised from `.bober/` on resume — so "no writer" is not the
 * same as "impossible", and the scan below says only what it can actually prove.
 */
describe("CLAIM 6 — no production code writes the 'abandoned' BranchState", () => {
  /** Every shipped `.ts` under `src/`: no tests, no fixtures, no test-only helpers. */
  async function productionSources(dir: string): Promise<string[]> {
    const found: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__fixtures__" || entry.name === "__tests__") continue;
        found.push(...(await productionSources(full)));
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".d.ts")) continue;
      found.push(full);
    }
    return found;
  }

  it("is still a DECLARED BranchState — this claim is about the missing writer, not a missing value", () => {
    expect(BRANCH_STATES).toContain("abandoned");
  });

  it("no shipped file constructs a branch status in the 'abandoned' state", async () => {
    const files = await productionSources("src");
    expect(files.length).toBeGreaterThan(100);

    // The shape of a WRITE: `state: "abandoned"` is how every BranchStatus is built
    // (`BranchStatusSchema`), so a writer cannot avoid this token without going through a
    // variable — which the next test's broader scan would still catch.
    const offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf-8");
      if (/state:\s*["'`]abandoned["'`]/.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("every shipped mention of 'abandoned' in the PGE is a comparison, never an assignment", async () => {
    const files = (await productionSources(join("src", "pge"))).filter(
      (file) => !file.endsWith(join("state", "overall.ts")),
    );

    const mentions: { file: string; line: string }[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf-8");
      for (const line of source.split("\n")) {
        if (!line.includes('"abandoned"')) continue;
        // Comment lines explain the state; they cannot write it.
        if (line.trimStart().startsWith("*") || line.trimStart().startsWith("//")) continue;
        mentions.push({ file, line: line.trim() });
      }
    }

    // The two readers, and only those two. A NEW entry here is the signal: it means somebody
    // has begun to care about `abandoned` in shipped code, and claims 5 and 6 both need
    // re-reading before it lands.
    expect(mentions.map((m) => m.file).sort()).toEqual([
      join("src", "pge", "nodes", "gates.ts"),
      join("src", "pge", "nodes", "sprint-fanout.ts"),
    ]);
    for (const mention of mentions) {
      expect(mention.line, `${mention.file} should only COMPARE against "abandoned"`).toMatch(
        /[!=]==\s*"abandoned"|"abandoned"\s*[!=]==/,
      );
    }
  });

  it("the two readers DISAGREE about what an abandoned branch means — pinned, because nothing else records it", async () => {
    const [a] = twoContracts();
    const state: OverallState = {
      ...baseState([a]),
      branchStatus: { [a.contractId]: { state: "abandoned", attempts: 1 } },
    };

    // `reduceSprintsGate`: settled badly -> must be re-dispatched. It REFUSES.
    const gate = reduceSprintsGate(CODING_GRAPH);
    const command = await gate.handler(
      undefined,
      state,
      rootContext({ nodeId: SPRINT_GATE_IDS.reduce }),
    );
    expect(command.goto).toEqual({
      kind: "node",
      node: gatePolicyOf(CODING_GRAPH, SPRINT_GATE_IDS.reduce).onFail,
    });

    // `dispatchableContracts`: deliberately given up on -> excluded from re-dispatch. It
    // offers NOTHING to satisfy the refusal above. That is the silent drop.
    expect(dispatchableContracts(state, state.sprintContracts)).toEqual([]);
  });

  it("the fail-closed verdict still holds for such a branch — unsucceededBranches counts it as not-succeeded", () => {
    const [a] = twoContracts();
    const state: OverallState = {
      ...baseState([a]),
      branchStatus: { [a.contractId]: { state: "abandoned", attempts: 1 } },
    };
    expect(unsucceededBranches(state)).toEqual([a.contractId]);
  });
});
