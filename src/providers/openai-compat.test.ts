/**
 * Unit tests for OpenAICompatAdapter.
 *
 * OpenAICompatAdapter extends OpenAIAdapter — all underlying tool conversion,
 * message conversion, and response normalisation is tested in openai.test.ts.
 *
 * These tests focus on:
 * - Constructor sets custom baseURL on the underlying OpenAI client
 * - Default apiKey "not-needed" is used when no key provided
 * - Explicit apiKey overrides the default
 * - Model and tools are passed through to the OpenAI API correctly
 * - Error handling: missing openai package produces the correct error
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import type { ChatParams, ToolDef } from "./types.js";
import { createClient } from "./factory.js";

// ── Fake OpenAI client factory ───────────────────────────────────────

type FakeCreateFn = Mock;

interface ConstructorOptions {
  apiKey?: string;
  baseURL?: string;
}

let lastConstructorOptions: ConstructorOptions = {};

function makeFakeOpenAI(createFn: FakeCreateFn) {
  return class FakeOpenAI {
    chat = {
      completions: {
        create: createFn,
      },
    };

    constructor(opts: ConstructorOptions) {
      lastConstructorOptions = opts;
    }
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

function makeOAIResponse(opts: {
  content?: string | null;
  finishReason?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
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
    usage: { prompt_tokens: 10, completion_tokens: 20 },
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("OpenAICompatAdapter", () => {
  let createFn: FakeCreateFn;

  beforeEach(() => {
    createFn = vi.fn();
    lastConstructorOptions = {};

    vi.doMock("openai", () => ({ default: makeFakeOpenAI(createFn) }));
  });

  async function makeAdapter(opts: {
    endpoint?: string;
    model?: string;
    apiKey?: string;
  } = {}) {
    const { OpenAICompatAdapter } = await import("./openai-compat.js?v=" + Date.now());
    return new OpenAICompatAdapter(
      opts.endpoint ?? "http://localhost:11434/v1",
      opts.model ?? "llama3",
      opts.apiKey,
    );
  }

  // ── Constructor behaviour ───────────────────────────────────────

  it("passes custom baseURL to the OpenAI client", async () => {
    createFn.mockResolvedValue(makeOAIResponse({ content: "hello" }));

    const adapter = await makeAdapter({ endpoint: "http://localhost:11434/v1" });
    await adapter.chat({
      model: "llama3",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(lastConstructorOptions.baseURL).toBe("http://localhost:11434/v1");
  });

  it("uses 'not-needed' as default apiKey when no key is provided", async () => {
    createFn.mockResolvedValue(makeOAIResponse({ content: "hello" }));

    const adapter = await makeAdapter({ endpoint: "http://my-server/v1" });
    await adapter.chat({
      model: "llama3",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(lastConstructorOptions.apiKey).toBe("not-needed");
  });

  it("uses the provided apiKey when one is given", async () => {
    createFn.mockResolvedValue(makeOAIResponse({ content: "hello" }));

    const adapter = await makeAdapter({
      endpoint: "http://my-server/v1",
      apiKey: "my-secret-key",
    });
    await adapter.chat({
      model: "llama3",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(lastConstructorOptions.apiKey).toBe("my-secret-key");
  });

  it("accepts different endpoint URLs", async () => {
    createFn.mockResolvedValue(makeOAIResponse({ content: "ok" }));

    const adapter = await makeAdapter({ endpoint: "https://api.together.xyz/v1" });
    await adapter.chat({
      model: "llama3",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(lastConstructorOptions.baseURL).toBe("https://api.together.xyz/v1");
  });

  // ── Inherited OpenAI behaviour ──────────────────────────────────

  it("passes tools in OpenAI function format (inherited from OpenAIAdapter)", async () => {
    createFn.mockResolvedValue(makeOAIResponse({ content: "ok" }));

    const tools: ToolDef[] = [
      {
        name: "list_files",
        description: "List files in a directory",
        input_schema: {
          type: "object",
          properties: { path: { type: "string", description: "Directory path" } },
          required: ["path"],
        },
      },
    ];

    const adapter = await makeAdapter();
    const params: ChatParams = {
      model: "llama3",
      system: "sys",
      messages: [{ role: "user", content: "list files" }],
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
    expect(callArgs.tools[0].type).toBe("function");
    expect(callArgs.tools[0].function.name).toBe("list_files");
  });

  it("normalises tool call response (inherited from OpenAIAdapter)", async () => {
    createFn.mockResolvedValue(
      makeOAIResponse({
        content: null,
        finishReason: "tool_calls",
        toolCalls: [
          { id: "c1", name: "list_files", arguments: '{"path":"/tmp"}' },
        ],
      }),
    );

    const adapter = await makeAdapter();
    const result = await adapter.chat({
      model: "llama3",
      system: "sys",
      messages: [{ role: "user", content: "list files" }],
    });

    expect(result.stopReason).toBe("tool_use");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toEqual({
      id: "c1",
      name: "list_files",
      input: { path: "/tmp" },
    });
  });

  it("normalises text response (inherited from OpenAIAdapter)", async () => {
    createFn.mockResolvedValue(
      makeOAIResponse({ content: "Hello from Ollama!", finishReason: "stop" }),
    );

    const adapter = await makeAdapter();
    const result = await adapter.chat({
      model: "llama3",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.text).toBe("Hello from Ollama!");
    expect(result.stopReason).toBe("end");
  });

  // ── Structured output inheritance ───────────────────────────────
  //
  // Proves the local-model path (Ollama / LM Studio / DeepSeek) inherits
  // structured output for free from OpenAIAdapter: a responseSchema yields a
  // response_format of type "json_schema" in the create() call.

  it("forwards responseSchema as response_format json_schema (inherited from OpenAIAdapter)", async () => {
    createFn.mockResolvedValue(makeOAIResponse({ content: '{"ok":true}' }));

    const adapter = await makeAdapter({
      endpoint: "http://localhost:11434/v1",
      model: "llama3",
    });
    await adapter.chat({
      model: "llama3",
      system: "sys",
      messages: [{ role: "user", content: "give me json" }],
      responseSchema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
      },
    });

    const callArgs = createFn.mock.calls[0][0] as {
      response_format?: { type: string };
    };
    expect(callArgs.response_format?.type).toBe("json_schema");
  });

  // ── Error handling ──────────────────────────────────────────────

  it("throws helpful error when openai package is missing", async () => {
    vi.doMock("openai", () => {
      throw new Error("Cannot find module 'openai'");
    });

    const { OpenAICompatAdapter } = await import(
      "./openai-compat.js?v=missing-" + Date.now()
    );
    const adapter = new OpenAICompatAdapter(
      "http://localhost:11434/v1",
      "llama3",
    );

    await expect(
      adapter.chat({
        model: "llama3",
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow('OpenAI provider requires the "openai" package. Run: npm install openai');
  });

  // ── DeepSeek key injection (sc-2-5) ────────────────────────────────────────
  //
  // When DEEPSEEK_API_KEY is set and the user calls createClient with a deepseek
  // shorthand, the key must flow through to the OpenAI client constructor.
  // We use the existing vi.doMock("openai") + lastConstructorOptions harness.

  it("passes DEEPSEEK_API_KEY env value to the openai client when resolving deepseek-v4-pro (sc-2-5)", async () => {
    const fakeDeepSeekKey = "sk-fake-deepseek-sc25-test";
    const savedDeepSeek = process.env["DEEPSEEK_API_KEY"];
    process.env["DEEPSEEK_API_KEY"] = fakeDeepSeekKey;

    try {
      createFn.mockResolvedValue(makeOAIResponse({ content: "deepseek reply" }));
      vi.doMock("openai", () => ({ default: makeFakeOpenAI(createFn) }));

      // Drive through createClient so DEEPSEEK_API_KEY injection in factory.ts fires,
      // then call .chat() to trigger the lazy openai import and constructor capture.
      const client = createClient(null, null, undefined, "deepseek-v4-pro");
      await client.chat({
        model: "deepseek-v4-pro",
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
      });

      expect(lastConstructorOptions.apiKey).toBe(fakeDeepSeekKey);
    } finally {
      if (savedDeepSeek !== undefined) {
        process.env["DEEPSEEK_API_KEY"] = savedDeepSeek;
      } else {
        delete process.env["DEEPSEEK_API_KEY"];
      }
    }
  });
});

// ── Documents (fail-loud: no file-input surface) ─────────────────────

describe("OpenAICompatAdapter — documents (fail-loud)", () => {
  let createFn: FakeCreateFn;

  beforeEach(() => {
    createFn = vi.fn();
    vi.doMock("openai", () => ({ default: makeFakeOpenAI(createFn) }));
  });

  async function makeAdapter() {
    const { OpenAICompatAdapter } = await import(
      "./openai-compat.js?v=docs-" + Date.now()
    );
    return new OpenAICompatAdapter("http://localhost:11434/v1", "llama3");
  }

  it("throws a clear error when documents are supplied (never calls the endpoint)", async () => {
    const adapter = await makeAdapter();

    await expect(
      adapter.chat({
        model: "llama3",
        system: "sys",
        messages: [{ role: "user", content: "parse this" }],
        documents: [{ base64: "QkFTRTY0", mediaType: "application/pdf" }],
      }),
    ).rejects.toThrow(/does not support `documents`/);

    expect(createFn).not.toHaveBeenCalled();
  });

  it("delegates to OpenAIAdapter unchanged when documents is absent", async () => {
    createFn.mockResolvedValue(makeOAIResponse({ content: "hello" }));
    const adapter = await makeAdapter();

    const res = await adapter.chat({
      model: "llama3",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(res.text).toBe("hello");
    expect(createFn).toHaveBeenCalledTimes(1);
  });

  it("delegates unchanged when documents is an empty array", async () => {
    createFn.mockResolvedValue(makeOAIResponse({ content: "hello" }));
    const adapter = await makeAdapter();

    await adapter.chat({
      model: "llama3",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      documents: [],
    });

    expect(createFn).toHaveBeenCalledTimes(1);
  });
});
