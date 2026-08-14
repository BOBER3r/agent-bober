# Pluggable graph backends: tokensave vs code-review-graph

agent-bober's code graph is **engine-agnostic**. Every graph-consuming surface — `agent-bober
onboard`, `agent-bober impact`, the `agent-bober graph` command group, and the external MCP server
(`src/mcp/server.ts`) — talks to the graph through a single `GraphClient` API. `GraphClient` owns
the cross-cutting sandbox/staleness/health/fallback logic and delegates the per-engine tool catalog
and response shaping to an injected `GraphBackend` (`src/graph/backends/types.ts`). Two backends are
registered today:

- **[tokensave](https://github.com/aovestdipaperino/tokensave)** — a native Rust binary
  (`src/graph/backends/tokensave-backend.ts`).
- **[code-review-graph](https://pypi.org/project/code-review-graph/)** — a Python package
  (`src/graph/backends/code-review-graph-backend.ts`).

This page is the full reference. The README's [Graph Integration](../README.md#graph-integration-tokensave-or-code-review-graph)
section is the short version.

---

## 1. Selection algorithm

`resolveGraphBackend()` (`src/graph/backends/registry.ts`) decides which engine a given run uses:

1. **Explicit `config.graph.backend` wins.** If set (`"tokensave"` | `"code-review-graph"`), that
   engine is used directly — the other engine is never probed, and if the chosen engine's binary
   turns out to be missing, the caller's own prereq check surfaces *that engine's* install hint, not
   a combined one.
2. **Otherwise, auto-detect.** Each backend in `KNOWN_BACKENDS` (tokensave first, then
   code-review-graph — `registry.ts:28-31`) is probed by running its version command
   (`<binary> --version`); the first one that responds with a parseable version wins. **tokensave is
   preferred when both are installed**, because it is probed first.
3. **Neither installed** → `resolveGraphBackend` throws a `GraphBackendResolutionError` whose
   message concatenates **both** engines' install hints (`registry.ts:146-152`).

Per-engine binary path overrides are independent config keys — `graph.tokensavePath` and
`graph.codeReviewGraphPath` (`src/config/schema.ts:394-401`) — resolved via `binaryForBackend()`
(`registry.ts:70-82`). Selection is **config-only**: there is no per-command `--backend` CLI flag.

```json
{
  "graph": {
    "enabled": true,
    "backend": "code-review-graph",
    "codeReviewGraphPath": "/opt/venvs/crg/bin/code-review-graph"
  }
}
```

**Known residual (documented, not fixed this sprint):** `TokensaveMcpClient.spawnAndHandshake`
resolves its *spawned* binary as `cfg.tokensavePath ?? processSpec.binary` (`mcp-client.ts:243`) —
that precedence predates the multi-backend seam and is load-bearing for an existing test
(`mcp-client.test.ts:381-401`), so it was intentionally left untouched. `processSpecForBackend()`
(`registry.ts:101-106`) works around it by resolving the *correct* binary via `binaryForBackend()`
at each construction site and passing it in as `processSpec.binary`, so `codeReviewGraphPath` does
reach the spawned `code-review-graph serve` process in practice. The one edge case that still
prefers `tokensavePath` is a config that sets **both** `graph.tokensavePath` **and**
`graph.backend: "code-review-graph"` simultaneously — a low-probability configuration mistake,
called out with a `bober:` comment at `registry.ts:95-99`.

---

## 2. Installing an engine

Neither engine ships with `npm install -g agent-bober` — install at least one separately.

### tokensave (native Rust binary)

```bash
# macOS (Homebrew)
brew install aovestdipaperino/tap/tokensave
# Windows (Scoop)
scoop bucket add tokensave https://github.com/aovestdipaperino/scoop-bucket && scoop install tokensave
# Any platform (Cargo / Rust)
cargo install tokensave
```

Required version range: **`>=6.0.0-beta.1 <7.0.0`** (`TOKENSAVE_VERSION_RANGE`,
`tokensave-backend.ts:39`), enforced by `TokensaveBackend.prereqSpec().isCompatible`.

### code-review-graph (Python package)

```bash
pip install code-review-graph
```

Requires **Python 3.10+**. `CodeReviewGraphBackend.prereqSpec().isCompatible` currently accepts
**any** detected version (`code-review-graph-backend.ts:301`) — see [§5](#5-residual-follow-ups)
for why, and the planned tightening.

If neither engine is installed, graph features degrade gracefully and the rest of the pipeline
(Researcher → Planner → Curator → Generator → Evaluator) is unaffected.

---

## 3. Operation parity — the full table

Every `GraphClient` operation is backed by exactly one tool call on each engine. This table is
derived directly from `tokensave-backend.ts` and `code-review-graph-backend.ts` — the source line
for each mapping is included so it can be spot-checked against the code.

| `GraphClient` operation | tokensave tool | tokensave source | code-review-graph tool | code-review-graph source |
|---|---|---|---|---|
| `search(query, opts?)` | `tokensave_search` | `tokensave-backend.ts:19,215-230` | `semantic_search_nodes_tool` | `code-review-graph-backend.ts:164-180` |
| `reviewContext(nodes)` | `tokensave_context` | `tokensave-backend.ts:21,310-317` | `get_review_context_tool` | `code-review-graph-backend.ts:254-265` |
| `overview()` | `tokensave_module_api` | `tokensave-backend.ts:22,319-329` | `get_architecture_overview_tool` | `code-review-graph-backend.ts:267-278` |
| `impact(target)` | `tokensave_impact` | `tokensave-backend.ts:20,287-308` | `get_impact_radius_tool` | `code-review-graph-backend.ts:224-252` |
| `changes(since?)` | `tokensave_changelog` | `tokensave-backend.ts:23,331-340` | `detect_changes_tool` | `code-review-graph-backend.ts:280-286` |
| `query("callers_of", target)` | `tokensave_callers` | `tokensave-backend.ts:28,234-245` | `query_graph_tool` (`pattern: "callers_of"`) | `code-review-graph-backend.ts:150-199` |
| `query("callees_of", target)` | `tokensave_callees` | `tokensave-backend.ts:29,234-245` | `query_graph_tool` (`pattern: "callees_of"`) | `code-review-graph-backend.ts:150-199` |
| `query("imports_of", target)` | `tokensave_file_dependents` | `tokensave-backend.ts:30,246-261` | `query_graph_tool` (`pattern: "importers_of"`) | `code-review-graph-backend.ts:150-155,201-218` |
| `query("tests_for", target)` | `tokensave_test_map` | `tokensave-backend.ts:31,262-281` | `query_graph_tool` (`pattern: "tests_for"`) | `code-review-graph-backend.ts:150-199` |

**Trap to know about:** bober's `imports_of` means *dependents* — "who imports the target" (same
direction as tokensave's `tokensave_file_dependents`). code-review-graph's `query_graph_tool` also
accepts a pattern literally named `"imports_of"`, but that is the **opposite** direction (what the
target imports). The adapter deliberately maps bober's `imports_of` to cr-graph's `"importers_of"`
pattern (`CR_QUERY_PATTERN`, `code-review-graph-backend.ts:150-155`); the wrong-direction fixture
`tests/graph/fixtures/cr-graph/query_graph_imports_of_tool.json` is committed only to document the
footgun.

### CLI verb parity

| bober CLI verb | tokensave command | tokensave source | code-review-graph command | code-review-graph source |
|---|---|---|---|---|
| `agent-bober graph init` | `tokensave init` | `tokensave-backend.ts:365` | `code-review-graph build` | `code-review-graph-backend.ts:308-312` |
| `agent-bober graph sync [paths]` | `tokensave sync <paths>` | `tokensave-backend.ts:366` | `code-review-graph update <paths>` | `code-review-graph-backend.ts:313-322` |
| `agent-bober graph status --json` | `tokensave status --json` | `tokensave-backend.ts:367` | `code-review-graph status --json` | `code-review-graph-backend.ts:323` |

`resolveGraphBackend()` picks the engine once per command invocation; `registerGraphCommand()`
(`src/cli/commands/graph.ts`) then constructs a `TokensaveCli` from whichever backend was resolved,
so `init`/`sync`/`status` always run the *actual* selected engine's verbs — never a hardcoded
tokensave path.

### `agent-bober graph status` readout

As of Sprint 7, `graph status` (both human-readable and `--json`) reports which engine is live:

```bash
$ agent-bober graph status --json
{
  "ready": true,
  "indexedFileCount": 128,
  "tokensaveVersion": "6.1.1",
  "lastSyncedHeadSha": "23e8b73...",
  "stale": false,
  "engine": "tokensave",
  "backendVersion": "6.1.1",
  "selectedBy": "auto-detect"
}
```

- `engine` — the resolved backend id (`tokensave` | `code-review-graph`), `graph.ts:297,309`.
- `backendVersion` — the resolved engine's detected version, falling back to
  `manifest.backendVersion` if the live prereq check failed, `graph.ts:298,310`.
- `selectedBy` — `"config"` when `config.graph.backend` was set explicitly, else `"auto-detect"`,
  `graph.ts:299-301,311`.

The pre-existing `ready` / `indexedFileCount` / `tokensaveVersion` / `lastSyncedHeadSha` / `stale`
fields are unchanged — these three fields are purely additive, so a tokensave-only config's output
is otherwise byte-identical to before the backend seam existed.

---

## 4. Verification & live smoke

### What CI runs (every PR)

CI relies on **committed, real fixtures** under `tests/graph/fixtures/cr-graph/` — 14 JSON files
captured from a **live** `code-review-graph serve` (cr-graph `2.3.7`, MCP `serverInfo.version`
`3.4.4`), not hand-written or provisional payloads. Every `CodeReviewGraphBackend` `*Plan` adapter's
unit tests parse these real captures; the mocked/fixture transport is what makes the cr-graph path
exercised in CI without a live Python install. The tokensave path is exercised the same way plus one
`skipIf`-gated live integration test (`tests/graph/mcp-client.test.ts`) that only runs when a real
`tokensave` binary is on `PATH`.

There is also one `skipIf`-gated **live** cr-graph test
(`tests/graph/backends/code-review-graph-live.test.ts`), gated on
`spawnSync(CRG_BIN ?? 'code-review-graph', ['--version']).status === 0`. It **skips (never fails)**
when the binary is absent (the default in CI) and, when present, completes a real MCP `initialize`
handshake and asserts `health() === 'ready'`.

### Deferred manual smoke run (NOT in CI)

A full **live** cr-graph smoke run — build a real graph with `code-review-graph`, point
`agent-bober` at it, and confirm the onboarding pipeline produces real output — is a **documented
manual step**, deliberately not added to default CI (see nonGoals: this sprint must not add a live
cr-graph test to CI). To run it:

```bash
# 1. Install code-review-graph
pip install code-review-graph

# 2. IMPORTANT environment gotcha (see docs/sprints/sprint-spec-20260726-graph-backend-choice-4.md
#    §"Refreshing the fixtures" for the full write-up): a plain `code-review-graph build` can yield
#    a 0-node graph, because cr-graph's parser-load probe runs `python -I` (isolated), which cannot
#    see a --user-installed tree_sitter_language_pack. Work around it with a throwaway venv whose
#    .pth re-adds the user site-packages:
python3 -m venv .venv
echo "$(python3 -m site --user-site)" > .venv/lib/python3.*/site-packages/crguser.pth
.venv/bin/python -m code_review_graph build   # should print "Full build: N files, M nodes, ..."
#    (if `nodes` is 0, the workaround above did not take effect — re-check the .pth path)

# 3. Point agent-bober at code-review-graph
#    In bober.config.json:
#    { "graph": { "enabled": true, "backend": "code-review-graph" } }

# 4. Run onboard and confirm all 5 artifacts are written
agent-bober onboard
ls .bober/onboarding/
#    README.md  architecture-overview.md  hotspots.md  knowledge-gaps.md  communities.md
```

This verifies, with a real engine and a real graph, that `onboard` (and by extension `impact` /
`graph status`) works end-to-end through `code-review-graph` — not just against fixtures. It has
**not** been re-run as part of this sprint (Sprint 8 is docs + a final fixture/tokensave
verification pass only); the manual command above is the reproducible recipe for whoever runs it
next.

---

## 5. Residual follow-ups

Carried forward from Sprints 4, 6, and 7 — none of these are fixed in Sprint 8 (docs-only):

- **`code-review-graph update` diff-base ceiling.** cr-graph's `update` verb is git-diff-base driven
  (`--base HEAD~1` by default), not a positional-path receiver like tokensave's `sync <paths>`.
  `CliMap.syncArgs` still forwards the generic `paths` argument (`['update', ...paths]`,
  `code-review-graph-backend.ts:313-322`) to satisfy the shared interface shape, but cr-graph will
  reject unrecognized positional argv if `paths` are ever non-empty in practice. Reconciling the
  generic `sync(paths)` call site with cr-graph's diff-based incremental model is deferred to a
  future sprint. Marked with a `bober:` comment at the cited line.
- **`tokensavePath` + `backend: "code-review-graph"` transport precedence.** See [§1](#1-selection-algorithm)
  above — a config setting both keys still has the transport layer prefer `tokensavePath`. Fixing it
  would require changing `mcp-client.ts:243`'s own precedence, which risks an existing test; deferred.
- **`isCompatible` accept-any-version TODO.** `CodeReviewGraphBackend.prereqSpec().isCompatible`
  returns `true` unconditionally (`code-review-graph-backend.ts:301`) because cr-graph has no
  published compatibility range yet. Tighten once one exists, mirroring
  `TOKENSAVE_VERSION_RANGE` in `tokensave-backend.ts:39`.
- **Minor test-coverage gaps.** `isTestRow()`'s `is_test === true` branch is untested (no committed
  fixture row sets that field); there is no dedicated tokensave `onboard` version-line test (the
  byte-identical claim rests on a code trace, not a direct assertion). Neither is a functional risk;
  both are candidates for a future sprint's test-hardening pass.
- **File-size smell (low-priority, non-blocking).** `code-review-graph-backend.ts` is 327 lines
  (>300-line soft threshold). It is cohesive today (all six `*Plan` adapters plus
  process/prereq/CLI specs for one backend); consider extracting the `query_graph_tool` pattern map
  into its own module only if the file keeps growing.
- **Pre-existing dead link (out of scope for this sprint's code changes).** Three CLI files —
  `src/cli/commands/graph.ts`, `src/cli/commands/impact.ts`, `src/cli/commands/onboard.ts` — each
  define an `ARCH_DOC_PATH` constant pointing at
  `.bober/architecture/arch-20260524-port-code-review-graph-architecture.md`, which does not exist
  in this repository, and surface it in a user-facing "graph integration is disabled" hint message.
  This sprint fixed the equivalent dead link in `README.md` (repointed to this document) but did
  **not** touch the three `.ts` constants — that is a slightly larger, unrequested code change
  outside this sprint's docs-only scope. A future sprint should either point `ARCH_DOC_PATH` at this
  document or remove it.

---

## 6. Final verification (recorded 2026-07-27, Sprint 8)

Run fresh as part of this sprint, on branch `bober/graph-backend-choice`, no code changes beyond the
one cosmetic CLI description string and this documentation:

- `npx vitest run` → **375 test files (1 skipped), 5083 tests passed | 2 skipped | 0 failed.** This
  includes the full `code-review-graph` adapter suite exercised against the real committed fixtures
  under `tests/graph/fixtures/cr-graph/` (search/impact/reviewContext/overview/changes/query all
  green), the `skipIf`-gated live cr-graph MCP-handshake test (skips — no cr-graph binary on this
  machine's default `PATH`), and the entire pre-existing tokensave test suite unchanged — confirming
  the tokensave path is still byte-identical.
- `npm run build` → clean, zero errors.
- `npm run typecheck` (`tsc --noEmit`) → clean, zero errors.
- `npm run lint` → **0 errors, 2 warnings** (both pre-existing `no-explicit-any` warnings in
  `src/orchestrator/eval-persist.test.ts`, unrelated to this spec).

These numbers match the Sprint 7 baseline (`5083 passed | 2 skipped | 0 failed`, recorded in
`docs/sprints/sprint-spec-20260726-graph-backend-choice-7.md`) exactly — confirming this sprint's
docs-only change introduced zero regressions and zero new test failures.

No live `code-review-graph serve` smoke run against a real installed binary was performed as part of
this sprint; §4 above documents the manual recipe for whoever runs it. The "cr-graph selectable
end-to-end" half of this sprint's final-verification criterion is satisfied via the real committed
fixtures, not a live run — this is stated explicitly per this sprint's nonGoals ("do not claim live
cr-graph verification unless a real run was actually performed and recorded").
