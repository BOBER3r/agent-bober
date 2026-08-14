# `synthesize` is the FOURTH structural limit — `rework_route` reconfirmed, coverage stays 42/44, and nothing that runs changed

**Contract:** sprint-spec-20260814-pge-full-convergence-9  ·  **Spec:** spec-20260814-pge-full-convergence  ·  **Completed:** 2026-08-14

**Evaluation:** PASSED at iteration 1, **5 of 5 required criteria — one of them `pass-AMENDED`**
(`.bober/eval-results/eval-sprint-spec-20260814-pge-full-convergence-9-1.json`). `sc-9-2`
("a golden case drives `synthesize` to execution") was honestly NOT met and is recorded as a
**structural finding**, on the authority of the contract's own stop condition: *"A node is
genuinely unreachable in the committed topology — that is a topology finding worth more than
the coverage number; record it."* `sc-9-3` and `sc-9-4` were already known unsatisfiable as
literally written before implementation began — the orchestrator's `preFlightFinding` on this
contract says so, citing sprint 8's `context_compact` finding — and were met against the
amended form. Commit `afe67e6`.

## What this sprint added

**A test file, and nothing that runs.** `git diff --stat acb512f..afe67e6` touches exactly
three paths: `src/pge/nodes/root.test.ts` (**new**, 343 lines), `src/pge/golden/coverage.test.ts`
(doc-comment lines only) and `docs/pge-graph.md`. No production `.ts`, no topology, no golden
case, no `package.json`. Node coverage is **42 / 44 before and after** — unchanged, and not
expected to change.

What it actually delivers is the thing sprint 8 left owing: the `synthesize` entry in
`NEVER_EXECUTED` was **prose only**, unlike its neighbour `context_compact`, whose claim
`nodes/supervisor.test.ts` backs with a test. `src/pge/nodes/root.test.ts` now backs it the
same way, in four `CLAIM` blocks that go red the moment any supporting fact stops being true.

- **`sc-9-1` was reconfirmed, not rebuilt.** `rework_route` began executing at sprint 8 —
  forced by topology, because `critique`'s sole successor edge IS `rework_route` — and the
  contract's `preFlightFinding` said so ahead of implementation. Confirmed still true on the
  working tree AND on a clean detached worktree at `afe67e6`: neither `critique` nor
  `rework_route` appears in `NEVER_EXECUTED`, so both have at least one `status: "ok"` span.
- **`sc-9-2` was genuinely investigated before being accepted as blocked.** It was not
  inherited from sprint 8's finding by assumption. The evaluator attacked **seven** distinct
  paths to `synthesize` and found none.
- **`sc-9-3`/`sc-9-4` were met against the amended bar:** `NEVER_EXECUTED` holds only the two
  structurally-proven entries, each now claim-tested; coverage is computed against the topology
  ARTIFACT (`.bober/topology/coding.json`, read in `beforeAll`, `coverage.test.ts:248-251`),
  not a hardcoded count. The guard was **not** deleted to make the criterion true.

## Why `synthesize` is unreachable — two independent proof chains

`synthesize` has exactly one edge in: `route_after_eval --partial--> synthesize`. `evalRouterNode`
selects `"partial"` only when `reworkRoundsTaken(spec, state) >= maxIterations`, the declared
bound of **2**. Both chains below prove that bound is never reached inside a single run — from
different code, through different mechanisms.

### Chain A — the supervisor's dispatch order (ENCODED as tests)

1. `supervisorNode` never selects its `"evaluate"` label while `dispatchableContracts(state,
   state.sprintContracts)` is non-empty: `nodes/supervisor.ts:165` checks `SPRINTS_LABEL`
   **strictly before** `EVALUATE_LABEL`. So the only state `evaluate_global` can ever be
   dispatched from is one in which every planned contract has already settled `"succeeded"`.
2. `evaluate_global`, `route_after_eval` and `critique` — the whole path between that dispatch
   and `rework_route`'s own run — declare writes of exactly `["messages","evaluations","ledger"]`,
   `["counters"]` and `["messages","ledger"]`. **None touches `sprintContracts` or
   `branchStatus`**, read off the committed artifact rather than the implementation. So the
   state step 1 establishes is EXACTLY what `rework_route` inspects.
3. `reworkRouterNode`, given that state, always selects `"exhausted"` — never its own `"rework"`
   fan-out, the one edge that could loop back to `evaluate_global` a second time — because its
   dispatch set is empty.
4. Therefore `route_after_eval` is invoked at most once per run, and its
   `reworkRoundsTaken >= maxIterations` branch is dead by construction.

This chain is what `src/pge/nodes/root.test.ts`'s four `CLAIM` blocks encode, one per step.

### Chain B — `reduce_sprints`' refusal (ARGUED, **not encoded as a test**)

The evaluator found a **second, independent barrier** that the generator's own doc comments
cite but that **nothing in the suite asserts**:

- `reduceSprintsGate` (`src/pge/nodes/gates.ts:1001-1028`) refuses — routing back to
  `fanout_sprints`, **not** to `supervisor` — whenever ANY `branchStatus` entry is `"failed"`
  or `"abandoned"`, and its own `fanoutRetries` budget (`coding.graph.ts:791`,
  `maxIterations: 2`, `onExhausted: "graceful_failure"`) degrades straight to
  `graceful_failure` once exhausted.
- `sprint_exit` is the **only** node that writes a new terminal `branchStatus`
  (`src/pge/nodes/sprint-review.ts`).
- `"abandoned"` is grep-verified as **never written** by any production `.ts` — every
  occurrence in non-test source is a read or a filter (`sprint-fanout.ts:61`, `gates.ts:1009`,
  the `BRANCH_STATES` vocabulary at `state/overall.ts:172`).

Together: **every branch is provably `"succeeded"` by the time a run can reach `evaluate_global`
at all.** A run that still had a bad branch never gets past the join; it is re-fanned-out twice
and then ends at `graceful_failure`. So `rework_route`'s dispatch set is empty on its one
reachable invocation for a second, independent reason, and the `"partial"` branch is dead
twice over.

> **Gap worth naming:** chain B is argued from source and grep, and it is written down here and
> in `docs/pge-graph.md` — but it is **not backed by a test**. The four `CLAIM` tests cover
> chain A only. If `reduce_sprints`' refusal predicate were relaxed, or a production writer
> began setting `"abandoned"`, chain B would silently stop holding and no test would report it.
> Chain A would still hold, so the `NEVER_EXECUTED` entry would remain correct — which is
> exactly why the silence is easy to miss. Encoding chain B (a gate-predicate claim test beside
> the existing ones, plus a source scan for `"abandoned"` writers) is the obvious follow-up.

### The apparent contradiction, reconciled

`CLAIM 3`'s negative control shows `reworkRouterNode` **can** select `"rework"` and fan out,
given a state with a `"failed"` `branchStatus` entry. That does not contradict the finding:
chain B proves that exact state can never arise **at `rework_route`**. The router's own code is
correct and its branch is live; the STATE is what rules it out, not a missing branch in the
node's body.

### Two things checked so nobody re-checks them

- **`maxIterations = 2` is a fixed topology constant** (`coding.graph.ts:872`), **not** a
  `bober.config.json` knob — and moot either way, since the block is upstream of the loop bound
  entirely. Turning it down to 1 would not help.
- **The contrivance was rejected, and the evaluator upheld the rejection as correct rather
  than as avoidable work.** Seeding a case to force `counters.reworkRounds = 2` would technically
  produce an `"ok"` span for `synthesize` — and would encode a state the shipped interpreter can
  never produce, proving nothing about the shipped runtime. `CLAIM 4`'s injected states are
  labelled `SYNTHETIC STATE (not claimed reachable)` in the test names themselves and are used
  only to prove `evalRouterNode`'s own `"partial"`/`"exhausted"` logic is right — a materially
  different, and more honest, claim than reachability.

**This is what makes `synthesize`'s block a different KIND from `context_compact`'s**, even
though both sit in the same list: `context_compact`'s label-selection code **does not exist at
all**; `synthesize`'s does, correctly, and is simply never fed the precondition it is written to
react to. The precondition is unreachable, not the code.

## Four structural limits now stand in this spec

`docs/pge-graph.md`'s table (in "How much of the graph the committed cases execute") grows from
three rows to four. Read together they are one kind of finding, not four setbacks:

| where | limit | cost to close |
| --- | --- | --- |
| sprint 1/3 → ADR-1 | `audits` — five checkpoint ids permanently undeclarable | a keyed, branch-aware interrupt slot plus branch discriminators through the resume path — a runtime redesign |
| sprint 6 | `pipelineResult.errors` — no imperative write site for a FAIL_CLOSED refusal | giving the imperative engine a checkpoint-gated commit — an architecture change |
| sprint 8 | `context_compact` unreachable — no handler path returns `COMPACT_LABEL` | a topology reads-list change + a minor `graphVersion` bump + new handler logic |
| sprint 9 | `synthesize` unreachable — the `"partial"` precondition cannot arise | production changes to the supervisor's dispatch order or to `reduce_sprints`' refusal — i.e. changing how the graph decides, not what a case supplies |

Each was established by RUNNING or reading the shipped system; each was RECORDED rather than
worked around, on the authority of the owning contract's stop condition; each has a named,
non-trivial cost in **shipped production code** that no case, binding, seed or fixture can
substitute for; and in each the implementation was right while the CONTRACT's premise was
wrong — which is why all four carry an `amendedDisposition` rather than a retry. Four of them
says something about how this spec was scoped: it assumed missing WRITERS and missing CASES
everywhere, and in four places the answer was a missing capability.

## What sprint 11 inherits

- **`sc-9-3` and `sc-9-4` are CLOSED** against their amended form — `NEVER_EXECUTED` holds
  only structurally-proven entries, both claim-tested; coverage asserted against the artifact
  at 42/44. Sprint 11 does not need to re-open them.
- **`sc-11-1` ("the harness reports `equivalent: true`") is UNSATISFIABLE BY BUILDING.** With
  four structural limits confirmed, no amount of further implementation makes it true: the
  conformance divergence set is `["audits", "pipelineResult"]`, both entries architectural and
  both tracing to one root cause (the graph has a checkpoint-gated commit the imperative engine
  lacks). The orchestrator has recorded the amendment intent on sprint 11's contract under
  `pendingAmendment`; this record states the consequence so the final sprint has it in writing.
  **The satisfiable work is the re-specification** — `sc-11-3`/`sc-11-5`: state plainly which
  fields did not converge and why, and re-specify the bar around a named, accepted,
  individually-justified exception set rather than around emptiness.
- **Do not read 42/44 as a shortfall to be closed.** `44/44` is not reachable and
  `NEVER_EXECUTED` will not empty. Anything that appears to make either true without the
  production changes named in the table above should be treated as a contrivance and rejected.

## Files touched

- `src/pge/nodes/root.test.ts` — **new**, 343 lines. A `CLAIM BACKING:` header block restating
  the claim and its four pieces, a throwing-collaborator `rootContext` in the
  `gates.test.ts` / `supervisor.test.ts` house style, then `CLAIM 1` (supervisor dispatch order,
  two cases), `CLAIM 2` (artifact `writes` of the three intervening nodes), `CLAIM 3`
  (`reworkRouterNode` selects `"exhausted"`, plus the negative control) and `CLAIM 4`
  (`evalRouterNode`'s `"partial"`/`"exhausted"` branches against explicitly-labelled synthetic
  state).
- `src/pge/golden/coverage.test.ts` — doc-comment lines only; the `synthesize` bullet gains the
  second-code-path derivation and the pointer to `root.test.ts`. `NEVER_EXECUTED` itself is
  byte-identical: `["context_compact", "synthesize"]`.
- `docs/pge-graph.md` *(generator)* — the `synthesize` table row records the sprint-9
  re-derivation; the inherit-consequences paragraph moves to past tense; a "Sprint 9's own
  outcome" paragraph is added, and the engine-migration disposition records `sc-9-3`/`sc-9-4`
  as closed.
- `docs/pge-graph.md` *(documentation commit)* — the structural-limits table extended from
  three rows to four; chain B written down with its "not encoded as a test" gap named; the
  sprint-11 consequence stated as unsatisfiable-by-building.
- `docs/sprints/README.md` — spec paragraph updated to four findings, new table row *(documentation commit)*.
- **This record** — new *(documentation commit)*.

## Notes for maintainers

- **`NEVER_EXECUTED` is a list of claims, not a to-do list**, and the pin is two-directional: a
  node that starts executing while still listed fails the test just as a node that stops
  executing does. If `root.test.ts`'s `CLAIM` tests ever go red, the `synthesize` entry must be
  deleted **deliberately in the same change**, not patched around.
- **The guard was proven to bite by mutation, not by assertion.** Four separate mutations of
  REAL production code, each confirmed red and then reverted — including reverting
  `supervisor.ts:165`'s dispatch-order guard (`CLAIM 1`) and disabling `reworkRouterNode`'s own
  `"exhausted"` branch (`CLAIM 3`). Separately, the evaluator reproduced the `evaluatorNotes`
  instruction directly: it removed the committed golden case driving `critique`/`rework_route`
  in a scratch edit and re-ran `coverage.test.ts`, and the **real production guard**
  (`:272-275`, not the local `missingAgainst` helper sprint 8's audit flagged) reported
  `missing = ['context_compact','critique','rework_route','synthesize']` with the ratio check
  failing (`expected 42, got 40`). Restored, 11/11 green.
- **Chain B is the one soft spot in this record.** See the gap note above — it is load-bearing
  for the finding and currently exists only in prose and in the eval result.
- **Gate, as run:** clean detached worktree at `afe67e6` with a fresh `npm ci` — **468 files /
  7114 passed / 6 skipped / 0 failed**; `typecheck` and `typecheck:tests` clean; `lint` 0 errors
  and 2 pre-existing warnings; `build` clean; golden gate **8/8 (100 %)**. The generator's and
  the evaluator's numbers match exactly. Run the suite as
  `npx vitest run --exclude '**/.claude/worktrees/**' --exclude '**/node_modules/**'` — a bare
  run picks up nested worktrees.
