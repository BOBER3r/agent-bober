# Sprint Briefing: Add effort control via output_config.effort

**Contract:** sprint-spec-20260529-opus-4-8-support-3
**Generated:** 2026-05-29T16:15:18Z

> Sprint 3 of 4 in "Claude Opus 4.8 Support". Add an optional, provider-agnostic
> `effort` field to `ChatParams` and have the Anthropic adapter forward it as a
> top-level `output_config.effort`. When `effort` is unset, send **no**
> `output_config` (API default `high` applies on Opus 4.8). Non-anthropic
> adapters accept and ignore the field. Change is confined to `types.ts`,
> `anthropic.ts`, and `*.test.ts` (per stopCondition).

---

## 1. Target Files

### src/providers/types.ts (modify)

**Relevant section — the `ChatParams` interface (lines 114-128):**
```ts
/**
 * Parameters for a single LLM chat request.
 */
export interface ChatParams {
  /** Model identifier (resolved by the factory / model-resolver). */
  model: string;
  /** System prompt. */
  system: string;
  /** Conversation history. */
  messages: Message[];
  /** Tools available to the model for this request. */
  tools?: ToolDef[];
  /** Maximum tokens to generate. Defaults to 16384. */
  maxTokens?: number;
}
```

**Exact edit:** add a new optional field at the END of the interface, after
`maxTokens` (line 127), keeping the existing `/** ... */` one-line doc-comment
style used by every other field:

```ts
  /** Maximum tokens to generate. Defaults to 16384. */
  maxTokens?: number;
  /**
   * Reasoning/output effort level. Provider-agnostic; only the Anthropic
   * adapter forwards it (as output_config.effort). When unset, the provider
   * default applies (high on Opus 4.8). Other adapters ignore it.
   */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}
```
- Use the union `"low" | "medium" | "high" | "xhigh" | "max"` (NO `| null`; this
  is the provider-agnostic type — the SDK side allows `null` but our public API
  should not). This satisfies **C1**.
- Use double-quotes for string literals (file convention — see lines 97, 133).

**Imports this file uses:** none (pure type module, no imports at all).

**Imported by (every provider + public API):**
- `src/providers/anthropic.ts:3-11` (`import type { LLMClient, ChatParams, ... } from "./types.js"`)
- `src/providers/openai.ts:12-20`
- `src/providers/google.ts`
- `src/providers/openai-compat.test.ts`, `openai.test.ts`, `google.test.ts`, `anthropic.test.ts`
- `src/providers/factory.ts`, `src/providers/index.ts`, `src/index.ts`
- Because `effort` is **optional**, adding it is backward-compatible — no
  existing caller breaks.

**Test file:** `src/providers/types.ts` has no dedicated test file; it is
exercised indirectly through the adapter tests. No new test needed for types.ts
beyond typecheck (C1).

---

### src/providers/anthropic.ts (modify)

**Relevant section — `AnthropicAdapter.chat()` (lines 208-252).** The two
load-bearing parts are the destructure (line 209) and the `messages.create`
call (lines 233-239):

```ts
async chat(params: ChatParams): Promise<ChatResponse> {
  const { model, system, messages, tools, maxTokens = 16384 } = params;   // line 209

  // ...conversion of messages + tools (lines 211-217)...

  // ── Prompt caching branch ──────────────────────────────────────
  const cachedSystem: string | Anthropic.Messages.TextBlockParam[] =       // lines 224-227
    this.promptCaching && system !== undefined
      ? buildCachedSystem(system)
      : system;

  const cachedMessages = this.promptCaching                                // lines 229-231
    ? attachMessageBreakpoints(anthropicMessages)
    : anthropicMessages;

  const response = await this.client.messages.create({                     // lines 233-239
    model,
    max_tokens: maxTokens,
    system: cachedSystem,
    messages: cachedMessages,
    tools: anthropicTools,
  });
  // ...normalize + return (lines 241-251)...
}
```

**Exact edits (two changes only):**

1. Add `effort` to the destructure on **line 209**:
   ```ts
   const { model, system, messages, tools, maxTokens = 16384, effort } = params;
   ```

2. Conditionally spread `output_config` into the `messages.create` call
   (lines 233-239). The cleanest pattern that omits the key entirely when unset
   (matching the existing `...(oaiTools ? {...} : {})` style in openai.ts:316):
   ```ts
   const response = await this.client.messages.create({
     model,
     max_tokens: maxTokens,
     system: cachedSystem,
     messages: cachedMessages,
     tools: anthropicTools,
     ...(effort !== undefined ? { output_config: { effort } } : {}),
   });
   ```
   - Use `effort !== undefined` (not truthiness) — all five union members are
     truthy strings so `if (effort)` would also work, but `!== undefined` is
     explicit and future-proof. Either passes the tests.
   - This is **typed, no cast needed**: `MessageCreateParams.output_config?: OutputConfig`
     (SDK line 2052) and `OutputConfig.effort?: 'low'|'medium'|'high'|'xhigh'|'max'|null`
     (SDK line 829). Our union is a strict subset, so `{ effort }` assigns cleanly.

**CRITICAL — prompt-caching independence:** The `output_config` spread is on the
top-level `messages.create` object, completely separate from `cachedSystem` /
`cachedMessages`. It works identically whether `this.promptCaching` is true or
false — do NOT put it inside either branch. The existing caching tests (C3:
"zero cache_control anywhere") scan `JSON.stringify(req)` for `"cache_control"`;
`output_config`/`effort` contain no such substring, so they stay green.

**Imports this file uses (lines 1-11):**
- `Anthropic` (default) from `"@anthropic-ai/sdk"` — line 1 (SDK lock-in is
  allowed here; this is the only file permitted to import the SDK per principles)
- `import type { LLMClient, ChatParams, ChatResponse, ToolDef, ToolCall, StopReason, Message } from "./types.js"` — lines 3-11
- No new imports needed.

**Imported by:**
- `src/providers/factory.ts` (constructs `AnthropicAdapter`)
- `src/providers/index.ts`, `src/index.ts` (re-export)
- `src/providers/anthropic.test.ts` (`import { AnthropicAdapter } from "./anthropic.js"` — line 36)

**Test file:** `src/providers/anthropic.test.ts` — **exists** (modify, see §6).

---

### src/providers/anthropic.test.ts (modify — add effort tests)

See §6 for the full test templates. Add two `it(...)` blocks inside the existing
`describe("AnthropicAdapter prompt caching", ...)` block (after line 204, before
the closing `});` at line 205), or in a new `describe` — either is fine.

### src/providers/openai.test.ts (modify — add C4 test) — OPTIONAL but recommended

generatorNotes explicitly asks for "a test proving the OpenAI adapter still
returns normally when effort is passed" (C4). Add one `it(...)` to
`openai.test.ts`. Note the stopCondition says "confined to types.ts,
anthropic.ts, and the relevant *.test.ts files" — `openai.test.ts` IS a relevant
test file, so adding a C4 test there is in-scope.

---

## 2. Patterns to Follow

### Conditional key omission via spread
**Source:** `src/providers/openai.ts`, line 316 (inside `chat.completions.create`)
```ts
const response = await client.chat.completions.create({
  model: model || this.model,
  messages: oaiMessages,
  ...(oaiTools ? { tools: oaiTools } : {}),   // <-- omit `tools` entirely when undefined
  max_tokens: maxTokens,
});
```
**Rule:** To OMIT a key (not set it to `undefined`), spread a conditional object
literal: `...(cond ? { key: value } : {})`. Use this exact idiom for
`output_config` so C3 (no `output_config` when unset) passes a JSON-key scan.

### Destructure ChatParams with defaults at the top of chat()
**Source:** `src/providers/anthropic.ts`, line 209
```ts
const { model, system, messages, tools, maxTokens = 16384 } = params;
```
**Rule:** All adapters destructure the params they care about at the top of
`chat()`. Add `effort` to this list in anthropic.ts. Adapters that don't use a
field simply don't name it in their destructure (google.ts:266 destructures
`{ model, system, messages, tools, maxTokens: _maxTokens = 16384 }` — it never
names `effort`, so it's silently ignored — this is the C4 mechanism).

### Section comments
**Source:** `src/providers/types.ts:112`, `anthropic.ts:185`, principles.md:32
```ts
// ── Chat params / response ──────────────────────────────────────────
```
**Rule:** Use unicode box-drawing `// ── Name ──...` section headers. No new
section needed for this small change, but match existing comment style.

### Double-quoted string literals
**Source:** `src/providers/types.ts:97`, `:133`; `anthropic.ts` throughout
```ts
role: "user" | "assistant";
export type StopReason = "end" | "tool_use" | "max_tokens" | "error" | string;
```
**Rule:** Use double quotes for all string literals and union members.

---

## 3. Existing Utilities — DO NOT Recreate

There are no shared `utils/` helpers relevant to this sprint — it is a pure
type + adapter-payload change. The relevant existing helpers all live INSIDE
the adapter files and must NOT be re-created or modified:

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `toAnthropicTool` | `src/providers/anthropic.ts:21` | `(tool: ToolDef): Anthropic.Messages.Tool` | Convert ToolDef → Anthropic Tool. Untouched. |
| `normalizeStopReason` (anthropic) | `src/providers/anthropic.ts:32` | `(reason): StopReason` | Map Anthropic stop_reason → StopReason. Untouched. |
| `normalizeContent` | `src/providers/anthropic.ts:50` | `(content[]): { text; toolCalls }` | Extract text/toolCalls from content blocks. Untouched. |
| `toAnthropicMessage` | `src/providers/anthropic.ts:79` | `(message: Message): Anthropic.Messages.MessageParam` | Convert agnostic Message → MessageParam. Untouched. |
| `buildCachedSystem` | `src/providers/anthropic.ts:129` | `(system: string): TextBlockParam[]` | Wrap system in ephemeral cache block. Untouched. |
| `attachMessageBreakpoints` | `src/providers/anthropic.ts:143` | `(msgs[]): MessageParam[]` | Attach cache_control to last ≤3 msgs. Untouched. |
| `fakeResponse` (test helper) | `src/providers/anthropic.test.ts:40` | `(): { content; stop_reason; usage }` | Build a fake Anthropic response in tests. **Reuse this in your new tests.** |
| `makeFakeOpenAI` (test helper) | `src/providers/openai.test.ts:28` | `(createFn): class` | Fake OpenAI client class. Reuse for C4 test. |
| `makeOAIResponse` (test helper) | `src/providers/openai.test.ts:43` | `(opts): {...}` | Build fake OpenAI response. Reuse for C4 test. |
| `makeAdapter` (test helper) | `src/providers/openai.test.ts:84` | `async (model?) => OpenAIAdapter` | Re-imports openai.js after vi.doMock. Reuse for C4 test. |

**Do NOT add a new ChatParams subtype, a separate EffortConfig type, a Zod
schema, or a config field — those are explicit nonGoals/outOfScope.**

---

## 4. Prior Sprint Output

### Sprint 1: opus -> claude-opus-4-8
**Changed:** model-resolver only (mapped the `opus` alias to `claude-opus-4-8`).
**Connection:** None directly. The model string flows through `ChatParams.model`
unchanged. No code from this sprint is touched.

### Sprint 2: SDK upgrade to 0.100.1
**Changed:** `@anthropic-ai/sdk` bumped to `0.100.1`; adapter code unchanged.
**Connection — THIS is the enabler for sprint 3.** The upgraded SDK now types:
- `OutputConfig.effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null`
  at `node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts:825-835`
- `MessageCreateParams.output_config?: OutputConfig` at the same file, **line 2052**
  (also `MessageCreateParamsBase` at line 2305).
Both are optional, so `messages.create({ ..., output_config: { effort } })`
typechecks with **no cast**. Confirmed installed version `0.100.1` (verified via
`node_modules/@anthropic-ai/sdk/package.json`).

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
Directly relevant rules:
- **Provider-agnostic interfaces** (line 28): "All LLM interaction goes through
  `providers/types.ts` — provider-specific SDKs are wrapped by adapters... Never
  leak SDK types outside adapter files." → `effort` goes in `types.ts` as a plain
  union; `OutputConfig` (SDK type) is referenced only implicitly inside
  `anthropic.ts`. Do not import any SDK type into `types.ts`.
- **No SDK lock-in** (line 41): never import `@anthropic-ai/sdk` outside
  `anthropic.ts`. The new `effort` union must be hand-written, not
  `Anthropic.Messages.OutputConfig["effort"]`.
- **Use `type` imports** (line 35): ESLint `consistent-type-imports`. Existing
  imports already use `import type { ... }` — no new imports needed anyway.
- **Type safety** (line 18): strict mode, `noUnusedLocals`, `noUnusedParameters`.
  If you destructure `effort` in anthropic.ts you MUST use it (you will, in the
  spread) — an unused destructured var would error. Other adapters must NOT
  destructure `effort` (they'd trip `noUnusedLocals` / would need a `_` prefix);
  simplest is to leave their destructures untouched.
- **No `any`** (line 40): tests cast captured args to typed shapes
  (`as { ... }` / `as Record<string, unknown>`), never `any`. Follow that.
- **Tests collocated** (line 20): `*.test.ts` next to `*.ts`. Vitest.
- **Conventional commit** (line 34 / handoff): `bober(sprint-3): add effort control via output_config.effort`.

### Architecture Decisions
No `.bober/architecture/` directory or ADRs found relevant to this sprint.

### Other Docs
The doc-comment in `anthropic.test.ts:1-16` documents WHY a top-level
`vi.mock("@anthropic-ai/sdk")` is used (static default import) vs the
`vi.doMock`/dynamic-import pattern in openai.test.ts — read it before editing.

---

## 6. Testing Patterns

### Unit Test Pattern — Anthropic (static default-import mock)
**Source:** `src/providers/anthropic.test.ts:18-77`
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatParams } from "./types.js";

// Shared mock fn captures the arg passed to messages.create
const createMock = vi.fn();

// Static default-import mock (HOISTED by vitest). Factory returns { default: ... }
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { create: createMock };
    constructor(_opts?: unknown) {}
  }
  return { default: FakeAnthropic };
});

import { AnthropicAdapter } from "./anthropic.js";   // import AFTER vi.mock

function fakeResponse() {
  return { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 7 } };
}

beforeEach(() => {
  createMock.mockReset();
  createMock.mockResolvedValue(fakeResponse());
});

// Capture pattern: const req = createMock.mock.calls[0][0] as <shape>;
```
**Runner:** vitest. **Assertion style:** `expect(...).toBe / .toEqual / .toMatchObject`.
**Mock approach:** top-level hoisted `vi.mock("@anthropic-ai/sdk", () => ({ default: FakeAnthropic }))` with a shared `createMock`. **File naming:** `*.test.ts`, **collocated**.

**ADD these two tests** (inside the existing `describe`, after line 204):

```ts
// ── C2: effort set -> output_config.effort present with the value ──────
it("C2: forwards effort as output_config.effort when set", async () => {
  const adapter = new AnthropicAdapter("k", { promptCaching: true });
  await adapter.chat({
    model: "claude-x",
    system: "SYS",
    messages: [{ role: "user", content: "hi" }],
    effort: "max",
  } satisfies ChatParams);

  const req = createMock.mock.calls[0][0] as {
    output_config?: { effort?: string };
  };
  expect(req.output_config).toEqual({ effort: "max" });
});

// ── C3: effort unset -> NO output_config key anywhere in the request ───
it("C3: omits output_config entirely when effort is unset", async () => {
  const adapter = new AnthropicAdapter("k", { promptCaching: true });
  await adapter.chat({
    model: "claude-x",
    system: "SYS",
    messages: [{ role: "user", content: "hi" }],
  } satisfies ChatParams);

  const req = createMock.mock.calls[0][0] as Record<string, unknown>;
  expect(req).not.toHaveProperty("output_config");
  expect(JSON.stringify(req)).not.toContain("output_config");
});
```
Notes:
- Use `satisfies ChatParams` (existing convention, lines 64/87/106 etc.) so the
  new `effort` field is type-checked against the updated interface — this is a
  de-facto C1 check too.
- The unset test mirrors the existing C3 caching test's `JSON.stringify(req)`
  scan idiom (line 164) — robust against nested keys.
- Optionally also assert effort works with caching off (parallels C3-multi):
  `new AnthropicAdapter("k", { promptCaching: false })` + `effort: "low"` →
  `req.output_config` still `{ effort: "low" }`, proving caching-independence.

### Unit Test Pattern — OpenAI (dynamic-import mock, for C4)
**Source:** `src/providers/openai.test.ts:74-89`
```ts
beforeEach(() => {
  createFn = vi.fn();
  vi.doMock("openai", () => ({ default: makeFakeOpenAI(createFn) }));
});

async function makeAdapter(model = "gpt-4.1") {
  // cache-bust the dynamic import so the mock applies
  const { OpenAIAdapter } = await import("./openai.js?v=" + Date.now());
  return new OpenAIAdapter(model, "test-api-key");
}
```
**Mock approach:** `vi.doMock("openai", ...)` (NOT hoisted) + cache-busted
re-import — because openai.ts uses a runtime dynamic `import("openai")`.

**ADD this C4 test** to `openai.test.ts` (inside the main `describe("OpenAIAdapter", ...)`):
```ts
// ── C4: non-anthropic adapter accepts effort, ignores it, no error ─────
it("C4: accepts effort without error and never sends output_config", async () => {
  createFn.mockResolvedValue(makeOAIResponse({ content: "ok" }));

  const adapter = await makeAdapter();
  const result = await adapter.chat({
    model: "gpt-4.1",
    system: "sys",
    messages: [{ role: "user", content: "hi" }],
    effort: "max",
  } satisfies ChatParams);

  expect(result.text).toBe("ok");
  expect(result.stopReason).toBe("end");

  // effort must NOT leak into the OpenAI request
  const callArgs = createFn.mock.calls[0][0] as Record<string, unknown>;
  expect(callArgs).not.toHaveProperty("output_config");
  expect(callArgs).not.toHaveProperty("effort");
});
```
- `ChatParams` is already imported in openai.test.ts (line 16-22). The
  `satisfies ChatParams` proves the field is accepted at the type level; the
  passing `chat()` call proves no runtime error (C4).

### E2E Test Pattern
Not applicable — agent-bober is a CLI/library with no Playwright/E2E suite
(principles.md:48 "no user interface").

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/providers/openai.ts` | `types.ts` (ChatParams) | low | Adding an OPTIONAL field is backward-compatible; openai.ts never references `effort` → ignored. No edit needed to source. |
| `src/providers/google.ts` | `types.ts` (ChatParams) | low | Destructures `{ model, system, messages, tools, maxTokens: _maxTokens }` (line 266); never names `effort`. Unaffected. |
| `src/providers/factory.ts` | `types.ts`, `anthropic.ts` | low | Constructs adapters; does not build ChatParams payloads with effort. Unaffected. |
| `src/providers/index.ts`, `src/index.ts` | re-export types/adapters | low | Re-exports only; an added optional field is transparent. |
| `src/providers/anthropic.ts` (the target) | SDK 0.100.1 | low | New `output_config` spread is typed (SDK lines 829, 2052). Verify it sits on the top-level create object, not inside a caching branch. |

### Existing Tests That Must Still Pass (regressions if they break)
- `src/providers/anthropic.test.ts` — the 8 existing caching tests (C1, C1-default,
  C2, C2-edge, C3, C3-multi, normalisation). The C3 tests scan
  `JSON.stringify(req)` for `"cache_control"`. Your `output_config`/`effort`
  additions contain no `cache_control` substring → must stay green. When `effort`
  is unset (which all existing tests are), no `output_config` is added, so the
  payload shape for those tests is byte-identical to before.
- `src/providers/openai.test.ts` — all existing tests pass `ChatParams` without
  `effort`; an added optional field cannot break them.
- `src/providers/google.test.ts`, `src/providers/openai-compat.test.ts` — same
  reasoning; unaffected.
- `src/providers/factory.test.ts` (if present) — unaffected.

### Features That Could Be Affected
- **Prompt caching (sprint feat from earlier work)** — shares
  `anthropic.ts chat()`. Verify caching ON and OFF still behave identically;
  `output_config` is orthogonal to `cachedSystem`/`cachedMessages`.
- **Model resolution (sprint 1)** — shares `ChatParams.model`; untouched.

### Recommended Regression Checks (run after implementation)
1. `npm run typecheck` — exit 0 (C1; proves the union + the no-cast create call).
2. `npm run lint` — exit 0 (consistent-type-imports, no unused `effort`).
3. `npm run test -- src/providers/anthropic.test.ts` — all anthropic tests green,
   including the 2 new effort tests (C2, C3) AND the unchanged caching tests.
4. `npm run test -- src/providers/openai.test.ts` — all green incl. new C4 test.
5. `npm run build` — exit 0 (C5).
6. `npm run test` (full suite) — only the documented flaky baseline may fail
   (see §9). Any NEW failure, especially in `src/providers/`, is a regression.

---

## 8. Implementation Sequence

1. **src/providers/types.ts** — add the optional `effort` union field to the END
   of the `ChatParams` interface (after `maxTokens`, line 127) with a doc-comment.
   - Verify: `npm run typecheck` still exits 0 (no other code references it yet).
2. **src/providers/anthropic.ts** — (a) add `effort` to the destructure (line 209);
   (b) add `...(effort !== undefined ? { output_config: { effort } } : {})` to the
   top-level `messages.create({...})` object (lines 233-239).
   - Verify: `npm run typecheck` exits 0 (proves SDK types accept it, no cast);
     `npm run lint` exits 0 (effort is now used, no unused-var error).
3. **src/providers/anthropic.test.ts** — add the C2 (set) and C3 (unset) tests
   inside the existing `describe` block (after line 204).
   - Verify: `npm run test -- src/providers/anthropic.test.ts` — all green.
4. **src/providers/openai.test.ts** — add the C4 test proving the OpenAI adapter
   accepts `effort` and returns normally without leaking it.
   - Verify: `npm run test -- src/providers/openai.test.ts` — all green.
5. **Run full verification** — `npm run build` (exit 0), `npm run typecheck`
   (exit 0), `npm run lint` (exit 0), `npm run test` (only flaky baseline fails).
6. **Commit** — `bober(sprint-3): add effort control via output_config.effort`.

---

## 9. Pitfalls & Warnings

- **DO NOT include `| null` in the public `effort` union.** The SDK's
  `OutputConfig.effort` allows `null`, but the contract/C1 specifies
  `'low' | 'medium' | 'high' | 'xhigh' | 'max'`. The SDK accepts the narrower
  type fine (subset of its own union).
- **DO NOT set `output_config: undefined`.** Setting the key to `undefined`
  would make `JSON.stringify` drop it (so the C3 string-scan passes) BUT
  `expect(req).not.toHaveProperty("output_config")` would FAIL because the key
  exists with value `undefined`. Use the conditional-spread idiom so the key is
  truly absent. The C3 test above uses `not.toHaveProperty` deliberately to catch
  this mistake.
- **DO NOT put the `output_config` spread inside a prompt-caching branch.** It
  must be a sibling of `system`/`messages`/`tools` on the top-level
  `messages.create` object so it works with caching on OR off.
- **DO NOT modify `openai.ts` / `google.ts` source.** They ignore unknown
  ChatParams fields by simply not destructuring them. Adding `effort` to their
  destructures would trigger `noUnusedLocals`/`consistent-type-imports` churn for
  no benefit and violates the stopCondition (change confined to types.ts,
  anthropic.ts, *.test.ts).
- **DO NOT cast in anthropic.ts.** SDK 0.100.1 types `output_config` (lines 829,
  2052) — `as any` / `as OutputConfig` would trip `no-explicit-any` warnings and
  is unnecessary. The handoff confirms "no cast needed."
- **Import order in anthropic.test.ts matters.** The static `vi.mock(...)` block
  is hoisted, and `import { AnthropicAdapter } from "./anthropic.js"` must come
  AFTER it (line 36). Add your new tests inside the existing `describe`; do not
  add new imports of the SDK.
- **`ChatParams` import in openai.test.ts already exists** (lines 16-22) — reuse
  it; do not re-import.
- **Tolerated flaky baseline (NOT regressions):** the 2 flaky "37-tool-count"
  tests, and occasionally `disk.test.ts` (a race that passes in isolation). ANY
  other failure — especially in `src/providers/` — is a real regression to fix.
- **Conventional commit format is exact:** `bober(sprint-3): add effort control via output_config.effort`.
