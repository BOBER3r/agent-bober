/**
 * Google Gemini provider adapter.
 *
 * Uses a dynamic import so the `@google/generative-ai` package is an optional
 * peer dependency. If the package is not installed, a clear installation error
 * is thrown at call-time rather than at module load time.
 *
 * All Gemini SDK types are inlined below so this file compiles without the
 * `@google/generative-ai` package present in node_modules.
 */

import type {
  LLMClient,
  ChatParams,
  ChatResponse,
  ToolDef,
  ToolCall,
  Message,
} from "./types.js";

// ── Inline Gemini SDK shapes ─────────────────────────────────────────
// These mirror only the fields we actually use from the @google/generative-ai
// SDK so we do not need the package present at compile time.

interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface GeminiTool {
  functionDeclarations: GeminiFunctionDeclaration[];
}

interface GeminiTextPart {
  text: string;
}

interface GeminiFunctionCallPart {
  functionCall: {
    name: string;
    args: Record<string, unknown>;
  };
}

interface GeminiFunctionResponsePart {
  functionResponse: {
    name: string;
    response: Record<string, unknown>;
  };
}

type GeminiPart = GeminiTextPart | GeminiFunctionCallPart | GeminiFunctionResponsePart;

interface GeminiContent {
  role: "user" | "model" | "function";
  parts: GeminiPart[];
}

interface GeminiCandidate {
  content?: {
    parts?: GeminiPart[];
  };
  finishReason?: string;
}

interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
}

interface GeminiGenerateContentResult {
  response: {
    candidates?: GeminiCandidate[];
    usageMetadata?: GeminiUsageMetadata;
    text?: () => string;
  };
}

interface GeminiGenerativeModel {
  generateContent(request: {
    contents: GeminiContent[];
    tools?: GeminiTool[];
  }): Promise<GeminiGenerateContentResult>;
}

interface GeminiGenerativeAI {
  getGenerativeModel(config: {
    model: string;
    systemInstruction?: string;
  }): GeminiGenerativeModel;
}

// ── Conversion helpers ───────────────────────────────────────────────

/**
 * Convert a provider-agnostic ToolDef to Gemini functionDeclarations format.
 */
function toGeminiTool(tools: ToolDef[]): GeminiTool {
  return {
    functionDeclarations: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema as Record<string, unknown>,
    })),
  };
}

/**
 * Normalize a Gemini finishReason to our StopReason type.
 */
function normalizeStopReason(finishReason: string | undefined): string {
  switch (finishReason) {
    case "STOP":
      return "end";
    case "MAX_TOKENS":
      return "max_tokens";
    default:
      return "end";
  }
}

/**
 * Convert a provider-agnostic Message to Gemini content format.
 *
 * Returns an array because ToolResultMessage may need special handling —
 * Gemini uses role "function" with functionResponse parts for tool results.
 */
function toGeminiContents(message: Message): GeminiContent[] {
  // ToolResultMessage → role:"function" with functionResponse parts
  if ("toolResults" in message) {
    return message.toolResults.map((tr) => ({
      role: "function" as const,
      parts: [
        {
          functionResponse: {
            name: tr.toolUseId,
            response: { content: tr.content },
          },
        },
      ],
    }));
  }

  // AssistantMessage (with tool calls) → role:"model" with functionCall parts
  if ("toolCalls" in message && message.toolCalls.length > 0) {
    const parts: GeminiPart[] = [];

    if (message.content) {
      parts.push({ text: message.content });
    }

    for (const tc of message.toolCalls) {
      parts.push({
        functionCall: {
          name: tc.name,
          args: tc.input,
        },
      });
    }

    return [{ role: "model", parts }];
  }

  // TextMessage — map "user" → "user", "assistant" → "model"
  const textMsg = message as { role: "user" | "assistant"; content: string };
  const geminiRole = textMsg.role === "assistant" ? "model" : "user";
  return [{ role: geminiRole, parts: [{ text: textMsg.content }] }];
}

/**
 * Extract normalized text and tool calls from Gemini response parts.
 */
function normalizeResponseParts(parts: GeminiPart[]): {
  text: string;
  toolCalls: ToolCall[];
} {
  let text = "";
  const toolCalls: ToolCall[] = [];

  for (const part of parts) {
    if ("text" in part && typeof part.text === "string") {
      text += part.text;
    } else if ("functionCall" in part) {
      // Gemini does not provide a stable call ID — synthesize one from index
      const callId = `gemini-call-${toolCalls.length}-${part.functionCall.name}`;
      toolCalls.push({
        id: callId,
        name: part.functionCall.name,
        input: part.functionCall.args ?? {},
      });
    }
  }

  return { text, toolCalls };
}

// ── GoogleAdapter ────────────────────────────────────────────────────

/**
 * LLMClient implementation that wraps the Google Gemini API.
 *
 * The `@google/generative-ai` npm package is dynamically imported so it
 * remains an optional peer dependency. If the package is absent a descriptive
 * install error is thrown on the first call.
 *
 * Supports:
 * - Function/tool calling via functionDeclarations format
 * - System instruction passed via model config
 * - Message history with user/model/function roles
 */
export class GoogleAdapter implements LLMClient {
  private readonly model: string;
  private readonly apiKey: string | undefined;

  /** Lazily initialised after the dynamic import succeeds. */
  private genAI: GeminiGenerativeAI | null = null;

  constructor(model: string, apiKey?: string) {
    this.model = model;
    this.apiKey = apiKey;
  }

  /**
   * Lazily import the `@google/generative-ai` package and return the
   * initialised GoogleGenerativeAI client.
   *
   * @throws If the `@google/generative-ai` package is not installed.
   */
  private async getGenAI(): Promise<GeminiGenerativeAI> {
    if (this.genAI) {
      return this.genAI;
    }

    let GoogleGenerativeAI: new (apiKey: string) => GeminiGenerativeAI;

    try {
      // Construct the specifier at runtime so TypeScript does not attempt
      // to statically resolve the optional peer dependency at compile time.
      const specifier = "@google/generative-ai";
      const mod = (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
      // Handle both ESM default export and CommonJS-style .default wrapping
      GoogleGenerativeAI = (mod["GoogleGenerativeAI"] ?? mod["default"]) as typeof GoogleGenerativeAI;
    } catch {
      throw new Error(
        'Google provider requires the "@google/generative-ai" package. Run: npm install @google/generative-ai',
      );
    }

    const apiKey =
      this.apiKey ??
      process.env["GOOGLE_API_KEY"] ??
      process.env["GEMINI_API_KEY"];

    if (!apiKey) {
      throw new Error(
        "Google provider requires an API key. Set GOOGLE_API_KEY or GEMINI_API_KEY environment variable.",
      );
    }

    this.genAI = new GoogleGenerativeAI(apiKey);
    return this.genAI;
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    const { model, system, messages, tools, maxTokens: _maxTokens = 16384 } = params;

    const genAI = await this.getGenAI();

    // Get the generative model — system instruction set at model config level
    const generativeModel = genAI.getGenerativeModel({
      model: model || this.model,
      ...(system ? { systemInstruction: system } : {}),
    });

    // Convert provider-agnostic Message[] to Gemini contents format
    const contents: GeminiContent[] = messages.flatMap(toGeminiContents);

    // Convert ToolDef[] to Gemini tools format (all declarations in one tool)
    const geminiTools =
      tools && tools.length > 0 ? [toGeminiTool(tools)] : undefined;

    const result = await generativeModel.generateContent({
      contents,
      ...(geminiTools ? { tools: geminiTools } : {}),
    });

    const candidate = result.response.candidates?.[0];
    if (!candidate) {
      return {
        text: "",
        toolCalls: [],
        stopReason: "error",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    }

    const parts = candidate.content?.parts ?? [];
    const { text, toolCalls } = normalizeResponseParts(parts);
    const stopReason = normalizeStopReason(candidate.finishReason);

    // Determine stopReason based on whether there are tool calls
    const finalStopReason = toolCalls.length > 0 ? "tool_use" : stopReason;

    return {
      text,
      toolCalls,
      stopReason: finalStopReason,
      usage: {
        inputTokens: result.response.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: result.response.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
  }
}
