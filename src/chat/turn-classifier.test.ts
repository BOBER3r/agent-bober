import { describe, it, expect } from "vitest";

import { TurnClassifier } from "./turn-classifier.js";
import type { LLMClient } from "../providers/types.js";
import type { ChatParams, ChatResponse } from "../providers/types.js";

// ── Fake LLMClient ────────────────────────────────────────────────────

class ScriptedClient implements LLMClient {
  readonly calls: ChatParams[] = [];
  private idx = 0;
  constructor(private readonly responses: string[]) {}

  async chat(params: ChatParams): Promise<ChatResponse> {
    this.calls.push(params);
    const text = this.responses[Math.min(this.idx, this.responses.length - 1)] ?? "";
    this.idx += 1;
    return { text, toolCalls: [], stopReason: "end", usage: { inputTokens: 3, outputTokens: 5 } };
  }
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("TurnClassifier", () => {
  it("returns action:answer for a valid JSON response (sc-1-5)", async () => {
    const client = new ScriptedClient(['{"action":"answer"}']);
    const classifier = new TurnClassifier(client, "test-model");

    const result = await classifier.classify("What is bober?");
    expect(result).toEqual({ action: "answer" });
  });

  it("returns action:answer for fenced JSON (sc-1-5)", async () => {
    const client = new ScriptedClient(['```json\n{"action":"answer"}\n```']);
    const classifier = new TurnClassifier(client, "test-model");

    const result = await classifier.classify("Hello");
    expect(result).toEqual({ action: "answer" });
  });

  it("returns {action:answer} for garbage/non-JSON response (sc-1-5)", async () => {
    const client = new ScriptedClient(["not json"]);
    const classifier = new TurnClassifier(client, "test-model");

    const result = await classifier.classify("garbage test");
    expect(result).toEqual({ action: "answer" });
  });

  it("uses jsonObjectMode:true in the chat call (sc-1-5)", async () => {
    const client = new ScriptedClient(['{"action":"answer"}']);
    const classifier = new TurnClassifier(client, "test-model");

    await classifier.classify("test input");
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.jsonObjectMode).toBe(true);
  });

  it("returns {action:answer} when the LLM call throws", async () => {
    const throwingClient: LLMClient = {
      async chat(_params: ChatParams): Promise<ChatResponse> {
        throw new Error("network error");
      },
    };
    const classifier = new TurnClassifier(throwingClient, "test-model");
    const result = await classifier.classify("some input");
    expect(result).toEqual({ action: "answer" });
  });

  it("parses spawn action correctly", async () => {
    const client = new ScriptedClient(['{"action":"spawn","task":"build a login page"}']);
    const classifier = new TurnClassifier(client, "test-model");

    const result = await classifier.classify("Spawn a task");
    expect(result.action).toBe("spawn");
    if (result.action === "spawn") {
      expect(result.task).toBe("build a login page");
    }
  });
});
