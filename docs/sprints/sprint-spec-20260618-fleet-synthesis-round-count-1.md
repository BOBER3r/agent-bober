# executeRounds returns real round count → fleet-synthesis.json + fleet-report.json

**Contract:** sprint-spec-20260618-fleet-synthesis-round-count-1  ·  **Spec:** spec-20260618-fleet-synthesis-round-count  ·  **Completed:** 2026-06-18

## What this sprint added

This single-sprint spec **closes the one documented carry-forward limitation of Phase B**
(`spec-20260618-fleet-blackboard-exchange` Sprint 4): the round count reported on a blackboard
fleet run was the configured `maxRounds` **cap**, not the number of rounds actually executed when
a run early-stopped. `FleetCoordinator.executeRounds` now returns the **real terminating round**
alongside the final-round executions, and `runFleet` threads that count into **both** output
artifacts — `.bober/fleet-synthesis.json` (replacing the old cap value) and a **new optional
`rounds` field** on `.bober/fleet-report.json` (present **only** on blackboard runs). The
no-blackboard path stays **byte-identical** to Phase A. No behavior changed — only the reported
count became accurate.

## Public surface

- `FleetCoordinator.executeRounds(...)` (`src/fleet/coordinator.ts:55`) — return type changed from
  `Promise<ChildExecution[]>` to `Promise<{ executions: ChildExecution[]; roundsRun: number }>`.
  `roundsRun` is the round at which the bounded loop terminated: `=== maxRounds` on a full run,
  `< maxRounds` on a no-new-findings early-stop (e.g. `2` when the loop stops at round 2 of a
  `maxRounds: 3` run, `1` when `maxRounds === 1`). It is captured as the **first statement of each
  loop iteration** (`coordinator.ts:71`), so it holds the last executed round even when the
  early-stop `break` (`coordinator.ts:79`) fires later in the same iteration. `executions` is still
  the **final** round's `ChildExecution[]`. The method is private to `src/fleet/`; the early-stop
  condition, the scaffold-once gating, and the never-reject `runChildRound` thunk are untouched.
- `interface PortfolioReport` (`src/fleet/reporter.ts:17`) — gained an **optional** `rounds?: number`.
- `PortfolioReporter.build(...)` (`src/fleet/reporter.ts:37`) — signature changed to
  `build(outcomes: ChildOutcome[], opts?: { rounds?: number }): PortfolioReport`. The returned
  literal uses a **guarded spread** `...(opts?.rounds !== undefined ? { rounds: opts.rounds } : {})`,
  so a no-arg `build(outcomes)` call produces a report with **no** `rounds` key — byte-identical to
  before.
- `<rootDir>/.bober/fleet-report.json` (output artifact) — on a **blackboard** run now carries
  `rounds` = the real executed count (and it equals `fleet-synthesis.json.rounds`). On a
  **no-blackboard** run the key is **absent**.
- `<rootDir>/.bober/fleet-synthesis.json` (output artifact) — its existing `rounds` field is now the
  real executed count, not the `maxRounds` cap.

`synthesis.ts` was **not** changed — `collect(blackboard, childResults, rounds)` already took
`rounds: number`; only the value `runFleet` passes in changed.

## How to use / how it fits

There is **no new user-facing command or flag.** The accurate count is produced automatically by
`agent-bober fleet <manifest>` whenever the manifest carries a `blackboard` block. In `runFleet`
(`src/fleet/index.ts`), the blackboard branch now destructures the real count out of
`executeRounds`, the report build became
`reporter.build(outcomes, bb ? { rounds: roundsRun } : undefined)`, and the existing
`collect(bb, report, roundsRun)` call now passes the real count. The now-obsolete `bober:` ceiling
comment and the hardcoded `roundsRun = effectiveManifest.blackboard!.maxRounds` assignment were
removed.

A blackboard run that early-stops at round 2 of `maxRounds: 3` now writes `"rounds": 2` (not `3`)
to **both** files; a full 3-round run writes `"rounds": 3`. A no-blackboard run writes **no**
`fleet-synthesis.json` and a `fleet-report.json` with **no** `rounds` key.

## Notes for maintainers

- **Byte-identical no-blackboard path is the load-bearing invariant.** With `bb` null, the build
  call passes `undefined`, the guarded spread collapses to `{}`, and the report has no `rounds` key;
  the `if (bb)` synthesis gate means no `fleet-synthesis.json` is written. Do not pass `rounds`
  unconditionally — it must stay gated on the blackboard branch (criterion sc-1-6, evaluator-flagged
  CRITICAL).
- **`roundsRun` counts the terminating round, not "productive" rounds.** A final round that adds
  zero new findings still counts (the loop ran it before the `break`). This was an explicit non-goal:
  do not change it to count only productive rounds.
- **Scope.** Commit `5a4d6b7`: `src/fleet/coordinator.ts`, `src/fleet/index.ts`,
  `src/fleet/reporter.ts` (+ their three collocated tests). `synthesis.ts`, `SharedBlackboard`, the
  `config.fleet` / manifest schema, the blackboard CLI, and the early-stop / rounds-cap logic were
  all out of scope and untouched. Full suite **2789 passed**, fleet **276/276** (only the 6
  pre-existing cockpit-integration MCP failures remain); all 7 criteria (sc-1-1..sc-1-7) passed
  iteration 1, no regression.
