# Fold process spec + prereq + CLI map into the backend; parameterize the transport (tokensave byte-identical)

**Contract:** sprint-spec-20260726-graph-backend-choice-2  ·  **Spec:** spec-20260726-graph-backend-choice  ·  **Completed:** 2026-07-27

## What this sprint added

This sprint extends the Sprint-1 `GraphBackend` seam with the **remaining engine-specific
surface**, so a backend now fully describes how to *run* its engine, not just how to shape its
query calls. `GraphBackend` gains three accessors — `processSpec()` (binary + serve args),
`prereqSpec()` (version command + compatibility predicate + install hints), and `cliMap()`
(init/sync/status args + output parsers). The verbatim tokensave literals (the version range
`>=6.0.0-beta.1 <7.0.0`, the brew/scoop/cargo install hints, `parseSyncOutput`, and the
`status --json` parsing) **moved out of** `prereq.ts` and `cli.ts` **into** `TokensaveBackend`.
The MCP transport (`mcp-client.ts`) now spawns `binary + serveArgs` from an injected
`ProcessSpec` instead of a hardcoded `execa(this.binary, ["serve"])`. This is still
**tokensave-only** and **byte-identical**: it is the last extraction before Sprint 3 adds
`config.graph.backend` selection.

## Public surface

- `ProcessSpec` interface (`src/graph/backends/types.ts:31`) — `{ binary: string; serveArgs: string[] }`;
  how to spawn the engine's long-lived MCP server.
- `PrereqSpec` interface (`src/graph/backends/types.ts:37`) — `{ versionArgs, isCompatible(version),
  installHint(platform), incompatibleHint(detected) }`; how to detect + version-gate the binary.
- `CliMap` interface (`src/graph/backends/types.ts:46`) — `{ initArgs(opts), syncArgs(paths),
  statusArgs, parseSync(output), parseStatus(stdout) }`; how to run + parse the short-lived
  init/sync/status CLI.
- `Platform` type (`src/graph/backends/types.ts:28`) — alias of `typeof process.platform`, used by
  `PrereqSpec.installHint` (avoids a bare `NodeJS.*` reference under the flat eslint config).
- `GraphBackend.processSpec()` / `prereqSpec()` / `cliMap()` (`src/graph/backends/types.ts:90`, `:92`, `:94`) —
  three new required methods on the backend interface.
- `TokensaveBackend` implementations (`src/graph/backends/tokensave-backend.ts:344`, `:348`, `:360`) —
  return `{binary:"tokensave", serveArgs:["serve"]}`, the tokensave `PrereqSpec`, and the tokensave
  `CliMap`. The verbatim strings/parsers now live only here: `TOKENSAVE_VERSION_RANGE` (`:39`),
  `tokensaveInstallHint` (`:42`), `tokensaveIncompatibleHint` (`:54`), `parseSyncOutput` (`:66`),
  `parseStatusOutput` (`:102`).
- `SyncResult` / `StatusResult` interfaces (`src/graph/types.ts:35`, `:39`) — **moved** here from
  `cli.ts` (shared with the backend's `CliMap`) and **re-exported** from `./cli.js`
  (`src/graph/cli.ts:11`) so existing importers are unchanged. Purely additive.
- `GenericPrereqCheck` class (`src/graph/prereq.ts:15`) — backend-agnostic version-gate: runs
  `<binary> <spec.versionArgs>`, extracts a semver, and defers compatibility + hints to the injected
  `PrereqSpec`. Holds **no** engine-specific strings.
- `TokensavePrereqCheck` class (`src/graph/prereq.ts:62`) — kept as a thin tokensave-defaulted
  wrapper over `GenericPrereqCheck` so `new TokensavePrereqCheck(binary?)` + `.check()` callers are
  unchanged.
- `TokensaveCli` class (`src/graph/cli.ts:27`) — now drives its argv and output parsing from
  `new TokensaveBackend().cliMap()`; the transport-level guards (idempotent-init "already
  initialized", timeout, empty-stdout, throw-on-null-exit) stay in the class since they are not
  parsing concerns.
- `TokensaveMcpClient` constructor (`src/graph/mcp-client.ts:122`) — 4th param is now
  `processSpec: ProcessSpec` (was `binary: string = "tokensave"`); `spawnAndHandshake` spawns
  `execa(cfg.tokensavePath ?? processSpec.binary, processSpec.serveArgs)` (`src/graph/mcp-client.ts:243`).

## How to use / how it fits

Construction sites hardcode the tokensave backend and derive the transport spec from it (backend
*selection* is still Sprint 3). `pipeline-lifecycle.ts` now builds **one** `TokensaveBackend` and
reuses it for both the transport and the `GraphClient`:

```ts
this.backend = new TokensaveBackend();
this.mcpClient = new TokensaveMcpClient(
  projectRoot, cfg, this.incidents,
  this.backend.processSpec(),   // { binary: "tokensave", serveArgs: ["serve"] }
);
// ...later, getGraphClient() injects `this.backend ?? new TokensaveBackend()`
```

The other three sites (`onboard.ts`, `impact.ts`, `mcp/server.ts`) similarly construct a local
`backend` and pass `backend.processSpec()` to the transport and the same `backend` to `GraphClient`.
The version gate (`TokensavePrereqCheck`) and the init/sync/status wrapper (`TokensaveCli`) resolve
their tokensave strings from the backend internally, so their call sites are unchanged.

A future engine implements `processSpec`/`prereqSpec`/`cliMap` on its own `GraphBackend`; the
transport, the generic prereq check, and the CLI wrapper then run *that* engine with no further
changes to those modules.

## Notes for maintainers

- **Sprint 2 of 8; tokensave path is byte-identical.** No `config.graph.backend`, no
  auto-detection, no `resolveGraphBackend` (Sprint 3), and **no** code-review-graph backend code,
  tool names, or fixtures (Sprints 4–6).
- **Verbatim strings, one home.** `TOKENSAVE_VERSION_RANGE` and the brew/scoop/cargo install hints
  are marked "DO NOT paraphrase" and now live **only** in `tokensave-backend.ts`. The evaluator
  diffed them character-for-character against the pre-refactor source. The same user-facing strings
  are mirrored in the README's Graph section — keep them in sync if the range/hints ever change.
- **`languageTier` is accepted but not forwarded.** `CliMap.initArgs({languageTier?})` takes the
  bober-level manifest concept for caller convenience but returns just `["init"]` — tokensave's
  `init` has no `--tier` flag. This preserves prior behavior.
- **Transport binary resolution unchanged.** `spawnAndHandshake` still prefers
  `cfg.tokensavePath` over the spec's `binary`; only the previously-hardcoded `["serve"]` literal
  moved into `ProcessSpec.serveArgs`. The MCP initialize/tools-call wire protocol, circuit breaker,
  and health-state machine were **not** touched (nonGoals).
- **`grep -e "serve"|"6.0.0"|install-hint` in the transport/prereq/cli modules is now clean** — the
  only functional tokensave literals for these layers live in the backend (one pre-existing comment
  aside, noted by the evaluator).
- **Verification.** Full suite **4994 passed | 1 skip | 0 failures** (`tests/graph/` 244/244, +20
  new; `cli.test.ts` diff was 0 lines — byte-identical). `skipIf` integration tests ran against a
  real **tokensave 6.1.1** (handshake + `tokensave_status` round-trip) and passed. All 6 required +
  1 optional criteria passed iteration 1, zero regressions. Commit `129d841` on branch
  `bober/graph-backend-choice`.
