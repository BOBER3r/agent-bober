# ADR-3: Child runId Discovered from Disk, Not Parent-Injected

**Decision:** The fleet discovers each child's `runId` by reading the newest `.bober/runs/<runId>/state.json` by `startedAt` after the child exits, rather than injecting a runId into the child via a CLI flag.

**Context:** The aggregator must locate each child's `RunState` to report its status. The published `run` CLI exposes no runId flag, and the `run` CLI contract is a HARD locked dependency.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A: Discover newest `state.json` by `startedAt` from disk | No CLI change; uses durable state the pipeline already writes | Ambiguous if a folder contains prior runs (clock skew / reused folder) |
| B: Inject a parent-chosen runId via a new `run` flag | Unambiguous mapping parent → child run | Changes the published `run` CLI surface, violating the locked contract |

**Rationale:** The CP1 HARD backward-compat constraint (the `run` CLI contract MUST NOT change) eliminates B; disk discovery reads the `RunState` the pipeline already persists under `.bober/runs/`, the only sanctioned persistence per CP1.

**Consequences:** The aggregator selects the newest run by `startedAt` and records `source: "disk"`; no change to the `run` CLI; ambiguity is avoided by scaffolding into fresh, empty folders only.

**Risk:** If a child folder already contains a prior run (reused folder) or clocks skew across processes, newest-by-`startedAt` may select the wrong run; mitigated by scaffolding fresh folders only and recording `source`.
