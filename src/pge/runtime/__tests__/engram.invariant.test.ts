import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ChatParams, ChatResponse, LLMClient } from "../../../providers/types.js";
import {
  ARCHIVE_BRANCH_SEPARATOR,
  ARCHIVE_OUTPUTS_FILE,
  ARCHIVE_SEALED_MARKER,
  ARCHIVE_SNAPSHOT_FILE,
  ARCHIVE_STDOUT_FILE,
  archiveRunDir,
  restoreWritableTree,
} from "../archive.js";
import { COMPACTION_TRIGGER_RATIO } from "../compactor.js";
import { DigestMissingError, renderDigest, writeDigest } from "../digest.js";
import type { PhaseDigest } from "../digest.js";
import { SUCCESSOR_CONTEXT_RATIO } from "../handoff.js";
import { createScratchStore } from "../scratch.js";
import { createCharsPerTokenEstimator, estimateMessages } from "../token-estimator.js";
import type { Span } from "../trace.js";
import {
  ENGRAM_MESSAGE_CHARS,
  ENGRAM_NODES,
  ENGRAM_PROMPT_SPAN_OUTPUT_HASH,
  engramBehaviour,
  engramMessages,
  engramSpec,
  runEngram,
} from "../__fixtures__/engram-graph.js";
import type { EngramBehaviour, EngramRun } from "../__fixtures__/engram-graph.js";

/**
 * BLOCKING INVARIANT SUITE — THE ENGRAM CONTEXT LAYER.
 *
 * Three claims, and each is easy to get silently wrong in a different way:
 *
 *  1. Compaction fires at a SUPERSTEP BOUNDARY. A run that compacted inside the node that
 *     produced the messages would show the same "one compaction happened" count, so a
 *     count assertion alone proves nothing. What is asserted instead is span GEOMETRY:
 *     the compaction span's interval is not contained inside any other span's interval,
 *     its superstep is strictly greater than the routing node's, and its branch key is
 *     null so it cannot be inside a fan-out.
 *  2. The successor's context is CONSTRUCTED from the digest. The assertion reads the
 *     prompt back out of `.bober/traces/` — the actual bytes the successor assembled,
 *     addressed by a `ScratchRef` on a real span — rather than the value the fixture
 *     happens to have recorded. A test that asserted against the recorder would be
 *     asserting the intent to build a prompt, not the prompt.
 *  3. The archive tree matches the trace's EXECUTED node set. `abandoned` is declared,
 *     has a router target and an inbound edge, and is never selected; a failing run's
 *     `successor` opens a span and never archives. Both are directories that must NOT
 *     exist, and they are what make the set equality sensitive rather than tautological.
 *
 * Ordering assertions read the injected MONOTONIC LOGICAL CLOCK (one millisecond per
 * read, so span timestamps are a total order). Nothing asserts elapsed time, and nothing
 * here would change meaning on a slower machine.
 *
 * ── Mutation-proven ──
 *
 * This suite was run against four deliberate breakages and failed on each:
 *  - the supervisor compacting inline instead of routing to `context_compact` (the
 *    compaction span then nested inside the supervisor's own span interval, and the
 *    `context_compact` span count dropped to zero);
 *  - the 86-message case sized at 85 instead (the threshold comparison is strict, so the
 *    "exactly one compaction" assertion went to zero);
 *  - the successor building its prompt from `state.messages` (the predecessor-id scan
 *    over the trace-recovered bytes then found `m-pred-000`);
 *  - the archive-set predicate widened from `status === "ok"` to every span (the failing
 *    run then expected a `successor` directory that correctly does not exist).
 */

const EST = createCharsPerTokenEstimator(4);
const CAP = 10_000;

/** 84 messages of 400 chars = 8400 tokens = 84% of the cap. 86 = 8600 = 86%. */
const UNDER = 84;
const OVER = 86;

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bober-pge-engram-"));
});

afterEach(async () => {
  await restoreWritableTree(root);
  await rm(root, { recursive: true, force: true });
});

function summaryClient(): LLMClient & { readonly calls: ChatParams[] } {
  const calls: ChatParams[] = [];
  return {
    calls,
    async chat(params: ChatParams): Promise<ChatResponse> {
      calls.push(params);
      return {
        text: JSON.stringify({
          activeGoals: ["Finish the Engram layer", "Keep the imperative compactor untouched"],
          completedTasks: ["Produced the transcript", "Crossed the compaction threshold"],
          workspacePath: "/workspace/engram",
        }),
        toolCalls: [],
        stopReason: "end",
        usage: { inputTokens: 10, outputTokens: 20 },
      };
    },
  };
}

function digestFixture(runId = "run-engram"): PhaseDigest {
  return {
    phase: "generating",
    runId,
    createdAt: "2026-08-05T00:00:00.000Z",
    insights: [
      "The compaction decision belongs to the supervisor, not to the node that produced the messages.",
      "The channel is the audit record; the compaction product is a derived window.",
    ],
    modellingChoices: [
      {
        timestamp: "2026-08-05T00:00:01.000Z",
        description: "Route compaction through a node rather than a hook",
        rationale: "A node boundary is a superstep boundary, and the trace can prove it",
        madeBy: "planner",
      },
    ],
    nextSteps: ["Wire the real context.compact node body in sprint 11."],
    diagnoses: [
      {
        hypothesis: "An inline compactor would double-execute every preceding effect on resume.",
        evidence: "ADR-6 records the same argument against pausing inside a node body.",
      },
    ],
  };
}

function behaviour(messageCount: number, overrides: Partial<EngramBehaviour> = {}): EngramBehaviour {
  return engramBehaviour({
    messageCount,
    cap: CAP,
    estimator: EST,
    client: summaryClient(),
    model: "stub-frontier",
    ...overrides,
  });
}

/** Seed the digest the successor will read, then run. */
async function run(
  messageCount: number,
  overrides: Partial<EngramBehaviour> = {},
  options: { seedDigest?: boolean; runId?: string } = {},
): Promise<{ run: EngramRun; behaviour: EngramBehaviour }> {
  const runId = options.runId ?? "run-engram";
  const b = behaviour(messageCount, overrides);
  if (options.seedDigest !== false) await writeDigest(root, digestFixture(runId), EST);
  const result = await runEngram({ projectRoot: root, behaviour: b, runId });
  return { run: result, behaviour: b };
}

function spansFor(spans: readonly Span[], nodeId: string): Span[] {
  return spans.filter((span) => span.nodeId === nodeId);
}

/**
 * The trace's EXECUTED set: `(nodeId, branchKey)` of every span that ended `ok`.
 *
 * `ok` and not "not skipped": `SPAN_STATUSES` also carries `failed`, `interrupted`,
 * `serialized` and `skipped`, and a span in any of those four either never entered its
 * handler or entered it and did not finish — neither of which is a node that archived.
 * The leaf name is rebuilt exactly as `archiveNodeDir` builds it, so the comparison is
 * against the real layout rather than against a restatement of it.
 */
function executedLeaves(spans: readonly Span[]): string[] {
  const leaves = new Set<string>();
  for (const span of spans) {
    if (span.status !== "ok") continue;
    leaves.add(
      span.branchKey === null
        ? span.nodeId
        : `${span.nodeId}${ARCHIVE_BRANCH_SEPARATOR}${span.branchKey}`,
    );
  }
  return [...leaves].sort();
}

// ── sc-10-6 ─────────────────────────────────────────────────────────

describe("sc-10-6: 84% fires no compaction, 86% fires exactly one, at a superstep boundary", () => {
  it("the two cases use the SAME cap, the SAME estimator and the same 400-char messages", () => {
    expect(ENGRAM_MESSAGE_CHARS).toBe(400);
    expect(estimateMessages(engramMessages(behaviour(UNDER)), EST)).toBe(8400);
    expect(estimateMessages(engramMessages(behaviour(OVER)), EST)).toBe(8600);
    expect(Math.floor(CAP * COMPACTION_TRIGGER_RATIO)).toBe(8500);
    // 100 tokens of clearance on each side — one whole message — so no estimator rounding
    // step can move either case across the boundary.
    expect(8500 - 8400).toBe(100);
    expect(8600 - 8500).toBe(100);
  });

  it("84% of the cap: zero context_compact spans and no transcript on disk", async () => {
    const { run: r, behaviour: b } = await run(UNDER);

    expect(r.result.status).toBe("completed");
    expect(spansFor(r.spans, ENGRAM_NODES.compact)).toEqual([]);
    expect(b.entered).not.toContain(ENGRAM_NODES.compact);
    expect(b.decisions).toHaveLength(1);
    expect(b.decisions[0].tokens).toBe(8400);
    expect(b.decisions[0].threshold).toBe(8500);
    expect(b.decisions[0].shouldCompact).toBe(false);
    await expect(readdir(join(root, ".bober", "logs"))).rejects.toThrow(/ENOENT/);
  });

  it("86% of the cap: EXACTLY ONE context_compact span", async () => {
    const { run: r, behaviour: b } = await run(OVER);

    expect(r.result.status).toBe("completed");
    const compact = spansFor(r.spans, ENGRAM_NODES.compact);
    expect(compact).toHaveLength(1);
    expect(compact[0].status).toBe("ok");
    expect(b.entered.filter((id) => id === ENGRAM_NODES.compact)).toHaveLength(1);
    expect(b.decisions[0].tokens).toBe(8600);
    expect(b.decisions[0].shouldCompact).toBe(true);
    expect(b.compactions).toHaveLength(1);
    expect(b.compactions[0].kind).toBe("compacted");
  });

  it("the compaction runs at a superstep boundary, not mid-node", async () => {
    const { run: r } = await run(OVER);

    const compact = spansFor(r.spans, ENGRAM_NODES.compact)[0];
    const supervisor = spansFor(r.spans, ENGRAM_NODES.supervisor)[0];
    const producer = spansFor(r.spans, ENGRAM_NODES.producer)[0];

    // (a) A LATER superstep than the router that selected it — a compaction that happened
    //     inside the router's execution would share its superstep.
    expect(compact.superstep).toBeGreaterThan(supervisor.superstep);
    expect(supervisor.superstep).toBeGreaterThan(producer.superstep);

    // (b) Its interval is not CONTAINED inside any other span's interval. Under the
    //     injected monotonic clock the timestamps are a total order, so containment is
    //     decidable by string comparison and means exactly "ran inside that node".
    const nested = r.spans
      .filter((span) => span.spanId !== compact.spanId)
      .filter((span) => span.startedAt < compact.startedAt && compact.endedAt < span.endedAt);
    expect(nested.map((s) => s.nodeId)).toEqual([]);

    // (c) Not inside a fan-out branch.
    expect(compact.branchKey).toBeNull();

    // (d) Control: the same containment test DOES find the successor's own child span
    //     nested inside the successor's interpreter span, so the check above is a real
    //     check and not one that can never fire.
    const successorSpans = spansFor(r.spans, ENGRAM_NODES.successor);
    const child = successorSpans.find((s) => s.outputHash === ENGRAM_PROMPT_SPAN_OUTPUT_HASH);
    const parent = successorSpans.find((s) => s.spanId === child?.parentSpanId);
    expect(child).toBeDefined();
    expect(parent).toBeDefined();
    expect(parent!.startedAt < child!.startedAt && child!.endedAt < parent!.endedAt).toBe(true);
  });

  it("the compaction writes the transcript and commits a summary WITHOUT shrinking the channel", async () => {
    const { run: r, behaviour: b } = await run(OVER);
    const outcome = b.compactions[0];
    if (outcome.kind !== "compacted") throw new Error("expected a compaction");

    // `appendById` is a monotone union: the eighty-six predecessor messages are all still
    // there, plus the summary, plus the successor's own message. The channel is the audit
    // record; the post-compression BASELINE is the derived window.
    expect(r.finalState.messages).toHaveLength(OVER + 2);
    for (const message of engramMessages(b)) {
      expect(r.finalState.messages.some((m) => m.id === message.id)).toBe(true);
    }
    expect(r.finalState.messages.some((m) => m.id === outcome.summaryMessage.id)).toBe(true);
    expect(outcome.baselineTokens).toBeLessThan(outcome.decision.tokens / 4);

    // The absolute compaction count, never an increment: `counters` is a per-key maximum.
    expect(r.finalState.counters.contextCompactions).toBe(1);
    expect(Object.keys(r.finalState.refs)).toContain("compaction-0-transcript");
    expect(await readdir(join(root, ".bober", "logs", r.runId))).toEqual(["messages-0.jsonl"]);
  });
});

// ── sc-10-5 ─────────────────────────────────────────────────────────

describe("sc-10-5: the successor's assembled prompt, read back out of the trace", () => {
  async function assembledPrompt(messageCount: number): Promise<{
    text: string;
    span: Span;
    run: EngramRun;
    behaviour: EngramBehaviour;
  }> {
    const { run: r, behaviour: b } = await run(messageCount);
    const span = r.spans.find((s) => s.outputHash === ENGRAM_PROMPT_SPAN_OUTPUT_HASH);
    expect(span, "no span carried the assembled prompt").toBeDefined();
    expect(span!.toolOutputRef, "the span carried no ScratchRef").toBeDefined();
    // Read the actual bytes the node put in the scratch store, addressed by the ref the
    // span records. Not the recorder, not the intent — the artifact.
    const text = await createScratchStore(root).text(span!.toolOutputRef!);
    return { text, span: span!, run: r, behaviour: b };
  }

  it("contains the digest text", async () => {
    const { text } = await assembledPrompt(OVER);
    expect(text).toContain(renderDigest(digestFixture()));
    expect(text).toContain("The compaction decision belongs to the supervisor");
    expect(text).toContain("## Diagnoses");
  });

  it("contains ZERO message ids from the predecessor's transcript", async () => {
    const { text, run: r, behaviour: b } = await assembledPrompt(OVER);

    // Every id that actually reached the channel, taken from the committed state rather
    // than from the fixture's intent — including the compaction summary's own id.
    const idsInState = r.finalState.messages
      .map((m) => m.id)
      .filter((id) => id !== "m-successor");
    expect(idsInState.length).toBeGreaterThan(OVER);
    for (const id of idsInState) {
      expect(text, `assembled prompt leaked ${id}`).not.toContain(id);
    }
    expect(b.prompts[0].sourceMessageIds).toEqual([]);
  });

  it("its estimated token count is at most 15% of the predecessor's final context", async () => {
    const { text, span, run: r } = await assembledPrompt(OVER);

    const predecessorTokens = estimateMessages(
      r.finalState.messages.filter((m) => m.id !== "m-successor"),
      EST,
    );
    const budget = Math.floor(predecessorTokens * SUCCESSOR_CONTEXT_RATIO);

    // The token count recorded ON THE SPAN, not recomputed from the recorder.
    expect(span.tokens).toBeDefined();
    expect(span.tokens!.in).toBe(EST.estimate(text));
    expect(span.tokens!.in).toBeLessThanOrEqual(budget);
    expect(span.tokens!.out).toBe(0);
  });

  it("holds in the uncompacted path too — the digest, not the transcript, is the source either way", async () => {
    const { text, span } = await assembledPrompt(UNDER);
    expect(text).toContain("## Insights");
    for (const message of engramMessages(behaviour(UNDER))) {
      expect(text).not.toContain(message.id);
    }
    expect(span.tokens!.in).toBeLessThanOrEqual(Math.floor(8400 * SUCCESSOR_CONTEXT_RATIO));
  });

  it("a MISSING digest is a hard stop: the successor fails and assembles nothing", async () => {
    const { run: r, behaviour: b } = await run(OVER, {}, { seedDigest: false });

    // The handler was entered and threw on `readDigest`; nothing fell back to the
    // transcript, and no prompt exists.
    expect(b.entered).toContain(ENGRAM_NODES.successor);
    expect(b.prompts).toEqual([]);
    expect(r.spans.find((s) => s.outputHash === ENGRAM_PROMPT_SPAN_OUTPUT_HASH)).toBeUndefined();

    const failed = spansFor(r.spans, ENGRAM_NODES.successor).filter((s) => s.status === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].errorClass).toBe(DigestMissingError.name);
    expect(r.result.failures.map((f) => f.errorClass)).toContain(DigestMissingError.name);
  });
});

// ── sc-10-9 ─────────────────────────────────────────────────────────

describe("sc-10-9: one archive directory per EXECUTED node, each with its three files", () => {
  it("the directory set equals the trace's executed node set", async () => {
    const { run: r } = await run(OVER);

    const dirs = (await readdir(archiveRunDir(root, r.runId))).sort();
    expect(dirs).toEqual(executedLeaves(r.spans));
    expect(dirs).toEqual([
      ENGRAM_NODES.compact,
      ENGRAM_NODES.producer,
      ENGRAM_NODES.successor,
      ENGRAM_NODES.supervisor,
    ].sort());
  });

  it("each directory holds snapshot.json, stdout.log and outputs.json, and is sealed", async () => {
    const { run: r } = await run(OVER);
    const runDir = archiveRunDir(root, r.runId);

    for (const leaf of await readdir(runDir)) {
      const files = (await readdir(join(runDir, leaf))).sort();
      expect(files, `${leaf} is missing an archive file`).toEqual(
        expect.arrayContaining([
          ARCHIVE_OUTPUTS_FILE,
          ARCHIVE_SNAPSHOT_FILE,
          ARCHIVE_STDOUT_FILE,
        ]),
      );
      expect(files).toContain(ARCHIVE_SEALED_MARKER);
    }
  });

  it("control: `abandoned` is DECLARED and reachable, never executed, and has no directory", async () => {
    const { run: r } = await run(OVER);

    // Declared in the topology, with a router target and an inbound conditional edge.
    const spec = engramSpec();
    expect(spec.nodes.map((n) => n.id)).toContain(ENGRAM_NODES.abandoned);
    expect(spec.edges.some((e) => e.to === ENGRAM_NODES.abandoned)).toBe(true);

    // Absent from the trace and absent from the archive. An assertion written against the
    // topology's declared node set would fail here.
    expect(spansFor(r.spans, ENGRAM_NODES.abandoned)).toEqual([]);
    expect(await readdir(archiveRunDir(root, r.runId))).not.toContain(ENGRAM_NODES.abandoned);
    expect(spec.nodes).toHaveLength(5);
    expect(executedLeaves(r.spans)).toHaveLength(4);
  });

  it("control: a node that opened a span and FAILED has no directory, and the equality holds", async () => {
    const { run: r } = await run(OVER, { failing: [ENGRAM_NODES.successor] });

    // The successor entered its handler, threw before archiving, and closed `failed`.
    const successorSpans = spansFor(r.spans, ENGRAM_NODES.successor);
    expect(successorSpans).toHaveLength(1);
    expect(successorSpans[0].status).toBe("failed");

    const dirs = (await readdir(archiveRunDir(root, r.runId))).sort();
    expect(dirs).not.toContain(ENGRAM_NODES.successor);
    expect(dirs).toEqual(executedLeaves(r.spans));
    // An assertion written against every span's node id — rather than against the ones
    // that ended `ok` — would expect a `successor` directory that must not exist.
    expect([...new Set(r.spans.map((s) => s.nodeId))].sort()).toContain(ENGRAM_NODES.successor);
  });

  it("control: a run whose FIRST node fails leaves no archive tree at all", async () => {
    const { run: r } = await run(OVER, { failing: [ENGRAM_NODES.producer] });

    expect(executedLeaves(r.spans)).toEqual([]);
    // Archives are lazy: nothing is created until a node actually writes.
    await expect(readdir(archiveRunDir(root, r.runId))).rejects.toThrow(/ENOENT/);
  });
});
