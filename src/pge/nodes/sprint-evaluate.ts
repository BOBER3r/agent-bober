import { z } from "zod";

import type { SprintContract } from "../../contracts/sprint-contract.js";
import type { TopologySpec } from "../../contracts/topology.js";
import type { EvaluationRunResult } from "../../evaluators/registry.js";
import type { GraphMessage, LedgerEntry, OverallState, SprintVerdict } from "../state/overall.js";
import { SprintVerdictSchema } from "../state/overall.js";
import type { NodeContext, NodeImpl } from "../registry/nodes.js";
import {
  anchorsFrom,
  describeAnchorTrade,
  detectAnchorTrade,
  encodeAnchorRegression,
} from "./anchors.js";
import { EFFECTS, EvaluationRunResultSchema } from "./effects.js";
import type { GeneratorResultSchema, SecurityAuditResponse } from "./effects.js";
import { nodeSpecOf, portOf, resolveContract, soleSuccessor } from "./gates.js";
import { buildCorrection } from "./sprint-correct.js";
import type { CorrectionPayload } from "./sprint-correct.js";
import { generatorResultRefKey, sprintHandoff } from "./sprint-generate.js";
import {
  commandFor,
  describeSandboxOutcome,
  sandboxCorrectionSource,
  selectVerification,
  selectiveVerificationSettings,
  sprintSandboxPolicy,
  verificationPassed,
} from "./verification.js";
import type { SelectiveVerificationDecision, SprintRuntime } from "./verification.js";

/**
 * The security node and the terminal evaluator.
 *
 * ── An evaluator that fails may never look like one that passed (sc-12-6) ──
 *
 * Two distinct failures, one route. `runEvaluatorAgent` can THROW (a provider error, a
 * budget refusal, a missing contract — it throws by name at `evaluator-agent.ts:53`) and it
 * can RETURN something that is not an `EvaluationRunResult` (a plugin that resolved to
 * `undefined`, a stub that answered with prose). Both are caught here, both are parsed here,
 * and both route to `sprint_correct` — never to `gate_anchor_regression` with a synthesised
 * pass, and never to the `pass` label.
 *
 * `failClosed: true` is recorded on a span this body opens ITSELF. The interpreter sets that
 * flag only on the approval-block path (`interpreter.ts:1156,1170`), and the node-facing
 * `SpanHandle` on `NodeContext` cannot carry it at all (`registry/nodes.ts:86` versus
 * `runtime/trace.ts:131`) — which is why {@link SprintRuntime} threads the RUNTIME trace
 * writer in. Recording it matters because a fail-closed evaluation is the one failure mode
 * that would otherwise be indistinguishable, in the trace, from a sprint that simply needed
 * another iteration.
 *
 * ── Selective verification is a decision, not a skipped node (sc-12-8) ──
 *
 * The artifact declares no "expensive suite" node; `sprint_evaluate` is the only node that
 * runs the project's test command. So the ORDER inside this body is load-bearing: the agent
 * evaluation runs first and produces the intermediate quality score, and only then does
 * {@link selectVerification} decide whether the suite is worth the sandbox invocation. The
 * criterion is observed by counting invocations, which is why the runner is injected.
 *
 * ── Why the security node comes BEFORE the evaluator ──
 *
 * That is the artifact's edge order (`e-sprint-security`, `e-sprint-evaluate`), so the
 * security gate is asked about a sprint that has no evaluation yet. `evaluateSecurityGate`
 * takes one, so the node synthesises the minimum shape from the generator's own result and
 * says so here rather than pretending an evaluation happened. Nothing about the gate's
 * fail-closed decision is re-derived (nonGoal 6): `blocked` and `reason` are read off it.
 */

export const SPRINT_EVALUATE_NODE_IDS = {
  security: "sprint_security",
  evaluate: "sprint_evaluate",
} as const;

/** The error class a fail-closed evaluation records on its own span. */
export const EVALUATOR_FAIL_CLOSED_ERROR_CLASS = "EvaluatorFailClosed";

/** The error class a blocked security audit records. */
export const SECURITY_BLOCKED_ERROR_CLASS = "SecurityGateBlocked";

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

/** How many verdicts this branch has already recorded — the iteration number. */
export function iterationOf(state: Readonly<OverallState>, contractId: string): number {
  return state.evaluations.filter((entry) => entry.contractId === contractId).length + 1;
}

/** A `SprintVerdict` for this branch, with an identity the `appendById` reducer can union. */
export function sprintVerdict(args: {
  ctx: NodeContext;
  contract: SprintContract;
  iteration: number;
  verdict: SprintVerdict["verdict"];
  summary: string;
  evalId?: string | null;
}): SprintVerdict {
  return SprintVerdictSchema.parse({
    id: `${args.contract.contractId}:${args.ctx.nodeId}:${String(args.iteration)}`,
    seq: args.ctx.superstep,
    contractId: args.contract.contractId,
    sprintNumber: args.contract.sprintNumber,
    iteration: args.iteration,
    verdict: args.verdict,
    summary: args.summary,
    evalId: args.evalId ?? null,
  });
}

/** The generator result this branch offloaded, or `null`. */
async function readGeneratorResult(
  state: Readonly<OverallState>,
  ctx: NodeContext,
  contractId: string,
): Promise<z.infer<typeof GeneratorResultSchema> | null> {
  const ref = state.refs[generatorResultRefKey(contractId)];
  if (ref === undefined) return null;
  try {
    const parsed = z
      .object({
        success: z.boolean(),
        notes: z.string(),
        filesChanged: z.array(z.string()),
      })
      .passthrough()
      .safeParse(JSON.parse(await ctx.scratch.text(ref)));
    return parsed.success ? (parsed.data as z.infer<typeof GeneratorResultSchema>) : null;
  } catch {
    return null;
  }
}

/**
 * The minimum `EvaluationRunResult` the security gate can be asked about.
 *
 * Named `provisional` rather than `evaluation` because it is not one: the security node runs
 * BEFORE the evaluator in the artifact's own edge order, so there is nothing to report yet.
 * What it carries is the generator's own claim, which is what a pre-evaluation audit has.
 */
export function provisionalEvaluation(
  ctx: NodeContext,
  generated: { success: boolean; notes: string } | null,
): EvaluationRunResult {
  return {
    passed: generated?.success ?? false,
    score: 0,
    results: [],
    summary: generated?.notes ?? "no generator result was recorded for this branch",
    timestamp: ctx.clock.nowIso(),
  };
}

// ── sprint_security ─────────────────────────────────────────────────

/**
 * The fail-closed security audit, wired in and not reimplemented (nonGoal 6).
 *
 * A blocked audit routes to `sprint_correct` — the corrector is in the same subgraph, which
 * is what makes the hop legal (`interpreter.ts:604-618`) — carrying the gate's own reason.
 * A clean or disabled audit continues to the evaluator along the artifact's declared edge.
 */
export function sprintSecurityNode(spec: TopologySpec): NodeImpl<unknown, unknown> {
  const nodeId = SPRINT_EVALUATE_NODE_IDS.security;
  const node = nodeSpecOf(spec, nodeId);
  const next = soleSuccessor(spec, nodeId);
  const corrector = "sprint_correct";

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
      const generated = await readGeneratorResult(state, ctx, contract.contractId);
      const iteration = iterationOf(state, contract.contractId);

      const verdictOut = (await ctx.effects.invoke(
        EFFECTS.securityAudit,
        {
          contract,
          evaluation: provisionalEvaluation(ctx, generated),
          projectRoot: ctx.projectRoot,
        },
        ctx,
      )) as SecurityAuditResponse;

      const summary = `security: ${verdictOut.reason} (${String(verdictOut.findings)} critical finding(s))`;
      const evaluations = [
        sprintVerdict({
          ctx,
          contract,
          iteration,
          verdict: verdictOut.blocked ? "fail" : "skipped",
          summary,
        }),
      ];

      if (!verdictOut.blocked) {
        return {
          update: { messages: [note(ctx, summary)], evaluations, ledger: [charge(ctx)] },
          phase: "evaluating",
          goto: { kind: "node", node: next },
          output: input,
        };
      }

      return {
        update: { messages: [note(ctx, summary)], evaluations, ledger: [charge(ctx)] },
        goto: { kind: "node", node: corrector },
        output: await buildCorrection(ctx, {
          source: "security",
          contractId: contract.contractId,
          critique: `the fail-closed security gate blocked this iteration (${verdictOut.reason}). Resolve the critical finding(s) before regenerating.`,
        }),
      };
    },
  };
}

// ── sprint_evaluate ─────────────────────────────────────────────────

export interface SprintEvaluateOptions {
  spec: TopologySpec;
  runtime: SprintRuntime;
}

/**
 * Evaluate the sprint, record its anchors, and emit the verdict (sc-12-5, sc-12-6, sc-12-8,
 * sc-12-10).
 */
export function sprintEvaluateNode(options: SprintEvaluateOptions): NodeImpl<unknown, unknown> {
  const { spec, runtime } = options;
  const nodeId = SPRINT_EVALUATE_NODE_IDS.evaluate;
  const node = nodeSpecOf(spec, nodeId);
  const next = soleSuccessor(spec, nodeId);
  const corrector = "sprint_correct";

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
      const generated = await readGeneratorResult(state, ctx, contract.contractId);

      // ── 1. The evaluation itself, guarded on BOTH failure modes ──
      const evaluation = await evaluateGuarded(runtime, ctx, state, contract, generated);
      if (evaluation.kind === "failed") {
        return {
          update: {
            messages: [note(ctx, evaluation.critique)],
            evaluations: [
              sprintVerdict({
                ctx,
                contract,
                iteration,
                verdict: "fail",
                summary: evaluation.critique,
              }),
            ],
            ledger: [charge(ctx)],
          },
          goto: { kind: "node", node: corrector },
          output: await buildCorrection(ctx, {
            source: "evaluator",
            contractId: contract.contractId,
            critique: evaluation.critique,
          }),
        };
      }

      const result = evaluation.result;

      // ── 2. Selective verification, decided on the INTERMEDIATE score ──
      const settings = selectiveVerificationSettings(ctx.config);
      const decision = selectVerification({
        changedFiles: generated?.filesChanged ?? [],
        qualityScore: result.score,
        highRiskPaths: settings.highRiskPaths,
        threshold: settings.threshold,
      });

      const suite = await runSelectedSuite(runtime, ctx, decision);
      if (suite !== null && suite.correction !== null) {
        return {
          update: {
            messages: [note(ctx, suite.critique)],
            evaluations: [
              sprintVerdict({ ctx, contract, iteration, verdict: "fail", summary: suite.critique }),
            ],
            ledger: [charge(ctx)],
          },
          goto: { kind: "node", node: corrector },
          output: suite.correction,
        };
      }

      // ── 3. Anchors: what this iteration was green on, and what it traded ──
      const trade = detectAnchorTrade(state.testAnchors, result);
      const green = anchorsFrom(result);
      const passed = result.passed && !trade.regressed && (suite?.passed ?? true);
      const summary = trade.regressed
        ? encodeAnchorRegression(trade.broken, describeAnchorTrade(trade))
        : `${result.summary} [${decision.reason}]`;

      return {
        update: {
          messages: [
            note(
              ctx,
              `evaluated ${contract.contractId} iteration ${String(iteration)}: passed=${String(passed)}, score=${String(result.score)}, suite=${decision.reason}`,
            ),
          ],
          evaluations: [
            sprintVerdict({
              ctx,
              contract,
              iteration,
              verdict: passed ? "pass" : "fail",
              summary,
            }),
          ],
          // `setUnion`, so concurrent branches cannot lose an anchor and a replayed
          // superstep cannot duplicate one.
          testAnchors: green,
          ledger: [charge(ctx)],
        },
        phase: "evaluating",
        goto: { kind: "node", node: next },
        output: sprintVerdict({
          ctx,
          contract,
          iteration,
          verdict: passed ? "pass" : "fail",
          summary,
        }),
      };
    },
  };
}

// ── The two evaluator failure modes ─────────────────────────────────

type GuardedEvaluation =
  | { kind: "ok"; result: EvaluationRunResult }
  | { kind: "failed"; critique: string };

/**
 * Call the evaluator, and refuse to be fooled by either way it can fail.
 *
 * The child span is opened here rather than left to the interpreter because the interpreter
 * records `failClosed` on one path only, and it is not this one. `SpanHandle.end` is
 * synchronous and the writer serialises its own queue, so this cannot reorder the run.
 */
async function evaluateGuarded(
  runtime: SprintRuntime,
  ctx: NodeContext,
  state: Readonly<OverallState>,
  contract: SprintContract,
  generated: { filesChanged: string[] } | null,
): Promise<GuardedEvaluation> {
  const handoff = sprintHandoff({
    ctx,
    state,
    contract,
    correction: null,
    changedFiles: generated?.filesChanged ?? [],
  });

  let raw: unknown;
  try {
    raw = await ctx.effects.invoke(
      EFFECTS.evaluatorSprint,
      { handoff, projectRoot: ctx.projectRoot },
      ctx,
    );
  } catch (error) {
    return {
      kind: "failed",
      critique: failClosed(
        runtime,
        ctx,
        `the evaluator threw ${error instanceof Error ? error.name : typeof error}: ${error instanceof Error ? error.message : String(error)}`,
      ),
    };
  }

  const parsed = EvaluationRunResultSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      kind: "failed",
      critique: failClosed(
        runtime,
        ctx,
        `the evaluator returned output that is not an EvaluationRunResult: ${parsed.error.issues
          .slice(0, 4)
          .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
          .join("; ")}`,
      ),
    };
  }
  return { kind: "ok", result: parsed.data as EvaluationRunResult };
}

/**
 * Record the fail-closed span and return the critique unchanged, for readability.
 *
 * Written through {@link SprintRuntime.trace} — the RUNTIME writer — rather than through
 * `ctx.trace`, because `failClosed` is a field of `SpanEnd` (`runtime/trace.ts:131`) and the
 * narrowed `SpanHandle` a node body is handed accepts only `{ status, errorClass }`
 * (`registry/nodes.ts:86`). Same file, same run, same JSONL: `RunContext.trace` IS this
 * writer, and the node-facing type is a subset of it (`trace.ts:213` proves the direction).
 */
function failClosed(runtime: SprintRuntime, ctx: NodeContext, critique: string): string {
  runtime.trace
    .begin({
      nodeId: ctx.nodeId,
      kind: "llm",
      phase: "evaluating",
      branchKey: ctx.branchKey,
      superstep: ctx.superstep,
    })
    .end({ status: "failed", failClosed: true, errorClass: EVALUATOR_FAIL_CLOSED_ERROR_CLASS });
  return critique;
}

// ── The expensive suite ─────────────────────────────────────────────

interface SuiteOutcome {
  readonly passed: boolean;
  readonly critique: string;
  readonly correction: CorrectionPayload | null;
}

/**
 * Run the expensive suite when {@link selectVerification} says it is earned, and never
 * otherwise.
 *
 * Returns `null` when the suite was skipped, which is a different answer from "it ran and
 * passed": a caller that conflated them would let a skipped suite count as evidence.
 */
async function runSelectedSuite(
  runtime: SprintRuntime,
  ctx: NodeContext,
  decision: SelectiveVerificationDecision,
): Promise<SuiteOutcome | null> {
  if (!decision.runExpensive) return null;
  const command = commandFor(ctx.config, "unit-test");
  if (command === null) return null;

  const policy = sprintSandboxPolicy(ctx.config, ctx.projectRoot);
  const outcome = await runtime.sandbox.run(command.cmd, command.args, policy, runtime.scratch, {
    nodeId: ctx.nodeId,
    kind: "llm",
    phase: "evaluating",
    branchKey: ctx.branchKey,
    superstep: ctx.superstep,
  });

  if (verificationPassed(outcome)) {
    return { passed: true, critique: describeSandboxOutcome(command, outcome), correction: null };
  }

  const critique = describeSandboxOutcome(command, outcome);
  const source = sandboxCorrectionSource(outcome) ?? "evaluator";
  return {
    passed: false,
    critique,
    correction: await buildCorrection(ctx, {
      source,
      critique,
      ...(outcome.status === "ok" ? { stderrRef: outcome.stderrRef } : {}),
    }),
  };
}
