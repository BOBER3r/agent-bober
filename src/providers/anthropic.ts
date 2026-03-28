import Anthropic from "@anthropic-ai/sdk";

import type {
  LLMClient,
  ChatParams,
  ChatResponse,
  ToolDef,
  ToolCall,
  StopReason,
  Message,
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

/**
 * Convert a provider-agnostic Message to an Anthropic MessageParam.
 *
 * Handles three message variants:
 * - TextMessage: plain string content for user or assistant
 * - AssistantMessage: assistant turn with optional text + tool_use blocks
 * - ToolResultMessage: user turn carrying tool_result blocks
 */
function toAnthropicMessage(
  message: Message,
): Anthropic.Messages.MessageParam {
  // ToolResultMessage: user turn with tool results
  if ("toolResults" in message) {
    const content: Anthropic.Messages.ToolResultBlockParam[] =
      message.toolResults.map((tr) => ({
        type: "tool_result" as const,
        tool_use_id: tr.toolUseId,
        content: tr.content,
        is_error: tr.isError ?? false,
      }));
    return { role: "user", content };
  }

  // AssistantMessage: assistant turn with tool calls (and optional text)
  if ("toolCalls" in message && message.toolCalls.length > 0) {
    const content: Anthropic.Messages.ContentBlockParam[] = [];

    // Include text block if there is text content
    if (message.content) {
      content.push({ type: "text", text: message.content });
    }

    // Append tool_use blocks
    for (const tc of message.toolCalls) {
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.name,
        input: tc.input,
      });
    }

    return { role: "assistant", content };
  }

  // TextMessage: plain string content
  return {
    role: message.role,
    content: (message as { role: "user" | "assistant"; content: string }).content,
  };
}

// ── AnthropicAdapter ────────────────────────────────────────────────

/**
 * LLMClient implementation that wraps the Anthropic SDK.
 *
 * Converts ToolDef[] to Anthropic.Messages.Tool[] before each request,
 * converts provider-agnostic Message[] (including tool call/result variants)
 * to Anthropic MessageParam[], and normalizes Anthropic responses to
 * ChatResponse after each call.
 */
export class AnthropicAdapter implements LLMClient {
  private readonly client: Anthropic;

  constructor(apiKey?: string) {
    this.client = new Anthropic({ apiKey });
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    const { model, system, messages, tools, maxTokens = 16384 } = params;

    // Convert provider-agnostic Message[] to Anthropic MessageParam[]
    const anthropicMessages: Anthropic.Messages.MessageParam[] =
      messages.map(toAnthropicMessage);

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
