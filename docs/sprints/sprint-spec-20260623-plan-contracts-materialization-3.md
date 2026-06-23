# Scope sprint to the active spec with clarification guard

**Contract:** sprint-spec-20260623-plan-contracts-materialization-3  ·  **Spec:** spec-20260623-plan-contracts-materialization  ·  **Completed:** 2026-06-23

## What this sprint added

The third and final sprint of the **3-sprint plan→contracts fix**. It hardens the
`sprint` command (`runSprintCommand`, `src/cli/commands/sprint.ts`) so that the
contracts Sprint 2 now eagerly materializes are consumed **safely** when more than one
plan exists on disk. Three changes, all confined to `runSprintCommand`:

1. **Spec-scoped contract selection.** `listContracts` is now filtered to
   `c.specId === spec.specId` (the latest spec from `loadLatestSpec`) **before**
   `findNextPendingSprint`, so stale contracts from *other* specs can no longer be
   executed against the active plan.
2. **Needs-clarification guard.** If the latest spec's `status === "needs-clarification"`,
   the command prints the open clarification questions and the correct
   `plan answer` resolution hint, then **returns before invoking the generator**.
3. **Improved empty-contracts message.** When no contract matches the active spec, the
   error now points at `plan` (to re-materialize contracts) or `run` (full pipeline)
   instead of the old generic *"Run 'npx agent-bober plan' first."*

The single-spec happy path is **unchanged** — when only one spec's contracts exist, the
filter is a no-op and selection/execution behave exactly as before.

This took **2 iterations**. Iteration 1 (commit `6f4029d`) shipped all three changes but
the refusal hint used `plan-answer` (hyphen) — a command that **does not exist** in the
CLI (the real command is `plan answer`, a space-separated subcommand, per `cli/index.ts`
and `plan.ts`). The evaluator **failed S3-C3** on that bad hint. Iteration 2 (commit
`559025f`) corrected the hint to the runnable
`npx agent-bober plan answer <specId> <questionId> "<answer>"` form (now interpolating the
actual `spec.specId`) and strengthened the S3-C3 test to assert the output contains
`plan answer` and **not** `plan-answer`. Passed 5/5.

## Public surface

No new exported symbols. The surface change is the **behavior of the `npx agent-bober
sprint` CLI command**:

- `npx agent-bober sprint` now selects only the **latest spec's** contracts
  (`sprint.ts:128-130`, filter `c.specId === spec.specId`). Contracts belonging to other
  specs on disk are ignored.
- `npx agent-bober sprint` **refuses** to run when the latest spec is
  `needs-clarification` (`sprint.ts:113-126`): it prints each open question
  (`getOpenClarifications`, imported from `src/contracts/spec.ts:266`) and the hint
  `Answer with 'npx agent-bober plan answer <specId> <questionId> "<answer>"', then re-run.`,
  and invokes **no generator**.
- The empty-contracts error (`sprint.ts:131-137`) now reads *"No sprint contracts found
  for the active plan. Run 'npx agent-bober plan' to (re)materialize contracts, or
  'npx agent-bober run' to execute the full pipeline."*

## How to use / how it fits

With Sprint 2, `plan` materializes a spec's contracts; with Sprint 3, `sprint` only ever
acts on the **active** (latest) plan's contracts and never on a half-specified plan:

```bash
npx agent-bober plan "Add CSV export"   # spec resolves to ready → contracts materialized
npx agent-bober sprint                  # runs only THIS plan's contracts, even if older specs' contracts linger
```

If the latest plan is still blocked on clarification, `sprint` stops and tells you exactly
how to unblock it:

```bash
npx agent-bober sprint
# Plan "<title>" needs clarification before sprints can run.
#   [Q1] Should this include mobile support?
# Answer with 'npx agent-bober plan answer <specId> Q1 "<answer>"', then re-run.
```

## Notes for maintainers

- **The hint string is the load-bearing detail (again).** As in Sprint 2, the iteration-1
  bug was a single hint string: `plan-answer` (hyphen) is not a registered command —
  `plan answer` is a space-separated subcommand. The S3-C3 test now asserts both presence
  of `plan answer` **and** absence of `plan-answer`; keep that assertion if the message is
  ever reworded.
- **The hint interpolates `spec.specId`.** Iteration 2 changed the hint from a static
  string to a template literal that embeds the actual spec id, so the printed command is
  copy-paste runnable.
- **Refusal/empty-message routing.** The clarification *header* and the empty-contracts
  message go to `logger.error` (stderr); the per-question lines and the resolution hint go
  to `logger.info` (stdout). The S3-C3 test spies on **both** `console.error` and
  `console.log` for this reason.
- **Single-spec flow is provably unchanged.** The `c.specId === spec.specId` filter is a
  no-op when only one spec's contracts exist (S3-C5 happy-path test). This sprint adds
  **no** multi-spec parallel execution and **no** topological `dependsOn` ordering — both
  explicit non-goals.
- **Generator/evaluator behavior untouched.** Only `runSprintCommand`'s pre-loop selection
  and guards changed.
- **Scope.** Two files: `src/cli/commands/sprint.ts` (modified — guard, filter, message;
  new import of `getOpenClarifications`) and `src/cli/commands/sprint.test.ts` (new —
  S3-C2 two-spec filtering, S3-C3 needs-clarification refusal, S3-C4 empty-message, S3-C5
  single-spec happy path; all four mock the generator/evaluator/config/git so no LLM or
  network is touched). Commits `6f4029d` (iter-1) then `559025f` (iter-2). Full suite 2370
  passed / 3 skipped; the 6 pre-existing `tests/e2e/cockpit-integration.test.ts` MCP
  failures are unrelated and not a regression.
