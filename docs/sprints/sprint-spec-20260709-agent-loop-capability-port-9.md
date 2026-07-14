# Mid-turn interrupt: AbortSignal through the loop and streaming adapter

**Contract:** sprint-spec-20260709-agent-loop-capability-port-9  ·  **Spec:** spec-20260709-agent-loop-capability-port  ·  **Completed:** 2026-07-10

## What this sprint added

Makes a running `runAgenticLoop` **cancellable mid-flight** without ever throwing. Both `ChatParams`
and `AgenticLoopParams` gain an optional, web-standard `abortSignal?: AbortSignal`. The loop checks it
at **three** exit points — the top of every turn, again right after each chat response (before any tool
batch runs), and in the `chatWithRetry` catch — and every abort exit routes through the existing
Sprint 5 `finish()` helper, so `onStop` / the `result` `LoopEvent` fire **exactly once** and the
accumulated `usage` / `costUsd` / `turnsUsed` survive intact. An aborted run resolves with
`stopReason: "aborted"` plus that partial telemetry — **never a rejected promise**. The **Anthropic**
adapter additionally forwards the signal as the SDK's `signal` request option on both the `create()`
and `stream()` branches, so an in-flight (streaming or non-streaming) request is cancelled the instant
the signal fires; other adapters ignore the field and simply degrade at the loop's own post-response
boundary check. Absent the signal, behavior is **byte-identical** everywhere.

## Public surface

- `ChatParams.abortSignal?: AbortSignal` (`src/providers/types.ts:227`) — optional, provider-agnostic
  web-standard signal (an **own type, not an SDK type**, so it is legal on the provider-agnostic
  surface). Only the Anthropic adapter forwards it; other adapters accept and ignore it. Absent leaves
  every adapter's request payload byte-identical.
- `AgenticLoopParams.abortSignal?: AbortSignal` (`src/orchestrator/agentic-loop.ts:144`) — the
  loop-level knob. Checked at each turn boundary and post-response, and threaded into every `chat()`
  call as `ChatParams.abortSignal`. When it fires the loop ends gracefully at the next
  boundary/cancellation point.
- `StopReason` value `"aborted"` (`src/providers/types.ts:242`, documented in the `StopReason` JSDoc) —
  the loop's own terminal stop reason for an aborted run; a graceful partial return, never a throw. The
  `StopReason` union stays open (`| string`).
- `AbortedError` (`src/orchestrator/agentic-loop.ts:219`) — a typed error thrown by `chatWithRetry`
  when a chat call fails because the run's `abortSignal` fired. **Never retried** and **never escapes**
  `runAgenticLoop` — the loop's chat catch maps it to the graceful `"aborted"` return instead of
  `"error"`. Exported from the orchestrator module (not a user-thrown type; visible for `instanceof`
  narrowing).

## How to use / how it fits

Programmatic-only — nothing was added to `config/schema.ts`, and **no pipeline role auto-enables**
cancellation (same posture as Sprint 5 hooks, Sprint 6 sessions, Sprint 7 compaction, Sprint 8
streaming). A consumer supplies a standard `AbortController`:

```ts
import { runAgenticLoop } from "agent-bober";

const controller = new AbortController();
setTimeout(() => controller.abort(), 30_000); // or wire to a UI "stop" button

const result = await runAgenticLoop({
  /* ...client (Anthropic), model, tools, handlers... */
  userMessage: "long tool-using task",
  abortSignal: controller.signal,
});

if (result.stopReason === "aborted") {
  // partial result: result.finalText, result.turnsUsed, result.usage, result.costUsd
  // all reflect the FULLY completed turns before the abort.
}
```

Where it plugs in:

- **Turn-boundary check** (`src/orchestrator/agentic-loop.ts:488`) — runs before the next `chat()`
  call, so an abort between turns costs **zero** further chat calls.
- **Post-response check** (`:560`) — runs before usage accumulation, `Budget` charging, compaction, and
  the tool batch, so a non-cancellable adapter's already-completed response is **discarded entirely**
  (its usage is never accumulated and its tool calls never execute).
- **`chatWithRetry` catch** (`:248`) — checks `params.abortSignal?.aborted` **before** the transient
  classification and rethrows `AbortedError` immediately, so an in-flight abort is never mistaken for a
  retryable transient error. The loop's chat catch (`:532`) maps that to the `"aborted"` return.
- **Anthropic adapter** (`src/providers/anthropic.ts:385`) — builds a `requestOptions` object
  (`{ signal }`) once and passes it as the SDK's **2nd argument** to both `messages.create()` and
  `messages.stream()`; it is kept out of `requestBody` so the Sprint 8 body-identity invariant holds
  and the signal never travels over the wire. No signal ⇒ the 2nd arg is `undefined`, i.e.
  `create(body, undefined)` is identical to `create(body)`.

`turnsUsed` on every abort exit counts only **fully completed** turns (`turn - 1`), matching the
existing `stopReason: "error"` catch convention.

## Notes for maintainers

- **Abort is keyed on the signal's `aborted` flag, not the error name.** The Anthropic SDK's real abort
  error (`APIUserAbortError`) leaves `err.name` as `"Error"`, **not** `"AbortError"` — so
  `chatWithRetry` checks `params.abortSignal?.aborted === true` as the **primary** guard (provider-
  agnostic; always true when our signal caused the cancel) and keeps `err.name === "AbortError"` only as
  a **secondary** guard for raw fetch / `DOMException` aborts and test doubles. Don't invert this
  ordering.
- **Abort is terminal, not pause/resume.** It ends the run; a consumer that wants to continue later uses
  Sprint 6 session persistence to resume from the last completed turn's transcript. (Combining budget +
  an external `AbortController` is a consumer concern; the loop does **not** auto-abort on budget breach
  mid-turn — that stays a turn-boundary check.)
- **Non-cancellable adapters degrade at the boundary, not the request.** `openai` / `openai-compat` /
  `google` / `claude-code` structurally ignore the field (no destructure, no `signal` forwarded); their
  in-flight request completes normally, but the loop's post-response check discards that response before
  it can drive a further turn. This is the documented sc-9-4 behavior, not a bug.
- **NonGoals held.** No chat `/pause` or Telegram wiring to the signal, no mid-tool-execution
  cancellation (a running tool batch finishes before the abort takes effect), no timeout-based
  auto-abort helper, no cancellation on the `claude-code` CLI path. These are the loop-surface only;
  consumers integrate later.
- **Follow-up (evaluator advisory, low priority):** there is **no permanent regression test combining
  session persistence with abort**. The evaluator ad-hoc verified all three abort exits persist the
  transcript correctly at the last completed turn with no crash (temporary tests, deleted after). A
  future sprint should add a durable guard — suggested name
  *"abort with session enabled persists the transcript at the last completed turn without crashing"*.
- **Scope.** One commit — `2f3636e` — touching exactly the 5 estimated files (`types.ts`,
  `anthropic.ts` + test, `agentic-loop.ts` + test); `package.json` untouched (no new dep), no SDK-type
  leakage outside `anthropic.ts`. +13 tests (anthropic 5, agentic-loop 8); full suite 3859 → 3870. All
  6 required criteria (sc-9-1..9-6) passed iteration 1.
