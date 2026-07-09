/**
 * Unit tests for the agentic loop's refusal handling (sprint-1: sc-1-3, sc-1-5).
 *
 * Uses a fake LLMClient that returns scripted ChatResponses in order,
 * mirroring the ScriptedClient pattern in `src/providers/structured.test.ts`.
 */

import { describe, it, expect, vi } from "vitest";
import { runAgenticLoop } from "./agentic-loop.js";
import { Budget } from "./workflow/budget.js";
import type { LLMClient, ChatParams, ChatResponse } from "../providers/types.js";

// ── Fake LLMClient ───────────────────────────────────────────────────

/** Returns scripted ChatResponses in order; repeats the last once exhausted. */
class ScriptedLoopClient implements LLMClient {
  private idx = 0;
  callCount = 0;
  lastParams?: ChatParams;
  constructor(private readonly responses: ChatResponse[]) {}
  async chat(params: ChatParams): Promise<ChatResponse> {
    this.callCount += 1;
    this.lastParams = params;
    const r = this.responses[Math.min(this.idx, this.responses.length - 1)];
    this.idx += 1;
    return r;
  }
}

const base = { toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };

// ── Tests ────────────────────────────────────────────────────────────

describe("runAgenticLoop — refusal handling", () => {
  it("sc-1-3: resolves with refused:true on a refusal (no throw)", async () => {
    const client = new ScriptedLoopClient([
      { ...base, text: "I can't help with that.", stopReason: "refusal" },
    ]);

    const result = await runAgenticLoop({
      client,
      model: "m",
      systemPrompt: "s",
      userMessage: "u",
      tools: [],
      toolHandlers: new Map(),
      maxTurns: 3,
    });

    expect(result.refused).toBe(true);
    expect(result.stopReason).toBe("refusal");
    expect(result.finalText).toBe("I can't help with that.");
  });

  it("sc-1-3: refusal AFTER a prior tool_use turn still sets refused:true", async () => {
    const client = new ScriptedLoopClient([
      {
        ...base,
        text: "",
        toolCalls: [{ id: "t1", name: "noop", input: {} }],
        stopReason: "tool_use",
      },
      { ...base, text: "refused", stopReason: "refusal" },
    ]);

    const handlers = new Map([
      ["noop", async () => ({ output: "ok", isError: false })],
    ]);

    const result = await runAgenticLoop({
      client,
      model: "m",
      systemPrompt: "s",
      userMessage: "u",
      tools: [
        { name: "noop", description: "n", input_schema: { type: "object", properties: {} } },
      ],
      toolHandlers: handlers,
      maxTurns: 3,
    });

    expect(result.refused).toBe(true);
    expect(result.stopReason).toBe("refusal");
    expect(result.toolsCalled).toEqual(["noop"]);
  });

  it("sc-1-5: a normal completion has NO 'refused' key", async () => {
    const client = new ScriptedLoopClient([{ ...base, text: "done", stopReason: "end" }]);

    const result = await runAgenticLoop({
      client,
      model: "m",
      systemPrompt: "s",
      userMessage: "u",
      tools: [],
      toolHandlers: new Map(),
      maxTurns: 3,
    });

    expect(Object.hasOwn(result, "refused")).toBe(false);
    expect(result.stopReason).toBe("end");
  });

  it("sc-1-5: max_turns_exceeded path also has no 'refused' key (regression)", async () => {
    const client = new ScriptedLoopClient([
      {
        ...base,
        text: "still working",
        toolCalls: [{ id: "t1", name: "noop", input: {} }],
        stopReason: "tool_use",
      },
    ]);
    const handlers = new Map([
      ["noop", async () => ({ output: "ok", isError: false })],
    ]);

    const result = await runAgenticLoop({
      client,
      model: "m",
      systemPrompt: "s",
      userMessage: "u",
      tools: [
        { name: "noop", description: "n", input_schema: { type: "object", properties: {} } },
      ],
      toolHandlers: handlers,
      maxTurns: 2,
    });

    expect(result.stopReason).toBe("max_turns_exceeded");
    expect(Object.hasOwn(result, "refused")).toBe(false);
  });
});

// ── sc-3-2: effort forwarded to ChatParams only when configured ──────

describe("runAgenticLoop — effort forwarding (sc-3-2)", () => {
  it("forwards effort onto ChatParams.effort when configured", async () => {
    const client = new ScriptedLoopClient([{ ...base, text: "done", stopReason: "end" }]);

    await runAgenticLoop({
      client,
      model: "m",
      systemPrompt: "s",
      userMessage: "u",
      tools: [],
      toolHandlers: new Map(),
      maxTurns: 3,
      effort: "high",
    });

    expect(client.lastParams?.effort).toBe("high");
  });

  it("omits effort from ChatParams entirely when not configured (byte-identical)", async () => {
    const client = new ScriptedLoopClient([{ ...base, text: "done", stopReason: "end" }]);

    await runAgenticLoop({
      client,
      model: "m",
      systemPrompt: "s",
      userMessage: "u",
      tools: [],
      toolHandlers: new Map(),
      maxTurns: 3,
    });

    expect(Object.hasOwn(client.lastParams as object, "effort")).toBe(false);
  });
});

// ── sc-3-3 / sc-3-4: budget ceiling + cumulative cost ─────────────────

describe("runAgenticLoop — budget ceiling + cumulative cost (sc-3-3, sc-3-4)", () => {
  it("sc-3-3: charges tokens+cost per turn and stops gracefully at the ceiling, without a 3rd call", async () => {
    const client = new ScriptedLoopClient([
      {
        toolCalls: [{ id: "t1", name: "noop", input: {} }],
        usage: { inputTokens: 1, outputTokens: 1 },
        text: "",
        stopReason: "tool_use",
        costUsd: 0.6,
      },
      {
        toolCalls: [{ id: "t2", name: "noop", input: {} }],
        usage: { inputTokens: 1, outputTokens: 1 },
        text: "",
        stopReason: "tool_use",
        costUsd: 0.6,
      },
      { ...base, text: "done", stopReason: "end", costUsd: 0.1 },
    ]);
    const handlers = new Map([
      ["noop", async () => ({ output: "ok", isError: false })],
    ]);

    const budget = new Budget({ maxUsd: 1.0 });
    const assertSpy = vi.spyOn(budget, "assertWithinBudget");

    const result = await runAgenticLoop({
      client,
      model: "m",
      systemPrompt: "s",
      userMessage: "u",
      tools: [
        { name: "noop", description: "n", input_schema: { type: "object", properties: {} } },
      ],
      toolHandlers: handlers,
      maxTurns: 5,
      budget,
    });

    expect(result.stopReason).toBe("budget_exceeded");
    expect(result.turnsUsed).toBe(2);
    expect(client.callCount).toBe(2);
    expect(assertSpy).not.toHaveBeenCalled();
    expect(result.costUsd).toBe(1.2);
  });

  it("sc-3-4: costUsd equals the sum of per-turn costs when present", async () => {
    const client = new ScriptedLoopClient([
      {
        toolCalls: [{ id: "t1", name: "noop", input: {} }],
        usage: { inputTokens: 1, outputTokens: 1 },
        text: "",
        stopReason: "tool_use",
        costUsd: 0.25,
      },
      { ...base, text: "done", stopReason: "end", costUsd: 0.5 },
    ]);
    const handlers = new Map([
      ["noop", async () => ({ output: "ok", isError: false })],
    ]);

    const result = await runAgenticLoop({
      client,
      model: "m",
      systemPrompt: "s",
      userMessage: "u",
      tools: [
        { name: "noop", description: "n", input_schema: { type: "object", properties: {} } },
      ],
      toolHandlers: handlers,
      maxTurns: 5,
    });

    expect(result.costUsd).toBe(0.75);
  });

  it("sc-3-4: costUsd key is absent when no turn reports a cost", async () => {
    const client = new ScriptedLoopClient([{ ...base, text: "done", stopReason: "end" }]);

    const result = await runAgenticLoop({
      client,
      model: "m",
      systemPrompt: "s",
      userMessage: "u",
      tools: [],
      toolHandlers: new Map(),
      maxTurns: 3,
    });

    expect(Object.hasOwn(result, "costUsd")).toBe(false);
  });

  it("without a budget, no ceiling ever fires (byte-identical to no-budget path)", async () => {
    const client = new ScriptedLoopClient([
      {
        toolCalls: [{ id: "t1", name: "noop", input: {} }],
        usage: { inputTokens: 1, outputTokens: 1 },
        text: "",
        stopReason: "tool_use",
        costUsd: 100,
      },
      { ...base, text: "done", stopReason: "end", costUsd: 100 },
    ]);
    const handlers = new Map([
      ["noop", async () => ({ output: "ok", isError: false })],
    ]);

    const result = await runAgenticLoop({
      client,
      model: "m",
      systemPrompt: "s",
      userMessage: "u",
      tools: [
        { name: "noop", description: "n", input_schema: { type: "object", properties: {} } },
      ],
      toolHandlers: handlers,
      maxTurns: 5,
    });

    expect(result.stopReason).toBe("end");
    expect(result.costUsd).toBe(200);
  });
});
