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
  /**
   * True for side-effect-free tools eligible for concurrent execution
   * (ADR-2, agent-loop-capability-port sprint 4). Absent (not `false`) means
   * "unknown/serial" — the loop only parallelizes tools explicitly marked
   * `true`, so omitting this field keeps existing tool defs byte-identical.
   */
  readOnly?: boolean;
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
 * A provider-agnostic mid-conversation system instruction.
 *
 * Rendered by the Anthropic adapter as a `mid_conv_system` content block
 * inside a message (NOT a top-level role). Non-anthropic adapters render it
 * as best-effort text or skip it. The optional ephemeral cache TTL lets the
 * instruction update mid-task without breaking the prompt cache.
 */
export interface SystemUpdateMessage {
  role: "user";
  /** The mid-conversation system instruction text. */
  systemUpdate: string;
  /** Optional ephemeral cache TTL for this instruction block. */
  cacheTtl?: "5m" | "1h";
}

/**
 * A message in the conversation history.
 *
 * Four variants:
 * - TextMessage: plain user or assistant text
 * - AssistantMessage: assistant response that includes tool call requests
 * - ToolResultMessage: user message carrying tool execution results
 * - SystemUpdateMessage: mid-conversation system instruction (rendered as
 *   mid_conv_system content block by the Anthropic adapter)
 */
export type Message =
  | TextMessage
  | AssistantMessage
  | ToolResultMessage
  | SystemUpdateMessage;

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
  /**
   * Reasoning/output effort level. Provider-agnostic; only the Anthropic
   * adapter forwards it (as output_config.effort). When unset, the provider
   * default applies (high on Opus 4.8). Other adapters ignore it.
   */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /**
   * When set, requests schema-constrained ("structured") output. Each adapter
   * maps this to its native mechanism — OpenAI / openai-compat
   * `response_format: { type: "json_schema" }`, Gemini `responseSchema`,
   * Anthropic forced-tool (`tool_choice`) — and upholds a single contract:
   *
   *   **When `responseSchema` is set, `ChatResponse.text` holds a JSON document
   *   that best-effort conforms to this schema, and `toolCalls` is empty.**
   *
   * This keeps callers provider-agnostic: they always parse/validate
   * `response.text`, regardless of how the provider produced it. `responseSchema`
   * is for single-shot structured calls and is mutually exclusive with `tools`
   * — when set, user `tools` are NOT forwarded. The `claude-code` adapter
   * ignores it (no schema-constrainable surface). Local models that don't honor
   * the native knob still receive a prompt-level schema instruction via
   * `runStructuredAgent` (see `./structured`), which then validates and repairs
   * the output.
   */
  responseSchema?: JsonSchemaObject;
  /**
   * When true, request the provider's *loose* JSON-object mode
   * (`response_format: { type: "json_object" }` for OpenAI / openai-compat).
   * Unlike `responseSchema` (strict json_schema, which DeepSeek rejects), this
   * only guarantees the output is a syntactically valid JSON object — the caller
   * must spell out the required fields in the prompt. Ignored by adapters that
   * lack the knob. When both are set, `responseSchema` takes precedence.
   */
  jsonObjectMode?: boolean;
  /**
   * Optional documents (e.g. PDFs) to attach to the request. Each entry is a
   * base64-encoded payload plus its MIME type. This is a provider-agnostic
   * input shape: each adapter renders it in that provider's native document
   * format, prepended to the FIRST user message —
   *
   *   - Anthropic → `document` content block (base64 source)
   *   - OpenAI    → `file` content part (`file_data` base64 data-URL)
   *   - Gemini    → `inlineData` part (`mimeType` + base64 `data`)
   *
   * Adapters whose provider has NO document-input surface (`openai-compat`
   * endpoints such as DeepSeek/Grok/Ollama, and the `claude-code` CLI) THROW a
   * clear error when documents are supplied rather than silently dropping them —
   * a dropped PDF would let the model hallucinate from nothing. Omitting this
   * field leaves every adapter's rendered request byte-identical to prior
   * behaviour.
   */
  documents?: { base64: string; mediaType: string }[];
  /**
   * Optional streaming callback. When set, adapters that support server-sent
   * streaming (currently ONLY the Anthropic adapter) invoke it once per text
   * delta as the response is generated; the concatenation of all deltas equals
   * the final ChatResponse.text. This is a pure provider-agnostic own type —
   * adapters MAY ignore it (openai/openai-compat/google/claude-code do; they
   * return the identical non-streamed ChatResponse and put nothing extra on the
   * wire). A throwing callback must never kill the request (adapter wraps it).
   */
  onTextDelta?: (delta: string) => void;
  /**
   * Optional abort signal (agent-loop-capability-port sprint 9). A
   * web-standard `AbortSignal` — NOT an SDK type, so it belongs in this
   * provider-agnostic surface. Only the Anthropic adapter forwards it (into
   * the SDK `create`/`stream` request options); other adapters ignore it —
   * the agentic loop's own turn-boundary checks cover their (non-cancellable)
   * requests. Absent leaves every adapter's request byte-identical.
   */
  abortSignal?: AbortSignal;
}

/**
 * Stop reason indicating why the model stopped generating.
 *
 * Known values: `"end"` (normal completion), `"tool_use"` (model requested a
 * tool call), `"max_tokens"` (hit the token cap), `"error"` (adapter-level
 * failure), `"refusal"` (the provider declined to generate — surfaced by
 * the Anthropic `stop_reason: "refusal"` and the OpenAI-family `finish_reason:
 * "content_filter"` / `message.refusal` signals), and `"aborted"` (the loop's
 * own `AgenticLoopParams.abortSignal` fired — agent-loop-capability-port
 * sprint 9; a graceful partial return, never a throw). This is an open union
 * (`| string`) so adapters may pass through other provider-specific values.
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
  /**
   * USD cost of this request, when known. For `claude-code` this is the CLI's
   * real, vendor-authoritative `total_cost_usd`; for other providers it is a
   * `CostMeter` estimate derived from the static price table. Absent (not
   * `undefined`-valued — the key itself is omitted) when the cost cannot be
   * determined, e.g. an unpriced model or an older CLI that didn't report it.
   */
  costUsd?: number;
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
