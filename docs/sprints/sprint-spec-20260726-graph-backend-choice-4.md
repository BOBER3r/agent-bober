# code-review-graph backend: real CLI map (build/update/status) + captured live MCP fixtures

**Contract:** sprint-spec-20260726-graph-backend-choice-4  ·  **Spec:** spec-20260726-graph-backend-choice  ·  **Completed:** 2026-07-27

## What this sprint added

This sprint turns the Sprint-3 `CodeReviewGraphBackend` **stub** into a backend that can drive the
real `code-review-graph` CLI and hands Sprints 5-6 the ground-truth data they need. Two things
shipped: (1) a **real `cliMap()`** (`init -> ['build']`, `sync -> ['update', ...paths]`,
`status -> ['status','--json']`) with output parsers written against actual `code-review-graph`
**2.3.7** CLI output; and (2) **real MCP tool-output fixtures** captured from a live
`code-review-graph serve` (MCP `serverInfo.version` **3.4.4**) for every tool the future response
adapters will consume, committed under `tests/graph/fixtures/cr-graph/`. The **six response `*Plan`
adapters still throw `NOT_IMPL`** — they are Sprints 5-6, which parse these fixtures. The tokensave
backend and the MCP wire transport are untouched.

## Public surface

- `CodeReviewGraphBackend.cliMap()` (`src/graph/backends/code-review-graph-backend.ts:128`) — now
  **real** (was a `NOT_IMPL` throw). Returns `initArgs: () => ['build']` (`:132`),
  `syncArgs: (paths) => ['update', ...paths]` (`:142`), `statusArgs: ['status','--json']` (`:143`),
  plus `parseSync`/`parseStatus`. `build` has no `--tier` flag, so `languageTier` stays a
  bober-level manifest concept (not forwarded), same as tokensave.
- `parseCrGraphSyncOutput(output)` (`:45`, module-internal) — reads the leading file count from
  `code-review-graph build`/`update`'s single plain-text summary line via one regex
  (`/(\d+)\s+files?\b/`) that matches **both** shapes: `"Full build: 2 files, 8 nodes, 15 edges …"`
  and `"Incremental: 1 files updated, 4 nodes, 9 edges …"`. Defensively strips ANSI (plain here) and
  returns `0` on empty (`-q/--quiet` prints nothing, so the map never passes `-q`).
- `parseCrGraphStatusOutput(stdout)` (`:68`, module-internal) — parses `status --json`'s object
  (`{nodes, edges, files, languages, last_updated, vcs, …}`) into the shared `StatusResult`
  (`{ready, indexedFileCount, tokensaveVersion:""}`). cr-graph's `status --json` carries **no**
  version field, so the mis-named-generic `tokensaveVersion` is `""`.
- **The six `*Plan` adapters remain `NOT_IMPL`** (`:84-106`): `searchPlan`/`queryPlan`/`impactPlan`/
  `reviewContextPlan`/`overviewPlan`/`changesPlan` all `throw new Error(NOT_IMPL)` where
  `NOT_IMPL = "code-review-graph adapter not implemented until Sprints 4-6"` (`:27`). Sprints 5-6
  consume the fixtures below to implement them.
- `tests/graph/fixtures/cr-graph/*.json` — **8 real captured MCP tool payloads** (the unwrapped
  `result.content[].text`, JSON-parsed) for the adapter tools: `semantic_search_nodes_tool`,
  `query_graph_tool`, `get_impact_radius_tool`, `get_review_context_tool`,
  `get_architecture_overview_tool`, `detect_changes_tool`, `traverse_graph_tool`, plus
  `list_graph_stats_tool` (reference, not an adapter tool).
- `tests/graph/fixtures/cr-graph/_args.json` — the exact `tools/call` **argument shape** captured for
  each tool, the capture provenance (`crGraphVersion: 2.3.7`, `mcpServerInfoVersion: 3.4.4`,
  `capturedAt`), and the full **15-value `query_graph_tool` `pattern` enum** the server accepts
  (`callers_of, callees_of, imports_of, importers_of, children_of, tests_for, inheritors_of,
  triggers_of, triggered_by, publishers_of, listeners_of, handlers_of, endpoints_for, consumers_of,
  file_summary`).
- `tests/graph/backends/code-review-graph-live.test.ts` — new **skipIf-gated** live integration test
  (sc-4-5). Gated on `spawnSync(CRG_BIN ?? 'code-review-graph', ['--version']).status === 0` so it
  **skips (never fails)** when the binary is absent; when present it completes a real `initialize`
  handshake against `code-review-graph serve` through the Sprint-2 parameterized transport and
  asserts `health() === 'ready'`.

## How to use / how it fits

Selecting the code-review-graph engine is still **config-only** (Sprint 3): set
`graph.backend = "code-review-graph"` or let auto-detect pick it when only cr-graph is installed.
As of this sprint, `graph init`/`sync`/`status` against that backend now spawn the **real** cr-graph
verbs (`build` / `update <paths>` / `status --json`) and parse their output — no longer a
`NOT_IMPL` throw. The **read** operations (search / impact / review-context / overview / changes /
query) still throw `NOT_IMPL` until the Sprint 5-6 adapters land.

The binary is **not on the default shell PATH** in the dev environment (installed under
`~/Library/Python/3.12/bin`); the live test resolves it via `CRG_BIN` or PATH, and production honors
`config.graph.codeReviewGraphPath` (added in Sprint 3).

### Refreshing the fixtures (capture recipe)

The committed fixtures are ground truth; to refresh them from a newer cr-graph, reproduce the live
capture. The **critical env gotcha**: in this environment a plain `code-review-graph build` yields a
**0-node graph** for every language, because cr-graph's parser-load probe runs `python -I`
(isolated) which cannot see the `--user`-installed `tree_sitter_language_pack`. A populated graph
requires a throwaway venv whose `.pth` re-adds the user site-packages:

```bash
export PATH="$HOME/Library/Python/3.12/bin:$PATH"          # binary not on default PATH
BIN="$HOME/Library/Python/3.12/bin/code-review-graph"
US="$HOME/Library/Python/3.12/lib/python/site-packages"
WORK=$(mktemp -d); cd "$WORK"; git init -q
git config user.email t@t.co; git config user.name t
mkdir src                                                  # write 2 small python files w/ inter-file calls + a class
git add -A && git commit -qm init
python3 -m venv .venv
echo "$US" > .venv/lib/python3.12/site-packages/crguser.pth   # <-- the .pth workaround
.venv/bin/python -m code_review_graph build                # -> "Full build: 2 files, 8 nodes, 15 edges"
# SERVE with the INSTALLED binary (the venv's serve lacks platformdirs); it reads the same graph.db:
#   pipe JSON-RPC initialize -> notifications/initialized -> tools/call into `$BIN serve` (cwd=$WORK)
#   unwrap result.content[].text, JSON.parse, sanitize the absolute path -> /repo, save each as a fixture
```

Two further pitfalls captured live: **build with the venv python (has the parser) but serve with the
installed binary** — the venv's `serve` crashes with `ModuleNotFoundError: platformdirs`, and both
read the same on-disk `graph.db`. And **sanitize before commit**: the live payloads embed the
absolute `mktemp` project path in every `file_path`/`qualified_name`; the committed fixtures replace
it with the placeholder `/repo` (structure/keys kept byte-for-byte). Do **not** `pip install`
anything into the user/system env — the `.pth` trick touches only the throwaway venv.

## Notes for maintainers

- **Sprint 4 of 8.** The engine is now selectable + can build/sync/status, but is **not readable**
  yet: the six `*Plan` adapters throw `NOT_IMPL` and Sprints 5-6 implement them against the fixtures
  captured here. The tokensave path is unaffected.
- **cr-graph output shape is structurally distinct from tokensave** — this is deliberate and the
  reason the evaluator accepts the fixtures as genuinely real. Where tokensave returns bare `Ts*Row`
  arrays, every cr-graph payload is an **object** `{status, summary, <results>, _graph}` with:
  **capitalized `kind`** (`"Function"`, `"Class"`, `"File"` — not tokensave's lowercase),
  **`line_start`/`line_end`** (not a single `line`), an absolute **`file_path`** + **`qualified_name`**
  (`<file>::<symbol>`), and a trailing **`_graph` staleness envelope**
  (`{updated_at, age_seconds, built_on_branch, built_at_sha, head_sha, head_matches_build}`) on every
  payload. `status --json` keys are `files`/`nodes`/`edges` — **not** tokensave's
  `file_count`/`node_count`. Sprint 5-6 adapters must map these shapes; do not reshape the fixtures to
  mimic `Ts*Row`.
- **KNOWN CEILING — `sync` argv semantics (deferred to Sprint 7).** cr-graph's `update` verb is
  **git-diff-base driven** (`--base HEAD~1` by default), **not** a positional-path receiver like
  tokensave's `sync <paths>`. `syncArgs` forwards the generic `CliMap`'s `paths`
  (`['update', ...paths]`) to satisfy the shared interface shape (sc-4-3), but cr-graph will reject
  unrecognized positional argv if `paths` are ever non-empty in practice. Reconciling the generic
  `sync(paths)` call site with cr-graph's diff-based incremental model is **deferred to Sprint 7**
  (the CLI/onboard-parity sprint). See the load-bearing comment at
  `code-review-graph-backend.ts:135-141`.
- **Transport still resolves the spawned binary from `tokensavePath ?? processSpec.binary`**, so the
  live test injects the resolved cr-graph binary directly onto `processSpec.binary`. Wiring
  `config.graph.codeReviewGraphPath` through `spawnAndHandshake` is a follow-up (noted in the live
  test at `code-review-graph-live.test.ts:44-47`).
- **Version gate is still accept-any** (`prereqSpec().isCompatible = () => true`, TODO from
  Sprint 3). The `INCOMPATIBLE` path is only reachable via an unparseable `--version` line and then
  surfaces the `incompatibleHint` TODO string, not the pip hint — matches the Sprint-2 `PrereqSpec`
  split, not a new deviation. Tighten once cr-graph publishes a supported range, mirroring
  `TOKENSAVE_VERSION_RANGE`.
- **Sprint-3 regression tests updated, not weakened.** `tests/graph/cli-backend-injection.test.ts`
  and `tests/cli/graph-commands-backend.test.ts` previously asserted `init`/`sync`/`status` surface
  the stub's `NOT_IMPL`; they now mock execa and assert the **real argv** (`['build']`,
  `['update', '.']`/`['update','src/']`, `['status','--json']`) and parsed results. A new test keeps
  the six response `*Plan` adapters asserted as `NOT_IMPL`, so the still-stubbed surface stays pinned.
- **Verification.** Full suite **5038 passed | 2 skipped | 0 failed** (+20 over the 5018 baseline; the
  live cr-graph test skips on the default PATH and **passes** with PATH exported — real MCP handshake
  1256ms, `health='ready'`). Build/typecheck/lint clean (2 pre-existing warnings). All 6 required +
  1 optional criteria passed at iteration 1; fixtures independently verified as genuine (capitalized
  `Kind`, `_graph` envelope, cross-file-consistent `built_at_sha`/IDs/totals, no leaked `/Users/`
  paths). Commit `ed7d9cf` on branch `bober/graph-backend-choice`.
