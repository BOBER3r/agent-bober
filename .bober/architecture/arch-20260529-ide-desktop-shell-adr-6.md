# ADR-6: PTYs Live in Main and Survive Renderer Reload (Reattach, Not Respawn)

**Decision:** node-pty processes are owned by ClaudePtySupervisor in the MAIN process keyed by runId; a renderer reload (Cmd-R / Vite HMR / crash) does NOT kill them. On remount, TerminalPane re-attaches to the live runId and replays a bounded scrollback snapshot kept in main. PTYs die only on explicit `ptyKill` or process `pty:exit`.

**Context:** Checkpoint 1 mandates LOCAL-FIRST agent runs against the user's checkout and a <60s zero-key first run; a Claude `/login` or a long agent run must not be destroyed when the renderer reloads. The PTY kernel buffer is the authoritative terminal state (Consistency Model).

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| PTY in main, reattach + scrollback replay on reload | Runs/logins survive reload; terminal state never reconstructed; matches PTY-in-main (ADR-3) | Main must retain a bounded scrollback buffer per runId (memory cost) |
| Kill PTYs on `webContents` reload, respawn fresh | Simplest lifecycle; no retained buffer | Destroys in-progress login/run on every HMR; violates local-first run durability; data loss |
| PTY in a separate detached child, reconnect via socket | Survives even main crash | Reintroduces an IPC/socket transport contrary to ADR-1 (Electron-IPC-not-HTTP); extra moving part |

**Rationale:** Checkpoint 1's local-first long-running agent requirement and the <60s first-run login flow eliminate the kill-on-reload option — losing a login PTY on an HMR reload would make the first-run target unreliable. The detached-child option reintroduces a socket transport that ADR-1 rejected. Reattach-in-main is the only option preserving both run durability and the IPC-only boundary.

**Consequences:** ClaudePtySupervisor retains a per-runId ring of recent output bytes (last N KB) for replay-on-attach. Renderer treats xterm as a disposable mirror and re-subscribes to `pty:output` by runId after mount. Reload-resilience becomes a tested invariant.

**Risk:** If the main process itself crashes, PTYs die with it (not survivable without the rejected detached-child design) — acceptable because a main crash also loses the window; the scrollback buffer is bounded, so an extremely chatty PTY truncates older scrollback on reattach.
