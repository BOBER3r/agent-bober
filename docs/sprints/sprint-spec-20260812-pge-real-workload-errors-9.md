# Node coverage counts a node only when it actually ran

**Contract:** sprint-spec-20260812-pge-real-workload-errors-9  ·  **Spec:** spec-20260812-pge-real-workload-errors  ·  **Completed:** 2026-08-12

## What this sprint added

Nothing executable — **no runtime behaviour, no topology, no public API moved.** `pge diff` is
empty at `graphVersion 1.4.0` and the golden gate is 6/6. What moved is the meaning of a number
this document set has quoted for three specs.

`src/pge/golden/coverage.test.ts` read `nodeId` off every span in a replay run's trace and added
it to the executed set **with no check of that span's `status`**. A node that opens a span and is
then refused, interrupted, skipped or fails therefore counted as covered. `commit` is exactly such
a node — refused `FAIL_CLOSED` under the autopilot `noop` mechanism before its body is ever
entered — so the committed figure counted it on the strength of a span that recorded a *refusal*.
The rule now requires **at least one span with `status: "ok"`**, and the figure is restated:

> **38 of the 44 declared nodes execute.** The previous figure was **39 of 44**. The drop is a
> correction, not a regression — the old rule counted reached-but-refused nodes as covered.

`38 / 44 ≈ 86.4 %` still clears the dataset's own floor of *strictly greater than 85 %* without
that floor moving. NFR0 forbids lowering a gate to protect a number, and this sprint did not need
to.

## Two corrections the sprint made by measuring rather than by carrying wording forward

**1. `commit`'s span status is `"interrupted"`, not `"failed"`.** The contract's own VERIFIED
assumption said *"a node whose only span ended `failed`"*. The generator measured instead of
transcribing: `InterruptController` raises `GraphInterrupted` for the git effect before the node
body runs, and the interpreter ends the span
`{ status: "interrupted", errorClass: "FailClosed" }` (`src/pge/runtime/interpreter.ts:1183-1188`).
The evaluator re-ran the real executor and confirmed it on `commit`'s four spans. A rule that had
special-cased `"failed"` would have left `commit` miscounted, which is why the corrected rule
allow-lists `"ok"` rather than deny-listing failure — and why one of the new mutation tests pins
`"interrupted"` separately from `"failed"`.

**2. `synthesize`'s recorded reason was wrong, and so was its proposed replacement.** The
committed comment grouped `synthesize` with `critique` and `rework_route` under *"no case reaches
`evaluate_global` with a non-pass verdict"*. Sprint 7's evaluator proposed a different reason —
*"`rework_route`'s dispatch set is always empty because nothing ever writes `abandoned`"*. Neither
survived being traced. The mechanism, established independently by the generator and by the
evaluator through `nodes/gates.ts`, `nodes/sprint-fanout.ts`, `nodes/supervisor.ts`, the committed
artifact and `runtime/interpreter.ts`:

- `reduce_sprints` refuses to admit a run into evaluation while **any** branch is
  `failed`/`abandoned` — it re-dispatches through `fanout_sprints` instead, bounded by
  `fanoutRetries` — so `evaluate_global` is reached only once **every** branch has settled
  `"succeeded"`.
- `dispatchableContracts` excludes `"succeeded"` branches, so by the time `rework_route` can run
  at all its dispatch set is **always empty**. It therefore never selects its own `"rework"`
  fan-out — the one edge that loops back and returns to `evaluate_global` — and exits to
  `graceful_failure` on its first and only invocation per run.
- `reworkRounds` can therefore reach at most 1, never the declared bound of 2, so
  `route_after_eval` is invoked **at most once** and its `partial` label (the only edge into
  `synthesize`) is **dead code by construction**.

The sprint-7 theory had the right conclusion and the wrong mechanism: `"abandoned"` is never
written anywhere in `src/pge/nodes` — the evaluator confirmed that too — but it is beside the
point, because the exclusion that actually bites is `"succeeded"`.

**3. Two entries were never structural blocks at all.** The file's blanket claim that *every*
`NEVER_EXECUTED` entry is a structural block was already false for `critique` and `rework_route`
before this sprint. Both are closable by a **missing scenario**: a branch that needed one
correction round, which `gradeContracts` grades a permanent `fail` even after a later `pass`,
would drive `evaluate_global` to a non-pass verdict with every branch nonetheless `"succeeded"`.
Writing that case is out of scope here (nonGoal 1), so the claim was corrected in place rather
than by adding a case. The evaluator recorded that as the right call.

## Public surface

- **`executedNodeIdsFromSpans(spans)`** (`src/pge/golden/coverage.test.ts:183`) — newly exported
  and pure: parsed spans in, node ids out, admitting a `nodeId` only when that span's `status` is
  `"ok"`. `executedNodeIds` (the real-executor path) now delegates to it, so the pin and the
  mutation proofs exercise the same function rather than two copies of one rule.
- **`NEVER_EXECUTED`** (`src/pge/golden/coverage.test.ts:139`) — six entries, up from five:
  `commit`, `context_compact`, `critique`, `finalize`, `rework_route`, `synthesize`. Each entry
  is a **claim** about why the node does not execute, and the pin is two-directional in the exact
  sense that a claim which stops being true fails the build.
- **`describe("the status-ok rule, mutated in both directions")`**
  (`src/pge/golden/coverage.test.ts:286`) — five new tests proving the rule bites both ways
  against synthetic spans, independent of whichever statuses today's six cases happen to produce.
- **[`docs/pge-graph.md` § How much of the graph the committed cases execute](../pge-graph.md#how-much-of-the-graph-the-committed-cases-execute)**
  — restates 38 of 44, records the previous 39, and says plainly that the previous rule counted
  reached-but-refused nodes as covered. Each `NEVER_EXECUTED` row is reproduced there with its
  re-verified reason and its structural-block-vs-missing-scenario classification.

## How it fits

Nothing calls this at runtime; it is a gate. `npx vitest run src/pge/golden/coverage.test.ts`
drives every committed `replay` case through the real golden executor into a temp run root, reads
the span files back, and pins the executed set against the committed artifact's declared node
list. Three assertions guard three different failure modes: the set equality against
`NEVER_EXECUTED`, the ratio floor that stops the list being grown to absorb a shrinking dataset,
and a named-anchor check that each region of the graph is still entered.

The distinction the sprint introduces is the one to carry forward when reading any coverage claim
about this graph: **reached** and **executed** are different assertions, and only the second one
is evidence the node's body ran.

## Notes for maintainers

- **`commit` is REACHED by four of the six `replay` cases and executed by none.** The `hitl_commit`
  gate admits all of them; the refusal happens after the span opens. If you are looking for
  evidence that the commit path works, this dataset does not contain any.
- **The pin was mutated in both directions on the real file, not only on the synthetic block.**
  The evaluator dropped the status check (5 tests failed, including the executor-driven pin) and
  separately removed `commit` from `NEVER_EXECUTED` (2 failed, `expected 39 to be 38`), then
  restored the file byte-identically. It also re-derived 38 of 44 with its own executor script
  rather than trusting the test's own arithmetic.
- **What would move these numbers.** `commit` and `finalize` need a **durable checkpoint
  mechanism** — the golden executor pins one config on purpose, so no case can close them.
  `critique` and `rework_route` need a **new golden case** (a corrected-but-recorded-`fail`
  sprint alongside an otherwise passing run). `context_compact` needs the `supervisor.reads`
  artifact drift resolved. `synthesize` needs a graph change; no case can reach it.
- **Do not treat a falling coverage figure as a regression without reading the rule.** This one
  fell because the rule stopped over-counting. The two-directional pin exists precisely so the
  number and the explanations move together and deliberately.
- Passed **iteration 1**, all 6 of 6 required criteria. Suite **6902 passed / 2 skipped / 0
  failed** (6897 + 5 new mutation tests); typecheck (both tsconfigs), lint (0 errors, 2
  pre-existing warnings), and build green; five `pge` gates green, `pge diff` empty at `1.4.0`,
  golden 6/6. Commit `146a24c`.
