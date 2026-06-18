# Coordinator re-run loop (rounds, idempotent re-spawn, early-stop)

**Contract:** sprint-spec-20260618-fleet-blackboard-exchange-3  ·  **Spec:** spec-20260618-fleet-blackboard-exchange  ·  **Completed:** 2026-06-18

## What this sprint added

The **runtime that turns the Phase B blackboard from a passive seam into a live exchange loop**.
Until now (Sprints 1-2) a blackboard manifest only *configured* a shared `facts.db` and injected
its path into children — the fleet still ran exactly one pass. This sprint makes a blackboard fleet
run **up to `maxRounds` rounds** over the same shared blackboard: round 1 scaffolds each child's
config (once), every round re-spawns `agent-bober run`, and the loop **early-stops** as soon as a
completed round adds **zero new `'finding'` facts**. The no-blackboard path stays a **byte-identical
single pass** through the unchanged `coordinator.execute`, and the existing exit-0
(per-child-failures-are-data) contract is preserved throughout. `fleet-report.json` is still written
from the **final** round's outcomes; `fleet-synthesis.json` remains Sprint 4.

## Public surface

- `FleetCoordinator.executeRounds(manifest, blackboard, { maxRounds, dbPath })` (`src/fleet/coordinator.ts:55`)
  — the bounded rounds loop. For `r` in `1..maxRounds` it runs
  `mapBounded(children, concurrency, child => runChildRound(rootDir, child, r, …))`, threading the
  Sprint-2 scaffold config (`{ dbPath, namespace, maxRounds }`) **only on round 1** (`undefined`
  thereafter). After each round it reads `blackboard.readAll().length`; for `r > 1`, an unchanged
  count **breaks** the loop (`coordinator.ts:77`). Returns the **final** round's `ChildExecution[]`.
- `Scaffolder.scaffold(rootDir, child, blackboard?)` (`src/fleet/coordinator.ts:15`) — the
  coordinator's injection-seam interface widened with an **optional 3rd param**
  `{ dbPath: string; namespace: string; maxRounds: number }` (not an overload, so the existing fake
  scaffolders in tests stay type-compatible). This mirrors the concrete
  `ChildScaffolder.scaffold` widened in Sprint 2.
- `runFleet` blackboard branch (`src/fleet/index.ts:135`) — `runFleet` now computes
  `resolveBlackboardPath(effectiveManifest)` once and, when it returns a path, `ensureDir`s the db
  directory, opens a `SharedBlackboard`, runs `coordinator.executeRounds(...)` inside a
  `try`/`finally` that always `close()`s the blackboard, then continues to the **unchanged**
  aggregate + `fleet-report.json` write. When the path is `undefined` it falls back to the verbatim
  `coordinator.execute(effectiveManifest)` single pass.

`runChildRound` (`src/fleet/coordinator.ts:91`) is a private round-aware "never-reject" thunk
(scaffold-once on `round === 1`, reuse `resolve(rootDir, child.folder)` on later rounds, full
`try`/`catch` → `ChildExecution` with `scaffold.error` on failure) — internal, not exported.

## How to use / how it fits

There is **no new user-facing command or flag**. The behavior is driven entirely by the optional
`blackboard` block on the fleet manifest (introduced in Sprint 2):

```jsonc
{
  "rootDir": ".",
  "concurrency": 3,
  "blackboard": { "namespace": "fleet-run-123", "maxRounds": 3 },
  "children": [
    { "folder": "api-server",  "task": "Build a REST API server with auth" },
    { "folder": "web-frontend", "task": "Build a React frontend for the API" }
  ]
}
```

`agent-bober fleet <manifest>` on a manifest **with** a `blackboard` block now runs the children up
to `maxRounds` times sharing `<rootDir>/.bober/memory/<namespace>/facts.db`, early-stopping when a
round produces no new findings. Children publish/read across rounds with the existing
`agent-bober blackboard publish|read` CLI (Sprint 2) — re-spawning each round is how a child gets to
*see* the prior round's siblings' findings. A manifest with **no** `blackboard` block runs a single
pass exactly as before. This sequencing realizes the CP4 data-flow of
`arch-20260618-heterogeneous-multi-provider-agent-team` (ADR-3).

## Notes for maintainers

- **Early-stop is purely structural, not semantic.** The stop condition is "this round's
  `readAll().length` did not exceed the previous round's" — there is no convergence/quality judging
  (an explicit non-goal). `prevCount` is seeded **before** the loop and only updated when the round
  did *not* early-stop, so round 1 can never trigger a stop (the `r > 1` guard) and a single
  productive round always runs at least twice before the loop can break on flat findings.
- **Scaffold-once is enforced by the round gate, not by the scaffolder.** `runChildRound` calls the
  scaffolder only when `round === 1`; on rounds ≥ 2 it synthesizes a `ScaffoldResult` from
  `resolve(rootDir, child.folder)` and skips straight to `runner.run`, so a child's round-1
  `bober.config.json` (carrying its `fleet` section) is **never** re-written/clobbered. The
  scaffolder's own idempotence is not relied on for correctness here.
- **No-blackboard is byte-identical.** `runFleet` branches on `resolveBlackboardPath(...) !== undefined`;
  with no `blackboard` block it calls `coordinator.execute(...)` verbatim — no `SharedBlackboard.open`,
  no `ensureDir`, no `.bober/memory/.../facts.db` created. The 5 pre-existing coordinator tests and all
  index tests pass unchanged (the diff is additions only).
- **Never-throw preserved.** `runChildRound` wraps the scaffold *and* the spawn in a single
  `try`/`catch`; a failing child becomes a `ChildExecution` with `scaffold.error` (and
  `spawn: undefined`) rather than aborting the round or the run. The blackboard is `close()`d in a
  `finally`, so a mid-run error still checkpoints the WAL. Only batch-setup errors (bad manifest,
  missing credentials, report IO) still exit `1`.
- **Report is from the final round.** `executeRounds` returns only the last round's
  `ChildExecution[]`; the aggregate + `fleet-report.json` write path is unchanged from Phase 1.
  Per-round history is **not** persisted — `fleet-synthesis.json` (a head-side synthesis over the
  blackboard) is Sprint 4 and an explicit non-goal here.
- **Scope.** Commit `2e16f19`: `src/fleet/coordinator.ts`, `src/fleet/index.ts`, plus the collocated
  `coordinator.test.ts` / `index.test.ts`. Full suite **2781 passed**, fleet **268/268** (only the 6
  pre-existing cockpit-integration MCP failures remain). All 8 criteria (sc-3-1..sc-3-8) passed
  iteration 1.
