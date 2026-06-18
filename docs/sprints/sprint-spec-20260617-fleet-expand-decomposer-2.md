# fleet expand subcommand (write-and-stop, --yes gate)

**Contract:** sprint-spec-20260617-fleet-expand-decomposer-2  ·  **Spec:** spec-20260617-fleet-expand-decomposer  ·  **Completed:** 2026-06-17

## What this sprint added

The user-facing CLI for fleet **expand** (Phase 2 of the fleet orchestrator), completing the
plan. A new `agent-bober fleet expand <goal>` subcommand is attached as a sibling of the
locked Phase 1 `fleet <manifest>` runner. It builds a DeepSeek decomposer client
(**credential fail-fast** before any IO), calls Sprint 1's `decomposeGoal` to turn one goal
string into a children-only manifest, assembles `{ rootDir, concurrency, children }`, **atomically
writes** it to `<root>/.bober/fleet-expand.json`, prints the manifest plus a review hint, and
**stops by default**. It chains into the locked `runFleet(outPath)` **only** when `--yes` is
passed — the write-and-stop review gate is the sole spawn gate (no TTY check, no interactive
prompt). The change is additive: the `fleet <manifest>` registration is byte-identical
(only `program` → `const fleet = program` capture + a trailing `registerFleetExpandSubcommand(fleet)`
call), and `runFleet` / `FleetManifestSchema` / `buildChildConfig` are untouched.

## Public surface

- `agent-bober fleet expand <goal>` (CLI subcommand) — decompose a goal into a fleet manifest, write it, and optionally run it. Default writes-and-stops (exit 0, no spawn). Options: `--count <n>` (soft target for number of sub-projects), `--provider <p>` (decomposer LLM provider, default `openai-compat`), `--model <m>` (decomposer LLM model **only**, default `deepseek-v4-pro`), `--root <dir>` (manifest `rootDir`, default `.`), `--concurrency <c>` (manifest concurrency, default `3`), `--out <path>` (override the output path), `--yes` (chain into the fleet run after writing).
- `runFleetExpand(goal, opts, deps?): Promise<void>` (`src/fleet/index.ts:169`) — exported testable seam holding the action body. Order is load-bearing: (1) build the client (fail-fast), (2) `decomposeGoal`, (3) assemble manifest, (4) atomic temp+rename write to `outPath` with an overwrite notice, (5) print manifest + review hint, (6) `if (opts.yes)` call `runFleet(outPath)` and print the Fleet Summary, else set `process.exitCode = 0`. `deps` injects fake `decompose` / `runFleet` / `createClient` for tests (no network, no spawn).
- `registerFleetExpandSubcommand(fleet: Command): void` (`src/fleet/index.ts:266`) — attaches `.command("expand <goal>")` to the existing `fleet` parent (mirroring `registerWorktreeCommand`'s parent+child pattern). The commander `.action` is a thin try/catch wrapper around `runFleetExpand` (`logger.error` + `process.exitCode = 1` on throw).
- `FleetExpandOptions` interface (`src/fleet/index.ts:131`) — the parsed Commander options (`count`/`provider`/`model`/`root`/`concurrency`/`out`/`yes`, all optional).
- `FleetExpandDeps` interface (`src/fleet/index.ts:148`) — `{ decompose?, runFleet?, createClient? }` DI seam.

## How to use / how it fits

```bash
# 1. Decompose a goal → write a manifest → STOP for review (default)
agent-bober fleet expand "Build a todo app with an API server and a web frontend" --count 2

#   …writes <root>/.bober/fleet-expand.json, prints the manifest, then:
#   Review then run: agent-bober fleet "<root>/.bober/fleet-expand.json"

# 2. Review/edit the written manifest, then run it with the locked Phase 1 runner
agent-bober fleet ".bober/fleet-expand.json"

# 3. …or skip the review gate and run immediately after writing
agent-bober fleet expand "Build a todo app …" --yes
```

This closes the Phase 2 loop: Sprint 1 built the pure `decomposeGoal` core (goal → Zod-valid
children-only `FleetManifest`); this sprint owns the CLI side — `createClient` /
`DEEPSEEK_API_KEY`, the manifest file write, and the `runFleet` chaining that Sprint 1
deliberately left out. The written manifest is a normal `FleetManifestSchema` document, so
`fleet expand … --yes` and `fleet expand …` then `fleet <writtenPath>` are equivalent paths
into the same locked runner.

## Notes for maintainers

- **Three load-bearing safety invariants** (evaluator-verified structurally + by test): (1)
  `createClient` is the **first** statement in `runFleetExpand`, before any `ensureDir` / write /
  rename, so a missing `DEEPSEEK_API_KEY` aborts (exit 1) with **no file written** and
  `decomposeGoal` never reached; (2) the **only** `runFleet` call site is inside `if (opts.yes)`
  (`src/fleet/index.ts:237`) — default invocation cannot spawn; (3) the `fleet <manifest>`
  registration is byte-identical.
- **`--model` overrides the decomposer's own LLM only** — not the children's per-run providers.
  Children inherit their provider/model from the manifest / each child run's config as before.
- **Atomic write** uses a `randomBytes`-suffixed temp file + `rename` (mirroring `writeRunState`);
  the file is overwritten when it already exists, with a printed `[fleet expand] Overwritten
  existing manifest at: <path>` notice. `--out` redirects the write away from the
  `<root>/.bober/fleet-expand.json` default.
- **The fail-fast depends on the real factory.** The credential test injects a *throwing*
  `createClient` fake to bypass the `BOBER_TEST_DETERMINISTIC` guard in `providers/factory.ts`
  (which would otherwise skip `validateApiKey`); in production the unmodified factory throws for
  `openai-compat` + `api.deepseek.com` with no key.
- **No two-call decomposition and no hard child-count cap** — `--count` is folded into the goal
  prompt as a *soft* target only (these remain out of scope this plan).
- The fleet orchestrator's architecture is under `.bober/architecture/`:
  `arch-20260609-fleet-orchestrator-tech-lead-*` (Phase 1 runner) and
  `arch-20260617-fleet-orchestrator-phase-2-expand-*` (this phase).
