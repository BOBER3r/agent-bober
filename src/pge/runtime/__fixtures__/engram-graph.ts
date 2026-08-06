import { z } from "zod";

import type { BoberConfig } from "../../../config/schema.js";
import { createDefaultConfig } from "../../../config/schema.js";
import { TopologySpecSchema } from "../../../contracts/topology.js";
import type { NodeSpec, TopologySpec } from "../../../contracts/topology.js";
import { Scheduler } from "../../../orchestrator/workflow/scheduler.js";
import type { LLMClient } from "../../../providers/types.js";
import { compile } from "../../compile/compiler.js";
import type { CompiledGraph, Registries } from "../../compile/compiler.js";
import { createEffectRegistry } from "../../registry/effects.js";
import { createModelBinder, createNodeRegistry } from "../../registry/nodes.js";
import type { NodeContext, NodeImpl, NodeRegistry } from "../../registry/nodes.js";
import { createReducerRegistry } from "../../registry/reducers.js";
import { initialOverallState } from "../../state/overall.js";
import type { GraphMessage, OverallState } from "../../state/overall.js";
import { checksumTopology } from "../../topology/canonical.js";
import { createArchiveWriter } from "../archive.js";
import { createSemanticCache } from "../cache.js";
import { createCommitBoundary } from "../commit.js";
import { compactGraphContext, decideCompaction } from "../compactor.js";
import type { CompactionDecision, GraphCompactionOutcome } from "../compactor.js";
import { readDigest } from "../digest.js";
import { createFrontierPlanner } from "../frontier.js";
import { assembleSuccessorPrompt } from "../handoff.js";
import type { AssembledPrompt } from "../handoff.js";
import { createGraphInterpreter } from "../interpreter.js";
import type { GraphRunResult, RunContext } from "../interpreter.js";
import { createBudgetLedger } from "../ledger.js";
import { createScratchStore } from "../scratch.js";
import { estimateMessages } from "../token-estimator.js";
import type { TokenEstimator } from "../token-estimator.js";
import { createTraceWriter, readSpans } from "../trace.js";
import type { Span, TraceWriter } from "../trace.js";
import { GOLDEN_SCHEMA_MODULES, goldenSchemaCatalog } from "./golden-graph.js";
import { countingNodeRegistry, createMonotonicClock } from "./run-harness.js";
import type { HandlerCallLog } from "./run-harness.js";

/**
 * The Engram fixture: produce a transcript, decide at a superstep boundary whether it
 * needs compacting, then hand a successor a context built from the phase digest.
 *
 *   producer -> supervisor --(compact)--> context_compact -> successor -> END
 *                          \-(handoff)------------------->  successor -> END
 *                          \-(abandon)-> abandoned -> END        [never selected]
 *
 * Deliberately NOT the golden graph, and for the reason `hitl-graph.ts` records for
 * sprint 8: the golden topology is pinned by the determinism, exactly-once and barrier
 * suites down to span counts, so bolting a compaction region onto it would turn every one
 * of those assertions into a statement about THIS sprint's fixture.
 *
 * ── Why the compaction region is a line and not the shipped cycle ──
 *
 * The shipped artifact routes `supervisor -> context_compact -> supervisor`, re-entering
 * the supervisor. This fixture routes `context_compact -> successor` instead, so no node
 * is entered twice. That is not a simplification for its own sake: `ArchiveHandle.seal()`
 * makes a directory permanently refuse writes, and the interpreter opens a FRESH lazy
 * handle per task and never seals for you, so a node that archives-and-seals on its first
 * visit throws `ArchiveImmutableError` on its second. Every node body here seals, because
 * sc-10-9 needs sealed archives to compare; a cycle would therefore need a
 * seal-only-on-the-last-visit rule, which is a property of the node body rather than of
 * the compaction boundary this fixture exists to exercise. The cycle's own behaviour is
 * sprints 11–12's problem, when real node bodies land under `src/pge/nodes/`.
 *
 * ── `abandoned` is the negative control for sc-10-9 ──
 *
 * It is a fully declared node with a declared router target and a declared conditional
 * edge into it, and the supervisor never selects its label. So it appears in the
 * topology's node set and never in the trace's executed set, which is exactly the
 * difference sc-10-9's assertion has to be sensitive to.
 *
 * ── `messages.maxInlineBytes` is large ON PURPOSE ──
 *
 * The commit boundary sizes a channel update by serialising the WHOLE value it carries,
 * so a single `Command.update` bearing eighty-six messages is one large value, not
 * eighty-six small ones. The shipped graph's 4096 would refuse it as `StateBloatError`
 * before any compaction logic ran, and the run would degrade for a reason that has
 * nothing to do with compaction. The cap under test here is the CONTEXT cap
 * ({@link EngramBehaviour.cap}), which is a token budget, not a serialisation limit.
 */

// ── Ids ─────────────────────────────────────────────────────────────

export const ENGRAM_GRAPH_ID = "engram-fixture";

export const ENGRAM_NODES = {
  producer: "producer",
  supervisor: "supervisor",
  compact: "context_compact",
  successor: "successor",
  abandoned: "abandoned",
} as const;

const N = ENGRAM_NODES;

/** The three labels the supervisor may emit. `abandon` is never selected by any run here. */
export const ENGRAM_LABELS = {
  compact: "compact",
  handoff: "handoff",
  abandon: "abandon",
} as const;

/** Chars per fixture message. 400 chars is exactly 100 tokens under the chars/4 default. */
export const ENGRAM_MESSAGE_CHARS = 400;

// ── Topology ────────────────────────────────────────────────────────

const ENGRAM_NODE_SPECS: NodeSpec[] = [
  {
    id: N.producer,
    kind: "llm",
    title: "Produce the transcript",
    doc: "Emits the message volume the supervisor's threshold decision is taken over. Writes only order-invariant collection channels.",
    subgraph: null,
    role: "generator",
    modelTier: "frontier",
    promptRef: "engram/produce",
    inputPorts: [],
    outputPorts: [],
    reads: ["messages"],
    writes: ["messages", "counters"],
    effects: [],
  },
  {
    id: N.supervisor,
    kind: "router",
    title: "Supervisor",
    doc: "Takes the compaction decision at a superstep boundary and routes accordingly. Reads the message window; writes nothing but its own counter.",
    subgraph: null,
    role: "router",
    modelTier: "light",
    inputPorts: [],
    outputPorts: [],
    reads: ["messages", "counters"],
    writes: ["counters"],
    effects: [],
    targets: [
      { label: ENGRAM_LABELS.compact, to: N.compact },
      { label: ENGRAM_LABELS.handoff, to: N.successor },
      { label: ENGRAM_LABELS.abandon, to: N.abandoned },
    ],
  },
  {
    id: N.compact,
    kind: "tool",
    title: "Compact the conversation context",
    doc: "Writes the pre-compression transcript to .bober/logs/ and re-injects a summary. Never removes a message from the channel; the channel is the audit record.",
    subgraph: null,
    role: "utility",
    inputPorts: [],
    outputPorts: [],
    reads: ["messages", "refs"],
    writes: ["messages", "refs", "counters"],
    effects: ["fs-write"],
    toolRef: "context.compact",
  },
  {
    id: N.successor,
    kind: "llm",
    title: "Successor",
    doc: "Launches from the phase digest plus its own declared input ports. Imports no message id from the predecessor transcript.",
    subgraph: null,
    role: "generator",
    modelTier: "frontier",
    promptRef: "engram/successor",
    inputPorts: [],
    outputPorts: [],
    reads: ["messages"],
    writes: ["messages", "counters"],
    effects: [],
  },
  {
    id: N.abandoned,
    kind: "tool",
    title: "Abandon the phase",
    doc: "Declared, reachable and never selected. The control that keeps sc-10-9's set equality from being satisfiable against the topology's declared node set.",
    subgraph: null,
    role: "utility",
    inputPorts: [],
    outputPorts: [],
    reads: ["messages"],
    writes: ["messages"],
    effects: [],
    toolRef: "run.abandon",
  },
];

const ENGRAM_UNSEALED: TopologySpec = {
  formatVersion: 1,
  graphId: ENGRAM_GRAPH_ID,
  graphVersion: "1.0.0",
  description:
    "Engram fixture: threshold-driven compaction at a superstep boundary and a digest-built successor context.",
  provenance: "authored",
  entry: N.producer,
  defaults: {
    supervisorNodeId: N.supervisor,
    modelTier: "light",
    concurrency: 1,
    durability: "superstep",
    maxInlineBytes: 4096,
  },
  channels: [
    {
      id: "messages",
      reducerRef: "appendById",
      schemaRef: "GraphMessage",
      scope: "public",
      // See the module comment: a token cap is not a serialisation cap.
      maxInlineBytes: 262144,
    },
    {
      id: "refs",
      reducerRef: "appendById",
      schemaRef: "ScratchRef",
      scope: "public",
      maxInlineBytes: 8192,
    },
    {
      id: "counters",
      reducerRef: "maxNumber",
      schemaRef: "Counters",
      scope: "public",
      maxInlineBytes: 4096,
    },
  ],
  nodes: ENGRAM_NODE_SPECS,
  edges: [
    { id: "e-producer-supervisor", from: N.producer, to: N.supervisor, kind: "normal" },
    {
      id: "e-supervisor-compact",
      from: N.supervisor,
      to: N.compact,
      kind: "conditional",
      label: ENGRAM_LABELS.compact,
    },
    {
      id: "e-supervisor-handoff",
      from: N.supervisor,
      to: N.successor,
      kind: "conditional",
      label: ENGRAM_LABELS.handoff,
    },
    {
      id: "e-supervisor-abandon",
      from: N.supervisor,
      to: N.abandoned,
      kind: "conditional",
      label: ENGRAM_LABELS.abandon,
    },
    { id: "e-compact-successor", from: N.compact, to: N.successor, kind: "normal" },
    { id: "e-successor-end", from: N.successor, to: "END", kind: "normal" },
    { id: "e-abandoned-end", from: N.abandoned, to: "END", kind: "normal" },
  ],
  checksum: `sha256:${"0".repeat(64)}`,
  subgraphs: [],
};

/**
 * A fresh, sealed copy of the Engram artifact.
 *
 * Round-tripped through `TopologySpecSchema` before it is checksummed, so a fixture that
 * stopped matching the artifact schema fails HERE rather than somewhere downstream that
 * happens to notice.
 */
export function engramSpec(): TopologySpec {
  const clone = TopologySpecSchema.parse(JSON.parse(JSON.stringify(ENGRAM_UNSEALED)) as unknown);
  return { ...clone, checksum: checksumTopology(clone) };
}

// ── Behaviour ───────────────────────────────────────────────────────

export interface EngramBehaviour {
  /** How many messages the producer emits. 84 or 86 for the boundary pair at cap 10 000. */
  readonly messageCount: number;
  /** Chars per message. Default {@link ENGRAM_MESSAGE_CHARS}. */
  readonly messageChars?: number;
  /** The model's maximum input capacity, in the estimator's tokens. */
  readonly cap: number;
  /** The injected estimator EVERY threshold in the run flows through. */
  readonly estimator: TokenEstimator;
  /** The summariser the compaction node calls. One `chat`, no tools. */
  readonly client: LLMClient;
  readonly model?: string;
  /** Successor context ratio override. Default {@link SUCCESSOR_CONTEXT_RATIO}. */
  readonly ratio?: number;
  /** Node ids whose handler throws BEFORE it archives anything. */
  readonly failing?: readonly string[];

  // ── Recorders. Real values produced by real calls, for the assertions. ──
  readonly decisions: CompactionDecision[];
  readonly compactions: GraphCompactionOutcome[];
  readonly prompts: AssembledPrompt[];
  /** Node ids that reached the FIRST line of their handler body, in order. */
  readonly entered: string[];
}

/** A fresh recorder set, so a test never has to build the four arrays by hand. */
export function engramBehaviour(
  base: Omit<EngramBehaviour, "decisions" | "compactions" | "prompts" | "entered">,
): EngramBehaviour {
  return { ...base, decisions: [], compactions: [], prompts: [], entered: [] };
}

function fixtureMessage(index: number, chars: number): GraphMessage {
  // The id is embedded in the text on purpose: the successor-context assertion looks for
  // every predecessor id ANYWHERE in the assembled prompt, and a body that never carried
  // its own id would make that search weaker than it looks.
  const id = `m-pred-${String(index).padStart(3, "0")}`;
  const head = `${id}: `;
  const text = head + "x".repeat(Math.max(0, chars - head.length));
  return { id, seq: index, role: "assistant", nodeId: N.producer, text, tokens: text.length };
}

/** The message list the producer commits, exposed so a test can compute expectations. */
export function engramMessages(behaviour: EngramBehaviour): GraphMessage[] {
  const chars = behaviour.messageChars ?? ENGRAM_MESSAGE_CHARS;
  return Array.from({ length: behaviour.messageCount }, (_, i) => fixtureMessage(i, chars));
}

// ── Node bodies ─────────────────────────────────────────────────────

/** `outputHash` of the child span that carries the assembled successor prompt. */
export const ENGRAM_PROMPT_SPAN_OUTPUT_HASH = "engram:assembled-prompt";

/**
 * Every node archives; only the last visit seals, and there is only ever one visit.
 *
 * Called as the LAST thing a body does, after its work succeeded, so a node that throws
 * leaves no archive directory at all — which is what makes the failing-node control in the
 * invariant suite a real control rather than a directory with an empty stdout in it.
 */
async function archiveAndSeal(
  ctx: NodeContext,
  input: unknown,
  output: unknown,
  stdout: string,
): Promise<void> {
  await ctx.archive.writeSnapshot({ nodeId: ctx.nodeId, superstep: ctx.superstep, input });
  await ctx.archive.appendStdout(stdout);
  await ctx.archive.writeOutputs(output);
  await ctx.archive.seal();
}

function engramNodeRegistry(behaviour: EngramBehaviour, trace: TraceWriter): NodeRegistry {
  const failing = new Set(behaviour.failing ?? []);
  const registry = createNodeRegistry();
  const model = behaviour.model ?? "stub-frontier";

  const specs: Record<string, { kind: NodeImpl["kind"]; handler: NodeImpl["handler"] }> = {
    [N.producer]: {
      kind: "llm",
      handler: async (input, _state, ctx) => {
        behaviour.entered.push(N.producer);
        if (failing.has(N.producer)) throw new Error("engram fixture: producer failed");
        const messages = engramMessages(behaviour);
        const output = { produced: messages.length };
        await archiveAndSeal(ctx, input, output, `producer emitted ${String(messages.length)}\n`);
        return {
          update: { messages, counters: { produced: messages.length } },
          phase: "generating" as const,
          goto: { kind: "node", node: N.supervisor },
          output,
        };
      },
    },
    [N.supervisor]: {
      kind: "router",
      handler: async (input, state, ctx) => {
        behaviour.entered.push(N.supervisor);
        if (failing.has(N.supervisor)) throw new Error("engram fixture: supervisor failed");
        // THE decision, taken here, at a superstep boundary, over committed state — not
        // inside the producer that wrote the messages and not inside the node that will
        // act on it.
        const decision = decideCompaction(state.messages, behaviour.cap, behaviour.estimator);
        behaviour.decisions.push(decision);
        const label = decision.shouldCompact ? ENGRAM_LABELS.compact : ENGRAM_LABELS.handoff;
        const output = { label, tokens: decision.tokens, threshold: decision.threshold };
        await archiveAndSeal(ctx, input, output, `supervisor routed ${label}\n`);
        return {
          update: { counters: { supervisorRounds: 1 } },
          goto: { kind: "label", label },
          output,
        };
      },
    },
    [N.compact]: {
      kind: "tool",
      handler: async (input, state, ctx) => {
        behaviour.entered.push(N.compact);
        if (failing.has(N.compact)) throw new Error("engram fixture: compact failed");
        const outcome = await compactGraphContext({
          client: behaviour.client,
          model,
          messages: state.messages,
          cap: behaviour.cap,
          estimator: behaviour.estimator,
          projectRoot: ctx.projectRoot,
          runId: ctx.runId,
          index: 0,
        });
        behaviour.compactions.push(outcome);

        const update: Partial<OverallState> = {};
        if (outcome.kind === "compacted") {
          // The summary is a NEW message. `appendById` unions it in; the eighty-six
          // predecessor messages stay exactly where they are, because the channel is the
          // audit record and the compaction's product is the window, not the channel.
          update.messages = [outcome.summaryMessage];
          const ref = await ctx.scratch.put(ctx.runId, "document", outcome.transcriptBytes);
          update.refs = { "compaction-0-transcript": ref };
          // ABSOLUTE, never `prev + 1`: `counters` is reduced by a per-key MAXIMUM
          // precisely so a replayed superstep re-writing the same value is a no-op.
          update.counters = { contextCompactions: 1 };
        }
        const output = { compaction: outcome.kind };
        await archiveAndSeal(ctx, input, output, `compaction ${outcome.kind}\n`);
        return { update, goto: { kind: "node", node: N.successor }, output };
      },
    },
    [N.successor]: {
      kind: "llm",
      handler: async (input, state, ctx) => {
        behaviour.entered.push(N.successor);
        if (failing.has(N.successor)) throw new Error("engram fixture: successor failed");

        // FAIL CLOSED. `readDigest` throws on absent, on unreadable and on invalid, and
        // there is no branch here that reaches for `state.messages` instead.
        const digest = await readDigest(ctx.projectRoot, state.currentPhase);
        const predecessorTokens = estimateMessages(state.messages, behaviour.estimator);
        const prompt = assembleSuccessorPrompt(
          {
            digest,
            nodeId: ctx.nodeId,
            ports: [{ key: "handoff", schemaRef: "PlanSpec", value: input }],
          },
          behaviour.estimator,
          {
            predecessorTokens,
            ...(behaviour.ratio === undefined ? {} : { ratio: behaviour.ratio }),
          },
        );
        behaviour.prompts.push(prompt);

        // ── The prompt goes INTO THE TRACE, not just into a recorder ──
        //
        // `NodeContext.trace` narrows `SpanHandle.end` to `{status, errorClass}`, so a
        // node body cannot attach a `toolOutputRef` to its own span as typed. The fixture
        // therefore holds the CONCRETE `TraceWriter` and opens a child span through it —
        // the same writer the interpreter is using, the same JSONL file. A test then
        // reads the assembled prompt back out of `.bober/traces/` rather than out of the
        // recorder above, which is the difference between inspecting the actual prompt
        // and inspecting the intent to build one.
        const ref = await ctx.scratch.put(ctx.runId, "document", prompt.text);
        const child = trace.begin({
          nodeId: ctx.nodeId,
          kind: "llm",
          phase: state.currentPhase,
          branchKey: ctx.branchKey,
          parentSpanId: ctx.spanId,
          superstep: ctx.superstep,
        });
        child.end({
          status: "ok",
          outputHash: ENGRAM_PROMPT_SPAN_OUTPUT_HASH,
          toolOutputRef: ref,
          tokens: { in: prompt.tokens, out: 0 },
        });

        const output = { promptTokens: prompt.tokens, budget: prompt.budget };
        await archiveAndSeal(ctx, input, output, `successor assembled ${String(prompt.tokens)}\n`);
        return {
          update: {
            messages: [
              {
                id: "m-successor",
                seq: 100000,
                role: "assistant" as const,
                nodeId: ctx.nodeId,
                text: "successor ran from the digest",
                tokens: 29,
              },
            ],
            verdict: "success" as const,
          },
          phase: "complete" as const,
          goto: { kind: "node", node: "END" },
          output,
        };
      },
    },
    [N.abandoned]: {
      kind: "tool",
      handler: async (input, _state, ctx) => {
        behaviour.entered.push(N.abandoned);
        const output = { abandoned: true };
        await archiveAndSeal(ctx, input, output, "abandoned\n");
        return {
          update: { verdict: "failed" as const },
          phase: "failed" as const,
          goto: { kind: "node", node: "END" },
          output,
        };
      },
    },
  };

  for (const node of ENGRAM_NODE_SPECS) {
    const spec = specs[node.id];
    registry.register({
      id: node.id,
      kind: spec.kind,
      inputPort: null,
      outputPort: null,
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      handler: spec.handler,
    });
  }
  return registry;
}

export function engramRegistries(behaviour: EngramBehaviour, trace: TraceWriter): Registries {
  return {
    nodes: engramNodeRegistry(behaviour, trace),
    reducers: createReducerRegistry(),
    effects: createEffectRegistry(),
    schemas: goldenSchemaCatalog(),
    schemaModules: GOLDEN_SCHEMA_MODULES,
  };
}

export function compileEngram(
  behaviour: EngramBehaviour,
  trace: TraceWriter,
  spec: TopologySpec = engramSpec(),
): { graph: CompiledGraph; handlerLog: HandlerCallLog } {
  const registries = engramRegistries(behaviour, trace);
  const counted = countingNodeRegistry(registries.nodes);
  return {
    graph: compile(spec, { ...registries, nodes: counted.registry }),
    handlerLog: counted.log,
  };
}

// ── Harness ─────────────────────────────────────────────────────────

export interface RunEngramOptions {
  projectRoot: string;
  behaviour: EngramBehaviour;
  runId?: string;
  config?: BoberConfig;
  spec?: TopologySpec;
}

export interface EngramRun {
  result: GraphRunResult;
  spans: Span[];
  graph: CompiledGraph;
  runId: string;
  /** Returned so the archive-set assertion can `readdir` the real tree this run wrote. */
  projectRoot: string;
  finalState: OverallState;
  handlerLog: HandlerCallLog;
}

/**
 * Run the Engram fixture to completion against real stores under `projectRoot`.
 *
 * The trace writer is closed inside the `finally` before spans are read, so every span
 * the run produced — including the successor's child span carrying the assembled prompt —
 * is on disk when a test looks at it.
 */
export async function runEngram(options: RunEngramOptions): Promise<EngramRun> {
  const runId = options.runId ?? "run-engram";
  const projectRoot = options.projectRoot;
  const config = options.config ?? createDefaultConfig("engram-fixture", "brownfield");
  const clock = createMonotonicClock();
  const spec = options.spec ?? engramSpec();
  const trace = await createTraceWriter(projectRoot, runId, { now: () => clock.now() });
  const { graph, handlerLog } = compileEngram(options.behaviour, trace, spec);

  const ctx: RunContext = {
    runId,
    projectRoot,
    config,
    clock,
    signal: new AbortController().signal,
    trace,
    scheduler: new Scheduler({ maxConcurrent: 1 }),
    ledger: createBudgetLedger(),
    commit: createCommitBoundary({ clock }),
    planner: createFrontierPlanner(),
    services: {
      effects: createEffectRegistry(),
      scratch: createScratchStore(projectRoot),
      archive: createArchiveWriter(projectRoot),
      cache: createSemanticCache(projectRoot, runId),
      prompts: { has: () => true, get: async (ref: string) => `stub prompt for ${ref}` },
      models: createModelBinder({
        light: { provider: "stub", modelId: "stub-light" },
        frontier: { provider: "stub", modelId: "stub-frontier" },
      }),
    },
  };

  const interpreter = createGraphInterpreter();
  let result: GraphRunResult;
  try {
    result = await interpreter.run(
      graph,
      initialOverallState({
        runId,
        projectRoot,
        featureRequest: "Compact when the window fills, then hand off from the digest.",
      }),
      ctx,
    );
  } finally {
    await trace.close();
  }

  return {
    result,
    spans: await readSpans(trace.path()),
    graph,
    runId,
    projectRoot,
    finalState: result.state,
    handlerLog,
  };
}
