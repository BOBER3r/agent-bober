# One settled-status predicate, and the MCP sprint tools work again

**Contract:** sprint-spec-20260812-terminal-vocabulary-1  ·  **Spec:** spec-20260812-terminal-vocabulary  ·  **Completed:** 2026-08-12

## What this sprint added

Two engines pick different words out of `ContractStatusSchema` for the same outcome —
`runSprintCycle` writes `"passed"`, PGE's `sprint_review` writes `"completed"`
(`src/pge/nodes/sprint-review.ts:203`, pinned by
`src/orchestrator/workflow/conformance.engines.test.ts:397-398`) — and five production readers
each hardcoded **one** of the two: four in the sprint history they hand the generator and the
evaluator, a fifth in `.bober/progress.md`'s **"Passed"** row. All five picked `"passed"`, and a
sixth reader spelled both words out inline. Against this repository's own contract corpus, which
holds **zero** contracts with that literal status, all five therefore counted nothing. This sprint
gives the vocabulary **one definition site** and migrates every reader to it, then pins the live
bug closed with a test that drives the real corpus.

**No writer changed.** Nothing decides a different outcome than it did before; what changed is
which words the readers accept. The conformance divergence set is therefore **unmoved** — that is
sprints 3 and 5 (see [Notes for maintainers](#notes-for-maintainers)).

## Public surface

One definition site, `src/contracts/sprint-contract.ts`, exposing **two** predicates over one
shared set. Both are re-exported from the package root (`src/index.ts:31-36`).

- **`SETTLED_CONTRACT_STATUSES`** (`src/contracts/sprint-contract.ts:69`) — `{passed, completed}`.
- **`TERMINAL_CONTRACT_STATUSES`** (`src/contracts/sprint-contract.ts:84`) —
  `{passed, failed, completed}`, spelled `new Set([...SETTLED_CONTRACT_STATUSES, "failed"])` so
  the two sets are **derived, not parallel**, and cannot silently diverge.
- **`isSettledContractStatus(status): boolean`** (`src/contracts/sprint-contract.ts:101`) —
  *"this sprint finished successfully; you do not need to redo it."* The reading every
  successful-history filter wants.
- **`isTerminalContractStatus(status): boolean`** (`src/contracts/sprint-contract.ts:116`) —
  *"this sprint has stopped, success or not."* The reading `updateContractStatus` wants when it
  decides whether to stamp `completedAt`.

The distinction is load-bearing, not stylistic: **a failed sprint is terminal but not settled.**
Picking the wrong one is a real bug in both directions, and both directions are pinned —

| Claim | The test that fails when it stops being true |
|---|---|
| The two sets are exactly `{passed, completed}` and `{passed, failed, completed}`, and terminal is a **strict superset** of settled by exactly one member | `src/contracts/sprint-contract.test.ts` — *"SETTLED_CONTRACT_STATUSES is exactly …"*, *"TERMINAL… is exactly …"*, *"TERMINAL… is a strict superset …"* |
| Every one of the **nine** `ContractStatusSchema` members is partitioned deliberately — a tenth status added to the enum fails loudly rather than defaulting to "not settled" | `src/contracts/sprint-contract.test.ts` — *"partitions every member of ContractStatusSchema exactly as expected"* (asserts the enum still has 9 members as its own liveness control) |
| `updateContractStatus` stamps `completedAt` for exactly the terminal set — i.e. the inline rule it replaced moved with **no observable behaviour change**, and cannot drift back | `src/contracts/sprint-contract.test.ts` — *"agrees with isTerminalContractStatus for every status"* |

### The six migrated readers

All six previously spelled the rule out themselves; all six now call `isSettledContractStatus`.

| Reader | What it feeds |
|---|---|
| `src/mcp/tools/sprint.ts:147` | `completedContracts` → the generator handoff's `sprintHistory` for the `bober_sprint` MCP tool |
| `src/mcp/tools/eval.ts:140` | the same list for `bober_eval` |
| `src/cli/commands/sprint.ts:160` | the same list for the `bober sprint` CLI |
| `src/cli/commands/eval.ts:128` | the same list for the `bober eval` CLI |
| `src/state/history.ts:198` | the **"Passed"** row of `.bober/progress.md` |
| `src/orchestrator/workflow/resume-cursor.ts:23` | `ResumeCursor.completedSprintNumbers` — the sprints a resumed run skips |

`src/state/history.ts:199` — the **"Failed"** row — is deliberately left as a literal
`c.status === "failed"`, and is allowlisted with that reason. Folding it into the settled
predicate would double-count every failed sprint in `progress.md`.

## The live bug this closed

`bober_sprint` and `bober_eval` both built their `completedContracts` list with
`c.status === "passed"`. The evaluator counted this repository's `.bober/contracts/` corpus
independently at the time of the sprint: **256 contracts — 218 `completed`, 33 `proposed`, 4
`pending`, 1 `in-progress`, and 0 `passed`.** Both tools therefore handed the generator and the
evaluator an **empty sprint history** on every invocation, silently. (The four `pending` files
carry a status that is not a member of `ContractStatusSchema` at all — a separate defect, and
sprint 2's job.)

Pinned by **`src/mcp/tools/sprint-corpus.test.ts`**, which drives `listContracts(REPO_ROOT)` —
the exact function both tools call (`sprint.ts:115`, `eval.ts:81`) — against the **real committed
corpus**, not a fixture:

- the settled list is **non-empty** (this is the assertion that was false before the sprint);
- it agrees with an independently written `passed || completed` computation, rather than a
  hardcoded count, so sprint 2's corpus migration cannot break it;
- the corpus really does contain **zero** `"passed"` contracts — the root cause, pinned as a fact;
- each migrated reader's source no longer contains the bare `"passed"` literal.

Both MCP tool handlers run real generator/evaluator agents end to end and cannot be invoked from a
unit test, so the pin is on the data path plus the call sites rather than on a mocked handler.

## The rule that stops a sixth reader reintroducing it

**`src/contracts/status-vocabulary.invariant.test.ts`** walks every production `.ts` file under
`src/` (200+ files, with a liveness control asserting the walk happened) and reports any
`<expr>.status === "passed"|"completed"|"failed"` comparison — in either operand order — outside
the predicate.

It is deliberately a **text scan, not a type**: `ContractStatus` is a plain string union, and
nothing in the type system distinguishes a contract-terminal check from `RunState.status`,
`FlatTest.status`, `ChildOutcome.status` or a Jest `assertionResults[].status`, all of which spell
the identical idiom by coincidence. Those sites are therefore **allowlisted with the type that
makes each one not a contract check** — 16 entries as committed — and the allowlist is enforced
in **both** directions: an entry with a reason shorter than 20 characters fails, a duplicate
location fails, and a **stale** entry — one whose line no longer matches — fails too, so an
allowlist cannot quietly stop checking anything.

Five mutation controls guard the scan itself: two prove it bites (a synthetic sixth reader, the
reversed literal-first form) and three prove it does not over-fire (comment lines, non-terminal
literals such as `"in-progress"`, and a bare local-variable comparison with no `.status`
accessor). All five run `findOffenders()` — a pure function over in-memory sources — so no
scratch file is ever written under `src/`.

## Notes for maintainers

- **Which predicate you want is a real decision, so make it deliberately.** `isSettled…` for
  "successful history" reads; `isTerminal…` for "is this over" reads. The split is not cosmetic:
  the pre-existing `src/orchestrator/workflow/resume-cursor.test.ts:77-93` asserts that a
  `failed` contract is **excluded** from `completedSprintNumbers`, so a failed-inclusive predicate
  there would be a live bug. The evaluator upheld the split as technically necessary rather than
  as an evasion of the contract's "a single exported predicate" wording, and asked that later
  sprints not re-assume one flat predicate.
- **Seven contract-status literal sites are deferred, not missed.** Each is allowlisted with a
  per-entry reason and a `file:line`: `src/orchestrator/pipeline.ts:1052`,
  `src/pge/runtime/interpreter.ts:728`, `src/pge/runtime/commit.ts:531`,
  `src/pge/nodes/sprint-curate.ts:254`, `src/pge/nodes/sprint-generate.ts:133`,
  `src/pge/nodes/documenter.ts:83`, and `src/state/history.ts:199`. Migrating the first six would
  touch writers and PGE runtime verdict math, which this sprint promised not to do.
- **`src/pge/runtime/interpreter.ts:728` is a live instance of the same bug class, still open.**
  `verdictFrom` counts `state.sprintContracts` entries whose status is the literal `"passed"`,
  and a PGE run never writes that word — see
  [`docs/pge-graph.md` § Engine migration disposition → The evidence](../pge-graph.md#the-evidence)
  for what that
  costs and why fixing the literal alone would not be enough. Flagged to the planner by the
  generator.
- **Three further sites are outside the scan's pattern *by design*, and the test says so with a
  worked example each.** `src/orchestrator/workflow/flusher.ts:76` compares a local variable the
  same function just computed from a **write**; `src/pge/nodes/sprint-review.ts:203` is a writer
  whose only `===` is against `"succeeded"`; `src/fleet/aggregator.ts:8-9` compares a bare
  parameter with no `.status` accessor (and is a `RunState`, not a contract).
- **Verified untouched:** `src/mcp/tools/status.ts:69`, `src/evaluators/builtin/playwright.ts:530`,
  `src/fleet/reporter.ts` and `src/do-bridge/reconcile.ts` — the over-reach failure mode this
  sprint was warned about. The evaluator confirmed zero diff overlap with all four.
- Passed **iteration 1**, all 5 of 5 required criteria. Suite **459 files / 6926 tests passed, 2
  skipped, 0 failed**; typecheck (both tsconfigs), lint, and build green; golden gate **6/6**
  (threshold >80%), independently re-run. The evaluator re-derived the corpus counts with its own
  script and mutation-tested the scan's regex against seven novel synthetic cases. Commits
  `7af1119`, `f07d3f3`.
- **Known flake, unrelated:** the generator saw one `ENOTEMPTY` tmpdir-cleanup race in
  `run-manager.test.ts` during a full-suite run; it passed 40/40 in isolation and did not
  reproduce for the evaluator. `run-manager.ts` is untouched by this sprint.
