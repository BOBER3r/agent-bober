import { z } from "zod";

import { ResearchDigestSchema, totalSchema } from "../../contracts/problem-reflection.js";
import type { ResearchDigest } from "../../contracts/problem-reflection.js";
import {
  PlanSpecSchema,
  getOpenClarifications,
  hasOpenClarifications,
  resolveClarification,
} from "../../contracts/spec.js";
import type { PlanSpec, ResolvedClarification } from "../../contracts/spec.js";
import { SprintContractSchema } from "../../contracts/sprint-contract.js";
import type { SprintContract } from "../../contracts/sprint-contract.js";
import type { TopologySpec } from "../../contracts/topology.js";
import { loopCounterKey } from "../runtime/interpreter.js";
import { resumeMessageId } from "../runtime/interrupt.js";
import type { Exact, GraphMessage, LedgerEntry, OverallState, ScratchRef } from "../state/overall.js";
import type { NodeContext, NodeImpl, NodeRegistry } from "../registry/nodes.js";
import { EFFECTS } from "./effects.js";
import type { PlannerResponseSchema } from "./effects.js";
import { loopBoundOf, nodeSpecOf, portOf, preconditionIssue, schemaGate, soleSuccessor } from "./gates.js";
import { resolveResearchDigest } from "./research.js";
import type { SchemaIssue } from "../../contracts/problem-reflection.js";

/**
 * The plan region's node bodies: entry gate, draft, clarification check, the HITL
 * clarification gate, materialisation and the exit gate.
 *
 * ── The plan region is a REGION, not a subgraph ──
 *
 * The artifact declares exactly two subgraphs, `research` and `sprint`
 * (`coding.graph.ts:1170-1187`), and every node below carries `subgraph: null`
 * (`coding.graph.ts:353-442`). The artifact's own header says so at
 * `coding.graph.ts:49-51`. The sprint contract's "plan subgraph" wording is an error in
 * the contract; `supervisor.test.ts` pins the artifact's answer so the discrepancy is
 * settled by the repository rather than by a claim.
 *
 * ── The clarification loop uses the vocabulary that already exists ──
 *
 * `ClarificationQuestionSchema`, `ResolvedClarificationSchema`, `hasOpenClarifications`,
 * `getOpenClarifications`, `resolveClarification` and `isPipelineReady` are all shipped in
 * `src/contracts/spec.ts` and are the only clarification vocabulary in this module — no
 * parallel question type, and none of the source documents' `sprint_id`, `goals`,
 * `files_to_edit`, `verification_commands` or `trip_goal` errata (nonGoal #3).
 *
 * ── How an answer reaches the planner's INPUT ──
 *
 * The pause is raised by `InterruptController.maybeInterrupt` BEFORE `plan_clarify` is
 * dispatched (ADR-6), so nothing ran and nothing re-runs. `applyResume` injects the human
 * decision into `state.messages` as a `GraphMessage` keyed by `resumeMessageId`
 * (`interrupt.ts:420-427`). `plan_clarify` then reads that message, folds the answers into
 * the draft with `resolveClarification`, and routes along the artifact's declared
 * `e-plan-clarified` edge back to `plan_draft` — whose input is therefore the merged
 * `PlanSpec` CARRYING THE ANSWERS (sc-11-3). That is why `plan_draft` accepts either a
 * `ResearchDigest` or a `PlanSpec`: the artifact's own `e-plan-clarified` edge declares no
 * port mapping, which is the artifact acknowledging exactly this.
 *
 * ── Materialisation writes CHANNELS, not files ──
 *
 * `plan_materialize` writes `spec` and `sprintContracts`, and the commit boundary persists
 * them (`commit.ts:415-430`), de-duplicated by canonical bytes. A node that also wrote the
 * files itself would double-write and break the exactly-once accounting those writes are
 * asserted against.
 */

// ── Node ids ────────────────────────────────────────────────────────

export const PLAN_NODE_IDS = {
  entryGate: "gate_plan_in",
  draft: "plan_draft",
  clarifyCheck: "plan_clarify_check",
  clarify: "plan_clarify",
  materialize: "plan_materialize",
  exitGate: "gate_plan_out",
} as const;

/** The `refs` key the materialised plan spec is offloaded under. */
export const PLAN_SPEC_REF_KEY = "plan-spec";

/**
 * The contract list a plan port carries.
 *
 * `SprintContractSchema` is the REAL contract schema and this is an array OF IT — the
 * artifact names the ELEMENT type in `schemaRef` and the cardinality in the port key
 * (`contracts` here, `contract` on `fanout_sprints`' output, `coding.graph.ts:453-454`).
 * No second contract type is introduced anywhere, which {@link _planContractsAreExact}
 * and `overall.ts:269` both fail `tsc` over (sc-11-9).
 */
export const PlanContractsSchema = z.array(SprintContractSchema);
export type PlanContracts = z.infer<typeof PlanContractsSchema>;

/** sc-11-9 — the plan region's port payload IS the shipped `SprintContract`. */
export const _planContractsAreExact: Exact<PlanContracts[number], SprintContract> = true;

// ── Helpers ─────────────────────────────────────────────────────────

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

function charge(ctx: NodeContext, callIndex = 0): LedgerEntry {
  const entry: LedgerEntry = {
    nodeId: ctx.nodeId,
    attempt: 0,
    callIndex,
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
 * The id prefix `applyResume` keys an injected decision under, derived from the shipped
 * function rather than spelled.
 *
 * Deriving it matters here: the artifact declares `checkpointId: "plan-clarify"`
 * (`coding.graph.ts:413`), which is NOT one of the nine ids the shipped approval
 * subsystem answers (`src/orchestrator/checkpoints/types.ts:16-26`), so a composition that
 * substitutes a shipped id changes the message id. Matching on the prefix plus the gate's
 * own node id finds the decision either way.
 */
const HITL_MESSAGE_PREFIX = resumeMessageId("");

/** The human decision recorded for `nodeId`, or `undefined` when none was injected. */
export function hitlDecisionFor(
  state: Readonly<OverallState>,
  nodeId: string,
): GraphMessage | undefined {
  return state.messages.find(
    (message) => message.nodeId === nodeId && message.id.startsWith(HITL_MESSAGE_PREFIX),
  );
}

/** The answers a resumed decision carries, in the shipped `CheckpointOutcome` envelope. */
export const ClarificationAnswersSchema = z.object({
  answers: z.array(z.object({ questionId: z.string().min(1), answer: z.string().min(1) })).min(1),
});
export type ClarificationAnswers = z.infer<typeof ClarificationAnswersSchema>;

const DecisionEnvelopeSchema = z.object({
  approved: z.boolean().optional(),
  edit: z.boolean().optional(),
  editDelta: z.unknown().optional(),
});

/** The answers inside a decision message, or `[]` when it carries none. */
export function answersIn(message: GraphMessage | undefined): ClarificationAnswers["answers"] {
  if (message?.text === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(message.text) as unknown;
  } catch {
    return [];
  }
  const envelope = DecisionEnvelopeSchema.safeParse(parsed);
  if (!envelope.success) return [];
  const answers = ClarificationAnswersSchema.safeParse(envelope.data.editDelta);
  return answers.success ? answers.data.answers : [];
}

/**
 * Fold answers into a draft with the SHIPPED `resolveClarification`.
 *
 * Guarded by the draft's own question list because `resolveClarification` throws on an id
 * the spec does not carry (`spec.ts:284`) — a second planner pass can legitimately drop a
 * question the human already answered, and that is not a reason to fail the run.
 */
export function applyAnswers(
  draft: PlanSpec,
  answers: ReadonlyArray<{ questionId: string; answer: string }>,
): PlanSpec {
  let merged = draft;
  for (const answer of answers) {
    if (!merged.clarificationQuestions.some((q) => q.questionId === answer.questionId)) continue;
    merged = resolveClarification(merged, answer.questionId, answer.answer, "user");
  }
  return merged;
}

// ── gate_plan_in ────────────────────────────────────────────────────

export function planEntryGate(spec: TopologySpec): NodeImpl<unknown, unknown> {
  return schemaGate({ spec, nodeId: PLAN_NODE_IDS.entryGate, admitted: ResearchDigestSchema });
}

// ── plan_draft ──────────────────────────────────────────────────────

/** What `plan_draft` may be handed: the brief, or the draft the clarification gate returned. */
const DraftInputSchema = z.union([ResearchDigestSchema, PlanSpecSchema]);

/**
 * Draft the plan through the shipped `runPlanner`, unmodified.
 *
 * On the clarification round the input is the merged draft rather than the brief, so the
 * brief is resolved from the offloaded digest — the same `refs` handle `research_collect`
 * writes. KNOWN ARTIFACT DRIFT: `plan_draft` declares `reads: ["messages", "spec"]` and
 * the fallback reads `refs`. Reported rather than fixed; the artifact is out of scope.
 *
 * The answers are ALSO carried on the effect request, beside the folded prompt. The
 * shipped agent has no parameter for them — adding one would modify it (nonGoal #2) — so
 * they reach `runPlanner` through `userPrompt`, and the explicit field is what makes "the
 * planner was re-invoked WITH the answers" an assertion about a value rather than about
 * substring matching.
 */
export function planDraftNode(spec: TopologySpec): NodeImpl<ResearchDigest | PlanSpec, PlanSpec> {
  const nodeId = PLAN_NODE_IDS.draft;
  const node = nodeSpecOf(spec, nodeId);
  const next = soleSuccessor(spec, nodeId);

  return {
    id: nodeId,
    kind: "llm",
    inputPort: portOf(node, "input"),
    outputPort: portOf(node, "output"),
    inputSchema: totalSchema(DraftInputSchema),
    outputSchema: totalSchema(PlanSpecSchema),
    handler: async (input, state, ctx) => {
      const carried = ResearchDigestSchema.safeParse(input);
      const priorDraft = carried.success ? null : PlanSpecSchema.parse(input);
      const brief: ResearchDigest | null = carried.success
        ? carried.data
        : await resolveResearchDigest(state, ctx);

      const resolved: ResolvedClarification[] = priorDraft?.resolvedClarifications ?? [];
      const answers = resolved.map((entry) => ({
        questionId: entry.questionId,
        answer: entry.answer,
      }));

      const userPrompt = [
        state.featureRequest,
        answers.length === 0
          ? ""
          : `Answers to your clarification questions:\n${answers
              .map((entry) => `- ${entry.questionId}: ${entry.answer}`)
              .join("\n")}`,
      ]
        .filter((part) => part.length > 0)
        .join("\n\n");

      const result = (await ctx.effects.invoke(
        EFFECTS.plannerDraft,
        {
          userPrompt,
          projectRoot: ctx.projectRoot,
          ...(brief === null
            ? {}
            : {
                researchDoc: {
                  id: brief.researchId,
                  timestamp: brief.timestamp,
                  questions: brief.questions,
                  findings: brief.findings,
                  sections: brief.sections,
                  filesExplored: brief.filesExplored,
                  questionsAnswered: brief.questionsAnswered,
                },
              }),
          resolvedClarifications: answers,
        },
        ctx,
      )) as z.infer<typeof PlannerResponseSchema>;

      // Re-applied rather than assumed: the planner is free to re-emit a question the
      // human already answered, and the answer is a fact about the run either way.
      const draft = applyAnswers(result.spec, answers);

      return {
        update: {
          messages: [note(ctx, `drafted ${draft.specId} (${result.kind})`)],
          ledger: [charge(ctx)],
        },
        phase: "planning",
        goto: { kind: "node", node: next },
        output: draft,
      };
    },
  };
}

// ── plan_clarify_check ──────────────────────────────────────────────

/**
 * Route to the human while the draft still carries open questions.
 *
 * `hasOpenClarifications` is the shipped predicate; the bound is the artifact's
 * `planClarifyRounds` loop. Unlike the research router this one does NOT leave the cycle
 * on its own at the bound: `loop.onExhausted` here is `graceful_failure`, and a planner
 * that has burned its whole clarification budget without converging is a run that should
 * fail loudly rather than silently proceed with unanswered questions.
 */
export function planClarifyCheckNode(spec: TopologySpec): NodeImpl<PlanSpec, PlanSpec> {
  const nodeId = PLAN_NODE_IDS.clarifyCheck;
  const node = nodeSpecOf(spec, nodeId);
  if (node.kind !== "router") throw new Error(`Node "${nodeId}" is not a router node.`);
  const bound = loopBoundOf(spec, nodeId);
  const labels = new Set(node.targets.map((target) => target.label));
  for (const label of ["clarify", "ok"]) {
    if (!labels.has(label)) {
      throw new Error(`Node "${nodeId}" declares no "${label}" target in the topology artifact.`);
    }
  }

  return {
    id: nodeId,
    kind: "router",
    inputPort: portOf(node, "input"),
    outputPort: portOf(node, "output"),
    inputSchema: totalSchema(PlanSpecSchema),
    outputSchema: totalSchema(PlanSpecSchema),
    handler: async (input, state, ctx) => {
      const key = loopCounterKey(bound.counterKey, ctx.branchKey);
      const taken = (state.counters[key] ?? 0) + 1;
      return {
        update: { counters: { [key]: taken } },
        goto: { kind: "label", label: hasOpenClarifications(input) ? "clarify" : "ok" },
        output: input,
      };
    },
  };
}

// ── plan_clarify ────────────────────────────────────────────────────

/**
 * The human-in-the-loop clarification gate.
 *
 * The body contains NO interrupt call. The pause is raised by the interpreter, before
 * dispatch, at a superstep boundary (ADR-6) — so by the time this runs the decision has
 * already been made and injected into state. All that is left is to fold it into the draft
 * and hand the draft back to the planner along the artifact's `e-plan-clarified` edge.
 *
 * A body with nothing to fold (an autopilot approval records no answers) passes the draft
 * through unchanged, the planner re-emits its questions, and the `planClarifyRounds` bound
 * ends the cycle — which is the artifact's declared behaviour, not a special case.
 */
export function planClarifyNode(spec: TopologySpec): NodeImpl<PlanSpec, PlanSpec> {
  const nodeId = PLAN_NODE_IDS.clarify;
  const node = nodeSpecOf(spec, nodeId);
  const next = soleSuccessor(spec, nodeId);

  return {
    id: nodeId,
    kind: "gate",
    inputPort: portOf(node, "input"),
    outputPort: portOf(node, "output"),
    inputSchema: totalSchema(PlanSpecSchema),
    outputSchema: totalSchema(PlanSpecSchema),
    handler: async (input, state, ctx) => {
      const answers = answersIn(hitlDecisionFor(state, nodeId));
      const merged = applyAnswers(input, answers);
      const remaining = getOpenClarifications(merged).length;

      return {
        update: {
          messages: [
            note(
              ctx,
              `clarification: ${String(answers.length)} answered, ${String(remaining)} open`,
            ),
          ],
        },
        goto: { kind: "node", node: next },
        output: merged,
      };
    },
  };
}

// ── plan_materialize ────────────────────────────────────────────────

/**
 * Persist the plan by WRITING ITS CHANNELS.
 *
 * `spec` is a scalar channel with a single declared writer, and `sprintContracts` is the
 * contract set. The commit boundary turns both into `.bober/` artifacts. The contracts
 * themselves come from the shipped `materializeContracts`, so the files this produces are
 * the files the imperative pipeline produces.
 */
export function planMaterializeNode(spec: TopologySpec): NodeImpl<PlanSpec, PlanContracts> {
  const nodeId = PLAN_NODE_IDS.materialize;
  const node = nodeSpecOf(spec, nodeId);
  const next = soleSuccessor(spec, nodeId);

  return {
    id: nodeId,
    kind: "tool",
    inputPort: portOf(node, "input"),
    outputPort: portOf(node, "output"),
    inputSchema: totalSchema(PlanSpecSchema),
    outputSchema: totalSchema(PlanContractsSchema),
    handler: async (input, _state, ctx) => {
      const contracts = (await ctx.effects.invoke(
        EFFECTS.planMaterialize,
        { projectRoot: ctx.projectRoot, spec: input },
        ctx,
      )) as PlanContracts;

      const specRef: ScratchRef = await ctx.scratch.put(
        ctx.runId,
        "document",
        JSON.stringify(input),
      );

      return {
        update: {
          spec: input,
          sprintContracts: contracts,
          refs: { [PLAN_SPEC_REF_KEY]: specRef },
        },
        goto: { kind: "node", node: next },
        output: contracts,
      };
    },
  };
}

// ── gate_plan_out ───────────────────────────────────────────────────

/**
 * The plan exit gate: the fail-closed schema gate sc-11-4 and sc-11-5 are about.
 *
 * Root-scope, so its refusal routes straight to the artifact's declared
 * `gate.onFail: "graceful_failure"`. Its declared check is
 * `spec-and-contracts-persisted`, and it consults exactly the two channels its artifact
 * declaration lists in `reads` — `spec` and `sprintContracts` — after the payload itself
 * has parsed.
 */
export function planExitGate(spec: TopologySpec): NodeImpl<unknown, unknown> {
  return schemaGate({
    spec,
    nodeId: PLAN_NODE_IDS.exitGate,
    admitted: PlanContractsSchema.min(1),
    precondition: (contracts, state) => {
      const issues: SchemaIssue[] = [];
      if (state.spec === null) {
        issues.push(preconditionIssue("spec", "no plan spec was committed to the spec channel"));
      }
      const committed = new Set(state.sprintContracts.map((contract) => contract.contractId));
      const missing = contracts.filter((contract) => !committed.has(contract.contractId));
      if (missing.length > 0) {
        issues.push(
          preconditionIssue(
            "sprintContracts",
            `${String(missing.length)} contract(s) never reached the sprintContracts channel`,
          ),
        );
      }
      return issues;
    },
  });
}

// ── Registration ────────────────────────────────────────────────────

/** Register every plan-region implementation into `registry`. */
export function registerPlanNodes(registry: NodeRegistry, spec: TopologySpec): void {
  registry.register(planEntryGate(spec));
  registry.register(planDraftNode(spec));
  registry.register(planClarifyCheckNode(spec));
  registry.register(planClarifyNode(spec));
  registry.register(planMaterializeNode(spec));
  registry.register(planExitGate(spec));
}
