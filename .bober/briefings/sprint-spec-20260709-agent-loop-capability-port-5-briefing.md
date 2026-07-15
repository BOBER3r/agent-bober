# Sprint Briefing: Structured loop event stream + host-style hooks (preToolUse veto, postToolUse, onStop)

**Contract:** sprint-spec-20260709-agent-loop-capability-port-5
**Generated:** 2026-07-10T00:00:00.000Z

> ⚠️ The contract's `assumptions`/`generatorNotes` line anchors (`~:328`, `~:362-369`, `~:406`) were written BEFORE sprints 1/3/4 landed and are STALE. Every anchor below was re-located by reading the CURRENT file. Trust THIS briefing's line numbers, not the contract's.

---

## 0. TL;DR — what this sprint actually is

- **New file** `src/orchestrator/loop-events.ts` = pure TYPES only (`LoopEvent` union, `LoopHooks`, `HookDecision`). No runtime logic, no imports except a type-only `AgenticLoopResult` from `./agentic-loop.js`.
- **Modify** `src/orchestrator/agentic-loop.ts` = add `onEvent?` + `hooks?` to `AgenticLoopParams`; emit events at loop points; wrap all observe callbacks; route the 4 return paths through one `finish()` helper.
- **Modify** `src/orchestrator/tools/executor.ts` = extend `ToolBatch` with optional tool-level callbacks (`onToolStart`/`onToolEnd`/`preToolUse`/`postToolUse`) threaded into `executeOne`; veto short-circuits the handler with a standard `isError` ToolResult.
- **Tests** collocated: `loop-events.test.ts` + additions to `agentic-loop.test.ts`.
- **NO config/schema change.** `onEvent`/`hooks` are programmatic params only (Zod untouched). Confirmed: nothing in `config/schema.ts` needs editing.
- **Byte-identical guarantee:** every new field is optional; when all absent, `?.` calls are no-ops and behavior is unchanged. This is the SAME additive-optional discipline sprints 1/3/4 used.

---

## 1. Target Files

### src/orchestrator/loop-events.ts (create)

**Directory pattern:** siblings in `src/orchestrator/` are kebab-case `.ts` with a collocated `.test.ts` (e.g. `agentic-loop.ts` + `agentic-loop.test.ts`, `context-handoff.ts`). Section headers use `// ── Name ──────` box-drawing comments (principles.md:32).
**Most similar existing file:** `src/orchestrator/tools/executor.ts` (a focused, types-then-logic orchestrator module). For a *types-only* module, mirror the `// ── Types ──` block of `providers/types.ts:8-98`.

**Structure template (per `generatorNotes` — verified against `ChatResponse`/`AgenticLoopResult` shapes):**
```ts
import type { AgenticLoopResult } from "./agentic-loop.js"; // type-only → NO runtime cycle (erased)

// ── Loop events ────────────────────────────────────────────────────

/**
 * Host-side observability event stream. `compact-boundary` (sprint 7) and
 * `text-delta` (sprint 8) type names are RESERVED via this comment only —
 * do NOT emit them this sprint.
 */
export type LoopEvent =
  | { type: "init"; model: string; maxTurns: number }
  | { type: "turn-start"; turn: number }
  | { type: "tool-start"; turn: number; name: string; input: unknown; toolUseId: string }
  | { type: "tool-end"; turn: number; name: string; toolUseId: string; isError: boolean }
  | { type: "turn-end"; turn: number; toolsCalled: string[] }
  | { type: "result"; stopReason: string; turnsUsed: number };
// RESERVED (do not implement): { type: "compact-boundary"; ... } | { type: "text-delta"; ... }

// ── Hooks ──────────────────────────────────────────────────────────

export interface HookDecision {
  allow: boolean;
  reason?: string;
}

export interface LoopHooks {
  /** Veto gate BEFORE a tool handler runs. Deny → handler skipped, model gets an isError rejection, loop continues. */
  preToolUse?: (call: { name: string; input: unknown; toolUseId: string }) => HookDecision | Promise<HookDecision>;
  /** Observe a tool result after execution. Throwing is caught + logged. */
  postToolUse?: (call: { name: string; input: unknown; toolUseId: string }, result: { toolUseId: string; content: string; isError?: boolean }) => void | Promise<void>;
  /** Observe the final result exactly once, on every stop path. Throwing is caught + logged. */
  onStop?: (result: AgenticLoopResult) => void | Promise<void>;
}
```
> `input`/`content`/`isError` shapes above are taken verbatim from `ToolCall` (`providers/types.ts:56-63`) and `ToolResult` (`providers/types.ts:71-78`). You MAY `import type { ToolCall, ToolResult } from "../providers/types.js"` and reference them instead of re-declaring the inline literals — cleaner and DRY.

---

### src/orchestrator/agentic-loop.ts (modify)

**Current return-path & emission map (VERIFIED against the current file):**

| Concern | Current location | Action |
|---------|------------------|--------|
| Destructure params | lines 265-282 | add `onEvent`, `hooks` |
| `AgenticLoopParams` interface | lines 11-65 | add `onEvent?` + `hooks?` fields |
| `AgenticLoopResult` interface | lines 67-93 | UNCHANGED (loop-events.ts imports it type-only) |
| **init** emit point | before the `for` loop, ~line 300-301 (after accumulators init) | emit `{type:'init', model, maxTurns}` |
| **turn-start** emit point | top of loop, after `logger.debug` line 303 | emit `{type:'turn-start', turn}` |
| **RETURN #1 — error** | lines 324-334, `stopReason: "error"` (catch block) | wrap in `finish(...)` |
| **RETURN #2 — budget_exceeded** | lines 353-365, `stopReason: "budget_exceeded"` | wrap in `finish(...)` |
| **RETURN #3 — completion (incl. refused)** | lines 404-415, `stopReason: turnStopReason` | wrap in `finish(...)` |
| nudge `continue` (NOT a return) | line 397 | leave as-is — does not stop the loop |
| `executeToolBatch` call site | lines 437-443 | pass new tool callbacks (closing over `turn`) |
| **turn-end** / `onTurnComplete` | line 453 `onTurnComplete?.(turn, turnTools)` | emit `{type:'turn-end', turn, toolsCalled: turnTools}` ADJACENT; keep `onTurnComplete` call byte-identical |
| **RETURN #4 — max_turns** | lines 461-473, `stopReason: "max_turns_exceeded"` | wrap in `finish(...)` |

**There are EXACTLY 4 `return` statements** (lines 324, 353, 404, 461). Route ALL four through a single inner `finish()` helper so `result` event + `onStop` fire exactly once per stop path (sc-5-3). The nudge branch at line 397 uses `continue`, NOT return — it must NOT fire `onStop`.

**Current completion/refusal return (lines 404-415) — the model of a return to wrap:**
```ts
      return {
        finalText,
        turnsUsed: turn,
        toolsCalled: allToolsCalled,
        usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
        stopReason: turnStopReason,
        ...(refused ? { refused: true } : {}),
        ...(totalCostUsd !== undefined ? { costUsd: totalCostUsd } : {}),
      };
```

**Current executeToolBatch call (lines 437-443) — where tool callbacks thread in:**
```ts
    const toolResults = await executeToolBatch({
      toolCalls: response.toolCalls,
      toolHandlers,
      readOnlyTools,
      parallel: parallelReadOnlyTools === true,
      onToolUse,
    });
```
> `onToolUse` is the EXISTING channel sprint 4 moved into the batch. The new `tool-start`/`tool-end` events + `preToolUse`/`postToolUse` hooks follow the SAME channel — add them to this object.

**Recommended `finish()` helper (place as inner fn after destructuring, ~line 283):**
```ts
  const safeEmit = (e: LoopEvent): void => {
    if (!onEvent) return;
    try { onEvent(e); } catch (err) {
      logger.warn(`onEvent hook threw (swallowed): ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  async function finish(result: AgenticLoopResult): Promise<AgenticLoopResult> {
    safeEmit({ type: "result", stopReason: result.stopReason, turnsUsed: result.turnsUsed });
    if (hooks?.onStop) {
      try { await hooks.onStop(result); } catch (err) {
        logger.warn(`onStop hook threw (swallowed): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return result;
  }
```
Then each `return { ... }` becomes `return finish({ ... })` (async fn already; `finish` returns a Promise, so `return finish(...)` awaits `onStop` before the loop resolves). Do NOT `return await` inside try blocks unless you intend the catch to see it — plain `return finish(...)` is correct here.

**Imports this file already uses (lines 1-7):**
- `import type { LLMClient, ToolDef, Message, AssistantMessage, ToolResultMessage } from "../providers/types.js"`
- `import { logger } from "../utils/logger.js"` — REUSE for all swallowed-hook logging (sc-5-4)
- `import { executeToolBatch } from "./tools/executor.js"`
- ADD: `import type { LoopEvent, LoopHooks } from "./loop-events.js"`

**Imported by (impact — all pass a params object, all safe with additive optionals):**
`src/index.ts` (re-exports `AgenticLoopParams`/`AgenticLoopResult`/`runAgenticLoop` at 118-121), `generator-agent.ts`, `evaluator-agent.ts`, `architect-agent.ts`, `documenter-agent.ts`, `code-reviewer-agent.ts`, `planner-agent.ts`, `curator-agent.ts`, `research-agent.ts`, `workflow/retry.ts`.

**Test file:** `src/orchestrator/agentic-loop.test.ts` (EXISTS — extend it).

---

### src/orchestrator/tools/executor.ts (modify)

**Current `ToolBatch` interface (lines 18-32) — add optional tool-level callbacks:**
```ts
export interface ToolBatch {
  toolCalls: ToolCall[];
  toolHandlers: Map<string, ToolHandler>;
  readOnlyTools: Set<string>;
  parallel: boolean;
  onToolUse?: (name: string, input: unknown) => void;
  // NEW (all optional — omitting them is byte-identical to sprint 4):
  onToolStart?: (call: ToolCall) => void;                                    // dispatch-time event
  onToolEnd?: (call: ToolCall, result: ToolResult) => void;                  // settle-time event
  preToolUse?: (call: ToolCall) => Promise<HookDecision>;                    // already fail-closed-wrapped by the loop
  postToolUse?: (call: ToolCall, result: ToolResult) => void | Promise<void>;// already try/catch-wrapped by the loop
}
```
> Import `HookDecision` type-only from `../loop-events.js`. Wrapping preToolUse (fail-closed on throw) and postToolUse (swallow on throw) is done ONCE in the LOOP before passing them in — so the executor calls plain callbacks that never throw. Keep the swallow/fail-closed policy in the loop, NOT scattered in the executor.

**Current `executeOne` (lines 41-77) — the 3 result shapes to preserve + where to inject:**
```ts
async function executeOne(toolCall, toolHandlers, onToolUse?): Promise<ToolResult> {
  const toolName = toolCall.name;
  const toolInput = toolCall.input;
  onToolUse?.(toolName, toolInput);
  // >>> INJECT: onToolStart?.(toolCall)  (dispatch-time, synchronous, before any await)
  // >>> INJECT: preToolUse veto here — if !decision.allow, build the isError ToolResult
  //             below (mirror the unknown-tool shape), fire onToolEnd + postToolUse, RETURN it.
  const handler = toolHandlers.get(toolName);
  if (!handler) {
    logger.warn(`Unknown tool requested: "${toolName}"`);
    return { toolUseId: toolCall.id, content: `Error: Unknown tool "${toolName}"...`, isError: true }; // shape A
  }
  try {
    const result = await handler(toolInput);
    return { toolUseId: toolCall.id, content: result.output, isError: result.isError };               // shape B
  } catch (err) {
    return { toolUseId: toolCall.id, content: `Error: Tool execution failed: ${message}`, isError: true }; // shape C
  }
}
```
**Veto rejection ToolResult** (sc-5-2) MUST reuse this exact error shape — `{ toolUseId: toolCall.id, content: <text containing decision.reason>, isError: true }`. Example content: `` `Error: Tool call to "${toolName}" was denied by policy: ${decision.reason ?? "no reason given"}` ``. After building ANY result (veto / A / B / C), fire `onToolEnd?.(toolCall, result)` then `await postToolUse?.(toolCall, result)` before returning it — pull this into a small local `finalize(result)` closure inside `executeOne` to avoid 4 copies.

**Signature change:** give `executeOne` a 4th optional param bundling the new callbacks (e.g. `execHooks?: Pick<ToolBatch, "onToolStart"|"onToolEnd"|"preToolUse"|"postToolUse">`), and pass `batch`'s new fields through from both the serial branch (line 105) and the parallel `.map()` branch (line 122).

**Imported by:** ONLY `src/orchestrator/agentic-loop.ts` (line 7). This is the sole consumer — low blast radius.

**Test file:** `src/orchestrator/tools/executor.test.ts` (EXISTS — you MAY add veto/hook cases here too, but sc-5-1/5-2 are cleanest as full-loop tests in `agentic-loop.test.ts`).

---

## 2. Patterns to Follow

### Additive-optional param = byte-identical (the spine of this sprint)
**Source:** `src/orchestrator/agentic-loop.ts`, lines 44-48 (`parallelReadOnlyTools?`, `onToolUse?`, `onTurnComplete?`) and the spread guards at 413-414.
```ts
  parallelReadOnlyTools?: boolean;
  onToolUse?: (name: string, input: unknown) => void;
  onTurnComplete?: (turn: number, toolsCalled: string[]) => void;
```
**Rule:** add `onEvent?`/`hooks?` exactly like these — optional, guarded with `?.`, never changing a code path when absent.

### Omit-the-key-when-absent (keeps results deep-equal)
**Source:** `src/orchestrator/agentic-loop.ts`, lines 413-414.
```ts
        ...(refused ? { refused: true } : {}),
        ...(totalCostUsd !== undefined ? { costUsd: totalCostUsd } : {}),
```
**Rule:** the `finish()` helper must NOT add any key to the result object — it only observes. `AgenticLoopResult` stays byte-identical for sc-5-5's deep-equal paired-run.

### Never-throw executor + exact error shapes
**Source:** `src/orchestrator/tools/executor.ts`, lines 52-76 (shapes A/B/C) and the docstring 87-92 ("Never rejects").
**Rule:** the veto path and hook plumbing must NEVER let a throw escape `executeToolBatch`; every failure becomes an in-slot `isError` ToolResult.

### Swallow-and-log via the shared logger
**Source:** `src/orchestrator/agentic-loop.ts`, lines 320-322 (catch → `logger.warn`) and executor.ts:69-70.
```ts
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`Agentic loop API error on turn ${turn}: ${message}`);
```
**Rule:** observe-hook throws (`onEvent`/`postToolUse`/`onStop`) are caught and `logger.warn`'d, then execution continues (sc-5-4). There is NO existing `safeInvoke`/swallow util (grep confirmed) — inline try/catch is the house style.

### ESM + type-imports discipline (hard lint gates)
**Source:** principles.md:27, 35 and every file's `import type` usage (e.g. agentic-loop.ts:1).
**Rule:** all relative imports end in `.js`; import types with `import type`; prefix any unused param with `_`. `consistent-type-imports` + `noUnusedParameters` are enforced gates.

### Section headers
**Source:** principles.md:32; e.g. executor.ts:16 `// ── Types ──` , agentic-loop.ts:9 `// ── Types ──`.
**Rule:** organize new files/blocks with `// ── Name ──────` box-drawing comments.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `logger` | `src/utils/logger.ts:87` | singleton `Logger` w/ `.warn/.debug/.info/.error` | The ONLY logging surface — use `logger.warn(...)` for every swallowed hook error (sc-5-4). Do NOT `console.log`. |
| `executeToolBatch` | `src/orchestrator/tools/executor.ts:93` | `(batch: ToolBatch) => Promise<ToolResult[]>` | The turn's tool dispatcher (sprint 4). EXTEND its `ToolBatch` input — do NOT re-implement per-tool execution in the loop. |
| `ToolHandler` (type) | `src/orchestrator/tools/handlers.ts:21-23` | `(input: Record<string, unknown>) => Promise<{output: string; isError: boolean}>` | Handler contract; `executeOne` maps `output→content`, `isError→isError`. |
| `ToolCall` / `ToolResult` (types) | `src/providers/types.ts:56-63` / `71-78` | see §1 | Reuse in `LoopEvent`/`LoopHooks` payloads instead of re-declaring literals. |
| `AgenticLoopResult` (type) | `src/orchestrator/agentic-loop.ts:67-93` | interface | The `onStop` param type; `loop-events.ts` imports it type-only. |
| `ScriptedLoopClient` (test util) | `src/orchestrator/agentic-loop.test.ts:17-29` | `new ScriptedLoopClient(ChatResponse[])` | Fake `LLMClient` scripting turns; the base fixture is `const base` at line 31. Reuse/extend for new tests. |

**Utilities reviewed:** `src/utils/` (`fs.ts`, `git.ts`, `logger.ts`, `index.ts`) — only `logger` applies. No `safeInvoke`/`swallow`/hook helper exists anywhere in `src/` (verified by grep) — write inline try/catch.

---

## 4. Prior Sprint Output

### Sprint 1 (35a2dbd): refusal detection
**Modified:** `agentic-loop.ts` — the completion return (lines 400-415) now derives `refused` from `turnStopReason === "refusal"` and spreads `refused: true` only when true.
**Connection:** the refusal stop path is RETURN #3 (completion branch). `onStop` must fire on it (sc-5-3) — routing all returns through `finish()` covers it automatically.

### Sprint 3 (b9c936c): effort/budget loop wiring
**Modified:** `agentic-loop.ts` — added the `budget_exceeded` return (lines 351-366) and effort forwarding (line 315).
**Connection:** `budget_exceeded` is RETURN #2 — `finish()` must wrap it so `onStop` fires exactly once (sc-5-3). Existing tests sc-3-3/sc-3-4 (test lines 174-296) MUST still pass.

### Sprint 4 (4ab7040 / 59b4b23): tool execution delegated to `executeToolBatch`
**Created:** `src/orchestrator/tools/executor.ts` (`executeToolBatch`, `executeOne`, `ToolBatch`). The loop's old serial for-await tool block is GONE — replaced by the call at agentic-loop.ts:437-443.
**Connection:** this is THE integration point for `tool-start`/`tool-end`/`preToolUse`/`postToolUse`. Thread them through `ToolBatch` (see §1). `onToolUse` already flows this way (executor.ts:31,49) — the new tool events use the same channel. Preserve sprint-4's byte-identical serial semantics AND its parallel/order-preservation path (executor.ts:98-128).

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **Type safety hard gate** (18): strict mode, `noUnusedParameters`, `isolatedModules`. Zero type errors.
- **Lint hard gate** (19): `consistent-type-imports`, unused vars errored (`_` escape).
- **Collocated tests** (20): `*.test.ts` next to `*.ts`, Vitest.
- **ESM everywhere** (27): `.js` import extensions, NodeNext.
- **Provider-agnostic** (28): keep SDK types out; `LoopEvent`/`LoopHooks` are OWN types, no SDK involvement (contract assumption).
- **No barrel re-export for deep internals** (43): `src/index.ts` is public API only. Re-exporting `LoopEvent`/`LoopHooks` from `index.ts` is OPTIONAL (nice-to-have for programmatic consumers, since `AgenticLoopParams` is already public at index.ts:119) — not required this sprint.
- **Section comments** (32) & **small utility modules** (33).

### Architecture Decisions
No ADR specific to the agent loop event stream exists. `.bober/architecture/` holds ADRs for other features (openhands fork, ide-shell, fleet, medical, chat-session) — none govern this sprint. The contract's own `assumptions`/`generatorNotes` are the design authority here.

### Other Docs
No `CLAUDE.md`/`CONTRIBUTING.md` coding-guideline file governs this module beyond principles.md.

---

## 6. Testing Patterns

### Unit Test Pattern
**Source:** `src/orchestrator/agentic-loop.test.ts:8-31` (scripted fake client + base fixture).
```ts
import { describe, it, expect, vi } from "vitest";
import { runAgenticLoop } from "./agentic-loop.js";
import type { LLMClient, ChatParams, ChatResponse } from "../providers/types.js";

class ScriptedLoopClient implements LLMClient {
  private idx = 0;
  callCount = 0;
  lastParams?: ChatParams;
  constructor(private readonly responses: ChatResponse[]) {}
  async chat(params: ChatParams): Promise<ChatResponse> {
    this.callCount += 1;
    this.lastParams = params;              // NOTE: only the LAST call's params are kept
    const r = this.responses[Math.min(this.idx, this.responses.length - 1)];
    this.idx += 1;
    return r;
  }
}
const base = { toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
```
**Runner:** vitest. **Assertion style:** `expect(...)`. **Mock approach:** `vi.fn()` spies + the hand-rolled `ScriptedLoopClient` (no `vi.mock`). **File naming:** `*.test.ts` collocated.

**Two-turn (tool turn + completion) scripted client — copy from test lines 320-335:**
```ts
new ScriptedLoopClient([
  { ...base, text: "", stopReason: "tool_use", toolCalls: [{ id: "t1", name: "noop", input: {} }] },
  { ...base, text: "done", stopReason: "end" },
]);
```

**sc-5-1 event-collection assertion (recommended):**
```ts
const events: LoopEvent[] = [];
await runAgenticLoop({ /* ...2-turn client... */, onEvent: (e) => events.push(e) });
expect(events.map((e) => e.type)).toEqual([
  "init", "turn-start", "tool-start", "tool-end", "turn-end", "turn-start", "result",
]); // see §9 note on whether turn-end fires on the completion turn
```

**sc-5-2 veto assertion (spy handler NOT called; inspect fed-back messages):**
```ts
const noopSpy = vi.fn(async () => ({ output: "ok", isError: false }));
const result = await runAgenticLoop({
  /* 2-turn client whose turn 1 calls "noop" */,
  toolHandlers: new Map([["noop", noopSpy]]),
  hooks: { preToolUse: ({ name }) => name === "noop" ? { allow: false, reason: "blocked" } : { allow: true } },
});
expect(noopSpy).not.toHaveBeenCalled();
expect(result.stopReason).toBe("end");               // loop CONTINUED to completion
// The completion turn's chat received the rejection ToolResult:
const msgs = client.lastParams!.messages;            // 2nd chat call = completion turn
const tr = msgs.find((m) => "toolResults" in m) as { toolResults: { isError?: boolean; content: string }[] };
expect(tr.toolResults[0].isError).toBe(true);
expect(tr.toolResults[0].content).toContain("blocked");
```

**sc-5-3 spy hooks + exactly-once onStop across stop paths:**
```ts
const onStop = vi.fn(); const postToolUse = vi.fn();
await runAgenticLoop({ /* completion run */, hooks: { onStop, postToolUse } });
expect(onStop).toHaveBeenCalledTimes(1);
// repeat with a maxTurns:2 single-tool-turn client (see test lines 105-132) → onStop once on max_turns_exceeded
// budget/refusal paths already exist (sprints 1/3) → assert onStop once there too
```

**sc-5-4 throwing observe hook is swallowed / throwing preToolUse = fail-closed:**
```ts
await expect(runAgenticLoop({ /* run */, onEvent: () => { throw new Error("boom"); } })).resolves.toBeDefined();
// throwing preToolUse → tool skipped with isError rejection, loop still completes
```

**sc-5-5 byte-identical paired run (use TWO fresh scripted clients — `ScriptedLoopClient` is stateful):**
```ts
const withHooks = await runAgenticLoop({ client: makeClient(), /* + onEvent/hooks */ });
const withoutHooks = await runAgenticLoop({ client: makeClient() });
expect(withHooks).toEqual(withoutHooks);
```
> Fresh-client-per-run pattern is proven at test lines 320-335 (`makeScriptedTurnClient()`).

**Message-capture note:** `ScriptedLoopClient` only stores `lastParams`. For a 2-turn veto run, `lastParams` is the completion turn's params, which DOES include turn 1's `ToolResultMessage` — sufficient for sc-5-2. If a test needs EVERY call's params, extend the fake with `allParams: ChatParams[] = []; this.allParams.push(params);`.

### E2E Test Pattern
Not applicable — this is a pure-logic orchestrator module. No Playwright/`e2e/` involvement.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/orchestrator/tools/executor.ts` | (self, being modified) | low | ONLY imported by `agentic-loop.ts`. Additive optional `ToolBatch` fields keep all existing callers valid. |
| `src/orchestrator/agentic-loop.ts` consumers (generator/evaluator/architect/documenter/code-reviewer/planner/curator/research agents, `pipeline.ts`, `workflow/retry.ts`, `index.ts`) | `runAgenticLoop`/`AgenticLoopParams` | low | All call with a params object; new fields are optional → no signature break. Verify `npm run typecheck`. |
| `src/index.ts` (lines 118-121) | re-exports loop types | low | Still compiles; optionally add `loop-events` re-export (not required). |

### Existing Tests That Must Still Pass
- `src/orchestrator/agentic-loop.test.ts` — sc-1-3/sc-1-5 refusal (lines 35-133), sc-3-2 effort (137-170), sc-3-3/sc-3-4 budget+cost (174-296), sc-4-2/sc-4-3/sc-4-4 parallel tools (300-488). These exercise EVERY return path and the executor call — they are your byte-identical regression net.
- `src/orchestrator/tools/executor.test.ts` — sc-4-1..sc-4-4 (all 301 lines): concurrency proof, in-slot error containment, serial fallback, `onToolUse`-fires-for-every-call (lines 279-299). Adding optional callbacks must NOT change any of these outcomes.
- `src/orchestrator/generator-agent.test.ts` — references `AgenticLoopParams`; verify still typechecks.

### Features That Could Be Affected
- **Parallel read-only tool execution (sprint 4)** — shares `executeOne`/`executeToolBatch`. Verify order preservation (executor.test.ts:126-129) and the "onToolUse fires for every call before handler lookup, in order" invariant (executor.test.ts:279-299) still hold after inserting `onToolStart`/`preToolUse`. Keep `onToolStart` synchronous + BEFORE the first `await`, exactly like `onToolUse` at executor.ts:49, so dispatch order is unchanged.
- **Budget / refusal / effort (sprints 1/3)** — share the return paths now routed through `finish()`. Verify their stopReasons/keys are unchanged.

### Recommended Regression Checks (run after implementation)
1. `npm run build` — must pass (sc-5-6).
2. `npm run typecheck` — zero errors (sc-5-6; watch for the type-only `loop-events.ts ↔ agentic-loop.ts` cycle — `import type` keeps it runtime-safe).
3. `npx vitest run src/orchestrator/agentic-loop.test.ts src/orchestrator/tools/executor.test.ts src/orchestrator/loop-events.test.ts` — targeted green.
4. `npm test` (full suite, ~3787 tests) — full green with NO pre-existing test edited except additive new cases (sc-5-5).
5. `npm run lint` — `consistent-type-imports` / unused-param gates clean.

---

## 8. Implementation Sequence (dependency-ordered)

1. **`src/orchestrator/loop-events.ts`** — define `LoopEvent`, `HookDecision`, `LoopHooks`; type-only import of `AgenticLoopResult`; optionally import `ToolCall`/`ToolResult` for payload types.
   - Verify: `npm run typecheck` — file compiles, no runtime import emitted (type-only).
2. **`src/orchestrator/loop-events.test.ts`** — light structural/type tests (e.g. a `HookDecision` literal is assignable; a sample `LoopEvent` narrows by `type`). Types-only modules often just need a compile-time smoke test.
   - Verify: test file typechecks and runs green.
3. **`src/orchestrator/tools/executor.ts`** — extend `ToolBatch` with the 4 optional callbacks; thread into `executeOne` (dispatch `onToolStart` before first await → `preToolUse` veto → handler → `onToolEnd` + `postToolUse` on every result via a local `finalize`); pass through both serial (line 105) and parallel (line 122) branches.
   - Verify: `npx vitest run src/orchestrator/tools/executor.test.ts` — all sprint-4 tests still green (byte-identical when callbacks absent).
4. **`src/orchestrator/agentic-loop.ts`** — add `onEvent?`/`hooks?` to `AgenticLoopParams` + destructure; add `safeEmit` + `finish()`; emit `init` (pre-loop), `turn-start` (loop top), `turn-end` (adjacent to line 453); build per-turn tool callbacks closing over `turn` + wrapped `preToolUse` (fail-closed) / `postToolUse` (swallow) and pass into `executeToolBatch`; wrap all 4 returns in `finish()`.
   - Verify: `npx vitest run src/orchestrator/agentic-loop.test.ts` — all sprints 1/3/4 tests still green.
5. **`src/orchestrator/agentic-loop.test.ts`** — add sc-5-1..sc-5-5 cases (event order, veto continuation, per-path onStop, throwing-hook swallow, byte-identical paired run).
   - Verify: new cases green.
6. **Run full verification** — `npm run build` && `npm run typecheck` && `npm test` && `npm run lint`.

---

## 9. Pitfalls & Warnings

- **STALE contract anchors.** `~:328`, `~:362-369`, `~:406` in the contract predate sprints 1/3/4. Use §1's verified lines. The "unknown-tool path" the contract cites for the rejection shape is now `executor.ts:52-58`, NOT agentic-loop.
- **turn-end on the completion turn — the one genuine ambiguity.** `onTurnComplete` fires ONLY at line 453 (tool turns) and MUST stay there byte-identically (sc-5-5). `turn-end` is a NEW event. sc-5-1 lists `turn-end` in the per-turn sequence; a tool-less completion turn currently returns at line 404 BEFORE line 453. RECOMMENDATION: emit `turn-end` for the completion turn too (with `toolsCalled: []`) just before RETURN #3, so a 2-turn run yields `init, turn-start, tool-start, tool-end, turn-end, turn-start, turn-end, result`. If you instead only emit `turn-end` at line 453 (tool turns only), the trace omits the 2nd `turn-end`. Pick ONE and make the sc-5-1 test assert it explicitly — do NOT leave it implicit.
- **Exactly-once onStop.** Only the 4 `return`s (lines 324/353/404/461) are stop paths. The nudge `continue` (line 397) is NOT — do not fire `finish()`/`onStop` there. Route every return through `finish()` so `result`+`onStop` fire once each.
- **Fail-closed vs swallow are OPPOSITE policies.** `preToolUse` throw → treat as `{allow:false, reason:'hook error (fail-closed)'}` (DENY). `onEvent`/`postToolUse`/`onStop` throw → catch, `logger.warn`, CONTINUE. Do not conflate.
- **Byte-identical parallel path.** When `preToolUse` is undefined, `executeOne`'s first `await` must remain the handler call (executor.ts:62) so sprint-4 timing/order tests hold. `onToolStart` must be synchronous and fire BEFORE any await, mirroring `onToolUse` at executor.ts:49.
- **tool-end ordering in parallel batches.** `tool-start` = dispatch order (input order, synchronous). `tool-end`/`postToolUse` fire at SETTLE time → in a parallel read-only batch they may interleave by completion order, not input order. This is the documented convention (contract instruction) — sc-5-1 uses a SERIAL single-tool-per-turn run so it stays deterministic. Do not try to force tool-end into input order.
- **Type-only cycle.** `loop-events.ts` imports `AgenticLoopResult` from `agentic-loop.ts`, which imports `LoopEvent`/`LoopHooks` from `loop-events.ts`. Use `import type` on BOTH sides — TS erases it, no runtime ESM cycle. A value import here would break.
- **No config schema change.** Do NOT touch `config/schema.ts`. `onEvent`/`hooks` are programmatic params; adding Zod fields is out of scope and would violate the contract.
- **Don't mutate tool inputs.** `preToolUse` is veto-only this sprint (contract nonGoal). Do not let it transform `call.input`.
- **Result object stays byte-identical.** `finish()` observes only — it must NOT add keys to `AgenticLoopResult`, or sc-5-5's `toEqual` paired-run fails.
