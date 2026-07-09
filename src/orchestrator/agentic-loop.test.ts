/**
 * Unit tests for the agentic loop's refusal handling (sprint-1: sc-1-3, sc-1-5).
 *
 * Uses a fake LLMClient that returns scripted ChatResponses in order,
 * mirroring the ScriptedClient pattern in `src/providers/structured.test.ts`.
 */

import { describe, it, expect, vi } from "vitest";
import { performance } from "node:perf_hooks";
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

// ── sc-4-2 / sc-4-4 / sc-4-5: parallel read-only tool execution ───────

describe("runAgenticLoop — parallel read-only tool execution (sprint-4)", () => {
  const READ_ONLY_TOOLS = [
    { name: "read_file", readOnly: true, description: "r", input_schema: { type: "object" as const, properties: {} } },
    { name: "glob", readOnly: true, description: "g", input_schema: { type: "object" as const, properties: {} } },
    { name: "grep", readOnly: true, description: "s", input_schema: { type: "object" as const, properties: {} } },
  ];

  const delayed = (ms: number, out: string) => async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return { output: out, isError: false };
  };

  function makeDelayedHandlers(): Map<string, () => Promise<{ output: string; isError: boolean }>> {
    return new Map([
      ["read_file", delayed(50, "a")],
      ["glob", delayed(50, "b")],
      ["grep", delayed(50, "c")],
    ]);
  }

  /** Build a fresh scripted client for one tool-use turn followed by an ending turn. */
  function makeScriptedTurnClient(): ScriptedLoopClient {
    return new ScriptedLoopClient([
      {
        ...base,
        text: "",
        stopReason: "tool_use",
        toolCalls: [
          { id: "t1", name: "read_file", input: {} },
          { id: "t2", name: "glob", input: {} },
          { id: "t3", name: "grep", input: {} },
        ],
      },
      { ...base, text: "done", stopReason: "end" },
    ]);
  }

  it("sc-4-2: with parallelReadOnlyTools:true, a turn's read-only calls overlap — meaningfully faster than the SAME turn serial", async () => {
    // Measure serial and parallel back-to-back so both share the same
    // machine-load conditions — self-calibrated comparison instead of a
    // fixed absolute-ms threshold (real setTimeout delays are used, not fake
    // timers, per Pattern 7 — a hardcoded upper bound can flake on a loaded box).
    const tSerialStart = performance.now();
    const serialResult = await runAgenticLoop({
      client: makeScriptedTurnClient(),
      model: "m",
      systemPrompt: "s",
      userMessage: "u",
      tools: READ_ONLY_TOOLS,
      toolHandlers: makeDelayedHandlers(),
      maxTurns: 3,
      // parallelReadOnlyTools intentionally omitted — byte-identical serial baseline.
    });
    const serialElapsed = performance.now() - tSerialStart;

    const tParallelStart = performance.now();
    const parallelResult = await runAgenticLoop({
      client: makeScriptedTurnClient(),
      model: "m",
      systemPrompt: "s",
      userMessage: "u",
      tools: READ_ONLY_TOOLS,
      toolHandlers: makeDelayedHandlers(),
      maxTurns: 3,
      parallelReadOnlyTools: true,
    });
    const parallelElapsed = performance.now() - tParallelStart;

    // Hard lower bound — three sequential 50ms waits can never resolve faster
    // than ~150ms, regardless of machine load.
    expect(serialElapsed).toBeGreaterThanOrEqual(140);
    expect(parallelElapsed).toBeLessThan(serialElapsed * 0.7);

    expect(parallelResult.toolsCalled).toEqual(["read_file", "glob", "grep"]);
    expect(parallelResult.stopReason).toBe("end");
    expect(serialResult.toolsCalled).toEqual(["read_file", "glob", "grep"]);
  });

  it("sc-4-4: with the flag absent, the SAME read-only-annotated batch stays serial (elapsed >= 140ms)", async () => {
    const client = new ScriptedLoopClient([
      {
        ...base,
        text: "",
        stopReason: "tool_use",
        toolCalls: [
          { id: "t1", name: "read_file", input: {} },
          { id: "t2", name: "glob", input: {} },
          { id: "t3", name: "grep", input: {} },
        ],
      },
      { ...base, text: "done", stopReason: "end" },
    ]);

    const t0 = performance.now();
    const result = await runAgenticLoop({
      client,
      model: "m",
      systemPrompt: "s",
      userMessage: "u",
      tools: READ_ONLY_TOOLS,
      toolHandlers: makeDelayedHandlers(),
      maxTurns: 3,
      // parallelReadOnlyTools intentionally omitted
    });
    const elapsed = performance.now() - t0;

    expect(elapsed).toBeGreaterThanOrEqual(140);
    expect(result.toolsCalled).toEqual(["read_file", "glob", "grep"]);
  });

  it("sc-4-4: with parallelReadOnlyTools:true but UNANNOTATED tools, execution stays serial", async () => {
    const plainTools = [
      { name: "read_file", description: "r", input_schema: { type: "object" as const, properties: {} } },
      { name: "glob", description: "g", input_schema: { type: "object" as const, properties: {} } },
    ];
    const client = new ScriptedLoopClient([
      {
        ...base,
        text: "",
        stopReason: "tool_use",
        toolCalls: [
          { id: "t1", name: "read_file", input: {} },
          { id: "t2", name: "glob", input: {} },
        ],
      },
      { ...base, text: "done", stopReason: "end" },
    ]);

    const t0 = performance.now();
    const result = await runAgenticLoop({
      client,
      model: "m",
      systemPrompt: "s",
      userMessage: "u",
      tools: plainTools,
      toolHandlers: new Map([
        ["read_file", delayed(40, "a")],
        ["glob", delayed(40, "b")],
      ]),
      maxTurns: 3,
      parallelReadOnlyTools: true,
    });
    const elapsed = performance.now() - t0;

    expect(elapsed).toBeGreaterThanOrEqual(70); // ~80ms serial, never overlaps unannotated tools
    expect(result.toolsCalled).toEqual(["read_file", "glob"]);
  });

  it("sc-4-3: a thrown handler mid-batch produces an in-slot error result without aborting the turn", async () => {
    const client = new ScriptedLoopClient([
      {
        ...base,
        text: "",
        stopReason: "tool_use",
        toolCalls: [
          { id: "t1", name: "read_file", input: {} },
          { id: "t2", name: "glob", input: {} },
          { id: "t3", name: "grep", input: {} },
        ],
      },
      { ...base, text: "done", stopReason: "end" },
    ]);

    const result = await runAgenticLoop({
      client,
      model: "m",
      systemPrompt: "s",
      userMessage: "u",
      tools: READ_ONLY_TOOLS,
      toolHandlers: new Map([
        ["read_file", async () => ({ output: "a", isError: false })],
        [
          "glob",
          async () => {
            throw new Error("boom");
          },
        ],
        ["grep", async () => ({ output: "c", isError: false })],
      ]),
      maxTurns: 3,
      parallelReadOnlyTools: true,
    });

    // The loop completes normally (turn continues, second turn ends it) —
    // the throw never propagates out of the tool-execution step.
    expect(result.stopReason).toBe("end");
    expect(result.toolsCalled).toEqual(["read_file", "glob", "grep"]);
  });
});
