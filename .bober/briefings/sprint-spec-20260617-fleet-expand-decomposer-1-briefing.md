# Sprint Briefing: FleetDecomposer module (goal to validated manifest)

**Contract:** sprint-spec-20260617-fleet-expand-decomposer-1
**Generated:** 2026-06-17T19:30:00Z

> Build ONLY `src/fleet/decomposer.ts` + collocated `src/fleet/decomposer.test.ts`. Pure module:
> goal string → one DeepSeek `LLMClient.chat` call → JSON-extract + `FleetManifestSchema.safeParse`
> + per-child `config`-key reject → at most ONE coercion re-prompt → resolve a `FleetManifest`.
> No CLI, no `createClient`, no `fs`, no real network, no Phase 1 file edits.

---

## 1. Target Files

### src/fleet/decomposer.ts (create)

**Directory pattern:** `src/fleet/` uses kebab-case file names (`child-config.ts`, `manifest.ts`, `coordinator.ts`). Tests are collocated as `<name>.test.ts`. Each module opens with section comments `// ── Name ──`.

**Most similar existing files to mirror:**
- `src/fleet/child-config.ts` — for the module shape (imports → section-commented constants → exported fn) and the DeepSeek constants.
- `src/orchestrator/planner-agent.ts:299-349` (`parsePlanSpec`) — for the JSON-extraction order and Zod-issue formatting.
- `src/orchestrator/planner-agent.ts:30-58` (`PLAN_SPEC_COERCION_INSTRUCTION`) — for the coercion-instruction constant shape.
- `src/orchestrator/agentic-loop.ts:169-194` (`coerceJsonOutput`) — for how a coercion re-prompt is assembled as a 3-message array (user → assistant priorText → user instruction) with `jsonObjectMode: true`.

**Structure template (skeleton, fill in bodies):**
```ts
import { FleetManifestSchema } from "./manifest.js";
import type { FleetManifest } from "./manifest.js";
import type { ChatResponse, LLMClient, Message } from "../providers/types.js";

// ── Constants ────────────────────────────────────────────────────────
export const DECOMPOSE_SYSTEM_PROMPT = `...`;
export const DECOMPOSE_COERCION_INSTRUCTION = `...`;
export const DECOMPOSE_MAX_RETRIES = 1;

// ── Types ────────────────────────────────────────────────────────────
export interface DecomposeInput {
  goal: string;
  client: LLMClient;
  model: string;
  maxRetries?: number;
}
type ValidateResult =
  | { ok: true; manifest: FleetManifest }
  | { ok: false; error: string };

// ── Internal: one LLM call ───────────────────────────────────────────
async function callDecomposer(input: {
  client: LLMClient; model: string; goal: string; priorText?: string;
}): Promise<string> { /* one client.chat({ ..., jsonObjectMode: true }) → return response.text */ }

// ── Internal: extract + validate + config-key guard ──────────────────
function validateManifest(rawText: string): ValidateResult { /* see §2 */ }

// ── Public entrypoint ────────────────────────────────────────────────
export async function decomposeGoal(input: DecomposeInput): Promise<FleetManifest> { /* loop, see §8 */ }
```

**Imports this file needs:**
- `FleetManifestSchema` (value) + `type FleetManifest` from `./manifest.js`
- `type LLMClient`, `type ChatResponse`, `type Message` from `../providers/types.js`
  (`ChatResponse`/`Message` only if you type intermediate vars; `response.text` is `string`.)

**Imported by:** nothing yet (Sprint 2 wires the CLI). No dependents to break.

**Test file:** `src/fleet/decomposer.test.ts` — does not exist; create it.

---

### src/fleet/decomposer.test.ts (create)

**Most similar existing test (fake-client pattern):** `src/providers/structured.test.ts:28-52` — a `ScriptedClient implements LLMClient` that records every `ChatParams` and returns scripted text per call index. Copy this verbatim and adapt. See §6.

---

## 2. Patterns to Follow

### Pattern A — JSON extraction order (direct → fence → first-brace substring)
**Source:** `src/orchestrator/planner-agent.ts:299-349` (`parsePlanSpec`)
```ts
function parsePlanSpec(text: string): PlanSpec {
  let parsed: unknown;

  // Try direct parse first
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    // Try extracting JSON from markdown code fences
    const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/.exec(text);
    if (fenceMatch) {
      try {
        parsed = JSON.parse(fenceMatch[1].trim());
      } catch {
        // Fall through
      }
    }
    // Try finding the first { ... } block
    if (!parsed) {
      const braceStart = text.indexOf("{");
      const braceEnd = text.lastIndexOf("}");
      if (braceStart !== -1 && braceEnd > braceStart) {
        try {
          parsed = JSON.parse(text.slice(braceStart, braceEnd + 1));
        } catch { /* throw No-JSON error */ }
      }
    }
  }

  const result = PlanSpecSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Planner produced invalid PlanSpec:\n${issues}\n...`);
  }
  return result.data;
}
```
**Rule:** `validateManifest` mirrors this extraction order EXACTLY (direct `JSON.parse` → `/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/` fence → `indexOf("{")`/`lastIndexOf("}")` substring). BUT instead of throwing on schema failure, return `{ ok: false, error }` so `decomposeGoal` can route to the coercion retry. Reuse the `result.error.issues.map((i) => \`  - ${i.path.join(".")}: ${i.message}\`).join("\n")` formatting verbatim. (zod v4: `result.error.issues` is the correct accessor — confirmed in this codebase.)

### Pattern B — config-key guard AFTER successful safeParse
**Source:** `src/fleet/manifest.ts:6-11` — `FleetChildSchema.config` is **optional**, so `safeParse` will happily *accept* `{ folder, task, config: {...} }`. The contract requires the LLM to emit children with ONLY `folder`/`task`, so after a successful parse you must additionally reject any child whose own object carries a `config` key:
```ts
// after const result = FleetManifestSchema.safeParse(parsed); result.success === true
const offending = result.data.children.find(
  (c) => Object.prototype.hasOwnProperty.call(c, "config"),
);
if (offending) {
  return { ok: false, error: `child "${offending.folder}": children must not carry a "config" key` };
}
return { ok: true, manifest: result.data };
```
**Rule:** The guard runs IN ADDITION to `safeParse`, not instead of it. A child with a `config` key must route to the coercion retry (return `{ ok: false }`), not throw immediately.

### Pattern C — coercion instruction constant (template literal, restates exact shape)
**Source:** `src/orchestrator/planner-agent.ts:30-58` (`PLAN_SPEC_COERCION_INSTRUCTION`)
```ts
const PLAN_SPEC_COERCION_INSTRUCTION = `Your previous response was not a complete PlanSpec object.
Output ONLY a single JSON object (no prose, no markdown fences, no tool calls) with EXACTLY this shape...
{
  "specId": "spec-<yyyymmdd>-<slug>",
  ...
}
Rules: ... Output the JSON object and nothing else.`;
```
**Rule:** `DECOMPOSE_COERCION_INSTRUCTION` follows the same voice: "Your previous response was not a valid fleet manifest. Output ONLY `{ "children": [{ "folder": string, "task": string }] }` ... do NOT include config/concurrency/rootDir/provider keys ... Output the JSON object and nothing else." At runtime the prior text + formatted Zod/guard error get appended (see Pattern D).

### Pattern D — coercion re-prompt is a 3-message array
**Source:** `src/orchestrator/agentic-loop.ts:182-194` (`coerceJsonOutput`)
```ts
const messages: Message[] = [
  { role: "user", content: userMessage },
  { role: "assistant", content: priorText || "(no output produced)" },
  { role: "user", content: instruction },
];
const response = await chatWithRetry(
  client,
  { model, system: systemPrompt, messages, jsonObjectMode: true, maxTokens },
  0,
);
return response.text;
```
**Rule:** On the retry turn, `callDecomposer` builds the same 3-message shape: `[{role:'user', content: goal}, {role:'assistant', content: priorText}, {role:'user', content: DECOMPOSE_COERCION_INSTRUCTION + "\n\n" + formattedError}]`. On the first turn it is a single user message `[{role:'user', content: goal}]`. **Always pass `jsonObjectMode: true`; never pass `responseSchema`.** Return `response.text` only — do no parsing inside `callDecomposer`.

### Pattern E — DeepSeek / openai-compat constants
**Source:** `src/fleet/child-config.ts:7-9`
```ts
const DEEPSEEK_PROVIDER = "openai-compat";
const DEEPSEEK_ENDPOINT = "https://api.deepseek.com";
const DEEPSEEK_MODEL = "deepseek-v4-pro";
```
**Rule:** The decomposer does NOT create a client or pick a provider this sprint — `model` is passed in by the caller (Sprint 2 will supply `deepseek-v4-pro`). Cite these only for context; do not import or re-declare them in `decomposer.ts`.

### Pattern F — schema reuse (DO NOT re-create or relax)
**Source:** `src/fleet/manifest.ts:6-18`
```ts
export const FleetChildSchema = z.object({
  folder: z.string().min(1),
  task: z.string().min(1),
  config: z.record(z.string(), z.unknown()).optional(),
});
export type FleetChild = z.infer<typeof FleetChildSchema>;

export const FleetManifestSchema = z.object({
  rootDir: z.string().default("."),
  concurrency: z.number().int().min(1).default(3),
  children: z.array(FleetChildSchema).min(1),
});
export type FleetManifest = z.infer<typeof FleetManifestSchema>;
```
**Rule:** Import and use these verbatim. Note `rootDir` and `concurrency` have **defaults** — so a `{ children: [...] }`-only LLM output is valid input to `safeParse` and the returned `manifest` will carry `rootDir: "."` and `concurrency: 3`. `children` requires `.min(1)`. Each child requires non-empty `folder` and `task`.

---

## 3. The provider types (CRITICAL — copy field-for-field)

**Source:** `src/providers/types.ts`

`ChatParams` (the object passed to `client.chat`) — lines 139-184. The two knobs that matter:
```ts
export interface ChatParams {
  model: string;
  system: string;
  messages: Message[];
  tools?: ToolDef[];
  maxTokens?: number;             // defaults to 16384
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** strict json_schema — DeepSeek REJECTS this. DO NOT USE. */
  responseSchema?: JsonSchemaObject;
  /** loose json_object mode (DeepSeek-safe). USE THIS: jsonObjectMode: true */
  jsonObjectMode?: boolean;
}
```

`ChatResponse` (the resolved value of `client.chat`) — lines 194-206. `.text` holds the JSON document:
```ts
export interface ChatResponse {
  text: string;              // ← the JSON document the decomposer parses
  toolCalls: ToolCall[];     // empty for jsonObjectMode
  stopReason: StopReason;    // "end" | "tool_use" | "max_tokens" | "error" | string
  usage: { inputTokens: number; outputTokens: number };
}
```

`LLMClient` — lines 216-222:
```ts
export interface LLMClient {
  chat(params: ChatParams): Promise<ChatResponse>;
}
```

`Message` (for the `messages` array) — line 128-132 is a union; for plain text turns use the `TextMessage` variant (lines 96-100): `{ role: "user" | "assistant"; content: string }`.

---

## 4. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `FleetManifestSchema` | `src/fleet/manifest.ts:13` | `z.ZodObject` | Validate the manifest; reuse verbatim. |
| `FleetChildSchema` | `src/fleet/manifest.ts:6` | `z.ZodObject` | Per-child schema; `config` optional (hence the extra guard). |
| `FleetManifest` (type) | `src/fleet/manifest.ts:18` | `z.infer<…>` | Return type of `decomposeGoal`. |
| `FleetChild` (type) | `src/fleet/manifest.ts:11` | `z.infer<…>` | Child element type. |
| `LLMClient` / `ChatParams` / `ChatResponse` / `Message` | `src/providers/types.ts:216 / 139 / 194 / 128` | interfaces | The provider-agnostic chat contract — type the fake client against these. |
| `parsePlanSpec` (reference only) | `src/orchestrator/planner-agent.ts:299` | `(text:string)=>PlanSpec` | The extraction pattern to mirror; do NOT import (it throws, is PlanSpec-specific, and lives in the orchestrator). |
| `coerceJsonOutput` (reference only) | `src/orchestrator/agentic-loop.ts:169` | `(params)=>Promise<string>` | Shows the 3-message coercion shape; do NOT import (it constructs its own client retry + has a json fallback you don't need). |

**Utilities reviewed:** `src/utils/` (`fs.ts`, `git.ts`, `logger.ts` — none needed; no fs, no logging required in a pure module — `logger` is optional and not in scope), `src/fleet/` (schemas + constants above), `src/providers/` (types + `structured.ts` coerce helpers — reference only). The decomposer is self-contained: it should NOT pull in `coerceJsonOutput`, `createClient`, or any fs util. Inline the small extraction/validation logic the way `parsePlanSpec` does.

---

## 5. Prior Sprint Output

No prior sprint in THIS plan (`dependsOn: []`). Phase 1 of the fleet orchestrator is already merged:
- `src/fleet/manifest.ts` — exports `FleetManifestSchema`, `FleetChildSchema`, `FleetManifest`, `FleetChild`, `load`. **Reuse the schemas; do not modify.**
- `src/fleet/child-config.ts` — exports `buildChildConfig`; holds the DeepSeek constants (Pattern E). **Do not modify.**
- `src/fleet/index.ts`, `coordinator.ts`, `runner.ts` — `runFleet` and friends. **Out of scope; do not touch.**

**Connection to this sprint:** `decomposeGoal` produces a `FleetManifest` that Sprint 2 will hand to `runFleet`. This sprint only emits the object — no writing, no spawning.

---

## 6. Testing Patterns

### Unit Test Pattern — scripted fake LLMClient
**Source:** `src/providers/structured.test.ts:16-52`
```ts
import { describe, it, expect } from "vitest";
import type { LLMClient, ChatParams, ChatResponse } from "../providers/types.js";

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
**Assertion patterns to copy (same file):**
- Call count: `expect(client.calls).toHaveLength(2);` (`structured.test.ts:242`)
- Inspect params of nth call: `const call = client.calls[0]; expect(call?.responseSchema).toEqual(...)` (`:216-218`) — adapt to assert `expect(client.calls[0]?.jsonObjectMode).toBe(true)` and `expect(client.calls[0]?.responseSchema).toBeUndefined()`.
- Inspect retry message content: `client.calls[1]?.messages` → assert the 3rd message (`role:'user'`) `.content` contains the prior text and a Zod path (`:245-252`).
- Reject + message substring: `await expect(decomposeGoal(...)).rejects.toThrow(/.../);` (mirror `:272-284` style; assert the message `toContain` a Zod path fragment like `children`).

**Runner:** vitest. **Import style:** `import { describe, it, expect } from "vitest";` (note: `child-config.test.ts:1` uses `describe, expect, it` order — either order is fine). **Assertion style:** `expect(...).toBe/.toEqual/.toHaveLength/.rejects.toThrow`. **Mock approach:** hand-rolled `ScriptedClient implements LLMClient` (NO `vi.mock`, NO real network). **File naming:** `decomposer.test.ts`. **Location:** collocated next to `decomposer.ts` in `src/fleet/`.

### Required test cases (map to success criteria)
1. **valid-first-try (sc-1-4):** one scripted `{"children":[{"folder":"api","task":"build the API"}]}` → resolves; `expect(FleetManifestSchema.safeParse(result).success).toBe(true)`; children carry only folder/task; `client.calls` length 1.
2. **invalid-then-coerce-success (sc-1-5):** `["not json", '{"children":[{"folder":"x","task":"t"}]}']` → resolves; `client.calls` length **exactly 2**; assert `client.calls[1].messages` has the assistant prior-text turn + a user instruction turn containing a Zod/extraction error.
3. **invalid-twice-throws (sc-1-6):** `["garbage", "still garbage"]` → `.rejects.toThrow`; message contains the formatted Zod issues / a `path: message` fragment; assert NO manifest leaks (the promise rejects).
4. **child-with-config rejected (sc-1-7a):** first response `{"children":[{"folder":"x","task":"t","config":{"foo":1}}]}` (which `safeParse` ALONE would accept) → routes to coercion (2 calls) or throws; assert the guard fired.
5. **fenced-```json``` extraction (sc-1-7b):** a response wrapping the valid object in a ```` ```json ... ``` ```` fence → resolves first try.
6. **chat-params shape (sc-1-7c):** `expect(client.calls[0]?.jsonObjectMode).toBe(true)` and `expect(client.calls[0]?.responseSchema).toBeUndefined()`.

No E2E layer applies (pure module; no Playwright in this repo).

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| (none) | `src/fleet/decomposer.ts` | low | New file; nothing imports it yet (Sprint 2 wires it). |
| `src/fleet/manifest.ts` | reused, NOT modified | low | Confirm zero edits — `nonGoals` forbids changing the schema. |
| `src/fleet/child-config.ts` | reused, NOT modified | low | Confirm zero edits. |
| `src/providers/types.ts` | reused, NOT modified | low | Confirm zero edits. |

### Existing Tests That Must Still Pass (sc-1-8)
This is purely additive, so the regression surface is "the whole existing suite stays green." Highest-relevance existing tests:
- `src/fleet/manifest.test.ts` — covers `FleetManifestSchema`/`load`; must stay green (you reuse the schema).
- `src/fleet/child-config.test.ts` — covers `buildChildConfig`; must stay green.
- `src/providers/structured.test.ts` — the `ScriptedClient` pattern's origin; unaffected, must stay green.
- All other `src/**/*.test.ts` (~2484 tests per project memory) — run `npm test` to confirm zero new failures.

### Features That Could Be Affected
- **Fleet runFleet / `fleet <manifest>` (Phase 1)** — shares the `FleetManifest` type. Verify you did not relax or re-declare the schema; the manifest `decomposeGoal` returns must be the SAME shape `runFleet` already consumes.

### Recommended Regression Checks
1. `npm run build` (tsc, zero errors — sc-1-1/sc-1-2).
2. `npx eslint src/fleet/decomposer.ts src/fleet/decomposer.test.ts` (zero errors — sc-1-3: `consistent-type-imports`, no-unused, `.js` extensions, no `any`).
3. `npx vitest run src/fleet/decomposer.test.ts` (new tests pass — sc-1-4..7).
4. `npm test` (full suite, zero failures — sc-1-8).
5. `git status src/fleet/manifest.ts src/fleet/child-config.ts src/fleet/index.ts src/providers/types.ts` shows NO modifications (out-of-scope guard).

---

## 8. Implementation Sequence

1. **Constants + types** — declare `DECOMPOSE_SYSTEM_PROMPT`, `DECOMPOSE_COERCION_INSTRUCTION`, `DECOMPOSE_MAX_RETRIES = 1`, and the `DecomposeInput` interface + internal `ValidateResult` union. The system prompt must spell out the exact `{ "children": [{ "folder": string, "task": string }] }` shape, `folder` = kebab-case dir name, `task` = self-contained build instruction, forbid `config`/`concurrency`/`rootDir`/`provider` keys, `>=1` child.
   - Verify: `tsc` clean; constants exported.
2. **`callDecomposer`** — one `client.chat({ model, system: DECOMPOSE_SYSTEM_PROMPT, messages, jsonObjectMode: true })`; first turn = `[{role:'user', content: goal}]`, retry turn appends the prior text (assistant) + coercion instruction (user). Return `response.text` only.
   - Verify: passes `jsonObjectMode: true`, never sets `responseSchema`.
3. **`validateManifest`** — extraction order (direct → fence → first-brace), then `FleetManifestSchema.safeParse`, then the config-key guard (Pattern B); on any failure format Zod issues as `path: message` lines and return `{ ok:false, error }`; on full success return `{ ok:true, manifest }`. No throwing here.
   - Verify: returns a discriminated union; throws nowhere.
4. **`decomposeGoal`** — loop bounded by `1 + (maxRetries ?? DECOMPOSE_MAX_RETRIES)` total attempts: call `callDecomposer` → `validateManifest`; if `ok` return the manifest; else if attempts remain, re-call with `priorText` + the formatted error; on final failure `throw new Error(\`Fleet decomposition failed after N attempts:\n${lastError}\`)`. NEVER return an invalid manifest.
   - Verify: max 2 `client.chat` calls when `maxRetries` defaults to 1.
5. **`decomposer.test.ts`** — copy `ScriptedClient` from `structured.test.ts:34-52`, then the six cases in §6.
   - Verify: `npx vitest run src/fleet/decomposer.test.ts` all green; call-count assertions hold.
6. **Run full verification** — `npm run build`, `npx eslint src/fleet/decomposer*.ts`, `npm test`.

---

## 9. Pitfalls & Warnings

- **jsonObjectMode, NOT responseSchema.** DeepSeek 400s on strict `json_schema`. Always set `jsonObjectMode: true`; never set `responseSchema`. The test must assert both (`client.calls[0]?.jsonObjectMode === true` AND `responseSchema === undefined`). (`src/providers/types.ts:174-183`.)
- **The config-key guard runs BEYOND safeParse.** `FleetChildSchema.config` is `.optional()` (`manifest.ts:9`), so `safeParse` ACCEPTS a child with a `config` key. You must add the explicit `hasOwnProperty("config")` reject after a successful parse, or sc-1-7 fails silently.
- **Never resolve an invalid/partial manifest (sc-1-6).** On final failure `decomposeGoal` must `throw`, not return. The error message MUST contain the formatted Zod issues (`path: message`).
- **Max 2 calls.** With default `maxRetries = 1`, total `client.chat` invocations on a bad-then-bad sequence is exactly 2 (then throw) — not 3. The loop bound is `1 + maxRetries` attempts.
- **Do not import `coerceJsonOutput`/`createClient`/`parsePlanSpec`.** They live in the orchestrator, throw, build their own client, or carry json fallbacks you don't want. Inline the small extraction/validation logic the way `parsePlanSpec` does. (`generatorNotes` says "Pure module … no createClient".)
- **ESM `.js` extensions on every relative import** (`./manifest.js`, `../providers/types.js`) — `principles.md:27`. NodeNext will fail otherwise.
- **`import type` for type-only imports** (`FleetManifest`, `LLMClient`, `ChatResponse`, `Message`) — `consistent-type-imports` is a hard lint gate (`principles.md:35`). `FleetManifestSchema` is a VALUE import (used at runtime for `.safeParse`).
- **No `any`.** Use `unknown` for the parsed JSON and narrow (`principles.md:40`). `parsed: unknown` exactly like `parsePlanSpec:300`.
- **No fs, no logger required, no network.** Pure module. Tests use only the in-memory `ScriptedClient` — no temp dirs, no `vi.mock`.
- **zod v4 issue access.** Use `result.error.issues` (not `.errors`) — that's what `parsePlanSpec:340` uses in this codebase.
- **Do NOT modify any Phase 1 file** (`manifest.ts`, `child-config.ts`, `index.ts`, `coordinator.ts`, `runner.ts`) or `providers/types.ts`. The evaluator explicitly checks for this (`evaluatorNotes`).
