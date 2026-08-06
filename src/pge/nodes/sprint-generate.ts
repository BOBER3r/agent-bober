import { z } from "zod";

import { PlanSpecSchema } from "../../contracts/spec.js";
import type { SprintContract } from "../../contracts/sprint-contract.js";
import type { TopologySpec } from "../../contracts/topology.js";
import type { ContextHandoff } from "../../orchestrator/context-handoff.js";
import type { GraphMessage, LedgerEntry, OverallState } from "../state/overall.js";
import type { NodeContext, NodeImpl } from "../registry/nodes.js";
import { EFFECTS } from "./effects.js";
import type { GeneratorResultSchema } from "./effects.js";
import { branchRecord, nodeSpecOf, portOf, resolveContract, soleSuccessor } from "./gates.js";
import {
  correctionInstructions,
  correctionMessage,
  isCorrectionPayload,
} from "./sprint-correct.js";
import type { CorrectionPayload } from "./sprint-correct.js";

/**
 * The generator and the corrector: the two nodes that put source code in the working tree.
 *
 * ── The correction reaches the generator's PROMPT, not just its state ──
 *
 * sc-12-4 is the claim that the second iteration's prompt contains the correction payload.
 * The path is deliberately short and inspectable: a guard's OUTPUT is a
 * {@link CorrectionPayload}; the interpreter hands a node's output to its destination as
 * that destination's input (`interpreter.ts:1462-1470`); `sprint_correct` records it into
 * `messages` and passes it on; `sprint_generate` folds
 * {@link correctionInstructions} into `handoff.instructions`, which is the field
 * `runGenerator` renders into the model's user turn (`generator-agent.ts`). No channel
 * outside each node's declared `writes` is touched at any hop.
 *
 * ── Why the handoff is built by hand ──
 *
 * `createHandoff` (`context-handoff.ts:85`) calls `new Date().toISOString()` at line 98. A
 * wall clock inside a node body is exactly what the concurrency-1 versus concurrency-8
 * byte-identical criterion forbids, and the handoff reaches `.bober/` through the agents
 * that consume it. So the object is constructed literally with `ctx.clock.nowIso()`. The
 * SHAPE is still the shipped `ContextHandoff` — no parallel handoff type — which
 * `ContextHandoffSchema` on the effect's request re-checks at the boundary.
 *
 * ── The corrector does NOT count its own iterations ──
 *
 * `sprint_correct` declares `loop: { counterKey: "sprintIterations", maxIterations: 3 }`,
 * the same counter `sprint_route` declares. The interpreter folds `prev + 1` into whatever
 * `counters` update the node returns (`interpreter.ts:1298-1330`) and overrides the
 * destination at the bound (`interpreter.ts:988-1029`). This body therefore returns NO
 * `counters` update at all: a hand-written increment would double-count and exhaust the
 * branch at half the declared budget.
 */

export const SPRINT_GENERATE_NODE_IDS = {
  generate: "sprint_generate",
  correct: "sprint_correct",
} as const;

/** The `refs` key a branch's generator result is offloaded under. */
export function generatorResultRefKey(contractId: string): string {
  return `sprint-generator-result:${contractId}`;
}

/** The `refs` key a branch's latest correction payload is offloaded under. */
export function correctionRefKey(contractId: string): string {
  return `sprint-correction:${contractId}`;
}

/** The branch error class recorded while a branch is generating. */
export const GENERATING_ERROR_CLASS = "Generating";

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

/**
 * A `ContextHandoff` for one sprint, with every timestamp taken from the injected clock.
 *
 * Exported so a test can assert the correction really is in `instructions` without running
 * a graph, and so the "no wall clock" claim is checkable rather than asserted.
 */
export function sprintHandoff(args: {
  ctx: NodeContext;
  state: Readonly<OverallState>;
  contract: SprintContract;
  correction: CorrectionPayload | null;
  changedFiles?: readonly string[];
}): ContextHandoff {
  const { ctx, state, contract, correction } = args;
  const instructions = [
    `Implement sprint contract ${contract.contractId}: ${contract.title}.`,
    ...(correction === null ? [] : [correctionInstructions(correction)]),
  ].join("\n\n");

  return {
    timestamp: ctx.clock.nowIso(),
    from: correction === null ? "planner" : "evaluator",
    to: "generator",
    projectContext: {
      name: ctx.config.project.name,
      type: ctx.config.project.mode,
      techStack: [],
      entryPoints: [],
      currentBranch: "",
    },
    spec: state.spec ?? syntheticSpec(contract, ctx.clock.nowIso()),
    currentContract: contract,
    sprintHistory: state.sprintContracts.filter(
      (entry) => entry.contractId !== contract.contractId && entry.status === "completed",
    ),
    instructions,
    changedFiles: [...(args.changedFiles ?? [])],
    decisions: [],
    issues: correction === null ? [] : [correction.critique],
  };
}

/**
 * A one-contract `PlanSpec` for a run whose `spec` channel is still empty.
 *
 * A REGION run legitimately starts from contracts alone — that is what a projection IS — and
 * `runCurator`, `runGenerator` and `runEvaluatorAgent` all take a spec. Parsed through the
 * REAL `PlanSpecSchema` so its own defaults fill everything this does not name, and so a
 * schema change cannot leave a hand-written look-alike behind. `now` comes from the caller's
 * injected clock; nothing here reads a wall clock.
 */
export function syntheticSpec(contract: SprintContract, now: string): ContextHandoff["spec"] {
  return PlanSpecSchema.parse({
    specId: contract.specId,
    title: contract.title,
    description: contract.description,
    status: "ready",
    mode: "brownfield",
    features: [],
    createdAt: contract.createdAt ?? now,
    updatedAt: contract.updatedAt ?? now,
  });
}

/** The contract a sprint node is working on, or a hard failure naming why not. */
function requireContract(
  input: unknown,
  state: Readonly<OverallState>,
  ctx: NodeContext,
): SprintContract {
  const contract = resolveContract(input, state, ctx);
  if (contract === null) {
    throw new Error(
      `Node "${ctx.nodeId}" was entered for branch "${ctx.branchKey ?? "<root>"}" and no matching contract is in the sprintContracts channel.`,
    );
  }
  return contract;
}

// ── sprint_generate ─────────────────────────────────────────────────

/**
 * Implement one sprint contract through the shipped `runGenerator`, unmodified.
 *
 * The node declares `effects: ["fs-write"]` and reaches the agent through
 * `ctx.effects.invoke`, so the working-tree write is authorised by the artifact rather than
 * by an import. The generator's result is offloaded to the scratch store and only its
 * `ScratchRef` enters `refs`: a `filesChanged` list on a real sprint is far past the 4 KiB
 * inline budget every channel declares.
 */
export function sprintGenerateNode(spec: TopologySpec): NodeImpl<unknown, unknown> {
  const nodeId = SPRINT_GENERATE_NODE_IDS.generate;
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
      const contract = requireContract(input, state, ctx);
      const correction = isCorrectionPayload(input) ? input : null;
      const handoff = sprintHandoff({ ctx, state, contract, correction });

      const result = (await ctx.effects.invoke(
        EFFECTS.generatorSprint,
        { handoff, projectRoot: ctx.projectRoot },
        ctx,
      )) as z.infer<typeof GeneratorResultSchema>;

      const ref = await ctx.scratch.put(ctx.runId, "payload", JSON.stringify(result));
      return {
        update: {
          messages: [
            note(
              ctx,
              `generated ${contract.contractId}: ${String(result.filesChanged.length)} file(s), success=${String(result.success)}`,
            ),
          ],
          refs: { [generatorResultRefKey(contract.contractId)]: ref },
          // `attempts: 0` — the branch is RUNNING, and a running record claiming a
          // completed attempt would outrank the outcome that follows it
          // (`state/overall.ts:131-142`).
          branchStatus: branchRecord(ctx, {
            state: "running",
            attempts: 0,
            errorClass: GENERATING_ERROR_CLASS,
          }),
          ledger: [charge(ctx)],
        },
        phase: "generating",
        goto: { kind: "node", node: next },
        output: result,
      };
    },
  };
}

// ── sprint_correct ──────────────────────────────────────────────────

/**
 * Record the correction and hand the branch back to the generator (sc-12-4).
 *
 * Every route into the corrector converges here — `gate_syntax` and
 * `gate_anchor_regression` through `gate.onFail`, `sprint_route` through the `retry` label —
 * and all three arrive carrying a {@link CorrectionPayload}. The body writes exactly the
 * channels the artifact declares for it (`messages`, `refs`, `ledger`) and lets the
 * interpreter own `counters`.
 */
export function sprintCorrectNode(spec: TopologySpec): NodeImpl<unknown, unknown> {
  const nodeId = SPRINT_GENERATE_NODE_IDS.correct;
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
      const contract = requireContract(input, state, ctx);
      if (!isCorrectionPayload(input)) {
        // Nothing to correct: hand the branch on unchanged rather than inventing a
        // critique the generator would then be asked to act on.
        return {
          update: { messages: [note(ctx, `no correction payload reached ${contract.contractId}`)] },
          goto: { kind: "node", node: next },
          output: input,
        };
      }

      // The payload in full, on disk. The MESSAGE carries the bounded excerpt; this ref
      // carries the whole thing, so a later reader can recover what the generator was told.
      const ref = await ctx.scratch.put(ctx.runId, "payload", JSON.stringify(input));

      return {
        update: {
          messages: [correctionMessage(ctx, input)],
          refs: { [correctionRefKey(contract.contractId)]: ref },
          ledger: [charge(ctx)],
        },
        goto: { kind: "node", node: next },
        output: input,
      };
    },
  };
}
