# Streaming text deltas (Anthropic adapter streaming + loop passthrough)

**Contract:** sprint-spec-20260709-agent-loop-capability-port-8  ·  **Spec:** spec-20260709-agent-loop-capability-port  ·  **Completed:** 2026-07-10

## What this sprint added

Real-time output from agent-bober's own provider layer **without changing the loop's turn model**.
`ChatParams` gains an optional, provider-agnostic `onTextDelta` callback; when it is set, the
**Anthropic** adapter switches from `client.messages.create()` to the SDK's accumulating
`client.messages.stream()`, forwards each `text_delta` to the callback as the response is generated,
and then returns the **exact same** normalized `ChatResponse` (`text`, `toolCalls`, `stopReason`,
`usage`, `costUsd`) it would have returned non-streamed — both branches now run the SAME newly
extracted `normalizeResponse()` helper, so streamed and non-streamed responses are **deep-equal**.
Every other adapter (`openai` / `openai-compat` / `google` / `claude-code`) accepts the field and
**never invokes it** — a documented no-op with nothing extra on the wire. `runAgenticLoop` threads
`onTextDelta` into every `chat()` call and, when `onEvent` is also present, emits a
`{ type: "text-delta", turn, delta }` `LoopEvent` per delta. This was the **last name Sprint 5
reserved by comment** — all reserved `LoopEvent` names are now implemented. Absent the callback
(and `onEvent`), no `onTextDelta` key reaches `chat()`, the adapter uses non-streaming `create()`,
and behavior is **byte-identical** (paired deep-equal run + full suite 3843 → 3859, +16 tests).

## Public surface

- `ChatParams.onTextDelta?: (delta: string) => void` (`src/providers/types.ts:218`) — optional
  provider-agnostic streaming callback. A plain own type; adapters **MAY** ignore it. A throwing
  callback must never kill the request (the adapter wraps each invocation in `try/catch`).
- `AgenticLoopParams.onTextDelta?: (delta: string) => void` (`src/orchestrator/agentic-loop.ts:84`) —
  the loop-level knob. Threaded into every `chat()` call as `ChatParams.onTextDelta`; additionally
  drives the `text-delta` `LoopEvent` when `onEvent` is present.
- `LoopEvent` member `{ type: "text-delta"; turn: number; delta: string }`
  (`src/orchestrator/loop-events.ts:34`) — now-implemented; the `RESERVED` comment is removed since
  every reserved name is live.
- `normalizeResponse(response, model, structured)` (`src/providers/anthropic.ts:23`) — **internal**
  (module-private, not exported). Extracted verbatim from the prior inline tail so the streaming
  `finalMessage()` and the non-streaming `create()` result normalize identically (content →
  `text`/`toolCalls`, usage, `costUsd` spread-when-known, structured-output forced-tool handling).

## How to use / how it fits

Programmatic-only — nothing was added to `config/schema.ts`, and **no pipeline role auto-enables
streaming** (same posture as the Sprint 5 hooks, Sprint 6 sessions, and Sprint 7 compaction).

```ts
import { runAgenticLoop } from "agent-bober";

await runAgenticLoop({
  /* ...client (Anthropic), model, tools, handlers... */
  userMessage: "stream this",
  onTextDelta: (delta) => process.stdout.write(delta), // fires per token as it arrives
  onEvent: (e) => {
    if (e.type === "text-delta") {
      // e.turn, e.delta — same deltas, also on the observation channel
    }
  },
});
```

Or at the raw adapter layer:

```ts
const res = await anthropicAdapter.chat({
  model, system, messages,
  onTextDelta: (d) => buffer.push(d),
});
// buffer.join("") === res.text  (delta-join guarantee, Anthropic path)
```

Where it plugs in (`src/providers/anthropic.ts`): the request body is built **once** (no `stream`
key — `.stream()` is the accumulating helper, not a flag on `create()`), so both paths send an
identical payload. When `onTextDelta` is absent the adapter takes the pre-sprint-8 `create()` path;
when present it iterates the stream, forwarding only `content_block_delta` events of type
`text_delta`, then normalizes the stream's `finalMessage()` through the shared helper. In the loop
(`src/orchestrator/agentic-loop.ts:430`+), a per-turn `emitTextDelta` wrapper is built **inside** the
turn loop (so it captures the current `turn`) only when `onTextDelta` **or** `onEvent` is set; it
`safeEmit`s the `text-delta` event **first**, then calls the caller's `onTextDelta`, and is spread
into the chat params conditionally so the no-callback path carries no `onTextDelta` key.

## Notes for maintainers

- **Only the Anthropic adapter streams.** `openai` / `openai-compat` / `google` / `claude-code`
  carry a one-line no-op documentation comment in their `chat()` and are covered by an explicit
  per-adapter test (spy never called; no `onTextDelta` in the serialized request payload). Streaming
  the OpenAI-family or Google adapters, and the `claude-code` text-only boundary, are declared
  **nonGoals** here — each is its own follow-up if wanted.
- **Mid-stream errors keep `chatWithRetry` parity (sc-8-5).** Only the **per-delta callback** is
  wrapped in `try/catch`. Errors from stream iteration / `finalMessage()` propagate **uncaught**, so
  `chatWithRetry`'s `isTransientError` classification applies identically to a rejecting `create()`
  call — a transient error is retried, otherwise it surfaces as `stopReason "error"`.
  `chatWithRetry` / `isTransientError` were **not touched** (zero diff).
- **Follow-up (evaluator advisory, low priority):** the **streaming + structured-output** combination
  is **untested and undocumented**. With both set, `messages.stream()` fires text deltas while the
  final `ChatResponse.text` is derived from the forced `structured_output` tool's JSON — so the
  `delta-join === text` guarantee would **not** hold in that combo. It is not a contract violation
  today (no caller combines them), but the next change that first combines streaming with a forced
  `tool_choice` should either document the caveat or guard against it.
- **Scope.** Two commits — `37405e2` (implementation: `types.ts`, `anthropic.ts` + test,
  `agentic-loop.ts` + test, `loop-events.ts`, one-line no-op comments in the four other adapters) and
  `016e9f5` (the explicit sc-8-3 no-op tests for the four non-Anthropic adapters). No SDK-type leakage
  outside `anthropic.ts` (provider-agnosticism law), no nonGoal violations (no abort/interrupt — that
  is Sprint 9 — no non-Anthropic streaming, no UI wiring), `package.json` unchanged (no new dep).
  +16 tests (suite 3843 → 3859). All 6 required criteria (sc-8-1..8-6) passed iteration 1.
