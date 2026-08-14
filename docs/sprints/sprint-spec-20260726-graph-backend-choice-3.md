# Backend selection: `graph.backend` config + auto-detection + wire construction sites + additive manifest

**Contract:** sprint-spec-20260726-graph-backend-choice-3  ·  **Spec:** spec-20260726-graph-backend-choice  ·  **Completed:** 2026-07-27

## What this sprint added

This sprint turns the Sprint-1/2 `GraphBackend` seam into a **selectable** one: agent-bober now
decides *which* graph engine to run instead of always running tokensave. A new
`resolveGraphBackend(config, {probe})` implements the selection policy — an explicit
`config.graph.backend` value wins outright; otherwise it auto-detects by probing each known
engine's `--version` (tokensave preferred when both are installed); when neither is installed it
throws a **combined** install hint naming both engines. All five graph construction sites now
resolve the backend rather than hardcoding tokensave, the `GraphManifest` gains additive
`backend`/`backendVersion` fields (legacy manifests read back as `backend='tokensave'`), and a
registered `CodeReviewGraphBackend` **stub** makes the second engine *selectable* even though its
adapters do not land until Sprints 4–6. The tokensave path is **byte-identical** when
`graph.backend` is unset.

## Public surface

- `config.graph.backend` (`src/config/schema.ts:398`) — optional `z.enum(['tokensave', 'code-review-graph'])`.
  Unset (default) = auto-detect. Additive; a config without it validates exactly as before.
- `config.graph.codeReviewGraphPath` (`src/config/schema.ts:400`) — optional custom cr-graph binary
  path, mirroring the existing `tokensavePath`.
- `resolveGraphBackend(config, deps?)` (`src/graph/backends/registry.ts:95`) — async resolver.
  `deps.probe` is an injectable `VersionProbe` so tests never touch a real binary. Explicit-wins →
  auto-detect (preference order) → throw a combined-hint error.
- `KNOWN_BACKENDS` (`src/graph/backends/registry.ts:28`) — the engine registry in **preference
  order**: `[new TokensaveBackend(), new CodeReviewGraphBackend()]` (tokensave first).
- `VersionProbe` type (`src/graph/backends/registry.ts:36`) — `(binary, args) => Promise<{ok, version?}>`;
  detection only, distinct from the per-site compatibility gate.
- `binaryForBackend(backend, config)` (`src/graph/backends/registry.ts:70`) — resolves the binary to
  invoke, honoring `tokensavePath` / `codeReviewGraphPath` overrides, else the backend's default.
- `GraphBackendResolutionError` (`src/graph/backends/registry.ts:86`) — thrown for an unknown
  explicit backend id and for the neither-installed combined-hint case.
- `CodeReviewGraphBackend` (`src/graph/backends/code-review-graph-backend.ts:32`) — **STUB** backend
  (`id='code-review-graph'`). Real `processSpec()` (`{binary:'code-review-graph', serveArgs:['serve']}`),
  real `prereqSpec()` (`--version`, accept-any-version TODO, `installHint` = `pip install code-review-graph`).
  Its six `*Plan` adapters and `cliMap()` throw the `NOT_IMPL` marker
  (`"code-review-graph adapter not implemented until Sprints 4-6"`, `:24`) until Sprints 4–6.
- `GraphManifest.backend` / `.backendVersion` (`src/graph/types.ts:18`, `:20`) — additive string
  fields recording the resolved engine + version. `tokensaveVersion` is kept for back-compat.
- `GraphArtifactStore.readManifest()` legacy normalization (`src/graph/artifact-store.ts:27`) — a
  manifest lacking `backend` reads back as `backend='tokensave'`, `backendVersion` falling back to
  the always-written `tokensaveVersion`.
- `TokensaveCli` constructor (`src/graph/cli.ts:37`) — gains a 4th param `backend: GraphBackend`
  (defaults to `new TokensaveBackend()`) plus a `binaryOverride?` 3rd param; `cliMap()` is now
  resolved **lazily** inside `init()`/`sync()`/`status()` (`:46` binary getter), not in the
  constructor.

## How to use / how it fits

Selection is **config-only** — there is deliberately no per-command `--backend` flag. Pick an
engine explicitly:

```json
{
  "graph": {
    "enabled": true,
    "backend": "tokensave"
  }
}
```

Or omit `backend` entirely and let agent-bober auto-detect: it probes `tokensave --version` first,
then `code-review-graph --version`, and uses whichever is installed (tokensave wins if both are).
If neither is on `PATH`, resolution fails with a single error naming both install paths (the
tokensave brew/scoop/cargo hint **and** `pip install code-review-graph`).

All five construction sites now call `resolveGraphBackend(config)` and thread the resolved backend
(plus `binaryForBackend(...)`) into the transport, prereq check, `GraphClient`, and CLI wrapper:
`src/graph/pipeline-lifecycle.ts:82`, `src/mcp/server.ts:95`, `src/cli/commands/impact.ts:103`,
`src/cli/commands/onboard.ts:72`, and `src/cli/commands/graph.ts` (init `:95`, sync `:184`,
status `:268`).

Selecting `code-review-graph` today is wired end-to-end but the engine is **not yet functional**:
its `cliMap()`/`*Plan` adapters throw the clean `NOT_IMPL` error rather than silently running
tokensave. That surfaced-but-honored error is the correct behavior until the adapters land in
Sprints 4–6.

## Notes for maintainers

- **Sprint 3 of 8; tokensave path is byte-identical when `graph.backend` is unset.** The
  code-review-graph engine is *selectable* but a no-op — adapters, tool catalog, and fixtures come
  in Sprints 4–6.
- **Iteration-1 lesson — the resolved backend must reach the CLI-construction sites, not just the
  prereq/transport.** Iteration 1 (commit `77bb53c`) failed `sc-3-6`: `src/graph/cli.ts`'s
  `TokensaveCli` hardcoded `this.cliMap = new TokensaveBackend().cliMap()` in its constructor with
  no injection point, so `graph init/sync/status` and the pipeline file-watch **hook-sync** loop
  resolved the backend for the prereq check but then constructed a **tokensave** CLI regardless.
  With `backend='code-review-graph'` (tokensave absent), `graph init` passed the prereq (reporting
  cr-graph) then spawned `tokensave init` → `ENOENT`, instead of the `NOT_IMPL` message. The
  iteration-2 fix (commit `6fc5a00`) injected the backend as a 4th `TokensaveCli` param and made
  `cliMap()` resolve **lazily** inside `init()`/`sync()`/`status()` — so constructing the wrapper
  for a stub backend never throws, and the `NOT_IMPL` error surfaces only on an actual call, before
  any process spawn. Three new test files (12 tests) assert the resolved `backend.id` reaches all
  four sites via ctor-arg spies and that `execa` is never called for the stub; `cli.test.ts` stayed
  byte-identical.
- **Detection vs compatibility are separate.** The `VersionProbe` only answers "did `<binary>
  --version` print a parseable semver?" — it is **not** the compatibility gate. The per-site
  `GenericPrereqCheck` still applies `PrereqSpec.isCompatible` and the version range. An explicit
  backend value short-circuits detection entirely (no probe of the other engine, no fallback if its
  binary is missing).
- **cr-graph version gate is a deliberate TODO.** `CodeReviewGraphBackend.prereqSpec().isCompatible`
  accepts any version for now; tighten it once the adapter (Sprints 4–6) pins a supported range,
  mirroring `TOKENSAVE_VERSION_RANGE`.
- **`tokensaveVersion` is intentionally retained** in the manifest alongside the new
  `backendVersion` (nonGoal to remove it); for the tokensave backend the two mirror each other.
- **Verification.** Full suite **5018 passed | 1 skipped | 0 failed** (+12 new over the 5006
  iter-1 baseline); build/typecheck/lint clean (2 pre-existing warnings). All 8 required criteria
  passed at iteration 2, zero regressions. Commits `77bb53c` (iteration 1, kept) + `6fc5a00`
  (iteration-2 `sc-3-6` fix) on branch `bober/graph-backend-choice`.
