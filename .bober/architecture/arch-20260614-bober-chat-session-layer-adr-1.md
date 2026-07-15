# ADR-1: Pure-Reader Polling Session

**Decision:** Each chat turn reads run roster and worker completions directly from disk by polling, rather than subscribing to a live event stream or re-deriving state from the LLM.

**Context:** A persistent `bober chat <team>` REPL must track multiple long-running detached workers across turns without owning their lifecycle. State must come from an authoritative source that survives REPL exit.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A. Pure-reader polling (readRunStatesFromDisk + history.jsonl tail) | No SDK leakage; disk-authoritative; survives REPL restart; one classifier call/turn | Polling lag (bounded by turn cadence, acceptable — completion woven into a later turn) |
| B. Async EventStreamManager subscription | Push delivery, lower latency | Requires fake MCP Server shim leaking SDK types; second in-memory inbox becomes a competing source of truth |
| C. Single tool-calling answerer re-deriving roster from LLM | One LLM call does everything | Re-derives roster from model context each turn (cost ceiling violation); DeepSeek tool-calling unreliable |

**Rationale:** Checkpoint-1 "Locked: filesystem state only (NO in-memory global as source of truth; disk roster authoritative)" and "no per-turn re-derivation of roster from the model" eliminate B (second inbox truth, SDK leak) and C (model-derived roster). Latency has no hard budget and completions are explicitly woven into a later turn, so polling lag is acceptable.

**Consequences:** Session holds only byte cursors as state. Roster comes from `readRunStatesFromDisk`, completions from tailing `.bober/history.jsonl`. No subscription, no MCP shim, no provider SDK dependency in the session layer.

**Risk:** If a worker completes and the history line is rotated away before the next poll, the completion is missed (handled by ADR-4 cursor-reset + dedupe). If turn cadence is very slow, completion surfacing is delayed — acceptable per Checkpoint-1.
