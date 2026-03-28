/**
 * Unit tests for OpenAIAdapter.
 *
 * Because the `openai` package is an optional peer dependency (not installed),
 * we mock the dynamic `import("openai")` call to inject a fake client.
 *
 * Tests cover:
 * - ToolDef conversion to OpenAI function-calling format
 * - Message conversion (TextMessage, AssistantMessage, ToolResultMessage)
 * - Response normalisation (text, toolCalls, stopReason, usage)
 * - Edge cases: empty tool_calls, null content, parallel tool calls
 * - Missing openai package error
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import type {
  ChatParams,
  ToolDef,
  TextMessage,
  AssistantMessage,
  ToolResultMessage,
} from "./types.js";

// ── Fake OpenAI client factory ───────────────────────────────────────

type FakeCreateFn = Mock;

function makeFakeOpenAI(createFn: FakeCreateFn) {
  return class FakeOpenAI {
    chat = {
      completions: {
        create: createFn,
      },
    };
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Build a minimal OpenAI chat completions response.
 */
function makeOAIResponse(opts: {
  content?: string | null;
  finishReason?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  promptTokens?: number;
  completionTokens?: number;
}) {
  return {
    choices: [
      {
        finish_reason: opts.finishReason ?? "stop",
        message: {
          role: "assistant",
          content: opts.content ?? null,
          tool_calls: opts.toolCalls?.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        },
      },
    ],
    usage: {
      prompt_tokens: opts.promptTokens ?? 10,
      completion_tokens: opts.completionTokens ?? 20,
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("OpenAIAdapter", () => {
  let createFn: FakeCreateFn;

  beforeEach(() => {
    createFn = vi.fn();

    // Intercept dynamic import("openai") to return our fake client
    vi.doMock("openai", () => ({ default: makeFakeOpenAI(createFn) }));
  });

  async function makeAdapter(model = "gpt-4.1") {
    // Re-import after mocking so the dynamic import resolves the mock
    const { OpenAIAdapter } = await import("./openai.js?v=" + Date.now());
    return new OpenAIAdapter(model, "test-api-key");
  }

  // ── Tool conversion ─────────────────────────────────────────────

  it("converts ToolDef[] to OpenAI function format", async () => {
    createFn.mockResolvedValue(makeOAIResponse({ content: "ok" }));

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
      model: "gpt-4.1",
      system: "You are helpful.",
      messages: [{ role: "user", content: "Hello" }],
      tools,
    };

    await adapter.chat(params);

    const callArgs = createFn.mock.calls[0][0] as {
      tools: Array<{
        type: string;
        function: { name: string; description: string; parameters: unknown };
      }>;
    };
    expect(callArgs.tools).toHaveLength(1);
    expect(callArgs.tools[0]).toEqual({
      type: "function",
      function: {
        name: "search",
        description: "Search the web",
        parameters: tools[0].input_schema,
      },
    });
  });

  it("omits tools key when tools array is empty", async () => {
    createFn.mockResolvedValue(makeOAIResponse({ content: "hi" }));

    const adapter = await makeAdapter();
    await adapter.chat({
      model: "gpt-4.1",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    });

    const callArgs = createFn.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs["tools"]).toBeUndefined();
  });

  // ── Message conversion ──────────────────────────────────────────

  it("prepends system message and converts TextMessage (user)", async () => {
    createFn.mockResolvedValue(makeOAIResponse({ content: "response" }));

    const msg: TextMessage = { role: "user", content: "Hello world" };
    const adapter = await makeAdapter();
    await adapter.chat({
      model: "gpt-4.1",
      system: "Be concise.",
      messages: [msg],
    });

    const callArgs = createFn.mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(callArgs.messages[0]).toEqual({ role: "system", content: "Be concise." });
    expect(callArgs.messages[1]).toEqual({ role: "user", content: "Hello world" });
  });

  it("converts AssistantMessage with tool calls", async () => {
    createFn.mockResolvedValue(makeOAIResponse({ content: "done" }));

    const msg: AssistantMessage = {
      role: "assistant",
      content: "Let me look that up.",
      toolCalls: [
        { id: "call_1", name: "search", input: { query: "vitest" } },
      ],
    };

    const adapter = await makeAdapter();
    await adapter.chat({
      model: "gpt-4.1",
      system: "sys",
      messages: [msg],
    });

    const callArgs = createFn.mock.calls[0][0] as {
      messages: Array<{
        role: string;
        content: string | null;
        tool_calls?: Array<{
          id: string;
          type: string;
          function: { name: string; arguments: string };
        }>;
      }>;
    };
    const assistantOAI = callArgs.messages[1];
    expect(assistantOAI.role).toBe("assistant");
    expect(assistantOAI.content).toBe("Let me look that up.");
    expect(assistantOAI.tool_calls).toHaveLength(1);
    expect(assistantOAI.tool_calls![0]).toEqual({
      id: "call_1",
      type: "function",
      function: { name: "search", arguments: JSON.stringify({ query: "vitest" }) },
    });
  });

  it("converts ToolResultMessage to role:tool messages", async () => {
    createFn.mockResolvedValue(makeOAIResponse({ content: "done" }));

    const msg: ToolResultMessage = {
      role: "user",
      toolResults: [
        { toolUseId: "call_1", content: "result text" },
        { toolUseId: "call_2", content: "other result" },
      ],
    };

    const adapter = await makeAdapter();
    await adapter.chat({
      model: "gpt-4.1",
      system: "sys",
      messages: [msg],
    });

    const callArgs = createFn.mock.calls[0][0] as {
      messages: Array<{ role: string; tool_call_id?: string; content: string }>;
    };
    // index 0 is system, indices 1 and 2 are the tool results
    expect(callArgs.messages[1]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "result text",
    });
    expect(callArgs.messages[2]).toEqual({
      role: "tool",
      tool_call_id: "call_2",
      content: "other result",
    });
  });

  // ── Response normalisation ──────────────────────────────────────

  it("normalises finish_reason stop -> stopReason end", async () => {
    createFn.mockResolvedValue(
      makeOAIResponse({ content: "hi", finishReason: "stop" }),
    );
    const adapter = await makeAdapter();
    const result = await adapter.chat({
      model: "gpt-4.1",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.stopReason).toBe("end");
  });

  it("normalises finish_reason tool_calls -> stopReason tool_use", async () => {
    createFn.mockResolvedValue(
      makeOAIResponse({
        content: null,
        finishReason: "tool_calls",
        toolCalls: [
          { id: "c1", name: "foo", arguments: '{"x":1}' },
        ],
      }),
    );
    const adapter = await makeAdapter();
    const result = await adapter.chat({
      model: "gpt-4.1",
      system: "sys",
      messages: [{ role: "user", content: "call a tool" }],
    });
    expect(result.stopReason).toBe("tool_use");
  });

  it("normalises finish_reason length -> stopReason max_tokens", async () => {
    createFn.mockResolvedValue(
      makeOAIResponse({ content: "truncated", finishReason: "length" }),
    );
    const adapter = await makeAdapter();
    const result = await adapter.chat({
      model: "gpt-4.1",
      system: "sys",
      messages: [{ role: "user", content: "write a lot" }],
    });
    expect(result.stopReason).toBe("max_tokens");
  });

  it("maps usage tokens correctly", async () => {
    createFn.mockResolvedValue(
      makeOAIResponse({ content: "ok", promptTokens: 42, completionTokens: 17 }),
    );
    const adapter = await makeAdapter();
    const result = await adapter.chat({
      model: "gpt-4.1",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 17 });
  });

  it("returns empty string for null content", async () => {
    createFn.mockResolvedValue(
      makeOAIResponse({ content: null, finishReason: "stop" }),
    );
    const adapter = await makeAdapter();
    const result = await adapter.chat({
      model: "gpt-4.1",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.text).toBe("");
  });

  // ── Edge cases ──────────────────────────────────────────────────

  it("treats empty tool_calls array as no tool calls", async () => {
    createFn.mockResolvedValue({
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: "nothing",
            tool_calls: [],
          },
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 5 },
    });
    const adapter = await makeAdapter();
    const result = await adapter.chat({
      model: "gpt-4.1",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.toolCalls).toEqual([]);
  });

  it("returns all parallel tool calls", async () => {
    createFn.mockResolvedValue(
      makeOAIResponse({
        content: null,
        finishReason: "tool_calls",
        toolCalls: [
          { id: "c1", name: "tool_a", arguments: '{"a":1}' },
          { id: "c2", name: "tool_b", arguments: '{"b":2}' },
          { id: "c3", name: "tool_c", arguments: '{"c":3}' },
        ],
      }),
    );
    const adapter = await makeAdapter();
    const result = await adapter.chat({
      model: "gpt-4.1",
      system: "sys",
      messages: [{ role: "user", content: "call all tools" }],
    });
    expect(result.toolCalls).toHaveLength(3);
    expect(result.toolCalls[0]).toEqual({ id: "c1", name: "tool_a", input: { a: 1 } });
    expect(result.toolCalls[1]).toEqual({ id: "c2", name: "tool_b", input: { b: 2 } });
    expect(result.toolCalls[2]).toEqual({ id: "c3", name: "tool_c", input: { c: 3 } });
  });

  it("handles malformed tool call arguments gracefully", async () => {
    createFn.mockResolvedValue(
      makeOAIResponse({
        content: null,
        finishReason: "tool_calls",
        toolCalls: [{ id: "c1", name: "bad_tool", arguments: "not-json" }],
      }),
    );
    const adapter = await makeAdapter();
    const result = await adapter.chat({
      model: "gpt-4.1",
      system: "sys",
      messages: [{ role: "user", content: "go" }],
    });
    // Falls back to empty input object
    expect(result.toolCalls[0].input).toEqual({});
  });
});

// ── Missing package error test ────────────────────────────────────────

describe("OpenAIAdapter missing openai package", () => {
  it("throws a helpful install error when openai is not available", async () => {
    // Mock the import to reject
    vi.doMock("openai", () => {
      throw new Error("Cannot find module 'openai'");
    });

    const { OpenAIAdapter } = await import("./openai.js?v=missing-" + Date.now());
    const adapter = new OpenAIAdapter("gpt-4.1");

    await expect(
      adapter.chat({
        model: "gpt-4.1",
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow('OpenAI provider requires the "openai" package. Run: npm install openai');
  });
});
