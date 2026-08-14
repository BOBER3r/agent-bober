# Sprint Briefing: The version delta closes — contracts and pipelineResult converge

**Contract:** sprint-spec-20260814-pge-full-convergence-6
**Generated:** 2026-08-14T00:00:00Z
**Branch:** bober/pge-full-convergence (HEAD `23a1718`, sprint 5)

> **Line numbers in the contract are STALE.** `generatorNotes` cites
> `src/pge/nodes/sprint-review.ts:215` for `version: attempts`. Sprints 4 and 5 landed today and
> shifted that file. The CURRENT line is **`src/pge/nodes/sprint-review.ts:287`**. Every citation
> below was re-read from the working tree at HEAD `23a1718`.

---

## 1. Target Files

### `src/pge/nodes/sprint-review.ts` (READ ONLY — the reference implementation, do not modify)

**`sprint_exit`'s settle block, lines 260-292:**
```ts
      const attempts = Math.max(
        1,
        state.evaluations.filter(
          (entry) => entry.contractId === contract.contractId && entry.verdict !== "skipped",
        ).length,
      );
      // ...
      const settled: SprintContract = {
        ...contractWithoutFeedback,
        status: outcome.settled === "succeeded" ? "completed" : "failed",
        updatedAt: ctx.clock.nowIso(),
        // `attempts` is a replay-stable count (filter().length over a channel a replay
        // rebuilds identically), monotone across the seeded->settled transition ... and
        // branch-local. See `versionRank`, `src/pge/registry/reducers.ts:366-393`.
        version: attempts,          // <- :287, the line the contract cites as :215
```
This is the value the imperative engine must reproduce. It is written once per branch, on BOTH
the succeeded and failed settle (line 280 chooses the status; line 287 writes `version`
unconditionally).

---

### `src/orchestrator/pipeline.ts` (modify) — 1109 lines; the four settle sites

**The loop and its counter, line 208 and line 299:**
```ts
  const maxIterations = config.evaluator.maxIterations;      // :208
  // ...
  for (let iteration = 1; iteration <= maxIterations; iteration++) {   // :299
```

**Settle site A — the PASSING path, lines 587-594 (the one the conformance fixture takes):**
```ts
      logger.success(`Sprint ${currentContract.contractId} passed all evaluations!`);

      currentContract = updateContractStatus(currentContract, "completed");
      currentContract = {
        ...currentContract,
        evaluatorFeedback: evaluation.summary,
      };
      await updateContract(projectRoot, currentContract);
```
The returned object is the SAME `currentContract` (`return { contract: currentContract, ... }`,
`:709`), so one write here reaches disk AND `PipelineResult`. `version` must be set BEFORE the
`updateContract` at `:594`.

**Settle sites B, C and D — the three `needs-rework` settles**, all inside the same loop, all with
`iteration` in scope, all `updateContractStatus(currentContract, "needs-rework")` immediately
followed by `await updateContract(projectRoot, currentContract)` and a `return`:

| Site | Lines | Cause |
|---|---|---|
| B | `:416-423` | generator returned `success: false` at `maxIterations` (also sets `evaluatorFeedback` to a literal) |
| C | `:566-571` | security gate blocked at `maxIterations` |
| D | `:740-747` | evaluation failed at `maxIterations` |

PGE writes `version` on its failed settle too (`sprint-review.ts:280` picks the status, `:287`
writes `version` unconditionally), so leaving these three out would be an asymmetry.

**The OUT-OF-LOOP return, lines 753-754 — `iteration` is NOT in scope here:**
```ts
  // Should not normally reach here
  return { contract: currentContract, evaluation: lastEvaluation };
```
Reached only via the `interrupted` `break` at `:302` (status still `"in-progress"`, never a
settle) or a zero/negative `maxIterations`. See §9 pitfall 6 for how to handle it.

**Non-settle writes that must NOT gain a `version`** — `:209-210` (`in-progress`, the seeded-copy
analogue), `:404-408` (`generatorNotes`, mid-round), `:458-459` (`evaluating`), `:717-721`
(`evaluatorFeedback` on a failing round that will retry).

**`PipelineResult` is a container for the same objects, lines 86-92 and 1052-1055:**
```ts
export interface PipelineResult {
  success: boolean;
  spec: PlanSpec;
  completedSprints: SprintContract[];
  failedSprints: SprintContract[];
```
```ts
      if (isSettledContractStatus(result.contract.status)) {
        completedSprints.push(result.contract);      // :1053 — the object runSprintCycle returned
      } else {
        failedSprints.push(result.contract);
```

**Imported by (production):** `workflow/ts-engine.ts`, `workflow/engine.ts`, `workflow/flusher.ts`,
`orchestrator/finalize.ts`, `cli/commands/run.ts`, `mcp/run-manager.ts`, `medical/engine.ts`,
`src/index.ts`.
**Test file:** `src/orchestrator/pipeline.test.ts` (exists, 500+ lines, drives `runSprintCycle`
directly).

---

### `src/contracts/sprint-contract.ts` (READ ONLY unless a doc comment is added)

**Lines 196-214 — the schema field and the anti-default rule:**
```ts
  /**
   * ── `version` is the ordering discriminator, not decoration ──
   * ...
   * DELIBERATELY `.optional()`, never `.default(...)`. A default would
   * materialise `version` on the SEEDED copy too (every parse, including
   * `OverallStateSchema.parse` at every commit boundary), collapsing seeded
   * and settled to the same rank and destroying the exact ordering this
   * field exists to provide. All ~250 committed contracts predate this
   * field and must stay valid with it absent.
   */
  version: z.number().int().min(0).optional(),
```
`nonGoals[0]` forbids removing it. The generator does **not** need to touch this file at all
(the field already exists and already accepts the value); an added sentence in this JSDoc naming
the imperative writer is optional and low-risk.

---

### `src/orchestrator/workflow/conformance.ts` (READ ONLY — sc-6-4 forbids editing VOLATILE_KEYS)

**Lines 65-76, EXACT current contents — the evaluator will diff this list:**
```ts
const VOLATILE_KEYS = new Set([
  "createdAt",
  "updatedAt",
  "startedAt",
  "completedAt",
  "timestamp",
  "duration",
  "runId",
  "totalCost",
  "durationMs",
  "approverId",
]);
```
Ten keys. `version` is not among them and must not become one.

**How the two fields are compared** — `FIELD_SPECS` (`:347-422`) declares `contracts` (`:348-354`,
identity `contractId`, read by `listContracts`) and `pipelineResult` (`:416-421`, identity the
constant string `"pipelineResult"`, sourced from the runner's return value at `:551-552`).
`collectFields` (`:436-454`) puts BOTH through the same path: `contracts: await
listContracts(projectRoot)` (`:442`) and `pipelineResult: pipelineResult === undefined ? [] :
[pipelineResult]` (`:452`). Both are then redacted + `normalize`d identically (`:494-497`) and
canonicalised by `keyedCollection`; the diff loop (`:577-605`) reports a field when the key lists
differ.

**Why closing `contracts` closes `pipelineResult` as a CONSEQUENCE, not by special-casing:**
`PipelineResult.completedSprints`/`failedSprints` are `SprintContract[]` (`pipeline.ts:89-90`)
and are populated with the identical object `runSprintCycle` returned (`pipeline.ts:1053`), which
is the identical object `updateContract` wrote to disk (`pipeline.ts:594`). One write of `version`
onto `currentContract` before `:594` therefore lands in both fields simultaneously. The already-
committed proof of the container relation is `conformance.engines.test.ts:661`:
`expect(pgeResult?.completedSprints[0]).toEqual(pgeContract)` — the in-result contract equals the
one `listContracts` reads back. If `pipelineResult` still diverges after `contracts` converges,
something ELSE differs inside the container and must be found, not stripped.

---

### `src/orchestrator/workflow/conformance.engines.test.ts` (modify) — 795 lines

**The pin to flip, lines 389-394:**
```ts
    expect([...new Set(report.diffs.map((diff) => diff.field))].sort()).toEqual([
      "audits",
      "contracts",
      "pipelineResult",
    ]);
    expect(report.equivalent).toBe(false);
```
After this sprint the array becomes `["audits"]`. `expect(report.equivalent).toBe(false)` STAYS
true — `audits` is permanently accepted (sprint 3 / ADR-1).

**The both-directions control, lines 406-429** — `committedPin` at `:409` is a hand-built literal
`["audits", "contracts", "pipelineResult"]` and must move with the pin, keeping BOTH directions
discriminating (a regression re-appearing, and a real field silently vanishing).

**The sc-5-4 stripped-`version` control, lines 439-466** — a pure-function control proving the strip
does real work. After sprint 6 the strip is no longer needed to equalise the two sides; keep or
rewrite it deliberately, and update its comment at `:451-453` ("the one delta sprint 6 has yet to
close").

**The real-run assertions to invert, lines 626-640:**
```ts
    // The remaining delta: `sprint_exit` writes a monotone `version`; `runSprintCycle` writes none.
    expect(tsContract.version).toBeUndefined();      // :627 — MUST become an equality
    expect(pgeContract.version).toBeDefined();       // :628
    // ...
    const { version: _tsContractVersion, ...tsContractWithoutVersion } = tsContract;   // :638
    const { version: _pgeContractVersion, ...pgeContractWithoutVersion } = pgeContract;
    expect(canonical(pgeContractWithoutVersion)).toBe(canonical(tsContractWithoutVersion));
```
Pattern D (assert against the OTHER engine's own answer, not a literal) is the house style — see
`:620-625` for `evaluatorFeedback`/`generatorNotes` and `:509-510` for `history`. The strongest
sc-6-3 assertion is `expect(canonical(pgeContract)).toBe(canonical(tsContract))` with **nothing
stripped**, plus `toBeDefined()` on each `version` first so two `undefined`s cannot pass.

**The pipelineResult block, lines 642-661** — its prose ("it reduces exactly to the `contracts`
divergence") is now the CLOSURE argument; keep the `toEqual(pgeContract)` line at `:661` and add
the ts-side equivalent so the container claim is pinned on both engines.

---

### `.bober/golden/` (verify, almost certainly UNCHANGED)

44 cases; **7** carry `enforcement: "replay"` and are the only ones EXECUTED
(`case-schema.ts:83-111`; floor `GOLDEN_MIN_REPLAY_CASES = 5` at `:127`):
`replay-full-run-commit-approved`, `replay-full-run-evaluation-fails`,
`replay-full-run-evaluation-passes`, `replay-plan-clarification-round`,
`replay-plan-clarify-rounds-exhausted`, `replay-research-reflexions-exhausted`,
`replay-research-second-reflexion`. The other 37 are `integrity` and are never run.

**Prediction: ZERO cases move.** `src/pge/golden/executor.ts:499` constructs `new PgeEngine(...)`
and nothing else — every golden case is a GRAPH run, and this sprint changes only the imperative
engine. Six of the seven already pin `"version": N` inside
`pinnedResponses[].request.contract` (captured at sprint 3 of spec-20260812-terminal-vocabulary);
those pins describe the PGE writer, which is untouched. **Prove it, do not assume it**: run the
golden tests and then `git status --porcelain .bober/golden/` must be empty.

---

## 2. Patterns to Follow

### Pattern A — the monotone value is derived from a COUNT, never a clock or an ordering
**Source:** `src/pge/nodes/sprint-review.ts:260-265, 282-287`
```ts
      const attempts = Math.max(
        1,
        state.evaluations.filter(
          (entry) => entry.contractId === contract.contractId && entry.verdict !== "skipped",
        ).length,
      );
```
**Rule:** the value must be a pure function of WHICH events happened, floored at 1, never of when
or in what order they happened.

### Pattern B — assert against the other engine's own answer (Pattern D in-file)
**Source:** `src/orchestrator/workflow/conformance.engines.test.ts:620-625`
```ts
    expect(tsContract.evaluatorFeedback).toBeDefined();
    expect(pgeContract.evaluatorFeedback).toBeDefined();
    expect(pgeContract.evaluatorFeedback).toBe(tsContract.evaluatorFeedback);
```
**Rule:** never pin a literal for a convergence claim — pin the equality, with a `toBeDefined()`
on each side so two absences cannot pass.

### Pattern C — a pure-function control beside every real-run assertion
**Source:** `src/orchestrator/workflow/conformance.engines.test.ts:439-466` (and `:406-429`) —
`canonical(stripVersion(tsLike))` equals `canonical(stripVersion(pgeLike))` (`:456`), and WITHOUT
stripping the same pair is not equal (`:459`), proving the strip does real work.
**Rule:** every transform used in a real-run assertion also gets a synthetic two-direction control,
so the claim is not hostage to what the fixture happens to produce today.

### Pattern D — a doc claim is re-derived from source by a scanner
**Source:** `src/pge/topology/docs.test.ts:1335-1377`
```ts
function findContractFeedbackWriters(files: readonly ScannedFile[]): string[] {
  return files
    .filter((file) => file.content.includes("evaluatorFeedback") || file.content.includes("generatorNotes"))
    .map((file) => file.path);
}
```
plus two "the scanner actually bites" tests over synthetic input (`:1371-1385`).
**Rule:** the definitionOfDone requires "every documentation claim added backed by a test that
fails when the claim stops being true" — this is the shipped shape of that.

### Pattern E — the paired-run determinism test
**Source:** `src/orchestrator/pipeline.test.ts:455-508` — `vi.useFakeTimers()` +
`vi.setSystemTime(...)` at `:456-457`, a `runOnce` helper making a fresh temp root per run
(`:475-500`), then `expect(a.result).toEqual(b.result)` at `:507`.
**Rule:** sc-6-2 ("two runs over the same input produce the same version, proven by execution") is
exactly this shape — a fresh temp root per run, a frozen clock, deep-equal on the results.

### Pattern F — multi-round control with `mockResolvedValueOnce`
**Source:** `src/orchestrator/pipeline.test.ts:300-302` (`.mockResolvedValueOnce(criticalAuditResult)`
then `.mockResolvedValueOnce(cleanAuditResult)`, with `evaluator.maxIterations: 2` at `:306`).
**Rule:** a one-round fixture cannot tell `version: 1` from any rule that also yields 1 — add a
two-round fail-then-pass case and assert `version === 2`.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---|---|---|---|
| `versionRank` | `src/pge/registry/reducers.ts:366` | `(value: unknown): [number, string, string]` | The rank-aware join's key: `version` first, then `updatedAt`, then canonical JSON. Missing/non-finite `version` ranks `0`. |
| `rankIsGreater` / `higherRanked` | `src/pge/registry/reducers.ts:395`, `:412` | `(candidate, incumbent): boolean` / `(incumbent, candidate): unknown` | The total order `appendById` (`:191-201`) and `lastWriteWinsByKey` (`:304-322`) both resolve same-key conflicts through. |
| `iterationOf` | `src/pge/nodes/sprint-evaluate.ts:118` | `(state, contractId): number` | `evaluations.filter(...).length + 1`. **Over-counts** inside `sprint_evaluate` — not a round counter. |
| `generateAttemptsSoFar` | `src/pge/nodes/gates.ts:252` | `(state, branchKey): number` | Counts `sprint_generate` messages. Sprint 4's round counter, explicitly built to match "the imperative engine's single shared loop variable" (`:249-250`). |
| `branchOutcome` | `src/pge/nodes/sprint-review.ts:203` | `(state, contractId): { settled, summary, evaluatorFeedback?, generatorNotes? }` | Reduces the same non-`skipped` filter to the decisive verdict. |
| `updateContractStatus` | `src/contracts/sprint-contract.ts:293` | `(contract, status): SprintContract` | Returns a NEW contract with `status`/`updatedAt` (+ `startedAt`/`completedAt`). Spread-based — a later spread of `version` composes with it. |
| `isSettledContractStatus` | `src/contracts/sprint-contract.ts:101` | `(status): boolean` | `"passed" \| "completed"`. The `completedSprints` split at `pipeline.ts:1052`. |
| `updateContract` / `saveContract` | `src/state/sprint-state.ts:228`, `:38` | `(projectRoot, contract): Promise<void>` | Validates with `SprintContractSchema.safeParse` then writes the RAW object (`:63`). A declared field survives; an undeclared key is stripped on read. |
| `listContracts` | `src/state/sprint-state.ts` (via `listContractsWithSkips:150`) | `(projectRoot): Promise<SprintContract[]>` | What `collectFields` uses for the `contracts` field. |
| `canonical` / `normalize` | `src/orchestrator/workflow/conformance.ts:113`, `:85` | `(value: unknown): string` / `unknown` | The one definition of "identical" — volatile keys stripped, keys sorted. Use it in assertions; do not hand-roll a comparator. |
| `collectRunArtifacts` | `src/orchestrator/workflow/conformance.ts:483` | `(projectRoot, pipelineResult?): Promise<Record<ConformanceField, unknown[]>>` | The single collection path shared by the harness and the golden executor. |
| `emitPhaseEvent` | `src/pge/runtime/history.ts` (sprint 4) | see `sprint-evaluate.ts:334-339` | The graph's history writer, delegating to `appendHistory`. Not needed this sprint — listed so it is not re-invented. |

Directories reviewed: `src/utils/`, `src/state/`, `src/contracts/`, `src/pge/registry/`,
`src/pge/nodes/`, `src/orchestrator/workflow/`.

---

## 4. Prior Sprint Output

### Sprint 3 of spec-20260812-terminal-vocabulary — the field itself
**Created:** `SprintContractSchema.version` (`src/contracts/sprint-contract.ts:214`) and
`sprint_exit`'s write. **Doc:** `docs/sprints/sprint-spec-20260812-terminal-vocabulary-3.md`.
**THE DISQUALIFYING ARGUMENT this sprint must not re-litigate** (`:27-47` and `:49-80`):
- **Wall-clock is disqualified twice over.** `updatedAt` is step 2 of `versionRank` and it "cannot
  decide anything in the case that matters": under the golden harness's fixed clock the seeded and
  settled copies carry a **byte-identical** `updatedAt` — readable in
  `.bober/golden/replay-full-run-evaluation-passes.json`, where both copies read
  `"2026-08-05T00:00:00.000Z"`. So a clock-derived value is a dead tiebreak under the very harness
  that measures convergence, and a live clock is not reproducible on a replay at all.
- **Ordering-derived is disqualified.** The value must depend on "which verdicts exist, never on
  the order they arrived in", and must touch "**no clock, no superstep counter and no spanId**".
  A value derived from arrival order, an array index or a superstep number would differ between a
  concurrency-1 and a concurrency-8 run — the exact determinism criterion the graph is held to.
- **Never `.default(...)`** (`:82-98`): a default materialises `version` on the SEEDED copy at every
  parse, collapsing both copies to rank 0 and handing the tie back to `canonicalJson`, where
  `"completed" < "proposed"` and the seed wins.

### Sprint 4 of spec-20260812-terminal-vocabulary — the reader
`appendById`'s `mergeEntries` (`src/pge/registry/reducers.ts:191-201`) resolves a duplicate
`contractId` by RANK, not canonical order. **This is the rank-aware channel join sc-6-1 forbids
breaking.** What would break it: giving the seeded copy a `version` (a schema `.default()`, a write
in `contract-materialization.ts`, or a materialiser that stamps one) — the settled copy would stop
outranking the seed, `sprintContracts` would revert to carrying the `"proposed"` copy, and
`commit.finalize` would put a `proposed` contract into `completedSprints` (the sprint-12 defect).
Pinned by `src/pge/nodes/sprint-evaluate.test.ts:798-801`.

### Sprint 4 of spec-20260814-pge-full-convergence — `history` converged
`src/pge/runtime/history.ts` + nine emitters. Relevant only as the template for "how a divergence
gets dropped from the pin in BOTH directions" (`conformance.engines.test.ts:406-429`).

### Sprint 5 of spec-20260814-pge-full-convergence — `evaluatorFeedback`/`generatorNotes` converged
Commits `b03463b..23a1718`. Left `version` as the sole `contracts` delta, and said so in the code:
`src/pge/nodes/sprint-review.ts:76-78` — *"Deliberately unclosed by this sprint: the contract's
third field, `version` … sprint 6's business."* That paragraph is now stale and should be updated.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`, 48 lines)
- ESM everywhere, `.js` extensions on every import (NodeNext).
- `import type { ... }` — ESLint `consistent-type-imports` is enforced; unused vars error unless
  `_`-prefixed.
- Zero type errors and zero lint errors are hard gates. Tests are collocated (`*.test.ts` beside
  `*.ts`), vitest, real temp directories rather than fs mocks.
- Section headers use `// ── Name ─────`.
- Commits: `bober(sprint-N): description`.

### Architecture Decisions
- `.bober/architecture/arch-20260814-pge-full-convergence-adr-1.md` (sprint 1) — fan-out checkpoints
  stay illegal; `audits` is architecturally unclosable, which is why
  `expect(report.equivalent).toBe(false)` survives this sprint. Sprints 2-5 produced no further ADR,
  and sprint 6 needs none: the field, its rank semantics and its anti-default rule are all decided.

### Other Docs
- `docs/sprints/sprint-spec-20260812-terminal-vocabulary-3.md` — §4 above; **read it before
  proposing any alternative version source.**
- `docs/pge-graph.md:1220-1300` — the "Engine migration disposition" bullets for `contracts` and
  `pipelineResult`. These must be UPDATED, not deleted (see §9 pitfall 8).
- `docs/sprints/sprint-spec-20260814-pge-full-convergence-5.md` — the previous sprint's write-up;
  the house format for the doc this sprint owes.

---

## 6. Testing Patterns

**Runner:** vitest. **Assertion style:** `expect`. **Mocks:** `vi.mock` factories hoisted to the top
of the file + `vi.mocked(fn).mockImplementation(...)` in `beforeEach`. **Naming:** `*.test.ts`
collocated. **Timeouts:** conformance tests pass `60_000` as the third `it` argument.

### Unit Test Pattern — driving `runSprintCycle` directly
**Source:** `src/orchestrator/pipeline.test.ts:44-51, 310-320, 475-507`
```ts
vi.mock("../state/index.js", () => ({
  ensureBoberDir: vi.fn().mockResolvedValue(undefined),
  saveContract: vi.fn().mockResolvedValue(undefined),
  updateContract: vi.fn().mockResolvedValue(undefined),
  appendHistory: vi.fn().mockResolvedValue(undefined),
  readDesign: vi.fn().mockRejectedValue(new Error("no design")),
  readOutline: vi.fn().mockRejectedValue(new Error("no outline")),
}));
// ...
    const result = await runSprintCycle({
      contract: testContract,
      spec: testSpec,
      completedContracts: [],
      projectRoot: tmpRoot,
      config,
      projectContext: testProjectContext,
    });
    expect(result.contract.status).toBe("completed");
```
`updateContract` is mocked here, so the DISK copy is asserted through
`vi.mocked(updateContract).mock.calls` — assert `version` on the LAST call's contract as well as on
`result.contract`, so a write that reached the return value but not disk is caught.

### The PGE-side analogue this sprint mirrors
**Source:** `src/pge/nodes/sprint-evaluate.test.ts:804-828`
```ts
  it("the written version is REPLAY-STABLE: two independent runs over the same input write the same value (sc-3-3)", async () => {
    // ...two runs, capture `written.version` from the writeContract binding...
    expect(versions[0]).toBeDefined();
    expect(versions[0]).toBe(versions[1]);
  }, 30_000);
```

### Integration Test Pattern — the two real engines
**Source:** `src/orchestrator/workflow/conformance.engines.test.ts:150-163` (`runnerFor` builds
`new PgeEngine(...)` or `new TsPipelineEngine()` from a fresh `conformanceConfig()`), `:185-192`
(`compare()`), `:482-485` (two fresh roots, the shipped runners).
`conformanceConfig()` (`src/pge/engine/__fixtures__/whole-graph.ts:420-427`) sets
`evaluator.maxIterations: 1`, so the fixture settles on round 1 and BOTH engines must produce
`version: 1`. Frozen clock `2026-08-05T00:00:00.000Z`, fixed `RUN_ID = "run-conformance"`.

### E2E
No Playwright in this repo. Not applicable.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### THE CRUX — do the two counters count the same transitions?

| Round shape | imperative `iteration` (`pipeline.ts:299`) | PGE `attempts` (`sprint-review.ts:260`) | agree? |
|---|---|---|---|
| generator OK → evaluator passes | +1 | `sprint_security` writes `"skipped"` (not counted), `sprint_evaluate` writes `pass` → +1 | YES |
| generator OK → evaluator fails → retry | +1 | `sprint_evaluate` writes `fail` → +1 | YES |
| security gate blocks | +1 (imperative runs the evaluator FIRST, `:484`, then the gate; PGE runs the gate first and skips the evaluator — either way one round) | `sprint_security` writes `"fail"` → +1 | YES |
| evaluator threw / returned malformed | +1 (retry) | `sprint_evaluate` writes `fail` (`:344-366`) → +1 | YES |
| expensive suite fails / anchor regressed | +1 | `sprint_evaluate` writes `fail` (`:380-392`) → +1 | YES |
| **generator returns `success: false`** | **+1** (`:402-412`, `continue` — evaluator never runs) | **+0** — `sprint_generate` (`sprint-generate.ts:237-259`) writes NO `evaluations` entry and does not branch on `success`; `gate_syntax` catches it and routes to `sprint_correct` *"without spending an evaluation"* (`coding.graph.ts:642`) | **NO** |

**This one row is the whole finding.** The imperative loop variable counts rounds STARTED; PGE's
`attempts` counts rounds that produced a decisive verdict. They agree on every path the conformance
fixture and the golden dataset exercise, and on every retry path, and diverge only when a round
dies before any verdict is recorded. Two honest options, both satisfying sc-6-1 — pick one and say
which in the code comment and the doc:
- **(i) `version: iteration`** — the loop variable, in scope at all four settle sites. Simplest, and
  it is the counter sprint 4 already declared to be PGE's `generateAttemptsSoFar` analogue
  (`gates.ts:245-250`). Diverges from `attempts` by the number of generator-failure rounds.
- **(ii) a decisive-round counter** — a `let settledAttempts = 0` hoisted above the loop and
  incremented once per round in which `runEvaluatorAgent` returned (i.e. immediately after
  `:489`), then written as `Math.max(1, settledAttempts)`. This is a byte-for-byte match for
  `attempts` on every path, including the generator-failure round, and it also solves the
  out-of-scope problem at `:754`.

Both are counts, both are floor-1-able, neither touches a clock or an ordering — so both clear the
sprint-3 disqualification bar. Option (ii) is the stronger answer to sc-6-1's word "equivalent";
option (i) is the smaller diff. The stopCondition is NOT triggered either way: a replay-stable
monotone source **does exist at the settle site**.

### Files That May Break
| File | Depends on | Risk | What to check |
|---|---|---|---|
| `src/orchestrator/workflow/conformance.engines.test.ts` | `runSprintCycle`'s contract shape | **high** | `:627` (`tsContract.version` undefined) FAILS by design; `:389-394` pin FAILS by design. Both are the sprint's deliverable. |
| `src/orchestrator/workflow/oracle-retention.test.ts:156-167` | the SOURCE TEXT of the conformance test | **high** | Scans for the literal substrings `"history"`, `"audits"`, `"contracts"`, `"pipelineResult"` and `expect(report.equivalent).toBe(false)`. Keep the prose and that assertion. |
| `src/pge/topology/docs.test.ts:920-942` | `docs/pge-graph.md` | medium | `assertDispositionCitesEvidence` needs the doc to still contain `contracts`, `pipelineResult`, `history`, `audits` and to match `/equivalent[^\n]*false/i`. |
| `src/orchestrator/pipeline.test.ts` | `runSprintCycle` results | medium | `:507` `expect(a.result).toEqual(b.result)` — a non-deterministic `version` breaks it immediately (a free replay-stability canary). |
| `src/orchestrator/loop-bounds.test.ts:246-330` | `runSprintCycle` + `maxIterations` | medium | Asserts `result.contract.status === "needs-rework"` after exactly `maxIterations` rounds — settle sites B/C/D. |
| `src/orchestrator/workflow/flusher.ts:60-80` | its OWN settle (`updateContractStatus` at `:69`) | low | A THIRD engine (workflow) that also settles contracts and writes NO version. Out of scope — the harness compares `ts` vs `pge` only. Do not change it silently. |
| `src/orchestrator/contract-materialization.ts:66-76` | `SprintContract.version` | **high if touched** | It deliberately `delete contract.version` on the seeded copy. Touching it inverts the rank join. |
| `src/pge/nodes/sprint-review.ts:49-78` | prose claiming `version` is unclosed | low | Comment is now stale; update it. |
| `src/orchestrator/workflow/ts-engine.ts`, `engine.ts`, `finalize.ts`, `cli/commands/run.ts`, `mcp/run-manager.ts`, `medical/engine.ts` | `PipelineResult` | low | Additive optional field on a contract; no signature change. |

### Existing Tests That Must Still Pass
- `src/contracts/sprint-contract.test.ts:468-556` — the anti-default suite: `:478`
  (`version` undefined when omitted), `:479` (`"version" in result.data === false` — genuine
  absence, not `undefined`), `:516-525` (a declared `version` survives save→load), `:538` (control:
  an UNDECLARED key does NOT). **If any of these fail, a default was introduced somewhere.**
- `src/orchestrator/contract-materialization.test.ts:268-318` — the security strip: a
  producer-supplied `version: 9999` must not survive materialization.
- `src/pge/nodes/sprint-evaluate.test.ts:740-828` — PGE writes `version`, equals `attempts`, is
  replay-stable, and the settled copy wins the channel (`:798-801`).
- `src/pge/registry/reducers.test.ts` — the order-invariance/rank property suite.
- `src/pge/golden/dataset.test.ts:288-300` — every replay case still passes and the counts still
  match; `src/pge/golden/capture.test.ts` — 9/9 with NO capture env.
- `src/orchestrator/pipeline.test.ts` (all 4 cases), `src/orchestrator/loop-bounds.test.ts`,
  `src/orchestrator/workflow/workflow-engine.test.ts`, `src/contracts/status-vocabulary.invariant.test.ts`.

### Features That Could Be Affected
- **feat-5 (this sprint)** — `contracts` + `pipelineResult` convergence.
- **The rank-aware `sprintContracts` join** (sprint 4 of terminal-vocabulary) — shares
  `SprintContract.version`. Verify `sprint-evaluate.test.ts:798-801` still reports `"completed"`.
- **Contract materialization security** (sprint 4, sc-4) — shares the same field.

### Recommended Regression Checks
1. `npx vitest run --exclude '**/.claude/worktrees/**' --exclude '**/node_modules/**'` — full suite.
2. `npx vitest run src/orchestrator/workflow/conformance.engines.test.ts src/orchestrator/workflow/oracle-retention.test.ts src/pge/topology/docs.test.ts --exclude '**/.claude/worktrees/**'`
3. `npx vitest run src/pge/golden/ --exclude '**/.claude/worktrees/**'` then
   `git status --porcelain .bober/golden/` → **must be empty** (sc-6-5: nothing moved, proven).
4. `npx vitest run src/contracts/sprint-contract.test.ts src/orchestrator/contract-materialization.test.ts src/pge/nodes/sprint-evaluate.test.ts src/pge/registry/reducers.test.ts`
5. `git diff src/orchestrator/workflow/conformance.ts` → **must be empty** (sc-6-4).
6. `npm run typecheck && npm run typecheck:tests && npm run lint && npm run build`
7. Verify on a CLEAN checkout (`git stash -u` or a fresh worktree), not just the working tree —
   this repo has twice been green locally and red in CI on uncommitted state.

---

## 8. Implementation Sequence

1. **Decide the counter** — option (i) `iteration` or option (ii) a decisive-round counter (§7).
   Write the reason into the code comment at the settle site, citing
   `sprint-review.ts:260-265` and `gates.ts:213-250`.
   - Verify: the choice is a count, is floored at 1, and touches no clock/superstep/index.
2. **`src/orchestrator/pipeline.ts`** — write `version` at the four settle sites (`:417-422`,
   `:568-569`, `:589-594`, `:745-746`), always BEFORE the `updateContract` call, so the disk copy
   and the returned object carry the same number. Decide `:754` explicitly (§9 pitfall 6).
   - Verify: `npm run typecheck`; `npx vitest run src/orchestrator/pipeline.test.ts src/orchestrator/loop-bounds.test.ts`.
3. **`src/orchestrator/pipeline.test.ts`** — new `describe` for sc-6-1/sc-6-2: (a) a one-round pass
   writes `version: 1` on both `result.contract` AND the last `updateContract` call; (b) a two-round
   fail-then-pass writes `version: 2` (Pattern F) — the case that discriminates the rule from a
   constant; (c) two independent runs over the same input produce the same `version` (Pattern E,
   frozen clock, fresh temp root each).
   - Verify: those tests fail if the write is removed (mutate and re-run once).
4. **`src/orchestrator/workflow/conformance.engines.test.ts`** — flip the pin at `:389-393` to
   `["audits"]`, move `committedPin` at `:409` with both directions still discriminating, invert
   `:627-628` into a Pattern-B equality, add the unstripped whole-object
   `canonical(pgeContract) === canonical(tsContract)`, and add the ts-side container assertion beside
   `:661`. Rewrite the three prose blocks (`:350-370` contracts, `:371-384` pipelineResult,
   `:602-640`) to record the CLOSURE and how it happened. Keep every field name in the text.
   - Verify: `npx vitest run src/orchestrator/workflow/conformance.engines.test.ts` and then
     `src/orchestrator/workflow/oracle-retention.test.ts`.
5. **Golden gate** — run it, then prove nothing moved with `git status --porcelain .bober/golden/`.
   Do **not** set `GOLDEN_CAPTURE=1` unless a case genuinely fails.
6. **`src/pge/nodes/sprint-review.ts:49-78`** — update the stale "deliberately unclosed … sprint 6's
   business" paragraph to record the closure. Comment only.
7. **Docs** — `docs/pge-graph.md:1220-1300` (update the two disposition bullets in place; do not
   delete the historical paragraphs) and a new `docs/sprints/sprint-spec-20260814-pge-full-convergence-6.md`
   in the sprint-5 format. Add a Pattern-D scanner test if a new source-derived claim is made.
   - Verify: `npx vitest run src/pge/topology/docs.test.ts`.
8. **Full verification** — the seven checks in §7, on a clean checkout.

---

## 9. Pitfalls & Warnings

1. **Never give `version` a `.default(...)`.** It materialises on the SEEDED copy at every parse,
   both copies rank 0, the tie falls to `canonicalJson` where `"completed" < "proposed"`, and the
   seed wins the `sprintContracts` channel — the exact defect sprint 4 of terminal-vocabulary fixed.
   `src/contracts/sprint-contract.ts:207-213` says so; `sprint-contract.test.ts:479`
   (`expect("version" in result.data).toBe(false)`) bites.
2. **Never add `version` to `VOLATILE_KEYS`** (`conformance.ts:65-76`). sc-6-4 and nonGoal 2. The
   evaluator diffs that list — it is the cheap way this sprint could be faked.
3. **Never write `version` in `contract-materialization.ts`.** `:66-76` deliberately
   `delete contract.version` from a producer-supplied embedded contract; stamping the seed there is
   the same failure as pitfall 1, with a security dimension (an inflated `version` permanently
   outranks the settled copy).
4. **Do not change the PGE side.** sc-6-1 says give the IMPERATIVE engine an equivalent source.
   Editing `sprint-review.ts:287` would move `version` pins inside `pinnedResponses[].request.contract`
   in six of the seven replay cases and force a re-capture this sprint does not need.
5. **Do not use `Date.now()`, `updatedAt`, a superstep, a spanId, an array index or an arrival
   order.** Disqualified with reasons at `docs/sprints/sprint-spec-20260812-terminal-vocabulary-3.md:27-80`;
   re-proposing one is re-proposing a rejected design.
6. **`iteration` is out of scope at `pipeline.ts:754`.** That return is reached via the `interrupted`
   `break` (`:302`), where the status is still `"in-progress"` and nothing has settled. Either leave
   it version-less deliberately (with a comment saying an un-settled contract has no attempt count to
   report — the honest answer, matching sprint 5's refusal to synthesise absent values) or hoist the
   counter above the loop. Do NOT default it to `0` or `1` there.
7. **The one-round fixture cannot discriminate.** `conformanceConfig()` sets
   `evaluator.maxIterations: 1` (`whole-graph.ts:425`), so ANY rule that yields 1 passes the
   conformance test. The two-round test in step 3(b) is what makes the claim real.
8. **Do not delete prose from `conformance.engines.test.ts` or `docs/pge-graph.md`.**
   `oracle-retention.test.ts:164` scans the test file's SOURCE for the literals `history`, `audits`,
   `contracts`, `pipelineResult`; `docs.test.ts:920-942` scans the doc for the same words plus
   `/equivalent[^\n]*false/i`. Record the closure by rewriting, the way sprint 4 recorded
   `history`'s.
9. **`expect(report.equivalent).toBe(false)` stays.** `audits` is permanently accepted (ADR-1). A
   sprint that "achieved equivalence" here has broken something.
10. **`saveContract` writes the RAW object** (`sprint-state.ts:63`) but `loadContract` returns
    `safeParse(...).data` in zod's strip mode — an UNDECLARED key reaches the file and vanishes on
    the next read — the control at `sprint-contract.test.ts:538`. Use the declared `version` field;
    never invent a parallel key such as `attempts`.
11. **Run the suite with the excludes:** `npx vitest run --exclude '**/.claude/worktrees/**'
    --exclude '**/node_modules/**'`. A bare run picks up nested worktrees.
12. **Verify on a clean checkout.** The working tree currently carries unrelated untracked files
    (`.bober/contracts/sprint-spec-20260804-opus5-adaptation-*.json`, research docs); green locally
    with those present has twice meant red in CI.
