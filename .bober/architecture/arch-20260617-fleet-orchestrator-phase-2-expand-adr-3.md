# ADR-3: Validate/retry contract — one bounded coercion re-prompt, then fail clearly

**Decision:** `decomposeGoal` makes one normal LLM call, validates via `validateManifest`; on failure it re-prompts once (`DECOMPOSE_MAX_RETRIES = 1`, total ≤ 2 model calls) via `jsonObjectMode` with the prior text + formatted Zod error, then on continued failure rejects with a single clear `Error` — never resolving with an invalid manifest.

**Context:** Decomposition is constrained to "ONE cheap DeepSeek call + bounded retry". We must define the retry count and exhaustion behavior so the seam fails predictably rather than emitting a half-valid manifest into a real spawn path.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| One call + 1 coercion re-prompt, then throw | Matches planner's proven try-then-coerce shape; ≤ 2 calls keeps it cheap; deterministic failure | One reflow may not fix a deeply confused model (rare; throws clearly) |
| Unbounded / N-retry loop until valid | Higher success odds | Violates "cheap single call"; unbounded cost/latency on a pathological goal |
| No retry — throw on first invalid output | Cheapest; simplest | DeepSeek routinely emits wrong-shape JSON (`agentic-loop.ts:152-167`) — high false-fail rate |

**Rationale:** The CP1 "ONE cheap DeepSeek call + bounded retry" constraint eliminates the unbounded loop; the same constraint plus DeepSeek's documented wrong-shape tendency eliminate the zero-retry option. One coercion call mirrors the planner exactly (`planner-agent.ts:255-271`).

**Consequences:** Retry re-uses the json_object→plain fallback behavior; the thrown error carries the formatted Zod issues so the operator sees why decomposition failed; no manifest object is returned on failure, so the inspect/spawn path never sees an invalid manifest.

**Risk:** If the operator sets `maxRetries` very high to "force" a result, the cheap-call guarantee erodes — the default is fixed at 1 and the budget is documented as a bounded knob, not an open loop.
