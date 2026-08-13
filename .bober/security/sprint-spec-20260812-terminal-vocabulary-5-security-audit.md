# Security Audit — sprint-spec-20260812-terminal-vocabulary-5

Scope: `git diff e68d3ed..HEAD` (commits ce94992, 0c68422, 2cd3612, 87f23ee, 061ff25, 14efc5f)
Verdict: **PASS** — 0 critical, 0 important, 3 minor (each either conservative in direction or pre-existing).

## The nonGoal held: only the word changed, not the decision

Every new write of `"completed"` sits strictly inside a branch already gated on `evaluation.passed` (`pipeline.ts:501`) and, where the security gate is enabled, only after it returns clean — the blocked path returns at `:570` or continues at `:574` before ever reaching the write. No failing or security-blocked evaluation can be recorded as settled.

## No gate widened

- `PENDING_STATUSES` (`mcp/tools/sprint.ts:32-37`, `cli/commands/sprint.ts:39-44`) is disjoint from both `"passed"` and `"completed"` before AND after the flip, so `findNextPendingSprint` selects identically.
- The resume cursor already accepted both words, so no sprint is newly skipped or newly retried.
- Loop termination in both migrated entry points is driven by `sprintPassed`/`evaluation.passed` (`:254`/`:283`), never by the recorded word.

## MINOR — the flusher's split uses a bare literal, not the predicate

`flusher.ts:76` (`if (contractStatus === "completed")`) is safe today only because the ternary two lines above bounds the value to `{completed, needs-rework, failed}`. It is also structurally invisible to the sc-1-4 invariant scan, which keys on the `.status` member-access spelling (documented at `status-vocabulary.invariant.test.ts:44-49`). If a future change makes that ternary emit a second settled word, a settled sprint silently lands in `failedSprints` and flows into `deriveRunSuccess` (`finalize.ts:84-85, :226`). **Failure direction is conservative** — a passing run would report failed, never the reverse — so no integrity or authorization impact. Recorded because it is the one settled-ness decision in this diff not routed through `isSettledContractStatus`, with a documented exclusion but no named upgrade path.

## MINOR — `verdictFrom`'s counter is now structurally always zero

After this sprint no writer in either engine produces the literal `"passed"` for a settled contract, so `interpreter.ts:728`'s counter is always 0. The pending-verdict path can never return `"success"`, and a declared `"failed"` can never soften to `"partial"`. **Every affected transition moves toward a MORE severe verdict** — a declared `"success"` with zero recorded failures still returns `"success"` at `:746` without consulting the counter — so no run can be made to report success it did not earn. Already allowlisted and deferred at `status-vocabulary.invariant.test.ts:205-208`.

## MINOR (pre-existing, unchanged by this sprint) — unbounded retry under a non-default config

In both migrated entry points the outer `while (continueLoop)` re-selects the first contract whose status is in `PENDING_STATUSES`, and `"needs-rework"` is itself pending (`mcp/tools/sprint.ts:36`, `cli/commands/sprint.ts:43`). With `continue: true` AND a non-default `sprint.requireContracts: false`, a sprint that exhausts maxIterations is written back as `"needs-rework"` and re-selected forever — unbounded LLM spend reachable from the MCP tool. The default `requireContracts: true` (`config/schema.ts:175`) terminates the loop. The status flip changes nothing here: neither word is in `PENDING_STATUSES`, before or after. Recorded only because the brief asked whether the two newly migrated entry points changed their loop-termination semantics — they did not.

## Approved areas

- `pipeline.ts:501-589` — evaluator DECISION logic untouched; the write is unreachable except behind a passing evaluation and a clean security gate.
- `pipeline.ts:1052` — the completed/failed split migrated to the predicate in the SAME change as the write it reads; the `requireContracts`/needs-rework break at `:1058-1066` unchanged.
- `sprint-contract.ts:69-118` — one vocabulary source; TERMINAL built on top of SETTLED so they cannot drift; `updateContractStatus` stamps `completedAt` off the terminal (not settled) predicate, so timestamp behaviour is identical across the flip.
- `state/history.ts:266-272` — `getStatusIcon` is a pure, total, side-effect-free mapping reading no module or filesystem state. Its export widens nothing (absent from `src/index.ts`'s public surface, unlike `isSettledContractStatus` at `index.ts:35`), and its default branch fails safe to `[PENDING]`, so an unknown status can never render as `[PASS]`.
- `state/history.ts:194-199` — the "Passed" row counts via the predicate while "Failed" stays a separate literal count; no unfinished contract can render or count as finished.
- `contract-materialization.ts:61` — materialization force-overwrites `status = "proposed"`, so a supplied spec cannot embed a settled status and have a sprint skipped or reported done.
- `resume-cursor.ts:22-24` — already accepted both words pre-flip; no sprint newly skipped or newly retried.
- `workflow/pure-sprint.ts:135-153` — `outcome: "passed"` requires `verdict.passed && !gen.blocked`; a blocked generator returns "failed", so the flusher's "completed" write is anchored to a real pass.
- `pge/nodes/sprint-review.ts:203-223` — `sprint_exit` writes "completed" strictly on `outcome.settled === "succeeded"`, and `branchOutcome` ignores advisory "skipped" verdicts, so a disabled security gate cannot make a failing branch look settled.
- `conformance.engines.test.ts:408-441` — the status delta closes by real convergence (both engines asserted, plus a same-value assertion), not by allowlisting. The golden dataset is untouched; all 16 fixtures still carrying a "passed" contract are `enforcement: "integrity"` cases, which make no runtime claim.
