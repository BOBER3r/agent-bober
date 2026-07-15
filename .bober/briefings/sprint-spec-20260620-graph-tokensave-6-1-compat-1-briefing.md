# Sprint Briefing: MCP-compliant transport in TokensaveMcpClient (initialize handshake + tools/call envelope)

**Contract:** sprint-spec-20260620-graph-tokensave-6-1-compat-1
**Generated:** 2026-06-20T00:00:00Z

> Scope is TINY and surgical: exactly TWO files change — `src/graph/mcp-client.ts` and `tests/graph/mcp-client.test.ts`. Everything else (GraphClient/client.ts, types.ts, pipeline-lifecycle.ts, onboard.ts) is OUT of scope (Sprint 2 owns the tool-name remap). Preserve the circuit breaker, health states, id-correlation PendingMap, and stop() exactly.

---

## 0. Live-probed tokensave 6.1.1 wire shapes (GROUND TRUTH)

These were captured by piping JSON-RPC into the real `tokensave serve` on PATH. Build the transport to match THESE bytes.

### `initialize` response (id-correlated)
Request written: `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"agent-bober","version":"0"}}}`
Response (one line on stdout, **same id**):
```json
{"jsonrpc":"2.0","id":1,"result":{"capabilities":{"logging":{},"resources":{},"tools":{}},"instructions":"tokensave is a code-graph MCP server...","protocolVersion":"2024-11-05","serverInfo":{"name":"tokensave","version":"6.1.1"}}}
```
The handshake MUST resolve on `parsed.id === handshakeId`, NOT on "first line".

### `tools/call` success result — CRITICAL: content is a MULTI-ENTRY array
After `initialize` + a `{"jsonrpc":"2.0","method":"notifications/initialized"}` notification, a `tools/call` for `tokensave_status`:
Request: `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"tokensave_status","arguments":{}}}`
Response (line, **content has TWO text entries**):
```json
{"jsonrpc":"2.0","id":2,"result":{"content":[
  {"text":"WARNING: Index last synced 2h 42m ago. Run `tokensave sync` to update.","type":"text"},
  {"text":"{\n  \"active_branch\": \"bober/medical-team\",\n  \"db_size_bytes\": 20078592, ... }","type":"text"}
]}}
```
**PITFALL:** content[0] is a PLAIN-TEXT staleness WARNING (does NOT parse as JSON). content[1] is the JSON payload. A naive `content[0].text` + JSON.parse would return the warning STRING, not the parsed status. See §9 for the required unwrap strategy.

### Error shapes (two distinct kinds)
1. **JSON-RPC `error` member** (unknown tool / missing required arg) — this is what tokensave 6.1.1 actually emits:
```json
{"jsonrpc":"2.0","id":2,"error":{"code":-32603,"message":"tool execution failed: config error: unknown tool: tokensave_nonexistent_tool"}}
{"jsonrpc":"2.0","id":2,"error":{"code":-32603,"message":"tool execution failed: config error: missing required parameter: query"}}
```
This is ALREADY handled by `handleResponse` (mcp-client.ts:289-292) → rejects GRAPH_ERROR. Keep it.
2. **MCP `result.isError === true`** — the MCP spec's in-band tool-error shape. Probing didn't elicit it from tokensave (it prefers JSON-RPC errors), but sc-1-5 + the assumptions REQUIRE you handle it defensively in `unwrapMcpContent`: `if (result?.isError === true) throw makeGraphError("GRAPH_ERROR", text)`.

---

## 1. Target Files

### src/graph/mcp-client.ts (modify)

**Constant to bump (line 23):**
```ts
const HANDSHAKE_TIMEOUT_MS = 1_000;   // → 5_000
```

**Fields / constructor (lines 67-84):** `childPid` (public, read by pipeline-lifecycle), `child`, `healthState: EngineHealth`, `nextId=1`, `pending: Map<number,PendingCall>`, `restartTimestamps`, `stdoutBuf`, `stopping`. **You will ADD one private field**, e.g. `private handshakeId = 0;` (reserve the id of the in-flight initialize so the stdout handler can match it).

**`makeGraphError` helper (lines 58-63) — REUSE, do not redefine:**
```ts
function makeGraphError(reason: string, detail: string): Error {
  const err = new Error(`${reason}: ${detail}`);
  (err as Error & { reason: string; detail: string }).reason = reason;
  (err as Error & { reason: string; detail: string }).detail = detail;
  return err;
}
```

**`call()` (lines 156-194) — REPLACE the request literal (180-185) and wrap the resolved result.**
Current literal (WRONG for MCP — sends bare tool name as method):
```ts
const request: JsonRpcRequest = { jsonrpc: "2.0", id, method: tool, params };
```
Target literal (MCP tools/call envelope):
```ts
const request: JsonRpcRequest = {
  jsonrpc: "2.0", id, method: "tools/call",
  params: { name: tool, arguments: params },
};
```
KEEP exactly: the `broken`/`stopping`/`!ready` guards (157-163), `id = this.nextId++` (165), `timeoutMs` (166), the `setTimeout` GRAPH_TIMEOUT timer (169-172), `this.pending.set(id, …)` correlation (174-178), the stdin write try/catch (187-193).
The pending promise still resolves with the JSON-RPC `result` (via `handleResponse`). You must transform that resolved value with `unwrapMcpContent` BEFORE `call()` returns. Because the current `pending` resolve is wired straight to the Promise `resolve`, the cleanest approach is: keep `handleResponse` resolving the raw `result`, and in `call()` do `const result = await <that promise>; return unwrapMcpContent(result) as T;` — i.e. wrap the `new Promise` body so the resolver stores raw result, then unwrap. (See §8 sequence for the exact shape.)

**`spawnAndHandshake()` (lines 199-278) — REPLACE only the "resolve on first JSON line" block (262-269).**
KEEP: execa argv spawn (202-206, `reject:false`, argv array per ADR-10), `this.child`/`this.childPid`/`this.stdoutBuf=""` (208-210), stderr→`logger.debug` (213-215), `settled` flag + `handshakeTimer` reject (217-224), early-exit reject + `void this.onExit` (227-241), the line-buffered stdout parser scaffold (244-261, 275-276), and the id-correlation dispatch (271-274).
Current block to REMOVE (262-269):
```ts
// Handshake: accept any valid JSON-RPC 2.0 message ...
if (!settled) {
  clearTimeout(handshakeTimer);
  settled = true;
  this.healthState = "ready";
  resolve();
}
```
Target behavior:
1. Right after `this.child = child` (≈208), reserve `this.handshakeId = this.nextId++;` and WRITE the initialize request to `child.stdin`:
```ts
child.stdin?.write(JSON.stringify({
  jsonrpc: "2.0", id: this.handshakeId, method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {},
            clientInfo: { name: "agent-bober", version: "0" } },
}) + "\n");
```
2. In the stdout per-line handler, branch BEFORE the `typeof msg.id === "number"` dispatch:
```ts
if (!settled && typeof msg.id === "number" && msg.id === this.handshakeId) {
  clearTimeout(handshakeTimer);
  settled = true;
  this.healthState = "ready";
  resolve();
  child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  continue; // do not also feed the handshake response into handleResponse
}
if (typeof msg.id === "number") {
  this.handleResponse(msg as unknown as JsonRpcResponse);
}
```

**`handleResponse()` (lines 282-296) — UNCHANGED.** It resolves `(msg as JsonRpcSuccessResponse).result` and rejects JSON-RPC `error` as GRAPH_ERROR. That contract is exactly what `call()`/`unwrapMcpContent` rely on.

**Imports this file uses (13-17):** `execa`, `type Subprocess` (from `"execa"`), `type GraphSection` (`./types.js`), `type IncidentLog` (`./incidents.js`), `logger` (`../utils/logger.js`). All `.js` ESM specifiers + `import type`. No new imports needed.

**Imported by:** `src/graph/client.ts` (constructs `TokensaveMcpClient`, calls `.call<unknown>(tool, params)` at client.ts:208), `src/graph/pipeline-lifecycle.ts` (reads `childPid`, calls `start()`/`stop()`/`health()`). Do NOT touch either.

**Test file:** `tests/graph/mcp-client.test.ts` (exists — modify per §6).

---

### tests/graph/mcp-client.test.ts (modify)

The only test file. Structure: availability probe (16-29), `vi.mock("execa")` (33-43), `beforeEach`/`afterEach` tmp dir (49-56), `makeFakeSubprocess` factory (60-112), `makeIncidentLog` stub (116-120), 4 pure-logic describe blocks, 3 `it.skipIf` integration tests.

**`makeFakeSubprocess` (60-112):** accepts `opts.onWrite` (76-80 — captures every stdin chunk). The fake's `subprocess.stdin.write = (data) => stdin.push(data)` (85) feeds back into the `onWrite` PassThrough listener. `stdout` is a `PassThrough` you `.push()` lines onto. `emit("exit", code, signal)` fires the registered exit listeners (106-109).

**Edits required (see §6 for full detail):**
- Breaker test (132-145): the fake currently pushes `'{"jsonrpc":"2.0","method":"ready"}\n'` (137). Replace with an initialize-by-id reply (read the request id via `onWrite`).
- PendingMap test (208-243): wire `onWrite` to capture the initialize id and push back an initialize result (replace the line-227 `ready` push); change the two tool responses (236-237) so the unwrap yields `{result:"A"}`/`{result:"B"}` — i.e. wrap in `{result:{content:[{type:"text",text:JSON.stringify({result:"A"})}]}}`.
- Integration test (326): replace `"semantic_search_nodes"` with a real 6.1.1 tool name (`tokensave_status` or `tokensave_search`).
- ADD new unit tests for sc-1-2/1-3/1-4/1-5 (handshake-by-id resolves ready; initialize precedes notifications/initialized; tools/call envelope literal + JSON-vs-string unwrap; error + isError → GRAPH_ERROR).

---

## 2. Patterns to Follow

### Structured error tagging (the ONLY error constructor in this file)
**Source:** `src/graph/mcp-client.ts`, lines 58-63
```ts
function makeGraphError(reason: string, detail: string): Error {
  const err = new Error(`${reason}: ${detail}`);
  (err as Error & { reason: string; detail: string }).reason = reason;
  (err as Error & { reason: string; detail: string }).detail = detail;
  return err;
}
```
**Rule:** Every rejection from `call()` / handshake / unwrap MUST go through `makeGraphError("GRAPH_ERROR", …)` (or GRAPH_TIMEOUT / GRAPH_UNAVAILABLE) so `client.ts` `toFailureResult` (client.ts:231-237) reads `.reason` and yields `GraphResult.ok=false`. Never `throw new Error(...)` for a call-path failure. (The handshake-timeout reject at 222 and early-exit reject at 232 use bare `new Error` today — that is acceptable because those reject the `start()` promise, not a `call()`; the contract only requires call-path errors to be tagged. Leave them as-is unless you have reason not to.)

### Line-buffered JSON-RPC stdout parser
**Source:** `src/graph/mcp-client.ts`, lines 244-261
```ts
child.stdout?.on("data", (chunk: unknown) => {
  this.stdoutBuf += String(chunk);
  const lines = this.stdoutBuf.split("\n");
  this.stdoutBuf = lines.pop() ?? "";        // keep incomplete tail
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(trimmed) as Record<string, unknown>; }
    catch { logger.debug(`[tokensave-serve] non-JSON stdout: ${trimmed}`); continue; }
    // ... dispatch ...
  }
});
```
**Rule:** Keep this exact framing. Note the `instructions` field in tokensave's initialize result contains literal `'`/newline-escaped text but is still ONE JSON line — the parser handles it. Do not switch to byte-length framing.

### id-correlation PendingMap
**Source:** `src/graph/mcp-client.ts`, lines 174-178 (set) + 282-296 (resolve)
```ts
this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
// later, in handleResponse:
const entry = this.pending.get(msg.id);
if (!entry) return;
clearTimeout(entry.timer);
this.pending.delete(msg.id);
```
**Rule:** Concurrent `call()`s are demultiplexed purely by numeric `id`. The handshake id is reserved from the SAME `nextId` counter, so it can never collide with a call id. Never broadcast a response to all pending; always look up by id.

### ESM `.js` import + `import type`
**Source:** `src/graph/mcp-client.ts`, lines 13-17
```ts
import { execa } from "execa";
import type { Subprocess } from "execa";
import type { GraphSection } from "./types.js";
```
**Rule:** Relative imports carry the `.js` extension (NodeNext); type-only imports use `import type`. Unicode `── Section ──` headers (lines 19, 25, 56, 65, 90, …) are the file's section convention — keep new helpers under a matching header.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `makeGraphError` | `src/graph/mcp-client.ts:58` | `(reason: string, detail: string) => Error` | The ONLY structured-error factory; tags `.reason`/`.detail` for `toFailureResult`. Reuse for unwrap/isError rejections. |
| `logger` | `src/utils/logger.ts:87` (instance of `Logger` :9) | `logger.debug(msg, ...args)` etc. | stderr/non-JSON stdout routing. `debug` is gated on `verbose`. Already imported. |
| `handleResponse` | `src/graph/mcp-client.ts:282` | `(msg: JsonRpcResponse) => void` | Resolves/rejects a pending call by id; rejects JSON-RPC `error` as GRAPH_ERROR. Keep AS-IS. |
| `IncidentLog.append` | `src/graph/incidents.ts:45` | `(e: IncidentEvent) => Promise<void>` | Restart/breaker incident sink. Untouched this sprint. |
| `toFailureResult` (downstream) | `src/graph/client.ts:231` | `<T>(err) => GraphResult<T>` | Reads `.reason`/`.detail` off your error. Don't change it — just feed it tagged errors. |

**You WILL add ONE new helper:** `unwrapMcpContent(result)` — see §9. Searched `src/utils/`, `src/graph/` — no existing MCP content-unwrap helper exists, so creating it is correct, not duplication.

---

## 4. Prior Sprint Output

No prior sprints (`dependsOn: []`). This is Sprint 1 of `spec-20260620-graph-tokensave-6-1-compat`. Sprint 2 (separate, NOT yet built) will remap the stale `TOOL` catalog in `src/graph/client.ts:31-38` (`semantic_search_nodes` → `tokensave_search`, etc.). Do NOT pre-empt that here.

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` consulted for transport specifics; the binding rules are the contract's `assumptions` + `generatorNotes` (carry exact file:line guidance) and the inline doc-comments in `mcp-client.ts:1-11` describing the client's four responsibilities (one child per instance, PendingMap multiplex, 3-per-60s breaker, reject-in-flight-on-exit). Preserve all four.

### Architecture Decisions
- **ADR-10 (cited inline, mcp-client.ts:201):** spawn with an argv ARRAY, never a shell string — `execa(this.binary, ["serve"], { … })`. Keep.
- **GraphFailureReason union** (`src/graph/types.ts:50-55`): `"GRAPH_DISABLED" | "GRAPH_UNAVAILABLE" | "GRAPH_STALE" | "GRAPH_TIMEOUT" | "GRAPH_ERROR"`. `call()` only ever produces `GRAPH_UNAVAILABLE` (breaker), `GRAPH_ERROR` (not-ready / write-fail / json-rpc-error / isError / unwrap), `GRAPH_TIMEOUT` (query timer). Stay within these strings.

### Other Docs
- `package.json` scripts: `build` = `tsc`, `typecheck` = `tsc --noEmit`, `lint` = `eslint src/` (**lints `src/` ONLY — test-file lint is not gated, but keep tests clean anyway**), `test` = `vitest`. There is NO `vitest.config.*` (defaults).

---

## 6. Testing Patterns

### Unit Test Pattern
**Source:** `tests/graph/mcp-client.test.ts`
**Runner:** vitest. **Assertion style:** `expect(...).toBe/.toThrow/.rejects.toThrow`. **Mock approach:** `vi.mock("execa")` hoisted (lines 33-43) — `execa` is a `vi.fn()`; each test sets `(execa as unknown as Mock).mockReturnValueOnce(subprocess)` or `.mockImplementation(...)`. `vi.importActual` is used to keep `execaSync("--version")` real for the availability probe. **File naming:** `<name>.test.ts`. **Location:** `tests/graph/` (NOT co-located).

**Handshake-via-id template (NEW shape — the core change to the fake):**
```ts
const writes: string[] = [];
const { subprocess, stdout } = makeFakeSubprocess({ onWrite: (d) => writes.push(d) });
(execa as unknown as Mock).mockReturnValueOnce(subprocess);

const client = new TokensaveMcpClient(tmp, { enabled: true, queryTimeoutMs: 2_000 } as never, incidents as never);
const startPromise = client.start();

// Read the initialize request the client just wrote, reply by id:
await new Promise<void>((r) => setTimeout(r, 5));
const initReq = JSON.parse(writes.find((w) => w.includes('"initialize"'))!.trim());
stdout.push(JSON.stringify({
  jsonrpc: "2.0", id: initReq.id,
  result: { protocolVersion: "2024-11-05", serverInfo: { name: "tokensave", version: "6.1.1" }, capabilities: {} },
}) + "\n");
await startPromise;
expect(client.health()).toBe("ready");
// sc-1-3: the client must then have written notifications/initialized:
await new Promise<void>((r) => setTimeout(r, 5));
const idx = writes.findIndex((w) => w.includes('"initialize"'));
const nidx = writes.findIndex((w) => w.includes('notifications/initialized'));
expect(idx).toBeGreaterThanOrEqual(0);
expect(nidx).toBeGreaterThan(idx);
```

**tools/call envelope + unwrap template (sc-1-4):**
```ts
// after handshake above:
const callP = client.call<{ status: string }>("tokensave_status", {});
await new Promise<void>((r) => setTimeout(r, 5));
const toolReq = JSON.parse(writes.find((w) => w.includes('"tools/call"'))!.trim());
expect(toolReq).toMatchObject({ method: "tools/call", params: { name: "tokensave_status", arguments: {} } });
stdout.push(JSON.stringify({ jsonrpc: "2.0", id: toolReq.id,
  result: { content: [{ type: "text", text: JSON.stringify({ status: "ok" }) }] } }) + "\n");
expect(await callP).toEqual({ status: "ok" });            // JSON text → parsed object
// plain-text content → raw string:
//   text: "hello"  →  call() resolves "hello"
```

**Existing pure-logic tests that must pass UNCHANGED (sc-1-6):**
- Breaker rolling-window math (124-198) — pure `filter` math, mostly binary-free; the one that spawns (125-170) only needs its handshake stimulus updated (137).
- PendingMap correlation (202-243) — UPDATE the handshake push (227) to an initialize-by-id reply and wrap the two responses (236-237) as `{result:{content:[{type:"text",text:JSON.stringify({result:"A"})}]}}` so unwrap still yields `{result:"A"}`/`{result:"B"}`. Assertions at 241-242 stay.
- `health()==='starting'` before start (249-258) — UNCHANGED.
- `call() rejects GRAPH_ERROR when not ready` (260-270) — UNCHANGED (health is `starting`).
- `call() rejects GRAPH_UNAVAILABLE when broken` (272-284) — UNCHANGED.

### Integration test pattern (`it.skipIf(!tokensaveAvailable)`)
**Source:** `tests/graph/mcp-client.test.ts:289-376`
```ts
it.skipIf(!tokensaveAvailable)("start() resolves health='ready' in <2s", async () => {
  const client = new TokensaveMcpClient(tmp, { enabled: true, queryTimeoutMs: 5_000 } as never, incidents as never, "tokensave");
  const t0 = Date.now();
  await client.start();
  expect(Date.now() - t0).toBeLessThan(2_000);   // consider bumping budget if cold-start is slow
  expect(client.health()).toBe("ready");
  await client.stop();
});
```
**Selector/round-trip convention:** real binary, 4th constructor arg `"tokensave"`. Replace `client.call("semantic_search_nodes", { query: "test" })` (line 326) with a real 6.1.1 tool — e.g. `client.call("tokensave_status", {})` and assert the result is a parsed object (`expect(typeof res).toBe("object")` / `expect(res).toHaveProperty("node_count")`). Add/keep a round-trip assertion per sc-1-7.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/graph/client.ts` | `TokensaveMcpClient.call<unknown>(tool, params)` (client.ts:208) | medium | `call()` now returns the UNWRAPPED content payload (parsed JSON / string), no longer the raw `{content:[…]}`. client.ts post-processes the result with `raw as T` (runRaw, 226) / NodeRef filters — unwrapping is exactly what it expects downstream, but the stale `TOOL` names (client.ts:31-38) still won't match real tools until Sprint 2, so client.ts integration paths stay red until then (acceptable; not this sprint's gate). |
| `src/graph/pipeline-lifecycle.ts` | `childPid`, `start()`, `stop()`, `health()` | low | Public surface unchanged — keep `childPid` public, `health()` returning `EngineHealth`, `start()/stop()` signatures intact. |
| `tests/graph/mcp-client.test.ts` | `TokensaveMcpClient` internals + fake subprocess | high | THIS sprint rewrites the handshake stimulus + response wrapping here; it is a target file, not collateral. |

### Existing Tests That Must Still Pass
- `tests/graph/mcp-client.test.ts` — breaker math (124-198), PendingMap correlation (202-243), health-state transitions (248-285): all must stay green after the handshake-stimulus + response-wrap updates. The breaker/health assertions themselves do NOT change.
- Full suite (`vitest`) — per `evaluatorNotes`, pre-existing unrelated failures (e.g. cockpit-integration MCP E2E) may remain; introduce NO new failures. Any test that imports `TokensaveMcpClient` or `client.ts` indirectly must not regress.

### Features That Could Be Affected
- **Graph context pre-flight injection** (ADR-9, `preflightBudgets` in schema.ts:269-276) and **graph_* orchestrator tools** consume `GraphClient` → `TokensaveMcpClient.call`. Behavior is gated behind `graph.enabled` (default `false`, schema.ts:255) and the stale tool names, so live graph queries are already non-functional until Sprint 2 — your transport fix is a prerequisite, not a regression vector.

### Recommended Regression Checks
1. `npm run build` and `npm run typecheck` → zero errors.
2. `npx vitest run tests/graph/mcp-client.test.ts` → all pure-logic + updated integration tests green (integration skips if no binary; here the binary IS present, so they RUN).
3. `npm run lint` → zero errors (lints `src/` only; ensure `src/graph/mcp-client.ts` is clean — no `any`, no unused vars, ESM `.js` specifiers).
4. `npx vitest run` (full suite) → no NEW failures vs. baseline (cockpit-integration MCP E2E may be pre-failing).
5. `git status --porcelain` → ONLY `src/graph/mcp-client.ts` and `tests/graph/mcp-client.test.ts` modified.

---

## 8. Implementation Sequence

1. **`src/graph/mcp-client.ts` — bump constant.** Line 23: `HANDSHAKE_TIMEOUT_MS = 1_000` → `5_000`.
   - Verify: grep shows `5_000`; satisfies sc-1-6.
2. **`src/graph/mcp-client.ts` — add `private handshakeId` field** near the other private fields (≈73-77).
   - Verify: tsc has no unused-field error (it gets assigned in spawnAndHandshake).
3. **`src/graph/mcp-client.ts` — add `unwrapMcpContent` helper** under a `── MCP content unwrap ──` header (place near makeGraphError, ≈64). See §9 for the exact body.
   - Verify: typecheck; helper is referenced by `call()` (next step) so no unused-fn error.
4. **`src/graph/mcp-client.ts` — rewrite `spawnAndHandshake` handshake** (write `initialize` after `this.child=child`; resolve on `msg.id===handshakeId`; emit `notifications/initialized`; keep everything else 199-278).
   - Verify: a unit test where the fake replies to initialize by id → `start()` resolves + `health()==='ready'`; a fake that IGNORES initialize → `start()` rejects at ~5s (proves no spurious resolve). sc-1-2.
5. **`src/graph/mcp-client.ts` — rewrite `call()` envelope + unwrap** (tools/call literal; `await` pending result then `return unwrapMcpContent(result) as T`).
   - Verify: unit test asserts the exact wire envelope + JSON-vs-string unwrap + isError/error → GRAPH_ERROR. sc-1-4, sc-1-5.
6. **`tests/graph/mcp-client.test.ts` — update the fake's handshake stimulus** (breaker test :137 and PendingMap test :227) from the unsolicited `ready` push to an initialize-by-id reply read via `onWrite`.
   - Verify: those two tests pass with the new transport.
7. **`tests/graph/mcp-client.test.ts` — wrap tool responses** in the PendingMap test (:236-237) as `{result:{content:[{type:"text",text:JSON.stringify(payload)}]}}` so unwrap yields `{result:"A"}`/`{result:"B"}`; assertions (:241-242) unchanged.
   - Verify: concurrent-correlation test green.
8. **`tests/graph/mcp-client.test.ts` — add new unit tests** for sc-1-2 / sc-1-3 / sc-1-4 / sc-1-5 (handshake-by-id; initialize-before-notification ordering; envelope + unwrap; error + isError reasons).
   - Verify: all new tests green.
9. **`tests/graph/mcp-client.test.ts` — fix integration tests** (:326) to a real 6.1.1 tool (`tokensave_status`) and assert a parsed object round-trips; keep the `start() health='ready'` + `stop()` tests (bump the `<2s` budget if cold start needs it). sc-1-7.
   - Verify: with the real binary present, integration tests RUN and pass.
10. **Run full verification** — `npm run build`, `npm run typecheck`, `npx vitest run tests/graph/mcp-client.test.ts`, `npm run lint`, then `npx vitest run` + `git status --porcelain`.

---

## 9. Pitfalls & Warnings

- **content[] is multi-entry; content[0] is a staleness WARNING string.** The live `tokensave_status`/`tokensave_search` results return `content[0]` = `"WARNING: Index last synced …"` (NOT JSON) and `content[1]` = the JSON payload. The assumptions say "find the first `{type:'text'}` entry, JSON.parse, return raw string on catch." Taken literally that returns the warning STRING. RECOMMENDED `unwrapMcpContent` (robust to both single- and multi-entry content):
  ```ts
  function unwrapMcpContent(result: unknown): unknown {
    const r = result as { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
    const texts = (r?.content ?? []).filter((c) => c?.type === "text").map((c) => c.text ?? "");
    const joined = texts.join("");
    if (r?.isError === true) throw makeGraphError("GRAPH_ERROR", joined || "tool returned isError");
    // Prefer the first text entry that parses as JSON; fall back to the first text (raw string).
    for (const t of texts) { try { return JSON.parse(t); } catch { /* not json, keep looking */ } }
    return texts[0] ?? "";
  }
  ```
  This satisfies sc-1-4's "JSON.parse when JSON, raw string when prose" while surviving the leading-warning quirk. If you instead follow the literal "first text entry" reading, your `tokensave_status` integration assertion (sc-1-7, must round-trip a PARSED object) will FAIL because content[0] is prose. Flag this divergence-from-assumption in your commit if you keep the robust version.
- **tokensave emits JSON-RPC `error`, not `isError:true`, for bad tools/args** (probed: `{"error":{"code":-32603,"message":"…unknown tool…"}}`). That path is ALREADY handled by `handleResponse` (289-292). Still implement the `isError===true` branch in `unwrapMcpContent` for spec compliance (sc-1-5) — but don't expect the live binary to exercise it.
- **Do NOT resolve the handshake on any-first-line.** The current code (262-269) resolves on the first parseable line; the NEW contract requires resolving ONLY on `id===handshakeId`. A fake/server that emits an unrelated line first must NOT flip health to ready.
- **Reserve handshakeId from `this.nextId++`** (the same counter as call ids) so it never collides; then the `id===handshakeId` branch must `continue` (skip `handleResponse`) — otherwise `handleResponse` sees an id with no pending entry and harmlessly returns, but skipping is cleaner and avoids confusion.
- **`notifications/initialized` has NO `id`** (it is a notification). Write it AFTER `resolve()` so the client is `ready` before the first `tools/call`.
- **Don't break stop()/breaker/onExit.** `onExit` re-invokes `spawnAndHandshake` on restart (355) — your new handshake write runs again on every respawn, which is correct. `rejectAllPending`, the 3-per-60s rolling window (325-347), and SIGTERM→SIGKILL (122-144) stay byte-identical.
- **`npm run lint` only lints `src/`** — tsc still typechecks tests, so the test file must compile (no `any` leaks that break `--strict`); the `as never` casts already used in the test file (e.g. 217, 254) are the established escape hatch for the config arg — reuse that pattern, don't invent typed config fixtures.
- **Diff discipline:** touch ONLY the two target files. `client.ts` `TOOL` map (31-38), `types.ts`, `pipeline-lifecycle.ts`, `onboard.ts` are Sprint-2 / out-of-scope. `git status --porcelain` is an evaluator gate (sc-1-8).
