/**
 * Unit tests for the pure `summarizeMessages` helper
 * (agent-loop-capability-port sprint 7 — sc-7-1, sc-7-4).
 */

import { describe, it, expect } from "vitest";
import { summarizeMessages } from "./compaction.js";
import type { LLMClient, ChatParams, ChatResponse, Message } from "../providers/types.js";

class ScriptedClient implements LLMClient {
  lastParams?: ChatParams;
  constructor(
    private readonly respond: (params: ChatParams) => ChatResponse | Promise<ChatResponse>,
  ) {}
  async chat(params: ChatParams): Promise<ChatResponse> {
    this.lastParams = params;
    return this.respond(params);
  }
}

const HEAD: Message[] = [
  { role: "user", content: "please write foo.ts" },
  {
    role: "assistant",
    content: "on it",
    toolCalls: [{ id: "t1", name: "write_file", input: { path: "foo.ts" } }],
  },
  {
    role: "user",
    toolResults: [{ toolUseId: "t1", content: "wrote foo.ts", isError: false }],
  },
];

describe("summarizeMessages", () => {
  it("returns a [Conversation summary] user message plus the call's usage/costUsd", async () => {
    const client = new ScriptedClient(() => ({
      text: "Wrote foo.ts per the user's request.",
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 42, outputTokens: 8 },
      costUsd: 0.015,
    }));

    const outcome = await summarizeMessages({ client, model: "m", head: HEAD });

    expect(outcome).toBeDefined();
    expect(outcome?.summaryMessage).toEqual({
      role: "user",
      content: "[Conversation summary] Wrote foo.ts per the user's request.",
    });
    expect(outcome?.usage).toEqual({ inputTokens: 42, outputTokens: 8 });
    expect(outcome?.costUsd).toBe(0.015);
  });

  it("omits costUsd from the outcome when the response reports none", async () => {
    const client = new ScriptedClient(() => ({
      text: "summary",
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 1, outputTokens: 1 },
    }));

    const outcome = await summarizeMessages({ client, model: "m", head: HEAD });

    expect(outcome).toBeDefined();
    expect(Object.hasOwn(outcome ?? {}, "costUsd")).toBe(false);
  });

  it("never forwards tools/effort/responseSchema; sends one bounded, no-tools user message", async () => {
    const client = new ScriptedClient(() => ({
      text: "summary",
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 1, outputTokens: 1 },
    }));

    await summarizeMessages({ client, model: "m", head: HEAD, maxTokens: 123 });

    const params = client.lastParams!;
    expect(params.tools).toBeUndefined();
    expect(params.effort).toBeUndefined();
    expect(params.responseSchema).toBeUndefined();
    expect(params.maxTokens).toBe(123);
    expect(params.messages).toHaveLength(1);
    expect(params.messages[0].role).toBe("user");
    // Never sends raw tool_use/tool_result blocks without `tools` — the head
    // is serialized to plain text instead.
    expect("toolCalls" in params.messages[0]).toBe(false);
    expect("toolResults" in params.messages[0]).toBe(false);
  });

  it("defaults maxTokens to 4096 when omitted", async () => {
    const client = new ScriptedClient(() => ({
      text: "summary",
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 1, outputTokens: 1 },
    }));

    await summarizeMessages({ client, model: "m", head: HEAD });

    expect(client.lastParams?.maxTokens).toBe(4096);
  });

  it("appends caller-supplied instructions to the base summarization system prompt", async () => {
    const client = new ScriptedClient(() => ({
      text: "summary",
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 1, outputTokens: 1 },
    }));

    await summarizeMessages({
      client,
      model: "m",
      head: HEAD,
      instructions: "Preserve the exact API signature discussed.",
    });

    expect(client.lastParams?.system).toContain("Summarize this conversation preserving");
    expect(client.lastParams?.system).toContain("Preserve the exact API signature discussed.");
  });

  it("fails open: returns undefined (never throws) when the summarizer call rejects", async () => {
    const client = new ScriptedClient(() => {
      throw new Error("boom");
    });

    const outcome = await summarizeMessages({ client, model: "m", head: HEAD });

    expect(outcome).toBeUndefined();
  });
});
