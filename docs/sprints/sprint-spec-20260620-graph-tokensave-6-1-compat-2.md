# Remap GraphClient to the tokensave 6.1.1 tool catalog + verify onboard end-to-end

**Contract:** sprint-spec-20260620-graph-tokensave-6-1-compat-2  ·  **Spec:** spec-20260620-graph-tokensave-6-1-compat  ·  **Completed:** 2026-06-20

## What this sprint added

This sprint replaced `GraphClient`'s **stale tool-name catalog** with tokensave 6.1.1's
**real** tool names and added per-tool result adapters, so every higher-level graph query now
hits a tool that actually exists on `tokensave serve` 6.1.1. The old `TOOL` map still named the
pre-6.1.1 catalog (`semantic_search_nodes`, `query_graph`, `get_impact_radius`,
`get_review_context`, `get_architecture_overview`, `detect_changes`) — none of which 6.1.1
emits — so even after Sprint 1 fixed the *handshake*, the graph queries themselves still failed.
Together, **Sprint 1 (MCP transport) + Sprint 2 (this catalog remap) fix `agent-bober onboard`
end-to-end** and restore the graph features of `agent-bober run` against tokensave 6.1.1: the
verified E2E run prints `Starting graph engine...` with **no** `handshake timed out` and writes
all 5 `.bober/onboarding/*.md` files with real symbol rows. The change is confined to the graph
layer (`src/graph/client.ts`) plus its test; `GraphClient`'s public method signatures, the
`GraphResult` contract, the sandbox post-filter, and the disabled/unavailable short-circuits are
all preserved. `onboard.ts` was deliberately **not** touched (an explicit scope decision — see
the limitation below).

## Public surface

`GraphClient`'s six public method **signatures are unchanged** (`search`, `query`, `impact`,
`reviewContext`, `overview`, `changes`); each still returns its existing stable type. What
changed is the downstream tool name each method calls, the params it sends, and the adapter
that maps 6.1.1's raw JSON back into that stable type.

- `TOOL` (`src/graph/client.ts:31`) — the catalog map, rewritten to the real `tokensave_`-prefixed
  6.1.1 names: `search → tokensave_search`, `impact → tokensave_impact`,
  `reviewContext → tokensave_context`, `overview → tokensave_module_api`,
  `changes → tokensave_changelog`.
- `QUERY_TOOL` (`src/graph/client.ts:40`) — new per-`QueryPattern` map, because 6.1.1 has **no**
  single `query_graph` tool: `callers_of → tokensave_callers`, `callees_of → tokensave_callees`,
  `imports_of → tokensave_file_dependents`, `tests_for → tokensave_test_map`.
- `toNodeRef(row)` (`src/graph/client.ts:116`, module-private) — the shared row→`NodeRef` adapter.
  It reads `id ?? node_id`, maps the raw `name`/`file`/`line` onto `symbol`/`file`/`line`, and
  **coerces** any `kind` outside the `NODE_KINDS` allow-set (`function`/`class`/`module`/`symbol`,
  `src/graph/client.ts:114`) down to `"symbol"` — so 6.1.1's wider kinds (`method`,
  `constructor`, `field`, `trait`, `file`, …) never violate the existing `NodeRef["kind"]` type.
- Adapter-internal raw row types (`src/graph/client.ts`, module-private) — `TsSearchRow`,
  `TsEdgeRow`, `TsFileDependentsResult`, `TsTestMapResult`, `TsImpactResult`,
  `TsModuleApiResult`, `TsChangelogResult` — type the raw 6.1.1 JSON before the adapter narrows
  it. These live in `client.ts`, **not** `types.ts` (which was not modified); the public
  `SearchHit`/`NodeRef`/`ImpactReport` shapes stay stable.

### Per-method 6.1.1 mapping (return type unchanged)

- `search(q, opts)` → `SearchHit[]` (`client.ts:168`) — calls `tokensave_search` with
  `{ query, limit? }`; maps each `TsSearchRow` to `{ node: toNodeRef(row), score, snippet:
  signature ?? "" }`. `tokensave_search` has **no** `kind` param, so `opts.kind` is applied as a
  **post-filter** (then the sandbox `keepNode` filter runs).
- `query(pattern, target)` → `NodeRef[]` (`client.ts:188`) — a `switch` over the pattern with an
  `assertNever(pattern)` exhaustiveness default. `callers_of`/`callees_of` send `{ node_id:
  target.id }` and adapt `TsEdgeRow[]`; `imports_of` sends `{ file: target.file }` and adapts
  `TsFileDependentsResult.dependents` (a `string[]` of paths) into module `NodeRef`s; `tests_for`
  sends `{ file: target.file }` and returns `test_files` as module `NodeRef`s, **falling back** to
  `uncovered` symbol rows when `test_files` is empty.
- `impact(target)` → `ImpactReport` (`client.ts:247`) — sends `{ node_id }` (from
  `target.id` or the raw string) to `tokensave_impact`; `nodes[0]` becomes `root`, and the
  remaining nodes are split into `testsAffected` vs `affected` by a `/test|spec/i` path regex
  (6.1.1 returns one flat `nodes[]`, not the old pre-split shape). The root is informational and
  intentionally **not** sandbox-filtered; `affected`/`testsAffected` are.
- `reviewContext(nodes)` → `string` (`client.ts:270`) — calls `tokensave_context` with
  `{ task: nodes.map(n => n.symbol).join(", ") }` and returns its raw markdown text.
- `overview()` → `string` (`client.ts:275`) — calls `tokensave_module_api` with `{ path: "src" }`
  and returns `JSON.stringify(result)` to preserve the `string` return type (6.1.1 returns a JSON
  object, not prose).
- `changes(since)` → `NodeRef[]` (`client.ts:283`) — calls `tokensave_changelog` with
  `{ from_ref: since ?? "HEAD~1", to_ref: "HEAD" }` and adapts `symbols_in_changed_files` to
  `NodeRef[]`.

## How to use / how it fits

There is **no new user-facing command, flag, or config key.** This is the second half of an
internal compatibility fix behind the existing graph engine. The same surface documented in the
README "Graph (Tokensave) Integration" section and `COMMANDS.md` — `agent-bober graph init|sync|
status`, `agent-bober onboard`, `agent-bober impact <symbol>` — is unchanged; it simply **works
now** against tokensave 6.1.1. The flow is: `GraphClient.call("<tool>", args)` (Sprint 1's
`tools/call` envelope + `unwrapMcpContent`) returns the raw 6.1.1 payload, then this sprint's
adapter narrows it back to the method's stable type before the sandbox `keepNode` filter and the
never-throw `GraphResult` wrapper. `onboard.ts` consumes `search()` exactly as before (its
`SearchHit` mapping is untouched), so the onboarding composer renders real hotspots and module/
files sections without any change to `onboard.ts`.

## Notes for maintainers

- **`onboard` is functional but low-quality — a known, scoped limitation, not a bug.** By explicit
  scope decision (the contract's non-goals and `sc-2-7`), `onboard.ts` keeps its **semantic-search
  data path**: it builds every section from `GraphClient.search()` rather than from tokensave's
  dedicated analysis tools. So the output is real but **noisy** — test fixtures surface as
  "hotspots", `dist/` and `docs/` entries appear in `architecture-overview.md`, communities
  collapse to a single `default`/`uncategorized`, and the README `indexedFileCount` is `0` (the
  manifest is not populated on this path). This **meets** `sc-2-5` (real symbol rows, not the
  empty-state text) but is not accurate onboarding documentation. The deferred follow-up
  (**"option C"**) is to rework `onboard.ts` to call the dedicated 6.1.1 tools directly —
  `tokensave_hotspots`, `tokensave_dead_code`, `tokensave_circular`, `tokensave_module_api` — for
  accurate hotspots / dead-code / communities / module sections. That rework was an explicit
  **non-goal** of this sprint and is the natural next spec for this area.
- **Pre-existing dangling onboarding link (not introduced here).** `README.md:204` and
  `onboard.ts:27` reference an architecture doc under `.bober/architecture/` that does not exist in
  the tree. This predates this sprint (this sprint did not touch either file) and is a separate
  follow-up.
- **Tool params were probed against the real 6.1.1 serve, not guessed.** `callers`/`callees`/
  `impact` require a `node_id` (not a bare symbol); `file_dependents`/`test_map` take a `file` and
  return `string[]` path lists adapted into module `NodeRef`s; `module_api` requires a `path` arg
  (passed `"src"`). If a future tokensave renames a field or tool, the fix belongs in the
  `client.ts` adapter (and `TOOL`/`QUERY_TOOL`), keeping `types.ts` and all callers stable.
- **`kind` coercion is intentional and load-bearing.** 6.1.1 emits richer kinds than the
  `NodeRef["kind"]` union allows; `toNodeRef` maps anything outside `NODE_KINDS` to `"symbol"`
  rather than widening the public type. Do not "fix" this by widening `NodeRef["kind"]` without
  auditing every consumer.
- **Scope / verification.** Commit `6ed3f77`: only `src/graph/client.ts` and
  `tests/graph/client.test.ts`. `types.ts`, `mcp-client.ts` (Sprint 1), `onboard.ts`,
  `pipeline-lifecycle.ts`, the circuit breaker, and the sandbox were non-goals and untouched. The
  client tests were rewritten to feed **raw 6.1.1 payloads** (30 tests, +5: `callees_of`,
  `imports_of`, `tests_for`, unknown-kind coercion, `impact` `testsAffected` split). Full suite
  **2814 passed** (up from 2809); the onboard E2E ran against the real binary (exit 0, no
  handshake timeout, 5 files / 10952 bytes). All 7 criteria (sc-2-1..sc-2-7) passed iteration 1,
  zero regressions.
