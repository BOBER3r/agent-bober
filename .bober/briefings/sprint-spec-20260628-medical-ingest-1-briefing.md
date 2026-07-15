# Sprint Briefing: Lab-PDF -> structured JSON parser (Claude document block, egress-gated)

**Contract:** sprint-spec-20260628-medical-ingest-1
**Generated:** 2026-06-28T00:00:00Z

> Scope: ADD an additive optional `ChatParams.documents` field rendered ONLY by the Anthropic
> adapter as a `document` content block, and a new `parseLabPdf()` in `src/medical/lab-pdf-parser.ts`
> that base64-encodes a native-text lab PDF, calls an injectable `LLMClient` with schema-constrained
> output, and returns a Zod-validated `ParsedLabReport`. No network in tests, no CLI, no vault writes.

---

## 1. Target Files

### `src/providers/types.ts` (modify)

`ChatParams` is the interface to extend. The two existing optional-field precedents the contract tells
you to mirror (`responseSchema`, `jsonObjectMode`) are right here — copy their JSDoc style.

**Relevant sections (lines 139-184):**
```ts
export interface ChatParams {
  model: string;
  system: string;
  messages: Message[];
  tools?: ToolDef[];
  maxTokens?: number;            // Defaults to 16384.
  effort?: "low" | "medium" | "high" | "xhigh" | "max";  // only Anthropic forwards it (lines 150-155)
  /**
   * When `responseSchema` is set, `ChatResponse.text` holds a JSON document that
   * best-effort conforms to this schema, and `toolCalls` is empty. (lines 150-174)
   * ... mutually exclusive with `tools`; claude-code ignores it.
   */
  responseSchema?: JsonSchemaObject;     // line 174
  /** loose json_object mode; provider must support the knob (lines 175-183) */
  jsonObjectMode?: boolean;              // line 183
  // >>> ADD HERE: documents?: { base64: string; mediaType: string }[]  <<<
}
```
**Add (additive, optional, last field):** a `documents?: { base64: string; mediaType: string }[]`
field with a JSDoc note that ONLY the Anthropic adapter renders it (as a `document` content block on
the first user message) and every other adapter ignores it. Match the prose tone of the `effort`
(lines 150-155) and `responseSchema` (150-174) docs.

**`JsonSchemaObject`** (the type of `responseSchema`) is defined in THIS file, lines 19-26 — it has a
`[key: string]: unknown` index signature so plain JSON-Schema object literals are assignable.

**`LLMClient`** interface (lines 216-222): single method `chat(params: ChatParams): Promise<ChatResponse>`.
**`ChatResponse`** (lines 194-206): `{ text: string; toolCalls: ToolCall[]; stopReason; usage }` — your
parser reads `response.text`.

**Imported by (every adapter + structured runner + factory):** `src/providers/anthropic.ts:3-11`,
`openai.ts`, `google.ts`, `openai-compat.ts`, `claude-code.ts`, `structured.ts`, `factory.ts:6`, and
all medical LLM consumers. Adding an OPTIONAL field is non-breaking — but see Impact Analysis (sec 7).
**Test file:** no dedicated `types.test.ts`; the field is exercised via `anthropic.test.ts`.

---

### `src/providers/anthropic.ts` (modify)

The content-block construction pattern lives in `toAnthropicMessage` (lines 80-134). Note this is a
**free function** mapped via `messages.map(toAnthropicMessage)` at line 225-226 — it has NO access to
`params.documents` or the message index. So the document-block injection must happen in `chat()` AFTER
the map and BEFORE caching, guarded by a `params.documents` presence check.

**`toAnthropicMessage` TextMessage path (lines 129-133) — the shape you prepend onto:**
```ts
  // TextMessage: plain string content
  return {
    role: message.role,
    content: (message as { role: "user" | "assistant"; content: string }).content,
  };
```
A user `TextMessage` renders as `{ role: "user", content: "<string>" }`. To attach a PDF you convert
that string to a content-block array `[ <document block>, { type: "text", text: <string> } ]`.

**`chat()` mapping + caching pipeline (lines 221-265) — where to inject:**
```ts
async chat(params: ChatParams): Promise<ChatResponse> {
  const { model, system, messages, tools, maxTokens = 16384, effort } = params;   // line 222 — destructure does NOT include documents
  const anthropicMessages: Anthropic.Messages.MessageParam[] =
    messages.map(toAnthropicMessage);                                              // lines 225-226
  // ... structured-output branch (lines 228-251) ...
  const cachedMessages = this.promptCaching
    ? attachMessageBreakpoints(anthropicMessages)   // line 264 — runs AFTER your injection
    : anthropicMessages;
  const response = await this.client.messages.create({ model, max_tokens: maxTokens, system: cachedSystem, messages: cachedMessages, ... });  // line 267
```
**Injection rule:** after line 226, if `params.documents?.length`, locate the FIRST message whose
`role === "user"` in `anthropicMessages` and prepend a `DocumentBlockParam`. Convert string content to
`[doc, {type:"text", text}]`; if content is already an array, `unshift` the doc block. Do this BEFORE
`attachMessageBreakpoints` (line 263-265) so the cache breakpoint still lands on the LAST (text) block.
Wrap ALL of it in `if (params.documents && params.documents.length > 0)` so omitting `documents` leaves
the request byte-identical (sc-1-5; see the existing byte-identical guard tests in sec 6 / sec 7).

**Anthropic SDK block shape (verified from `node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts`):**
- `DocumentBlockParam` (line 551-561): `{ type: 'document'; source: Base64PDFSource | ...; ... }`
- `Base64PDFSource` (line 100-104): `{ type: 'base64'; media_type: 'application/pdf'; data: string }`

So the block you build is exactly:
```ts
{ type: "document", source: { type: "base64", media_type: "application/pdf", data: doc.base64 } }
```
(`source.type` = `"base64"`, `media_type` = `"application/pdf"`, `data` = the base64 string — these are
the precise keys sc-1-5 asserts.)

**Imports this file uses (lines 1-11):** `Anthropic` default-import (line 1, SDK), and `type { LLMClient, ChatParams, ChatResponse, ToolDef, ToolCall, StopReason, Message } from "./types.js"`.
**Imported by:** `src/providers/factory.ts:1`.
**Test file:** `src/providers/anthropic.test.ts` EXISTS (modify it — sc-1-5 lives here; see sec 6).

---

### `src/medical/lab-types.ts` (create)

**Directory pattern:** `src/medical/` files are kebab/lowercase `.ts` with box-drawing `// -- Section --`
headers. Zod-backed type modules use `import { z } from "zod"` then `export const XSchema = z.object(...)`
+ `export type X = z.infer<typeof XSchema>`.
**Most similar existing file:** `src/medical/retrieval/grounding-critic.ts` lines 1-32 — copy its
schema+infer pattern. (`src/medical/types.ts` is the big shared types file; the contract explicitly says
put the new schemas in a SEPARATE `lab-types.ts` to avoid churning it.)

**Structure template (based on grounding-critic.ts:1-32):**
```ts
/** Zod schemas for parsed lab reports (medical-ingest Sprint 1). */
import { z } from "zod";

// -- Schemas ----------------------------------------------------------

export const ParsedLabMarkerSchema = z.object({
  name: z.string(),
  value: z.number(),
  unit: z.string(),
  referenceLow: z.number().optional(),
  referenceHigh: z.number().optional(),
  critical: z.boolean().optional(),
});
export const ParsedLabReportSchema = z.object({
  panel: z.string(),
  collectedAtIso: z.string(),
  markers: z.array(ParsedLabMarkerSchema),
});

// -- Types ------------------------------------------------------------

export type ParsedLabMarker = z.infer<typeof ParsedLabMarkerSchema>;
export type ParsedLabReport = z.infer<typeof ParsedLabReportSchema>;
```
**Mapping check:** `ParsedLabMarker` maps cleanly onto the existing `LabResult`
(`src/medical/types.ts:118-127`): `name->biomarker`, `value->value`, `unit->unit`,
`referenceLow/High->referenceLow/High`; `ParsedLabReport.collectedAtIso` -> `LabResult.collectedAtIso`.
(`LabResult.id` is derived later; `critical` is parser-only.) Sprint 2 will do the actual mapping — do
NOT import `LabResult` here; just keep field names aligned.

---

### `src/medical/lab-pdf-parser.ts` (create)

**Most similar existing file:** `src/medical/retrieval/grounding-critic.ts` — the
`callGroundingCritic` (lines 123-166) / `getGroundingVerdict` (lines 170-207) pair shows the deps-object
LLM-call-then-validate shape. Mirror the injectable seam in `src/medical/inference.ts:31-35`.

**Structure template:**
```ts
/** parseLabPdf — native-text lab PDF -> Zod-validated ParsedLabReport via injectable LLMClient. */
import type { LLMClient } from "../providers/types.js";
import type { JsonSchemaObject } from "../providers/types.js";
import { ParsedLabReportSchema, type ParsedLabReport } from "./lab-types.js";

// -- Deps seam --------------------------------------------------------

export interface ParseLabPdfDeps {
  client: LLMClient;   // tests inject a fake; prod passes buildMedicalInferenceClient(...) in Sprint 3
  model: string;
}

// -- Response schema (hand-written JsonSchemaObject literal) -----------

const LAB_REPORT_JSON_SCHEMA: JsonSchemaObject = {
  type: "object",
  properties: { /* panel, collectedAtIso, markers[]: {name,value,unit,referenceLow?,referenceHigh?,critical?} */ },
  required: ["panel", "collectedAtIso", "markers"],
};

// -- parseLabPdf ------------------------------------------------------

export async function parseLabPdf(pdfBytes: Uint8Array, deps: ParseLabPdfDeps): Promise<ParsedLabReport> {
  const base64 = Buffer.from(pdfBytes).toString("base64");
  const response = await deps.client.chat({
    model: deps.model,
    system: "<extraction instruction>",
    messages: [{ role: "user", content: "<extraction prompt>" }],
    documents: [{ base64, mediaType: "application/pdf" }],
    responseSchema: LAB_REPORT_JSON_SCHEMA,        // => response.text holds the JSON (types.ts:160-163)
  });
  const parsed = JSON.parse(response.text);        // model returns JSON string in .text
  return ParsedLabReportSchema.parse(parsed);      // THROWS ZodError on malformed output (sc-1-4)
}
```
Notes: build the `responseSchema` as a hand-written `JsonSchemaObject` literal (the established pattern —
`anthropic.test.ts:282-286`, `google.ts`/`openai.ts` consume the same shape; `zod-to-json-schema` is a
dependency at `package.json:75` but is imported NOWHERE in `src/`, so do not introduce it). Use
`ParsedLabReportSchema.parse()` (NOT `safeParse`) so malformed output throws — the contract forbids
returning unvalidated objects. `pdfBytes` is passed IN; the parser does NOT read the file (no fs here).

**Test file:** `src/medical/lab-pdf-parser.test.ts` (create — sc-1-3, sc-1-4).

---

### `src/medical/lab-pdf-parser.test.ts` (create)

Copy the `ScriptedClient` fake from `grounding-critic.test.ts:12-25` and the throwing-client from
`grounding-critic.test.ts:274-289`. See sec 6 for the exact templates.

---

## 2. Patterns to Follow

### Injectable fake LLMClient ("ScriptedClient")
**Source:** `src/medical/retrieval/grounding-critic.test.ts`, lines 12-25
```ts
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
```
**Rule:** inject a fake `LLMClient` returning canned JSON text; record `calls` to assert what was sent.
No network, no Anthropic SDK — this is how every medical LLM test stays offline (contract nonGoal #1).

### Zod schema + `z.infer` type module
**Source:** `src/medical/retrieval/grounding-critic.ts`, lines 27-32
```ts
export const GroundingVerdictSchema = z.object({
  verdict: z.enum(["approve", "reject"]),
  feedback: z.string(),
});
export type GroundingVerdict = z.infer<typeof GroundingVerdictSchema>;
```
**Rule:** declare schema as `export const XSchema = z.object(...)`, derive the TS type with `z.infer`.

### LLMClient.chat call site (deps object, reads response.text)
**Source:** `src/medical/retrieval/grounding-critic.ts`, lines 158-165
```ts
const response = await llm.chat({
  model,
  system: buildGroundingSystemPrompt(question, answerBody, passages),
  messages,
  jsonObjectMode: true,
});
return response.text;
```
**Rule:** pass `{ client/llm, model }` via the deps object; the adapter contract guarantees structured
output lands in `response.text`. (Your parser uses `responseSchema` instead of `jsonObjectMode`.)

### Anthropic adapter content-block array construction
**Source:** `src/providers/anthropic.ts`, lines 97-114 (assistant path) and 117-126 (mid_conv_system path)
```ts
const content: Anthropic.Messages.ContentBlockParam[] = [];
if (message.content) content.push({ type: "text", text: message.content });
for (const tc of message.toolCalls) content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
return { role: "assistant", content };
```
**Rule:** content-block messages are `{ role, content: ContentBlockParam[] }`; build the typed array and
push/unshift blocks. Your document block is `{ type: "document", source: {...} }` unshifted onto the
first user message's content array.

### Adapter request-shape inspection test (createMock)
**Source:** `src/providers/anthropic.test.ts`, lines 24-33 (mock) + 288-306 (assertion)
```ts
const createMock = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic { messages = { create: createMock }; constructor(_opts?: unknown) {} }
  return { default: FakeAnthropic };
});
// ... in a test:
const req = createMock.mock.calls[0][0] as { messages: Array<{ role: string; content: unknown }> };
expect(req.tools?.[0].input_schema).toBe(schema);   // inspect the EXACT constructed request
```
**Rule:** the Anthropic adapter test mocks the SDK and inspects `createMock.mock.calls[0][0]` (the
request object). Use this exact harness for sc-1-5. The byte-identical assertion style is at
`anthropic.test.ts:354-365` (`expect(req).not.toHaveProperty(...)` + `JSON.stringify(req)` not-contains).

### Additive-optional-field byte-identical guard
**Source:** `src/providers/anthropic.ts`, lines 273-281 (`effort`/`structured` spreads) and the matching
tests `anthropic.test.ts:205-216` (`omits output_config entirely when effort is unset`).
**Rule:** new behaviour is added via `...(cond ? {...} : {})` spreads / fully-guarded `if`-blocks so the
request is byte-identical when the feature is unused. Replicate this for `documents`.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `zodValidator` | `src/providers/structured.ts:80` | `<T>(schema: SafeParseable<T>): Validator<T>` | Wrap a Zod schema into a `(raw)=>{ok,value\|error}` validator (flattens issues) |
| `coerceJson` | `src/providers/structured.ts:106` | `(text: string): unknown` | Robust JSON extraction from model text (direct -> strip fences -> brace-span). Use only if the model wraps JSON in prose; with `responseSchema` a plain `JSON.parse` suffices |
| `runStructuredAgent` | `src/providers/structured.ts:212` | `<T>(opts): Promise<StructuredAgentResult<T>>` | Single-shot structured call w/ coerce+validate+bounded repair; `opts.schema: JsonSchemaObject`, `opts.validate: zodValidator(Schema)`. Optional richer alternative to a raw `chat()` call |
| `StructuredOutputError` | `src/providers/structured.ts:39` | `class extends Error` | Thrown by `runStructuredAgent` when no attempt validates |
| `Validator<T>` / `ValidationResult<T>` | `src/providers/structured.ts:54-59` | type | `{ok:true,value}\|{ok:false,error}` result contract |
| `createClient` | `src/providers/factory.ts:192` | `(provider?, endpoint?, providerConfig?, model?, role?): LLMClient` | Sole client-construction seam (do NOT new-up adapters directly) |
| `buildMedicalInferenceClient` | `src/medical/inference.ts:31` | `(config, egress, factory?): { client: LLMClient; model: string }` | Production resolver for the medical LLM client/model; Sprint 3 wires its result into `parseLabPdf` deps |
| `LabResult` | `src/medical/types.ts:118` | interface `{ biomarker, value, unit, collectedAtIso, referenceLow?, referenceHigh? }` | Existing lab shape `ParsedLabMarker` must align with (Sprint 2 maps onto it) |
| `LLMClient` / `ChatParams` / `ChatResponse` / `Message` / `JsonSchemaObject` | `src/providers/types.ts:216 / 139 / 194 / 128 / 19` | types | Provider-agnostic interfaces — import, never redefine |

Directories reviewed: `src/utils/` (fs.ts, git.ts, logger.ts — none applicable to PDF parsing),
`src/providers/` (structured.ts utils above), `src/medical/` (inference.ts seam, types.ts shapes).
There is NO existing base64 helper and NO existing PDF utility in `src/` (grep for `base64`/`Buffer.from`
in non-test `src/` returns zero hits) — use `Buffer.from(bytes).toString("base64")` inline.

---

## 4. Prior Sprint Output

No prior sprints in this spec (`dependsOn: []`). This sprint builds on existing infrastructure:
- The provider seam (`src/providers/types.ts`, `anthropic.ts`, `factory.ts`).
- The medical module conventions established in Phase 6 (`src/medical/types.ts`, `inference.ts`,
  `retrieval/grounding-critic.ts`).
Sprint 2 (vault notes / store reindex) and Sprint 3 (egress gating + CLI wiring of
`buildMedicalInferenceClient` into `parseLabPdf`'s deps) are OUT OF SCOPE here.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM everywhere** — all imports use `.js` extensions (NodeNext). (principles.md:27)
- **Provider-agnostic interfaces** — all LLM interaction goes through `providers/types.ts`; NEVER import
  `@anthropic-ai/sdk` outside `providers/anthropic.ts`. (principles.md:28, 41)
- **Zod for validation** — `import { z } from "zod"`; use `z.parse()`/schemas, no hand-rolled validation.
  (principles.md:29) Note: principle 29 mentions config schemas in `config/schema.ts`, but `medical/`
  already establishes local zod schema modules (grounding-critic.ts) — follow that precedent.
- **`type` imports** — `consistent-type-imports` is enforced; use `import type { ... }`. (principles.md:35)
- **No `any`** — prefer `unknown` + narrowing. (principles.md:40)
- **Prefix unused params with `_`.** (principles.md:36)
- **Section comments** — `// -- Section Name ------` box headers. (principles.md:32)
- **No sync fs** — `node:fs/promises` only (not relevant here: parser receives bytes, does not read).
  (principles.md:42)
- **Collocated tests** — `*.test.ts` next to source. (principles.md:20)

### Architecture Decisions
No ADR file dedicated to this sprint. The medical module is governed by the egress-gating /
fail-closed safety model from Phase 6 (see `src/medical/inference.ts:21-30` doc + `EgressGuard`), but
egress gating is explicitly Sprint 3 (out of scope). For Sprint 1, the only architectural rule is
ADDITIVE provider change: only the Anthropic adapter renders `documents`; all other adapters ignore it.

### Other Docs
`package.json`: scripts `build` = `tsc` (line 12), `typecheck` = `tsc --noEmit` (line 15), `test` =
`vitest` (line 16). Deps: `zod ^3.24.2` (line 74), `zod-to-json-schema ^3.25.2` (line 75 — present but
unused in `src/`). Test runner is **vitest** (no `vitest.config.*` file; default config).

---

## 6. Testing Patterns

### Unit Test Pattern — medical parser (canned-client + throws)
**Source:** `src/medical/retrieval/grounding-critic.test.ts:1-25, 94-119, 272-290`
```ts
import { describe, it, expect } from "vitest";
import type { LLMClient, ChatParams, ChatResponse } from "../providers/types.js";

class ScriptedClient implements LLMClient {
  readonly calls: ChatParams[] = [];
  constructor(private readonly responses: string[]) {}
  async chat(params: ChatParams): Promise<ChatResponse> {
    this.calls.push(params);
    return { text: this.responses[0] ?? "", toolCalls: [], stopReason: "end", usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

// sc-1-3 happy path:
it("returns a ParsedLabReport from canned JSON", async () => {
  const canned = JSON.stringify({ panel: "CBC", collectedAtIso: "2026-06-01", markers: [{ name: "Hgb", value: 14.2, unit: "g/dL" }] });
  const client = new ScriptedClient([canned]);
  const report = await parseLabPdf(new Uint8Array([1,2,3]), { client, model: "test-model" });
  expect(report.markers).toHaveLength(1);
  expect(report.markers[0].value).toBe(14.2);
  expect(report.markers[0].unit).toBe("g/dL");
  expect(report.collectedAtIso).toBe("2026-06-01");
});

// sc-1-4 malformed -> rejects (throwing on bad shape):
it("throws when a required marker field is missing", async () => {
  const bad = JSON.stringify({ panel: "CBC", collectedAtIso: "2026-06-01", markers: [{ name: "Hgb", unit: "g/dL" }] }); // no value
  const client = new ScriptedClient([bad]);
  await expect(parseLabPdf(new Uint8Array([1]), { client, model: "m" })).rejects.toThrow();
});
```
For a transport-error variant, see the inline `errorClient` at `grounding-critic.test.ts:274-289`.
**Runner:** vitest. **Assertion style:** `expect()` + `.rejects.toThrow()`. **Mock approach:** hand-rolled
`implements LLMClient` (NOT `vi.mock`). **File naming:** `lab-pdf-parser.test.ts` collocated in `src/medical/`.

### Anthropic adapter request-shape test (sc-1-5) — goes in `src/providers/anthropic.test.ts`
**Source:** `src/providers/anthropic.test.ts:24-33` (SDK mock) + `:288-306` (request inspection) + `:354-365` (byte-identical-when-absent)
```ts
it("renders ChatParams.documents as a base64 application/pdf document block on the first user message", async () => {
  const adapter = new AnthropicAdapter("k", { promptCaching: false }); // disable caching to inspect raw blocks
  await adapter.chat({
    model: "claude-x", system: "SYS",
    messages: [{ role: "user", content: "extract this" }],
    documents: [{ base64: "QkFTRTY0", mediaType: "application/pdf" }],
  } satisfies ChatParams);

  const req = createMock.mock.calls[0][0] as { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> };
  const firstUserBlocks = req.messages[0].content;
  expect(firstUserBlocks[0]).toMatchObject({
    type: "document",
    source: { type: "base64", media_type: "application/pdf", data: "QkFTRTY0" },
  });
});

it("omits the document block (request unchanged) when documents is absent", async () => {
  const adapter = new AnthropicAdapter("k", { promptCaching: false });
  await adapter.chat({ model: "claude-x", system: "SYS", messages: [{ role: "user", content: "hi" }] } satisfies ChatParams);
  const req = createMock.mock.calls[0][0] as Record<string, unknown>;
  expect(JSON.stringify(req)).not.toContain("document");      // byte-identical guard (mirrors :354-365)
  expect(req["messages"]).toEqual([{ role: "user", content: "hi" }]);
});
```
**Mock approach:** top-level `vi.mock("@anthropic-ai/sdk", () => ({ default: FakeAnthropic }))` with a
shared `createMock` (already present at `anthropic.test.ts:24-33` — REUSE it, do not add a second mock).
Disable `promptCaching` in these cases so you inspect the unmodified block array. There is NO Playwright /
E2E surface for this sprint.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/providers/anthropic.ts` | `ChatParams` (types.ts) | low | Adding optional `documents?` is non-breaking; the adapter is the only renderer |
| `src/providers/openai.ts` / `google.ts` / `openai-compat.ts` / `claude-code.ts` | `ChatParams` | low | Must continue to IGNORE `documents` (do NOT destructure/handle it). Contract nonGoal #4 + evaluatorNotes require non-Anthropic adapters unchanged |
| `src/providers/structured.ts` | `ChatParams` (`responseSchema`) | low | `runStructuredAgent` builds `chat()` calls; new optional field doesn't affect it |
| `src/providers/factory.ts` | `AnthropicAdapter` | low | Constructs the adapter; no signature change |
| `src/medical/inference.ts` + all medical LLM consumers | `LLMClient`/`ChatParams` | low | Interface only gains an optional field |

### Existing Tests That Must Still Pass
- `src/providers/anthropic.test.ts` — caching (C1/C2/C3), `effort`, `mid_conv_system`, and **structured-output**
  cases. CRITICAL: the C3 byte-identical tests (`:154-182`) and `no tool_choice when responseSchema absent`
  (`:354-365`) assert zero extra keys when a feature is unused — your `documents` guard must keep that true.
- `src/providers/structured.test.ts` — exercises `responseSchema` end-to-end through a client.
- `src/providers/factory.test.ts`, `openai.test.ts`, `google.test.ts`, `openai-compat.test.ts`,
  `claude-code.test.ts` — confirm the new optional field compiles/typechecks and adapters still ignore it.
- `src/medical/inference.test.ts`, `src/medical/retrieval/grounding-critic.test.ts` — LLMClient consumers;
  verify the `ChatParams` change doesn't perturb their scripted-client expectations.

### Features That Could Be Affected
- **Prompt caching** (`anthropic.ts:156-196 attachMessageBreakpoints`) — shares the first user message you
  mutate. Inject the document block BEFORE `attachMessageBreakpoints` so the cache breakpoint lands on the
  final (text) block and string->array conversion stays consistent. Verify C2 (`anthropic.test.ts:96-150`)
  still passes with a document present (breakpoint count stays <= 4).
- **Structured output** (`anthropic.ts:228-251`, `:296-306`) — `parseLabPdf` uses `responseSchema`, so the
  forced-tool branch produces `response.text = JSON.stringify(forced.input)`. Confirm a request can carry
  BOTH `documents` and `responseSchema` (it should: document block on the message, forced tool separately).

### Recommended Regression Checks (run after implementation)
1. `npm run build` exits 0 (sc-1-1).
2. `npm run typecheck` exits 0 (sc-1-2).
3. `npx vitest run src/providers/anthropic.test.ts` — all cache/effort/structured cases + new document cases pass.
4. `npx vitest run src/providers` — every adapter still green (non-Anthropic adapters ignore `documents`).
5. `npx vitest run src/medical/lab-pdf-parser.test.ts` — sc-1-3 happy path + sc-1-4 throws-on-malformed pass.
6. `git grep -n "documents" src/providers/openai.ts src/providers/google.ts src/providers/openai-compat.ts src/providers/claude-code.ts` returns NOTHING (proves non-Anthropic adapters untouched).

---

## 8. Implementation Sequence

1. **`src/medical/lab-types.ts`** — create the Zod schemas + `z.infer` types (no deps).
   - Verify: `npx tsc --noEmit` resolves the module; `ParsedLabReportSchema.parse({...})` shape matches sec 1.
2. **`src/providers/types.ts`** — add optional `documents?: { base64: string; mediaType: string }[]` to
   `ChatParams` with JSDoc mirroring `responseSchema`/`effort` (depends on nothing).
   - Verify: typecheck stays green; no other adapter forced to handle it (optional field).
3. **`src/providers/anthropic.ts`** — in `chat()`, after `messages.map(toAnthropicMessage)` and BEFORE
   `attachMessageBreakpoints`, guarded by `params.documents?.length`, prepend the `document` block to the
   first user message (depends on step 2).
   - Verify: existing `anthropic.test.ts` still passes; a `documents` request shows the block; an absent
     `documents` request is byte-identical (`JSON.stringify(req)` has no `"document"`).
4. **`src/medical/lab-pdf-parser.ts`** — implement `parseLabPdf(pdfBytes, deps)`: base64-encode, build
   `chat()` with `documents` + `responseSchema` (JsonSchemaObject literal), `JSON.parse(response.text)`,
   `ParsedLabReportSchema.parse(...)` (throws on bad) (depends on steps 1-3).
   - Verify: typecheck green; deps object `{ client, model }` matches the inference.ts/grounding-critic seam.
5. **`src/medical/lab-pdf-parser.test.ts`** (create) + add sc-1-5 cases to **`src/providers/anthropic.test.ts`**
   (modify) — ScriptedClient happy path (sc-1-3), malformed `.rejects.toThrow()` (sc-1-4), and the adapter
   document-block + byte-identical cases (sc-1-5) (depends on all above).
   - Verify: the three new test files/cases pass; no network call.
6. **Run full verification** — `npm run build` && `npm run typecheck` && `npx vitest run src/providers src/medical`.

---

## 9. Pitfalls & Warnings

- **`toAnthropicMessage` cannot see `documents`.** It is a free function mapped without index/params
  (`anthropic.ts:225-226`). Do the injection inside `chat()` after the map, NOT inside `toAnthropicMessage`.
- **`chat()` destructure at line 222 omits `documents`.** Read `params.documents` directly (or add it to the
  destructure). Forgetting this is the most likely "feature silently does nothing" bug.
- **Byte-identical guard is graded.** sc-1-5 + evaluatorNotes require a NO-documents request to match prior
  snapshots exactly. Wrap ALL document logic in `if (params.documents && params.documents.length > 0)`.
  Don't add an empty array or a key when `documents` is absent.
- **Order vs prompt caching.** Inject the document block BEFORE `attachMessageBreakpoints` (line 263-265) so
  the ephemeral breakpoint still lands on the LAST block (the text) and string->array conversion is done once.
- **Exact SDK key names.** `source.type` = `"base64"`, `media_type` (snake_case) = `"application/pdf"`,
  `data` = base64 string (verified at SDK `messages.d.ts:100-104, 551-561`). The provider-agnostic
  `ChatParams.documents` field uses camelCase `{ base64, mediaType }`; the adapter maps it to the snake_case
  SDK shape.
- **`response.text` holds JSON, not tool calls.** With `responseSchema` set, the Anthropic adapter stringifies
  the forced-tool input into `response.text` and empties `toolCalls` (`anthropic.ts:296-306`,
  `types.ts:160-163`). Parse `response.text`; do NOT look in `toolCalls`.
- **Use `.parse()` not `.safeParse()`** in `parseLabPdf` — the contract requires THROWING on malformed output
  (sc-1-4). `safeParse` would swallow the error. (`zodValidator`/`runStructuredAgent` are non-throwing
  alternatives — only use them if you also re-throw on failure.)
- **Do NOT import `@anthropic-ai/sdk` outside `anthropic.ts`** (principles.md:41) and do NOT import `zod` into
  `providers/` (keep `structured.ts`/`types.ts` dependency-pure). `zod` belongs in `medical/lab-types.ts`.
- **Do NOT introduce `zod-to-json-schema`.** It's an unused dependency; hand-write the `JsonSchemaObject`
  literal (matches every existing `responseSchema` producer).
- **`.js` import extensions + `import type`** everywhere (principles.md:27, 35) — `tsc` NodeNext + ESLint will
  fail otherwise.
- **Don't touch non-Anthropic adapters.** They must ignore `documents` by simply not handling it (nonGoal #4).
- **No real fs/network in this sprint.** `parseLabPdf` receives bytes; tests inject a fake client.
