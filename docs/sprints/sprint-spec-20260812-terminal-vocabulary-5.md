# Both engines write the same word, and contracts converges

**Contract:** sprint-spec-20260812-terminal-vocabulary-5  ·  **Spec:** spec-20260812-terminal-vocabulary  ·  **Completed:** 2026-08-12

## What this sprint changed

One write flipped: `runSprintCycle` (`src/orchestrator/pipeline.ts:589`) now stamps a settled
sprint `"completed"` instead of `"passed"` — the identical word `sprint_review` has always
written (`src/pge/nodes/sprint-review.ts:206-208`, unchanged). Everything else this sprint did
is either a direct consumer of that one write, or a consequence a careless blanket
`"passed"` → `"completed"` replace would have gotten wrong.

**Sites classified, not guessed** (the curator's map, verified before editing):

| Site | Verdict | Why |
|---|---|---|
| `pipeline.ts:589` | **CHANGED** | The write itself. |
| `pipeline.ts:1052` | **CHANGED** | `result.contract.status === "passed"` → `isSettledContractStatus(result.contract.status)`, migrated in the SAME step as :589 so the write and its own reader never went out of sync (deferring this the way sprint 1 deferred it would have landed every passing sprint in `failedSprints`). |
| `flusher.ts:62` | left alone | `sprint.outcome === "passed"` reads `SprintOutcomeKind` (`pure-sprint.ts:25`), not a contract status. |
| `flusher.ts:63` | **CHANGED** | The ternary's `"passed"` branch feeds `updateContractStatus` — a WRITE, same class as `pipeline.ts:589`. |
| `flusher.ts:76` | **CHANGED**, kept as a bare local | `contractStatus === "passed"` → `=== "completed"`, still comparing the LOCAL variable computed two lines above, not a `.status` accessor — this is deliberately invisible to `status-vocabulary.invariant.test.ts`'s scan (its own proof-test at `:343-353` pins why), and rewriting it as `stamped.status === "completed"` would have added an un-allowlisted offender. |
| `interpreter.ts:128,134,140,141` | left alone | All four are `SprintOutcomeKind`, verified end to end via `pure-sprint.ts:25/40` and `workflow/types.ts:41`. No code change in this file. |
| `pipeline.ts:598` (`event: "sprint-passed"`) | left alone | A history event NAME, pinned verbatim at `conformance.engines.test.ts:341-352`. |
| `pipeline.ts:614` (`outcome: "passed"`) | left alone | A telemetry enum (`telemetry/emit.ts:54`). |
| `pge/runtime/commit.ts:539` (was `:533` before this sprint's own prose edit shifted it) | left alone, deliberately | `c.status === "passed" \|\| succeededBranches.has(...)`. Migrating it would change which contracts land in a GRAPH run's `completedSprints`/`failedSprints`, which moves golden cases — exactly sc-5-4's stop condition. Prose above it rewritten to say the comparison is now dead for BOTH engines, not just PGE (see below). |
| `pge/runtime/interpreter.ts:728` (`verdictFrom`) | left alone, deliberately | Same reasoning; allowlist reason unchanged (it already said PGE writes `"completed"` not `"passed"`). |

## The defect the contract did not name, found and fixed: `getStatusIcon`

`src/state/history.ts`'s `getStatusIcon` switched on the bare literal `"passed"` to render
`[PASS]` in `.bober/progress.md`. Once the write flips, every settled sprint would silently
fall through to `default: "[PENDING]"` — a real user-visible regression, and nothing in the
pre-sprint suite caught it (grep for `[PASS]` found only the function itself and two unrelated
boolean-returning CLI flags). Fixed by routing through `isSettledContractStatus` instead of a
literal, exported (was module-private) so the mapping can be pinned directly, and typed on
`ContractStatus` rather than a bare `string`:

```ts
export function getStatusIcon(status: ContractStatus): string {
  if (status === "failed") return "[FAIL]";
  if (status === "in-progress" || status === "evaluating") return "[WIP]";
  if (status === "needs-rework") return "[REWORK]";
  if (isSettledContractStatus(status)) return "[PASS]";
  return "[PENDING]";
}
```

Pinned by six new tests in `src/state/history.test.ts`, the load-bearing one iterating
`SETTLED_CONTRACT_STATUSES` directly rather than hardcoding `"passed"`/`"completed"` — so a
THIRD settled word added to the set in the future without a matching `getStatusIcon` branch
fails this test, which is exactly the shape the pre-sprint bug took (the set grew a member the
icon switch never learned about).

## sc-5-2 — the honest disposition of all four contract deltas

The contract's own text names three deltas (`status`, `evaluatorFeedback`, `generatorNotes`);
the curator's briefing found a fourth (`version`) the contract text omits, and pre-authorized
recording it rather than forcing it closed. Measured by running
`conformance.engines.test.ts` against the two REAL engines, not by reading the pin:

| Delta | Disposition | Why |
|---|---|---|
| `status` | **CLOSED** | Both engines write `"completed"`. Pinned by asserting `tsContract.status` against `pgeContract.status` directly (`conformance.engines.test.ts:417-419`), not against a literal, so the CONVERGENCE is what is pinned, not today's word. |
| `evaluatorFeedback` | **RECORDED, not closed** | PGE has no writer for it anywhere in `src/pge/` — `grep -rn 'evaluatorFeedback' src/pge/` outside tests returns zero hits. Closing it means adding a writer to a PGE node body: a graph-node change, not a vocabulary change, and outside this sprint. |
| `generatorNotes` | **RECORDED, not closed** | Same class as `evaluatorFeedback` — same zero-hit grep, same reasoning. |
| `version` | **RECORDED, not closed** | `sprint_exit` writes a monotone `version: attempts`; `runSprintCycle` writes none. `VOLATILE_KEYS` (`conformance.ts:65-76`) deliberately does NOT include `version` — stripping it would hide a real divergence rather than close one. |

**Therefore `contracts` stays in the pinned four-field divergence set** (`audits`, `contracts`,
`history`, `pipelineResult`) — unchanged, still asserted both directions
(`conformance.engines.test.ts:318-323`) — but the deltas INSIDE `contracts` went from four to
three, and `pipelineResult`'s divergence (a container for `contracts`, per sprint 4) narrowed
identically. This is exactly the contract's own stop condition: *"Closing the status delta does
not close the contracts divergence because another delta remains — that is a finding to
record, not to force."*

## sc-5-3 — the sprint-evaluate.test.ts prose edit

The comment at `sprint-evaluate.test.ts:759-760` ("the contract channel carries the settled
status the imperative pipeline writes") was FALSE before this sprint — `runSprintCycle` wrote
`"passed"`, `sprint_exit` wrote `"completed"`. This sprint makes it literally true for the
first time. Edited deliberately, with the history spelled out inline, and a second assertion
added that ties the PGE write to the shared `SETTLED_CONTRACT_STATUSES` set both engines' code
now shares (`expect(SETTLED_CONTRACT_STATUSES.has("completed")).toBe(true)`), rather than
restating the same literal `persisted` assertion a second time. No assertion VALUE in this file
changed — it still pins the PGE side only, per its own header.

## sc-5-4 — the golden re-capture: exactly the predicted ZERO cases moved

The curator's prediction: golden capture drives a `PgeEngine` only
(`src/pge/golden/capture.ts:110-120`); this sprint changes only `pipeline.ts` and `flusher.ts`
(ts-engine / workflow-engine code), neither of which executes during a capture. Predicted diff:
empty.

Verified by executing the capture, not by assuming: `GOLDEN_CAPTURE=1 npx vitest run
src/pge/golden/capture.test.ts` → **9/9 green**, and `git diff --stat .bober/golden/` →
**empty**. Unlike sprints 3 and 4 (which changed PGE code and each moved the same 5 of 6
replay cases), this sprint moved zero. `node scripts/run-golden-regression.mjs` → **6/6
passed**, dataset unchanged at 43 files (6 replay / 37 integrity).

## sc-5-5 — the replay floor

Replay count stayed at **6**, one above `GOLDEN_MIN_REPLAY_CASES = 5`. No case's `enforcement`
field was touched by this sprint (nothing in this sprint's diff writes to `.bober/golden/`
at all, since the capture produced an empty diff).

## sc-5-6 — the negative controls, and the one reverted to prove it still bites

All golden test files re-ran green: `src/pge/golden/` — **8 files, 147 tests**. Per the
contract's evaluatorNotes, one control was reverted to a form that would produce a false pass,
to prove the current form's strengthening is load-bearing rather than decorative.

**Control reverted:** `executor.test.ts`'s `"exits non-zero when a committed replay case stops
reproducing its expectation"` (the control sprint 8 of `spec-20260812-pge-real-workload-errors`
strengthened from a fixed-count mutation to a `seen % 3` fraction, specifically because a fixed
count silently stops biting once the dataset grows past a threshold). In a **scratch edit,
reverted before commit**: changed the divisor from `% 3` to `% 7` (which drifts 0 of the
current 6 replay cases — `(index+1) % 7` never hits 0 for index in `0..5`), removed the
in-test non-vacuity guard (`expect(drifted.length).toBeGreaterThan(0)`), and changed the final
assertion from `GOLDEN_EXIT.belowThreshold` to `GOLDEN_EXIT.pass`. Result: **the test went
green**, having corrupted nothing and therefore proven nothing — the exact false pass the
fraction-based control exists to prevent. Reverted immediately with `git checkout --`, verified
byte-identical to the committed file (`diff -q` against a pre-edit backup), then re-ran the
real (un-reverted) test: **16/16 green**, the control bites for real again.

## An assertion gap the briefing's worklist did not name, found by running the full suite

`src/orchestrator/workflow/interpreter.test.ts:246` — `expect(byNumber.get(1)).toBe("passed")`
— reads `c.status` off a contract loaded from disk AFTER a real `RunResultFlusher.flush()`
call, inside the "Sprint-3 exit criterion" integration test. The briefing's own site
classification (§7.2) listed this file's line 246 alongside lines 72 and 122 as "outcome, not
status" — that classification was right for 72 and 122 (both genuinely read
`SprintOutcome.outcome`) but wrong for 246, which is a genuine `SprintContract.status` read
through the shipped flusher. Caught by running `src/contracts/ src/orchestrator/ src/mcp/`
before declaring the worklist complete, exactly the discipline the contract's evaluatorNotes
asks for ("verify... not by reading the pin"). Fixed: `"passed"` → `"completed"`, with the
distinction documented inline so the next reader does not repeat the misclassification.

## The two extra ts-side writers, migrated

Beyond `runSprintCycle`, two more ts-side loops write a contract status on a passing
evaluation: `bober_sprint`'s own loop (`src/mcp/tools/sprint.ts:255`) and `bober sprint`'s own
loop (`src/cli/commands/sprint.ts:285`). Neither is a consumer of `runSprintCycle`'s write —
each is an independent writer — so sc-5-1's literal text ("every ts-side consumer of that
write follows") does not strictly reach them. Migrated anyway, and recorded here rather than
left silent, because: the spec's own title is "One terminal vocabulary", sprint 6 (the final
sprint) is docs-only so no later sprint would cover them, and
`src/mcp/tools/sprint-corpus.test.ts` already asserts the real corpus holds zero `"passed"`
contracts — leaving these two writers active would mean the vocabulary the whole spec exists to
unify was still splittable through two live code paths. Both now write `"completed"`, pinned by
two new tests in `sprint-corpus.test.ts` that grep each file's source for the literal
`updateContractStatus(currentContract, "passed")` (absent) and `"completed")` (present).

## Every claim, and the test that fails when it stops being true

| Claim | The test that pins it |
|---|---|
| `runSprintCycle` writes `"completed"`, not `"passed"`, for a settled sprint | `src/orchestrator/pipeline.test.ts` (both `runSprintCycle` assertions) |
| `pipeline.ts:1052`'s split uses `isSettledContractStatus`, and the allowlist no longer covers it | `src/contracts/status-vocabulary.invariant.test.ts`, "the six migrated readers" |
| `flusher.ts` writes and reads `"completed"` for a passed outcome | `src/orchestrator/workflow/flusher.test.ts` (C3, re-flush idempotency, mixed-outcomes) |
| `flusher.ts:76` stays a bare-local comparison invisible to the invariant scan | same invariant test file's dedicated proof-test (unchanged, still passes) |
| `interpreter.ts` needed no code change | `src/orchestrator/workflow/interpreter.test.ts` (outcome-reading tests unchanged) and the flush-integration test (status-reading, now fixed) |
| `getStatusIcon` covers the whole settled vocabulary, not just today's literal | `src/state/history.test.ts`, "sc-5: getStatusIcon covers the settled vocabulary" (6 tests) |
| The `contracts` status delta is closed; the other three are recorded with a reason | `src/orchestrator/workflow/conformance.engines.test.ts` ("3. contracts" section, and the divergence-set pin) |
| `sprint-evaluate.test.ts`'s settled-status comment is now literally true | same file, the added `SETTLED_CONTRACT_STATUSES.has("completed")` assertion |
| Golden capture moves zero cases | `GOLDEN_CAPTURE=1 npx vitest run src/pge/golden/capture.test.ts` + `git diff --stat .bober/golden/` (empty) |
| Golden gate passes at 6/6, 43 total | `node scripts/run-golden-regression.mjs` |
| The two extra ts-side writers no longer write `"passed"` | `src/mcp/tools/sprint-corpus.test.ts`, two new tests |
| `commit.ts:539` and `interpreter.ts:728` stay deliberately unmigrated | `status-vocabulary.invariant.test.ts` allowlist, reasons updated for the line shift and the writer flip |

**(Historical, on the last row above and on the two "left alone, deliberately" rows near the
top of this record: both sites were MIGRATED at sprint 7 of
`spec-20260814-pge-full-convergence` — `interpreter.ts:728` → `:734` and `commit.ts:539` →
`:535`, now `isSettledContractStatus` — and both allowlist entries were removed. The deferral
this record describes ended there; see
[sprint 7's record](./sprint-spec-20260814-pge-full-convergence-7.md).)**

Suite **459 files passed / 1 pre-existing skip (460), 6960 tests passed / 2 skipped (6962), 0
failed** — up from the pre-sprint baseline of 6952 passed by exactly the 8 new test cases this
sprint added (6 in `history.test.ts`, 2 in `sprint-corpus.test.ts`). Typecheck (both
tsconfigs), lint (0 errors, 2 pre-existing warnings in an untouched file), build all green.
Golden gate 6/6. Two transient `ENOTEMPTY`/`ENOSPC` failures were observed during verification
on this machine (a shared dev box under heavy disk pressure — `/System/Volumes/Data` briefly
hit 100% capacity) in `src/mcp/tools/abort-run.test.ts` and `src/mcp/run-manager.test.ts`,
both unrelated to this sprint's code (they exercise run-abort machinery this sprint never
touches) and both confirmed to pass cleanly in isolation once disk pressure eased.

## Notes for maintainers

- **A blanket find-and-replace would have broken this sprint.** The same literal `"passed"`
  spells four unrelated types in this codebase: `ContractStatus`, `SprintOutcomeKind`, a
  history event name, and a telemetry enum. Every site in the table at the top of this doc was
  read before being classified, not pattern-matched.
- **`pge/runtime/commit.ts`'s prose shifted its own pinned offender line from `:533` to
  `:539`** because this sprint's prose edit (explaining the comparison is now dead for both
  engines, not narrower for one) added lines above it. The allowlist entry in
  `status-vocabulary.invariant.test.ts` was updated in the same commit as the prose edit that
  caused the shift — the same discipline sprint 4 established for `reducers.ts`'s line moves.
- **`docs/pge-graph.md`'s "Engine migration disposition" section was rewritten, not appended
  to** — the four bullets describing the `contracts` divergence's history were each updated in
  place to their current, accurate state (status closed; three deltas remain; `verdictFrom`'s
  defect is now dead for both engines) rather than left to describe a pre-sprint-5 world
  alongside a new paragraph contradicting it.
- **What sprint 6 (docs-only per the spec) inherits:** the divergence set is `audits`,
  `contracts` (3 deltas), `history`, `pipelineResult` (mirrors `contracts`) — stable, and not
  expected to move again without a further writer change this spec does not plan to make.
- Passed **iteration 1**, all 7 required criteria, each re-verified by execution: the golden
  capture was run, not assumed empty; the negative control was actually reverted and observed
  to false-pass, then restored and re-verified live; the full suite was run twice (once mid-way
  through the worklist, once at the end) specifically because the first run caught a gap the
  briefing's worklist missed.
