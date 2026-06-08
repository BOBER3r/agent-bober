import type { LLMClient, ToolDef, Message, AssistantMessage, ToolResultMessage, ToolResult, JsonSchemaObject } from "../providers/types.js";

import type { ToolHandler } from "./tools/index.js";
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
  /** Called when the model invokes a tool (for logging/progress). */
  onToolUse?: (name: string, input: unknown) => void;
  /** Called after each completed turn (for progress tracking). */
  onTurnComplete?: (turn: number, toolsCalled: string[]) => void;
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
  /** The (non-JSON) text the agentic loop produced, fed back for context. */
  priorText: string;
  /** JSON Schema the provider must conform its output to (enables JSON mode). */
  responseSchema: JsonSchemaObject;
  /** Final instruction telling the model to emit ONLY the JSON object. */
  instruction: string;
  maxTokens?: number;
}

/**
 * Force a structured-JSON response after an agentic loop failed to terminate
 * with parseable JSON. Some OpenAI-compatible models (notably DeepSeek) explore
 * with tools correctly but then narrate prose instead of emitting the required
 * JSON object. Setting `responseSchema` flips the adapter into native JSON mode
 * (response_format) with tools disabled, which reliably yields a JSON document.
 *
 * Provider-agnostic: Anthropic/Claude rarely needs this (it follows the
 * "JSON only" instruction directly), so callers should use it as a *fallback*
 * after a normal parse attempt fails — zero behavior change for compliant models.
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
    responseSchema,
    instruction,
    maxTokens = 16384,
  } = params;

  const messages: Message[] = [
    { role: "user", content: userMessage },
    { role: "assistant", content: priorText || "(no output produced)" },
    { role: "user", content: instruction },
  ];

  const response = await chatWithRetry(
    client,
    { model, system: systemPrompt, messages, responseSchema, maxTokens },
    0,
  );

  return response.text;
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
    onToolUse,
    onTurnComplete,
  } = params;

  const messages: Message[] = [
    { role: "user", content: userMessage },
  ];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const allToolsCalled: string[] = [];
  let finalText = "";

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
      };
    }

    // Accumulate usage
    totalInputTokens += response.usage.inputTokens;
    totalOutputTokens += response.usage.outputTokens;

    const turnStopReason = response.stopReason;

    // If the model is done (no more tool use), return
    if (response.stopReason !== "tool_use") {
      finalText = response.text;

      return {
        finalText,
        turnsUsed: turn,
        toolsCalled: allToolsCalled,
        usage: {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
        },
        stopReason: turnStopReason,
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
  };
}
