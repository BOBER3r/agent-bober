# Sprint Briefing: Promote claude-code subscription provider into the factory

**Contract:** sprint-spec-20260531-multi-provider-deepseek-claude-code-4
**Generated:** 2026-05-31T00:00:00Z

---

## 0. TL;DR for the Generator

The `ClaudeCodeAdapter` already EXISTS and is correct (`src/providers/claude-code.ts`). This sprint is **wiring**, not new logic:

1. Add `"claude-code"` to the `ProviderName` union (`factory.ts:11`).
2. Add a `case "claude-code":` to `validateApiKey` that requires **no key** and is a **no-op** for keys (the binary PATH probe is ASYNC, so it CANNOT live in the synchronous `validateApiKey` — do the probe in `createClient`'s branch instead). See §6 for the exact design decision.
3. Add a `case "claude-code":` to `createClient`'s switch returning `new ClaudeCodeAdapter(binary, timeoutMs)`, reading `providerConfig.binary` / `providerConfig.timeoutMs`, and run an async binary-on-PATH preflight there that throws naming the binary if absent.
4. Export `ClaudeCodeAdapter` from `src/providers/index.ts`.
5. Soften the SPIKE header comment in `claude-code.ts` (keep the capability-boundary doc).
6. Write `src/providers/claude-code.test.ts` with `vi.mock("execa")` (NO real CLI call). There is NO existing `vi.mock("execa")` in the repo — you are writing the first one; the pattern is in §6.

**CRITICAL design tension:** `createClient` is currently **synchronous** (`factory.ts:129` returns `LLMClient`, not `Promise<LLMClient>`). An async PATH probe (`execa("claude", ["--version"])`) cannot be `await`ed inside a sync function. See §6 for the recommended resolution — this is the single biggest decision in the sprint.

---

## 1. Target Files

### src/providers/claude-code.ts (modify — soften SPIKE header only; logic stays)

**Header to soften (lines 1-32).** Lines 1-7 describe the adapter; lines 9-31 are the `SPIKE SCOPE` block. Drop the word "SPIKE" and the "read before wiring into the factory" framing (it IS now wired), but KEEP the capability-boundary doc (the no-tools rule, the cost caveat, the terms note). Verbatim current header:

```ts
/**
 * Claude Code subscription provider — SPIKE.
 *
 * Backs the LLMClient interface with the local `claude` CLI in headless
 * print mode (`claude -p --output-format json`), so model calls bill against
 * the user's Claude Pro/Max SUBSCRIPTION credit instead of an
 * ANTHROPIC_API_KEY. No API key is read or required by this adapter.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SPIKE SCOPE — read before wiring into the factory:
 * ...
```
The chat() method, constructor, and the throw message described below MUST NOT change.

**Constructor signature + defaults (lines 102-105) — verbatim:**
```ts
constructor(
  private readonly binary: string = "claude",
  private readonly timeoutMs: number = 180_000,
) {}
```
So `createClient` calls `new ClaudeCodeAdapter(binary, timeoutMs)` where `binary` defaults to `"claude"` and `timeoutMs` defaults to `180_000`.

**Tools-guard throw (lines 112-119) — VERBATIM, this is what sc-4-4 asserts:**
```ts
if (tools && tools.length > 0) {
  throw new Error(
    "ClaudeCodeAdapter (spike) does not support custom tools: the `claude` " +
      "CLI runs its own tool loop and cannot return custom tool_use blocks. " +
      "Use this provider only for prompt→text roles (e.g. planner), or use " +
      "the anthropic/openai-compat providers for tool-driven roles.",
  );
}
```
The guard fires BEFORE `flattenMessages` and BEFORE any `execa` call. sc-4-4 asserts the message contains the phrase about the CLI not returning custom `tool_use` blocks AND that execa was NOT called. A robust regex assertion: `/cannot return custom tool_use blocks/`. NOTE: the message contains the literal substring "(spike)" — if you remove the word "spike" from the header you may keep it here (sc-4-4 only requires the message states the CLI cannot return custom tool_use blocks), but if you change this string, update the test regex accordingly. Recommendation: leave the throw string EXACTLY as-is to avoid churn.

**The execa invocation (lines 123-146) — VERBATIM, this is what sc-4-5 inspects:**
```ts
const args = [
  "-p",
  prompt,
  "--output-format",
  "json",
  // Disable Claude Code's built-in tools — we want pure completion, not its loop.
  "--disallowed-tools",
  "Read Edit Write Bash Glob Grep WebFetch WebSearch Task",
  // Don't inherit the project's MCP servers (keeps the call hermetic).
  "--strict-mcp-config",
];
if (system && system.trim().length > 0) {
  args.push("--append-system-prompt", system);
}
if (model) {
  args.push("--model", model);
}

const result = await execa(this.binary, args, {
  reject: false,
  timeout: this.timeoutMs,
  // No stdin; everything is in args.
  input: "",
});
```
So sc-4-5 asserts `vi.mocked(execa)` was called with first arg = the overridden binary name, and the options object (3rd arg) has `timeout` = the overridden `timeoutMs`. The model is appended via `--model` (assumption Q2 confirmed: lines 137-139).

**Result/usage mapping (lines 171-179) — VERBATIM, this is what sc-4-3 asserts:**
```ts
return {
  text: parsed.result ?? "",
  toolCalls: [],
  stopReason: mapStopReason(parsed.stop_reason),
  usage: {
    inputTokens: parsed.usage?.input_tokens ?? 0,
    outputTokens: parsed.usage?.output_tokens ?? 0,
  },
};
```
So the mocked execa stdout JSON must use snake_case CLI keys: `result`, `stop_reason`, `usage.input_tokens`, `usage.output_tokens`. sc-4-3 asserts `response.text === parsed.result`, `response.usage.inputTokens === usage.input_tokens`, `response.usage.outputTokens === usage.output_tokens`.

**stop_reason mapping (lines 59-70) — for completeness:** `"end_turn"→"end"`, `"tool_use"→"tool_use"`, `"max_tokens"→"max_tokens"`, else `raw ?? "end"`.

**Exit-code / error handling that the mock must satisfy (lines 148-169):**
- `result.exitCode !== 0` → throws. So the mocked result MUST include `exitCode: 0`.
- `JSON.parse(result.stdout)` → the mock's `stdout` must be a JSON STRING (use `JSON.stringify(...)`).
- `parsed.is_error` truthy → throws. So omit `is_error` or set it `false`.

**Imports this file uses:**
- `execa` from `"execa"` (line 34)
- types `LLMClient, ChatParams, ChatResponse, StopReason` from `"./types.js"` (lines 35-40)

**Imported by:** currently NOTHING (spike, never wired). After this sprint: `factory.ts` and `index.ts`.

**Test file:** `src/providers/claude-code.test.ts` — **does not exist** (you create it).

---

### src/providers/factory.ts (modify)

**ProviderName union (line 11) — verbatim, add `"claude-code"`:**
```ts
export type ProviderName = "anthropic" | "openai" | "google" | "openai-compat";
```
→ becomes `... | "openai-compat" | "claude-code";`

**validateApiKey signature (lines 47-52) — verbatim (note the Sprint-2 `endpoint` 4th param):**
```ts
export function validateApiKey(
  resolvedProvider: string,
  role?: string,
  apiKey?: string,
  endpoint?: string,
): void {
```
It is **synchronous** (`: void`). Add a `case "claude-code":` inside the switch (the switch spans lines 55-105; `default:` is at 102-104). The claude-code case must be a **no-op for keys** (do NOT read ANTHROPIC_API_KEY — nonGoal). Because the PATH probe is async and this function is sync, do NOT probe here. Pattern of an existing no-key case for reference (openai-compat, lines 89-101):
```ts
case "openai-compat":
  // API key is optional for Ollama and other local servers.
  if (endpoint?.includes("api.deepseek.com")) { ... }
  break;
```
So:
```ts
case "claude-code":
  // Subscription provider: no API key is read or required. The `claude`
  // binary PATH preflight is async and runs in createClient's branch.
  break;
```

**createClient signature (lines 129-135) — verbatim. It is SYNCHRONOUS:**
```ts
export function createClient(
  provider?: string | null,
  endpoint?: string | null,
  providerConfig?: Record<string, unknown>,
  model?: string,
  role?: string,
): LLMClient {
```
**switch statement** is at lines 181-222; `default:` throw (the "Unsupported provider" message) is at 218-221. Add the new case before `default:`. The `apiKey` local is at 157-160; `providerConfig` is `Record<string, unknown>` so read `binary`/`timeoutMs` with typeof guards (mirror the apiKey/promptCaching pattern at 157-160 / 183-186):
```ts
case "claude-code": {
  const binary =
    typeof providerConfig?.["binary"] === "string"
      ? providerConfig["binary"]
      : "claude";
  const timeoutMs =
    typeof providerConfig?.["timeoutMs"] === "number"
      ? providerConfig["timeoutMs"]
      : 180_000;
  // binary-on-PATH preflight — see §6 for the sync/async resolution.
  return new ClaudeCodeAdapter(binary, timeoutMs);
}
```
**Add import** at top of factory.ts (mirror lines 1-4):
```ts
import { ClaudeCodeAdapter } from "./claude-code.js";
```
Also update the `default:` "Supported providers" error string (line 220) to include `claude-code` so the message stays accurate (sc-4-1 only needs ProviderName to include it; the unsupported-provider test at factory.test.ts:154-159 asserts `/anthropic, openai, google, openai-compat/` — if you append claude-code, that regex STILL matches since it's a substring match, so this is safe).

**Imported by (factory.ts dependents — grep `from.*factory`):** see §7.

**Test file:** `src/providers/factory.test.ts` — **exists** (read in full; add a `describe("claude-code provider")` block).

---

### src/providers/index.ts (modify)

**Current adapter export style (lines 18-21) — verbatim:**
```ts
export { AnthropicAdapter } from "./anthropic.js";
export { OpenAIAdapter } from "./openai.js";
export { GoogleAdapter } from "./google.js";
export { OpenAICompatAdapter } from "./openai-compat.js";
```
Add the SAME style:
```ts
export { ClaudeCodeAdapter } from "./claude-code.js";
```
Note `.js` extension (NodeNext ESM — see §9).

**Test file:** none for index.ts.

---

### src/providers/claude-code.test.ts (create)

**Directory pattern:** every adapter test in `src/providers/` is co-located, kebab-case, `*.test.ts` (e.g. `anthropic.test.ts`, `google.test.ts`, `openai-compat.test.ts`, `preflight.test.ts`).
**Most similar existing file for module-mock structure:** `src/providers/factory.test.ts` (mocks `./anthropic.js` with a hoisted `vi.mock`). For the test runner/assertion conventions, also `src/providers/preflight.test.ts`.
**Structure template:** see the full template in §6 (the execa-mock pattern is the load-bearing part).

---

## 2. Patterns to Follow

### Vitest imports + describe/it/expect
**Source:** `src/providers/preflight.test.ts`, line 1
```ts
import { describe, it, expect, vi, afterEach } from "vitest";
```
**Rule:** named imports from `"vitest"`; use `describe`/`it`/`expect`; reset mocks in `afterEach(() => { vi.clearAllMocks(); })` (preflight.test.ts:16-18).

### Hoisted vi.mock with call-recording (for inspecting constructor/call args)
**Source:** `src/providers/factory.test.ts`, lines 40-61
```ts
vi.mock("./anthropic.js", () => {
  const calls: Array<[string | undefined, { promptCaching?: boolean } | undefined]> = [];
  class AnthropicAdapter {
    static readonly _ctorCalls = calls;
    constructor(apiKey?: string, opts?: { promptCaching?: boolean }) {
      calls.push([apiKey, opts]);
    }
    chat = () => Promise.resolve({ content: "", usage: { inputTokens: 0, outputTokens: 0 } });
  }
  return { AnthropicAdapter };
});
const { AnthropicAdapter } = await import("./anthropic.js");
```
**Rule:** `vi.mock` is HOISTED — the factory closure must be self-contained (no outer refs). To inspect calls after hoisting, attach a static recorder on the class OR (simpler for execa) use `vi.mocked(execa)` + `vi.fn()`. For execa, prefer the `vi.mocked` pattern in §6 (don't hand-roll a recorder).

### env-var save/restore around throw assertions
**Source:** `src/providers/factory.test.ts`, lines 166-175
```ts
const saved = process.env["ANTHROPIC_API_KEY"];
delete process.env["ANTHROPIC_API_KEY"];
try {
  expect(() => createClient("anthropic")).toThrow(/ANTHROPIC_API_KEY/);
} finally {
  if (saved !== undefined) process.env["ANTHROPIC_API_KEY"] = saved;
}
```
**Rule:** For sc-4-2's "no key set" path, delete ANTHROPIC_API_KEY in the test and restore in `finally`, asserting `validateApiKey("claude-code")` does NOT throw. Use `.not.toThrow()`.

### typeof-guarded providerConfig reads
**Source:** `src/providers/factory.ts`, lines 157-160 (apiKey) and 183-186 (promptCaching)
```ts
const apiKey =
  typeof providerConfig?.["apiKey"] === "string"
    ? providerConfig["apiKey"]
    : undefined;
```
**Rule:** `providerConfig` is `Record<string, unknown>`; read `binary`/`timeoutMs` with `typeof` guards exactly like this (string for binary, number for timeoutMs).

### Injectable importer seam for mockable external calls (Sprint 3 reference)
**Source:** `src/providers/preflight.ts`, lines 17-24, 56-68
```ts
export type OpenaiImporter = () => Promise<unknown>;
const defaultImporter: OpenaiImporter = () => { ... };
export async function preflightOpenaiPeer(
  config: Partial<BoberConfig>,
  importer: OpenaiImporter = defaultImporter,
): Promise<string | null> { ... }
```
**Rule:** This is the codebase's blessed pattern for making external calls testable WITHOUT `vi.mock`: take an injectable function with a real default, pass a fake in tests. CONSIDER applying this for the binary-PATH probe (a `claude --version` probe function defaulting to an execa call) so the preflight is testable even without mocking the `execa` module globally. See §6.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `createClient` | `src/providers/factory.ts:129` | `(provider?, endpoint?, providerConfig?, model?, role?): LLMClient` | Factory you are extending with the claude-code case. SYNC. |
| `validateApiKey` | `src/providers/factory.ts:47` | `(resolvedProvider, role?, apiKey?, endpoint?): void` | Key validator you are extending. SYNC. |
| `ClaudeCodeAdapter` | `src/providers/claude-code.ts:97` | `class implements LLMClient; constructor(binary="claude", timeoutMs=180000)` | The adapter — already complete, just wire/export it. |
| `mapStopReason` | `src/providers/claude-code.ts:59` | `(raw?: string): StopReason` | Already maps CLI stop_reason; no change. |
| `flattenMessages` | `src/providers/claude-code.ts:78` | `(messages): string` | Already flattens transcript; no change. |
| `preflightOpenaiPeer` / `OpenaiImporter` | `src/providers/preflight.ts:56` / `:17` | `(config, importer?) => Promise<string|null>` | Sprint-3 injectable-importer seam — REFERENCE pattern for a mockable binary probe. Do NOT reuse directly (it's openai-specific). |
| `resolveProviderModel` | `src/orchestrator/model-resolver.js` (imported `factory.ts:6`) | `(model, provider?) => {provider, modelId, endpoint}` | Model shorthand resolver; claude-code is set EXPLICITLY so you do not need to add a shorthand here. |
| `logger` | `src/utils/logger.js` (used `preflight.ts:2`) | `{warn, info, error, debug, success}` | Project logger; not required for this sprint but available. |

**Utilities reviewed:** `src/utils/` (git.ts uses execa, logger.ts), `src/providers/` (preflight.ts is the relevant seam), `src/orchestrator/model-resolver`. No existing helper does "is binary on PATH" — you must add one (see §6). No existing `vi.mock("execa")` test helper exists.

---

## 4. Prior Sprint Output

### Sprint 2: DeepSeek resolution
**Modified:** `src/providers/factory.ts` — `validateApiKey` gained the 4th `endpoint?` param (line 51) and the `api.deepseek.com` gate (lines 92-100). **Connection:** your new `case "claude-code":` lives in the SAME switch; keep the existing `endpoint` param and DeepSeek gate intact.

### Sprint 3: preflight.ts injectable-importer seam
**Created:** `src/providers/preflight.ts` — exports `preflightOpenaiPeer`, `usesOpenaiFamily`, `OPENAI_PEER_HINT`, type `OpenaiImporter`. **Connection:** this is the REFERENCE pattern (`§2`, `§6`) for making an external call mockable via an injectable function with a real default — directly applicable to the binary-PATH probe. The tests (`preflight.test.ts`) show passing a fake importer instead of `vi.mock`.

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` found in repo root (checked). Conventions are enforced by tsconfig (strict NodeNext ESM) and eslint (`npm run lint` = `eslint src/`).

### Architecture Decisions
`.bober/architecture/` exists (untracked) but contains no ADR relevant to the claude-code provider beyond the spike header in `claude-code.ts` itself, which documents the capability boundary (no-tools, subscription billing) — that IS the de-facto design note. Preserve it.

### Other Docs
The SPIKE header comment in `claude-code.ts:1-31` is the authoritative doc for WHY tools throw and WHY no API key is read. Soften the "SPIKE" framing but keep the substance (nonGoal: tools-guard must stay; no ANTHROPIC_API_KEY).

---

## 6. Testing Patterns + The Preflight Design Decision

### THE KEY DECISION: where does the binary-PATH preflight live?

`createClient` (`factory.ts:129`) and `validateApiKey` (`factory.ts:47`) are BOTH synchronous. A PATH probe via `execa("claude", ["--version"])` is async. You cannot `await` in a sync function. **Recommended approach (cleanest, lets sc-4-2 test BOTH branches with execa mocked):**

**Option A (RECOMMENDED) — synchronous PATH check, no execa probe.** Use Node's ability to resolve a binary on PATH synchronously. The simplest mockable, sync approach is a small helper that checks PATH and is itself injectable/mockable. BUT the contract's sc-4-2 says "binary preflight reports it is not on PATH" and the assumptions mention "via which/where or a no-op execa probe". Since the rest of the codebase mocks via `execa`, and sc-4-2 wants execa-mocked branches, the FACTORY-LOCAL ASYNC approach is cleaner than forcing a sync probe:

**Option B (RECOMMENDED given sc-4-2 wording) — async probe inside createClient's claude-code branch; validateApiKey stays a no-op for claude-code.** Because the probe is async, `createClient` cannot stay sync IF the probe must run inside it AND be awaited. Two sub-options:

- **B1:** Make ONLY the claude-code path do the probe by making the probe injectable and SYNCHRONOUS at the call site is impossible with execa. So keep `createClient` synchronous and put the probe in a small exported async helper `preflightClaudeBinary(binary, probe?)` that the claude-code branch CALLS but the test exercises directly (like preflightOpenaiPeer). Then `createClient`'s claude-code branch invokes a SYNC binary check.

- **B2 (SIMPLEST, RECOMMENDED):** Add an exported async function in factory.ts (or a new tiny module) modeled on the Sprint-3 seam:
```ts
/** Probe used to verify the claude CLI is on PATH. Injectable for tests. */
export type BinaryProbe = (binary: string) => Promise<boolean>;

const defaultBinaryProbe: BinaryProbe = async (binary) => {
  try {
    const r = await execa(binary, ["--version"], { reject: false, timeout: 5_000 });
    return r.exitCode === 0;
  } catch {
    return false; // ENOENT => not on PATH
  }
};

/** Throws an Error naming the binary if the claude CLI is not on PATH. */
export async function preflightClaudeBinary(
  binary = "claude",
  probe: BinaryProbe = defaultBinaryProbe,
): Promise<void> {
  const ok = await probe(binary);
  if (!ok) {
    throw new Error(
      `The "${binary}" CLI was not found on PATH. The claude-code provider ` +
        `requires the Claude Code CLI. Install it and ensure "${binary}" is on your PATH.`,
    );
  }
}
```
Then:
- `validateApiKey("claude-code")` → `break;` (no-op for keys). sc-4-2 "no key" branch: `expect(() => validateApiKey("claude-code")).not.toThrow()` — passes trivially.
- sc-4-2 "binary missing" branch: test `preflightClaudeBinary` directly with a fake probe that resolves `false`, asserting it throws naming the binary: `await expect(preflightClaudeBinary("claude", async () => false)).rejects.toThrow(/claude/)`. This keeps execa fully mockable (or even un-needed since the probe is injected). This MIRRORS the Sprint-3 `preflightOpenaiPeer(config, importer)` test style exactly.
- `createClient`'s claude-code branch returns `new ClaudeCodeAdapter(binary, timeoutMs)` synchronously. If the orchestrator wants the preflight wired into a call path, it can `await preflightClaudeBinary(binary)` at the role-resolution layer (Sprint 5 / out of scope here). For THIS sprint, exporting `preflightClaudeBinary` + the no-op validateApiKey case + the createClient case satisfies sc-4-1/4-2/4-5 without making createClient async (which would break ALL existing callers — see §7 risk).

**Why NOT make createClient async:** grep shows many callers treat the return as a sync `LLMClient` (see §7). Changing the signature to `Promise<LLMClient>` is a breaking, out-of-scope change that would fail the build for unrelated files. Keep it sync; put the async probe in the exported `preflightClaudeBinary` helper.

### Unit Test Pattern — the execa mock (you write the FIRST one in this repo)
There is NO existing `vi.mock("execa")` in the codebase (grep confirmed). Use this hoisted pattern. `execa` is a NAMED export, so the mock factory returns `{ execa: vi.fn() }`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// HOISTED to top of module by vitest. execa is a named export.
vi.mock("execa", () => ({
  execa: vi.fn(),
}));

// Import AFTER vi.mock so we hold the mocked fn.
import { execa } from "execa";
import { ClaudeCodeAdapter } from "./claude-code.js";

const mockedExeca = vi.mocked(execa);

beforeEach(() => {
  mockedExeca.mockReset();
});

describe("ClaudeCodeAdapter.chat", () => {
  it("sc-4-3: maps mocked CLI JSON result.text and usage", async () => {
    mockedExeca.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({
        type: "result",
        result: "hello from claude",
        stop_reason: "end_turn",
        usage: { input_tokens: 42, output_tokens: 7 },
      }),
      stderr: "",
    } as never); // cast: execa's full ExecaReturnValue has many fields; we only need these.

    const adapter = new ClaudeCodeAdapter("claude", 180_000);
    const res = await adapter.chat({ model: "opus", system: "be brief", messages: [{ role: "user", content: "hi" }] });

    expect(res.text).toBe("hello from claude");
    expect(res.usage.inputTokens).toBe(42);
    expect(res.usage.outputTokens).toBe(7);
    expect(res.stopReason).toBe("end"); // end_turn -> end
  });

  it("sc-4-4: throws on custom tools WITHOUT calling execa", async () => {
    const adapter = new ClaudeCodeAdapter();
    const oneTool = { name: "t", description: "d", input_schema: { type: "object" as const, properties: {} } };
    await expect(
      adapter.chat({ model: "opus", system: "", messages: [{ role: "user", content: "hi" }], tools: [oneTool] }),
    ).rejects.toThrow(/cannot return custom tool_use blocks/);
    expect(mockedExeca).not.toHaveBeenCalled();
  });

  it("sc-4-5: invokes execa with overridden binary and timeout", async () => {
    mockedExeca.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ result: "ok", usage: { input_tokens: 1, output_tokens: 1 } }),
      stderr: "",
    } as never);

    const adapter = new ClaudeCodeAdapter("my-claude", 5_000);
    await adapter.chat({ model: "opus", system: "", messages: [{ role: "user", content: "hi" }] });

    expect(mockedExeca).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = mockedExeca.mock.calls[0]!;
    expect(bin).toBe("my-claude");
    expect(opts).toMatchObject({ timeout: 5_000 });
    expect(args).toContain("-p");
  });
});
```
**Runner:** vitest@^3.0.5. **Assertion style:** `expect`. **Mock approach:** `vi.mock("execa", () => ({ execa: vi.fn() }))` + `vi.mocked(execa)`. **File naming:** `claude-code.test.ts`. **Location:** co-located in `src/providers/`.

### Type shapes the test asserts (from src/providers/types.ts)
- **ChatParams** (`types.ts:139-156`): `{ model: string; system: string; messages: Message[]; tools?: ToolDef[]; maxTokens?; effort? }`. `model` and `system` are REQUIRED — pass them in every test `chat()` call (system can be `""`).
- **Message / TextMessage** (`types.ts:96-100`): `{ role: "user"|"assistant"; content: string }` — use `{ role: "user", content: "hi" }`.
- **ToolDef** (`types.ts:37-44`): `{ name: string; description: string; input_schema: JsonSchemaObject }`. `JsonSchemaObject` requires `type: "object"` (`types.ts:20`). The sc-4-4 fixture above satisfies this.
- **ChatResponse** (`types.ts:166-178`): `{ text: string; toolCalls: ToolCall[]; stopReason: StopReason; usage: { inputTokens: number; outputTokens: number } }` — assert `res.text`, `res.usage.inputTokens`, `res.usage.outputTokens`, `res.stopReason`.

### factory.test.ts additions (sc-4-1, sc-4-2, sc-4-5 via createClient)
Add a block mirroring the existing provider describes (factory.test.ts:71-151). Import `ClaudeCodeAdapter` and `preflightClaudeBinary`:
```ts
describe("claude-code provider", () => {
  it("sc-4-1: createClient returns ClaudeCodeAdapter", () => {
    const client = createClient("claude-code", null, undefined, "opus");
    expect(client).toBeInstanceOf(ClaudeCodeAdapter);
  });
  it("sc-4-2: validateApiKey('claude-code') does not throw with no key set", () => {
    const saved = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
    try { expect(() => validateApiKey("claude-code")).not.toThrow(); }
    finally { if (saved !== undefined) process.env["ANTHROPIC_API_KEY"] = saved; }
  });
  it("sc-4-2: preflightClaudeBinary throws naming the binary when probe reports absent", async () => {
    await expect(preflightClaudeBinary("claude", async () => false)).rejects.toThrow(/claude/);
  });
  it("sc-4-2: preflightClaudeBinary does not throw when probe reports present", async () => {
    await expect(preflightClaudeBinary("claude", async () => true)).resolves.toBeUndefined();
  });
});
```
NOTE: factory.test.ts mocks `./anthropic.js` at module scope (lines 40-57). That mock does NOT affect ClaudeCodeAdapter. Importing the REAL `ClaudeCodeAdapter` is fine because constructing it does NOT call execa (execa only runs inside `chat()`). So `createClient("claude-code", ...)` is safe in factory.test.ts without mocking execa there. If you prefer, assert binary/timeout passthrough via the dedicated `claude-code.test.ts` (sc-4-5) rather than in factory.test.ts.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/providers/index.ts` | adds export of `./claude-code.js` | low | New named export; barrel re-export, no behavior change. |
| `src/providers/factory.test.ts` | `createClient`, `validateApiKey` from `./factory.js` | medium | New switch case + ProviderName change; existing tests must still pass (esp. unsupported-provider regex at :154-159 and the `./anthropic.js` mock). |
| Callers of `createClient` (grep `from.*factory` / `createClient`) | `factory.ts` signature | HIGH if you make it async | Do NOT change createClient to async/Promise — existing callers use it synchronously. Keeping it sync = zero blast radius. |
| `ProviderName` consumers | `factory.ts:11` union | low | Widening a union is additive; existing exhaustive switches gain an unhandled case only if they `switch` on ProviderName exhaustively — grep below. |

Run to confirm caller surface before editing:
```
grep -rn "createClient\|ProviderName\|validateApiKey" src/ --include=*.ts | grep -v ".test.ts" | grep -v "providers/factory.ts"
```

### Existing Tests That Must Still Pass
- `src/providers/factory.test.ts` — tests createClient for google/openai-compat/anthropic/openai, validateApiKey for all providers, unsupported-provider error (`:154-159` asserts `/anthropic, openai, google, openai-compat/`). Adding `claude-code` to the error string keeps this regex matching (substring). VERIFY it still passes.
- `src/providers/preflight.test.ts` — Sprint-3 tests; untouched, must still pass.
- `src/providers/anthropic.test.ts`, `google.test.ts`, `openai.test.ts`, `openai-compat.test.ts` — untouched; ensure no shared-module change broke them (it won't — you only add a case + an import).
- Any worktree/git test that uses REAL execa (`worktree.test.ts`, `run-in-worktree.test.ts`) — your `vi.mock("execa")` is SCOPED to `claude-code.test.ts` only (vitest isolates module mocks per test file), so it will NOT leak into those. VERIFY by running full `npm test`.

### Features That Could Be Affected
- **feat-5 (this sprint)** — claude-code provider promotion. Self-contained.
- **Sprint 5 (out of scope)** — role-aware fallback when a tool role resolves to claude-code. Your tools-guard throw (claude-code.ts:112-119) is the hook Sprint 5 builds on; do NOT weaken it.
- **DeepSeek (Sprint 2)** — shares `validateApiKey`/`createClient`. Verify the DeepSeek key gate (factory.ts:92-100, 208-214) is untouched.

### Recommended Regression Checks
1. `npm run build` — exits 0 (sc-4-6). NodeNext: verify the `./claude-code.js` import specifier compiles.
2. `npm run lint` — exits 0 (sc-4-6). eslint over `src/`.
3. `npx vitest run src/providers/` — all provider tests pass, including the new `claude-code.test.ts`.
4. `npx vitest run` (full) — confirm the execa mock did not leak into git/worktree tests.
5. `grep -rn "vi.mock(\"execa\")" src/providers/claude-code.test.ts` — confirm execa IS mocked (evaluatorNotes requirement: no real spawn).

---

## 8. Implementation Sequence

1. **src/providers/claude-code.ts** — soften the SPIKE header (lines 1-31): keep capability-boundary doc, drop "SPIKE"/"read before wiring" framing. Do NOT touch the constructor, the tools-guard throw, the execa call, or the result mapping.
   - Verify: file still exports `class ClaudeCodeAdapter`; throw string at ~line 113 unchanged.
2. **src/providers/factory.ts** — (a) add `import { ClaudeCodeAdapter } from "./claude-code.js";`; (b) add `"claude-code"` to ProviderName (line 11); (c) add `case "claude-code": break;` to validateApiKey switch; (d) add the `case "claude-code": { ...return new ClaudeCodeAdapter(binary, timeoutMs); }` to createClient switch; (e) add the exported `BinaryProbe` type + `defaultBinaryProbe` + `preflightClaudeBinary` (§6 B2); (f) append `claude-code` to the default-case "Supported providers" string.
   - Verify: `npx tsc --noEmit` clean; createClient stays `: LLMClient` (sync).
3. **src/providers/index.ts** — add `export { ClaudeCodeAdapter } from "./claude-code.js";` (also consider exporting `preflightClaudeBinary`/`BinaryProbe` if the orchestrator needs them; not required by success criteria).
   - Verify: barrel compiles.
4. **src/providers/claude-code.test.ts** — create with the §6 execa-mock template: sc-4-3 (result/usage mapping), sc-4-4 (tools throw + no execa call), sc-4-5 (binary+timeout passthrough). Mock execa via `vi.mock("execa", () => ({ execa: vi.fn() }))`.
   - Verify: `npx vitest run src/providers/claude-code.test.ts` green.
5. **src/providers/factory.test.ts** — add the `describe("claude-code provider")` block: sc-4-1 (instanceof), sc-4-2 (validateApiKey no-throw + preflightClaudeBinary both branches).
   - Verify: `npx vitest run src/providers/factory.test.ts` green; existing tests unaffected.
6. **Run full verification** — `npm run build` (exit 0), `npm run lint` (exit 0), `npx vitest run` (all pass, no execa leakage).

---

## 9. Pitfalls & Warnings

- **DO NOT make createClient async.** It is `: LLMClient` (sync) at factory.ts:135 with many sync callers. Making it `Promise<LLMClient>` is a breaking, out-of-scope change. Put the async PATH probe in the exported `preflightClaudeBinary` helper (§6 B2).
- **DO NOT read ANTHROPIC_API_KEY for claude-code** (nonGoal, contract:54). The validateApiKey claude-code case is a pure `break;`. Tests must pass with NO ANTHROPIC_API_KEY set.
- **execa is a NAMED export.** The mock factory MUST be `() => ({ execa: vi.fn() })`, NOT `{ default: vi.fn() }`. Importing `{ execa }` after the mock gives you the `vi.fn()`.
- **Mock stdout must be a JSON STRING.** chat() does `JSON.parse(result.stdout)` (claude-code.ts:158). Use `JSON.stringify({...})`. A raw object will throw the "non-JSON output" error.
- **Mock result must have `exitCode: 0`.** chat() throws if `exitCode !== 0` (claude-code.ts:148). Omit/false `is_error` (claude-code.ts:165).
- **NodeNext ESM `.js` extensions.** All relative imports MUST end in `.js` (e.g. `"./claude-code.js"`, NOT `"./claude-code"`). See existing index.ts:18-21 and factory.ts:1-6.
- **The tools-guard throw string is load-bearing for sc-4-4.** Leave it EXACTLY as-is (claude-code.ts:113-118). If you change it, update the test regex `/cannot return custom tool_use blocks/`.
- **Do NOT add the Claude Agent SDK as a dependency** (nonGoal, contract:55). Only `execa` (already a dep) is used.
- **Do NOT make a real claude CLI call in any test** (nonGoal, contract:56; evaluator greps for the execa mock). Every chat() test path goes through `vi.mocked(execa)`.
- **factory.test.ts already mocks `./anthropic.js`** at module scope. That mock won't interfere with ClaudeCodeAdapter, but be aware the file has top-level `await import` (factory.test.ts:61) — keep new imports consistent with its ESM-with-top-level-await style.
- **The unsupported-provider test (factory.test.ts:154-159)** asserts a substring regex `/anthropic, openai, google, openai-compat/`. Appending `, claude-code` to the message keeps it passing (still a substring). Do not reorder/rename the existing four.
