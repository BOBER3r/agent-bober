import { z } from "zod";

import type { TopologySpec } from "../../contracts/topology.js";
import type { GraphMessage, LedgerEntry, OverallState } from "../state/overall.js";
import type { NodeContext, NodeImpl } from "../registry/nodes.js";
import { HISTORY_EVENT, emitPhaseEvent } from "../runtime/history.js";
import { EFFECTS } from "./effects.js";
import type { DocumentationResultSchema } from "./effects.js";
import { nodeSpecOf, portOf, successorOrEnd } from "./gates.js";
import { provisionalEvaluation } from "./sprint-evaluate.js";

/**
 * The run's documenter (sc-12-9).
 *
 * ── Run-scoped, not sprint-scoped ──
 *
 * `documenter` carries `subgraph: null` and sits after `route_after_eval`'s `pass` label
 * (`coding.graph.ts:752,808`). It runs ONCE PER RUN, after every branch has settled through
 * `reduce_sprints`. Per branch the sprint subgraph terminates at `sprint_exit ->
 * gate_sprint_out`; nothing inside the fan-out reaches this node, and a body that assumed a
 * branch key would be reading `null` on every real run.
 *
 * ── The documenter must not commit (trap 10) ──
 *
 * `runDocumenter`'s prompt instructs the model to `git add <doc files> && git commit`
 * (`documenter-agent.ts:137`), and this node declares `effects: ["fs-write"]` and NOT
 * `git` (`coding.graph.ts:820`). Under ADR-6 a git effect is reachable only behind the
 * approval gate one hop later, so a documenter that committed would put a git object in the
 * user's repository with no recorded approval — the exact thing sc-12-9 exists to prevent.
 *
 * The node cannot edit the agent's prompt (nonGoal 2), so it does the one thing it can: it
 * states the prohibition in the {@link DOCUMENTER_NO_COMMIT_INSTRUCTION} it passes down, and
 * `commit.test.ts` asserts the absence of a commit object in a real temp repository rather
 * than trusting the instruction. The instruction is the request; the test is the evidence.
 */

export const DOCUMENTER_NODE_ID = "documenter";

/** The `refs` key the documentation result is offloaded under. */
export const DOCUMENTATION_REF_KEY = "run-documentation";

/**
 * The prohibition the documenter is given, spelled once.
 *
 * Exported so `commit.test.ts` can assert it actually reached the agent rather than only
 * existing in this file.
 */
export const DOCUMENTER_NO_COMMIT_INSTRUCTION =
  "Do NOT run git add, git commit or any other git command. This node declares only the fs-write effect; the run's single commit happens later, behind the human-approval gate, and a commit from here would be an unapproved git object.";

function note(ctx: NodeContext, text: string): GraphMessage {
  return {
    id: `${ctx.nodeId}:${String(ctx.superstep)}`,
    seq: ctx.superstep,
    role: "assistant",
    nodeId: ctx.nodeId,
    text,
    tokens: text.length,
  };
}

function charge(ctx: NodeContext): LedgerEntry {
  const entry: LedgerEntry = {
    nodeId: ctx.nodeId,
    attempt: 0,
    callIndex: 0,
    calls: 1,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
  };
  ctx.ledger.charge(
    { nodeId: entry.nodeId, attempt: entry.attempt, callIndex: entry.callIndex },
    { calls: entry.calls, tokensIn: entry.tokensIn, tokensOut: entry.tokensOut, costUsd: entry.costUsd },
  );
  return entry;
}

/** The contracts this run completed, in sprint order — what the documenter documents. */
export function documentedContracts(state: Readonly<OverallState>): OverallState["sprintContracts"] {
  return state.sprintContracts
    .filter((contract) => {
      const status = state.branchStatus[contract.contractId];
      return status?.state === "succeeded" || contract.status === "completed";
    })
    .slice()
    .sort((a, b) => a.sprintNumber - b.sprintNumber);
}

/**
 * Write the run's documentation through the shipped `runDocumenter`, unmodified.
 *
 * Writes `messages`, `refs` and `ledger` — exactly the artifact's declared `writes` — and
 * offloads the `DocumentationResult` so only its `ScratchRef` enters state.
 *
 * ── History event 9 of 10 (sc-4-1) ──
 *
 * `sprint-docs-complete` fires after `EFFECTS.documenterSummary` returns, matching
 * `pipeline.ts:675`. NOT emitted on the "nothing to document" early return above — there is
 * no settled contract to attribute the event to, exactly as the imperative engine never
 * reaches its own `sprint-docs-complete` site when documentation was never attempted.
 */
export function documenterNode(spec: TopologySpec): NodeImpl<unknown, unknown> {
  const nodeId = DOCUMENTER_NODE_ID;
  const node = nodeSpecOf(spec, nodeId);
  const next = successorOrEnd(spec, nodeId);

  return {
    id: nodeId,
    kind: "llm",
    inputPort: portOf(node, "input"),
    outputPort: portOf(node, "output"),
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    handler: async (_input, state, ctx) => {
      const documented = documentedContracts(state);
      const contract = documented[documented.length - 1];
      if (contract === undefined) {
        // Nothing SETTLED, so there is nothing to document — and deliberately no fallback to
        // "whatever contract is around". A run whose branches all failed must not produce a
        // sprint document claiming they did, and the commit node one hop later reads the
        // same empty set and commits nothing (sc-12-9's second half).
        return {
          update: { messages: [note(ctx, "no completed contract to document")] },
          goto: { kind: "node", node: next },
          output: { documented: [] as string[] },
        };
      }

      const result = (await ctx.effects.invoke(
        EFFECTS.documenterSummary,
        {
          contract: { ...contract, description: `${contract.description}\n\n${DOCUMENTER_NO_COMMIT_INSTRUCTION}` },
          evaluation: provisionalEvaluation(ctx, {
            success: true,
            notes: `documenting ${String(documented.length)} completed contract(s)`,
          }),
          projectRoot: ctx.projectRoot,
        },
        ctx,
      )) as z.infer<typeof DocumentationResultSchema>;

      await emitPhaseEvent(ctx, {
        event: HISTORY_EVENT.SPRINT_DOCS_COMPLETE,
        phase: "complete",
        sprintId: contract.contractId,
        details: {
          sprintDocPath: result.sprintDocPath,
          relatedDocsUpdated: result.relatedDocsUpdated.length,
          concerns: result.concerns.length,
        },
      });

      const ref = await ctx.scratch.put(ctx.runId, "document", JSON.stringify(result));
      return {
        update: {
          messages: [note(ctx, `documented ${result.contractId} -> ${result.sprintDocPath}`)],
          refs: { [DOCUMENTATION_REF_KEY]: ref },
          ledger: [charge(ctx)],
        },
        phase: "complete",
        goto: { kind: "node", node: next },
        output: result,
      };
    },
  };
}
