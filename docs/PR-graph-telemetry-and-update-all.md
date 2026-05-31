## Why

Two questions motivated this: *"are the agents actually using the code graph?"* and *"how do I update agent-bober across the 3 solex projects without hand-editing each?"* This PR makes the first **measurable** and the second **one command**.

## What

### 1. Graph-preflight run-level telemetry (`feat(graph)`)
The tokensave graph was wired in but **unmeasured** — `inject()` fail-opened silently, so history had no record of whether graph context actually reached an agent. Now every spawn under an enabled graph appends a `graph-preflight` event to `.bober/history.jsonl`:

| field | meaning |
|---|---|
| `role` | curator / generator / evaluator / … |
| `outcome` | `injected` / `skipped-engine-not-ready` / `skipped-no-client` / `no-context` / `degraded` / `timeout` / `error` |
| `injected`, `approxTokensAdded`, `budgetTokens` | did context get added, and how much |
| `engineHealth`, `elapsedMs` | engine state + preflight cost |

Instrumented at the single chokepoint `PreflightContextInjector.inject()` → all roles covered, **zero call-site changes**. Best-effort (optional-chained + try/catch); telemetry can never block a spawn. Disabled-graph stays zero-overhead.

**To prove the graph helps:** run a sprint, then `grep graph-preflight .bober/history.jsonl`. `outcome:injected` with non-zero tokens = the graph is feeding agents.

### 2. `update-all` propagation + Claude plugin (`feat(scripts)`)
agent-bober reaches consuming projects two ways: CLI via npm **symlink** (shared — `npm run build` updates all at once), but skills/agents are **copied** into each `.claude/` and went stale on every edit.

- `npm run update-all` — builds the CLI once, then re-inlines skills + copies agents into every registered project (`scripts/sync-targets.json`), **byte-identical to `init`**. Flags: `--check` (dry-run drift, nonzero on drift), `--skills-only`, `--discover`, or explicit paths. Caught that `apps/api` was missing 3 commands.
- `.claude-plugin/marketplace.json` + `plugin.json`@0.15.0 — long-term path so skills install/update via `/plugin` instead of copies.

### 3. Stale test fixes (`test`)
Two pre-existing failures (not from this work): version assertion `0.14.0`→`0.15.0`, and graph-schema asserting `checkpointMechanism` parses to `noop` when the schema leaves it `undefined` (resolved at runtime from `mode`). Also fixed a malformed `describe` closing that corrupted a sibling test.

## Verification
- `npm run build` ✓  `tsc --noEmit` ✓
- Full suite: **1356 passed / 3 skipped / 0 failed** (107 files)
- New: `src/graph/preflight-telemetry.test.ts` (4 tests)
- `update-all --check` → 0 drift after sync

🤖 Generated with [Claude Code](https://claude.com/claude-code)
