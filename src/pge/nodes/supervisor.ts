import { z } from "zod";

import { ResearchDigestSchema } from "../../contracts/problem-reflection.js";
import type { ResearchDigest } from "../../contracts/problem-reflection.js";
import { isPipelineReady } from "../../contracts/spec.js";
import { TERMINAL_ENDPOINT } from "../../contracts/topology.js";
import type { TopologySpec } from "../../contracts/topology.js";
import type { GraphMessage, OverallState } from "../state/overall.js";
import type { Goto, NodeContext, NodeImpl } from "../registry/nodes.js";
import { EFFECTS, FAILURE_ARTIFACT_FORMAT_VERSION } from "./effects.js";
import { describeRefusal, isNodeRefusal, nodeSpecOf, portOf } from "./gates.js";
import type { NodeRefusal } from "./gates.js";
import { GRACEFUL_FAILURE_NODE_ID } from "./regions.js";
import { resolveResearchDigest } from "./research.js";

/**
 * The supervisor router and the failure terminal — the two root-scope nodes every region
 * keeps.
 *
 * ── The supervisor is a ROUTER, so it selects a LABEL (ADR-3) ──
 *
 * `goto: { kind: "label" }` with a label the artifact declares on `supervisor.targets`,
 * and the artifact says where that label leads. There are exactly two exceptions, both of
 * which are about LEAVING the graph rather than routing inside it:
 *
 *  - `{ kind: "node", node: "END" }` when there is no further phase to dispatch. `END` is
 *    the reserved terminal (`interpreter.ts:610` resolves it before any scope check); the
 *    artifact declares no `supervisor -> END` edge because the shipped pipeline reaches
 *    its terminal through `finalize`, which is a sprint-13 node.
 *  - `{ kind: "node", node: "graceful_failure" }` when the supervisor is handed a
 *    {@link NodeRefusal}. This completes a hop the ARTIFACT declares and the compiled
 *    adjacency cannot express: a research-scope gate's `gate.onFail` names
 *    `graceful_failure`, but that node is at the root, so the gate leaves its subgraph
 *    with `{ kind: "parent" }` — which lands here — and the supervisor finishes the
 *    journey the gate's own declaration started. Root-to-root, so `resolveDestination`
 *    admits it (`interpreter.ts:611-617`).
 *
 * ── Which labels are dispatchable is derived, never assumed ──
 *
 * `supervisor.targets` declares four labels and `RouterNodeSchema.targets` is `.min(1)`,
 * so a region projection cannot trim the three whose targets it does not contain. If the
 * body selected one of those, `resolveDestination` would resolve it through
 * `node.spec.targets` (`interpreter.ts:596`) and the interpreter would then fail looking
 * the node up in scope. So the dispatchable set is computed from the nodes the graph
 * ACTUALLY has, and a label whose target is absent is never selected.
 *
 * ── Where the brief comes from ──
 *
 * A `ResearchDigest` carrying real findings is far larger than the 4096-byte inline
 * budget every channel in the artifact declares, so it travels as a `ScratchRef` in
 * `refs` — which is exactly why `research_collect` declares `writes: ["refs"]` (ADR-4).
 * The supervisor prefers the digest it was handed (the `gate_research_out -> supervisor`
 * edge carries one) and falls back to resolving the ref. KNOWN ARTIFACT DRIFT: the
 * supervisor's declared `reads` are `["branchStatus", "counters", "spec", "evaluations"]`
 * and do not include `refs`, which the fallback reads. Reported rather than fixed — the
 * artifact is outside this sprint's scope.
 */

// ── Labels ──────────────────────────────────────────────────────────

/** The dispatch label the artifact declares for the planning phase (`coding.graph.ts:330`). */
export const PLAN_LABEL = "plan";

// ── Supervisor ──────────────────────────────────────────────────────

export interface SupervisorOptions {
  spec: TopologySpec;
}

/** True when the run still needs a plan it can plausibly execute sprints from. */
function needsPlan(state: Readonly<OverallState>): boolean {
  return state.spec === null || !isPipelineReady(state.spec);
}

export function supervisorNode(options: SupervisorOptions): NodeImpl<unknown, unknown> {
  const { spec } = options;
  const nodeId = spec.defaults.supervisorNodeId;
  const node = nodeSpecOf(spec, nodeId);
  if (node.kind !== "router") {
    throw new Error(`The declared supervisor "${nodeId}" is not a router node.`);
  }
  const present = new Set(spec.nodes.map((entry) => entry.id));
  const dispatchable = new Set(
    node.targets.filter((target) => present.has(target.to)).map((target) => target.label),
  );
  const failureReachable = present.has(GRACEFUL_FAILURE_NODE_ID);
  const endGoto: Goto = { kind: "node", node: TERMINAL_ENDPOINT };
  const failGoto: Goto = failureReachable
    ? { kind: "node", node: GRACEFUL_FAILURE_NODE_ID }
    : endGoto;

  return {
    id: nodeId,
    kind: "router",
    inputPort: portOf(node, "input"),
    outputPort: portOf(node, "output"),
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    handler: async (input, state, ctx) => {
      // A refusal that reached the supervisor came from a subgraph gate leaving its
      // region. Finish the hop the gate's own `gate.onFail` declared.
      if (isNodeRefusal(input)) {
        return { goto: failGoto, output: input };
      }

      if (dispatchable.has(PLAN_LABEL) && needsPlan(state)) {
        const carried = ResearchDigestSchema.safeParse(input);
        const brief: ResearchDigest | null = carried.success
          ? carried.data
          : await resolveResearchDigest(state, ctx);
        if (brief !== null) {
          return { goto: { kind: "label", label: PLAN_LABEL }, output: brief };
        }
      }

      return {
        goto: endGoto,
        output: { supervised: true, dispatchable: [...dispatchable].sort() },
      };
    },
  };
}

// ── Graceful failure terminal ───────────────────────────────────────

/**
 * What the interpreter's own failure paths hand the terminal.
 *
 * The deadlock path sends `{ reason, blockedBy }` (`interpreter.ts:1082`) and the
 * retries-exhausted path sends `{ reason, superstep, branches }` (`interpreter.ts:1511`).
 * Both are parsed leniently: the terminal's job is to RECORD what it was told, and a
 * terminal that threw on an unexpected shape would lose the account of the failure that
 * brought the run here.
 */
const TerminalInputSchema = z.object({
  reason: z.string().min(1).default("Unknown"),
  branches: z
    .array(
      z.object({
        branchKey: z.string().min(1),
        contractId: z.string().min(1).optional(),
        nodeId: z.string().min(1),
        attempts: z.number().int().min(1),
        errorClass: z.string().min(1),
        message: z.string(),
      }),
    )
    .default([]),
});

/** The failure record the terminal appends to `messages`. */
export function failureMessage(ctx: NodeContext, text: string): GraphMessage {
  return {
    id: `failure:${ctx.nodeId}:${String(ctx.superstep)}`,
    seq: ctx.superstep,
    role: "assistant",
    nodeId: ctx.nodeId,
    text,
    tokens: text.length,
  };
}

/**
 * The single failure terminal.
 *
 * Writes the failure artifact through the `run.gracefulFailure` effect — the node
 * declares `effects: ["fs-write"]`, which is what authorises it — and appends ONE record
 * to `messages`, which the artifact declares it may write. It sets no verdict and no
 * phase: `finalize` owns the terminal verdict (`coding.graph.ts:179-186`) and this node
 * "ends the run without a commit".
 */
export function gracefulFailureNode(options: SupervisorOptions): NodeImpl<unknown, unknown> {
  const { spec } = options;
  const node = nodeSpecOf(spec, GRACEFUL_FAILURE_NODE_ID);

  return {
    id: GRACEFUL_FAILURE_NODE_ID,
    kind: "tool",
    inputPort: portOf(node, "input"),
    outputPort: portOf(node, "output"),
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    handler: async (input, _state, ctx) => {
      const refusal: NodeRefusal | null = isNodeRefusal(input) ? input : null;
      const told = TerminalInputSchema.safeParse(input);
      const reason =
        refusal === null ? (told.success ? told.data.reason : "Unknown") : `NodeRefusal:${refusal.check}`;
      const branches = told.success ? told.data.branches : [];
      const text = refusal === null ? `run failed: ${reason}` : describeRefusal(refusal);

      await ctx.effects.invoke(
        EFFECTS.gracefulFailure,
        {
          projectRoot: ctx.projectRoot,
          artifact: {
            formatVersion: FAILURE_ARTIFACT_FORMAT_VERSION,
            runId: ctx.runId,
            reason,
            supersteps: ctx.superstep,
            createdAt: ctx.clock.nowIso(),
            branches,
          },
        },
        ctx,
      );

      return {
        update: { messages: [failureMessage(ctx, text)] },
        goto: { kind: "node", node: TERMINAL_ENDPOINT },
        output: { failed: true, reason },
      };
    },
  };
}
