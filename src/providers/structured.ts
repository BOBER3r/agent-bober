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
 *      `}`/`]` (drops surrounding prose), then parse;
 *   4. last resort: {@link normaliseBlockScalars} repairs raw control characters and
 *      unescaped quotes inside string values, then parse each candidate in turn.
 *
 * Step 4 is unreachable for any text steps 1-3 accept, so adding it cannot change what an
 * existing caller sees — it only narrows the set of inputs that throw.
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

  // 4. LAST RESORT, and last on purpose (ADR-7). Every step above has already refused
  //    this text, so nothing that parses today reaches this line and no existing caller
  //    can observe a different value. See {@link normaliseBlockScalars}.
  for (const candidate of normaliseBlockScalars(span ?? defenced)) {
    const normalised = tryParse(candidate);
    if (normalised.ok) return normalised.value;
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

// ── Block-scalar normaliser (tolerant inbound path, ADR-7) ──────────

/**
 * The failure mode this exists for.
 *
 * A model asked for `{ "path": …, "content": … }` where `content` is a file's source
 * routinely emits the source LITERALLY — raw newlines and unescaped inner double quotes
 * inside a JSON string — or reaches for YAML's block-scalar syntax (`"content": |`) to
 * avoid escaping at all. Both are invalid JSON and both are recoverable without a parser
 * dependency, which is what ADR-7 chose over mandating YAML on the wire.
 *
 * ── Why this is a TOLERANT INBOUND PATH and nothing more ──
 *
 * It runs as the FOURTH step of {@link coerceJson}, after `JSON.parse`, after the fence
 * strip and after the span extraction have each already refused the text. So:
 *
 *  - no input that parses today reaches it, which is why no existing value can change;
 *  - an input that fails today either becomes a parsed value (a recovery) or still throws
 *    {@link JsonCoercionError} with the same message and the same `raw`;
 *  - {@link runStructuredAgent} treats a throw and a validation failure identically, so a
 *    recovery can only turn a failed attempt into a successful one.
 *
 * The structural fix is still the one ADR-7 names — generated source travels by scratch
 * reference and never inside a JSON string — and this is the residue absorber for output
 * that arrives before that discipline can be applied.
 *
 * ── Why it returns CANDIDATES, and why the CONSERVATIVE one comes first ──
 *
 * Deciding whether a `"` inside an unterminated string closes it or belongs to the source
 * is a heuristic, and a heuristic that is wrong once ruins the whole document. Two repairs
 * are emitted instead: the conservative one (escape control characters only) and the
 * aggressive one (escape control characters AND embedded quotes). The caller tries them in
 * order and takes the first that parses.
 *
 * The order is load-bearing and it is conservative-first, because the two failures are not
 * symmetric. The aggressive repair can produce a document that parses but is WRONG: a JSON
 * array of strings — `"filesChanged": ["src/a.ts", "src/b.ts"]` — reaches `closesString`
 * with no `:` ahead of `"src/b.ts"`, so the quotes around each element get escaped and the
 * array silently collapses into one long element. That value still satisfies
 * `z.array(z.string())`, so no validator downstream can catch it. The conservative repair
 * cannot make that mistake: it never touches a quote, so it can never merge two array
 * elements, and it only parses at all when the document's own quoting was already correct
 * — which is precisely the case in which nothing should be guessed. Being wrong about
 * quotes must therefore cost one `JSON.parse`, not a corrupted value, and only ordering the
 * conservative candidate first buys that.
 *
 * The aggressive repair stays as the FALLBACK, for output whose inner quotes are genuinely
 * unescaped (a TypeScript snippet inside a string field); such output does not parse under
 * the conservative repair, so the fallback is reached exactly when it is needed.
 */
export function normaliseBlockScalars(text: string): string[] {
  const inlined = inlineBlockScalars(text);
  const candidates = [repairStrings(inlined, false), repairStrings(inlined, true)];
  if (inlined !== text) candidates.push(inlined);
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (candidate === text || seen.has(candidate)) return false;
    seen.add(candidate);
    return true;
  });
}

/** The escape characters JSON itself defines, so a legal escape is never doubled. */
const JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

/** Control characters JSON forbids raw inside a string, and their escapes. */
const CONTROL_ESCAPES: Readonly<Record<string, string>> = {
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\b": "\\b",
  "\f": "\\f",
};

/** The next character after `from` that is not a space, tab, CR or LF. */
function nextMeaningful(s: string, from: number): { char: string; index: number } {
  for (let i = from; i < s.length; i++) {
    const char = s.charAt(i);
    if (char !== " " && char !== "\t" && char !== "\n" && char !== "\r") {
      return { char, index: i };
    }
  }
  return { char: "", index: s.length };
}

/** A complete JSON string literal followed by a `:` — i.e. an object KEY. */
const KEY_AHEAD = /^"(?:[^"\\]|\\.)*"\s*:/;

/**
 * Walk a run of `}` and `]` from `index` and report what follows it.
 *
 * The discriminator between `…"}` inside a TypeScript snippet and `…"}` closing the JSON
 * document: real JSON continues with a `,` or runs out of input, while source code
 * continues with a `;`, an identifier or anything else.
 */
function afterCloserChain(s: string, index: number): { char: string; index: number } {
  let i = index;
  while (i < s.length) {
    const char = s.charAt(i);
    if (char === "}" || char === "]" || char === " " || char === "\t" || char === "\n" || char === "\r") {
      i += 1;
      continue;
    }
    return { char, index: i };
  }
  return { char: "", index: s.length };
}

/**
 * Does the `"` at `index` CLOSE the string it sits in, or belong to its contents?
 *
 * Structural position is the only evidence available, so that is what is used, and WHERE
 * THE STRING STARTED is half of it:
 *
 *  - a KEY string (one that opened right after `{` or `,`) closes only at a `:`;
 *  - a VALUE string closes at end of input, at a `,` THAT INTRODUCES THE NEXT KEY, or at
 *    a run of closers that the document then ends on or continues from with a `,`.
 *
 * All three halves matter for real source. `const m = {"kind": "error"};` inside a value
 * string contains a `"` before a `:` and a `"` before a `}` — the key rule keeps the first
 * inside the string, and the closer-chain rule keeps the second inside it because a `;`
 * follows the brace. `return "x", y;` stays inside because the comma introduces an
 * identifier, and `["run", "typecheck"]` stays inside because `"typecheck"` is followed by
 * `]` rather than by the `:` a real next key would carry.
 */
function closesString(s: string, index: number, keyPosition: boolean): boolean {
  const next = nextMeaningful(s, index + 1);
  if (next.char === "") return true;
  if (keyPosition) return next.char === ":";
  if (next.char === ",") {
    const after = nextMeaningful(s, next.index + 1);
    return KEY_AHEAD.test(s.slice(after.index));
  }
  if (next.char === "}" || next.char === "]") {
    const after = afterCloserChain(s, next.index);
    if (after.char === "") return true;
    // The same test as the comma rule, one level out: `["run", "typecheck"], { cwd }`
    // reaches a comma through a closer too, and only a real next KEY makes it JSON.
    return (
      after.char === "," &&
      KEY_AHEAD.test(s.slice(nextMeaningful(s, after.index + 1).index))
    );
  }
  return false;
}

/**
 * Escape what JSON forbids inside a string literal, leaving the structure alone.
 *
 * `escapeQuotes` selects the aggressive repair. Outside strings nothing is touched at all,
 * so the document's own punctuation, numbers and literals survive byte-for-byte.
 */
function repairStrings(s: string, escapeQuotes: boolean): string {
  let out = "";
  let inString = false;
  let keyPosition = false;
  /** The last meaningful character seen OUTSIDE a string; decides key vs value position. */
  let lastStructural = "";
  for (let i = 0; i < s.length; i++) {
    const char = s.charAt(i);

    if (!inString) {
      out += char;
      if (char === '"') {
        inString = true;
        keyPosition = lastStructural === "{" || lastStructural === ",";
      } else if (char !== " " && char !== "\t" && char !== "\n" && char !== "\r") {
        lastStructural = char;
      }
      continue;
    }

    if (char === "\\") {
      const next = s.charAt(i + 1);
      // A backslash that does not begin a legal JSON escape is a lone backslash from the
      // source (a Windows path, a regex) and has to become one.
      if (JSON_ESCAPES.has(next)) {
        out += char + next;
        i += 1;
      } else {
        out += "\\\\";
      }
      continue;
    }

    if (char === '"') {
      if (closesString(s, i, keyPosition)) {
        out += char;
        inString = false;
        lastStructural = '"';
      } else {
        out += escapeQuotes ? '\\"' : char;
      }
      continue;
    }

    const control = CONTROL_ESCAPES[char];
    if (control !== undefined) {
      out += control;
      continue;
    }
    // Every other C0 control character, which JSON also forbids raw.
    out += char.charCodeAt(0) < 0x20 ? `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}` : char;
  }
  return out;
}

/** `"key": |` / `|-` / `>` / `>-` — YAML's block-scalar introducers. */
const BLOCK_SCALAR_HEADER = /^(\s*)("[^"\n]*"\s*:\s*)([|>])([-+]?)\s*$/;

/**
 * Fold a YAML block scalar back into a JSON string literal.
 *
 * The one YAML shape a model reaches for unprompted when it is asked for JSON and its
 * payload is source code. Everything else about the document is left as it was — this is
 * not a YAML parser and must not become one (ADR-7: no parser dependency).
 */
function inlineBlockScalars(s: string): string {
  const lines = s.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const header = BLOCK_SCALAR_HEADER.exec(lines[i]);
    if (header === null) {
      out.push(lines[i]);
      continue;
    }
    const [, indent, keyPart, style, chomp] = header;
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j];
      const blank = line.trim().length === 0;
      const deeper = line.startsWith(`${indent} `) || line.startsWith(`${indent}\t`);
      if (!blank && !deeper) break;
      body.push(blank ? "" : line.slice(indent.length).replace(/^\s{1,2}/, ""));
    }
    while (body.length > 0 && body[body.length - 1] === "") body.pop();
    const joined = style === ">" ? body.join(" ") : body.join("\n");
    const text = chomp === "-" ? joined : `${joined}\n`;
    // YAML separates members by line, JSON by comma. A block scalar followed by another
    // key therefore needs the comma the source never had.
    const follows = (lines[j] ?? "").trim();
    out.push(`${indent}${keyPart}${JSON.stringify(text)}${follows.startsWith('"') ? "," : ""}`);
    i = j - 1;
  }
  return out.join("\n");
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
