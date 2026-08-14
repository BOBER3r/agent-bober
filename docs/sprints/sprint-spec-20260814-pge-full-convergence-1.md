# The fan-out checkpoint question is answered — the rule stands, and `audits` shrinks its own goal

**Contract:** sprint-spec-20260814-pge-full-convergence-1  ·  **Spec:** spec-20260814-pge-full-convergence  ·  **Completed:** 2026-08-14

## What this sprint added

**No executable behaviour.** `git diff` over `.bober/topology/`, `coding.graph.ts`,
`interrupt.ts`, `checkpointer.ts` and `interpreter.ts` is **empty**; the one production edit is a
message string. What moved is a **decision**, and with it one of this spec's own goals.

The spec needs five of the imperative pipeline's checkpoint ids declared on nodes inside the
sprint fan-out region, where `InterruptInsideFanOut` (`src/pge/topology/validate.ts:1093`) is a
BLOCKING validation error by ADR-6. The sprint reopened that ADR and concluded **the rule
stands** — which the contract's own `stopConditions[0]` named in advance as a legitimate outcome,
and which the record should read as the answer it is rather than as a failure to move it.

**Why the revisit was licensed at all.** ADR-6 never argued the fan-out clause was *unsound*. Its
stated hazard is double execution under restart-from-top resume — an argument about *where* an
interrupt fires, not about whether a fan-out branch may host one — and its Option C Pros column
calls the clause merely unnecessary: *"per-branch approvals batch naturally at the fan-in
barrier."* That narrower claim is the gap this sprint filled.

**The soundness argument the new ADR supplies comes from the runtime, not from the validator.**
Three facts, each read from source rather than inferred:

1. `Checkpoint.interrupt` is one `InterruptRecord | null` (`src/pge/runtime/checkpointer.ts:247`)
   — nowhere to hold N concurrent pauses.
2. `grantScope` carries no branch key (`src/pge/runtime/interrupt.ts:268`) and `clearScope`
   deletes every key sharing its prefix before a fresh pass asks (`:371-375`, called at `:485`),
   so a sibling branch's arrival **evicts an already-granted branch's approval**. Pre-existing,
   unmodified `interrupt.test.ts:794` pins that eviction as *intended* for the single-scope case;
   per-branch fan-out is the identical eviction one level down.
3. `resumeMessageId` is `hitl:<checkpointId>` with no branch key (`:332`) and its consumer matches
   by node id alone (`src/pge/nodes/plan.ts:142-144`), so **N branch decisions collapse onto one
   message row**.

The resulting defect is concurrency-dependent — serialized at cap 1 a grant may be consumed
before a sibling clears it, concurrent at cap 8 it is not (`frontier.ts:13,29-32`) — which
collides directly with this graph's byte-identical-at-cap-1-and-8 determinism criterion.

**ADR-6 also carried a factual error, now corrected.** Its Consequences state `hitl_commit` *"sits
at the fan-in barrier"*. False for the shipped artifact: `hitl_commit`'s only inbound edge is
`e-doc-approval` from `documenter`, outside the region. `reduce_sprints` — the artifact's actual
named barrier — is itself **inside** the fan-out region, and could not have hosted a HITL node
under ADR-6's own rule either.

## The consequence, recorded rather than absorbed

Five of the six undeclared checkpoint ids (`pre-curator`, `pre-generator`, `pre-evaluator`,
`pre-code-reviewer`, `post-sprint`) are `subgraph: "sprint"` nodes and stay **permanently
undeclarable**. Only the sixth, out-of-region id remains open to a later sprint. So `audits` joins
`history` as **recommended for permanent acceptance** — now with a runtime-verified reason rather
than an unrevisited rule behind it — and the spec's own `feat-1` and `feat-3` were amended in the
same commit to say so, including their acceptance criteria. The validator was **not** weakened to
make sprint 3 easier, which is what the contract's stop condition forbade.

## A mid-sprint correction worth carrying forward

The evaluator's one medium finding asserted that `reduce_sprints` "genuinely executes ONCE per
fan-out episode" via the interpreter's JOIN logic, and therefore that a HITL placed there would
escape blockers (1)-(3). The generator disputed it, and the orchestrator verified directly that
**the generator was right**: `leavingFanOut` (`src/pge/runtime/interpreter.ts:1485-1488`) requires
the destination to be *outside* the region, and `reduce_sprints` is inside it — so a task routed
there falls through to the default `enqueue` (`:1501-1510`) with its `branchKey` **preserved**, and
`reduce_sprints` executes **once per branch**. The one-task-per-join-target behaviour at
`:1565-1579` fires for `reduce_sprints`'s own destination, `supervisor`, not for `reduce_sprints`.

The evaluator's premise was wrong and its critique was still right: the ADR *had* conflated the
validator's coarse `fanOutRegion` reachability test with the runtime reason. Commit `b42af01`
separates them — the interpreter's per-branch dispatch is now the controlling ground, with the
validator's region test named as *consistent with* it rather than identical to it. Decision
unchanged.

## Public surface

- **`.bober/architecture/arch-20260814-pge-full-convergence-adr-1.md`** — the new ADR, all six
  fields, amending `arch-20260805-pge-graph-engineering-adr-6` (which gained a cross-referencing
  **Amendment (2026-08-14)** line). Its **Risk** field states the falsifiable condition: give
  `Checkpoint.interrupt` a keyed slot and `grantScope`/`resumeMessageId` a branch discriminator,
  and this decision must be revisited.
- **`InterruptInsideFanOut`'s diagnostic message** (`src/pge/topology/validate.ts:1093`) — now
  names the reason and the remedy ("Move the interrupt to a node reachable only after the fan-out
  has joined") and cites the ADR by id. **The code, the `severity: "error"`, and the set of legal
  topologies are unchanged.**
- **`describe("InterruptInsideFanOut")`** (`src/pge/topology/validate.test.ts:799`) — the rule's
  first dedicated test. Pins both directions: HITL on `sprint_generate` (verified `subgraph:
  "sprint"`, reachable only via fanout edges) is still rejected *and* now names the reason; HITL on
  `supervisor` (verified reachable without any fanout edge) validates clean.
- **`assertAdrRecordsFanOutDecision(adr)`** (`src/pge/topology/validate.test.ts:838`) — reads the
  ADR **from disk** and pins its content across 10 tests, 8 of them "FAILS when X is edited out"
  negative controls. **No test in this repository read a real `.bober/architecture/*.md` file
  before this sprint.**
- **`assertFlipPrerequisitesStated`** (`src/pge/topology/docs.test.ts:949`) — extended so
  `docs/pge-graph.md` must carry both the sprint-1 ADR citation and the runtime-grounded reason
  (`Checkpoint.interrupt`), with two new gutted controls.
- **[`docs/pge-graph.md` § Engine migration disposition](../pge-graph.md#engine-migration-disposition)**
  (point 1) — restates `audits`' disposition with the revisit, the three runtime blockers, and the
  ADR-6 correction.

## How it fits

Nothing calls any of this at runtime. The effect on a maintainer is a **closed question**: if you
are about to declare a `hitl` checkpoint on a node inside the sprint region, the validator will
now tell you why it refuses and where to put it instead, and the ADR tells you what would have to
change in the runtime for the answer to be different.

## Notes for maintainers

- **`audits` is not "still open work" any more.** Treat a proposal to close it as a proposal to
  change `Checkpoint.interrupt`, `grantScope` and `resumeMessageId` first — that is the ADR's Risk
  field, and it is deliberately falsifiable.
- **sc-1-4 was judged on intent, and the generator disclosed why.** The criterion asks for "a
  topology that is now legal" — which presumes the ADR concludes *yes*. Under the verified-correct
  *no*, no topology can move illegal→legal, so the "still legal" test pins the ADR-affirmed-sound
  shape (HITL at the join) that was already legal under ADR-6. Reverting `validate.ts` leaves that
  test passing and breaks only the "still forbidden" one — the generator surfaced this rather than
  constructing an artificial newly-legal shape. The evaluator also filed a planner-facing note:
  **an ADR-revisit contract should phrase both-directions criteria outcome-neutrally**, since this
  one's own `stopConditions[0]` anticipated the answer its `successCriteria` could not express.
- **Sprint 3 was read but deliberately not edited.** Its own `sc-3-1`/`sc-3-4`/`stopConditions[0]`
  already hedge for this outcome. It should declare the one out-of-region id, name the other five
  as undeclarable citing this ADR, and treat `sc-3-4` as met only in the amended sense.
- **The load-bearing claim was reproduced by the evaluator, not trusted.** Reverting *only* the
  `validate.ts` message string in an isolated worktree broke **exactly one** test, with 180 others
  unaffected. All three runtime facts were re-read line by line against source.
- Passed **iteration 1**, all 6 of 6 required criteria, verified in an isolated clean worktree
  that reproduced the generator's numbers exactly: suite **466 files / 7048 passed, 6 skipped, 0
  failed** at `b6ef959` and **7054 passed, 2 skipped** after `b42af01`; typecheck (both tsconfigs),
  lint (0 errors, 2 pre-existing warnings) and build green; golden gate **6/6**, unaffected because
  the topology diff is zero-line. Commits `b6ef959`, `b42af01`.
