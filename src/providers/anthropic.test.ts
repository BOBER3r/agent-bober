/**
 * Unit tests for AnthropicAdapter prompt caching.
 *
 * Uses a top-level vi.mock("@anthropic-ai/sdk") because anthropic.ts uses a
 * static default import (not a dynamic import like openai.ts / google.ts).
 * The mock factory MUST return { default: FakeAnthropic } to match
 * `export default Anthropic` in the SDK's index.d.ts.
 *
 * Tests cover:
 * - C1: enabled flag -> system is a content-block array with ephemeral cache_control
 * - C2: enabled flag, >=2 messages -> latest message final block carries
 *       cache_control; total breakpoints across the entire request <= 4
 * - C3: disabled flag -> system is a plain string; deep JSON scan finds zero
 *       cache_control fields (byte-identical to the previous payload shape)
 * - Response normalisation is unchanged regardless of the flag
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatParams } from "./types.js";

// ── Fake Anthropic SDK ───────────────────────────────────────────────

// Shared mock function: captures the argument passed to messages.create.
const createMock = vi.fn();

// Static default-import mock (hoisted by vitest).
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { create: createMock };
    constructor(_opts?: unknown) {}
  }
  return { default: FakeAnthropic };
});

// Import AFTER vi.mock (hoisting ensures the mock is active).
import { AnthropicAdapter } from "./anthropic.js";

// ── Helpers ──────────────────────────────────────────────────────────

function fakeResponse() {
  return {
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 5, output_tokens: 7 },
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("AnthropicAdapter prompt caching", () => {
  beforeEach(() => {
    createMock.mockReset();
    createMock.mockResolvedValue(fakeResponse());
  });

  // ── C1: enabled -> system is a content-block array with ephemeral marker ─

  it("C1: caches system prompt as a content-block array when enabled", async () => {
    const adapter = new AnthropicAdapter("k", { promptCaching: true });
    await adapter.chat({
      model: "claude-x",
      system: "SYS",
      messages: [{ role: "user", content: "hi" }],
    } satisfies ChatParams);

    const req = createMock.mock.calls[0][0] as { system: unknown };
    expect(Array.isArray(req.system)).toBe(true);

    const block = (
      req.system as Array<{ type: string; text: string; cache_control?: { type: string } }>
    )[0];
    expect(block).toMatchObject({
      type: "text",
      text: "SYS",
      cache_control: { type: "ephemeral" },
    });
  });

  // ── C1 (default): promptCaching defaults to true when no opts passed ──────

  it("C1-default: promptCaching defaults to true (no opts argument)", async () => {
    const adapter = new AnthropicAdapter("k");
    await adapter.chat({
      model: "claude-x",
      system: "SYS",
      messages: [{ role: "user", content: "hi" }],
    } satisfies ChatParams);

    const req = createMock.mock.calls[0][0] as { system: unknown };
    expect(Array.isArray(req.system)).toBe(true);
  });

  // ── C2: enabled, >=2 messages -> latest message carries cache_control; ─────
  //        total breakpoints across the whole request <= 4

  it("C2: attaches cache_control to latest message and never exceeds 4 breakpoints", async () => {
    const adapter = new AnthropicAdapter("k", { promptCaching: true });
    await adapter.chat({
      model: "claude-x",
      system: "SYS",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "second" },
        { role: "user", content: "third" },
      ],
    } satisfies ChatParams);

    const req = createMock.mock.calls[0][0] as Record<string, unknown>;

    // Count every cache_control occurrence in the serialized payload.
    const count = JSON.stringify(req).match(/"cache_control"/g)?.length ?? 0;
    expect(count).toBeLessThanOrEqual(4);
    expect(count).toBeGreaterThan(0);

    // The LAST message (index 2) must have a content array whose final block
    // carries cache_control.
    const msgs = req["messages"] as Array<{
      role: string;
      content:
        | string
        | Array<{ type: string; text?: string; cache_control?: { type: string } }>;
    }>;
    const lastMsg = msgs[msgs.length - 1];
    expect(Array.isArray(lastMsg.content)).toBe(true);

    const lastContent = lastMsg.content as Array<{
      type: string;
      cache_control?: { type: string };
    }>;
    const lastBlock = lastContent[lastContent.length - 1];
    expect(lastBlock.cache_control).toEqual({ type: "ephemeral" });
  });

  // ── C2 edge: single message still gets a breakpoint ──────────────────────

  it("C2-edge: single message gets a cache_control breakpoint on its final block", async () => {
    const adapter = new AnthropicAdapter("k", { promptCaching: true });
    await adapter.chat({
      model: "claude-x",
      system: "SYS",
      messages: [{ role: "user", content: "only message" }],
    } satisfies ChatParams);

    const req = createMock.mock.calls[0][0] as Record<string, unknown>;
    const msgs = req["messages"] as Array<{
      content: Array<{ cache_control?: { type: string } }>;
    }>;
    const lastBlock = msgs[0].content[msgs[0].content.length - 1];
    expect(lastBlock.cache_control).toEqual({ type: "ephemeral" });
  });

  // ── C3: disabled -> plain-string system; zero cache_control anywhere ──────

  it("C3: sends plain-string system and zero cache_control when disabled", async () => {
    const adapter = new AnthropicAdapter("k", { promptCaching: false });
    await adapter.chat({
      model: "claude-x",
      system: "SYS",
      messages: [{ role: "user", content: "hi" }],
    } satisfies ChatParams);

    const req = createMock.mock.calls[0][0] as { system: unknown };
    expect(req.system).toBe("SYS");
    expect(JSON.stringify(req)).not.toContain("cache_control");
  });

  it("C3-multi: disabled with multiple messages still has zero cache_control", async () => {
    const adapter = new AnthropicAdapter("k", { promptCaching: false });
    await adapter.chat({
      model: "claude-x",
      system: "SYS",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "second" },
        { role: "user", content: "third" },
      ],
    } satisfies ChatParams);

    const req = createMock.mock.calls[0][0] as Record<string, unknown>;
    expect(req["system"]).toBe("SYS");
    expect(JSON.stringify(req)).not.toContain("cache_control");
  });

  // ── Response normalisation is unchanged ─────────────────────────────────

  // ── C2: effort set -> output_config.effort present with the value ──────────

  it("C2: forwards effort as output_config.effort when set", async () => {
    const adapter = new AnthropicAdapter("k", { promptCaching: true });
    await adapter.chat({
      model: "claude-x",
      system: "SYS",
      messages: [{ role: "user", content: "hi" }],
      effort: "max",
    } satisfies ChatParams);

    const req = createMock.mock.calls[0][0] as {
      output_config?: { effort?: string };
    };
    expect(req.output_config).toEqual({ effort: "max" });
  });

  // ── C3: effort unset -> NO output_config key anywhere in the request ────────

  it("C3: omits output_config entirely when effort is unset", async () => {
    const adapter = new AnthropicAdapter("k", { promptCaching: true });
    await adapter.chat({
      model: "claude-x",
      system: "SYS",
      messages: [{ role: "user", content: "hi" }],
    } satisfies ChatParams);

    const req = createMock.mock.calls[0][0] as Record<string, unknown>;
    expect(req).not.toHaveProperty("output_config");
    expect(JSON.stringify(req)).not.toContain("output_config");
  });

  // ── SystemUpdateMessage: mid_conv_system block shape ────────────────────────

  it("mid_conv_system: renders block with cache_control ephemeral when ttl supplied", async () => {
    const adapter = new AnthropicAdapter("k", { promptCaching: false });
    await adapter.chat({
      model: "claude-x",
      system: "SYS",
      messages: [{ role: "user", systemUpdate: "Always answer in French.", cacheTtl: "1h" }],
    } satisfies ChatParams);

    const req = createMock.mock.calls[0][0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const block = (req.messages[0].content as Array<Record<string, unknown>>)[0];
    expect(block).toMatchObject({
      type: "mid_conv_system",
      content: [{ type: "text", text: "Always answer in French." }],
      cache_control: { type: "ephemeral", ttl: "1h" },
    });
  });

  it("mid_conv_system: omits cache_control when no ttl supplied", async () => {
    const adapter = new AnthropicAdapter("k", { promptCaching: false });
    await adapter.chat({
      model: "claude-x",
      system: "SYS",
      messages: [{ role: "user", systemUpdate: "Be terse." }],
    } satisfies ChatParams);

    const req = createMock.mock.calls[0][0] as {
      messages: Array<{ content: unknown }>;
    };
    const block = (req.messages[0].content as Array<Record<string, unknown>>)[0];
    expect(block).toMatchObject({
      type: "mid_conv_system",
      content: [{ type: "text", text: "Be terse." }],
    });
    expect(block).not.toHaveProperty("cache_control");
  });

  // ── normalises response correctly regardless of caching flag ────────────────

  it("normalises response correctly regardless of caching flag", async () => {
    createMock.mockResolvedValue({
      content: [{ type: "text", text: "hello" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 20 },
    });

    const adapter = new AnthropicAdapter("k", { promptCaching: true });
    const result = await adapter.chat({
      model: "claude-x",
      system: "SYS",
      messages: [{ role: "user", content: "hi" }],
    } satisfies ChatParams);

    expect(result.text).toBe("hello");
    expect(result.stopReason).toBe("end");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
    expect(result.toolCalls).toEqual([]);
  });

  // ── Structured output (responseSchema → forced tool) ────────────────────────

  const schema = {
    type: "object" as const,
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
  };

  it("forces structured_output tool when responseSchema is set", async () => {
    const adapter = new AnthropicAdapter("k", { promptCaching: true });
    await adapter.chat({
      model: "claude-x",
      system: "SYS",
      messages: [{ role: "user", content: "hi" }],
      responseSchema: schema,
    } satisfies ChatParams);

    const req = createMock.mock.calls[0][0] as {
      tool_choice?: unknown;
      tools?: Array<{ name: string; input_schema: unknown }>;
    };
    expect(req.tool_choice).toEqual({ type: "tool", name: "structured_output" });
    expect(Array.isArray(req.tools)).toBe(true);
    expect(req.tools).toHaveLength(1);
    expect(req.tools?.[0].name).toBe("structured_output");
    expect(req.tools?.[0].input_schema).toBe(schema);
  });

  it("does not forward user tools when responseSchema is set", async () => {
    const adapter = new AnthropicAdapter("k", { promptCaching: true });
    await adapter.chat({
      model: "claude-x",
      system: "SYS",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          name: "search",
          description: "search the web",
          input_schema: { type: "object", properties: {} },
        },
      ],
      responseSchema: schema,
    } satisfies ChatParams);

    const req = createMock.mock.calls[0][0] as {
      tools?: Array<{ name: string }>;
    };
    const names = (req.tools ?? []).map((t) => t.name);
    expect(names).not.toContain("search");
    expect(names).toEqual(["structured_output"]);
  });

  it("stringifies the forced tool input into text", async () => {
    createMock.mockResolvedValue({
      content: [
        { type: "tool_use", id: "t1", name: "structured_output", input: { ok: true } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 3, output_tokens: 4 },
    });

    const adapter = new AnthropicAdapter("k", { promptCaching: true });
    const result = await adapter.chat({
      model: "claude-x",
      system: "SYS",
      messages: [{ role: "user", content: "hi" }],
      responseSchema: schema,
    } satisfies ChatParams);

    expect(result.text).toBe(JSON.stringify({ ok: true }));
    expect(result.toolCalls).toEqual([]);
    expect(result.stopReason).toBe("end");
  });

  it("no tool_choice when responseSchema absent (regression)", async () => {
    const adapter = new AnthropicAdapter("k", { promptCaching: true });
    await adapter.chat({
      model: "claude-x",
      system: "SYS",
      messages: [{ role: "user", content: "hi" }],
    } satisfies ChatParams);

    const req = createMock.mock.calls[0][0] as Record<string, unknown>;
    expect(req).not.toHaveProperty("tool_choice");
    expect(JSON.stringify(req)).not.toContain("tool_choice");
  });
});
