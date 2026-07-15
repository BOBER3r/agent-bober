# ADR-3: Compute Per-Request USD Cost in the Adapter, Not the Loop or Budget

**Decision:** Each provider adapter populates `ChatResponse.costUsd` — `claude-code` from its already-parsed `total_cost_usd`, token-priced adapters via `CostMeter` — and the loop only reads `costUsd` to charge `Budget`.

**Context:** The USD ceiling needs a request-to-dollars conversion. The three candidate homes are the adapter (which knows provider and model), the loop (a single call site), and `Budget` (the central accountant).

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| Adapter | Preserves authoritative `total_cost_usd` incl. cache tokens the loop never sees; knows provider + model; loop stays agnostic | Each adapter gains a `CostMeter` call |
| Loop | One call site | Cannot see provider identity behind `LLMClient`; would re-estimate and DISCARD the authoritative CLI number |
| Budget | Centralized accounting | Pure token/agent accountant with no model knowledge; coupling breaks the provider boundary |

**Rationale:** Provider-agnosticism bars the loop from knowing which provider ran, and `claude-code.ts:55` already parses the authoritative `total_cost_usd` — computing cost anywhere but the adapter either violates the boundary or throws away real billing data.

**Consequences:** `ChatResponse` gains an optional `costUsd`; the loop calls `budget?.chargeUsd(response.costUsd ?? 0)`; with no budget and no matching price row, `costUsd` is unused and behavior is byte-identical.

**Risk:** Stale price rows under-charge, letting a run exceed the ceiling; mitigated by returning `undefined` for unknown models (never a silently-wrong number) and using real cost for `claude-code`.
