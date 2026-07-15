# Sprint Briefing: In-context auto-compaction (threshold-triggered summarization + compact-boundary event)

**Contract:** sprint-spec-20260709-agent-loop-capability-port-7
**Generated:** 2026-07-10T00:00:00Z

---

## 0. TL;DR — the 7 design decisions this sprint hinges on (ambiguity 5)

All resolved below with evidence. Read this first.

1. **Trigger = PER-REQUEST `response.usage.inputTokens`, NOT the cumulative `totalInputTokens`.** The contract prose says "cumulative"; the `generatorNotes` and the anti-thrash guarantee override it. `ChatResponse.usage.inputTokens` is documented as "Token usage for this request" (`src/providers/types.ts:233-237`). Only a per-request trigger lets a shrunken prompt reset the trigger. Using the running total would re-fire every turn = thrash. **Decision (c) resolved.**
2. **Insertion point = between `agentic-loop.ts:454` and `:455`** — right after the per-turn budget charge (`budget?.chargeUsd(...)`), BEFORE the `if (budget?.exceeded())` gate. This makes the summarizer's charge land in the SAME turn's `exceeded()` check "naturally" (contract 3e). **Decision (e-budget) resolved.**
3. **A "turn" = an AssistantMessage(+toolCalls) + ToolResultMessage PAIR = 2 messages.** Tail to keep verbatim = last `keepRecentTurns * 2` messages (default `2*2 = 4`). Head = everything before that. **Decision (a) resolved.**
4. **Summary message = a plain user-role `TextMessage`: `{ role: "user", content: "[Conversation summary] " + summaryText }`.** Verified valid mid-conversation for every adapter (Anthropic `src/providers/anthropic.ts:134-137`, OpenAI/openai-compat `src/providers/openai.ts:221-228`). **Decision (b) resolved.**
5. **The summarizer call passes NO tools and a bounded `maxTokens` (recommend 4096).** Do NOT forward `tools`, `effort`, `responseSchema`. Mirrors the existing one-shot `coerceJsonOutput` precedent (`agentic-loop.ts:244-288`). **Decision (d) resolved.**
6. **The summarizer emits ONLY the `compact-boundary` event** — no `tool-start/tool-end/turn-*` events. It is a direct `client.chat` call outside the turn machinery, so it emits nothing unless you explicitly `safeEmit`. **Decision (e-events) resolved.**
7. **Feed the summarizer a SERIALIZED transcript, not the raw head messages.** The head contains `tool_use`/`tool_result` blocks; the main loop only ever sends those WITH `tools` (`agentic-loop.ts:416`). Sending them to a no-tools chat risks a provider 400. Render the head to one plain-text user message instead. **Decision (b-extended) resolved.**

---

## 1. Target Files

### src/orchestrator/loop-events.ts (modify)

The `compact-boundary` type is RESERVED **by comment only** — you must add the real union member. Note the reserved comment shows a 2-field shape `{ type, turn }`, but **sc-7-2 requires three payload fields** — you must add them.

**Relevant sections (lines 26-42):**
```typescript
/**
 * ...
 * `compact-boundary` (sprint 7) and `text-delta` (sprint 8) type names are
 * RESERVED via this comment only — do NOT emit them this sprint:
 *   | { type: "compact-boundary"; turn: number }
 *   | { type: "text-delta"; turn: number; delta: string }
 */
export type LoopEvent =
  | { type: "init"; model: string; maxTurns: number }
  | { type: "turn-start"; turn: number }
  | { type: "tool-start"; turn: number; name: string; input: unknown; toolUseId: string }
  | { type: "tool-end"; turn: number; name: string; toolUseId: string; isError: boolean }
  | { type: "turn-end"; turn: number; toolsCalled: string[] }
  | { type: "result"; stopReason: string; turnsUsed: number };
```
**Change:** append a new member (keep `turn` for consistency with every other event; add the three sc-7-2 fields):
```typescript
  | { type: "compact-boundary"; turn: number; messagesBefore: number; messagesAfter: number; inputTokensAtTrigger: number }
```
Update the RESERVED comment so it only still reserves `text-delta` (leave sprint 8 alone).

**Imported by:** `src/orchestrator/agentic-loop.ts:14`, and 8 role agents re-export/consume `LoopEvent`. Additive union member → all existing consumers stay valid (they exhaustively switch or push into `LoopEvent[]`).

**Test file:** none dedicated — `LoopEvent` is exercised via `src/orchestrator/agentic-loop.test.ts:514-565`.

---

### src/orchestrator/compaction.ts (create)

**Directory pattern:** siblings in `src/orchestrator/` are kebab-case single-purpose modules (`loop-events.ts`, `session-store.ts`, `context-handoff.ts`). Section headers use `// -- Name ----` unicode box-drawing (principles.md).
**Most similar existing precedent:** the `coerceJsonOutput` one-shot chat helper at `src/orchestrator/agentic-loop.ts:244-288` — builds a synthetic `Message[]`, calls the client with a purpose-specific system prompt and NO tools, returns the text. Copy that shape.

**Structure template (recommended):**
```typescript
import type { LLMClient, Message, TextMessage } from "../providers/types.js";
import { logger } from "../utils/logger.js";

// -- Types --------------------------------------------------------------
export interface CompactionParams {
  client: LLMClient;
  model: string;
  /** The HEAD messages being summarized away (older, completed turns). */
  head: Message[];
  /** Optional caller steering appended to the base summarization prompt. */
  instructions?: string;
  /** Bounded output cap for the summary. Default 4096. */
  maxTokens?: number;
}

export interface CompactionOutcome {
  /** The single replacement message: { role:"user", content:"[Conversation summary] ..." }. */
  summaryMessage: Message;
  usage: { inputTokens: number; outputTokens: number };
  costUsd?: number;
}

const SUMMARY_SYSTEM =
  "Summarize this conversation preserving: task objective, file paths touched, " +
  "decisions made, errors seen. Be concise and factual.";

// -- Serialize head so we never send tool_use/tool_result blocks without tools --
function renderTranscript(messages: Message[]): string {
  return messages
    .map((m) => {
      if ("toolResults" in m) return `[tool results] ${m.toolResults.map((r) => r.content).join("\n")}`;
      if ("toolCalls" in m && m.toolCalls.length > 0)
        return `[assistant] ${m.content}\n[tool calls] ${m.toolCalls.map((c) => c.name).join(", ")}`;
      if ("systemUpdate" in m) return `[system update] ${m.systemUpdate}`;
      return `[${m.role}] ${(m as TextMessage).content}`;
    })
    .join("\n\n");
}

// -- Pure helper: one summarization chat, fail-open --------------------
export async function summarizeMessages(
  params: CompactionParams,
): Promise<CompactionOutcome | undefined> {
  const { client, model, head, instructions, maxTokens = 4096 } = params;
  const system = instructions ? `${SUMMARY_SYSTEM}\n\n${instructions}` : SUMMARY_SYSTEM;
  const messages: Message[] = [{ role: "user", content: renderTranscript(head) }];
  try {
    const res = await client.chat({ model, system, messages, maxTokens });
    const summaryMessage: Message = {
      role: "user",
      content: `[Conversation summary] ${res.text}`,
    };
    return {
      summaryMessage,
      usage: res.usage,
      ...(res.costUsd !== undefined ? { costUsd: res.costUsd } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`Compaction summarization failed (skipped, continuing uncompacted): ${message}`);
    return undefined; // fail-open (sc-7-4)
  }
}
```
> NOTE: The contract's suggested signature `summarizeMessages(...) -> Promise<Message | undefined>` OMITS usage — but **sc-7-3 mandates charging the call's usage/costUsd**, so the return MUST carry usage. Use the richer `CompactionOutcome` above. Do NOT return a bare `Message`.

**Test file:** `src/orchestrator/compaction.test.ts` (create — see §6).

---

### src/orchestrator/agentic-loop.ts (modify)

Four edits, all additive & gated on `compaction` being set (byte-identical when absent — sc-7-5).

**(A) Extend `AgenticLoopParams`** (interface at lines 22-108; add near the `session`/`initialMessages` fields ~line 107):
```typescript
  /**
   * Opt-in in-context auto-compaction (sprint 7). When set and a turn's
   * response.usage.inputTokens exceeds maxContextTokens, the loop summarizes
   * older messages via ONE extra client.chat call, replacing the head with a
   * single summary message and keeping the last keepRecentTurns*2 messages
   * verbatim. Absent (the default) => never compacts, byte-identical.
   */
  compaction?: { maxContextTokens: number; keepRecentTurns?: number; instructions?: string };
```

**(B) Destructure it** in the `const { ... } = params;` block (lines 308-329): add `compaction,`.

**(C) Insert the compaction block between line 454 and line 455** (after the per-turn budget charge, BEFORE the `exceeded()` gate). Current code:
```typescript
    budget?.chargeTokens(response.usage);
    budget?.chargeUsd(response.costUsd ?? 0);
    // <<< INSERT COMPACTION BLOCK HERE >>>
    if (budget?.exceeded()) {
```
Insert (recommended — guard on `stopReason === "tool_use"` so the final completion turn never pays for a useless summarization):
```typescript
    // In-context auto-compaction (sprint 7). Trigger on the PER-REQUEST prompt
    // size (response.usage.inputTokens), never the running total — a shrunken
    // prompt then naturally resets the trigger (anti-thrash). Only when the loop
    // will make another request (tool_use) is compaction worthwhile.
    if (
      compaction &&
      response.stopReason === "tool_use" &&
      response.usage.inputTokens > compaction.maxContextTokens
    ) {
      const keep = (compaction.keepRecentTurns ?? 2) * 2;
      if (messages.length > keep) {
        const head = messages.slice(0, messages.length - keep);
        const outcome = await summarizeMessages({
          client,
          model,
          head,
          instructions: compaction.instructions,
        });
        if (outcome) {
          const before = messages.length;
          // Replace the head in place with the single summary; splice keeps the
          // tail's object identity so recent turns stay deep-equal (sc-7-1).
          messages.splice(0, head.length, outcome.summaryMessage);
          // Charge the extra call to BOTH result totals and Budget (sc-7-3).
          totalInputTokens += outcome.usage.inputTokens;
          totalOutputTokens += outcome.usage.outputTokens;
          if (outcome.costUsd !== undefined) {
            totalCostUsd = (totalCostUsd ?? 0) + outcome.costUsd;
          }
          budget?.chargeTokens(outcome.usage);
          budget?.chargeUsd(outcome.costUsd ?? 0);
          safeEmit({
            type: "compact-boundary",
            turn,
            messagesBefore: before,
            messagesAfter: messages.length,
            inputTokensAtTrigger: response.usage.inputTokens,
          });
        }
      }
    }
    if (budget?.exceeded()) {
```
Because this runs BEFORE `exceeded()`, a summarizer charge that crosses the ceiling is caught by the *existing* post-turn `exceeded()` gate (lines 455-471) with no new exit path (contract 3e satisfied). On `outcome === undefined` (summarizer threw) nothing changes → fail-open (sc-7-4).

**(D) Add the import** near the top (after line 18):
```typescript
import { summarizeMessages } from "./compaction.js";
```

**Imports this file already uses (relevant):** `Message`, `AssistantMessage`, `ToolResultMessage`, `LLMClient` from `../providers/types.js:1-9`; `Budget` from `./workflow/budget.js:13`; `LoopEvent` from `./loop-events.js:14`; `logger` from `../utils/logger.js:17`.

**Imported by (callers of `runAgenticLoop`):** `src/index.ts`, `src/orchestrator/{generator,curator,evaluator,planner,architect,documenter,code-reviewer,research}-agent.ts`, `src/orchestrator/pipeline.ts`. None pass `compaction` today → all stay byte-identical.

**Test file:** `src/orchestrator/agentic-loop.test.ts` (exists, 1132 lines).

---

## 2. Patterns to Follow

### Per-turn usage + cost accumulation (the accumulators to also charge for the summarizer)
**Source:** `src/orchestrator/agentic-loop.ts`, lines 441-454
```typescript
    totalInputTokens += response.usage.inputTokens;
    totalOutputTokens += response.usage.outputTokens;
    if (response.costUsd !== undefined) {
      totalCostUsd = (totalCostUsd ?? 0) + response.costUsd;
    }
    budget?.chargeTokens(response.usage);
    budget?.chargeUsd(response.costUsd ?? 0);
```
**Rule:** Charge the summarizer's `outcome.usage`/`outcome.costUsd` to these SAME four accumulators (`totalInputTokens`, `totalOutputTokens`, `totalCostUsd`, `budget`) with the identical `costUsd !== undefined` guard so cost-free runs keep omitting the `costUsd` key.

### One-shot purpose-specific chat with NO tools (the summarizer-call precedent)
**Source:** `src/orchestrator/agentic-loop.ts`, lines 257-269 (inside `coerceJsonOutput`)
```typescript
  const messages: Message[] = [
    { role: "user", content: userMessage },
    { role: "assistant", content: priorText || "(no output produced)" },
    { role: "user", content: instruction },
  ];
  ...
    const response = await chatWithRetry(
      client,
      { model, system: systemPrompt, messages, jsonObjectMode: true, maxTokens },
      0,
    );
    return response.text;
```
**Rule:** Build a fresh `Message[]`, pass a dedicated `system` prompt, no `tools`, a bounded `maxTokens`, read `response.text`. Your `summarizeMessages` does exactly this (use `client.chat` directly — `chatWithRetry` is module-private and NOT importable into `compaction.ts`).

### safeEmit — the ONLY way to emit events (respects onEvent-absent + swallows throws)
**Source:** `src/orchestrator/agentic-loop.ts`, lines 377-385
```typescript
  const safeEmit = (event: LoopEvent): void => {
    if (!onEvent) return;
    try { onEvent(event); }
    catch (err) { logger.warn(`onEvent hook threw (swallowed): ${message}`); }
  };
```
**Rule:** Emit `compact-boundary` via `safeEmit(...)`, never by calling `onEvent` directly. This makes sc-7-2's "compaction still works when onEvent is absent" automatic.

### System prompt is a SEPARATE ChatParams field — never in `messages`
**Source:** `src/orchestrator/agentic-loop.ts`, lines 410-421 (`system: systemPrompt`)
**Rule:** The run's `systemPrompt` is never a member of the `messages` array (`src/providers/types.ts:146-152` — `ChatParams.system` is its own field). Compaction operates ONLY on `messages`; it can never touch or drop the system prompt (contract nonGoal satisfied for free).

### Absent-config byte-identical (the sprint-5/6 gating idiom)
**Source:** `src/orchestrator/agentic-loop.ts`, lines 355-373 (`persistSession` no-ops when `!session`)
**Rule:** Gate the entire compaction block on `if (compaction && ...)`. No `compaction` => the block is skipped, no extra `client.chat`, no `safeEmit` — byte-identical (sc-7-5).

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `Budget.chargeTokens` | `src/orchestrator/workflow/budget.ts:49-52` | `(usage: TokenUsage): void` | Adds input+output tokens to the budget. Call for the summarizer usage. |
| `Budget.chargeUsd` | `src/orchestrator/workflow/budget.ts:65-68` | `(usd: number): void` | Adds a USD charge; no-op on non-finite/negative. Call for the summarizer cost. |
| `Budget.exceeded` | `src/orchestrator/workflow/budget.ts:107-113` | `(): boolean` | True once any ceiling is hit. The EXISTING post-turn check (`agentic-loop.ts:455`) that naturally catches the summarizer charge. |
| `safeEmit` (loop-local) | `src/orchestrator/agentic-loop.ts:377-385` | `(event: LoopEvent): void` | The only sanctioned event emitter; already respects `onEvent` absence + swallows throws. |
| `logger.warn` | `src/utils/logger.ts` (imported `agentic-loop.ts:17`) | `(msg: string): void` | The "existing logger" for the fail-open skip message (contract sc-7-4). |
| `coerceJsonOutput` | `src/orchestrator/agentic-loop.ts:244-288` | one-shot no-tools chat | STRUCTURAL PRECEDENT for the summarizer call — do not import it, copy the shape. |
| `summarizeOlderSprints` | `src/orchestrator/context-handoff.ts:153` | `(handoff, keepRecent): ContextHandoff` | DIFFERENT layer — operates on `ContextHandoff`/`SprintContract` JSON, NOT `Message[]`. ZERO overlap. Do not touch, do not reuse. |

Utilities reviewed: `src/utils/` (`logger`, `fs`, `git`), `src/orchestrator/workflow/budget.ts`, `src/orchestrator/context-handoff.ts` — the four Budget/emit/logger entries above are the only ones this sprint needs.

---

## 4. Prior Sprint Output (dependsOn: sprint 5; also builds on 3 & 6)

### Sprint 5: LoopEvent union + safeEmit + hooks
**Created/owns:** `src/orchestrator/loop-events.ts` — exports `LoopEvent` (union), `LoopHooks`, `HookDecision`, `LoopToolCallInfo`; the `compact-boundary` type name is RESERVED-by-comment (lines 30-34).
**Connection:** This is the HARD `dependsOn`. You implement the reserved member and emit it via the sprint-5 `safeEmit` (`agentic-loop.ts:377-385`). The single-`finish()` exit and `onEvent`-absent behavior are already in place.

### Sprint 3: per-turn usage accumulation + Budget charging
**Landed in:** `agentic-loop.ts:441-471` — the accumulators (`totalInputTokens`/`totalOutputTokens`/`totalCostUsd`) + `budget?.chargeTokens/chargeUsd` + the graceful `exceeded()` return (`stopReason: "budget_exceeded"`).
**Connection:** sc-7-3 requires charging the summarizer to these exact accumulators + Budget; your insertion point sits directly in this block (between :454 and :455).

### Sprint 6: session persistence
**Landed in:** `agentic-loop.ts:355-373` (`persistSession`), called at every turn boundary (e.g. :619 in the tool_use path).
**Connection (expected behavior to DOCUMENT, not fix):** compaction mutates `messages` in place (splice), so the next `persistSession(turn)` at :619 persists the **compacted** array. This is intended — the session captures the live transcript. No pre-compaction snapshot is required (contract outOfScope).

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **Provider-agnostic interfaces.** All LLM interaction goes through `providers/types.ts`; never leak SDK types. Your summary message uses the own `Message` union only.
- **ESM everywhere** — import `./compaction.js` with the `.js` extension (NodeNext).
- **`import type { ... }`** enforced (`consistent-type-imports`). Import `Message`/`LLMClient`/`TextMessage` as `import type`.
- **Section comments** `// -- Name ----` (unicode box-drawing) for long files.
- **Prefix unused params with `_`.** Strict flags (`noUnusedLocals`/`noUnusedParameters`) are a hard gate.
- **Tests collocated** `*.test.ts` next to source; Vitest.

### Architecture Decisions (`.bober/architecture/arch-20260709-agent-sdk-agent-loop-harness-architecture.md`)
- Capability audit row 6 (line 51): "Context mgmt (auto-compaction... ) — PARTIAL — Own coarse `summarizeOlderSprints` + `contextReset:"always"`; **no in-context compaction**." This sprint fills exactly that gap. The two layers are intentionally separate (contract nonGoal #1).
- Line 24: context is currently bounded per-sprint by `contextReset:"always"` + `summarizeOlderSprints` (`pipeline.ts:291`) — NOT SDK compaction. Confirms zero overlap with your in-run layer.

### Other Docs
- No dedicated compaction ADR (ADR-1..5 exist but none cover compaction — checked). The `generatorNotes`/`evaluatorNotes` in the contract ARE the spec for the ambiguous points; §0 above resolves them.

---

## 6. Testing Patterns

### Unit Test Pattern (Vitest, collocated)
**Source:** `src/orchestrator/agentic-loop.test.ts` — `ScriptedLoopClient` (lines 22-34) is the workhorse. It records `callCount` and `lastParams`, returns scripted responses in order, and REPEATS the last once exhausted.
```typescript
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
const base = { toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
```
**Runner:** vitest. **Assertion style:** `expect(...)`. **Mock approach:** `vi.spyOn` on the Budget (no `vi.mock`). **File naming:** `*.test.ts` collocated. **Import specifiers use `.js`** (`import { runAgenticLoop } from "./agentic-loop.js"`).

**Recognizing the summarizer call by system prompt (per evaluatorNotes):** because the loop calls `client.chat` once per turn PLUS once for the summarizer, script a client that branches on `params.system`. Recommended test-local client:
```typescript
class CompactionClient implements LLMClient {
  chats: ChatParams[] = [];
  summarizerCalls = 0;
  async chat(params: ChatParams): Promise<ChatResponse> {
    this.chats.push(params);
    if (params.system.startsWith("Summarize this conversation")) {
      this.summarizerCalls += 1;
      return { text: "SUMMARY", toolCalls: [], stopReason: "end",
               usage: { inputTokens: 5, outputTokens: 7 }, costUsd: 0.02 };
    }
    // escalating prompt size: turn 3 crosses the threshold
    const turn = this.chats.filter((c) => c.system === params.system).length;
    return { text: "", toolCalls: [{ id: `t${turn}`, name: "noop", input: {} }],
             stopReason: "tool_use",
             usage: { inputTokens: turn >= 3 ? 100000 : 10, outputTokens: 1 } };
  }
}
```

**Escalating-usage + threshold pattern (drives sc-7-1):** set `compaction: { maxContextTokens: 50000, keepRecentTurns: 2 }`, make the client report a small `inputTokens` for turns 1-2 then a large one (e.g. 100000) on turn 3 so it crosses. Assert: `summarizerCalls === 1`, and the messages sent on the NEXT chat (`client.chats[i].messages`) begin with exactly one `{ role: "user", content: "[Conversation summary] SUMMARY" }` followed by the deep-equal preserved tail.

**Budget spy pattern (sc-7-3):**
**Source:** `src/orchestrator/agentic-loop.test.ts:202-203`
```typescript
    const budget = new Budget({ maxUsd: 1.0 });
    const assertSpy = vi.spyOn(budget, "assertWithinBudget");
    // ... run ...
    expect(assertSpy).not.toHaveBeenCalled();
    expect(result.costUsd).toBe(1.2);
```
For sc-7-3, `vi.spyOn(budget, "chargeUsd")` / `chargeTokens` and assert they were called with the summarizer's usage/cost, and that `result.usage.inputTokens` / `result.costUsd` include the summarizer's contribution.

**Event collection pattern (sc-7-2):**
**Source:** `src/orchestrator/agentic-loop.test.ts:516-560`
```typescript
    const events: LoopEvent[] = [];
    await runAgenticLoop({ /* ... */ onEvent: (e) => events.push(e) });
    expect(events.map((e) => e.type)).toEqual([ "init", "turn-start", /* ... */ ]);
    expect(events[2]).toEqual({ type: "tool-start", turn: 1, name: "noop", input: { x: 1 }, toolUseId: "t1" });
```
For sc-7-2: filter `events.filter((e) => e.type === "compact-boundary")`, assert one, assert `{ turn, messagesBefore, messagesAfter, inputTokensAtTrigger }`. Then RE-RUN identically WITHOUT `onEvent` and assert compaction still happened by inspecting `client.chats` for the summary message.

**Byte-identical / absent-config pattern (sc-7-5):**
**Source:** `src/orchestrator/agentic-loop.test.ts:802-833` — run the same script with and without the new option, `expect(withX).toEqual(withoutX)`. For sc-7-5, additionally assert `client.callCount` has NO extra summarizer call when `compaction` is absent.

**Fail-open pattern (sc-7-4):** script the summarizer branch to `throw new Error("boom")`; assert the run completes (no throw), `result.stopReason` is normal, and the messages were NOT compacted (no summary message in later `client.chats`).

### E2E Test Pattern
Not applicable — this is a pure orchestrator-internal unit (no Playwright/`e2e/` surface for the loop).

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/orchestrator/loop-events.ts` | (self, adds union member) | low | Additive union member; every consumer either switches exhaustively or pushes into `LoopEvent[]`. Verify no exhaustive `switch` elsewhere now needs a `compact-boundary` case (grep `case "result"`). |
| `src/orchestrator/{generator,curator,evaluator,planner,architect,documenter,code-reviewer,research}-agent.ts` | `runAgenticLoop` | low | None pass `compaction` → gated block skipped → byte-identical. Confirm they still typecheck against the extended `AgenticLoopParams`. |
| `src/orchestrator/pipeline.ts` | `runAgenticLoop`, `summarizeOlderSprints` | low | Uses the SEPARATE sprint-boundary layer (`:291`); untouched by in-run compaction. |
| `src/index.ts` | `runAgenticLoop`, `summarizeOlderSprints` (`:76`) | low | Public API surface — adding an optional param is backward-compatible. |

### Existing Tests That Must Still Pass
- `src/orchestrator/agentic-loop.test.ts` — the whole 1132-line suite (refusal, effort, budget, parallel-tools, events, hooks, sessions). Your changes are gated on `compaction`; every existing test omits it, so ALL must remain green unchanged (this IS sc-7-5's "full existing suite unchanged").
- `src/orchestrator/loop-events` consumers via `agentic-loop.test.ts:514-565` (event ordering) — must be unaffected: no `compaction` config means no `compact-boundary` event is ever inserted into the existing ordered-event assertions.
- Any test asserting exact `result.usage`/`result.costUsd` totals (e.g. `agentic-loop.test.ts:222,252,299`) — must be unaffected because they set no `compaction`.

### Features That Could Be Affected
- **Sprint-boundary compaction (`summarizeOlderSprints`)** — shares the word "compaction" but NOT any code/module. Verify `context-handoff.ts` and `pipeline.ts:291` are untouched (contract nonGoal #1).
- **Budget accounting (sprint 3)** — shares the `totalCostUsd`/`budget` accumulators. Verify a no-compaction run's totals are unchanged (the escalating-usage tests must not leak into non-compaction tests).

### Recommended Regression Checks
1. `npm run typecheck` — 0 errors (extended union + new param + new module).
2. `npm run build` — clean `tsc` (sc-7-6).
3. `npx vitest run src/orchestrator/agentic-loop.test.ts src/orchestrator/compaction.test.ts` — new + touched suites green.
4. `npx vitest run` — full suite still ~3832+ green (sc-7-5: no pre-existing test changes behavior).
5. Grep-verify no other exhaustive `switch (event.type)` needs a new case: `grep -rn "case \"result\"" src/`.

---

## 8. Implementation Sequence (dependency order)

1. **`src/orchestrator/loop-events.ts`** — add the `compact-boundary` union member with the three sc-7-2 payload fields; trim the RESERVED comment to `text-delta` only.
   - Verify: `npm run typecheck` still passes (additive member).
2. **`src/orchestrator/compaction.ts`** — create `summarizeMessages` (pure, no-tools one-shot chat, serialized head, `[Conversation summary]` message, fail-open `undefined` on throw, returns `CompactionOutcome` with usage).
   - Verify: file typechecks; imports use `import type` + `.js`.
3. **`src/orchestrator/compaction.test.ts`** — unit-test the helper in isolation: (a) returns a `{ role:"user", content:"[Conversation summary] ..." }` message + usage; (b) returns `undefined` when the client throws (fail-open); (c) never passes `tools` in the ChatParams it sends.
   - Verify: `npx vitest run src/orchestrator/compaction.test.ts` green.
4. **`src/orchestrator/agentic-loop.ts`** — add the `compaction?` field to `AgenticLoopParams`, destructure it, add the `import { summarizeMessages } from "./compaction.js"`, and insert the gated compaction block between lines 454 and 455 (charge totals+budget, splice head→summary, `safeEmit` compact-boundary).
   - Verify: `npm run typecheck`.
5. **`src/orchestrator/agentic-loop.test.ts`** — add sc-7-1..sc-7-5 integration tests using the escalating-usage / system-prompt-recognizing client, Budget spies, event collection, fail-open, and an absent-config byte-identical/no-extra-call assertion.
   - Verify: `npx vitest run src/orchestrator/agentic-loop.test.ts`.
6. **Run full verification** — `npm run build`, `npm run typecheck`, `npx vitest run` (full suite green, sc-7-5 + sc-7-6).

---

## 9. Pitfalls & Warnings

- **Trigger is per-request, NOT cumulative.** Use `response.usage.inputTokens`, never `totalInputTokens`. Cumulative would re-fire every turn (thrash) and break the anti-thrash guarantee. (Contract prose says "cumulative" — it is wrong; `generatorNotes` + `types.ts:233-237` win.)
- **The RESERVED comment shows only `{ type, turn }`** — but sc-7-2 needs `messagesBefore`, `messagesAfter`, `inputTokensAtTrigger`. Add all three; don't just uncomment the 2-field shape.
- **`summarizeMessages` MUST return usage**, not a bare `Message` — the contract's suggested `-> Promise<Message | undefined>` signature is under-specified vs sc-7-3. Use `CompactionOutcome`.
- **Do NOT send the raw head to a no-tools chat.** The head contains `tool_use`/`tool_result` blocks (`anthropic.ts:89-119`); the main loop only ever sends those alongside `tools` (`agentic-loop.ts:416`). Sending them without `tools` can 400 on Anthropic. Serialize to one user-text message.
- **`chatWithRetry` is module-private** in `agentic-loop.ts` — you cannot import it into `compaction.ts`. Use `client.chat` directly. A transient failure just fails-open (skip this turn's compaction), which is acceptable.
- **`messages` is `const`** (`agentic-loop.ts:338`) — you cannot reassign it. Use `messages.splice(0, head.length, summaryMessage)` to replace the head in place. Splice preserves the tail's object identity so `keepRecentTurns` survivors stay deep-equal (sc-7-1).
- **Place compaction BEFORE the `exceeded()` gate (between :454 and :455)**, not after — otherwise the summarizer charge won't be caught until the next turn, contradicting contract 3e.
- **Guard `messages.length > keep`** before slicing, or a short conversation yields an empty head (nothing to summarize) and a pointless summarizer call.
- **Never touch the system prompt.** It is `ChatParams.system` (`types.ts:146-152`), a separate field from `messages`; compaction only mutates `messages`, so the nonGoal is satisfied automatically — do not add code that references `systemPrompt` in the compaction path.
- **Emit via `safeEmit`, never `onEvent` directly** — so sc-7-2's onEvent-absent path works and a throwing consumer can't crash the loop.
- **Do NOT emit tool/turn events for the summarizer** — it is a direct `client.chat` call outside the turn machinery; emit ONLY the single `compact-boundary`.
- **Keep everything gated on `if (compaction && ...)`** so sc-7-5 (byte-identical, zero extra `client.chat`) holds — this is also what keeps the entire existing 3832-test suite green.
- **Don't confuse layers:** `summarizeOlderSprints` (`context-handoff.ts:153`) operates on `ContextHandoff`/`SprintContract` JSON, not `Message[]`. Zero overlap — do not import, extend, or modify it (contract nonGoal #1).
