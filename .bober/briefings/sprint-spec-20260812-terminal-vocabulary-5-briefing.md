# Sprint Briefing: Both engines write the same word, and contracts converges

**Contract:** sprint-spec-20260812-terminal-vocabulary-5
**Generated:** 2026-08-12T22:15:00Z
**Curator verification:** every file:line below was opened and read. Four test files were RUN
(`conformance.engines.test.ts` 5/5, `capture.test.ts` 9/9, `dataset.test.ts` 20/20 +
`gate.test.ts` 16/16, `executor.test.ts` 16/16) — all green on the pre-sprint tree.

---

## 0. THE HEADLINE — read this before touching anything

**Three facts that decide most of this sprint:**

1. **`outcome` is NOT `status`.** Four of the six reader sites the contract names read
   `SprintOutcomeKind` (`src/orchestrator/workflow/pure-sprint.ts:25` —
   `"passed" | "needs-rework" | "failed"`), a workflow verdict enum that has NOTHING to do
   with `ContractStatus`. Changing them is a bug, not a fix. Full classification in §2.
2. **The golden dataset captures PGE runs ONLY** (`src/pge/golden/capture.ts:110-120`
   constructs a `PgeEngine`; there is no `runTsPipeline` anywhere on the capture path).
   This sprint changes only ts-engine / workflow-engine code. **Predicted golden diff:
   ZERO of the 43 cases move.** Anything moving is the sc-5-4 STOP CONDITION firing. §7.
3. **`.bober/contracts/` still has TWO other ts-side writers of `"passed"`** that the
   contract text does not name: `src/mcp/tools/sprint.ts:255` and
   `src/cli/commands/sprint.ts:285`. Sprint 6 is docs-only, so no later sprint covers them.
   Decision required — §2.4.

---

## 1. Target Files

### `src/orchestrator/pipeline.ts` (modify — 1124 lines)

**THE WRITE (lines 587-594):**
```ts
      logger.success(`Sprint ${currentContract.contractId} passed all evaluations!`);

      currentContract = updateContractStatus(currentContract, "passed");   // <- :589 THE WRITE
      currentContract = {
        ...currentContract,
        evaluatorFeedback: evaluation.summary,                             // <- :592 the ts-only field
      };
      await updateContract(projectRoot, currentContract);
```

**The two nearby literals that MUST NOT change:**
```ts
        event: "sprint-passed",     // :598  — a HISTORY EVENT NAME, pinned at
                                    //         conformance.engines.test.ts:341-352
        outcome: "passed",          // :614  — a TELEMETRY enum (src/telemetry/emit.ts:54),
                                    //         not a contract status
```

**THE SPLIT (lines 1052-1067):**
```ts
      if (result.contract.status === "passed") {        // <- :1052 MUST FOLLOW THE WRITE
        completedSprints.push(result.contract);
      } else {
        failedSprints.push(result.contract);
        if (
          config.sprint.requireContracts &&
          result.contract.status !== "needs-rework"
        ) { ... break; }
      }
```
If :589 flips and :1052 does not, **every passing sprint lands in `failedSprints`** and
`deriveRunSuccess` (`src/orchestrator/finalize.ts:90-93`) reports `success: false`.

**`generatorNotes` is written here, twice** — `:406` (generator-failure path) and `:428`
(success path): `generatorNotes: generatorResult.notes`. This is the factual basis for §4.

**Imported by (impact):** `src/index.ts`, `src/mcp/run-manager.ts`, `src/cli/commands/run.ts`,
`src/cli/commands/trace.ts`, `src/medical/engine.ts`, `src/orchestrator/worktree.ts`,
`src/orchestrator/finalize.ts`, `src/orchestrator/workflow/engine.ts` (+ ts-engine).
**Test files:** `pipeline.test.ts`, `pipeline.guidance.test.ts`, `pipeline.pause.test.ts`,
`loop-bounds.test.ts`, `code-reviewer-agent.test.ts`, `documenter-agent.test.ts`,
`conformance.engines.test.ts` — all exist. See §7.

---

### `src/orchestrator/workflow/flusher.ts` (modify — 133 lines)

**Lines 60-80, verbatim:**
```ts
    for (const sprint of result.perSprint) {
      const contractStatus =
        sprint.outcome === "passed"        // :62 <- OUTCOME enum. DO NOT CHANGE.
          ? "passed"                       // :63 <- CONTRACT STATUS. CHANGE to "completed".
          : sprint.outcome === "needs-rework"
            ? "needs-rework"
            : "failed";

      const stamped = updateContractStatus(sprint.contract, contractStatus);   // :69
      await updateContract(projectRoot, stamped);

      if (contractStatus === "passed") {   // :76 <- reads the LOCAL var from :63. CHANGE.
        completedSprints.push(stamped);
      } else {
        failedSprints.push(stamped);
      }
```

**`:76` is deliberately invisible to the sprint-1 invariant scan.** See
`src/contracts/status-vocabulary.invariant.test.ts:41-46` and its dedicated proof-test at
`:343-353` ("does not bite on a bare local-variable comparison with no `.status` accessor
(flusher.ts:76's shape)"). **Do not rewrite `:76` as `stamped.status === "completed"`** —
that WOULD match `OFFENDER_PATTERN` (`invariant.test.ts:68-69`) and add an un-allowlisted
offender, failing `"no un-allowlisted offender exists in the real tree"` (`:266-271`).

**Imported by:** `src/orchestrator/workflow/workflow-engine.ts` (production),
`finalize.e2e.test.ts`, `flusher.test.ts`, `interpreter.test.ts`, `pge/runtime/commit.test.ts`.

---

### `src/orchestrator/workflow/interpreter.ts` (modify — 145 lines; likely NO CODE CHANGE)

**Lines 117-142, verbatim:**
```ts
  const perSprint = outcomes.map((o) => ({
    contract: o.contract,
    finalVerdict: o.finalVerdict,
    iterationsUsed: o.iterationsUsed,
    outcome: o.outcome,                                                     // :121
    lensVerdicts: o.lensVerdicts,
  }));

  for (const o of outcomes) {
    pendingHistory.push({
      event: "workflow-sprint-evaluated",
      phase: o.outcome === "passed" ? "complete" : "evaluating",            // :128
      sprintId: o.contract.contractId,
      details: { outcome: o.outcome, iterations: o.iterationsUsed },        // :130
    });
  }

  const allPassed = perSprint.length > 0 && perSprint.every((p) => p.outcome === "passed"); // :134
  pendingHistory.push({
    event: "workflow-complete",
    phase: allPassed ? "complete" : "failed",
    details: {
      total: perSprint.length,
      passed: perSprint.filter((p) => p.outcome === "passed").length,       // :140
      failed: perSprint.filter((p) => p.outcome !== "passed").length,       // :141
    },
  });
```
**All four are `SprintOutcomeKind`.** Proof chain, read end to end:
`src/orchestrator/workflow/types.ts:41` (`outcome: "passed" | "needs-rework" | "failed"` on
`WorkflowRunResult.perSprint[]`) ← `src/orchestrator/workflow/pure-sprint.ts:40`
(`outcome: SprintOutcomeKind`) ← `pure-sprint.ts:25`
(`export type SprintOutcomeKind = "passed" | "needs-rework" | "failed";`), produced at
`pure-sprint.ts:140` / `:150` / `:174`. **No `SprintContract.status` is read in this file.**

---

### `src/pge/nodes/sprint-evaluate.test.ts` (modify — 847 lines; sc-5-3)

The file pins the **PGE** write, which is NOT changing. Its assertions stay:
```ts
    expect(persisted).toEqual([`${contract.contractId}:completed`]);   // :765
    expect(versions).toEqual([1]);                                     // :770
    expect(
      run.finalState.sprintContracts.find(...)?.status,
    ).toBe("completed");                                               // :785-787
```
**What sc-5-3 actually asks for** is the *prose* at `:759-760`, which today is a
FALSE claim that this sprint makes TRUE:
```ts
    // The branch settled, the contract was persisted through the SHIPPED writer, and the
    // contract channel carries the settled status the imperative pipeline writes.   // :759-760
```
Before this sprint the imperative pipeline wrote `"passed"`, so "the settled status the
imperative pipeline writes" was wrong. After it, it is literally true. Edit the comment
**deliberately** and say so, and consider adding an assertion that ties the two engines'
word together rather than restating a literal.

**TRAP:** `expect(run.result.status).toBe("completed")` at `:748` and `:805` is
`GraphRunResult.status` (`src/pge/runtime/interpreter.ts:329-331`:
`"completed" | "aborted" | "interrupted" | ...`) — an INTERPRETER run state, not a contract
status. Do not touch.

---

### `src/orchestrator/workflow/conformance.engines.test.ts` (modify — 487 lines; sc-5-2)

**The pinned divergence set (`:312-318`) — VERIFIED GREEN just now, do NOT shrink it:**
```ts
    expect([...new Set(report.diffs.map((diff) => diff.field))].sort()).toEqual([
      "audits", "contracts", "history", "pipelineResult",
    ]);
    expect(report.equivalent).toBe(false);
```

**The per-field record (`:402-419`) — THIS is what moves:**
```ts
    expect(tsContract.status).toBe("passed");            // :407  -> "completed"
    expect(pgeContract.status).toBe("completed");        // :408  (unchanged)
    expect(tsContract.evaluatorFeedback).toBeDefined();  // :409  (unchanged)
    expect(pgeContract.evaluatorFeedback).toBeUndefined();// :410 (unchanged)
    expect(tsContract.generatorNotes).toBeDefined();     // :411  (unchanged)
    expect(pgeContract.generatorNotes).toBeUndefined();  // :412  (unchanged)
    expect(tsContract.version).toBeUndefined();          // :414  (unchanged)
    expect(pgeContract.version).toBeDefined();           // :415  (unchanged)
```
```ts
    expect(tsResult?.completedSprints.map((c) => c.status)).toEqual(["passed"]);      // :429 -> ["completed"]
    expect(pgeResult?.completedSprints.map((c) => c.status)).toEqual(["completed"]);  // :430 (unchanged)
```
Prose at `:286-293` says "**FOUR** field deltas" — becomes THREE. Prose at `:303-304`
lists `status`/`evaluatorFeedback`/`generatorNotes`/`version` — drop `status`.

**Do not delete the word `contracts` from this file.**
`src/orchestrator/workflow/oracle-retention.test.ts:164-166` reads this file's SOURCE and
asserts it still contains each of `"history"`, `"audits"`, `"contracts"`, `"pipelineResult"`.

---

### `.bober/golden/` (43 case files — 6 replay, 37 integrity) and `docs/pge-graph.md`

See §7 (prediction) and §5 (docs claims that go stale).

---

## 2. THE READER MAP — every site classified (sc-5-1's main risk)

| # | Site | Value compared | Type | Verdict |
|---|------|----------------|------|---------|
| 1 | `pipeline.ts:589` | `updateContractStatus(c, "passed")` | **`ContractStatus` WRITE** | **CHANGE → `"completed"`** |
| 2 | `pipeline.ts:1052` | `result.contract.status === "passed"` | **`SprintContract.status`** | **CHANGE** (`isSettledContractStatus` preferred) |
| 3 | `flusher.ts:62` | `sprint.outcome === "passed"` | `SprintOutcomeKind` (types.ts:41) | **DO NOT CHANGE** |
| 4 | `flusher.ts:63` | ternary result `"passed"` | **`ContractStatus` WRITE** (fed to `updateContractStatus` at `:69`) | **CHANGE → `"completed"`** |
| 5 | `flusher.ts:76` | `contractStatus === "passed"` (local from `:63`) | **`ContractStatus`** | **CHANGE → `"completed"`**, keep it a bare local (see §1) |
| 6 | `interpreter.ts:128` | `o.outcome === "passed"` | `SprintOutcomeKind` | **DO NOT CHANGE** |
| 7 | `interpreter.ts:134` | `p.outcome === "passed"` | `SprintOutcomeKind` | **DO NOT CHANGE** |
| 8 | `interpreter.ts:140` | `p.outcome === "passed"` | `SprintOutcomeKind` | **DO NOT CHANGE** |
| 9 | `interpreter.ts:141` | `p.outcome !== "passed"` | `SprintOutcomeKind` | **DO NOT CHANGE** |
| 10 | `pipeline.ts:598` | `event: "sprint-passed"` | history event NAME | **DO NOT CHANGE** — pinned `conformance.engines.test.ts:348` |
| 11 | `pipeline.ts:614` | `outcome: "passed"` | telemetry enum (`emit.ts:54`) | **DO NOT CHANGE** |
| 12 | `resume-cursor.ts:22-23` | `isSettledContractStatus(c.status)` | already migrated | **ALREADY COVERED by sprint 1** |
| 13 | `state/history.ts:198` | `isSettledContractStatus(c.status)` | already migrated | **ALREADY COVERED** |
| 14 | `mcp/tools/sprint.ts`, `mcp/tools/eval.ts`, `cli/commands/sprint.ts`, `cli/commands/eval.ts` filters | `isSettledContractStatus(c.status)` | already migrated | **ALREADY COVERED** (pinned `sprint-corpus.test.ts:73-93`) |

### 2.1 The graph-side sites a blanket replace WOULD damage — LEAVE ALONE

| Site | Code | Why it must not move |
|------|------|----------------------|
| `src/pge/runtime/commit.ts:533` | `c.status === "passed" \|\| succeededBranches.has(c.contractId)` | PGE never writes `"passed"`, so this half is permanently false; the split is decided by `branchStatus`. Making it `"completed"`/settled changes graph `completedSprints`/`failedSprints` → **golden cases move** → sc-5-4 stop condition. Its own rationale block is at `:502-526`. |
| `src/pge/runtime/interpreter.ts:728` | `state.sprintContracts.filter((c) => c.status === "passed").length` | `verdictFrom`'s `passed` counter. Today always 0 for a graph run. Flipping it changes `partial`/`failed` verdict math → **golden cases move**. Documented as a deliberate live defect at `docs/pge-graph.md:1236-1252`. |
| `src/pge/nodes/sprint-curate.ts:254`, `sprint-generate.ts:133`, `documenter.ts:83` | `"completed"` history filters | Already the right word for PGE; untouched. |
| `.claude/workflows/bober-pipeline.js:39-41, 129, 133` | `decideOutcome` returns `"passed"` | Produces `WorkflowRunResult.perSprint[].outcome` — the OUTCOME enum. Pinned by `src/orchestrator/workflow/script-helpers.test.ts:133`. **DO NOT CHANGE.** |

### 2.2 An unpinned consequence nobody has named — `progress.md` renders `[PENDING]`

`src/state/history.ts:255-268`:
```ts
function getStatusIcon(status: string): string {
  switch (status) {
    case "passed":  return "[PASS]";
    case "failed":  return "[FAIL]";
    ...
    default:        return "[PENDING]";     // <- "completed" falls HERE
  }
}
```
Called at `:226` for every contract in `.bober/progress.md`. `updateProgress` is called by
`RunResultFlusher.flush` (`flusher.ts:83-87`). **After the flip, every settled sprint renders
as `[PENDING]` in progress.md, and NO test catches it** — grep for `[PASS]` finds only
`history.ts:258`, `cli/commands/sprint.ts:323` and `cli/commands/eval.ts:152` (the latter two
are booleans, unrelated). Fix `getStatusIcon` to accept `"completed"` and add the test that
would have caught it. (`history.ts:199`'s separate `"failed"` row is ALLOWLISTED at
`status-vocabulary.invariant.test.ts:181-185` — leave it.)

### 2.3 `pipeline.ts:1052` breaks the sprint-1 allowlist either way — decide deliberately

`src/contracts/status-vocabulary.invariant.test.ts:194-198` allowlists it by **exact
`path:line`**, and `:252-264` fails with `"stale allowlist entry"` if the line stops matching
`OFFENDER_PATTERN`.
- If you write `isSettledContractStatus(result.contract.status)` → the line no longer matches
  → **DELETE the allowlist entry** (and consider adding `pipeline.ts` to the
  `"the five migrated readers…"` list at `:273-289`).
- If you write `=== "completed"` → the line still matches → **keep the entry, rewrite its
  reason** (it currently claims the migration was "deferred to keep this sprint's diff to
  reader convergence only").
Either way this is a deliberate edit, not a leave-alone.

### 2.4 DECISION REQUIRED — two other ts-side writers of `"passed"`

```ts
// src/mcp/tools/sprint.ts:254-259  (the bober_sprint MCP tool's own sprint loop)
          if (evaluation.passed) {
            currentContract = updateContractStatus(currentContract, "passed");
            currentContract = { ...currentContract, evaluatorFeedback: evaluation.summary };
```
```ts
// src/cli/commands/sprint.ts:283-288  (the `bober sprint` CLI's own sprint loop)
      if (evaluation.passed) {
        logger.success(`Sprint passed! Score: ${evaluation.score}/100`);
        currentContract = updateContractStatus(currentContract, "passed");
```
These are **writers**, not consumers of `runSprintCycle`'s write, so sc-5-1's literal text
does not reach them — but the spec is titled "One terminal vocabulary", sprint 6 is
docs-only, and `src/mcp/tools/sprint-corpus.test.ts:62-71` asserts the real corpus holds
**zero** `"passed"` contracts. Leaving them means the repo still has two paths that can
reintroduce the word. **Change them, or record explicitly why not.** Do not leave it silent.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---|---|---|---|
| `isSettledContractStatus` | `src/contracts/sprint-contract.ts:101` | `(status: ContractStatus) => boolean` | `passed \| completed` — "done and good". The sprint-1 predicate. |
| `isTerminalContractStatus` | `src/contracts/sprint-contract.ts:116` | `(status: ContractStatus) => boolean` | adds `failed` — "stopped at all". Used by `updateContractStatus`. |
| `SETTLED_CONTRACT_STATUSES` | `src/contracts/sprint-contract.ts:69` | `ReadonlySet<ContractStatus>` | The set behind the predicate. |
| `TERMINAL_CONTRACT_STATUSES` | `src/contracts/sprint-contract.ts:84` | `ReadonlySet<ContractStatus>` | Built ON TOP of the settled set (`:85`) so they cannot diverge. |
| `updateContractStatus` | `src/contracts/sprint-contract.ts:293` | `(c: SprintContract, status: ContractStatus) => SprintContract` | Stamps `updatedAt`, `startedAt`, and `completedAt` via `isTerminalContractStatus` (`:304`). `"completed"` is terminal, so **`completedAt` behaviour is unchanged by the flip**. |
| `ContractStatusSchema` | `src/contracts/sprint-contract.ts:38-48` | `z.enum([... 9 members ...])` | `"completed"` is member 9 — already legal, no schema change needed. |
| `normalize` / `canonical` | `src/orchestrator/workflow/conformance.ts:85` / `:113` | `(value: unknown) => unknown` / `=> string` | Volatile-key stripping + key sorting. `VOLATILE_KEYS` is at `:65-76` (10 keys). `version` is NOT among them, by design. |
| `fullyPopulatedFields` / `emptyOnAllEnginesFields` | `src/orchestrator/workflow/conformance.ts:648` / `:655` | `(report: ConformanceReport) => ConformanceField[]` | The population gate used at `conformance.engines.test.ts:218-223`. |
| `finalizePipelineRun` | `src/orchestrator/finalize.ts:~200` | `(input) => Promise<PipelineResult>` | Single owner of the terminal set. Reads only `completedSprints.length` / `failedSprints.length` (`:213`, `:226`) — **never reads `status`**, so it needs no change. |
| `deriveRunSuccess` / `deriveRunVerdict` | `src/orchestrator/finalize.ts:90-93` / `:98-102` | `(completedCount, failedCount) => boolean \| verdict` | Count-based. Unaffected. |
| `GOLDEN_MIN_REPLAY_CASES` | `src/pge/golden/case-schema.ts:127` | `= 5` | The floor. See §6. |
| `isReplayCase` / `parseGoldenCase` | `src/pge/golden/case-schema.ts:304` / `:320` | `(goldenCase) => boolean` / `(value, source) => GoldenCaseParse` | Dataset loading. |
| `GOLDEN_DATASET_MIN_CASES` / `_MAX_CASES` | `src/pge/golden/case-schema.ts:77` / `:78` | `= 20` / `= 50` | Directory-size gate. Currently 43 files. |
| `runGoldenGate` | `src/pge/golden/gate.ts:160` | `(options: GoldenGateOptions) => Promise<GoldenGateResult>` | Builds the real executor itself; no injection needed. |
| `captureGoldenCase` / `goldenCaseJson` | `src/pge/golden/capture.ts:~106` / exported | `(input) => Promise<GoldenCaptureResult>` | Records a PGE run then replays it. **PGE only.** |
| `versionRank` / `rankIsGreater` / `higherRanked` | `src/pge/registry/reducers.ts:365` / `:393` / `:412` | rank helpers | Sprint 4's rank-aware join. Not touched here. |
| `listContracts` / `loadContract` / `updateContract` / `saveContract` | `src/state/sprint-state.ts:113` / `:70` / `:152` / `:38` | `(projectRoot, …)` | The only contract IO. |

Directories reviewed for anything else applicable: `src/utils/` (`fs.ts`, `git.ts`,
`logger.ts`, …) — none relevant to status vocabulary. `src/state/`, `src/contracts/`,
`src/pge/golden/`, `src/orchestrator/workflow/` — covered above.

---

## 4. sc-5-2 — the other deltas, with the code that produces each

**Measure it yourself first** (evaluatorNotes demands this):
`npx vitest run src/orchestrator/workflow/conformance.engines.test.ts --exclude '**/.claude/worktrees/**' --exclude '**/node_modules/**'`
Curator ran it on the pre-sprint tree: **5/5 green**, divergence set
`["audits","contracts","history","pipelineResult"]`.

### Delta A — `status`: **CLOSES this sprint**
- ts: `pipeline.ts:589` `updateContractStatus(currentContract, "passed")` → becomes `"completed"`.
- PGE: `src/pge/nodes/sprint-review.ts:206-208`
  ```ts
      const settled: SprintContract = {
        ...contract,
        status: outcome.settled === "succeeded" ? "completed" : "failed",
  ```
  Unchanged. → both write `"completed"`. **Closed.**

### Delta B — `evaluatorFeedback`: **CANNOT close here → RECORD with reason**
- ts writes it at `pipeline.ts:590-593` (`evaluatorFeedback: evaluation.summary`), and also at
  `:427-431` on the needs-rework path.
- PGE writes it **nowhere**: `grep -rn 'evaluatorFeedback' src/pge/` (excluding tests) returns
  **zero hits**. `sprintExitNode` spreads `...contract` from the channel
  (`sprint-review.ts:206-216`) and sets only `status`, `updatedAt`, `version`.
- Closing it would mean **adding a writer to a PGE node body** — outside `estimatedFiles`
  and outside this sprint. **Reason to state: PGE has no evaluatorFeedback writer; adding one
  is a graph-node change, not a vocabulary change.**

### Delta C — `generatorNotes`: **CANNOT close here → RECORD with reason**
- ts writes it at `pipeline.ts:406` and `pipeline.ts:428` (`generatorNotes: generatorResult.notes`).
- PGE writes it **nowhere** (same zero-hit grep). The seeded contract does not carry it either:
  `stubContracts` (`src/pge/nodes/__fixtures__/region-harness.ts:247-274`) never sets it.
- **Reason to state: same class as B — a missing PGE writer, not a disagreement about a word.**

### Delta D — `version`: the FOURTH delta the contract text does not name → **RECORD**
- PGE: `sprint-review.ts:215` `version: attempts`, with the rationale at `:210-214`.
- ts: writes none.
- Not strippable: `VOLATILE_KEYS` (`conformance.ts:65-76`) holds exactly 10 keys and `version`
  is deliberately not one — `conformance.ts:47-60` states the bar for adding a key.
- Pinned today at `conformance.engines.test.ts:413-415`.
- **Pre-authorised** by sc-5-2 ("either closed too or recorded with a stated reason") and by
  the contract's second stop condition. `docs/pge-graph.md:1201-1218` already predicts exactly
  this outcome. **Record it; do not force it.**

**Therefore: `contracts` STAYS in the divergence set with THREE deltas
(`evaluatorFeedback`, `generatorNotes`, `version`), and so does `pipelineResult`, which
reduces to it** (`conformance.engines.test.ts:294-307`, `:433-440`). Say this explicitly —
sc-5-2 forbids ambiguity.

---

## 5. Relevant Documentation

### Project principles (`.bober/principles.md`, present)
ESM with `.js` extensions; `import type` (ESLint `consistent-type-imports`); no `any`;
tests co-located as `*.test.ts`; strict tsc is a hard gate; section headers as
`// ── Name ──────`; conventional commits `bober(sprint-N): description`.

### `docs/pge-graph.md` — the claims that go stale and MUST be updated
| Line | Claim | After this sprint |
|---|---|---|
| `:1190-1200` | "`runSprintCycle` writes `"passed"`, the graph's `sprint_review` writes `"completed"`… **No writer changed, so the divergence set above is unmoved**" | Writer changed. Rewrite. |
| `:1201-1218` | "closing the status delta at sprint 5 leaves **three** open — `evaluatorFeedback`, `generatorNotes`, `version`" | Becomes past tense — this is the sprint that does it. Cite the new pin. |
| `:1236-1252` | `verdictFrom` "compares against a word no PGE run writes" | Still true for PGE. But "the word `runTsPipeline` … compare literally" is now wrong — **the ts engine no longer writes `"passed"` either**, so the site is now dead for BOTH engines. That is a strictly stronger statement of the defect; say it. |
| `:827-863` | negative-control scaling section | Still accurate; §6 re-verifies it. |

Also stale, in source prose:
- `src/pge/nodes/sprint-review.ts:48-53` — "the word `runTsPipeline` and `commit.ts`'s
  `passed()` compare literally". Update. (No allowlist entry for this file — safe to edit.)
- `src/pge/runtime/commit.ts:504` — "`runTsPipeline` splits on `status === "passed"`". Update
  — **but see the line-shift trap in §9.**

### Sprint record convention
`docs/sprints/sprint-spec-20260812-terminal-vocabulary-{1..4}.md` exist. Write `-5.md` in the
same shape: what changed, why, what was measured, what was recorded rather than forced.

### Architecture
`.bober/architecture/` holds ADRs from unrelated specs (openhands fork, ide-desktop-shell).
**No ADR relevant to this sprint.**

---

## 6. Testing Patterns

### Unit test pattern — the invariant-scan shape this repo prefers
**Source:** `src/contracts/status-vocabulary.invariant.test.ts:90-102`
```ts
function findOffenders(files: SourceFile[]): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    const lines = file.content.split("\n");
    lines.forEach((line, i) => {
      if (isCommentLine(line)) return;
      if (OFFENDER_PATTERN.test(line)) offenders.push(`${file.path}:${i + 1}: ${line.trim()}`);
    });
  }
  return offenders;
}
```
**Rule:** split the PURE predicate from the disk walk, so the mutation control
(`:293-309`) can drive synthetic content without ever writing a scratch file under `src/`.

**Runner:** vitest 3.2.6. **Assertions:** `expect`. **Mocks:** `vi.mock` (hoisted) +
`vi.mocked(fn).mockImplementation(...)` re-bound in `beforeEach`
(`conformance.engines.test.ts:34-53`, `:125-140`). **Naming:** `*.test.ts` co-located.
**Timeouts:** engine-driving tests pass an explicit `60_000` / `120_000` / `180_000`.

### The negative-control pattern (this repo's signature)
**Source:** `src/pge/golden/dataset.test.ts:304-322`
```ts
  it("fails when a third of the executed cases stop reproducing their expectation", async () => {
    let seen = 0;
    const report = await runGoldenRegressionFromDir({
      dir: GOLDEN_DIR,
      execute: (goldenCase) => {
        seen += 1;
        return seen % 3 === 0
          ? { contracts: [{ contractId: "drifted" }] }
          : goldenCase.expected.artifacts;
      },
      facts,
    });
    expect(report.exitCode).toBe(GOLDEN_EXIT.belowThreshold);
```
**Rule:** inject a **FRACTION**, never a fixed count — a fixed count has a dataset size at
which it silently stops biting (`docs/pge-graph.md:859-863`).

### sc-5-6 — every negative control in the golden suite, and whether it BITES at 43 cases / 6 replay

Counts measured by the Curator: `.bober/golden/` holds **43** files — **6 replay**
(`replay-full-run-evaluation-fails`, `replay-full-run-evaluation-passes`,
`replay-plan-clarification-round`, `replay-plan-clarify-rounds-exhausted`,
`replay-research-reflexions-exhausted`, `replay-research-second-reflexion`) and **37 integrity**.

| # | Control | file:line | What it plants | Bites at 6 replay? Evidence |
|---|---|---|---|---|
| 1 | "fails when a third of the executed cases stop reproducing their expectation" | `dataset.test.ts:304` | `seen % 3 === 0` → cases 3, 6 return `{contracts:[{contractId:"drifted"}]}` | **YES.** 2 of 6 fail → 66.7 % ≤ 80 (strict `>`). Ran: 20/20 green. Scales: ≥2 failures from n=6 up. |
| 2 | "exits non-zero when a third of the dataset stops reproducing its expectation" | `gate.test.ts:236` | identical `seen % 3` injection through `runGoldenGate` | **YES.** Same arithmetic. Ran: 16/16 green. |
| 3 | "exits non-zero when a committed replay case stops reproducing its expectation" | `executor.test.ts:284` | copies the dataset to a temp dir, flips `pipelineResult[0].success` on `(index+1)%3===0` (indices 2, 5) | **YES.** `expect(drifted.length).toBeGreaterThan(0)` asserts non-vacuity in-test; 2 of 6 → 66.7 %. Ran: 16/16 green. This is the third of the three the previous spec fixed (sprint 8, `docs/pge-graph.md:849-857`). |
| 4 | "exits non-zero when the replay cases are relabelled as integrity" | `executor.test.ts:317` | rewrites every replay case to `enforcement:"integrity"` | **YES**, count-independent: replay count drops to 0 < `GOLDEN_MIN_REPLAY_CASES` → `GOLDEN_EXIT.usage` + `'enforcement "replay"'` in the log. |
| 5 | "fails when the executed cases are relabelled away" | `dataset.test.ts:205` | same relabel, through `validateGoldenDataset` | **YES**, count-independent. |
| 6 | "exits non-zero when the executor throws for every case" | `gate.test.ts:256` | executor throws | **YES**, 0 % pass. |
| 7 | "fails when the directory holds fewer than 20 files" | `dataset.test.ts:169` | deletes down to 19 | **YES**, but note the live headroom: 43 of a max 50. |
| 8 | "fails when the directory holds more than 50 files" | `dataset.test.ts:182` | writes synthetic cases to 51 | **YES.** **Only 7 files of headroom left** — flag if any case is added. |
| 9 | "fails when a case pins a node the graph no longer has" / "an effect the registry no longer has" / "a stray file" / "a volatile key" / "a truncated file" | `dataset.test.ts:219`, `:227`, `:240`, `:253`, `:267` | per-mutation dataset corruption | **YES**, all count-independent. |
| 10 | `runGoldenGate`'s dataset-half controls | `gate.test.ts:157, 169, 181, 189, 201, 211` | same mutations end-to-end | **YES**, count-independent. |
| 11 | "reports an unsatisfiable threshold as a usage error" | `gate.test.ts:273` | `minPassRatePercent: 100` | **YES.** |
| 12 | "refuses to run a dataset that failed validation, and never calls the executor" | `gate.test.ts:285` | renames a pinned nodeId; counts executor calls | **YES.** |
| 13 | coverage status-ok mutations (4) | `coverage.test.ts:293, 298, 306, 325, 344` | synthetic spans with `status: "failed"` / `"interrupted"` / added ok span | **YES**, driven against `executedNodeIdsFromSpans` directly — independent of case count by construction. |
| 14 | per-scenario byte-exact recapture | `capture.test.ts:247-284` | none — it IS the change detector (`expect(bytes).toBe(committed)`) | **YES.** Ran: 9/9 green. |
| 15 | "are the only cases in the dataset that declare enforcement replay" | `capture.test.ts:288-297` | none — cross-checks `SCENARIOS` against on-disk `enforcement` | **YES** — this is the third guard against a silent relabel. |

**The evaluator will revert one control and expect a false pass.** The cheapest honest
demonstration: change `executor.test.ts:291` from `(index + 1) % 3 === 0` back to the
pre-sprint-8 fixed pair, or to `% 7` (0 of 6 drift) and confirm the gate goes green while
proving nothing — then restore. Do this in a scratch edit you revert; do not commit it.

---

## 7. Impact Analysis — Affected Files, Features & Tests

### 7.1 Tests that WILL go red on the flip — the complete worklist

Every one below was opened and the exact assertion read. Work top to bottom.

| File:line | Assertion today | Action |
|---|---|---|
| `src/orchestrator/pipeline.test.ts:320` | `expect(result.contract.status).toBe("passed")` | → `"completed"` |
| `src/orchestrator/pipeline.test.ts:442` | same | → `"completed"` |
| `src/orchestrator/code-reviewer-agent.test.ts:239` | `expect(result.contract.status).toBe("passed")` | → `"completed"` |
| `src/orchestrator/code-reviewer-agent.test.ts:247` | `expect.objectContaining({ contractId: "test-contract", status: "passed" })` (contract handed to `runCodeReviewer`) | → `"completed"` |
| `src/orchestrator/code-reviewer-agent.test.ts:345` | `expect(result!.contract.status).toBe("passed")` | → `"completed"` |
| `src/orchestrator/documenter-agent.test.ts:238` | `.status).toBe("passed")` | → `"completed"` |
| `src/orchestrator/documenter-agent.test.ts:241` | `expect.objectContaining({ …, status: "passed" })` | → `"completed"` |
| `src/orchestrator/documenter-agent.test.ts:276` | `.status).toBe("passed")` | → `"completed"` |
| `src/orchestrator/documenter-agent.test.ts:308` | `.status).toBe("passed")` | → `"completed"` |
| `src/orchestrator/loop-bounds.test.ts:366` | `expect(result.contract.status).toBe("passed")` | → `"completed"` |
| `src/orchestrator/workflow/flusher.test.ts:209` | `expect(loaded.status).toBe("passed")` (C3 passed-outcome flush) | → `"completed"` |
| `src/orchestrator/workflow/flusher.test.ts:345` | `expect(loaded.status).toBe("passed")` (re-flush idempotency) | → `"completed"` |
| `src/orchestrator/workflow/flusher.test.ts:409` | `expect(loaded1.status).toBe("passed")` (mixed outcomes) | → `"completed"` |
| `src/orchestrator/workflow/conformance.engines.test.ts:407` | `expect(tsContract.status).toBe("passed")` | → `"completed"`; better, assert `toBe(pgeContract.status)` so the CONVERGENCE is what is pinned |
| `src/orchestrator/workflow/conformance.engines.test.ts:429` | `…completedSprints.map(c=>c.status)).toEqual(["passed"])` | → `["completed"]` |
| `src/contracts/status-vocabulary.invariant.test.ts:194-198` | allowlist entry `src/orchestrator/pipeline.ts:1052` | delete or re-reason — §2.3 |
| `src/pge/nodes/sprint-evaluate.test.ts:759-760` | prose claim about "the imperative pipeline" | update deliberately — sc-5-3 |
| `docs/pge-graph.md:1190-1252` | four stale prose claims | update — §5 |

### 7.2 Tests that MUST NOT change (and will stay green if you classified correctly)

- `src/orchestrator/workflow/interpreter.test.ts:72, 122, 246` — `outcome`, not status.
- `src/orchestrator/workflow/pure-sprint.test.ts:78, 92, 147, 162` — `out.outcome`.
- `src/orchestrator/workflow/script-helpers.test.ts:133-146` — `decideOutcome`.
- `src/orchestrator/loop-bounds.test.ts:476` — `out.outcome`.
- `src/orchestrator/finalize.e2e.test.ts:372, 431, 481` — `outcome: "passed"` in a
  `WorkflowRunResult` literal; no status assertion. Leave.
- `src/orchestrator/finalize.test.ts:165` — a fixture `status: "passed"`; nothing asserts it.
- `src/mcp/run-manager.test.ts:265` — a fake `PipelineResult` with an invented shape
  (`id`/`feature`); no status assertion.
- `src/pge/runtime/**` (`interpreter.test.ts:173-175`, `commit.test.ts:439/571/598/646`,
  `__tests__/partial-failure.test.ts`, `__tests__/exactly-once.invariant.test.ts:180`,
  `__tests__/admission.invariant.test.ts:164-166`, `replay.test.ts:237/324`) — these
  construct PGE state with `status: "passed"` deliberately, to exercise
  `verdictFrom`/`commit.ts:533` which this sprint does not touch. **Leave every one.**
- `src/pge/golden/case-schema.test.ts`, `runner.test.ts`, `registry/reducers.test.ts` —
  `"passed"` is arbitrary fixture data.
- `src/orchestrator/workflow/resume-cursor.test.ts:81-161` — writes contracts directly with
  both `"passed"` and `"completed"`; already predicate-driven. **Green either way**; the
  `"passed"` fixtures deliberately prove the predicate still accepts the legacy word.
- `src/orchestrator/workflow/conformance.test.ts:600` — `["passed", true]` is an EvalResult key.

### 7.3 Corpus tests over the real repo — must still hold

- `src/mcp/tools/sprint-corpus.test.ts:62-71` — asserts `.bober/contracts/` holds **zero**
  contracts with `status === "passed"`. This sprint makes it more true, not less. But if you
  leave `mcp/tools/sprint.ts:255` / `cli/commands/sprint.ts:285` writing `"passed"`, this is
  the test that documents the remaining hazard (§2.4).
- `src/contracts/sprint-contract.test.ts:336+` — corpus guard: every committed contract's
  `status` parses against `ContractStatusSchema`. `"completed"` is legal (`:47`).
- `src/orchestrator/workflow/oracle-retention.test.ts:156-167` — reads
  `conformance.engines.test.ts` source; all four field names must remain present.

### 7.4 Golden prediction for sc-5-4 — **ZERO of the 43 cases move**

**Why sprints 3 and 4 moved 5 of 6, and why this sprint moves 0.**

Sprints 3 and 4 changed **PGE** code — `sprintExitNode` gained `version: attempts`
(`sprint-review.ts:215`), and `mergeEntries` began resolving by rank
(`reducers.ts:191-197`). Golden cases are captured by driving a **`PgeEngine`**
(`src/pge/golden/capture.ts:110-120`), so PGE changes land in `expected.artifacts`. The 5 that
moved (commit `749a83a`, and `83ceed1` before it) were exactly the ones whose traversal reaches
`sprint_exit`:
`replay-full-run-evaluation-fails`, `replay-full-run-evaluation-passes`,
`replay-plan-clarification-round`, `replay-research-reflexions-exhausted`,
`replay-research-second-reflexion`. The sixth, `replay-plan-clarify-rounds-exhausted`, never
reaches `sprint_exit` (the plan region never settles), so it has no `contracts` expectation to
move — verified: it is absent from both commits' file lists.

**This sprint changes only `src/orchestrator/pipeline.ts`, `src/orchestrator/workflow/flusher.ts`
and test/doc prose. None of those executes during a golden capture.** The shared
`finalizePipelineRun` reads only array LENGTHS (`finalize.ts:213`, `:226`), never `status`.
So:

- **Predicted moved cases: none. Predicted `git status .bober/golden/`: clean.**
- **Verification procedure:** run `GOLDEN_CAPTURE=1 npx vitest run src/pge/golden/capture.test.ts`
  (sc-5-4 requires the re-capture to actually happen), then `git diff --stat .bober/golden/`.
  An empty diff CONFIRMS the prediction. **A non-empty diff is the sc-5-4 STOP CONDITION** and
  almost certainly means the change leaked into `src/pge/runtime/commit.ts:533`,
  `src/pge/runtime/interpreter.ts:728`, or `src/pge/nodes/sprint-review.ts`.
- Curator ran the non-capturing comparison on the pre-sprint tree: **9/9 green**, so the
  baseline is byte-exact and any post-sprint movement is attributable to this sprint alone.
- One legitimate non-status way a case can move, named so you can rule it out fast: cases embed
  `graph.graphVersion` at capture time (`docs/pge-graph.md`, and commit `925f57a`'s message).
  Do not bump the topology version this sprint.

### 7.5 sc-5-5 — the replay floor

- `GOLDEN_MIN_REPLAY_CASES = 5` — `src/pge/golden/case-schema.ts:127`, with the
  "why a floor and not an equality" rationale at `:113-125`.
- **Replay cases today: 6** (measured by parsing every `.bober/golden/*.json`). Headroom: 1.
- Enforced in four places: `dataset.test.ts:143`, `capture.test.ts:239`,
  `coverage.test.ts:237`, and `runner.ts:418` (`minReplay: GOLDEN_MIN_REPLAY_CASES`,
  documented at `runner.ts:54`).
- **The only mechanism that can relabel a case** is editing the `enforcement` field in a
  `.bober/golden/*.json` file (schema at `case-schema.ts:110`, and `:106-108` explains why the
  field is REQUIRED, never defaulted). Three independent guards catch it:
  `dataset.test.ts:205`, `executor.test.ts:317`, and `capture.test.ts:288-297` (which
  cross-checks the on-disk `enforcement` set against `SCENARIOS`).
- **Action:** do not touch `enforcement` anywhere. Assert the count after re-capture:
  6 replay / 37 integrity / 43 total.

### 7.6 Recommended regression checks (run in this order)

1. `npx vitest run src/orchestrator/workflow/conformance.engines.test.ts --exclude '**/.claude/worktrees/**' --exclude '**/node_modules/**'` — divergence set still 4 fields; the status delta is gone; read `report.diffs` yourself rather than trusting the pin.
2. `npx vitest run src/contracts/ src/orchestrator/ src/mcp/ --exclude '**/.claude/worktrees/**' --exclude '**/node_modules/**'` — the §7.1 worklist.
3. `GOLDEN_CAPTURE=1 npx vitest run src/pge/golden/capture.test.ts` then `git diff --stat .bober/golden/` — **expect empty** (§7.4).
4. `npx vitest run src/pge/golden/ --exclude '**/.claude/worktrees/**' --exclude '**/node_modules/**'` — all controls in §6.
5. `node scripts/run-golden-regression.mjs` — expect `6/6 passed`.
6. `npx vitest run --exclude '**/.claude/worktrees/**' --exclude '**/node_modules/**'` — baseline is **459 files / 6952 tests, 0 failed** (handoff `environmentNote`). A bare `npx vitest run` picks up the stray worktree at `.claude/worktrees/youthful-satoshi-563347` and reports ~22 foreign failures. **Never touch or delete that worktree.**
7. `npm run typecheck && npm run typecheck:tests && npm run lint && npm run build`.
8. Manual: confirm `getStatusIcon` renders `[PASS]` for `"completed"` (§2.2) and that a test now pins it.

---

## 8. Implementation Sequence

1. **`src/orchestrator/pipeline.ts:589`** — `"passed"` → `"completed"`. Do NOT touch `:598` or `:614`.
   - Verify: `git diff src/orchestrator/pipeline.ts` shows exactly one changed line so far.
2. **`src/orchestrator/pipeline.ts:1052`** — migrate the split (prefer `isSettledContractStatus`; add the import next to the existing `contracts/sprint-contract.js` import).
   - Verify: `npm run typecheck`.
3. **`src/contracts/status-vocabulary.invariant.test.ts`** — delete or re-reason the `pipeline.ts:1052` allowlist entry per §2.3, in the SAME step as (2).
   - Verify: `npx vitest run src/contracts/status-vocabulary.invariant.test.ts …` — all 4 structural tests green, especially `"every ALLOWLIST entry corresponds to a REAL, currently-matching offender"`.
4. **`src/orchestrator/workflow/flusher.ts:63` and `:76`** — `"passed"` → `"completed"`. Leave `:62` alone; keep `:76` a bare-local comparison.
   - Verify: `npx vitest run src/orchestrator/workflow/flusher.test.ts …` after step 6.
5. **`src/state/history.ts:255-268`** — teach `getStatusIcon` about `"completed"` (§2.2), and add the test that fails without it.
   - Verify: new test red before the fix, green after.
6. **Test worklist §7.1 rows 1-13** — the `"passed"` → `"completed"` assertion updates.
   - Verify: `npx vitest run src/orchestrator/ …` green.
7. **`src/orchestrator/workflow/conformance.engines.test.ts`** — `:407`, `:429`, and the prose at `:286-293` / `:303-304` (FOUR → THREE deltas). Keep the 4-field divergence set.
   - Verify: 5/5 green; `oracle-retention.test.ts` still green.
8. **`src/pge/nodes/sprint-evaluate.test.ts:759-760`** — the deliberate sc-5-3 prose edit. Change no assertion values.
   - Verify: file green, `run.result.status` assertions untouched.
9. **§2.4 decision** — either migrate `mcp/tools/sprint.ts:255` + `cli/commands/sprint.ts:285`, or write the reason down in the sprint doc. Do not leave it implicit.
10. **Re-capture `.bober/golden/`** — `GOLDEN_CAPTURE=1 npx vitest run src/pge/golden/capture.test.ts`, then read `git diff .bober/golden/` hunk by hunk against §7.4's prediction of ZERO.
    - Verify: `node scripts/run-golden-regression.mjs` → `6/6 passed`; 6 replay / 37 integrity / 43 total.
11. **sc-5-6 re-verification** — run the §6 table; optionally revert one control in a scratch edit, observe the false pass, restore.
12. **Docs** — `docs/pge-graph.md` (§5) + `docs/sprints/sprint-spec-20260812-terminal-vocabulary-5.md`. Every added claim must be backed by a test that fails when it stops being true.
13. **Full verification** — §7.6 steps 1-8.

---

## 9. Pitfalls & Warnings

- **A blanket find-and-replace of `"passed"` → `"completed"` breaks this sprint.** Nine
  production sites and dozens of test sites spell the same word for four different types:
  `ContractStatus`, `SprintOutcomeKind`, a history event name, and a telemetry enum. Work
  from §2's table, site by site.
- **Line-number-pinned allowlist.** `status-vocabulary.invariant.test.ts:138-223` pins
  `path:line` for 16 sites. **Adding or removing a line ANYWHERE above** `pipeline.ts:1052`,
  `pge/runtime/commit.ts:533`, `pge/runtime/interpreter.ts:728`, `pge/nodes/sprint-curate.ts:254`,
  `pge/nodes/sprint-generate.ts:133`, `pge/nodes/documenter.ts:83`, `state/history.ts:199`,
  `mcp/tools/status.ts:69`, `evaluators/builtin/playwright.ts:530/532/542`,
  `evaluators/builtin/unit-test.ts:285`, `fleet/reporter.ts:46/48`, `do-bridge/reconcile.ts:70/74`
  **shifts the pin and fails the test.** Sprint 4 had to update it twice for exactly this
  (commit `949661d` moved `commit.ts:531`→`:533` after editing prose above it). **If you update
  `commit.ts:504-512`'s now-stale prose, you WILL shift `:533` — update the allowlist location
  and its reason (which itself cites ":502-526") in the same edit.**
- **`state/history.ts:199`'s `=== "failed"` is deliberate**, not an oversight
  (`invariant.test.ts:181-185`): folding it into the settled predicate double-counts every
  failed sprint in `progress.md`.
- **`sprint-passed` (history event) and `sprint-pass` (telemetry) are not statuses.** The ts
  history event list is pinned verbatim at `conformance.engines.test.ts:341-352`; renaming
  the event moves the `history` divergence, which nonGoal 2 forbids.
- **Do NOT migrate `pge/runtime/commit.ts:533` or `pge/runtime/interpreter.ts:728`.** Both are
  live, documented, deliberately-deferred defects. Changing them moves golden cases and blows
  sc-5-4's stop condition. `docs/pge-graph.md:1236-1252` explains why they are still deferred.
- **Do not add a golden case.** The dataset is at 43 of a 50 maximum
  (`case-schema.ts:78`, gate at `dataset.test.ts:182`), and every replay case must be a
  distinct traversal registered in `capture.test.ts`'s `SCENARIOS`.
- **Do not add `version` (or `status`) to `VOLATILE_KEYS`.** `conformance.ts:47-60` sets the
  bar; stripping a key hides the very divergence the harness exists to find. Forcing the
  contracts divergence closed that way is explicitly forbidden by the sprint's stop condition.
- **`updateContractStatus` already handles `"completed"`** — `isTerminalContractStatus`
  (`sprint-contract.ts:304`) includes it, so `completedAt` still stamps. No schema or helper
  change is needed; adding one would be reinvention.
- **Run the suite with the exclude flags.** `npx vitest run --exclude '**/.claude/worktrees/**'
  --exclude '**/node_modules/**'`. A bare run picks up a stray unrelated worktree and reports
  ~22 failures that are not yours. Do not touch or delete
  `.claude/worktrees/youthful-satoshi-563347`.
- **`sprint-evaluate.test.ts` is 847 lines and pins the PGE side.** Only its prose changes.
  Any assertion-value edit there means you changed PGE behaviour, which this sprint must not.
