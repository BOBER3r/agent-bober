# Sprint Briefing: GraphBackend interface + extract TokensaveBackend (tokensave byte-identical)

**Contract:** sprint-spec-20260726-graph-backend-choice-1
**Generated:** 2026-07-27T00:00:00Z

> PURE REFACTOR. Same inputs -> same outputs. The `tokensave` path must stay byte-identical: every existing assertion in `tests/graph/client.test.ts` passes UNCHANGED, only the construction gains an injected `TokensaveBackend`. Do NOT change any public signature, the `GraphResult` union, or `NodeRef`/`SearchHit`/`ImpactReport`.

---

## 1. Target Files

### src/graph/client.ts (modify) — the heart of this sprint

This file currently owns BOTH the cross-cutting orchestration (stays) AND the tokensave-specific catalog + narrowing (MOVES OUT). The contract's line references are exact against the current file. Extract these blocks verbatim into `tokensave-backend.ts`:

**MOVES OUT (tokensave-specific) — delete from client.ts, recreate inside TokensaveBackend:**
- `TOOL` map — `client.ts:31-37` (5 tool names: search/impact/reviewContext/overview/changes)
- `QUERY_TOOL` map — `client.ts:40-45` (callers_of/callees_of/imports_of/tests_for)
- All `Ts*Row` raw types — `client.ts:52-109` (TsSearchRow, TsEdgeRow, TsFileDependentsResult, TsTestMapResult, TsImpactResult, TsModuleApiResult, TsChangelogResult)
- `NODE_KINDS` set — `client.ts:114`
- `toNodeRef(...)` — `client.ts:116-131`

**STAYS IN client.ts (cross-cutting — do NOT move):**
- `QueryPattern` type `client.ts:47` (client passes it to the backend; keep OR re-export from backend — but the method signature `query(pattern: QueryPattern, ...)` must not change, so keep the type visible to client)
- `SearchOpts` interface `client.ts:133-136` (public API surface)
- `runWithSandbox` `client.ts:366-401` (config.enabled short-circuit, health short-circuit, staleness, timing, narrow(), toFailureResult)
- `runRaw` `client.ts:404-406`
- `toFailureResult` `client.ts:410-417`
- `checkStaleness` `client.ts:420-425`
- `keepNode` `client.ts:428-439` (needs `projectRoot` + `incidents` — MUST stay in client)
- `logSandboxDrop` `client.ts:441-452`
- `prefetch` `client.ts:296-321` + `dispatch` `client.ts:325-360`
- `markFresh` `client.ts:154-156`, `hintFor` `client.ts:162-164`

**The exact per-operation narrowing to reproduce inside TokensaveBackend (copy byte-for-byte):**

`search` (`client.ts:168-186`): rows as `TsSearchRow[]` -> map to `SearchHit{node:toNodeRef(row), score:row.score, snippet:row.signature ?? ""}`; then post-filter by `opts?.kind` (`h.node.kind === opts.kind`). Params: `{ query: q, ...(opts?.limit !== undefined ? { limit: opts.limit } : {}) }`. NOTE: the `.filter(h => this.keepNode(...))` at line 183 STAYS in client (see section 8).

`query` (`client.ts:188-245`) — 4 sub-patterns:
- `callers_of`/`callees_of` (191-198): tool `QUERY_TOOL[pattern]`, params `{ node_id: target.id }`, narrow `rows as TsEdgeRow[]` -> `toNodeRef({ ...row, id: row.node_id })`.
- `imports_of` (200-217): tool `tokensave_file_dependents`, params `{ file: target.file }`, narrow `(raw as TsFileDependentsResult).dependents` -> synthetic `NodeRef{ id:path, kind:"module", file:path, line:0, symbol:path }`.
- `tests_for` (218-240): tool `tokensave_test_map`, params `{ file: target.file }`. If `result.test_files.length > 0` -> synthetic module NodeRefs from `test_files`; ELSE fall back to `result.uncovered.map(toNodeRef)`.
- `default` (242-243): `assertNever(pattern)`.

`impact` (`client.ts:247-268`): `nodeId = typeof target === "string" ? target : target.id`; tool `tokensave_impact`, params `{ node_id: nodeId }`. Narrow: `allNodes = result.nodes.map(toNodeRef)`; `root = allNodes[0] ?? toNodeRef({id:nodeId, name:nodeId, file: typeof target==="string" ? "" : target.file, line:0, kind:"symbol"})`; `rest = allNodes.slice(1)`; `testsAffected = rest.filter(n => /test|spec/i.test(n.file))`; `affected = rest.filter(n => !/test|spec/i.test(n.file))`. Return `{root, affected, testsAffected}`. NOTE: `keepNode` filter on affected/testsAffected STAYS in client (see section 8).

`reviewContext` (`client.ts:270-273`): `task = nodes.map(n=>n.symbol).join(", ")`; tool `tokensave_context`, params `{ task }`. Uses `runRaw<string>` (no NodeRef narrowing, no post-filter).

`overview` (`client.ts:275-281`): tool `tokensave_module_api`, params `{ path: "src" }`, narrow `JSON.stringify(raw as TsModuleApiResult)`.

`changes` (`client.ts:283-294`): tool `tokensave_changelog`, params `{ from_ref: since ?? "HEAD~1", to_ref: "HEAD" }`, narrow `(raw as TsChangelogResult).symbols_in_changed_files.map(toNodeRef)`.

**Imports this file uses (top of client.ts:11-27):**
- `import type { TokensaveMcpClient } from "./mcp-client.js"`
- `import type { GraphArtifactStore } from "./artifact-store.js"`
- `import { type GraphFallback } from "./fallback.js"`
- `import type { IncidentLog } from "./incidents.js"`
- `import type { FallbackHint, GraphFailureReason, GraphResult, GraphSection, ImpactReport, NodeRef, PrefetchSpec, SearchHit, StalenessVerdict } from "./types.js"`
- `import { assertNever } from "./types.js"` — `assertNever` used at client.ts:243
- `import { sandboxNodePath } from "./sandbox.js"`
- After refactor ADD: `import type { GraphBackend } from "./backends/types.js"` and (at construction sites) `import { TokensaveBackend } from "./backends/tokensave-backend.js"`

**Constructor (client.ts:144-151):** currently `(projectRoot, mcpClient, artifactStore, fallback, incidents, config)`. Add `backend: GraphBackend` as an injected dependency. RECOMMENDED: append as a required 7th `private readonly backend: GraphBackend` param (matches evaluator's "inject a TokensaveBackend at construction"). Then update ALL call sites (section 7 — there are FOUR in src, not two).

**Imported by:** `pipeline-lifecycle.ts:25`, `cli/commands/onboard.ts:21`, `cli/commands/impact.ts:23`, `mcp/server.ts:88` (dynamic import), `tests/graph/client.test.ts:5`.

**Test file:** `tests/graph/client.test.ts` (exists — 665 lines, the primary regression gate).

---

### src/graph/backends/types.ts (create)

**Directory pattern:** `src/graph/backends/` does NOT exist yet — create it. Sibling files in `src/graph/` use kebab-case (`mcp-client.ts`, `artifact-store.ts`, `pipeline-lifecycle.ts`).
**Most similar existing file for interface style:** `src/graph/fallback.ts` (small module: `export type` + one class) and `src/graph/types.ts` (pure type exports).
**Structure template (declare the GraphBackend seam):**
```typescript
// GraphBackend — per-engine tool catalog + param builders + response-shape adapters.
// The backend produces {tool, params, narrow}; GraphClient owns sandbox/staleness/health.

import type { ImpactReport, NodeRef, SearchHit } from "../types.js";
import type { SearchOpts } from "../client.js"; // OR relocate SearchOpts here to avoid a cycle

export type QueryPattern = "callers_of" | "callees_of" | "imports_of" | "tests_for";

/** A single MCP call plan: which tool, which params, and how to narrow the raw payload. */
export interface CallPlan<T> {
  tool: string;
  params: unknown;
  narrow: (raw: unknown) => T;
}

export interface GraphBackend {
  readonly id: string; // e.g. "tokensave"
  searchPlan(q: string, opts?: SearchOpts): CallPlan<SearchHit[]>;
  queryPlan(pattern: QueryPattern, target: NodeRef): CallPlan<NodeRef[]>;
  impactPlan(target: NodeRef | string): CallPlan<ImpactReport>;
  reviewContextPlan(nodes: NodeRef[]): CallPlan<string>;
  overviewPlan(): CallPlan<string>;
  changesPlan(since?: string): CallPlan<NodeRef[]>;
}
```
> WATCH THE IMPORT CYCLE: `SearchOpts` and `QueryPattern` currently live in `client.ts`. If `backends/types.ts` imports from `client.ts` AND `client.ts` imports from `backends/types.ts`, that is a type-only cycle (tolerable under `import type`, but cleaner to MOVE `SearchOpts`/`QueryPattern` into `backends/types.ts` and re-export from client, keeping `client.ts`'s public `search(q, opts?: SearchOpts)` / `query(pattern: QueryPattern, ...)` signatures byte-identical via re-export). Either approach is fine; pick the one that typechecks.

---

### src/graph/backends/tokensave-backend.ts (create)

**Most similar existing file:** the code you are extracting IS the template — `src/graph/client.ts:29-131` (TOOL, QUERY_TOOL, Ts*Row types, NODE_KINDS, toNodeRef) plus the narrow bodies at `client.ts:168-294`.
**Structure template:**
```typescript
import type { ImpactReport, NodeRef, SearchHit } from "../types.js";
import type { CallPlan, GraphBackend, QueryPattern } from "./types.js";
import type { SearchOpts } from "../client.js"; // or ./types.js if relocated

// ── Tokensave 6.1.1 tool catalog ────────────────────────────────────
const TOOL = { /* client.ts:31-37 verbatim */ } as const;
const QUERY_TOOL = { /* client.ts:40-45 verbatim */ } as const;

// ── Raw 6.1.1 row types (adapter-internal) ──────────────────────────
type TsSearchRow = { /* client.ts:52-60 */ };
// ...TsEdgeRow, TsFileDependentsResult, TsTestMapResult, TsImpactResult, TsModuleApiResult, TsChangelogResult (client.ts:62-109)

// ── Kind coercion ───────────────────────────────────────────────────
const NODE_KINDS = new Set<string>(["function", "class", "module", "symbol"]); // client.ts:114
function toNodeRef(row: { /* client.ts:116-131 verbatim */ }): NodeRef { /* ... */ }

export class TokensaveBackend implements GraphBackend {
  readonly id = "tokensave";
  searchPlan(q: string, opts?: SearchOpts): CallPlan<SearchHit[]> {
    return {
      tool: TOOL.search,
      params: { query: q, ...(opts?.limit !== undefined ? { limit: opts.limit } : {}) },
      narrow: (raw) => {
        const rows = raw as TsSearchRow[];
        const hits: SearchHit[] = rows.map((row) => ({ node: toNodeRef(row), score: row.score, snippet: row.signature ?? "" }));
        return opts?.kind ? hits.filter((h) => h.node.kind === opts.kind) : hits;
      },
    };
  }
  // queryPlan / impactPlan / reviewContextPlan / overviewPlan / changesPlan — reproduce client.ts:188-294 narrow bodies MINUS the keepNode filters.
}
```
> CRITICAL: the backend's `narrow` returns the FULL narrowed value WITHOUT the `this.keepNode(...)` sandbox filter. `keepNode` stays in GraphClient because it needs `projectRoot` + `incidents`. See section 8 for exactly where the filter re-attaches.

---

### tests/graph/backends/tokensave-backend.test.ts (create)

**Directory pattern:** `tests/graph/backends/` does NOT exist — create it. Test files are `*.test.ts` (see `tests/graph/*.test.ts`). Vitest, `import { describe, it, expect } from "vitest"`.
**Most similar existing file:** `tests/graph/client.test.ts` (the raw-row fixtures at lines 92-100, 162-170, 186-188, 224-228, 244-249, 265-273 are ready-made inputs). Also `tests/graph/fallback.test.ts` for a pure-unit no-mock style.
**What to test:** the backend is PURE (no mcpClient, no fs) — feed a raw fixture to `new TokensaveBackend().searchPlan("foo").narrow(rawRows)` and assert the SearchHit/NodeRef/ImpactReport shape. Cover: `name->symbol`, `signature->snippet`, unknown-kind -> `"symbol"` coercion, `node_id->id` for edges, `imports_of` synthetic module NodeRefs, `tests_for` empty-test_files fallback to uncovered, impact root/affected/testsAffected partition (`/test|spec/i`), overview JSON.stringify, changes symbols_in_changed_files mapping. Also assert `backend.id === "tokensave"` and each `*Plan().tool` equals the expected `tokensave_*` string.

---

## 2. Patterns to Follow

### Constructor dependency injection (all graph deps are constructor-injected)
**Source:** `src/graph/client.ts:144-151`
```typescript
constructor(
  private readonly projectRoot: string,
  private readonly mcpClient: TokensaveMcpClient,
  private readonly artifactStore: GraphArtifactStore,
  private readonly fallback: GraphFallback,
  private readonly incidents: IncidentLog,
  private readonly config: GraphSection,
) {}
```
**Rule:** Inject `GraphBackend` the same way — append `private readonly backend: GraphBackend` and reference it as `this.backend.searchPlan(...)`. `GraphFallback` (fallback.ts:11) is the existing precedent for a small injected collaborator with a single mode arg.

### Exhaustive switch + assertNever
**Source:** `src/graph/client.ts:242-243` and `src/graph/fallback.ts:63-64`
```typescript
default:
  return assertNever(pattern);
```
**Rule:** Keep the `assertNever(pattern)` default in `queryPlan`'s pattern switch (moved into the backend). `assertNever` is exported from `types.ts:133` — import it into the backend.

### Unicode section-header comments
**Source:** `src/graph/client.ts:49`, `:111`, `:166`, `:323`; `src/graph/types.ts:33`, `:57`
```typescript
// ── Raw 6.1.1 row types (adapter-internal only) ────────────────────
```
**Rule:** Organize the new files with `// ── Section ──` box-drawing headers (mandated by principles.md:32).

### ESM `.js` specifiers + `import type`
**Source:** `src/graph/fallback.ts:1-2`
```typescript
import type { FallbackHint, GraphFailureReason } from "./types.js";
import { assertNever } from "./types.js";
```
**Rule:** All relative imports end in `.js`; type-only imports use `import type` (ESLint `consistent-type-imports` is a hard gate — principles.md:35). From `backends/` the path up to types is `"../types.js"`.

### GraphResult never-throws (ADR-3)
**Source:** `src/graph/client.ts:1-9` (file header) + `runWithSandbox` `client.ts:366-401`
**Rule:** The client's method bodies must keep returning `Promise<GraphResult<T>>` and never throw. The backend's `narrow` may cast (`raw as TsX`) but must not throw or call mcp/fs — it is a pure adapter.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `sandboxNodePath` | `src/graph/sandbox.ts:15` | `(projectRoot: string, inputPath?: string \| null) => {ok:true,abs} \| {ok:false}` | Path-escape guard; called by `keepNode`. Stays in client. |
| `assertNever` | `src/graph/types.ts:133` | `(x: never) => never` | Exhaustiveness in switch defaults. Import into backend's queryPlan. |
| `toNodeRef` | `src/graph/client.ts:116` | `(row) => NodeRef` | Coerce a raw tokensave row to NodeRef. **MOVE into tokensave-backend.ts** (do not duplicate). |
| `NODE_KINDS` | `src/graph/client.ts:114` | `Set<string>` | Valid NodeRef.kind allow-list for `toNodeRef`. **MOVE with toNodeRef.** |
| `keepNode` | `src/graph/client.ts:428` | `(node?: NodeRef, source: string) => boolean` | Sandbox post-filter + incident on drop. **STAYS in client** (needs projectRoot+incidents). |
| `GraphFallback.hint` | `src/graph/fallback.ts:14` | `(reason, detail?) => FallbackHint` | Failure->hint mapping. Injected; unchanged. |
| `mcpClient.call<T>` | `src/graph/mcp-client.ts:194` | `(tool: string, params: unknown) => Promise<T>` | The single MCP transport call. Contract UNCHANGED — only WHERE `tool`/`params` come from moves. |
| `makeGraphError` | `src/graph/mcp-client.ts:58` | `(reason, detail) => Error` | Tags errors with `.reason`/`.detail`; `toFailureResult` (client.ts:410) reads them. Unchanged. |

**Utilities reviewed:** `src/graph/` (sandbox, fallback, types, mcp-client, incidents, artifact-store) and `src/utils/` (fs, logger) — the table above lists all that are load-bearing for this sprint. `src/utils/*` is not touched.

---

## 4. Prior Sprint Output

No prior sprints completed (`dependsOn: []`). This is Sprint 1 of the plan and is a self-contained refactor of the existing `src/graph/` module.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM everywhere** — all imports `.js`, NodeNext (`:27`).
- **`import type`** — ESLint `consistent-type-imports` hard gate (`:35`).
- **Section comments** — `// ── Section ──` unicode headers (`:32`).
- **No synchronous fs** — none needed here; backend is pure (`:42`).
- **Small utility modules** (`:33`) and **no barrel re-exports for deep internals** (`:43`) — export `TokensaveBackend` and `GraphBackend` directly from their files; do NOT add them to `src/index.ts`.
- **TypeScript strict** with `noUnusedLocals`/`noUnusedParameters`/`noFallthroughCasesInSwitch`/`isolatedModules` (`:18`) — zero type errors is a hard gate. Prefix any unused param with `_`.
- **Conventional commits** — `bober(sprint-1): ...` (`:34`).

### Architecture Decisions
No architecture doc exists for this spec (checked `.bober/architecture/` for `graph-backend-choice`/`20260726`/`port-code-review` — none). The graph module's own header comment references `arch-20260524-port-code-review-graph-architecture.md` (`types.ts:2`) but that file is not present under `.bober/architecture/`. ADR-3 (GraphResult never-throws) is documented inline at `client.ts:1-9`.

### Other Docs
No CONTRIBUTING.md-specific guidance beyond principles.md. `EngineHealth = "starting" | "ready" | "restarting" | "broken"` is defined at `src/graph/mcp-client.ts:27` — the client's `broken`/`restarting` short-circuit depends on it.

---

## 6. Testing Patterns

### Unit Test Pattern
**Source:** `tests/graph/client.test.ts:24-85` (harness) and `:89-117` (a test)
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// makeMockMcp builds a fake TokensaveMcpClient whose .call returns a raw fixture:
function makeMockMcp(opts = {}): TokensaveMcpClient {
  return { call: vi.fn().mockImplementation(opts.callImpl ?? (async () => [])),
           health: vi.fn().mockReturnValue(opts.health ?? "ready"),
           start: vi.fn(), stop: vi.fn(), childPid: 12345 } as unknown as TokensaveMcpClient;
}
function makeClient(mcp, stale = false, enabled = true, incidents?) {
  return new GraphClient(tmp, mcp, makeMockStore(stale), new GraphFallback("dual"),
                         incidents ?? makeMockIncidents(), makeConfig(enabled));
}
```
**Runner:** vitest. **Assertion style:** `expect(...).toBe/.toEqual/.toContain`. **Mock approach:** `vi.fn().mockImplementation`, hand-rolled `as unknown as X` fakes (NOT `vi.mock`). **File naming:** `*.test.ts`. **Location:** `tests/graph/` mirrors `src/graph/` (NOT co-located).

**REQUIRED EDIT to `makeClient` (`client.test.ts:71-85`):** inject a backend so the constructor still typechecks. Add `new TokensaveBackend()` as the final arg. Because the harness feeds the SAME raw fixtures and asserts on the SAME narrowed output, EVERY assertion stays byte-identical.
```typescript
import { TokensaveBackend } from "../../src/graph/backends/tokensave-backend.js";
// inside makeClient:
return new GraphClient(tmp, mcp, makeMockStore(stale), new GraphFallback("dual"),
                       incidents ?? makeMockIncidents(), makeConfig(enabled), new TokensaveBackend());
```
**ALSO** update the FIVE direct `new GraphClient(` sites in this test that bypass `makeClient`: lines **400, 430, 458, 482** (sandbox tests) and **592** (staleness) — append `new TokensaveBackend()` to each. Missing any one = a compile error if `backend` is a required param.

### New backend unit test
The new `tokensave-backend.test.ts` needs NO mcp/fs mocks — `TokensaveBackend` is pure. Test shape: `const { narrow } = new TokensaveBackend().searchPlan("q"); expect(narrow([rawRow])[0].node.symbol).toBe("foo")`. Reuse the raw fixtures already in `client.test.ts`.

### E2E Test Pattern
Not applicable — no Playwright/`e2e/` in this project (CLI/library only; principles.md:48).

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break (ALL FOUR must be updated if `backend` is a required constructor param)
> The contract's `estimatedFiles` lists only `pipeline-lifecycle.ts` and `onboard.ts`, but `grep -rn "new GraphClient(" src/` finds FOUR src construction sites. `mcp/server.ts` and `impact.ts` are NOT in the contract and WILL fail typecheck if missed. This is the #1 pitfall.

| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/graph/pipeline-lifecycle.ts:222` | `GraphClient` ctor (6-arg call, config inline stub 230-248) | high | Append `new TokensaveBackend()` as 7th arg; add `import { TokensaveBackend } from "./backends/tokensave-backend.js"`. |
| `src/cli/commands/onboard.ts:107` | `GraphClient` ctor (`graphCfg`) | high | Append `new TokensaveBackend()`; import from `"../../graph/backends/tokensave-backend.js"`. |
| `src/cli/commands/impact.ts:138` | `GraphClient` ctor (`graphCfg`) | high | **NOT in contract** — append `new TokensaveBackend()` + import. Same relative path as onboard. |
| `src/mcp/server.ts:101` | `GraphClient` ctor via **dynamic import** (`await import(...)` at 88) | high | **NOT in contract** — add `const { TokensaveBackend } = await import("../graph/backends/tokensave-backend.js")` and append `new TokensaveBackend()` as 7th arg. |
| `tests/graph/client.test.ts` (makeClient:77 + lines 400/430/458/482/592) | `GraphClient` ctor | high | Inject `new TokensaveBackend()` in all six spots. |

> ALTERNATIVE that avoids touching untouched sites: make `backend` an OPTIONAL constructor param defaulting to `new TokensaveBackend()`. This keeps mcp/server.ts, impact.ts, onboard.ts, pipeline-lifecycle.ts, and the 5 inline test constructions compiling unchanged. Trade-off: `client.ts` then imports the concrete `TokensaveBackend` (a compile-time coupling), though it still passes the `grep -n 'tokensave_' src/graph/client.ts` gate since the class name has no underscore. The evaluator prefers explicit injection at construction (evaluatorNotes + assumption 3 say "pass a `new TokensaveBackend()`"), so PREFERRED = required param + update all sites. If you choose the default, still update at least the two contract sites + test harness to inject explicitly.

### Existing Tests That Must Still Pass
- `tests/graph/client.test.ts` — 30+ cases across happy-path/failure/sandbox/prefetch/staleness/health. The regression gate for byte-identical behavior. MUST pass unchanged except the injected backend arg.
- `tests/graph/pipeline-lifecycle.test.ts` — exercises `getGraphClient()` construction (client.ts:222 site). Verify it still constructs a client after the ctor gains a param.
- `tests/graph/mcp-client.test.ts` — the `call<T>` transport; unaffected (contract unchanged) but part of the suite that must stay green.
- `tests/graph/fallback.test.ts`, `tests/graph/cli.test.ts`, `tests/graph/preflight-injector.test.ts` — no direct dependency; must remain green (no NEW failures).

### Features That Could Be Affected
- **`agent-bober onboard` CLI** — shares `onboard.ts` GraphClient; verify `search()` still adapts hotspots/deadCode rows (onboard.ts:119-145).
- **`agent-bober impact` CLI** — shares `impact.ts`; verify `impact()` + `query("tests_for")` still return the same NodeRefs (impact.ts:159-162).
- **External MCP graph tools** — `mcp/server.ts` registers `registerGraphTools({client, fallback})` (server.ts:109); verify graph_* tools still construct.
- **Preflight context injection** — `getGraphDeps()`/`getGraphClient()` in pipeline-lifecycle feed `resolveRoleTools`; behavior must be identical.

### Recommended Regression Checks (run after implementation)
1. `grep -n 'tokensave_' src/graph/client.ts` -> MUST be EMPTY (sc-1-4).
2. `grep -n 'tokensave_' src/graph/backends/tokensave-backend.ts` -> MUST show the 9-tool catalog.
3. `grep -rn 'Ts[A-Z].*Row\|TsImpactResult\|TsModuleApiResult\|TsChangelogResult\|TsFileDependentsResult\|TsTestMapResult' src/graph/client.ts` -> MUST be EMPTY.
4. `grep -rn 'new GraphClient(' src/` -> confirm all 4 sites pass a backend.
5. `npm run build && npm run typecheck` -> zero errors.
6. `npx vitest run tests/graph/` -> all green.
7. `npx vitest run` (full suite) -> no NEW failures vs baseline (pre-existing cockpit-integration MCP E2E failures may remain — sc-1-6). Use `git stash` to compare baseline if unsure.
8. `npm run lint` -> zero errors.

---

## 8. Implementation Sequence

1. **`src/graph/backends/types.ts`** — declare `GraphBackend`, `CallPlan<T>`, and (recommended) relocate `QueryPattern` + `SearchOpts` here. No behavior; types only.
   - Verify: `npm run typecheck` compiles the new file in isolation (no import cycle error).
2. **`src/graph/backends/tokensave-backend.ts`** — MOVE `TOOL`, `QUERY_TOOL`, all `Ts*Row` types, `NODE_KINDS`, `toNodeRef` here; implement each `*Plan()` returning `{tool, params, narrow}` with the narrow bodies from `client.ts:168-294` MINUS the `keepNode` filters. Set `id = "tokensave"`.
   - Verify: `grep -n 'tokensave_' src/graph/backends/tokensave-backend.ts` shows the catalog; file typechecks.
3. **`src/graph/client.ts`** — delete the moved blocks (31-45, 52-131); add `import type { GraphBackend } from "./backends/types.js"`; add `backend` ctor param; rewrite each public method to `const {tool, params, narrow} = this.backend.<op>Plan(...); return this.runWithSandbox(tool, params, (raw) => narrow(raw)<...keepNode filter...>)`. Re-attach `keepNode` in the CLIENT lambda exactly where it was: search -> `.filter(h => this.keepNode(h.node,"search"))`; query patterns -> `.filter(n => this.keepNode(n,"query"))`; impact -> `affected.filter(n=>this.keepNode(n,"impact"))` + `testsAffected.filter(...)`; changes -> `.filter(n => this.keepNode(n,"changes"))`. `reviewContext` uses `runRaw` (no filter). `overview` returns the string (no filter). Keep `runWithSandbox`/`runRaw`/`toFailureResult`/`checkStaleness`/`keepNode`/`prefetch`/`dispatch` untouched.
   - Verify: `grep -n 'tokensave_' src/graph/client.ts` EMPTY; `npm run typecheck` green.
4. **Wire the four construction sites** — `pipeline-lifecycle.ts:222`, `onboard.ts:107`, `impact.ts:138`, `mcp/server.ts:101` (dynamic import). Append `new TokensaveBackend()` + add the import at each.
   - Verify: `npm run build` succeeds; `grep -rn 'new GraphClient(' src/` all pass a backend.
5. **Update test harness** — `tests/graph/client.test.ts` makeClient:77 + inline sites 400/430/458/482/592 inject `new TokensaveBackend()`; add the import at top.
   - Verify: `npx vitest run tests/graph/client.test.ts` — all assertions pass UNCHANGED.
6. **`tests/graph/backends/tokensave-backend.test.ts`** — new pure-unit tests for the narrow logic (section 6).
   - Verify: `npx vitest run tests/graph/backends/`.
7. **Run full verification** — `npm run build && npm run typecheck && npx vitest run && npm run lint`. Confirm no NEW failures vs baseline; commit `bober(sprint-1): GraphBackend interface + extract TokensaveBackend, GraphClient delegates`.

---

## 9. Pitfalls & Warnings

- **TWO construction sites are missing from the contract.** `src/mcp/server.ts:101` and `src/cli/commands/impact.ts:138` also call `new GraphClient(...)`. If `backend` is a required param and these are not updated, `npm run build`/`typecheck` FAIL. `mcp/server.ts` uses a **dynamic `await import(...)`** (server.ts:88), so you must add a matching `await import("../graph/backends/tokensave-backend.js")`.
- **The test file has SIX construction sites, not one.** `makeClient` (77) plus five inline `new GraphClient(` at lines 400, 430, 458, 482, 592. Update all six.
- **`keepNode` MUST stay in GraphClient, NOT in the backend.** It needs `this.projectRoot` + `this.incidents`. The backend's `narrow` returns the UNFILTERED narrowed value; the client re-applies `.filter(...=>this.keepNode(...))` in exactly the four spots it does today (search 183, query 197/214/233/238, impact 264-265, changes 291). Moving keepNode into the backend breaks the sandbox drop-and-log tests (client.test.ts:391-473).
- **Preserve `runWithSandbox`'s ordering EXACTLY** (client.ts:371-397): config.enabled short-circuit -> health short-circuit -> `checkStaleness()` -> `t0` -> `mcpClient.call` -> `narrow` -> build result -> apply `stale` flag. The tests assert `mcp.call` is NOT called when disabled/broken (client.test.ts:328, 337, 662) and that staleness is checked once (client.test.ts:603).
- **`overview` post-filters NOTHING** — it returns `JSON.stringify(result)` with no NodeRef narrowing/sandbox. `reviewContext` uses `runRaw` (the raw string passes through). Do not accidentally route these through a NodeRef filter.
- **`impact` root can be out-of-sandbox on purpose** — `root` is NOT keepNode-filtered (client.ts:263 comment "root may be out-of-sandbox but is informational only"). Only `affected`/`testsAffected` are filtered.
- **Import cycle risk:** `SearchOpts` (client.ts:133) and `QueryPattern` (client.ts:47) are used by both client and backend. Prefer relocating them to `backends/types.ts` and (if needed) re-exporting from `client.ts` to keep `search(q, opts?: SearchOpts)`/`query(pattern: QueryPattern, ...)` signatures byte-identical. Type-only cycles are tolerated but avoid a value cycle.
- **Do NOT touch** `src/graph/types.ts` NodeRef/SearchHit/ImpactReport/GraphResult (nonGoal), `GraphFallback`, the circuit breaker, PID/orphan handling, or `sandboxNodePath` (nonGoals). No config.graph.backend, no detection, no code-review-graph code (Sprints 2/3+).
- **`isolatedModules` + `consistent-type-imports`:** the `Ts*Row` types are type-only — import/export with `import type`/`export type`. The `TOOL`/`QUERY_TOOL` maps and `TokensaveBackend` class are values.
- **`npm run build` writes to `dist/`** — do not hand-edit anything under `dist/`; it is generated. Verify against `src/`.
