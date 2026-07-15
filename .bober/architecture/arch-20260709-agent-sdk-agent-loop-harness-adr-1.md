# ADR-1: Port High-Value Agent-Loop Capabilities into the Own Loop, Not the Agent SDK

**Decision:** Add refusal detection, per-role effort, a USD ceiling, and parallel read-only tool execution as additive, default-off changes to `runAgenticLoop` and the `LLMClient` substrate, rather than adopting `@anthropic-ai/claude-agent-sdk`.

**Context:** The capability audit found nine of thirteen agent-loop capabilities absent or undriven. The four most consequential must gain driven behaviors while one loop (`agentic-loop.ts`) backs every pipeline role plus fleet children running DeepSeek, Grok, openai-compat, and local models.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A: Minimal port into own loop | Smallest additive diff; reuses live substrate (open StopReason union, effort plumbing, Budget, parsed `total_cost_usd`); provider-agnostic; hits all four criteria | Leaves 7 capabilities disposition-only; price-table drift; ceiling fires between turns |
| B: Full 13-area parity program | True parity; sessions/hooks/streaming would help chat and IDE monitor | Repeated re-touch of shared loop → max cumulative regression on ~3686 tests; speculative areas without named constraints; delays the four fixes |
| C: Adopt Agent SDK (Anthropic-only) | Sessions/fork/hooks/subagents/streaming for free | `query()` runs its own loop, never returns custom single-turn `tool_use` to `toolHandlers` (same boundary as `claude-code.ts:10-31`); fleet children cannot use it, so fixes still need porting; SDK-type leakage strains the HARD LAW |

**Rationale:** The provider-agnosticism HARD LAW plus non-Anthropic fleet children eliminate Option C; the backward-compat / additive-only / ~3686-tests-green constraints eliminate Option B's speculative multi-phase re-touching. Option A's scope is exactly the four named success criteria.

**Consequences:** Four fixes land default-off on `AgenticLoopParams`/`ChatParams`/config; `Budget` gains `maxUsd`; `BudgetExceededError` gains kind `"usd"`; the serial tool loop splits a contiguous read-only batch; the 7 remaining capabilities are explicitly deferred with named-constraint disposition lines.

**Risk:** Price tables drift, firing the ceiling early or late for non-`claude-code` adapters; a mis-classified read-only tool could reorder side effects — mitigated by a conservative allow-list that defaults any unmarked tool to serial execution.
