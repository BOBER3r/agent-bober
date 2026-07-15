# Sprint Briefing: Anthropic prompt caching behind a default-on flag

**Contract:** sprint-spec-20260529-anthropic-prompt-caching-1
**Generated:** 2026-05-29T13:51:44Z

> Goal: add ephemeral `cache_control` breakpoints to `AnthropicAdapter` using a
> "system-and-last-3" strategy (capped at 4 breakpoints total), gated by a
> `promptCaching` flag the factory resolves from per-role `providerConfig` and
> defaults to `true` for the anthropic provider. No-op for other providers.
> Verified against a mocked `@anthropic-ai/sdk` — no live API calls.

---

## 0. Ground Truth (read these first)

- **SDK:** `@anthropic-ai/sdk` declared `^0.39.0`, **installed 0.39.0** (`package.json`). Confirmed below to expose `cache_control`.
- **Scripts** (`package.json`): `build` = `tsc`, `test` = `vitest`, `typecheck` = `tsc --noEmit`, `lint` = `eslint src/`.
- **BASELINE (do not "fix"):** before this sprint, typecheck/lint/build PASS; `npm run test` has exactly **2 pre-existing, provider-unrelated failures**: `tests/mcp/external-server-graph.test.ts` ("registers exactly 37 tools") and `src/orchestrator/checkpoints/mechanisms/disk.test.ts` ("deletes pending file after approval"). These are the ONLY allowed failures (C7). Any new failure, or any failure under `src/providers/`, is a real regression.
- **Isolation rule (evaluator will grep):** after this sprint, `grep -rn cache_control src/providers` must match ONLY `anthropic.ts` and `anthropic.test.ts`. `openai.ts`, `google.ts`, `openai-compat.ts` must be byte-unchanged.

---

## 1. Target Files

### `src/providers/anthropic.ts` (modify)

Two insertion points: the **constructor** (line 136-138) and **chat()** (lines 140-170). You will also touch `toAnthropicMessage` indirectly (see GOTCHA).

**Constructor today (lines 133-138):**
```ts
export class AnthropicAdapter implements LLMClient {
  private readonly client: Anthropic;

  constructor(apiKey?: string) {
    this.client = new Anthropic({ apiKey });
  }
```
Change to add an optional 2nd arg storing `promptCaching` (default `true`):
```ts
export class AnthropicAdapter implements LLMClient {
  private readonly client: Anthropic;
  private readonly promptCaching: boolean;

  constructor(apiKey?: string, opts?: { promptCaching?: boolean }) {
    this.client = new Anthropic({ apiKey });
    this.promptCaching = opts?.promptCaching ?? true;
  }
```

**chat() today (lines 140-170) — the request build is what changes:**
```ts
  async chat(params: ChatParams): Promise<ChatResponse> {
    const { model, system, messages, tools, maxTokens = 16384 } = params;

    const anthropicMessages: Anthropic.Messages.MessageParam[] =
      messages.map(toAnthropicMessage);

    const anthropicTools =
      tools && tools.length > 0 ? tools.map(toAnthropicTool) : undefined;

    const response = await this.client.messages.create({
      model,
      max_tokens: maxTokens,
      system,                    // <-- plain string today
      messages: anthropicMessages,
      tools: anthropicTools,
    });
    // ...normalizeContent / normalizeStopReason / usage unchanged...
  }
```
**What to change in chat():** when `this.promptCaching` is true, build `system` as a `TextBlockParam[]` carrying `cache_control` and attach a `cache_control` breakpoint to the final content block of the most-recent message(s). When false, keep `system` as the plain string and emit ZERO `cache_control` fields (byte-identical to today). Do NOT change `model`, `max_tokens`, tool conversion, or response normalization (lines 159-169).

**GOTCHA (most-recent message caching):** `toAnthropicMessage` returns `content` as a **plain string** for the `TextMessage` branch (lines 117-120). A string cannot carry `cache_control`. To attach a breakpoint you must convert that string into `[{ type: "text", text, cache_control: { type: "ephemeral" } }]`. For the array-content branches (AssistantMessage tool_use, ToolResultMessage tool_result), attach `cache_control` to the LAST element of the existing `content` array. Do this in a small helper that runs AFTER `messages.map(toAnthropicMessage)` so you don't disturb the disabled-flag path.

**Imports this file uses (lines 1-11):**
- `Anthropic` (default) from `@anthropic-ai/sdk`
- type-only: `LLMClient, ChatParams, ChatResponse, ToolDef, ToolCall, StopReason, Message` from `./types.js`
- Reuse SDK types you'll need: `Anthropic.Messages.TextBlockParam`, `Anthropic.Messages.MessageParam`, `Anthropic.Messages.ContentBlockParam`.

**Imported by:** `src/providers/factory.ts:1`, `src/providers/index.ts:17` (barrel), `src/index.ts:175` (public API), `src/providers/factory.test.ts:24`. All consume only the class name / `instanceof` — the optional 2nd constructor arg keeps every call site valid.

**Test file:** `src/providers/anthropic.test.ts` — **does not exist** (create it, item below).

---

### `src/providers/factory.ts` (modify — flag plumbing only)

**anthropic case today (lines 159-161):**
```ts
  switch (resolvedProvider) {
    case "anthropic":
      return new AnthropicAdapter(apiKey);
```
**Change to** resolve the flag from `providerConfig` (default true) and forward it. Per generatorNotes, place the resolution right before the switch or inside the case:
```ts
    case "anthropic": {
      const promptCaching =
        typeof providerConfig?.["promptCaching"] === "boolean"
          ? providerConfig["promptCaching"]
          : true;
      return new AnthropicAdapter(apiKey, { promptCaching });
    }
```
Note the existing `apiKey` is already read at lines 145-148 from `providerConfig?.["apiKey"]`. Mirror that exact `typeof ... === "boolean" ? ... : default` idiom (it matches how `endpoint` is read at lines 180-182). Do NOT touch the `openai`/`google`/`openai-compat` cases.

**Imported by / call sites:** `createClient` is the single entry point. Confirmed live call sites all pass a role's `providerConfig` through unchanged, so the flag flows end-to-end automatically (no further wiring needed this sprint):
- `src/orchestrator/generator-agent.ts:66`, `planner-agent.ts:150`, `evaluator-agent.ts:156`, `architect-agent.ts:165`, `research-agent.ts:84,224`, `curator-agent.ts:87`, `code-reviewer-agent.ts:77`, `discovery/synthesizer.ts:373` — each calls `createClient(..., config.<role>.providerConfig, ...)`.
- `providerConfig` is a free-form record (`config/schema.ts:89,100,111,128,139` = `z.record(z.string(), z.unknown()).optional()`), so `promptCaching` needs **no schema migration** (assumption confirmed).

**Test file:** `src/providers/factory.test.ts` — **exists** (extend it for C4; pattern below).

---

### `src/providers/anthropic.test.ts` (create)

**Directory pattern:** provider tests are collocated, kebab/lowercase matching source name + `.test.ts` (`openai.test.ts`, `google.test.ts`, `factory.test.ts`). Use `.js` import specifiers.

**Most similar existing file for STRUCTURE:** `src/providers/openai.test.ts` (describe/it layout, fake-client factory, `createFn.mock.calls[0][0]` capture, payload assertions). **BUT the mock mechanism differs** — see Testing Patterns (section 6): anthropic.ts uses a STATIC default import, so you must use top-level `vi.mock("@anthropic-ai/sdk", ...)`, not the dynamic `vi.doMock` + `import("./x.js?v=" + Date.now())` trick openai/google use.

**Structure template (anthropic-specific mock):**
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatParams } from "./types.js";

// Capture the args passed to messages.create across all tests.
const createMock = vi.fn();

// Static default-import mock: anthropic.ts does `import Anthropic from "@anthropic-ai/sdk"`.
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { create: createMock };
    constructor(_opts?: unknown) {}
  }
  return { default: FakeAnthropic };
});

// Import AFTER vi.mock is hoisted.
import { AnthropicAdapter } from "./anthropic.js";

function fakeResponse() {
  return {
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 5, output_tokens: 7 },
  };
}

describe("AnthropicAdapter prompt caching", () => {
  beforeEach(() => {
    createMock.mockReset();
    createMock.mockResolvedValue(fakeResponse());
  });

  // C1: enabled -> system is array w/ ephemeral cache_control on its text block
  // C2: >=2 messages -> latest message final block carries cache_control; total <= 4
  // C3: disabled -> system is plain string; deep scan finds zero cache_control
});
```

---

## 2. Patterns to Follow

### Pattern A — `typeof providerConfig?.[key] === "<type>" ? ... : default` resolution
**Source:** `src/providers/factory.ts`, lines 145-148 (apiKey) and 180-182 (endpoint)
```ts
const apiKey =
  typeof providerConfig?.["apiKey"] === "string"
    ? providerConfig["apiKey"]
    : undefined;
```
**Rule:** Resolve `promptCaching` with the identical idiom but `=== "boolean"` and default `true`. Use bracket access `providerConfig["promptCaching"]` (TS `noUncheckedIndexedAccess`/index-signature style used throughout this file).

### Pattern B — SDK types stay inside the adapter (never leak)
**Source:** `src/providers/anthropic.ts`, line 1 + helper signatures (lines 21, 79)
```ts
import Anthropic from "@anthropic-ai/sdk";
function toAnthropicMessage(message: Message): Anthropic.Messages.MessageParam { /* ... */ }
```
**Rule:** Build `TextBlockParam[]` / `cache_control` using `Anthropic.Messages.*` types ONLY in `anthropic.ts`. Principles forbid importing the SDK outside its adapter (`.bober/principles.md` line 41).

### Pattern C — `import type { ... }` for all type-only imports
**Source:** `src/providers/anthropic.ts`, lines 3-11; `openai.test.ts`, lines 16-22
```ts
import type { LLMClient, ChatParams, ChatResponse, ToolDef, ToolCall, StopReason, Message } from "./types.js";
```
**Rule:** ESLint `consistent-type-imports` is a hard gate. Types -> `import type`. Values (`AnthropicAdapter`, `vi`, `describe`) -> normal import.

### Pattern D — `.js` extensions on every relative import (ESM/NodeNext)
**Source:** `factory.ts` lines 1-6; every test file imports `"./types.js"`, `"./anthropic.js"`.
**Rule:** Always `.js`, even in `.ts`/`.test.ts` files. Principles line 27.

### Pattern E — Section header comments
**Source:** `anthropic.ts` lines 13, 123; `factory.ts` line 13
```ts
// ── AnthropicAdapter ────────────────────────────────────────────────
```
**Rule:** Group new logic (e.g. a `// ── Prompt caching ──` block) with unicode box-drawing headers. Principles line 32.

### Pattern F — Mocked request-payload capture in tests
**Source:** `src/providers/openai.test.ts`, lines 116-131
```ts
await adapter.chat(params);
const callArgs = createFn.mock.calls[0][0] as { tools: Array<{ ... }> };
expect(callArgs.tools).toHaveLength(1);
```
**Rule:** Assert against `createMock.mock.calls[0][0]` (the object passed to `messages.create`). Cast to a local shape, then assert. Mirror for `system`, `messages`, and a deep cache_control scan.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `toAnthropicMessage` | `src/providers/anthropic.ts:79` | `(message: Message): Anthropic.Messages.MessageParam` | Converts agnostic Message -> Anthropic param. REUSE — then post-process the array to attach `cache_control`. Do not rewrite. |
| `toAnthropicTool` | `src/providers/anthropic.ts:21` | `(tool: ToolDef): Anthropic.Messages.Tool` | Tool conversion. Leave untouched (non-goal: do not add cache_control to tools). |
| `normalizeContent` | `src/providers/anthropic.ts:50` | `(content: ContentBlock[]) => { text; toolCalls }` | Response normalization. Untouched. |
| `normalizeStopReason` | `src/providers/anthropic.ts:32` | `(reason) => StopReason` | Response normalization. Untouched. |
| `createClient` | `src/providers/factory.ts:117` | `(provider?, endpoint?, providerConfig?, model?, role?) => LLMClient` | Single factory entry. Add flag resolution to its anthropic case only. |
| `validateApiKey` | `src/providers/factory.ts:46` | `(resolvedProvider, role?, apiKey?): void` | API key validation. Untouched. |

No `cache_control` helper exists anywhere in the repo — you are creating the first. Keep it local to `anthropic.ts`. There are no shared `utils/` helpers relevant to caching; do not add one.

---

## 4. Prior Sprint Output

None — `dependsOn: []`, no completed sprints in this plan. This is sprint 1.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM everywhere; `.js` extensions on all imports** (line 27).
- **Provider-agnostic interfaces; never leak SDK types outside the adapter** (line 28) and **"No SDK lock-in" — never import `@anthropic-ai/sdk` outside its adapter** (line 41). => All cache_control code lives in `anthropic.ts`.
- **`consistent-type-imports` enforced** (line 35); **strict mode, zero type errors is a hard gate** (line 18); **zero lint errors hard gate** (line 19).
- **Vitest, tests collocated `*.test.ts` next to `*.ts`** (line 20).
- **Section comments with box-drawing headers** (line 32).
- **`no-explicit-any` is a warning** (line 40) — prefer `unknown` + narrowing; use local cast shapes in tests rather than `any`.

### Architecture Decisions
No `.bober/architecture/` directory / ADRs found relevant to this sprint.

### Other Docs
`README.md` and `AGENTS.md` exist but contain no provider/cache-specific conventions beyond what principles.md states. The `claude-api` skill named in generatorNotes is NOT present as a local skill dir (local skills are `bober.*` under `./skills/`); rely on the verified SDK types in section 0/below + generatorNotes for breakpoint semantics. No guessing needed — the field shapes are confirmed.

---

## 6. Testing Patterns

### Anthropic SDK shape — VERIFIED from installed 0.39.0 (`node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts`)
```ts
// line 49-51
export interface CacheControlEphemeral { type: 'ephemeral'; }

// line 352-357  -> the text block that carries the breakpoint
export interface TextBlockParam {
  text: string;
  type: 'text';
  cache_control?: CacheControlEphemeral | null;
  citations?: Array<TextCitationParam> | null;
}

// line 704  -> system accepts string OR an array of TextBlockParam
system?: string | Array<TextBlockParam>;

// also accept cache_control (for the "last message" breakpoint):
//   ToolUseBlockParam.cache_control       (line 539)
//   ToolResultBlockParam.cache_control     (line 513)
// line 109: ContentBlockParam = TextBlockParam | ImageBlockParam | ToolUseBlockParam | ToolResultBlockParam | ...
```
So: enabled-system = `[{ type: "text", text: system, cache_control: { type: "ephemeral" } }]`.
Last-message breakpoint = set `cache_control: { type: "ephemeral" }` on the FINAL block of that message's `content` array (convert a string-content TextMessage into a one-element TextBlockParam array first).

### Strategy (system-and-last-3, cap 4) — borrow #1 from hermes-agent `prompt_caching.py 'system_and_3'`
- 1 breakpoint on the system block (always, when enabled).
- + breakpoints on the final content block of up to the last 3 messages.
- Anthropic allows **at most 4** `cache_control` blocks per request; system counts as 1 => **at most 3** message breakpoints. Cap the total at 4.
- A robust minimal pass that satisfies C1/C2: always cache system + cache the final block of the single most-recent message (C2 requires "history has >=2 entries" -> latest message carries cache_control). You MAY extend toward last-3 as long as the total stays <= 4. C2's hard assert is total `cache_control` count <= 4 AND latest message's final block has one.

### Unit Test Pattern (adapter) — anthropic-specific
**Source for STRUCTURE:** `src/providers/openai.test.ts` (lines 74-167, describe/it + `createFn.mock.calls[0][0]` capture).
**CRITICAL difference:** openai.test.ts / google.test.ts mock a **dynamic** `import()` via `vi.doMock` inside `beforeEach`, then re-import with a cache-busting query (`"./openai.js?v=" + Date.now()`):
```ts
// openai.test.ts:77-88  (dynamic-import pattern — DO NOT copy verbatim for anthropic)
beforeEach(() => {
  createFn = vi.fn();
  vi.doMock("openai", () => ({ default: makeFakeOpenAI(createFn) }));
});
async function makeAdapter(model = "gpt-4.1") {
  const { OpenAIAdapter } = await import("./openai.js?v=" + Date.now());
  return new OpenAIAdapter(model, "test-api-key");
}
```
`anthropic.ts:1` uses a **STATIC default import** (`import Anthropic from "@anthropic-ai/sdk"`), so use **top-level `vi.mock`** (hoisted) with a `default` export instead — see the section-1 create template. Then construct the adapter directly: `new AnthropicAdapter("test-key", { promptCaching: true|false })`. Do NOT rely on `createClient` for payload-shape tests (generatorNotes assumption: `BOBER_TEST_DETERMINISTIC` would short-circuit; constructing the adapter directly avoids that entirely).

**Runner:** vitest. **Assertion style:** `expect(...)`. **Mock approach:** top-level `vi.mock("@anthropic-ai/sdk", () => ({ default: FakeAnthropic }))` with a shared `const createMock = vi.fn()`. **File naming:** `anthropic.test.ts`. **Location:** collocated in `src/providers/`.

**Concrete assertions to write:**
```ts
// C1 — enabled: system is an array whose text block has ephemeral cache_control
it("caches the system prompt as a content-block array when enabled", async () => {
  const adapter = new AnthropicAdapter("k", { promptCaching: true });
  await adapter.chat({ model: "claude-x", system: "SYS", messages: [{ role: "user", content: "hi" }] });
  const req = createMock.mock.calls[0][0] as { system: unknown };
  expect(Array.isArray(req.system)).toBe(true);
  const block = (req.system as Array<{ type: string; text: string; cache_control?: { type: string } }>)[0];
  expect(block).toMatchObject({ type: "text", text: "SYS", cache_control: { type: "ephemeral" } });
});

// C2 — enabled, >=2 messages: latest msg final block cached; total breakpoints <= 4
it("caches latest message and never exceeds 4 breakpoints", async () => {
  const adapter = new AnthropicAdapter("k", { promptCaching: true });
  await adapter.chat({
    model: "claude-x", system: "SYS",
    messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
      { role: "user", content: "third" },
    ],
  });
  const req = createMock.mock.calls[0][0] as Record<string, unknown>;
  const count = JSON.stringify(req).match(/"cache_control"/g)?.length ?? 0;
  expect(count).toBeLessThanOrEqual(4);
  // assert the LAST message's final content block carries cache_control (deep-read req.messages)
});

// C3 — disabled: plain-string system, zero cache_control anywhere
it("sends plain-string system and zero cache_control when disabled", async () => {
  const adapter = new AnthropicAdapter("k", { promptCaching: false });
  await adapter.chat({ model: "claude-x", system: "SYS", messages: [{ role: "user", content: "hi" }] });
  const req = createMock.mock.calls[0][0] as { system: unknown };
  expect(req.system).toBe("SYS");
  expect(JSON.stringify(req)).not.toContain("cache_control");
});
```

### Factory Test Pattern (C4) — extend existing file
**Source:** `src/providers/factory.test.ts` lines 96-103, 153-179 (anthropic `instanceof` + env-key save/restore). Add tests that assert the flag is read & forwarded. Since `createClient` returns an `LLMClient` (not the flag), the cleanest C4 assertion is to assert behavior via the adapter the factory builds — but the adapter does not expose `promptCaching` publicly. Two viable options:
1. **Spy on the constructor:** `vi.spyOn` is awkward for `new`. Prefer: in factory.test.ts, mock `./anthropic.js` to capture constructor args:
```ts
import { vi } from "vitest";
const ctorSpy = vi.fn();
vi.mock("./anthropic.js", () => ({
  AnthropicAdapter: class { constructor(...args: unknown[]) { ctorSpy(...args); } },
}));
// then: createClient("anthropic", null, { apiKey: "k" });  expect 2nd arg => { promptCaching: true }
//       createClient("anthropic", null, { apiKey: "k", promptCaching: false }); expect { promptCaching: false }
```
   NOTE: top-level `vi.mock("./anthropic.js")` in factory.test.ts will replace `AnthropicAdapter` for the WHOLE file, breaking the existing `instanceof AnthropicAdapter` assertions (lines 102/159/175). **Safer: put the C4 constructor-capture tests in a SEPARATE new describe block / file-level decision** OR keep them in `anthropic.test.ts` by importing `createClient` there with the SDK already mocked. RECOMMENDED: add the C4 factory-flag tests to `factory.test.ts` only if you do NOT need to also `instanceof` in the same file scope; otherwise place a dedicated `createClient` flag-forwarding test alongside the adapter tests. Do NOT set `BOBER_TEST_DETERMINISTIC` (it returns the stub, `factory.ts:127-129`).
2. Confirm `createClient("anthropic", null, { apiKey, promptCaching: false })` still returns an `AnthropicAdapter` instance (cheap regression) AND that the default (no promptCaching key) path also returns one.

**Mock approach across the repo:** top-level hoisted `vi.mock("<module.js>", factory)` is the established pattern for replacing a module's exports (e.g. `src/orchestrator/code-reviewer-agent.test.ts:29-52`).

### E2E
Not applicable — no Playwright path for this sprint (unit + typecheck + build only).

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/providers/factory.ts:1,161` | `AnthropicAdapter` ctor | low | New 2nd ctor arg is optional; existing `new AnthropicAdapter(apiKey)` stays valid. |
| `src/providers/factory.test.ts:24,96-179` | `AnthropicAdapter` (instanceof) | medium | If you `vi.mock("./anthropic.js")` here, existing `instanceof` assertions break. Keep ctor-capture isolated (see C4 note). |
| `src/index.ts:175` | re-exports `AnthropicAdapter` | low | Public API export — unchanged class name, backward-compatible signature. |
| `src/providers/index.ts:17` | barrel re-export | low | Unchanged. |
| All orchestrator agents calling `createClient(... providerConfig ...)` | factory | low | They pass `providerConfig` through unchanged; flag flows automatically. No edits needed. |

### Existing Tests That Must Still Pass
- `src/providers/factory.test.ts` — anthropic `instanceof` + API-key validation tests (lines 96-103, 128-179). Verify ALL still green after the case edit and any new C4 tests.
- `src/providers/openai.test.ts`, `src/providers/google.test.ts` — must stay green (no edits to those adapters; non-goal). Confirms isolation.
- Any openai-compat suite if present.

### Features That Could Be Affected
- **Every agent role's LLM call** shares `createClient`. Since `promptCaching` defaults `true` for anthropic, the real request shape CHANGES for anthropic runs (system becomes an array). This is intended. Disabled path must remain byte-identical (C3 regression guard).
- No other in-plan features (single-sprint plan).

### Recommended Regression Checks (run after implementation)
1. `npm run typecheck` — exit 0, no new TS errors (C5).
2. `npm run build` — exit 0, dist updated (C6).
3. `npm run lint` — exit 0 (consistent-type-imports, no unused vars).
4. `npm run test` — only the 2 documented baseline failures allowed; new anthropic tests pass; openai/google/openai-compat/factory suites green (C7).
5. `grep -rn cache_control src/providers` — matches ONLY `anthropic.ts` + `anthropic.test.ts` (isolation).
6. Manually confirm `git diff src/providers/openai.ts src/providers/google.ts src/providers/openai-compat.ts` is empty.

---

## 8. Implementation Sequence

1. **`src/providers/anthropic.ts` — constructor** (lines 133-138). Add `private readonly promptCaching: boolean;` field + optional `opts?: { promptCaching?: boolean }` 2nd arg, store `opts?.promptCaching ?? true`.
   - Verify: `npm run typecheck` still passes; no call site breaks (ctor arg optional).
2. **`src/providers/anthropic.ts` — caching helpers + chat()** (lines 140-170). Add a `// ── Prompt caching ──` section: helper to build the cached system `TextBlockParam[]`, and a helper to attach `cache_control` to the final block of the most-recent message(s) (cap total 4). In `chat()`, branch on `this.promptCaching`: enabled -> cached `system` array + post-process `anthropicMessages`; disabled -> pass plain `system` string and unmodified `anthropicMessages` (zero cache_control). Keep model/max_tokens/tools/normalization identical.
   - Verify: `npm run typecheck`; disabled path produces a payload with no `cache_control` substring.
3. **`src/providers/factory.ts` — anthropic case** (lines 159-161). Resolve `promptCaching` from `providerConfig` (default true, `=== "boolean"` idiom) and `new AnthropicAdapter(apiKey, { promptCaching })`. Touch nothing else.
   - Verify: `npm run typecheck`; existing factory tests still pass.
4. **`src/providers/anthropic.test.ts` (create)** — top-level `vi.mock("@anthropic-ai/sdk", () => ({ default: FakeAnthropic }))` with shared `createMock`; write C1 (system array w/ ephemeral), C2 (latest-msg breakpoint + total <= 4), C3 (disabled plain-string + zero cache_control).
   - Verify: `npm run test src/providers/anthropic.test.ts` green.
5. **C4 factory-flag test** — assert the flag is resolved/forwarded (default true; explicit false honored) WITHOUT `BOBER_TEST_DETERMINISTIC`. Prefer a constructor-capture mock isolated from the existing `instanceof` tests (see section 6 C4 note).
   - Verify: factory suite green, no regression to existing anthropic instanceof tests.
6. **Run full verification** — `npm run typecheck`, `npm run lint`, `npm run build`, `npm run test`, plus the `grep -rn cache_control src/providers` isolation check. Only the 2 baseline failures permitted.

---

## 9. Pitfalls & Warnings

- **Static vs dynamic SDK import.** `anthropic.ts` imports the SDK with a STATIC default import (`import Anthropic from "@anthropic-ai/sdk"`). Do NOT copy openai/google's `vi.doMock` + `import("./x.js?v=Date.now()")` dance — that pattern exists because THOSE packages are optional peer deps loaded dynamically. For anthropic, use a single hoisted top-level `vi.mock("@anthropic-ai/sdk", () => ({ default: FakeAnthropic }))`. The mock factory MUST return `{ default: ... }` because the SDK uses `export default Anthropic` (`index.d.ts:151`).
- **String-content messages can't hold cache_control.** `toAnthropicMessage` returns plain-string `content` for the TextMessage branch (anthropic.ts:117-120). You must convert that string to `[{ type: "text", text, cache_control }]` before attaching a breakpoint — don't try to set a property on a string.
- **Breakpoint cap is hard (<= 4).** system = 1 => at most 3 message breakpoints. Exceeding 4 is a C2 failure (and a real-API error). When walking "last 3 messages" guard the total count.
- **Disabled path must be byte-identical.** C3 is the primary regression guard: when `promptCaching` is false, `system` stays a plain string and `messages` are the raw `toAnthropicMessage` output — a deep JSON scan must find zero `cache_control`. Build the cached variants ONLY inside the `if (this.promptCaching)` branch.
- **Isolation grep will be run.** Any `cache_control` token leaking into `openai.ts`/`google.ts`/`openai-compat.ts` fails the evaluator. Keep it strictly in `anthropic.ts` + its test.
- **`consistent-type-imports` + `noUnusedLocals`.** Import `Anthropic` (value) normally; import `ChatParams` etc. as `import type`. Remove any SDK type alias you don't actually use (strict unused checks will error).
- **Do NOT touch tool conversion, response normalization, model, or max_tokens** (explicit non-goal). Do NOT extend `ChatResponse.usage` with cache fields (non-goal). Do NOT add `cache_control` to tools even though the SDK allows it on `Tool` — strategy is system-and-last-3 only.
- **Do NOT set `BOBER_TEST_DETERMINISTIC`** in any new test — `factory.ts:127-129` short-circuits to a stub and your flag plumbing would never run.
- **The 2 baseline failures are NOT yours.** `external-server-graph.test.ts` (37-tool count) and `disk.test.ts` (approval-poll). Don't attempt to fix them; don't let them mask a real new failure.
