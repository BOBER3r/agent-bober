# MCP-compliant transport in TokensaveMcpClient (initialize handshake + tools/call envelope)

**Contract:** sprint-spec-20260620-graph-tokensave-6-1-compat-1  ·  **Spec:** spec-20260620-graph-tokensave-6-1-compat  ·  **Completed:** 2026-06-20

## What this sprint added

This sprint rewrote `TokensaveMcpClient`'s wire transport to speak **standard MCP** to
`tokensave serve` **6.1.1**. The old client passively waited for the server to emit any first
stdout line as its "ready" signal and called tools by their bare method name — neither matches the
6.1.1 protocol, which is why `agent-bober onboard` failed with `tokensave serve handshake timed
out`. The client now drives a JSON-RPC **`initialize`** handshake (resolving health to `ready`
**only** on the correlated response id, then emitting a `notifications/initialized` notification),
issues every tool call through the **`tools/call`** envelope, and **unwraps** `result.content[].text`
into the real payload. The change is confined to the transport layer (`src/graph/mcp-client.ts`)
plus its test; the circuit breaker, health-state machine, concurrent-call id correlation, `stop()`
shutdown, stderr→debug routing, and early-exit reject are all preserved.

> **Not yet end-to-end.** This sprint fixes the *transport handshake* only. `GraphClient`
> (`src/graph/client.ts`) still carries a stale tool-name catalog (e.g. `semantic_search_nodes`)
> that does not match 6.1.1; that is **Sprint 2** of this spec. `agent-bober onboard` is therefore
> **not fully working after Sprint 1 alone** — the handshake now succeeds, but the higher-level
> graph queries still need the Sprint 2 tool-name fix.

## Public surface

The client's public method **signatures are unchanged** (`start()`, `stop()`, `call<T>(tool,
params)`, `health()`). What changed is the bytes on the wire and the shape `call()` returns.

- `TokensaveMcpClient.call<T>(tool, params)` (`src/graph/mcp-client.ts:194`) — now writes the MCP
  envelope `{ jsonrpc:"2.0", id, method:"tools/call", params:{ name: tool, arguments: params } }`
  (previously `{ method: tool, params }`) and returns **`unwrapMcpContent(result)`** rather than the
  raw JSON-RPC `result`. A JSON-RPC `error` response (via `handleResponse`) **or** an MCP result
  with `isError:true` rejects as a `makeGraphError("GRAPH_ERROR", …)` Error (`.reason ===
  "GRAPH_ERROR"`), so `client.ts`'s `toFailureResult` yields `GraphResult.ok=false`. The
  `queryTimeoutMs` timer (default 5000ms → `GRAPH_TIMEOUT`) and the pending-map id correlation are
  unchanged.
- `unwrapMcpContent(result)` (`src/graph/mcp-client.ts:79`, module-private) — pulls every
  `content[]` entry whose `type==="text"`, returns the **first** one that `JSON.parse`s, and falls
  back to the first text entry as a raw string when none parse. Throws `GRAPH_ERROR` first if
  `result.isError === true`. It deliberately **scans all** text entries (not just `content[0]`)
  because live `tokensave 6.1.1` may return a plain-text staleness **WARNING** as `content[0]` and
  the actual JSON payload as a later entry.
- `TokensaveMcpClient.spawnAndHandshake()` (`src/graph/mcp-client.ts:239`, private) — after spawning
  the child it **writes an `initialize` request** (`protocolVersion "2024-11-05"`, `capabilities {}`,
  `clientInfo { name:"agent-bober", version:"0" }`) reserving its id from the same `nextId` counter
  as `call()` (stored as the new private `handshakeId` field). The stdout handler resolves the
  handshake **only** when a response with `id === handshakeId` arrives — no longer on an arbitrary
  first line — then sets `healthState="ready"`, resolves, and writes the
  `notifications/initialized` notification before any `tools/call`. The early-exit-before-handshake
  reject, the line-buffered stdout parser, and the timeout reject are kept.
- `HANDSHAKE_TIMEOUT_MS` (`src/graph/mcp-client.ts:23`) — raised **1000 → 5000** to tolerate
  tokensave cold starts.

## How to use / how it fits

There is **no new user-facing command, flag, or config key.** This is an internal protocol fix
behind the existing graph engine. `TokensaveMcpClient` is owned by the graph subsystem
(`src/graph/`) and is spawned/managed by `pipeline-lifecycle.ts`, which reads `childPid` for its PID
file — both untouched. The first round-trip a real run makes is `initialize` → `notifications/
initialized`, after which `GraphClient.call("<tool>", args)` flows through the `tools/call`
envelope and gets a parsed object back via `unwrapMcpContent`. The contract's integration test
(`it.skipIf(!tokensaveAvailable)`) proves the round trip against the real binary: `start()` resolves
`health()==="ready"`, `call("tokensave_status", {})` returns a parsed status object, and `stop()`
shuts the child down. (`tokensave_status` replaced the stale `semantic_search_nodes` tool name in
the test.)

## Notes for maintainers

- **`unwrapMcpContent` scans all `content[]` text entries, not just `content[0]`.** This diverges
  from the literal "first text entry" wording in the contract assumptions, but it is **required**:
  live `tokensave_status` returns a staleness `WARNING:` string as `content[0]` and the JSON payload
  as a later entry. The generator flagged the divergence and the evaluator accepted it under
  criterion sc-1-7. If a future tokensave returns multiple JSON entries, this returns the **first**
  parseable one — revisit if the contract grows richer.
- **Handshake resolves only on the correlated id.** With a fake/server that ignores `initialize`,
  `start()` must now reject at ~`HANDSHAKE_TIMEOUT_MS` (5000ms) — it no longer resolves spuriously on
  any first stdout line. This is the behavioral crux of the sprint; do not relax it back to
  "resolve on first message".
- **`handshakeId` shares the `nextId` counter** so a handshake id can never collide with a tool-call
  id. The handshake response is `continue`d past `handleResponse` (it has no pending-map entry).
- **Scope.** Commit `1441890`: only `src/graph/mcp-client.ts` and `tests/graph/mcp-client.test.ts`.
  `GraphClient` (`client.ts`), `pipeline-lifecycle.ts`, `GraphFallback`, the sandbox, and
  `src/graph/types.ts` public shapes were explicit non-goals and untouched. The stale `GraphClient`
  tool-name catalog is fixed in **Sprint 2**. Full suite **2809 passed** (up from 2789;
  `tests/graph/mcp-client.test.ts` 20/20 including 4 real-binary integration tests); all 8 criteria
  (sc-1-1..sc-1-8) passed iteration 1, zero regressions.
