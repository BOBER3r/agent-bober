import { randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { NodeKindSchema } from "../../contracts/topology.js";
import { PhaseSchema } from "../../state/history.js";
import { ScratchRefSchema } from "../state/overall.js";
import type { Goto, TraceWriter as NodeContextTraceWriter } from "../registry/nodes.js";
import { assertSafePathSegment } from "./scratch.js";
import type { Implements } from "./scratch.js";

/**
 * One JSONL span per node execution, appended to `.bober/traces/<runId>.jsonl`.
 *
 * ── Why a file, and why append-only ──
 *
 * The trace is the source of truth when a 40-node run does something surprising. It is
 * written line-by-line as spans END, never buffered as a whole document, so a crashed
 * run still leaves every span that completed before the crash. It is local: nothing here
 * exports anywhere off the machine — the OTLP exporter is sprint 13 and is off by
 * default.
 *
 * ── Not a replacement for `src/telemetry/emit.ts` ──
 *
 * Spans are a NEW stream, at node granularity, with a parent/child structure that the
 * flat history log does not have. The existing telemetry path is untouched.
 *
 * ── Widening, deliberately ──
 *
 * {@link SpanBegin} requires exactly the four fields `NodeContext.trace.begin` promises
 * (`nodeId`, `kind`, `phase`, `branchKey`) and makes the rest optional, so this concrete
 * writer is usable wherever the narrow node-facing interface is expected — proved by
 * {@link _traceWriterImplementsNodeContext} at `tsc` time, not by a test.
 */

// ── Span schema ─────────────────────────────────────────────────────

export const SPAN_STATUSES = ["ok", "failed", "interrupted", "skipped", "serialized"] as const;
export const SpanStatusSchema = z.enum(SPAN_STATUSES);
export type SpanStatus = z.infer<typeof SpanStatusSchema>;

export const CACHE_STATUSES = ["hit", "miss", "skip"] as const;
export const SpanCacheSchema = z.object({
  status: z.enum(CACHE_STATUSES),
  key: z.string(),
});

export const SERIALIZED_REASONS = ["fileConflict", "dependsOn", "concurrencyCap"] as const;

/** Mirrors the {@link Goto} interface; the guard below proves every `Goto` fits. */
export const GotoSchema = z.object({
  kind: z.enum(["label", "node", "fanout", "parent"]),
  label: z.string().optional(),
  node: z.string().optional(),
  sends: z.array(z.object({ branchKey: z.string(), input: z.unknown() })).optional(),
});

/** Every routing decision the interpreter can make is serialisable into a span. */
export const _gotoIsSerializable: Implements<Goto, z.infer<typeof GotoSchema>> = true;

export const SpanSchema = z.object({
  runId: z.string().min(1),
  spanId: z.string().min(1),
  parentSpanId: z.string().min(1).nullable(),
  superstep: z.number().int().min(0),
  nodeId: z.string().min(1),
  branchKey: z.string().nullable(),
  kind: NodeKindSchema,
  phase: PhaseSchema,
  startedAt: z.string().min(1),
  endedAt: z.string().min(1),
  inputHash: z.string(),
  outputHash: z.string(),
  model: z
    .object({
      tier: z.enum(["light", "frontier"]),
      provider: z.string(),
      modelId: z.string(),
    })
    .optional(),
  tokens: z.object({ in: z.number().int().min(0), out: z.number().int().min(0) }).optional(),
  costUsd: z.number().min(0).optional(),
  cache: SpanCacheSchema.optional(),
  toolOutputRef: ScratchRefSchema.optional(),
  archiveDir: z.string().optional(),
  route: z.object({ label: z.string().optional(), goto: GotoSchema }).optional(),
  failClosed: z.boolean().optional(),
  status: SpanStatusSchema,
  errorClass: z.string().optional(),
  serializedReason: z.enum(SERIALIZED_REASONS).optional(),
});
export type Span = z.infer<typeof SpanSchema>;

/** What a caller supplies when a node starts. Only the first four are required. */
export type SpanBegin = Pick<Span, "nodeId" | "kind" | "phase" | "branchKey"> &
  Partial<Pick<Span, "parentSpanId" | "superstep" | "inputHash" | "model" | "archiveDir">>;

/** What a caller supplies when a node finishes. */
export type SpanEnd = Pick<Span, "status"> &
  Partial<
    Pick<
      Span,
      | "errorClass"
      | "outputHash"
      | "tokens"
      | "costUsd"
      | "cache"
      | "toolOutputRef"
      | "archiveDir"
      | "route"
      | "failClosed"
      | "serializedReason"
    >
  >;

export interface SpanHandle {
  readonly spanId: string;
  readonly startedAt: string;
  end(outcome: SpanEnd): void;
}

// ── Errors ──────────────────────────────────────────────────────────

/** `end()` twice on one handle. Always a bug: the span was already written. */
export class SpanAlreadyEndedError extends Error {
  readonly spanId: string;

  constructor(spanId: string) {
    super(`Span "${spanId}" has already ended; a span is written exactly once.`);
    this.name = "SpanAlreadyEndedError";
    this.spanId = spanId;
  }
}

/**
 * `begin()` or `end()` after `close()`. The file handle is gone, so the line would be
 * written into a drained queue against a closed descriptor and lost.
 *
 * `end()` is the case that matters in practice: a node's `end()` runs in a `finally`,
 * and a run loop that has already torn the writer down would otherwise drop that span
 * with no error anywhere. Failing at the call site is the only way the caller learns.
 */
export class TraceWriterClosedError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`Trace "${path}" is closed; no further span may begin or end.`);
    this.name = "TraceWriterClosedError";
    this.path = path;
  }
}

/** A line in a trace file that is not a valid span. */
export class TraceParseError extends Error {
  readonly path: string;
  readonly lineNumber: number;

  constructor(path: string, lineNumber: number, cause: unknown) {
    super(
      `Trace "${path}" line ${lineNumber} is not a valid span: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "TraceParseError";
    this.path = path;
    this.lineNumber = lineNumber;
  }
}

// ── Layout ──────────────────────────────────────────────────────────

/** `.bober/traces/` for a project root. */
export function traceRoot(projectRoot: string): string {
  return join(projectRoot, ".bober", "traces");
}

/** `.bober/traces/<runId>.jsonl`. */
export function tracePath(projectRoot: string, runId: string): string {
  assertSafePathSegment("runId", runId);
  return join(traceRoot(projectRoot), `${runId}.jsonl`);
}

// ── Writer ──────────────────────────────────────────────────────────

export interface TraceWriter {
  begin(span: SpanBegin): SpanHandle;
  path(): string;
  /** Flush every pending line and release the file handle. Idempotent. */
  close(): Promise<void>;
}

/** sc-6-11 — the concrete writer is still a legal `NodeContext.trace`. */
export const _traceWriterImplementsNodeContext: Implements<
  TraceWriter,
  NodeContextTraceWriter
> = true;

export interface TraceWriterOptions {
  /** Injected clock. Default `() => new Date()`. */
  now?: () => Date;
  /** Injected span-id source, so a test can assert an exact tree. Default `randomUUID`. */
  newSpanId?: () => string;
}

/**
 * Open the run's trace for appending.
 *
 * Async because the directory must exist before the handle does, and this repository
 * has no synchronous filesystem calls. The handle is kept open for the run and written
 * through a serialised queue: `end()` stays synchronous (a node body must not await its
 * own bookkeeping), and {@link TraceWriter.close} is where the queue is drained and any
 * write error surfaces.
 *
 * @param projectRoot REQUIRED. No module-level writer exists; a worktree run traces into
 *   the worktree.
 */
export async function createTraceWriter(
  projectRoot: string,
  runId: string,
  options: TraceWriterOptions = {},
): Promise<TraceWriter> {
  const path = tracePath(projectRoot, runId);
  const now = options.now ?? (() => new Date());
  const newSpanId = options.newSpanId ?? (() => randomUUID());

  await mkdir(traceRoot(projectRoot), { recursive: true });
  const handle: FileHandle = await open(path, "a");

  let closed = false;
  let queue: Promise<void> = Promise.resolve();
  let firstWriteError: unknown = null;

  function enqueue(line: string): void {
    queue = queue.then(async () => {
      try {
        await handle.write(line);
      } catch (err) {
        if (firstWriteError === null) firstWriteError = err;
      }
    });
  }

  return {
    path: () => path,

    begin(span): SpanHandle {
      if (closed) throw new TraceWriterClosedError(path);
      const spanId = newSpanId();
      const startedAt = now().toISOString();
      let ended = false;

      return {
        spanId,
        startedAt,
        end(outcome): void {
          if (ended) throw new SpanAlreadyEndedError(spanId);
          // The queue was drained by `close()` and the descriptor released, so enqueuing
          // here would write into a closed handle and park the rejection in
          // `firstWriteError`, which no second `close()` will ever re-throw. `ended` stays
          // false: this span was never written, and saying otherwise would be a lie.
          if (closed) throw new TraceWriterClosedError(path);
          ended = true;
          const record: Span = SpanSchema.parse({
            runId,
            spanId,
            parentSpanId: span.parentSpanId ?? null,
            superstep: span.superstep ?? 0,
            nodeId: span.nodeId,
            branchKey: span.branchKey,
            kind: span.kind,
            phase: span.phase,
            startedAt,
            endedAt: now().toISOString(),
            inputHash: span.inputHash ?? "",
            outputHash: outcome.outputHash ?? "",
            model: span.model,
            archiveDir: outcome.archiveDir ?? span.archiveDir,
            tokens: outcome.tokens,
            costUsd: outcome.costUsd,
            cache: outcome.cache,
            toolOutputRef: outcome.toolOutputRef,
            route: outcome.route,
            failClosed: outcome.failClosed,
            status: outcome.status,
            errorClass: outcome.errorClass,
            serializedReason: outcome.serializedReason,
          });
          enqueue(JSON.stringify(record) + "\n");
        },
      };
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await queue;
      await handle.close();
      if (firstWriteError !== null) throw firstWriteError;
    },
  };
}

// ── Reading ─────────────────────────────────────────────────────────

/** Every span in a trace file, in write order. A missing file reads as no spans. */
export async function readSpans(path: string): Promise<Span[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const spans: Span[] = [];
  const lines = raw.split("\n");
  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) continue;
    try {
      spans.push(SpanSchema.parse(JSON.parse(line)));
    } catch (err) {
      throw new TraceParseError(path, index + 1, err);
    }
  }
  return spans;
}

export interface SpanTreeNode {
  span: Span;
  children: SpanTreeNode[];
}

/** Two spans claiming one id — the tree would be ambiguous. */
export class DuplicateSpanIdError extends Error {
  readonly spanId: string;

  constructor(spanId: string) {
    super(`Span id "${spanId}" appears more than once in the trace.`);
    this.name = "DuplicateSpanIdError";
    this.spanId = spanId;
  }
}

/**
 * Reconstruct the parent/child tree.
 *
 * A span whose `parentSpanId` is `null`, or names a span that is not in this trace, is a
 * ROOT — an orphan is surfaced as a second root rather than dropped, so a malformed
 * trace fails the "exactly one root" assertion instead of passing it quietly.
 */
export function buildSpanTree(spans: readonly Span[]): SpanTreeNode[] {
  const byId = new Map<string, SpanTreeNode>();
  for (const span of spans) {
    if (byId.has(span.spanId)) throw new DuplicateSpanIdError(span.spanId);
    byId.set(span.spanId, { span, children: [] });
  }
  const roots: SpanTreeNode[] = [];
  for (const node of byId.values()) {
    const parentId = node.span.parentSpanId;
    const parent = parentId === null ? undefined : byId.get(parentId);
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
  }
  const order = (a: SpanTreeNode, b: SpanTreeNode): number =>
    a.span.startedAt === b.span.startedAt
      ? a.span.spanId.localeCompare(b.span.spanId)
      : a.span.startedAt.localeCompare(b.span.startedAt);
  const sortDeep = (nodes: SpanTreeNode[]): void => {
    nodes.sort(order);
    for (const node of nodes) sortDeep(node.children);
  };
  sortDeep(roots);
  return roots;
}
