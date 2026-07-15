# Sprint Briefing: Mid-turn interrupt — AbortSignal through the loop and streaming adapter

**Contract:** sprint-spec-20260709-agent-loop-capability-port-9
**Generated:** 2026-07-10T00:00:00Z

> Goal: add an optional `AbortSignal` to `AgenticLoopParams` + `ChatParams`. The loop
> checks it at every turn boundary AND after each response (before running tools),
> threads it into `ChatParams`, and the Anthropic adapter forwards it into the SDK
> `create`/`stream` options so an in-flight request is cancelled. An aborted run
> resolves with `stopReason: "aborted"` + accumulated partial telemetry — NEVER a
> throw/rejection. No signal ⇒ byte-identical. Reuse the sprint-5 `finish()` helper
> (single onStop/result), mirror the sprint-3 `budget_exceeded` return shape.

---

## 1. Target Files

### src/providers/types.ts (modify)

Add `abortSignal?: AbortSignal` to `ChatParams`. `AbortSignal` is a web-standard global
type (no SDK import) — acceptable in the provider-agnostic surface (contract assumption).
Insert next to the other optional callback field `onTextDelta` (ends at line 218).

**`ChatParams` interface, lines 146-219 (the tail — insert after `onTextDelta`):**
```ts
  // types.ts:209-218 — existing final field
  onTextDelta?: (delta: string) => void;
  // ADD (sprint 9): abort in-flight requests. Web-standard AbortSignal, NOT an SDK
  // type. Only the Anthropic adapter forwards it (into create/stream options);
  // other adapters ignore it. Absent => byte-identical request.
  abortSignal?: AbortSignal;
}   // <- closes ChatParams at line 219
```

**`StopReason` (types.ts:231):** `"aborted"` needs NO type change — the union is already
open: `export type StopReason = "end" | "tool_use" | "max_tokens" | "error" | string;`
(You may extend the JSDoc at types.ts:221-230, optional.)

**Imported by:** every adapter (`anthropic.ts:5`, `openai.ts`, `google.ts`, `claude-code`),
the loop (`agentic-loop.ts:205` via `Parameters<LLMClient["chat"]>[0]`), and
`agentic-loop.test.ts:16`. Adding an OPTIONAL field is source-compatible everywhere.

**Test file:** `src/providers/types.ts` has no dedicated test (pure types).

---

### src/providers/anthropic.ts (modify)

Forward `params.abortSignal` into BOTH SDK calls as the 2nd `options` arg. The adapter
already references optional params directly via `params.` (e.g. `params.documents`,
`params.onTextDelta`, `params.responseSchema`) rather than destructuring — follow that.

**Non-stream + stream call sites, lines 380-403:**
```ts
    // anthropic.ts:382-384 (non-stream)
    if (params.onTextDelta === undefined) {
      const response = await this.client.messages.create(requestBody);        // <- add 2nd arg
      return normalizeResponse(response, model, structured);
    }
    // anthropic.ts:389 (stream)
    const stream = this.client.messages.stream(requestBody);                  // <- add 2nd arg
```
Change to pass request options built ONCE (keep `requestBody` untouched so the
`streamMock.calls[0][0] === createMock.calls[0][0]` invariant at anthropic.test.ts:715
still holds — the signal goes in the SECOND arg, not the body):
```ts
    const requestOptions = params.abortSignal ? { signal: params.abortSignal } : undefined;
    ...
    const response = await this.client.messages.create(requestBody, requestOptions);
    ...
    const stream = this.client.messages.stream(requestBody, requestOptions);
```
`requestOptions === undefined` when no signal ⇒ `create(body, undefined)` is identical to
`create(body)` ⇒ byte-identical (sc-9-5).

**Concrete SDK surface (VERIFIED, @anthropic-ai/sdk 0.100.1):**
- `create(body, options?: RequestOptions)` — `node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts:31-33`
- `stream(body, options?: RequestOptions)` — `messages.d.ts:74`
- `RequestOptions.signal?: AbortSignal | undefined | null` — `node_modules/@anthropic-ai/sdk/internal/request-options.d.ts:56`. So the option KEY is **`signal`** (not `abortSignal`).

**Do NOT swallow the abort error in the stream loop.** The comment at anthropic.ts:399-401
mandates errors from iteration/`finalMessage()` propagate uncaught (sc-8-5 parity). When
the signal fires mid-stream the SDK rejects with `APIUserAbortError` — let it propagate so
`chatWithRetry` can classify it as an abort.

**Imports this file uses:** `Anthropic from "@anthropic-ai/sdk"` (anthropic.ts:1); types from `./types.js` (anthropic.ts:3-11).
**Imported by:** `src/providers/factory.ts` (adapter registry).
**Test file:** `src/providers/anthropic.test.ts` — EXISTS (717 lines).

---

### src/orchestrator/agentic-loop.ts (modify — the core)

Four edits: (1) add `abortSignal?` to `AgenticLoopParams` + destructure; (2) top-of-turn
boundary check; (3) post-response pre-tool check (degraded adapters); (4) abort-aware
`chatWithRetry` + the chat catch routing to `"aborted"`.

**(1) `AgenticLoopParams` (interface ends at line 131) + destructure (lines 331-354):**
```ts
  // agentic-loop.ts — add to AgenticLoopParams, near the compaction field (:130):
  /** Optional abort signal (sprint 9). When it fires, the loop ends at the next
   * boundary / cancels an in-flight Anthropic request, resolving with
   * stopReason 'aborted' + accumulated partials (never throws). Absent => byte-identical. */
  abortSignal?: AbortSignal;
```
Add `abortSignal` to the destructure block at lines 331-354 (alongside `compaction`).

**(2) Turn-boundary check — TOP of the `for` loop (lines 429-431):**
```ts
  for (let turn = 1; turn <= maxTurns; turn++) {                 // agentic-loop.ts:429
    // ADD FIRST — before the chat call is ever made (sc-9-1: 0 further chat calls).
    if (abortSignal?.aborted) {
      await persistSession(turn - 1);
      return finish(abortedResult(turn - 1));   // helper spelled out in §2
    }
    logger.debug(`Agentic loop turn ${turn}/${maxTurns}...`);    // agentic-loop.ts:430
    safeEmit({ type: "turn-start", turn });
```

**(3) Post-response check — right after the chat try/catch, BEFORE usage accumulation
(insert between line 479 and line 481), so a degraded adapter's completed response is
discarded, compaction is skipped, and its tool calls are NOT run (sc-9-4):**
```ts
    }   // <- end of the chat try/catch at agentic-loop.ts:479
    // ADD (sc-9-4): a non-cancellable adapter completed the request, but the signal
    // fired during it. Discard this response — do not accumulate usage, do not
    // compact, do not run its tool batch. turnsUsed = fully-completed turns only.
    if (abortSignal?.aborted) {
      await persistSession(turn - 1);
      return finish(abortedResult(turn - 1));
    }
    // Accumulate usage                                          // agentic-loop.ts:481-483
    totalInputTokens += response.usage.inputTokens;
```

**(4) Thread signal into chat params (the object at lines 450-460) — spread pattern like
`effort`/`onTextDelta` at :457-458 so the absent path never carries the key:**
```ts
      response = await chatWithRetry(client, {
        model, system: systemPrompt, messages,
        tools: tools.length > 0 ? tools : undefined,
        maxTokens,
        ...(effort !== undefined ? { effort } : {}),
        ...(emitTextDelta ? { onTextDelta: emitTextDelta } : {}),
        ...(abortSignal !== undefined ? { abortSignal } : {}),   // ADD
      }, turn);
```

**(4b) The chat catch (lines 462-479) currently returns `stopReason: "error"`. Branch it
so an abort finishes as `"aborted"`:**
```ts
    } catch (err) {                                              // agentic-loop.ts:462
      // ADD: an abort is terminal, not an error. chatWithRetry rethrew AbortedError
      // (never retried). Also guard on the flag for provider-agnostic robustness.
      if (err instanceof AbortedError || abortSignal?.aborted) {
        await persistSession(turn - 1);
        return finish(abortedResult(turn - 1));
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`Agentic loop API error on turn ${turn}: ${message}`);
      await persistSession(turn - 1);
      return finish({ /* ...existing stopReason:"error" shape, lines 468-478... */ });
    }
```

**Test file:** `src/orchestrator/agentic-loop.test.ts` — EXISTS (1544 lines).
**Imported by (real consumers of `runAgenticLoop`):**
- `src/orchestrator/agents/*` runners (generator/curator/etc.) and `src/orchestrator/pipeline.ts` — none pass `abortSignal` today, so adding an optional field is a no-op for them (sc-9-5).

---

## 2. Patterns to Follow

### The `abortedResult(...)` shape MIRRORS the `budget_exceeded` return
**Source:** `src/orchestrator/agentic-loop.ts`, lines 548-564 (budget_exceeded return).
```ts
    if (budget?.exceeded()) {
      logger.warn(`Agentic loop hit budget ceiling on turn ${turn}. Returning partial result.`);
      await persistSession(turn);
      return finish({
        finalText: finalText || "Budget ceiling reached before completion. Partial result returned.",
        turnsUsed: turn,
        toolsCalled: allToolsCalled,
        usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
        stopReason: "budget_exceeded",
        ...(totalCostUsd !== undefined ? { costUsd: totalCostUsd } : {}),
      });
    }
```
**Rule:** Build the aborted result identically but with `stopReason: "aborted"`. Define a
small local helper INSIDE `runAgenticLoop` (near `finish` at :414) to avoid repeating the
shape at all 3 abort exits:
```ts
    const abortedResult = (turnsUsed: number): AgenticLoopResult => ({
      finalText: finalText || "Run aborted before completion. Partial result returned.",
      turnsUsed,
      toolsCalled: allToolsCalled,
      usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
      stopReason: "aborted",
      ...(totalCostUsd !== undefined ? { costUsd: totalCostUsd } : {}),
    });
```
Note the `...(totalCostUsd !== undefined ? ... : {})` spread — keeps `costUsd` ABSENT (not
`undefined`) when no cost was seen, consistent with every other return (sc-3-4 discipline).

### Single-exit `finish()` — route EVERY abort return through it (sc-9-3)
**Source:** `src/orchestrator/agentic-loop.ts`, lines 414-425.
```ts
  async function finish(result: AgenticLoopResult): Promise<AgenticLoopResult> {
    safeEmit({ type: "result", stopReason: result.stopReason, turnsUsed: result.turnsUsed });
    if (hooks?.onStop) {
      try { await hooks.onStop(result); }
      catch (err) { /* swallow-and-log */ }
    }
    return result;
  }
```
**Rule:** `return finish(abortedResult(...))` — this fires the `{type:"result"}` LoopEvent
and `onStop` EXACTLY ONCE (sc-9-3). Never construct the aborted result and return it raw.
`LoopEvent.result.stopReason` is typed `string` (`loop-events.ts:48`), so `"aborted"` is valid.

### Never-retry classification lives in `chatWithRetry` (sprint-3 pattern)
**Source:** `src/orchestrator/agentic-loop.ts`, lines 203-228 (esp. the catch 212-225).
```ts
    } catch (err) {
      lastErr = err;
      const message = err instanceof Error ? err.message : String(err);
      if (!isTransientError(message) || attempt === MAX_CHAT_RETRIES) {
        throw err;                          // non-transient => rethrown immediately
      }
      ...backoff + sleep...
    }
```
**Rule:** Special-case abort BEFORE the transient check so it is rethrown immediately and
never retried (sc-9-2). `params.abortSignal` is available because `params` is `ChatParams`.
Define a typed `AbortedError` at module scope and throw it:
```ts
  // module scope, near TRANSIENT_ERROR_PATTERNS (:172):
  export class AbortedError extends Error {
    constructor() { super("Run aborted."); this.name = "AbortedError"; }
  }
  // inside chatWithRetry's catch, FIRST line:
      if (params.abortSignal?.aborted === true || (err instanceof Error && err.name === "AbortError")) {
        throw new AbortedError();           // never retried, loop catch maps to 'aborted'
      }
```
**WHY the flag check is primary (VERIFIED, critical):** the Anthropic SDK's abort error is
`APIUserAbortError` and its constructor does NOT set `this.name`
(`node_modules/@anthropic-ai/sdk/core/error.js:70-74`), so `err.name === "Error"`, NOT
`"AbortError"`. Its message is `"Request was aborted."`. Relying on `err.name` alone would
MISS the real SDK abort. `params.abortSignal?.aborted` is provider-agnostic and always true
when our signal caused the cancel. Keep the `err.name === "AbortError"` clause only as a
secondary guard (standard fetch/DOMException & test mocks that throw a raw `AbortError`).

### Threading an optional field with the spread-guard (byte-identical discipline)
**Source:** `src/orchestrator/agentic-loop.ts`:457-458 and `src/providers/anthropic.ts`:369.
```ts
  ...(effort !== undefined ? { effort } : {}),         // loop chat params
  ...(effort !== undefined ? { output_config: { effort } } : {}),  // adapter requestBody
```
**Rule:** Every new optional field is added ONLY when defined, so absence leaves the object
shape byte-identical. Same idiom for `abortSignal` in the loop's chat-params object.

### Provider-agnostic surface (principles)
**Source:** `.bober/principles.md` "Provider-agnostic interfaces" + this spec's ADR notes.
**Rule:** `AbortSignal` is a web-standard type — OK in `types.ts`. NEVER import an SDK type
into `types.ts` or the loop. The SDK `RequestOptions`/`APIUserAbortError` stay inside
`anthropic.ts` (this file may `import Anthropic` — it already does at :1).

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `finish` | `agentic-loop.ts:414` | `(result): Promise<AgenticLoopResult>` | Single exit: fires `result` event + `onStop` once. Route aborts through it. |
| `persistSession` | `agentic-loop.ts:380` | `(turnsUsed, extra?): Promise<void>` | No-op when no `session`; call on abort paths consistent with error path (`turn-1`). |
| `chatWithRetry` | `agentic-loop.ts:203` | `(client, params, turn): Promise<ChatResponse>` | The one place to special-case aborts (never retry). |
| `isTransientError` | `agentic-loop.ts:191` | `(message): boolean` | Existing transient classifier. Abort must be caught BEFORE this. |
| `TRANSIENT_ERROR_PATTERNS` | `agentic-loop.ts:172` | `string[]` | Note: "aborted"/"Request was aborted." matches NONE of these, so an abort already fails-fast — but still routes to `"error"` unless you branch it. |
| `safeEmit` | `agentic-loop.ts:402` | `(event: LoopEvent): void` | Swallow-and-log event emitter; used inside `finish`. |
| `budget.exceeded()` | `workflow/budget.ts` | `(): boolean` | Do NOT auto-abort on budget (nonGoal); budget stays a separate turn-boundary check. |
| `normalizeResponse` | `anthropic.ts:23` | `(resp, model, structured): ChatResponse` | Shared by both create & stream branches — DO NOT touch for this sprint. |
| SDK `APIUserAbortError` | `@anthropic-ai/sdk/core/error` | `class extends APIError` | The SDK's abort error (name `"Error"`, msg `"Request was aborted."`). Detect via `signal.aborted`, not name. |
| SDK `RequestOptions.signal` | SDK `internal/request-options.d.ts:56` | `signal?: AbortSignal \| null` | The exact option key to pass into `create`/`stream`. |

Utilities reviewed: `src/utils/` (`logger.ts`, `fs.ts`, `git.ts` — none abort-related);
`src/orchestrator/workflow/budget.ts`; `src/orchestrator/loop-events.ts`. There is NO
existing abort helper to reuse — you must add `AbortedError` + `abortedResult`. Existing
`AbortController`/`AbortSignal` usages elsewhere (`src/telegram/bot.ts:233`,
`src/evaluators/builtin/api-check.ts:62`, `src/cli/commands/telegram.ts:37`) are unrelated
long-poll/HTTP callers — no shared convention to import, but they confirm the codebase uses
the standard web `AbortController`/`AbortSignal` (no polyfill).

---

## 4. Prior Sprint Output (hard dependsOn: S3 + S8)

### Sprint 3: budget + cumulative cost accumulators (`agentic-loop.ts`)
**Provides:** `totalInputTokens`/`totalOutputTokens` (:368-369), `totalCostUsd` (:370, spread
absent-when-undefined), the `budget_exceeded` graceful-break return (:548-564), and the
never-throw `chatWithRetry` classifier.
**Connection:** the aborted return MIRRORS the `budget_exceeded` shape and reuses the SAME
accumulators for partial telemetry (sc-9-3).

### Sprint 5: single `finish()` exit + LoopEvents/hooks
**Provides:** `finish()` (:414), `safeEmit()` (:402), `{type:"result"}` event, `onStop` hook.
**Connection:** the aborted return MUST route through `finish()` so `result`/`onStop` fire once.

### Sprint 6: `persistSession` at turn boundaries (`agentic-loop.ts:380`)
**Connection:** call `persistSession(turn - 1)` on abort paths — consistent with the existing
`stopReason:"error"` catch (:467), which persists `turn - 1`.

### Sprint 7: in-context compaction block (`agentic-loop.ts:503-546`)
**Connection:** the post-response abort check (edit 3) sits BEFORE this block, so an aborted
turn skips compaction entirely (recommended — no wasted summarizer call).

### Sprint 8: streaming branch + shared `normalizeResponse` (`anthropic.ts`)
**Provides:** `create` (non-stream, :383) and `stream` (:389) branches sharing one
`requestBody` (:363-378) and `normalizeResponse` (:23). The stream loop deliberately lets
mid-stream errors propagate (:399-401).
**Connection:** forward `signal` into BOTH branches' 2nd options arg; the SDK cancels either
an in-flight `create` or `stream`, and the propagating abort error reaches `chatWithRetry`.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **Provider-agnostic interfaces** — SDK types stay in adapters; `types.ts` uses only
  provider-agnostic / web-standard types. `AbortSignal` qualifies.
- **Type safety (strict)** — zero type errors is a hard gate; `noUnusedParameters` etc. If an
  adapter ignores `abortSignal`, it needs no reference (it doesn't destructure it) so no
  unused-var issue. `use type imports` — `AbortSignal` is a global value/type, no import.
- **ESM everywhere** — `.js` import extensions; tests import via `./agentic-loop.js`.
- **Tests collocated** (`*.test.ts` next to source).

### Architecture Decisions
- `arch-20260709-agent-sdk-agent-loop-harness-adr-4.md` + `-architecture.md:287,341,346`:
  graceful-break-with-`stopReason` (NEVER throw) is the established convention, mirroring
  `max_turns_exceeded`/`budget_exceeded`. `-architecture.md:346` explicitly notes new
  `stopReason` values are low-risk because `StopReason` is already `| string` and no external
  code switches on it — so `"aborted"` needs no type change and breaks no consumer.
- No dedicated abort ADR exists — this sprint extends the same graceful-partial-return pattern.

### Other Docs
- `README.md` / `CLAUDE.md`: no abort-specific guidance. Build = `npm run build`, typecheck =
  `npm run typecheck`, tests = `npx vitest run` (Vitest).

---

## 6. Testing Patterns

### Unit Test Pattern — the loop (`src/orchestrator/agentic-loop.test.ts`)
**Runner:** Vitest. **Assertion:** `expect`. **Mock:** hand-rolled fake `LLMClient` classes.
**File naming/location:** collocated `agentic-loop.test.ts`.

`ScriptedLoopClient` (lines 22-34) — records `callCount` + `lastParams`, returns scripted
responses in order:
```ts
class ScriptedLoopClient implements LLMClient {
  private idx = 0;
  callCount = 0;
  lastParams?: ChatParams;
  constructor(private readonly responses: ChatResponse[]) {}
  async chat(params: ChatParams): Promise<ChatResponse> {
    this.callCount += 1;
    this.lastParams = params;
    const r = this.responses[Math.min(this.idx, this.responses.length - 1)];
    this.idx += 1;
    return r;
  }
}
const base = { toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };  // :36
```

`HookedLoopClient` (lines 847-860) — runs `onBeforeCall(callIndex)` BEFORE resolving each
`chat()`. This is the KEY tool for firing an `AbortController` deterministically between
turns (the loop only reaches call N+1 after turn N's full body + persistSession):
```ts
class HookedLoopClient implements LLMClient {
  private idx = 0;
  constructor(private readonly responses: ChatResponse[],
              private readonly onBeforeCall: (callIndex: number) => Promise<void> | void) {}
  async chat(params: ChatParams): Promise<ChatResponse> {
    await this.onBeforeCall(this.idx);
    const r = this.responses[Math.min(this.idx, this.responses.length - 1)];
    this.idx += 1; void params; return r;
  }
}
```

Budget test as the template for asserting `callCount` + `turnsUsed` + `stopReason`
(lines 205-223): `expect(result.stopReason).toBe("budget_exceeded"); expect(result.turnsUsed).toBe(2); expect(client.callCount).toBe(2);`

**Test recipes for this sprint:**

1. **sc-9-1 — abort BETWEEN turns, no further chat call.** 3-turn script (tool_use, tool_use,
   end). Use `HookedLoopClient` with `onBeforeCall((i)=>{ if (i===1) controller.abort(); })`
   OR fire `controller.abort()` inside the tool handler of turn 1. Assert
   `result.stopReason === "aborted"`, `result.turnsUsed === 1`, and `client.callCount === 1`
   (NO 2nd chat call — the boundary check fires first).

2. **sc-9-2 — abort mid-flight, no retry.** A fake client whose `chat()` rejects with an
   abort error WHEN its `params.abortSignal` fires:
   ```ts
   class AbortingClient implements LLMClient {
     callCount = 0;
     async chat(params: ChatParams): Promise<ChatResponse> {
       this.callCount += 1;
       return new Promise((_res, rej) => {
         params.abortSignal?.addEventListener("abort", () => {
           const e = new Error("Request was aborted."); e.name = "AbortError"; rej(e);
         });
       });
     }
   }
   // fire the abort after the call starts:
   const controller = new AbortController();
   setTimeout(() => controller.abort(), 5);
   const result = await runAgenticLoop({ ...params, abortSignal: controller.signal });
   expect(result.stopReason).toBe("aborted");
   expect(client.callCount).toBe(1);   // NOT retried (chatWithRetry rethrew immediately)
   ```
   Also assert `onStop`/result event fired once (sc-9-3): register `hooks.onStop` and count.

3. **sc-9-3 — accumulated partials.** Turn-1 response carries `usage:{inputTokens:10,outputTokens:20}`
   (+ optional `costUsd`), abort during turn 2. Assert `result.usage` equals turn-1 totals and
   `result.costUsd` equals turn-1 cost, and `onStop` called exactly once.

4. **sc-9-4 — degraded (non-cancellable) adapter.** A fake client that IGNORES the signal and
   returns a tool_use response normally, but the signal was aborted during the request:
   ```ts
   class IgnoresSignalClient implements LLMClient {  // never reads abortSignal
     async chat(): Promise<ChatResponse> {
       controller.abort();                            // simulate abort during the request
       return { ...base, text: "", stopReason: "tool_use",
                toolCalls: [{ id: "t1", name: "noop", input: {} }] };
     }
   }
   // handler MUST record whether it ran:
   let ran = false;
   const handlers = new Map([["noop", async () => { ran = true; return { output: "x", isError: false }; }]]);
   const result = await runAgenticLoop({ ...params, client, toolHandlers: handlers, abortSignal: controller.signal });
   expect(result.stopReason).toBe("aborted");
   expect(ran).toBe(false);            // the post-response check ran BEFORE the tool batch
   ```
   This proves the post-response check (edit 3) is placed BEFORE `executeToolBatch`
   (agentic-loop.ts:690) — the response's tool calls are NOT executed.

5. **sc-9-5 — byte-identical paired run.** Run the loop twice on the same script — once with
   NO `abortSignal`, once with a fresh never-fired `new AbortController().signal` — and
   `expect(withSignal).toEqual(withoutSignal)`. Follow the existing paired-run pattern at
   `agentic-loop.test.ts:832` (`expect(withHooks).toEqual(withoutHooks)`).

### Unit Test Pattern — the adapter (`src/providers/anthropic.test.ts`)
Top-level `vi.mock("@anthropic-ai/sdk")` returning `{ default: FakeAnthropic }` whose
`messages = { create: createMock, stream: streamMock }` (lines 24-36). `createMock`/`streamMock`
capture args: **body is `.calls[0][0]`, options (signal) is `.calls[0][1]`.**
```ts
// anthropic.test.ts:24-36 mock setup + helpers fakeResponse():43, fakeStream():56, erroringStream():74
```
**Recipes:**
- Non-stream forwards signal: call `adapter.chat({ ...params, abortSignal: c.signal })`, then
  `expect((createMock.mock.calls[0][1] as { signal?: AbortSignal }).signal).toBe(c.signal);`
- Stream forwards signal: set `onTextDelta`, `streamMock.mockReturnValue(fakeStream([...], finalMsg))`,
  assert `streamMock.mock.calls[0][1].signal === c.signal`.
- No signal ⇒ options undefined: `expect(createMock.mock.calls[0][1]).toBeUndefined();`
- Mid-stream abort propagates (mirror sc-8-5 at :682-694): `streamMock.mockReturnValue(erroringStream("Request was aborted."))`
  and `await expect(adapter.chat(...)).rejects.toThrow("Request was aborted.")` (NOT swallowed).
- Keep the body-identity invariant (:715): signal must NOT be in `requestBody`, only in the
  2nd arg — re-assert `streamMock.mock.calls[0][0]` deep-equals `createMock.mock.calls[0][0]`.

### E2E Test Pattern
Not applicable — pure loop/adapter unit sprint (no Playwright/UI surface).

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/orchestrator/agentic-loop.test.ts` | `agentic-loop.ts` | medium | 1544 lines of existing loop behavior; all must stay green (esp. budget/error/refusal/session/compaction paths). New edits are additive-guarded on `abortSignal?.aborted`. |
| `src/providers/anthropic.test.ts` | `anthropic.ts` | medium | Streaming/create body-identity (:715) + all sprint-8 tests must pass; signal goes in 2nd arg only. |
| `src/providers/openai.ts`, `google.ts`, `claude-code` adapters | `types.ts` `ChatParams` | low | They receive the new optional field and structurally ignore it (don't destructure it). No edit needed; verify typecheck (`noUnusedParameters` won't fire — no new param). |
| `src/orchestrator/pipeline.ts` + role runners (generator/curator/…) | `AgenticLoopParams` | low | None pass `abortSignal` today ⇒ unaffected (sc-9-5). |
| `src/providers/factory.ts` | adapters | low | Constructs adapters; no signature change to the `LLMClient.chat` shape (added field is optional). |

### Existing Tests That Must Still Pass
- `src/orchestrator/agentic-loop.test.ts` — refusal (sc-1), budget+cost (sc-3, :180-300),
  parallel tools (sc-4), events/hooks (sc-5), session/resume/fork (sc-6), compaction (sc-7).
  These exercise every stop path the aborted path sits alongside; verify none regress.
- `src/providers/anthropic.test.ts` — prompt caching (C1-C3), structured output, documents,
  streaming (sc-8, :576-716). The body-identity test (:715) is the tripwire for putting signal
  in the body by mistake.
- Full suite baseline is **3859 green** (per orchestrator context) — must remain green (sc-9-5).

### Features That Could Be Affected
- **Streaming (sprint 8)** — shares the `create`/`stream` call sites you edit. Verify text-delta
  behavior and mid-stream error propagation are unchanged when no signal is present.
- **Budget / max-turns / error / refusal graceful returns** — the aborted return is a NEW
  sibling exit; ensure it doesn't reorder or shadow them (abort checks are guarded on
  `abortSignal?.aborted`, so absent-signal runs never enter them).

### Recommended Regression Checks (runnable)
1. `npm run build` — clean tsc output (sc-9-6).
2. `npm run typecheck` — zero type errors (sc-9-6).
3. `npx vitest run src/orchestrator/agentic-loop.test.ts src/providers/anthropic.test.ts` — targeted.
4. `npx vitest run` — FULL suite green (sc-9-5), expect ~3859+ passing.
5. Manual grep sanity: `grep -n "stopReason: \"aborted\"" src/orchestrator/agentic-loop.ts` returns
   the 3 abort exits (boundary, post-response, chat-catch) all via `abortedResult`/`finish`.

---

## 8. Implementation Sequence (dependency-ordered)

1. **`src/providers/types.ts`** — add `abortSignal?: AbortSignal` to `ChatParams` (after
   `onTextDelta`, ~:218). Optionally extend `StopReason` JSDoc to mention `"aborted"`.
   - Verify: `npm run typecheck` clean; no adapter breaks (optional field).
2. **`src/providers/anthropic.ts`** — build `requestOptions = params.abortSignal ? { signal }
   : undefined`; pass as 2nd arg to `create` (:383) and `stream` (:389). Leave `requestBody`
   untouched.
   - Verify: `npx vitest run src/providers/anthropic.test.ts` (esp. body-identity :715, sc-8-5).
3. **`src/orchestrator/agentic-loop.ts`** — in order:
   a. `export class AbortedError extends Error` at module scope (near :172).
   b. `abortSignal?` on `AgenticLoopParams` (~:130) + destructure (:331-354).
   c. `abortedResult(turnsUsed)` local helper near `finish` (:414).
   d. Special-case abort at TOP of `chatWithRetry` catch (:212) → `throw new AbortedError()`.
   e. Top-of-turn boundary check (:429).
   f. Post-response pre-tool check (after :479, before :481).
   g. Thread `abortSignal` into the chat-params object (:450-460).
   h. Branch the chat catch (:462) → abort → `finish(abortedResult(turn-1))`.
   - Verify: `npx vitest run src/orchestrator/agentic-loop.test.ts`.
4. **`src/providers/anthropic.test.ts`** — add signal-forwarding + undefined-options + mid-stream
   abort-propagation tests.
   - Verify: adapter test green.
5. **`src/orchestrator/agentic-loop.test.ts`** — add sc-9-1..sc-9-5 tests (recipes in §6).
   - Verify: loop test green.
6. **Run full verification** — `npm run build`, `npm run typecheck`, `npx vitest run` (full suite).

---

## 9. Pitfalls & Warnings

- **`err.name` is NOT `"AbortError"` for the real SDK abort.** `APIUserAbortError` inherits
  `Error`'s name (`"Error"`); message is `"Request was aborted."` (`@anthropic-ai/sdk/core/error.js:70-74`).
  Detect aborts via `params.abortSignal?.aborted` (primary); `err.name === "AbortError"` is only a
  secondary guard for raw fetch/DOMException and test mocks. Relying on name alone silently
  fails the mid-flight case (sc-9-2).
- **The abort option key is `signal`, not `abortSignal`.** `RequestOptions.signal`
  (`internal/request-options.d.ts:56`). Pass `{ signal: params.abortSignal }`.
- **Signal goes in the 2nd (options) arg, NEVER the request body.** Putting it in `requestBody`
  breaks the create/stream body-identity invariant (`anthropic.test.ts:715`) and would be sent
  over the wire.
- **The post-response check (edit 3) MUST sit before usage accumulation (:481) AND before
  `executeToolBatch` (:690).** If placed after tool execution, sc-9-4 fails (the degraded
  adapter's tool calls would run). Placing it right after the chat try/catch also naturally
  skips compaction (:503) and budget (:548) for the aborted turn.
- **Never throw on abort.** The loop's contract is graceful partial return; an abort resolves
  with `stopReason:"aborted"`, mirroring `budget_exceeded`. A rejected promise fails
  sc-9-1/9-2 and the "never a throw" definitionOfDone. `chatWithRetry` DOES throw `AbortedError`,
  but the loop CATCHES it and finishes — the throw never escapes `runAgenticLoop`.
- **`chatWithRetry` must not retry aborts.** Put the abort check as the FIRST statement in the
  catch, BEFORE `isTransientError`. (Note: `"Request was aborted."` matches no transient pattern,
  so it wouldn't be retried anyway — but it WOULD route to `stopReason:"error"` without the
  explicit `AbortedError` branch. The branch is what makes it `"aborted"`.)
- **turnsUsed on abort = `turn - 1`** at all three abort exits (mirrors the existing error
  catch at :467, which uses `turn - 1`). The budget path uses `turn` because its response was
  fully processed; the aborted turn is NOT counted as completed.
- **Keep byte-identical spreads.** Add `abortSignal` to the loop's chat-params object and the
  adapter's options ONLY when defined (spread-guard), so the no-signal path is unchanged (sc-9-5).
- **Other adapters need NO code change.** They don't destructure `abortSignal`, so `noUnusedParameters`
  won't fire. A one-line "ignored" comment is optional, not required. (Only `anthropic.ts` is in
  `estimatedFiles`.)
- **Do NOT wire chat `/pause`, telegram, or claude-code CLI cancellation** — explicit nonGoals.
  This sprint is the loop + Anthropic adapter surface only.
