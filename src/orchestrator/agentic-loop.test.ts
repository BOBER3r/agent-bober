/**
 * Unit tests for the agentic loop's refusal handling (sprint-1: sc-1-3, sc-1-5).
 *
 * Uses a fake LLMClient that returns scripted ChatResponses in order,
 * mirroring the ScriptedClient pattern in `src/providers/structured.test.ts`.
 */

import { describe, it, expect } from "vitest";
import { runAgenticLoop } from "./agentic-loop.js";
import type { LLMClient, ChatParams, ChatResponse } from "../providers/types.js";

// ── Fake LLMClient ───────────────────────────────────────────────────

/** Returns scripted ChatResponses in order; repeats the last once exhausted. */
class ScriptedLoopClient implements LLMClient {
  private idx = 0;
  constructor(private readonly responses: ChatResponse[]) {}
  async chat(_params: ChatParams): Promise<ChatResponse> {
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
