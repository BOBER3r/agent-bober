# ADR-6: Sprint-run lifecycle is fire-and-observe (POST returns 202; watcher delivers progress)

**Decision:** `POST /api/v1/bober/sprints` returns HTTP 202 immediately after `subprocess.Popen` returns with a pid; body is `{sprintId, pid, startedAt}`. All subsequent progress, status, and terminal state arrive via SSE ArtifactEvents from ArtifactWatcher observing `.bober/sprints/<id>.json` and `.bober/eval-results/<sprintId>/*.json`. The HTTP request does NOT hold a connection open for the sprint duration.

**Context:** A bober sprint runs seconds to many minutes. Holding HTTP across that span burns a worker, breaks every standard reverse-proxy idle timeout (60-120s), and creates a different code path than the `.bober/` source-of-truth model the CLI already uses.

**Options Considered:**

| Option | Pros | Cons |
|---|---|---|
| Fire-and-observe (chosen) | One source of truth; HTTP returns <500ms; proxies happy; reconnect resilient | FE must reconcile optimistic UI with eventual SSE; "started but no event yet" gap ≤100ms |
| Long-lived HTTP streaming | Single request models full lifecycle | Breaks proxy timeouts; doubles state machines |
| Dedicated WS per sprint | Bidirectional allows cancel over channel | Another protocol; cancel is rare, DELETE covers it |

**Rationale:** Checkpoint 1 mandates byte-identical `.bober/*.json` between CLI and UI runs — only achievable if UI is pure observer of the same artifact tree. Long-lived responses tempt synthesizing progress not on disk. Fire-and-observe gives free crash resilience: refresh mid-sprint reconnects SSE and resyncs from disk.

**Consequences:** ProcessRegistry holds `sprintId → pid` only. Cancel is `DELETE /sprints/{sprintId}`. Frontend `BoberStore.startSprint` flow: optimistic state → 202 ack → await SSE for truth. Progress beyond status transitions must be CLI-written to `.bober/` to be visible — this is the contract.

**Risk:** If bober CLI is changed upstream to emit progress only to stdout, UI shows no progress between start and terminal. Mitigation: contract test in agent-bober asserts every phase transition produces a `.bober/sprints/<id>.json` write before any stdout log line.
