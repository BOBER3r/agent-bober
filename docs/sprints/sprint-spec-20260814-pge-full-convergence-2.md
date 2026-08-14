# `commit` and `finalize` execute for the first time, under a real approval file

**Contract:** sprint-spec-20260814-pge-full-convergence-2  ·  **Spec:** spec-20260814-pge-full-convergence  ·  **Completed:** 2026-08-14

## What this sprint added

`commit` is a `git`-effect node behind a HITL gate. Under the autopilot `noop` mechanism the gate
grants nothing (`src/pge/runtime/interrupt.ts:523` — `if (mechanismName !== "noop") granted.set(key,
outcome);`), so every run this repository has ever recorded ended `commit`'s span
`{ status: "interrupted", errorClass: "FailClosed" }` **before its body was entered**, and
`finalize` — whose only edge in is `commit -> finalize` — was never reached at all.

This sprint gives them a **durable approval path** and executes both. Golden replay cases go
**6 → 7** (dataset 44 total, gate **7/7**); node coverage goes **38/44 → 40/44 (~90.9 %)**, still
above the dataset's own strictly-greater-than-85 % floor without that floor moving.

**The route taken, and the two that were not.** A concurrent approver writes a **real**
temp-plus-rename approval file while the run blocks polling for it — the same pattern
`src/pge/runtime/interrupt.test.ts`'s `startApprover` already uses — and a **run-root-scoped**
`DiskCheckpointMechanism` is swapped into the registry for the duration of one case's run and
restored in a `finally`. Teaching `disk.ts` to honour a pre-existing marker was **rejected**:
`disk.ts` is **byte-untouched**, so its race-safety sweep (`disk.ts:80-83`, which deletes a marker
written up front and then polls) keeps its full meaning.

**The lever is a second config, not an unpinned first one.** `checkpointOverrides['end-of-pipeline']
= 'disk'` arrives through `goldenApprovedConfig()`, a **second code constant** beside
`goldenConfig()`, selected per case. `goldenConfig()` was never unpinned — the contract's stop
condition forbade trading reproducibility for coverage — and the proof is that the **six
pre-existing replay cases re-capture byte-for-byte**. The graph's other HITL gate,
`plan_clarify -> post-plan`, stays on the autopilot default; this sprint's territory is the commit
gate, not every gate.

## The safety story, because `commit` runs `git` for real

Four independent layers keep a golden run away from this checkout. The evaluator verified each,
and the orchestrator confirmed independently — **HEAD unchanged, `git status` empty,
`.bober/approvals` absent from the checkout, every run root under `/var/folders/.../golden-*`**:

1. **Every golden run root is a fresh `mkdtemp` OS temp dir**, never the checkout.
2. **The only `disk` instance a durable-approval run can reach is scoped to that run's own root.**
   The shipped singleton is rooted at `process.cwd()` at module-load time
   (`orchestrator/checkpoints/registry.ts:126-132`) — the real checkout under `vitest`. Swapping it
   is what stops a golden run writing `.bober/approvals/` into this repository, and the swap is
   undone unconditionally in a `finally`. Pinned by a test asserting
   `getCheckpointMechanism("disk")` is the **same reference** before and after, and that
   `.bober/approvals` never appears under `REPO_ROOT`.
3. **A replay's effect registry never calls `inner.invoke`**
   (`src/pge/runtime/replay.ts:368,385-424`) — every effect,
   `git.commit` included, is answered from pre-recorded JSON. That is the path every CI run and
   every gate run takes.
4. **Only the capture step can reach a real effect seam**, and its committer binding is the fixed
   `"0000000"` stub from `whole-graph.ts`, never `commitAll`.

## Fail-closed was not weakened

The evaluator made `interrupt.ts:523`'s grant unconditional and watched **seven pre-existing tests
break** — `commit.test.ts`'s byte-unchanged *"never executes, and creates no git object in a real
repository"*, its documenter sibling, and all five in `interrupt.test.ts`'s *"FAIL CLOSED: git and
deploy are unreachable without a recorded approval (sc-8-7)"* block — then restored the file to an
empty diff.

**Cite the right test.** The new test tagged `sc-2-2`
(`src/pge/nodes/commit.test.ts:484`) does **not** break under that mutation, and its own docstring
says so. It pins the *adjacent* property — **configuring a durable mechanism is not itself an
approval**: with nobody answering, the mechanism times out, `hitl_commit`'s own gate is rejected
(`HitlRejected`, not `FailClosed`), and `commit` is never even admitted, so it opens **no span at
all**. The `FAIL_CLOSED` guard itself is pinned by the untouched pre-existing test.

## Public surface

- **`goldenApprovedConfig()`** (`src/pge/golden/executor.ts:152`) — `goldenConfig()` with
  `end-of-pipeline` routed through the real `disk` mechanism via `checkpointOverrides`. A second
  pinned code constant; reads nothing from the checkout's `bober.config.json`.
- **`GOLDEN_APPROVED_CONFIG_INPUT`** (`:173`) — `{ approved: true }`, the **one** shape
  `assertExecutable` now accepts into `input.config`. Deliberately not `{ autopilot: true }` (the
  shape the 37 `integrity` cases use and the executor still refuses), so "give commit a durable
  approval" cannot be confused with "flip autopilot".
- **`resolveGoldenConfig(configInput)`** (`:188`) — shared by the executor and `capture.ts`, so a
  case's capture and its replay can never resolve to two different configs.
- **`withGoldenApproval(runRoot, needed, fn)`** (`:377`) — swaps the registered `disk` mechanism
  for a `runRoot`-scoped instance, runs `fn` with an auto-approver polling every 5 ms, and restores
  the original instance in a `finally`. A **no-op when `needed` is false**, so the autopilot path
  never touches the registry.
- **`.bober/golden/replay-full-run-commit-approved.json`** — the seventh replay case. Same scenario
  as `replay-full-run-evaluation-passes`, executed under the approved config.
- **`NEVER_EXECUTED`** (`src/pge/golden/coverage.test.ts:143`) — now
  `["context_compact", "critique", "rework_route", "synthesize"]`. The two-directional
  mutation-proof block is **byte-for-byte untouched** and still passes.
  *(Historical, as of this sprint. Sprint 8 shrank the list again, to
  `["context_compact", "synthesize"]`, and moved the count to 42/44 — `critique` and
  `rework_route` left it together, since `critique`'s sole successor edge IS `rework_route`.
  See `sprint-spec-20260814-pge-full-convergence-8.md`.)*
- **`describe("the commit node behind a DURABLE disk approval, not a scripted one")`**
  (`src/pge/nodes/commit.test.ts:442`) — two node-level tests using the real, unmodified
  `DiskCheckpointMechanism` against a real `.bober/approvals/` under the test's own temp root.
  The file also gained `beforeEach`/`afterEach` hygiene restoring the registered `disk` mechanism,
  which the pre-existing `scriptApproval` tests never did.

## Blast radius, measured rather than eyeballed

Against `replay-full-run-evaluation-passes`, a programmatic recursive JSON diff found **exactly
four** differences, all direct consequences of the two newly-executing nodes:

| field | before | after |
| --- | --- | --- |
| `expected.terminalNodeId` | `graceful_failure` | `finalize` |
| `audits` | `noop` / `noop`, second carrying the `FAIL_CLOSED:` feedback | `disk` / `disk` / `noop`, all `approved` |
| `pipelineResult[0].errors` | present (`FailClosed` on `commit`) | **absent** |
| tail `pinnedResponses` entry | `graceful_failure` / `run.gracefulFailure` | `commit` / `git.commit` |

`completionMarker`, `history`, `contracts`, `specs`, `progress`, `runState`, `briefings`,
`reviews` and `evalResults` are byte-identical, and `pipelineResult[0].success` is still `true` —
**Option A stays frozen**, as `nonGoals` required. A full `GOLDEN_CAPTURE=1` re-run afterwards left
`git diff .bober/golden/` empty: all seven cases reproduce byte-for-byte.

## Notes for maintainers

- **A pre-existing defect is now VISIBLE in a committed fixture, deliberately unfixed.** The new
  case's audit trail reads `disk`, `disk`, **`noop`**. `finalizePipelineRun` asks `end-of-pipeline`
  a third time independently and labels it from `config.pipeline?.checkpointMechanism ?? "noop"`
  (`src/orchestrator/finalize.ts:220-221`), which **ignores `checkpointOverrides`** — so the label
  disagrees with the mechanism that actually answered. The evaluator confirmed `audits[2]` is
  byte-identical in both cases, so the asymmetry is genuinely pre-existing and not introduced here.
  Fixing it would move a committed fixture; it was left for a sprint that owns it.
- **Coverage moved because the count moved, not because the rule did.** Sprint 9 of
  `spec-20260812-pge-real-workload-errors` corrected the *rule* (a node counts only with a
  `status: "ok"` span, 39→38); this sprint gave `commit` an actual `"ok"` span, 38→40. Its
  two-directional pin exists precisely so a node *leaving* `NEVER_EXECUTED` also fails — and it
  caught nothing here only because the deletion was deliberate and the accompanying claims were
  deleted with it.
- **`reached` and `executed` remain different assertions.** `commit` was reached by four of the
  then-six replay cases long before any of them executed it.
- **If you add another approved case**, opt in with `input.config: { approved: true }` and nothing
  else — `assertExecutable` refuses any other key by design, and both capture and replay must go
  through `resolveGoldenConfig` or the two will silently diverge.
- Passed **iteration 1**, all 6 of 6 required criteria, every gate re-run against a clean detached
  worktree of `275f074`: suite **466 files / 7057 passed, 6 skipped, 0 failed**; typecheck (both
  tsconfigs), lint (0 errors, 2 pre-existing warnings) and build green; golden gate **7/7 (100 %)**
  with HEAD unchanged and `git status` empty afterwards. Commits `7237c56`, `275f074`.
