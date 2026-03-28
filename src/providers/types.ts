/**
 * Provider-agnostic LLM interface types.
 *
 * These types decouple agent-bober from any specific LLM SDK. All provider
 * adapters (Anthropic, OpenAI, etc.) convert to/from these types.
 */

// ── JSON Schema subset ──────────────────────────────────────────────

export interface JsonSchemaProperty {
  type: string;
  description?: string;
  enum?: string[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

export interface JsonSchemaObject {
  type: "object";
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
  /** Allow extra keys so this type is assignable to Anthropic's InputSchema (which has [k: string]: unknown). */
  [key: string]: unknown;
}

// ── Tool types ──────────────────────────────────────────────────────

/**
 * Provider-agnostic tool definition.
 *
 * Uses plain JSON Schema for parameters (no SDK-specific types).
 * Maps directly to the Anthropic Tool shape (input_schema → parameters)
 * and to OpenAI function calling format.
 */
export interface ToolDef {
  /** Unique tool name (snake_case). */
  name: string;
  /** Human-readable description of what the tool does. */
  description: string;
  /** JSON Schema object describing the tool's input parameters. */
  input_schema: JsonSchemaObject;
}

/**
 * A single tool invocation requested by the model.
 */
export interface ToolCall {
  /** Unique ID for this tool call (used to correlate results). */
  id: string;
  /** Tool name. */
  name: string;
  /** Parsed input arguments. */
  input: Record<string, unknown>;
}

// ── Message types ───────────────────────────────────────────────────

/**
 * A tool result item, returned by the agent after executing a tool.
 * Used within ToolResultMessage to correlate results with tool call IDs.
 */
export interface ToolResult {
  /** The ID of the tool call this result corresponds to. */
  toolUseId: string;
  /** The output text from the tool execution. */
  content: string;
  /** Whether this result represents a tool execution error. */
  isError?: boolean;
}

/**
 * An assistant message that contains both optional text and tool call requests.
 */
export interface AssistantMessage {
  role: "assistant";
  /** Text portion of the response (may be empty when only tool calls are present). */
  content: string;
  /** Tool calls the assistant wants to execute. */
  toolCalls: ToolCall[];
}

/**
 * A user message that carries tool execution results back to the model.
 */
export interface ToolResultMessage {
  role: "user";
  /** Tool results keyed by tool call ID. */
  toolResults: ToolResult[];
}

/**
 * A plain text message from user or assistant.
 */
export interface TextMessage {
  role: "user" | "assistant";
  /** Text content. */
  content: string;
}

/**
 * A message in the conversation history.
 *
 * Three variants:
 * - TextMessage: plain user or assistant text
 * - AssistantMessage: assistant response that includes tool call requests
 * - ToolResultMessage: user message carrying tool execution results
 */
export type Message = TextMessage | AssistantMessage | ToolResultMessage;

// ── Chat params / response ──────────────────────────────────────────

/**
 * Parameters for a single LLM chat request.
 */
export interface ChatParams {
  /** Model identifier (resolved by the factory / model-resolver). */
  model: string;
  /** System prompt. */
  system: string;
  /** Conversation history. */
  messages: Message[];
  /** Tools available to the model for this request. */
  tools?: ToolDef[];
  /** Maximum tokens to generate. Defaults to 16384. */
  maxTokens?: number;
}

/**
 * Stop reason indicating why the model stopped generating.
 */
export type StopReason = "end" | "tool_use" | "max_tokens" | "error" | string;

/**
 * Normalized response from a single LLM chat request.
 */
export interface ChatResponse {
  /** The assistant's text response (may be empty if only tool calls). */
  text: string;
  /** Tool calls requested by the model (may be empty). */
  toolCalls: ToolCall[];
  /** Why the model stopped generating. */
  stopReason: StopReason;
  /** Token usage for this request. */
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

// ── LLMClient interface ─────────────────────────────────────────────

/**
 * Unified interface for all LLM provider adapters.
 *
 * Implementations must handle tool conversion to/from their native
 * format and normalize responses to ChatResponse.
 */
export interface LLMClient {
  /**
   * Send a chat request to the underlying provider and return a
   * normalized ChatResponse.
   */
  chat(params: ChatParams): Promise<ChatResponse>;
}
