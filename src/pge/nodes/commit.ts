import { z } from "zod";

import type { SprintContract } from "../../contracts/sprint-contract.js";
import type { TopologySpec } from "../../contracts/topology.js";
import { resumeMessageId } from "../runtime/interrupt.js";
import type { GraphMessage, OverallState } from "../state/overall.js";
import type { NodeContext, NodeImpl } from "../registry/nodes.js";
import { EFFECTS } from "./effects.js";
import type { GitCommitResponseSchema } from "./effects.js";
import { gatePolicyOf, nodeSpecOf, portOf, successorOrEnd } from "./gates.js";
import { documentedContracts } from "./documenter.js";

/**
 * The commit approval gate and the git commit (sc-12-9).
 *
 * NOTE: unrelated to `src/pge/runtime/commit.ts`, which is the STATE commit boundary. These
 * two share a filename and nothing else; import both by path, never by shape.
 *
 * ── The fail-closed guarantee is NOT in this file, and that is the point ──
 *
 * `commit` declares `effects: ["git"]` (`coding.graph.ts:850`). Under ADR-6 that makes it
 * dispatchable only when a HITL gate with a DECLARED EDGE into it has a recorded approval
 * for this pass — derived from the artifact by `computeEffectGates`
 * (`interpreter.ts:499-512`), enforced by `maybeInterrupt` BEFORE dispatch
 * (`interrupt.ts:527-556`), and audited in both directions. Without an approval the
 * interpreter blocks the task, closes the span `failClosed: true` with
 * `FAIL_CLOSED_ERROR_CLASS`, pushes a `TaskFailure` — and never enters this handler.
 *
 * So the body below contains no approval check of its own, and there is no bypass flag
 * (nonGoal 4). Adding one would move a guarantee the topology enforces into a body where a
 * diff of the topology could no longer see it. The test proves the absence the way it has to
 * be proved: `git rev-parse HEAD` is unchanged in a real temporary repository.
 *
 * ── The second lock ──
 *
 * `EffectRegistry.invoke` independently refuses `git.commit` for any node whose artifact
 * declaration does not list `git` (`registry/effects.ts:147`). Two locks, one door, neither
 * reachable from a node body.
 */

export const COMMIT_NODE_IDS = {
  approval: "hitl_commit",
  commit: "commit",
} as const;

// ── Conventional commit message ─────────────────────────────────────

/**
 * The conventional message sc-12-9 names: `bober(sprint-N): <subject>`.
 *
 * It does not exist anywhere in the repository today. The imperative pipeline writes
 * `bober: ${title} (sprint ${contractId}, round ${iteration})` (`pipeline.ts:403-405`) and
 * the documenter is told to write `bober(${contractId}): docs for …`
 * (`documenter-agent.ts:137`); neither matches, and `src/utils/git.ts` has no message
 * builder at all. So this is a new formatter, and it is exported and unit-tested rather than
 * inlined at the call site — a commit subject is the most visible artifact a run produces.
 *
 * Rules, all of them enforced by {@link commitSubject}: the scope is the sprint NUMBER (not
 * the contract id — `bober(sprint-12)` is what a reader scans for); the subject is one line;
 * a subject longer than {@link COMMIT_SUBJECT_MAX} is truncated on a word boundary with an
 * ellipsis, because a wrapped subject line is a wrapped subject line in every git UI.
 */
export const COMMIT_SUBJECT_MAX = 72;

export function commitSubject(sprintNumbers: readonly number[], title: string): string {
  const scope =
    sprintNumbers.length === 0
      ? "sprint"
      : sprintNumbers.length === 1
        ? `sprint-${String(sprintNumbers[0])}`
        : `sprint-${String(Math.min(...sprintNumbers))}..${String(Math.max(...sprintNumbers))}`;
  const prefix = `bober(${scope}): `;
  const oneLine = title.replace(/\s+/g, " ").trim();
  const budget = COMMIT_SUBJECT_MAX - prefix.length;
  if (oneLine.length <= budget) return `${prefix}${oneLine}`;
  const cut = oneLine.slice(0, Math.max(0, budget - 1));
  const boundary = cut.lastIndexOf(" ");
  return `${prefix}${(boundary > 0 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

/** The full message: the conventional subject, then one line per contract committed. */
export function commitMessage(contracts: readonly SprintContract[]): string {
  const numbers = contracts.map((contract) => contract.sprintNumber);
  const title =
    contracts.length === 1
      ? (contracts[0]?.title ?? "sprint")
      : `${String(contracts.length)} sprints`;
  const body = contracts
    .slice()
    .sort((a, b) => a.sprintNumber - b.sprintNumber)
    .map((contract) => `- ${contract.contractId}: ${contract.title}`)
    .join("\n");
  return body.length === 0 ? commitSubject(numbers, title) : `${commitSubject(numbers, title)}\n\n${body}`;
}

// ── hitl_commit ─────────────────────────────────────────────────────

/** The id prefix `applyResume` keys an injected decision under (`interrupt.ts:332`). */
const HITL_MESSAGE_PREFIX = resumeMessageId("");

/** The human decision recorded for `nodeId`, or `undefined` when none was injected. */
export function approvalDecisionFor(
  state: Readonly<OverallState>,
  nodeId: string,
): GraphMessage | undefined {
  return state.messages.find(
    (message) => message.nodeId === nodeId && message.id.startsWith(HITL_MESSAGE_PREFIX),
  );
}

/** True when the recorded decision approved. A missing decision is not an approval. */
export function decisionApproved(message: GraphMessage | undefined): boolean {
  if (message?.text === undefined) return false;
  try {
    const parsed = z
      .object({ approved: z.boolean().optional() })
      .safeParse(JSON.parse(message.text));
    return parsed.success && parsed.data.approved === true;
  } catch {
    return false;
  }
}

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

/**
 * The commit approval gate.
 *
 * Effect-free by construction — `EffectfulNodeContainsHitl` forbids a node from carrying
 * both a `hitl` policy and an effect, which is why the artifact splits the approval and the
 * commit into two nodes. The body contains NO interrupt call: the pause is raised by the
 * interpreter before dispatch, at a superstep boundary (ADR-6), so by the time this runs the
 * decision has already been made and injected into `messages`.
 *
 * A rejection routes to the artifact's declared `gate.onFail`. An ABSENT decision routes
 * onward — and the commit node then blocks fail-closed one hop later, which is the whole
 * design: the guarantee lives at the effectful node, not at the gate in front of it.
 */
export function hitlCommitNode(spec: TopologySpec): NodeImpl<unknown, unknown> {
  const nodeId = COMMIT_NODE_IDS.approval;
  const node = nodeSpecOf(spec, nodeId);
  const next = successorOrEnd(spec, nodeId);
  const { onFail } = gatePolicyOf(spec, nodeId);

  return {
    id: nodeId,
    kind: "gate",
    inputPort: portOf(node, "input"),
    outputPort: portOf(node, "output"),
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    handler: async (input, state, ctx) => {
      const decision = approvalDecisionFor(state, nodeId);
      if (decision !== undefined && !decisionApproved(decision)) {
        return {
          update: { messages: [note(ctx, "commit approval was rejected")] },
          goto: { kind: "node", node: onFail },
          output: { approved: false },
        };
      }
      return {
        update: {
          messages: [
            note(
              ctx,
              decision === undefined
                ? "commit approval gate evaluated with no recorded decision"
                : "commit approval granted",
            ),
          ],
        },
        goto: { kind: "node", node: next },
        output: input,
      };
    },
  };
}

// ── commit ──────────────────────────────────────────────────────────

/**
 * The run's single git commit.
 *
 * Reached only through the approval gate, and only with a recorded approval — see the module
 * header. `commitAll` is invoked through `ctx.effects.invoke` under the `git` tag, which the
 * node's own artifact declaration authorises and nothing else does.
 */
export function commitNode(spec: TopologySpec): NodeImpl<unknown, unknown> {
  const nodeId = COMMIT_NODE_IDS.commit;
  const node = nodeSpecOf(spec, nodeId);
  const next = successorOrEnd(spec, nodeId);

  return {
    id: nodeId,
    kind: "tool",
    inputPort: portOf(node, "input"),
    outputPort: portOf(node, "output"),
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    handler: async (_input, state, ctx) => {
      const contracts = documentedContracts(state);
      if (contracts.length === 0) {
        // A failing run produces NO COMMIT (sc-12-9). The approval authorises the effect; it
        // does not manufacture something to commit, and an empty `bober(sprint): 0 sprints`
        // object in a user's history is worse than no object at all.
        return {
          update: { messages: [note(ctx, "no settled contract to commit")] },
          goto: { kind: "node", node: next },
          output: { commit: null, message: null },
        };
      }
      const message = commitMessage(contracts);
      const result = (await ctx.effects.invoke(
        EFFECTS.gitCommit,
        { cwd: ctx.projectRoot, message },
        ctx,
      )) as z.infer<typeof GitCommitResponseSchema>;

      return {
        update: { messages: [note(ctx, `committed ${result.commit}: ${message.split("\n")[0]}`)] },
        goto: { kind: "node", node: next },
        output: { commit: result.commit, message },
      };
    },
  };
}
