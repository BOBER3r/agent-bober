import type Anthropic from "@anthropic-ai/sdk";

import type { ToolHandler } from "./tools/index.js";
import { logger } from "../utils/logger.js";

// ── Types ──────────────────────────────────────────────────────────

type Tool = Anthropic.Messages.Tool;
type MessageParam = Anthropic.Messages.MessageParam;
type ContentBlockParam = Anthropic.Messages.ContentBlockParam;
type ToolResultBlockParam = Anthropic.Messages.ToolResultBlockParam;

export interface AgenticLoopParams {
  /** Anthropic SDK client instance. */
  client: Anthropic;
  /** Model ID (resolved via model-resolver). */
  model: string;
  /** System prompt (loaded from agent .md file). */
  systemPrompt: string;
  /** Initial user message (task description, handoff, etc.). */
  userMessage: string;
  /** Tool schemas to pass to the API. */
  tools: Tool[];
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

// ── Helpers ─────────────────────────────────────────────────────────

function extractText(
  content: Anthropic.Messages.ContentBlock[],
): string {
  return content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
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

  const messages: MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const allToolsCalled: string[] = [];
  let finalText = "";

  for (let turn = 1; turn <= maxTurns; turn++) {
    logger.debug(`Agentic loop turn ${turn}/${maxTurns}...`);

    let response: Anthropic.Messages.Message;
    try {
      response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        tools: tools.length > 0 ? tools : undefined,
        messages,
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
    totalInputTokens += response.usage?.input_tokens ?? 0;
    totalOutputTokens += response.usage?.output_tokens ?? 0;

    // Extract text from this response
    const turnText = extractText(response.content);
    const turnStopReason = response.stop_reason ?? "unknown";

    // If the model is done (no more tool use), return
    if (response.stop_reason !== "tool_use") {
      finalText = turnText;

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

    // Model wants to use tools — process tool_use blocks
    // Append the assistant's full response (including tool_use blocks)
    messages.push({
      role: "assistant",
      content: response.content as unknown as ContentBlockParam[],
    });

    // Execute each tool and collect results
    const toolResults: ToolResultBlockParam[] = [];
    const turnTools: string[] = [];

    for (const block of response.content) {
      if (block.type !== "tool_use") continue;

      const toolName = block.name;
      const toolInput = block.input as Record<string, unknown>;
      turnTools.push(toolName);
      allToolsCalled.push(toolName);

      onToolUse?.(toolName, toolInput);

      const handler = toolHandlers.get(toolName);
      if (!handler) {
        logger.warn(`Unknown tool requested: "${toolName}"`);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `Error: Unknown tool "${toolName}". Available tools: ${[...toolHandlers.keys()].join(", ")}`,
          is_error: true,
        });
        continue;
      }

      try {
        const result = await handler(toolInput);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result.output,
          is_error: result.isError,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`Tool "${toolName}" threw: ${message}`);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `Error: Tool execution failed: ${message}`,
          is_error: true,
        });
      }
    }

    // Append tool results as a user message
    messages.push({
      role: "user",
      content: toolResults as ContentBlockParam[],
    });

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
