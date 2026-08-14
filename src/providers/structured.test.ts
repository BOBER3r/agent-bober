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
  normaliseBlockScalars,
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

// ── Multiline-TypeScript corpus (sprint 12, sc-12-11) ────────────────

/**
 * The failure mode ADR-7 names: a model asked for JSON whose payload is SOURCE CODE emits
 * the source literally — real newlines and unescaped inner double quotes inside the JSON
 * string — because escaping a file into one line is the thing models are worst at.
 *
 * Every snippet below carries at least one embedded `"` and at least one newline. They are
 * deliberately ordinary TypeScript rather than pathological input: the claim under test is
 * that the tolerant inbound path recovers what a model actually emits.
 */
const MULTILINE_TS_SNIPPETS: readonly string[] = [
  'export function greet(name: string): string {\n  return "hello, " + name;\n}',
  'const label = "sprint";\nexport const id = `${label}-12`;',
  'if (kind === "gate") {\n  throw new Error("gate refused the payload");\n}',
  'export const KEYS = ["alpha", "beta", "gamma"];\n// note the "quoted" comment',
  'await run("npm", ["run", "typecheck"], { cwd: root });\nreturn 0;',
  'type Mode = "light" | "frontier";\nexport const DEFAULT: Mode = "light";',
  'logger.warn(`could not read "${path}"`);\nprocess.exitCode = 1;',
  'const m = { kind: "error", detail: "unterminated string" };\nexport default m;',
  'export class Gate {\n  readonly check = "typecheck-and-lint";\n}',
  'it("routes to the corrector", async () => {\n  expect(goto.node).toBe("sprint_correct");\n});',
];

/**
 * Serialize `value` the way a model that has not escaped its source does.
 *
 * Every other field goes through `JSON.stringify`; `feedback` is written RAW, so the
 * result carries literal newlines and bare `"` inside a JSON string. `feedback` is placed
 * in the middle of the object on purpose — the closing quote is then followed by `,
 * "timestamp"`, which is the comma-then-key case the normaliser's terminator rule turns
 * on, and the trailing `}` case is exercised by the snippets that end in a brace.
 */
function sloppyStringify(value: EvalResult, raw: string): string {
  const head = [
    `  "evaluator": ${JSON.stringify(value.evaluator)}`,
    `  "passed": ${String(value.passed)}`,
    ...(value.score === undefined ? [] : [`  "score": ${String(value.score)}`]),
    `  "details": ${JSON.stringify(value.details)}`,
    `  "summary": ${JSON.stringify(value.summary)}`,
  ];
  const tail = [`  "timestamp": ${JSON.stringify(value.timestamp)}`];
  return `{\n${[...head, `  "feedback": "${raw}"`, ...tail].join(",\n")}\n}`;
}

/** The 20 sloppy fixtures: each snippet, compact and pretty-wrapped. */
function multilineTsCorpus(): string[] {
  const corpus: string[] = [];
  MULTILINE_TS_SNIPPETS.forEach((snippet, index) => {
    const base = validEvalResult({
      evaluator: index % 2 === 0 ? "correctness" : "regression",
      passed: index % 3 !== 0,
      summary: `snippet ${String(index)}`,
    });
    corpus.push(sloppyStringify(base, snippet));
    corpus.push(`\`\`\`json\n${sloppyStringify(base, snippet)}\n\`\`\``);
  });
  return corpus;
}

// ── String-array regression corpus (sc-12-11) ────────────────────────

/**
 * The case the twenty fixtures above CANNOT see, and the one the live consumer has.
 *
 * `validEvalResult` carries no field of type `string[]`, so nothing in the corpus above
 * exercises a JSON ARRAY OF STRINGS — and an array of strings is the one shape a quote
 * heuristic can silently destroy. `src/pge/nodes/sprint-evaluate.ts` parses exactly
 * `{ success, notes, filesChanged: string[] }` off the generator and feeds `filesChanged`
 * to selective verification, so a `filesChanged` collapsed from three elements into one
 * matches no high-risk path pattern and skips the expensive suite for a `src/**` change.
 *
 * The corruption is invisible to the Validator seam: `["src/a.ts\", \"src/b.ts"]` still
 * satisfies `z.array(z.string())`. That is why these fixtures assert the VALUE
 * element-for-element rather than asserting that something schema-valid came back.
 */
interface SloppyGeneratorResult {
  readonly notes: string;
  readonly filesChanged: readonly string[];
}

const GENERATOR_RESULT_FIXTURES: readonly SloppyGeneratorResult[] = [
  { notes: "did a\nthing", filesChanged: ["src/x.ts", "src/y.ts", "src/z.ts"] },
  { notes: "touched docs only\nno source", filesChanged: ["docs/a.md"] },
  { notes: "line one\nline two\nline three", filesChanged: ["src/a.ts", "src/b.ts"] },
  { notes: "ran\tnpm run typecheck", filesChanged: ["src/pge/nodes/gates.ts", "src/pge/nodes/gates.test.ts"] },
  { notes: "wrapped a gate\nand pinned it", filesChanged: [] },
];

/**
 * Serialize a generator result the way a model that has not escaped `notes` does.
 *
 * `filesChanged` goes through `JSON.stringify` — short paths are the one thing models DO
 * escape correctly — while `notes` is written RAW, so the only defect in the document is a
 * literal control character. That is the exact input on which a quote-escaping repair must
 * not be preferred.
 */
function sloppyGeneratorResult(value: SloppyGeneratorResult): string {
  return [
    "{",
    `  "success": true,`,
    `  "notes": "${value.notes}",`,
    `  "filesChanged": ${JSON.stringify(value.filesChanged)}`,
    "}",
  ].join("\n");
}

/**
 * Each fixture bare, fenced and prose-wrapped — the three shapes a model ships it in.
 *
 * Every item carries its OWN expected value rather than being recovered by index
 * arithmetic, so adding a wrapper cannot quietly re-pair a fixture with the wrong answer.
 */
function generatorResultCorpus(): Array<{ raw: string; expected: SloppyGeneratorResult }> {
  const corpus: Array<{ raw: string; expected: SloppyGeneratorResult }> = [];
  for (const expected of GENERATOR_RESULT_FIXTURES) {
    const raw = sloppyGeneratorResult(expected);
    corpus.push({ raw, expected });
    corpus.push({ raw: `\`\`\`json\n${raw}\n\`\`\``, expected });
    corpus.push({ raw: `Sure, here you go:\n${raw}\nLet me know.`, expected });
  }
  return corpus;
}

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
    // sc-12-11 — the multiline-TypeScript fixtures join the SAME corpus and are held to
    // the SAME pinned rate. Appended, never substituted: the eighty formatting-noise items
    // above still have to recover, and the threshold is measured over the larger set.
    corpus.push(...multilineTsCorpus());

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

// ── sc-12-11: the tolerant inbound path, and what it must NOT do ─────

/**
 * The block-scalar normaliser (ADR-7), and the three claims that make it safe.
 *
 * What these tests exist to catch:
 *
 *  - a normaliser wired BEFORE `JSON.parse`, which would rewrite text that already parses
 *    and change the value every existing caller of `coerceJson` receives. The control run
 *    below is the evidence for the ordering: the same fixtures go through `JSON.parse`
 *    directly — the strict, escape-sensitive path sc-12-11 names — and every one of them
 *    fails, which is exactly why the tolerant step is reachable at all;
 *  - a normaliser that INVENTS structure from prose, turning "I could not do that" into a
 *    confident empty object. Prose in, `JsonCoercionError` out, unchanged;
 *  - a normaliser that changes an existing recovery. Every input the three strict steps
 *    already handle is re-asserted to produce the identical value.
 *
 * Deliberate mutations this suite was run against and failed on. Each line records the
 * failing test by name, because a mutation that fails NOTHING is a claim without evidence:
 *  1. moving the normaliser call above the `JSON.parse` step  -> "leaves every already-parsing
 *     input untouched" fails on `["run", "typecheck"]`, which the normaliser rewrites into
 *     the single element `run", "typecheck`. The escaped-newline input in that test is a
 *     no-op for the normaliser and does NOT catch the reorder — the string-array inputs are
 *     the ones that do, and they are there for exactly that reason;
 *  2. dropping the key-position rule from `closesString`      -> the `{"kind": "error"}` snippet
 *     stops recovering and the pinned rate falls below 0.95;
 *  3. dropping the closer-chain rule                          -> the `};`-terminated snippets stop
 *     recovering;
 *  4. returning the aggressive candidate only                 -> the "escaped quotes, raw newline"
 *     case stops recovering;
 *  5. returning the input unchanged as a candidate            -> "prose stays a coercion error"
 *     still passes, so the guard below asserts the THROW rather than the candidate list;
 *  6. ordering the AGGRESSIVE candidate first                 -> "round-trips a string array
 *     element-for-element" fails: `filesChanged` collapses from three elements into one.
 */
describe("block-scalar normaliser (tolerant inbound path)", () => {
  it("control: every multiline-TypeScript fixture fails the strict escape-sensitive path", () => {
    const corpus = [...multilineTsCorpus(), ...generatorResultCorpus().map((c) => c.raw)];
    expect(corpus.length).toBeGreaterThanOrEqual(20);

    let strictFailures = 0;
    for (const raw of corpus) {
      try {
        JSON.parse(raw);
      } catch {
        strictFailures += 1;
      }
    }
    // The failure mode the offloading discipline removes structurally: a file's source
    // inside a JSON string is not JSON, and no amount of prompting makes it so.
    expect(strictFailures).toBe(corpus.length);
  });

  it("recovers every multiline-TypeScript fixture through coerceJson", () => {
    const validate = zodValidator(EvalResultSchema);
    const corpus = multilineTsCorpus();

    const failures: string[] = [];
    for (const raw of corpus) {
      try {
        if (!validate(coerceJson(raw)).ok) failures.push(raw);
      } catch {
        failures.push(raw);
      }
    }
    expect(failures).toEqual([]);
  });

  it("preserves the source verbatim, embedded quotes and all", () => {
    const snippet = 'export function greet(name: string): string {\n  return "hello, " + name;\n}';
    const recovered = coerceJson(sloppyStringify(validEvalResult(), snippet)) as EvalResult;
    // Not "it parsed" — the exact bytes the model meant to send are what came back.
    expect(recovered.feedback).toBe(snippet);
  });

  it("leaves every already-parsing input untouched", () => {
    // The ordering claim, stated as values rather than as a call count: these all resolve
    // in steps 1-3, so the normaliser never sees them and cannot change them.
    const escaped = JSON.stringify({ code: 'const a = "x";\nreturn a;' });
    expect(coerceJson(escaped)).toEqual({ code: 'const a = "x";\nreturn a;' });
    expect(coerceJson('{"a":1,"b":"x"}')).toEqual({ a: 1, b: "x" });
    expect(coerceJson('```json\n{"ok": true}\n```')).toEqual({ ok: true });
    expect(coerceJson('Here you go:\n{"ok": false}\nDone.')).toEqual({ ok: false });

    // The four above are all NO-OPS for the normaliser, so on their own they cannot detect
    // a normaliser wired ahead of `JSON.parse` — the mutation would return the identical
    // value and the test would still pass. These two are inputs the normaliser DOES
    // rewrite (its aggressive candidate escapes the element quotes, because a `"` inside
    // an array is not followed by the `:` a next key would carry), so they parse correctly
    // today at step 1 and fail the instant the tolerant step is moved in front of it.
    expect(coerceJson('["run", "typecheck"]')).toEqual(["run", "typecheck"]);
    expect(coerceJson('{"args": ["a", "b"], "cwd": "."}')).toEqual({
      args: ["a", "b"],
      cwd: ".",
    });
  });

  it("round-trips a string array element-for-element beside a raw-newline field", () => {
    // sc-12-11's live consumer shape. The quote heuristic is ambiguous here and the
    // AGGRESSIVE reading is the wrong one: it escapes each element's quotes and merges the
    // array into a single string. `z.array(z.string())` still accepts that, so no
    // validator downstream can catch it and the assertion has to be on the value.
    const corpus = generatorResultCorpus();
    expect(corpus.length).toBeGreaterThanOrEqual(15);

    for (const { raw, expected } of corpus) {
      const value = coerceJson(raw) as { success: boolean; notes: string; filesChanged: string[] };
      expect(value.success).toBe(true);
      expect(value.notes).toBe(expected.notes);
      // Element-for-element, not "is an array of strings": the corruption is schema-valid.
      expect(value.filesChanged).toEqual([...expected.filesChanged]);
      expect(value.filesChanged).toHaveLength(expected.filesChanged.length);
    }
  });

  it("prefers the conservative candidate, which can never merge array elements", () => {
    // The ordering inside `normaliseBlockScalars`, pinned at the unit it lives in. Both
    // candidates are emitted; only the first one is ever consumed by `coerceJson`.
    const candidates = normaliseBlockScalars(
      '{"notes": "did a\nthing", "filesChanged": ["src/x.ts", "src/y.ts", "src/z.ts"]}',
    );
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(candidates[0]) as { filesChanged: string[] }).toEqual({
      notes: "did a\nthing",
      filesChanged: ["src/x.ts", "src/y.ts", "src/z.ts"],
    });
    // The aggressive candidate is still emitted as the fallback, and it is still the wrong
    // reading of THIS input — which is the whole reason it must not come first.
    expect((JSON.parse(candidates[1]) as { filesChanged: string[] }).filesChanged).toHaveLength(1);
  });

  it("still refuses prose, and invents no JSON from it", () => {
    expect(() => coerceJson("I could not complete that request.")).toThrow(JsonCoercionError);
    expect(() => coerceJson("")).toThrow(JsonCoercionError);
    expect(() => coerceJson("no braces here at all")).toThrow(JsonCoercionError);
  });

  it("folds a YAML block scalar back into a JSON string", () => {
    const raw = ['{', '  "path": "src/a.ts",', '  "content": |', '    export const a = "x";', '    ', '  "ok": true', '}'].join("\n");
    const value = coerceJson(raw) as { path: string; content: string; ok: boolean };
    expect(value.path).toBe("src/a.ts");
    expect(value.content.trim()).toBe('export const a = "x";');
  });

  it("emits candidates only when it has something to repair", () => {
    // A conservative repair for output whose quotes are already escaped and whose only
    // defect is a literal newline, and an aggressive one for output where neither is.
    const candidates = normaliseBlockScalars('{"a": "line one\nline two"}');
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(candidates[0]) as { a: string }).toEqual({ a: "line one\nline two" });
  });
});
