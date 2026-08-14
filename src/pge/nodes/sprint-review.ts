import { z } from "zod";

import type { SprintContract } from "../../contracts/sprint-contract.js";
import type { TopologySpec } from "../../contracts/topology.js";
import type { BranchStatus, GraphMessage, LedgerEntry, OverallState } from "../state/overall.js";
import type { NodeContext, NodeImpl } from "../registry/nodes.js";
import { HISTORY_EVENT, emitPhaseEvent } from "../runtime/history.js";
import { EFFECTS } from "./effects.js";
import type { ReviewResultSchema } from "./effects.js";
import { branchRecord, isNodeRefusal, nodeSpecOf, portOf, resolveContract, soleSuccessor } from "./gates.js";
import { iterationOf, provisionalEvaluation, sprintVerdict } from "./sprint-evaluate.js";

/**
 * The advisory reviewer and the single per-branch termination point.
 *
 * ── The review is advisory, and stays advisory ──
 *
 * `runCodeReviewer` runs after a passing evaluation and its findings "do NOT block sprint
 * completion, do NOT trigger generator retry, and do NOT mutate contract status"
 * (`code-reviewer-agent.ts:40-42`). The node keeps that contract: it records the review into
 * `messages` and `evaluations` — the two channels its artifact declaration lists — and
 * routes to `sprint_exit` whatever the review says. A node that downgraded the branch on a
 * critical finding would silently promote an advisory stage into a blocking one.
 *
 * ── `attempts` is what makes a branch settled ──
 *
 * `sprint_exit` is the ONE node that writes a terminal `branchStatus`, and it writes
 * `attempts >= 1`. That number is the ordering discriminator `lastWriteWinsByKey` resolves a
 * branch's `running -> succeeded` transition by (`state/overall.ts:131-142`): a settled
 * record must outrank the running one it replaces, and a `running` record that claimed a
 * completed attempt would leave the branch looking permanently in flight. `gate_sprint_out`
 * checks exactly this, which is what its declared `branch-verdicts-recorded` means.
 *
 * ── The channel now carries the settled copy (sprint 4 of spec-20260812-terminal-vocabulary) ──
 *
 * `sprint_exit` declares `writes: ["branchStatus", "sprintContracts"]` and writes the settled
 * contract to both, and both writes now land. `appendById` unions by `contractId` and used to
 * resolve a duplicate id by CANONICAL ORDER, under which `"completed"` sorted BEFORE
 * `"proposed"` and the seeded copy always outranked the settled one. It now resolves by RANK
 * (`registry/reducers.ts`, `rankIsGreater`/`mergeEntries`) instead: the settled copy's
 * `version` (set to `attempts` above) outranks the seeded copy, which carries no `version` at
 * all, so `versionRank` (`registry/reducers.ts:366-393`) decides before the two `status`
 * strings are ever compared.
 *
 * `branchStatus` solved the identical problem earlier with its own explicit `attempts`
 * discriminator (`state/overall.ts:146-157`); `SprintContract.version` is the same idea
 * applied to this channel, and `rankIsGreater` is what now consults it.
 *
 * One gap remains, deliberately, but it narrowed at sprint 5 of
 * spec-20260812-terminal-vocabulary: the settled contract's `status` is `"completed"` or
 * `"failed"`, never `"passed"`. Before that sprint, `runTsPipeline` AND `commit.ts`'s
 * `passed()` both compared the literal `"passed"` (`commit.ts`, near its
 * `succeededBranches` split) — sprint 5 migrated `runTsPipeline`'s own reader
 * (`pipeline.ts:1052`) to `isSettledContractStatus` in the same step it stopped WRITING
 * `"passed"` at all (`pipeline.ts:589` now writes `"completed"`, the same word this file
 * writes). `commit.ts`'s `passed()` still compares the literal, deliberately: migrating it
 * would change which contracts land in a GRAPH run's `completedSprints`, which moves golden
 * cases and is exactly what sc-5-4's stop condition forbids — so a reader that still checks
 * `status === "passed"` there sees no change from this file. This node's job was only to
 * make the channel converge on the settled copy at all, and it now does; unifying the
 * WRITTEN word across engines was sprint 5's job, not this one's.
 * `sprint-evaluate.test.ts` asserts the settled status lands in the channel.
 *
 * ── `evaluatorFeedback`/`generatorNotes` (sprint 5 of spec-20260814-pge-full-convergence) ──
 *
 * Before this sprint, `settled` never carried either field, because the seeded contract never
 * does and `sprint_exit` had no other source for them — the `contracts` divergence's two
 * missing-writer deltas. Both now ride the SAME edge `version` already rides: the decisive
 * `SprintVerdict` `sprint_evaluate` emits, read here through `branchOutcome`. `sprint_exit`'s
 * declared `reads` stays `["evaluations"]` alone (`coding.graph.ts:756`) — no new channel, no
 * topology change, no `graphVersion` bump — because the raw values were carried ONTO that
 * channel's existing entries rather than fetched from a second one. See
 * `sprint-evaluate.ts`'s `sprintVerdict` doc comment for exactly which call sites populate
 * them, and `overall.ts`'s `SprintVerdictSchema` doc comment for why widening the schema with
 * an optional field (rather than adding a channel, the option `anchors.ts:179-196` rejected
 * for an unrelated fact) is proportionate here.
 *
 * ── `version` (sprint 6 of spec-20260814-pge-full-convergence) — CLOSED ──
 *
 * This file has written `version: attempts` since sprint 3; the imperative engine wrote none
 * until sprint 6, when `runSprintCycle` (`pipeline.ts`) gained its own count of rounds that
 * reached a decisive verdict — `settledAttempts`, incremented once per round the evaluator
 * actually ran for, floored at 1 — and started writing it at all four of its own settle sites.
 * This file is untouched by that closure: the counting rule lives once, here, and the
 * imperative side reproduces its SHAPE (a replay-stable count of decisive rounds, never a
 * clock or an ordering) independently, the way `generateAttemptsSoFar`
 * (`nodes/gates.ts:245-250`) already mirrors this file's round-counting for `history`'s
 * `iteration` field. `contracts`' last field delta is closed as of sprint 6.
 */

export const SPRINT_REVIEW_NODE_IDS = {
  review: "sprint_review",
  exit: "sprint_exit",
} as const;

// ── Helpers ─────────────────────────────────────────────────────────

function note(ctx: NodeContext, text: string): GraphMessage {
  return {
    id: `${ctx.nodeId}:${ctx.branchKey ?? "root"}:${String(ctx.superstep)}`,
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

// ── sprint_review ───────────────────────────────────────────────────

/**
 * Advisory code review of a passing sprint diff, through the shipped reviewer.
 *
 * ── History event 8 of 10 (sc-4-1) ──
 *
 * `code-review-complete` fires after `EFFECTS.reviewerSprint` returns, from the same three
 * finding-array lengths `pipeline.ts:636` reports.
 */
export function sprintReviewNode(spec: TopologySpec): NodeImpl<unknown, unknown> {
  const nodeId = SPRINT_REVIEW_NODE_IDS.review;
  const node = nodeSpecOf(spec, nodeId);
  const next = soleSuccessor(spec, nodeId);

  return {
    id: nodeId,
    kind: "llm",
    inputPort: portOf(node, "input"),
    outputPort: portOf(node, "output"),
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    handler: async (input, state, ctx) => {
      const contract = resolveContract(input, state, ctx);
      if (contract === null) {
        throw new Error(`Node "${nodeId}" ran for a branch with no contract in the channel.`);
      }
      const iteration = iterationOf(state, contract.contractId);

      const review = (await ctx.effects.invoke(
        EFFECTS.reviewerSprint,
        {
          contract,
          evaluation: provisionalEvaluation(ctx, { success: true, notes: "sprint passed evaluation" }),
          projectRoot: ctx.projectRoot,
        },
        ctx,
      )) as z.infer<typeof ReviewResultSchema>;

      await emitPhaseEvent(ctx, {
        event: HISTORY_EVENT.CODE_REVIEW_COMPLETE,
        phase: "complete",
        sprintId: contract.contractId,
        details: {
          critical: review.critical.length,
          important: review.important.length,
          minor: review.minor.length,
        },
      });

      const summary = `review ${review.reviewId}: ${String(review.critical.length)} critical, ${String(review.important.length)} important, ${String(review.minor.length)} minor`;

      return {
        update: {
          messages: [note(ctx, summary)],
          // `skipped`, not `pass`/`fail`: the review is advisory and a verdict of `fail`
          // here would make an advisory finding change the branch's outcome.
          evaluations: [
            sprintVerdict({ ctx, contract, iteration, verdict: "skipped", summary }),
          ],
          ledger: [charge(ctx)],
        },
        phase: "evaluating",
        goto: { kind: "node", node: next },
        output: contract,
      };
    },
  };
}

// ── sprint_exit ─────────────────────────────────────────────────────

/**
 * Whether this branch settled well, from the verdicts it recorded.
 *
 * A branch SUCCEEDS when its most recent non-advisory verdict is a pass. Advisory entries
 * (`skipped` — the security note and the review) are ignored rather than counted, so a
 * disabled security gate cannot make a failing branch look settled.
 *
 * `evaluatorFeedback`/`generatorNotes` (sc-5-1, sc-5-2) pass through from the decisive
 * verdict UNCHANGED — `sprint_exit` does not decide their content, only whether one was
 * recorded. Absent on the decisive verdict (a refusal never reaches here at all; a decisive
 * verdict from a call site that does not populate them — see `sprint-evaluate.ts`'s
 * `sprintVerdict` doc comment) means absent here too: sc-5-3 forbids inventing a value this
 * function did not receive, and the contract's stop condition forbids a plausible-looking
 * placeholder standing in for "the graph genuinely has no answer here".
 */
export function branchOutcome(
  state: Readonly<OverallState>,
  contractId: string,
): {
  settled: BranchStatus["state"];
  summary: string;
  evaluatorFeedback?: string;
  generatorNotes?: string;
} {
  const decisive = state.evaluations.filter(
    (entry) => entry.contractId === contractId && entry.verdict !== "skipped",
  );
  const last = decisive[decisive.length - 1];
  if (last === undefined) {
    return { settled: "failed", summary: "the branch recorded no decisive verdict" };
  }
  return {
    settled: last.verdict === "pass" ? "succeeded" : "failed",
    summary: last.summary,
    ...(last.evaluatorFeedback === undefined ? {} : { evaluatorFeedback: last.evaluatorFeedback }),
    ...(last.generatorNotes === undefined ? {} : { generatorNotes: last.generatorNotes }),
  };
}

/**
 * Record the branch verdict and flush the contract (sc-12-12).
 *
 * Writes `branchStatus` and `sprintContracts`, the two channels the artifact declares for
 * it, and persists the contract through the `sprint.exit` effect — the node's declared
 * `toolRef`, and its declared `fs-write`. The `.bober/contracts/<id>.json` this produces is
 * the file the imperative pipeline produces, because it is written by the same
 * `saveContract`.
 */
export function sprintExitNode(spec: TopologySpec): NodeImpl<unknown, unknown> {
  const nodeId = SPRINT_REVIEW_NODE_IDS.exit;
  const node = nodeSpecOf(spec, nodeId);
  const next = soleSuccessor(spec, nodeId);

  return {
    id: nodeId,
    kind: "tool",
    inputPort: portOf(node, "input"),
    outputPort: portOf(node, "output"),
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    handler: async (input, state, ctx) => {
      const contract = resolveContract(input, state, ctx);
      if (contract === null) {
        throw new Error(`Node "${nodeId}" ran for a branch with no contract in the channel.`);
      }
      // A refusal reached the exit — from `gate_sprint_in` or from the curate step's
      // short-circuit — so the branch is settled BADLY without ever having been evaluated.
      const refused = isNodeRefusal(input);
      const outcome = refused
        ? { settled: "failed" as const, summary: `admission refused: ${input.check}` }
        : branchOutcome(state, contract.contractId);

      const attempts = Math.max(
        1,
        state.evaluations.filter(
          (entry) => entry.contractId === contract.contractId && entry.verdict !== "skipped",
        ).length,
      );

      // sc-5-1/sc-5-2/sc-5-3: `evaluatorFeedback`/`generatorNotes` on the settled contract are
      // written from `outcome` — the decisive verdict `sprint_evaluate` produced (or, for a
      // refusal, nobody) — NEVER from the SEEDED contract's own copy of either key. The seed's
      // copy is stripped here BEFORE the spread below, so a stale value on `contract` (however
      // it got there) can never survive by omission: when `outcome` carries no raw value (a
      // refusal, or a decisive verdict from a call site that never populated one — see
      // `sprint-evaluate.ts`'s `sprintVerdict` doc comment), the field is genuinely ABSENT on
      // `settled`, which is the honest answer the contract's stop condition asks for, not a
      // seed left standing in for it.
      const { evaluatorFeedback: _seededFeedback, generatorNotes: _seededNotes, ...contractWithoutFeedback } =
        contract;
      const settled: SprintContract = {
        ...contractWithoutFeedback,
        status: outcome.settled === "succeeded" ? "completed" : "failed",
        updatedAt: ctx.clock.nowIso(),
        // `attempts` is a replay-stable count (filter().length over a channel a replay
        // rebuilds identically), monotone across the seeded->settled transition (seeded has
        // no `version` at all, which `versionRank` ranks `0`; `attempts >= 1` always beats
        // that), and branch-local (filtered by `contractId`, immune to another branch's
        // writes). See `versionRank`, `src/pge/registry/reducers.ts:366-393`.
        version: attempts,
        ...(outcome.evaluatorFeedback === undefined
          ? {}
          : { evaluatorFeedback: outcome.evaluatorFeedback }),
        ...(outcome.generatorNotes === undefined ? {} : { generatorNotes: outcome.generatorNotes }),
      };

      await ctx.effects.invoke(
        EFFECTS.sprintExit,
        { projectRoot: ctx.projectRoot, contract: settled },
        ctx,
      );

      return {
        update: {
          // `attempts >= 1` — the record that must outrank the `running` one it replaces.
          branchStatus: branchRecord(ctx, {
            state: outcome.settled,
            attempts,
            ...(outcome.settled === "succeeded" ? {} : { errorClass: "SprintFailed" }),
          } as BranchStatus),
          sprintContracts: [settled],
        },
        goto: { kind: "node", node: next },
        output: settled,
      };
    },
  };
}
