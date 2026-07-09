# Structured loop event stream + host-style hooks (`onEvent`, `preToolUse` veto, `postToolUse`, `onStop`)

**Contract:** sprint-spec-20260709-agent-loop-capability-port-5  ·  **Spec:** spec-20260709-agent-loop-capability-port  ·  **Completed:** 2026-07-10

## What this sprint added

The first **extension** sprint (past the four architecture-backed sprints) gives agent-bober's own
`runAgenticLoop` the Anthropic SDK's **observability + interception** surface **without consuming
model context** — every event and hook runs host-side in the orchestrating process and adds **zero
tokens** to the conversation. Two orthogonal, independently-gated capabilities: an optional
**`onEvent` callback** emits a typed `LoopEvent` union (`init` → per-turn `turn-start` /
`tool-start` / `tool-end` / `turn-end` → `result`) as a pure observation channel, and an optional
**`hooks` bag** lets a host **veto** a tool call before it runs (`preToolUse`), **observe** each tool
result (`postToolUse`), and **observe the final result exactly once** (`onStop`). All new params are
programmatic-only (no config schema surface), fully additive, and **byte-identical when absent**.

## Public surface

New types-only module **`src/orchestrator/loop-events.ts`** (own, provider-agnostic — never SDK types):

- `LoopEvent` (`src/orchestrator/loop-events.ts:36`) — discriminated union: `{type:"init", model,
  maxTurns}` · `{type:"turn-start", turn}` · `{type:"tool-start", turn, name, input, toolUseId}` ·
  `{type:"tool-end", turn, name, toolUseId, isError}` · `{type:"turn-end", turn, toolsCalled}` ·
  `{type:"result", stopReason, turnsUsed}`. `compact-boundary` (sprint 7) and `text-delta`
  (sprint 8) type names are **RESERVED via comment only** — not emitted this sprint.
- `LoopToolCallInfo` (`:18`) — `{ name, input, toolUseId }`, the subset of a model-requested tool
  call surfaced to hooks/events (`toolUseId` correlates with `ToolResult.toolUseId`).
- `HookDecision` (`:47`) — `{ allow: boolean; reason?: string }`, returned by `preToolUse`.
- `LoopHooks` (`:59`) — `{ preToolUse?, postToolUse?, onStop? }`. `preToolUse(call)` (`:67`) is a
  veto gate (`HookDecision | Promise<HookDecision>`); `postToolUse(call, result)` (`:72`) observes
  each result; `onStop(result)` (`:78`) observes the final `AgenticLoopResult`.

Threaded onto the loop:

- `AgenticLoopParams.onEvent?: (event: LoopEvent) => void` (`src/orchestrator/agentic-loop.ts:82`) —
  optional structured event stream.
- `AgenticLoopParams.hooks?: LoopHooks` (`src/orchestrator/agentic-loop.ts:91`) — optional host-side hooks.
- Internal `finish(result)` helper (`src/orchestrator/agentic-loop.ts:345`) — **all four** loop
  return paths (error, `budget_exceeded`, completion/refusal, `max_turns_exceeded`) now route
  through this single closure, so the `result` event fires and `onStop` runs **exactly once** per
  stop path. `safeEmit` (`:333`) wraps `onEvent` in try/catch.

Executor plumbing (`src/orchestrator/tools/executor.ts`):

- `ToolBatch` gains optional `onToolStart` (`:38`), `onToolEnd` (`:43`), `preToolUse` (`:51`),
  `postToolUse` (`:58`). The loop passes these per-turn callbacks only when its `onEvent`/`hooks`
  are set; the veto short-circuit lives in `executeOne` (`:91`), producing the standard `isError`
  rejection `ToolResult` shape.

## How to use / how it fits

Both are optional `runAgenticLoop` params — this is a **programmatic API**, not a `bober.config.json`
knob (nothing was added to `config/schema.ts`):

```ts
const result = await runAgenticLoop({
  // ...existing params (client, tools, handlers, ...)
  onEvent(e) {
    if (e.type === "tool-start") log(`turn ${e.turn}: ${e.name}`);
  },
  hooks: {
    // Veto: skip the handler, feed the model an isError rejection, keep looping.
    preToolUse(call) {
      if (call.name === "bash") return { allow: false, reason: "bash disabled in this run" };
      return { allow: true };
    },
    postToolUse(call, result) { audit(call.name, result.isError); },
    onStop(final) { record(final.stopReason, final.costUsd); },
  },
});
```

**Event ordering** for a two-turn run (one tool turn + one completion turn) is `init` → `turn-start`
→ `tool-start` → `tool-end` → `turn-end` → `turn-start` → `turn-end` → `result` (an 8-event trace —
a tool-less completion turn still emits `turn-end` with `toolsCalled: []`).

**Veto semantics:** a `preToolUse` returning `{allow:false, reason}` skips the handler, pushes an
`isError` `ToolResult` containing the reason back to the model, and the loop **continues to the next
turn** rather than stopping. Veto-only this sprint — hooks **cannot mutate `call.input`** (input
transformation is an explicit non-goal).

Where it plugs in: the loop derives per-turn `onToolStart`/`onToolEnd`/`preToolUse`/`postToolUse`
closures and passes them into `executeToolBatch`. Existing `onToolUse` / `onTurnComplete` callbacks
are **untouched and coexist** (additive) — no consumer of the loop is wired onto the new surface yet
(chat `/careful` gates, `ToolRoleGuard`, and the IDE monitor integrate later; not this sprint).

## Notes for maintainers

- **Observe hooks can never crash the loop.** A throwing `onEvent`, `postToolUse`, or `onStop` is
  caught and `logger.warn`-logged, and the loop resolves normally. A throwing **`preToolUse` is
  fail-closed** — it counts as a deny (`{allow:false, reason:"hook error (fail-closed)"}`), so the
  tool is skipped, never executed on a hook error.
- **`finish()` is the only result/`onStop` dispatch.** The evaluator confirmed all four `return`
  statements in `runAgenticLoop` route through it and no path bypasses it. Preserve that invariant
  if you add a new stop path — emit through `finish()`, not a bare `return`.
- **Two independent gates.** Events are gated on `onEvent` only; hooks on `hooks` only. The executor
  callbacks are left `undefined` when their capability is unset, so `executeToolBatch`/`executeOne`
  take their exact pre-sprint-5 code path — omitting both is byte-identical (paired deep-equal
  `AgenticLoopResult` test + full suite 3787 → 3802).
- **No config/schema or package.json change.** This is a programmatic-only surface; it is documented
  here rather than in [`docs/providers.md`](../providers.md), which covers only `bober.config.json`
  schema surfaces.
- **Follow-up (evaluator advisory, low priority).** No **direct executor-level** unit tests for the
  veto / `onToolStart` / `onToolEnd` / `postToolUse` plumbing were added — loop-level tests exercise
  them transitively and were judged sufficient for this contract. Add direct `finalize()`-path
  coverage in `src/orchestrator/tools/executor.test.ts` when `executor.ts` is next touched.
- **Scope.** One commit `d52f94c` (5 files: new `loop-events.ts` + test, `agentic-loop.ts` + test,
  `tools/executor.ts`). +15 tests (suite 3787 → 3802). All 6 required criteria (sc-5-1..5-6) passed
  iteration 1; the 2 suite flakes (`preflight-injector-bench`, `checkpoints/disk`) are confirmed
  machine-load perf flakes in files untouched by this commit.
</content>
