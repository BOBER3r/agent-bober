import { describe, it, expect } from "vitest";
import type { LLMClient, ChatParams, ChatResponse } from "../../providers/types.js";
import {
  validateLensVerdict,
  getLensVerdict,
  buildEvidenceGraderSystemPrompt,
  buildContraindicationCheckerSystemPrompt,
  buildConservativeCliniciansSystemPrompt,
  buildOptimizationLensSystemPrompt,
  LensVerdictSchema,
} from "./lenses.js";
import { LENS_MAX_LLM_CALLS, LENS_PARSE_MAX_RETRIES } from "./types.js";

// ── ScriptedClient ────────────────────────────────────────────────────

/** Returns scripted responses in order; repeats the last once exhausted. Records every ChatParams. */
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

// ── Sample data ───────────────────────────────────────────────────────

const VALID_APPROVE = '{"verdict":"approve","feedback":""}';
const VALID_REJECT = '{"verdict":"reject","feedback":"Claim not evidence-based."}';
const VALID_APPROVE_WITH_VETO = '{"verdict":"approve","veto":true,"feedback":"interacts w/ med X"}';

// ── validateLensVerdict — never throws ───────────────────────────────

describe("validateLensVerdict never throws", () => {
  it.each([
    VALID_APPROVE,
    "```json\n{\"verdict\":\"reject\",\"feedback\":\"x\"}\n```",
    'prose {"verdict":"reject","feedback":"x"} prose',
    "",
    "garbage",
    "{}",
  ])("does not throw for %j", (input) => {
    expect(() => validateLensVerdict(input)).not.toThrow();
  });

  it("returns ok:true only for valid shapes", () => {
    expect(validateLensVerdict(VALID_APPROVE).ok).toBe(true);
    expect(validateLensVerdict(VALID_REJECT).ok).toBe(true);
    expect(validateLensVerdict("garbage").ok).toBe(false);
    expect(validateLensVerdict("{}").ok).toBe(false);
    expect(validateLensVerdict("").ok).toBe(false);
  });

  it("parses fenced JSON correctly", () => {
    const result = validateLensVerdict("```json\n{\"verdict\":\"approve\",\"feedback\":\"\"}\n```");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verdict.verdict).toBe("approve");
    }
  });

  it("parses prose-embedded JSON correctly", () => {
    const result = validateLensVerdict('Some prose. {"verdict":"reject","feedback":"bad"} More prose.');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verdict.verdict).toBe("reject");
      expect(result.verdict.feedback).toBe("bad");
    }
  });

  it("rejects missing feedback field", () => {
    const result = validateLensVerdict('{"verdict":"approve"}');
    expect(result.ok).toBe(false);
  });

  it("parses veto field when present", () => {
    const result = validateLensVerdict(VALID_APPROVE_WITH_VETO);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verdict.veto).toBe(true);
      expect(result.verdict.verdict).toBe("approve");
    }
  });

  it("succeeds when veto field is absent (optional)", () => {
    const result = validateLensVerdict(VALID_APPROVE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verdict.veto).toBeUndefined();
    }
  });
});

// ── LensVerdictSchema — Zod schema sanity ────────────────────────────

describe("LensVerdictSchema", () => {
  it("accepts approve without veto", () => {
    expect(LensVerdictSchema.safeParse({ verdict: "approve", feedback: "" }).success).toBe(true);
  });

  it("accepts reject with veto:false", () => {
    expect(
      LensVerdictSchema.safeParse({ verdict: "reject", feedback: "x", veto: false }).success,
    ).toBe(true);
  });

  it("rejects unknown verdict values", () => {
    expect(
      LensVerdictSchema.safeParse({ verdict: "abstain", feedback: "" }).success,
    ).toBe(false);
  });
});

// ── getLensVerdict — approve path ────────────────────────────────────

describe("getLensVerdict approve path", () => {
  it("returns approve when model emits a valid approve verdict", async () => {
    const client = new ScriptedClient([VALID_APPROVE]);
    const result = await getLensVerdict({
      llm: client,
      model: "test-model",
      systemPrompt: "system",
      userContent: "user",
    });
    expect(result.verdict).toBe("approve");
    expect(result.feedback).toBe("");
  });

  it("returns reject when model emits a valid reject verdict", async () => {
    const client = new ScriptedClient([VALID_REJECT]);
    const result = await getLensVerdict({
      llm: client,
      model: "test-model",
      systemPrompt: "system",
      userContent: "user",
    });
    expect(result.verdict).toBe("reject");
  });

  it("parses veto:true from contraindication-checker response", async () => {
    const client = new ScriptedClient([VALID_APPROVE_WITH_VETO]);
    const result = await getLensVerdict({
      llm: client,
      model: "test-model",
      systemPrompt: buildContraindicationCheckerSystemPrompt("q", "ctx"),
      userContent: "user",
    });
    expect(result.veto).toBe(true);
    expect(result.verdict).toBe("approve");
  });
});

// ── getLensVerdict — fail-closed on parse exhaustion ─────────────────

describe("getLensVerdict fail-closed on exhaustion", () => {
  it("returns verdict=reject when all attempts return unparseable text", async () => {
    const client = new ScriptedClient(["garbage 1", "garbage 2"]);
    const result = await getLensVerdict({
      llm: client,
      model: "test-model",
      systemPrompt: "system",
      userContent: "user",
    });
    expect(result.verdict).toBe("reject");
    expect(result.feedback).toBe("<unparseable lens output>");
    expect(result.veto).toBe(false);
  });

  it("makes exactly LENS_MAX_LLM_CALLS attempts on parse exhaustion", async () => {
    const client = new ScriptedClient(["garbage 1", "garbage 2", "garbage 3"]);
    await getLensVerdict({
      llm: client,
      model: "test-model",
      systemPrompt: "system",
      userContent: "user",
    });
    expect(client.calls).toHaveLength(LENS_MAX_LLM_CALLS);
  });

  it("uses LENS_MAX_LLM_CALLS as a derived constant (not a magic number)", () => {
    expect(LENS_MAX_LLM_CALLS).toBe(1 + LENS_PARSE_MAX_RETRIES);
  });

  it("uses coercion retry on second attempt (3-message shape)", async () => {
    // First response is garbage → retry with coercion → second response is garbage too
    const client = new ScriptedClient(["garbage", "garbage"]);
    await getLensVerdict({
      llm: client,
      model: "test-model",
      systemPrompt: "system",
      userContent: "user",
    });
    // Second call should have 3 messages [user, assistant, user-coercion]
    expect(client.calls).toHaveLength(2);
    const secondCall = client.calls[1];
    expect(secondCall).toBeDefined();
    if (secondCall) {
      expect(secondCall.messages).toHaveLength(3);
    }
  });
});

// ── getLensVerdict — jsonObjectMode is set ────────────────────────────

describe("getLensVerdict jsonObjectMode", () => {
  it("sets jsonObjectMode:true on every call (mirrors grounding-critic.ts:162)", async () => {
    const client = new ScriptedClient([VALID_APPROVE]);
    await getLensVerdict({
      llm: client,
      model: "test-model",
      systemPrompt: "system",
      userContent: "user",
    });
    expect(client.calls[0]?.jsonObjectMode).toBe(true);
  });
});

// ── System prompt builders ────────────────────────────────────────────

describe("system prompt builders", () => {
  it("evidence-grader prompt includes the question", () => {
    const prompt = buildEvidenceGraderSystemPrompt("test question", "ctx");
    expect(prompt).toContain("test question");
  });

  it("contraindication-checker prompt includes veto instruction", () => {
    const prompt = buildContraindicationCheckerSystemPrompt("test question", "ctx");
    expect(prompt.toLowerCase()).toContain("veto");
  });

  it("conservative-clinician prompt includes safety language", () => {
    const prompt = buildConservativeCliniciansSystemPrompt("test question", "ctx");
    expect(prompt.toLowerCase()).toContain("safety");
  });

  it("optimization-lens prompt includes actionable language", () => {
    const prompt = buildOptimizationLensSystemPrompt("test question", "ctx");
    expect(prompt.toLowerCase()).toContain("actionable");
  });
});
