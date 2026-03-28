import type { LLMClient, ToolDef, Message, AssistantMessage, ToolResultMessage, ToolResult } from "../providers/types.js";

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
      response = await client.chat({
        model,
        system: systemPrompt,
        messages,
        tools: tools.length > 0 ? tools : undefined,
        maxTokens,
      });
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
