# ADR-3: PTY ownership lives in the Electron MAIN process via node-pty

**Decision:** Allocate and own every Claude Code PTY in the main process through `ClaudePtySupervisor` (node-pty), streaming raw frames to the renderer over the `pty:output` IPC channel; the renderer holds only xterm.js view state.

**Context:** Claude Code runs as a long-lived interactive subprocess needing a real TTY (winsize, SIGWINCH, signal-based kill), exactly as `openhands_bober/pty/supervisor.py` manages it. Renderer (Chromium) processes cannot own file descriptors or send POSIX signals.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| PTY in main (node-pty) | Real TTY fd, `TIOCSWINSZ` resize + SIGTERM→SIGKILL lifecycle; survives renderer reloads; one isolation point | Frames must cross IPC to reach xterm |
| PTY in renderer / utility process | Terminal data stays in one process | Chromium sandbox cannot hold a TTY fd or signal the child; renderer reload kills the agent mid-run |

**Rationale:** Checkpoint 1 requires running agents LOCAL-FIRST as durable processes against the user's checkout; only the main process can hold the TTY fd and deliver `TIOCSWINSZ`/signals, and main-ownership means a renderer crash/reload does not orphan or kill a running Claude session.

**Consequences:** `ClaudePtySupervisor` mirrors `supervisor.py` (PtyHandle per `runId`, `CLAUDE_CODE_SESSION_ID` injection for orphan-scan, EMFILE→`PtyExhaustedError`); PTY output is sent as `Uint8Array` over IPC (structured clone, no base64).

**Risk:** Very high-throughput PTY output could pressure the IPC channel; if observed, frames must be coalesced/throttled in `ClaudePtySupervisor` before `emit` (see ADR-6 frame-window coalescing).
