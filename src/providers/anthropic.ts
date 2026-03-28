import Anthropic from "@anthropic-ai/sdk";

import type {
  LLMClient,
  ChatParams,
  ChatResponse,
  ToolDef,
  ToolCall,
  StopReason,
} from "./types.js";

// ── Conversion helpers ──────────────────────────────────────────────

/**
 * Convert a provider-agnostic ToolDef to Anthropic's Tool format.
 *
 * ToolDef.input_schema maps directly to Anthropic's input_schema field,
 * so this is a straightforward cast with a rename of the top-level key.
 */
function toAnthropicTool(tool: ToolDef): Anthropic.Messages.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema as Anthropic.Messages.Tool["input_schema"],
  };
}

/**
 * Normalize Anthropic's stop_reason to our StopReason type.
 */
function normalizeStopReason(
  reason: Anthropic.Messages.Message["stop_reason"],
): StopReason {
  switch (reason) {
    case "end_turn":
      return "end";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    default:
      return reason ?? "end";
  }
}

/**
 * Extract normalized text and tool calls from Anthropic content blocks.
 */
function normalizeContent(
  content: Anthropic.Messages.ContentBlock[],
): { text: string; toolCalls: ToolCall[] } {
  let text = "";
  const toolCalls: ToolCall[] = [];

  for (const block of content) {
    if (block.type === "text") {
      text += block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      });
    }
  }

  return { text, toolCalls };
}

// ── AnthropicAdapter ────────────────────────────────────────────────

/**
 * LLMClient implementation that wraps the Anthropic SDK.
 *
 * Converts ToolDef[] to Anthropic.Messages.Tool[] before each request
 * and normalizes Anthropic responses to ChatResponse after.
 */
export class AnthropicAdapter implements LLMClient {
  private readonly client: Anthropic;

  constructor(apiKey?: string) {
    this.client = new Anthropic({ apiKey });
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    const { model, system, messages, tools, maxTokens = 16384 } = params;

    // Convert provider-agnostic messages to Anthropic format.
    // All messages in our types are plain text at this layer --
    // the agentic loop will be refactored in sprint 2 to pass
    // pre-serialized content. For now, cast content as string.
    const anthropicMessages: Anthropic.Messages.MessageParam[] =
      messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

    // Convert ToolDef[] to Anthropic.Messages.Tool[]
    const anthropicTools =
      tools && tools.length > 0 ? tools.map(toAnthropicTool) : undefined;

    const response = await this.client.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      messages: anthropicMessages,
      tools: anthropicTools,
    });

    const { text, toolCalls } = normalizeContent(response.content);

    return {
      text,
      toolCalls,
      stopReason: normalizeStopReason(response.stop_reason),
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }
}
