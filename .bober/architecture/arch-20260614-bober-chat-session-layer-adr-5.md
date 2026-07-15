# ADR-5: Kill-by-PID Stop Semantics with Disk Intent-Flag Fallback

**Decision:** Hard-stop a worker by `process.kill(pid)`, where the pid is read from a session-owned sidecar under `.bober/chat/` keyed by runId; additionally flip the disk `state.json` status to `"aborted"` via `writeRunState`. If the pid is unknown (sidecar lost), fall back to writing the `"aborted"` intent-flag only. Do NOT use `RunManager.abortRun` for cross-process stop.

**Context:** Phase-1 "steer" includes a real hard-stop. Workers run as detached children in separate processes. `RunManager.abortRun` mutates only an in-memory map (run-manager.ts:123), so it no-ops across processes and cannot stop a detached child.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A. Kill-by-PID (sidecar) + disk `aborted` flip + intent-flag fallback | Actually terminates the OS process; survives session restart (sidecar on disk); does not mutate RunState type | Pid can be reused/stale; sidecar can be lost |
| B. RunManager.abortRun(runId) | Reuses existing API | No-ops cross-process (run-manager.ts:123) — does not stop a detached child |
| C. Extend RunState with a "stopRequested" field, child polls it | No PID handling | Mutates RunState type (additive-reuse breach); child must poll — not a hard-stop |

**Rationale:** Checkpoint-1 "MUST NOT break public APIs ... Additive reuse" and the FINAL refinement "Real hard-stop by PID ... Do NOT rely on RunManager.abortRun for cross-process stop" eliminate B (no-ops cross-process) and C (mutates RunState type, not a true stop). The sidecar lives under `.bober/chat/`, honouring filesystem-state-only without touching `RunState`.

**Consequences:** `RunSpawner.spawn` records `{runId, pid}` in a `.bober/chat/<sessionId>.pids.json` sidecar at spawn. `stop(runId)` resolves the pid, `process.kill(pid)`, then `writeRunState(...status:"aborted")`. Sidecar-miss path writes only the `aborted` disk flag.

**Risk:** If the OS reused the pid for an unrelated process, `process.kill` could signal the wrong process. Mitigated by killing only pids the session itself recorded this session-lifetime; stale-sidecar entries fall through to the disk-flag-only path rather than killing a guessed pid.
