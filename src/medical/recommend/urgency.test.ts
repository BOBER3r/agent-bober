import { describe, it, expect } from "vitest";
import type { LLMClient, ChatParams, ChatResponse } from "../../providers/types.js";
import { assignUrgencySeverity } from "./urgency.js";

// -- ScriptedClient (mirrors judge-panel.test.ts:20-30) ------------------

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

const throwingClient: LLMClient = {
  async chat(_p: ChatParams): Promise<ChatResponse> {
    throw new Error("Network timeout");
  },
};

// -- Tests ---------------------------------------------------------------

describe("assignUrgencySeverity", () => {
  const CONTEXT = "Patient: 45yo, no known allergies";
  const CANDIDATE = "Take omega-3 1000mg daily with meals.";

  it("parses valid JSON response and clamps to 1..5", async () => {
    const client = new ScriptedClient(['{"urgency":4,"severity":3,"confidence":0.85}']);
    const result = await assignUrgencySeverity(client, "test-model", CANDIDATE, CONTEXT);
    expect(result.urgency).toBe(4);
    expect(result.severity).toBe(3);
    expect(result.confidence).toBeCloseTo(0.85);
  });

  it("clamps urgency/severity above 5 to 5", async () => {
    const client = new ScriptedClient(['{"urgency":9,"severity":8,"confidence":0.9}']);
    const result = await assignUrgencySeverity(client, "test-model", CANDIDATE, CONTEXT);
    expect(result.urgency).toBe(5);
    expect(result.severity).toBe(5);
  });

  it("clamps urgency/severity below 1 to 1", async () => {
    const client = new ScriptedClient(['{"urgency":-3,"severity":0,"confidence":0.5}']);
    const result = await assignUrgencySeverity(client, "test-model", CANDIDATE, CONTEXT);
    expect(result.urgency).toBe(1);
    expect(result.severity).toBe(1);
  });

  it("returns DEFAULT_URGENCY on garbage JSON without throwing", async () => {
    const client = new ScriptedClient(["not valid json at all %%%"]);
    const result = await assignUrgencySeverity(client, "test-model", CANDIDATE, CONTEXT);
    // Default is {urgency:3, severity:3, confidence:0.5}
    expect(result.urgency).toBeGreaterThanOrEqual(1);
    expect(result.urgency).toBeLessThanOrEqual(5);
    expect(result.severity).toBeGreaterThanOrEqual(1);
    expect(result.severity).toBeLessThanOrEqual(5);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
  });

  it("returns DEFAULT_URGENCY on missing fields without throwing", async () => {
    const client = new ScriptedClient(['{"urgency":3}']); // missing severity + confidence
    const result = await assignUrgencySeverity(client, "test-model", CANDIDATE, CONTEXT);
    expect(result.urgency).toBeGreaterThanOrEqual(1);
    expect(result.urgency).toBeLessThanOrEqual(5);
    expect(result.severity).toBeGreaterThanOrEqual(1);
    expect(result.severity).toBeLessThanOrEqual(5);
  });

  it("returns DEFAULT_URGENCY when client throws without rethrowing", async () => {
    const result = await assignUrgencySeverity(throwingClient, "test-model", CANDIDATE, CONTEXT);
    expect(result.urgency).toBeGreaterThanOrEqual(1);
    expect(result.urgency).toBeLessThanOrEqual(5);
    expect(result.severity).toBeGreaterThanOrEqual(1);
    expect(result.severity).toBeLessThanOrEqual(5);
  });

  it("makes exactly one LLM call", async () => {
    const client = new ScriptedClient(['{"urgency":2,"severity":2,"confidence":0.7}']);
    await assignUrgencySeverity(client, "test-model", CANDIDATE, CONTEXT);
    expect(client.calls).toHaveLength(1);
  });

  it("passes jsonObjectMode:true to the LLM call", async () => {
    const client = new ScriptedClient(['{"urgency":2,"severity":2,"confidence":0.7}']);
    await assignUrgencySeverity(client, "test-model", CANDIDATE, CONTEXT);
    expect(client.calls[0]?.jsonObjectMode).toBe(true);
  });

  it("extracts JSON from markdown fence", async () => {
    const fenced = '```json\n{"urgency":5,"severity":4,"confidence":0.95}\n```';
    const client = new ScriptedClient([fenced]);
    const result = await assignUrgencySeverity(client, "test-model", CANDIDATE, CONTEXT);
    expect(result.urgency).toBe(5);
    expect(result.severity).toBe(4);
    expect(result.confidence).toBeCloseTo(0.95);
  });
});
