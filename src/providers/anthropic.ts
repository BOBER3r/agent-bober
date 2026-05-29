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
 * Handles four message variants:
 * - TextMessage: plain string content for user or assistant
 * - AssistantMessage: assistant turn with optional text + tool_use blocks
 * - ToolResultMessage: user turn carrying tool_result blocks
 * - SystemUpdateMessage: user turn carrying a mid_conv_system content block
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

  // SystemUpdateMessage: render as a mid_conv_system content block inside a user turn
  if ("systemUpdate" in message) {
    const block: Anthropic.Messages.MidConversationSystemBlockParam = {
      type: "mid_conv_system",
      content: [{ type: "text", text: message.systemUpdate }],
      ...(message.cacheTtl
        ? { cache_control: { type: "ephemeral", ttl: message.cacheTtl } }
        : {}),
    };
    return { role: "user", content: [block] };
  }

  // TextMessage: plain string content
  return {
    role: message.role,
    content: (message as { role: "user" | "assistant"; content: string }).content,
  };
}

// ── Prompt caching ──────────────────────────────────────────────────

/**
 * Build a cached system block: wraps the plain system string in a
 * TextBlockParam array with an ephemeral cache_control marker.
 */
function buildCachedSystem(
  system: string,
): Anthropic.Messages.TextBlockParam[] {
  return [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
}

/**
 * Attach ephemeral cache_control breakpoints to the final content block of
 * up to the last 3 messages (system-and-last-3 strategy, capped at 4 total).
 *
 * System counts as 1 breakpoint, so at most 3 message breakpoints are added.
 * Messages with plain-string content are converted to a one-element
 * TextBlockParam array so the breakpoint can be attached.
 */
function attachMessageBreakpoints(
  msgs: Anthropic.Messages.MessageParam[],
): Anthropic.Messages.MessageParam[] {
  const result: Anthropic.Messages.MessageParam[] = msgs.map((m) => ({ ...m }));
  const maxMsgBreakpoints = 3; // 4 total - 1 for system
  let placed = 0;

  // Walk from the end of the array, attaching breakpoints to the last 3.
  for (let i = result.length - 1; i >= 0 && placed < maxMsgBreakpoints; i--) {
    const msg = result[i];

    if (typeof msg.content === "string") {
      // Convert plain-string content to a TextBlockParam array.
      result[i] = {
        ...msg,
        content: [
          {
            type: "text",
            text: msg.content,
            cache_control: { type: "ephemeral" },
          } satisfies Anthropic.Messages.TextBlockParam,
        ],
      };
    } else if (Array.isArray(msg.content) && msg.content.length > 0) {
      // Attach to the LAST block of the existing array.
      const blocks = msg.content.map((b) => ({ ...b }));
      const last = blocks[blocks.length - 1] as Anthropic.Messages.ContentBlockParam & {
        cache_control?: { type: "ephemeral" };
      };
      last.cache_control = { type: "ephemeral" };
      result[i] = { ...msg, content: blocks };
    } else {
      // Empty content — skip without consuming a breakpoint slot.
      continue;
    }

    placed++;
  }

  return result;
}

// ── AnthropicAdapter ────────────────────────────────────────────────

/**
 * LLMClient implementation that wraps the Anthropic SDK.
 *
 * Converts ToolDef[] to Anthropic.Messages.Tool[] before each request,
 * converts provider-agnostic Message[] (including tool call/result variants)
 * to Anthropic MessageParam[], and normalizes Anthropic responses to
 * ChatResponse after each call.
 *
 * When promptCaching is enabled (the default), attaches ephemeral
 * cache_control breakpoints to the system prompt and up to the last 3
 * messages (system-and-last-3 strategy, capped at 4 breakpoints total).
 */
export class AnthropicAdapter implements LLMClient {
  private readonly client: Anthropic;
  private readonly promptCaching: boolean;

  constructor(apiKey?: string, opts?: { promptCaching?: boolean }) {
    this.client = new Anthropic({ apiKey });
    this.promptCaching = opts?.promptCaching ?? true;
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    const { model, system, messages, tools, maxTokens = 16384, effort } = params;

    // Convert provider-agnostic Message[] to Anthropic MessageParam[]
    const anthropicMessages: Anthropic.Messages.MessageParam[] =
      messages.map(toAnthropicMessage);

    // Convert ToolDef[] to Anthropic.Messages.Tool[]
    const anthropicTools =
      tools && tools.length > 0 ? tools.map(toAnthropicTool) : undefined;

    // ── Prompt caching branch ──────────────────────────────────────
    // When enabled: system becomes a TextBlockParam[] with cache_control,
    // and breakpoints are attached to the final block of up to the last 3
    // messages (total capped at 4 across system + messages).
    // When disabled: plain-string system and unmodified messages (C3 guard).
    const cachedSystem: string | Anthropic.Messages.TextBlockParam[] =
      this.promptCaching && system !== undefined
        ? buildCachedSystem(system)
        : system;

    const cachedMessages = this.promptCaching
      ? attachMessageBreakpoints(anthropicMessages)
      : anthropicMessages;

    const response = await this.client.messages.create({
      model,
      max_tokens: maxTokens,
      system: cachedSystem,
      messages: cachedMessages,
      tools: anthropicTools,
      ...(effort !== undefined ? { output_config: { effort } } : {}),
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
