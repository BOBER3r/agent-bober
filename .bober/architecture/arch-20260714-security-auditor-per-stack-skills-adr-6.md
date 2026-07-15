# ADR-6: The Verifier Runs Inside the Gate's Single Time-Box, Sequentially After the Finder

**Decision:** Run the verifier stage inside the same gate `Promise.race` time-box as the finder, sequentially after it, sharing one `AbortController` — not a second time-box and not a concurrent race — with `verifier.maxTurns` capped at 10 and its own sub-budget.

**Context:** The gate wraps the whole audit in one `Promise.race([runSecurityAudit, timeout])` (security-gate.ts:98) bounded by `timeoutMs` (default 300s, schema.ts:214), with an optional `budget.maxUsd` (schema.ts:221) and finder `maxTurns` 20. The verifier consumes the finder's output, so it cannot start until the finder finishes.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A. Second independent time-box for the verifier | Verifier gets a full budget | Doubles worst-case wall-clock beyond the gate's 300s contract; two boxes to reason about |
| B. Run finder and verifier concurrently | Lower latency | Impossible — the verifier's input IS the finder's output; a data dependency, not a perf trade |
| **C. One shared box, sequential, single AbortController (chosen)** | Honours the 300s contract; one cancellation path; default-off ⇒ byte-identical single stage | Verifier competes for the finder's remaining time budget |

**Rationale:** The single-time-box constraint (security-gate.ts:98, schema.ts:214) eliminates A — a second box would break the gate's 300s wall-clock contract. The data dependency (verifier input = finder output) eliminates B's concurrency as physically impossible. Sequential execution in one box with a shared `AbortController` is the only shape that fits both.

**Consequences:** One `AbortController` keyed to `timeoutMs` threads through diff, finder, and verifier; `verifier.maxTurns` 10 (< finder's 20) plus a sub-budget bound the second stage; with `verifier.enabled:false` (default) the path is a single-stage audit byte-identical to today.

**Risk:** A slow provider makes finder + verifier exceed 300s and the gate fails closed (blocks the sprint). Mitigation: the shared `AbortController` cancels both stages at the deadline, `verifier.maxTurns` 10 + sub-budget cap the second stage, and the verifier is default-off so no existing configuration incurs the two-stage latency.
