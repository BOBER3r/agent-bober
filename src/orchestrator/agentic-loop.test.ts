/**
 * Unit tests for the agentic loop's refusal handling (sprint-1: sc-1-3, sc-1-5).
 *
 * Uses a fake LLMClient that returns scripted ChatResponses in order,
 * mirroring the ScriptedClient pattern in `src/providers/structured.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { performance } from "node:perf_hooks";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgenticLoop, resumeSession, forkSession } from "./agentic-loop.js";
import { Budget } from "./workflow/budget.js";
import { SessionStore } from "./session-store.js";
import type { LLMClient, ChatParams, ChatResponse, Message } from "../providers/types.js";
import type { LoopEvent } from "./loop-events.js";

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

// ── sprint-5: structured event stream + host-style hooks ──────────────

/** A tool-turn (calling `noop`) followed by a completion turn. Fresh per run. */
function makeToolThenEndClient(): ScriptedLoopClient {
  return new ScriptedLoopClient([
    {
      ...base,
      text: "",
      stopReason: "tool_use",
      toolCalls: [{ id: "t1", name: "noop", input: { x: 1 } }],
    },
    { ...base, text: "done", stopReason: "end" },
  ]);
}

const NOOP_TOOL = [
  { name: "noop", description: "n", input_schema: { type: "object" as const, properties: {} } },
];

describe("runAgenticLoop — structured event stream (sc-5-1)", () => {
  it("emits ordered typed events with the documented payload for a tool-turn + completion-turn run", async () => {
    const events: LoopEvent[] = [];
    const handlers = new Map([["noop", async () => ({ output: "ok", isError: false })]]);

    const result = await runAgenticLoop({
      client: makeToolThenEndClient(),
      model: "m",
      systemPrompt: "s",
      userMessage: "u",
      tools: NOOP_TOOL,
      toolHandlers: handlers,
      maxTurns: 5,
      onEvent: (e) => events.push(e),
    });

    expect(events.map((e) => e.type)).toEqual([
      "init",
      "turn-start",
      "tool-start",
      "tool-end",
      "turn-end",
      "turn-start",
      "turn-end",
      "result",
    ]);

    expect(events[0]).toEqual({ type: "init", model: "m", maxTurns: 5 });
    expect(events[1]).toEqual({ type: "turn-start", turn: 1 });
    expect(events[2]).toEqual({
      type: "tool-start",
      turn: 1,
      name: "noop",
      input: { x: 1 },
      toolUseId: "t1",
    });
    expect(events[3]).toEqual({
      type: "tool-end",
      turn: 1,
      name: "noop",
      toolUseId: "t1",
      isError: false,
    });
    expect(events[4]).toEqual({ type: "turn-end", turn: 1, toolsCalled: ["noop"] });
    expect(events[5]).toEqual({ type: "turn-start", turn: 2 });
    expect(events[6]).toEqual({ type: "turn-end", turn: 2, toolsCalled: [] });
    expect(events[7]).toEqual({ type: "result", stopReason: "end", turnsUsed: 2 });

    expect(result.stopReason).toBe("end");
    expect(result.turnsUsed).toBe(2);
  });
});

describe("runAgenticLoop — preToolUse veto (sc-5-2)", () => {
  it("a deny decision skips the handler; the model gets an isError rejection and the loop continues", async () => {
    const noopSpy = vi.fn(async () => ({ output: "ok", isError: false }));
    const client = makeToolThenEndClient();

    const result = await runAgenticLoop({
      client,
      model: "m",
      systemPrompt: "s",
      userMessage: "u",
      tools: NOOP_TOOL,
      toolHandlers: new Map([["noop", noopSpy]]),
      maxTurns: 5,
      hooks: {
        preToolUse: ({ name }) =>
          name === "noop" ? { allow: false, reason: "blocked" } : { allow: true },
      },
    });

    expect(noopSpy).not.toHaveBeenCalled();
    expect(result.stopReason).toBe("end");
    expect(result.turnsUsed).toBe(2);

    // The completion turn's chat call received the fed-back rejection result.
    const toolResultMsg = client.lastParams?.messages.find((m) => "toolResults" in m);
    expect(toolResultMsg).toBeDefined();
    const toolResults = (
      toolResultMsg as { toolResults: { isError?: boolean; content: string }[] }
    ).toolResults;
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0].isError).toBe(true);
    expect(toolResults[0].content).toContain("blocked");
  });
});

describe("runAgenticLoop — postToolUse + onStop exactly once per stop path (sc-5-3)", () => {
  it("completion path: postToolUse fires per call, onStop fires exactly once with the final result", async () => {
    const onStop = vi.fn();
    const postToolUse = vi.fn();
    const handlers = new Map([["noop", async () => ({ output: "ok", isError: false })]]);

    const result = await runAgenticLoop({
      client: makeToolThenEndClient(),
      model: "m",
      systemPrompt: "s",
      userMessage: "u",
      tools: NOOP_TOOL,
      toolHandlers: handlers,
      maxTurns: 5,
      hooks: { onStop, postToolUse },
    });

    expect(postToolUse).toHaveBeenCalledTimes(1);
    expect(postToolUse).toHaveBeenCalledWith(
      { name: "noop", input: { x: 1 }, toolUseId: "t1" },
      { toolUseId: "t1", content: "ok", isError: false },
    );
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledWith(result);
  });

  it("max-turns path: onStop fires exactly once with stopReason max_turns_exceeded", async () => {
    const onStop = vi.fn();
    const client = new ScriptedLoopClient([
      {
        ...base,
        text: "still working",
        toolCalls: [{ id: "t1", name: "noop", input: {} }],
        stopReason: "tool_use",
      },
    ]);
    const handlers = new Map([["noop", async () => ({ output: "ok", isError: false })]]);

    const result = await runAgenticLoop({
      client,
      model: "m",
      systemPrompt: "s",
      userMessage: "u",
      tools: NOOP_TOOL,
      toolHandlers: handlers,
      maxTurns: 2,
      hooks: { onStop },
    });

    expect(result.stopReason).toBe("max_turns_exceeded");
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledWith(result);
  });

  it("refusal path: onStop fires exactly once with stopReason refusal", async () => {
    const onStop = vi.fn();
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
      hooks: { onStop },
    });

    expect(result.refused).toBe(true);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledWith(result);
  });

  it("budget_exceeded path: onStop fires exactly once with stopReason budget_exceeded", async () => {
    const onStop = vi.fn();
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
    const handlers = new Map([["noop", async () => ({ output: "ok", isError: false })]]);
    const budget = new Budget({ maxUsd: 1.0 });

    const result = await runAgenticLoop({
      client,
      model: "m",
      systemPrompt: "s",
      userMessage: "u",
      tools: NOOP_TOOL,
      toolHandlers: handlers,
      maxTurns: 5,
      budget,
      hooks: { onStop },
    });

    expect(result.stopReason).toBe("budget_exceeded");
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledWith(result);
  });
});

describe("runAgenticLoop — throwing hooks never crash the loop (sc-5-4)", () => {
  it("a throwing onEvent is caught and logged; the run completes normally", async () => {
    const handlers = new Map([["noop", async () => ({ output: "ok", isError: false })]]);

    await expect(
      runAgenticLoop({
        client: makeToolThenEndClient(),
        model: "m",
        systemPrompt: "s",
        userMessage: "u",
        tools: NOOP_TOOL,
        toolHandlers: handlers,
        maxTurns: 5,
        onEvent: () => {
          throw new Error("boom");
        },
      }),
    ).resolves.toMatchObject({ stopReason: "end" });
  });

  it("a throwing postToolUse is caught and logged; the run completes normally and the handler still ran", async () => {
    const noopSpy = vi.fn(async () => ({ output: "ok", isError: false }));

    const result = await runAgenticLoop({
      client: makeToolThenEndClient(),
      model: "m",
      systemPrompt: "s",
      userMessage: "u",
      tools: NOOP_TOOL,
      toolHandlers: new Map([["noop", noopSpy]]),
      maxTurns: 5,
      hooks: {
        postToolUse: () => {
          throw new Error("boom");
        },
      },
    });

    expect(noopSpy).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe("end");
  });

  it("a throwing onStop is caught and logged; the run still resolves with the final result", async () => {
    await expect(
      runAgenticLoop({
        client: new ScriptedLoopClient([{ ...base, text: "done", stopReason: "end" }]),
        model: "m",
        systemPrompt: "s",
        userMessage: "u",
        tools: [],
        toolHandlers: new Map(),
        maxTurns: 3,
        hooks: {
          onStop: () => {
            throw new Error("boom");
          },
        },
      }),
    ).resolves.toMatchObject({ stopReason: "end" });
  });

  it("a throwing preToolUse is treated as a fail-closed deny — handler skipped, loop continues", async () => {
    const noopSpy = vi.fn(async () => ({ output: "ok", isError: false }));

    const result = await runAgenticLoop({
      client: makeToolThenEndClient(),
      model: "m",
      systemPrompt: "s",
      userMessage: "u",
      tools: NOOP_TOOL,
      toolHandlers: new Map([["noop", noopSpy]]),
      maxTurns: 5,
      hooks: {
        preToolUse: () => {
          throw new Error("boom");
        },
      },
    });

    expect(noopSpy).not.toHaveBeenCalled();
    expect(result.stopReason).toBe("end");
  });
});

describe("runAgenticLoop — byte-identical when onEvent/hooks are absent (sc-5-5)", () => {
  it("a paired run with vs. without onEvent/hooks produces a deep-equal AgenticLoopResult", async () => {
    const handlers = () => new Map([["noop", async () => ({ output: "ok", isError: false })]]);

    const withHooks = await runAgenticLoop({
      client: makeToolThenEndClient(),
      model: "m",
      systemPrompt: "s",
      userMessage: "u",
      tools: NOOP_TOOL,
      toolHandlers: handlers(),
      maxTurns: 5,
      onEvent: () => {},
      hooks: {
        preToolUse: () => ({ allow: true }),
        postToolUse: () => {},
        onStop: () => {},
      },
    });

    const withoutHooks = await runAgenticLoop({
      client: makeToolThenEndClient(),
      model: "m",
      systemPrompt: "s",
      userMessage: "u",
      tools: NOOP_TOOL,
      toolHandlers: handlers(),
      maxTurns: 5,
    });

    expect(withHooks).toEqual(withoutHooks);
  });
});

// ── sprint-6: session persistence, resume, fork ───────────────────────

/**
 * A ScriptedLoopClient variant that runs a caller-supplied hook BEFORE
 * resolving each `chat()` call, awaited by the caller (`chatWithRetry`
 * inside the loop). Because the loop's `for` iteration only reaches turn
 * N+1's `chat()` call after turn N's full body — including its awaited
 * `persistSession` save — has completed, a hook that fires on call index N
 * can deterministically assert the ON-DISK state left by turn N, with no
 * race against the loop's own persistence write.
 */
class HookedLoopClient implements LLMClient {
  private idx = 0;
  constructor(
    private readonly responses: ChatResponse[],
    private readonly onBeforeCall: (callIndex: number) => Promise<void> | void,
  ) {}
  async chat(params: ChatParams): Promise<ChatResponse> {
    await this.onBeforeCall(this.idx);
    const r = this.responses[Math.min(this.idx, this.responses.length - 1)];
    this.idx += 1;
    void params;
    return r;
  }
}

describe("runAgenticLoop — session persistence, resume, fork (sprint 6)", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "bober-agentic-loop-session-"));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("sc-6-1: the transcript file exists after turn 1 and is updated after every subsequent turn; final record has full metadata", async () => {
    const store = new SessionStore({ projectRoot: tmpRoot, now: () => "2026-07-10T00:00:00.000Z" });
    const handlers = new Map([["noop", async () => ({ output: "ok", isError: false })]]);

    const snapshotAfterCall: Record<number, { turnsUsed: number; messageCount: number } | null> = {};

    const client = new HookedLoopClient(
      [
        { ...base, text: "", stopReason: "tool_use", toolCalls: [{ id: "t1", name: "noop", input: {} }] },
        { ...base, text: "", stopReason: "tool_use", toolCalls: [{ id: "t2", name: "noop", input: {} }] },
        { ...base, text: "final answer", stopReason: "end" },
      ],
      async (callIndex) => {
        // Before the 2nd chat() call, turn 1's persistSession has already run.
        if (callIndex === 1 || callIndex === 2) {
          const record = await store.load("sess-abc");
          snapshotAfterCall[callIndex] = record
            ? { turnsUsed: record.turnsUsed, messageCount: record.messages.length }
            : null;
        }
      },
    );

    const result = await runAgenticLoop({
      client,
      model: "test-model",
      systemPrompt: "s",
      userMessage: "do the thing",
      tools: [
        { name: "noop", description: "n", input_schema: { type: "object", properties: {} } },
      ],
      toolHandlers: handlers,
      maxTurns: 5,
      session: { store, sessionId: "sess-abc" },
    });

    // File exists (with turn-1 data) BEFORE the 2nd chat() call.
    expect(snapshotAfterCall[1]).toEqual({ turnsUsed: 1, messageCount: 3 }); // user + assistant + toolResult
    // Updated again (with turn-2 data) BEFORE the 3rd chat() call.
    expect(snapshotAfterCall[2]).toEqual({ turnsUsed: 2, messageCount: 5 });

    expect(result.turnsUsed).toBe(3);
    expect(result.finalText).toBe("final answer");

    const final = await store.load("sess-abc");
    expect(final).not.toBeNull();
    expect(final?.sessionId).toBe("sess-abc");
    expect(final?.model).toBe("test-model");
    expect(final?.turnsUsed).toBe(3);
    expect(final?.createdAt).toBe("2026-07-10T00:00:00.000Z");
    expect(final?.updatedAt).toBe("2026-07-10T00:00:00.000Z");
    expect(final?.messages[0]).toEqual({ role: "user", content: "do the thing" });
    // The completion turn's assistant text IS persisted even though the
    // in-loop `messages` array never receives it (the loop returns instead).
    expect(final?.messages.at(-1)).toEqual({ role: "assistant", content: "final answer" });
  });

  it("sc-6-2: resumeSession seeds prior messages ahead of the new user message; new turns append to the same file", async () => {
    const store = new SessionStore({ projectRoot: tmpRoot, now: () => "2026-07-10T00:05:00.000Z" });

    await store.save({
      sessionId: "sess-resume",
      model: "m",
      turnsUsed: 1,
      messages: [
        { role: "user", content: "first task" },
        { role: "assistant", content: "first answer" },
      ],
    });

    const resumed = await resumeSession(store, "sess-resume");
    if ("error" in resumed) {
      throw new Error(`unexpected error result: ${resumed.error}`);
    }
    expect(resumed.initialMessages).toEqual([
      { role: "user", content: "first task" },
      { role: "assistant", content: "first answer" },
    ]);

    const client = new ScriptedLoopClient([{ ...base, text: "second answer", stopReason: "end" }]);

    const result = await runAgenticLoop({
      client,
      model: "m",
      systemPrompt: "s",
      userMessage: "second task",
      tools: [],
      toolHandlers: new Map(),
      maxTurns: 3,
      session: { store, sessionId: resumed.sessionId },
      initialMessages: resumed.initialMessages,
    });

    // The client's (only, hence first) chat() call received the seeded
    // messages ahead of the new user message.
    expect(client.lastParams?.messages).toEqual([
      { role: "user", content: "first task" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second task" },
    ]);
    expect(result.stopReason).toBe("end");

    const final = await store.load("sess-resume");
    expect(final?.messages).toEqual([
      { role: "user", content: "first task" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second task" },
      { role: "assistant", content: "second answer" },
    ]);
  });

  it("sc-6-3: forkSession copies the transcript; continuing the fork leaves the original byte-identical while it diverges", async () => {
    const store = new SessionStore({ projectRoot: tmpRoot, now: () => "2026-07-10T00:10:00.000Z" });

    await store.save({
      sessionId: "sess-orig",
      model: "m",
      turnsUsed: 1,
      messages: [
        { role: "user", content: "shared task" },
        { role: "assistant", content: "shared answer" },
      ],
    });

    const originalBytes = await readFile(store.path("sess-orig"), "utf-8");

    const forkedId = await forkSession(store, "sess-orig", "sess-fork");
    expect(forkedId).toBe("sess-fork");

    const forkedBeforeRun = await store.load("sess-fork");
    expect(forkedBeforeRun?.messages).toEqual([
      { role: "user", content: "shared task" },
      { role: "assistant", content: "shared answer" },
    ]);

    // Continue the fork with a response the ORIGINAL never received.
    const client = new ScriptedLoopClient([{ ...base, text: "forked answer", stopReason: "end" }]);
    await runAgenticLoop({
      client,
      model: "m",
      systemPrompt: "s",
      userMessage: "diverging task",
      tools: [],
      toolHandlers: new Map(),
      maxTurns: 3,
      session: { store, sessionId: "sess-fork" },
      initialMessages: forkedBeforeRun?.messages,
    });

    const afterOriginalBytes = await readFile(store.path("sess-orig"), "utf-8");
    expect(afterOriginalBytes).toBe(originalBytes);

    const forkedFinal = await store.load("sess-fork");
    expect(forkedFinal?.messages).toEqual([
      { role: "user", content: "shared task" },
      { role: "assistant", content: "shared answer" },
      { role: "user", content: "diverging task" },
      { role: "assistant", content: "forked answer" },
    ]);
  });

  it("forkSession derives a deterministic id when newId is omitted (no argless randomness)", async () => {
    const store = new SessionStore({ projectRoot: tmpRoot, now: () => "2026-07-10T00:15:00.000Z" });
    await store.save({ sessionId: "sess-orig2", model: "m", turnsUsed: 0, messages: [] });

    const forkedId1 = await forkSession(store, "sess-orig2");
    // Re-fork the same source at the SAME injected clock reading — deterministic.
    await store.save({ sessionId: "sess-orig2", model: "m", turnsUsed: 0, messages: [] });
    const forkedId2 = await forkSession(store, "sess-orig2");

    expect(forkedId1).toBe(forkedId2);
    expect(forkedId1).toMatch(/^[0-9a-f]{16}$/);
  });

  it("sc-6-4: without a session option, no .bober/sessions/ file or directory is created (byte-identical no-session path)", async () => {
    const client = new ScriptedLoopClient([{ ...base, text: "done", stopReason: "end" }]);

    const result = await runAgenticLoop({
      client,
      model: "m",
      systemPrompt: "s",
      userMessage: "u",
      tools: [],
      toolHandlers: new Map(),
      maxTurns: 3,
      // session intentionally omitted
    });

    expect(result.stopReason).toBe("end");
    await expect(readdir(join(tmpRoot, ".bober", "sessions"))).rejects.toThrow();
  });

  it("sc-6-4: a paired run with vs. without `session` produces the SAME AgenticLoopResult (persistence never alters loop behavior)", async () => {
    const store = new SessionStore({ projectRoot: tmpRoot, now: () => "2026-07-10T00:20:00.000Z" });
    const handlers = () => new Map([["noop", async () => ({ output: "ok", isError: false })]]);

    const withSession = await runAgenticLoop({
      client: makeToolThenEndClient(),
      model: "m",
      systemPrompt: "s",
      userMessage: "u",
      tools: NOOP_TOOL,
      toolHandlers: handlers(),
      maxTurns: 5,
      session: { store, sessionId: "sess-parity" },
    });

    const withoutSession = await runAgenticLoop({
      client: makeToolThenEndClient(),
      model: "m",
      systemPrompt: "s",
      userMessage: "u",
      tools: NOOP_TOOL,
      toolHandlers: handlers(),
      maxTurns: 5,
    });

    expect(withSession).toEqual(withoutSession);
  });

  describe("resumeSession — fail-soft (sc-6-5)", () => {
    it("returns a typed error for a missing session (never throws, no empty session created)", async () => {
      const store = new SessionStore({ projectRoot: tmpRoot });

      const result = await resumeSession(store, "does-not-exist");
      expect("error" in result).toBe(true);
      if (!("error" in result)) throw new Error("expected an error result");
      expect(result.error).toContain("does-not-exist");

      // No session file was created as a side effect of the failed resume.
      await expect(readFile(store.path("does-not-exist"), "utf-8")).rejects.toThrow();
    });

    it("returns a typed error for a corrupt session file and never overwrites it", async () => {
      const store = new SessionStore({ projectRoot: tmpRoot });
      await store.save({ sessionId: "sess-corrupt", model: "m", turnsUsed: 1, messages: [] });
      await writeFile(store.path("sess-corrupt"), "{ this is not valid json", "utf-8");
      const corruptBytesBefore = await readFile(store.path("sess-corrupt"), "utf-8");

      const result = await resumeSession(store, "sess-corrupt");
      expect("error" in result).toBe(true);

      const corruptBytesAfter = await readFile(store.path("sess-corrupt"), "utf-8");
      expect(corruptBytesAfter).toBe(corruptBytesBefore);
    });

    it("never silently starts an empty session in place of the requested one on error", async () => {
      const store = new SessionStore({ projectRoot: tmpRoot });

      const result = await resumeSession(store, "ghost");
      expect("error" in result).toBe(true);

      // A caller that (correctly) does NOT call runAgenticLoop on the error
      // branch leaves no trace for 'ghost' — demonstrating no silent
      // empty-session file is ever written by resumeSession itself.
      const loaded = await store.load("ghost");
      expect(loaded).toBeNull();
    });
  });
});

// ── sprint-7: in-context auto-compaction ──────────────────────────────

const SUMMARY_SYSTEM_PREFIX = "Summarize this conversation preserving";

/**
 * A client that plays out `toolTurns` tool_use turns (escalating usage per
 * `turnInputTokens`, indexed 1-based) followed by a final completion turn,
 * AND separately recognizes + answers the compaction summarizer call by its
 * distinctive system prompt (never confused with a normal turn call).
 */
class CompactionScriptedClient implements LLMClient {
  chats: ChatParams[] = [];
  summarizerCalls = 0;
  private turnCallIdx = 0;

  constructor(
    private readonly turnInputTokens: number[],
    private readonly summaryResponse: ChatResponse = {
      text: "SUMMARY",
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 5, outputTokens: 7 },
      costUsd: 0.02,
    },
    private readonly summarizerImpl?: () => Promise<ChatResponse>,
  ) {}

  async chat(params: ChatParams): Promise<ChatResponse> {
    this.chats.push(params);
    if (params.system.startsWith(SUMMARY_SYSTEM_PREFIX)) {
      this.summarizerCalls += 1;
      if (this.summarizerImpl) return this.summarizerImpl();
      return this.summaryResponse;
    }
    this.turnCallIdx += 1;
    const idx = Math.min(this.turnCallIdx, this.turnInputTokens.length) - 1;
    const inputTokens = this.turnInputTokens[idx];
    const isLast = this.turnCallIdx >= this.turnInputTokens.length;
    if (isLast) {
      return {
        text: "all done",
        toolCalls: [],
        stopReason: "end",
        usage: { inputTokens, outputTokens: 1 },
      };
    }
    return {
      text: "",
      toolCalls: [{ id: `t${this.turnCallIdx}`, name: "noop", input: {} }],
      stopReason: "tool_use",
      usage: { inputTokens, outputTokens: 1 },
    };
  }
}

const COMPACTION_NOOP_TOOL = [
  { name: "noop", description: "n", input_schema: { type: "object" as const, properties: {} } },
];
const compactionHandlers = () => new Map([["noop", async () => ({ output: "ok", isError: false })]]);

/**
 * Shared escalating-usage script: 4 small tool_use turns, a 5th tool_use turn
 * whose inputTokens (100_000) crosses a 50_000 threshold, then a final
 * completion turn. With the default `keepRecentTurns: 2` (keep = 4 messages),
 * this puts a non-trivial (5-message) head ahead of the trigger turn's own
 * (never-compacted, still-pending) exchange — see the per-turn trace below.
 *
 * Trace of `messages` (1-indexed turn call order), all tool_use except the
 * last ("end"): after turn 4, `messages` = [initial, t1-a, t1-r, t2-a, t2-r,
 * t3-a, t3-r, t4-a, t4-r] (9 entries). Turn 5's response (100_000 tokens)
 * triggers compaction BEFORE turn 5's own exchange is appended: head =
 * slice(0, 9-4=5) = [initial, t1-a, t1-r, t2-a, t2-r] (5 msgs, replaced by 1
 * summary); tail (last 4, preserved verbatim) = [t3-a, t3-r, t4-a, t4-r].
 * Turn 5's own exchange (t5-a, t5-r) is then appended fresh, so the final
 * completion turn (turn 6) sees: [summary, t3-a, t3-r, t4-a, t4-r, t5-a, t5-r]
 * (7 messages).
 */
const ESCALATING_SCRIPT = [10, 10, 10, 10, 100_000, 10];

function toolCallMessage(id: string): Message {
  return { role: "assistant", content: "", toolCalls: [{ id, name: "noop", input: {} }] };
}
function toolResultMessage(id: string): Message {
  return { role: "user", toolResults: [{ toolUseId: id, content: "ok", isError: false }] };
}

describe("runAgenticLoop — in-context auto-compaction (sprint 7)", () => {
  it("sc-7-1: crossing maxContextTokens replaces the head with one summary message; recent turns survive verbatim", async () => {
    const client = new CompactionScriptedClient(ESCALATING_SCRIPT);

    const result = await runAgenticLoop({
      client,
      model: "m",
      systemPrompt: "s",
      userMessage: "u",
      tools: COMPACTION_NOOP_TOOL,
      toolHandlers: compactionHandlers(),
      maxTurns: 10,
      compaction: { maxContextTokens: 50_000, keepRecentTurns: 2 },
    });

    expect(client.summarizerCalls).toBe(1);
    expect(result.stopReason).toBe("end");

    // The final (turn-6) chat call's `messages` reflects the post-compaction
    // state: exactly one summary message where the 5-message head used to
    // be, then the preserved turn-3/turn-4 tail, then turn-5's own
    // (never-compacted, pending-at-trigger-time) exchange.
    const nonSummarizerChats = client.chats.filter(
      (c) => !c.system.startsWith(SUMMARY_SYSTEM_PREFIX),
    );
    const finalParams = nonSummarizerChats[nonSummarizerChats.length - 1];

    expect(finalParams.messages).toEqual([
      { role: "user", content: "[Conversation summary] SUMMARY" },
      toolCallMessage("t3"),
      toolResultMessage("t3"),
      toolCallMessage("t4"),
      toolResultMessage("t4"),
      toolCallMessage("t5"),
      toolResultMessage("t5"),
    ]);
  });

  it("sc-7-2: emits compact-boundary with the documented payload when onEvent is present, and still compacts without it", async () => {
    const events: LoopEvent[] = [];
    const client = new CompactionScriptedClient(ESCALATING_SCRIPT);

    await runAgenticLoop({
      client,
      model: "m",
      systemPrompt: "s",
      userMessage: "u",
      tools: COMPACTION_NOOP_TOOL,
      toolHandlers: compactionHandlers(),
      maxTurns: 10,
      compaction: { maxContextTokens: 50_000, keepRecentTurns: 2 },
      onEvent: (e) => events.push(e),
    });

    const boundaryEvents = events.filter((e) => e.type === "compact-boundary");
    expect(boundaryEvents).toHaveLength(1);
    const boundary = boundaryEvents[0] as Extract<LoopEvent, { type: "compact-boundary" }>;
    expect(boundary).toEqual({
      type: "compact-boundary",
      turn: 5,
      messagesBefore: 9,
      messagesAfter: 5,
      inputTokensAtTrigger: 100_000,
    });

    // Re-run identically WITHOUT onEvent — compaction must still occur
    // (verified by message inspection, since there's no event stream now).
    const clientNoEvent = new CompactionScriptedClient(ESCALATING_SCRIPT);
    await runAgenticLoop({
      client: clientNoEvent,
      model: "m",
      systemPrompt: "s",
      userMessage: "u",
      tools: COMPACTION_NOOP_TOOL,
      toolHandlers: compactionHandlers(),
      maxTurns: 10,
      compaction: { maxContextTokens: 50_000, keepRecentTurns: 2 },
    });
    expect(clientNoEvent.summarizerCalls).toBe(1);
    const sawSummary = clientNoEvent.chats.some((c) =>
      c.messages.some((m) => "content" in m && m.content?.startsWith("[Conversation summary]")),
    );
    expect(sawSummary).toBe(true);
  });

  it("sc-7-3: charges the summarizer's usage/costUsd to Budget and to the result totals", async () => {
    const client = new CompactionScriptedClient(ESCALATING_SCRIPT);
    const budget = new Budget({ maxUsd: 100 });
    const chargeTokensSpy = vi.spyOn(budget, "chargeTokens");
    const chargeUsdSpy = vi.spyOn(budget, "chargeUsd");

    const result = await runAgenticLoop({
      client,
      model: "m",
      systemPrompt: "s",
      userMessage: "u",
      tools: COMPACTION_NOOP_TOOL,
      toolHandlers: compactionHandlers(),
      maxTurns: 10,
      budget,
      compaction: { maxContextTokens: 50_000, keepRecentTurns: 2 },
    });

    // The summarizer's usage { inputTokens: 5, outputTokens: 7 } and
    // costUsd: 0.02 must appear among the chargeTokens/chargeUsd calls (in
    // addition to each normal turn's own charge).
    expect(
      chargeTokensSpy.mock.calls.some(
        ([usage]) => usage.inputTokens === 5 && usage.outputTokens === 7,
      ),
    ).toBe(true);
    expect(chargeUsdSpy.mock.calls.some(([usd]) => usd === 0.02)).toBe(true);

    // Result totals: sum of all 6 turn usages (10+10+10+10+100000+10 in,
    // 1*6 out) PLUS the summarizer's (5 in, 7 out) and cost (0.02, the only
    // cost any turn in this script reports).
    expect(result.usage.inputTokens).toBe(10 + 10 + 10 + 10 + 100_000 + 10 + 5);
    expect(result.usage.outputTokens).toBe(6 * 1 + 7);
    expect(result.costUsd).toBe(0.02);
  });

  it("sc-7-4: a failed summarizer call fails open — no throw, no compaction, run continues uncompacted", async () => {
    const client = new CompactionScriptedClient(ESCALATING_SCRIPT, undefined, () => {
      throw new Error("summarizer boom");
    });

    const result = await runAgenticLoop({
      client,
      model: "m",
      systemPrompt: "s",
      userMessage: "u",
      tools: COMPACTION_NOOP_TOOL,
      toolHandlers: compactionHandlers(),
      maxTurns: 10,
      compaction: { maxContextTokens: 50_000, keepRecentTurns: 2 },
    });

    expect(result.stopReason).toBe("end");
    expect(client.summarizerCalls).toBe(1); // attempted, but failed

    // No summary message ever appears in any subsequent chat call — every
    // message the loop ever sent remains a real, non-summary message.
    const sawSummary = client.chats.some((c) =>
      c.messages.some((m) => "content" in m && m.content?.includes("[Conversation summary]")),
    );
    expect(sawSummary).toBe(false);

    // Nothing was dropped: the final request still carries all 9 messages
    // that would exist pre-compaction, plus turn 5's own exchange (11 total).
    const nonSummarizerChats = client.chats.filter(
      (c) => !c.system.startsWith(SUMMARY_SYSTEM_PREFIX),
    );
    const finalParams = nonSummarizerChats[nonSummarizerChats.length - 1];
    expect(finalParams.messages).toHaveLength(11);
  });

  it("sc-7-5: without compaction config, no summarizer call is ever made and behavior is byte-identical", async () => {
    // Same escalating script that WOULD cross 50_000 if `compaction` were
    // configured — but it is entirely absent here.
    const bareClient = new CompactionScriptedClient(ESCALATING_SCRIPT);
    const withoutCompaction = await runAgenticLoop({
      client: bareClient,
      model: "m",
      systemPrompt: "s",
      userMessage: "u",
      tools: COMPACTION_NOOP_TOOL,
      toolHandlers: compactionHandlers(),
      maxTurns: 10,
    });

    expect(bareClient.summarizerCalls).toBe(0);
    expect(bareClient.chats.every((c) => !c.system.startsWith(SUMMARY_SYSTEM_PREFIX))).toBe(true);
    expect(bareClient.chats).toHaveLength(6); // one chat per turn, no extra summarizer call

    // A run with `compaction` PRESENT but never triggered (threshold set far
    // above anything this script reports) must be deep-equal to the run
    // above — proving the gated code path is genuinely inert when unused,
    // mirroring the sc-5-5 onEvent/hooks-absent precedent.
    const neverTriggeredClient = new CompactionScriptedClient(ESCALATING_SCRIPT);
    const withInertCompaction = await runAgenticLoop({
      client: neverTriggeredClient,
      model: "m",
      systemPrompt: "s",
      userMessage: "u",
      tools: COMPACTION_NOOP_TOOL,
      toolHandlers: compactionHandlers(),
      maxTurns: 10,
      compaction: { maxContextTokens: 999_999_999 },
    });

    expect(withoutCompaction).toEqual(withInertCompaction);
    expect(neverTriggeredClient.summarizerCalls).toBe(0);
  });
});
