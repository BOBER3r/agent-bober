# Sprint Briefing: Add mid-conversation system blocks (mid_conv_system)

**Contract:** sprint-spec-20260529-opus-4-8-support-4
**Generated:** 2026-05-29T19:40:00Z
**Project root:** `/Users/bober4ik/agent-bober-workspace/agent-bober` (NOT the cwd)

---

## 0. TL;DR for the Generator

1. Add ONE new interface to `src/providers/types.ts` carrying instruction text + optional ephemeral ttl, add it to the `Message` union, and re-export it from `src/providers/index.ts`.
2. In `src/providers/anthropic.ts`, add a NEW discriminating `"in"`-branch to `toAnthropicMessage()` that returns a `MessageParam` whose `content[]` contains a `MidConversationSystemBlockParam`.
3. In each non-anthropic adapter (`openai.ts`, `google.ts`), add a branch that maps the variant to best-effort text OR skips it — never throw. `openai-compat.ts` needs NO change (it inherits from `OpenAIAdapter`).
4. Add unit tests: anthropic ttl + no-ttl block shape (in `anthropic.test.ts`), and a non-anthropic no-throw test (recommend `openai.test.ts`).

**CRITICAL de-risk fact:** None of the conversion functions use an exhaustive `assertNever` switch. They use `"in"`-checks (`'toolResults' in message`, `'toolCalls' in message`) with a **fall-through** to `TextMessage`. If you do NOT add an explicit branch, your new variant will silently be coerced into a `TextMessage` access (`message as { role; content }`), reading `.content` which does NOT exist on your variant → `undefined` content sent to the API. So you MUST add an explicit branch in `anthropic.ts`, `openai.ts`, AND `google.ts`. Typecheck will NOT catch the missing branch (no exhaustive check), so this is behavioral, not a compile error.

---

## 1. Target Files

### `src/providers/types.ts` (modify)

**Exact current Message union (lines 87-110):**
```ts
export interface ToolResultMessage {
  role: "user";
  /** Tool results keyed by tool call ID. */
  toolResults: ToolResult[];
}

export interface TextMessage {
  role: "user" | "assistant";
  /** Text content. */
  content: string;
}

/**
 * A message in the conversation history.
 *
 * Three variants:
 * - TextMessage: plain user or assistant text
 * - AssistantMessage: assistant response that includes tool call requests
 * - ToolResultMessage: user message carrying tool execution results
 */
export type Message = TextMessage | AssistantMessage | ToolResultMessage;
```

The three current members and their **discriminators**:
- `TextMessage` (lines 96-100): `{ role: "user" | "assistant"; content: string }` — the FALL-THROUGH default; has no unique key.
- `AssistantMessage` (lines 76-82): `{ role: "assistant"; content: string; toolCalls: ToolCall[] }` — discriminated by `'toolCalls' in message` (AND `.length > 0`).
- `ToolResultMessage` (lines 87-91): `{ role: "user"; toolResults: ToolResult[] }` — discriminated by `'toolResults' in message`.

**Discriminator strategy:** `"in"`-checks on a UNIQUE property name, NOT on `role` (since `role` overlaps). Your new variant MUST have a unique property key that no other variant has (e.g. `systemUpdate`) so `'systemUpdate' in message` cleanly selects it. Do NOT reuse `content` (collides with TextMessage/AssistantMessage) as the sole discriminator.

**Edit to make (add the interface, follow the existing JSDoc + section style):**
```ts
/**
 * A provider-agnostic mid-conversation system instruction.
 *
 * Rendered by the Anthropic adapter as a `mid_conv_system` content block
 * inside a message (NOT a top-level role). Non-anthropic adapters render it
 * as best-effort text or skip it. The optional ephemeral cache TTL lets the
 * instruction update mid-task without breaking the prompt cache.
 */
export interface SystemUpdateMessage {
  role: "user";
  /** The mid-conversation system instruction text. */
  systemUpdate: string;
  /** Optional ephemeral cache TTL for this instruction block. */
  cacheTtl?: "5m" | "1h";
}
```
Then extend the union (line 110) and update the JSDoc comment above it:
```ts
export type Message =
  | TextMessage
  | AssistantMessage
  | ToolResultMessage
  | SystemUpdateMessage;
```

> Field names are the Generator's choice per `generatorNotes`, but: (a) the discriminator key MUST be unique; (b) the ttl MUST be typed as `"5m" | "1h"` (matches `CacheControlEphemeral.ttl`, see §4); (c) `role: "user"` is the natural choice since this is a user-turn content block and matches how `attachMessageBreakpoints` and the API treat it.

**Imports this file uses:** none (pure types, no imports).

**Imported by (re-exported through barrel):** `src/providers/index.ts` (lines 1-15) re-exports each member by name. **You MUST add `SystemUpdateMessage` to that export list** or it won't be part of the public API. `src/orchestrator/agentic-loop.ts:1` imports `Message` directly from `../providers/types.js` (it constructs Text/Assistant/ToolResult messages only — adding a union member does not break it).

**Test file:** `src/providers/types.ts` has no dedicated test; it is exercised through adapter tests.

---

### `src/providers/anthropic.ts` (modify)

**`toAnthropicMessage()` IN FULL (lines 79-121):**
```ts
function toAnthropicMessage(
  message: Message,
): Anthropic.Messages.MessageParam {
  // ToolResultMessage: user turn with tool results
  if ("toolResults" in message) {                                    // <- discriminator
    const content: Anthropic.Messages.ToolResultBlockParam[] =
      message.toolResults.map((tr) => ({
        type: "tool_result" as const,
        tool_use_id: tr.toolUseId,
        content: tr.content,
        is_error: tr.isError ?? false,
      }));
    return { role: "user", content };
  }

  // AssistantMessage: assistant turn with tool calls (and optional text)
  if ("toolCalls" in message && message.toolCalls.length > 0) {      // <- discriminator
    const content: Anthropic.Messages.ContentBlockParam[] = [];
    if (message.content) {
      content.push({ type: "text", text: message.content });
    }
    for (const tc of message.toolCalls) {
      content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
    }
    return { role: "assistant", content };
  }

  // TextMessage: plain string content   <-- FALL-THROUGH (any unhandled variant lands here!)
  return {
    role: message.role,
    content: (message as { role: "user" | "assistant"; content: string }).content,
  };
}
```

**Precise edit:** insert a NEW branch BEFORE the TextMessage fall-through (so the variant is caught before the cast). Recommended placement: right after the `toolResults` branch (line 92) or right before the final `return` (line 116). Use the unique discriminator key:
```ts
  // SystemUpdateMessage: render as a mid_conv_system content block inside a user turn
  if ("systemUpdate" in message) {
    const block: Anthropic.Messages.MidConversationSystemBlockParam = {
      type: "mid_conv_system",
      content: [{ type: "text", text: message.systemUpdate }],
      ...(message.cacheTtl
        ? { cache_control: { type: "ephemeral", ttl: message.cacheTtl } }
        : {}),
    };
    return { role: "user", content: [block] };
  }
```

Key points:
- `content` is `Array<TextBlockParam>` — a SINGLE-element array `[{ type: "text", text }]`, NOT a bare string (see §4). TextBlockParam needs `type: "text"` and `text`.
- `cache_control` is attached via conditional spread (the project's idiom — see `effort` spread at `anthropic.ts:239` and the `output_config` spread). Omit the key entirely when no ttl (C3 requires NO `cache_control` field, not `cache_control: undefined`).
- Type the local as `Anthropic.Messages.MidConversationSystemBlockParam` so NO `any` cast is needed. Returning `{ role: "user", content: [block] }` is assignable to `MessageParam` because `MidConversationSystemBlockParam` is a member of `ContentBlockParam` (messages.d.ts:527).

**Interaction with `attachMessageBreakpoints` (lines 143-183) — WATCH OUT:** When `promptCaching` is true (the default), this function walks the last 3 messages and attaches `cache_control: { type: "ephemeral" }` to the LAST block of each message's content array (lines 166-173). Your mid_conv_system message is an array with content, so if it is among the last 3, it WILL get a `cache_control` added to its last (and only) block — i.e. on the `MidConversationSystemBlockParam` itself. For deterministic ttl/no-ttl assertions in C2/C3, **construct the test adapter with `{ promptCaching: false }`** (the existing C3 tests already do this), OR assert on the `content[0].content[0]` text and inspect the block precisely. Recommend `promptCaching: false` for the new ttl/no-ttl tests to isolate the block shape.

**Imports this file uses (lines 1-11):** `import Anthropic from "@anthropic-ai/sdk";` (default import — the SDK is allowed ONLY here) and `import type { ... Message } from "./types.js";`.

**Imported by:** `src/providers/factory.ts` and `src/providers/index.ts:17`.

**Test file:** `src/providers/anthropic.test.ts` (exists) — see §6.

---

### `src/providers/openai.ts` (modify)

**`toOpenAIMessages()` (lines 154-189) — returns `OAIRequestMessage[]`:**
```ts
function toOpenAIMessages(message: Message): OAIRequestMessage[] {
  if ("toolResults" in message) { /* one role:"tool" msg per result */ ... }
  if ("toolCalls" in message && message.toolCalls.length > 0) { /* role:"assistant" */ ... }

  // TextMessage (user or assistant without tool calls)   <-- FALL-THROUGH
  const textMsg = message as { role: "user" | "assistant"; content: string };
  if (textMsg.role === "user") {
    return [{ role: "user", content: textMsg.content }];
  }
  return [{ role: "assistant", content: textMsg.content }];
}
```
**Not exhaustive — fall-through to `TextMessage` cast reading `.content`.** Without a branch, your variant's `content` is `undefined` → silently sends `{ role:"user", content: undefined }`. Add a branch BEFORE the fall-through:
```ts
  // SystemUpdateMessage: best-effort render as an OpenAI system message
  if ("systemUpdate" in message) {
    return [{ role: "system", content: message.systemUpdate }];
  }
```
`OAISystemMessage` (lines 61-64) is `{ role: "system"; content: string }` and is a member of `OAIRequestMessage` (lines 83-87), so this is type-clean and never throws. (Alternatively return `[]` to skip — also acceptable per C4/non-goals.)

**Imported by:** `openai-compat.ts:13` (extends `OpenAIAdapter`), `factory.ts`, `index.ts:18`.
**Test file:** `src/providers/openai.test.ts` (exists).

### `src/providers/openai-compat.ts` (NO CHANGE NEEDED)
It is a 44-line subclass: `export class OpenAICompatAdapter extends OpenAIAdapter` (line 31) and inherits all message conversion. Fixing `openai.ts` automatically covers it. Do NOT add conversion logic here. (Listed in `estimatedFiles` but the correct action is "no edit".)

---

### `src/providers/google.ts` (modify)

**`toGeminiContents()` (lines 129-169) — returns `GeminiContent[]`:**
```ts
function toGeminiContents(message: Message): GeminiContent[] {
  if ("toolResults" in message) { /* role:"function" functionResponse parts */ ... }
  if ("toolCalls" in message && message.toolCalls.length > 0) { /* role:"model" */ ... }

  // TextMessage — map "user" → "user", "assistant" → "model"   <-- FALL-THROUGH
  const textMsg = message as { role: "user" | "assistant"; content: string };
  const geminiRole = textMsg.role === "assistant" ? "model" : "user";
  return [{ role: geminiRole, parts: [{ text: textMsg.content }] }];
}
```
**Not exhaustive.** Add a branch BEFORE the fall-through. Gemini has no system role here (system goes via `systemInstruction` at model config), so best-effort = a `user` text part, or skip:
```ts
  // SystemUpdateMessage: best-effort render as a user text part (Gemini has no
  // in-array system role; the top-level systemInstruction is set separately)
  if ("systemUpdate" in message) {
    return [{ role: "user", parts: [{ text: message.systemUpdate }] }];
  }
```
`GeminiContent` (lines 55-58) = `{ role: "user" | "model" | "function"; parts: GeminiPart[] }`; `GeminiTextPart` = `{ text: string }`. Type-clean, never throws. (Returning `[]` to skip is also acceptable.)

**Imported by:** `factory.ts`, `index.ts:19`.
**Test file:** `src/providers/google.test.ts` (exists).

---

## 2. Patterns to Follow

### Pattern A — Discriminate the Message union with `"in"`-checks, NOT `switch`
**Source:** `anthropic.ts` lines 83, 95; `openai.ts` 156, 165; `google.ts` 131, 146
```ts
if ("toolResults" in message) { ... return ...; }
if ("toolCalls" in message && message.toolCalls.length > 0) { ... return ...; }
// fall-through = TextMessage
```
**Rule:** Add your branch as another `if ("<uniqueKey>" in message)` placed BEFORE the TextMessage fall-through. There is no `assertNever`, so an omitted branch is a SILENT behavioral bug, not a compile error — add the branch in all three adapters.

### Pattern B — Conditional spread to omit a key entirely
**Source:** `anthropic.ts:239`
```ts
...(effort !== undefined ? { output_config: { effort } } : {}),
```
Also `anthropic.ts:273,292`, `openai.ts:292,316`, `google.ts:273,285`.
**Rule:** Use `...(cond ? { key: ... } : {})` to attach `cache_control` ONLY when a ttl is supplied. This produces an object with NO `cache_control` key when absent (satisfies C3's "carries no cache_control"). Never set `cache_control: undefined`.

### Pattern C — Type the SDK block locally, no `any`
**Source:** `anthropic.ts:84-90` (typed `ToolResultBlockParam[]`), `anthropic.ts:163` (`satisfies Anthropic.Messages.TextBlockParam`)
```ts
const content: Anthropic.Messages.ToolResultBlockParam[] = message.toolResults.map(...);
```
**Rule:** Declare `const block: Anthropic.Messages.MidConversationSystemBlockParam = { ... }` so strict mode validates the shape and no cast is needed. SDK types are referenced as `Anthropic.Messages.X`.

### Pattern D — SDK isolated to anthropic.ts; other adapters use inlined shapes
**Source:** `anthropic.ts:1` (`import Anthropic from "@anthropic-ai/sdk"`); `openai.ts:22-87` and `google.ts:21-92` define INLINE interfaces (`OAIRequestMessage`, `GeminiContent`) — no SDK import.
**Rule:** Do NOT import `@anthropic-ai/sdk` in openai.ts/google.ts. The mid_conv_system SDK type is referenced ONLY in anthropic.ts. Non-anthropic adapters map to their own inline request-message shapes.

### Pattern E — ESM `.js` imports + `import type`
**Source:** `anthropic.ts:3-11`, `openai.ts:12-20`, `openai-compat.ts:13-14`
```ts
import type { LLMClient, ChatParams, ... Message } from "./types.js";
```
**Rule:** Type-only imports use `import type` (`consistent-type-imports` is enforced). All relative imports carry the `.js` extension (NodeNext).

### Pattern F — Section header comments
**Source:** every provider file, e.g. `types.ts:58` `// ── Message types ───`, `anthropic.ts:13` `// ── Conversion helpers ──`
**Rule:** When adding the interface to types.ts, keep it inside the `// ── Message types ──` section.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `toAnthropicMessage` | `anthropic.ts:79` | `(message: Message) => Anthropic.Messages.MessageParam` | The function you EXTEND with the mid_conv_system branch. Do not write a new converter. |
| `buildCachedSystem` | `anthropic.ts:129` | `(system: string) => Anthropic.Messages.TextBlockParam[]` | Existing example of wrapping text in a TextBlockParam[] with ephemeral cache_control — mirror its block shape. |
| `attachMessageBreakpoints` | `anthropic.ts:143` | `(msgs: MessageParam[]) => MessageParam[]` | Adds cache_control to last-3 message blocks. Be aware it may add cache_control to your block when promptCaching is on (see §1 note). |
| `toOpenAIMessages` | `openai.ts:154` | `(message: Message) => OAIRequestMessage[]` | EXTEND with a systemUpdate branch. Returns an array (flatMapped at openai.ts:306). |
| `toGeminiContents` | `google.ts:129` | `(message: Message) => GeminiContent[]` | EXTEND with a systemUpdate branch. Returns an array (flatMapped at google.ts:277). |
| `normalizeStopReason` | `anthropic.ts:32`, `openai.ts:135`, `google.ts:112` | `(reason) => StopReason` | Response-side only; NOT touched by this sprint. |
| `CacheControlEphemeral` (SDK) | `@anthropic-ai/sdk .../messages.d.ts:150` | `{ type: 'ephemeral'; ttl?: '5m' \| '1h' }` | Use this exact shape for cache_control; do not invent your own. |
| `MidConversationSystemBlockParam` (SDK) | `.../messages.d.ts:807` | see §4 | The target block type. Use it directly; no `any`. |

No separate `utils/` helpers are relevant to provider message conversion — all conversion lives inside each adapter file.

---

## 4. EXACT SDK Type Shapes (constructed without `any`)

**`MidConversationSystemBlockParam`** — `node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts:807-817`:
```ts
export interface MidConversationSystemBlockParam {
    /** System instruction text blocks. */
    content: Array<TextBlockParam>;          // <-- ARRAY of TextBlockParam, NOT a string
    type: 'mid_conv_system';
    /** Create a cache control breakpoint at this content block. */
    cache_control?: CacheControlEphemeral | null;
}
```
It is a member of `ContentBlockParam` (line 527) → it can sit inside a message's `content[]`.

**`TextBlockParam`** — `messages.d.ts:1017-1025`:
```ts
export interface TextBlockParam {
    text: string;
    type: 'text';
    cache_control?: CacheControlEphemeral | null;
    citations?: Array<TextCitationParam> | null;
}
```
So each content element must be `{ type: "text", text: <instruction> }`.

**`CacheControlEphemeral`** — `messages.d.ts:150-163`:
```ts
export interface CacheControlEphemeral {
    type: 'ephemeral';
    ttl?: '5m' | '1h';        // <-- exactly these two literals; matches your cacheTtl field type
}
```

**Constructed block (the exact object to emit, no cast):**
```ts
const block: Anthropic.Messages.MidConversationSystemBlockParam = {
  type: "mid_conv_system",
  content: [{ type: "text", text: message.systemUpdate }],
  ...(message.cacheTtl ? { cache_control: { type: "ephemeral", ttl: message.cacheTtl } } : {}),
};
```

**SDK version confirmed installed:** `@anthropic-ai/sdk` `0.100.1` (`node_modules/@anthropic-ai/sdk/package.json:3`). No SDK bump needed — sprint 2 already installed it.

---

## 5. Prior Sprint Output

### Sprint 1: opus -> 4.8
Bumped the default model identifier to `claude-opus-4-8` (now in the SDK `Model` union at `messages.d.ts:824`). No direct dependency for this sprint.

### Sprint 2: SDK 0.100.1
**Effect:** Installed `@anthropic-ai/sdk@0.100.1`, which is what TYPES `MidConversationSystemBlockParam`, `CacheControlEphemeral`, and adds them to `ContentBlockParam`. **This sprint depends directly on sprint 2** (`dependsOn: ["...-2"]`). Verified present in node_modules (§4). This is why no cast is required.

### Sprint 3: effort control
**Modified:** `types.ts` (added `ChatParams.effort?: "low"|"medium"|"high"|"xhigh"|"max"`, lines 128-133) and `anthropic.ts:239` (`...(effort !== undefined ? { output_config: { effort } } : {})`).
**Connection:** Establishes the exact CONDITIONAL-SPREAD pattern you mirror for `cache_control` (Pattern B), and the test idiom for asserting a key is present-with-value / absent-entirely (`anthropic.test.ts:188-216`). Your ttl/no-ttl tests are the cache_control analog of these effort tests.

---

## 6. Testing Patterns

**Runner:** vitest. **Assertions:** `expect(...).toMatchObject / toEqual / toContain`. **File naming:** collocated `*.test.ts` next to source. **Mock approach:** top-level `vi.mock` for anthropic (static default import); `vi.doMock` + re-import for openai/google (dynamic imports).

### Anthropic unit-test pattern (USE THIS for C2/C3 ttl + no-ttl)
**Source:** `anthropic.test.ts` lines 18-46 (mock + capture setup):
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatParams } from "./types.js";

const createMock = vi.fn();                              // captures messages.create arg
vi.mock("@anthropic-ai/sdk", () => {                     // top-level, hoisted
  class FakeAnthropic { messages = { create: createMock }; constructor(_opts?: unknown) {} }
  return { default: FakeAnthropic };                     // MUST be { default: ... }
});
import { AnthropicAdapter } from "./anthropic.js";       // import AFTER vi.mock

function fakeResponse() {
  return { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn",
           usage: { input_tokens: 5, output_tokens: 7 } };
}
// beforeEach: createMock.mockReset(); createMock.mockResolvedValue(fakeResponse());
```
Capture + assert idiom (from C2 effort test, `anthropic.test.ts:96-132, 188-216`):
```ts
const req = createMock.mock.calls[0][0] as Record<string, unknown>;
const msgs = req["messages"] as Array<{ role: string; content: unknown }>;
```

**New test — ttl case (C2/C3):** construct adapter with `{ promptCaching: false }` so `attachMessageBreakpoints` does NOT add stray cache_control to your block:
```ts
it("mid_conv_system: renders block with cache_control ephemeral when ttl supplied", async () => {
  const adapter = new AnthropicAdapter("k", { promptCaching: false });
  await adapter.chat({
    model: "claude-x", system: "SYS",
    messages: [{ role: "user", systemUpdate: "Always answer in French.", cacheTtl: "1h" }],
  } satisfies ChatParams);

  const req = createMock.mock.calls[0][0] as { messages: Array<{ role: string; content: unknown }> };
  const block = (req.messages[0].content as Array<Record<string, unknown>>)[0];
  expect(block).toMatchObject({
    type: "mid_conv_system",
    content: [{ type: "text", text: "Always answer in French." }],
    cache_control: { type: "ephemeral", ttl: "1h" },
  });
});

it("mid_conv_system: omits cache_control when no ttl supplied", async () => {
  const adapter = new AnthropicAdapter("k", { promptCaching: false });
  await adapter.chat({
    model: "claude-x", system: "SYS",
    messages: [{ role: "user", systemUpdate: "Be terse." }],
  } satisfies ChatParams);

  const req = createMock.mock.calls[0][0] as { messages: Array<{ content: unknown }> };
  const block = (req.messages[0].content as Array<Record<string, unknown>>)[0];
  expect(block).toMatchObject({ type: "mid_conv_system", content: [{ type: "text", text: "Be terse." }] });
  expect(block).not.toHaveProperty("cache_control");
});
```
> NOTE: the existing fakeResponse `content[0]` is `{ type:"text" }` so `normalizeContent` returns fine — no change to the fake needed. `satisfies ChatParams` will TYPECHECK your new variant in the messages array — proof that the union accepts it (C1).

### Non-anthropic no-throw test (C4) — recommend `openai.test.ts`
**Source:** `openai.test.ts` lines 28-36, 77-88, 151-167 (dynamic-import mock + capture):
```ts
beforeEach(() => { createFn = vi.fn(); vi.doMock("openai", () => ({ default: makeFakeOpenAI(createFn) })); });
async function makeAdapter(model = "gpt-4.1") {
  const { OpenAIAdapter } = await import("./openai.js?v=" + Date.now()); // cache-bust re-import
  return new OpenAIAdapter(model, "test-api-key");
}
```
New test:
```ts
it("C4: tolerates SystemUpdateMessage without throwing (best-effort text)", async () => {
  createFn.mockResolvedValue(makeOAIResponse({ content: "ok" }));
  const adapter = await makeAdapter();
  const result = await adapter.chat({
    model: "gpt-4.1", system: "sys",
    messages: [{ role: "user", systemUpdate: "Switch to terse mode." }],
  });
  expect(result.text).toBe("ok");                       // returned normally, no throw
  const callArgs = createFn.mock.calls[0][0] as { messages: Array<{ role: string; content: string }> };
  // best-effort: the instruction appears as a system message (or assert it was skipped)
  expect(callArgs.messages.some((m) => m.content === "Switch to terse mode.")).toBe(true);
});
```
> The existing `makeOAIResponse` helper (openai.test.ts:43-70) and `makeFakeOpenAI` (28-36) are reusable as-is. If you choose the "skip" approach instead, assert `messages` contains only the system + nothing for the variant, and that the call resolves.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/providers/index.ts` | `types.ts` (re-exports each Message member) | low | Add `SystemUpdateMessage` to the `export type { ... }` list (lines 1-15) so the public API stays complete. |
| `src/orchestrator/agentic-loop.ts:1` | `types.ts` `Message` | low | Only constructs Text/Assistant/ToolResult messages. Adding a union member is additive; no break. Do NOT modify (out of scope). |
| `src/providers/openai-compat.ts` | `openai.ts` (extends) | low | Inherits the fix automatically; no edit. Verify its tests still pass. |
| `src/providers/factory.ts` | all adapters | low | Constructs adapters; unaffected by conversion changes. |

### Existing Tests That Must Still Pass
- `src/providers/anthropic.test.ts` — C1/C2/C3 prompt-caching + effort tests. Your new branch must NOT alter behavior for the existing 3 variants. The `fakeResponse` and mock are shared; add new `it(...)` blocks, do not modify existing ones.
- `src/providers/openai.test.ts` — TextMessage/AssistantMessage/ToolResultMessage conversion (lines 151-237). Adding a `systemUpdate` branch before the fall-through must not change existing TextMessage routing (TextMessage has no `systemUpdate` key, so `"systemUpdate" in message` is false for it).
- `src/providers/google.test.ts` — Gemini content conversion. Same: new branch is exclusive via the unique key.
- `src/providers/openai-compat.test.ts` — inherits OpenAIAdapter; verify still green.
- `src/providers/factory.test.ts` — adapter construction; unaffected.

### Features That Could Be Affected
- **Prompt caching (sprint-prior feature)** — shares `anthropic.ts` and `attachMessageBreakpoints`. Verify C1/C2/C3 caching tests still pass and that a mid_conv_system message among the last 3 messages does not break the ≤4-breakpoint cap (run with promptCaching default in at least a smoke check). Recommend isolating new ttl/no-ttl tests with `{ promptCaching: false }`.
- **effort control (sprint 3)** — shares the conditional-spread idiom in `anthropic.ts:239`; independent code path, no conflict.

### Recommended Regression Checks (run from project root)
1. `cd /Users/bober4ik/agent-bober-workspace/agent-bober && npm run typecheck` — exit 0 (proves the union member is accepted; C1).
2. `npm run lint` — exit 0 (no `any`, `consistent-type-imports`, no unused).
3. `npm run build` — exit 0 (C5).
4. `npx vitest run src/providers/` — ALL provider tests green (new ttl/no-ttl/C4 pass; no regression in caching/effort/conversion tests).
5. `npm run test` — only the documented flaky baseline may fail (see §9). Any other `src/providers/` failure is a regression.

---

## 8. Implementation Sequence

1. **`src/providers/types.ts`** — add `SystemUpdateMessage` interface inside `// ── Message types ──`, add it to the `Message` union (line 110), update the union JSDoc to list four variants.
   - Verify: `npm run typecheck` still passes (no consumer breaks); the interface has a unique discriminator key (`systemUpdate`) and `cacheTtl?: "5m" | "1h"`.
2. **`src/providers/index.ts`** — add `SystemUpdateMessage` to the `export type { ... } from "./types.js"` list.
   - Verify: build/typecheck clean; public API exports the new type.
3. **`src/providers/anthropic.ts`** — add the `"systemUpdate" in message` branch to `toAnthropicMessage()` BEFORE the TextMessage fall-through; construct the typed `MidConversationSystemBlockParam` with conditional `cache_control`.
   - Verify: typecheck passes with NO `any`/cast; existing C1/C2/C3 tests unaffected.
4. **`src/providers/openai.ts`** — add the `"systemUpdate" in message` branch to `toOpenAIMessages()` (return a `role:"system"` message, or `[]` to skip).
   - Verify: typecheck; existing conversion tests pass.
5. **`src/providers/google.ts`** — add the `"systemUpdate" in message` branch to `toGeminiContents()` (return a `role:"user"` text part, or `[]`).
   - Verify: typecheck; existing google tests pass. (`openai-compat.ts` needs NO edit.)
6. **`src/providers/anthropic.test.ts`** — add ttl + no-ttl tests (§6), using `{ promptCaching: false }`.
   - Verify: `npx vitest run src/providers/anthropic.test.ts` green; ttl block has `cache_control:{type:"ephemeral",ttl}`, no-ttl block has no `cache_control`.
7. **`src/providers/openai.test.ts`** — add the C4 no-throw test (§6).
   - Verify: `npx vitest run src/providers/openai.test.ts` green; chat resolves, no throw.
8. **Run full verification** — `npm run typecheck && npm run lint && npm run build && npm run test`. Tolerate only the documented flaky baseline.
9. **Commit** — `bober(sprint-4): add mid-conversation system blocks (mid_conv_system)`.

---

## 9. Pitfalls & Warnings

- **No exhaustive check exists.** Omitting an adapter branch is NOT a compile error — it silently falls through to `(message as { content: string }).content` → `undefined`. You MUST add the branch in anthropic.ts, openai.ts, AND google.ts. This is the #1 risk of this sprint.
- **`content` is `Array<TextBlockParam>`, NOT a string.** The block's `content` is `[{ type:"text", text }]`. A bare string will not typecheck against `MidConversationSystemBlockParam`.
- **Conditional spread, not `cache_control: undefined`.** C3 requires the field ABSENT when no ttl. Use `...(ttl ? { cache_control: {...} } : {})`.
- **`attachMessageBreakpoints` may add cache_control to your block** when `promptCaching` is on and the variant is in the last 3 messages. Use `{ promptCaching: false }` in ttl/no-ttl tests to get a clean assertion.
- **Discriminator must be a UNIQUE key.** Do NOT discriminate on `role` (overlaps user/assistant) or `content` (collides). Use `systemUpdate`.
- **No SDK outside anthropic.ts.** Do NOT import `@anthropic-ai/sdk` in openai.ts / google.ts (principle: "No SDK lock-in"). Use their inline request shapes.
- **No `role:"system"` entry in the Anthropic messages array.** The Anthropic path emits `{ role:"user", content:[ mid_conv_system block ] }` — never a `role:"system"` message (non-goal + evaluator check). The OpenAI best-effort `role:"system"` is fine ONLY because OpenAI's API supports an in-array system message; this does not apply to the Anthropic path.
- **`openai-compat.ts` is in estimatedFiles but should NOT be edited.** It inherits from OpenAIAdapter; editing it would duplicate logic. State clearly in the commit that the fix is inherited.
- **ESM `.js` + `import type`.** New type imports use `import type`; relative imports keep `.js`. Lint will error otherwise.
- **Tolerated flaky baseline (do NOT treat as regression):** the 2 flaky "37-tool-count" tests and occasionally `disk.test.ts` (race). Any OTHER failure, especially in `src/providers/`, is a real regression.
- **Field-name freedom but ttl type is fixed.** Per generatorNotes you may rename fields, but `cacheTtl` MUST be typed `"5m" | "1h"` to feed `CacheControlEphemeral.ttl` without coercion.
