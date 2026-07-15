# ADR-4: Raw binary WebSocket frames for Claude PTY, JSON only for control

**Decision:** The `/ws/claude/:conversationId` endpoint transmits PTY stdout as raw binary WebSocket frames to the browser, and accepts JSON text frames from the browser only for `input` and `resize` control messages.

**Context:** Claude Code CLI emits ANSI-coded TTY output destined for xterm. JSON envelopes would force base64 encoding or escape-sequence escaping, inflating payload ~33% and risking corruption. Control messages are infrequent and structured.

**Options Considered:**

| Option | Pros | Cons |
|---|---|---|
| Binary out, JSON in (chosen) | Zero-copy PTY passthrough; correct ANSI handling; small payloads; matches xterm `write(Uint8Array)` API | Two frame types; server demuxes by `typeof event.data` |
| All-JSON both directions | Symmetric; single codec | Base64 ~33% inflation per PTY byte; escape-sequence bugs; CPU overhead |
| All-binary both directions | Symmetric; smallest payload | Need private binary control protocol for resize; reinvents structure |

**Rationale:** Frontend dependency lock (xterm v6 + addon-fit, no new transports) makes native `WebSocket` binary the natural fit; control traffic rare enough that JSON parse cost is irrelevant.

**Consequences:** ClaudeWebSocketHook checks `event.data instanceof ArrayBuffer` for output; server sends `bytes`/`text` accordingly. socket.io intentionally not used here — reserved for OpenHands existing event channel.

**Risk:** Intermediaries downgrading binary WS frames (some corp proxies) break the terminal. Mitigation: ClaudeHealthCheck exposes `/health` probe verifying binary roundtrip before mounting xterm; on failure surface diagnostic in status bar.
