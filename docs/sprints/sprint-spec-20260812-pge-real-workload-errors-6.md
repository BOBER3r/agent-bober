# An operator can see the refusal

**Contract:** sprint-spec-20260812-pge-real-workload-errors-6  ·  **Spec:** spec-20260812-pge-real-workload-errors  ·  **Completed:** 2026-08-12

## What this sprint added

**An error channel nobody surfaces closes nothing.** Sprint 5 gave `PipelineResult` an
`errors?: readonly PipelineFailure[]` array and deliberately stopped there — a human running
`bober run` against a refused run still saw exactly what they saw before. This sprint puts that
channel in the two places a person or a CI job actually encounters it: **`bober run` now sets
`process.exitCode = 1` and prints a `Refused:` block naming each failure's `nodeId` and
`errorClass`**, and the **MCP run manager resolves such a run to `RunState.status = "failed"` with
`RunState.error` populated** instead of the pre-existing unconditional `"completed"`.

**No schema change was needed, and none was made.** `RunState` already declared
`status: "running" | "completed" | "failed" | "aborted" | "input-required" | "paused"` and
`error?: string` (`src/mcp/run-manager.ts:39`, `:46`); the sprint follows the existing assignment
sites rather than adding fields, which was an explicit nonGoal. The CLI side likewise adds a
branch beside the pre-existing `!result.success` check instead of restructuring it.

## Why the change is strictly additive — structurally, not merely tested

`sc-6-4` asked that a run with no errors keep today's exit code and today's run state *exactly*.
Both sides are additive by construction, and the construction is worth recording because it is
what makes the tests' claim durable rather than incidental:

- **The exit code cannot be fought over.** `src/cli/commands/run.ts` has exactly **four**
  `process.exitCode` sites — `:152` (unknown `--approve-gates` name), `:242` (the pre-existing
  `!result.success` check), `:251` (this sprint's new branch) and `:271` (the `catch`) — and every
  one of them only ever **writes `1`**. Nothing in the file resets it to `0`. So the new branch and
  the `!result.success` branch cannot disagree regardless of evaluation order: the exit-1 set is
  the *union* of their conditions, and a run that satisfies neither never touches
  `process.exitCode` at all, keeping Node's default `0`.
- **Nothing can overwrite `failed` back to `completed`.** After this sprint
  `src/mcp/run-manager.ts` contains exactly **one** `s.status = "completed"` assignment (`:232`),
  and it is the `else` arm of the new branch itself. The two other `"failed"` assignments are on
  paths this sprint did not touch — the promise `.catch` arm (`:257`, a rejected pipeline) and
  `RunManager.load`'s crash reconciliation (`:287`, a `running` state found on disk) — and neither
  runs after the resolve branch on the same run.

## Public surface

- **`bober run` exit code** (`src/cli/commands/run.ts:250-261`) — a resolved `PipelineResult`
  carrying a non-empty `errors` array now exits **non-zero (`1`)**, *even though `success` is still
  `true` under the Option A formula*. This is observable CLI behaviour: a CI job wrapping
  `bober run` fails on a fail-closed refusal where it previously passed.
- **The `Refused:` block** (`src/cli/commands/run.ts:252-259`) — printed after the existing summary
  and "Failed sprints" output, one entry per `PipelineFailure`:

  ```text
  Refused:
    x commit (FailClosed)
        FAIL_CLOSED: node "commit" declares effects (git) ...
  ```

  It names *what* was refused — the `nodeId` and the `errorClass`, then the message — which is the
  bar `sc-6-2` set; a generic "run failed" line would have failed the criterion.
- **`RunState.status = "failed"` + `RunState.error`** (`src/mcp/run-manager.ts:227-233`) — the
  resolve handler in `RunManager.startRun` branches on `errors !== undefined && errors.length > 0`.
  Everything else about the completion path is unchanged: `completedAt`, `result` and `progress`
  are still written from the same values, and the state is still persisted through the same
  fire-and-forget `writeRunState`.
- **`describeRefusal(errors: readonly PipelineFailure[]): string`**
  (`src/mcp/run-manager.ts:91`) — module-internal renderer for the single-line `RunState.error`
  string: `` `${nodeId} (${errorClass}): ${message}` `` per entry, joined with `"; "`. Not exported;
  `PipelineFailure` is imported **type-only**, so the module gains no runtime coupling to
  `src/orchestrator/pipeline.ts`.

## How to use / how it fits

Nothing to configure — both surfaces are unconditional on the presence of `errors`, and only
`PgeEngine.run` ever populates that key (sprint 5), so a default `"ts"`-engine run is byte-for-byte
unaffected.

```bash
bober run "..."          # a fail-closed `commit` refusal now prints `Refused:` and exits 1
echo $?                  # → 1
```

Over MCP, `bober_get_run_status` returns the full `RunState`, so a poller sees
`status: "failed"` and the `error` string without any client change; `bober_list_active_runs`
reads the same in-memory map. The persisted `.bober/runs/<runId>/state.json` carries the same two
fields, so a consumer reading the file rather than the tool sees the refusal too.

## The gap this sprint deliberately does NOT close

**`success` is still `true` for a refused run.** That is Option A, decided in this spec's
`resolvedClarifications` D3 and unchanged here — `deriveRunSuccess` stays sprint-split based and
shared with the imperative engine, so a `FAIL_CLOSED` refusal of the git-effect `commit` node is
not a failed *sprint* and does not move `success`. Concretely, after this sprint a refused MCP run
carries `status: "failed"` **next to** `result.success: true` in the very same `RunState` — and
that disagreement is *pinned by a test* ("leaves `result.success` untouched — Option A, `success`
and the failed status can disagree"), not tolerated by accident.

So: an operator now sees the refusal, and a CI job now fails on it. **A programmatic caller that
reads `success` alone is still told the wrong thing.** Making `success` false is Option B, and it
belongs to the later decision that re-specifies the conformance bar — not to this spec. Sprint 6
did not close it and should not be read as having done so.

## Notes for maintainers

- **Check `errors`, not `success`.** The caller contract from sprint 5 is unchanged and is now the
  contract the CLI and MCP layers themselves obey. Any new consumer of `PipelineResult` should
  follow them.
- **A clean run carries no `errors` key at all** (conditional spread, sprint 5), so both new
  branches test *presence and length*, never truthiness of an `undefined`. Dedicated absent-key and
  empty-array tests exist on both sides for exactly this reason.
- **Carried forward, not introduced here:** the generator reported an `ENOTEMPTY` flake in
  `src/mcp/run-manager.test.ts` (the fire-and-forget `writeRunState` racing tmpdir teardown). The
  evaluator could not reproduce it in four runs (one full suite plus three isolated, 40/40 each
  time). This sprint reuses the *same* fire-and-forget shape the `"completed"` path already had, so
  it adds no new hazard; if the flake is real, awaiting the persistence write is a future sprint's
  call.
- **No topology, golden or conformance movement.** This sprint touches no graph structure:
  `graphVersion` stays `1.3.0`, the golden gate stayed 5/5 with the checksum unmoved, and the five
  `pge` gates are green — an expected no-op, since the change is entirely in the CLI and MCP
  presentation layers.
- Passed **iteration 1**: all 5 of 5 required criteria met. Suite **6894 passed / 2 skipped /
  0 failed** (baseline 6883, **+11**, exactly matching the new tests); typecheck (both tsconfigs),
  build and lint (0 errors, 2 pre-existing warnings in an unrelated file) all green. The evaluator
  did not settle for the unit tests: it drove a genuinely **unmocked `PgeEngine`** to a live
  `commit` / `FailClosed` refusal and fed that real result object through the actual
  `runRunCommand` and `RunManager.startRun` paths — observing exit `1`, the literal output
  `Refused: / x commit (FailClosed)`, `status: "failed"`, `error` populated and persisted to disk,
  and the `RunState` key set unchanged at exactly its pre-existing nine. Commit `eaeb766`.
