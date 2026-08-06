import { z } from "zod";

import { totalSchema } from "../../contracts/problem-reflection.js";
import { SprintContractSchema } from "../../contracts/sprint-contract.js";
import type { SprintContract } from "../../contracts/sprint-contract.js";
import type { TopologySpec } from "../../contracts/topology.js";
import type { OverallState } from "../state/overall.js";
import type { NodeImpl } from "../registry/nodes.js";
import { nodeSpecOf, portOf, soleSuccessor } from "./gates.js";

/**
 * The sprint fan-out router and the subgraph call site it dispatches into.
 *
 * ── One branch per contract, keyed by contract id ──
 *
 * `Goto.sends` carries `{ branchKey, input }` and the interpreter reads the branch's
 * dependency facts off the INPUT (`branchFactsOf`, `interpreter.ts:1425`), so the input is
 * the `SprintContract` itself and the key is its `contractId`. Two branches sharing a key
 * is a `FanOutNotDispatchableError` (`interpreter.ts:643`) precisely because a join cannot
 * tell them apart, and using the contract id makes collisions impossible by construction.
 *
 * ── Why a FAILED branch is re-dispatched and a SUCCEEDED one is not ──
 *
 * `reduce_sprints` declares `gate.onFail: "fanout_sprints"` and the artifact's own doc says
 * why: "On a failed branch it routes back to the fan-out with jittered backoff." A fan-out
 * that refused to re-dispatch would make that route a no-op — the barrier would refuse, the
 * fan-out would drain, and the run would end quietly without ever spending the
 * `fanoutRetries` budget or reaching `graceful_failure`. So the dispatch set is "planned and
 * not yet settled successfully", which covers both the first pass and the retry.
 *
 * The retry is bounded by the artifact and not by this node: `reduce_sprints` carries
 * `{ counterKey: "fanoutRetries", maxIterations: 2, onExhausted: "graceful_failure" }`, and
 * the interpreter enforces it (`interpreter.ts:988-1029`).
 */

export const SPRINT_FANOUT_NODE_IDS = {
  fanout: "fanout_sprints",
  body: "sprint_body",
} as const;

/** The labels the artifact declares on `fanout_sprints` (`coding.graph.ts:458-461`). */
export const FANOUT_LABELS = { dispatch: "dispatch", drained: "drained" } as const;

/**
 * The contracts this fan-out still owes a branch, in `sprintNumber` order.
 *
 * Exported and pure so the dispatch rule is testable without a graph. Order is the
 * contracts' own declared order, which is what makes two runs at different concurrency
 * caps dispatch the same set in the same sequence.
 */
export function dispatchableContracts(
  state: Readonly<OverallState>,
  candidates: readonly SprintContract[],
): SprintContract[] {
  return candidates
    .filter((contract) => {
      const status = state.branchStatus[contract.contractId];
      if (status === undefined) return true;
      // `succeeded` is done; `abandoned` was deliberately given up on. Everything else —
      // `pending`, `running`, `failed` — is still owed a branch.
      return status.state !== "succeeded" && status.state !== "abandoned";
    })
    .slice()
    .sort((a, b) => a.sprintNumber - b.sprintNumber || (a.contractId < b.contractId ? -1 : 1));
}

/**
 * The sprint fan-out.
 *
 * Reads `sprintContracts`, `branchStatus` and `counters`, exactly the three channels its
 * artifact declaration lists. Writes none of them itself: the only `counters` write it
 * makes is the one the interpreter folds in, and it declares no loop of its own.
 */
export function fanoutSprintsNode(spec: TopologySpec): NodeImpl<unknown, unknown> {
  const nodeId = SPRINT_FANOUT_NODE_IDS.fanout;
  const node = nodeSpecOf(spec, nodeId);
  if (node.kind !== "router") {
    throw new Error(`The declared sprint fan-out "${nodeId}" is not a router node.`);
  }
  const labels = new Set(node.targets.map((target) => target.label));
  for (const label of [FANOUT_LABELS.dispatch, FANOUT_LABELS.drained]) {
    if (!labels.has(label)) {
      throw new Error(`Node "${nodeId}" declares no "${label}" target in the topology artifact.`);
    }
  }

  return {
    id: nodeId,
    kind: "router",
    inputPort: portOf(node, "input"),
    outputPort: portOf(node, "output"),
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    handler: async (input, state, _ctx) => {
      // The contracts to dispatch come from the CHANNEL, not from whatever arrived on the
      // input port: the fan-out is re-entered by the barrier's retry with a join payload,
      // and a fan-out that dispatched only what it was handed would dispatch nothing.
      const carried = z.array(SprintContractSchema).safeParse(input);
      const candidates = carried.success && carried.data.length > 0
        ? carried.data
        : state.sprintContracts;
      const pending = dispatchableContracts(state, candidates);

      if (pending.length === 0) {
        return { goto: { kind: "label", label: FANOUT_LABELS.drained }, output: [] };
      }
      return {
        goto: {
          kind: "fanout",
          label: FANOUT_LABELS.dispatch,
          sends: pending.map((contract) => ({ branchKey: contract.contractId, input: contract })),
        },
        phase: "generating",
        output: pending,
      };
    },
  };
}

/**
 * The sprint subgraph call site.
 *
 * A pass-through by design. The artifact declares it `kind: "subgraph"` with
 * `subgraphRef: "sprint"`, `subgraph: null` and a `contract` port on each side
 * (`coding.graph.ts:463-476`): it is the ROOT-SCOPE node the fan-out edge targets, and the
 * subgraph is entered one hop later through `gate_sprint_in`, because a subgraph boundary
 * must be crossed through a gate. There is nothing for the body to decide.
 */
export function sprintBodyNode(spec: TopologySpec): NodeImpl<SprintContract, SprintContract> {
  const nodeId = SPRINT_FANOUT_NODE_IDS.body;
  const node = nodeSpecOf(spec, nodeId);
  const next = soleSuccessor(spec, nodeId);

  return {
    id: nodeId,
    kind: "subgraph",
    inputPort: portOf(node, "input"),
    outputPort: portOf(node, "output"),
    inputSchema: totalSchema(SprintContractSchema),
    outputSchema: totalSchema(SprintContractSchema),
    handler: async (input) => ({ goto: { kind: "node", node: next }, output: input }),
  };
}
