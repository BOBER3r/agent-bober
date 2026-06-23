# Embedded-sprint materialization and eager wiring into plan

**Contract:** sprint-spec-20260623-plan-contracts-materialization-2  ·  **Spec:** spec-20260623-plan-contracts-materialization  ·  **Completed:** 2026-06-23

## What this sprint added

The second of the **3-sprint plan→contracts fix**, and the one that **closes the original
bug**: standalone `plan` → `sprint` now works end-to-end. Before this sprint `plan` wrote a
spec but **no contract files**, so a subsequent `npx agent-bober sprint` errored with
*"No sprint contracts found"*. Sprint 2 makes the `plan` command **eagerly materialize**
schema-valid sprint contracts (via Sprint 1's `materializeContracts` helper) the moment a
plan resolves to `ready`, so `sprint` finds them immediately.

It does this in two parts. First, `materializeContracts` gains an **embedded branch**: if
`spec.sprints` carries full contract *objects*, each is `safeParse`d against
`SprintContractSchema` and — only if **all** parse — used **verbatim** (status normalized to
`proposed`, `specId` rebound, deterministic `sprint-<specId>-NN` ids); any parse failure or
`saveContract` precision-gate throw triggers a **whole-set fallback** to feature-derived
generation (no throw, no partial mix). Second, all three `plan` entry points
(`runPlanCommand`, `runPlanAnswerCommand`, `runPlanAnswerInteractive`) now **clear-then-
materialize** the current spec's contracts on resolve→`ready`, and their next-step hint was
corrected from `run` to `npx agent-bober sprint` (the command the fresh contracts are for;
`run` re-plans and ignores them).

This took **2 iterations**. Iteration 1 (commit `36de025`) shipped the embedded branch,
`clearContractsForSpec`, and `runPlanCommand` wiring but set the hint to `run` to match the
old `plan answer` hint — the evaluator **failed S2-C6** on hint *semantics* (`run` re-plans
and ignores the just-written contracts; the correct executor is `sprint`). Iteration 2
(commit `bef849e`) fixed all three hints to `sprint` and made the two `plan answer` paths
also materialize on resolve, so the hint is correct *and* consistent everywhere. Passed
6/6.

## Public surface

- `clearContractsForSpec(projectRoot: string, specId: string): Promise<void>`
  (`src/state/sprint-state.ts:163`, re-exported from `src/state/index.ts:9`) — deletes only
  the `.bober/contracts/*.json` files whose parsed `specId` matches; other specs' contracts
  are untouched. Silently tolerates a missing directory, unreadable files, and non-JSON
  files so a partial state never aborts a re-plan. This is what makes re-planning a spec
  idempotent (no stale higher-numbered files left behind).
- `materializeContracts(...)` — **same signature** as Sprint 1, now with an internal
  **embedded branch** preceding the feature-derived branch (`src/orchestrator/contract-materialization.ts:43`).
  When `spec.sprints` is a non-empty array of objects that **all** satisfy
  `SprintContractSchema`, those entries are used verbatim (status→`proposed`, `specId`
  rebound, `sprintNumber = i+1`, id = `sprint-<specId>-NN`); otherwise it falls back to the
  Sprint-1 feature-derived path. No new exported symbol — the surface change is the new
  branch behavior.
- `npx agent-bober plan "<feature>"` — now **writes contract files** as a side effect of a
  ready plan (previously wrote only the spec). The printed next-step hint is now
  `npx agent-bober sprint` (`src/cli/commands/plan.ts:178`).
- `npx agent-bober plan answer <specId> [...]` (and the interactive resolution path) — now
  **materialize contracts** when the final clarification resolves the spec to `ready`, then
  print the `npx agent-bober sprint` hint (`plan.ts:307`, `plan.ts:394`).

## How to use / how it fits

The standalone manual flow now functions without the full `run` pipeline:

```bash
npx agent-bober plan "Add CSV export to the users table page"
# → writes .bober/specs/<specId>.json AND .bober/contracts/sprint-<specId>-NN.json
# → prints: Next: npx agent-bober sprint
npx agent-bober sprint   # now finds the contracts (no more "No sprint contracts found")
```

If the plan needs clarification, contracts are **not** written yet (the
`needs-clarification` branch is skipped); they are materialized when the last answer
promotes the spec to `ready`:

```bash
npx agent-bober plan answer <specId> <questionId> "my answer"
# → on resolve→ready: clears + materializes contracts, prints: Next: npx agent-bober sprint
```

Inside `runPlanCommand` the wiring is two lines after `printPlan`, guarded to the
non-clarification branch:

```ts
await clearContractsForSpec(projectRoot, spec.specId);
await materializeContracts(spec, projectRoot, config);
```

In the two `plan answer` paths the same pair runs inside a `try/catch` that logs a warning
and continues (materialization failure is **non-fatal** there — the spec is already
resolved on disk).

## Notes for maintainers

- **The embedded branch does not fire for bober-authored specs.** Real bober specs store
  `spec.sprints` as an array of **contractId strings** (e.g.
  `"sprint-spec-20260623-plan-contracts-materialization-1"`), which `safeParse`-**reject** —
  so they fall through to the feature-derived branch. The embedded branch is for
  external/OpenAI-planner specs that emit full sprint **objects**. Both paths produce
  schema-valid, deterministically-id'd contracts.
- **Whole-set fallback, never a partial mix.** If even one embedded entry fails parse (or
  the precision gate throws during `saveContract`), the **entire** spec falls back to
  feature-derived generation, keeping a single id scheme per spec. This is intentional (see
  the contract's `assumptions`).
- **Hint semantics are the load-bearing detail.** Iteration 1's bug was *only* the hint
  string: `run` re-plans (it calls `runPlanner` again) and ignores the just-written
  contracts, whereas `sprint` consumes them. All three hints now say
  `npx agent-bober sprint`; keep them consistent if any plan path is refactored. The
  iteration-1 test passed because it only asserted string *presence*, not semantics — the
  evaluator caught the gap.
- **`plan answer` materialization is non-fatal by design.** It is wrapped in `try/catch`
  with a logged warning; the spec resolution is the primary effect and a contracts failure
  must not abort the resolve. `runPlanCommand` does **not** wrap it (a fresh-plan failure
  should surface).
- **This sprint does not change the `sprint` command.** Scoping the `sprint` command to the
  active spec and adding a clarification guard is **Sprint 3** (the contract's `nonGoals` /
  `outOfScope`). Do not document a spec-scoped `sprint` selector as shipped yet.
- **Scope.** Iter-1 (`36de025`): `contract-materialization.ts` (embedded branch),
  `sprint-state.ts` + `state/index.ts` (`clearContractsForSpec`), `plan.ts` (wiring +
  hint), plus tests. Iter-2 (`bef849e`): `plan.ts` (hint→`sprint`, materialize on
  `plan answer` resolve) + tests. No production code outside `src/orchestrator/`,
  `src/state/`, and `src/cli/commands/plan.ts`. Full suite 2366 passed / 3 skipped; the 6
  pre-existing `tests/e2e/cockpit-integration.test.ts` MCP failures are unrelated and not a
  regression.
