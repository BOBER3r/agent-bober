# ADR-1: Electron IPC as the main↔renderer transport (not loopback HTTP/WS+SSE)

**Decision:** Bind the renderer to the runtime exclusively through Electron IPC (`ipcMain.handle` / `webContents.send`) defined by the `MainApi`/`MainEvents` contract — no loopback HTTP server, no WebSocket, no SSE.

**Context:** The prior architecture (`openhands_bober/standalone.py`) exposed a FastAPI loopback server with REST + WS (PTY) + SSE (artifact events). In Approach A everything is in one Electron process pair, so an HTTP hop between them is gratuitous.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| Electron IPC | No port binding/CORS/auth surface; structured-clone passes `Uint8Array` PTY frames natively; typed via one shared `MainApi` file | Electron-only (no remote browser client); must use `contextBridge` preload correctly |
| Loopback HTTP + WS + SSE | Reusable by a browser; matches `standalone.py` patterns directly | Two extra round-trip layers, a bound port to secure, manual reconnection/Last-Event-ID replay, serialisation of binary PTY frames to base64 |

**Rationale:** Checkpoint 1 names "local-first against the user's own checkout" and a custom desktop app for a solo builder as the PRIMARY constraint — there is no remote-browser consumer to justify a network surface, and an unauthenticated loopback port is an attack surface a desktop app should not open.

**Consequences:** `IpcBridge` and `IpcClient` are the only transport components; the prior WS-close-codes/SSE-replay logic collapses into `MainEvents` pushes plus `artifactEventsSince(seq)` ring-buffer replay.

**Risk:** If a future requirement adds a remote/web client, IPC is not reachable over the network and a thin HTTP adapter over `MainApi` must be added — the typed contract makes this mechanical but it is real new work.
