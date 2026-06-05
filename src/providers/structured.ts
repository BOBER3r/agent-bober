/**
 * Schema-constrained ("structured") output utilities.
 *
 * Provides a provider-agnostic single-shot structured call that makes JSON
 * output reliable even on small local models (DeepSeek / Ollama / LM Studio),
 * where the server may not honor a strict schema. It:
 *
 *   1. requests native structured output (`ChatParams.responseSchema`) AND
 *      injects the schema into the system prompt — belt-and-suspenders for
 *      models that ignore the native knob;
 *   2. coerces the model's raw text into JSON, tolerating the failure modes
 *      7B-class models exhibit (markdown fences, surrounding prose);
 *   3. validates the parsed value against a caller-supplied validator
 *      (typically backed by a Zod schema); and
 *   4. on failure, performs up to `maxRepairs` repair round-trips, feeding the
 *      validation error back to the model.
 *
 * See structured.test.ts for the recovery-rate fixture suite that pins the
 * single-shot + one-repair reliability target.
 */

import type { LLMClient, JsonSchemaObject, Message } from "./types.js";

// ── Errors ──────────────────────────────────────────────────────────

/** Raised by {@link coerceJson} when no JSON value can be extracted from text. */
export class JsonCoercionError extends Error {
  constructor(
    message: string,
    /** The raw model text that could not be coerced. */
    readonly raw: string,
  ) {
    super(message);
    this.name = "JsonCoercionError";
  }
}

/** Raised by {@link runStructuredAgent} when every attempt fails validation. */
export class StructuredOutputError extends Error {
  constructor(
    message: string,
    /** The last raw model text seen. */
    readonly raw: string,
    /** Total chat calls made before giving up. */
    readonly attempts: number,
  ) {
    super(message);
    this.name = "StructuredOutputError";
  }
}

// ── Validator ───────────────────────────────────────────────────────

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/** Validates and narrows a coerced JSON value to `T`. */
export type Validator<T> = (raw: unknown) => ValidationResult<T>;

/**
 * Structural shape of a Zod schema's `safeParse`. Declared here (instead of
 * importing `zod`) so this module stays dependency-pure and accepts any
 * validator exposing the same surface.
 */
export interface SafeParseable<T> {
  safeParse(data: unknown):
    | { success: true; data: T }
    | {
        success: false;
        error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> };
      };
}

/**
 * Build a {@link Validator} from a Zod schema (or anything exposing
 * `safeParse`). Flattens issues into one human-readable string the model can
 * act on during a repair round-trip.
 */
export function zodValidator<T>(schema: SafeParseable<T>): Validator<T> {
  return (raw: unknown): ValidationResult<T> => {
    const parsed = schema.safeParse(raw);
    if (parsed.success) {
      return { ok: true, value: parsed.data };
    }
    const error = parsed.error.issues
      .map((i) => `${i.path.map((p) => p.toString()).join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, error: error || "validation failed" };
  };
}

// ── JSON coercion ───────────────────────────────────────────────────

/**
 * Extract a JSON value from a model's raw text response.
 *
 * Handles the common local-model failure modes, in order:
 *   1. direct `JSON.parse` (well-behaved providers / strict json mode);
 *   2. strip a leading/trailing markdown code fence, then parse;
 *   3. extract the substring spanning the first `{`/`[` to the matching last
 *      `}`/`]` (drops surrounding prose), then parse.
 *
 * @throws {JsonCoercionError} if nothing parses.
 */
export function coerceJson(text: string): unknown {
  const trimmed = text.trim();

  const direct = tryParse(trimmed);
  if (direct.ok) return direct.value;

  const defenced = stripFences(trimmed);
  const fenced = tryParse(defenced);
  if (fenced.ok) return fenced.value;

  const span = extractJsonSpan(defenced);
  if (span !== null) {
    const spanned = tryParse(span);
    if (spanned.ok) return spanned.value;
  }

  throw new JsonCoercionError(
    `Could not extract JSON from model output (${String(text.length)} chars).`,
    text,
  );
}

function tryParse(s: string): { ok: true; value: unknown } | { ok: false } {
  if (s.length === 0) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(s) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Strip a single leading ```lang fence and matching trailing ``` fence. */
function stripFences(s: string): string {
  const fenceMatch = /^```[a-zA-Z0-9]*\s*\n?([\s\S]*?)\n?```$/.exec(s);
  if (fenceMatch && fenceMatch[1] !== undefined) {
    return fenceMatch[1].trim();
  }
  return s;
}

/**
 * Return the substring from the first JSON open-bracket to the last matching
 * close-bracket (object or array, whichever appears first), or null if none.
 */
function extractJsonSpan(s: string): string | null {
  const firstObj = s.indexOf("{");
  const firstArr = s.indexOf("[");
  if (firstObj === -1 && firstArr === -1) return null;

  const useArray =
    firstObj === -1 || (firstArr !== -1 && firstArr < firstObj);
  const start = useArray ? firstArr : firstObj;
  const close = useArray ? "]" : "}";

  const lastClose = s.lastIndexOf(close);
  if (lastClose <= start) return null;
  return s.slice(start, lastClose + 1);
}

// ── Structured agent ────────────────────────────────────────────────

export interface RunStructuredAgentOptions<T> {
  /** Provider-agnostic LLM client (any adapter from the provider factory). */
  client: LLMClient;
  /** Model ID (resolved via the factory / model-resolver). */
  model: string;
  /** Base system prompt. The schema instruction is appended automatically. */
  system: string;
  /** The task / user message. */
  prompt: string;
  /** Provider-facing JSON Schema (also injected into the system prompt). */
  schema: JsonSchemaObject;
  /** Validates + narrows the coerced JSON. Typically `zodValidator(SomeSchema)`. */
  validate: Validator<T>;
  /** Max repair round-trips after the first attempt. Default 1. */
  maxRepairs?: number;
  /** Per-call max tokens. */
  maxTokens?: number;
}

export interface StructuredAgentResult<T> {
  /** The validated, typed value. */
  value: T;
  /** Total chat calls made (1 = first-try success). */
  attempts: number;
  /** True if any repair round-trip was needed. */
  repaired: boolean;
  /** Cumulative token usage across all attempts. */
  usage: { inputTokens: number; outputTokens: number };
}

const SCHEMA_INSTRUCTION_HEADER =
  "You MUST respond with a single JSON value that conforms to the JSON Schema " +
  "below. Respond with ONLY the JSON — no prose, no explanation, no markdown " +
  "code fences.";

/**
 * Run a single-shot structured-output call with coercion, validation, and
 * bounded repair. Returns a validated, typed value.
 *
 * The returned `ChatResponse.text` is parsed via {@link coerceJson} and checked
 * with `validate`. If either fails and repairs remain, the bad output and the
 * error are fed back as a follow-up turn.
 *
 * @throws {StructuredOutputError} if no attempt produces a schema-valid value.
 */
export async function runStructuredAgent<T>(
  opts: RunStructuredAgentOptions<T>,
): Promise<StructuredAgentResult<T>> {
  const { client, model, schema, validate, prompt } = opts;
  const maxRepairs = opts.maxRepairs ?? 1;
  const maxAttempts = maxRepairs + 1;
  const system = buildStructuredSystem(opts.system, schema);

  const messages: Message[] = [{ role: "user", content: prompt }];

  let inputTokens = 0;
  let outputTokens = 0;
  let lastError = "";
  let lastRaw = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await client.chat({
      model,
      system,
      messages,
      responseSchema: schema,
      ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
    });
    inputTokens += response.usage.inputTokens;
    outputTokens += response.usage.outputTokens;
    lastRaw = response.text;

    lastError = "";
    let parsed: unknown;
    try {
      parsed = coerceJson(response.text);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }

    if (lastError === "") {
      const result = validate(parsed);
      if (result.ok) {
        return {
          value: result.value,
          attempts: attempt,
          repaired: attempt > 1,
          usage: { inputTokens, outputTokens },
        };
      }
      lastError = result.error;
    }

    if (attempt < maxAttempts) {
      pushRepair(messages, response.text, lastError);
    }
  }

  throw new StructuredOutputError(
    `Structured output failed after ${String(maxAttempts)} attempt(s): ${lastError}`,
    lastRaw,
    maxAttempts,
  );
}

/** Append the schema instruction + serialized schema to the base system prompt. */
function buildStructuredSystem(system: string, schema: JsonSchemaObject): string {
  const base = system.trim();
  const block = `${SCHEMA_INSTRUCTION_HEADER}\n\nJSON Schema:\n${JSON.stringify(schema)}`;
  return base.length > 0 ? `${base}\n\n${block}` : block;
}

/** Append the failed output + a corrective instruction as a new turn. */
function pushRepair(messages: Message[], rawText: string, error: string): void {
  messages.push({ role: "assistant", content: rawText });
  messages.push({
    role: "user",
    content:
      `Your previous response could not be used: ${error}. ` +
      "Return ONLY a corrected JSON value that conforms to the schema. " +
      "No prose, no markdown fences.",
  });
}
