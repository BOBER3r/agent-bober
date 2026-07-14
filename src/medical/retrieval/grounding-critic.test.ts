import { describe, it, expect } from "vitest";
import type { LLMClient, ChatParams, ChatResponse } from "../../providers/types.js";
import type { Passage } from "./medline-source.js";
import {
  validateGroundingVerdict,
  getGroundingVerdict,
  buildGroundingSystemPrompt,
  GROUNDING_MAX_LLM_CALLS,
  GROUNDING_PARSE_MAX_RETRIES,
} from "./grounding-critic.js";

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

const SAMPLE_PASSAGES: Passage[] = [
  {
    title: "Diabetes overview",
    url: "https://medlineplus.gov/diabetes",
    text: "Diabetes is a disease in which blood glucose levels are too high.",
    source: "medlineplus",
  },
  {
    title: "Insulin therapy",
    url: "https://medlineplus.gov/insulin",
    text: "Insulin is a hormone that helps blood glucose enter cells.",
    source: "medlineplus",
  },
];

const VALID_APPROVE = '{"verdict":"approve","feedback":""}';
const VALID_REJECT = '{"verdict":"reject","feedback":"Claim not supported by passages."}';

// ── validateGroundingVerdict — never throws (sc-1-3) ─────────────────

describe("validateGroundingVerdict never throws", () => {
  it.each([
    VALID_APPROVE,
    "```json\n{\"verdict\":\"reject\",\"feedback\":\"x\"}\n```",
    'prose {"verdict":"reject","feedback":"x"} prose',
    "",
    "garbage",
    "{}",
  ])("does not throw for %j", (input) => {
    expect(() => validateGroundingVerdict(input)).not.toThrow();
  });

  it("returns ok:true only for valid shapes", () => {
    expect(validateGroundingVerdict(VALID_APPROVE).ok).toBe(true);
    expect(validateGroundingVerdict(VALID_REJECT).ok).toBe(true);
    expect(validateGroundingVerdict("garbage").ok).toBe(false);
    expect(validateGroundingVerdict("{}").ok).toBe(false);
    expect(validateGroundingVerdict("").ok).toBe(false);
  });

  it("parses fenced JSON correctly", () => {
    const result = validateGroundingVerdict("```json\n{\"verdict\":\"approve\",\"feedback\":\"\"}\n```");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verdict.verdict).toBe("approve");
    }
  });

  it("parses prose-embedded JSON correctly", () => {
    const result = validateGroundingVerdict('Some prose. {"verdict":"reject","feedback":"bad"} More prose.');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verdict.verdict).toBe("reject");
      expect(result.verdict.feedback).toBe("bad");
    }
  });

  it("rejects missing feedback field", () => {
    const result = validateGroundingVerdict('{"verdict":"approve"}');
    expect(result.ok).toBe(false);
  });
});

// ── getGroundingVerdict — approve only on explicit approve (sc-1-4) ──

describe("getGroundingVerdict approve path", () => {
  it("returns approve when model emits a valid approve verdict", async () => {
    const client = new ScriptedClient([VALID_APPROVE]);
    const result = await getGroundingVerdict({
      llm: client,
      model: "test-model",
      question: "What is diabetes?",
      answerBody: "Diabetes is a disease in which blood glucose levels are too high.",
      passages: SAMPLE_PASSAGES,
    });
    expect(result.verdict).toBe("approve");
    expect(result.feedback).toBe("");
  });

  it("returns reject when model emits a valid reject verdict", async () => {
    const client = new ScriptedClient([VALID_REJECT]);
    const result = await getGroundingVerdict({
      llm: client,
      model: "test-model",
      question: "What is diabetes?",
      answerBody: "Some answer.",
      passages: SAMPLE_PASSAGES,
    });
    expect(result.verdict).toBe("reject");
  });
});

// ── getGroundingVerdict — fail-closed on parse exhaustion (sc-1-4) ───

describe("getGroundingVerdict fail-closed on exhaustion", () => {
  it("returns verdict=reject when all attempts return unparseable text", async () => {
    const client = new ScriptedClient(["garbage 1", "garbage 2"]);
    const result = await getGroundingVerdict({
      llm: client,
      model: "test-model",
      question: "q",
      answerBody: "a",
      passages: SAMPLE_PASSAGES,
    });
    expect(result.verdict).toBe("reject");
    expect(result.feedback).toBe("<unparseable critic output>");
  });

  it("uses the GROUNDING_MAX_LLM_CALLS constant for the budget (not a hardcoded value)", () => {
    expect(GROUNDING_MAX_LLM_CALLS).toBe(1 + GROUNDING_PARSE_MAX_RETRIES);
  });
});

// ── getGroundingVerdict — fresh message array (sc-1-5) ───────────────

describe("getGroundingVerdict fresh message array", () => {
  it("first call uses a single user message with passages and answer body, no assistant turn", async () => {
    const client = new ScriptedClient(["garbage 1", "garbage 2"]);
    await getGroundingVerdict({
      llm: client,
      model: "test-model",
      question: "What is diabetes?",
      answerBody: "Diabetes involves high blood glucose.",
      passages: SAMPLE_PASSAGES,
    });

    const firstCallMessages = client.calls[0]?.messages;
    expect(firstCallMessages).toBeDefined();
    expect(firstCallMessages).toHaveLength(1);

    const firstMsg = firstCallMessages![0];
    expect(firstMsg?.role).toBe("user");

    // Content must include passage title and url
    const content = (firstMsg as { content: string }).content;
    expect(content).toContain(SAMPLE_PASSAGES[0].title);
    expect(content).toContain(SAMPLE_PASSAGES[0].url);

    // Content must include the answer body
    expect(content).toContain("Diabetes involves high blood glucose.");

    // Must NOT contain any prior synthesis assistant turn
    expect(firstCallMessages!.some((m) => m.role === "assistant")).toBe(false);
  });

  it("first call uses jsonObjectMode:true", async () => {
    const client = new ScriptedClient([VALID_APPROVE]);
    await getGroundingVerdict({
      llm: client,
      model: "test-model",
      question: "q",
      answerBody: "a",
      passages: SAMPLE_PASSAGES,
    });
    expect(client.calls[0]?.jsonObjectMode).toBe(true);
  });
});

// ── getGroundingVerdict — call budget cap (sc-1-6) ───────────────────

describe("getGroundingVerdict call budget cap", () => {
  it("makes exactly GROUNDING_MAX_LLM_CALLS attempts on parse-exhaustion path", async () => {
    const client = new ScriptedClient(["garbage 1", "garbage 2", "garbage 3"]);
    await getGroundingVerdict({
      llm: client,
      model: "test-model",
      question: "q",
      answerBody: "a",
      passages: SAMPLE_PASSAGES,
    });
    expect(client.calls).toHaveLength(GROUNDING_MAX_LLM_CALLS);
  });

  it("stops early (1 call) when first response is valid", async () => {
    const client = new ScriptedClient([VALID_APPROVE, "should-not-be-called"]);
    await getGroundingVerdict({
      llm: client,
      model: "test-model",
      question: "q",
      answerBody: "a",
      passages: SAMPLE_PASSAGES,
    });
    expect(client.calls).toHaveLength(1);
  });
});

// ── getGroundingVerdict — coercion retry shape (sc-1-5 + sc-1-6) ────

describe("getGroundingVerdict coercion retry", () => {
  it("uses 3-message [user, assistant, user] shape on retry attempt", async () => {
    const client = new ScriptedClient(["garbage response", VALID_APPROVE]);
    await getGroundingVerdict({
      llm: client,
      model: "test-model",
      question: "What is diabetes?",
      answerBody: "An answer about diabetes.",
      passages: SAMPLE_PASSAGES,
    });

    // Two calls total (first garbage + retry)
    expect(client.calls).toHaveLength(2);

    // Second call should have 3 messages: [user, assistant(priorText), user(coercion)]
    const secondCallMessages = client.calls[1]?.messages;
    expect(secondCallMessages).toHaveLength(3);
    expect(secondCallMessages![0]?.role).toBe("user");
    expect(secondCallMessages![1]?.role).toBe("assistant");
    expect(secondCallMessages![2]?.role).toBe("user");

    // The assistant turn should contain the prior garbage response
    const assistantContent = (secondCallMessages![1] as { content: string }).content;
    expect(assistantContent).toBe("garbage response");
  });
});

// ── buildGroundingSystemPrompt ────────────────────────────────────────

describe("buildGroundingSystemPrompt", () => {
  it("includes question, answer body, and passage info in the system prompt", () => {
    const prompt = buildGroundingSystemPrompt(
      "What is diabetes?",
      "Diabetes is a disease.",
      SAMPLE_PASSAGES,
    );
    expect(prompt).toContain("What is diabetes?");
    expect(prompt).toContain("Diabetes is a disease.");
    expect(prompt).toContain(SAMPLE_PASSAGES[0].title);
    expect(prompt).toContain(SAMPLE_PASSAGES[0].url);
    expect(prompt).toContain("[1]");
    expect(prompt).toContain("[2]");
  });

  it("includes grounding instructions in the system prompt", () => {
    const prompt = buildGroundingSystemPrompt("q", "a", SAMPLE_PASSAGES);
    expect(prompt).toContain("approve");
    expect(prompt).toContain("reject");
    expect(prompt).toContain("faithfulness");
    expect(prompt).toContain("completeness");
  });
});

// ── Transport errors propagate (not caught here) ──────────────────────

describe("getGroundingVerdict transport error propagation", () => {
  it("propagates LLM transport errors (does not catch them)", async () => {
    const errorClient: LLMClient = {
      async chat(_params: ChatParams): Promise<ChatResponse> {
        throw new Error("Network timeout");
      },
    };

    await expect(
      getGroundingVerdict({
        llm: errorClient,
        model: "test-model",
        question: "q",
        answerBody: "a",
        passages: SAMPLE_PASSAGES,
      }),
    ).rejects.toThrow("Network timeout");
  });
});
