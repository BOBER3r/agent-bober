/**
 * Unit tests for ClaudeCodeAdapter.
 *
 * All tests use a mocked execa — no real claude CLI call is ever made.
 * Covers sprint sc-4-1 through sc-4-5.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// HOISTED to top of module by vitest. execa is a NAMED export.
vi.mock("execa", () => ({
  execa: vi.fn(),
}));

// Import AFTER vi.mock so we hold the mocked function.
import { execa } from "execa";
import { ClaudeCodeAdapter } from "./claude-code.js";

const mockedExeca = vi.mocked(execa);

beforeEach(() => {
  mockedExeca.mockReset();
});

// ── sc-4-3: result/usage mapping ─────────────────────────────────────────────

describe("ClaudeCodeAdapter.chat — result/usage mapping (sc-4-3)", () => {
  it("resolves to a ChatResponse whose text and usage match the mocked CLI JSON", async () => {
    mockedExeca.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({
        type: "result",
        result: "hello from claude",
        stop_reason: "end_turn",
        usage: { input_tokens: 42, output_tokens: 7 },
      }),
      stderr: "",
    } as never);

    const adapter = new ClaudeCodeAdapter("claude", 180_000);
    const res = await adapter.chat({
      model: "opus",
      system: "be brief",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(res.text).toBe("hello from claude");
    expect(res.usage.inputTokens).toBe(42);
    expect(res.usage.outputTokens).toBe(7);
    expect(res.stopReason).toBe("end"); // end_turn → end
    expect(res.toolCalls).toEqual([]);
  });

  it("resolves with empty text and zero usage when CLI returns no result/usage fields", async () => {
    mockedExeca.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ type: "result" }),
      stderr: "",
    } as never);

    const adapter = new ClaudeCodeAdapter();
    const res = await adapter.chat({
      model: "opus",
      system: "",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(res.text).toBe("");
    expect(res.usage.inputTokens).toBe(0);
    expect(res.usage.outputTokens).toBe(0);
  });
});

// ── sc-4-4: tools-guard throw without calling execa ──────────────────────────

describe("ClaudeCodeAdapter.chat — tools-guard (sc-4-4)", () => {
  it("throws on custom tools stating the CLI cannot return custom tool_use blocks", async () => {
    const adapter = new ClaudeCodeAdapter();
    const oneTool = {
      name: "t",
      description: "d",
      input_schema: { type: "object" as const, properties: {} },
    };

    await expect(
      adapter.chat({
        model: "opus",
        system: "",
        messages: [{ role: "user", content: "hi" }],
        tools: [oneTool],
      }),
    ).rejects.toThrow(/cannot return custom tool_use blocks/);

    expect(mockedExeca).not.toHaveBeenCalled();
  });
});

// ── sc-4-5: binary + timeoutMs overrides reach execa ─────────────────────────

describe("ClaudeCodeAdapter.chat — binary/timeout overrides (sc-4-5)", () => {
  it("invokes execa with the overridden binary name and timeout", async () => {
    mockedExeca.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({
        result: "ok",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      stderr: "",
    } as never);

    const adapter = new ClaudeCodeAdapter("my-claude", 5_000);
    await adapter.chat({
      model: "opus",
      system: "",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(mockedExeca).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = mockedExeca.mock.calls[0]!;
    expect(bin).toBe("my-claude");
    expect(opts).toMatchObject({ timeout: 5_000 });
    expect(args).toContain("-p");
  });

  it("passes --model to execa args when model is provided", async () => {
    mockedExeca.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ result: "ok", usage: { input_tokens: 1, output_tokens: 1 } }),
      stderr: "",
    } as never);

    const adapter = new ClaudeCodeAdapter("claude", 180_000);
    await adapter.chat({
      model: "claude-opus-4-5",
      system: "",
      messages: [{ role: "user", content: "hi" }],
    });

    const [, args] = mockedExeca.mock.calls[0]!;
    const argsArray = args as string[];
    const modelIdx = argsArray.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(argsArray[modelIdx + 1]).toBe("claude-opus-4-5");
  });

  it("appends --append-system-prompt when system is non-empty", async () => {
    mockedExeca.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ result: "ok", usage: { input_tokens: 1, output_tokens: 1 } }),
      stderr: "",
    } as never);

    const adapter = new ClaudeCodeAdapter();
    await adapter.chat({
      model: "opus",
      system: "be concise",
      messages: [{ role: "user", content: "hi" }],
    });

    const [, args] = mockedExeca.mock.calls[0]!;
    expect(args).toContain("--append-system-prompt");
    expect(args).toContain("be concise");
  });

  it("does not append --append-system-prompt when system is empty", async () => {
    mockedExeca.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ result: "ok", usage: { input_tokens: 1, output_tokens: 1 } }),
      stderr: "",
    } as never);

    const adapter = new ClaudeCodeAdapter();
    await adapter.chat({
      model: "opus",
      system: "",
      messages: [{ role: "user", content: "hi" }],
    });

    const [, args] = mockedExeca.mock.calls[0]!;
    expect(args).not.toContain("--append-system-prompt");
  });
});

// ── documents-guard throw without calling execa ──────────────────────────────

describe("ClaudeCodeAdapter.chat — documents-guard", () => {
  it("throws when documents are supplied, stating the CLI accepts only text", async () => {
    const adapter = new ClaudeCodeAdapter();

    await expect(
      adapter.chat({
        model: "claude",
        system: "sys",
        messages: [{ role: "user", content: "parse this" }],
        documents: [{ base64: "QkFTRTY0", mediaType: "application/pdf" }],
      }),
    ).rejects.toThrow(/does not support `documents`/);

    expect(mockedExeca).not.toHaveBeenCalled();
  });
});
