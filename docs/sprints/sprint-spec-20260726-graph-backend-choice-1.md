# GraphBackend interface + extract TokensaveBackend (tokensave byte-identical)

**Contract:** sprint-spec-20260726-graph-backend-choice-1  ·  **Spec:** spec-20260726-graph-backend-choice  ·  **Completed:** 2026-07-27

## What this sprint added

This sprint introduces a **pluggable code-graph backend seam**. All tokensave-specific
knowledge — the `tokensave_*` MCP tool catalog, the raw 6.1.1 row/result shapes, the
`toNodeRef` kind-coercion adapter, and the per-method `narrow` logic — was extracted out of
`src/graph/client.ts` into a new `GraphBackend` interface (`src/graph/backends/types.ts`) and a
concrete `TokensaveBackend` implementation (`src/graph/backends/tokensave-backend.ts`).
`GraphClient` now takes an injected `GraphBackend` as its **7th constructor parameter** and asks
it for a `{tool, params, narrow}` **call plan** per operation, while keeping ALL of its
cross-cutting logic (sandbox `keepNode` post-filter, staleness cache, health short-circuits,
`GRAPH_DISABLED`/`GRAPH_UNAVAILABLE`, `GraphFallback`, prefetch dispatch) unchanged. This is a
**pure refactor**: every construction site passes `new TokensaveBackend()`, so the tokensave path
is byte-identical. The seam is what later sprints in this spec use to add a second, distinct
code-review-graph backend without touching `GraphClient`'s cross-cutting core.

## Public surface

- `GraphBackend` interface (`src/graph/backends/types.ts:47`) — per-engine tool catalog + param
  builders + response-shape adapters. Carries a `readonly id: string` engine identifier and one
  `*Plan` method per logical operation: `searchPlan`, `queryPlan`, `impactPlan`,
  `reviewContextPlan`, `overviewPlan`, `changesPlan`.
- `CallPlan<T>` interface (`src/graph/backends/types.ts:33`) — a single MCP call plan:
  `{ tool: string; params: unknown; narrow: (raw: unknown) => T }`. `narrow` must be **pure** (no
  I/O, no sandbox filtering); `GraphClient` applies the sandbox post-filter *after* calling
  `narrow`, because that filter needs `projectRoot` + `incidents`, which the backend does not have.
- `QueryPattern` / `SearchOpts` (`src/graph/backends/types.ts:11`, `:18`) — moved here from
  `client.ts` and **re-exported** from `./client.js` (`src/graph/client.ts:32`) so existing
  importers keep working unchanged.
- `TokensaveBackend` class (`src/graph/backends/tokensave-backend.ts:119`) — `implements
  GraphBackend`, `id = "tokensave"`. Owns the `TOOL` catalog (`:17`), the per-pattern `QUERY_TOOL`
  map (`:26`), the adapter-internal `Ts*Row` raw types (`:33`–`:93`), `NODE_KINDS` (`:98`) +
  `toNodeRef` (`:100`), and the six `*Plan` methods that reproduce the exact tool names, params, and
  narrowing that previously lived inline in `client.ts`.
- `GraphClient` constructor (`src/graph/client.ts:47`) — gains a 7th param
  `private readonly backend: GraphBackend`. Public method signatures
  (`search`/`query`/`impact`/`reviewContext`/`overview`/`changes`/`prefetch`) and the
  `GraphResult` return shapes are **unchanged**; `NodeRef`/`SearchHit`/`ImpactReport` in
  `src/graph/types.ts` are byte-untouched.

## How to use / how it fits

Constructing a `GraphClient` now requires injecting a backend. The four production construction
sites all pass `new TokensaveBackend()`:

- `src/graph/pipeline-lifecycle.ts` (`getGraphClient`)
- `src/cli/commands/onboard.ts`
- `src/cli/commands/impact.ts`
- `src/mcp/server.ts` (graph-tools registration)

Each `GraphClient` public method delegates the engine-specific decision and keeps the cross-cutting
work, e.g. `search`:

```ts
const { tool, params, narrow } = this.backend.searchPlan(q, opts);
return this.runWithSandbox(tool, params, (raw) =>
  narrow(raw).filter((h) => this.keepNode(h.node, "search")),
);
```

A new backend (e.g. a future code-review-graph engine) implements `GraphBackend`, returns its own
`{tool, params, narrow}` per operation, and is injected at construction — nothing in
`GraphClient`'s sandbox/staleness/health/fallback/prefetch logic changes.

## Notes for maintainers

- **Sprint 1 of 8; tokensave path is byte-identical.** This sprint delivers only the seam +
  extraction. There is **no** `config.graph.backend`, no auto-detection, no `resolveGraphBackend`
  (Sprint 3), no transport/serveArgs/prereq/CLI change (Sprint 2), and **no code-review-graph
  backend code, tool names, or fixtures** (Sprints 4–6). Do not read this doc as "a second backend
  exists" — only `TokensaveBackend` is implemented and wired.
- **`grep tokensave_ src/graph/client.ts` is now empty.** The catalog lives only in
  `tokensave-backend.ts`. Keep it that way — any new tokensave tool name or `Ts*Row` shape belongs
  in the backend, not the client.
- **`narrow` is pure by contract.** The backend must never do sandbox filtering, I/O, or reference
  `projectRoot`/`incidents`; `GraphClient` owns the `keepNode` post-filter. Preserving this split is
  what keeps the seam clean for the second backend.
- **Construction sites:** the contract anticipated two (`pipeline-lifecycle.ts`, `onboard.ts`); the
  actual change also injects the backend at `impact.ts` and `mcp/server.ts` — four sites total.
- **Verification.** Full suite **4974 passed | 1 pre-existing skip | 0 failures**
  (`tests/graph/` 224/224, incl. 15 new `tests/graph/backends/tokensave-backend.test.ts` cases);
  the evaluator diffed the extracted narrows byte-for-byte against the pre-refactor `client.ts` and
  confirmed `types.ts` unchanged. All 6 required + 1 optional criteria passed iteration 1, zero
  regressions. Commit `ae1bde7` on branch `bober/graph-backend-choice`.
