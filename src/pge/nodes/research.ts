import { z } from "zod";

import {
  FeatureRequestSchema,
  ProblemReflectionSchema,
  ResearchDigestSchema,
  parseWithIssues,
  totalSchema,
} from "../../contracts/problem-reflection.js";
import type { FeatureRequest, ResearchDigest } from "../../contracts/problem-reflection.js";
import { ScratchRefSchema } from "../state/overall.js";
import type { GraphMessage, LedgerEntry, OverallState, ScratchRef } from "../state/overall.js";
import { HISTORY_EVENT, emitPhaseEvent } from "../runtime/history.js";
import { loopCounterKey } from "../runtime/interpreter.js";
import type { NodeContext, NodeImpl, NodeRegistry } from "../registry/nodes.js";
import { EFFECTS } from "./effects.js";
import type { CritiqueResponse } from "./effects.js";
import {
  NodeRefusalSchema,
  loopBoundOf,
  nodeSpecOf,
  portOf,
  refuse,
  schemaGate,
  soleSuccessor,
} from "./gates.js";
import type { NodeRefusal } from "./gates.js";
import type { ModelTier, TopologySpec } from "../../contracts/topology.js";

/**
 * The research region's node bodies: reflect, explore, critique, route, collect, plus the
 * two boundary gates.
 *
 * ── Every body is a THIN ADAPTER ──
 *
 * `research_explore` reaches the shipped `runResearch` and nothing else: it folds the
 * prior round's critique into the prompt it passes and returns what came back. The agent
 * is not modified, not wrapped in a subclass and not re-implemented — it is the same
 * function `src/orchestrator/pipeline.ts` calls, so moving research onto the graph changes
 * WHERE it runs and not WHAT it produces (sc-11-8). Every outward call goes through
 * `ctx.effects.invoke`, so the `effects: []` the artifact declares on each `llm` node
 * stays a meaningful claim rather than a comment.
 *
 * ── The reflexion loop, and where the critique lives ──
 *
 * The claim the loop makes is that each re-entry of the explorer is INFORMED by the
 * previous round's critique. The interpreter hands a successor exactly the predecessor's
 * `output` (`interpreter.ts:1462`), and the explorer's declared input is one port —
 * `digest: ResearchDigest` — so the critique has to live inside the digest or it is not in
 * the explorer's input at all. `ResearchDigestSchema.critique` is that field, and it is
 * `null` only on the first round.
 *
 * `research_route` declares `outputPorts: []` and therefore binds `outputPort: null`
 * (anything else is `NodeImplPortMismatch`), but it still RETURNS an output: the binding
 * is what `compile()` checks, and the returned value is what the interpreter forwards.
 * Getting that backwards silently breaks the loop, because the explorer would be re-entered
 * with `undefined`.
 *
 * ── Why the router selects "done" at the bound itself ──
 *
 * The interpreter enforces every declared bound unconditionally: at `maxIterations` it
 * REDIRECTS a node still heading round the cycle to `loop.onExhausted`, and records a
 * `failed` span plus a `TaskFailure` when it has to (`interpreter.ts:1010-1029`). A router
 * that already routes to `onExhausted` is left alone (`interpreter.ts:1001-1008`). So a
 * router that keeps saying "retry" forever produces a correct destination and a spurious
 * failure that downgrades the run's verdict. This one reads the same committed counter the
 * interpreter reads and leaves the cycle on its own — the belt is the interpreter's, and
 * the braces are here.
 */

// ── Scratch keys ────────────────────────────────────────────────────

/**
 * The `refs` key the consolidated research digest is offloaded under.
 *
 * A digest carrying real findings is far larger than the 4096-byte inline budget every
 * channel in the artifact declares, so it travels as a `ScratchRef` (ADR-4) — which is why
 * `research_collect` declares `writes: ["refs"]`. A stable key rather than a content hash,
 * because `appendById` unions a record by key and the CURRENT digest is what a later phase
 * wants, not every digest the run ever produced.
 */
export const RESEARCH_DIGEST_REF_KEY = "research-digest";

/** The `refs` key the explorer's raw findings blob is offloaded under. */
export const RESEARCH_FINDINGS_REF_KEY = "research-findings";

/**
 * The digest a later phase works from: the one handed over, or the one on disk.
 *
 * Returns `null` when neither exists, so a caller decides what an absent brief means
 * rather than being handed a fabricated one.
 */
export async function resolveResearchDigest(
  state: Readonly<OverallState>,
  ctx: NodeContext,
): Promise<ResearchDigest | null> {
  const ref = state.refs[RESEARCH_DIGEST_REF_KEY];
  if (ref === undefined) return null;
  const text = await ctx.scratch.text(ScratchRefSchema.parse(ref));
  const parsed = ResearchDigestSchema.safeParse(JSON.parse(text) as unknown);
  return parsed.success ? parsed.data : null;
}

// ── Node ids ────────────────────────────────────────────────────────

export const RESEARCH_NODE_IDS = {
  body: "research_body",
  entryGate: "gate_research_in",
  reflect: "research_reflect",
  explore: "research_explore",
  critique: "research_critique",
  route: "research_route",
  collect: "research_collect",
  exitGate: "gate_research_out",
} as const;

/** The check `research_reflect` applies. Not a `gate.check` — it is an `llm` node. */
export const REFLECTION_CHECK = "problem-reflection-structured";

// ── Small helpers ───────────────────────────────────────────────────

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
 * One charged model call, recorded on both the ledger COLLABORATOR and the ledger CHANNEL.
 *
 * The collaborator is what a budget guard reads during the run; the channel is what
 * survives into committed state. `mergeLedger` replaces by `(nodeId, attempt, callIndex)`,
 * so a replayed superstep re-charges the same call without double-counting. Token counts
 * are zero because neither shipped agent reports usage — an invented number would be worse
 * than an honest one.
 */
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

/** The prompt the artifact's `promptRef` names, and the model its `modelTier` binds to. */
function bindings(spec: TopologySpec, nodeId: string): { promptRef: string; tier: ModelTier } {
  const node = nodeSpecOf(spec, nodeId);
  if (node.kind !== "llm") throw new Error(`Node "${nodeId}" is not an llm node.`);
  // `promptRef` is optional on the node schema, so an `llm` node without one is an
  // artifact defect rather than a shape this module may guess its way past.
  if (node.promptRef === undefined) {
    throw new Error(`Node "${nodeId}" is an llm node but declares no promptRef.`);
  }
  return { promptRef: node.promptRef, tier: node.modelTier ?? spec.defaults.modelTier };
}

// ── research_body ───────────────────────────────────────────────────

/**
 * The graph entry: the feature request, UNVALIDATED.
 *
 * Its output schema is `z.unknown()` on purpose. `gate_research_in` exists to fail closed
 * when no feature request is present (`coding.graph.ts:210`), and a call site that
 * validated the request first would make that gate unreachable — the entry would throw
 * before the gate could refuse, and the artifact's declared failure route would be dead.
 * The gate is the validator; this node is the door.
 *
 * ── The run's first history event (sc-4-1, event 1 of 10) ──
 *
 * This is the graph's entry node, so it is where `pipeline-start` belongs: the imperative
 * engine writes it before anything else in `runTsPipeline` (`pipeline.ts:798`), and this
 * node runs before anything else in a graph run for the identical reason.
 */
export function researchBodyNode(spec: TopologySpec): NodeImpl<unknown, unknown> {
  const node = nodeSpecOf(spec, RESEARCH_NODE_IDS.body);
  const next = soleSuccessor(spec, RESEARCH_NODE_IDS.body);
  return {
    id: RESEARCH_NODE_IDS.body,
    kind: "subgraph",
    inputPort: portOf(node, "input"),
    outputPort: portOf(node, "output"),
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    handler: async (_input, state, ctx) => {
      await emitPhaseEvent(ctx, {
        event: HISTORY_EVENT.PIPELINE_START,
        phase: "init",
        details: { userPrompt: state.featureRequest.slice(0, 200) },
      });
      return {
        goto: { kind: "node", node: next },
        output: { featureRequest: state.featureRequest, projectRoot: ctx.projectRoot },
      };
    },
  };
}

// ── gate_research_in ────────────────────────────────────────────────

export function researchEntryGate(spec: TopologySpec): NodeImpl<unknown, unknown> {
  return schemaGate({
    spec,
    nodeId: RESEARCH_NODE_IDS.entryGate,
    admitted: FeatureRequestSchema,
  });
}

// ── research_reflect ────────────────────────────────────────────────

/**
 * Turn the feature request into a STRUCTURED problem reflection.
 *
 * The shipped researcher emits prose; prose cannot be checked, so a researcher that
 * answered a different question than the one asked is indistinguishable from one that
 * answered it. This node demands {@link ProblemReflectionSchema} — an explicit goal and
 * non-empty inputs, outputs, rules and constraints — and a prose-only emission is REFUSED
 * with the failing Zod path named (sc-11-1).
 *
 * The refusal leaves the subgraph with `{ kind: "parent" }`: this node is inside the
 * `research` region and the failure terminal is at the root, so the supervisor completes
 * the hop, exactly as it does for a research boundary gate.
 */
export function researchReflectNode(
  spec: TopologySpec,
): NodeImpl<FeatureRequest, ResearchDigest | NodeRefusal> {
  const nodeId = RESEARCH_NODE_IDS.reflect;
  const node = nodeSpecOf(spec, nodeId);
  const next = soleSuccessor(spec, nodeId);
  const { promptRef, tier } = bindings(spec, nodeId);

  return {
    id: nodeId,
    kind: "llm",
    inputPort: portOf(node, "input"),
    outputPort: portOf(node, "output"),
    inputSchema: totalSchema(FeatureRequestSchema),
    outputSchema: totalSchema(z.union([ResearchDigestSchema, NodeRefusalSchema])),
    handler: async (input, _state, ctx) => {
      const emitted = await ctx.effects.invoke(
        EFFECTS.researchReflect,
        {
          featureRequest: input.featureRequest,
          projectRoot: input.projectRoot,
          promptRef,
          model: ctx.models.bind(tier).modelId,
        },
        ctx,
      );

      const reflection = parseWithIssues(ProblemReflectionSchema, emitted);
      if (!reflection.ok) {
        return {
          goto: { kind: "parent" },
          output: refuse(ctx, {
            check: REFLECTION_CHECK,
            // `llm` nodes declare no `gate` block, so the endpoint is the region's own:
            // control leaves through the supervisor, which routes to the terminal.
            onFail: spec.defaults.supervisorNodeId,
            issues: reflection.issues,
          }),
        };
      }

      const digest: ResearchDigest = {
        researchId: `research-${ctx.runId}`,
        timestamp: ctx.clock.nowIso(),
        reflection: reflection.value,
        questions: [],
        findings: "",
        sections: {
          architectureOverview: "",
          existingPatterns: "",
          keyFiles: "",
          integrationPoints: "",
          testCoverage: "",
          riskAreas: "",
        },
        filesExplored: [],
        questionsAnswered: 0,
        critique: null,
        reflexionRound: 0,
        documentId: null,
      };

      return {
        update: {
          messages: [note(ctx, `reflected: ${reflection.value.goal}`)],
          ledger: [charge(ctx)],
        },
        goto: { kind: "node", node: next },
        output: digest,
      };
    },
  };
}

// ── research_explore ────────────────────────────────────────────────

/**
 * Answer the reflexion questions against the real codebase, through `runResearch`.
 *
 * The prior round's critique is folded into the PROMPT rather than passed as an argument:
 * `runResearch(userPrompt, projectRoot, config)` takes three parameters, and adding a
 * fourth would modify a shipped agent (nonGoal #2). The critique is also carried on the
 * effect request so a test can assert which critique the explorer was re-entered with
 * without matching substrings.
 */
export function researchExploreNode(spec: TopologySpec): NodeImpl<ResearchDigest, ResearchDigest> {
  const nodeId = RESEARCH_NODE_IDS.explore;
  const node = nodeSpecOf(spec, nodeId);
  const next = soleSuccessor(spec, nodeId);

  return {
    id: nodeId,
    kind: "llm",
    inputPort: portOf(node, "input"),
    outputPort: portOf(node, "output"),
    inputSchema: totalSchema(ResearchDigestSchema),
    outputSchema: totalSchema(ResearchDigestSchema),
    handler: async (input, state, ctx) => {
      const critique = input.critique;
      const userPrompt = [
        state.featureRequest,
        `Goal: ${input.reflection.goal}`,
        critique === null ? "" : `Prior critique to address:\n${critique}`,
      ]
        .filter((part) => part.length > 0)
        .join("\n\n");

      const doc = (await ctx.effects.invoke(
        EFFECTS.researchExplore,
        { userPrompt, projectRoot: ctx.projectRoot, critique, reflexionRound: input.reflexionRound },
        ctx,
      )) as {
        id: string;
        timestamp: string;
        questions: string[];
        findings: string;
        sections: ResearchDigest["sections"];
        filesExplored: string[];
        questionsAnswered: number;
      };

      const digest: ResearchDigest = {
        ...input,
        researchId: doc.id,
        timestamp: doc.timestamp,
        questions: doc.questions,
        findings: doc.findings,
        sections: doc.sections,
        filesExplored: doc.filesExplored,
        questionsAnswered: doc.questionsAnswered,
        reflexionRound: input.reflexionRound + 1,
      };

      const findingsRef = await ctx.scratch.put(ctx.runId, "document", doc.findings);

      return {
        update: {
          messages: [note(ctx, `explored round ${String(digest.reflexionRound)}: ${doc.id}`)],
          refs: { [RESEARCH_FINDINGS_REF_KEY]: findingsRef },
          ledger: [charge(ctx)],
        },
        goto: { kind: "node", node: next },
        output: digest,
      };
    },
  };
}

// ── research_critique ───────────────────────────────────────────────

/**
 * Grade the exploration. `null` ends the loop EARLY; the declared bound ends it late.
 *
 * Effect-free by declaration (`effects: []`), which is what lets the artifact give this
 * node a cache policy at all — `CacheOnEffectfulNode` refuses one on a node that writes.
 */
export function researchCritiqueNode(spec: TopologySpec): NodeImpl<ResearchDigest, ResearchDigest> {
  const nodeId = RESEARCH_NODE_IDS.critique;
  const node = nodeSpecOf(spec, nodeId);
  const next = soleSuccessor(spec, nodeId);
  const { promptRef, tier } = bindings(spec, nodeId);

  return {
    id: nodeId,
    kind: "llm",
    inputPort: portOf(node, "input"),
    outputPort: portOf(node, "output"),
    inputSchema: totalSchema(ResearchDigestSchema),
    outputSchema: totalSchema(ResearchDigestSchema),
    handler: async (input, _state, ctx) => {
      const graded = (await ctx.effects.invoke(
        EFFECTS.researchCritique,
        {
          researchId: input.researchId,
          reflection: input.reflection,
          questions: input.questions,
          findings: input.findings,
          questionsAnswered: input.questionsAnswered,
          reflexionRound: input.reflexionRound,
          promptRef,
          model: ctx.models.bind(tier).modelId,
        },
        ctx,
      )) as CritiqueResponse;

      return {
        update: {
          messages: [
            note(ctx, graded.critique === null ? "critique: accepted" : "critique: rework requested"),
          ],
          ledger: [charge(ctx)],
        },
        goto: { kind: "node", node: next },
        output: { ...input, critique: graded.critique },
      };
    },
  };
}

// ── research_route ──────────────────────────────────────────────────

/**
 * The reflexion router: another round, or collect what exists.
 *
 * Reads the committed counter the INTERPRETER maintains — `loopCounterKey` is the
 * interpreter's own key derivation, imported rather than restated — adds this execution's
 * own increment, and leaves the cycle at the declared bound. Both exits lead to the
 * artifact's `loop.onExhausted` target, which is `research_collect`, so exceeding the
 * reflexion budget collects findings instead of failing the run.
 */
export function researchRouteNode(spec: TopologySpec): NodeImpl<ResearchDigest, ResearchDigest> {
  const nodeId = RESEARCH_NODE_IDS.route;
  const node = nodeSpecOf(spec, nodeId);
  if (node.kind !== "router") throw new Error(`Node "${nodeId}" is not a router node.`);
  const bound = loopBoundOf(spec, nodeId);
  const labels = new Set(node.targets.map((target) => target.label));
  const retryLabel = "retry";
  const doneLabel = "done";
  for (const label of [retryLabel, doneLabel]) {
    if (!labels.has(label)) {
      throw new Error(`Node "${nodeId}" declares no "${label}" target in the topology artifact.`);
    }
  }

  return {
    id: nodeId,
    kind: "router",
    inputPort: portOf(node, "input"),
    outputPort: portOf(node, "output"),
    inputSchema: totalSchema(ResearchDigestSchema),
    // Declared `outputPorts: []`, so `outputPort` is null — but the value below is what
    // the interpreter forwards to whichever target the label resolves to.
    outputSchema: totalSchema(ResearchDigestSchema),
    handler: async (input, state, ctx) => {
      const key = loopCounterKey(bound.counterKey, ctx.branchKey);
      const taken = (state.counters[key] ?? 0) + 1;
      const exhausted = taken >= bound.maxIterations;
      const satisfied = input.critique === null;

      return {
        update: { counters: { [key]: taken } },
        goto: { kind: "label", label: exhausted || satisfied ? doneLabel : retryLabel },
        output: input,
      };
    },
  };
}

// ── research_collect ────────────────────────────────────────────────

/**
 * Write the research document and offload the digest.
 *
 * The document goes through the SHIPPED `saveResearch`, so the file `.bober/research/`
 * gains is byte-identical to the one the imperative pipeline writes. `documentId` comes
 * back out of the directory listing — evidence, not a computed path — and the exit gate
 * refuses a digest that reaches it without one.
 */
export function researchCollectNode(spec: TopologySpec): NodeImpl<ResearchDigest, ResearchDigest> {
  const nodeId = RESEARCH_NODE_IDS.collect;
  const node = nodeSpecOf(spec, nodeId);
  const next = soleSuccessor(spec, nodeId);

  return {
    id: nodeId,
    kind: "tool",
    inputPort: portOf(node, "input"),
    outputPort: portOf(node, "output"),
    inputSchema: totalSchema(ResearchDigestSchema),
    outputSchema: totalSchema(ResearchDigestSchema),
    handler: async (input, _state, ctx) => {
      const written = (await ctx.effects.invoke(
        EFFECTS.researchCollect,
        {
          projectRoot: ctx.projectRoot,
          doc: {
            id: input.researchId,
            timestamp: input.timestamp,
            questions: input.questions,
            findings: input.findings,
            sections: input.sections,
            filesExplored: input.filesExplored,
            questionsAnswered: input.questionsAnswered,
          },
        },
        ctx,
      )) as { researchId: string; documentId: string | null };

      const digest: ResearchDigest = { ...input, documentId: written.documentId };
      const digestRef: ScratchRef = await ctx.scratch.put(
        ctx.runId,
        "document",
        JSON.stringify(digest),
      );

      return {
        update: {
          messages: [note(ctx, `collected research ${input.researchId}`)],
          refs: { [RESEARCH_DIGEST_REF_KEY]: digestRef },
        },
        goto: { kind: "node", node: next },
        output: digest,
      };
    },
  };
}

// ── gate_research_out ───────────────────────────────────────────────

export function researchExitGate(spec: TopologySpec): NodeImpl<unknown, unknown> {
  return schemaGate({
    spec,
    nodeId: RESEARCH_NODE_IDS.exitGate,
    admitted: ResearchDigestSchema,
    // The gate's declared check, expressed against the payload because the gate declares
    // `reads: []` and therefore may consult no channel.
    precondition: (digest) =>
      digest.documentId === null
        ? [
            {
              path: "documentId",
              pathSegments: ["documentId"],
              code: "custom",
              message: "no research document was written to .bober/research/",
            },
          ]
        : [],
  });
}

// ── Registration ────────────────────────────────────────────────────

/** Register every research-region implementation into `registry`. */
export function registerResearchNodes(registry: NodeRegistry, spec: TopologySpec): void {
  registry.register(researchBodyNode(spec));
  registry.register(researchEntryGate(spec));
  registry.register(researchReflectNode(spec));
  registry.register(researchExploreNode(spec));
  registry.register(researchCritiqueNode(spec));
  registry.register(researchRouteNode(spec));
  registry.register(researchCollectNode(spec));
  registry.register(researchExitGate(spec));
}
