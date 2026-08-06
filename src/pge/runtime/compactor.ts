import { join } from "node:path";

import { z } from "zod";

import type { LLMClient } from "../../providers/types.js";
import type { GraphMessage } from "../state/overall.js";
import { assertSafePathSegment, atomicWriteFile } from "./scratch.js";
import { estimateMessages } from "./token-estimator.js";
import type { TokenEstimator } from "./token-estimator.js";

/**
 * Graph-scoped context compaction, fired at a superstep boundary.
 *
 * ── This is a SECOND compactor, and the first one is not touched ──
 *
 * `src/orchestrator/compaction.ts` compacts the live imperative agent loop, in-turn,
 * mid-run. It is untouched by this sprint (an explicit non-goal) and nothing here imports
 * it. What IS borrowed from it is its posture: ONE `client.chat` call, no `tools` passed
 * (so no adapter is handed tool_use blocks without a tool list), a bounded `maxTokens`,
 * and a fail-open catch around the call so an unreachable provider degrades the run
 * instead of ending it.
 *
 * The provider types are `import type` only. `src/pge/**` gains no runtime edge to the
 * provider layer, so the zero-execution probe over the `bober pge` import graph stays
 * true by construction rather than by care.
 *
 * ── Fail-open is scoped to the CALL, not to the result ──
 *
 * A `client.chat` that throws yields {@link SummariserUnavailable}: the run continues
 * uncompacted, exactly as `summarizeMessages` returns `undefined`. A response that comes
 * back and does NOT carry `activeGoals`, `completedTasks` and `workspacePath` throws
 * {@link ContextSummaryInvalidError}. The distinction is deliberate: an unreachable
 * provider is an environment condition, while a summary missing its workspace path is a
 * WRONG summary, and silently adopting it would make the post-compression baseline a
 * measurement of something nobody can name.
 *
 * ── The transcript is written BEFORE anything is summarised ──
 *
 * {@link compactGraphContext} writes `.bober/logs/<runId>/messages-<n>.jsonl` before it
 * calls the model. Written after, the file would be an artifact of a successful
 * compaction and would prove nothing about auditability: the case where you need the
 * uncompressed transcript most is the case where the compaction went wrong.
 *
 * ── What compaction does NOT do: shrink `messages` ──
 *
 * The `messages` channel is reduced by `appendById`, a MONOTONE UNION —
 * `merge(current, updates)` can never remove a member of `current` — and `messages` is not
 * one of the commit boundary's three control keys. A `Command.update` returning
 * `{ messages: [summary, ...tail] }` therefore does NOT replace the transcript; it unions
 * the summary in and keeps every existing message.
 *
 * That is by design, not a limitation worked around. `state.messages` stays the full
 * append-only audit record. Compaction produces a DERIVED WORKING WINDOW —
 * {@link GraphCompactionResult.summaryMessage} plus {@link GraphCompactionResult.tail} —
 * and {@link GraphCompactionResult.baselineTokens} is measured on THAT window. A reader
 * expecting `state.messages` to have shrunk after a compaction is reading the wrong
 * value; the window is the post-compression context, the channel is the history.
 */

// ── Ratios ──────────────────────────────────────────────────────────

/** Fraction of the cap above which compaction fires (R29). Configurable; default 85%. */
export const COMPACTION_TRIGGER_RATIO = 0.85;

/** Fraction of the cap re-injected as the most recent messages (R31). Default 10%. */
export const REINJECTION_RATIO = 0.1;

/** Bounded output for the one summarisation call, mirroring `compaction.ts`. */
export const DEFAULT_SUMMARY_MAX_TOKENS = 4096;

// ── Summary schema ──────────────────────────────────────────────────

/**
 * What a compaction summary must carry.
 *
 * All three are `.min(1)` at both levels for the reason {@link PhaseDigestSchema} is:
 * `activeGoals: [""]` would satisfy a bare presence check and tell a successor nothing.
 * `workspacePath` in particular is what lets a resumed context know WHERE it is working;
 * a summary without it is the failure mode sc-10-7 pins.
 */
export const ContextSummarySchema = z.object({
  activeGoals: z.array(z.string().min(1)).min(1),
  completedTasks: z.array(z.string().min(1)).min(1),
  workspacePath: z.string().min(1),
});
export type ContextSummary = z.infer<typeof ContextSummarySchema>;

/** The summariser returned something that is not a {@link ContextSummary}. */
export class ContextSummaryInvalidError extends Error {
  readonly issues: readonly string[];
  readonly paths: readonly string[];

  constructor(issues: readonly string[], paths: readonly string[]) {
    super(`Compaction summary failed validation:\n${issues.join("\n")}`);
    this.name = "ContextSummaryInvalidError";
    this.issues = issues;
    this.paths = paths;
  }
}

/** Parse a summariser response, raising the failing Zod paths rather than swallowing them. */
export function parseContextSummary(value: unknown): ContextSummary {
  const result = ContextSummarySchema.safeParse(value);
  if (!result.success) {
    const paths = result.error.issues.map((issue) => issue.path.join("."));
    const issues = result.error.issues.map(
      (issue, index) => `  - ${paths[index] === "" ? "<root>" : paths[index]}: ${issue.message}`,
    );
    throw new ContextSummaryInvalidError(issues, paths);
  }
  return result.data;
}

/** Deterministic prose form of a summary — what gets re-injected and what gets measured. */
export function renderContextSummary(summary: ContextSummary): string {
  return [
    "[Context summary]",
    `Workspace: ${summary.workspacePath}`,
    "Active goals:",
    ...summary.activeGoals.map((goal) => `- ${goal}`),
    "Completed tasks:",
    ...summary.completedTasks.map((task) => `- ${task}`),
  ].join("\n");
}

// ── Threshold ───────────────────────────────────────────────────────

export interface CompactionDecision {
  /** Estimated tokens of the message window, through the injected estimator. */
  readonly tokens: number;
  readonly cap: number;
  readonly triggerRatio: number;
  /** `floor(cap * triggerRatio)`. Compaction fires strictly ABOVE this. */
  readonly threshold: number;
  readonly shouldCompact: boolean;
  readonly estimatorId: string;
}

/** A cap that is not a positive finite number. */
export class InvalidContextCapError extends Error {
  constructor(cap: number) {
    super(`Context cap must be a finite number greater than zero; received ${String(cap)}.`);
    this.name = "InvalidContextCapError";
  }
}

/**
 * Should the window be compacted?
 *
 * Every number here flows from `estimator`: `tokens` is
 * {@link estimateMessages}, which sums the estimator's answer over message TEXT and never
 * reads `GraphMessage.tokens`. Swap the estimator and `tokens` moves, so `shouldCompact`
 * moves with it — which is the whole of sc-10-10 and is only true because nothing in this
 * function has a token count of its own.
 *
 * Strictly greater than the threshold, so a window sitting exactly ON the boundary does
 * not compact. An inclusive comparison would make the 84/86 pair depend on which side of
 * a rounding step the estimator landed.
 */
export function decideCompaction(
  messages: readonly GraphMessage[],
  cap: number,
  estimator: TokenEstimator,
  triggerRatio: number = COMPACTION_TRIGGER_RATIO,
): CompactionDecision {
  if (!Number.isFinite(cap) || cap <= 0) throw new InvalidContextCapError(cap);
  const tokens = estimateMessages(messages, estimator);
  const threshold = Math.floor(cap * triggerRatio);
  return {
    tokens,
    cap,
    triggerRatio,
    threshold,
    shouldCompact: tokens > threshold,
    estimatorId: estimator.id,
  };
}

// ── Transcript log ──────────────────────────────────────────────────

/** `.bober/logs/<runId>/` — already git-ignored; this layer is its first writer. */
export function transcriptLogDir(projectRoot: string, runId: string): string {
  assertSafePathSegment("runId", runId);
  return join(projectRoot, ".bober", "logs", runId);
}

/** `.bober/logs/<runId>/messages-<n>.jsonl`, one file per compaction of the run. */
export function transcriptLogPath(projectRoot: string, runId: string, index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError(`Compaction index must be a non-negative integer; received ${String(index)}.`);
  }
  return join(transcriptLogDir(projectRoot, runId), `messages-${String(index)}.jsonl`);
}

/**
 * One message per line, JSON, trailing newline.
 *
 * Keys are emitted in a FIXED order rather than whatever `JSON.stringify` finds on the
 * object, so the same messages render to the same bytes and the byte-for-byte
 * recoverability assertion is a statement about the transcript rather than about object
 * construction order. Optional keys are omitted when absent, never emitted as `null`.
 */
export function renderTranscriptJsonl(messages: readonly GraphMessage[]): string {
  const lines = messages.map((message) => {
    const ordered: Record<string, unknown> = {
      id: message.id,
      seq: message.seq,
      role: message.role,
      nodeId: message.nodeId,
      tokens: message.tokens,
    };
    if (message.text !== undefined) ordered.text = message.text;
    if (message.textRef !== undefined) ordered.textRef = message.textRef;
    return JSON.stringify(ordered);
  });
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

export interface WrittenTranscript {
  readonly path: string;
  /** The EXACT string written. A test compares this against `readFile(path, "utf8")`. */
  readonly bytes: string;
}

/** Write the pre-compression transcript atomically and return exactly what went to disk. */
export async function writeTranscript(
  projectRoot: string,
  runId: string,
  index: number,
  messages: readonly GraphMessage[],
): Promise<WrittenTranscript> {
  const path = transcriptLogPath(projectRoot, runId, index);
  const bytes = renderTranscriptJsonl(messages);
  await atomicWriteFile(path, bytes);
  return { path, bytes };
}

// ── Tail selection ──────────────────────────────────────────────────

export interface SelectedTail {
  readonly tail: readonly GraphMessage[];
  readonly tokens: number;
  readonly budget: number;
}

/**
 * The most recent messages that fit `floor(cap * reinjectionRatio)`.
 *
 * Walked from the END, and a message is admitted only if it fits WHOLE. Half a message is
 * not a smaller message, it is a corrupted one, and a re-injection window that can contain
 * a truncated turn is not a window a successor can reason about.
 */
export function selectTail(
  messages: readonly GraphMessage[],
  cap: number,
  estimator: TokenEstimator,
  reinjectionRatio: number = REINJECTION_RATIO,
): SelectedTail {
  if (!Number.isFinite(cap) || cap <= 0) throw new InvalidContextCapError(cap);
  const budget = Math.floor(cap * reinjectionRatio);
  const tail: GraphMessage[] = [];
  let tokens = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const cost = estimator.estimate(messages[i].text ?? "");
    if (tokens + cost > budget) break;
    tokens += cost;
    tail.unshift(messages[i]);
  }
  return { tail, tokens, budget };
}

// ── Compaction ──────────────────────────────────────────────────────

const SUMMARY_SYSTEM =
  "Summarize this conversation as JSON with exactly the keys activeGoals (string[]), " +
  "completedTasks (string[]) and workspacePath (string). Preserve the task objective, " +
  "the file paths touched and the decisions made. Be concise and factual.";

export interface GraphCompactionParams {
  readonly client: LLMClient;
  readonly model: string;
  readonly messages: readonly GraphMessage[];
  /** The model's maximum input capacity, in the SAME estimator's tokens. */
  readonly cap: number;
  readonly estimator: TokenEstimator;
  readonly projectRoot: string;
  readonly runId: string;
  /** Which compaction of this run this is. Names the transcript file. */
  readonly index: number;
  readonly triggerRatio?: number;
  readonly reinjectionRatio?: number;
  readonly maxTokens?: number;
  /** Injected, so the summary message's id and the run's spans agree on time. */
  readonly now?: () => Date;
}

/** Below the threshold. Nothing was summarised and NOTHING WAS WRITTEN. */
export interface BelowThreshold {
  readonly kind: "below-threshold";
  readonly decision: CompactionDecision;
}

/** The summarisation call failed. The transcript is on disk; the run continues uncompacted. */
export interface SummariserUnavailable {
  readonly kind: "summariser-unavailable";
  readonly decision: CompactionDecision;
  readonly transcriptPath: string;
  readonly reason: string;
}

export interface GraphCompactionResult {
  readonly kind: "compacted";
  readonly decision: CompactionDecision;
  readonly summary: ContextSummary;
  /** The summary as a NEW message. `appendById` unions it in; nothing is removed. */
  readonly summaryMessage: GraphMessage;
  readonly tail: readonly GraphMessage[];
  /** `estimate(summary) + estimate(tail)` — the post-compression working window. */
  readonly baselineTokens: number;
  readonly summaryTokens: number;
  readonly tailTokens: number;
  readonly reinjectionBudget: number;
  readonly transcriptPath: string;
  /** Exactly the bytes written, for a byte-for-byte comparison against the file. */
  readonly transcriptBytes: string;
}

export type GraphCompactionOutcome =
  | BelowThreshold
  | SummariserUnavailable
  | GraphCompactionResult;

/** The message id every compaction of a run writes. Deterministic, so a replay unions rather than duplicates. */
export function compactionMessageId(index: number): string {
  return `compaction-${String(index)}`;
}

/**
 * Decide, archive the transcript, summarise, and select the re-injection tail.
 *
 * The order of the first two steps is load-bearing and is asserted by the suite:
 *
 *  1. {@link decideCompaction}. Below the threshold, return immediately — no file is
 *     created, so a run that never crosses the threshold leaves no `.bober/logs/` tree.
 *  2. Write the FULL pre-compression transcript to disk, and keep the exact bytes.
 *  3. One `client.chat`, no tools, bounded output, fail-open.
 *  4. Validate the response. A malformed summary throws.
 *  5. Select the tail and compute the baseline.
 */
export async function compactGraphContext(
  params: GraphCompactionParams,
): Promise<GraphCompactionOutcome> {
  const {
    client,
    model,
    messages,
    cap,
    estimator,
    projectRoot,
    runId,
    index,
    triggerRatio = COMPACTION_TRIGGER_RATIO,
    reinjectionRatio = REINJECTION_RATIO,
    maxTokens = DEFAULT_SUMMARY_MAX_TOKENS,
  } = params;

  const decision = decideCompaction(messages, cap, estimator, triggerRatio);
  if (!decision.shouldCompact) return { kind: "below-threshold", decision };

  const written = await writeTranscript(projectRoot, runId, index, messages);

  let raw: string;
  try {
    const response = await client.chat({
      model,
      system: SUMMARY_SYSTEM,
      messages: [{ role: "user", content: written.bytes }],
      maxTokens,
    });
    raw = response.text;
  } catch (error) {
    // Fail-open, and ONLY here. Mirrors `summarizeMessages`'s catch: the caller keeps
    // going uncompacted rather than losing the run to an unreachable provider.
    return {
      kind: "summariser-unavailable",
      decision,
      transcriptPath: written.path,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw;
  }
  const summary = parseContextSummary(parsed);

  const summaryText = renderContextSummary(summary);
  const summaryTokens = estimator.estimate(summaryText);
  const selected = selectTail(messages, cap, estimator, reinjectionRatio);

  const maxSeq = messages.reduce((high, message) => Math.max(high, message.seq), -1);
  const summaryMessage: GraphMessage = {
    id: compactionMessageId(index),
    seq: maxSeq + 1,
    role: "system",
    nodeId: "context_compact",
    text: summaryText,
    tokens: summaryTokens,
  };

  return {
    kind: "compacted",
    decision,
    summary,
    summaryMessage,
    tail: selected.tail,
    baselineTokens: summaryTokens + selected.tokens,
    summaryTokens,
    tailTokens: selected.tokens,
    reinjectionBudget: selected.budget,
    transcriptPath: written.path,
    transcriptBytes: written.bytes,
  };
}
