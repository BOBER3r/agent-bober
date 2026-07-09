import type { LLMClient, ToolDef, Message, AssistantMessage, ToolResultMessage, ToolResult } from "../providers/types.js";

import type { ToolHandler } from "./tools/index.js";
import type { Effort } from "../config/schema.js";
import type { Budget } from "./workflow/budget.js";
import { logger } from "../utils/logger.js";

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
    tools,
    toolHandlers,
    maxTurns,
    maxTokens = 16384,
    effort,
    budget,
    onToolUse,
    onTurnComplete,
    completionCheck,
    maxNudges = 2,
    nudgeMessage,
  } = params;

  const messages: Message[] = [
    { role: "user", content: userMessage },
  ];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd: number | undefined;
  const allToolsCalled: string[] = [];
  let finalText = "";
  let nudgesUsed = 0;

  for (let turn = 1; turn <= maxTurns; turn++) {
    logger.debug(`Agentic loop turn ${turn}/${maxTurns}...`);

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
        },
        turn,
      );
    } catch (err) {
      // Handle context window exhaustion or other API errors
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`Agentic loop API error on turn ${turn}: ${message}`);

      return {
        finalText: finalText || `Error on turn ${turn}: ${message}`,
        turnsUsed: turn - 1,
        toolsCalled: allToolsCalled,
        usage: {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
        },
        stopReason: "error",
        ...(totalCostUsd !== undefined ? { costUsd: totalCostUsd } : {}),
      };
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
    if (budget?.exceeded()) {
      logger.warn(`Agentic loop hit budget ceiling on turn ${turn}. Returning partial result.`);
      return {
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
      };
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

      return {
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
      };
    }

    // Model wants to use tools — append the assistant's full response
    // (text + tool calls) as an AssistantMessage.
    const assistantMessage: AssistantMessage = {
      role: "assistant",
      content: response.text,
      toolCalls: response.toolCalls,
    };
    messages.push(assistantMessage);

    // Execute each tool and collect results
    const toolResults: ToolResult[] = [];
    const turnTools: string[] = [];

    for (const toolCall of response.toolCalls) {
      const toolName = toolCall.name;
      const toolInput = toolCall.input;
      turnTools.push(toolName);
      allToolsCalled.push(toolName);

      onToolUse?.(toolName, toolInput);

      const handler = toolHandlers.get(toolName);
      if (!handler) {
        logger.warn(`Unknown tool requested: "${toolName}"`);
        toolResults.push({
          toolUseId: toolCall.id,
          content: `Error: Unknown tool "${toolName}". Available tools: ${[...toolHandlers.keys()].join(", ")}`,
          isError: true,
        });
        continue;
      }

      try {
        const result = await handler(toolInput);
        toolResults.push({
          toolUseId: toolCall.id,
          content: result.output,
          isError: result.isError,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`Tool "${toolName}" threw: ${message}`);
        toolResults.push({
          toolUseId: toolCall.id,
          content: `Error: Tool execution failed: ${message}`,
          isError: true,
        });
      }
    }

    // Append tool results as a ToolResultMessage (user role).
    // The adapter converts this to provider-specific format.
    const toolResultMessage: ToolResultMessage = {
      role: "user",
      toolResults,
    };
    messages.push(toolResultMessage);

    onTurnComplete?.(turn, turnTools);
  }

  // Max turns exceeded — return what we have
  logger.warn(
    `Agentic loop exceeded max turns (${maxTurns}). Returning partial result.`,
  );

  return {
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
  };
}
