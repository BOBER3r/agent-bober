# Command parity (onboard / impact / graph / external MCP) through the resolved backend + `graph status` readout

**Contract:** sprint-spec-20260726-graph-backend-choice-7  ·  **Spec:** spec-20260726-graph-backend-choice  ·  **Completed:** 2026-07-27

## What this sprint added

This sprint proves that **every** graph-consuming surface — `agent-bober onboard`, `agent-bober
impact`, the `agent-bober graph` command group, and the external MCP server (`src/mcp/server.ts`) —
actually operates **through the resolved backend** end-to-end (not just constructs it), for both
`tokensave` and `code-review-graph`. The surfaces were already switched to `resolveGraphBackend` back
in Sprint 3; this sprint adds coverage that **forces `graph.backend='code-review-graph'` and asserts
the cr-graph tool names are the ones actually called** (e.g. `get_impact_radius_tool` /
`query_graph_tool`, never `tokensave_*`). It also ships three production deltas and closes the two
accumulated correctness follow-ups from Sprints 4/5. **The tokensave path stays byte-identical** (its
existing onboard/impact/graph/reviewContext tests pass unchanged). This closes **feat-5**.

## Public surface

- **`agent-bober graph status` — new engine/version/selection readout** (`src/cli/commands/graph.ts:292-334`).
  The existing `graph status` subcommand's output gains three **additive** fields — in both the
  human-readable output and the `--json` object:
  - `engine` — the resolved backend id (`tokensave` | `code-review-graph`).
  - `backendVersion` — the resolved engine's version (falls back to `manifest.backendVersion`).
  - `selectedBy` — `"config"` when `config.graph.backend` is set explicitly, else `"auto-detect"`.

  The pre-existing `ready` / `indexedFileCount` / `tokensaveVersion` / `lastSyncedHeadSha` / `stale`
  fields are unchanged, so existing tokensave status output is byte-identical (the three new lines are
  appended).
- **`processSpecForBackend(backend, config)`** (`src/graph/backends/registry.ts:101`) — new exported
  helper returning `{ ...backend.processSpec(), binary: binaryForBackend(backend, config) }`. It
  threads the per-backend binary override (`graph.tokensavePath` for tokensave,
  `graph.codeReviewGraphPath` for cr-graph) into the spawned `serve` subprocess. Now used at **all
  four** transport construction sites: `onboard.ts`, `impact.ts`, `pipeline-lifecycle.ts`,
  `mcp/server.ts`.

## The two follow-ups this sprint closed

### HIGH — `GraphClient.reviewContext()` narrow bypass (from Sprint 5)

`src/graph/client.ts:91-93` — `reviewContext()` now routes through `runWithSandbox` with the
backend's `reviewContextPlan.narrow`, exactly like `overview()` does:

```ts
const { tool, params, narrow } = this.backend.reviewContextPlan(nodes);
return this.runWithSandbox<string>(tool, params, narrow);
```

The dead `runRaw<T>()` helper (an identity-cast wrapper that silently skipped the narrow) is
**deleted**. Previously `reviewContext()` returned cr-graph's `get_review_context_tool` **JSON
object** mistyped as `GraphResult<string>`; now the backend's narrow stringifies it before it reaches
callers. **tokensave is byte-identical** here because `TokensaveBackend.reviewContextPlan.narrow` is
an identity passthrough (its raw is already a string) — verified three ways by the evaluator (the
pre-existing tokensave `reviewContext` test is unchanged and still passes).

### MEDIUM — `codeReviewGraphPath` not threaded into the transport (from Sprint 4)

`TokensaveMcpClient.spawnAndHandshake` resolves its spawned binary as `cfg.tokensavePath ??
processSpec.binary` (`mcp-client.ts:243`). That precedence is load-bearing for an existing test and
**was not touched**. Instead, the new `processSpecForBackend()` resolves the binary via
`binaryForBackend()` at the **construction site** and passes it in as `processSpec.binary`, so for the
cr-graph backend (where `cfg.tokensavePath` is never set) `graph.codeReviewGraphPath` now actually
reaches the spawned `code-review-graph serve` subprocess — at all four construction sites — without
editing `mcp-client.ts`.

## How to use / how it fits

Backend selection remains **config-only** (Sprint 3): set `graph.backend = "code-review-graph"` (or
let auto-detect pick it), optionally with `graph.codeReviewGraphPath` pointing at the binary. As of
this sprint:

- `agent-bober onboard` writes all five markdown artifacts (README, architecture-overview, hotspots,
  knowledge-gaps, communities) through the resolved backend; its status/version line now sources
  `manifest.backendVersion` (`onboard.ts:151`), so a cr-graph run shows the **cr-graph** version, not
  an empty/assumed tokensave version. Its five `search()` calls and the `SearchHit → OnboardingInputs`
  mapping are **unchanged** (nonGoal to rework the data strategy).
- `agent-bober impact` and `agent-bober graph` operate through the resolved cr-graph backend
  (tests assert the cr-graph tool list, not tokensave's).
- The external MCP server builds its `GraphClient` on the resolved backend (a test constructs it with
  `graph.backend='code-review-graph'` and asserts `GraphClient` ctor arg `.id === 'code-review-graph'`).
- `agent-bober graph status` reports which engine is live, its version, and whether it was chosen by
  explicit config or auto-detection — e.g. `Engine: code-review-graph`, `Version: 2.3.7`,
  `Selected by: config`; or `Engine: tokensave`, `Version: 6.1.1`, `Selected by: auto-detect`.

## Notes for maintainers

- **feat-5 is complete.** Every graph-consuming surface is verified end-to-end for both backends;
  tokensave is byte-identical. Only **Sprint 8 (docs)** remains in the spec.
- **Documented residuals carried into Sprint 8:**
  - **cr-graph `update` diff-base ceiling** (from Sprint 4). cr-graph's `update` is git-diff-base
    driven (`--base HEAD~1`), not a positional-path receiver like tokensave's `sync <paths>`.
    `syncArgs` still forwards `paths` to satisfy the shared `CliMap` interface; reconciling the generic
    `sync(paths)` call site with cr-graph's diff-based model is a deferred documented follow-up.
  - **`tokensavePath` + `backend='code-review-graph'` transport-layer preference.** A config that sets
    **both** `graph.tokensavePath` *and* `graph.backend='code-review-graph'` still has
    `mcp-client.ts:243` prefer `tokensavePath` at the transport layer (its own untouched precedence).
    This is a documented, low-probability residual ambiguity — reconciling it would require changing
    `mcp-client.ts`'s precedence, which risks the existing `tokensavePath`-override test; deferred.
  - **cr-graph `isCompatible` accept-any-version TODO** (from Sprint 3). `CodeReviewGraphBackend`'s
    prereq spec still accepts any version (no version range gate yet).
- **Advisory (evaluator, low).** No dedicated test asserts the *tokensave* onboard version line
  renders correctly; the byte-identical claim rests on an unambiguous code trace
  (`backendVersion === tokensaveVersion` when `backend.id === 'tokensave'`). Adding a
  tokensave-backend onboard version-line test is an optional follow-up.
- **Verification.** Full suite **5083 passed | 2 skipped | 0 failed** (+7 over the 5076 baseline);
  build/typecheck/lint clean (2 pre-existing warnings). All six required criteria (sc-7-1..sc-7-6)
  passed at **iteration 1**; the evaluator independently verified the per-surface cr-graph tool-name
  assertions, the `reviewContext` byte-identical trace, and the `codeReviewGraphPath` threading at all
  four sites. Commit `d190d7b` on branch `bober/graph-backend-choice`.
