# code-review-graph read adapters: search / reviewContext / overview / impact / changes

**Contract:** sprint-spec-20260726-graph-backend-choice-5  ·  **Spec:** spec-20260726-graph-backend-choice  ·  **Completed:** 2026-07-27

## What this sprint added

This sprint implements **5 of the 6** `CodeReviewGraphBackend` response `*Plan` adapters —
`searchPlan`, `reviewContextPlan`, `overviewPlan`, `impactPlan`, `changesPlan` — turning the
Sprint-4 backend from *buildable but not readable* into one that returns real data through
`GraphClient`. Each adapter follows the same `{tool, params, narrow}` `CallPlan` shape as the
tokensave backend, so `GraphClient`'s sandbox / staleness / health / fallback / prefetch core is
reused **unchanged** — the narrows just map cr-graph's structurally-distinct payloads onto the shared
`SearchHit[]` / `string` / `ImpactReport` / `NodeRef[]` types. The narrows were written against, and
unit-tested with, the **real Sprint-4 fixtures** (`tests/graph/fixtures/cr-graph/*.json`), never
guessed shapes. `queryPlan` (the 4 query sub-patterns — callers/callees/imports/tests) still throws
`NOT_IMPL` — that is Sprint 6. The tokensave backend and `GraphClient` (`client.ts`) are
**byte-unchanged**.

## Public surface

All symbols live in `src/graph/backends/code-review-graph-backend.ts`.

- `CodeReviewGraphBackend.searchPlan(q, opts?)` (`:142`) — `{tool:'semantic_search_nodes_tool',
  params:{query, limit?}, narrow}`. `narrow` reads `raw.results` → `SearchHit[]` (`node` via
  `crToNodeRef`, `score` from `row.score` — default `0`, faithful, **not** normalized to tokensave;
  `snippet` from `row.signature ?? ""`). Post-filters by `opts.kind` if requested (the cr-graph tool
  has no kind param of its own), mirroring tokensave's `searchPlan`.
- `CodeReviewGraphBackend.impactPlan(target)` (`:164`) — `{tool:'get_impact_radius_tool',
  params:{changed_files:[file]}, narrow}`. cr-graph's tool takes **file paths, not node ids**; a
  string `target` may be a `qualified_name` (`<file>::<symbol>`), so the **file portion** before
  `::` is used. `narrow` maps `changed_nodes[0]` → `root` (synthesizes a `File`-kind root from the
  target file when `changed_nodes` is empty) and partitions `impacted_nodes` into `affected` vs
  `testsAffected` via `isTestRow`.
- `CodeReviewGraphBackend.reviewContextPlan(nodes)` (`:194`) — `{tool:'get_review_context_tool',
  params:{changed_files:[...deduped node files]}, narrow}`. `narrow` returns `raw` when it is a
  string, else `JSON.stringify(raw)`. **See the known limitation below** — `GraphClient.reviewContext()`
  bypasses this narrow, so it is only exercised by unit tests today.
- `CodeReviewGraphBackend.overviewPlan()` (`:206`) — `{tool:'get_architecture_overview_tool',
  params:{}, narrow}`. The tool returns a JSON object (`communities`, `cross_community_edges`,
  `warnings`); `narrow` `JSON.stringify`s it for the string-typed caller, mirroring how tokensave
  overview stringifies `module_api`.
- `CodeReviewGraphBackend.changesPlan(since?)` (`:219`) — `{tool:'detect_changes_tool',
  params:{base: since ?? "HEAD~1"}, narrow}`. `narrow` reads the `changed_functions` key →
  `NodeRef[]` (empty array when absent).
- `CodeReviewGraphBackend.queryPlan(...)` (`:160`) — **still `throw new Error(NOT_IMPL)`** (Sprint 6).

### Shared cr-graph → NodeRef mapping helpers (module-internal, factored for Sprint 6 reuse)

- `crToNodeRef(row)` (`:119`) — the canonical cr-graph field map:
  `qualified_name → id` (falls back to `String(id)`; cr-graph `id` is a *number*, `NodeRef.id` is a
  string), `name → symbol`, `file_path → file`, `line_start → line` (`line_end` ignored),
  `kind → NodeRef.kind` via `crKind`.
- `crKind(kind)` (`:97`) — coerces cr-graph's **capitalized** kind: `Function → function`,
  `Class → class`, `File → module`, anything else → `symbol` (guarded by the `CR_NODE_KINDS` set at
  `:94`, mirroring tokensave's `NODE_KINDS`).
- `CrNodeRow` (`:107`) / `CrSearchRow` (`:130`) — the raw row shapes shared by search results, impact
  changed/impacted nodes, and changes rows (`CrSearchRow` adds `score`/`signature`).
- `isTestRow(row)` (`:135`) — impact test/non-test partition: prefers cr-graph's explicit `is_test`
  boolean; falls back to the `/test|spec/i` path heuristic (the same heuristic
  `tokensave-backend.ts` uses) when `is_test` is absent.

## How to use / how it fits

Selecting the engine is still **config-only** (Sprint 3): set `graph.backend = "code-review-graph"`
or let auto-detect pick it. As of this sprint, `GraphClient.search` / `overview` / `impact` /
`changes` (and, at the plan level, `reviewContext`) return **`ok=true` narrowed results** through the
cr-graph backend instead of `NOT_IMPL`. Because each adapter returns a plain `{tool, params, narrow}`
plan, `GraphClient`'s `runWithSandbox` applies the **same** `keepNode` sandbox post-filter and kind
coercion to cr-graph results as it does to tokensave — nothing in the client needed to change.

### cr-graph field map (quick reference)

| cr-graph field | `NodeRef` field | notes |
|---|---|---|
| `qualified_name` | `id` | falls back to `String(id)` (cr-graph `id` is numeric) |
| `name` | `symbol` | |
| `file_path` | `file` | |
| `line_start` | `line` | `line_end` is ignored |
| `kind` (`"Function"`/`"Class"`/`"File"`) | `kind` | `Function→function`, `Class→class`, `File→module`, unknown→`symbol` |

### Sandbox `'/repo'` test convention

The Sprint-4 fixtures sanitize the live absolute capture path to the placeholder **`/repo`** in every
`file_path`/`qualified_name`. The end-to-end tests exploit this: they inject a real
`CodeReviewGraphBackend` (not tokensave) into `GraphClient` with `projectRoot='/repo'` so the sandbox
**keeps** the fixture nodes, and pair it with `tmp`-`projectRoot` cases that prove the sandbox
`keepNode` chokepoint still **drops** out-of-repo nodes — the same parity guarantee the tokensave
path has.

## Notes for maintainers

- **KNOWN LIMITATION — `GraphClient.reviewContext()` bypasses `reviewContextPlan.narrow`
  (fix scheduled for Sprint 7).** `GraphClient.reviewContext()` (`src/graph/client.ts:91-94`)
  destructures only `{tool, params}` and calls `runRaw()` (`client.ts:216-218`), whose narrow is an
  **identity cast** `(raw) => raw as T`. So the backend's `reviewContextPlan.narrow` is **never
  invoked** on the client path. This is harmless for tokensave (its `get_review_context` raw is
  already a string), but for cr-graph `get_review_context_tool` returns a **JSON object**, so
  `GraphClient.reviewContext()` returns the raw object **mistyped** as `GraphResult<string>`. The
  narrow *is* correct and *is* unit-tested; only the client wiring bypasses it. This is a
  **pre-existing** issue (the `runRaw` path dates to Sprint 1) and fixing it was a **nonGoal** this
  sprint (must not touch `GraphClient`). The evaluator judged it an acceptable, honestly-documented
  known limitation and filed it as a **high-priority follow-up folded into Sprint 7** (which should
  make `reviewContext()` invoke the narrow — e.g. route it through `runWithSandbox` like `overview`,
  or give `runRaw` an optional narrow). Contrast `overviewPlan`, whose narrow **is** applied because
  `GraphClient.overview()` uses `runWithSandbox`.
- **Low-priority follow-up — `isTestRow` `is_test===true` branch untested.** No captured fixture row
  has `is_test:true`, so that branch of the partition is uncovered; a synthetic hand-built row unit
  test in a follow-up would close it.
- **cr-graph scoring is mapped faithfully, not normalized.** `search` carries cr-graph's own score
  (e.g. `0.016393`) straight into `SearchHit.score`; the sprint deliberately does **not** rescale it
  to tokensave's ranking (a nonGoal).
- **Sprint 5 of 8.** Read adapters are live; `queryPlan` (Sprint 6), CLI/onboard parity + the
  `reviewContext` narrow fix (Sprint 7), and docs (Sprint 8) remain. The tokensave backend and
  `client.ts` are **byte-unchanged** (git diff 0 lines); fixtures untouched.
- **Verification.** Full suite **5060 passed | 2 skipped | 0 failed** (+22 over the 5038 baseline);
  tokensave 32/32 + live integration 22/22 unchanged; build/typecheck/lint clean (2 pre-existing
  warnings). All 6 required + 1 optional criteria (sc-5-1..sc-5-7) passed at iteration 1; each narrow
  was independently hand-traced against its real fixture. Commit `2ebe2af` on branch
  `bober/graph-backend-choice`.
