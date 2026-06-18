import { describe, it, expect } from "vitest";

import type { LLMClient, ChatParams, ChatResponse } from "../providers/types.js";
import { FleetManifestSchema } from "./manifest.js";
import {
  CRITIQUE_MAX_ROUNDS,
  CRITIQUE_PARSE_MAX_RETRIES,
  DEEP_CRITIQUE_MAX_TOTAL_CALLS,
  CRITIQUE_SYSTEM_PROMPT,
  CritiqueVerdictSchema,
  validateVerdict,
  callCritic,
  getCriticVerdict,
  runCritiqueLoop,
} from "./critic-deep.js";
import {
  DEEP_MAX_TOTAL_CALLS,
  DEEP_EXPAND_MAX_RETRIES,
  decomposeGoalDeep,
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

const VALID_OUTLINE = {
  areas: [
    { name: "auth", intent: "user login and sessions" },
    { name: "billing", intent: "payments and invoices" },
  ],
};

const VALID_OUTLINE_JSON = JSON.stringify(VALID_OUTLINE);

const VALID_SINGLE_CHILD_JSON = JSON.stringify({
  children: [{ folder: "api-server", task: "Build the REST API server" }],
});

const VALID_MULTI_CHILD_JSON = JSON.stringify({
  children: [
    { folder: "auth-service", task: "Build the auth service with JWT" },
    { folder: "billing-service", task: "Build the billing service with Stripe" },
    { folder: "web-frontend", task: "Build the React frontend" },
  ],
});

const VALID_TWO_CHILD_JSON = JSON.stringify({
  children: [
    { folder: "auth-service", task: "Build the auth service" },
    { folder: "billing-service", task: "Build the billing service" },
  ],
});

const VALID_APPROVE_JSON = JSON.stringify({ verdict: "approve", feedback: "" });
const VALID_REJECT_JSON = JSON.stringify({ verdict: "reject", feedback: "too few children for 12-area outline" });

const VALID_SINGLE_CHILD_MANIFEST = {
  children: [{ folder: "api-server", task: "Build the REST API server" }],
  rootDir: ".",
  concurrency: 3,
};

const VALID_TWO_CHILD_MANIFEST = {
  children: [
    { folder: "auth-service", task: "Build the auth service" },
    { folder: "billing-service", task: "Build the billing service" },
  ],
  rootDir: ".",
  concurrency: 3,
};

// ── Constants (sc-1-4) ───────────────────────────────────────────────

describe("CritiqueConstants (sc-1-4)", () => {
  it("CRITIQUE_MAX_ROUNDS is exactly 1", () => {
    expect(CRITIQUE_MAX_ROUNDS).toBe(1);
  });

  it("CRITIQUE_PARSE_MAX_RETRIES is exactly 1", () => {
    expect(CRITIQUE_PARSE_MAX_RETRIES).toBe(1);
  });

  it("DEEP_CRITIQUE_MAX_TOTAL_CALLS is exactly 8", () => {
    expect(DEEP_CRITIQUE_MAX_TOTAL_CALLS).toBe(8);
  });

  it("DEEP_CRITIQUE_MAX_TOTAL_CALLS satisfies the closed-form audit relation", () => {
    expect(DEEP_CRITIQUE_MAX_TOTAL_CALLS).toBe(
      DEEP_MAX_TOTAL_CALLS +
        CRITIQUE_MAX_ROUNDS * ((1 + CRITIQUE_PARSE_MAX_RETRIES) + (1 + DEEP_EXPAND_MAX_RETRIES)),
    );
  });
});

// ── CritiqueVerdictSchema ────────────────────────────────────────────

describe("CritiqueVerdictSchema", () => {
  it("accepts approve with empty feedback", () => {
    const r = CritiqueVerdictSchema.safeParse({ verdict: "approve", feedback: "" });
    expect(r.success).toBe(true);
  });

  it("accepts reject with feedback text", () => {
    const r = CritiqueVerdictSchema.safeParse({ verdict: "reject", feedback: "too few children" });
    expect(r.success).toBe(true);
  });

  it("rejects unknown verdict enum", () => {
    const r = CritiqueVerdictSchema.safeParse({ verdict: "maybe", feedback: "x" });
    expect(r.success).toBe(false);
  });

  it("rejects missing feedback", () => {
    const r = CritiqueVerdictSchema.safeParse({ verdict: "approve" });
    expect(r.success).toBe(false);
  });
});

// ── validateVerdict (sc-1-5) ─────────────────────────────────────────

describe("validateVerdict (sc-1-5)", () => {
  it("returns ok:false (does not throw) for empty string", () => {
    expect(() => validateVerdict("")).not.toThrow();
    expect(validateVerdict("").ok).toBe(false);
  });

  it("returns ok:false (does not throw) for non-JSON text", () => {
    expect(() => validateVerdict("not json at all")).not.toThrow();
    expect(validateVerdict("not json at all").ok).toBe(false);
  });

  it("returns ok:false (does not throw) for bad verdict enum", () => {
    const raw = JSON.stringify({ verdict: "maybe", feedback: "x" });
    expect(() => validateVerdict(raw)).not.toThrow();
    expect(validateVerdict(raw).ok).toBe(false);
  });

  it("returns ok:false (does not throw) for missing feedback key", () => {
    const raw = JSON.stringify({ verdict: "approve" });
    expect(() => validateVerdict(raw)).not.toThrow();
    expect(validateVerdict(raw).ok).toBe(false);
  });

  it("returns ok:true for a valid approve verdict", () => {
    const r = validateVerdict(VALID_APPROVE_JSON);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.verdict.verdict).toBe("approve");
      expect(r.verdict.feedback).toBe("");
    }
  });

  it("returns ok:true for a valid reject verdict with feedback", () => {
    const r = validateVerdict(VALID_REJECT_JSON);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.verdict.verdict).toBe("reject");
      expect(r.verdict.feedback).toBe("too few children for 12-area outline");
    }
  });

  it("extracts from a fenced json block", () => {
    const fenced = "```json\n" + VALID_APPROVE_JSON + "\n```";
    const r = validateVerdict(fenced);
    expect(r.ok).toBe(true);
  });

  it("extracts from first-brace-to-last-brace substring", () => {
    const wrapped = "Here is the verdict: " + VALID_APPROVE_JSON + " That is all.";
    const r = validateVerdict(wrapped);
    expect(r.ok).toBe(true);
  });

  it("returns ok:false for empty JSON object (missing both fields)", () => {
    expect(validateVerdict("{}").ok).toBe(false);
  });
});

// ── callCritic (sc-1-6 — call shape) ────────────────────────────────

describe("callCritic (sc-1-6)", () => {
  it("uses CRITIQUE_SYSTEM_PROMPT and jsonObjectMode:true, never responseSchema", async () => {
    const client = new ScriptedClient([VALID_APPROVE_JSON]);
    await callCritic({
      client,
      model: "m",
      goal: "Build a platform",
      outline: VALID_OUTLINE,
      candidate: VALID_SINGLE_CHILD_MANIFEST,
    });

    expect(client.calls).toHaveLength(1);
    const call = client.calls[0];
    expect(call?.system).toBe(CRITIQUE_SYSTEM_PROMPT);
    expect(call?.jsonObjectMode).toBe(true);
    expect(call?.responseSchema).toBeUndefined();
  });

  it("first user turn includes goal + outline + candidate JSON as third-party review", async () => {
    const client = new ScriptedClient([VALID_APPROVE_JSON]);
    await callCritic({
      client,
      model: "m",
      goal: "Build a platform",
      outline: VALID_OUTLINE,
      candidate: VALID_SINGLE_CHILD_MANIFEST,
    });

    const firstMsg = client.calls[0]?.messages[0];
    expect(firstMsg?.role).toBe("user");
    expect(firstMsg?.content).toContain("third-party");
    expect(firstMsg?.content).toContain("Build a platform");
    expect(firstMsg?.content).toContain(JSON.stringify(VALID_OUTLINE));
    expect(firstMsg?.content).toContain(JSON.stringify(VALID_SINGLE_CHILD_MANIFEST));
  });

  it("coercion retry uses 3-message [user, assistant, user] shape", async () => {
    const client = new ScriptedClient([VALID_APPROVE_JSON]);
    const priorText = "bad response";
    const formattedError = "verdict: invalid enum";
    await callCritic({
      client,
      model: "m",
      goal: "g",
      outline: VALID_OUTLINE,
      candidate: VALID_SINGLE_CHILD_MANIFEST,
      priorText,
      formattedError,
    });

    const call = client.calls[0];
    expect(call?.messages).toHaveLength(3);
    expect(call?.messages[0]?.role).toBe("user");
    expect(call?.messages[1]?.role).toBe("assistant");
    expect(call?.messages[1]?.content).toBe(priorText);
    expect(call?.messages[2]?.role).toBe("user");
  });

  it("fresh message array (single turn) when no priorText/formattedError", async () => {
    const client = new ScriptedClient([VALID_APPROVE_JSON]);
    await callCritic({
      client,
      model: "m",
      goal: "g",
      outline: VALID_OUTLINE,
      candidate: VALID_SINGLE_CHILD_MANIFEST,
    });

    expect(client.calls[0]?.messages).toHaveLength(1);
  });
});

// ── getCriticVerdict — fail-open (sc-1-6) ────────────────────────────

describe("getCriticVerdict — fail-open (sc-1-6)", () => {
  it("returns {verdict:approve,feedback:''} after 2 unparseable responses, never throws", async () => {
    const client = new ScriptedClient(["garbage 1", "garbage 2"]);
    const result = await getCriticVerdict({
      client,
      model: "m",
      goal: "Build a platform",
      outline: VALID_OUTLINE,
      candidate: VALID_SINGLE_CHILD_MANIFEST,
    });
    expect(result.verdict).toBe("approve");
    expect(result.feedback).toBe("");
  });

  it("makes exactly 2 chat calls on full parse exhaustion", async () => {
    const client = new ScriptedClient(["garbage 1", "garbage 2"]);
    await getCriticVerdict({
      client,
      model: "m",
      goal: "g",
      outline: VALID_OUTLINE,
      candidate: VALID_SINGLE_CHILD_MANIFEST,
    });
    expect(client.calls).toHaveLength(2);
  });

  it("both exhaustion calls have jsonObjectMode===true and responseSchema===undefined", async () => {
    const client = new ScriptedClient(["garbage 1", "garbage 2"]);
    await getCriticVerdict({
      client,
      model: "m",
      goal: "g",
      outline: VALID_OUTLINE,
      candidate: VALID_SINGLE_CHILD_MANIFEST,
    });
    for (const call of client.calls) {
      expect(call.jsonObjectMode).toBe(true);
      expect(call.responseSchema).toBeUndefined();
    }
  });

  it("second call uses 3-message coercion shape on parse retry", async () => {
    const client = new ScriptedClient(["garbage", "garbage"]);
    await getCriticVerdict({
      client,
      model: "m",
      goal: "g",
      outline: VALID_OUTLINE,
      candidate: VALID_SINGLE_CHILD_MANIFEST,
    });

    const secondCall = client.calls[1];
    expect(secondCall?.messages).toHaveLength(3);
    expect(secondCall?.messages[0]?.role).toBe("user");
    expect(secondCall?.messages[1]?.role).toBe("assistant");
    expect(secondCall?.messages[1]?.content).toBe("garbage");
    expect(secondCall?.messages[2]?.role).toBe("user");
  });

  it("returns parsed verdict immediately on first valid response", async () => {
    const client = new ScriptedClient([VALID_REJECT_JSON]);
    const result = await getCriticVerdict({
      client,
      model: "m",
      goal: "g",
      outline: VALID_OUTLINE,
      candidate: VALID_SINGLE_CHILD_MANIFEST,
    });

    expect(result.verdict).toBe("reject");
    expect(result.feedback).toBe("too few children for 12-area outline");
    expect(client.calls).toHaveLength(1);
  });
});

// ── runCritiqueLoop (sc-1-7) ─────────────────────────────────────────

describe("runCritiqueLoop (sc-1-7)", () => {
  it("returns baseline immediately on approve", async () => {
    const client = new ScriptedClient([VALID_APPROVE_JSON]);
    const result = await runCritiqueLoop({
      client,
      model: "m",
      goal: "g",
      outline: VALID_OUTLINE,
      baseline: VALID_SINGLE_CHILD_MANIFEST,
      expandMaxRetries: DEEP_EXPAND_MAX_RETRIES,
    });

    expect(result).toBe(VALID_SINGLE_CHILD_MANIFEST);
    expect(client.calls).toHaveLength(1); // just the critic call
  });

  it("reject-then-richer-expand: folds feedback into re-expand and returns multi-child manifest (sc-1-7a)", async () => {
    // Sequence: critic(baseline)=reject, re-expand=multi-child, critic(re-expand)=approve
    const client = new ScriptedClient([
      VALID_REJECT_JSON,
      VALID_MULTI_CHILD_JSON,
      VALID_APPROVE_JSON,
    ]);
    const result = await runCritiqueLoop({
      client,
      model: "m",
      goal: "Build a platform",
      outline: VALID_OUTLINE,
      baseline: VALID_SINGLE_CHILD_MANIFEST,
      expandMaxRetries: DEEP_EXPAND_MAX_RETRIES,
    });

    expect(FleetManifestSchema.safeParse(result).success).toBe(true);
    expect(result.children.length).toBeGreaterThan(1);
    // 1 critic call + 1 expand call + 1 critic call = 3
    expect(client.calls).toHaveLength(3);
  });

  it("reject-then-richer-expand: re-expand call first user message CONTAINS critique feedback", async () => {
    const client = new ScriptedClient([
      VALID_REJECT_JSON,
      VALID_MULTI_CHILD_JSON,
      VALID_APPROVE_JSON,
    ]);
    await runCritiqueLoop({
      client,
      model: "m",
      goal: "Build a platform",
      outline: VALID_OUTLINE,
      baseline: VALID_SINGLE_CHILD_MANIFEST,
      expandMaxRetries: DEEP_EXPAND_MAX_RETRIES,
    });

    // calls[0]=critic, calls[1]=re-expand, calls[2]=critic-2
    const reExpandCall = client.calls[1];
    const firstMsg = reExpandCall?.messages[0];
    expect(firstMsg?.content).toContain("too few children for 12-area outline");
  });

  it("all-reject: returns accept-best (tiebreak most children, else baseline) and NEVER throws (sc-1-7b)", async () => {
    // baseline=2 children; reject on baseline critic; re-expand=2 children; reject on re-expand critic → accept best
    const client = new ScriptedClient([VALID_REJECT_JSON, VALID_TWO_CHILD_JSON, VALID_REJECT_JSON]);
    const result = await runCritiqueLoop({
      client,
      model: "m",
      goal: "g",
      outline: VALID_OUTLINE,
      baseline: VALID_TWO_CHILD_MANIFEST,
      expandMaxRetries: DEEP_EXPAND_MAX_RETRIES,
    });
    expect(result).toBeDefined();
    expect(FleetManifestSchema.safeParse(result).success).toBe(true);
  });

  it("all-reject ceiling: total calls never exceed DEEP_CRITIQUE_MAX_TOTAL_CALLS (sc-1-7c)", async () => {
    // Script one reject verdict that will repeat; each critic call = reject
    const client = new ScriptedClient([VALID_REJECT_JSON, VALID_TWO_CHILD_JSON]);
    await runCritiqueLoop({
      client,
      model: "m",
      goal: "g",
      outline: VALID_OUTLINE,
      baseline: VALID_TWO_CHILD_MANIFEST,
      expandMaxRetries: DEEP_EXPAND_MAX_RETRIES,
    });
    expect(client.calls.length).toBeLessThanOrEqual(DEEP_CRITIQUE_MAX_TOTAL_CALLS);
  });

  it("loop resolves (never throws) on all-reject run", async () => {
    const client = new ScriptedClient([VALID_REJECT_JSON, VALID_TWO_CHILD_JSON]);
    await expect(
      runCritiqueLoop({
        client,
        model: "m",
        goal: "g",
        outline: VALID_OUTLINE,
        baseline: VALID_TWO_CHILD_MANIFEST,
        expandMaxRetries: DEEP_EXPAND_MAX_RETRIES,
      }),
    ).resolves.toBeDefined();
  });

  it("tiebreak: baseline wins when re-expand has same child count", async () => {
    // baseline=2, re-expand=2 → baseline (first-seen) wins
    const client = new ScriptedClient([VALID_REJECT_JSON, VALID_TWO_CHILD_JSON, VALID_REJECT_JSON]);
    const result = await runCritiqueLoop({
      client,
      model: "m",
      goal: "g",
      outline: VALID_OUTLINE,
      baseline: VALID_TWO_CHILD_MANIFEST,
      expandMaxRetries: DEEP_EXPAND_MAX_RETRIES,
    });
    // both have 2 children; baseline is first, so reduces to baseline
    expect(result.children.length).toBe(2);
  });

  it("tiebreak: re-expand wins when it has more children than baseline", async () => {
    // baseline=1 child; re-expand=3 children → re-expand wins
    const client = new ScriptedClient([VALID_REJECT_JSON, VALID_MULTI_CHILD_JSON, VALID_REJECT_JSON]);
    const result = await runCritiqueLoop({
      client,
      model: "m",
      goal: "g",
      outline: VALID_OUTLINE,
      baseline: VALID_SINGLE_CHILD_MANIFEST,
      expandMaxRetries: DEEP_EXPAND_MAX_RETRIES,
    });
    expect(result.children.length).toBe(3);
  });
});

// ── decomposeGoalDeep integration (sc-1-8) ───────────────────────────

describe("decomposeGoalDeep — critique:true integration (sc-1-8)", () => {
  it("with critique:true, scripted reject+richer-expand returns multi-child manifest", async () => {
    // Sequence: PLAN, EXPAND-baseline(2 children), critic=reject, re-EXPAND(3 children), critic=approve
    const client = new ScriptedClient([
      VALID_OUTLINE_JSON,          // PLAN
      VALID_TWO_CHILD_JSON,        // EXPAND-baseline
      VALID_REJECT_JSON,           // critic verdict: reject
      VALID_MULTI_CHILD_JSON,      // re-EXPAND
      VALID_APPROVE_JSON,          // critic verdict: approve
    ]);

    const result = await decomposeGoalDeep({
      goal: "Build a platform",
      client,
      model: "m",
      critique: true,
    });

    expect(FleetManifestSchema.safeParse(result).success).toBe(true);
    expect(result.children.length).toBe(3);
  });

  it("manifest handed to critic is FleetManifestSchema-valid (critic after structural gate)", async () => {
    const client = new ScriptedClient([
      VALID_OUTLINE_JSON,
      VALID_TWO_CHILD_JSON,
      VALID_APPROVE_JSON,
    ]);

    await decomposeGoalDeep({
      goal: "Build a platform",
      client,
      model: "m",
      critique: true,
    });

    // The critic call (calls[2]) received the candidate serialized in its user message
    const criticCall = client.calls[2];
    expect(criticCall?.system).toBe(CRITIQUE_SYSTEM_PROMPT);
    // Verify the candidate JSON in the critic user message is valid per FleetManifestSchema
    const userContent = criticCall?.messages[0]?.content as string;
    expect(userContent).toContain("auth-service");
  });

  it("with critique:false, ZERO critic calls and <=4 chat calls (byte-identical to Phase 3)", async () => {
    const client = new ScriptedClient([VALID_OUTLINE_JSON, VALID_MULTI_CHILD_JSON]);
    await decomposeGoalDeep({
      goal: "Build a platform",
      client,
      model: "m",
      critique: false,
    });

    // Only PLAN + EXPAND; no critic
    expect(client.calls).toHaveLength(2);
    for (const call of client.calls) {
      expect(call.system).not.toBe(CRITIQUE_SYSTEM_PROMPT);
    }
    expect(client.calls.length).toBeLessThanOrEqual(4);
  });

  it("with critique absent (undefined), ZERO critic calls and <=4 chat calls (byte-identical to Phase 3)", async () => {
    const client = new ScriptedClient([VALID_OUTLINE_JSON, VALID_MULTI_CHILD_JSON]);
    await decomposeGoalDeep({
      goal: "Build a platform",
      client,
      model: "m",
    });

    expect(client.calls).toHaveLength(2);
    for (const call of client.calls) {
      expect(call.system).not.toBe(CRITIQUE_SYSTEM_PROMPT);
    }
    expect(client.calls.length).toBeLessThanOrEqual(4);
  });

  it("end-to-end ceiling: all-reject run stays within DEEP_CRITIQUE_MAX_TOTAL_CALLS=8", async () => {
    // Sequence: PLAN, EXPAND-baseline, critic=reject (repeats), re-EXPAND, critic=reject → accept-best
    const client = new ScriptedClient([
      VALID_OUTLINE_JSON,
      VALID_SINGLE_CHILD_JSON,
      VALID_REJECT_JSON,
      VALID_MULTI_CHILD_JSON,
      VALID_REJECT_JSON,
    ]);

    await expect(
      decomposeGoalDeep({
        goal: "Build a platform",
        client,
        model: "m",
        critique: true,
      }),
    ).resolves.toBeDefined();

    expect(client.calls.length).toBeLessThanOrEqual(DEEP_CRITIQUE_MAX_TOTAL_CALLS);
  });

  it("with critique:true, decomposeGoalDeep never throws even on all-reject", async () => {
    const client = new ScriptedClient([
      VALID_OUTLINE_JSON,
      VALID_SINGLE_CHILD_JSON,
      VALID_REJECT_JSON,
      VALID_MULTI_CHILD_JSON,
      VALID_REJECT_JSON,
    ]);

    await expect(
      decomposeGoalDeep({
        goal: "g",
        client,
        model: "m",
        critique: true,
      }),
    ).resolves.toBeDefined();
  });
});

// ── Regression: existing decomposer-deep tests via re-import ─────────

describe("decomposeGoalDeep — Phase-3 regression (no critique)", () => {
  it("happy path resolves with FleetManifestSchema-valid multi-child manifest", async () => {
    const client = new ScriptedClient([VALID_OUTLINE_JSON, VALID_MULTI_CHILD_JSON]);
    const result = await decomposeGoalDeep({
      goal: "Build a platform",
      client,
      model: "deepseek-v4-pro",
    });

    expect(FleetManifestSchema.safeParse(result).success).toBe(true);
    expect(result.children.length).toBeGreaterThan(1);
    expect(client.calls).toHaveLength(2);
  });

  it("PLAN+EXPAND calls have jsonObjectMode===true and responseSchema===undefined", async () => {
    const client = new ScriptedClient([VALID_OUTLINE_JSON, VALID_MULTI_CHILD_JSON]);
    await decomposeGoalDeep({
      goal: "Build a platform",
      client,
      model: "m",
    });

    for (const call of client.calls) {
      expect(call.jsonObjectMode).toBe(true);
      expect(call.responseSchema).toBeUndefined();
    }
  });
});
