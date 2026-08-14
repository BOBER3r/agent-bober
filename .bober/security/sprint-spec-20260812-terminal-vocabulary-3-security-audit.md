# Security Audit — sprint-spec-20260812-terminal-vocabulary-3

Scope: `git diff 40950e2..HEAD` (commits 19ad3d4, 83ceed1)
Verdict after adversarial verification: **PASS** — 0 critical, 0 important, 1 minor, 1 informational.

Both auditor findings were handed to a fresh-context verifier that attempted to disprove them. Both were **downgraded**; neither survived at its original severity.

## Finding 1 — producer-supplied `version` is not normalized (auditor: IMPORTANT → verifier: MINOR, high confidence)

`PlanSpecSchema.sprints` is `z.array(z.unknown())` (`spec.ts:160`), so producer output reaches `SprintContractSchema.safeParse` in the embedded branch of `materializeContracts` (`contract-materialization.ts:52`). That branch overwrites `status`, `specId`, `sprintNumber` and `contractId` (`:61-65`) but leaves `version` as supplied, and `saveContract` (`sprint-state.ts:44-63`) validates then writes the raw object, so it survives to disk. Constraints are only `.int().min(0)` — no upper bound.

**Why it is minor, not important** (all verified independently):
- `versionRank` is reachable only through `replaceIfNewer`, which `coding.graph.ts` binds solely to `spec`/`specDraft`/`verdict` (`:206,236,252`). `sprintContracts` is `appendById` (`:192`). **No code reads `SprintContract.version` today.**
- The only producer is the planner LLM or a `.bober/specs/*.json` authored by the repo owner — the same trust domain as the code the pipeline then generates and executes, not an external actor.
- Even after a future join switch, the worst outcome is the channel showing `proposed` instead of `completed` — the already-documented status quo at `sprint-review.ts:33-51`. Branch settlement is still decided by `branchStatus`'s own `attempts` discriminator, and `gate_sprint_in` reads neither version nor status (`gates.ts:447-472`).

**Directive carried into sprint 4** (verbatim from the verifier): if sprint 4 switches the `sprintContracts` join to consult `versionRank`, it must NOT rank on producer-supplied `version` alone — either strip/reset `version` on the embedded branch of `materializeContracts` alongside the four fields already normalized, or make the join settled-status-aware so only a contract passing `isSettledContractStatus` may win on version. Either fix makes the finding moot.

## Finding 2 — `version` is monotone within a run, not across runs (auditor: MINOR → verifier: INFORMATIONAL, high confidence)

Mechanism confirmed: `attempts` is recomputed per run from `state.evaluations` (`sprint-review.ts:197-202`) and `saveContract` overwrites unconditionally (`:62-63`). But the impact half does not hold: nothing reads on-disk `version` back into any decision (zero `loadContract`/`listContracts` calls anywhere under `src/pge`), and before a re-run could write a lower number, `plan_materialize` → `materializeContracts` regenerates the file as a fresh `proposed` copy with **no `version` key at all** (`contract-materialization.ts:102-132`). The on-disk sequence is `2 → absent → 1` on a field with no consumer. `resume-cursor.ts:22-24` additionally skips settled sprints.

**Note for sprint 4**: if `version` ever becomes decision-bearing across a resumed/re-run boundary, derive rank from within-run state only — never trust a `version` read off disk, since the plan step legitimately rewrites the file with the field absent.

## Approved areas

- `sprint-contract.ts:213` — `.int().min(0)` rejects NaN/Infinity/negatives at every parse boundary including `OverallStateSchema.parse` per commit (`commit.ts:441`); pinned by `sprint-contract.test.ts:491-494`.
- `reducers.ts:348-359` — `versionRank` independently guards with `Number.isFinite` and falls back to rank 0 (defence in depth).
- `sprint-review.ts:203-213` — `version: attempts` is written LAST in the object literal, so an inflated incoming `version` is overwritten, not propagated onto the settled copy.
- `sprint-review.ts:197-202` + `coding.graph.ts:695` — `attempts` counts only engine-written verdicts, branch-locally by contractId, with the loop bounded at `maxIterations: 3`. No unbounded-counter or DoS surface.
- `capture.ts:112,167-168` — every recorded request/response passes through `redactProjectRoot` against an `mkdtemp` throwaway root; recaptured fixtures show `"projectRoot": "<projectRoot>"`. A full scan of `.bober/golden/` found zero absolute paths, home directories, env values, keys, tokens, Bearer/Authorization headers or PEM blocks.
- The five re-captured fixtures change only a single `"version": <small int>` key inside `sprint.exit` payloads.
- `sprint-state.ts:70-104` — `loadContract` widens by exactly one bounded-type integer field; no passthrough, no `.strict()` removal, no new path handling.
