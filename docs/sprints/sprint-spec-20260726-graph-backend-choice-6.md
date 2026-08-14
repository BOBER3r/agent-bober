# code-review-graph query sub-patterns (full parity): callers_of / callees_of / imports_of / tests_for

**Contract:** sprint-spec-20260726-graph-backend-choice-6  ·  **Spec:** spec-20260726-graph-backend-choice  ·  **Completed:** 2026-07-27

## What this sprint added

This sprint implements the **last of the six** `CodeReviewGraphBackend` response `*Plan` adapters —
`queryPlan`, covering all four `GraphClient` query sub-patterns (`callers_of`, `callees_of`,
`imports_of`, `tests_for`) — **completing full cr-graph adapter parity (feat-4)**. All four patterns
route through cr-graph's single **`query_graph_tool`**, whose `pattern` argument *is* the
direction/relationship selector; the adapter returns the same `{tool, params, narrow}` `CallPlan`
shape as tokensave, so `GraphClient`'s sandbox / staleness / health / fallback / prefetch core is
reused **unchanged**. Every narrow was written against, and unit-tested with, **real live-captured
fixtures** (`tests/graph/fixtures/cr-graph/*.json`) — including a deliberate **trap fixture** kept
only to document a wrong-direction footgun. The tokensave backend, `GraphClient` (`client.ts`), and
`src/graph/types.ts` are **byte-unchanged**, and the `QueryPattern` union + `GraphClient.query()`
signature are untouched.

## Public surface

All symbols live in `src/graph/backends/code-review-graph-backend.ts`.

- `CodeReviewGraphBackend.queryPlan(pattern, target)` (`:182`) — now real for all four patterns
  (previously `throw NOT_IMPL`). A `switch (pattern)` returns a `{tool:'query_graph_tool', params,
  narrow}` `CallPlan<NodeRef[]>`, with an `assertNever(pattern)` (`:220`) default enforcing
  exhaustiveness at compile time. The removed `NOT_IMPL` constant is gone — no `*Plan` adapter throws
  anymore.
- `CR_QUERY_PATTERN` (`:150`) — module-internal `Record<QueryPattern, string>` mapping each bober
  `QueryPattern` to its cr-graph `pattern` string. **`imports_of → "importers_of"`** (see Trap 1
  below); the other three map to their same-named cr-graph pattern.
- `CrImporterRow` (`:159`) — module-internal `{ importer?: string; file?: string }`. The
  `importers_of` result rows are **path-string pairs**, not `CrNodeRow`s (no name/kind/line), so they
  are mapped to module `NodeRef`s directly instead of via `crToNodeRef`.

### Pattern → cr-graph pattern → target map

| bober `QueryPattern` | cr-graph `pattern` | `target` passed | narrow source | direction |
|---|---|---|---|---|
| `callers_of` | `callers_of` | `target.id` (qualified_name) | `results[]` → `crToNodeRef` | **INBOUND** (who calls target) |
| `callees_of` | `callees_of` | `target.id` (qualified_name) | `results[]` → `crToNodeRef` | **OUTBOUND** (what target calls) |
| `imports_of` | **`importers_of`** | `target.file` | `results[].importer` → module `NodeRef`s | dependents (who imports target) — matches tokensave `file_dependents` |
| `tests_for` | `tests_for` | `target.id` (qualified_name) | `results[]` → `crToNodeRef` | tests covering target |

`callers_of` / `callees_of` / `tests_for` share one `switch` arm (all key on `target.id` and narrow
`raw.results ?? []` through the shared `crToNodeRef`); `imports_of` has its own arm (keys on
`target.file`, narrows `results[].importer ?? file` path strings into
`{id, kind:"module", file, line:0, symbol}` NodeRefs, mirroring tokensave's `imports_of` narrow).

## The two silent-failure traps (read before touching this)

Both are guard-tested (a passing unit test would break if either mapping regressed) and both are
recorded in `tests/graph/fixtures/cr-graph/_args.json` under `sprint6DirectionMap`.

- **Trap 1 — `imports_of` maps to cr-graph `importers_of`, NOT cr-graph's own `imports_of`.**
  bober's `imports_of` means *dependents* — "who imports the target" (same direction as tokensave's
  `tokensave_file_dependents`). cr-graph **also** has a pattern literally named `imports_of`, but it
  is the **opposite** direction: *what the target imports*. Wiring bober `imports_of` to cr-graph
  `imports_of` would compile, run, and silently return the wrong set. The wrong-direction fixture
  **`query_graph_imports_of_tool.json`** is committed **only to document this** — it returns
  structurally different rows (`{import_target}`) than the correct `importers_of` fixture
  (`{importer, file}`), which is how the guard test tells them apart.
- **Trap 2 — `tests_for` must pass `target.id` (qualified_name), NOT `target.file`.** cr-graph's
  `tests_for` keys on the symbol's qualified_name; calling `tests_for(<file>)` returns **0 results**
  (a silent empty answer, not an error). `callers_of` / `callees_of` share this requirement — a bare
  name yields `status:"ambiguous"` with no `results`.

## How to use / how it fits

Selecting the engine is still **config-only** (Sprint 3): set `graph.backend = "code-review-graph"`
or let auto-detect pick it. As of this sprint, `GraphClient.query(pattern, target)` returns
**`ok=true` `NodeRef[]`** through the cr-graph backend for **all four** patterns (no
`GRAPH_UNAVAILABLE` anywhere — genuine full parity), with the **same** `runWithSandbox` post-filter
tokensave gets. The end-to-end tests inject the cr-graph backend into `GraphClient` with
`projectRoot='/repo'` (the fixtures' sanitized capture path) and prove the sandbox still drops
out-of-repo/file-less nodes — e.g. the builtin `range` callee (no `file_path`) and out-of-repo
dependents are dropped, exactly as for tokensave.

Edge-direction correctness is asserted end-to-end: for `src/math_utils.py::multiply`, `callers_of`
narrows to the **INBOUND** set `[compute, test_multiply]` while `callees_of` narrows to the
**OUTBOUND** set `[add, range]` — proving the two are not identical (the classic `callers == callees`
bug this sprint's evaluator specifically guarded against).

### Why `query_graph_tool` and not `traverse_graph_tool`

`traverse_graph_tool` was **rejected** for the directional query patterns: its captured fixture takes
**no direction argument** (it is an undirected BFS neighbor walk), and cr-graph's own tool docs point
directional queries at `query_graph_tool`. Routing all four patterns through `query_graph_tool`'s
`pattern` enum is the faithful mapping.

## Fixtures added

Five new live captures (code-review-graph **2.3.7**, MCP `serverInfo` **3.4.4**; sample project
`src/math_utils.py` / `src/main.py` / `tests/test_math_utils.py`, paths sanitized to `/repo`), plus
two new entries in `_args.json` (`sprint6QueryCaptures` + `sprint6DirectionMap`):

- `query_graph_callers_of_tool.json` — `callers_of(multiply)` → `[compute, test_multiply]` (INBOUND)
- `query_graph_callees_of_tool.json` — `callees_of(multiply)` → `[add, range]` (OUTBOUND)
- `query_graph_importers_of_tool.json` — `importers_of(src/math_utils.py)` → `{importer, file}` rows (the **correct** `imports_of` mapping)
- `query_graph_imports_of_tool.json` — **trap fixture**, cr-graph's own `imports_of` (opposite direction, `{import_target}` rows); committed only to document the wrong direction
- `query_graph_tests_for_tool.json` — `tests_for(multiply)` → `[test_multiply, test_add]`

## Notes for maintainers

- **feat-4 is complete — full cr-graph adapter parity.** All six response `*Plan` adapters
  (`search`/`impact`/`reviewContext`/`overview`/`changes` from Sprint 5, `query` from this sprint)
  are now real; the `NOT_IMPL` constant is deleted. Remaining in the spec: CLI/onboard parity + the
  Sprint-5 `reviewContext` narrow-bypass fix (Sprint 7), and docs (Sprint 8).
- **File-size smell (low-priority, non-blocking).** `code-review-graph-backend.ts` is now **327
  lines** (>300 soft threshold). It is cohesive — all six `*Plan` adapters plus
  `process`/`prereq`/`cliMap` for one backend. The evaluator's only feedback was to consider
  extracting the `queryPlan` pattern map to its own module **only if it keeps growing**.
- **Byte-unchanged guarantees (nonGoals held).** `tokensave-backend.ts`, `client.ts`, and
  `types.ts` have a zero-line git diff; the `QueryPattern` union and `GraphClient.query()` signature
  were not touched. Both backends produce the same `NodeRef` shape and the same sandbox behavior —
  only the underlying tool differs.
- **Verification.** Full suite **5076 passed | 2 skipped | 0 failed** (+16 over the 5060 baseline);
  build/typecheck/lint clean (2 pre-existing warnings). All six required criteria (sc-6-1..sc-6-6)
  passed at **iteration 1**; the evaluator independently verified edge direction fixture-by-fixture
  and confirmed both traps are avoided and guard-tested. Commit `4b837ff` on branch
  `bober/graph-backend-choice`.
