# Sprint Briefing: code-review-graph backend — process/prereq/CLI specs + capture live fixtures

**Contract:** sprint-spec-20260726-graph-backend-choice-4
**Generated:** 2026-07-27T00:00:00Z
**Live MCP probe:** SUCCEEDED. Real binary `code-review-graph 2.3.7` at `~/Library/Python/3.12/bin/code-review-graph`; MCP `serve` `serverInfo.version=3.4.4`; enumerated **30 real tools, all `_tool`-suffixed**; captured populated payloads for every adapter tool. See §10.

---

## 0. TL;DR for the Generator (read this first)

1. This is an **analogy sprint**: mirror `TokensaveBackend` (`src/graph/backends/tokensave-backend.ts`) exactly. Fill in `CodeReviewGraphBackend.cliMap()` and (already-correct) `processSpec()`/`prereqSpec()`. **Do NOT touch the 6 `*Plan` adapters — they stay `throw new Error(NOT_IMPL)` (Sprints 5-6).**
2. The live binary WAS reachable and I DID capture real fixtures. **Take the real-capture path, not the sc-4-6 provisional fallback.** The exact payloads are in §10 — commit them (sanitized) under `tests/graph/fixtures/cr-graph/`.
3. **CRITICAL ENV GOTCHA (§9):** in this environment `code-review-graph build` yields **0 nodes** for BOTH python AND typescript, because cr-graph's parser-load probe runs `python -I` (isolated) which cannot see the `--user`-installed `tree_sitter_language_pack`. To get a *populated* graph you MUST use the venv+`.pth` workaround in §8. Building against THIS repo (TypeScript) will also give 0 nodes — do not rely on it.
4. cr-graph's tool output shapes are **structurally different from tokensave's** bare `Ts*Row` arrays: every payload is an object `{status, summary, ...results, _graph}` with an absolute `file_path` and a trailing `_graph` staleness envelope. This satisfies the evaluator's "must differ from tokensave shapes" bar.

---

## 1. Target Files

### `src/graph/backends/code-review-graph-backend.ts` (modify)

Current stub (already real for id/processSpec/prereqSpec; `cliMap` throws). Lines to change: **79-82** (`cliMap`). Leave 32-57 (the 6 `*Plan` adapters) untouched.

```ts
// code-review-graph-backend.ts:61-82  (CURRENT)
processSpec(): ProcessSpec {
  return { binary: "code-review-graph", serveArgs: ["serve"] };   // ✓ already correct (sc-4-2)
}
prereqSpec(): PrereqSpec {
  return {
    versionArgs: ["--version"],                                    // ✓ `--version` verified live (§7)
    isCompatible: (_version: string) => true,                      // accept-any (sc-4-2 assumption)
    installHint: (platform) => codeReviewGraphInstallHint(platform), // "pip install code-review-graph" ✓
    incompatibleHint: (detected) => `code-review-graph ${detected} version gate is a TODO (Sprints 4-6)`,
  };
}
cliMap(): CliMap { throw new Error(NOT_IMPL); }   // ← REPLACE THIS (see §2 for the concrete map)
```

`NOT_IMPL` const is at line 24-25 and is asserted verbatim by `tests/graph/cli-backend-injection.test.ts:63` — **do not change the string**.

**Imports this file uses:** `ImpactReport, NodeRef, SearchHit` from `../types.js`; `CallPlan, CliMap, GraphBackend, Platform, PrereqSpec, ProcessSpec, QueryPattern, SearchOpts` from `./types.js`. (Add `StatusResult` from `../types.js` for `parseStatus`.)
**Imported by:** `src/graph/backends/registry.ts:23`, `tests/graph/cli-backend-injection.test.ts:23`, `tests/graph/pipeline-lifecycle-backend.test.ts:43`.
**Test file:** `tests/graph/backends/code-review-graph-backend.test.ts` — **does not exist** (create it).

### `tests/graph/backends/code-review-graph-backend.test.ts` (create)

**Directory pattern:** backend tests live in `tests/graph/backends/*.test.ts`. **Most similar existing file:** `tests/graph/backends/tokensave-backend.test.ts` — copy its structure (see §6).

### `tests/graph/fixtures/cr-graph/` (create)

Fixtures dir does **not** exist yet. Write one `<tool>.json` per adapter tool (the parsed `result.content[].text` payload) — see §10 for exact contents. Add `_args.json` documenting each tool's argument shape (§10.2).

---

## 2. RECOMMENDED CliMap (from the live probe — §7)

cr-graph verbs: **init = MCP registration (NOT a build)**; `build` = full build; `update` = incremental; `status --json` = machine-readable stats. Mirror `tokensave-backend.ts:360-371`.

```ts
cliMap(): CliMap {
  return {
    // cr-graph 'build' has no --tier flag; languageTier is manifest-only (same as tokensave).
    initArgs: (_opts) => ["build"],                 // sc-4-3: init -> build (full build)
    syncArgs: (paths) => ["update", ...paths],      // sc-4-3: sync -> update (incremental)
    statusArgs: ["status", "--json"],               // --json verified live (§7)
    parseSync: (out) => parseCrGraphSyncOutput(out),
    parseStatus: (stdout) => parseCrGraphStatusOutput(stdout),
  };
}
```

**`parseSync` ground truth (real CLI output, §7):**
- Full build (`build`): `Full build: 2 files, 8 nodes, 15 edges (postprocess=full)`
- Incremental (`update`): `Incremental: 2 files updated, 6 nodes, 10 edges (postprocess=full)`
- `-q/--quiet` prints **nothing** — do NOT pass `-q`.
Return the file count. A single regex handles both: `/(\d+)\s+files?\b/` captures `2` from `2 files` and `2 files updated`. (Model it on `parseSyncOutput` at `tokensave-backend.ts:66-99`, including the ANSI-strip at line 69 — cr-graph output is plain here but strip defensively.)

**`parseStatus` ground truth (real `status --json`, §7):**
```json
{"nodes": 8, "edges": 15, "files": 2, "languages": ["python"], "last_updated": "2026-07-27T03:36:10",
 "vcs": "git", "built_on_branch": "master", "built_at_commit": "8a78...", "current_branch": "master",
 "current_sha": "8a78...", "svn_branch": null, "svn_revision": null}
```
Keys are `files`/`nodes`/`edges` (NOT tokensave's `file_count`/`node_count`). Map to the shared `StatusResult` (`src/graph/types.ts:44-48` → `{ready, indexedFileCount, tokensaveVersion}`):
```ts
function parseCrGraphStatusOutput(stdout: string): StatusResult {
  const p = JSON.parse(stdout) as Record<string, unknown>;
  const files = typeof p.files === "number" ? p.files : 0;
  const ready = typeof p.files === "number" || typeof p.nodes === "number";
  return { ready, indexedFileCount: files, tokensaveVersion: "" }; // status has no version field
}
```
(`tokensaveVersion` is a mis-named generic field on the shared `StatusResult`; cr-graph `status --json` carries no version, so `""`. Model on `parseStatusOutput` at `tokensave-backend.ts:102-124`.)

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---|---|---|---|
| `parseSyncOutput` (template) | `src/graph/backends/tokensave-backend.ts:66-99` | `(output: string) => number` | Reference impl for `parseSync`; copy the ANSI-strip + regex approach. |
| `parseStatusOutput` (template) | `src/graph/backends/tokensave-backend.ts:102-124` | `(stdout: string) => StatusResult` | Reference impl for `parseStatus`. |
| `GenericPrereqCheck` | `src/graph/prereq.ts:15-54` | `new (binary, PrereqSpec).check(): Promise<PrereqResult>` | Backend-agnostic version gate — runs `<binary> --version`, extracts semver, applies `isCompatible`. Reuse for the prereq unit test (execa mocked). |
| `defaultProbe` (private) | `src/graph/backends/registry.ts:47-61` | `(binary, args) => Promise<{ok, version?}>` | Detection probe used by `resolveGraphBackend`. Do not duplicate. |
| `binaryForBackend` | `src/graph/backends/registry.ts:70-82` | `(GraphBackend, BoberConfig) => string` | Resolves `codeReviewGraphPath` override → binary name. Already handles cr-graph (line 78-80). |
| `resolveGraphBackend` | `src/graph/backends/registry.ts:95-129` | `(config, {probe?}) => Promise<GraphBackend>` | Selection logic. Already selects cr-graph (sc-4-5). Add tests only. |
| `unwrapMcpContent` (private) | `src/graph/mcp-client.ts:80-101` | `(result) => unknown` | Unwraps `result.content[].text` → JSON.parse. This is what a fixture MUST equal (the parsed payload). |
| `semver` | npm (`import semver from "semver"`) | `semver.satisfies/valid` | Version parsing. cr-graph uses accept-any this sprint, so `semver` is optional here. |
| `hasTokensave` probe (template) | `tests/graph/mcp-client.test.ts:22-31`, `tests/graph/hook-integration.test.ts:14-20` | `() => boolean` via `spawnSync` | **Copy verbatim** as `hasCrGraph()` for skipIf gating (§4). |

Utilities reviewed: `src/graph/` (backends, prereq, registry, mcp-client, types) — the table covers all relevant ones. No `utils/`/`lib/`/`helpers/` symbol applies to this pure-adapter sprint.

---

## 4. skipIf Gating Pattern (mirror for cr-graph)

tokensave integration tests gate on binary presence with `spawnSync` (NOT execa, so the `vi.mock("execa")` in the same file does not interfere) and `describe.skipIf` / `it.skipIf`:

```ts
// tests/graph/hook-integration.test.ts:14-20 + :32  (COPY THIS SHAPE)
import { spawnSync } from "node:child_process";
const hasCrGraph = (() => {
  try {
    // NB: binary is NOT on default PATH in this env — allow a config/env override.
    const bin = process.env.CRG_BIN ?? "code-review-graph";
    return spawnSync(bin, ["--version"]).status === 0;
  } catch { return false; }
})();

describe.skipIf(!hasCrGraph)("cr-graph live integration (sc-4-5)", () => {
  it("initialize-handshakes a real `code-review-graph serve` via the parameterized transport", async () => { /* ... */ });
});
```

- **sc-4-5 handshake test:** construct `TokensaveMcpClient(root, cfg, incidents, new CodeReviewGraphBackend().processSpec())` and `await start()`; assert `health()==="ready"`. The transport is backend-parameterized already (`mcp-client.ts:243` uses `this.processSpec.binary` + `this.cfg.tokensavePath` — note the cr-graph path override is NOT yet wired into `spawnAndHandshake`; for the test, pass the binary via `processSpec.binary` or set `cfg.tokensavePath` to the resolved cr-graph path, and gate the test so it never fails when absent).
- **Real capture, NOT default CI:** these tests MUST skip (not fail) when the binary is absent (nonGoal: no live cr-graph in default CI path).

---

## 5. Prior Sprint Output & Config

- **Sprint 3** created the stub `src/graph/backends/code-review-graph-backend.ts` (processSpec/prereqSpec real; cliMap + adapters throw) and registered it in `KNOWN_BACKENDS` (`registry.ts:28-31`, cr-graph second). You flesh out `cliMap` only.
- **Sprint 2** built the tokensave process/prereq/cli specs — the template (`tokensave-backend.ts:34-372`) — plus `GenericPrereqCheck` (`prereq.ts`), the `ProcessSpec`/`PrereqSpec`/`CliMap` interfaces (`backends/types.ts:31-52`), and `resolveGraphBackend` (`registry.ts`).
- **Config schema** already has the fields (no schema change needed): `src/config/schema.ts:398` `backend: z.enum(["tokensave","code-review-graph"]).optional()`, `:400` `codeReviewGraphPath: z.string().optional()`, `:396` `tokensavePath`.
- **Original cr-graph adapter (git history `6ed3f77~1:src/graph/client.ts`)** — tool-name prior, now superseded by the live `_tool`-suffixed names:
  `{search:"semantic_search_nodes", query:"query_graph", impact:"get_impact_radius", reviewContext:"get_review_context", overview:"get_architecture_overview", changes:"detect_changes"}`. The live names all add `_tool` (§10). Use this only as a name/shape prior; the §10 live captures win.

---

## 6. Testing Patterns

**Runner:** vitest. **Assertion:** `expect`. **Mock:** `vi.mock("execa")`. **Location:** collocated under `tests/graph/backends/`. **File naming:** `<module>.test.ts`.

### Unit test template (from `tests/graph/backends/tokensave-backend.test.ts`)
```ts
// tokensave-backend.test.ts:280-335  (cliMap block — mirror for cr-graph)
describe("cliMap", () => {
  const cliMap = backend.cliMap();
  it("initArgs is ['build']", () => { expect(cliMap.initArgs({})).toEqual(["build"]); });
  it("syncArgs is ['update', ...paths]", () => {
    expect(cliMap.syncArgs(["src/"])).toEqual(["update", "src/"]);
  });
  it("statusArgs is ['status','--json']", () => { expect(cliMap.statusArgs).toEqual(["status","--json"]); });
  it("parseSync reads 'Full build: N files'", () => {
    expect(cliMap.parseSync("Full build: 2 files, 8 nodes, 15 edges (postprocess=full)")).toBe(2);
  });
  it("parseSync reads 'Incremental: N files updated'", () => {
    expect(cliMap.parseSync("Incremental: 2 files updated, 6 nodes, 10 edges (postprocess=full)")).toBe(2);
  });
  it("parseStatus maps {files,nodes} -> {ready,indexedFileCount}", () => {
    const r = cliMap.parseStatus(JSON.stringify({ nodes: 8, edges: 15, files: 2, languages: ["python"] }));
    expect(r.ready).toBe(true); expect(r.indexedFileCount).toBe(2); expect(r.tokensaveVersion).toBe("");
  });
});
```

### Prereq test (execa mocked) — sc-4-2
`GenericPrereqCheck` mocking pattern: mock execa to return `{exitCode:0, stdout:"code-review-graph 2.3.7"}` → `check()` ok; return an unparseable/incompatible line → `INCOMPATIBLE` with the pip hint. Since cr-graph `isCompatible` is accept-any, test that a valid semver passes and that a MISSING binary (execa throws / exitCode!=0) returns `{ok:false, reason:"MISSING", hint:"pip install code-review-graph"}` (prereq.ts:29,32). For an "incompatible" assertion under accept-any, drive it through a non-semver `--version` line so `semver.valid` fails at `prereq.ts:38` → INCOMPATIBLE.

### Selection test template (from `tests/graph/backends/registry.test.ts:41-47, 82-90`)
```ts
it("selects code-review-graph when only cr-graph is detected", async () => {
  const probe: VersionProbe = vi.fn(async (b) => b === "code-review-graph" ? {ok:true,version:"2.3.7"} : {ok:false});
  expect((await resolveGraphBackend(makeConfig({enabled:true}), {probe})).id).toBe("code-review-graph");
});
it("explicit backend:'code-review-graph' wins with no probe", async () => { /* registry.test.ts:82-90 */ });
```
(These selection cases already exist in `registry.test.ts` — extend/duplicate only if adding version-string assertions.)

---

## 7. Live CLI Probe Results (ground truth — captured 2026-07-27)

`code-review-graph --version` → `code-review-graph 2.3.7`. Top-level verbs include: `install, init(=install alias), build, update, postprocess, embed, watch, status, detect-changes, query, impact, search, architecture, communities, dead-code, serve, mcp, daemon`.

- `build --help`: `[--repo REPO] [-q] [--skip-flows] [--skip-postprocess] [--data-dir DATA_DIR] [--embedding-provider ...]`. Output: `Full build: N files, N nodes, N edges (postprocess=full)`.
- `update --help`: `[--base BASE] [--repo REPO] [-q] [--brief] [--verify] [--data-dir DATA_DIR] ...`. `--base` default `HEAD~1`. Output: `Incremental: N files updated, N nodes, N edges (postprocess=full)`.
- `status --help`: `[--repo REPO] [-q] [--json] [--data-dir DATA_DIR]`. `--json` → single machine-readable object (shape in §2).
- `detect-changes --help`: `[--base BASE] [--brief] [--repo REPO] [--churn] [--verify]`. Default (no `--brief`) prints JSON; read-only, no re-parse. (Not used by cliMap — status is the status verb.)
- MCP server verb: **`serve`** (stdio by default; `mcp` is an alias). Use `serveArgs: ["serve"]` (already set).

---

## 8. Fixture-Capture Recipe (reproduce this — the scratchpad is per-session, so RE-CAPTURE)

**Why:** In this env a plain `code-review-graph build` gives 0 nodes (parser blocker, §9). Use a throwaway venv whose `.pth` re-adds the user site-packages so the isolated `python -I` parser probe passes.

```bash
export PATH="$HOME/Library/Python/3.12/bin:$PATH"   # binary not on default PATH
BIN="$HOME/Library/Python/3.12/bin/code-review-graph"
US="$HOME/Library/Python/3.12/lib/python/site-packages"
WORK=$(mktemp -d)                                    # sample PYTHON project (TS parser also unavailable!)
cd "$WORK"; git init -q; git config user.email t@t.co; git config user.name t
mkdir src
# write 2 small python files w/ inter-file calls + a class (see math_utils.py/main.py in §10)
git add -A && git commit -qm init
# venv + .pth workaround so BUILD can parse:
python3 -m venv .venv
echo "$US" > .venv/lib/python3.12/site-packages/crguser.pth
.venv/bin/python -m code_review_graph build          # -> "Full build: 2 files, 8 nodes, 15 edges"
# SERVE with the INSTALLED binary (venv serve lacks platformdirs); it reads the same graph.db:
#   pipe JSON-RPC initialize -> notifications/initialized -> tools/call into `$BIN serve` (cwd=$WORK)
#   unwrap result.content[].text, JSON.parse, save to tests/graph/fixtures/cr-graph/<tool>.json
```

**Capture tools (args verified live):**
| Tool | tools/call arguments used |
|---|---|
| `semantic_search_nodes_tool` | `{"query":"add","limit":5}`  (required: `query`) |
| `query_graph_tool` | `{"pattern":"callers_of","target":"add"}`  (required: `pattern`,`target`) |
| `get_impact_radius_tool` | `{"changed_files":["src/math_utils.py"]}` |
| `get_review_context_tool` | `{"changed_files":["src/main.py"]}` |
| `get_architecture_overview_tool` | `{}` |
| `detect_changes_tool` | `{"base":"HEAD~1"}` (needs a committed code-change diff to populate `changed_functions`) |
| `traverse_graph_tool` | `{"query":"compute"}`  (required: `query`) |

**Sanitize before commit:** the live payloads embed the ABSOLUTE sample-project path in every `file_path`/`qualified_name`. Replace the `mktemp` prefix with a stable placeholder (e.g. `/repo`) so the committed fixture is deterministic. Keep the structure/keys byte-for-byte.

---

## 9. PITFALLS & WARNINGS

- **PARSER BLOCKER (root cause):** cr-graph's parser-load probe (`parser.py:357-405`) runs `subprocess([sys.executable,"-I","-c",...])`. `-I` (isolated) ignores the `--user` site-packages where `tree_sitter_language_pack` (0.13.0) lives, so EVERY language is "Skipping unavailable tree-sitter parser" → **0 nodes**. Affects python AND typescript. Fix ONLY via the venv+`.pth` recipe (§8). **Do NOT `pip install` anything into the user/system env (nonGoal).** The `.pth` trick modifies nothing outside the throwaway venv.
- **`init` is NOT a build.** cr-graph `init` = MCP registration (alias of `install`). The graph is built with `build`/`update`. `cliMap.initArgs` must be `["build"]`.
- **`serve` needs full deps; `build` needs the parser.** venv `-m code_review_graph serve` crashes (`ModuleNotFoundError: platformdirs`). Build with the venv python (parser), then **serve with the installed binary** against the on-disk `graph.db` (§8).
- **`-q/--quiet` prints nothing** → `parseSync` gets `""`. Never pass `-q` on the sync/init path.
- **Tool names carry `_tool`.** Live names differ from git-history: `semantic_search_nodes_tool`, `query_graph_tool`, `get_impact_radius_tool`, etc. (§10). The `_tool` suffix is confirmed real.
- **Shapes differ from tokensave.** cr-graph returns objects `{status, summary, results/impacted_nodes/…, _graph}` with absolute `file_path`, `qualified_name`, `kind` capitalized (`"Function"`,`"Class"`,`"File"`), `line_start`/`line_end` (NOT `line`), and a `_graph` staleness envelope on EVERY payload. Do not reshape fixtures to look like `Ts*Row` — the evaluator rejects that.
- **`get_impact_radius_tool` takes `changed_files`+`base`, not a `node_id`** (unlike tokensave `impact`). `query_graph_tool` takes a string `target` (a bare name or `qualified_name`), not a node object. Adapter param-building is Sprints 5-6 — just capture the shapes now.
- **Binary not on default PATH.** Tests/probe must resolve it (`$HOME/Library/Python/3.12/bin`, or `config.graph.codeReviewGraphPath`, or `CRG_BIN`). skipIf must skip-not-fail when absent.
- **Do NOT modify** `tokensave-backend.ts`, `mcp-client.ts` wire protocol, or the tokensave path (nonGoal). No new npm/pip deps.

---

## 10. RAW CAPTURED GROUND TRUTH

### 10.1 Full MCP tools/list (30 tools, `serve` transport, serverInfo.version=3.4.4)
```
build_or_update_graph_tool  run_postprocess_tool  get_minimal_context_tool  get_impact_radius_tool
query_graph_tool  get_review_context_tool  semantic_search_nodes_tool  embed_graph_tool
list_graph_stats_tool  get_docs_section_tool  find_large_functions_tool  list_flows_tool
get_flow_tool  get_affected_flows_tool  list_communities_tool  get_community_tool
get_architecture_overview_tool  detect_changes_tool  refactor_tool  apply_refactor_tool
generate_wiki_tool  get_wiki_page_tool  get_hub_nodes_tool  get_bridge_nodes_tool
get_knowledge_gaps_tool  get_surprising_connections_tool  get_suggested_questions_tool
traverse_graph_tool  list_repos_tool  cross_repo_search_tool
```

### 10.2 Input schemas for the 7 adapter tools (_args.json content)
```
semantic_search_nodes_tool : query*(str), kind, limit, repo_root, model, provider, detail_level
query_graph_tool           : pattern*, target*, repo_root, detail_level, max_results
get_impact_radius_tool     : changed_files, max_depth, repo_root, base, detail_level
get_review_context_tool    : changed_files, max_depth, include_source, max_lines_per_file, repo_root, base, detail_level
get_architecture_overview_tool : repo_root, detail_level
detect_changes_tool        : base, changed_files, include_source, max_depth, repo_root, detail_level
traverse_graph_tool        : query*, mode, depth, token_budget, repo_root
```
`query_graph_tool` valid `pattern` enum (from the server's own error): `callers_of, callees_of, imports_of, importers_of, children_of, tests_for, inheritors_of, triggers_of, triggered_by, publishers_of, listeners_of, handlers_of, endpoints_for, consumers_of, file_summary`. (bober's 4 `QueryPattern`s — `callers_of/callees_of/imports_of/tests_for` — are ALL present.)

### 10.3 Sample sources used (recreate in §8)
```python
# src/math_utils.py
def add(a, b): return a + b
def multiply(a, b):
    total = 0
    for _ in range(b): total = add(total, a)
    return total
class Calculator:
    def compute(self, a, b): return multiply(add(a, b), 2)
# src/main.py
from src.math_utils import Calculator, add
def run():
    c = Calculator(); return add(c.compute(1, 2), 10)
def helper(): return run() + 1
```

### 10.4 Real payloads (parsed result.content[].text; `<P>` = absolute project path, sanitize on commit)

**semantic_search_nodes_tool.json** `{query:"add"}`:
```json
{"status":"ok","query":"add","search_mode":"fts","summary":"Found 1 node(s) matching 'add'",
 "results":[{"name":"add","qualified_name":"<P>/src/math_utils.py::add","kind":"Function",
   "file_path":"<P>/src/math_utils.py","line_start":1,"line_end":2,"language":"python",
   "params":"(a, b)","return_type":null,"signature":"def add((a, b))","score":0.016393}],
 "_hints":{"next_steps":[{"tool":"query_graph","suggestion":"..."}],"related":[],"warnings":[]},
 "_graph":{"updated_at":"...","age_seconds":139,"built_on_branch":"master","built_at_sha":"8a78...",
   "head_sha":"8a78...","head_matches_build":true}}
```

**query_graph_tool.json** `{pattern:"callers_of",target:"add"}` (result row + edge row shapes):
```json
{"status":"ok","pattern":"callers_of","target":"<P>/src/math_utils.py::add",
 "description":"Find all functions that call a given function","summary":"Found 3 result(s) ...",
 "result_count":3,"results_omitted":0,
 "results":[{"id":2,"kind":"Function","name":"run","qualified_name":"<P>/src/main.py::run",
   "file_path":"<P>/src/main.py","line_start":3,"line_end":5,"language":"python",
   "parent_name":null,"is_test":false}, ...(multiply, Calculator.compute)],
 "edges":[{"id":4,"kind":"CALLS","source":"<P>/src/main.py::run","target":"<P>/src/math_utils.py::add",
   "file_path":"<P>/src/main.py","line":5,"confidence":1.0,"confidence_tier":"EXTRACTED"}, ...],
 "_graph":{...}}
```

**get_impact_radius_tool.json** `{changed_files:["src/math_utils.py"]}` (envelope + node/edge rows):
```json
{"status":"ok","summary":"Blast radius for 1 changed file(s):\n  - 5 nodes directly changed\n  - 3 nodes impacted (within 2 hops)\n  - 1 additional files affected",
 "changed_files":["src/math_utils.py"],
 "changed_nodes":[{"id":5,"kind":"Function","name":"add","qualified_name":"<P>/src/math_utils.py::add",
   "file_path":"<P>/src/math_utils.py","line_start":1,"line_end":2,"language":"python","parent_name":null,"is_test":false}, ...],
 "impacted_nodes":[{"id":2,"kind":"Function","name":"run","qualified_name":"<P>/src/main.py::run",
   "file_path":"<P>/src/main.py","line_start":3,"line_end":5,"language":"python","parent_name":null,"is_test":false,"impact_score":0.6}, ...],
 "impacted_files":["<P>/src/main.py"],
 "edges":[{"id":1,"kind":"IMPORTS_FROM","source":"<P>/src/main.py","target":"<P>/src/math_utils.py","file_path":"<P>/src/main.py","line":1,"confidence":1.0,"confidence_tier":"EXTRACTED"}, ...(CONTAINS, CALLS)],
 "truncated":false,"total_impacted":3,"nodes_omitted":0,
 "context_savings":{"estimated":true,"saved_tokens":0,"saved_percent":0},"_graph":{...}}
```

**get_review_context_tool.json** `{changed_files:["src/main.py"]}` (nested `context`):
```json
{"status":"ok","summary":"Review context for 1 changed file(s): ...",
 "context":{"changed_files":["src/main.py"],"impacted_files":["<P>/src/math_utils.py"],
   "graph":{"changed_nodes":[{"id":1,"kind":"File","name":"<P>/src/main.py","qualified_name":"...","file_path":"...","line_start":1,"line_end":9,"language":"python","parent_name":null,"is_test":false}, ...],
     "impacted_nodes":[...],"edges":[...]},
   "source_snippets":{"<P>/src/main.py":"1: from src.math_utils ...\n2: ..."},
   "review_guidance":"- Changes appear well-contained ..."},
 "context_savings":{"estimated":true,"saved_tokens":0,"saved_percent":0},"_graph":{...}}
```

**get_architecture_overview_tool.json** `{}`:
```json
{"status":"ok","summary":"Architecture: 2 communities, ... 0 warning(s)",
 "communities":[{"id":1,"name":"src-helper","size":3,"cohesion":0.25,"dominant_language":"python"}, ...],
 "cross_community_edges":[],"warnings":[],"_hints":{...},"context_savings":{...},"_graph":{...}}
```

**detect_changes_tool.json** `{base:"HEAD~1"}` (envelope; arrays populate only with a committed code diff):
```json
{"status":"ok","summary":"...","risk_score":0.0,"changed_functions":[],"affected_flows":[],
 "test_gaps":[],"review_priorities":[],"functions_truncated":false,"_hints":{...},
 "context_savings":{...},"_graph":{...}}
```
(A `changed_functions` element mirrors the query/impact node-row shape: `{id,kind,name,qualified_name,file_path,line_start,line_end,language,parent_name,is_test,...}`. To populate: commit a code change, then `base` = the prior sha.)

**traverse_graph_tool.json** `{query:"compute"}`:
```json
{"start_node":"<P>/src/math_utils.py::Calculator.compute","mode":"...","max_depth":...,
 "nodes_visited":8,
 "traversal":[{"name":"compute","qualified_name":"<P>/src/math_utils.py::Calculator.compute",
   "kind":"Function","file":"<P>/src/math_utils.py","depth":0}, ...(8 nodes)],
 "truncated":false,"next_tool_suggestions":[...],"_graph":{...}}
```

**list_graph_stats_tool.json** `{}` (for reference; not an adapter tool): keys `{status, summary, total_nodes, total_edges, nodes_by_kind, edges_by_kind, languages, files_count, last_updated, embeddings_count, _graph}`.

---

## 11. Impact Analysis

### Files that may break
| File | Depends on | Risk | What to check |
|---|---|---|---|
| `src/graph/backends/registry.ts` | `CodeReviewGraphBackend` (`:23`) | low | Only calls `id`/`prereqSpec`/`processSpec` — unchanged. `cliMap` not called here. |
| `tests/graph/cli-backend-injection.test.ts` | cr-graph stub `NOT_IMPL` | **medium** | Asserts init/sync surface the `NOT_IMPL` string (`:63`). **Once `cliMap` returns real args, `init()`/`sync()` will call execa `code-review-graph build/update` instead of throwing.** These assertions WILL break — the generator must update them (they test the STUB; now the stub is gone). Verify what `TokensaveCli.init/sync` do when `cliMap` is real. |
| `tests/graph/pipeline-lifecycle-backend.test.ts` | cr-graph `processSpec` (`:88,134`) | low | Uses `processSpec().binary`/`serveArgs` only — unaffected. |

### Existing tests that must still pass
- `tests/graph/backends/registry.test.ts` — selection + `binaryForBackend` for cr-graph; unaffected (extend only).
- `tests/graph/backends/tokensave-backend.test.ts` — tokensave path untouched (sc-4-7).
- `tests/graph/cli-backend-injection.test.ts` — **will need updating** (see table): the two `NOT_IMPL` init/sync cases now exercise a real cliMap. Re-point them to mock execa and assert the argv (`["build"]` / `["update", ...]`), OR keep a NOT_IMPL assertion only for the still-stubbed `*Plan` adapters.

### Recommended regression checks (run after implementation)
1. `npm run build && npm run typecheck` — zero errors (sc-4-1).
2. `npx vitest run tests/graph/` — cr-graph + tokensave + registry + cli-injection green.
3. `npx vitest run` (full suite) — no NEW failures (sc-4-7); tokensave path unaffected.
4. `npm run lint` — clean (`consistent-type-imports`; import `StatusResult` as a type).
5. Confirm committed `tests/graph/fixtures/cr-graph/*.json` are the REAL sanitized captures (each has `_graph`, capitalized `kind`, `line_start`/`line_end`) — not tokensave-shaped stubs.

---

## 12. Implementation Sequence

1. **`cliMap()` + `parseCrGraphSyncOutput` + `parseCrGraphStatusOutput`** in `code-review-graph-backend.ts` (add `StatusResult` type-import). — Verify: `npm run typecheck` clean.
2. **Capture fixtures** via §8 recipe → `tests/graph/fixtures/cr-graph/{semantic_search_nodes_tool,query_graph_tool,get_impact_radius_tool,get_review_context_tool,get_architecture_overview_tool,detect_changes_tool,traverse_graph_tool}.json` + `_args.json`. Sanitize absolute paths. — Verify: each parses as JSON and has a `_graph` key.
3. **Unit test** `tests/graph/backends/code-review-graph-backend.test.ts`: processSpec/prereqSpec (execa mocked, pip hint), cliMap args, parseSync (build + update samples), parseStatus (files/nodes). — Verify: `npx vitest run tests/graph/backends/code-review-graph-backend.test.ts`.
4. **skipIf integration test** (§4): `hasCrGraph()` gate + `initialize` handshake through `TokensaveMcpClient` with cr-graph `processSpec`. — Verify: skips when binary absent, passes when present.
5. **Fix dependent test** `tests/graph/cli-backend-injection.test.ts` init/sync cases (now real cliMap). — Verify: `npx vitest run tests/graph/cli-backend-injection.test.ts`.
6. **Full verification** — `npm run build`, `npm run typecheck`, `npx vitest run`, `npm run lint`. Commit `bober(sprint-4): code-review-graph process/prereq/cli specs + captured MCP fixtures`.

---

## 13. Project Principles (relevant excerpts)
- ESM everywhere; `.js` import extensions (NodeNext). TypeScript strict; **zero type errors + zero lint errors are hard gates**. `consistent-type-imports` enforced (import `StatusResult`/interfaces as `type`).
- Tests: Vitest, collocated, run against the real thing when practical. (Here: skipIf-gated against the real binary; unit tests mock execa.)
- Zod for config (already has `backend`/`codeReviewGraphPath`). No architecture doc exists specifically for spec-20260726 (checked `.bober/architecture/` — none match). `.bober/principles.md` reviewed.
