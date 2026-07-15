# Sprint Briefing: Streaming text deltas (Anthropic adapter streaming + loop passthrough)

**Contract:** sprint-spec-20260709-agent-loop-capability-port-8
**Generated:** 2026-07-10T00:00:00Z

---

## 0. What this sprint does (the one-paragraph model)

Add an optional `onTextDelta?: (delta: string) => void` to `ChatParams`. When it is set, the
Anthropic adapter switches from `client.messages.create(...)` to `client.messages.stream(...)`,
invokes the callback for each text delta, then builds the **exact same** normalized `ChatResponse`
from the stream's final accumulated message. Every other adapter accepts the field and ignores it
(documented no-op). The loop threads a combined delta callback into every `chat()` call and also
emits a new `text-delta` `LoopEvent` when `onEvent` is present. With neither `onTextDelta` nor
`onEvent` set, the loop passes NO `onTextDelta`, the adapter uses `create()`, and everything is
byte-identical to today. The critical refactor: **extract a shared `normalizeResponse(message)`
helper** so the streaming and non-streaming branches produce identical output.

---

## 1. Target Files

### `src/providers/types.ts` (modify)

Add one optional field to the `ChatParams` interface. It currently ends with `documents?` at line 208.

**Relevant section (lines 146-209):** `ChatParams` interface. Insert the new field alongside the
other optional, provider-agnostic knobs (`effort`, `responseSchema`, `documents`). Follow the
existing doc-comment style — each field has a JSDoc block explaining that adapters MAY ignore it:

```ts
// existing tail of ChatParams (line 191-208) for placement reference:
  jsonObjectMode?: boolean;
  documents?: { base64: string; mediaType: string }[];
```

Add (own type, safe for every adapter to ignore — mirror the "Other adapters ignore it" wording
already used by `effort` at lines 156-162):

```ts
  /**
   * Optional streaming callback. When set, adapters that support server-sent
   * streaming (currently ONLY the Anthropic adapter) invoke it once per text
   * delta as the response is generated; the concatenation of all deltas equals
   * the final ChatResponse.text. This is a pure provider-agnostic own type —
   * adapters MAY ignore it (openai/openai-compat/google/claude-code do; they
   * return the identical non-streamed ChatResponse and put nothing extra on the
   * wire). A throwing callback must never kill the request (adapter wraps it).
   */
  onTextDelta?: (delta: string) => void;
```

**Imported by:** every adapter (`anthropic.ts`, `openai.ts`, `openai-compat.ts`, `google.ts`,
`claude-code.ts`), `agentic-loop.ts`, `compaction.ts`, `structured.ts`. Adding an OPTIONAL field is
backward-compatible — no existing caller breaks.

**Test file:** no dedicated `types.test.ts`; covered transitively by adapter/loop tests.

---

### `src/providers/anthropic.ts` (modify — the core change)

Two edits: (1) **extract** the response-normalization tail into a reusable `normalizeResponse`
helper, and (2) add a streaming branch in `chat()`.

**Current normalization tail to EXTRACT (lines 326-363)** — this is what the new helper must
reproduce byte-for-byte:

```ts
    const { text, toolCalls } = normalizeContent(response.content);        // line 326

    const usage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };

    const costUsd = estimateCostUsd({ provider: "anthropic", model, usage });  // line 336

    if (structured) {                                                      // line 343
      const forced = toolCalls.find((tc) => tc.name === "structured_output");
      if (forced !== undefined) {
        return {
          text: JSON.stringify(forced.input),
          toolCalls: [],
          stopReason: "end",
          usage,
          ...(costUsd !== undefined ? { costUsd } : {}),
        };
      }
    }

    return {
      text,
      toolCalls,
      stopReason: normalizeStopReason(response.stop_reason),              // line 359
      usage,
      ...(costUsd !== undefined ? { costUsd } : {}),
    };
```

**Extract to a module-level helper** (place it in the "Conversion helpers" region near
`normalizeContent` at lines 52-74, so it is reusable by both branches). Note: `response` in both
the `create()` result and the stream's `finalMessage()` result is an `Anthropic.Messages.Message`
(same `.content` / `.stop_reason` / `.usage` shape — see §2.4), so a single signature works:

```ts
function normalizeResponse(
  response: Anthropic.Messages.Message,
  model: string,
  structured: boolean,
): ChatResponse {
  // ...body copied EXACTLY from lines 326-362 above (costUsd spread stays so the
  // key is ABSENT, not `undefined`, when unpriced — sc-2-3 regression)...
}
```

**The request-assembly + SDK call to branch (lines 226-324):** `chat()` destructures params at
line 227, builds `anthropicMessages` (map `toAnthropicMessage`), injects `documents` blocks
(238-268), computes the `structured` branch + `forcedTool` + `anthropicTools` (275-293), applies
prompt-caching (`cachedSystem`/`cachedMessages`, 300-307), then calls:

```ts
    const response = await this.client.messages.create({                  // line 309
      model,
      max_tokens: maxTokens,
      system: cachedSystem,
      messages: cachedMessages,
      tools: anthropicTools,
      ...(effort !== undefined ? { output_config: { effort } } : {}),
      ...(structured ? { tool_choice: { type: "tool" as const, name: "structured_output" } } : {}),
    });
```

**Change:** extract that object literal to a `const requestBody = { ... }` (build it ONCE), then
branch on `params.onTextDelta`:

```ts
    // NON-STREAM PATH (unchanged, byte-identical when onTextDelta absent):
    if (params.onTextDelta === undefined) {
      const response = await this.client.messages.create(requestBody);
      return normalizeResponse(response, model, structured);
    }

    // STREAM PATH (onTextDelta set):
    const stream = this.client.messages.stream(requestBody);
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        try {
          params.onTextDelta(event.delta.text);
        } catch {
          // A throwing consumer must NOT kill the request (contract: wrap in try/catch).
        }
      }
    }
    const message = await stream.finalMessage();
    return normalizeResponse(message, model, structured);
```

`params.onTextDelta` is destructured from `params` at line 227 today only for the named fields —
you can keep referencing `params.onTextDelta` directly (as `params.documents` is used at 238).
See §2.4 for why iterate-then-`finalMessage()` is the recommended, most-testable surface, and §5
for the exact mock recipe.

**Imports this file uses (lines 1-12):** `Anthropic` (default), the provider-agnostic types, and
`estimateCostUsd` from `./cost-meter.js`. No new import is needed — `MessageStream`/`TextDelta`
types are reached via the `Anthropic.Messages.*` namespace already imported. **Keep all SDK types
inside this file** (principles.md:28 — never leak SDK types outside adapter files).

**Imported by:** `factory.ts`, `preflight.ts`, and the loop indirectly (via the `LLMClient`
interface). **Test file:** `src/providers/anthropic.test.ts` (exists).

---

### `src/providers/anthropic.test.ts` (modify)

Extend the existing SDK mock to add a `stream` method. See §5 for the full recipe. The mock
factory today (lines 28-34) exposes only `create`.

---

### `src/orchestrator/agentic-loop.ts` (modify)

**Add `onTextDelta` to `AgenticLoopParams`** — near `onEvent?` at line 85 (same doc-comment style):

```ts
  /**
   * Optional streaming text callback (sprint 8). Threaded into every chat call
   * as ChatParams.onTextDelta; the Anthropic adapter invokes it per text delta.
   * When onEvent is ALSO present, each delta additionally emits a
   * { type:"text-delta", turn, delta } LoopEvent. Absent (and no onEvent) => no
   * onTextDelta reaches chat, the adapter uses non-streaming create, byte-identical.
   */
  onTextDelta?: (delta: string) => void;
```

**Destructure it** in `runAgenticLoop` (add to the block at lines 323-345, alongside `onEvent`).

**Build a per-turn combined delta callback and thread it into the chat params.** The chat call is
assembled inside the `for` loop at lines 426-437 (the `effort` spread is the pattern to copy at
line 434). Define the wrapper INSIDE the loop so it captures the current `turn`:

```ts
  // inside the `for (let turn...)` body, before chatWithRetry:
  const emitTextDelta =
    onTextDelta !== undefined || onEvent !== undefined
      ? (delta: string): void => {
          safeEmit({ type: "text-delta", turn, delta }); // has its own try/catch (lines 393-401)
          onTextDelta?.(delta);                           // adapter wraps this in try/catch
        }
      : undefined;
```

Then extend the chat params object (lines 428-436) with a spread that keeps the key ABSENT when the
wrapper is undefined (byte-identical guard — mirrors the `effort` spread at line 434):

```ts
        {
          model,
          system: systemPrompt,
          messages,
          tools: tools.length > 0 ? tools : undefined,
          maxTokens,
          ...(effort !== undefined ? { effort } : {}),
          ...(emitTextDelta ? { onTextDelta: emitTextDelta } : {}),   // NEW
        },
```

Order matters: emit the LoopEvent FIRST (`safeEmit` self-catches), then call the caller's
`onTextDelta`. That way a throwing caller callback (caught by the adapter's try/catch) does not
suppress the loop event.

**Do NOT touch the compaction block (lines 479-522).** `summarizeMessages` builds its own params
(see below) so it naturally never streams — recommended and correct.

**`chatWithRetry` semantics stay unchanged (lines 195-220).** Streaming happens INSIDE the adapter;
a mid-stream SSE error propagates as a thrown `Error` out of `chat()` exactly like `create()`
throwing today, so `chatWithRetry`'s `isTransientError(err.message)` classification (patterns at
lines 164-181) applies identically. You do not modify `chatWithRetry`.

**Test file:** `src/orchestrator/agentic-loop.test.ts` (exists).

---

### `src/orchestrator/agentic-loop.test.ts` (modify)

Add sc-8-4 coverage using the existing `ScriptedLoopClient` (lines 22-34) extended to record
`onTextDelta` receipt, plus the `onEvent`-collection pattern (lines 514-528). See §6.

---

### `src/orchestrator/loop-events.ts` (modify)

**Un-reserve `text-delta`.** The name is currently RESERVED-only via a comment (lines 28-34) and is
the last remaining reserved name. Add the member to the `LoopEvent` union (lines 35-51) and delete
the "do NOT emit it this sprint" note:

```ts
export type LoopEvent =
  | { type: "init"; model: string; maxTurns: number }
  | { type: "turn-start"; turn: number }
  | { type: "text-delta"; turn: number; delta: string }   // NEW (was reserved, lines 28-34)
  | { type: "tool-start"; turn: number; name: string; input: unknown; toolUseId: string }
  // ...rest unchanged...
```

**Imported by:** `agentic-loop.ts` (line 14). **Test file:** covered by `agentic-loop.test.ts`.

---

## 2. Installed SDK Streaming Surface (@anthropic-ai/sdk 0.100.1)

Verified against `node_modules/@anthropic-ai/sdk` (package.json version `0.100.1`).

### 2.1 The stream entry point — USE `client.messages.stream(body)`

**`resources/messages/messages.d.ts:74`:**
```ts
stream<Params extends MessageStreamParams>(body: Params, options?: RequestOptions): MessageStream<...>;
```
`.stream()` is the high-level HELPER (accumulates the final message for you). The `body` is the
SAME object you pass to `create()` — no `stream: true` flag needed. Build `requestBody` once and
pass it to either `create(requestBody)` or `stream(requestBody)`.

(There is also `create({..., stream: true})` returning a raw `Stream<RawMessageStreamEvent>` —
`messages.d.ts:32` — but it does NOT auto-accumulate a final message. Prefer `.stream()`.)

### 2.2 `MessageStream` is BOTH an async-iterable of raw events AND a helper

**`lib/MessageStream.d.ts:22`:** `class MessageStream implements AsyncIterable<MessageStreamEvent>`
with `[Symbol.asyncIterator](): AsyncIterator<MessageStreamEvent>` at `MessageStream.d.ts:118`.

Key members:
- **`finalMessage(): Promise<ParsedMessage<ParsedT>>`** — `MessageStream.d.ts:108`. Resolves with
  the full accumulated assistant `Message` (`.content`, `.stop_reason`, `.usage`). **"rejects if an
  error occurred or the stream ended prematurely."** This is your normalization source.
- `finalText(): Promise<string>` — `MessageStream.d.ts:114` (concatenated text; not needed since
  `normalizeContent` walks the blocks).
- Typed `.on(event, cb)` listeners — `MessageStream.d.ts:74`; notably `text: (textDelta, snapshot)`
  at `MessageStream.d.ts:9`, and `error: (error) => void` at `MessageStream.d.ts:17`. (Event-based
  approach is harder to mock deterministically than the async-iterator approach — prefer iterating.)

### 2.3 The raw stream events (what you iterate)

`MessageStreamEvent = RawMessageStreamEvent` (`messages.d.ts:1933`), a union
(`messages.d.ts:916`) of:
- **`RawContentBlockDeltaEvent`** (`messages.d.ts:855-861`): `{ type: 'content_block_delta';
  index: number; delta: RawContentBlockDelta }`.
  - `RawContentBlockDelta = TextDelta | InputJSONDelta | CitationsDelta | ThinkingDelta |
    SignatureDelta` (`messages.d.ts:854`).
  - **`TextDelta`** (`messages.d.ts:1028-1031`): `{ type: 'text_delta'; text: string }` — the ONLY
    delta you forward to `onTextDelta`. Guard `event.delta.type === "text_delta"` to skip
    `input_json_delta` (tool args) / `thinking_delta`.
- `RawMessageDeltaEvent` (`messages.d.ts:872-892`): carries `usage: MessageDeltaUsage` and
  `delta.stop_reason`. You do NOT need to read these manually — `finalMessage()` gives the complete
  totals.
- `RawMessageStartEvent`, `RawMessageStopEvent`, `RawContentBlockStartEvent`,
  `RawContentBlockStopEvent` — ignore.

### 2.4 The final accumulated message (normalization source)

`finalMessage()` returns a `Message` whose `usage: Usage` (`messages.d.ts:1525`) has
`input_tokens: number` and `output_tokens: number` — the **same field names** the non-streaming
path already reads at `anthropic.ts:329-330`. Its `.content` is `ContentBlock[]` (walk with the
existing `normalizeContent`) and `.stop_reason` feeds `normalizeStopReason`. This is exactly why a
single `normalizeResponse(message, model, structured)` helper works for BOTH paths and guarantees
sc-8-1's deep-equal.

### 2.5 How SSE errors surface (sc-8-5 parity)

A mid-stream error is thrown from the async iteration (`for await`) AND rejects `finalMessage()`
(`MessageStream.d.ts:108` docstring). Either way it propagates out of `chat()` as a thrown `Error`,
identical to `create()` rejecting. No special handling in the adapter — just DON'T swallow it. The
loop's `chatWithRetry` (agentic-loop.ts:195) then classifies it via `isTransientError`
(agentic-loop.ts:183). Note: do NOT wrap the `for await`/`finalMessage()` in a try/catch that
hides the error — only the per-delta `onTextDelta(...)` call is wrapped.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `normalizeContent` | `src/providers/anthropic.ts:55` | `(content: ContentBlock[]) => { text: string; toolCalls: ToolCall[] }` | Walks content blocks → text + tool_use calls. Reuse in `normalizeResponse` (already used at line 326). |
| `normalizeStopReason` | `src/providers/anthropic.ts:33` | `(reason) => StopReason` | Maps `end_turn`/`tool_use`/`max_tokens`/`refusal`. Reuse in `normalizeResponse`. |
| `estimateCostUsd` | `src/providers/cost-meter.ts:86` | `({ provider, model, usage }) => number \| undefined` | Static-table USD estimate; returns `undefined` for unpriced models (key must stay ABSENT). |
| `toAnthropicMessage` | `src/providers/anthropic.ts:85` | `(message: Message) => Anthropic.Messages.MessageParam` | Message→SDK conversion (already called at line 231; do not touch). |
| `toAnthropicTool` | `src/providers/anthropic.ts:22` | `(tool: ToolDef) => Anthropic.Messages.Tool` | Tool conversion (already used). |
| `chatWithRetry` | `src/orchestrator/agentic-loop.ts:195` | `(client, params, turn) => Promise<ChatResponse>` | Exponential-backoff retry wrapper. UNCHANGED — streaming lives in the adapter. |
| `isTransientError` | `src/orchestrator/agentic-loop.ts:183` | `(message: string) => boolean` | Transient-vs-fatal classification (patterns 164-181). Governs sc-8-5 parity. |
| `safeEmit` | `src/orchestrator/agentic-loop.ts:393` | `(event: LoopEvent) => void` | Emits a LoopEvent, swallow-and-log on throw. Reuse for the new `text-delta` event. |
| `summarizeMessages` | `src/orchestrator/compaction.ts:85` | `(params) => Promise<CompactionOutcome \| undefined>` | Builds its OWN chat params at line 93 (`{ model, system, messages, maxTokens }`) — no `onTextDelta`, so it naturally never streams. Leave as-is. |

Utilities reviewed: `src/utils/` (logger only, already imported), `src/providers/` (above),
`src/orchestrator/` (above). No new helper is needed beyond the extracted `normalizeResponse`.

---

## 4. Prior Sprint Output

### Sprint 5: Structured event stream + hooks (`dependsOn`)
**Created/extended:** `src/orchestrator/loop-events.ts` — the `LoopEvent` union and `safeEmit`
wiring. The `text-delta` name was RESERVED here (loop-events.ts:28-34) specifically for THIS sprint.
**Connection:** you add the `text-delta` member to that union and emit it via the existing
`safeEmit` (agentic-loop.ts:393). The event-emission ORDER contract and swallow-on-throw behavior
(sc-5-4) are already established — reuse them, do not invent a parallel channel.

### Sprints 1-2: anthropic.ts refusal + costUsd
**Modified:** `src/providers/anthropic.ts` — `normalizeStopReason` gained the explicit `refusal`
case (lines 43-46), and `costUsd` is spread into BOTH return sites so the key is absent when
unpriced (lines 336, 351, 361). **Connection:** your extracted `normalizeResponse` MUST preserve
both behaviors verbatim — the refusal case and the `...(costUsd !== undefined ? { costUsd } : {})`
spread. anthropic.test.ts already asserts these (lines 443-459, 486-501).

### Sprint 7: in-context compaction
**Created:** `src/orchestrator/compaction.ts` — `summarizeMessages` makes ONE internal
`client.chat` call (line 93) with its own minimal params. **Connection:** confirm (and it holds)
that this internal call receives NO `onTextDelta` — the internal summarizer should never stream to
the end user. No change needed.

---

## 5. Anthropic Adapter Test Pattern (sc-8-1, sc-8-2, sc-8-5)

**Runner:** vitest. **Assertion:** `expect`. **Mock approach:** top-level hoisted
`vi.mock("@anthropic-ai/sdk")` returning `{ default: FakeAnthropic }` (static default import).
**Location:** co-located `*.test.ts`.

**Current mock (anthropic.test.ts:25-34)** exposes only `create`:
```ts
const createMock = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { create: createMock };
    constructor(_opts?: unknown) {}
  }
  return { default: FakeAnthropic };
});
```

**Extend it** by adding a `stream` method to the fake `messages` object:
```ts
const createMock = vi.fn();
const streamMock = vi.fn();                       // NEW
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { create: createMock, stream: streamMock };   // add stream
    constructor(_opts?: unknown) {}
  }
  return { default: FakeAnthropic };
});
```

**Fake stream helper** — shape it to match the two surfaces the adapter touches (async-iterable of
raw events + `finalMessage()`), so NO network is hit:
```ts
function fakeStream(
  deltas: string[],
  finalMsg: { content: unknown[]; stop_reason: string; usage: { input_tokens: number; output_tokens: number } },
) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const text of deltas) {
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } };
      }
    },
    finalMessage: async () => finalMsg,
  };
}
```

**sc-8-1 (delta join == final text, response deep-equal to non-stream):**
```ts
it("streams text deltas whose join equals text; response matches non-streaming", async () => {
  const finalMsg = { content: [{ type: "text", text: "Hello world" }],
                     stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 7 } };
  streamMock.mockReturnValue(fakeStream(["Hello", " world"], finalMsg));
  createMock.mockResolvedValue(finalMsg);           // same underlying content

  const adapter = new AnthropicAdapter("k", { promptCaching: false });
  const seen: string[] = [];
  const streamed = await adapter.chat({ model: "claude-x", system: "S",
    messages: [{ role: "user", content: "hi" }], onTextDelta: (d) => seen.push(d) });
  const plain = await adapter.chat({ model: "claude-x", system: "S",
    messages: [{ role: "user", content: "hi" }] });

  expect(seen.join("")).toBe(streamed.text);
  expect(streamed).toEqual(plain);                  // deep-equal: stopReason, toolCalls, usage, costUsd
});
```

**sc-8-2 (tool_use streaming parity):** set `finalMsg.content` to include a `tool_use` block
(`{ type: "tool_use", id: "t1", name: "search", input: { q: 1 } }`) with `stop_reason: "tool_use"`;
assert `streamed.toolCalls` equals the non-streaming normalization (the async iterator yields no
`text_delta`, so `onTextDelta` is never called — that's correct).

**sc-8-5 (mid-stream error parity):** make the iterator throw after a partial delta AND/OR
`finalMessage` reject; assert `adapter.chat(...)` rejects with that error (adapter must not swallow):
```ts
function erroringStream(msg: string) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "par" } };
      throw new Error(msg);            // e.g. "overloaded" (transient) or "401 unauthorized" (fatal)
    },
    finalMessage: async () => { throw new Error(msg); },
  };
}
// expect(adapter.chat({ ..., onTextDelta: () => {} })).rejects.toThrow(msg);
```
Also add a "throwing consumer does not kill the request" test: `onTextDelta: () => { throw new
Error("boom"); }` — the call still resolves to the normalized response.

**sc-8-4 spy (streaming branch NOT taken without callback):** after a plain `adapter.chat(...)`
with no `onTextDelta`, assert `expect(streamMock).not.toHaveBeenCalled()` and
`expect(createMock).toHaveBeenCalled()`.

Remember `beforeEach` must `streamMock.mockReset()` alongside the existing `createMock.mockReset()`
(anthropic.test.ts:52-55).

---

## 6. Loop Test Pattern (sc-8-4)

**`ScriptedLoopClient` (agentic-loop.test.ts:22-34)** already records `lastParams`. Extend a fake to
capture the `onTextDelta` it received and INVOKE it (simulating an adapter that streams), so the
loop's event emission + threading can be asserted:

```ts
class DeltaRecordingClient implements LLMClient {
  received: (typeof Function.prototype | undefined)[] = [];
  async chat(params: ChatParams): Promise<ChatResponse> {
    this.received.push(params.onTextDelta);
    params.onTextDelta?.("a");           // simulate the adapter emitting deltas
    params.onTextDelta?.("b");
    return { text: "ab", toolCalls: [], stopReason: "end", usage: { inputTokens: 1, outputTokens: 1 } };
  }
}
```

**onEvent collection pattern (agentic-loop.test.ts:514-528):**
```ts
const events: LoopEvent[] = [];
const deltas: string[] = [];
await runAgenticLoop({
  client: new DeltaRecordingClient(), model: "m", systemPrompt: "s", userMessage: "u",
  tools: [], toolHandlers: new Map(), maxTurns: 1,
  onTextDelta: (d) => deltas.push(d),
  onEvent: (e) => events.push(e),
});
expect(deltas).toEqual(["a", "b"]);
expect(events.filter((e) => e.type === "text-delta")).toEqual([
  { type: "text-delta", turn: 1, delta: "a" },
  { type: "text-delta", turn: 1, delta: "b" },
]);
```

**Byte-identical guard (no callback):** the existing `ScriptedLoopClient` never sets/invokes
`onTextDelta`. Add a test asserting that with neither `onTextDelta` nor `onEvent`, the params reaching
`chat()` have NO `onTextDelta` key: `expect("onTextDelta" in client.lastParams!).toBe(false)`. The
paired deep-equal pattern for byte-identical runs is at lines 802-840 (sc-5-5) — reuse it.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/providers/anthropic.ts` (self, refactor) | extracting `normalizeResponse` | medium | The `create()` (non-stream) path MUST stay byte-identical: refusal case, structured branch, costUsd-absent-when-unpriced. anthropic.test.ts (18 cases) must all still pass. |
| `src/providers/openai.ts`, `openai-compat.ts`, `google.ts`, `claude-code.ts` | `ChatParams` (add field) | low | Each destructures only named fields (openai.ts:400, google.ts:326-333, claude-code.ts:108) and never forwards unknown fields onto the wire. Adding an optional field is inert. Add ONE no-op comment line per §8-item-3. |
| `src/orchestrator/agentic-loop.ts` (self) | new param + chat spread | medium | The `...(emitTextDelta ? {...} : {})` spread must keep the key absent when unset (byte-identical). `chatWithRetry` untouched. |
| `src/orchestrator/compaction.ts` | `ChatParams` | low | Internal `client.chat` at line 93 must NOT gain `onTextDelta` (it doesn't — builds its own literal). No change. |
| `src/orchestrator/loop-events.ts` (self) | union widen | low | Adding a union member is additive; existing exhaustive switches (if any) must handle it — grep for `switch` over `event.type`. |
| `src/providers/structured.ts` | `ChatParams` | low | Uses `client.chat`; adding an optional field is inert. |

### Existing Tests That Must Still Pass
- `src/providers/anthropic.test.ts` — 18 cases covering caching (C1-C3), effort, mid_conv_system,
  structured output, refusal (443-459), costUsd (463-526). The `normalizeResponse` extraction must
  not alter ANY of these. Highest-priority regression guard.
- `src/orchestrator/agentic-loop.test.ts` — ~40 cases incl. the sc-5-5 byte-identical paired-run
  (802-840), event-order (514-549), compaction (1144-1300). Verify the new spread does not perturb
  the params-shape assertions or event ordering.
- `src/orchestrator/loop-events.test.ts` (if present) — verify the widened union still type-checks.
- Full suite is 3843 green today; target 3843 + new cases, 0 regressions.

### Features That Could Be Affected
- **Prompt caching / effort / documents / structured output** — all share the anthropic.ts
  request-assembly you are refactoring. The `requestBody` extraction must include EVERY current key
  (`system: cachedSystem`, `messages: cachedMessages`, `tools`, `output_config`, `tool_choice`) so
  both `create()` and `stream()` send an identical payload. Verify via the existing caching/effort/
  structured tests (they assert `createMock.mock.calls[0][0]` shape).
- **Compaction (sprint 7)** — must NOT stream (internal call). Confirmed no-op.

### Recommended Regression Checks (run after implementation)
1. `npm run typecheck` (tsc --noEmit) — catches SDK-type friction on `stream(requestBody)` (§9).
2. `npm run build` (tsc) — sc-8-6.
3. `npx vitest run src/providers/anthropic.test.ts` — non-stream parity + new streaming cases.
4. `npx vitest run src/orchestrator/agentic-loop.test.ts` — threading, event emission, byte-identical.
5. `npx vitest run` — FULL suite (sc-8-4 requires full-suite green).

---

## 8. Implementation Sequence (dependency-ordered)

1. **`src/orchestrator/loop-events.ts`** — add `| { type: "text-delta"; turn: number; delta: string }`
   to the `LoopEvent` union (lines 35-51); delete the reserved-only comment (28-34).
   - Verify: `npm run typecheck` still passes; the union is consumed in agentic-loop.ts.
2. **`src/providers/types.ts`** — add `onTextDelta?: (delta: string) => void` to `ChatParams`
   (after line 208) with the doc comment.
   - Verify: `npm run typecheck` — every adapter still compiles (optional field is inert).
3. **Other adapters (no-op documentation)** — add ONE comment line in each `chat()` noting the field
   is accepted and never invoked (nothing extra on the wire): `openai.ts:399`, `openai-compat.ts:59`,
   `google.ts:326`, `claude-code.ts:107`. No behavioral code.
   - Verify: `npm run typecheck`; these adapters never destructure/forward `onTextDelta`.
4. **`src/providers/anthropic.ts`** — (a) extract `normalizeResponse(response, model, structured)`
   from lines 326-362; (b) extract the request literal to `const requestBody`; (c) add the
   `params.onTextDelta === undefined` create-vs-stream branch (§1).
   - Verify: `npx vitest run src/providers/anthropic.test.ts` (existing 18 cases green BEFORE adding
     new ones).
5. **`src/providers/anthropic.test.ts`** — add `streamMock`, `fakeStream`, `erroringStream`; add
   sc-8-1/8-2/8-5 + throwing-consumer + spy cases; add `streamMock.mockReset()` to `beforeEach`.
   - Verify: `npx vitest run src/providers/anthropic.test.ts` all green.
6. **`src/orchestrator/agentic-loop.ts`** — add `onTextDelta` to `AgenticLoopParams` (near line 85)
   + destructure (323-345) + per-turn `emitTextDelta` wrapper + spread into chat params (428-436).
   - Verify: `npx vitest run src/orchestrator/agentic-loop.test.ts` (existing green).
7. **`src/orchestrator/agentic-loop.test.ts`** — add sc-8-4 threading + event-emission + byte-identical
   cases (§6).
   - Verify: `npx vitest run src/orchestrator/agentic-loop.test.ts` green.
8. **Run full verification** — `npm run build`, `npm run typecheck`, `npx vitest run` (full 3843+ suite).

---

## 9. Pitfalls & Warnings

- **Do NOT duplicate the normalization logic.** The whole point of sc-8-1's deep-equal is the SHARED
  `normalizeResponse`. Copy-pasting the tail into the streaming branch risks divergence (e.g.
  forgetting the `costUsd`-absent spread → sc-2-3 regression, or the refusal case → sc-1-1 regression).
- **Keep the `costUsd` spread, not `costUsd: undefined`.** anthropic.test.ts:486-501 asserts
  `Object.hasOwn(result, "costUsd") === false` for unpriced models. The extracted helper must keep
  `...(costUsd !== undefined ? { costUsd } : {})` in BOTH returns.
- **`stream()` needs NO `stream: true` flag.** It is the accumulating helper. Passing `stream: true`
  is for the low-level `create()` overload (a different return type). Build ONE `requestBody` (no
  `stream` key) and pass it to whichever method.
- **Possible typecheck friction on the shared `requestBody`.** `create(body)` wants
  `MessageCreateParamsBase`; `stream(body)` wants `MessageStreamParams`. An object literal WITHOUT a
  `stream` key satisfies both. If TS complains after you extract it to a `const`, do NOT add
  `stream:` — instead let inference stand, or annotate `const requestBody: Anthropic.Messages.MessageCreateParams = {...}`. Keep the literal identical to today's inline object (lines 310-323).
- **Only forward `text_delta`.** Guard `event.delta.type === "text_delta"`. `input_json_delta`
  (tool args), `thinking_delta`, `citations_delta`, `signature_delta` also flow through
  `content_block_delta` — forwarding them would corrupt the delta stream (sc-8-1 join would not
  equal `text`).
- **Do not swallow the stream error.** Only the per-delta `params.onTextDelta(...)` call is wrapped
  in try/catch. The `for await` loop and `finalMessage()` must let errors propagate so
  `chatWithRetry` (agentic-loop.ts:195) classifies them (sc-8-5). A try/catch around the whole
  stream would break retry parity.
- **Byte-identical spread in the loop.** Use `...(emitTextDelta ? { onTextDelta: emitTextDelta } : {})`
  — never `onTextDelta: emitTextDelta` unconditionally, or the no-callback path carries an
  `onTextDelta: undefined` key and diverges from the pre-change params shape (sc-8-4 spy + sc-5-5).
- **Keep SDK types inside anthropic.ts** (principles.md:28). `MessageStream`, `TextDelta`,
  `RawContentBlockDeltaEvent` must never appear in types.ts, loop-events.ts, or agentic-loop.ts.
  The loop only ever sees the provider-agnostic `(delta: string) => void`.
- **Structured + streaming is harmless but yields no text deltas.** With `responseSchema` set, the
  model emits `tool_use` (input_json_delta), so `onTextDelta` is simply never called; `finalMessage()`
  still carries the `structured_output` tool_use block and `normalizeResponse` stringifies it as
  before. Do not special-case this — branch on `onTextDelta` presence regardless of `structured`.
- **`emitTextDelta` must be defined INSIDE the turn loop** so it captures the current `turn` for the
  `text-delta` event payload. Defining it once outside would emit a stale/undefined turn.
