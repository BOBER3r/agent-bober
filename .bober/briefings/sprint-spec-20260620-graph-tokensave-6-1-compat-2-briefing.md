# Sprint Briefing: Remap GraphClient to the tokensave 6.1.1 tool catalog + verify onboard end-to-end

**Contract:** sprint-spec-20260620-graph-tokensave-6-1-compat-2
**Generated:** 2026-06-20T00:00:00Z

> Scope (from contract): rewrite the stale `TOOL` map + per-method result narrowing in
> `src/graph/client.ts` so all six methods call real tokensave 6.1.1 tools with verified
> params + result adapters, keep each method's external `GraphResult<T>` type stable, then
> verify `agent-bober onboard` writes 5 files via the live engine. Diff confined to
> `src/graph/client.ts` (+ `src/graph/types.ts` only if an adapter type is needed) and
> `tests/graph/client.test.ts`. **`onboard.ts` and `mcp-client.ts` are NOT touched.**

---

## 0. Live-probe results — EXACT tokensave 6.1.1 wire shapes (PROBED, not recalled)

Probed against `tokensave 6.1.1` (`/opt/homebrew/bin/tokensave`) via `tokensave serve` with the
MCP envelope (`initialize` → `notifications/initialized` → `tools/call`). For every tool below,
**Sprint-1's `unwrapMcpContent` returns the FIRST `content[].text` entry that JSON-parses** — which
is the JSON payload shown (a second `text` entry `tokensave_metrics: before=… after=…` is ignored
because it does not parse; for `tokensave_context` the payload is plain markdown so the raw string is
returned). So `this.mcpClient.call<unknown>(tool, params)` returns exactly the parsed object/array/string below.

| GraphClient method | 6.1.1 tool | required params | result top-level shape (after Sprint-1 unwrap) |
|---|---|---|---|
| `search` | `tokensave_search` | `query` (+ `limit`) | **JSON array** `[{file,id,kind,line,name,score,signature}]` |
| `query(callers_of)` | `tokensave_callers` | `node_id` (+`max_depth`) | **JSON array** `[{edge_kind,file,kind,line,name,node_id}]` |
| `query(callees_of)` | `tokensave_callees` | `node_id` (+`max_depth`,`resolve_dispatch`) | **JSON array** `[{dispatch_via_trait,edge_kind,file,kind,line,name,node_id}]` |
| `query(imports_of)` | `tokensave_file_dependents` | `file` | **JSON object** `{count, dependents: string[], file}` (dependents are FILE PATHS) |
| `query(tests_for)` | `tokensave_test_map` | (`file` or `node_id`) | **JSON object** `{coverage:[], covered_symbols, test_files:[], uncovered:[{file,id,line,name}]}` |
| `impact` | `tokensave_impact` | `node_id` (+`max_depth`) | **JSON object** `{edge_count, node_count, nodes:[{file,id,kind,line,name}]}` |
| `reviewContext` | `tokensave_context` | `task` | **plain-text markdown string** (NOT JSON — returned raw by unwrap) |
| `overview` | `tokensave_module_api` | `path` | **JSON object** `{path, public_symbol_count, symbols:[{file,id,kind,line,name,signature}]}` |
| `changes` | `tokensave_changelog` | `from_ref`, `to_ref` | **JSON object** `{changed_file_count, changed_files:[], files_not_indexed, from_ref, symbols_in_changed_files:[{file,id,kind,line,name,signature}]}` |

### Field renames the adapters MUST apply (6.1.1 → internal types)
- `name` → `NodeRef.symbol` / `SearchHit.node.symbol`
- `id` (search/impact/module_api/changelog rows) → `NodeRef.id`
- `node_id` (callers/callees rows) → `NodeRef.id`
- `file` → `NodeRef.file` (already correct name)
- `line` → `NodeRef.line` (already correct name)
- `kind` → `NodeRef.kind` BUT 6.1.1 emits kinds like `"method"`, `"file"`, `"constructor"`, `"field"`, `"trait"` that are NOT in the `NodeRef["kind"]` union (`"function" | "class" | "module" | "symbol"`). **Coerce unknown kinds to `"symbol"`** in the adapter to keep types stable.
- `score` (search only) → `SearchHit.score`; `signature` (search/module_api/changelog) → `SearchHit.snippet` (use `signature ?? ""`).

### Verified example payloads (literal, for test fixtures)

`tokensave_search` query "GraphClient":
```json
[
  { "file": "src/graph/client.ts", "id": "class:7afbea15…", "kind": "class", "line": 46, "name": "GraphClient", "score": 23.14, "signature": "class GraphClient" }
]
```

`tokensave_callers` node_id "function:c82e…":
```json
[ { "edge_kind": "calls", "file": "src/graph/mcp-client.ts", "kind": "method", "line": 139, "name": "call", "node_id": "method:7c20b9a8…" } ]
```

`tokensave_file_dependents` file "src/graph/types.ts":
```json
{ "count": 11, "dependents": ["src/graph/client.ts", "src/mcp/tools/graph.ts", …], "file": "src/graph/types.ts" }
```

`tokensave_test_map` file "src/graph/client.ts":
```json
{ "coverage": [], "covered_symbols": 0, "test_files": [], "uncovered": [ {"file":"src/graph/client.ts","id":"method:…","line":76,"name":"search"} ] }
```

`tokensave_impact` node_id "class:7afbea15…":
```json
{ "edge_count": 26, "node_count": 27, "nodes": [ {"file":"src/graph/client.ts","id":"class:7afbea15…","kind":"class","line":46,"name":"GraphClient"}, … ] }
```

`tokensave_module_api` path "src/graph":
```json
{ "path": "src/graph", "public_symbol_count": 122, "symbols": [ {"file":"src/graph/artifact-store.ts","id":"class:…","kind":"class","line":7,"name":"GraphArtifactStore","signature":"class GraphArtifactStore"} ] }
```

`tokensave_changelog` from_ref "HEAD~2" to_ref "HEAD":
```json
{ "changed_file_count": 4, "changed_files": ["src/graph/mcp-client.ts", …], "files_not_indexed": [], "from_ref": "HEAD~2", "symbols_in_changed_files": [ {"file":"docs/sprints/README.md","id":"module:…","kind":"module","line":0,"name":"Sprint records","signature":"# Sprint records"} ] }
```

`tokensave_context` task "how does GraphClient call tokensave" → a plain markdown STRING starting `## Code Context\n**Query:** …` (no JSON). `unwrapMcpContent` returns it verbatim — perfect for `GraphResult<string>`.

---

## 1. Target Files

### src/graph/client.ts (modify)

**The TOOL map to REPLACE (lines 28-38):**
```typescript
// Tokensave MCP tool catalog → GraphClient method mapping.
// Names match the canonical tool catalog (per the project CLAUDE.md);
// no `tokensave_` prefix.
const TOOL = {
  search: "semantic_search_nodes",      // → "tokensave_search"
  query: "query_graph",                 // → per-pattern switch (see §2 query adapter)
  impact: "get_impact_radius",          // → "tokensave_impact"
  reviewContext: "get_review_context",  // → "tokensave_context"
  overview: "get_architecture_overview",// → "tokensave_module_api"
  changes: "detect_changes",            // → "tokensave_changelog"
} as const;
```
Replace with the real names AND fix the comment (it now lies — 6.1.1 DOES use the `tokensave_` prefix).

**The six methods to re-narrow (lines 77-115)** — each currently casts `raw` straight to its return type, which only worked because the old engine returned pre-adapted shapes. Replace each narrow callback with an adapter (see §2):
```typescript
async search(q: string, opts?: SearchOpts): Promise<GraphResult<SearchHit[]>> {
  return this.runWithSandbox(TOOL.search, { query: q, ...opts }, (raw) => {
    const hits = (raw as SearchHit[]).filter((h) => this.keepNode(h.node, "search"));   // ← raw is now SearchRow[], adapt first
    return hits;
  });
}
async query(pattern: QueryPattern, target: NodeRef): Promise<GraphResult<NodeRef[]>> {
  return this.runWithSandbox(TOOL.query, { pattern, target }, (raw) => {               // ← single tool no longer exists; switch by pattern
    return (raw as NodeRef[]).filter((n) => this.keepNode(n, "query"));
  });
}
async impact(target: NodeRef | string): Promise<GraphResult<ImpactReport>> {
  return this.runWithSandbox(TOOL.impact, { target }, (raw) => {                       // ← raw is {nodes:[…]}, build ImpactReport
    const report = raw as ImpactReport;
    return { root: report.root, affected: report.affected.filter(…), testsAffected: report.testsAffected.filter(…) };
  });
}
async reviewContext(nodes: NodeRef[]): Promise<GraphResult<string>> {
  return this.runRaw<string>(TOOL.reviewContext, { nodes });                            // ← param must be { task: string } for tokensave_context
}
async overview(): Promise<GraphResult<string>> {
  return this.runRaw<string>(TOOL.overview, {});                                        // ← param must be { path: "src" }; raw is JSON → stringify/summarize
}
async changes(since?: string): Promise<GraphResult<NodeRef[]>> {
  return this.runWithSandbox(TOOL.changes, { since }, (raw) => {                        // ← param must be { from_ref, to_ref }; adapt symbols_in_changed_files
    return (raw as NodeRef[]).filter((n) => this.keepNode(n, "changes"));
  });
}
```

**DO NOT TOUCH these — they are load-bearing and correct (sc-2-6):**
- `runWithSandbox` (187-222): `GRAPH_DISABLED`/`GRAPH_UNAVAILABLE`/`restarting` short-circuits (192-202), staleness, timing, `toFailureResult`. The call site `await this.mcpClient.call<unknown>(tool, params)` (208) is UNCHANGED — Sprint 1 made `call()` return the unwrapped payload.
- `keepNode` sandbox filter (249-260) + `logSandboxDrop` (262-273).
- `toFailureResult` (231-238), `checkStaleness` (241-246), `prefetch`/`dispatch` (117-181), `markFresh`/`hintFor`.

**Imports this file uses:** types from `./types.js` (`SearchHit, NodeRef, ImpactReport, GraphResult, GraphSection, FallbackHint, GraphFailureReason, PrefetchSpec, StalenessVerdict`), `sandboxNodePath` from `./sandbox.js`, `TokensaveMcpClient`/`GraphArtifactStore`/`GraphFallback`/`IncidentLog` (type-only).

**Imported by (sc-2-6 — must not break):**
- `src/cli/commands/onboard.ts:21` — calls `search()` 5× (the E2E-critical path).
- `src/cli/commands/impact.ts:23,160-161` — calls `impact(target: string)` and `query("tests_for", targetRef)` where `targetRef.id = target` (a raw symbol/file string).
- `src/mcp/tools/graph.ts` — wraps all 6 methods (tested by `tests/mcp/graph-tools.test.ts`, which mocks GraphClient — UNAFFECTED by internal adapter changes).
- `src/graph/pipeline-lifecycle.ts:212` — holds a `GraphClient` (out of scope; signatures unchanged so safe).

**Test file:** `tests/graph/client.test.ts` (EXISTS, 504 lines — **MUST be updated**, see §1 below + §6).

---

### src/graph/types.ts (modify ONLY IF a new adapter type is genuinely needed)

`SearchHit`, `NodeRef`, `ImpactReport`, `GraphResult`, `NodeRef["kind"]` union live here (lines 59-77).
**Per contract assumption + sc-2-7: do the field renaming INSIDE client.ts adapters; only add to types.ts if you introduce an internal row type.** Cleanest: define the raw-row interfaces (`TsSearchRow`, `TsEdgeRow`, etc.) as `private`/local `type` aliases inside `client.ts` so the diff stays in one file. Touch types.ts only if you prefer to export them.

---

### tests/graph/client.test.ts (modify — NOT create; file already exists)

**This is the trap.** The existing tests mock `mcpClient.call` to return ALREADY-ADAPTED shapes, which only passed because the old engine pre-adapted. After you move adapters into client.ts, these mocks feed the wrong shape. You MUST update the `callImpl` fixtures to return RAW 6.1.1 shapes so they flow through the new adapters:
- `search` happy path (90-108): currently returns `[{node:{…},score,snippet}]` → change to `[{file,id,kind,line,name,score,signature}]`.
- `query` (134-145): returns `[{id,kind,file,line,symbol}]` → change to `[{file,kind,line,name,node_id,edge_kind}]`.
- `impact` (147-162): returns `{root,affected,testsAffected}` → change to `{node_count,edge_count,nodes:[{file,id,kind,line,name}]}`.
- `changes` (122-132): returns `[{…symbol…}]` → change to `{changed_files,symbols_in_changed_files:[{file,id,kind,line,name}]}` (adapter reads `symbols_in_changed_files`).
- **Sandbox tests (245-344)**: currently return `[{node:{…file:"/etc/passwd"…}}]` (already-adapted SearchHit). Update to the RAW `tokensave_search` row shape `[{file:"/etc/passwd",id,kind,line,name,score,signature}]` so the adapter builds the SearchHit and `keepNode` still drops it. **The sandbox-drop assertion (`event:"sandbox-drop", file:"/etc/passwd"`) MUST still pass.**
- **`prefetch` "all ops dispatch" test (381-406)**: its `callImpl` switches on OLD tool names `get_architecture_overview`/`get_review_context`/`get_impact_radius` (386-390) AND returns adapted shapes — update both the tool-name strings (to `tokensave_module_api`/`tokensave_context`/`tokensave_impact`) and the returned shapes.
- Failure tests (176-241), staleness (411-459), disabled/broken (463-503) need NO shape change (they throw or short-circuit before the adapter).

---

## 2. Patterns to Follow

### Pattern: per-method adapter inside the narrow callback
**Source:** `src/graph/client.ts`, lines 90-101 (the impact method already demonstrates building a structured return inside `narrow`):
```typescript
async impact(target: NodeRef | string): Promise<GraphResult<ImpactReport>> {
  return this.runWithSandbox(TOOL.impact, { target }, (raw) => {
    const report = raw as ImpactReport;
    return {
      root: report.root,
      affected: report.affected.filter((n) => this.keepNode(n, "impact")),
      testsAffected: report.testsAffected.filter((n) => this.keepNode(n, "impact")),
    };
  });
}
```
**Rule:** Build/rename the result INSIDE the `narrow` callback, run `keepNode` on every NodeRef, return the existing type. The `narrow` signature is `(raw: unknown) => T` (line 190) — cast `raw` to the raw 6.1.1 row type, map to internal type, filter.

### Pattern: a NodeRef-building adapter from a 6.1.1 row
**Source (proof of the target shape):** `src/graph/types.ts:59-71` (`NodeRef` + `SearchHit`). Recommended helper inside client.ts:
```typescript
function toNodeRef(row: { id?: string; node_id?: string; name: string; file: string; line: number; kind?: string }): NodeRef {
  return {
    id: row.id ?? row.node_id ?? "",
    kind: NODE_KINDS.has(row.kind ?? "") ? (row.kind as NodeRef["kind"]) : "symbol",
    file: row.file,
    line: row.line,
    symbol: row.name,
  };
}
```
**Rule:** `name→symbol`, `id ?? node_id → id`, coerce unknown `kind` to `"symbol"` (the union is only `function|class|module|symbol`).

### Pattern: `imports_of` / `tests_for` produce file-only NodeRefs
`tokensave_file_dependents.dependents` is `string[]` of file paths; `tokensave_test_map.test_files` is also file paths. There is no symbol/line/id for these. Build a synthetic NodeRef per path: `{ id: path, kind: "module", file: path, line: 0, symbol: path }`. **`keepNode` only requires `node.file` to be in-sandbox** (client.ts:249-260), so these still pass the filter. For `tests_for`, prefer `test_files` (the actual test files); if empty, fall back to `coverage`/`uncovered` symbol rows via `toNodeRef`.

### Pattern: NodeRef union is `function|class|module|symbol`
**Source:** `src/graph/types.ts:60` — `kind: "function" | "class" | "module" | "symbol";`. 6.1.1 emits `method`, `file`, `constructor`, `field`, `trait`, etc. → coerce to `"symbol"`.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---|---|---|---|
| `sandboxNodePath` | `src/graph/sandbox.ts` (imported `client.ts:26`) | `(projectRoot, file) => { ok: boolean; … }` | Validate a NodeRef.file is inside projectRoot; already called by `keepNode`. Do NOT re-implement path checks. |
| `keepNode` | `src/graph/client.ts:249-260` | `(node: NodeRef \| undefined, source: string) => boolean` | The single sandbox chokepoint — call it on every adapted NodeRef. Keep it as-is. |
| `unwrapMcpContent` | `src/graph/mcp-client.ts:79-100` | `(result: unknown) => unknown` | Sprint-1: returns first JSON-parsing `content[].text` (or raw text). You consume its OUTPUT via `call()`; do NOT touch it. |
| `makeGraphError` | `src/graph/mcp-client.ts:58-63` | `(reason, detail) => Error` (sets `.reason`/`.detail`) | Error tagging consumed by `toFailureResult` (client.ts:231-238). Out of scope. |
| `toFailureResult` | `src/graph/client.ts:231-238` | `<T>(err) => GraphResult<T>` | Converts tagged errors to `ok:false`. Reuse — do not duplicate try/catch logic. |
| `assertNever` | `src/graph/types.ts:133-135` | `(x: never) => never` | Exhaustiveness in the `query()` pattern switch `default:` case. Use it. |
| `deriveSlug` | `src/cli/commands/impact.ts:52` | `(target: string) => string` | (impact CLI only; not needed here, listed so you don't reinvent.) |
| `OnboardingComposer.render/writeAll` | `src/graph/onboarding-composer.ts` | render PURE; writeAll preserves above `MARKER`, replaces below | onboard.ts uses these — unchanged. Empty-state strings: "No hotspots detected in this codebase." (171), "_No modules found._" (143), "_No public API symbols._" (151). |

**Utilities reviewed:** `src/graph/` (sandbox, fallback, incidents, artifact-store), `src/utils/` (fs, logger). No new util needed — add only local row→NodeRef mappers inside client.ts.

---

## 4. Prior Sprint Output

### Sprint 1 (commit 1441890): MCP transport fix in src/graph/mcp-client.ts
**Changed:** `call(tool, params)` (mcp-client.ts:194-235) now sends the `tools/call` envelope `{method:"tools/call", params:{name:tool, arguments:params}}` and RETURNS `unwrapMcpContent(rawResult)` — i.e. the JSON-parsed payload from `result.content[].text`, scanning past a leading non-JSON `WARNING`/`tokensave_metrics` entry (mcp-client.ts:79-100).
**Connection to this sprint:** GraphClient's call site `await this.mcpClient.call<unknown>(tool, params)` (client.ts:208) is UNCHANGED. You only change (1) the tool NAMES in `TOOL`, (2) the `params` each method passes, (3) the `narrow` adapter that maps the returned payload to the method's type. The unwrap shape is exactly the §0 "after Sprint-1 unwrap" column: a JSON array, a JSON object, or (for `tokensave_context`) a raw markdown string.

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` consulted for this sprint beyond the in-file ADR comments. Key in-file contracts: **ADR-3** (client.ts:1-9 header) — every method returns `GraphResult<T>` and NEVER throws for expected failures; callers branch on `.ok`. The sandbox post-filter is a single chokepoint (`keepNode`). **ADR-10** — `tokensave serve` spawned without a shell (mcp-client.ts:242). Preserve both.

### Architecture Decisions
`.bober/architecture/arch-20260524-port-code-review-graph-architecture.md` §Data Model is the source of truth for `NodeRef`/`SearchHit`/`ImpactReport` (mirrored in types.ts:1-2,57). Do not deviate from those field names — adapters must conform incoming 6.1.1 data TO these types.

### Other Docs
Project CLAUDE.md historically claimed tokensave tools had "no `tokensave_` prefix" — that is WRONG for 6.1.1 (the live `tools/list` shows every tool prefixed `tokensave_`). Fix the stale comment at client.ts:29-30.

---

## 6. Testing Patterns

### Unit Test Pattern (the file you update)
**Source:** `tests/graph/client.test.ts:24-108` (mock MCP + happy-path search).
```typescript
function makeMockMcp(opts: {
  callImpl?: (tool: string, params: unknown) => Promise<unknown>;
  health?: "starting" | "ready" | "restarting" | "broken";
} = {}): TokensaveMcpClient {
  return {
    call: vi.fn().mockImplementation(opts.callImpl ?? (async () => [])),
    health: vi.fn().mockReturnValue(opts.health ?? "ready"),
    start: vi.fn(), stop: vi.fn(), childPid: 12345,
  } as unknown as TokensaveMcpClient;
}
// happy-path search assertion (lines 99-107):
const r = await client.search("foo");
expect(r.ok).toBe(true);
if (r.ok) { expect(r.backend).toBe("mcp"); expect(r.data[0]!.node.file).toBe("src/foo.ts"); }
```
**Runner:** vitest. **Assertion style:** `expect`. **Mock approach:** `vi.fn().mockImplementation` on `mcpClient.call` (the fake serve — return a RAW 6.1.1 payload per tool). **File naming / location:** co-located under `tests/graph/`, `*.test.ts`.

**New/updated test fixtures must return RAW 6.1.1 payloads (the §0 shapes), e.g.:**
```typescript
// search → tokensave_search row
const mcp = makeMockMcp({ callImpl: async () =>
  [{ file: "src/foo.ts", id: "function:1", kind: "function", line: 1, name: "foo", score: 0.9, signature: "function foo()" }] });
const r = await client.search("foo");
if (r.ok) expect(r.data[0]!.node.symbol).toBe("foo");   // proves name→symbol rename

// query(callers_of) → tokensave_callers row
callImpl: async () => [{ edge_kind:"calls", file:"src/r.ts", kind:"method", line:5, name:"r", node_id:"method:9" }]
// → expect data[0].node.id === "method:9", data[0].node.symbol === "r"

// impact → tokensave_impact object
callImpl: async () => ({ node_count:2, edge_count:1,
  nodes:[{file:"src/root.ts",id:"class:1",kind:"class",line:1,name:"Root"},
         {file:"src/a.ts",id:"function:2",kind:"function",line:2,name:"a"}] })
// → expect data.root + data.affected populated, all sandbox-kept

// sandbox-drop (raw search row with out-of-root file)
callImpl: async () => [{ file:"/etc/passwd", id:"x", kind:"function", line:1, name:"evil", score:1, signature:"" },
                       { file:"src/foo.ts", id:"y", kind:"function", line:1, name:"foo", score:0.5, signature:"" }]
// → r.data.length === 1, incidents.append called with {event:"sandbox-drop", file:"/etc/passwd"}
```

### E2E Test Pattern
No Playwright in this repo. The E2E is a CLI run (sc-2-4):
```bash
npm run build
node dist/cli/index.js onboard
# assert: stdout has "Starting graph engine..." then NO "handshake timed out";
# exit 0; 5 files under .bober/onboarding/ have mtime newer than run start;
# hotspots.md and architecture-overview.md contain >=1 real symbol row (not the empty-state text).
```
If the `tokensave` binary is absent the evaluator SKIPS sc-2-4 (it is present here: `/opt/homebrew/bin/tokensave`, v6.1.1).

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|---|---|---|---|
| `src/cli/commands/onboard.ts` | `GraphClient.search` | **high** | search() must return real SearchHit[] with `node.symbol/file/line` so hotspots.md + architecture-overview.md are non-empty (sc-2-5). |
| `src/cli/commands/impact.ts` | `GraphClient.impact(string)`, `query("tests_for", ref)` | medium | impact() now calls `tokensave_impact` (needs `node_id`); it passes a raw symbol string as the node_id (best-effort). tests_for now → `tokensave_test_map`. Live `agent-bober impact` may return sparse results for non-hash targets, but must NOT crash (ADR-3 never-throw). |
| `src/mcp/tools/graph.ts` | all 6 GraphClient methods | low | Mocks GraphClient — internal adapter changes are invisible. `tests/mcp/graph-tools.test.ts` stays green. |
| `src/graph/pipeline-lifecycle.ts` | holds GraphClient | low | Signatures unchanged → no effect. |

### Existing Tests That Must Still Pass
- `tests/graph/client.test.ts` — **you are editing this**; after fixture updates all 30+ cases (happy path, failure reasons, sandbox drop, prefetch, staleness, disabled/broken) MUST pass. The sandbox-drop assertions and the `GRAPH_DISABLED`/`GRAPH_UNAVAILABLE` short-circuit assertions are the regression guards for sc-2-6.
- `tests/mcp/graph-tools.test.ts` — mocks GraphClient (does NOT exercise adapters); must stay green untouched.
- `tests/graph/mcp-client.test.ts` — Sprint-1's transport tests; out of scope, must stay green.
- `tests/graph/cli.test.ts`, `tests/graph/onboarding-composer.test.ts` — onboard/composer tests; unchanged code path → stay green.

### Features That Could Be Affected
- **`agent-bober onboard`** — shares `GraphClient.search`; verify hotspots.md + architecture-overview.md render real rows (E2E, sc-2-4/sc-2-5).
- **`agent-bober impact <target>`** — shares `impact()` + `query("tests_for")`; verify it does not throw (run it once manually if time permits).

### Recommended Regression Checks (run AFTER implementation)
1. `grep -rn 'semantic_search_nodes\|query_graph\|get_impact_radius\|get_review_context\|get_architecture_overview\|detect_changes' src/graph/` → **zero hits** (sc-2-2).
2. `npm run build && npm run typecheck` → zero errors (sc-2-1).
3. `npx vitest run tests/graph/client.test.ts tests/mcp/graph-tools.test.ts` → all green (sc-2-3, sc-2-6).
4. `npm run lint` → zero errors (sc-2-7).
5. `node dist/cli/index.js onboard` → no "handshake timed out", 5 files written, then `grep -c "src/" .bober/onboarding/hotspots.md` > 0 and architecture-overview.md not showing "_No modules found._"/"_No public API symbols._" (sc-2-4, sc-2-5).
6. `git status --porcelain` → only `src/graph/client.ts` (+ maybe `src/graph/types.ts`) and `tests/graph/client.test.ts`; **`onboard.ts` NOT in the diff** (sc-2-7).

---

## 8. Implementation Sequence

1. **src/graph/client.ts — rewrite `TOOL` (28-38)** to the 9 real tool names you need: `search→"tokensave_search"`, `impact→"tokensave_impact"`, `reviewContext→"tokensave_context"`, `overview→"tokensave_module_api"`, `changes→"tokensave_changelog"`, plus the 4 query tools (`"tokensave_callers"`, `"tokensave_callees"`, `"tokensave_file_dependents"`, `"tokensave_test_map"`) — either as 4 extra keys on `TOOL` or a `QUERY_TOOL` sub-map. Fix the stale "no prefix" comment.
   - Verify: `grep` shows zero stale names in `src/graph/`.
2. **Add local row types + a `toNodeRef` helper** (kinds-coercion + name/node_id renames). Add a `NODE_KINDS = new Set(["function","class","module","symbol"])`.
   - Verify: `tsc --noEmit` compiles the helper.
3. **Rewrite `search()` (77-82)** — params `{ query: q, limit: opts?.limit }`; adapter maps each `tokensave_search` row → `SearchHit{ node: toNodeRef(row), score: row.score, snippet: row.signature ?? "" }`, then `keepNode`. (Post-filter by `opts.kind` only if provided — tool has no kind param.)
   - Verify: client.test.ts search happy-path passes with the raw-row fixture.
4. **Rewrite `query()` (84-88)** — switch on `pattern`: `callers_of`→`tokensave_callers {node_id: target.id}`; `callees_of`→`tokensave_callees {node_id: target.id}`; `imports_of`→`tokensave_file_dependents {file: target.file}` (adapt `dependents: string[]` → synthetic file NodeRefs); `tests_for`→`tokensave_test_map {file: target.file}` (adapt `test_files`/`coverage`). `default: assertNever(pattern)`. Each branch returns `NodeRef[]` filtered by `keepNode`.
   - Verify: client.test.ts query(callers_of) passes.
5. **Rewrite `impact()` (90-101)** — param `{ node_id: typeof target === "string" ? target : target.id }`; adapter: `root = nodes[0]` (mapped), `affected = nodes.slice(1).map(toNodeRef)`, `testsAffected = nodes.filter(n => /test|spec/.test(n.file))` (or `[]`); filter all by `keepNode`. `root` may be out-of-sandbox (informational, per existing comment line 94).
   - Verify: client.test.ts impact passes with `{nodes:[…]}` fixture.
6. **Rewrite `reviewContext()` (103-105)** — param `{ task: nodes.map(n => n.symbol).join(", ") }` (or a short NL string); raw is a markdown string → `runRaw<string>` returns it directly.
   - Verify: tsc + reviewContext happy-path (`callImpl: async () => "context text"`) passes.
7. **Rewrite `overview()` (107-109)** — param `{ path: "src" }`; raw is `{path, public_symbol_count, symbols}`. Adapter: stringify a summary (e.g. `JSON.stringify(raw)` or a formatted list). Since `runRaw` does no adaptation, either switch overview to `runWithSandbox<string>(TOOL.overview, {path:"src"}, raw => summarize(raw))` OR keep `runRaw` and JSON.stringify. Keep the `string` return type.
   - Verify: overview test — note the existing test feeds a string; update its fixture to `{path,public_symbol_count,symbols:[]}` and assert the stringified output, OR keep returning a string and adjust.
8. **Rewrite `changes()` (111-114)** — param `{ from_ref: since ?? "HEAD~1", to_ref: "HEAD" }`; adapter maps `symbols_in_changed_files` → `NodeRef[]` via `toNodeRef`, filter by `keepNode`.
   - Verify: changes test passes with changelog-object fixture.
9. **Update `tests/graph/client.test.ts`** — replace all `callImpl` fixtures with raw 6.1.1 shapes (§1 list), fix the prefetch tool-name switch (386-390) and the GRAPH_TIMEOUT detail string (215, optional). Keep all assertions; only the input shapes change.
   - Verify: `npx vitest run tests/graph/client.test.ts` all green.
10. **Run full verification** — `npm run build`, `npm run typecheck`, `npm run lint`, `npx vitest run tests/graph/ tests/mcp/`, then the E2E: `node dist/cli/index.js onboard` and inspect hotspots.md + architecture-overview.md for real rows.

---

## 9. Pitfalls & Warnings

- **The existing `tests/graph/client.test.ts` will silently break** if you move adapters into client.ts without updating its `callImpl` fixtures (they currently return pre-adapted shapes). This is the #1 failure mode for this sprint — update fixtures to RAW 6.1.1 shapes (§1). Also fix the `prefetch` test's tool-name switch (lines 386-390) and the stale `semantic_search_nodes` string in the GRAPH_TIMEOUT detail (line 215).
- **`tokensave_callers`/`callees`/`impact` require `node_id`, NOT a symbol name.** `query()`'s `target` NodeRef and `impact()`'s string come from callers as raw symbol/file strings (impact.ts:150-156 sets `id: target`). Pass `target.id` as `node_id` best-effort; do not try to resolve hashes — the sprint's correctness is verified via fake-serve fixtures (sc-2-3) and onboard uses only `search()` (sc-2-5). Live `impact` CLI may return sparse data for non-hash targets but must not throw.
- **`tokensave_context` returns plain markdown, not JSON.** `unwrapMcpContent` returns it as a raw string (its JSON.parse fails, so it falls to the `texts[0]` branch). Perfect for `reviewContext()`'s `GraphResult<string>` — do NOT try to JSON.parse it in the adapter.
- **The `kind` union mismatch is real and will fail typecheck** if you cast 6.1.1 `kind` straight onto `NodeRef.kind`. 6.1.1 emits `method`/`file`/`constructor`/`field`/`trait`. Coerce unknown kinds to `"symbol"` (§2 `toNodeRef`).
- **`tokensave_file_dependents.dependents` and `test_map.test_files` are `string[]` (file paths), not node objects.** Build synthetic file NodeRefs (`line:0`, `kind:"module"`, `symbol:path`). `keepNode` passes them since they have a valid in-sandbox `file`.
- **Do NOT change the `runWithSandbox` call site or `unwrapMcpContent`** — Sprint 1 owns the transport; `call()` already returns the unwrapped payload. Your changes live entirely in `TOOL` + the `narrow` callbacks + each method's `params`.
- **`dist/` is generated** — don't edit `dist/graph/client.js`; run `npm run build` to regenerate before the E2E.
- **Keep the diff confined (sc-2-7):** `onboard.ts` must NOT appear in `git status`. If you feel tempted to "fix" onboard's search-based path, STOP — it's an explicit nonGoal; search() returning real SearchHit[] is all onboard needs.
- **`overview()` uses `runRaw` (no narrow)** — `runRaw` casts `raw as T` with no adaptation. Since `tokensave_module_api` returns an OBJECT but `overview` must return a STRING, you must either switch overview to `runWithSandbox<string>` with a stringify adapter, or JSON.stringify inside a thin wrapper. A bare `runRaw<string>` would return an object cast to string → wrong type at runtime. Same caution applies to `reviewContext` (that one IS a string from the engine, so `runRaw<string>` is fine there).
