# Sprint Briefing: Cost substrate — CostMeter price table, ChatResponse.costUsd, Budget maxUsd

**Contract:** sprint-spec-20260709-agent-loop-capability-port-2
**Generated:** 2026-07-09T21:00:00Z

> Scope reminder (nonGoals): NO loop wiring, NO config schema fields, NO config-overridable table, NO runtime price fetch. This sprint builds a dormant money layer. Omitting `maxUsd`/`costUsd` must be byte-identical to today.

---

## 1. Target Files

### src/providers/cost-meter.ts (create)

**Directory pattern:** `src/providers/` uses kebab-case filenames, collocated `*.test.ts`, `import type` for type-only imports, `.js` NodeNext extensions. Most similar pure module to mirror for structure/JSDoc density: `src/orchestrator/model-resolver.ts` (a const map + a pure lookup fn).

**Interface — extract VERBATIM from arch doc `arch-20260709-agent-sdk-agent-loop-harness-architecture.md:136-147`:**
```typescript
type PriceRow = { inputPerMillion: number; outputPerMillion: number };
type PriceTable = Record<string, PriceRow>; // key `${provider}:${modelPrefix}`

interface CostMeter {
  estimateCostUsd(input: {
    provider: ProviderName;
    model: string;
    usage: TokenUsage;
  }): number | undefined; // longest-prefix match; undefined if none
}
```
Arch note line 148: *"Pure, no I/O; `claude-code` never consults it."* Line 150: **Dependencies: []** — keep this file dependency-free.

**Structure template (skeleton the Generator should produce):**
```typescript
import type { ProviderName } from "./factory.js"; // TYPE-ONLY (erased → no runtime cycle)

export interface PriceRow { inputPerMillion: number; outputPerMillion: number }
export type PriceTable = Record<string, PriceRow>; // key `${provider}:${modelPrefix}`

// Prices as of 2026-07 (list prices; guardrail semantics, not billing)
export const PRICE_TABLE: PriceTable = { /* rows — see §Pricing below */ };

export function estimateCostUsd(input: {
  provider: ProviderName;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}): number | undefined {
  if (input.provider === "claude-code") return undefined; // never estimated (ADR-3)
  const fullKey = `${input.provider}:${input.model}`;
  const match = Object.keys(PRICE_TABLE)
    .filter((k) => fullKey.startsWith(k))
    .sort((a, b) => b.length - a.length)[0]; // longest-prefix wins
  if (match === undefined) return undefined;
  const row = PRICE_TABLE[match]!;
  return (
    (input.usage.inputTokens / 1_000_000) * row.inputPerMillion +
    (input.usage.outputTokens / 1_000_000) * row.outputPerMillion
  );
}
```
**Decisions the Generator must make (see §9 pitfalls):** (a) `TokenUsage` in the arch interface lives in `budget.ts` — do NOT import it across module boundaries; inline `{ inputTokens; outputTokens }` to honor Dependencies:[]. (b) `ProviderName` import MUST be `import type` (ESLint `consistent-type-imports` + avoids a runtime import cycle since `factory.ts` imports the adapters which will import this file). (c) Export `PRICE_TABLE` so the test derives expected dollars from the same constants (no magic numbers in tests).

---

### src/providers/cost-meter.test.ts (create)
Collocated Vitest. Cover (evaluatorNotes): exact prefix hit; **longer-prefix-wins** (e.g. `grok-4` vs `grok-4-fast`, or `gpt-4.1` vs `gpt-4.1-mini`); unknown model → `undefined`; `provider:"claude-code"` → `undefined`; arithmetic `= in/1e6*inPM + out/1e6*outPM`. Derive `expected` from `PRICE_TABLE[row]` — never hardcode dollars.

---

### src/providers/types.ts (modify) — ChatResponse at lines 219-231
**Current (219-231):**
```typescript
export interface ChatResponse {
  /** The assistant's text response (may be empty if only tool calls). */
  text: string;
  /** Tool calls requested by the model (may be empty). */
  toolCalls: ToolCall[];
  /** Why the model stopped generating. */
  stopReason: StopReason;
  /** Token usage for this request. */
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}
```
**Change:** add ONE optional field after `usage` (arch doc line 162 `costUsd?: number; // NEW`). JSDoc it: real vendor cost for `claude-code`, else a `CostMeter` estimate; absent when unknown. `LLMClient.chat` signature is UNCHANGED.

---

### src/providers/claude-code.ts (modify) — return block lines 182-190
`total_cost_usd?: number` is ALREADY parsed into the `ClaudeCliResult` interface at **line 55** and currently DISCARDED. Thread it through the return (lines 182-190):
```typescript
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
**Change:** conditional-spread the vendor-authoritative value so the key is ABSENT when the CLI omits it (older CLIs): `...(typeof parsed.total_cost_usd === "number" ? { costUsd: parsed.total_cost_usd } : {})`. **DO NOT import cost-meter here** (ADR-3: claude-code never estimates — generatorNotes are explicit). sc-2-2.

---

### src/providers/anthropic.ts (modify) — usage at 327-330, returns at 340-346 and 349-354
Two return sites share the `usage` object built at 327-330. Compute cost ONCE after 330, spread into BOTH returns.
```typescript
    const usage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
    // ... structured return (340-346) and normal return (349-354) both spread ...usage
```
**Change:** `import { estimateCostUsd } from "./cost-meter.js";` then
`const costUsd = estimateCostUsd({ provider: "anthropic", model, usage });`
and add `...(costUsd !== undefined ? { costUsd } : {})` to both the structured return (340) and the normal return (349). `model` is already destructured in `chat`. sc-2-3.

---

### src/providers/openai.ts (modify) — class 327-346, returns at 443-448, 456-464, 471-479
Class fields (327-346): `private readonly model` and `private readonly baseURL` (endpoint). Three ChatResponse return sites: empty-choice (443, zero usage), refusal (456, real usage), normal (471, real usage). Normal return:
```typescript
    return {
      text,
      toolCalls,
      stopReason,
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
    };
```
**Change:** `import { estimateCostUsd } from "./cost-meter.js";`. Compute cost from each return's usage and conditional-spread into the refusal (456) and normal (471) returns (empty-choice at 443 has zero usage → cost 0 or omit; either is acceptable, be consistent). Provider key MUST be provider-aware — see §9 pitfall "openai vs openai-compat key". sc-2-3.

---

### src/providers/openai-compat.ts (modify) — class 31-63
`OpenAICompatAdapter extends OpenAIAdapter`; `chat()` (53-63) only guards documents then delegates `return super.chat(params)`. It therefore inherits the shared cost computation in `OpenAIAdapter.chat`. **The only change here is to make the shared code emit the `openai-compat` provider key** (DeepSeek/Grok prices differ from OpenAI). Recommended: add a `protected` provider discriminator on OpenAIAdapter (default `"openai"`) and `override` it here to `"openai-compat"` — see §9. sc-2-3.

---

### src/orchestrator/workflow/budget.ts (modify) — additive USD axis
Current shape (all additive-only edits): `BudgetOptions` 19-24, `BudgetExceededError` 27-36, `Budget` 38-103.
```typescript
export interface BudgetOptions {
  maxTokens?: number | null;   // 20-21
  maxAgents?: number | null;   // 22-23
}
export class BudgetExceededError extends Error {
  constructor(message: string, readonly kind: "tokens" | "agents") { ... }  // 27-36
}
export class Budget {
  private inputTokens = 0; private outputTokens = 0; private agents = 0;  // 39-41
  chargeTokens(usage) {...}          // 46-49
  get tokensSpent() {...}            // 57-59
  remainingTokens(): number { const max = this.opts.maxTokens; if (max==null) return Infinity; return Math.max(0, max - this.tokensSpent); }  // 67-71
  exceeded(): boolean { return this.remainingTokens()===0 || this.remainingAgents()===0; }  // 81-83
  assertWithinBudget(): void { if (this.remainingTokens()===0) throw new BudgetExceededError(..., "tokens"); if (this.remainingAgents()===0) throw ...("agents"); }  // 89-102
}
```
**Changes (mirror the token axis exactly, all optional/default-off):**
1. `BudgetOptions`: add `maxUsd?: number | null;` (null/omitted = unlimited).
2. `Budget`: add `private usd = 0;`.
3. `chargeUsd(usd: number): void` — **guard `if (!Number.isFinite(usd) || usd < 0) return;`** (NaN/negative/±Infinity → treated as 0) then `this.usd += usd;` (sc-2-4).
4. `get usdSpent(): number { return this.usd; }`.
5. `remainingUsd(): number` — Infinity when `maxUsd == null`, else `Math.max(0, maxUsd - this.usd)`.
6. `exceeded()`: OR-in `this.remainingUsd() === 0`.
7. `assertWithinBudget()`: add a third `if (this.remainingUsd() === 0) throw new BudgetExceededError(..., "usd");`.
8. `BudgetExceededError` kind union: `"tokens" | "agents" | "usd"`.

**Imported by:** NOTHING outside `budget.test.ts` (grep for `workflow/budget` across `src/` returns only the test — the class is Sprint-3-dormant). Source-compatibility is therefore trivially preserved: every existing signature stays, all edits are additive. ADR-4 (`arch...adr-4.md`) confirms `assertWithinBudget`/`BudgetExceededError` are **retained** for the future workflow-interpreter pre-dispatch use — do NOT remove them.

**Test file:** `src/orchestrator/workflow/budget.test.ts` (exists).

---

## 2. Patterns to Follow

### Conditional-spread to keep a key absent when a value is undefined
**Source:** `src/providers/openai.ts:436`, `src/providers/anthropic.ts:314-322`
```typescript
      ...(oaiTools ? { tools: oaiTools } : {}),          // openai.ts:436
      ...(effort !== undefined ? { output_config: { effort } } : {}),  // anthropic.ts:314
```
**Rule:** For every `costUsd` insertion use `...(costUsd !== undefined ? { costUsd } : {})` (and for claude-code, guard on `typeof parsed.total_cost_usd === "number"`). This is exactly how the sprint keeps the field ABSENT (`Object.hasOwn` false) when unpriced — the evaluator asserts absence, not `=== undefined`.

### Pure const-map + lookup module
**Source:** `src/orchestrator/model-resolver.ts:22-46` (`SHORTHAND_MAP` const + pure resolver)
```typescript
const SHORTHAND_MAP: Record<string, { provider: string; modelId: string }> = {
  opus: { provider: "anthropic", modelId: "claude-opus-4-8" },
  sonnet: { provider: "anthropic", modelId: "claude-sonnet-4-6" },
  // ...
};
```
**Rule:** Model `cost-meter.ts` after this: a top-level exported const table + a pure exported function. No classes, no I/O.

### Uncapped axis returns Infinity; charge guards clamp
**Source:** `src/orchestrator/workflow/budget.ts:67-71`
```typescript
  remainingTokens(): number {
    const max = this.opts.maxTokens;
    if (max === null || max === undefined) return Infinity;
    return Math.max(0, max - this.tokensSpent);
  }
```
**Rule:** `remainingUsd()` is a byte-for-byte analog with `maxUsd`. `exceeded()`/`assertWithinBudget()` extend by the same shape.

---

## 3. Existing Utilities — DO NOT Recreate

Directories reviewed: `src/providers/`, `src/orchestrator/`, `src/orchestrator/workflow/`. (No `src/utils` or `src/lib` — helpers are collocated.)

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `ProviderName` | `src/providers/factory.ts:13` | `"anthropic" \| "openai" \| "google" \| "openai-compat" \| "claude-code"` | The exact provider union CostMeter's `provider` param must use (import TYPE-ONLY). |
| `ChatResponse` | `src/providers/types.ts:219-231` | `interface { text; toolCalls; stopReason; usage; }` | The response type gaining `costUsd?`. |
| `TokenUsage` | `src/orchestrator/workflow/budget.ts:14-17` | `{ inputTokens: number; outputTokens: number }` | Arch interface names this for CostMeter usage — but do NOT cross-import it into `providers/`; inline the shape. |
| `SHORTHAND_MAP` / `resolveProviderModel` | `src/orchestrator/model-resolver.ts:22`, `:52+` | shorthand → `{provider, modelId}` | Source of the REAL model-id strings your price keys must prefix-match. CostMeter does NOT call this (adapters already hold the resolved `params.model`). |
| `mapStopReason` | `src/providers/claude-code.ts:59` | `(raw?) => StopReason` | Existing CLI stop-reason mapper — untouched; shown so you don't duplicate it. |
| `BudgetExceededError` | `src/orchestrator/workflow/budget.ts:27` | `class extends Error { kind }` | Extend the `kind` union to add `"usd"`; do not create a new error class. |

**Confirmed NOT to exist (grep across `src/**/*.ts`): any price/cost table, `estimateCostUsd`, `PriceRow`, `PriceTable`, `costUsd`, `inputPerMillion`.** Only `total_cost_usd` exists (claude-code.ts). You are building the money layer from scratch — nothing to reuse, nothing to collide with.

---

## 4. Prior Sprint Output

### Sprint 1 (commit 35a2dbd): refusal detection
**Touched:** `src/providers/anthropic.ts`, `src/providers/openai.ts` — added explicit `stopReason: "refusal"` return paths; `types.ts` `StopReason` doc mentions `"refusal"` (types.ts:206-214); `parseGeneratorResult` fail-closed.
**Connection to this sprint:** The openai refusal return at `openai.ts:456-464` is Sprint-1 code — it carries real `usage`, so your `costUsd` spread should include it too. No refactor of Sprint-1 logic; you are adding an orthogonal `costUsd` field alongside the `stopReason` work. `dependsOn` is empty in the contract, but this is the same `spec-20260709-agent-loop-capability-port` and the loop wiring is Sprint 3 (out of scope here).

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` at repo root governing this sprint. Governing conventions come from the tech stack: TypeScript strict ESM (NodeNext, `.js` import extensions), Zod config, Vitest collocated tests, ESLint flat config with `consistent-type-imports`.

### Architecture Decisions (govern this sprint)
- **ADR-3** (`.bober/architecture/arch-20260709-agent-sdk-agent-loop-harness-adr-3.md`): *Compute per-request USD cost in the ADAPTER, not the loop or Budget.* claude-code returns its authoritative `total_cost_usd` (incl. cache tokens the loop never sees); token-priced adapters call CostMeter. **Consequence:** `ChatResponse` gains optional `costUsd`; with no matching price row `costUsd` is undefined and behavior is byte-identical. **Risk mitigation:** return `undefined` for unknown models (never a silently-wrong number).
- **ADR-4** (`...adr-4.md`): budget-exceeded is a graceful in-loop stop in Sprint 3 — NOT this sprint. Relevant only in that it confirms `assertWithinBudget`/`BudgetExceededError` remain available (do not delete them) for the workflow interpreter's pre-dispatch use.
- **Main arch doc** (`...architecture.md:131-148`): the CostMeter interface (extracted verbatim in §1). Lines 133/145/263: unknown `provider:model` → `undefined` (fail-open); `provider "claude-code"` → `undefined` (never consulted).

### Other Docs
Contract `nonGoals`/`outOfScope`: no config schema, no config-overridable table, no runtime fetch, no loop charging — all Sprint 3.

---

## 6. Testing Patterns

### Unit test — claude-code (mocked execa CLI)
**Source:** `src/providers/claude-code.test.ts:11-46`
```typescript
vi.mock("execa", () => ({ execa: vi.fn() }));      // NAMED export, hoisted
import { execa } from "execa";
const mockedExeca = vi.mocked(execa);
beforeEach(() => mockedExeca.mockReset());

mockedExeca.mockResolvedValue({
  exitCode: 0,
  stdout: JSON.stringify({
    type: "result", result: "hi", stop_reason: "end_turn",
    usage: { input_tokens: 42, output_tokens: 7 },
    total_cost_usd: 0.0123,          // ← add this for the passthrough test
  }),
  stderr: "",
} as never);
```
For sc-2-2: one test WITH `total_cost_usd` asserts `res.costUsd === 0.0123`; one WITHOUT it asserts `Object.hasOwn(res, "costUsd") === false`.

### Unit test — anthropic (static default-import SDK mock)
**Source:** `src/providers/anthropic.test.ts:24-53`
```typescript
const createMock = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic { messages = { create: createMock }; constructor(_?: unknown) {} }
  return { default: FakeAnthropic };            // MUST be { default: ... }
});
import { AnthropicAdapter } from "./anthropic.js";
beforeEach(() => { createMock.mockReset(); createMock.mockResolvedValue({
  content: [{ type: "text", text: "ok" }], stop_reason: "end_turn",
  usage: { input_tokens: 5, output_tokens: 7 },
}); });
// new AnthropicAdapter("k") → adapter.chat({ model: "claude-opus-4-8", system, messages })
```
For sc-2-3: priced model `claude-opus-4-8` → `costUsd === estimateCostUsd({provider:"anthropic",model:"claude-opus-4-8",usage:{inputTokens:5,outputTokens:7}})`; unpriced model `claude-nonexistent-99` → `Object.hasOwn(res,"costUsd") === false`.

### Unit test — openai / openai-compat (dynamic-import mock + cache-busting re-import)
**Source:** `src/providers/openai.test.ts:78-90`, `src/providers/openai-compat.test.ts:79-90`
```typescript
beforeEach(() => { createFn = vi.fn(); vi.doMock("openai", () => ({ default: makeFakeOpenAI(createFn) })); });
async function makeAdapter(model = "gpt-4.1") {
  const { OpenAIAdapter } = await import("./openai.js?v=" + Date.now()); // re-import AFTER doMock
  return new OpenAIAdapter(model, "test-api-key");
}
// openai-compat: const { OpenAICompatAdapter } = await import("./openai-compat.js?v=" + Date.now());
//                new OpenAICompatAdapter("https://api.deepseek.com", "deepseek-v4-pro")
```
`makeOAIResponse({ promptTokens, completionTokens })` (openai.test.ts:44-70) builds the fake response; usage defaults 10/20. For sc-2-3: openai priced (`gpt-4.1`) vs unpriced; openai-compat priced (`deepseek-v4-pro`/`grok-4-fast`) asserts the DeepSeek/Grok row is used, NOT the OpenAI row.

**Runner:** vitest · **Assertion:** `expect` · **Mock:** `vi.mock` (static SDKs) / `vi.doMock`+dynamic re-import (openai family) / `vi.mock("execa")` (CLI) · **File naming:** collocated `*.test.ts` · **Location:** co-located next to source.

### Budget test pattern
**Source:** `src/orchestrator/workflow/budget.test.ts:9-82`
```typescript
import { Budget, BudgetExceededError } from "./budget.js";
it("assertWithinBudget throws BudgetExceededError tagged by kind", () => {
  const b = new Budget({ maxTokens: 10 });
  b.chargeTokens({ inputTokens: 10, outputTokens: 1 });
  try { b.assertWithinBudget(); } catch (e) {
    expect(e).toBeInstanceOf(BudgetExceededError);
    expect((e as BudgetExceededError).kind).toBe("tokens");
  }
});
```
Add USD analogs (sc-2-4): `new Budget({ maxUsd: 1 })`; charge sequence crossing 1.0 → `exceeded()` true, `assertWithinBudget()` throws with `kind === "usd"`; uncapped → `remainingUsd() === Infinity`; `chargeUsd(NaN)` / `chargeUsd(-5)` → `usdSpent` unchanged (treated as 0).

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/providers/anthropic.test.ts` | anthropic.ts | low | `fakeResponse()` has no `total_cost_usd`; existing assertions don't inspect `costUsd` — adding the optional field is additive. |
| `src/providers/openai.test.ts` | openai.ts | low | Existing return-shape assertions must not break; `costUsd` only appears for priced models. |
| `src/providers/openai-compat.test.ts` | openai-compat.ts | medium | Delegates to super; verify the `openai-compat` provider key resolves (DeepSeek/Grok) and does NOT accidentally use OpenAI prices. |
| `src/providers/claude-code.test.ts` | claude-code.ts | low | Existing "no result/usage" test must still pass with `costUsd` absent. |
| `src/orchestrator/workflow/budget.test.ts` | budget.ts | low | All 9 existing token/agent tests must pass byte-identically — the USD axis is purely additive. |
| Any `ChatResponse` consumer (agentic-loop, structured, roles) | types.ts | low | `costUsd?` is optional — no consumer is forced to read it; TS structural typing unaffected. |

**Budget dependents:** grep `workflow/budget` across `src/` → ONLY `budget.test.ts`. No production caller of `Budget`/`BudgetExceededError`/`assertWithinBudget` exists yet (Sprint-3 wiring). Source-compat risk is therefore near-zero.

### Existing Tests That Must Still Pass
- `src/providers/anthropic.test.ts` — prompt-caching + response normalisation; verify unchanged with `costUsd` added.
- `src/providers/openai.test.ts` / `openai-compat.test.ts` — tool/message conversion + normalisation + refusal (Sprint 1).
- `src/providers/claude-code.test.ts` — result/usage mapping, tools-guard, documents-guard.
- `src/orchestrator/workflow/budget.test.ts` — all token/agent ceilings (sc-2-5).
- Full suite baseline: **3699 green** (Sprint 1) — must remain green (sc-2-5).

### Features That Could Be Affected
- **Refusal detection (Sprint 1)** — shares `anthropic.ts`/`openai.ts` return blocks. Verify the refusal return path still emits `stopReason:"refusal"` AND now optionally `costUsd`.
- **Sprint 3 (loop budget wiring)** — CONSUMER of this sprint. Do NOT pre-wire; just leave the substrate correct (`chargeUsd`, `costUsd`, `remainingUsd`).

### Recommended Regression Checks
1. `npm run build` — passes (sc-2-6).
2. `npm run typecheck` — passes (sc-2-6).
3. `npx vitest run src/providers src/orchestrator/workflow/budget.test.ts` — targeted green.
4. Full suite green (sc-2-5): `npm test` (expect ≥ 3699 + new cases).
5. Manual grep: `grep -rn "workflow/budget" src` still shows only `budget.test.ts` (no accidental loop wiring).

---

## 8. Implementation Sequence (dependency-ordered)

1. **src/providers/types.ts** — add `costUsd?: number` to `ChatResponse` (219-231). No deps; unblocks every adapter return.
   - Verify: `npm run typecheck` still passes (optional field).
2. **src/providers/cost-meter.ts** — `PriceRow`, `PriceTable`, exported `PRICE_TABLE` (dated comment), `estimateCostUsd` (longest-prefix, claude-code→undefined). `import type { ProviderName }` only.
   - Verify: no runtime import of factory (type-only); `npm run build`.
3. **src/providers/cost-meter.test.ts** — prefix/longer-prefix/unknown/claude-code/arithmetic (derive expected from `PRICE_TABLE`).
   - Verify: `npx vitest run src/providers/cost-meter.test.ts`.
4. **src/orchestrator/workflow/budget.ts** — additive USD axis (independent of adapters).
5. **src/orchestrator/workflow/budget.test.ts** — USD tests; keep all 9 existing tests unchanged.
   - Verify: `npx vitest run src/orchestrator/workflow/budget.test.ts`.
6. **src/providers/claude-code.ts** — thread `total_cost_usd` into return (conditional spread; NO cost-meter import) + tests.
7. **src/providers/anthropic.ts** — import `estimateCostUsd`, compute once from `usage`, spread into both returns (340, 349) + tests.
8. **src/providers/openai.ts** — import `estimateCostUsd`, add `protected` provider discriminator (default `"openai"`), spread costUsd into refusal (456) + normal (471) returns + tests.
9. **src/providers/openai-compat.ts** — `override` provider discriminator → `"openai-compat"` + tests asserting DeepSeek/Grok row is used.
10. **Full verification** — `npm run build`, `npm run typecheck`, `npm test` (≥ 3699 green + new cases).

---

## 9. Pitfalls & Warnings

- **PRICE NUMBERS — no confirmed table exists in-repo.** The arch docs carry only the CostMeter *interface* (`architecture.md:136-147`), NOT dollar values. The real model IDs your keys must prefix-match are current-generation, future-dated strings (`claude-opus-4-8`/`-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5`, `gpt-4.1`/`-mini`, `o3`, `o4-mini`, `gemini-2.5-pro`/`-flash`, `deepseek-v4-pro`/`-flash`, `grok-4`/`-fast` — from `model-resolver.ts:22-46`). Populate rows with best-known list prices under the MANDATORY comment `// Prices as of 2026-07 (list prices; guardrail semantics, not billing)`. Because tests derive `expected` from `PRICE_TABLE` (not external ground truth), exact dollar accuracy is NOT a correctness gate — structure, prefix-match, `undefined`-for-unknown, and arithmetic self-consistency are. If a provider's price truly cannot be estimated, prefer omitting that row (undefined = safe fail-open) — but sc-2-1 REQUIRES at least one row for each of anthropic/openai/openai-compat(DeepSeek+Grok)/google, so include a plausible dated row for each family.
- **generatorNotes model names have DRIFTED.** They say `claude-fable-5`, `claude-sonnet-5` — neither exists in `model-resolver.ts` (there is NO `claude-fable`; it is `claude-sonnet-4-6`). Key your prefixes against the ACTUAL resolver IDs above, e.g. `anthropic:claude-opus-4` (matches -4-8 and -4-7), `anthropic:claude-sonnet-4`, `anthropic:claude-haiku-4-5`. A short `anthropic:claude` catch-all is fine (longest-prefix keeps the specific rows winning).
- **openai vs openai-compat price key.** `OpenAICompatAdapter extends OpenAIAdapter` and delegates `chat()` to `super.chat` (`openai-compat.ts:62`), so the SHARED code computes cost. If you hardcode `provider:"openai"` there, DeepSeek/Grok get OpenAI prices — WRONG. Recommended fix (smallest surface, no constructor/factory change): add `protected readonly costProvider: ProviderName = "openai";` on `OpenAIAdapter`, `override` it to `"openai-compat"` in `OpenAICompatAdapter`, and call `estimateCostUsd({ provider: this.costProvider, ... })`. (The `this.baseURL`-presence heuristic is simpler but misfires if a plain `openai` provider is ever given a custom endpoint — factory.ts:252-258 does pass `endpoint ?? undefined` to the openai case.)
- **Do NOT import `cost-meter` into `claude-code.ts`.** ADR-3 + generatorNotes: claude-code returns real `total_cost_usd` and NEVER estimates. Importing cost-meter there is an evaluator-visible violation.
- **Import cycle:** `factory.ts` imports adapters (value) → adapters will import `cost-meter` (value) → `cost-meter` imports `ProviderName` from `factory` — this is only safe if that last import is `import type` (erased at runtime). ESLint `consistent-type-imports` also mandates it.
- **Do NOT cross-import `TokenUsage` from `budget.ts` into `providers/`.** It would couple the providers layer to `orchestrator/workflow` and violate CostMeter's `Dependencies: []`. Inline `{ inputTokens: number; outputTokens: number }`.
- **`chargeUsd` guard order:** check `!Number.isFinite(usd) || usd < 0` FIRST (catches `NaN`, `±Infinity`, negatives → treat as 0), THEN accumulate. `undefined` never reaches it in-sprint, but the loop (Sprint 3) will pass `response.costUsd ?? 0`.
- **Absence, not undefined:** the evaluator checks `Object.hasOwn(res, "costUsd") === false` for unpriced models — a literal `costUsd: undefined` FAILS that. Always use conditional spread.
- **Existing budget tests are byte-frozen:** all 9 tests in `budget.test.ts` must pass unchanged (sc-2-5). Only ADD USD tests.
