import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ScratchRef } from "../state/overall.js";
import {
  DuplicateSpanIdError,
  SpanAlreadyEndedError,
  TraceParseError,
  TraceWriterClosedError,
  buildSpanTree,
  createTraceWriter,
  readSpans,
  tracePath,
} from "./trace.js";
import type { Span, SpanTreeNode } from "./trace.js";

/**
 * sc-6-7 — one JSONL span per node execution.
 *
 * The trace is the artifact someone reads at 3am, so the assertions are about the
 * CONTENT of each line (every mandated field, with the value the caller supplied) and
 * about the STRUCTURE across lines (the parent/child tree, with exactly one root).
 */

let root = "";
const RUN = "run-20260805-c";

const TOOL_REF: ScratchRef = {
  uri: "scratch://run-20260805-c/" + "a".repeat(64) + ".txt",
  sha256: "a".repeat(64),
  bytes: 12,
  kind: "stdout",
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bober-pge-trace-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A clock that advances one second per read, so startedAt < endedAt is observable. */
function tickingClock(startIso = "2026-08-05T00:00:00.000Z"): () => Date {
  let ms = Date.parse(startIso);
  return () => {
    const at = new Date(ms);
    ms += 1_000;
    return at;
  };
}

describe("TraceWriter (sc-6-7)", () => {
  it("appends one line per node execution to .bober/traces/<runId>.jsonl", async () => {
    const writer = await createTraceWriter(root, RUN, { now: tickingClock() });
    expect(writer.path()).toBe(join(root, ".bober", "traces", `${RUN}.jsonl`));
    expect(writer.path()).toBe(tracePath(root, RUN));

    writer.begin({ nodeId: "plan", kind: "llm", phase: "planning", branchKey: null }).end({
      status: "ok",
    });
    writer.begin({ nodeId: "gate_syntax", kind: "gate", phase: "generating", branchKey: null }).end(
      { status: "failed", errorClass: "TypeError" },
    );
    await writer.close();

    const raw = await readFile(writer.path(), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.trimEnd().split("\n").length).toBe(2);

    const spans = await readSpans(writer.path());
    expect(spans.map((s) => s.nodeId)).toEqual(["plan", "gate_syntax"]);
    expect(spans.map((s) => s.status)).toEqual(["ok", "failed"]);
    expect(spans[1]?.errorClass).toBe("TypeError");
  });

  it("carries every mandated field through the file and back", async () => {
    const writer = await createTraceWriter(root, RUN, {
      now: tickingClock(),
      newSpanId: () => "span-full",
    });

    writer
      .begin({
        nodeId: "sprint_generate",
        kind: "llm",
        phase: "generating",
        branchKey: "sprint-3",
        parentSpanId: "span-parent",
        superstep: 4,
        inputHash: "sha256:in",
        model: { tier: "frontier", provider: "anthropic", modelId: "claude-sonnet-4-5" },
        archiveDir: "/tmp/archive/sprint_generate.sprint-3",
      })
      .end({
        status: "ok",
        outputHash: "sha256:out",
        tokens: { in: 1200, out: 340 },
        costUsd: 0.0412,
        cache: { status: "miss", key: "b".repeat(64) },
        toolOutputRef: TOOL_REF,
        route: { label: "pass", goto: { kind: "label", label: "pass" } },
        failClosed: false,
      });
    await writer.close();

    const [span] = await readSpans(writer.path());
    expect(span).toEqual({
      runId: RUN,
      spanId: "span-full",
      parentSpanId: "span-parent",
      superstep: 4,
      nodeId: "sprint_generate",
      branchKey: "sprint-3",
      kind: "llm",
      phase: "generating",
      startedAt: "2026-08-05T00:00:00.000Z",
      endedAt: "2026-08-05T00:00:01.000Z",
      inputHash: "sha256:in",
      outputHash: "sha256:out",
      model: { tier: "frontier", provider: "anthropic", modelId: "claude-sonnet-4-5" },
      tokens: { in: 1200, out: 340 },
      costUsd: 0.0412,
      cache: { status: "miss", key: "b".repeat(64) },
      toolOutputRef: TOOL_REF,
      archiveDir: "/tmp/archive/sprint_generate.sprint-3",
      route: { label: "pass", goto: { kind: "label", label: "pass" } },
      failClosed: false,
      status: "ok",
    });
  });

  it("records a serialized span with its reason", async () => {
    const writer = await createTraceWriter(root, RUN, { now: tickingClock() });
    writer
      .begin({ nodeId: "sprint_generate", kind: "llm", phase: "generating", branchKey: "s2" })
      .end({ status: "serialized", serializedReason: "fileConflict" });
    await writer.close();

    const [span] = await readSpans(writer.path());
    expect(span?.status).toBe("serialized");
    expect(span?.serializedReason).toBe("fileConflict");
  });

  it("defaults the optional beginning fields rather than emitting an invalid span", async () => {
    const writer = await createTraceWriter(root, RUN, { now: tickingClock() });
    writer.begin({ nodeId: "router", kind: "router", phase: "evaluating", branchKey: null }).end({
      status: "skipped",
    });
    await writer.close();

    const [span] = await readSpans(writer.path());
    expect(span?.parentSpanId).toBeNull();
    expect(span?.superstep).toBe(0);
    expect(span?.inputHash).toBe("");
    expect(span?.outputHash).toBe("");
    expect(span?.model).toBeUndefined();
    expect(span?.spanId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("appends to an existing trace instead of truncating it", async () => {
    const first = await createTraceWriter(root, RUN, { now: tickingClock() });
    first.begin({ nodeId: "a", kind: "tool", phase: "init", branchKey: null }).end({ status: "ok" });
    await first.close();

    const second = await createTraceWriter(root, RUN, { now: tickingClock() });
    second.begin({ nodeId: "b", kind: "tool", phase: "init", branchKey: null }).end({
      status: "ok",
    });
    await second.close();

    expect((await readSpans(tracePath(root, RUN))).map((s) => s.nodeId)).toEqual(["a", "b"]);
  });

  it("refuses to end a span twice and to begin one after close", async () => {
    const writer = await createTraceWriter(root, RUN, { now: tickingClock() });
    const handle = writer.begin({ nodeId: "n", kind: "tool", phase: "init", branchKey: null });
    handle.end({ status: "ok" });
    expect(() => handle.end({ status: "failed" })).toThrow(SpanAlreadyEndedError);

    await writer.close();
    expect(() => writer.begin({ nodeId: "n", kind: "tool", phase: "init", branchKey: null })).toThrow(
      TraceWriterClosedError,
    );
    // close is idempotent — the interpreter closes on every exit path.
    await expect(writer.close()).resolves.toBeUndefined();

    // Exactly one line was written despite the second end() attempt.
    expect((await readSpans(writer.path())).length).toBe(1);
  });

  it("refuses to END a span after close instead of losing it silently", async () => {
    const writer = await createTraceWriter(root, RUN, { now: tickingClock() });

    // The shape the interpreter hits: one span still open when the run loop tears the
    // writer down, and its `end()` running afterwards in a `finally`.
    const stillOpen = writer.begin({
      nodeId: "still-running",
      kind: "tool",
      phase: "init",
      branchKey: null,
    });
    writer.begin({ nodeId: "done", kind: "tool", phase: "init", branchKey: null }).end({
      status: "ok",
    });
    await writer.close();

    expect(() => stillOpen.end({ status: "interrupted" })).toThrow(TraceWriterClosedError);
    const error = (() => {
      try {
        stillOpen.end({ status: "interrupted" });
        return null;
      } catch (e: unknown) {
        return e as TraceWriterClosedError;
      }
    })();
    // Not a stale SpanAlreadyEndedError: the refused end() did not mark the span written.
    expect(error).toBeInstanceOf(TraceWriterClosedError);
    expect(error?.path).toBe(writer.path());

    // The trace is exactly what it was before the late end() — nothing appended into a
    // closed handle, nothing lost into an unread `firstWriteError`.
    expect((await readSpans(writer.path())).map((s) => s.nodeId)).toEqual(["done"]);
  });

  it("refuses a runId that would escape .bober/traces/", async () => {
    await expect(createTraceWriter(root, "../../escape")).rejects.toThrow(
      /Unsafe runId/,
    );
  });

  it("surfaces a malformed line with its line number rather than a silent skip", async () => {
    const path = join(root, "broken.jsonl");
    await writeFile(path, '{"runId":"r","spanId":"s"}\n', "utf8");
    await expect(readSpans(path)).rejects.toBeInstanceOf(TraceParseError);
    const err = (await readSpans(path).catch((e: unknown) => e)) as TraceParseError;
    expect(err.lineNumber).toBe(1);
    expect(err.path).toBe(path);
  });

  it("reads an absent trace as no spans", async () => {
    expect(await readSpans(join(root, "never-written.jsonl"))).toEqual([]);
  });
});

describe("span tree (sc-6-7)", () => {
  it("reconstructs a well-formed tree with exactly one root", async () => {
    const writer = await createTraceWriter(root, RUN, { now: tickingClock() });

    // A realistic superstep: one root, two children, one grandchild under each child.
    const rootHandle = writer.begin({
      nodeId: "pipeline",
      kind: "subgraph",
      phase: "init",
      branchKey: null,
      superstep: 0,
    });
    const planHandle = writer.begin({
      nodeId: "plan",
      kind: "llm",
      phase: "planning",
      branchKey: null,
      parentSpanId: rootHandle.spanId,
      superstep: 1,
    });
    const sprintHandle = writer.begin({
      nodeId: "sprint",
      kind: "subgraph",
      phase: "generating",
      branchKey: null,
      parentSpanId: rootHandle.spanId,
      superstep: 1,
    });
    const generateHandle = writer.begin({
      nodeId: "sprint_generate",
      kind: "llm",
      phase: "generating",
      branchKey: "sprint-1",
      parentSpanId: sprintHandle.spanId,
      superstep: 2,
    });
    const evaluateHandle = writer.begin({
      nodeId: "sprint_evaluate",
      kind: "llm",
      phase: "evaluating",
      branchKey: "sprint-1",
      parentSpanId: sprintHandle.spanId,
      superstep: 3,
    });

    for (const handle of [
      generateHandle,
      evaluateHandle,
      planHandle,
      sprintHandle,
      rootHandle,
    ]) {
      handle.end({ status: "ok" });
    }
    await writer.close();

    const spans = await readSpans(writer.path());
    expect(spans.length).toBe(5);

    const roots = buildSpanTree(spans);
    expect(roots.length).toBe(1);

    const [tree] = roots as [SpanTreeNode];
    expect(tree.span.nodeId).toBe("pipeline");
    expect(tree.span.parentSpanId).toBeNull();
    expect(tree.children.map((c) => c.span.nodeId)).toEqual(["plan", "sprint"]);
    expect(tree.children[1]?.children.map((c) => c.span.nodeId)).toEqual([
      "sprint_generate",
      "sprint_evaluate",
    ]);
    expect(tree.children[0]?.children).toEqual([]);

    // Well-formed: every span appears exactly once in the tree, and every non-root
    // span's parent really is the span it names.
    const seen: string[] = [];
    const walk = (node: SpanTreeNode, parentId: string | null): void => {
      expect(node.span.parentSpanId).toBe(parentId);
      seen.push(node.span.spanId);
      for (const child of node.children) walk(child, node.span.spanId);
    };
    walk(tree, null);
    expect(seen.length).toBe(spans.length);
    expect(new Set(seen).size).toBe(spans.length);
  });

  it("surfaces an orphan as a SECOND root rather than dropping it", () => {
    const base: Omit<Span, "spanId" | "parentSpanId" | "nodeId"> = {
      runId: RUN,
      superstep: 0,
      branchKey: null,
      kind: "tool",
      phase: "init",
      startedAt: "2026-08-05T00:00:00.000Z",
      endedAt: "2026-08-05T00:00:01.000Z",
      inputHash: "",
      outputHash: "",
      status: "ok",
    };
    const spans: Span[] = [
      { ...base, spanId: "root", parentSpanId: null, nodeId: "root" },
      { ...base, spanId: "orphan", parentSpanId: "vanished", nodeId: "orphan" },
    ];
    const roots = buildSpanTree(spans);
    expect(roots.map((r) => r.span.spanId).sort()).toEqual(["orphan", "root"]);
    expect(roots.length).toBe(2);
  });

  it("refuses a trace with a duplicated span id", () => {
    const span: Span = {
      runId: RUN,
      spanId: "dup",
      parentSpanId: null,
      superstep: 0,
      nodeId: "n",
      branchKey: null,
      kind: "tool",
      phase: "init",
      startedAt: "2026-08-05T00:00:00.000Z",
      endedAt: "2026-08-05T00:00:01.000Z",
      inputHash: "",
      outputHash: "",
      status: "ok",
    };
    expect(() => buildSpanTree([span, { ...span }])).toThrow(DuplicateSpanIdError);
  });
});
