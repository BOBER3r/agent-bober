import { describe, it, expect } from "vitest";

import type { LLMClient, ChatParams, ChatResponse } from "../providers/types.js";
import { FleetManifestSchema } from "./manifest.js";
import {
  decomposeGoalDeep,
  runPlanStage,
  runExpandStage,
  validateOutline,
  DEEP_PLAN_MAX_RETRIES,
  DEEP_EXPAND_MAX_RETRIES,
  DEEP_MAX_TOTAL_CALLS,
} from "./decomposer-deep.js";

// ── Scripted fake client ─────────────────────────────────────────────

/**
 * Returns scripted responses in order; repeats the last one once exhausted.
 * Records every ChatParams it was called with.
 */
class ScriptedClient implements LLMClient {
  readonly calls: ChatParams[] = [];
  private idx = 0;

  constructor(private readonly responses: string[]) {}

  async chat(params: ChatParams): Promise<ChatResponse> {
    this.calls.push(params);
    const text =
      this.responses[Math.min(this.idx, this.responses.length - 1)] ?? "";
    this.idx += 1;
    return {
      text,
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 3, outputTokens: 5 },
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

const VALID_OUTLINE_JSON = JSON.stringify({
  areas: [
    { name: "auth", intent: "user login and sessions" },
    { name: "billing", intent: "payments and invoices" },
  ],
});

const VALID_MULTI_CHILD_JSON = JSON.stringify({
  children: [
    { folder: "auth-service", task: "Build the auth service with JWT" },
    { folder: "billing-service", task: "Build the billing service with Stripe" },
  ],
});

const VALID_SINGLE_CHILD_JSON = JSON.stringify({
  children: [{ folder: "api-server", task: "Build the REST API server" }],
});

// ── Constants ────────────────────────────────────────────────────────

describe("Constants", () => {
  it("DEEP_PLAN_MAX_RETRIES is exactly 1", () => {
    expect(DEEP_PLAN_MAX_RETRIES).toBe(1);
  });

  it("DEEP_EXPAND_MAX_RETRIES is exactly 1", () => {
    expect(DEEP_EXPAND_MAX_RETRIES).toBe(1);
  });

  it("DEEP_MAX_TOTAL_CALLS is exactly 4", () => {
    expect(DEEP_MAX_TOTAL_CALLS).toBe(4);
  });

  it("DEEP_MAX_TOTAL_CALLS equals (1+DEEP_PLAN_MAX_RETRIES)+(1+DEEP_EXPAND_MAX_RETRIES)", () => {
    expect(DEEP_MAX_TOTAL_CALLS).toBe(
      (1 + DEEP_PLAN_MAX_RETRIES) + (1 + DEEP_EXPAND_MAX_RETRIES),
    );
  });
});

// ── validateOutline ──────────────────────────────────────────────────

describe("validateOutline", () => {
  it("returns ok:true for a valid outline JSON", () => {
    const result = validateOutline(VALID_OUTLINE_JSON);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.outline.areas).toHaveLength(2);
      expect(result.outline.areas[0]?.name).toBe("auth");
      expect(result.outline.areas[0]?.intent).toBe("user login and sessions");
    }
  });

  it("returns ok:true for a minimal single-area outline", () => {
    const result = validateOutline(
      JSON.stringify({ areas: [{ name: "auth", intent: "login" }] }),
    );
    expect(result.ok).toBe(true);
  });

  it("returns ok:false (does not throw) for empty string", () => {
    expect(() => validateOutline("")).not.toThrow();
    const result = validateOutline("");
    expect(result.ok).toBe(false);
  });

  it("returns ok:false (does not throw) for non-JSON text", () => {
    expect(() => validateOutline("nope")).not.toThrow();
    const result = validateOutline("nope");
    expect(result.ok).toBe(false);
  });

  it("returns ok:false (does not throw) for empty areas array", () => {
    expect(() => validateOutline(JSON.stringify({ areas: [] }))).not.toThrow();
    const result = validateOutline(JSON.stringify({ areas: [] }));
    expect(result.ok).toBe(false);
  });

  it("returns ok:false when areas key is missing", () => {
    const result = validateOutline(JSON.stringify({ children: [] }));
    expect(result.ok).toBe(false);
  });

  it("returns ok:false when area name is empty string", () => {
    const result = validateOutline(
      JSON.stringify({ areas: [{ name: "", intent: "something" }] }),
    );
    expect(result.ok).toBe(false);
  });

  it("extracts from a fenced json block", () => {
    const fenced = "```json\n" + VALID_OUTLINE_JSON + "\n```";
    const result = validateOutline(fenced);
    expect(result.ok).toBe(true);
  });

  it("extracts from first-brace-to-last-brace substring", () => {
    const wrapped = "Here is the outline: " + VALID_OUTLINE_JSON + " That is all.";
    const result = validateOutline(wrapped);
    expect(result.ok).toBe(true);
  });
});

// ── decomposeGoalDeep — happy path ───────────────────────────────────

describe("decomposeGoalDeep — happy path", () => {
  it("resolves with a FleetManifestSchema-valid manifest with multiple children (sc-1-4)", async () => {
    const client = new ScriptedClient([VALID_OUTLINE_JSON, VALID_MULTI_CHILD_JSON]);
    const result = await decomposeGoalDeep({
      goal: "Build a platform",
      client,
      model: "deepseek-v4-pro",
    });

    expect(FleetManifestSchema.safeParse(result).success).toBe(true);
    expect(result.children.length).toBeGreaterThan(1);
    expect(result.children[0]?.folder).toBe("auth-service");
    expect(result.children[1]?.folder).toBe("billing-service");
    // Children carry ONLY folder+task (no config key)
    expect(Object.prototype.hasOwnProperty.call(result.children[0], "config")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(result.children[1], "config")).toBe(false);
    // Exactly PLAN + EXPAND = 2 calls
    expect(client.calls).toHaveLength(2);
  });

  it("resolves with a single-child manifest", async () => {
    const client = new ScriptedClient([VALID_OUTLINE_JSON, VALID_SINGLE_CHILD_JSON]);
    const result = await decomposeGoalDeep({
      goal: "Build an API",
      client,
      model: "deepseek-v4-pro",
    });

    expect(FleetManifestSchema.safeParse(result).success).toBe(true);
    expect(result.children).toHaveLength(1);
    expect(client.calls).toHaveLength(2);
  });
});

// ── jsonObjectMode / responseSchema assertions ───────────────────────

describe("decomposeGoalDeep — ChatParams shape (sc-1-5)", () => {
  it("both PLAN and EXPAND calls have jsonObjectMode===true and responseSchema===undefined", async () => {
    const client = new ScriptedClient([VALID_OUTLINE_JSON, VALID_MULTI_CHILD_JSON]);
    await decomposeGoalDeep({
      goal: "Build a platform",
      client,
      model: "deepseek-v4-pro",
    });

    expect(client.calls).toHaveLength(2);
    // PLAN call
    expect(client.calls[0]?.jsonObjectMode).toBe(true);
    expect(client.calls[0]?.responseSchema).toBeUndefined();
    // EXPAND call
    expect(client.calls[1]?.jsonObjectMode).toBe(true);
    expect(client.calls[1]?.responseSchema).toBeUndefined();
  });
});

// ── PLAN exhaustion ──────────────────────────────────────────────────

describe("decomposeGoalDeep — PLAN exhaustion (sc-1-6)", () => {
  it("throws with 'deep plan failed' message when all PLAN attempts fail", async () => {
    const client = new ScriptedClient(["not json", "still not json"]);
    await expect(
      decomposeGoalDeep({ goal: "g", client, model: "m" }),
    ).rejects.toThrow(/deep plan failed/);
  });

  it("makes exactly 2 calls when PLAN fails — EXPAND never runs", async () => {
    const client = new ScriptedClient(["not json", "still not json"]);
    await expect(
      decomposeGoalDeep({ goal: "g", client, model: "m" }),
    ).rejects.toThrow();
    // Exactly 2 calls (PLAN attempts), EXPAND absent
    expect(client.calls).toHaveLength(2);
  });

  it("uses 3-message coercion shape on PLAN retry", async () => {
    const client = new ScriptedClient(["not json", "still not json"]);
    await expect(
      decomposeGoalDeep({ goal: "g", client, model: "m" }),
    ).rejects.toThrow();

    // Second (retry) call must use 3-message shape
    const secondCall = client.calls[1];
    expect(secondCall?.messages).toHaveLength(3);
    expect(secondCall?.messages[0]?.role).toBe("user");
    expect(secondCall?.messages[1]?.role).toBe("assistant");
    expect(secondCall?.messages[1]?.content).toBe("not json"); // echoed prior text
    expect(secondCall?.messages[2]?.role).toBe("user");
  });

  it("throws after exactly 2 PLAN attempts (1 + DEEP_PLAN_MAX_RETRIES)", async () => {
    const client = new ScriptedClient(["bad", "still bad"]);
    await expect(
      decomposeGoalDeep({ goal: "goal", client, model: "m" }),
    ).rejects.toThrow(/deep plan failed after 2 attempts/);
    expect(client.calls).toHaveLength(2);
  });
});

// ── EXPAND exhaustion (incl. config-key guard) ───────────────────────

describe("decomposeGoalDeep — EXPAND exhaustion (sc-1-7)", () => {
  it("throws with 'deep expand failed' when all EXPAND attempts fail", async () => {
    const badExpand = JSON.stringify({ children: [{ folder: "x", task: "t", config: {} }] });
    const client = new ScriptedClient([VALID_OUTLINE_JSON, badExpand, badExpand]);
    await expect(
      decomposeGoalDeep({ goal: "g", client, model: "m" }),
    ).rejects.toThrow(/deep expand failed/);
  });

  it("config-key guard surfaces in EXPAND error and triggers coercion retry", async () => {
    const cfgChild = JSON.stringify({
      children: [{ folder: "x", task: "t", config: {} }],
    });
    const client = new ScriptedClient([VALID_OUTLINE_JSON, cfgChild, cfgChild]);
    await expect(
      decomposeGoalDeep({ goal: "g", client, model: "m" }),
    ).rejects.toThrow(/config/);
  });

  it("total chat calls across a fully-failing deep run never exceed DEEP_MAX_TOTAL_CALLS (4)", async () => {
    const cfgChild = JSON.stringify({
      children: [{ folder: "x", task: "t", config: {} }],
    });
    const client = new ScriptedClient([VALID_OUTLINE_JSON, cfgChild, cfgChild]);
    await expect(
      decomposeGoalDeep({ goal: "g", client, model: "m" }),
    ).rejects.toThrow();
    expect(client.calls.length).toBeLessThanOrEqual(DEEP_MAX_TOTAL_CALLS);
  });

  it("EXPAND retry uses 3-message coercion shape", async () => {
    const badExpand = "not valid manifest";
    const client = new ScriptedClient([VALID_OUTLINE_JSON, badExpand, badExpand]);
    await expect(
      decomposeGoalDeep({ goal: "g", client, model: "m" }),
    ).rejects.toThrow();

    // calls[0] = PLAN, calls[1] = EXPAND attempt 1, calls[2] = EXPAND retry
    expect(client.calls).toHaveLength(3);
    const expandRetryCall = client.calls[2];
    expect(expandRetryCall?.messages).toHaveLength(3);
    expect(expandRetryCall?.messages[0]?.role).toBe("user");
    expect(expandRetryCall?.messages[1]?.role).toBe("assistant");
    expect(expandRetryCall?.messages[1]?.content).toBe(badExpand);
    expect(expandRetryCall?.messages[2]?.role).toBe("user");
  });

  it("succeeds on EXPAND retry after first EXPAND failure", async () => {
    const badExpand = "not valid manifest";
    const client = new ScriptedClient([
      VALID_OUTLINE_JSON,
      badExpand,
      VALID_MULTI_CHILD_JSON,
    ]);
    const result = await decomposeGoalDeep({ goal: "g", client, model: "m" });

    expect(FleetManifestSchema.safeParse(result).success).toBe(true);
    expect(client.calls).toHaveLength(3); // PLAN + EXPAND fail + EXPAND retry
  });
});

// ── runPlanStage standalone ──────────────────────────────────────────

describe("runPlanStage", () => {
  it("returns an Outline on valid response", async () => {
    const client = new ScriptedClient([VALID_OUTLINE_JSON]);
    const outline = await runPlanStage({
      client,
      model: "m",
      goal: "Build something",
      maxRetries: 1,
    });
    expect(outline.areas).toHaveLength(2);
    expect(client.calls).toHaveLength(1);
  });

  it("throws after maxRetries+1 attempts", async () => {
    const client = new ScriptedClient(["bad", "bad"]);
    await expect(
      runPlanStage({ client, model: "m", goal: "g", maxRetries: 1 }),
    ).rejects.toThrow(/deep plan failed after 2 attempts/);
    expect(client.calls).toHaveLength(2);
  });

  it("throws after exactly 1 attempt when maxRetries=0", async () => {
    const client = new ScriptedClient(["bad"]);
    await expect(
      runPlanStage({ client, model: "m", goal: "g", maxRetries: 0 }),
    ).rejects.toThrow(/deep plan failed after 1 attempt/);
    expect(client.calls).toHaveLength(1);
  });
});

// ── runExpandStage standalone ─────────────────────────────────────────

describe("runExpandStage", () => {
  const testOutline = {
    areas: [
      { name: "auth", intent: "user login" },
      { name: "billing", intent: "payments" },
    ],
  };

  it("returns a FleetManifest on valid response", async () => {
    const client = new ScriptedClient([VALID_MULTI_CHILD_JSON]);
    const manifest = await runExpandStage({
      client,
      model: "m",
      outline: testOutline,
      goal: "Build a platform",
      maxRetries: 1,
    });
    expect(FleetManifestSchema.safeParse(manifest).success).toBe(true);
    expect(client.calls).toHaveLength(1);
  });

  it("throws after maxRetries+1 attempts with 'deep expand failed'", async () => {
    const client = new ScriptedClient(["bad", "bad"]);
    await expect(
      runExpandStage({
        client,
        model: "m",
        outline: testOutline,
        goal: "g",
        maxRetries: 1,
      }),
    ).rejects.toThrow(/deep expand failed after 2 attempts/);
    expect(client.calls).toHaveLength(2);
  });

  it("rejects config-bearing children (config-key guard inherited from validateManifest)", async () => {
    const withConfig = JSON.stringify({
      children: [{ folder: "api", task: "build it", config: { foo: 1 } }],
    });
    const client = new ScriptedClient([withConfig, VALID_MULTI_CHILD_JSON]);
    const manifest = await runExpandStage({
      client,
      model: "m",
      outline: testOutline,
      goal: "g",
      maxRetries: 1,
    });
    // Should succeed on second attempt (after config-key guard rejected first)
    expect(FleetManifestSchema.safeParse(manifest).success).toBe(true);
    expect(client.calls).toHaveLength(2);
  });
});
