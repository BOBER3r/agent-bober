/**
 * OpenAI provider adapter.
 *
 * Uses a dynamic import so the `openai` package is an optional peer dependency.
 * If the package is not installed, a clear installation error is thrown at
 * call-time rather than at module load time.
 *
 * All OpenAI SDK types are inlined below so this file compiles without the
 * `openai` package present in node_modules.
 */

import type {
  LLMClient,
  ChatParams,
  ChatResponse,
  ToolDef,
  ToolCall,
  StopReason,
  Message,
} from "./types.js";

// ── Inline OpenAI response shapes ───────────────────────────────────
// These mirror only the fields we actually use from the openai SDK so
// we do not need the package present at compile time.

interface OAIFunctionCall {
  name: string;
  /** JSON-serialised argument object. */
  arguments: string;
}

interface OAIToolCall {
  id: string;
  type: "function";
  function: OAIFunctionCall;
}

interface OAIMessage {
  role: string;
  content: string | null;
  tool_calls?: OAIToolCall[];
}

interface OAIChoice {
  finish_reason: string | null;
  message: OAIMessage;
}

interface OAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
}

interface OAIChatCompletion {
  choices: OAIChoice[];
  usage?: OAIUsage;
}

// ── OpenAI request message shapes ───────────────────────────────────

interface OAISystemMessage {
  role: "system";
  content: string;
}

interface OAIUserMessage {
  role: "user";
  content: string;
}

interface OAIAssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: OAIToolCall[];
}

interface OAIToolMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

type OAIRequestMessage =
  | OAISystemMessage
  | OAIUserMessage
  | OAIAssistantMessage
  | OAIToolMessage;

// ── Minimal OpenAI client shape ──────────────────────────────────────

interface OAIToolParam {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OAICreateParams {
  model: string;
  messages: OAIRequestMessage[];
  tools?: OAIToolParam[];
  max_tokens?: number;
}

interface OAIClientLike {
  chat: {
    completions: {
      create(params: OAICreateParams): Promise<OAIChatCompletion>;
    };
  };
}

// ── Conversion helpers ──────────────────────────────────────────────

/**
 * Convert a provider-agnostic ToolDef to OpenAI function calling format.
 */
function toOpenAITool(tool: ToolDef): OAIToolParam {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      // input_schema is already a JSON Schema object; OpenAI uses `parameters`
      parameters: tool.input_schema as Record<string, unknown>,
    },
  };
}

/**
 * Normalize the OpenAI finish_reason to our StopReason type.
 */
function normalizeStopReason(finishReason: string | null): StopReason {
  switch (finishReason) {
    case "stop":
      return "end";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    default:
      return finishReason ?? "end";
  }
}

/**
 * Convert a provider-agnostic Message to one or more OpenAI request messages.
 *
 * Returns an array because ToolResultMessage expands into one OAI tool
 * message per tool result (OpenAI requires separate messages per tool call).
 */
function toOpenAIMessages(message: Message): OAIRequestMessage[] {
  // ToolResultMessage → one role:"tool" message per result
  if ("toolResults" in message) {
    return message.toolResults.map((tr) => ({
      role: "tool" as const,
      tool_call_id: tr.toolUseId,
      content: tr.content,
    }));
  }

  // AssistantMessage → role:"assistant" with optional tool_calls
  if ("toolCalls" in message && message.toolCalls.length > 0) {
    const oaiMsg: OAIAssistantMessage = {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.input),
        },
      })),
    };
    return [oaiMsg];
  }

  // TextMessage (user or assistant without tool calls)
  const textMsg = message as { role: "user" | "assistant"; content: string };
  if (textMsg.role === "user") {
    return [{ role: "user", content: textMsg.content }];
  }

  // Plain assistant text message (no tool calls)
  return [{ role: "assistant", content: textMsg.content }];
}

/**
 * Parse tool_calls from an OAI response message into ToolCall[].
 *
 * Guards against an empty array (treated as no tool calls) and handles
 * JSON parse errors in arguments gracefully.
 */
function normalizeToolCalls(toolCalls: OAIToolCall[] | undefined): ToolCall[] {
  if (!toolCalls || toolCalls.length === 0) {
    return [];
  }

  return toolCalls.map((tc) => {
    let input: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(tc.function.arguments);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        input = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed JSON from the model — fall back to empty input
    }
    return {
      id: tc.id,
      name: tc.function.name,
      input,
    };
  });
}

// ── OpenAIAdapter ────────────────────────────────────────────────────

/**
 * LLMClient implementation that wraps the OpenAI chat completions API.
 *
 * The `openai` npm package is dynamically imported so it remains an optional
 * peer dependency. If the package is absent a descriptive install error is
 * thrown on the first call.
 *
 * Supports:
 * - Function/tool calling via the tools array format
 * - Parallel tool calls
 * - Custom base URL for OpenAI-compatible endpoints
 * - Optional provider-level configuration
 */
export class OpenAIAdapter implements LLMClient {
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly baseURL: string | undefined;
  private readonly providerConfig: Record<string, unknown> | undefined;

  /** Lazily initialised after the dynamic import succeeds. */
  private client: OAIClientLike | null = null;

  constructor(
    model: string,
    apiKey?: string,
    endpoint?: string,
    providerConfig?: Record<string, unknown>,
  ) {
    this.model = model;
    this.apiKey = apiKey;
    this.baseURL = endpoint;
    this.providerConfig = providerConfig;
  }

  /**
   * Lazily import the `openai` package and return the initialised client.
   *
   * @throws If the `openai` package is not installed.
   */
  private async getClient(): Promise<OAIClientLike> {
    if (this.client) {
      return this.client;
    }

    let OpenAI: new (opts: {
      apiKey?: string;
      baseURL?: string;
    }) => OAIClientLike;

    try {
      // Construct the specifier at runtime so TypeScript does not attempt
      // to statically resolve the optional peer dependency at compile time.
      const specifier = "openai";
      const mod = (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
      // Handle both ESM default export and CommonJS-style .default wrapping
      OpenAI = (mod["default"] ?? mod) as typeof OpenAI;
    } catch {
      throw new Error(
        'OpenAI provider requires the "openai" package. Run: npm install openai',
      );
    }

    const apiKey =
      this.apiKey ??
      (typeof this.providerConfig?.["apiKey"] === "string"
        ? this.providerConfig["apiKey"]
        : process.env["OPENAI_API_KEY"]);

    this.client = new OpenAI({
      apiKey,
      ...(this.baseURL ? { baseURL: this.baseURL } : {}),
    });

    return this.client;
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    const { model, system, messages, tools, maxTokens = 16384 } = params;

    const client = await this.getClient();

    // Build the messages array: system message first, then conversation
    const oaiMessages: OAIRequestMessage[] = [
      { role: "system", content: system },
      ...messages.flatMap(toOpenAIMessages),
    ];

    // Convert ToolDef[] to OpenAI tools format
    const oaiTools =
      tools && tools.length > 0 ? tools.map(toOpenAITool) : undefined;

    const response = await client.chat.completions.create({
      model: model || this.model,
      messages: oaiMessages,
      ...(oaiTools ? { tools: oaiTools } : {}),
      max_tokens: maxTokens,
    });

    const choice = response.choices[0];
    if (!choice) {
      return {
        text: "",
        toolCalls: [],
        stopReason: "error",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    }

    const text = choice.message.content ?? "";
    const toolCalls = normalizeToolCalls(choice.message.tool_calls);
    const stopReason = normalizeStopReason(choice.finish_reason);

    return {
      text,
      toolCalls,
      stopReason,
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
    };
  }
}
