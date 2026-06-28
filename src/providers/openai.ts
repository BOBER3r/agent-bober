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

// ── User content parts (multimodal) ─────────────────────────────────
// A user message is either a plain string or an array of content parts.
// PDFs/files ride as a `file` part with a base64 `file_data` data-URL.

interface OAITextPart {
  type: "text";
  text: string;
}

interface OAIFilePart {
  type: "file";
  file: {
    filename: string;
    file_data: string;
  };
}

type OAIContentPart = OAITextPart | OAIFilePart;

interface OAIUserMessage {
  role: "user";
  content: string | OAIContentPart[];
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
  response_format?:
    | {
        type: "json_schema";
        json_schema: {
          name: string;
          schema: Record<string, unknown>;
          strict?: boolean;
        };
      }
    | { type: "json_object" };
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

  // SystemUpdateMessage: best-effort render as an OpenAI system message
  if ("systemUpdate" in message) {
    return [{ role: "system", content: message.systemUpdate }];
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
 * Map a document MIME type to a filename extension. OpenAI requires a
 * `filename` alongside inline `file_data`; the extension is cosmetic (the
 * data-URL MIME is authoritative), so an unknown type falls back to `bin`.
 */
function extensionForMediaType(mediaType: string): string {
  switch (mediaType) {
    case "application/pdf":
      return "pdf";
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    default:
      return "bin";
  }
}

/**
 * Attach `documents` to the FIRST user message as OpenAI `file` content parts.
 *
 * The string content of that message is preserved as a trailing `text` part.
 * Mutates `messages` in place. No-op semantics for callers: when `documents`
 * is empty the caller skips this entirely, leaving the request byte-identical.
 */
function attachOpenAIDocuments(
  messages: OAIRequestMessage[],
  documents: { base64: string; mediaType: string }[],
): void {
  const firstUserIdx = messages.findIndex((m) => m.role === "user");
  if (firstUserIdx === -1) {
    return;
  }
  const firstUser = messages[firstUserIdx] as OAIUserMessage;

  const fileParts: OAIFilePart[] = documents.map((doc, i) => ({
    type: "file" as const,
    file: {
      filename: `document-${i + 1}.${extensionForMediaType(doc.mediaType)}`,
      file_data: `data:${doc.mediaType};base64,${doc.base64}`,
    },
  }));

  const existing: OAIContentPart[] =
    typeof firstUser.content === "string"
      ? [{ type: "text" as const, text: firstUser.content }]
      : firstUser.content;

  messages[firstUserIdx] = {
    ...firstUser,
    content: [...fileParts, ...existing],
  };
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
    const { model, system, messages, tools, maxTokens = 16384, responseSchema, jsonObjectMode } = params;

    const client = await this.getClient();

    // Build the messages array: system message first, then conversation
    const oaiMessages: OAIRequestMessage[] = [
      { role: "system", content: system },
      ...messages.flatMap(toOpenAIMessages),
    ];

    // Documents (PDFs/files) → `file` content part on the first user message.
    // Omitting documents leaves the rendered request byte-identical.
    if (params.documents && params.documents.length > 0) {
      attachOpenAIDocuments(oaiMessages, params.documents);
    }

    // Structured output via response_format. `responseSchema` (strict json_schema)
    // wins when set; otherwise `jsonObjectMode` requests the loose json_object
    // mode (broadly supported, incl. DeepSeek, which rejects json_schema).
    // Both disable tool forwarding (mutually exclusive with structured output).
    // strict:false maximises compatibility; the caller validates/repairs output.
    const responseFormat: OAICreateParams["response_format"] | undefined =
      responseSchema
        ? {
            type: "json_schema",
            json_schema: {
              name: "structured_output",
              schema: responseSchema as Record<string, unknown>,
              strict: false,
            },
          }
        : jsonObjectMode
          ? { type: "json_object" }
          : undefined;

    // Convert ToolDef[] to OpenAI tools format. Skipped entirely when structured
    // output (responseSchema or json_object mode) is requested.
    const oaiTools =
      !responseSchema && !jsonObjectMode && tools && tools.length > 0
        ? tools.map(toOpenAITool)
        : undefined;

    const response = await client.chat.completions.create({
      model: model || this.model,
      messages: oaiMessages,
      ...(oaiTools ? { tools: oaiTools } : {}),
      ...(responseFormat ? { response_format: responseFormat } : {}),
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
