# Sprint Briefing: Refusal detection end-to-end (stopReason 'refusal' + fail-closed generator)

**Contract:** sprint-spec-20260709-agent-loop-capability-port-1
**Generated:** 2026-07-09T00:00:00.000Z

---

## 0. TL;DR (the whole sprint in one paragraph)

Provider refusals are currently swallowed as a silent success. The Anthropic SDK already emits
`stop_reason: "refusal"` (`node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts:1004`) and it
passes through `normalizeStopReason`'s **default** branch unchanged, so the value already reaches the loop.
The real bug is `agentic-loop.ts:301` — `if (response.stopReason !== "tool_use")` treats **any** non-tool
stop (including a refusal) as "done" and returns `success`-shaped output. This sprint makes refusal a
first-class outcome across five source files (plus three test files), entirely **additive / default-off**:
add explicit `refusal` cases to both adapters, set `refused: true` (spread-conditional) on
`AgenticLoopResult`, and make `parseGeneratorResult` fail closed on `refused` **before** the
`filesWritten.size > 0` success shortcut. Non-refusal runs must stay byte-identical.

---

## 1. Target Files

### src/providers/types.ts (modify)

**Relevant section — the open StopReason union (lines 204-207):**
```ts
/**
 * Stop reason indicating why the model stopped generating.
 */
export type StopReason = "end" | "tool_use" | "max_tokens" | "error" | string;
```
**What to do:** This is already an *open* union (`| string`), so `"refusal"` is accepted at runtime with
zero type changes. Only update the doc comment to **document `"refusal"` as a known value** (sc-1-1's "the
open StopReason union documents 'refusal'"). Do NOT add a `refused?` key to `ChatResponse` (lines 212-224) —
the generatorNotes are explicit: the loop derives `refused`, the response does not carry it.

**Imported by:** every adapter (`anthropic.ts:9`, `openai.ts:18`, `google.ts`, `claude-code.ts`) and
`agentic-loop.ts:1`. Additive doc-only change → zero break risk.
**Test file:** no dedicated `types.test.ts`; type usage is exercised transitively by every adapter test.

---

### src/providers/anthropic.ts (modify)

**Relevant section — normalizeStopReason (lines 29-45):**
```ts
function normalizeStopReason(
  reason: Anthropic.Messages.Message["stop_reason"],
): StopReason {
  switch (reason) {
    case "end_turn":
      return "end";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    default:
      return reason ?? "end";        // 'refusal' currently falls through here
  }
}
```
**What to do:** Add an **explicit** case (sc-1-1 requires "not the default branch"):
```ts
    case "refusal":
      // 'refusal' is part of the open StopReason union; surface it explicitly
      // so the loop can fail closed rather than treat it as a normal completion.
      return "refusal";
```
**Evidence the raw value exists:** `node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts:1004`:
`export type StopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'pause_turn' | 'refusal';`
So `Anthropic.Messages.Message["stop_reason"]` already includes `"refusal"` — the case is type-safe.

**Imports this file uses:** `StopReason` (and siblings) from `./types.js` (lines 3-11); `Anthropic` from
`@anthropic-ai/sdk` (line 1). Do not add imports.
**normalizeStopReason is consumed at:** `anthropic.ts:348` (the final `return { ..., stopReason: normalizeStopReason(response.stop_reason) }`). The structured-output branch (lines 333-343) hard-returns `"end"` and is unaffected.
**Test file:** `src/providers/anthropic.test.ts` (exists — add a refusal case, see §6).

---

### src/providers/openai.ts (modify)

The OpenAI refusal surface has **two** signals; handle both (generatorNotes item 2).

**(a) finish_reason — normalizeStopReason (lines 161-175):**
```ts
function normalizeStopReason(finishReason: string | null): StopReason {
  switch (finishReason) {
    case "stop":
      return "end";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    default:
      return finishReason ?? "end";   // 'content_filter' currently falls through
  }
}
```
Add: `case "content_filter": return "refusal";`

**(b) message.refusal content — the inline OAIMessage shape (lines 38-42):**
```ts
interface OAIMessage {
  role: string;
  content: string | null;
  tool_calls?: OAIToolCall[];
}
```
Add an optional field so the SDK's structured-output refusal is representable:
`refusal?: string | null;`

**(c) the response-normalisation tail of `chat()` (lines 437-459):**
```ts
    const choice = response.choices[0];
    if (!choice) { /* ... stopReason: "error" ... */ }

    const text = choice.message.content ?? "";
    const toolCalls = normalizeToolCalls(choice.message.tool_calls);
    const stopReason = normalizeStopReason(choice.finish_reason);

    return { text, toolCalls, stopReason, usage: { ... } };
```
When `choice.message.refusal` is a non-empty string, override to a refusal result — e.g. set
`stopReason = "refusal"` and surface the refusal text into `text` (so the fail-closed generator note has an
excerpt). A minimal, byte-identical-when-absent shape:
```ts
    const refusalText = choice.message.refusal;
    if (refusalText) {
      return {
        text: refusalText,
        toolCalls: [],
        stopReason: "refusal",
        usage: { inputTokens: response.usage?.prompt_tokens ?? 0, outputTokens: response.usage?.completion_tokens ?? 0 },
      };
    }
```
Place this AFTER the `if (!choice)` guard and BEFORE the normal return. When `refusal` is absent/empty the
path is byte-identical (sc-1-5).

**openai-compat is covered for free:** `src/providers/openai-compat.ts:31` `OpenAICompatAdapter extends
OpenAIAdapter` and its `override chat()` (lines 53-63) delegates to `super.chat(params)` — it inherits
`normalizeStopReason` and the refusal branch. No edit needed there; DeepSeek/Grok/Ollama get the mapping
automatically (generatorNotes: "openai-compat shares this path").

**Test file:** `src/providers/openai.test.ts` (exists — add refusal cases, see §6).

---

### src/orchestrator/agentic-loop.ts (modify)

**(a) AgenticLoopResult interface (lines 47-61):**
```ts
export interface AgenticLoopResult {
  finalText: string;
  turnsUsed: number;
  toolsCalled: string[];
  usage: { inputTokens: number; outputTokens: number };
  /** The stop reason of the final API response. */
  stopReason: string;
}
```
Add an **optional** field (additive; absent on non-refusal runs — sc-1-5):
```ts
  /**
   * True only when the provider refused. Absent otherwise. Write-capable roles
   * (generator/curator) MUST treat this as success:false (ADR-5).
   */
  refused?: boolean;
```

**(b) the completion branch (lines 296-338)** — this is the substantive bug fix:
```ts
    const turnStopReason = response.stopReason;

    // If the model is done (no more tool use), return — UNLESS a completion
    // predicate says this tool-less turn isn't actually complete ...
    if (response.stopReason !== "tool_use") {
      finalText = response.text;

      const incomplete = completionCheck !== undefined && !completionCheck(finalText) && nudgesUsed < maxNudges;
      if (incomplete) { /* nudge & continue */ }

      return {
        finalText,
        turnsUsed: turn,
        toolsCalled: allToolsCalled,
        usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
        stopReason: turnStopReason,
      };
    }
```
**What to do:** derive `const refused = turnStopReason === "refusal";` and spread the key conditionally on the
completion-branch return so it is ABSENT on the normal path:
```ts
      return {
        finalText,
        turnsUsed: turn,
        toolsCalled: allToolsCalled,
        usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
        stopReason: turnStopReason,
        ...(refused ? { refused: true } : {}),
      };
```
Do NOT touch the error return (lines 280-289) or the max-turns return (lines 406-417). Do NOT throw
(nonGoal + ADR-4/ADR-5: no catcher around `runGenerator` — verified `pipeline.ts:329` is a bare `await` with
no surrounding try/catch). A refusal that arrives after prior tool_use turns naturally reaches this same
branch on a later turn (sc-1-3: "including when tool results from earlier turns exist"), because each turn
re-enters the `for` loop and re-checks `stopReason`.

**Imports this file uses:** provider types from `../providers/types.js` (line 1); `ToolHandler` from
`./tools/index.js`; `logger` from `../utils/logger.js`.
**Imported by (runAgenticLoop consumers):** `generator-agent.ts`, `evaluator-agent.ts`, `architect-agent.ts`,
`code-reviewer-agent.ts`, `curator-agent.ts`, `documenter-agent.ts`, `planner-agent.ts`, `research-agent.ts`,
`workflow/retry.ts`, and re-exported by `src/index.ts:118-121`. See §7 for impact.
**Test file:** `src/orchestrator/agentic-loop.test.ts` — **DOES NOT EXIST**; create it (see §1 create block + §6).

---

### src/orchestrator/generator-agent.ts (modify)

**Relevant section — parseGeneratorResult (lines 181-279):**
```ts
function parseGeneratorResult(
  text: string,
  filesWritten: Set<string>,
  loopResult: { turnsUsed: number; toolsCalled: string[]; usage: { inputTokens: number; outputTokens: number } },
): GeneratorResult {
  let parsed: unknown;
  // ... JSON extraction ...

  if (parsed && typeof parsed === "object" && ("success" in parsed || "status" in parsed)) {
    // ... returns success from report ...
  }

  // If parsing failed entirely, check if we at least wrote files
  if (filesWritten.size > 0) {                       // <-- line 260: the false-pass shortcut
    return { success: true, notes: `Generator wrote ${filesWritten.size} files ...`, ... };
  }

  return { success: false, notes: `Failed to parse ...`, ... };
}
```
**What to do (sc-1-4):**
1. **Widen the `loopResult` param type** to also carry the flag: add `refused?: boolean` to that inline
   type. The call site already passes the full loop result: `generator-agent.ts:151` does
   `return parseGeneratorResult(result.finalText, filesWritten, result);` where `result` is the
   `AgenticLoopResult` — so `result.refused` is already present, just not yet in the param type.
2. **Add a refusal guard as the FIRST statement** of the function (before any JSON parsing, and crucially
   before the `filesWritten.size > 0` check at line 260):
```ts
  if (loopResult.refused === true) {
    return {
      success: false,
      notes: `model refused: ${text.slice(0, 300)}`,
      filesChanged: [...filesWritten],
      turnsUsed: loopResult.turnsUsed,
      toolsCalled: loopResult.toolsCalled,
      usage: loopResult.usage,
    };
  }
```
3. **EXPORT `parseGeneratorResult`.** It is currently a non-exported `function` (`generator-agent.ts:181`,
   no `export`). The evaluatorNotes require calling it directly in a unit test ("call parseGeneratorResult
   with a loop result where refused=true"). Change `function parseGeneratorResult` →
   `export function parseGeneratorResult`. This is additive (it stays internally callable).

**Imports this file uses:** `runAgenticLoop` from `./agentic-loop.js:9`; `createClient`, `resolveModel`,
`assembleSystemPrompt`, tools, telemetry. `GeneratorResult` is declared locally (lines 16-27) and re-exported
from `src/index.ts:83`.
**Imported by:** `src/orchestrator/pipeline.ts:32` (`runGenerator`) — call site at `pipeline.ts:329`,
**no surrounding try/catch** (confirms the never-throw constraint).
**Test file:** `src/orchestrator/generator-agent.test.ts` — **DOES NOT EXIST**; create it (see §6).

---

### src/orchestrator/agentic-loop.test.ts (create)

**Directory pattern:** collocated `*.test.ts` next to source (principles.md:20; e.g. `anthropic.ts` +
`anthropic.test.ts`). Runner is Vitest.
**Most similar existing file for the fake client:** `src/providers/structured.test.ts:34-52` — the
`ScriptedClient implements LLMClient` returning scripted `ChatResponse`s. Use it as the template but make the
scripted unit a full `ChatResponse` (so you can set `stopReason: "refusal"` and `toolCalls`).
**Structure template:**
```ts
import { describe, it, expect } from "vitest";
import { runAgenticLoop } from "./agentic-loop.js";
import type { LLMClient, ChatParams, ChatResponse } from "../providers/types.js";

/** Returns scripted ChatResponses in order; repeats the last once exhausted. */
class ScriptedLoopClient implements LLMClient {
  private idx = 0;
  constructor(private readonly responses: ChatResponse[]) {}
  async chat(_params: ChatParams): Promise<ChatResponse> {
    const r = this.responses[Math.min(this.idx, this.responses.length - 1)];
    this.idx += 1;
    return r;
  }
}

const base = { toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };

it("sc-1-3: resolves with refused:true on a refusal (no throw)", async () => {
  const client = new ScriptedLoopClient([
    { ...base, text: "I can't help with that.", stopReason: "refusal" },
  ]);
  const result = await runAgenticLoop({
    client, model: "m", systemPrompt: "s", userMessage: "u",
    tools: [], toolHandlers: new Map(), maxTurns: 3,
  });
  expect(result.refused).toBe(true);
  expect(result.stopReason).toBe("refusal");
});

it("sc-1-3: refusal AFTER a prior tool_use turn still sets refused:true", async () => {
  const client = new ScriptedLoopClient([
    { ...base, text: "", toolCalls: [{ id: "t1", name: "noop", input: {} }], stopReason: "tool_use" },
    { ...base, text: "refused", stopReason: "refusal" },
  ]);
  const handlers = new Map([["noop", async () => ({ output: "ok", isError: false })]]);
  const result = await runAgenticLoop({
    client, model: "m", systemPrompt: "s", userMessage: "u",
    tools: [{ name: "noop", description: "n", input_schema: { type: "object", properties: {} } }],
    toolHandlers: handlers, maxTurns: 3,
  });
  expect(result.refused).toBe(true);
});

it("sc-1-5: a normal completion has NO 'refused' key", async () => {
  const client = new ScriptedLoopClient([{ ...base, text: "done", stopReason: "end" }]);
  const result = await runAgenticLoop({
    client, model: "m", systemPrompt: "s", userMessage: "u",
    tools: [], toolHandlers: new Map(), maxTurns: 3,
  });
  expect(Object.hasOwn(result, "refused")).toBe(false);   // evaluatorNotes: use Object.hasOwn
});
```
Note the `ToolHandler` result shape is `{ output: string; isError: boolean }` (see `agentic-loop.ts:373-378`).

---

### src/orchestrator/generator-agent.test.ts (create)

**Most similar existing file:** `src/orchestrator/architect-agent.test.ts:14-80` (Vitest + `vi.mock`
collocation). But you do NOT need to mock the whole loop — after you `export parseGeneratorResult`, unit-test
it directly (simpler, matches evaluatorNotes).
**Structure template:**
```ts
import { describe, it, expect } from "vitest";
import { parseGeneratorResult } from "./generator-agent.js";

const loop = { turnsUsed: 1, toolsCalled: [], usage: { inputTokens: 0, outputTokens: 0 } };

it("sc-1-4: refused overrides the filesWritten success shortcut", () => {
  const files = new Set(["src/a.ts"]);            // non-empty → would be success:true without the guard
  const res = parseGeneratorResult("I refuse to do this.", files, { ...loop, refused: true });
  expect(res.success).toBe(false);
  expect(res.notes.toLowerCase()).toContain("refus");
});

it("sc-1-5: without refused, filesWritten still yields success:true (byte-identical)", () => {
  const files = new Set(["src/a.ts"]);
  const res = parseGeneratorResult("not json", files, loop);   // no refused key
  expect(res.success).toBe(true);
});
```

---

## 2. Patterns to Follow

### Explicit-case-then-default switch in adapters
**Source:** `src/providers/anthropic.ts:35-44` and `src/providers/openai.ts:165-174`
```ts
switch (reason) {
  case "end_turn": return "end";
  case "tool_use": return "tool_use";
  case "max_tokens": return "max_tokens";
  default: return reason ?? "end";
}
```
**Rule:** Add the new mapping as an **explicit `case`** above `default:` (sc-1-1 forbids relying on the
default branch). Keep the `?? "end"` default untouched.

### Spread-conditional for additive-when-absent keys
**Source:** `src/providers/anthropic.ts:310-318` and `src/orchestrator/agentic-loop.ts:310` idiom
```ts
...(effort !== undefined ? { output_config: { effort } } : {}),
```
**Rule:** Emit `refused` via `...(refused ? { refused: true } : {})` so the key is entirely absent on the
non-refusal path — this is how the codebase keeps changes byte-identical-when-absent (the project's
established idiom; sc-1-5).

### Section comments (box-drawing headers)
**Source:** `src/orchestrator/agentic-loop.ts:6`, `:63`, `:215`; `src/providers/types.ts:8`, `:204`
```ts
// ── Section Name ────────────────────────────────────────────────────
```
**Rule:** New test files and any new sub-blocks use the same `// ── … ──` header style (principles.md:32).

### `import type` for type-only imports
**Source:** `src/providers/anthropic.ts:3-11`, `src/orchestrator/agentic-loop.ts:1-3`
```ts
import type { LLMClient, ChatParams, ChatResponse, StopReason } from "./types.js";
```
**Rule:** ESLint `consistent-type-imports` is a hard gate (principles.md:35). Types → `import type`; `.js`
extension on every relative import (NodeNext).

---

## 3. Existing Utilities — DO NOT Recreate

Reviewed `src/utils/`, `src/providers/`, `src/orchestrator/` for anything this sprint might reinvent:

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `normalizeStopReason` (Anthropic) | `src/providers/anthropic.ts:32` | `(reason: Anthropic…stop_reason) => StopReason` | The one place to add the Anthropic refusal case — extend, don't wrap. |
| `normalizeStopReason` (OpenAI) | `src/providers/openai.ts:164` | `(finishReason: string \| null) => StopReason` | The one place to add `content_filter → refusal`; inherited by openai-compat. |
| `normalizeContent` | `src/providers/anthropic.ts:50` | `(content[]) => { text, toolCalls }` | Text/tool-call extraction — reuse as-is. |
| `normalizeToolCalls` | `src/providers/openai.ts:285` | `(toolCalls?) => ToolCall[]` | Tool-call parsing — reuse as-is. |
| `runAgenticLoop` | `src/orchestrator/agentic-loop.ts:230` | `(AgenticLoopParams) => Promise<AgenticLoopResult>` | The shared loop; the only place the `refused` flag is derived. |
| `chatWithRetry` | `src/orchestrator/agentic-loop.ts:105` | `(client, params, turn) => Promise<ChatResponse>` | Transient-error backoff wrapper the loop already uses — leave untouched (a refusal is NOT transient). |
| `logger` | `src/utils/logger.ts` | `{ debug, info, warn, sprint }` | Use for any new log line; do not `console.log`. |
| `ScriptedClient` (test pattern) | `src/providers/structured.test.ts:34` | `class implements LLMClient` | Copy this shape for the new loop test's fake client (do not invent a new mock style). |

No new utility module is needed. A refusal is derived inline in the loop; the generator guard is a few lines
in the existing function.

---

## 4. Prior Sprint Output

No prior sprints in this spec (`dependsOn: []`). This is Sprint 1. The relevant *substrate* it builds on:

- **Open StopReason union** (`src/providers/types.ts:207`) — added in earlier work; already `| string`, so
  `"refusal"` is representable with no type change.
- **Effort plumbing / spread-conditional idiom** (`src/providers/anthropic.ts:310`) — the additive
  `...(x ? {…} : {})` pattern this sprint reuses for `refused`.
- **The shared loop backs every role and every fleet child** (ADR-1) — hence the byte-identical-when-absent
  requirement (sc-1-5) is load-bearing: a regression here would ripple to generator, evaluator, architect,
  code-reviewer, curator, documenter, planner, research, and DeepSeek/Grok fleet children.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **Provider-agnostic (line 28 & 41):** never leak SDK types outside the adapter. The `refused` derivation
  lives in `agentic-loop.ts` off the normalized `StopReason` string — do NOT import `@anthropic-ai/sdk` or
  `openai` anywhere new.
- **Type safety hard gate (line 18):** `noFallthroughCasesInSwitch` is on — each new `case` must `return`.
- **Collocated Vitest tests (line 20):** `*.test.ts` next to source.
- **`consistent-type-imports` + `.js` extensions (lines 27, 35):** hard gates.
- **Conventional commits (line 34):** sprint commits use `bober(sprint-N): description`.

### Architecture Decisions (`.bober/architecture/arch-20260709-agent-sdk-agent-loop-harness-*`)
- **ADR-5 (governs this sprint):** refusal → `refused:true`/`stopReason:"refusal"`, **never throws**;
  write-capable roles (generator, curator) map `refused` → `success:false` **before** the `filesWritten`
  check (`generator-agent.ts:260`); read-only/advisory roles surface the refusal text without failing. The
  uniform fail-open flag was rejected precisely because it would leave a refused-after-partial-write as
  `success:true`.
- **ADR-4:** the never-throw rationale — `runGenerator` at `pipeline.ts:329` has NO surrounding try/catch, so
  a throw escapes uncaught and crashes the run. Enforcement must mirror the graceful `max_turns_exceeded`
  return (`agentic-loop.ts:406`).
- **ADR-1:** everything is additive / default-off; only the four named criteria are in scope. Non-goals
  (budget/effort/parallel tools) are later sprints — do not touch them.

### Other Docs
No `CLAUDE.md`/`CONTRIBUTING.md` coding-guideline file in-repo governs this sprint. README not relevant.

---

## 6. Testing Patterns

### Unit Test Pattern — scripted fake LLMClient
**Source:** `src/providers/structured.test.ts:34-52`
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
**Runner:** vitest. **Assertion style:** `expect(...)`. **Mock approach for adapters:** SDK-level mocks
(below). **Mock approach for the loop:** inject a fake `LLMClient` (no `vi.mock` needed). **File naming:**
`<name>.test.ts` collocated.

### Adapter refusal test — Anthropic (add to `src/providers/anthropic.test.ts`)
**Source pattern:** `src/providers/anthropic.test.ts:24-33` (SDK mock) + `:260-278` (normalisation assert)
```ts
// createMock is the mocked messages.create (anthropic.test.ts:24)
it("maps stop_reason 'refusal' -> stopReason 'refusal'", async () => {
  createMock.mockResolvedValue({
    content: [{ type: "text", text: "I can't help with that." }],
    stop_reason: "refusal",
    usage: { input_tokens: 5, output_tokens: 7 },
  });
  const adapter = new AnthropicAdapter("k", { promptCaching: false });
  const result = await adapter.chat({ model: "claude-x", system: "SYS",
    messages: [{ role: "user", content: "…" }] } satisfies ChatParams);
  expect(result.stopReason).toBe("refusal");   // sc-1-1
});
```

### Adapter refusal test — OpenAI (add to `src/providers/openai.test.ts`)
**Source pattern:** `src/providers/openai.test.ts:43-70` (`makeOAIResponse` helper) + `:245-256` (assert).
The helper builds `choices[0].message`; extend it (or inline a response) to carry `finish_reason:
"content_filter"` and/or `message.refusal`:
```ts
it("maps finish_reason 'content_filter' -> stopReason 'refusal'", async () => {
  createFn.mockResolvedValue(makeOAIResponse({ content: null, finishReason: "content_filter" }));
  const adapter = await makeAdapter();
  const result = await adapter.chat({ model: "gpt-4.1", system: "sys",
    messages: [{ role: "user", content: "…" }] });
  expect(result.stopReason).toBe("refusal");   // sc-1-2
});

it("maps a message.refusal payload -> stopReason 'refusal'", async () => {
  createFn.mockResolvedValue({
    choices: [{ finish_reason: "stop", message: { role: "assistant", content: null, refusal: "I won't." } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
  const adapter = await makeAdapter();
  const result = await adapter.chat({ model: "gpt-4.1", system: "sys",
    messages: [{ role: "user", content: "…" }] });
  expect(result.stopReason).toBe("refusal");   // sc-1-2
});
```
(If you add a `refusal?` key to `makeOAIResponse`'s options, keep its default `undefined` so all existing
callers stay byte-identical.)

### Loop + generator tests
See the create-block templates in §1 (agentic-loop.test.ts, generator-agent.test.ts).

### E2E Test Pattern
Not applicable — no Playwright/`e2e/` in this repo. All verification is Vitest unit + `tsc` build.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/index.ts:118-121` | re-exports `runAgenticLoop`, `AgenticLoopResult` | low | Optional `refused?` is additive; public type still compiles. |
| `src/orchestrator/{evaluator,architect,code-reviewer,curator,documenter,planner,research}-agent.ts` | call `runAgenticLoop`, read `result.finalText` | low | None read `result.stopReason`/`refused` (grep confirmed) → additive, no behavior change. |
| `src/orchestrator/workflow/retry.ts` | wraps `runAgenticLoop` | low | Same — consumes result, not `stopReason`. |
| `src/orchestrator/pipeline.ts:329-357` | calls `runGenerator`, branches on `generatorResult.success` | medium | A refusal now yields `success:false` → pipeline goes to its existing retry/needs-rework path. That is the intended behavior; confirm no test asserts "partial write ⇒ success". |
| `src/providers/openai-compat.ts` | extends `OpenAIAdapter` | low | Inherits the refusal mapping via `super.chat`; must NOT need its own edit. |
| `src/providers/claude-code.ts` | separate adapter | none | **Do NOT touch** (nonGoal 4: text-only boundary). |

Grep evidence: consumers of `AgenticLoopResult` are only `src/index.ts` and `agentic-loop.ts`; the only reads
of `.stopReason` in `src/` are inside `agentic-loop.ts` (`response.stopReason`, `turnStopReason`) and provider
**tests** asserting existing literals — no production consumer reads the loop result's `stopReason`.

### Existing Tests That Must Still Pass (byte-identical non-refusal path — sc-1-5)
- `src/providers/anthropic.test.ts:275,351` — assert `stopReason` `"end"` for `end_turn`/structured. Unchanged.
- `src/providers/openai.test.ts:255,274,287,398` — assert `end`/`tool_use`/`max_tokens`. Unchanged (you only
  add a new `content_filter` case; existing cases keep their mapping). Also the `makeOAIResponse` helper
  (`:43-70`) is used across the whole file — if you extend it, default new fields to `undefined`.
- `src/providers/openai-compat.test.ts:208,230` — inherited mapping asserts `tool_use`/`end`. Unchanged.
- `src/providers/google.test.ts:313,436,449,465,552,569` and `claude-code.test.ts:50` — untouched adapters;
  must stay green (regression sentinels).
- `src/orchestrator/architect-agent.test.ts`, `evaluator-agent.test.ts` — mock `runAgenticLoop`; the
  additive `refused?` field does not change their scripted return objects.

### Features That Could Be Affected
- **Generator sprint success semantics** — the one intended behavior change: refusal-after-partial-write is
  now `success:false` (ADR-5). Verify no existing generator/pipeline test encodes the old false-pass.
- **Fleet children (DeepSeek/Grok/openai-compat)** — get refusal mapping for free via `openai.ts`; verify
  `openai-compat.test.ts` stays green.

### Recommended Regression Checks (run after implementation)
1. `npm run build` (tsc) — must be clean (sc-1-6).
2. `npm run typecheck` (tsc --noEmit) — zero errors (sc-1-6).
3. `npm run lint` (eslint src/) — zero errors (`consistent-type-imports`, unused-vars gates).
4. `npm test` (vitest) — FULL suite green (~3686 tests); pay attention to
   `src/providers/*.test.ts` and `src/orchestrator/*agent*.test.ts`.
5. Targeted: `npx vitest run src/providers/anthropic.test.ts src/providers/openai.test.ts src/orchestrator/agentic-loop.test.ts src/orchestrator/generator-agent.test.ts`.

---

## 8. Implementation Sequence (dependency-ordered)

1. **src/providers/types.ts** — update the `StopReason` doc comment to document `"refusal"` (no type change).
   - Verify: `npm run typecheck` still clean.
2. **src/providers/anthropic.ts** — add explicit `case "refusal": return "refusal";` to `normalizeStopReason`.
   - Verify: add + run the Anthropic refusal test (§6) → `stopReason === "refusal"`.
3. **src/providers/openai.ts** — add `case "content_filter"`, add `refusal?: string | null` to `OAIMessage`,
   and the `message.refusal` override branch in `chat()`.
   - Verify: add + run the two OpenAI refusal tests (§6); openai-compat inherits (no edit).
4. **src/orchestrator/agentic-loop.ts** — add `refused?: boolean` to `AgenticLoopResult`; derive
   `refused = turnStopReason === "refusal"` and spread-conditionally set it on the completion-branch return.
   - Verify: create `agentic-loop.test.ts` (§1) → sc-1-3 (with and without prior tool_use) + sc-1-5 (no key).
5. **src/orchestrator/generator-agent.ts** — `export` `parseGeneratorResult`, widen its `loopResult` param
   type with `refused?: boolean`, and add the `refused === true` guard as the FIRST statement (before the
   `filesWritten.size > 0` check).
   - Verify: create `generator-agent.test.ts` (§1) → sc-1-4 (refused overrides files) + sc-1-5 (files still pass).
6. **Run full verification** — `npm run build` && `npm run typecheck` && `npm run lint` && `npm test`.

---

## 9. Pitfalls & Warnings

- **`parseGeneratorResult` is NOT exported** (`generator-agent.ts:181`). sc-1-4's unit test calls it directly
  per evaluatorNotes → you MUST add `export`. Forgetting this forces an awkward `runGenerator`+`vi.mock` test.
- **Guard ORDER is the whole point of sc-1-4.** The `refused` check must run **before** the
  `if (filesWritten.size > 0) return { success: true … }` at `generator-agent.ts:260`. Put it at the top of
  the function. Placing it later lets a partial-write refusal slip through as success.
- **Never throw on refusal** (ADR-4/ADR-5). `pipeline.ts:329` has no try/catch around `runGenerator`; a
  throw crashes the run. Return the result shape with `refused:true` — mirror the graceful
  `max_turns_exceeded` return at `agentic-loop.ts:406`.
- **Spread-conditional, not `refused: false`.** sc-1-5 checks `Object.hasOwn(result, "refused") === false`
  on normal completions. Emitting `refused: false` fails that. Use `...(refused ? { refused: true } : {})`.
- **Do NOT add `refused?` to `ChatResponse`** (`types.ts:212`). generatorNotes: the loop derives it; the
  response only carries `stopReason`.
- **Do NOT edit `openai-compat.ts` or `claude-code.ts`.** openai-compat inherits via `super.chat`
  (`openai-compat.ts:62`); claude-code is an explicit nonGoal (text-only boundary).
- **`noFallthroughCasesInSwitch` is on** — every new `case` must `return`. Do not fall through.
- **A refusal is NOT a transient error.** Do not add "refusal" to `TRANSIENT_ERROR_PATTERNS`
  (`agentic-loop.ts:74`) — that would retry it. Refusal is a normal (non-throwing) response, handled at the
  completion branch, never in `chatWithRetry`.
- **`makeOAIResponse` is shared** across `openai.test.ts`. If you extend it with a `refusal`/`content_filter`
  option, keep defaults `undefined`/`"stop"` so the ~dozen existing callers stay byte-identical.
- **Anthropic raw `"refusal"` already reaches normalize** via the default branch (SDK union at
  `messages.d.ts:1004`). Adding the explicit case is required for sc-1-1's "not the default branch" wording,
  but remember the substantive fix is the **loop** completion branch — the adapter change alone would not
  have failed the run.
