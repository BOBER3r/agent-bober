# Sprint Briefing: code-review-graph query sub-patterns (full parity) — callers_of / callees_of / imports_of / tests_for

**Contract:** sprint-spec-20260726-graph-backend-choice-6
**Generated:** 2026-07-27T05:00:00Z

> **HEADLINE (read first).** All 4 patterns map cleanly to a SINGLE cr-graph tool, `query_graph_tool`, whose `pattern` argument IS the direction selector. **You do NOT need `traverse_graph_tool`** (it is a mixed BFS with no direction separation — see §9). I live-probed `code-review-graph 2.3.7` (MCP serverInfo 3.4.4) and committed 5 NEW real fixtures. **Full parity is achievable — NO `GRAPH_UNAVAILABLE` fallback is required for any pattern.** Two edge-direction traps will silently produce wrong data if missed: (1) bober `imports_of` must use cr-graph pattern **`importers_of`** (NOT `imports_of`); (2) bober `tests_for` must pass **`target.id`** (qualified_name), NOT `target.file`.

---

## 0. THE MAP (paste-ready) — pattern → tool → params → neighbor field → NodeRef[]

All 4 use `tool: "query_graph_tool"`. `query_graph_tool` args schema: `{pattern*, target*, repo_root?, detail_level?, max_results?}` (fixtures/cr-graph/_args.json:273-274, `queryGraphPatternEnum` at :6-22 — 15 patterns; bober's 4 are all present).

| bober pattern | cr-graph `pattern` | `target` value | direction | neighbor list | build NodeRef via |
|---|---|---|---|---|---|
| `callers_of` | `"callers_of"` | `target.id` (qualified_name) | **INBOUND** (who calls target) | `payload.results[]` (CrNodeRow) | `crToNodeRef` (reuse, backend :119) |
| `callees_of` | `"callees_of"` | `target.id` (qualified_name) | **OUTBOUND** (what target calls) | `payload.results[]` (CrNodeRow) | `crToNodeRef` |
| `imports_of` | **`"importers_of"`** ⚠ | `target.file` | dependents (who imports target) | `payload.results[].importer` (path string) | **module NodeRef built from path** (like tokensave imports_of) |
| `tests_for` | `"tests_for"` | **`target.id`** (qualified_name) ⚠ | tests covering target symbol | `payload.results[]` (CrNodeRow test rows) | `crToNodeRef` |

`crToNodeRef` narrows the SAME cr-graph node-row shape used by every other adapter (`{name, qualified_name, file_path, line_start, kind, is_test}`) — see `src/graph/backends/code-review-graph-backend.ts:119-127`. The module-NodeRef shape for `imports_of` mirrors tokensave `src/graph/backends/tokensave-backend.ts:252-258`: `{ id: path, kind: "module", file: path, line: 0, symbol: path }`.

**Defensive narrow:** always `const rows = (payload.results ?? [])` — an `"ambiguous"` payload (bare-name target) has NO `results` key (it has `candidates`/`disambiguation`), so `?? []` prevents a crash. The adapter avoids ambiguity by passing `target.id`/`target.file`, but stay defensive (mirrors `searchPlan`'s `results ?? []` at backend :147).

---

## 1. Target Files

### src/graph/backends/code-review-graph-backend.ts (modify)

**The ONLY method to change — replace the NOT_IMPL body (lines 160-162):**
```ts
  queryPlan(_pattern: QueryPattern, _target: NodeRef): CallPlan<NodeRef[]> {
    throw new Error(NOT_IMPL);
  }
```
Model the new body on the tokensave template (`tokensave-backend.ts:232-285`): a `switch (pattern)` with a `default: return assertNever(pattern);` for exhaustiveness. **Reuse (do not re-declare):** `crToNodeRef` (:119), `crKind` (:97), `CrNodeRow` type (:107). Import `assertNever` from `"../types.js"` (tokensave does this at :12 — cr-graph backend does not import it yet, so ADD the import).

**Reuse-in-place helpers already in this file:**
- `crToNodeRef(row: CrNodeRow): NodeRef` — :119-127. `qualified_name→id`, `name→symbol`, `file_path→file`, `line_start→line`, `crKind(kind)`.
- `crKind(kind)` — :97-101. `"File"→"module"`, `"Function"/"Class"→lowercased`, everything else (incl. `"Test"`) → `"symbol"`.
- `CrNodeRow` — :107-115. Note `is_test?: boolean` is present on cr-graph rows.

**Imports this file uses:** `NodeRef` from `../types.js` (:16); `CallPlan, QueryPattern, GraphBackend, SearchOpts` etc. from `./types.js` (:17-26). ADD `assertNever` to the `../types.js` import.

**Imported by:** `src/graph/backends/registry.ts:23,30` (registered in `KNOWN_BACKENDS`); `tests/graph/client.test.ts:9,703`; `tests/graph/cli-backend-injection.test.ts:29`.

**Test file:** `tests/graph/backends/code-review-graph-backend.test.ts` (exists — modify).

---

### tests/graph/backends/code-review-graph-backend.test.ts (modify)

The current file has a placeholder that MUST be replaced (lines 351-358):
```ts
  it("queryPlan still throws NOT_IMPL (Sprint 6)", () => {
    ...
    expect(() => backend.queryPlan("callers_of", nodeRef)).toThrow(/.../);
  });
```
Replace it with a `describe("queryPlan", ...)` block modeled on the tokensave one (`tests/graph/backends/tokensave-backend.test.ts:74-146`). Fixture loader `loadFixture` already exists at :25-28 (reads `../fixtures/cr-graph`).

---

### tests/graph/fixtures/cr-graph/ (create — ALREADY DONE BY CURATOR)

I captured + committed these 5 NEW fixtures (live, sanitized `WORK→/repo`). They are real cr-graph 2.3.7 payloads — DO NOT reshape them:
- `query_graph_callers_of_tool.json` — `callers_of(.../multiply)` → 2 results: `compute`, `test_multiply` (INBOUND)
- `query_graph_callees_of_tool.json` — `callees_of(.../multiply)` → 2 results: `range` (builtin, **no file_path**), `add` (OUTBOUND)
- `query_graph_importers_of_tool.json` — `importers_of(src/math_utils.py)` → 2 results as `{importer, file}`: `src/main.py`, `tests/test_math_utils.py`
- `query_graph_imports_of_tool.json` — `imports_of(src/main.py)` → 1 result as `{import_target}`: `src/math_utils.py` (**opposite direction — the trap fixture**)
- `query_graph_tests_for_tool.json` — `tests_for(.../multiply)` → 2 CrNodeRow rows (`kind:"Test"`, `is_test:true`): `test_multiply`, `test_add`

The exact capture args + the direction map are recorded in `tests/graph/fixtures/cr-graph/_args.json` under `sprint6QueryCaptures` and `sprint6DirectionMap`. The pre-existing `query_graph_tool.json` (callers_of `add`, older build) is retained but the NEW `callers_of`/`callees_of` pair on `multiply` is what the direction-assertion test uses (same node, same build).

---

## 2. Patterns to Follow

### Pattern A — the `switch(pattern)` CallPlan (reuse tokensave structure)
**Source:** `src/graph/backends/tokensave-backend.ts:232-285`
```ts
  queryPlan(pattern: QueryPattern, target: NodeRef): CallPlan<NodeRef[]> {
    switch (pattern) {
      case "callers_of":
      case "callees_of": {
        const tool = QUERY_TOOL[pattern];
        return { tool, params: { node_id: target.id }, narrow: (raw) => { ... } };
      }
      case "imports_of": { return { tool: ..., params: { file: target.file }, narrow: ... }; }
      case "tests_for":  { return { tool: ..., params: { file: target.file }, narrow: ... }; }
      default: return assertNever(pattern);
    }
  }
```
**Rule:** one `switch` with an `assertNever` default; each arm returns `{tool, params, narrow}`. For cr-graph, `tool` is always `"query_graph_tool"` and `params` is `{ pattern: <cr-graph-pattern>, target: <target.id|target.file> }`.

### Pattern B — CrNodeRow narrow (callers/callees/tests_for)
**Source:** `src/graph/backends/code-review-graph-backend.ts:146-152` (searchPlan) and :223 (changesPlan)
```ts
      narrow: (raw) => {
        const rows = (raw as { results?: CrNodeRow[] }).results ?? [];
        return rows.map(crToNodeRef);
      },
```
**Rule:** cast `raw` to `{ results?: CrNodeRow[] }`, default `?? []`, map `crToNodeRef`. Works for `callers_of`, `callees_of`, `tests_for` (all return CrNodeRow `results`).

### Pattern C — module NodeRef from a path string (imports_of)
**Source:** `src/graph/backends/tokensave-backend.ts:252-258`
```ts
            return result.dependents.map((path): NodeRef => ({
              id: path, kind: "module", file: path, line: 0, symbol: path,
            }));
```
**Rule:** `imports_of` results are `{importer, file}` rows (NOT CrNodeRow). Map `results[].importer` (fall back to `.file`) to a module NodeRef exactly like tokensave. Cite type: fixture row shape `{"importer": "/repo/src/main.py", "file": "/repo/src/main.py"}`.

### Pattern D — QUERY_TOOL constant map (optional but matches tokensave)
**Source:** `src/graph/backends/tokensave-backend.ts:27-32`
```ts
const QUERY_TOOL = {
  callers_of: "tokensave_callers", callees_of: "tokensave_callees",
  imports_of: "tokensave_file_dependents", tests_for: "tokensave_test_map",
} as const;
```
**Rule:** For cr-graph, all 4 route to ONE tool, so instead map bober-pattern → cr-graph-pattern-string, e.g. `const CR_PATTERN = { callers_of:"callers_of", callees_of:"callees_of", imports_of:"importers_of", tests_for:"tests_for" } as const;`. **Note the `imports_of → "importers_of"` flip lives HERE — make it explicit and comment it.**

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---|---|---|---|
| `crToNodeRef` | `src/graph/backends/code-review-graph-backend.ts:119` | `(row: CrNodeRow) => NodeRef` | cr-graph row → NodeRef (qualified_name→id, file_path→file, etc.) |
| `crKind` | `src/graph/backends/code-review-graph-backend.ts:97` | `(kind?: string) => NodeRef["kind"]` | `"File"→"module"`; Function/Class lowercased; `"Test"`/unknown → `"symbol"` |
| `CrNodeRow` (type) | `src/graph/backends/code-review-graph-backend.ts:107` | type | shared cr-graph node-row shape incl. `is_test?` |
| `isTestRow` | `src/graph/backends/code-review-graph-backend.ts:135` | `(row: CrNodeRow) => boolean` | test partition (prefers `is_test`, falls back to `/test|spec/i`). NOT needed for queryPlan but exists. |
| `assertNever` | `src/graph/types.ts:150` | `(x: never) => never` | exhaustiveness default in the `switch` (import it — cr-graph backend doesn't yet) |
| `toNodeRef` | `src/graph/backends/tokensave-backend.ts:193` | tokensave-only | tokensave analogue — do NOT use here; use `crToNodeRef` |
| `loadFixture` (test) | `tests/graph/backends/code-review-graph-backend.test.ts:25` | `(name) => Promise<unknown>` | reads a fixture from `../fixtures/cr-graph` |
| `makeCrClient` (test) | `tests/graph/client.test.ts:692` | `(projectRoot, callImpl) => GraphClient` | e2e: injects `CodeReviewGraphBackend` + mocked transport |
| `loadCrFixture` (test) | `tests/graph/client.test.ts:687` | `(name) => Promise<unknown>` | e2e fixture loader |

Directories reviewed for reusable utils: `src/graph/`, `src/graph/backends/` — the above are all that apply. No `src/utils|lib|helpers|shared|common` module is relevant to this pure-adapter sprint.

---

## 4. Prior Sprint Output

### Sprint 5 (2ebe2af): read adapters + crToNodeRef/crKind helpers
**Created/modified:** `src/graph/backends/code-review-graph-backend.ts` — added `crToNodeRef` (:119), `crKind` (:97), `CrNodeRow` (:107), `isTestRow` (:135) and the 5 response adapters (search/impact/reviewContext/overview/changes). Added the cr-graph e2e block + `makeCrClient` in `tests/graph/client.test.ts:675-793`.
**Connection to this sprint:** `queryPlan` is the LAST NOT_IMPL method (:160-162). Reuse the Sprint-5 helpers verbatim; extend the existing test blocks. The `/repo` sandbox convention (projectRoot `"/repo"` keeps sanitized fixture nodes; a `tmp` root drops them) was established here — `client.test.ts:681-683,708-730`.

### Sprint 4: process/prereq/cli specs + first fixtures
**Created:** `tests/graph/fixtures/cr-graph/*` incl. `query_graph_tool.json`, `traverse_graph_tool.json`, `_args.json`. Confirmed `query_graph_tool` has a 15-value `pattern` enum incl. all 4 bober patterns (`_args.json:6-22`).

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` was found in scope for this sprint. The one hard rule enforced in code: `GraphClient` methods NEVER throw for expected failures — return `GraphResult.ok=false` (client.ts:1-9, ADR-3). The backend `narrow` MUST be pure (no I/O, no sandbox) — sandbox filtering is GraphClient's job (`backends/types.ts:59-63`).

### Architecture Decisions
`backends/types.ts:54-95` documents the backend seam (CallPlan + GraphBackend). ADR-3 (`types.ts:52`) = the GraphResult discriminated union. No new ADR needed.

### Other Docs
Sprint-4 briefing `.bober/briefings/...-4-briefing.md` §8-§10 = the fixture-capture recipe + raw ground truth (used to produce this sprint's captures). The `query_graph_tool` pattern enum is at §10.2 / `_args.json:6-22`.

---

## 6. Testing Patterns

### Unit Test Pattern (fixture-driven backend test)
**Source:** `tests/graph/backends/tokensave-backend.test.ts:74-146` (queryPlan block) + cr-graph fixture loading at `tests/graph/backends/code-review-graph-backend.test.ts:25-28,225-245`.
```ts
  describe("queryPlan", () => {
    const target: NodeRef = { id: "/repo/src/math_utils.py::multiply", kind: "function",
      file: "/repo/src/math_utils.py", line: 4, symbol: "multiply" };

    it("callers_of -> query_graph_tool importers... uses pattern 'callers_of' + target.id", () => {
      const plan = backend.queryPlan("callers_of", target);
      expect(plan.tool).toBe("query_graph_tool");
      expect(plan.params).toEqual({ pattern: "callers_of", target: target.id });
    });

    it("callers_of narrows the real fixture -> INBOUND NodeRef[]", async () => {
      const nodes = backend.queryPlan("callers_of", target).narrow(
        await loadFixture("query_graph_callers_of_tool.json"));
      expect(nodes.map(n => n.symbol).sort()).toEqual(["compute", "test_multiply"]);
    });

    it("callees_of narrows -> OUTBOUND NodeRef[] (distinct from callers)", async () => {
      const nodes = backend.queryPlan("callees_of", target).narrow(
        await loadFixture("query_graph_callees_of_tool.json"));
      // range (builtin) has no file_path -> file undefined; add is in-repo
      expect(nodes.map(n => n.symbol).sort()).toEqual(["add", "range"]);
    });

    // ── THE required edge-direction assertion (sc-6-2) ──
    it("callers_of != callees_of for the same node with distinct in/out edges", async () => {
      const inbound  = backend.queryPlan("callers_of", target).narrow(
        await loadFixture("query_graph_callers_of_tool.json")).map(n => n.symbol).sort();
      const outbound = backend.queryPlan("callees_of", target).narrow(
        await loadFixture("query_graph_callees_of_tool.json")).map(n => n.symbol).sort();
      expect(inbound).not.toEqual(outbound);          // must differ
      expect(inbound).toEqual(["compute", "test_multiply"]);
      expect(outbound).toEqual(["add", "range"]);
    });

    it("imports_of -> pattern 'importers_of' + target.file; module NodeRefs from results[].importer", async () => {
      const plan = backend.queryPlan("imports_of",
        { ...target, file: "src/math_utils.py" });
      expect(plan.params).toEqual({ pattern: "importers_of", target: "src/math_utils.py" });
      const nodes = plan.narrow(await loadFixture("query_graph_importers_of_tool.json"));
      expect(nodes.map(n => n.file).sort())
        .toEqual(["/repo/src/main.py", "/repo/tests/test_math_utils.py"]);
      expect(nodes.every(n => n.kind === "module")).toBe(true);
    });

    it("tests_for -> pattern 'tests_for' + target.id (NOT file); test-symbol NodeRefs", async () => {
      const plan = backend.queryPlan("tests_for", target);
      expect(plan.params).toEqual({ pattern: "tests_for", target: target.id });
      const nodes = plan.narrow(await loadFixture("query_graph_tests_for_tool.json"));
      expect(nodes.map(n => n.symbol).sort()).toEqual(["test_add", "test_multiply"]);
    });
  });
```
**Runner:** vitest. **Assertion style:** `expect(...)`. **Mock approach:** `vi.mock("execa")` at top (already present :15-17) — not needed for pure narrow, but the file has it. **File naming:** `<name>.test.ts` co-located under `tests/graph/backends/`. **Location:** `tests/graph/backends/`.

### End-to-End Test Pattern (mocked transport through GraphClient — sc-6-5)
**Source:** `tests/graph/client.test.ts:692-793` (`makeCrClient` + Sprint-5 e2e block). Add 4 cases to that describe block:
```ts
  it("query(callers_of): ok:true INBOUND NodeRef[], sandboxed to /repo", async () => {
    const fixture = await loadCrFixture("query_graph_callers_of_tool.json");
    const client = makeCrClient("/repo", async () => fixture);
    const target = { id: "/repo/src/math_utils.py::multiply", kind: "function" as const,
      file: "/repo/src/math_utils.py", line: 4, symbol: "multiply" };
    const r = await client.query("callers_of", target);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.map(n => n.symbol).sort()).toEqual(["compute", "test_multiply"]);
  });

  it("query(callees_of): builtin 'range' (no file_path) is sandbox-dropped, leaving [add]", async () => {
    const fixture = await loadCrFixture("query_graph_callees_of_tool.json");
    const client = makeCrClient("/repo", async () => fixture);
    const target = { id: "/repo/src/math_utils.py::multiply", kind: "function" as const,
      file: "/repo/src/math_utils.py", line: 4, symbol: "multiply" };
    const r = await client.query("callees_of", target);
    // keepNode (client.ts:241) drops nodes with no .file -> range gone, add kept
    if (r.ok) expect(r.data.map(n => n.symbol)).toEqual(["add"]);
  });
  // + query(imports_of) and query(tests_for) similarly.
```
**Selector convention / sandbox:** projectRoot `"/repo"` keeps the sanitized fixture nodes; a `tmp` root drops them all (`client.test.ts:724-730,769-779`). No Playwright/E2E-browser layer in this project.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|---|---|---|---|
| `src/graph/backends/registry.ts` (:23,30) | constructs `CodeReviewGraphBackend` | low | Only instantiates it; queryPlan change is additive |
| `src/graph/client.ts` (:72-77) | `backend.queryPlan()` via `query()` | low | Signature unchanged (`CallPlan<NodeRef[]>`); no client change |
| `tests/graph/client.test.ts` (:703) | `makeCrClient` injects backend | medium | The Sprint-5 e2e block must still pass; you ADD 4 query cases |
| `tests/graph/cli-backend-injection.test.ts` (:29,61) | constructs backend for CLI | low | Uses cliMap only — unaffected |
| `tests/graph/pipeline-lifecycle-backend.test.ts` | `processSpec` | low | Uses process/serve only — unaffected |

### Existing Tests That Must Still Pass
- `tests/graph/backends/code-review-graph-backend.test.ts` — you REPLACE the `queryPlan still throws NOT_IMPL` case (:351-358) with the real queryPlan block; all other cases (search/impact/reviewContext/overview/changes/cli/prereq) must stay green.
- `tests/graph/client.test.ts` — the Sprint-5 cr-graph e2e block (:707-793) AND the tokensave query block (:186-256) must stay green (proves tokensave path is untouched — sc-6-6).
- `tests/graph/backends/tokensave-backend.test.ts` — must NOT change (nonGoal: tokensave query mapping unchanged).
- `tests/graph/backends/code-review-graph-live.test.ts` — skipIf-guarded live test; unaffected (skips when binary absent).

### Features That Could Be Affected
- **tokensave query path** — shares `GraphClient.query` + `QueryPattern` union but a DIFFERENT backend. Verify `tokensave-backend.ts` and its test are byte-unchanged (nonGoal in contract lines 52-53).
- **Backend auto-detection (Sprint 3)** — `registry.ts` selects cr-graph when tokensave absent. queryPlan becoming real only removes a throw; consistent NodeRef shape (sc-6-6) is the guarantee to preserve.

### Recommended Regression Checks (runnable)
1. `npm run build && npm run typecheck` — zero errors (sc-6-1). (New import `assertNever` must resolve.)
2. `npx vitest run tests/graph/backends/code-review-graph-backend.test.ts` — new queryPlan block green.
3. `npx vitest run tests/graph/client.test.ts` — cr-graph e2e + tokensave query blocks green.
4. `npx vitest run tests/graph/` then full `npx vitest run` — no NEW failures (sc-6-6).
5. `npm run lint` — clean.
6. `git diff --stat src/graph/backends/tokensave-backend.ts` — MUST be empty (tokensave untouched).

---

## 8. Implementation Sequence (dependency-ordered)

1. **Fixtures** — DONE (Curator committed 5 `query_graph_*_tool.json` + extended `_args.json`). Verify: each parses as JSON and has `results` (or `importer`/`import_target`) rows. No code work.
2. **src/graph/backends/code-review-graph-backend.ts** — add `assertNever` to the `../types.js` import (:16); add a `CR_PATTERN` map (or inline strings) with the `imports_of → "importers_of"` flip; replace `queryPlan` (:160-162) with the `switch(pattern)`. Reuse `crToNodeRef`. Verify: `npm run typecheck` passes; `assertNever` covers all 4 arms.
3. **tests/graph/backends/code-review-graph-backend.test.ts** — replace the NOT_IMPL case (:351-358) with the queryPlan describe block (§6), incl. the `callers_of != callees_of` assertion (sc-6-2). Verify: `npx vitest run` on that file is green.
4. **tests/graph/client.test.ts** — add 4 `query(...)` e2e cases into the existing cr-graph describe block (:707-793) using `makeCrClient`. Verify: green, incl. the `range` sandbox-drop case.
5. **Run full verification** — `npm run build && npm run typecheck && npx vitest run && npm run lint`. Commit `bober(sprint-6): code-review-graph query sub-patterns (callers/callees/imports/tests) — full parity`.

---

## 9. Pitfalls & Warnings

- **⚠ DIRECTION TRAP #1 (imports_of):** bober `imports_of` = tokensave `file_dependents` = **DEPENDENTS (who imports the target)**. In cr-graph that is pattern **`importers_of`**, NOT `imports_of`. Live proof: `importers_of(src/math_utils.py)` → `[main.py, test file]` (matches tokensave); `imports_of(src/math_utils.py)` → `0`; `imports_of(src/main.py)` → `[math_utils.py]` (the OPPOSITE direction). Using cr-graph `imports_of` silently returns wrong data — the exact bug the evaluator warns about (contract :77). Fixture `query_graph_imports_of_tool.json` is committed ONLY to document this trap; the adapter must NOT use it.
- **⚠ DIRECTION TRAP #2 (tests_for target):** cr-graph `tests_for` keys on a **symbol (qualified_name)**, not a file. `tests_for(src/math_utils.py)` → `0`; `tests_for(.../multiply)` → `[test_multiply, test_add]`. Pass **`target.id`**, NOT `target.file`. (tokensave's tests_for keys on `file` — this is the one param that differs between backends. Both still return `NodeRef[]`, satisfying parity.)
- **⚠ AMBIGUOUS bare names:** a bare symbol target (`"multiply"`) returns `status:"ambiguous"` with `candidates`/`disambiguation` and NO `results`. Always pass the qualified_name (`target.id`) for callers/callees/tests_for, and default `results ?? []` in every narrow.
- **⚠ imports_of rows are NOT CrNodeRow:** `importers_of` results are `{importer, file}` (path strings, no name/kind/line); `imports_of` results are `{import_target}`. `crToNodeRef` would produce empty NodeRefs — build module NodeRefs from the path string directly (Pattern C). Use `results[].importer` (fall back to `.file`).
- **Builtin callees have no file_path:** `callees_of(multiply)` includes `range` with only `{kind, name, qualified_name:"range"}` — no `file_path`. `crToNodeRef` yields `file: undefined`; the pure-narrow unit test sees 2 rows, but the E2E path drops it via `keepNode` (client.ts:241, `!node.file`). Assert accordingly (unit: `["add","range"]`; e2e under `/repo`: `["add"]`).
- **NO GRAPH_UNAVAILABLE needed:** all 4 patterns have a real, verified cr-graph mapping — do NOT take the `ok:false` shortcut. (Contract sc-6-5 allows it ONLY as a documented genuine limitation; there is none here.)
- **Do NOT use `traverse_graph_tool`:** despite the contract's early hypothesis, `traverse_graph_tool` takes `{query, mode:"bfs"/"dfs", depth}` — it has NO direction/edge-kind argument and returns a flat mixed `traversal` array (from `compute` it returns multiply+add+Calculator+run+files+helper — callers, callees, and containers intermixed; see `tests/graph/fixtures/cr-graph/traverse_graph_tool.json`). It cannot separate inbound vs outbound. `query_graph_tool` does the direction split by pattern name — use it for all 4.
- **Don't reshape fixtures / don't touch tokensave:** the committed fixtures are real cr-graph payloads (capitalized `kind`, `line_start`/`line_end`, `_graph` envelope). Keep them byte-faithful. `tokensave-backend.ts`, `mcp-client.ts`, and `client.ts` are all out of scope (nonGoals, contract :52-56).
- **Add the `assertNever` import:** cr-graph backend does not currently import it (tokensave does at :12). Without it the `default` arm won't compile as exhaustive.
