/**
 * Unit tests for buildSubagentTool (sprint 10: sc-10-1, sc-10-2, sc-10-3).
 *
 * Uses a FAKE `runLoop` (never the real `runAgenticLoop`) so these tests are
 * a pure unit test of the builder's child-param assembly and result mapping.
 * The full nested-loop integration (fresh history reaching a real scripted
 * client, scoped tool visibility on the wire, shared-Budget ceiling crossing
 * end-to-end) is covered by `agentic-loop.test.ts`'s "in-process scoped
 * subagents (sprint 10)" suite.
 */

import { describe, it, expect } from "vitest";
import { buildSubagentTool, type SubagentDef } from "./subagents.js";
import { Budget } from "./workflow/budget.js";
import type { AgenticLoopParams, AgenticLoopResult } from "./agentic-loop.js";
import type { LLMClient, ChatParams, ChatResponse, ToolDef } from "../providers/types.js";
import type { ToolHandler } from "./tools/index.js";

// ── Fixtures ─────────────────────────────────────────────────────────

class NoopClient implements LLMClient {
  async chat(_params: ChatParams): Promise<ChatResponse> {
    void _params;
    return {
      text: "unused",
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}

const toolA: ToolDef = { name: "tool_a", description: "a", input_schema: { type: "object" as const, properties: {} } };
const toolB: ToolDef = { name: "tool_b", description: "b", input_schema: { type: "object" as const, properties: {} } };

const handlerA: ToolHandler = async () => ({ output: "a-ran", isError: false });
const handlerB: ToolHandler = async () => ({ output: "b-ran", isError: false });

function makeParentParams(overrides: Partial<AgenticLoopParams> = {}): AgenticLoopParams {
  return {
    client: new NoopClient(),
    model: "parent-model",
    systemPrompt: "PARENT",
    userMessage: "parent task",
    tools: [toolA, toolB],
    toolHandlers: new Map([
      ["tool_a", handlerA],
      ["tool_b", handlerB],
    ]),
    maxTurns: 20,
    ...overrides,
  };
}

const baseDef: SubagentDef = {
  name: "writer",
  description: "writes stuff",
  systemPrompt: "CHILD",
  tools: ["tool_a"],
};

function successResult(finalText: string): AgenticLoopResult {
  return {
    finalText,
    turnsUsed: 1,
    toolsCalled: [],
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "end",
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("buildSubagentTool", () => {
  it("registers a NOT-readOnly spawn_subagent tool with the { name, task } input schema", () => {
    const parentParams = makeParentParams();
    const { tool } = buildSubagentTool([baseDef], parentParams, {
      runLoop: async () => successResult("x"),
    });

    expect(tool.name).toBe("spawn_subagent");
    // Unknown side effects -> stays serial (ADR-2, nonGoal #3).
    expect(Object.hasOwn(tool, "readOnly")).toBe(false);
    expect(tool.input_schema.required).toEqual(["name", "task"]);
    expect(tool.input_schema.properties?.["name"]).toBeDefined();
    expect(tool.input_schema.properties?.["task"]).toBeDefined();
  });

  it("sc-10-1: assembles a child AgenticLoopParams scoped to def.tools, with the task as a fresh userMessage", async () => {
    const parentParams = makeParentParams();
    let captured: AgenticLoopParams | undefined;
    const { handler } = buildSubagentTool([baseDef], parentParams, {
      runLoop: async (p) => {
        captured = p;
        return successResult("child summary");
      },
    });

    const result = await handler({ name: "writer", task: "do X" });

    expect(result).toEqual({ output: "child summary", isError: false });
    expect(captured?.systemPrompt).toBe("CHILD");
    expect(captured?.userMessage).toBe("do X");
    expect(captured?.tools.map((t) => t.name)).toEqual(["tool_a"]);
    expect([...(captured?.toolHandlers?.keys() ?? [])]).toEqual(["tool_a"]);
    // One-level hard cap (nonGoal #1).
    expect(captured?.subagents).toBeUndefined();
    // Excluded fields never leak into the child (fresh, opaque, ephemeral run).
    expect(Object.hasOwn(captured as object, "session")).toBe(false);
    expect(Object.hasOwn(captured as object, "initialMessages")).toBe(false);
    expect(Object.hasOwn(captured as object, "compaction")).toBe(false);
    expect(Object.hasOwn(captured as object, "onEvent")).toBe(false);
    expect(Object.hasOwn(captured as object, "hooks")).toBe(false);
    expect(Object.hasOwn(captured as object, "onTextDelta")).toBe(false);
  });

  it("sc-10-2: def.model absent -> inherits the parent's client + model", async () => {
    const parentParams = makeParentParams();
    let captured: AgenticLoopParams | undefined;
    const { handler } = buildSubagentTool([baseDef], parentParams, {
      runLoop: async (p) => {
        captured = p;
        return successResult("ok");
      },
    });

    await handler({ name: "writer", task: "t" });

    expect(captured?.client).toBe(parentParams.client);
    expect(captured?.model).toBe("parent-model");
  });

  it("sc-10-2: def.model set -> resolves the model and uses the injected clientFactory (never the real provider factory)", async () => {
    const parentParams = makeParentParams();
    const fakeChildClient = new NoopClient();
    const factoryCalls: string[] = [];
    let captured: AgenticLoopParams | undefined;

    const { handler } = buildSubagentTool([{ ...baseDef, model: "haiku" }], parentParams, {
      runLoop: async (p) => {
        captured = p;
        return successResult("ok");
      },
      clientFactory: (model) => {
        factoryCalls.push(model);
        return fakeChildClient;
      },
    });

    await handler({ name: "writer", task: "t" });

    expect(factoryCalls).toEqual(["haiku"]);
    expect(captured?.client).toBe(fakeChildClient);
    expect(captured?.model).toBe("claude-haiku-4-5"); // resolveModel("haiku")
  });

  it("sc-10-2: forwards def.effort when set, omits the key entirely when absent", async () => {
    const parentParams = makeParentParams();

    let capturedWith: AgenticLoopParams | undefined;
    const { handler: handlerWith } = buildSubagentTool([{ ...baseDef, effort: "high" }], parentParams, {
      runLoop: async (p) => {
        capturedWith = p;
        return successResult("ok");
      },
    });
    await handlerWith({ name: "writer", task: "t" });
    expect(capturedWith?.effort).toBe("high");

    let capturedWithout: AgenticLoopParams | undefined;
    const { handler: handlerWithout } = buildSubagentTool([baseDef], parentParams, {
      runLoop: async (p) => {
        capturedWithout = p;
        return successResult("ok");
      },
    });
    await handlerWithout({ name: "writer", task: "t" });
    expect(Object.hasOwn(capturedWithout as object, "effort")).toBe(false);
  });

  it("sc-10-2: def.maxTurns overrides the default of 10 when set, defaults to 10 when absent", async () => {
    const parentParams = makeParentParams();

    let capturedDefault: AgenticLoopParams | undefined;
    const { handler: h1 } = buildSubagentTool([baseDef], parentParams, {
      runLoop: async (p) => {
        capturedDefault = p;
        return successResult("ok");
      },
    });
    await h1({ name: "writer", task: "t" });
    expect(capturedDefault?.maxTurns).toBe(10);

    let capturedOverride: AgenticLoopParams | undefined;
    const { handler: h2 } = buildSubagentTool([{ ...baseDef, maxTurns: 3 }], parentParams, {
      runLoop: async (p) => {
        capturedOverride = p;
        return successResult("ok");
      },
    });
    await h2({ name: "writer", task: "t" });
    expect(capturedOverride?.maxTurns).toBe(3);
  });

  it("sc-10-2: shares the SAME Budget instance with the parent (combined spend)", async () => {
    const budget = new Budget({ maxUsd: 5 });
    const parentParams = makeParentParams({ budget });
    let captured: AgenticLoopParams | undefined;
    const { handler } = buildSubagentTool([baseDef], parentParams, {
      runLoop: async (p) => {
        captured = p;
        return successResult("ok");
      },
    });

    await handler({ name: "writer", task: "t" });

    expect(captured?.budget).toBe(budget);
  });

  it("inherits parallelReadOnlyTools/abortSignal/maxTokens from the parent when set, omits them entirely when absent", async () => {
    const controller = new AbortController();
    const parentParams = makeParentParams({
      parallelReadOnlyTools: true,
      abortSignal: controller.signal,
      maxTokens: 4096,
    });
    let captured: AgenticLoopParams | undefined;
    const { handler } = buildSubagentTool([baseDef], parentParams, {
      runLoop: async (p) => {
        captured = p;
        return successResult("ok");
      },
    });
    await handler({ name: "writer", task: "t" });

    expect(captured?.parallelReadOnlyTools).toBe(true);
    expect(captured?.abortSignal).toBe(controller.signal);
    expect(captured?.maxTokens).toBe(4096);

    const parentParamsBare = makeParentParams();
    let capturedBare: AgenticLoopParams | undefined;
    const { handler: handlerBare } = buildSubagentTool([baseDef], parentParamsBare, {
      runLoop: async (p) => {
        capturedBare = p;
        return successResult("ok");
      },
    });
    await handlerBare({ name: "writer", task: "t" });

    expect(Object.hasOwn(capturedBare as object, "parallelReadOnlyTools")).toBe(false);
    expect(Object.hasOwn(capturedBare as object, "abortSignal")).toBe(false);
    expect(Object.hasOwn(capturedBare as object, "maxTokens")).toBe(false);
  });

  it("sc-10-3: an unknown subagent name returns an isError result listing valid names, without calling runLoop", async () => {
    const parentParams = makeParentParams();
    let called = false;
    const { handler } = buildSubagentTool([baseDef, { ...baseDef, name: "reviewer" }], parentParams, {
      runLoop: async () => {
        called = true;
        return successResult("ok");
      },
    });

    const result = await handler({ name: "ghost", task: "t" });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("Unknown subagent 'ghost'");
    expect(result.output).toContain("writer");
    expect(result.output).toContain("reviewer");
    expect(called).toBe(false);
  });

  it("sc-10-3: maps refusal/budget_exceeded/error/aborted child stop reasons to isError results naming the reason", async () => {
    const parentParams = makeParentParams();
    const cases: Array<{ childResult: AgenticLoopResult; expectSubstring: string }> = [
      {
        childResult: { ...successResult("nope"), stopReason: "refusal", refused: true },
        expectSubstring: "refused",
      },
      {
        childResult: { ...successResult("over budget"), stopReason: "budget_exceeded" },
        expectSubstring: "budget_exceeded",
      },
      {
        childResult: { ...successResult("boom"), stopReason: "error" },
        expectSubstring: "error",
      },
      {
        childResult: { ...successResult("stopped"), stopReason: "aborted" },
        expectSubstring: "aborted",
      },
    ];

    for (const { childResult, expectSubstring } of cases) {
      const { handler } = buildSubagentTool([baseDef], parentParams, {
        runLoop: async () => childResult,
      });
      const result = await handler({ name: "writer", task: "t" });
      expect(result.isError).toBe(true);
      expect(result.output).toContain(expectSubstring);
    }
  });

  it("sc-10-3: a completed (non-refused/budget/error/aborted) child result maps to isError:false with finalText as output", async () => {
    const parentParams = makeParentParams();
    const { handler } = buildSubagentTool([baseDef], parentParams, {
      runLoop: async () => successResult("all done"),
    });

    const result = await handler({ name: "writer", task: "t" });

    expect(result).toEqual({ output: "all done", isError: false });
  });

  it("sc-10-3: never throws — a misbehaving injected runLoop that rejects still returns an isError result", async () => {
    const parentParams = makeParentParams();
    const { handler } = buildSubagentTool([baseDef], parentParams, {
      runLoop: async () => {
        throw new Error("boom");
      },
    });

    const result = await handler({ name: "writer", task: "t" });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("boom");
  });
});
