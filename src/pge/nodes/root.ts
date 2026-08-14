import { z } from "zod";

import { totalSchema } from "../../contracts/problem-reflection.js";
import { TERMINAL_ENDPOINT } from "../../contracts/topology.js";
import type { TopologySpec } from "../../contracts/topology.js";
import { SprintVerdictSchema } from "../state/overall.js";
import type { GraphMessage, LedgerEntry, OverallState, SprintVerdict } from "../state/overall.js";
import type { NodeContext, NodeImpl, NodeRegistry } from "../registry/nodes.js";
import { decideCompaction, renderTranscriptJsonl, selectTail } from "../runtime/compactor.js";
import { synthesizeBranchOutcomes } from "../runtime/graceful-failure.js";
import { createCharsPerTokenEstimator } from "../runtime/token-estimator.js";
import {
  gatePolicyOf,
  guardGate,
  loopBoundOf,
  nodeSpecOf,
  portOf,
  preconditionIssue,
  refuse,
  successorOrEnd,
} from "./gates.js";
import { CorrectionPayloadSchema, buildCorrection } from "./sprint-correct.js";
import type { CorrectionPayload } from "./sprint-correct.js";
import { dispatchableContracts } from "./sprint-fanout.js";
import { GRACEFUL_FAILURE_NODE_ID } from "./regions.js";

/**
 * The EIGHT root-scope nodes that belong to no region.
 *
 * ── Why they are here and not in a region module ──
 *
 * `../regions.ts` projects the committed artifact into four regions — research, plan,
 * sprint, terminal — and every node in this file sits OUTSIDE all four: the artifact gives
 * each of them `subgraph: null` and none of them is reachable from a region's entry gate.
 * They are the run's own spine: the barrier that admits a run into global evaluation, the
 * global evaluation itself, the two routers that decide what a failing run does next, the
 * two producers that turn a global verdict into rework instructions or a qualified partial
 * answer, the compaction utility, and the terminal that records the run's verdict.
 *
 * Until this sprint they had no implementations at all, so `codingRegistries` compiled the
 * committed artifact to eight `UnregisteredNodeImpl` diagnostics (sc-13-1). Registering
 * them is what makes the artifact and the registered implementations the same graph.
 *
 * ── Three of them are declared `llm` and none of them calls a model ──
 *
 * `evaluate_global`, `critique` and `synthesize` carry `kind: "llm"`, a `modelTier` and a
 * `promptRef` in the artifact, and this repository ships no agent for any of the three:
 * nothing here has ever graded a whole spec, turned a global verdict into per-branch rework
 * instructions, or written a qualified partial answer. Two options existed and both were
 * rejected:
 *
 *  - bind them to a throwing collaborator, as `PgeEngine` does for `reflect`/`critique`/
 *    `explain`/`mocks`. That is right when a node's whole job is the missing call, and
 *    wrong here: these three sit on the ONLY path from a settled fan-out to the run's
 *    terminal, so a thrower would make every full-graph run die at the last barrier and
 *    would take sc-13-2, sc-13-3, sc-13-7 and sc-13-8 with it;
 *  - invent a prompt and a provider call. That would put a second, unreviewed inference
 *    path in the product and make a conformance comparison a comparison of model output.
 *
 * So each of the three is a DERIVATION over channels the artifact already says it reads,
 * built out of shipped, pure reducers (`synthesizeBranchOutcomes`, `buildCorrection`) where
 * one exists. Each charges the ledger a ZERO-cost entry: it records that the node ran
 * without claiming spend that never happened, which keeps the per-node sums equal to the
 * run totals (sc-13-7). {@link DERIVED_LLM_NODES} names them so a test can assert the
 * property rather than trust this paragraph, and so the sprint that binds a real
 * collaborator has one list to consult.
 *
 * ── Nothing here emits the pipeline-complete event or the completion marker ──
 *
 * `finalize` records the run's VERDICT into the `verdict` channel and offloads a run
 * summary. It does not call `finalizePipelineRun`: that function is the single owner of the
 * terminal side effects (`src/orchestrator/finalize.ts`) and `CommitBoundary.finalize` is
 * the one caller in this runtime. A second emitter is exactly the defect the ordering
 * comment there describes.
 */

// ── Ids ─────────────────────────────────────────────────────────────

export const ROOT_NODE_IDS = {
  evalGate: "gate_eval_in",
  evaluateGlobal: "evaluate_global",
  routeAfterEval: "route_after_eval",
  critique: "critique",
  reworkRoute: "rework_route",
  synthesize: "synthesize",
  contextCompact: "context_compact",
  finalize: "finalize",
} as const;

/** The three `llm`-declared nodes this repository derives rather than infers. */
export const DERIVED_LLM_NODES = [
  ROOT_NODE_IDS.evaluateGlobal,
  ROOT_NODE_IDS.critique,
  ROOT_NODE_IDS.synthesize,
] as const;

/** The labels the artifact declares on `route_after_eval` (`coding.graph.ts`). */
export const EVAL_ROUTE_LABELS = ["pass", "partial", "rework", "exhausted"] as const;

/** The labels the artifact declares on `rework_route`. */
export const REWORK_ROUTE_LABELS = ["rework", "exhausted"] as const;

/** The `refs` key `finalize` offloads the run summary under. */
export const RUN_SUMMARY_REF_KEY = "run-summary";

/** The `refs` key `context_compact` offloads the pre-compression transcript under. */
export const TRANSCRIPT_REF_KEY = "compacted-transcript";

/**
 * The context window `context_compact` measures against when nothing configures one.
 *
 * A constant rather than a config read because no config section describes the graph's
 * context window, and inventing a field for one node would put a knob in the product that
 * nothing else consults. Conservative on purpose: compaction that fires slightly early
 * costs a scratch write, and compaction that fires late costs the run.
 */
export const DEFAULT_CONTEXT_CAP_TOKENS = 128_000;

// ── Shared helpers ──────────────────────────────────────────────────

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
 * A zero-cost ledger entry for a node that ran without calling a model.
 *
 * `calls: 0` and not `calls: 1`: the ledger counts MODEL CALLS, and a derivation made
 * none. The entry exists so the node appears in the per-node breakdown at all — an
 * absence and a zero are different facts, and the second is the true one.
 */
function chargeNothing(ctx: NodeContext): LedgerEntry {
  const entry: LedgerEntry = {
    nodeId: ctx.nodeId,
    attempt: 0,
    callIndex: 0,
    calls: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
  };
  ctx.ledger.charge(
    { nodeId: entry.nodeId, attempt: entry.attempt, callIndex: entry.callIndex },
    {
      calls: entry.calls,
      tokensIn: entry.tokensIn,
      tokensOut: entry.tokensOut,
      costUsd: entry.costUsd,
    },
  );
  return entry;
}

/**
 * How many rework rounds the run has spent, off the counter `rework_route` declares.
 *
 * Zero for a projection that does not contain `rework_route` at all: every region
 * legitimately lacks it, and the supervisor is built for every region. A throw there would
 * turn a legitimate projection into a topology defect.
 */
export function reworkRoundsTaken(spec: TopologySpec, state: Readonly<OverallState>): number {
  if (!spec.nodes.some((node) => node.id === ROOT_NODE_IDS.reworkRoute)) return 0;
  const { counterKey } = loopBoundOf(spec, ROOT_NODE_IDS.reworkRoute);
  // Root-scope, so the counter is unsuffixed — `loopCounterKey(key, null) === key`.
  return state.counters[counterKey] ?? 0;
}

/** The branches that did not succeed, sorted. */
export function unsucceededBranches(state: Readonly<OverallState>): string[] {
  return Object.entries(state.branchStatus)
    .filter(([, status]) => status.state !== "succeeded")
    .map(([branchKey]) => branchKey)
    .sort();
}

/** The branches that have not settled either way, sorted. */
export function unsettledBranches(state: Readonly<OverallState>): string[] {
  return Object.entries(state.branchStatus)
    .filter(([, status]) => status.state === "pending" || status.state === "running")
    .map(([branchKey]) => branchKey)
    .sort();
}

// ── gate_eval_in ────────────────────────────────────────────────────

/**
 * The evaluation entry barrier (`gate.check: "all-sprints-settled"`).
 *
 * Admits when every branch the fan-out dispatched has reached a terminal state, and
 * refuses otherwise. A `failed` branch IS settled: the run reaches global evaluation
 * precisely so the failure can be graded and routed, and a gate that refused a failed
 * branch would send every imperfect run straight to the failure terminal without ever
 * evaluating it.
 *
 * An EMPTY `branchStatus` is refused. "Every branch has settled" is vacuously true over no
 * branches, and admitting on that reading would put a run that never dispatched a sprint
 * into a global evaluation with nothing to grade — the run has failed, and the artifact's
 * `gate.onFail` says where a failure goes.
 */
export function evalEntryGate(spec: TopologySpec): NodeImpl<unknown, unknown> {
  const { check, onFail } = gatePolicyOf(spec, ROOT_NODE_IDS.evalGate);

  return guardGate({
    spec,
    nodeId: ROOT_NODE_IDS.evalGate,
    check: async (input, state, ctx) => {
      const unsettled = unsettledBranches(state);
      if (unsettled.length > 0) {
        return {
          admitted: false,
          output: refuse(ctx, {
            check,
            onFail,
            issues: [
              preconditionIssue(
                "branchStatus",
                `${String(unsettled.length)} branch(es) have not settled: ${unsettled.join(", ")}`,
              ),
            ],
          }),
        };
      }
      if (Object.keys(state.branchStatus).length === 0) {
        return {
          admitted: false,
          output: refuse(ctx, {
            check,
            onFail,
            issues: [
              preconditionIssue(
                "branchStatus",
                "no sprint branch was ever dispatched, so there is nothing for a global evaluation to grade",
              ),
            ],
          }),
        };
      }
      return { admitted: true, output: input };
    },
  });
}

// ── evaluate_global ─────────────────────────────────────────────────

/**
 * The identity of the global verdict for one rework round.
 *
 * Deterministic, and keyed by the round rather than by the superstep: `evaluations` is
 * merged by `appendById`, so a re-executed superstep must produce the SAME id or the
 * channel grows a duplicate row on every replay. A second round produces a genuinely new
 * verdict and therefore a new id.
 */
export function globalVerdictId(round: number): string {
  return `global:${String(round)}`;
}

/** True when `verdict` is the global evaluation's own row rather than a sprint's. */
export function isGlobalVerdict(verdict: SprintVerdict): boolean {
  return verdict.id.startsWith("global:");
}

/**
 * The run's own latest global verdict, or `null` when no global evaluation was ever recorded.
 *
 * `evaluations` is an append-joined channel, so "latest" cannot be "the last element" — a
 * join has no recency. The round is carried IN the id ({@link globalVerdictId}), which makes
 * it the only ordering fact that survives the join, so the highest round wins and a tie
 * falls back to encounter order.
 *
 * Exported because the COMMIT boundary needs it: `commit` must be able to ask "did this run
 * pass?" rather than infer it from whether anything happened to settle. See
 * `./commit.ts`'s own doc block for why that distinction is the whole point.
 */
export function latestGlobalVerdict(state: Readonly<OverallState>): SprintVerdict | null {
  let latest: SprintVerdict | null = null;
  let latestRound = -1;
  for (const verdict of state.evaluations) {
    if (!isGlobalVerdict(verdict)) continue;
    const round = Number.parseInt(verdict.id.slice("global:".length), 10);
    // An unparseable round is still a global row; treat it as round 0 rather than dropping
    // it, so a malformed id can never make a FAILING run look like an unevaluated one.
    const ordinal = Number.isNaN(round) ? 0 : round;
    if (ordinal >= latestRound) {
      latestRound = ordinal;
      latest = verdict;
    }
  }
  return latest;
}

/** What the recorded verdicts say about one contract. */
export type ContractGrade = "pass" | "fail" | "ungraded";

/**
 * Grade every contract the run recorded a verdict for.
 *
 * ── `skipped` is not a failure, and taking the LATEST row would make it one ──
 *
 * A branch records THREE verdicts under the shipped sprint region, not one:
 * `sprint_security` and `sprint_review` both write `skipped` when they have nothing to say,
 * and `sprint_evaluate` writes the actual `pass`/`fail` in between (their ids carry the
 * writing node, `<contractId>:<nodeId>:<iteration>`). So "the last verdict for this
 * contract" is `sprint_review`'s `skipped` on every successful branch, and a run whose
 * every sprint passed would be graded a failure.
 *
 * The rule is therefore a REDUCTION over all of a contract's rows: any `fail` fails it, a
 * `pass` with no `fail` passes it, and rows that are all `skipped` — or no rows at all —
 * leave it `ungraded`, which is its own outcome and not a quiet pass.
 *
 * The global evaluation's own rows are excluded throughout: a global verdict is not
 * evidence about a sprint.
 */
export function gradeContracts(state: Readonly<OverallState>): Map<string, ContractGrade> {
  const grades = new Map<string, ContractGrade>();
  for (const verdict of state.evaluations) {
    if (isGlobalVerdict(verdict)) continue;
    const seen = grades.get(verdict.contractId) ?? "ungraded";
    if (seen === "fail") continue;
    if (verdict.verdict === "fail") grades.set(verdict.contractId, "fail");
    else if (verdict.verdict === "pass") grades.set(verdict.contractId, "pass");
    else if (!grades.has(verdict.contractId)) grades.set(verdict.contractId, "ungraded");
  }
  return grades;
}

/**
 * The most recent verdict that says something about `contractId`, ignoring `skipped`.
 *
 * What a rework instruction needs is the finding, and a `skipped` row carries none.
 */
export function latestSubstantiveVerdict(
  state: Readonly<OverallState>,
  contractId: string,
): SprintVerdict | null {
  let latest: SprintVerdict | null = null;
  for (const verdict of state.evaluations) {
    if (isGlobalVerdict(verdict)) continue;
    if (verdict.contractId !== contractId) continue;
    if (verdict.verdict === "skipped") continue;
    if (latest === null || verdict.iteration >= latest.iteration) latest = verdict;
  }
  return latest;
}

/**
 * Grade the whole run.
 *
 * A DERIVATION, for the reason the module header gives. It passes when every branch
 * succeeded AND every contract the plan produced carries a passing verdict — the two
 * halves are not the same claim, and a run whose branch "succeeded" while its evaluator
 * said `fail` must not be graded a pass.
 */
export function evaluateGlobalNode(spec: TopologySpec): NodeImpl<unknown, SprintVerdict> {
  const nodeId = ROOT_NODE_IDS.evaluateGlobal;
  const node = nodeSpecOf(spec, nodeId);
  const next = successorOrEnd(spec, nodeId);

  return {
    id: nodeId,
    kind: "llm",
    inputPort: portOf(node, "input"),
    outputPort: portOf(node, "output"),
    inputSchema: z.unknown(),
    outputSchema: totalSchema(SprintVerdictSchema),
    handler: async (_input, state, ctx) => {
      const round = reworkRoundsTaken(spec, state);
      const grades = gradeContracts(state);
      const failedBranches = unsucceededBranches(state);
      const failedContracts = [...grades.entries()]
        .filter(([, grade]) => grade === "fail")
        .map(([contractId]) => contractId)
        .sort();
      const ungraded = state.sprintContracts
        .map((contract) => contract.contractId)
        .filter((contractId) => (grades.get(contractId) ?? "ungraded") === "ungraded")
        .sort();
      const passedCount = [...grades.values()].filter((grade) => grade === "pass").length;

      const passed =
        failedBranches.length === 0 && failedContracts.length === 0 && ungraded.length === 0;
      const summary = passed
        ? `every one of ${String(passedCount)} graded contract(s) passed and every branch succeeded`
        : [
            failedBranches.length === 0 ? null : `branches not succeeded: ${failedBranches.join(", ")}`,
            failedContracts.length === 0 ? null : `contracts graded fail: ${failedContracts.join(", ")}`,
            ungraded.length === 0 ? null : `contracts never graded: ${ungraded.join(", ")}`,
          ]
            .filter((line): line is string => line !== null)
            .join("; ");

      // `contractId` and `sprintNumber` are required and non-trivial on the shipped
      // `SprintVerdict`, and a RUN-level verdict has neither. The spec id and the number
      // of contracts the run planned are recorded in their place — the widest true
      // statement the shipped schema can carry — rather than a fabricated contract id.
      const verdict: SprintVerdict = SprintVerdictSchema.parse({
        id: globalVerdictId(round),
        seq: ctx.superstep,
        contractId: state.specId ?? state.spec?.specId ?? state.runId,
        sprintNumber: Math.max(1, state.sprintContracts.length),
        iteration: round + 1,
        verdict: passed ? "pass" : "fail",
        summary,
        evalId: null,
      });

      return {
        update: {
          evaluations: [verdict],
          messages: [note(ctx, `global verdict "${verdict.verdict}": ${summary}`)],
          ledger: [chargeNothing(ctx)],
        },
        phase: "evaluating",
        goto: { kind: "node", node: next },
        output: verdict,
      };
    },
  };
}

// ── route_after_eval ────────────────────────────────────────────────

/**
 * The post-evaluation router.
 *
 * A router selects a LABEL and nothing else (ADR-3). The four the artifact declares are
 * decided in one order, and the order is the policy:
 *
 *  1. `pass` — the global verdict passed. Nothing else is consulted.
 *  2. `rework` — the run failed and the rework budget `rework_route` declares still has
 *     room. Read off the artifact's own `loop.maxIterations`, never a literal here, so the
 *     budget lives in the diff.
 *  3. `partial` — the budget is spent and SOMETHING passed. `synthesize` produces the
 *     qualified answer.
 *  4. `exhausted` — the budget is spent and nothing passed.
 *
 * Reads `counters` and `evaluations`, which is exactly what the artifact declares. "Did
 * anything pass" is therefore answered from the recorded verdicts and not from
 * `branchStatus`, which this node does not declare.
 */
export function evalRouterNode(spec: TopologySpec): NodeImpl<unknown, unknown> {
  const nodeId = ROOT_NODE_IDS.routeAfterEval;
  const node = nodeSpecOf(spec, nodeId);
  if (node.kind !== "router") {
    throw new Error(`The declared post-evaluation router "${nodeId}" is not a router node.`);
  }
  const declared = new Set(node.targets.map((target) => target.label));
  for (const label of EVAL_ROUTE_LABELS) {
    if (!declared.has(label)) {
      throw new Error(`Node "${nodeId}" declares no "${label}" target in the topology artifact.`);
    }
  }
  const { maxIterations } = loopBoundOf(spec, ROOT_NODE_IDS.reworkRoute);

  return {
    id: nodeId,
    kind: "router",
    inputPort: portOf(node, "input"),
    outputPort: portOf(node, "output"),
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    handler: async (input, state, _ctx) => {
      const carried = SprintVerdictSchema.safeParse(input);
      if (carried.success && carried.data.verdict === "pass") {
        return { goto: { kind: "label", label: "pass" }, output: carried.data };
      }

      if (reworkRoundsTaken(spec, state) < maxIterations) {
        return { goto: { kind: "label", label: "rework" }, output: carried.success ? carried.data : input };
      }

      const anythingPassed = state.evaluations.some(
        (entry) => !isGlobalVerdict(entry) && entry.verdict === "pass",
      );
      return {
        goto: { kind: "label", label: anythingPassed ? "partial" : "exhausted" },
        output: carried.success ? carried.data : input,
      };
    },
  };
}

// ── critique ────────────────────────────────────────────────────────

/**
 * Turn the global verdict into per-branch rework instructions.
 *
 * One {@link CorrectionPayload} per branch that did not succeed, built with the SHIPPED
 * `buildCorrection` the sprint corrector already consumes — so a rework instruction has the
 * same shape however it was produced, and `sprint_correct` needs no second reader.
 *
 * The critique text for a branch is that branch's own latest failing verdict where one
 * exists, and the global summary otherwise. A branch that failed before any evaluator ran
 * has no verdict of its own, and inventing one would put a claim about the code into the
 * corrector's prompt that nothing measured.
 */
export function critiqueNode(spec: TopologySpec): NodeImpl<unknown, CorrectionPayload[]> {
  const nodeId = ROOT_NODE_IDS.critique;
  const node = nodeSpecOf(spec, nodeId);
  const next = successorOrEnd(spec, nodeId);

  return {
    id: nodeId,
    kind: "llm",
    inputPort: portOf(node, "input"),
    outputPort: portOf(node, "output"),
    inputSchema: z.unknown(),
    outputSchema: totalSchema(z.array(CorrectionPayloadSchema)),
    handler: async (input, state, ctx) => {
      const global = SprintVerdictSchema.safeParse(input);
      const globalSummary = global.success
        ? global.data.summary
        : "the run did not pass its global evaluation";
      const grades = gradeContracts(state);
      // A branch needs rework when it did not succeed OR when its contract was graded a
      // failure. The two are usually the same set and are not the same claim: a branch can
      // settle `succeeded` while the evaluator that ran inside it said `fail`.
      const needsRework = [
        ...new Set([
          ...unsucceededBranches(state),
          ...[...grades.entries()]
            .filter(([, grade]) => grade === "fail")
            .map(([contractId]) => contractId),
        ]),
      ].sort();

      const corrections: CorrectionPayload[] = [];
      for (const branchKey of needsRework) {
        const own = latestSubstantiveVerdict(state, branchKey);
        corrections.push(
          await buildCorrection(ctx, {
            source: "evaluator",
            contractId: branchKey,
            critique:
              own === null || own.verdict === "pass"
                ? globalSummary
                : `${own.verdict}: ${own.summary}`,
          }),
        );
      }

      const text =
        corrections.length === 0
          ? `no branch needs rework: ${globalSummary}`
          : `${String(corrections.length)} branch(es) to rework: ${corrections
              .map((correction) => correction.contractId ?? "<unkeyed>")
              .join(", ")}`;

      return {
        update: { messages: [note(ctx, text)], ledger: [chargeNothing(ctx)] },
        goto: { kind: "node", node: next },
        output: corrections,
      };
    },
  };
}

// ── rework_route ────────────────────────────────────────────────────

/**
 * Re-dispatch the failed branches through the sprint subgraph.
 *
 * The `rework` target is a FAN-OUT edge (`e-rework-dispatch`, `rework_route ->
 * sprint_body`), so the selection carries `sends` exactly as `fanout_sprints` does, keyed
 * by contract id for the same reason: the interpreter reads a branch's dependency facts off
 * the input, and two branches sharing a key is a `FanOutNotDispatchableError`.
 *
 * The BOUND is not re-implemented here. The artifact declares
 * `loop: { counterKey: "reworkRounds", maxIterations: 2, onExhausted: "graceful_failure" }`
 * and the interpreter owns both halves — it folds the increment into this node's own
 * `counters` update and overrides the destination once the committed counter reaches the
 * bound. A body that counted for itself would double-count and exhaust the run a round
 * early.
 */
export function reworkRouterNode(spec: TopologySpec): NodeImpl<unknown, unknown> {
  const nodeId = ROOT_NODE_IDS.reworkRoute;
  const node = nodeSpecOf(spec, nodeId);
  if (node.kind !== "router") {
    throw new Error(`The declared rework router "${nodeId}" is not a router node.`);
  }
  const declared = new Set(node.targets.map((target) => target.label));
  for (const label of REWORK_ROUTE_LABELS) {
    if (!declared.has(label)) {
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
    handler: async (_input, state, _ctx) => {
      // The same dispatch rule the fan-out uses, so "what is still owed a branch" has one
      // definition in this library rather than two that can drift.
      const pending = dispatchableContracts(state, state.sprintContracts);
      if (pending.length === 0) {
        return { goto: { kind: "label", label: "exhausted" }, output: [] };
      }
      return {
        goto: {
          kind: "fanout",
          label: "rework",
          sends: pending.map((contract) => ({ branchKey: contract.contractId, input: contract })),
        },
        phase: "generating",
        output: pending,
      };
    },
  };
}

// ── synthesize ──────────────────────────────────────────────────────

/**
 * The qualified partial answer.
 *
 * `synthesizeBranchOutcomes` (`../runtime/graceful-failure.ts`) is the shipped, pure
 * reducer for exactly this: it enumerates EVERY branch with its state, attempt count and
 * error class, ranks them through `src/orchestrator/workflow/synthesizer.ts`, and renders
 * one line naming all of them. Re-deriving any of that here would let a failed branch
 * vanish from the run's own account of itself, which is the failure that function exists to
 * make impossible.
 */
export function synthesizeNode(spec: TopologySpec): NodeImpl<unknown, unknown> {
  const nodeId = ROOT_NODE_IDS.synthesize;
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
      const synthesis = synthesizeBranchOutcomes(state.branchStatus);
      return {
        update: {
          messages: [note(ctx, `partial result — ${synthesis.summary}`)],
          ledger: [chargeNothing(ctx)],
        },
        goto: { kind: "node", node: next },
        output: synthesis,
      };
    },
  };
}

// ── context_compact ─────────────────────────────────────────────────

/**
 * Compact the message window at a superstep boundary.
 *
 * The threshold decision is the SHIPPED `decideCompaction` and the re-injection window is
 * the shipped `selectTail`, measured through the shipped estimator — so what counts as
 * "too large" has one definition in this runtime.
 *
 * ── Why it offloads rather than summarises ──
 *
 * `compactGraphContext` (`../runtime/compactor.ts`) produces a MODEL-written summary and
 * takes an `LLMClient` to do it. A node body may not import a provider — every outward call
 * goes through `ctx.effects.invoke` and the imports live in `./effects.ts` — and this node
 * is `kind: "tool"` with no effect binding of its own. So it does the part it can do
 * honestly: the full pre-compression transcript is written to the content-addressed scratch
 * store, a `ScratchRef` to it goes into `refs` (which is what this node's declared
 * `writes: ["refs"]` is for), and a deterministic digest naming what was offloaded is
 * appended to `messages`. Nothing is deleted — `messages` is merged by `appendById` and the
 * digest is an addition — so the window shrinks for readers that honour the digest and no
 * turn is ever lost.
 *
 * ── It is registered and, under the shipped supervisor, never entered ──
 *
 * The only edge in is `supervisor -> context_compact` under the `compact` label, and the
 * artifact's `supervisor.reads` is `["branchStatus", "counters", "spec", "evaluations"]` —
 * it does not include `messages`, so the supervisor cannot measure the window it would be
 * compacting. Recorded as artifact drift rather than worked around, exactly as the
 * `refs` drift in `./supervisor.ts` is.
 */
export function contextCompactNode(spec: TopologySpec): NodeImpl<unknown, unknown> {
  const nodeId = ROOT_NODE_IDS.contextCompact;
  const node = nodeSpecOf(spec, nodeId);
  const next = successorOrEnd(spec, nodeId);
  const estimator = createCharsPerTokenEstimator();

  return {
    id: nodeId,
    kind: "tool",
    inputPort: portOf(node, "input"),
    outputPort: portOf(node, "output"),
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    handler: async (_input, state, ctx) => {
      const decision = decideCompaction(state.messages, DEFAULT_CONTEXT_CAP_TOKENS, estimator);
      if (!decision.shouldCompact) {
        return {
          goto: { kind: "node", node: next },
          output: { compacted: false, tokens: decision.tokens, threshold: decision.threshold },
        };
      }

      const transcript = renderTranscriptJsonl(state.messages);
      const ref = await ctx.scratch.put(ctx.runId, "document", transcript);
      const tail = selectTail(state.messages, DEFAULT_CONTEXT_CAP_TOKENS, estimator);
      const digest = `compacted ${String(state.messages.length)} message(s) (${String(decision.tokens)} tokens) to ${ref.uri}; re-injecting the last ${String(tail.tail.length)} turn(s)`;

      return {
        update: { messages: [note(ctx, digest)], refs: { [TRANSCRIPT_REF_KEY]: ref } },
        goto: { kind: "node", node: next },
        output: {
          compacted: true,
          tokens: decision.tokens,
          threshold: decision.threshold,
          transcript: ref,
          tail: tail.tail.length,
        },
      };
    },
  };
}

// ── finalize ────────────────────────────────────────────────────────

/**
 * The run's terminal: record the verdict, offload the summary, and emit NOTHING else.
 *
 * `writes: ["refs", "verdict"]`, and it writes exactly those two. It is the sole writer of
 * the scalar `verdict` channel, which the commit boundary treats as a control key and
 * therefore rejects if two nodes disagree about it in one superstep.
 *
 * It does NOT call `finalizePipelineRun`. The pipeline-complete history event and the
 * `.completed.json` marker have one owner in this product, `CommitBoundary.finalize`
 * reaches it, and `PgeEngine` calls that after the interpreter loop — see the module
 * header. A `finalize` node that emitted them would double-emit for every run that reaches
 * it and produce a completion marker for a run that had not finished.
 */
export function finalizeNode(spec: TopologySpec): NodeImpl<unknown, unknown> {
  const nodeId = ROOT_NODE_IDS.finalize;
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
      const synthesis = synthesizeBranchOutcomes(state.branchStatus);
      const graded = gradeContracts(state);
      const failedVerdicts = [...graded.values()].filter((grade) => grade === "fail");
      const succeeded = synthesis.branches.filter((branch) => branch.status === "succeeded");

      const verdict: OverallState["verdict"] =
        synthesis.branches.length > 0 && synthesis.failed.length === 0 && failedVerdicts.length === 0
          ? "success"
          : succeeded.length > 0
            ? "partial"
            : "failed";

      const summary = {
        runId: state.runId,
        verdict,
        branches: synthesis.branches,
        failed: synthesis.failed,
        winner: synthesis.winner,
        evaluations: [...graded.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([contractId, grade]) => ({ contractId, grade })),
        ledger: ctx.ledger.totals(),
      };
      const ref = await ctx.scratch.put(ctx.runId, "payload", JSON.stringify(summary));

      return {
        update: { verdict, refs: { [RUN_SUMMARY_REF_KEY]: ref } },
        goto: { kind: "node", node: next === nodeId ? TERMINAL_ENDPOINT : next },
        output: { verdict, summary: ref },
      };
    },
  };
}

// ── Registration ────────────────────────────────────────────────────

/**
 * Register the eight root-scope implementations.
 *
 * Called ONLY from the whole-artifact composition (`../registry/index.ts`): every region
 * projection legitimately lacks these nodes, and registering one into a region would be an
 * `OrphanNodeImpl` there — exactly as fatal as a missing implementation.
 *
 * `graceful_failure` and `supervisor` are root-scope too and are NOT here: every region
 * keeps both, so they are registered by the region builder and, for the whole graph, once
 * by the composition root.
 */
export function registerRootNodes(registry: NodeRegistry, spec: TopologySpec): void {
  registry.register(evalEntryGate(spec));
  registry.register(evaluateGlobalNode(spec));
  registry.register(evalRouterNode(spec));
  registry.register(critiqueNode(spec));
  registry.register(reworkRouterNode(spec));
  registry.register(synthesizeNode(spec));
  registry.register(contextCompactNode(spec));
  registry.register(finalizeNode(spec));
}

/** The failure terminal every root router degrades to, re-exported for the composition root. */
export const ROOT_FAILURE_TERMINAL = GRACEFUL_FAILURE_NODE_ID;
