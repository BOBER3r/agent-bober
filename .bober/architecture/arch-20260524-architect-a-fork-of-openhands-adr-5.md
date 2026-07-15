# ADR-5: Server-Sent Events for artifact-event delivery to the frontend

**Decision:** Use a single Server-Sent Events stream at `GET /api/v1/bober/events` for `.bober/` artifact change notifications; reserve WebSocket exclusively for the Claude Code PTY bidirectional byte stream.

**Context:** Artifact events are strictly server→client, low-frequency (debounced 100ms, peak ~10/s), text-only JSON. The Claude PTY is bidirectional binary at keystroke rates. Conflating both onto WebSocket forces multiplexing two unrelated protocols.

**Options Considered:**

| Option | Pros | Cons |
|---|---|---|
| SSE (chosen) | Auto-reconnect with `Last-Event-ID` built into EventSource; HTTP/1.1 compatible; trivially proxied | Server→client only (fine — events are unidirectional); 6-conn-per-origin browser cap (irrelevant, we use 1) |
| Second WebSocket | Bidirectional (unused); binary-capable (unused) | Manual reconnect logic; binary downgrade risk; harder to reason about with PTY WS on same page |
| Long polling | Universally proxy-friendly | Extra latency per event; higher load with 100ms debounce ceiling |

**Rationale:** Checkpoint 1's <500ms p95 budget and 100ms watcher debounce comfortably met by SSE. Risk #4 (binary WS downgrade) only affects PTY socket; SSE is text-frame HTTP riding through any proxy. 6-conn cap moot at one stream per route.

**Consequences:** Frontend uses native `EventSource` (zero new dep) in `ArtifactEventHook`; backend uses `EventSourceResponse` from `sse-starlette`. 15s keep-alive comment frames prevent reverse-proxy timeout. `Last-Event-ID` enables crash-resume.

**Risk:** Buffering proxies (rare enterprise) deliver events in bursts at flush interval. Mitigation: documented in troubleshooting; not code-addressable without long-polling fallback.
