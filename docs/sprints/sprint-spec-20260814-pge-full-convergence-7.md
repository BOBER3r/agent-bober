# The dead `"passed"` comparisons are retired — `verdictFrom`'s downgrade paths are reachable again

**Contract:** sprint-spec-20260814-pge-full-convergence-7  ·  **Spec:** spec-20260814-pge-full-convergence

## What this sprint added

`verdictFrom` (`src/pge/runtime/interpreter.ts`) computes a graph run's reported verdict from
the count of `state.sprintContracts` entries that have settled. Before this sprint that count
was the literal `c.status === "passed"` — a word neither engine's settled-sprint writer
produces (`sprint_exit` in `sprint-review.ts` and `runSprintCycle` in `pipeline.ts` both write
`"completed"`), so the count was structurally **zero** for every run, ever, on either engine.
Three of `verdictFrom`'s five branches were consequently unreachable: a declared `"failed"`
never softened to `"partial"` even when branches had settled; a declared `"success"` with
recorded failures could only downgrade to `"failed"`, never `"partial"`; and the no-declared-
verdict fallback could never report `"success"` or `"partial"`, only `"failed"`.
`src/pge/runtime/commit.ts:539`'s completed/failed split carried the identical literal, guarded
only by an `OR` with `succeededBranches` that (as its own removed rationale block argued at
length) made the literal appear moot — until `isSettledContractStatus` is what actually
decides a `"completed"` contract with no `branchStatus` row at all, a case the OR alone cannot
catch.

Both sites now read `isSettledContractStatus(c.status)` (`src/contracts/sprint-contract.ts`),
the same predicate `state/history.ts`'s "Passed" row and `pipeline.ts`'s completed/failed split
already use. This is a **strict widening**: `SETTLED_CONTRACT_STATUSES = {"passed",
"completed"}`, so every contract the old literal counted is still counted, and only
`"completed"` — the word every real writer produces — joins it. A widening cannot flip a
verdict toward more severity; it can only make a downgrade fire that previously could not.

## Proving reachability by execution, not by reading (sc-7-2)

`src/pge/runtime/__tests__/partial-failure.test.ts` already had a test exercising branch B
(`state.verdict === "failed" && passed > 0` → `"partial"`) — but it passed today only because
the golden fixture's `gate_sprint_out` node body writes the RETIRED literal `"passed"`
(`golden-graph.ts:868-886`), not because the migration this sprint makes was live. A new test,
`downgrades a run that ENDED at the failure terminal, when branches settled 'completed' rather
than 'passed' (sc-7-2)`, overrides that one node via `GoldenBehaviour.handlerOverrides` to write
the production word `"completed"` instead, without touching the fixture body itself, then
asserts the reported verdict is `"partial"`.

**A real subtlety surfaced while writing this test, not in `verdictFrom` but in the fixture's
own channel-join tie-break.** `sprintContracts` resolves a same-key conflict by
`versionRank(candidate, incumbent)` — `(version, updatedAt, canonicalJson(value))`, in that
order. Neither the seeded contract nor the shipped `gate_sprint_out` body sets `version`, so
both rank `0`, `updatedAt` ties on the golden harness's fixed clock, and the join falls through
to a `canonicalJson` STRING comparison. The shipped body's settled write wins that tie only
because `"passed"` sorts lexicographically after `"in-progress"` (`p > i`); `"completed"` sorts
*before* it (`c < i`), so a naive override that wrote `"completed"` without also setting
`version` would silently **lose** the tie to the seeded copy — the contract would never settle,
and the test would fail for the wrong reason (`expected [] to have a length of 2 but got +0`,
observed directly while writing this test). The fix mirrors what a real settled write does:
`sprint_exit` (`sprint-review.ts:297`) always sets `version: attempts` (`Math.max(1, ...)`,
always ≥ 1), which reliably outranks the seed's implicit `0` regardless of the status word's
alphabetics. The test's override does the same (`version: 1`), with a comment explaining why —
a version-less override is not a bug in `verdictFrom`, but it would have been a silent,
misleading bug in the test.

**MUTATION VERIFIED**, per the sprint-5 (`23a1718`) precedent: run against the pre-migration
counter (`c.status === "passed"`), the test fails —
`AssertionError: expected 'failed' to be 'partial'`, `passed` stays `0` because the override
never writes the literal `"passed"`, guard B never fires, and branch C returns the terminal's
declared `"failed"` verbatim. Migrating the counter to `isSettledContractStatus` (which
`"completed"` satisfies) makes `passed = 2`, fires guard B, and the assertion passes. A
mirrored negative control (same scenario, exhausted before any branch settles) still returns
`"failed"` under both counters, confirming the migration is discriminating, not universally
true.

## Allowlist (sc-7-3)

`src/contracts/status-vocabulary.invariant.test.ts`'s `ALLOWLIST` loses the two entries these
sites occupied (`interpreter.ts:728`, `commit.ts:539`, by their pre-migration line numbers) — a
stale entry fails the scan's own bidirectional check (`"every ALLOWLIST entry corresponds to a
REAL, currently-matching offender"`), so removal is mandatory the moment the site no longer
matches `OFFENDER_PATTERN`. Both files also join the positive-evidence "migrated readers" test,
renamed from "the six migrated readers" to "the eight migrated readers" (`src/mcp/tools/
sprint.ts`, `eval.ts`, `src/cli/commands/sprint.ts`, `eval.ts`, `resume-cursor.ts`,
`pipeline.ts`, plus the two new ones), which asserts both `findOffenders([...]) === []` and
`content.toContain("isSettledContractStatus")` per file. The §3 header prose and two stale
`path:line` citations (`sprint-review.ts:208→290`, the pipeline.ts:1052 historical reference)
were corrected in the same change. All ten tests in the file pass, in both directions.

## Golden recapture (sc-7-4) — the curator's prediction, checked

`GOLDEN_CAPTURE=1 npx vitest run src/pge/golden/capture.test.ts`, then `git diff --stat
.bober/golden/`: **empty**, exactly as predicted. Two facts explain why real verdict movement
and zero golden movement are both true: `verdict` is not one of `CONFORMANCE_FIELDS`
(`src/orchestrator/workflow/types.ts`) and `PgeEngine.run` never reads `result.verdict`
(`src/pge/engine/pge-engine.ts`), so no committed `.bober/golden/` case carries it at all; and
`commit.ts`'s completed/failed split was already decided by `branchStatus` for every case in
which `sprint_exit` ran, since it writes a `succeeded` branch row and a settled contract status
in the same update. A re-run without the capture flag reproduced byte-identical output,
confirming determinism.

**One committed artifact outside `.bober/golden/` DOES capture `verdict`, and it moved.**
`.bober/topology/measurements/real-workload.json` (`src/pge/engine/real-workload.test.ts`,
from `spec-20260812-pge-real-workload-errors`) reads the interpreter's own
`GraphRunResult.verdict` directly (sc-1-3 of that spec: "the terminal node and the run verdict,
read off the INTERPRETER's own `GraphRunResult`, never off the `PipelineResult`"), and running
`npx vitest run --exclude '**/.claude/worktrees/**' --exclude '**/node_modules/**'` before
re-capturing it showed exactly one failing assertion: `expected '...verdict":
"failed"...' to be '...verdict": "partial"...'`. Read against the stop condition — "if making
the counter live changes a golden case's verdict in a way that looks WRONG rather than merely
different, STOP and understand it before re-capturing" — this movement is understood and is
NOT wrong: the same file's own pinned assertions (unaffected by this sprint, still passing)
establish that all 14 dispatched branches settle `"succeeded"` on the first attempt and the
ONLY recorded `TaskFailure` is the already-documented `commit` node's `FailClosed` refusal
(architectural, `arch-20260814-pge-full-convergence-adr-1`). A run whose work landed but whose
final commit was gated is exactly what `"partial"` means; reporting it `"failed"` was the
under-report this sprint exists to fix. Re-captured via `MEASURE_REAL_WORKLOAD=1 npx vitest run
src/pge/engine/real-workload.test.ts`; the diff touches exactly the `"verdict"` line and
nothing else, and the file's own reproducibility test (two independent runs compared to each
other, not to the committed file) still passes.

`src/orchestrator/workflow/conformance.engines.test.ts` was re-run: the divergence set pin is
unchanged, `["audits", "pipelineResult"]`, `equivalent: false` — `verdict` is not a conformance
field, so this sprint does not move it, confirmed by execution rather than assumed.

## Files touched

- `src/pge/runtime/interpreter.ts` — `verdictFrom`'s counter migrated to
  `isSettledContractStatus`; value import added.
- `src/pge/runtime/commit.ts` — the completed/failed split predicate migrated to the same
  function; value import added alongside the existing type import; the stale rationale block
  arguing against the migration rewritten to describe what the migration actually does and why
  the branch-status OR still matters as a fallback.
- `src/pge/runtime/__tests__/partial-failure.test.ts` — two new tests (sc-7-2 positive +
  mirrored negative control) plus a shared `settleAsCompleted` override helper.
- `src/contracts/status-vocabulary.invariant.test.ts` — two ALLOWLIST entries removed; the
  "migrated readers" test extended from six files to eight and renamed; §3 header prose and two
  stale citations corrected.
- `.bober/topology/measurements/real-workload.json` — re-captured; `verdict` moves from
  `"failed"` to `"partial"`, nothing else.
- `docs/pge-graph.md` — the "one graph-runtime reader was deliberately NOT migrated" bullet
  rewritten to record the sprint 7 closure (both sites, the sc-7-2 execution proof, the golden
  and real-workload recapture outcomes); the sprint-6 "two carried-forward facts" closing
  paragraph corrected — the `verdictFrom` half is now closed, the `flusher.ts:76` half is
  unchanged and still true.
- `docs/sprints/README.md` — new table row for this sprint.
- **This record** — new.

## Notes for maintainers

- **The migration is a strict widening, provably so, not merely argued.** `SETTLED_CONTRACT_
  STATUSES = {"passed", "completed"}` (`src/contracts/sprint-contract.ts`) is a superset of
  `{"passed"}`; nothing counted before stops being counted, so no branch of `verdictFrom` can
  move toward a MORE severe verdict as a consequence of this change.
- **`src/orchestrator/workflow/flusher.ts:76` remains the one known, documented, deliberately
  out-of-scope sibling.** It compares a LOCAL variable the same function just computed from a
  write (`contractStatus`, whose ternary can only ever produce `"completed"`, `"needs-rework"`
  or `"failed"` — never `"passed"`), invisible to the scan by construction because the pattern
  is keyed on the `.status` member-access spelling. `estimatedFiles` for this sprint did not
  name it; it stays untouched.
- **`src/pge/nodes/sprint-curate.ts`, `sprint-generate.ts`, `documenter.ts` remain
  allowlisted.** They are PGE NODE bodies, not runtime, outside this sprint's
  `estimatedFiles`; a future sprint's territory.
- Full gate, re-run on this checkout: suite (`npx vitest run --exclude
  '**/.claude/worktrees/**' --exclude '**/node_modules/**'`) **467 files / 7106 passed, 2
  skipped, 0 failed**; typecheck (both tsconfigs), lint (0 errors, 2 pre-existing warnings in
  `eval-persist.test.ts`), build green; golden gate **7/7 (100%)**, `.bober/golden/` diff empty
  before and after a full `GOLDEN_CAPTURE=1` re-run.
