# Sprint Briefing: Upgrade @anthropic-ai/sdk 0.39.0 → 0.100.1 (Opus 4.8 API fields)

**Contract:** sprint-spec-20260529-opus-4-8-support-2
**Generated:** 2026-05-29T19:10:00Z
**Risk level:** HIGH (major version jump across ~60 minor releases). This briefing exists to DE-RISK the bump.

> TL;DR: The good news from the type diff — the SDK kept full backward compatibility for every API surface this adapter touches. `new Anthropic({ apiKey })`, `Anthropic.Messages.<Type>` namespace access, `messages.create({ model, max_tokens, system, messages, tools })`, the `system: string | TextBlockParam[]` shape, `cache_control: { type: 'ephemeral' }`, `Usage.input_tokens/output_tokens`, and the `Message["stop_reason"]` indexed-access pattern all still resolve. The expected outcome is a CLEAN compile with NO adapter code changes — only `package.json` + `package-lock.json` change. The job is mostly: bump, install, verify, and watch the handful of low-probability gotchas in Section 9.

---

## 1. Target Files

### package.json (modify)

**Relevant section (lines 59-70), dependencies block:**
```jsonc
"dependencies": {
  "@anthropic-ai/sdk": "^0.39.0",   // ← line 60: bump to ^0.100.1
  "@modelcontextprotocol/sdk": "^1.28.0",
  ...
}
```
**Change:** line 60 `"@anthropic-ai/sdk": "^0.39.0"` → `"@anthropic-ai/sdk": "^0.100.1"`.
**Test file:** n/a.

### package-lock.json (modify)

**Change:** regenerate by running `npm install` after editing package.json. Do NOT hand-edit. Commit the regenerated lockfile.
**Test file:** n/a.

### src/providers/anthropic.ts (modify — EXPECTED: zero changes needed; verify compile)

This is the ONLY file in the repo that imports `@anthropic-ai/sdk` (confirmed by grep, Section 7). Every SDK touch point below was diffed against 0.100.1 and is backward-compatible. Enumerated touch points with file:line and the diff verdict:

| # | Touch point | Line(s) | SDK symbol used | 0.100.1 verdict |
|---|-------------|---------|-----------------|-----------------|
| 1 | Default import | 1 | `import Anthropic from "@anthropic-ai/sdk"` | SAFE — `index.d.ts` re-exports `Anthropic as default` from `./client.js`. Default export preserved. |
| 2 | Client construction | 200, 204 | `new Anthropic({ apiKey })` | SAFE — `ClientOptions.apiKey?: string \| ApiKeySetter \| null \| undefined`. `string \| undefined` still assignable. |
| 3 | Tool type | 21, 25 | `Anthropic.Messages.Tool`, `Anthropic.Messages.Tool["input_schema"]` | SAFE — `Tool` still requires only `name` + `input_schema`; `description?` optional; new fields all optional. `Tool.InputSchema` gained optional `required?` only. |
| 4 | stop_reason normalize | 32-34, 246 | `Anthropic.Messages.Message["stop_reason"]` | SAFE — still `StopReason \| null`. Union GREW (`+ pause_turn, + refusal`); the `default:` branch (line 42-43) absorbs new members, returns them as-is (StopReason in our types.ts is `... \| string`). |
| 5 | Response content blocks | 50-51, 241 | `Anthropic.Messages.ContentBlock[]`, `response.content` | SAFE — `ContentBlock` union GREW (server-tool / web-search / code-exec blocks added) but the loop narrows on `block.type === "text"` / `"tool_use"` only; `TextBlock.text`, `ToolUseBlock.{id,name,input}` all still present. `ToolUseBlock` gained a REQUIRED `caller` field but we never construct a `ToolUseBlock`, only read narrowed fields — no impact. |
| 6 | MessageParam construction | 79-81, 84-91, 96, 113, 117-120, 145, 212 | `Anthropic.Messages.MessageParam`, `ContentBlockParam`, `ToolResultBlockParam` | SAFE — `MessageParam.content: string \| Array<ContentBlockParam>` unchanged. `role` union GREW (`+ 'system'`) but we only emit `'user'`/`'assistant'`. `ToolResultBlockParam` unchanged for our fields (`tool_use_id`, `type`, `content`, `is_error`). `ContentBlockParam` union GREW (`+ MidConversationSystemBlockParam` etc.) — a superset, so our literals stay assignable. |
| 7 | text/tool_use param literals | 100, 105-110 | `{ type: "text", text }`, `{ type: "tool_use", id, name, input }` | SAFE — `TextBlockParam` and `ToolUseBlockParam` unchanged for these required fields. |
| 8 | buildCachedSystem | 129-133 | `Anthropic.Messages.TextBlockParam[]`, `cache_control: { type: "ephemeral" }` | SAFE — `TextBlockParam.cache_control?: CacheControlEphemeral \| null`; `CacheControlEphemeral` still `{ type: 'ephemeral' }` (gained OPTIONAL `ttl?`), so `{ type: "ephemeral" }` remains assignable. |
| 9 | attachMessageBreakpoints | 143-183 | `MessageParam[]`, `TextBlockParam` (`satisfies`, line 163), `ContentBlockParam &amp; { cache_control? }` cast (line 169) | SAFE but WATCH — see Section 9 #2. The `satisfies TextBlockParam` (line 163) is the most type-sensitive spot. Verified assignable: `{ type:"text", text, cache_control:{type:"ephemeral"} }` satisfies 0.100.1 `TextBlockParam`. |
| 10 | messages.create call | 233-239 | `this.client.messages.create({ model, max_tokens, system, messages, tools })` | SAFE — `MessageCreateParamsBase` still has `model: Model`, `max_tokens: number`, `messages: Array<MessageParam>`, `system?: string \| Array<TextBlockParam>`, `tools?`. `Model` is `'literal-union' \| (string & {})` so arbitrary model strings still accepted. Non-streaming overload `create(body: MessageCreateParamsNonStreaming): APIPromise<Message>` returns `Message` — `.content`, `.stop_reason`, `.usage` all present. |
| 11 | Usage mapping | 247-250 | `response.usage.input_tokens`, `response.usage.output_tokens` | SAFE — `Usage` GREW (`+ cache_creation, + inference_geo, + server_tool_use, + output_tokens_details`) but `input_tokens: number` and `output_tokens: number` are unchanged and still required. Adapter reads only these two. NOTE: `cache_read_input_tokens` / `cache_creation_input_tokens` exist in BOTH versions but the adapter does NOT read them (sprints 3/4 territory) — do not add. |

**Imports this file uses:**
- `Anthropic` (default) from `@anthropic-ai/sdk` (line 1)
- type-only: `LLMClient, ChatParams, ChatResponse, ToolDef, ToolCall, StopReason, Message` from `./types.js` (lines 3-11)

**Imported by:** `src/providers/factory.ts` (constructs `AnthropicAdapter`). The SDK itself is imported by NOTHING else (Section 7).

**Test file:** `src/providers/anthropic.test.ts` (exists — see Section 6).

---

## 2. Patterns to Follow

### Namespace-qualified SDK type access
**Source:** `src/providers/anthropic.ts`, lines 21, 51, 81, 84, 96, 131, 145
```ts
function toAnthropicTool(tool: ToolDef): Anthropic.Messages.Tool {
  return { name: tool.name, description: tool.description,
    input_schema: tool.input_schema as Anthropic.Messages.Tool["input_schema"] };
}
```
**Rule:** All SDK types are reached via the `Anthropic.Messages.*` namespace, never via named imports. 0.100.1 preserves this — `client.d.ts:307` re-exports `Messages as Messages` plus every type under it. Keep this style; do NOT switch to `import type { Tool } from "@anthropic-ai/sdk/resources/..."`.

### ESM `.js` import extensions + `import type`
**Source:** `src/providers/anthropic.ts`, lines 1-11; principles.md lines 27, 35
```ts
import Anthropic from "@anthropic-ai/sdk";          // value default import (no .js for packages)
import type { LLMClient, ChatParams, ... } from "./types.js";  // type-only, .js extension
```
**Rule:** Local imports use `.js` extensions (NodeNext). Type-only imports use `import type` (ESLint `consistent-type-imports`). The package import stays a bare default import.

### Indexed-access types to dodge union churn
**Source:** `src/providers/anthropic.ts`, lines 33, 25
```ts
function normalizeStopReason(reason: Anthropic.Messages.Message["stop_reason"]): StopReason { ... }
```
**Rule:** The adapter intentionally uses `Message["stop_reason"]` (indexed access) instead of the named `StopReason` type. This is robust across versions — keep it; do not "modernize" it to the now-exported `Anthropic.Messages.StopReason`.

### Section comments
**Source:** `src/providers/anthropic.ts`, lines 13, 123, 185; principles.md line 32
```ts
// ── Conversion helpers ──────────────────────────────────────────────
```
**Rule:** Preserve the unicode box-drawing section headers. (Only relevant if any edit is needed.)

---

## 3. Existing Utilities — DO NOT Recreate

This sprint touches only the adapter + manifest; no shared utils are involved. The adapter's OWN internal helpers (do not duplicate or rename) and the provider-agnostic types:

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `toAnthropicTool` | `src/providers/anthropic.ts:21` | `(tool: ToolDef) => Anthropic.Messages.Tool` | ToolDef → SDK Tool |
| `normalizeStopReason` | `src/providers/anthropic.ts:32` | `(reason: Message["stop_reason"]) => StopReason` | SDK stop_reason → our StopReason |
| `normalizeContent` | `src/providers/anthropic.ts:50` | `(content: ContentBlock[]) => { text: string; toolCalls: ToolCall[] }` | Response blocks → text + tool calls |
| `toAnthropicMessage` | `src/providers/anthropic.ts:79` | `(message: Message) => Anthropic.Messages.MessageParam` | Our Message → SDK MessageParam |
| `buildCachedSystem` | `src/providers/anthropic.ts:129` | `(system: string) => Anthropic.Messages.TextBlockParam[]` | Wrap system string with ephemeral cache_control |
| `attachMessageBreakpoints` | `src/providers/anthropic.ts:143` | `(msgs: MessageParam[]) => MessageParam[]` | Attach ≤3 ephemeral breakpoints (system-and-last-3, cap 4) |
| `AnthropicAdapter` | `src/providers/anthropic.ts:199` | `class implements LLMClient` | The adapter; `chat(params): Promise<ChatResponse>` |
| `LLMClient`, `ChatParams`, `ChatResponse`, `ToolDef`, `ToolCall`, `StopReason`, `Message` | `src/providers/types.ts` | provider-agnostic interfaces | Decouple harness from SDKs (`StopReason` = `"end"\|"tool_use"\|"max_tokens"\|"error"\|string`, types.ts:133) |

**Guardrail:** the prompt-caching behavior is FROZEN. Do not change `buildCachedSystem`/`attachMessageBreakpoints` logic, the 4-breakpoint cap, or the `cache_control: { type: "ephemeral" }` literal. The only acceptable edits are mechanical type fixes IF the compiler demands them (it should not).

---

## 4. Prior Sprint Output

### Sprint 1: Repoint opus shorthand to claude-opus-4-8
**Created/Modified:** model-resolver only (`opus` → `claude-opus-4-8`, plus an `opus-4-7` pin). NO adapter or SDK change.
**Connection to this sprint:** None functionally. `dependsOn: []` — this sprint is independent (assumption: sprint 1 may or may not be merged). The resolved model string flows in via `ChatParams.model` (a plain `string`) and is accepted by 0.100.1's `Model = <union> | (string & {})`, so any model id still compiles. Do not import or reference the resolver here.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **SDK confinement (line 28, 41):** "Never leak SDK types outside adapter files." / "Never import `@anthropic-ai/sdk` or `openai` outside of their respective adapter files." → enforced by C6. Keep the import in `anthropic.ts` ONLY.
- **ESM everywhere (line 27):** `.js` import extensions, NodeNext, no CommonJS.
- **`import type` (line 35):** ESLint `consistent-type-imports` is enforced (error).
- **No `any` without justification (line 40):** `no-explicit-any` is a WARNING; aim for zero. Contract nonGoals forbid "unjustified `any` casts to paper over SDK type changes." The existing `as` casts (lines 25, 63, 119, 169) are pre-existing and justified — keep them; do not add new ones unless the compiler genuinely forces it and you document why.
- **Type safety hard gate (line 18):** strict mode + `noUnusedLocals`/`noUnusedParameters`/`isolatedModules`. Zero type errors required (C3).
- **Conventional commit:** `bober(sprint-2): upgrade @anthropic-ai/sdk for Opus 4.8 API fields`.

### Architecture Decisions
No `.bober/architecture/` directory found. No ADRs.

### Other Docs
`tsconfig.json`: `module`/`moduleResolution` = `NodeNext`, `strict: true`, `noUnusedLocals/Parameters: true`, `isolatedModules: true`. Scripts (`package.json:11-18`): `build=tsc`, `typecheck=tsc --noEmit`, `lint=eslint src/`, `test=vitest`.

---

## 6. Testing Patterns

### Unit Test Pattern (THE MOCK MUST STAY VALID)
**Source:** `src/providers/anthropic.test.ts`, lines 18-46
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatParams } from "./types.js";

const createMock = vi.fn();

// Static default-import mock (hoisted by vitest). MUST return { default: FakeAnthropic }
// to match `export default Anthropic`.
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { create: createMock };
    constructor(_opts?: unknown) {}
  }
  return { default: FakeAnthropic };
});

import { AnthropicAdapter } from "./anthropic.js";   // imported AFTER vi.mock (hoisted)

function fakeResponse() {
  return {
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 5, output_tokens: 7 },
  };
}
```
**Runner:** vitest (`package.json` devDep `vitest@^3.0.5`; `npm run test` = `vitest`).
**Assertion style:** `expect(...).toBe / .toMatchObject / .toEqual`.
**Mock approach:** top-level `vi.mock("@anthropic-ai/sdk", () => ({ default: FakeAnthropic }))`, hoisted; a shared `createMock = vi.fn()` captures `messages.create` args; `beforeEach` resets and re-arms `createMock.mockResolvedValue(fakeResponse())` (lines 51-54).
**File naming / location:** `*.test.ts` co-located next to source (principles.md line 20).

**CRITICAL — why the mock survives the upgrade and what NOT to change:**
- The mock returns `{ default: FakeAnthropic }`. 0.100.1's `index.d.ts:1` is `export { Anthropic as default } from "./client.js"` — default export is preserved, so the mock shape is still correct. DO NOT change the mock to a named export.
- The mock's `fakeResponse()` returns a MINIMAL response (`content`, `stop_reason`, `usage.{input_tokens,output_tokens}` only). The adapter reads exactly those at runtime; mocks bypass SDK types, so the grown `Usage`/`ContentBlock` types do NOT force new mock fields. Keep `fakeResponse()` minimal — do NOT add `caller`, `cache_creation`, etc.
- The 7 caching tests (C1, C1-default, C2, C2-edge, C3, C3-multi, normalisation) assert payload SHAPE (`Array.isArray(req.system)`, `cache_control` counts ≤ 4, `req.system === "SYS"` when disabled, normalized `text/stopReason/usage`). They must pass UNCHANGED. If any fails, the adapter logic was altered — revert, the upgrade should not need logic changes.

### E2E Test Pattern
N/A for this sprint. (`tests/e2e/cockpit-integration.test.ts` exists but is unrelated; do not touch.)

---

## 7. Impact Analysis — Affected Features, Files & Tests

### SDK import isolation (C6 — verify after install)
`grep -rln '@anthropic-ai/sdk' src tests` → ONLY matches:
- `src/providers/anthropic.ts` (the import)
- `src/providers/anthropic.test.ts` (the `vi.mock` string)

No other file references the package. Keep it that way. Re-run this grep as the final C6 check.

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/providers/anthropic.test.ts` | the SDK default-export shape + adapter behavior | medium | All 7 tests pass; mock still `{ default: ... }`. |
| `src/providers/factory.ts` | `AnthropicAdapter` class (NOT the SDK) | low | `AnthropicAdapter` public surface (`constructor(apiKey?, opts?)`, `chat`) is unchanged → factory unaffected. `factory.test.ts` (26 tests) must stay green. |
| `package-lock.json` consumers (whole repo) | transitive dep tree | medium | A 60-minor jump may pull new transitive deps / drop old ones. After `npm install`, run typecheck+build+full test suite to catch any peer/transitive surprise. |

### Existing Tests That Must Still Pass
- `src/providers/anthropic.test.ts` (7 tests) — directly exercises the upgraded adapter via the mock. Highest-signal regression check.
- `src/providers/factory.test.ts` (26 tests) — constructs adapters incl. Anthropic.
- `src/providers/openai.test.ts`, `openai-compat.test.ts`, `google.test.ts` — unrelated providers; should be unaffected but run them (transitive-dep safety).
- DO NOT touch other providers' adapters (contract nonGoal).

### Tolerated Flaky Baseline (DO NOT try to fix)
2 PRE-EXISTING flaky timeout failures in the "registers exactly 37 tools" tests:
- `tests/mcp/external-server-graph.test.ts`
- `src/mcp/tools/tools.test.ts`
These are the ONLY tolerated failures. ANY failure in `src/providers/**` is a regression and a stop-the-line event.

### Features That Could Be Affected
- **feat-2 (this sprint)** — the dependency upgrade itself.
- **Sprints 3 & 4 (effort / mid_conv_system)** — depend on THIS sprint landing the typed fields, but DO NOT implement them here (contract nonGoals/outOfScope). Presence of `output_config.effort` and `mid_conv_system` is only VERIFIED, not used.

### Recommended Regression Checks (run after `npm install`)
1. `grep -rn 'output_config\|effort\|mid_conv_system' node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts` → must show `OutputConfig.effort?: 'low'|'medium'|'high'|'xhigh'|'max'|null` (line ~825-829) AND `MidConversationSystemBlockParam ... type: 'mid_conv_system'` (line ~807-812). Satisfies C1/C2.
2. `npm run typecheck` → exit 0 (C3).
3. `npm run lint` → exit 0 (C4).
4. `npm run build` → exit 0 (C4).
5. `npm run test` → all provider suites green; ONLY the 2 flaky 37-tool tests may fail (C5).
6. `grep -rln '@anthropic-ai/sdk' src` → only `src/providers/anthropic.ts` and `src/providers/anthropic.test.ts` (C6).
7. `git diff src/providers/anthropic.ts` → ideally EMPTY. If non-empty, every change must be a forced, justified type fix (no new `any`).

---

## 8. Implementation Sequence

1. **package.json** — edit line 60: `"@anthropic-ai/sdk": "^0.39.0"` → `"^0.100.1"`.
   - Verify: file shows `^0.100.1`.
2. **npm install** — regenerates `package-lock.json` and installs 0.100.1 into `node_modules`.
   - Verify: `cat node_modules/@anthropic-ai/sdk/package.json | grep version` shows `0.100.1` (or matching `^0.100.x`). Run regression check #1 (effort + mid_conv_system present).
3. **src/providers/anthropic.ts** — run `npm run typecheck`. EXPECTED: zero errors, no edits needed. If errors appear, fix ONLY the flagged lines using the namespace pattern (Section 2); prefer correct typed code over `any`; consult Section 9 for the likely culprit and its mitigation. Keep caching logic byte-identical in behavior.
   - Verify: `npm run typecheck` exits 0; `git diff` minimal/empty.
4. **src/providers/anthropic.test.ts** — EXPECTED: no edits. The mock shape (`{ default: FakeAnthropic }`) and minimal `fakeResponse()` remain valid. Only touch if a test genuinely breaks due to the upgrade (it should not).
   - Verify: `npm run test src/providers/anthropic.test.ts` → 7/7 pass.
5. **Run full verification** — `npm run typecheck` (C3), `npm run lint` (C4), `npm run build` (C4), `npm run test` (C5, tolerate only the 2 flaky 37-tool tests), then the C6 grep.
6. **Commit** — `bober(sprint-2): upgrade @anthropic-ai/sdk for Opus 4.8 API fields` (include package.json + package-lock.json + any adapter diff).

---

## 9. Pitfalls & Warnings

1. **Package layout moved, but exports are stable.** In 0.100.1 the `Anthropic` class + namespace live in `client.d.ts`; `index.d.ts` is a 7-line re-export (`export { Anthropic as default } from "./client.js"`). The default import on line 1 and the `Anthropic.Messages.*` namespace (re-exported at `client.d.ts:307`) BOTH still resolve. Do NOT switch to subpath imports.

2. **`attachMessageBreakpoints` line 169 cast is the single most type-sensitive spot.** It casts the last block to `Anthropic.Messages.ContentBlockParam & { cache_control?: { type: "ephemeral" } }` then assigns `last.cache_control`. The `ContentBlockParam` union GREW from 7 → 17 members in 0.100.1 (added `MidConversationSystemBlockParam`, server-tool/web-search/code-exec params). Because it's a SUPERSET and the cast is an intersection with an optional `cache_control`, it stays valid — every existing member still carries an optional `cache_control`. If (unlikely) this errors, the mitigation is to keep the SAME intersection cast shape, not to introduce `any`. Do NOT remove the cast.

3. **`satisfies TextBlockParam` (line 163)** is the strictest check on the cached-message literal. Verified: `{ type:"text", text, cache_control:{type:"ephemeral"} }` satisfies 0.100.1 `TextBlockParam` (only `text` + `type` required; `cache_control?` + `citations?` optional). No change expected.

4. **Do NOT add new behavior.** `output_config`/`effort` and `mid_conv_system` are present in the types but are sprints 3/4. Adding them here violates nonGoals and will likely break the C3-disabled "zero cache_control / byte-identical payload" test family. Also do NOT start reading `usage.cache_read_input_tokens` / `cache_creation_input_tokens` — the adapter currently maps only `input_tokens`/`output_tokens`; keep it that way.

5. **`ToolUseBlock` (response) gained a required `caller` field** in 0.100.1. This affects ONLY constructing a `ToolUseBlock`, which the adapter never does — `normalizeContent` reads narrowed `.id/.name/.input` off `block`. The test mock's `fakeResponse()` also bypasses the type. No action; do NOT add `caller` to the mock.

6. **`MessageParam.role` union grew to include `'system'`.** The adapter only emits `'user'`/`'assistant'` (lines 91, 113, 118). A wider union on the target type is harmless for emitting a subset. No action.

7. **Transitive-dependency drift.** A jump of ~60 minor versions can change the SDK's own deps. If `npm install` warns about peers or `npm run build` surfaces an unexpected error from a transitive package (not from `anthropic.ts`), that is the likely cause — re-run `npm install`, check the lockfile diff, and confirm Node ≥18 (`engines`, package.json:45). Do not "fix" by editing unrelated files.

8. **package-lock must be committed and consistent.** C1 requires the lock regenerated to match. Run `npm install` (not `npm ci`) so the lock updates; commit it alongside package.json.

9. **Keep the `as` casts already present** (lines 25, 63, 119, 169) — they are pre-existing/justified. Adding NEW `any` or `as any` to silence an upgrade error is explicitly forbidden by nonGoals; if the compiler forces a change, use a precise typed cast and document it in the commit body.
