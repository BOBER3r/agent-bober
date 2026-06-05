/**
 * Unit + reliability tests for the schema-constrained output layer.
 *
 * Covers:
 * - coerceJson: tolerant extraction (fences, surrounding prose, arrays, garbage)
 * - zodValidator: pass-through + flattened error string
 * - runStructuredAgent: first-try success, one-repair recovery, exhaustion,
 *   usage accumulation, native responseSchema + system-prompt injection
 * - Reliability fixture: recovery rate over the messy outputs a 7B-class local
 *   model emits, validated against the REAL EvalResultSchema. This is a
 *   hermetic proxy for the Sprint-1 exit criterion ("schema-valid >= 95% over a
 *   fixture suite") — it pins the coerce + validate + one-repair pipeline, not a
 *   live model (which cannot be hermetic).
 */

import { describe, it, expect } from "vitest";

import type { LLMClient, ChatParams, ChatResponse, JsonSchemaObject } from "./types.js";
import {
  coerceJson,
  zodValidator,
  runStructuredAgent,
  JsonCoercionError,
  StructuredOutputError,
} from "./structured.js";
import { EvalResultSchema, type EvalResult } from "../contracts/eval-result.js";

// ── Scripted fake client ─────────────────────────────────────────────

/**
 * Returns the scripted responses in order; repeats the last one once exhausted.
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

// ── A faithful EvalResult JSON Schema (mirrors EvalResultSchema's core) ──

const EVAL_RESULT_JSON_SCHEMA: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["evaluator", "passed", "details", "summary", "feedback", "timestamp"],
  properties: {
    evaluator: { type: "string" },
    passed: { type: "boolean" },
    score: { type: "number" },
    summary: { type: "string" },
    feedback: { type: "string" },
    timestamp: { type: "string", description: "ISO 8601 datetime" },
    details: {
      type: "array",
      items: {
        type: "object",
        required: ["criterion", "passed", "message", "severity"],
        properties: {
          criterion: { type: "string" },
          passed: { type: "boolean" },
          message: { type: "string" },
          severity: { type: "string", enum: ["error", "warning", "info"] },
        },
      },
    },
  },
};

/** A valid EvalResult object (satisfies the real EvalResultSchema). */
function validEvalResult(overrides: Partial<EvalResult> = {}): EvalResult {
  return {
    evaluator: "correctness",
    passed: true,
    score: 92,
    details: [
      {
        criterion: "sc-1-1",
        passed: true,
        message: "All endpoints respond",
        severity: "info",
      },
    ],
    summary: "All criteria met.",
    feedback: "No changes needed.",
    timestamp: "2026-06-04T12:00:00.000Z",
    ...overrides,
  };
}

// ── coerceJson ───────────────────────────────────────────────────────

describe("coerceJson", () => {
  it("parses a plain JSON object", () => {
    expect(coerceJson('{"a":1,"b":"x"}')).toEqual({ a: 1, b: "x" });
  });

  it("parses a plain JSON array", () => {
    expect(coerceJson("[1, 2, 3]")).toEqual([1, 2, 3]);
  });

  it("strips a ```json fenced block", () => {
    const raw = "```json\n{\"ok\": true}\n```";
    expect(coerceJson(raw)).toEqual({ ok: true });
  });

  it("strips a bare ``` fenced block", () => {
    const raw = "```\n{\"ok\": false}\n```";
    expect(coerceJson(raw)).toEqual({ ok: false });
  });

  it("extracts JSON wrapped in leading + trailing prose", () => {
    const raw = 'Here is the result:\n\n{"score": 7}\n\nHope this helps!';
    expect(coerceJson(raw)).toEqual({ score: 7 });
  });

  it("extracts JSON from a fenced block with surrounding chatter", () => {
    const raw = 'Sure!\n\n```json\n{"n": 42}\n```\n\nDone.';
    expect(coerceJson(raw)).toEqual({ n: 42 });
  });

  it("tolerates leading and trailing whitespace", () => {
    expect(coerceJson('  \n {"a": 1}  \n ')).toEqual({ a: 1 });
  });

  it("throws JsonCoercionError on empty input", () => {
    expect(() => coerceJson("   ")).toThrow(JsonCoercionError);
  });

  it("throws JsonCoercionError when no JSON is present", () => {
    expect(() => coerceJson("I cannot help with that.")).toThrow(JsonCoercionError);
  });
});

// ── zodValidator ─────────────────────────────────────────────────────

describe("zodValidator", () => {
  it("returns ok with the parsed value on success", () => {
    const validate = zodValidator(EvalResultSchema);
    const result = validate(validEvalResult());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.evaluator).toBe("correctness");
    }
  });

  it("returns a flattened error string on failure", () => {
    const validate = zodValidator(EvalResultSchema);
    // Missing required `feedback` and `timestamp`.
    const result = validate({ evaluator: "x", passed: true, details: [], summary: "s" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("feedback");
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it("reports the failing path for a bad nested enum", () => {
    const validate = zodValidator(EvalResultSchema);
    const bad = validEvalResult();
    const result = validate({
      ...bad,
      details: [{ criterion: "c", passed: true, message: "m", severity: "high" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("details");
    }
  });
});

// ── runStructuredAgent ───────────────────────────────────────────────

describe("runStructuredAgent", () => {
  it("returns a validated value on the first try", async () => {
    const client = new ScriptedClient([JSON.stringify(validEvalResult())]);
    const result = await runStructuredAgent({
      client,
      model: "ollama/llama3",
      system: "You are an evaluator.",
      prompt: "Evaluate sprint 1.",
      schema: EVAL_RESULT_JSON_SCHEMA,
      validate: zodValidator(EvalResultSchema),
    });

    expect(result.attempts).toBe(1);
    expect(result.repaired).toBe(false);
    expect(result.value.evaluator).toBe("correctness");
    expect(client.calls).toHaveLength(1);
  });

  it("forwards responseSchema and injects the schema into the system prompt", async () => {
    const client = new ScriptedClient([JSON.stringify(validEvalResult())]);
    await runStructuredAgent({
      client,
      model: "ollama/llama3",
      system: "Base system.",
      prompt: "Go.",
      schema: EVAL_RESULT_JSON_SCHEMA,
      validate: zodValidator(EvalResultSchema),
    });

    const call = client.calls[0];
    expect(call).toBeDefined();
    expect(call?.responseSchema).toEqual(EVAL_RESULT_JSON_SCHEMA);
    expect(call?.system).toContain("Base system.");
    expect(call?.system).toContain("JSON Schema:");
    expect(call?.system).toContain("ONLY the JSON");
    // The user prompt is the first message.
    expect(call?.messages[0]).toEqual({ role: "user", content: "Go." });
  });

  it("recovers via a single repair round-trip", async () => {
    const client = new ScriptedClient([
      "I think it passed but I'm not sure.", // unrecoverable → triggers repair
      JSON.stringify(validEvalResult()), // repaired
    ]);
    const result = await runStructuredAgent({
      client,
      model: "ollama/llama3",
      system: "sys",
      prompt: "Evaluate.",
      schema: EVAL_RESULT_JSON_SCHEMA,
      validate: zodValidator(EvalResultSchema),
    });

    expect(result.attempts).toBe(2);
    expect(result.repaired).toBe(true);
    expect(client.calls).toHaveLength(2);

    // The second call carries the failed output + a corrective instruction.
    const repairMessages = client.calls[1]?.messages ?? [];
    expect(repairMessages).toHaveLength(3);
    expect(repairMessages[1]?.role).toBe("assistant");
    const corrective = repairMessages[2];
    expect(corrective?.role).toBe("user");
    expect("content" in (corrective ?? {}) ? (corrective as { content: string }).content : "").toContain(
      "corrected JSON",
    );
  });

  it("accumulates usage across attempts", async () => {
    const client = new ScriptedClient([
      "garbage",
      JSON.stringify(validEvalResult()),
    ]);
    const result = await runStructuredAgent({
      client,
      model: "m",
      system: "sys",
      prompt: "Evaluate.",
      schema: EVAL_RESULT_JSON_SCHEMA,
      validate: zodValidator(EvalResultSchema),
    });
    // Two calls × { in: 3, out: 5 }
    expect(result.usage).toEqual({ inputTokens: 6, outputTokens: 10 });
  });

  it("throws StructuredOutputError after exhausting repairs", async () => {
    const client = new ScriptedClient(["nope", "still nope", "nope again"]);
    await expect(
      runStructuredAgent({
        client,
        model: "m",
        system: "sys",
        prompt: "Evaluate.",
        schema: EVAL_RESULT_JSON_SCHEMA,
        validate: zodValidator(EvalResultSchema),
        maxRepairs: 2,
      }),
    ).rejects.toThrow(StructuredOutputError);
  });

  it("respects maxRepairs = 0 (single attempt, no repair)", async () => {
    const client = new ScriptedClient(["not json"]);
    await expect(
      runStructuredAgent({
        client,
        model: "m",
        system: "sys",
        prompt: "Evaluate.",
        schema: EVAL_RESULT_JSON_SCHEMA,
        validate: zodValidator(EvalResultSchema),
        maxRepairs: 0,
      }),
    ).rejects.toThrow(StructuredOutputError);
    expect(client.calls).toHaveLength(1);
  });
});

// ── Reliability fixture (Sprint-1 exit criterion proxy) ──────────────

/**
 * The formatting noise a 7B-class local model wraps around otherwise-valid
 * JSON. Each wrapper preserves recoverable content; coerceJson must extract it.
 */
const MESSY_WRAPPERS: ReadonlyArray<(json: string) => string> = [
  (j) => j,
  (j) => `\`\`\`json\n${j}\n\`\`\``,
  (j) => `\`\`\`\n${j}\n\`\`\``,
  (j) => `Here is the evaluation:\n\n${j}`,
  (j) => `${j}\n\nLet me know if you'd like changes.`,
  (j) => `Sure thing!\n\n\`\`\`json\n${j}\n\`\`\`\n\nDone.`,
  (j) => `\n\n  ${j}  \n\n`,
  (j) => `Result below.\n${j}\nThanks!`,
  (j) => `\`\`\`JSON\n${j}\n\`\`\``,
  (j) => `Okay. ${j}`,
];

describe("structured-output reliability fixture", () => {
  it("recovers schema-valid EvalResult from messy single-shot output >= 95%", () => {
    const validate = zodValidator(EvalResultSchema);

    // A spread of valid EvalResult shapes (vary fields a real evaluator emits).
    const baseObjects: EvalResult[] = [
      validEvalResult(),
      validEvalResult({ passed: false, score: 40, evaluator: "security" }),
      validEvalResult({
        evaluator: "regression",
        details: [
          { criterion: "sc-2-1", passed: false, message: "Broke /login", severity: "error" },
          { criterion: "sc-2-2", passed: true, message: "ok", severity: "info" },
        ],
      }),
      validEvalResult({ score: undefined }),
    ];

    const corpus: string[] = [];
    for (const obj of baseObjects) {
      const pretty = JSON.stringify(obj, null, 2);
      const compact = JSON.stringify(obj);
      for (const wrap of MESSY_WRAPPERS) {
        corpus.push(wrap(compact));
        corpus.push(wrap(pretty));
      }
    }

    let recovered = 0;
    for (const raw of corpus) {
      try {
        const parsed = coerceJson(raw);
        if (validate(parsed).ok) recovered += 1;
      } catch {
        // counts as not recovered
      }
    }

    const rate = recovered / corpus.length;
    // Sanity: corpus is non-trivial.
    expect(corpus.length).toBeGreaterThanOrEqual(60);
    expect(rate).toBeGreaterThanOrEqual(0.95);
  });

  it("lifts first-try-invalid cases to 100% with one repair", async () => {
    const validate = zodValidator(EvalResultSchema);

    // Cases a model gets wrong on content (not just formatting) the first time.
    const firstTryInvalid: string[] = [
      "Honestly I'm not certain — let me think.", // no JSON at all
      JSON.stringify({ evaluator: "x", passed: true }), // missing required fields
      JSON.stringify(validEvalResult({})).replace('"feedback"', '"notes"'), // wrong key
      JSON.stringify({ ...validEvalResult(), severity: "critical" }).slice(0, 60), // truncated
      JSON.stringify({ ...validEvalResult(), details: "oops" }), // wrong type
    ];

    let recovered = 0;
    for (const badFirst of firstTryInvalid) {
      const client = new ScriptedClient([badFirst, JSON.stringify(validEvalResult())]);
      try {
        const result = await runStructuredAgent({
          client,
          model: "ollama/llama3",
          system: "sys",
          prompt: "Evaluate.",
          schema: EVAL_RESULT_JSON_SCHEMA,
          validate,
          maxRepairs: 1,
        });
        if (result.repaired) recovered += 1;
      } catch {
        // not recovered
      }
    }

    expect(recovered).toBe(firstTryInvalid.length);
  });
});
