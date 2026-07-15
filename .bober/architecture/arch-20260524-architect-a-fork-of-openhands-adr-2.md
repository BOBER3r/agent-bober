# ADR-2: CLI-subprocess + filesystem watching for the Python<->Node boundary

**Decision:** The Python sidecar invokes the agent-bober CLI as one-shot subprocesses and observes `.bober/` via a filesystem watcher; no long-lived RPC daemon, no in-process Node embedding.

**Context:** OpenHands is FastAPI/Python; agent-bober is ESM Node. A success criterion requires byte-identical `.bober/*.json` artifacts between UI-driven and CLI-only runs. The boundary choice dictates artifact-write paths, error semantics, and operability.

**Options Considered:**

| Option | Pros | Cons |
|---|---|---|
| One-shot CLI subprocess + fs watcher | Identical artifact-write code path to CLI; zero new IPC; CLI is canonical; trivial to debug | Per-run ~200ms Node cold-start; no streaming structured events except via stdout lines |
| Long-lived JSON-RPC daemon over Unix socket | Lower per-call latency; bidirectional streaming | New protocol to version; daemon lifecycle to supervise; artifact-write path diverges from CLI |
| Embed Node-in-process | Single process; no IPC | Heavyweight coupling; bypasses CLI so artifact equivalence unprovable; fragile ESM loader |

**Rationale:** The locked constraint "Python<->Node boundary is subprocess + filesystem only" reflects the byte-identical-artifacts criterion: only the CLI path is canonical. Daemon/embedded options diverge that path.

**Consequences:** Every sprint starts a fresh Node process (~200ms cold start, acceptable for minute-scale sprints). BoberPipelineDriver is a thin process manager. Live updates flow through ArtifactWatcher — the watcher is the load-bearing live-update path.

**Risk:** If ArtifactWatcher misses an event (macOS FSEvents coalescing under load), the UI silently desyncs. Mitigation: BoberStore.hydrate() callable as manual refresh and auto-invoked on WS reconnect.
