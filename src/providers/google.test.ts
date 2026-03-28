/**
 * Unit tests for GoogleAdapter.
 *
 * Because the `@google/generative-ai` package is an optional peer dependency
 * (not installed), we mock the dynamic import to inject a fake client.
 *
 * Tests cover:
 * - ToolDef conversion to Gemini functionDeclarations format
 * - Message conversion (TextMessage, AssistantMessage, ToolResultMessage)
 * - Response normalisation (text, toolCalls, stopReason, usage)
 * - Edge cases: no tool calls, empty candidates, API key from env
 * - Missing @google/generative-ai package error
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import type {
  ChatParams,
  ToolDef,
  TextMessage,
  AssistantMessage,
  ToolResultMessage,
} from "./types.js";

// ── Fake Gemini client factory ───────────────────────────────────────

type FakeGenerateContentFn = Mock;

function makeFakeGeminiModel(generateContentFn: FakeGenerateContentFn) {
  return {
    generateContent: generateContentFn,
  };
}

function makeFakeGeminiGenAI(generateContentFn: FakeGenerateContentFn) {
  const model = makeFakeGeminiModel(generateContentFn);
  return class FakeGoogleGenerativeAI {
    getGenerativeModel(_config: unknown) {
      return model;
    }
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Build a minimal Gemini generateContent response.
 */
function makeGeminiResponse(opts: {
  textParts?: string[];
  functionCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  finishReason?: string;
  promptTokenCount?: number;
  candidatesTokenCount?: number;
}) {
  const parts: Array<
    { text: string } | { functionCall: { name: string; args: Record<string, unknown> } }
  > = [];

  for (const text of opts.textParts ?? []) {
    parts.push({ text });
  }

  for (const fc of opts.functionCalls ?? []) {
    parts.push({ functionCall: { name: fc.name, args: fc.args } });
  }

  return {
    response: {
      candidates: [
        {
          content: { parts },
          finishReason: opts.finishReason ?? "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: opts.promptTokenCount ?? 10,
        candidatesTokenCount: opts.candidatesTokenCount ?? 20,
      },
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("GoogleAdapter", () => {
  let generateContentFn: FakeGenerateContentFn;

  beforeEach(() => {
    generateContentFn = vi.fn();

    // Intercept dynamic import("@google/generative-ai") to return our fake class
    vi.doMock("@google/generative-ai", () => ({
      GoogleGenerativeAI: makeFakeGeminiGenAI(generateContentFn),
    }));
  });

  async function makeAdapter(model = "gemini-2.5-pro", apiKey = "test-gemini-key") {
    // Re-import after mocking so the dynamic import resolves the mock
    const { GoogleAdapter } = await import("./google.js?v=" + Date.now());
    return new GoogleAdapter(model, apiKey);
  }

  // ── Tool conversion ─────────────────────────────────────────────

  it("converts ToolDef[] to Gemini functionDeclarations format", async () => {
    generateContentFn.mockResolvedValue(makeGeminiResponse({ textParts: ["ok"] }));

    const tools: ToolDef[] = [
      {
        name: "search",
        description: "Search the web",
        input_schema: {
          type: "object",
          properties: { query: { type: "string", description: "Search query" } },
          required: ["query"],
        },
      },
    ];

    const adapter = await makeAdapter();
    const params: ChatParams = {
      model: "gemini-2.5-pro",
      system: "You are helpful.",
      messages: [{ role: "user", content: "Hello" }],
      tools,
    };

    await adapter.chat(params);

    const callArgs = generateContentFn.mock.calls[0][0] as {
      tools: Array<{
        functionDeclarations: Array<{
          name: string;
          description: string;
          parameters: unknown;
        }>;
      }>;
    };
    expect(callArgs.tools).toHaveLength(1);
    expect(callArgs.tools[0].functionDeclarations).toHaveLength(1);
    expect(callArgs.tools[0].functionDeclarations[0]).toEqual({
      name: "search",
      description: "Search the web",
      parameters: tools[0].input_schema,
    });
  });

  it("groups all tools into one functionDeclarations array", async () => {
    generateContentFn.mockResolvedValue(makeGeminiResponse({ textParts: ["ok"] }));

    const tools: ToolDef[] = [
      { name: "tool_a", description: "Tool A", input_schema: { type: "object" } },
      { name: "tool_b", description: "Tool B", input_schema: { type: "object" } },
    ];

    const adapter = await makeAdapter();
    await adapter.chat({
      model: "gemini-2.5-pro",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools,
    });

    const callArgs = generateContentFn.mock.calls[0][0] as {
      tools: Array<{ functionDeclarations: unknown[] }>;
    };
    // All declarations go into a single tool object
    expect(callArgs.tools).toHaveLength(1);
    expect(callArgs.tools[0].functionDeclarations).toHaveLength(2);
  });

  it("omits tools key when tools array is empty", async () => {
    generateContentFn.mockResolvedValue(makeGeminiResponse({ textParts: ["hi"] }));

    const adapter = await makeAdapter();
    await adapter.chat({
      model: "gemini-2.5-pro",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    });

    const callArgs = generateContentFn.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs["tools"]).toBeUndefined();
  });

  // ── Message conversion ──────────────────────────────────────────

  it("converts TextMessage (user) to role:user content", async () => {
    generateContentFn.mockResolvedValue(makeGeminiResponse({ textParts: ["response"] }));

    const msg: TextMessage = { role: "user", content: "Hello world" };
    const adapter = await makeAdapter();
    await adapter.chat({
      model: "gemini-2.5-pro",
      system: "Be concise.",
      messages: [msg],
    });

    const callArgs = generateContentFn.mock.calls[0][0] as {
      contents: Array<{ role: string; parts: Array<{ text?: string }> }>;
    };
    expect(callArgs.contents[0]).toEqual({
      role: "user",
      parts: [{ text: "Hello world" }],
    });
  });

  it("converts TextMessage (assistant) to role:model content", async () => {
    generateContentFn.mockResolvedValue(makeGeminiResponse({ textParts: ["ok"] }));

    const msg: TextMessage = { role: "assistant", content: "I can help." };
    const adapter = await makeAdapter();
    await adapter.chat({
      model: "gemini-2.5-pro",
      system: "sys",
      messages: [msg],
    });

    const callArgs = generateContentFn.mock.calls[0][0] as {
      contents: Array<{ role: string; parts: Array<{ text?: string }> }>;
    };
    expect(callArgs.contents[0].role).toBe("model");
    expect(callArgs.contents[0].parts[0]).toEqual({ text: "I can help." });
  });

  it("converts AssistantMessage with tool calls to role:model with functionCall parts", async () => {
    generateContentFn.mockResolvedValue(makeGeminiResponse({ textParts: ["done"] }));

    const msg: AssistantMessage = {
      role: "assistant",
      content: "Let me search for that.",
      toolCalls: [
        { id: "call_1", name: "search", input: { query: "vitest" } },
      ],
    };

    const adapter = await makeAdapter();
    await adapter.chat({
      model: "gemini-2.5-pro",
      system: "sys",
      messages: [msg],
    });

    const callArgs = generateContentFn.mock.calls[0][0] as {
      contents: Array<{
        role: string;
        parts: Array<{ text?: string; functionCall?: { name: string; args: unknown } }>;
      }>;
    };
    const content = callArgs.contents[0];
    expect(content.role).toBe("model");
    // First part is text, second is functionCall
    expect(content.parts[0]).toEqual({ text: "Let me search for that." });
    expect(content.parts[1]).toEqual({
      functionCall: { name: "search", args: { query: "vitest" } },
    });
  });

  it("converts ToolResultMessage to role:function contents", async () => {
    generateContentFn.mockResolvedValue(makeGeminiResponse({ textParts: ["done"] }));

    const msg: ToolResultMessage = {
      role: "user",
      toolResults: [
        { toolUseId: "search", content: "10 results found" },
        { toolUseId: "fetch", content: "page content here" },
      ],
    };

    const adapter = await makeAdapter();
    await adapter.chat({
      model: "gemini-2.5-pro",
      system: "sys",
      messages: [msg],
    });

    const callArgs = generateContentFn.mock.calls[0][0] as {
      contents: Array<{
        role: string;
        parts: Array<{ functionResponse?: { name: string; response: unknown } }>;
      }>;
    };
    // Each tool result becomes its own content entry
    expect(callArgs.contents[0].role).toBe("function");
    expect(callArgs.contents[0].parts[0]).toEqual({
      functionResponse: { name: "search", response: { content: "10 results found" } },
    });
    expect(callArgs.contents[1].role).toBe("function");
    expect(callArgs.contents[1].parts[0]).toEqual({
      functionResponse: { name: "fetch", response: { content: "page content here" } },
    });
  });

  // ── Response normalisation ──────────────────────────────────────

  it("normalises STOP finishReason to stopReason 'end'", async () => {
    generateContentFn.mockResolvedValue(
      makeGeminiResponse({ textParts: ["hello"], finishReason: "STOP" }),
    );
    const adapter = await makeAdapter();
    const result = await adapter.chat({
      model: "gemini-2.5-pro",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.stopReason).toBe("end");
  });

  it("normalises MAX_TOKENS finishReason to stopReason 'max_tokens'", async () => {
    generateContentFn.mockResolvedValue(
      makeGeminiResponse({ textParts: ["..."], finishReason: "MAX_TOKENS" }),
    );
    const adapter = await makeAdapter();
    const result = await adapter.chat({
      model: "gemini-2.5-pro",
      system: "sys",
      messages: [{ role: "user", content: "write a lot" }],
    });
    expect(result.stopReason).toBe("max_tokens");
  });

  it("returns stopReason 'tool_use' when functionCall parts are present", async () => {
    generateContentFn.mockResolvedValue(
      makeGeminiResponse({
        functionCalls: [{ name: "search", args: { query: "test" } }],
        finishReason: "STOP",
      }),
    );
    const adapter = await makeAdapter();
    const result = await adapter.chat({
      model: "gemini-2.5-pro",
      system: "sys",
      messages: [{ role: "user", content: "search for something" }],
    });
    expect(result.stopReason).toBe("tool_use");
    expect(result.toolCalls).toHaveLength(1);
  });

  it("extracts text content from response parts", async () => {
    generateContentFn.mockResolvedValue(
      makeGeminiResponse({ textParts: ["Hello from Gemini!"] }),
    );
    const adapter = await makeAdapter();
    const result = await adapter.chat({
      model: "gemini-2.5-pro",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.text).toBe("Hello from Gemini!");
  });

  it("extracts multiple text parts concatenated", async () => {
    generateContentFn.mockResolvedValue(
      makeGeminiResponse({ textParts: ["Hello ", "world!"] }),
    );
    const adapter = await makeAdapter();
    const result = await adapter.chat({
      model: "gemini-2.5-pro",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.text).toBe("Hello world!");
  });

  it("maps usage tokens correctly", async () => {
    generateContentFn.mockResolvedValue(
      makeGeminiResponse({
        textParts: ["ok"],
        promptTokenCount: 50,
        candidatesTokenCount: 30,
      }),
    );
    const adapter = await makeAdapter();
    const result = await adapter.chat({
      model: "gemini-2.5-pro",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.usage).toEqual({ inputTokens: 50, outputTokens: 30 });
  });

  it("normalises multiple tool calls from response parts", async () => {
    generateContentFn.mockResolvedValue(
      makeGeminiResponse({
        functionCalls: [
          { name: "tool_a", args: { a: 1 } },
          { name: "tool_b", args: { b: 2 } },
        ],
        finishReason: "STOP",
      }),
    );
    const adapter = await makeAdapter();
    const result = await adapter.chat({
      model: "gemini-2.5-pro",
      system: "sys",
      messages: [{ role: "user", content: "call tools" }],
    });
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].name).toBe("tool_a");
    expect(result.toolCalls[0].input).toEqual({ a: 1 });
    expect(result.toolCalls[1].name).toBe("tool_b");
    expect(result.toolCalls[1].input).toEqual({ b: 2 });
  });

  // ── Edge cases ──────────────────────────────────────────────────

  it("returns empty response when candidates is empty", async () => {
    generateContentFn.mockResolvedValue({
      response: {
        candidates: [],
        usageMetadata: {},
      },
    });
    const adapter = await makeAdapter();
    const result = await adapter.chat({
      model: "gemini-2.5-pro",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.text).toBe("");
    expect(result.toolCalls).toEqual([]);
    expect(result.stopReason).toBe("error");
  });

  it("returns empty response when candidates is undefined", async () => {
    generateContentFn.mockResolvedValue({
      response: {
        usageMetadata: {},
      },
    });
    const adapter = await makeAdapter();
    const result = await adapter.chat({
      model: "gemini-2.5-pro",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.text).toBe("");
    expect(result.toolCalls).toEqual([]);
    expect(result.stopReason).toBe("error");
  });

  it("tool call IDs are unique and name-prefixed", async () => {
    generateContentFn.mockResolvedValue(
      makeGeminiResponse({
        functionCalls: [
          { name: "search", args: {} },
          { name: "fetch", args: {} },
        ],
      }),
    );
    const adapter = await makeAdapter();
    const result = await adapter.chat({
      model: "gemini-2.5-pro",
      system: "sys",
      messages: [{ role: "user", content: "go" }],
    });
    expect(result.toolCalls[0].id).toContain("search");
    expect(result.toolCalls[1].id).toContain("fetch");
    // IDs must be distinct
    expect(result.toolCalls[0].id).not.toBe(result.toolCalls[1].id);
  });
});

// ── Missing package error test ────────────────────────────────────────

describe("GoogleAdapter missing @google/generative-ai package", () => {
  it("throws a helpful install error when @google/generative-ai is not available", async () => {
    // Mock the import to throw (simulating missing package)
    vi.doMock("@google/generative-ai", () => {
      throw new Error("Cannot find module '@google/generative-ai'");
    });

    const { GoogleAdapter } = await import("./google.js?v=missing-" + Date.now());
    const adapter = new GoogleAdapter("gemini-2.5-pro", "test-key");

    await expect(
      adapter.chat({
        model: "gemini-2.5-pro",
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow(
      'Google provider requires the "@google/generative-ai" package. Run: npm install @google/generative-ai',
    );
  });
});
