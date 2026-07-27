# Sprint Briefing: code-review-graph read adapters (search / reviewContext / overview / impact / changes)

**Contract:** sprint-spec-20260726-graph-backend-choice-5
**Generated:** 2026-07-27T00:00:00Z

---

## 0. TL;DR for the Generator (read first)

1. **Analogy sprint.** Mirror `TokensaveBackend`'s `{tool, params, narrow}` pattern (`src/graph/backends/tokensave-backend.ts:215-340`). Replace **5 of the 6** `throw new Error(NOT_IMPL)` adapters in `src/graph/backends/code-review-graph-backend.ts:84-106` with real ones: `searchPlan`, `impactPlan`, `reviewContextPlan`, `overviewPlan`, `changesPlan`. **`queryPlan` stays `throw new Error(NOT_IMPL)` (Sprint 6).**
2. **The fixtures in `tests/graph/fixtures/cr-graph/*.json` are ground truth** — already committed by Sprint 4 (verified present). Write every narrow against the ACTUAL fields documented in §3. Do NOT reshape / guess.
3. **The cr-graph node-row shape is the same in every fixture** (search results, impact nodes, changes functions). Factor ONE shared `crToNodeRef` helper + one `crKind` coercion (§4) — Sprint 6's `queryPlan` will reuse it. This mirrors tokensave's `toNodeRef` + `NODE_KINDS` (`tokensave-backend.ts:191-208`).
4. **Two GraphClient quirks that change what you can assert end-to-end (§6):**
   - `GraphClient.reviewContext` uses `runRaw` and **IGNORES the narrow** (`client.ts:91-94`). Its narrow is only exercised by the *unit* test.
   - `GraphClient.overview` **DOES** use the narrow (`client.ts:96-99`). So `overviewPlan.narrow` must return a `string` (JSON.stringify).
5. **Sandbox drops `/repo/...`.** The committed fixtures use absolute paths under `/repo/...`. `keepNode`→`sandboxNodePath(projectRoot, file)` drops anything outside `projectRoot`. For an end-to-end test that KEEPS nodes, construct `GraphClient` with `projectRoot = "/repo"` (pure path math, no fs — `sandbox.ts:21-28`). For the "drops out-of-repo" assertion the evaluator wants, use a DIFFERENT projectRoot (a real tmp dir) so all `/repo/...` nodes drop.
6. **You WILL break `tests/graph/cli-backend-injection.test.ts:113-123`** — it asserts all 6 adapters throw NOT_IMPL. After this sprint only `queryPlan` throws. You MUST update that test (§7).

---

## 1. Target Files

### `src/graph/backends/code-review-graph-backend.ts` (modify)

The 5 adapters to implement (currently NOT_IMPL, lines 84-106). Leave `queryPlan` (88-90) throwing:

```ts
// code-review-graph-backend.ts:84-106  (CURRENT — replace 5, keep queryPlan)
searchPlan(_q: string, _opts?: SearchOpts): CallPlan<SearchHit[]> { throw new Error(NOT_IMPL); }
queryPlan(_pattern: QueryPattern, _target: NodeRef): CallPlan<NodeRef[]> { throw new Error(NOT_IMPL); } // ← KEEP (Sprint 6)
impactPlan(_target: NodeRef | string): CallPlan<ImpactReport> { throw new Error(NOT_IMPL); }
reviewContextPlan(_nodes: NodeRef[]): CallPlan<string> { throw new Error(NOT_IMPL); }
overviewPlan(): CallPlan<string> { throw new Error(NOT_IMPL); }
changesPlan(_since?: string): CallPlan<NodeRef[]> { throw new Error(NOT_IMPL); }
```

- `NOT_IMPL` const (line 27-28) stays verbatim (still asserted for `queryPlan`).
- Imports already present (line 15-25): `ImpactReport, NodeRef, SearchHit, StatusResult` from `../types.js`; `CallPlan, CliMap, GraphBackend, Platform, PrereqSpec, ProcessSpec, QueryPattern, SearchOpts` from `./types.js`. **No new imports needed** for the adapters (helpers are module-local functions).
- **Do NOT touch** `processSpec`/`prereqSpec`/`cliMap`/`parseCrGraphSyncOutput`/`parseCrGraphStatusOutput` (Sprint 4, lines 31-147).

**Imported by:** `src/graph/backends/registry.ts`, `tests/graph/cli-backend-injection.test.ts`, `tests/graph/pipeline-lifecycle-backend.test.ts`, `tests/graph/backends/code-review-graph-backend.test.ts`, `tests/graph/backends/code-review-graph-live.test.ts`.
**Test file:** `tests/graph/backends/code-review-graph-backend.test.ts` — **EXISTS** (Sprint 4). Add the 5 adapter `describe` blocks to it; the contract's `estimatedFiles` lists this file.

### `tests/graph/backends/code-review-graph-backend.test.ts` (modify — add adapter tests)

Extend the existing file (id/processSpec/prereqSpec/cliMap already tested, lines 30-200). Add fixture-driven narrow tests. Load fixtures with `readFileSync` + `JSON.parse` (see §6 template). **Most similar reference:** `tests/graph/backends/tokensave-backend.test.ts:14-233` (per-adapter `describe` + `plan.narrow(raw)` assertions).

### End-to-end: extend `tests/graph/client.test.ts` (recommended, optional file)

`client.test.ts` is the end-to-end harness (`makeClient` injects `new TokensaveBackend()` at line 85). Add a parallel `makeClient`-style helper injecting `new CodeReviewGraphBackend()` with `projectRoot="/repo"` and a `callImpl` returning each fixture. See §6.

---

## 2. Patterns to Follow

### Pattern A — `{tool, params, narrow}` CallPlan (the whole sprint)
**Source:** `src/graph/backends/tokensave-backend.ts:215-229` (searchPlan)
```ts
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
```
**Rule:** Each adapter returns a literal `{ tool, params, narrow }`; `narrow` MUST be pure (no I/O, no sandbox — GraphClient owns that per `backends/types.ts:60-67`).

### Pattern B — kind coercion + row→NodeRef helper
**Source:** `tokensave-backend.ts:191-208`
```ts
const NODE_KINDS = new Set<string>(["function", "class", "module", "symbol"]);
function toNodeRef(row: {...}): NodeRef {
  return { id: row.id ?? row.node_id ?? "", kind: NODE_KINDS.has(row.kind ?? "") ? (row.kind as NodeRef["kind"]) : "symbol", file: row.file, line: row.line, symbol: row.name };
}
```
**Rule:** cr-graph rows use DIFFERENT field names (`file_path`/`line_start`/`qualified_name`/capitalized `kind`) — write a cr-graph-specific `crToNodeRef` (§4), do NOT reuse tokensave's `toNodeRef` (wrong field names).

### Pattern C — impact test/non-test partition
**Source:** `tokensave-backend.ts:302-305`
```ts
const testsAffected = rest.filter((n) => /test|spec/i.test(n.file));
const affected = rest.filter((n) => !/test|spec/i.test(n.file));
```
**Rule:** cr-graph rows carry an explicit `is_test` boolean — **prefer `is_test`**, fall back to the `/test|spec/i` path heuristic when absent (§5 impact).

### Pattern D — overview stringifies an object
**Source:** `tokensave-backend.ts:319-329` — `narrow: (raw) => JSON.stringify(result)`.
**Rule:** cr-graph `get_architecture_overview_tool` returns an OBJECT; stringify it for the string-typed caller.

---

## 3. FIXTURE GROUND TRUTH (field maps — do not re-derive)

**Every fixture is an object** `{status, summary, ...results..., _hints?, context_savings?, _graph}`. Ignore the `_graph` staleness envelope, `_hints`, `context_savings`, `summary`, `status`.

### Shared cr-graph NODE ROW shape (search results, impact/changes nodes)
```jsonc
{
  "id": 5,                                   // NUMBER (NodeRef.id is string → use qualified_name)
  "kind": "Function",                        // CAPITALIZED: "Function" | "Class" | "File"
  "name": "add",                             // → NodeRef.symbol
  "qualified_name": "/repo/src/math_utils.py::add",  // → NodeRef.id
  "file_path": "/repo/src/math_utils.py",    // → NodeRef.file
  "line_start": 1,                           // → NodeRef.line   (line_end ignored)
  "language": "python", "parent_name": null,
  "is_test": false,                          // impact/changes only → test partition
  "score": 0.016393,                         // search results only → SearchHit.score
  "signature": "def add((a, b))",            // search results only → SearchHit.snippet
  "impact_score": 0.6                        // impacted_nodes only (ignore or informational)
}
```
**cr-graph field → NodeRef field:** `qualified_name`→`id`, `name`→`symbol`, `file_path`→`file`, `line_start`→`line`, `kind`(Function/Class/File)→coerced `kind`. NOTE: search rows have **NO `id` field** — `qualified_name` is the only stable id there.

### `semantic_search_nodes_tool.json` → `SearchHit[]`
Root key **`results`** (array of node rows, each with `score` + `signature`). Fixture has 1 result: `add` @ `/repo/src/math_utils.py:1`, `score:0.016393`, `signature:"def add((a, b))"`.
- `results[]` → SearchHit[]; per row: `node = crToNodeRef(row)`, `score = row.score`, `snippet = row.signature ?? ""`.

### `get_review_context_tool.json` → `string`
Nested under **`context`**: `{changed_files, impacted_files, graph:{changed_nodes, impacted_nodes, edges}, source_snippets, review_guidance}`. Human summary at top-level `summary` and `context.review_guidance`.
- **narrow returns a string** = `typeof raw === "string" ? raw : JSON.stringify(raw)`.
- **⚠ GraphClient bypasses this narrow** (§6). Only the unit test exercises it.

### `get_architecture_overview_tool.json` → `string`
Top-level `communities:[{id,name,size,cohesion,dominant_language}]`, `cross_community_edges`, `warnings`. No node rows.
- **narrow returns** `typeof raw === "string" ? raw : JSON.stringify(raw)` (mirrors tokensave module_api).

### `get_impact_radius_tool.json` → `ImpactReport{root, affected, testsAffected}`
Two node arrays:
- **`changed_nodes[]`** (5 rows): the directly-changed set. `changed_nodes[0]` = File `/repo/src/math_utils.py`.
- **`impacted_nodes[]`** (4 rows): blast radius — `run`, `helper`, File `main.py`, `another` (each also has `impact_score`, all `is_test:false`).
- Also `changed_files`, `impacted_files`, `edges`, `total_impacted:4`.
- **root** = `crToNodeRef(changed_nodes[0])` (fallback: synthesize from `target`). **affected** = non-test `impacted_nodes`. **testsAffected** = test `impacted_nodes` (via `is_test`, fallback `/test|spec/i`). Fixture → affected.length=4, testsAffected.length=0.

### `detect_changes_tool.json` → `NodeRef[]`
Root key **`changed_functions`** (array of node rows, each with `risk_score`). Fixture has 1: `another` @ `/repo/src/main.py:5`. (Also `test_gaps`, `review_priorities`, `affected_flows` — ignore for changes→NodeRef[].)
- `changed_functions[]` → NodeRef[] via `crToNodeRef`.

### `_args.json` — captured tools/call argument shapes (drive `params`)
```
semantic_search_nodes_tool     : { query: "add", limit: 5 }
get_impact_radius_tool         : { changed_files: ["src/math_utils.py"] }
get_review_context_tool        : { changed_files: ["src/main.py"] }
get_architecture_overview_tool : {}
detect_changes_tool            : { base: "HEAD~1" }
```
**These differ from tokensave's params — honor the cr-graph shape**, do NOT copy tokensave's `{task}`/`{node_id}`/`{path:"src"}`/`{from_ref,to_ref}`.

---

## 4. Recommended shared helpers (factor once; Sprint 6 reuses `crToNodeRef`)

```ts
// Coerce cr-graph's capitalized kind → NodeRef.kind. "File" → "module"
// (tokensave treats file-level nodes as "module"; see its imports_of/tests_for narrows).
const CR_NODE_KINDS = new Set<string>(["function", "class", "module", "symbol"]);
function crKind(kind: string | undefined): NodeRef["kind"] {
  const k = (kind ?? "").toLowerCase();
  if (k === "file") return "module";
  return CR_NODE_KINDS.has(k) ? (k as NodeRef["kind"]) : "symbol";
}

type CrNodeRow = {
  id?: number | string; name: string; qualified_name?: string;
  file_path: string; line_start?: number; kind?: string; is_test?: boolean;
};
function crToNodeRef(row: CrNodeRow): NodeRef {
  return {
    id: row.qualified_name ?? String(row.id ?? ""),
    kind: crKind(row.kind),
    file: row.file_path,
    line: row.line_start ?? 0,
    symbol: row.name,
  };
}
```
**Decision points (both defensible — recommend the first, note the second in a comment):**
- `id`: `qualified_name` (stable string; search rows lack numeric `id`) vs `String(row.id)`.
- `File` kind: `"module"` (recommended — matches tokensave file-node treatment) vs literal-lowercase-fallback `"symbol"`. sc-5-2 only requires kind ∈ the NodeRef set; both satisfy it.

---

## 5. Per-adapter implementation sketch (against the real fixtures)

```ts
searchPlan(q, opts) => ({
  tool: "semantic_search_nodes_tool",
  params: { query: q, ...(opts?.limit !== undefined ? { limit: opts.limit } : {}) },
  narrow: (raw) => {
    const rows = (raw as { results?: CrSearchRow[] }).results ?? [];
    const hits = rows.map((r) => ({ node: crToNodeRef(r), score: typeof r.score === "number" ? r.score : 0, snippet: r.signature ?? "" }));
    return opts?.kind ? hits.filter((h) => h.node.kind === opts.kind) : hits;   // mirror tokensave kind post-filter
  },
});

reviewContextPlan(nodes) => ({
  tool: "get_review_context_tool",
  params: { changed_files: [...new Set(nodes.map((n) => n.file))] },   // cr-graph wants file paths, NOT a joined task
  narrow: (raw) => (typeof raw === "string" ? raw : JSON.stringify(raw)),
});

overviewPlan() => ({
  tool: "get_architecture_overview_tool",
  params: {},
  narrow: (raw) => (typeof raw === "string" ? raw : JSON.stringify(raw)),
});

impactPlan(target) => {
  const file = typeof target === "string" ? (target.split("::")[0] ?? target) : target.file;
  return {
    tool: "get_impact_radius_tool",
    params: { changed_files: [file] },
    narrow: (raw) => {
      const p = raw as { changed_nodes?: CrNodeRow[]; impacted_nodes?: CrNodeRow[] };
      const changed = (p.changed_nodes ?? []).map(crToNodeRef);
      const root = changed[0] ?? crToNodeRef({ name: String(target), qualified_name: file, file_path: file, line_start: 0, kind: "file" });
      const impacted = p.impacted_nodes ?? [];
      const isTest = (r: CrNodeRow) => (typeof r.is_test === "boolean" ? r.is_test : /test|spec/i.test(r.file_path));
      return {
        root,
        affected: impacted.filter((r) => !isTest(r)).map(crToNodeRef),
        testsAffected: impacted.filter((r) => isTest(r)).map(crToNodeRef),
      };
    },
  };
};

changesPlan(since) => ({
  tool: "detect_changes_tool",
  params: { base: since ?? "HEAD~1" },
  narrow: (raw) => (raw as { changed_functions?: CrNodeRow[] }).changed_functions?.map(crToNodeRef) ?? [],
});
```
`CrSearchRow` = `CrNodeRow & { score?: number; signature?: string }`.

---

## 6. Testing Patterns

**Runner:** Vitest. **Assertion:** `expect`. **Location:** collocated under `tests/graph/`. **File naming:** `<module>.test.ts`. **Note:** `npm run lint` = `eslint src/` (tests NOT linted), but `npm run typecheck` = `tsc --noEmit` covers tests — keep test types clean (e.g. `import type`).

### Unit narrow test (mirror `tokensave-backend.test.ts:150-170`, but load the real fixture)
```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const FIX = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/cr-graph");
const load = (name: string) => JSON.parse(readFileSync(join(FIX, name), "utf8"));

describe("searchPlan", () => {
  it("narrows semantic_search_nodes_tool → SearchHit[] (name→symbol, score, signature→snippet, Function→function)", () => {
    const plan = backend.searchPlan("add", { limit: 5 });
    expect(plan.tool).toBe("semantic_search_nodes_tool");
    expect(plan.params).toEqual({ query: "add", limit: 5 });
    const hits = plan.narrow(load("semantic_search_nodes_tool.json"));
    expect(hits).toHaveLength(1);
    expect(hits[0]!.node.symbol).toBe("add");
    expect(hits[0]!.node.file).toBe("/repo/src/math_utils.py");
    expect(hits[0]!.node.kind).toBe("function");
    expect(hits[0]!.score).toBeCloseTo(0.016393);
    expect(hits[0]!.snippet).toBe("def add((a, b))");
  });
});
// impact: root.symbol from changed_nodes[0], affected.length===4, testsAffected.length===0
// changes: length 1, [0].symbol==="another", [0].file==="/repo/src/main.py", [0].line===5
// overview/reviewContext: typeof narrow(fixture) === "string" and contains "communities"/"review_guidance"
```

### End-to-end test (mirror `client.test.ts:72-119`), inject cr-graph backend
```ts
function makeCrClient(projectRoot: string, callImpl: (t: string, p: unknown) => Promise<unknown>) {
  return new GraphClient(projectRoot, makeMockMcp({ callImpl }), makeMockStore(false),
    new GraphFallback("dual"), makeMockIncidents(), makeConfig(), new CodeReviewGraphBackend());
}
// KEEP nodes: projectRoot "/repo" (sandbox.ts is pure path math, no fs)
it("search e2e keeps in-repo nodes + coerces kind", async () => {
  const client = makeCrClient("/repo", async () => load("semantic_search_nodes_tool.json"));
  const r = await client.search("add");
  expect(r.ok).toBe(true);
  if (r.ok) { expect(r.data).toHaveLength(1); expect(r.data[0]!.node.symbol).toBe("add"); expect(r.data[0]!.node.kind).toBe("function"); }
});
// DROP out-of-repo: different projectRoot so /repo/... is dropped (evaluatorNotes require this)
it("search e2e drops out-of-repo /repo nodes via sandbox", async () => {
  const client = makeCrClient(tmp, async () => load("semantic_search_nodes_tool.json")); // tmp !== /repo
  const r = await client.search("add");
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.data).toHaveLength(0);
});
```
- `makeMockMcp`/`makeMockStore`/`makeMockIncidents`/`makeConfig` already exist in `client.test.ts:25-70` — reuse verbatim.
- **overview e2e:** uses the narrow → assert `typeof r.data === "string"` and `r.data` contains `"src-helper"`/`"communities"`.
- **⚠ reviewContext e2e:** `GraphClient.reviewContext` uses `runRaw` and **does NOT call your narrow** (`client.ts:91-94`) — `r.data` is the raw fixture OBJECT typed as string. Assert ONLY `r.ok === true`; do NOT assert `typeof r.data === "string"` (it will be `"object"`).
- **impact e2e** (projectRoot "/repo"): `r.data.affected.length===4`, `r.data.testsAffected.length===0`, `r.data.root.symbol` is the changed File name.

---

## 7. Impact Analysis — Affected Files & Tests

### Files that may break
| File | Depends on | Risk | What to check |
|---|---|---|---|
| `tests/graph/cli-backend-injection.test.ts:113-123` | cr-graph adapters throwing NOT_IMPL | **HIGH** | Asserts **all 6** `*Plan` throw NOT_IMPL. After this sprint only `queryPlan` throws. **Must update** to assert only `queryPlan` throws (see below). |
| `src/graph/backends/registry.ts` | `CodeReviewGraphBackend` | low | Only uses `id`/`processSpec`/`prereqSpec`. Unaffected. |
| `tests/graph/pipeline-lifecycle-backend.test.ts` | cr-graph `processSpec` | low | Uses `processSpec()` only. Unaffected. |
| `tests/graph/backends/code-review-graph-live.test.ts` | cr-graph `processSpec` + skipIf | low | Live/skipped. Unaffected. |

### Required fix to `cli-backend-injection.test.ts:113-123`
Replace the "6 adapters throw" test with: only `queryPlan` throws NOT_IMPL now; the other 5 return a well-formed CallPlan.
```ts
it("queryPlan still throws NOT_IMPL (Sprint 6); the other 5 adapters are implemented", () => {
  const backend = new CodeReviewGraphBackend();
  const nodeRef = { id: "x", kind: "symbol" as const, file: "f.py", line: 1, symbol: "x" };
  expect(() => backend.queryPlan("callers_of", nodeRef)).toThrow(/not implemented until Sprints 4-6/);
  expect(backend.searchPlan("x").tool).toBe("semantic_search_nodes_tool");
  expect(backend.impactPlan(nodeRef).tool).toBe("get_impact_radius_tool");
  expect(backend.reviewContextPlan([nodeRef]).tool).toBe("get_review_context_tool");
  expect(backend.overviewPlan().tool).toBe("get_architecture_overview_tool");
  expect(backend.changesPlan().tool).toBe("detect_changes_tool");
});
```

### Existing tests that MUST still pass (tokensave path untouched — nonGoal)
- `tests/graph/backends/tokensave-backend.test.ts` — tokensave adapters; do NOT touch `tokensave-backend.ts`.
- `tests/graph/client.test.ts` — the tokensave e2e cases (add cr-graph cases alongside; do not alter the tokensave ones).
- `tests/graph/backends/code-review-graph-backend.test.ts` — Sprint-4 id/processSpec/prereqSpec/cliMap cases stay green.
- `tests/graph/backends/registry.test.ts`, `tests/graph/cli-backend-injection.test.ts` (other cases).

### Existing Utilities — DO NOT recreate
| Utility | Location | Purpose |
|---|---|---|
| `toNodeRef` / `NODE_KINDS` (template) | `tokensave-backend.ts:191-208` | Structural template for `crToNodeRef`/`crKind` (DIFFERENT field names — don't import). |
| `sandboxNodePath` | `src/graph/sandbox.ts:15-28` | Pure path-sandbox used by `keepNode`; no fs — lets you set `projectRoot="/repo"` in tests. |
| `makeMockMcp` / `makeMockStore` / `makeMockIncidents` / `makeConfig` | `tests/graph/client.test.ts:25-70` | Reuse for the cr-graph e2e test. |
| `GraphClient.search/impact/reviewContext/overview/changes` | `src/graph/client.ts:65-106` | The consumers; note reviewContext bypasses narrow (runRaw), overview uses it. |
| `CallPlan` / `GraphBackend` | `src/graph/backends/types.ts:64-95` | narrow must be pure (no sandbox/IO). |

Utilities reviewed: `src/graph/{sandbox,client,types}.ts`, `src/graph/backends/{tokensave-backend,types}.ts` — table covers all relevant ones. No generic `utils/`/`lib/` symbol applies to this pure-adapter sprint.

### Recommended regression checks (run after implementation)
1. `npm run build && npm run typecheck` — zero errors (sc-5-1).
2. `npx vitest run tests/graph/backends/code-review-graph-backend.test.ts` — new adapter tests green.
3. `npx vitest run tests/graph/client.test.ts tests/graph/cli-backend-injection.test.ts` — e2e + the updated NOT_IMPL test green.
4. `npx vitest run tests/graph/` then `npx vitest run` (full suite) — no NEW failures; tokensave path unaffected (sc-5-7).
5. `npm run lint` — clean.

---

## 8. Implementation Sequence (dependency-ordered)

1. **`crKind` + `crToNodeRef` helpers** (module-local, above the class in `code-review-graph-backend.ts`). — Verify: `npm run typecheck`.
2. **`searchPlan`** (uses crToNodeRef + kind post-filter). — Verify: unit narrow test on `semantic_search_nodes_tool.json`.
3. **`changesPlan`** (crToNodeRef over `changed_functions`). — Verify: unit test → 1 NodeRef `another`.
4. **`impactPlan`** (root from `changed_nodes[0]`, partition `impacted_nodes` by `is_test`). — Verify: affected=4, testsAffected=0.
5. **`overviewPlan`** (JSON.stringify). — Verify: `typeof narrow(fixture)==="string"`.
6. **`reviewContextPlan`** (`params:{changed_files}`, stringify narrow). — Verify: unit test string; remember GraphClient bypasses this narrow.
7. **Update** `cli-backend-injection.test.ts:113-123` to assert only `queryPlan` throws (§7).
8. **End-to-end** cr-graph cases in `client.test.ts` (projectRoot "/repo" keep + tmp drop). — Verify: search kept=1 / dropped=0.
9. **Full verification** — `npm run build && npm run typecheck && npx vitest run && npm run lint`. Commit `bober(sprint-5): code-review-graph read adapters (search/reviewContext/overview/impact/changes)`.

---

## 9. Pitfalls & Warnings

- **`queryPlan` STAYS `throw new Error(NOT_IMPL)`** — implementing it is Sprint 6 (nonGoal). Only 5 adapters change.
- **`GraphClient.reviewContext` ignores your narrow** (`client.ts:91-94` destructures `{tool, params}` only, calls `runRaw`). The narrow is unit-test-only. End-to-end `r.data` is the raw object typed as string — assert only `.ok===true`.
- **`GraphClient.overview` DOES use the narrow** (`client.ts:96-99`) — it MUST return a string, else the string-typed caller gets an object.
- **cr-graph `id` is a NUMBER; NodeRef.id is a string.** Use `qualified_name` (search rows have no numeric `id`). Never assign the raw number to `NodeRef.id`.
- **Field names differ from tokensave:** `file_path` not `file`, `line_start` not `line`, `qualified_name`/`name` not `id`/`name`, capitalized `kind`. Don't reuse `toNodeRef`.
- **Params differ from tokensave** — cr-graph uses `{changed_files}` (impact/reviewContext), `{base}` (changes), `{}` (overview). Do NOT copy tokensave's `{node_id}`/`{task}`/`{path}`/`{from_ref,to_ref}`. Match `_args.json`.
- **Sandbox drops `/repo/...`** unless `projectRoot="/repo"`. Choose projectRoot deliberately per e2e assertion (keep vs drop). `sandbox.ts` does pure path math — `/repo` need not exist on disk.
- **Do NOT normalize scores** to tokensave semantics — pass cr-graph's `score` through faithfully (nonGoal; evaluator rejects normalization).
- **Do NOT touch** `tokensave-backend.ts`, `client.ts`, the transport, or Sprint-4 cliMap/process/prereq code (nonGoal).
- **Do NOT add or regenerate fixtures** — use the committed Sprint-4 captures. They are present and verified.
- `npm run lint` only lints `src/` — but `tsc --noEmit` type-checks tests; use `import type` for type-only imports (`consistent-type-imports` is enforced in src).

---

## 10. Project Principles / Architecture
- ESM + NodeNext `.js` import extensions; TypeScript strict; **zero type + zero lint errors are hard gates**.
- Pure adapters: no I/O / no sandbox in `narrow` (`backends/types.ts:60-67`). GraphClient owns sandbox/staleness/health/fallback (`client.ts`).
- `.bober/architecture/`: no ADR specific to spec-20260726 read-adapters (checked). `.bober/principles.md` reviewed — no additional constraint beyond the above.
