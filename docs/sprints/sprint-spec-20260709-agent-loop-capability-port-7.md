# In-context auto-compaction (threshold-triggered summarization + compact-boundary event)

**Contract:** sprint-spec-20260709-agent-loop-capability-port-7  ·  **Spec:** spec-20260709-agent-loop-capability-port  ·  **Completed:** 2026-07-10

## What this sprint added

Opt-in **in-context auto-compaction** for agent-bober's own `runAgenticLoop`, so a long tool-using run
can stay inside the model's context window **without** the coarse cross-sprint handoff reset. When
`AgenticLoopParams.compaction` is set and a turn's **per-request** `response.usage.inputTokens` (the
prompt size the provider saw this turn, not a running total) crosses `maxContextTokens` on a
`tool_use` stop, the loop makes **one** extra `client.chat` summarization call — via the SAME
client/model — over the older ("head") messages, replaces that head **in place** with a single
`[Conversation summary] ...` user message while keeping the last `keepRecentTurns * 2` messages
(default `2 * 2 = 4`) **verbatim**, charges the extra call's usage/cost to both `Budget` and the
`AgenticLoopResult` totals, and emits the (now-implemented) `compact-boundary` `LoopEvent`. A failed
summarization call **fails open** — logged, skipped for that turn, run continues uncompacted, no
message ever dropped without a summary. Absent `compaction` (the default) => never compacts,
byte-identical (paired deep-equal run + full suite 3832 → 3843).

## Public surface

New pure module **`src/orchestrator/compaction.ts`** (internal — imported directly by the loop, **not**
re-exported from the `src/index.ts` barrel):

- `summarizeMessages(params)` (`src/orchestrator/compaction.ts:85`) — `Promise<CompactionOutcome | undefined>`.
  One no-`tools`, bounded-`maxTokens` (default 4096) `client.chat` call with a dedicated summarization
  system prompt (`"Summarize this conversation preserving: task objective, file paths touched,
  decisions made, errors seen..."`, plus optional caller `instructions`). Flattens the head to a plain-text
  transcript first (`renderTranscript`) so no raw `tool_use`/`tool_result` blocks are sent to a no-tools
  call. **Fails open**: any error is caught, `logger.warn`-logged, and returned as `undefined`. Never throws.
- `CompactionParams` (`src/orchestrator/compaction.ts:20`) — `{ client, model, head: Message[], instructions?, maxTokens? }`.
- `CompactionOutcome` (`src/orchestrator/compaction.ts:33`) — `{ summaryMessage: Message; usage: { inputTokens; outputTokens }; costUsd? }`.

Threaded onto the loop (`src/orchestrator/agentic-loop.ts`):

- `AgenticLoopParams.compaction?` (`src/orchestrator/agentic-loop.ts:122`) —
  `{ maxContextTokens: number; keepRecentTurns?: number; instructions?: string }`. The one opt-in knob.
  `keepRecentTurns` defaults to `2` (⇒ 4 trailing messages kept). `instructions` is appended to the base
  summarization prompt.

Now-implemented `LoopEvent` union member (`src/orchestrator/loop-events.ts:42`):

- `{ type: "compact-boundary"; turn; messagesBefore; messagesAfter; inputTokensAtTrigger }` — fires once
  per successful compaction when `onEvent` is present (compaction still happens when `onEvent` is absent).
  This was the name Sprint 5 reserved by comment; only `text-delta` (sprint 8) remains reserved.

## How to use / how it fits

Programmatic-only — nothing was added to `config/schema.ts`, and **no pipeline role auto-enables it**
(same posture as the Sprint 5 hooks and Sprint 6 sessions).

```ts
import { runAgenticLoop } from "agent-bober";

await runAgenticLoop({
  /* ...client, model, tools, handlers... */
  userMessage: "long multi-tool task",
  compaction: {
    maxContextTokens: 100_000, // trigger when a turn's prompt exceeds this
    keepRecentTurns: 2,        // (default) keep the last 2*2 = 4 messages verbatim
    // instructions: "Also preserve open questions.", // optional prompt steering
  },
  onEvent: (e) => {
    if (e.type === "compact-boundary") {
      // e.messagesBefore, e.messagesAfter, e.inputTokensAtTrigger
    }
  },
});
```

Where it plugs in: the compaction block sits inside the turn body **between** the per-turn `Budget`
charge and the `budget.exceeded()` gate (`src/orchestrator/agentic-loop.ts:487`+). Placing it before the
gate means the summarizer's own charge is caught by the **same** post-turn budget check — no new exit
path. The trigger is deliberately narrowed to `stopReason === "tool_use"` (the loop is about to make
another request anyway; the final completion turn never pays for a useless summary) and to the
**per-request** `inputTokens` (a shrunken prompt then naturally falls back below the threshold, the
anti-thrash mechanism). The `messages.splice(0, head.length, summaryMessage)` replaces the head in place,
preserving the tail's object identity so the recent turns stay deep-equal. Compaction only ever mutates
`messages`; the system prompt and the turn's in-flight tool exchange are structurally excluded.

## Notes for maintainers

- **This is a DIFFERENT, unrelated layer from the existing sprint-boundary compaction — keep them
  distinct:**
  - **In-context / in-run compaction (this sprint)** = `compaction.ts` + `agentic-loop.ts`. Summarizes the
    **live `Message[]` transcript inside a single running loop** when the per-request token trigger fires.
  - **Sprint-boundary compaction** = `summarizeOlderSprints` / `contextReset` in
    `src/orchestrator/context-handoff.ts`. Compacts the planner's **cross-sprint `ContextHandoff` document**
    (`SprintContract[]` history), a coarse between-sprints layer. It was **not touched** this sprint.
  The `compaction.ts` file header calls out this distinction explicitly.
- **Follow-up (evaluator advisory, low priority):** the anti-thrash JSDoc slightly overstates the
  guarantee. The trigger "naturally resets" only when the shrunken prompt drops back below the threshold —
  a **pathological single turn whose own content alone exceeds `maxContextTokens`** can re-trigger
  compaction on consecutive turns (this is correct behavior, just repeated). Consider softening the JSDoc
  wording and/or adding a bounding test when `agentic-loop.ts` is next touched.
- **Follow-up (evaluator advisory, low priority):** there is **no committed combined session + compaction
  test**. A manual trace confirmed `persistSession` (Sprint 6) serializes the post-splice array safely, but
  a future test should assert the persisted `.bober/sessions/<id>.json` reflects the compacted array after a
  compaction fires within a session-enabled run.
- **Scope.** One commit `8b8fd13`, 6 sprint-scoped files (new `compaction.ts` + test, `agentic-loop.ts` +
  test, `loop-events.ts` + test). No role-agent files, `context-handoff.ts` / `summarizeOlderSprints`
  untouched, `package.json` unchanged (no new dep). +11 tests (suite 3832 → 3843). All 6 required criteria
  (sc-7-1..7-6) passed iteration 1; all four nonGoals evaluator-confirmed.
