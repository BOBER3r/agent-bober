# Loop wiring: per-role effort, USD ceiling enforcement, config schema, cost persistence

**Contract:** sprint-spec-20260709-agent-loop-capability-port-3  ·  **Spec:** spec-20260709-agent-loop-capability-port  ·  **Completed:** 2026-07-09

## What this sprint added

This third sprint of the agent-loop capability port **wires the dormant Sprint 2 cost substrate
into live behaviour** and adds a per-role **reasoning effort** knob — all driven from
`bober.config.json`. Each per-role config section (`planner` / `curator` / `generator` /
`evaluator`) gains two **optional** fields: `effort` (`low|medium|high|xhigh|max`) and
`budget: { maxUsd }`. `runAgenticLoop` now forwards `effort` into every request (spread exactly
like `maxTokens`), charges an optional `Budget` **once per turn** (tokens + `costUsd`), and on a
hit ceiling **returns a graceful partial result** with `stopReason: "budget_exceeded"` — it
**never throws** `BudgetExceededError` and never calls `assertWithinBudget()` (ADR-4). The loop
result gains a cumulative `costUsd`, which the generator surfaces on `GeneratorResult` and the
pipeline persists onto the `sprint-passed` `history.jsonl` event. Everything is
**additive-optional**: omit both keys and every existing config parse, request payload, loop
invocation, and history line is **byte-identical**.

## Public surface

- `EffortSchema` / `Effort` (`src/config/schema.ts:40`) — `z.enum(["low","medium","high","xhigh","max"])`.
  Mirrors `ChatParams.effort` value-for-value; only the Anthropic adapter forwards it (as
  `output_config.effort`).
- `BudgetSectionSchema` / `BudgetSection` (`src/config/schema.ts:48`) — `z.object({ maxUsd:
  z.number().positive().nullable().optional() })`. `null`/omitted means uncapped, matching
  `Budget`'s null-means-unlimited convention.
- Per-role `effort?` + `budget?` fields on **all four** role sections — `PlannerSection`,
  `CuratorSection`, `GeneratorSection`, `EvaluatorSection` (`src/config/schema.ts`). Both attached
  as `.optional()`; no defaults are injected, so existing fixtures parse deep-equal to before.
- `budgetFromMaxUsd(maxUsd)` (`src/orchestrator/workflow/budget.ts:148`) — exported shared helper.
  Returns `new Budget({ maxUsd })` when `maxUsd != null`, else `undefined`. The single place the
  absent-means-no-budget convention lives, so future role wiring (curator/evaluator/planner) can
  adopt it without duplicating the `!= null` guard.
- `AgenticLoopParams.effort?: Effort` (`src/orchestrator/agentic-loop.ts:28`) and
  `AgenticLoopParams.budget?: Budget` (`:34`) — new optional loop inputs.
- `AgenticLoopResult.costUsd?: number` (`src/orchestrator/agentic-loop.ts:82`) — cumulative USD
  summed across turns that reported a `costUsd`. **Conditional key**: omitted entirely (not
  `undefined`-valued) when no turn reported cost, and spread on **all four** loop return sites
  (error, `budget_exceeded`, completion/refusal, `max_turns_exceeded`).
- `GeneratorResult.costUsd?: number` (`src/orchestrator/generator-agent.ts:29`) — the loop's
  `costUsd` propagated through every `parseGeneratorResult` return path.
- `stopReason: "budget_exceeded"` — a new loop-result `stopReason` **value** (the field is a plain
  `string`, so no union type changed). Signals the run ended at a turn boundary because the ceiling
  was hit; the partial result mirrors the `max_turns_exceeded` shape.

## How to use / how it fits

Set either or both fields on any of the four role sections in `bober.config.json`:

```jsonc
{
  "generator": {
    "provider": "anthropic",
    "model": "sonnet",
    "effort": "high",            // → Anthropic output_config.effort (ignored by other providers)
    "budget": { "maxUsd": 5 }    // → per-run USD ceiling; null/omitted = uncapped
  }
}
```

Behaviour when set:

- **`effort`** rides into each request as `ChatParams.effort`. The Anthropic adapter forwards it as
  `output_config.effort`; non-Anthropic adapters never carry it on the wire (this sprint added only
  the callers — the adapter forwarding pre-existed from an earlier sprint).
- **`budget.maxUsd`** is turned into a `Budget` via `budgetFromMaxUsd`. The loop charges it once per
  turn (`chargeTokens` + `chargeUsd(response.costUsd ?? 0)`, both no-op-safe on missing input) and,
  when `exceeded()` after a turn, returns the partial result with `stopReason: "budget_exceeded"`.
  The ceiling fires **between turns**, never mid-turn.
- **Cost persistence:** the generator surfaces `loopResult.costUsd` on `GeneratorResult`, and
  `runSprintCycle` conditionally spreads it into the `sprint-passed` event's `details`
  (`HistoryEntry.details` is a `z.record`, so no schema change). Absent when the run reported no
  cost — the history line stays byte-identical.

Wiring status: **the generator role is wired** (satisfying the "role entry point at minimum"
criterion). Curator, evaluator, and planner accept the config fields but do **not** yet read them
into their loop calls — `budgetFromMaxUsd` is the shared helper they adopt when wired.

## Notes for maintainers

- **The loop never throws on budget.** ADR-4: there is no catcher around `runGenerator` in
  `pipeline.ts`, so a hit ceiling must degrade to a resolved partial result, not an exception.
  `assertWithinBudget()` / `BudgetExceededError` remain reserved for the workflow interpreter's
  existing fail-fast use and are untouched here.
- **`costUsd` is a conditional key, everywhere.** Loop, generator result, and history event all use
  `...(x !== undefined ? { costUsd: x } : {})`. Treat an absent key as **"unknown," never `0`** —
  an unpriced model (or an older `claude` CLI) simply omits it. Any future summing consumer must
  `?? 0` / skip absence rather than assume real zero cost.
- **`anthropic.ts` was not touched.** The `output_config.effort` forwarding already existed; this
  sprint only created config-driven callers that pass `effort` through the loop.
- **Dogfooding declined.** This repo's own `bober.config.json` is byte-unchanged — no `effort` or
  `budget` value is set on it (an explicit non-goal).
- **Out of scope (later in this spec):** mid-turn cost interruption / abort (the ceiling only fires
  at turn boundaries), mapping `effort` to non-Anthropic reasoning params, and parallel read-only
  tool execution.
- **Scope.** One commit (`b9c936c`) touched 9 files (schema, agentic-loop, generator-agent,
  pipeline, budget + 4 collocated test files). +39 tests (suite 3731 → 3770); all 7 required
  criteria (sc-3-1..3-7) passed iteration 1, zero regressions.
</content>
</invoke>
