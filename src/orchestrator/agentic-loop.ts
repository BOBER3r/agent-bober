import type {
  LLMClient,
  ToolDef,
  ToolCall,
  ToolResult,
  Message,
  AssistantMessage,
  ToolResultMessage,
} from "../providers/types.js";

import type { ToolHandler } from "./tools/index.js";
import type { Effort } from "../config/schema.js";
import type { Budget } from "./workflow/budget.js";
import type { LoopEvent, LoopHooks, HookDecision } from "./loop-events.js";
import type { SessionStore } from "./session-store.js";
import { sessionForkId } from "./session-store.js";
import { logger } from "../utils/logger.js";
import { executeToolBatch } from "./tools/executor.js";
import { summarizeMessages } from "./compaction.js";
import { buildSubagentTool, type SubagentDef } from "./subagents.js";

export type { SubagentDef } from "./subagents.js";

// ── Types ──────────────────────────────────────────────────────────

export interface AgenticLoopParams {
  /** Provider-agnostic LLM client. */
  client: LLMClient;
  /** Model ID (resolved via model-resolver). */
  model: string;
  /** System prompt (loaded from agent .md file). */
  systemPrompt: string;
  /** Initial user message (task description, handoff, etc.). */
  userMessage: string;
  /** Tool schemas to pass to the API. */
  tools: ToolDef[];
  /** Handler functions for each tool, keyed by name. */
  toolHandlers: Map<string, ToolHandler>;
  /** Max tool-use round trips before stopping. */
  maxTurns: number;
  /** Per-message max_tokens. Defaults to 16384. */
  maxTokens?: number;
  /** Reasoning/output effort forwarded to ChatParams.effort (Anthropic only). */
  effort?: Effort;
  /**
   * Optional per-run spend ceiling. Charged per turn (tokens + costUsd); a hit
   * ceiling ends the run gracefully (stopReason 'budget_exceeded') rather than
   * throwing — see ADR-4. `assertWithinBudget()` is never called from the loop.
   */
  budget?: Budget;
  /**
   * When true, contiguous runs of read-only-annotated tool calls (per-tool
   * `ToolDef.readOnly === true`, derived once from `tools`) execute
   * concurrently within a turn; everything else stays strictly serial
   * (ADR-2). Absent/false (the default) is byte-identical to the pre-change
   * serial for-await loop — order, error shapes, and `onToolUse` behavior
   * are unchanged.
   */
  parallelReadOnlyTools?: boolean;
  /** Called when the model invokes a tool (for logging/progress). */
  onToolUse?: (name: string, input: unknown) => void;
  /** Called after each completed turn (for progress tracking). */
  onTurnComplete?: (turn: number, toolsCalled: string[]) => void;
  /**
   * Optional completion predicate. When the model ends a turn WITHOUT calling a
   * tool, the loop normally treats that as "done". Some OpenAI-compatible models
   * (e.g. DeepSeek) instead narrate intentions ("let me write the files...") and
   * stop without calling any tool — which would end the loop with no work done.
   *
   * When this predicate is provided and returns `false` for a tool-less turn,
   * the loop injects a nudge message (see `nudgeMessage`) and continues, up to
   * `maxNudges` times, instead of returning prematurely. When omitted, behavior
   * is unchanged (any tool-less turn ends the loop).
   */
  completionCheck?: (text: string) => boolean;
  /** Max nudges before giving up on an apparently-incomplete tool-less turn. Default 2. */
  maxNudges?: number;
  /** The nudge text appended when `completionCheck` fails. A sensible default is used if omitted. */
  nudgeMessage?: string;
  /**
   * Optional streaming text callback (sprint 8). Threaded into every chat call
   * as ChatParams.onTextDelta; the Anthropic adapter invokes it per text delta.
   * When onEvent is ALSO present, each delta additionally emits a
   * { type:"text-delta", turn, delta } LoopEvent. Absent (and no onEvent) => no
   * onTextDelta reaches chat, the adapter uses non-streaming create, byte-identical.
   */
  onTextDelta?: (delta: string) => void;
  /**
   * Optional structured event stream (agent-loop-capability-port sprint 5).
   * Emits a typed `LoopEvent` at each natural loop point (init, turn-start,
   * tool-start/tool-end, turn-end, result) — a pure host-side observation
   * channel that adds zero tokens to the conversation and never changes loop
   * behavior. A throwing `onEvent` is caught and logged, never crashes the
   * loop. Absent (the default) is byte-identical to omitting it entirely.
   */
  onEvent?: (event: LoopEvent) => void;
  /**
   * Optional host-side hooks (agent-loop-capability-port sprint 5):
   * `preToolUse` can veto a tool call (model gets an isError rejection, loop
   * continues), `postToolUse` observes each tool result, `onStop` observes
   * the final result exactly once. All observe-hooks are caught-and-logged
   * on throw; a throwing `preToolUse` is treated as a fail-closed deny.
   * Absent (the default) is byte-identical to omitting it entirely.
   */
  hooks?: LoopHooks;
  /**
   * Opt-in loop-transcript persistence (agent-loop-capability-port sprint 6).
   * When present, the loop saves the full `Message[]` transcript + metadata
   * to `.bober/sessions/<sessionId>.json` after every turn (crash-resumable).
   * A save failure is caught and logged, never crashes the run. Absent (the
   * default) is byte-identical — no files or directories are created.
   */
  session?: { store: SessionStore; sessionId: string };
  /**
   * A prior transcript to seed AHEAD of `userMessage` (loop resume). Use
   * `resumeSession()` to load this from a persisted session. Absent (the
   * default) is byte-identical to omitting it entirely.
   */
  initialMessages?: Message[];
  /**
   * Opt-in in-context auto-compaction (agent-loop-capability-port sprint 7).
   * When set and a turn's `response.usage.inputTokens` (the PER-REQUEST
   * prompt size, not a running total — a shrunken prompt naturally resets
   * this, avoiding thrash) exceeds `maxContextTokens`, the loop summarizes
   * older messages via ONE extra `client.chat` call, replacing the head with
   * a single summary message and keeping the last `keepRecentTurns * 2`
   * messages (default `2 * 2 = 4`) verbatim. The system prompt and the
   * turn's own pending tool exchange are never touched — compaction only
   * ever mutates `messages`. A failed summarization call fails open: logged,
   * skipped for that turn, the run continues uncompacted. Absent (the
   * default) => never compacts, byte-identical (sc-7-5).
   */
  compaction?: { maxContextTokens: number; keepRecentTurns?: number; instructions?: string };
  /**
   * Optional abort signal (agent-loop-capability-port sprint 9). A
   * web-standard `AbortSignal`. Checked at the top of every turn AND right
   * after each chat response (before tool execution) — an in-flight
   * Anthropic request is additionally cancelled mid-flight (threaded into
   * `ChatParams.abortSignal`). When it fires, the loop ends gracefully at
   * the next boundary/cancellation point with `stopReason: "aborted"` plus
   * accumulated partial usage/costUsd/turnsUsed — NEVER a throw or rejected
   * promise. Adapters without native cancellation (openai/google/claude-code)
   * simply ignore the field; their in-flight request completes, but the
   * loop discards that response at the post-response check rather than
   * using it for a further turn. Absent (the default) is byte-identical.
   */
  abortSignal?: AbortSignal;
  /**
   * Opt-in in-process scoped subagents (agent-loop-capability-port sprint 10).
   * When non-empty, a `spawn_subagent` ToolDef is registered whose handler
   * runs a NESTED `runAgenticLoop` with fresh context, the def's scoped tool
   * subset, per-agent model/effort/maxTurns, and the SAME `Budget` instance
   * (combined spend visible; a child cannot out-spend a parent ceiling).
   * One-level hard cap: children always get `subagents: undefined` — no
   * recursive nesting. Absent/empty => the tool list is byte-identical
   * (sc-10-4).
   */
  subagents?: SubagentDef[];
}

export interface AgenticLoopResult {
  /** The final text response from the model. */
  finalText: string;
  /** Total tool-use round trips completed. */
  turnsUsed: number;
  /** Names of all tools called across all turns. */
  toolsCalled: string[];
  /** Cumulative token usage. */
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  /** The stop reason of the final API response. */
  stopReason: string;
  /**
   * True only when the provider refused. Absent (not `false`) when no refusal
   * occurred, so non-refusal runs stay byte-identical. Write-capable roles
   * (generator/curator) MUST treat this as success:false (ADR-5).
   */
  refused?: boolean;
  /**
   * Cumulative USD cost summed across turns that reported a `costUsd`. Absent
   * (not `undefined`-valued — the key itself is omitted) when no turn reported
   * a cost, so cost-free runs stay byte-identical.
   */
  costUsd?: number;
}

// ── Transient-error retry ──────────────────────────────────────────

/** Max retry attempts for transient API failures before giving up. */
const MAX_CHAT_RETRIES = 5;

/**
 * Substrings that mark a *transient* failure worth retrying. Slower
 * OpenAI-compatible providers (e.g. DeepSeek) routinely drop a connection
 * mid-request ("terminated") or return 429/5xx under load. Auth errors (401),
 * bad requests (400), and the like are NOT listed here, so they fail fast.
 */
const TRANSIENT_ERROR_PATTERNS = [
  "terminated",
  "econnreset",
  "etimedout",
  "enotfound",
  "fetch failed",
  "socket hang up",
  "epipe",
  "network",
  "timeout",
  "overloaded",
  "rate limit",
  "429",
  "500",
  "502",
  "503",
  "504",
];

function isTransientError(message: string): boolean {
  const m = message.toLowerCase();
  return TRANSIENT_ERROR_PATTERNS.some((p) => m.includes(p));
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Thrown by `chatWithRetry` (agent-loop-capability-port sprint 9) when a chat
 * call fails because the run's `abortSignal` fired. Never retried and never
 * escapes `runAgenticLoop` — the loop's chat catch maps it to a graceful
 * `stopReason: "aborted"` return instead of `"error"`.
 */
export class AbortedError extends Error {
  constructor() {
    super("Run aborted.");
    this.name = "AbortedError";
  }
}

/**
 * Call client.chat() with exponential backoff on transient errors.
 * Non-transient errors are rethrown immediately (no point retrying a 401).
 */
async function chatWithRetry(
  client: LLMClient,
  params: Parameters<LLMClient["chat"]>[0],
  turn: number,
): Promise<Awaited<ReturnType<LLMClient["chat"]>>> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_CHAT_RETRIES; attempt++) {
    try {
      return await client.chat(params);
    } catch (err) {
      // An abort is terminal, never transient/retryable (sc-9-2). Checked
      // FIRST, before isTransientError. The primary signal is the caller's
      // own `abortSignal.aborted` flag — provider-agnostic and always true
      // when OUR signal caused the cancel. The Anthropic SDK's real abort
      // error (`APIUserAbortError`) does NOT set `err.name` to "AbortError"
      // (it stays "Error"), so `err.name === "AbortError"` is kept only as a
      // secondary guard for raw fetch/DOMException aborts and test doubles.
      if (
        params.abortSignal?.aborted === true ||
        (err instanceof Error && err.name === "AbortError")
      ) {
        throw new AbortedError();
      }
      lastErr = err;
      const message = err instanceof Error ? err.message : String(err);
      if (!isTransientError(message) || attempt === MAX_CHAT_RETRIES) {
        throw err;
      }
      const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 30_000);
      logger.warn(
        `Transient API error on turn ${turn} ` +
          `(attempt ${attempt}/${MAX_CHAT_RETRIES}): ${message}. ` +
          `Retrying in ${backoffMs}ms...`,
      );
      await sleep(backoffMs);
    }
  }
  throw lastErr;
}

// ── JSON-mode coercion ─────────────────────────────────────────────

export interface CoerceJsonParams {
  client: LLMClient;
  model: string;
  systemPrompt: string;
  /** The original task/user message that started the loop. */
  userMessage: string;
  /** The (non-JSON / wrong-shape) text the agentic loop produced, fed back for context. */
  priorText: string;
  /**
   * Final instruction telling the model EXACTLY what JSON to emit. Because we
   * use the provider's loose json_object mode (not strict json_schema — DeepSeek
   * rejects the latter), this instruction must spell out every required field;
   * json_object mode only guarantees the output is *a* valid JSON object.
   */
  instruction: string;
  maxTokens?: number;
}

/**
 * Force a structured-JSON response after an agentic loop failed to produce the
 * required object. Some OpenAI-compatible models (notably DeepSeek) either
 * narrate prose instead of JSON, or emit valid JSON of the WRONG shape (e.g.
 * following a short "summary" prompt instead of the full schema).
 *
 * Strategy: re-ask with `json_object` response_format (broadly supported,
 * including DeepSeek) plus an explicit field-by-field instruction. If the
 * provider rejects response_format at all (some servers 400 on it), fall back
 * to a plain prompt-only call — the instruction itself demands JSON-only output.
 *
 * Provider-agnostic and meant as a *fallback* after a normal parse attempt
 * fails, so it's a no-op for models that already comply (Claude).
 *
 * @returns The raw text of the coerced response (a JSON document). The caller
 *   still validates/repairs it against its domain schema.
 */
export async function coerceJsonOutput(
  params: CoerceJsonParams,
): Promise<string> {
  const {
    client,
    model,
    systemPrompt,
    userMessage,
    priorText,
    instruction,
    maxTokens = 16384,
  } = params;

  const messages: Message[] = [
    { role: "user", content: userMessage },
    { role: "assistant", content: priorText || "(no output produced)" },
    { role: "user", content: instruction },
  ];

  try {
    const response = await chatWithRetry(
      client,
      { model, system: systemPrompt, messages, jsonObjectMode: true, maxTokens },
      0,
    );
    return response.text;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Provider rejected response_format (e.g. DeepSeek 400 "response_format type
    // is unavailable"). Retry without it — the instruction still demands JSON.
    if (/response_format|json/i.test(message)) {
      logger.warn(
        `Provider rejected json_object mode (${message}); ` +
          `retrying coercion without response_format.`,
      );
      const response = await chatWithRetry(
        client,
        { model, system: systemPrompt, messages, maxTokens },
        0,
      );
      return response.text;
    }
    throw err;
  }
}

// ── Main loop ──────────────────────────────────────────────────────

/**
 * Run a multi-turn agentic conversation loop.
 *
 * The loop sends the initial user message, then iterates: if the model
 * responds with tool_use, we execute the tools and feed results back.
 * This continues until the model stops requesting tools or maxTurns
 * is exceeded.
 *
 * Uses provider-agnostic types throughout. The LLMClient implementation
 * handles all conversion to/from provider-specific formats.
 *
 * @returns The final text response and metadata about the conversation.
 */
export async function runAgenticLoop(
  params: AgenticLoopParams,
): Promise<AgenticLoopResult> {
  const {
    client,
    model,
    systemPrompt,
    userMessage,
    maxTurns,
    maxTokens = 16384,
    effort,
    budget,
    parallelReadOnlyTools,
    onToolUse,
    onTurnComplete,
    completionCheck,
    maxNudges = 2,
    nudgeMessage,
    onTextDelta,
    onEvent,
    hooks,
    session,
    initialMessages,
    compaction,
    abortSignal,
  } = params;

  // Locally-augmentable tool set (sprint 10). When `params.subagents` is
  // absent/empty, `tools`/`toolHandlers` keep the SAME reference as
  // `params.tools`/`params.toolHandlers` — so `readOnlyTools` below and every
  // `chat` call's `tools` argument stay byte-identical to the pre-sprint-10
  // behavior (sc-10-4). Registered BEFORE `readOnlyTools` is derived so the
  // spawn_subagent tool itself participates in that derivation (it is never
  // marked readOnly — ADR-2).
  let tools = params.tools;
  let toolHandlers = params.toolHandlers;
  if (params.subagents && params.subagents.length > 0) {
    const { tool, handler } = buildSubagentTool(params.subagents, params, {
      runLoop: runAgenticLoop,
    });
    tools = [...params.tools, tool];
    toolHandlers = new Map(params.toolHandlers);
    toolHandlers.set(tool.name, handler);
  }

  // Derived once, from the caller-supplied tool schemas — the loop never
  // hard-codes a tool-name allow-list (ADR-2). Absent `readOnly` => not in
  // the set => always serial for that tool, regardless of the flag.
  const readOnlyTools = new Set(
    tools.filter((t) => t.readOnly === true).map((t) => t.name),
  );

  const messages: Message[] = [
    ...(initialMessages ?? []),
    { role: "user", content: userMessage },
  ];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd: number | undefined;
  const allToolsCalled: string[] = [];
  let finalText = "";
  let nudgesUsed = 0;

  // Persist the transcript to the opted-in session store, swallowing (and
  // logging) any save failure — persistence is a convenience, and losing a
  // transcript write must never fail an otherwise-successful run (sc-6-1).
  // A no-op when `session` is absent, so calling this unconditionally at
  // every turn boundary keeps the no-session path byte-identical (sc-6-4).
  const persistSession = async (
    turnsUsed: number,
    extraMessages: Message[] = [],
  ): Promise<void> => {
    if (!session) return;
    try {
      await session.store.save({
        sessionId: session.sessionId,
        model,
        turnsUsed,
        messages: extraMessages.length > 0 ? [...messages, ...extraMessages] : messages,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        `Session persistence failed for '${session.sessionId}' (swallowed): ${message}`,
      );
    }
  };

  // Emit a LoopEvent, swallowing (and logging) any throw from the consumer —
  // an observe-only channel must never crash the loop (sc-5-4).
  const safeEmit = (event: LoopEvent): void => {
    if (!onEvent) return;
    try {
      onEvent(event);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`onEvent hook threw (swallowed): ${message}`);
    }
  };

  // Every stop path routes through here so `result` fires and `onStop` runs
  // exactly once, regardless of which of the 4 returns below is taken.
  async function finish(result: AgenticLoopResult): Promise<AgenticLoopResult> {
    safeEmit({ type: "result", stopReason: result.stopReason, turnsUsed: result.turnsUsed });
    if (hooks?.onStop) {
      try {
        await hooks.onStop(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`onStop hook threw (swallowed): ${message}`);
      }
    }
    return result;
  }

  // Aborted-run result (sprint 9). Mirrors the `budget_exceeded` shape at
  // line ~560 below, reusing the SAME usage/cost accumulators so partial
  // telemetry is preserved (sc-9-3). `turnsUsed` is the count of FULLY
  // completed turns — the in-progress/discarded turn is never counted, same
  // discipline as the existing `stopReason: "error"` catch (which also uses
  // `turn - 1`).
  const abortedResult = (turnsUsed: number): AgenticLoopResult => ({
    finalText: finalText || "Run aborted before completion. Partial result returned.",
    turnsUsed,
    toolsCalled: allToolsCalled,
    usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
    stopReason: "aborted",
    ...(totalCostUsd !== undefined ? { costUsd: totalCostUsd } : {}),
  });

  safeEmit({ type: "init", model, maxTurns });

  for (let turn = 1; turn <= maxTurns; turn++) {
    // Turn-boundary abort check (sc-9-1): fires BEFORE the next chat call is
    // ever made, so an abort between turns costs zero further chat calls.
    if (abortSignal?.aborted) {
      await persistSession(turn - 1);
      return finish(abortedResult(turn - 1));
    }

    logger.debug(`Agentic loop turn ${turn}/${maxTurns}...`);
    safeEmit({ type: "turn-start", turn });

    // Combined per-turn delta callback: emits the text-delta LoopEvent FIRST
    // (safeEmit self-catches), then the caller's onTextDelta (adapter wraps
    // this in try/catch), so a throwing caller callback never suppresses the
    // loop event. Defined INSIDE the loop so it captures the current `turn`.
    // Left undefined when neither onTextDelta nor onEvent is set, so the
    // no-callback path never carries an `onTextDelta` key (byte-identical).
    const emitTextDelta =
      onTextDelta !== undefined || onEvent !== undefined
        ? (delta: string): void => {
            safeEmit({ type: "text-delta", turn, delta });
            onTextDelta?.(delta);
          }
        : undefined;

    let response;
    try {
      response = await chatWithRetry(
        client,
        {
          model,
          system: systemPrompt,
          messages,
          tools: tools.length > 0 ? tools : undefined,
          maxTokens,
          ...(effort !== undefined ? { effort } : {}),
          ...(emitTextDelta ? { onTextDelta: emitTextDelta } : {}),
          ...(abortSignal !== undefined ? { abortSignal } : {}),
        },
        turn,
      );
    } catch (err) {
      // An abort is terminal, not an error (sc-9-2/9-3): chatWithRetry
      // rethrows AbortedError immediately (never retried) whenever the
      // signal caused the failure. Also guard on the flag directly for
      // provider-agnostic robustness (a non-Anthropic adapter might reject
      // for its own reasons right as the signal fires).
      if (err instanceof AbortedError || abortSignal?.aborted) {
        await persistSession(turn - 1);
        return finish(abortedResult(turn - 1));
      }

      // Handle context window exhaustion or other API errors
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`Agentic loop API error on turn ${turn}: ${message}`);

      await persistSession(turn - 1);
      return finish({
        finalText: finalText || `Error on turn ${turn}: ${message}`,
        turnsUsed: turn - 1,
        toolsCalled: allToolsCalled,
        usage: {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
        },
        stopReason: "error",
        ...(totalCostUsd !== undefined ? { costUsd: totalCostUsd } : {}),
      });
    }

    // Post-response abort check (sc-9-4): a non-cancellable adapter's request
    // may have completed anyway after the signal fired mid-flight. Discard
    // this response entirely — do not accumulate usage, do not compact, and
    // do not execute its tool batch. `turnsUsed` only ever counts fully
    // completed turns, so this uses `turn - 1`, same as the chat-catch above.
    if (abortSignal?.aborted) {
      await persistSession(turn - 1);
      return finish(abortedResult(turn - 1));
    }

    // Accumulate usage
    totalInputTokens += response.usage.inputTokens;
    totalOutputTokens += response.usage.outputTokens;

    // Accumulate cost (only tracks a sum when at least one turn reports cost)
    if (response.costUsd !== undefined) {
      totalCostUsd = (totalCostUsd ?? 0) + response.costUsd;
    }

    // Charge the budget (tokens + USD) once per turn. `chargeUsd`/`chargeTokens`
    // are no-op-safe on missing/non-finite input. ADR-4: a hit ceiling ends the
    // run gracefully — the loop NEVER throws and NEVER calls assertWithinBudget().
    budget?.chargeTokens(response.usage);
    budget?.chargeUsd(response.costUsd ?? 0);

    // In-context auto-compaction (agent-loop-capability-port sprint 7). Trigger
    // on the PER-REQUEST prompt size (response.usage.inputTokens), never the
    // running total — a shrunken prompt then naturally resets the trigger
    // (anti-thrash). Only worth doing when the loop will make another request
    // (tool_use); the final completion turn never pays for a useless summary.
    // Placed BEFORE the exceeded() gate below so the summarizer's own charge is
    // caught by the SAME post-turn budget check, with no new exit path.
    if (
      compaction &&
      response.stopReason === "tool_use" &&
      response.usage.inputTokens > compaction.maxContextTokens
    ) {
      const keep = (compaction.keepRecentTurns ?? 2) * 2;
      if (messages.length > keep) {
        const head = messages.slice(0, messages.length - keep);
        const outcome = await summarizeMessages({
          client,
          model,
          head,
          instructions: compaction.instructions,
        });
        if (outcome) {
          const before = messages.length;
          // Replace the head in place with the single summary message; splice
          // preserves the tail's object identity so the recent turns stay
          // deep-equal (sc-7-1). `messages` is declared `const`.
          messages.splice(0, head.length, outcome.summaryMessage);

          // Charge the extra call to the SAME accumulators/Budget used for
          // every other turn (sc-7-3).
          totalInputTokens += outcome.usage.inputTokens;
          totalOutputTokens += outcome.usage.outputTokens;
          if (outcome.costUsd !== undefined) {
            totalCostUsd = (totalCostUsd ?? 0) + outcome.costUsd;
          }
          budget?.chargeTokens(outcome.usage);
          budget?.chargeUsd(outcome.costUsd ?? 0);

          safeEmit({
            type: "compact-boundary",
            turn,
            messagesBefore: before,
            messagesAfter: messages.length,
            inputTokensAtTrigger: response.usage.inputTokens,
          });
        }
        // outcome === undefined => the summarizer failed; summarizeMessages
        // already logged. Fail open: skip compaction this turn, continue
        // uncompacted (sc-7-4) — no message is ever dropped without a summary.
      }
    }

    if (budget?.exceeded()) {
      logger.warn(`Agentic loop hit budget ceiling on turn ${turn}. Returning partial result.`);
      await persistSession(turn);
      return finish({
        finalText:
          finalText ||
          "Budget ceiling reached before completion. Partial result returned.",
        turnsUsed: turn,
        toolsCalled: allToolsCalled,
        usage: {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
        },
        stopReason: "budget_exceeded",
        ...(totalCostUsd !== undefined ? { costUsd: totalCostUsd } : {}),
      });
    }

    const turnStopReason = response.stopReason;

    // If the model is done (no more tool use), return — UNLESS a completion
    // predicate says this tool-less turn isn't actually complete (model narrated
    // intentions instead of acting). In that case, nudge it to act and continue.
    if (response.stopReason !== "tool_use") {
      finalText = response.text;

      const incomplete =
        completionCheck !== undefined &&
        !completionCheck(finalText) &&
        nudgesUsed < maxNudges;

      if (incomplete) {
        nudgesUsed += 1;
        logger.warn(
          `Model ended turn ${turn} without calling a tool and without ` +
            `completing (nudge ${nudgesUsed}/${maxNudges}). Prompting it to continue.`,
        );
        messages.push({ role: "assistant", content: finalText });
        messages.push({
          role: "user",
          content:
            nudgeMessage ??
            "You stopped without calling any tool and without producing your " +
              "final result. If work remains, CALL THE APPROPRIATE TOOL now to " +
              "do it (do not describe what you would do — actually call the tool). " +
              "If you are genuinely finished, output ONLY your final result now.",
        });
        continue;
      }

      // A refusal is a normal (non-throwing) response, not a transient error —
      // detect it here at the completion branch, never in chatWithRetry.
      const refused = turnStopReason === "refusal";

      // A tool-less completion turn calls no tools, but it is still "a turn"
      // — emit its turn-end symmetrically with the tool-turn case below.
      safeEmit({ type: "turn-end", turn, toolsCalled: [] });

      // This completion path never pushes its assistant text onto `messages`
      // (the loop is about to return, so there's no next turn to read it
      // back) — pass it as an extra so the persisted transcript still
      // captures the final answer (sc-6-1). `messages` itself is untouched,
      // so the no-session path stays byte-identical.
      await persistSession(turn, [{ role: "assistant", content: finalText }]);

      return finish({
        finalText,
        turnsUsed: turn,
        toolsCalled: allToolsCalled,
        usage: {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
        },
        stopReason: turnStopReason,
        ...(refused ? { refused: true } : {}),
        ...(totalCostUsd !== undefined ? { costUsd: totalCostUsd } : {}),
      });
    }

    // Model wants to use tools — append the assistant's full response
    // (text + tool calls) as an AssistantMessage.
    const assistantMessage: AssistantMessage = {
      role: "assistant",
      content: response.text,
      toolCalls: response.toolCalls,
    };
    messages.push(assistantMessage);

    // Name accumulation MUST follow input order regardless of parallelism —
    // done up front, in a dedicated pass, so it's unaffected by the executor's
    // internal concurrency.
    const turnTools = response.toolCalls.map((tc) => tc.name);
    allToolsCalled.push(...turnTools);

    // Tool-level event/hook callbacks for this turn (sprint 5). Each is left
    // `undefined` when its underlying capability (onEvent / hooks) is unset,
    // so `executeToolBatch`/`executeOne` take their pre-sprint-5 code path
    // exactly — byte-identical when nothing new is configured (sc-5-5).
    const onToolStart = onEvent
      ? (call: ToolCall): void => {
          safeEmit({ type: "tool-start", turn, name: call.name, input: call.input, toolUseId: call.id });
        }
      : undefined;

    const onToolEnd = onEvent
      ? (call: ToolCall, result: ToolResult): void => {
          safeEmit({ type: "tool-end", turn, name: call.name, toolUseId: call.id, isError: result.isError === true });
        }
      : undefined;

    // Fail-closed: a throwing preToolUse is treated as a deny, never as a
    // crash (sc-5-4). Veto-only — never transforms `call.input` (nonGoal).
    const preToolUseHook = hooks?.preToolUse;
    const preToolUse = preToolUseHook
      ? async (call: ToolCall): Promise<HookDecision> => {
          try {
            return await preToolUseHook({ name: call.name, input: call.input, toolUseId: call.id });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger.warn(`preToolUse hook threw (treated as fail-closed deny): ${message}`);
            return { allow: false, reason: "hook error (fail-closed)" };
          }
        }
      : undefined;

    // Swallow-and-log: a throwing postToolUse never crashes the loop (sc-5-4).
    const postToolUseHook = hooks?.postToolUse;
    const postToolUse = postToolUseHook
      ? async (call: ToolCall, result: ToolResult): Promise<void> => {
          try {
            await postToolUseHook({ name: call.name, input: call.input, toolUseId: call.id }, result);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger.warn(`postToolUse hook threw (swallowed): ${message}`);
          }
        }
      : undefined;

    // Execute each tool and collect results — delegated to executeToolBatch,
    // which runs contiguous read-only-annotated runs concurrently when
    // `parallelReadOnlyTools` is true, and everything else strictly serially
    // (byte-identical to the old for-await loop when the flag is off).
    const toolResults = await executeToolBatch({
      toolCalls: response.toolCalls,
      toolHandlers,
      readOnlyTools,
      parallel: parallelReadOnlyTools === true,
      onToolUse,
      onToolStart,
      onToolEnd,
      preToolUse,
      postToolUse,
    });

    // Append tool results as a ToolResultMessage (user role).
    // The adapter converts this to provider-specific format.
    const toolResultMessage: ToolResultMessage = {
      role: "user",
      toolResults,
    };
    messages.push(toolResultMessage);

    // Crash-resumable snapshot: `messages` now holds this turn's assistant
    // message AND tool results (sc-6-1).
    await persistSession(turn);

    onTurnComplete?.(turn, turnTools);
    safeEmit({ type: "turn-end", turn, toolsCalled: turnTools });
  }

  // Max turns exceeded — return what we have
  logger.warn(
    `Agentic loop exceeded max turns (${maxTurns}). Returning partial result.`,
  );

  // Covers the edge case where the last iteration ended via the nudge path
  // (pushed messages but `continue`d without an intervening save).
  await persistSession(maxTurns);

  return finish({
    finalText:
      finalText ||
      "Max turns exceeded. The agent ran out of tool-use budget before completing.",
    turnsUsed: maxTurns,
    toolsCalled: allToolsCalled,
    usage: {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
    },
    stopReason: "max_turns_exceeded",
    ...(totalCostUsd !== undefined ? { costUsd: totalCostUsd } : {}),
  });
}

// ── Session resume / fork (sprint 6) ────────────────────────────────────

/**
 * Load a persisted transcript so a NEW `runAgenticLoop` call can continue it
 * with full prior context: pass the returned `initialMessages` (seeded
 * AHEAD of the new `userMessage`) alongside `session: { store, sessionId }`
 * so new turns append to the same session file.
 *
 * Never throws. A missing or corrupt session file returns a typed
 * `{ error }` result instead — conceptually aligned with the loop's own
 * `stopReason: "error"` path, but this runs BEFORE the loop starts, so it is
 * a separate discriminated-union return, not a shared code path. The loop is
 * never started on the error branch, so no empty session ever silently
 * replaces the requested one (sc-6-5).
 */
export async function resumeSession(
  store: SessionStore,
  sessionId: string,
): Promise<{ initialMessages: Message[]; sessionId: string } | { error: string }> {
  const record = await store.load(sessionId);
  if (!record) {
    return { error: `Session '${sessionId}' not found or corrupt.` };
  }
  return { initialMessages: record.messages, sessionId };
}

/**
 * Copy the transcript at `sessionId` into a new session file so a new
 * `runAgenticLoop` invocation can branch from it without mutating the
 * original (sc-6-3). `newId` may be supplied explicitly (e.g. by tests);
 * when omitted, a deterministic id is derived from `sessionId` + the
 * store's injected clock (`sessionForkId` — no argless randomness).
 *
 * @returns The new session id (== `newId` when supplied).
 */
export async function forkSession(
  store: SessionStore,
  sessionId: string,
  newId?: string,
): Promise<string> {
  const targetId = newId ?? sessionForkId(sessionId, store.now());
  return store.fork(sessionId, targetId);
}
