# ADR-5: Per-Project Event Addressing and Isolation

**Decision:** Each project owns an isolated runtime lane — its own ArtifactStore + chokidar watcher, its own per-project monotonic `seq`, and its own `agent-bober mcp` stdio process — and every IPC push carries an explicit `projectId` for renderer-side routing.

**Context:** Checkpoint 1 requires parallel multi-project operation (≥3, isolated, NO cross-project leakage). A single shared watcher / event stream / MCP process would interleave events from different checkouts and risk one project's artifacts reducing into another's store.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| Per-project lanes (own watcher, seq, MCP proc); projectId on every event | True isolation; replay scoped per project; one project's crash can't corrupt another | More processes/watchers (N× resource); per-project lifecycle to manage |
| Single shared ArtifactStore + global seq, filter by projectId in renderer | Fewer processes; one event stream | A dropped/coalesced event in one project advances the global seq, breaking gap-detection for others; one bad Zod parse can stall the shared watcher for all projects |
| Tag events with projectId but share one MCP process | Lowest process count | MCP process is rooted at one cwd; serving 3 roots from one stdio process is not supported by `agent-bober mcp` (one-per-project-path was specified in Checkpoint 3) |

**Rationale:** Checkpoint 1's "isolated, no cross-project leakage" constraint eliminates the shared-store options — a global seq makes per-project gap-detection and `eventsSince` replay incorrect, and a shared watcher couples failure domains. Per-project lanes are the only option that satisfies isolation; the resource cost is bounded (≥3 projects, not hundreds).

**Consequences:** ProjectStore keys all state by projectId and rejects events for unregistered projects. `artifactEventsSince` takes `(projectId, seq)`. Removing a project tears down its watcher, ring-buffer, and MCP process.

**Risk:** If a push is ever emitted without a `projectId` (e.g. a future MainEvent added without the field), the renderer cannot route it and may misattribute or drop it — every new push channel MUST include projectId, enforced by the MainEvents type.
