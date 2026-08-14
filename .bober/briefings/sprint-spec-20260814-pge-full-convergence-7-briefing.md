# Sprint Briefing: Retire the dead `passed` comparisons

**Contract:** sprint-spec-20260814-pge-full-convergence-7
**Generated:** 2026-08-14T19:00:00Z
**Branch:** bober/pge-full-convergence

> Sprints 1-6 all landed TODAY. Every `file:line` below was read at the state of HEAD
> `1fd29e9`. Re-grep before you edit if you land anything that shifts a line.

---

## 1. Target Files

### `src/pge/runtime/interpreter.ts` (modify)

**Relevant section — the whole of `verdictFrom`, lines 727-752:**

```ts
function verdictFrom(state: OverallState, failures: readonly TaskFailure[]): Exclude<RunVerdict, "pending"> {
  const passed = state.sprintContracts.filter((c) => c.status === "passed").length;   // :728  ← THE SITE
  const total = state.sprintContracts.length;

  // A graph may DECLARE its own verdict, and a terminal node normally does. It may not
  // declare away a failure the INTERPRETER recorded: ... (:731-736)
  if (state.verdict !== "pending") {
    if (state.verdict === "success" && failures.length > 0) return passed > 0 ? "partial" : "failed";  // :738 (A)
    // ...and it may not declare away the work that DID land, either. (:739-744)
    if (state.verdict === "failed" && passed > 0) return "partial";                    // :745 (B)
    return state.verdict;                                                              // :746 (C)
  }

  if (failures.length === 0 && passed > 0 && passed === total) return "success";       // :749 (D)
  if (passed > 0) return "partial";                                                    // :750 (E)
  return "failed";                                                                     // :751 (F)
}
```

**Exactly what it counts, and why the counter is structurally zero.**
`state.sprintContracts` is `z.array(SprintContractSchema)` (`src/pge/state/overall.ts:252`).
`ContractStatus` is a 9-member enum including BOTH `"passed"` and `"completed"`
(`src/contracts/sprint-contract.ts:38-48`). The only node that writes a SETTLED contract
into that channel on the shipped coding graph is `sprint_exit`, and it writes:

```ts
// src/pge/nodes/sprint-review.ts:288-291
const settled: SprintContract = {
  ...contractWithoutFeedback,
  status: outcome.settled === "succeeded" ? "completed" : "failed",
```

`plan_materialize` seeds `"proposed"` (verified in the pinned planner response of
`.bober/golden/replay-full-run-evaluation-passes.json`). Since
`spec-20260812-terminal-vocabulary` sprint 5, the imperative writer agrees:
`runSprintCycle` writes `"completed"` too (`src/orchestrator/pipeline.ts`, and its reader
at `:1091` already uses the predicate). So **no writer anywhere produces `"passed"` for a
settled sprint** → `passed ≡ 0` for every run of the shipped graph.

**Which branches are consequently unreachable, and what each would have produced:**

| Branch | Line | Guard | Verdict it would produce | Status today |
|---|---|---|---|---|
| A (`partial` arm of the ternary) | :738 | `state.verdict === "success" && failures.length > 0 && passed > 0` | `"partial"` | **DEAD** — always takes the `"failed"` arm |
| B | :745 | `state.verdict === "failed" && passed > 0` | `"partial"` | **DEAD** — falls through to C |
| D | :749 | `failures.length === 0 && passed > 0 && passed === total` | `"success"` | **DEAD** |
| E | :750 | `passed > 0` | `"partial"` | **DEAD** |
| C | :746 | declared verdict, verbatim | whatever the graph declared | live |
| F | :751 | fallthrough | `"failed"` | live — and swallows D and E |

With `passed ≡ 0` the function degenerates to: *return the declared verdict, except
downgrade a declared `success` with failures to `failed`; and if nothing was declared,
return `failed`.* `"partial"` and the derived `"success"` are unreachable outputs.

**Migration (mirror `src/state/history.ts:198`, the exact same shape):**
```ts
const passed = state.sprintContracts.filter((c) => isSettledContractStatus(c.status)).length;
```
`interpreter.ts` does **not** currently import from `contracts/sprint-contract.js` — add a
value import alongside the existing `../../contracts/topology.js` group (imports run
`src/pge/runtime/interpreter.ts:1-40`; `zod` first, then `../../` paths, then `../`, then
`./`).

**Imported by / consumers of the value this function produces:**
- `src/pge/runtime/interpreter.ts:1608` — `verdict: verdictFrom(state, failures)` into
  `GraphRunResult` (`:329-339`).
- **`PgeEngine.run` DOES NOT READ IT.** `src/pge/engine/pge-engine.ts:551-572` calls
  `commit.finalize(...)` and layers `errors`; `result.verdict` is never touched. Verified
  by repo-wide grep for `result.verdict` — the only readers are
  `src/pge/runtime/interpreter.test.ts` (:169, :457, :524-525, :563, :616),
  `src/pge/runtime/interrupt.test.ts` (:292), `src/pge/runtime/__tests__/partial-failure.test.ts`
  (:260-261, :359, :401, :510, :670-671, :685, :716-717, :743, :758) and the cross-process
  fixture `src/pge/runtime/__fixtures__/resume-child.ts:140` (asserted at
  `src/pge/runtime/__tests__/cross-process-resume.invariant.test.ts:157,159`).

**Test file:** `src/pge/runtime/interpreter.test.ts` (exists) **and**
`src/pge/runtime/__tests__/partial-failure.test.ts` (exists — this is where the downgrade
paths are actually exercised, see §6).

---

### `src/pge/runtime/commit.ts` (modify)

**Relevant section, lines 533-541 (with the rationale block at :502-532 immediately above):**

```ts
      const succeededBranches = new Set(
        Object.entries(state.branchStatus)
          .filter(([, status]) => status.state === "succeeded")
          .map(([branchKey]) => branchKey),
      );
      const passed = (c: SprintContract): boolean =>
        c.status === "passed" || succeededBranches.has(c.contractId);       // :539  ← THE SITE
      const completedSprints = state.sprintContracts.filter((c) => passed(c));
      const failedSprints = state.sprintContracts.filter((c) => !passed(c));
```

Migration:
```ts
      const passed = (c: SprintContract): boolean =>
        isSettledContractStatus(c.status) || succeededBranches.has(c.contractId);
```

**Imports this file already uses (`src/pge/runtime/commit.ts:1-15`):**
- `import type { SprintContract } from "../../contracts/sprint-contract.js";` — line 5.
  Add the value import as a SECOND line next to it, exactly as
  `src/orchestrator/pipeline.ts:16-17` does (`import type {...}` then
  `import { updateContractStatus, isSettledContractStatus } from ...`). ESLint enforces
  `consistent-type-imports` (`eslint.config.js:40`), so do not merge them.

**Behavioural note (load-bearing for sc-7-4):** this predicate is an **OR** with
`succeededBranches`. On the shipped graph `sprint_exit` writes `branchStatus[contractId] =
{ state: "succeeded" }` and `status: "completed"` in the SAME update
(`src/pge/nodes/sprint-review.ts`), so the branch arm already catches every contract the
new status arm would newly catch. The migration is therefore a **no-op for every run in
which `sprint_exit` ran**, and only widens the fallback for a `"completed"` contract that
has no `branchStatus` row at all.

**Test file:** `src/pge/runtime/commit.test.ts` (exists) — the split is covered at
`:565-579` ("splits contracts into completed and failed by status", uses `"passed"` /
`"failed"` literals) and `:596-598` (`completedContracts()` builds `status: "passed"`).
Both keep passing under a strict widening.

---

### `src/contracts/status-vocabulary.invariant.test.ts` (modify) — this is sc-7-3

**The two entries to DELETE, lines 204-213 (CURRENT — sprint 5 already re-edited this file):**

```ts
  {
    location: "src/pge/runtime/interpreter.ts:728",
    reason:
      "Graph-engine verdict computation over the sprintContracts channel; PGE writes 'completed' not 'passed', ...",
  },
  {
    location: "src/pge/runtime/commit.ts:539",
    reason:
      "Has its own documented rationale at :502-519 for why contract status alone still cannot decide ...",
  },
```

**Entries to KEEP (do not touch):** `:143-181` (§2 non-contract `.status` types),
`:184-188` (`src/state/history.ts:199`, the deliberate separate "Failed" row), and
`:214-228` — the three PGE **node** sites `sprint-curate.ts:271`, `sprint-generate.ts:141`,
`documenter.ts:84`. Those are out of scope (`estimatedFiles` names only runtime files).

**The bidirectional check, and how a stale entry fails it:**

```ts
// src/contracts/status-vocabulary.invariant.test.ts:258-270
  it("every ALLOWLIST entry corresponds to a REAL, currently-matching offender", async () => {
    // ... a stale allowlist entry for code that changed
    // or was removed would silently stop being checked. If this fails, either the code
    // moved (update the line number) or the code was migrated (delete the entry).
    const files = await realSourceFiles();
    const rawOffenders = findOffenders(files);
    const rawLocations = new Set(rawOffenders.map(locationOf));
    for (const { location } of ALLOWLIST) {
      expect(rawLocations.has(location), `stale allowlist entry: ${location} no longer matches`).toBe(true);
    }
  });
```
Direction 1 (`:272-277`, "no un-allowlisted offender exists") would fail if you migrated
nothing. Direction 2 (above) fails the moment you migrate a site and leave its entry:
`interpreter.ts:728` stops matching `OFFENDER_PATTERN` (`:71-72`) so
`rawLocations.has("src/pge/runtime/interpreter.ts:728")` is `false`. **You must do both
halves in the same change.**

**Line-shift safety check (already done for you):** no remaining ALLOWLIST entry points
into `interpreter.ts` or `commit.ts`, so adding an import line to either file shifts no
allowlisted location. Adding lines to `status-vocabulary.invariant.test.ts` itself is
harmless — `collectProductionTsFiles` skips `*.test.ts` (`:113`) and `__fixtures__/`
directories (`:111`).

**Optional strengthening — the "six migrated readers" test at `:279-300`.** It asserts, per
file, `findOffenders([...]) === []` **and** `content.toContain("isSettledContractStatus")`.
Both files satisfy both after migration (grep confirms `:728` / `:539` are the ONLY
matching lines in each; the prose mentions of `"passed"` at `commit.ts:504,507,509` are
`//` lines and `isCommentLine` (`:74-77`) skips them). Adding them is genuine positive
evidence and mirrors how `pipeline.ts` joined that list. **If you do, rename the test — it
says "six" and would become eight** — and update the prose at `:279-285`.

**Prose that becomes false and should be corrected (not test-enforced, but the DoD asks):**
- `:30-42` "five PGE runtime/node files (originally six...)" → three remain.
- `:190-203` §3 header block, which explains why the runtime files were deferred.
- `:50-55` cites `src/pge/nodes/sprint-review.ts:208` — the real line is now **:290**.
- `:197-203` cites `src/orchestrator/pipeline.ts:1052` — the real line is now **:1091**.

---

### `.bober/golden/` (re-capture, sc-7-4) — see §7 for the movement prediction

44 committed cases; **7 carry `enforcement: "replay"` and are the only ones EXECUTED**
(`src/pge/golden/gate.ts:37-46`, `src/pge/golden/runner.ts:552-562`). The other 37 are
`integrity` and make no runtime claim, so they cannot move.

Re-capture is `GOLDEN_CAPTURE=1` over `capture.test.ts`
(`src/pge/golden/capture.test.ts:63`, doc at `:27-30`):
```
GOLDEN_CAPTURE=1 npx vitest run src/pge/golden/capture.test.ts
```

---

## 2. Patterns to Follow

### Pattern: the settled-count migration, verbatim
**Source:** `src/state/history.ts:195-199`
```ts
    // "Passed" row: sprints that settled successfully (passed OR completed —
    // the two engines' words for the same outcome). "Failed" stays a
    // SEPARATE, literal count below ...
    const passed = contracts.filter((c) => isSettledContractStatus(c.status)).length;
```
**Rule:** a "how many settled well" count is `filter(c => isSettledContractStatus(c.status)).length` — never a literal.

### Pattern: the completed/failed split migration, verbatim
**Source:** `src/orchestrator/pipeline.ts:1091-1094`
```ts
      if (isSettledContractStatus(result.contract.status)) {
        completedSprints.push(result.contract);
      } else {
        failedSprints.push(result.contract);
```
**Rule:** the imperative engine's split is already the predicate; `commit.ts` becomes the same fact.

### Pattern: import shape when a file needs both the type and the predicate
**Source:** `src/orchestrator/pipeline.ts:16-17`
```ts
import type { SprintContract } from "../contracts/sprint-contract.js";
import { updateContractStatus, isSettledContractStatus } from "../contracts/sprint-contract.js";
```
**Rule:** two statements, `.js` extension, `consistent-type-imports` is an ESLint **error**.

### Pattern: a negative control that names its own mutation proof
**Source:** `src/pge/nodes/sprint-evaluate.test.ts:900-917` (added by sprint 5, commit `23a1718`)
```ts
    // MUTATION VERIFIED: deleting the destructure at :276-278 and changing
    // `...contractWithoutFeedback` to `...contract` at :279 makes this test FAIL — the seeded
    // string below survives onto `settled` because nothing else overrides it ...
    // Restoring the shipped code makes it pass again. The test above does not detect that
    // same mutation.
```
**Rule:** house style for "proves it fails before the change" is (1) run the new test
against the pre-change code in a disposable worktree, (2) record the exact mutation and its
outcome in the test's own comment, (3) say so in the commit body. Sprint 5's commit message
(`23a1718`) is the template: *"Verified in a disposable detached worktree: deleting X makes
the new test fail (all N other tests still pass); restoring the code makes it pass again."*

### Pattern: a fixture-graph mutation without touching the fixture
**Source:** `src/pge/runtime/__fixtures__/golden-graph.ts:570-577` + `:982-994`
```ts
  /**
   * Replace one node's body outright.
   *
   * The graph stays the SAME artifact — same checksum, same edges, same ports ...
   */
  handlerOverrides?: Readonly<Record<string, NodeImpl["handler"]>>;
```
**Rule:** to make the fixture settle contracts with the production word, override
`GOLDEN_NODES.sprintOut` (`= "gate_sprint_out"`, `:72`) rather than editing the fixture.
Its shipped body is `:868-886`:
```ts
        return {
          update: {
            branchStatus: { [key]: { state: "succeeded", attempts: 1 } },
            ...(contract === undefined ? {} : { sprintContracts: [{ ...contract, status: "passed" as const }] }),
          },
          goto: { kind: "parent" },
          output: { contractId: key, verdict: "pass", echo: input },
        };
```
(A documented `settledContractStatus?: ContractStatus` knob on `GoldenBehaviour` is an
equally house-style alternative — the interface at `:535-578` is a list of exactly such
knobs, each with a doc comment. Pick one; do not do both.)

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---|---|---|---|
| `isSettledContractStatus` | `src/contracts/sprint-contract.ts:101-103` | `(status: ContractStatus) => boolean` | **The predicate this sprint migrates to.** `SETTLED_CONTRACT_STATUSES.has(status)`. |
| `SETTLED_CONTRACT_STATUSES` | `src/contracts/sprint-contract.ts:69-72` | `ReadonlySet<ContractStatus>` | `new Set(["passed", "completed"])` — the whole semantic content. |
| `isTerminalContractStatus` | `src/contracts/sprint-contract.ts:116-118` | `(status: ContractStatus) => boolean` | "Is this sprint OVER" — settled **plus `"failed"`**. **NOT the one you want here.** |
| `TERMINAL_CONTRACT_STATUSES` | `src/contracts/sprint-contract.ts:84-87` | `ReadonlySet<ContractStatus>` | Built on top of the settled set so the two cannot drift. |
| `ContractStatusSchema` / `ContractStatus` | `src/contracts/sprint-contract.ts:38-49` | `z.enum([...9])` | The 9-member vocabulary; `"passed"` is still a legal value, just unwritten. |
| `runGolden` | `src/pge/runtime/__fixtures__/run-harness.ts:295` | `(options: RunGoldenOptions) => Promise<GoldenRun>` | Compiles + runs the golden fixture graph; returns `{ result, finalState, spans, handlerLog, ... }` (`:260-271`). |
| `goldenContracts` / `goldenContract` | `src/pge/runtime/__fixtures__/golden-graph.ts:513` / `:479` | `(n: number) => SprintContract[]` / `(input) => SprintContract` | Seeded contracts, `status: "in-progress"` (`:437`, `:487`). |
| `GOLDEN_NODES` | `src/pge/runtime/__fixtures__/golden-graph.ts:62-77` | `Record<string,string>` | Node ids for `handlerOverrides` / `specWithLoop`. |
| `findOffenders` | `src/contracts/status-vocabulary.invariant.test.ts:93-105` | `(files: SourceFile[]) => string[]` | Pure in-memory scan — the mutation controls drive it directly, never via disk. |
| `synthesizeBranchOutcomes` | `src/pge/runtime/graceful-failure.ts` (imported at `partial-failure.test.ts:13`) | `(branchStatus) => { branches, failed, winner }` | What `finalizeNode` uses to compute the DECLARED verdict (`src/pge/nodes/root.ts:730-740`). |
| `captureGoldenCase`, `goldenCaseJson` | `src/pge/golden/capture.ts` (imported at `capture.test.ts:14`) | — | The re-capture path behind `GOLDEN_CAPTURE=1`. |

**Directories reviewed for anything else applicable:** `src/utils/` (only `fs.ts`, `git.ts`,
`logger.ts`, `index.ts` — nothing status-related), and there is no `src/lib/`,
`src/shared/`, `src/helpers/` or `src/common/` in this repo. Nothing further applies.

---

## 4. Prior Sprint Output

### spec-20260812-terminal-vocabulary (the spec that created this defect's current shape)
- **Sprint 1** created `isSettledContractStatus` / `isTerminalContractStatus`
  (`src/contracts/sprint-contract.ts:69-118`) and the invariant scan
  (`src/contracts/status-vocabulary.invariant.test.ts`), migrating the five named readers.
- **Sprint 4** made the channel join rank-aware (`rankIsGreater`, `src/pge/registry/reducers.ts`),
  so `sprintContracts` now holds the **settled** copy, not the seeded `"proposed"` one. Without
  that, migrating `verdictFrom` would still count zero.
- **Sprint 5** flipped the imperative WRITER to `"completed"` and migrated its reader
  (`src/orchestrator/pipeline.ts:1091`), removing that entry from the allowlist. That is the
  precedent for what sc-7-3 asks: **migrate the site and delete its entry in one step.**
  It also deliberately deferred these two runtime sites under its own sc-5-4 stop condition
  (`docs/sprints/sprint-spec-20260812-terminal-vocabulary-5.md:25-26`).

### spec-20260814-pge-full-convergence sprints 4-6 (this spec, today)
- **Sprint 4** added history emitters → shifted `sprint-curate.ts` `:254→:271`,
  `sprint-generate.ts` `:133→:141`, `documenter.ts` `:83→:84`; the allowlist reasons at
  `:217`, `:222`, `:227` record exactly that.
- **Sprint 5** re-edited the same allowlist for those shifts and set the mutation-control
  house style (`23a1718`).
- **Sprint 6** added `settledAttempts` to `runSprintCycle` and closed `contracts`. The
  divergence pin is now `["audits","pipelineResult"]`
  (`src/orchestrator/workflow/conformance.engines.test.ts:409-412`) with a both-directions
  guard at `:425-452`. **This sprint must not move that pin.**

**Connection to this sprint:** every prerequisite for making the counter live is already in
place. What remains is the literal itself.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- ESM everywhere, `.js` extensions on every relative import.
- `import type { ... }` — `consistent-type-imports` is an **error**.
- Tests collocated as `*.test.ts`; Vitest; tests run against the real project when practical.
- `tsc` strict, zero type errors and zero lint errors are hard gates.
- Section comments use `// ── Name ─────` box-drawing headers.
- Commits: `bober(sprint-N): description`.

### Architecture Decisions
- `.bober/architecture/arch-20260814-pge-full-convergence-adr-1.md` — sprint 3's ADR: fan-out
  checkpoints stay illegal, so `audits` is **permanently accepted** as divergent. Context
  only; nothing in it constrains this sprint.
- No ADR governs `verdictFrom`.

### Other Docs — claims this sprint FALSIFIES (must be rewritten)
- `docs/pge-graph.md:1367-1400` — the long "One graph-runtime reader was deliberately NOT
  migrated, and it is a live defect" bullet. Its concrete claims ("`passed` is still zero",
  "a declared `failed` never softens to `partial`", "the site stays in the allowlist") all
  become false.
- `docs/pge-graph.md:1622-1628` — "`verdictFrom` ... is now structurally dead for BOTH
  engines ... its downgrade paths are unreachable ... (allowlisted at
  `src/contracts/status-vocabulary.invariant.test.ts:205-208`)". Both the claim and the
  citation die with this sprint.
- `docs/sprints/sprint-spec-20260812-terminal-vocabulary-5.md:25-26,168` — the deferral
  table. Historical record; leave it, but the new sprint doc should say it is now closed.
- `docs/pge-graph.md:1632-1645` warns that stale `path:line` citations have bitten sprints
  3, 4, 5 and 6 and that **nothing in CI validates them**. Grep every citation you write.
- ⚠ `docs/` is currently dirty in the working tree and a documenter subagent is editing it
  concurrently. Coordinate before writing there.

---

## 6. Testing Patterns

**Runner:** vitest. **Assertions:** `expect`. **Mocks:** real fixtures + injected
collaborators; `vi.*` is rare in the PGE tree. **Naming:** `*.test.ts` collocated, plus
`src/pge/runtime/__tests__/*.invariant.test.ts` for cross-cutting invariant suites.

### The tests that ALREADY exercise the "dead" branches — and why they are not enough

**Source:** `src/pge/runtime/__tests__/partial-failure.test.ts:689-721`
```ts
  it("downgrades a run that ENDED at the failure terminal, when branches had passed", async () => {
    // The supervisor runs out of its declared rounds AFTER both sprints committed, so the
    // loop bound routes the run to the graceful terminal and `finalize` never executes.
    // `state.verdict` is therefore the terminal's own `"failed"` ...
    const run = await runGolden({ projectRoot: root, runId: RUN_ID, concurrency: 2, maxSupersteps: 40,
      spec: specWithLoop(GOLDEN_NODES.supervisor, { counterKey: "supervisorRounds", maxIterations: 2,
        onExhausted: GRACEFUL_FAILURE_NODE_ID }),
      behaviour: { contracts: goldenContracts(2) } });
    ...
    expect(run.finalState.sprintContracts.filter((c) => c.status === "passed")).toHaveLength(2);
    expect(run.finalState.verdict).toBe("failed");
    expect(run.result.verdict).toBe("partial");        // ← branch B, alive ONLY here
```
**This is branch B firing.** It passes today **only because the fixture writes the retired
word** at `golden-graph.ts:878`. Its negative control is `:723-744` ("does NOT downgrade a
run that ended at the terminal with nothing committed").

**So: the branches are covered by tests and unreachable in production simultaneously.** Say
that precisely in the sprint doc — "unreachable" is a claim about the shipped graph, not
about coverage.

### The sc-7-2 test to write

Take `:689-721` and add `handlerOverrides` for `GOLDEN_NODES.sprintOut` that writes
`status: "completed"` instead of `"passed"` (same `branchStatus` update, same `goto`, same
`output`), then assert `run.result.verdict === "partial"`.

- **Before the change:** `passed = 0` → guard B false → C returns the declared
  `"failed"` → **the test fails with `"failed"` received.** That is the discriminating
  proof sc-7-2 asks for.
- **After the change:** `passed = 2` → B fires → `"partial"`.
- Keep the mirrored negative control (nothing committed → still `"failed"`), so the test
  is not satisfied by a predicate that returns `true` for everything.
- Do **not** use the `interpreter.test.ts:505-526` StateBloat scenario as the control: with
  a `"completed"` override, `finalize` (`golden-graph.ts:925`) declares `"partial"` and
  branch C returns `"partial"` both before and after — non-discriminating.

Record the before/after in the test comment in the `MUTATION VERIFIED:` style of
`sprint-evaluate.test.ts:900-917`, and verify it in a disposable detached worktree, per the
sprint-5 precedent.

### Where NOT to put a status literal
`collectProductionTsFiles` (`status-vocabulary.invariant.test.ts:107-118`) skips
`node_modules`, `__fixtures__/` and any `*.test.ts`. A literal inside a new **production**
helper would trip the scan.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Golden replay cases — the sc-7-4 prediction, per case

All seven `replay-*.json` were opened and their `expected.artifacts` inspected. Two facts
drive the prediction:

1. **`verdict` is NOT a captured artifact.** The eleven collected fields are
   `CONFORMANCE_FIELDS` (`src/orchestrator/workflow/types.ts:68-80`): contracts, history,
   specs, evalResults, briefings, reviews, audits, progress, runState, completionMarker,
   pipelineResult. `verdict` is absent. The golden executor collects exactly those
   (`src/pge/golden/executor.ts:467-469, :521`), and `PgeEngine.run` never returns
   `result.verdict` (`src/pge/engine/pge-engine.ts:551-572`).
2. **`commit.ts`'s split is already decided by `branchStatus`** for every case where a
   contract settled, because `sprint_exit` writes both in one update.

| Case | terminal | contract status | `errors` present (⇒ `failures` non-empty) | run verdict BEFORE | run verdict AFTER | artifact move? |
|---|---|---|---|---|---|---|
| `replay-full-run-commit-approved` | `finalize` | `completed` | no | `success` (C, declared by `finalizeNode`) | `success` | **no** |
| `replay-full-run-evaluation-passes` | `graceful_failure` | `completed` | yes | `failed` (F) | **`partial`** (E) | **no** |
| `replay-plan-clarification-round` | `graceful_failure` | `completed` | yes | `failed` (F) | **`partial`** (E) | **no** |
| `replay-research-second-reflexion` | `graceful_failure` | `completed` | yes | `failed` (F) | **`partial`** (E) | **no** |
| `replay-research-reflexions-exhausted` | `graceful_failure` | `completed` | yes | `failed` (F) | **`partial`** (E) | **no** |
| `replay-full-run-evaluation-fails` | `graceful_failure` | `failed` | yes | `failed` (F) | `failed` (F) | **no** |
| `replay-plan-clarify-rounds-exhausted` | `graceful_failure` | *(no contracts)* | yes | `failed` (F) | `failed` (F) | **no** |

Supporting facts: `graceful_failure` writes **no verdict** — "It sets no verdict and no
phase: `finalize` owns the terminal verdict"
(`src/pge/nodes/supervisor.ts:220-227`, node body `:240-269`), and `verdict` is a scalar
with `finalize` as sole writer (`src/pge/topology/coding.graph.ts:261-269`). So
`state.verdict === "pending"` on six of seven cases, which is why branch F is what they hit
today.

**Predicted `git diff .bober/golden/` after re-capture: EMPTY.**
**Predicted real behaviour change: four runs stop reporting an in-memory `failed` for a run
that actually settled its sprint — exactly the defect the code comments at
`interpreter.ts:739-744` describe.**

⚠ **If the re-capture produces a non-empty diff, the stop condition has fired.** The
analysis above says it should not. Read the hunks before accepting anything; a moving
`pipelineResult.completedSprints` would mean a contract settled `"completed"` WITHOUT a
`succeeded` branchStatus row, which contradicts `sprint_exit`'s single update and needs
understanding, not re-capturing.

### Files That May Break

| File | Depends on | Risk | What to check |
|---|---|---|---|
| `src/pge/runtime/__tests__/partial-failure.test.ts` | `verdictFrom` (`:260,359,401,510,670,685,716,743,758`) | **high** | Its fixture writes `"passed"`; a **strict widening** keeps every assertion true. Confirm, don't assume. |
| `src/pge/runtime/interpreter.test.ts` | `verdictFrom` (`:169,457,524-525,563,616`) | medium | Same reasoning. `:457` (deadlock) has contracts stuck at `"in-progress"` → still 0. |
| `src/pge/runtime/interrupt.test.ts` | `run.result.verdict` (`:292`), `finalState.verdict` (several) | low | `finalState.verdict` is the CHANNEL, untouched by this sprint. |
| `src/pge/runtime/__tests__/cross-process-resume.invariant.test.ts` | `resume-child.ts:140` → `result.verdict` (`:157,159`) | medium | Expects `"success"`. Fixture writes `"passed"` → unchanged. |
| `src/pge/runtime/commit.test.ts` | `commit.ts:539` (`:439,565-579,596-598`) | medium | All use `"passed"`/`"failed"` literals → unchanged under widening. |
| `src/pge/golden/capture.test.ts`, `gate.test.ts`, `coverage.test.ts`, `dataset.test.ts` | committed `.bober/golden/` bytes | **high** | `capture.test.ts` re-captures and byte-compares on EVERY run; if artifacts move and you do not re-capture, it goes red. |
| `src/orchestrator/workflow/conformance.engines.test.ts` | both engines end-to-end | **high** | The divergence pin `["audits","pipelineResult"]` at `:409-412` must not move. |
| `src/contracts/status-vocabulary.invariant.test.ts` | both migrated sites | **high** | Fails in BOTH directions if the allowlist and the code disagree. |
| `src/contracts/sprint-contract.test.ts:219-265` | the predicate itself | low | Untouched — you are not changing the predicate. |
| `src/mcp/tools/sprint-corpus.test.ts` | `mcp/tools/*.ts` sources | low | Scans only the MCP tools; unaffected. |

### Existing Tests That Must Still Pass
- `src/pge/runtime/__tests__/partial-failure.test.ts` — the whole downgrade suite; `:689-721`
  is the closest living relative of your new test.
- `src/pge/runtime/interpreter.test.ts`, `interrupt.test.ts`, `commit.test.ts`.
- `src/pge/runtime/__tests__/cross-process-resume.invariant.test.ts` — spawns real child
  processes; slow, do not skip it.
- `src/contracts/status-vocabulary.invariant.test.ts` — all nine tests, both directions.
- `src/contracts/sprint-contract.test.ts` — the predicate's own semantics.
- `src/orchestrator/workflow/conformance.engines.test.ts` — 60s timeout, the divergence pin.
- `src/pge/golden/*.test.ts` — capture byte-comparison, gate, dataset bounds, coverage.

### Features That Could Be Affected
- **feat-5 (this sprint)** — the only feature that owns these sites.
- **The conformance flip decision** — `verdict` is not a conformance field, so this sprint
  does **not** change the divergence set. Say so explicitly rather than leaving it implied;
  sprint 6's record shows the harness must be RUN, not assumed.
- **`src/orchestrator/workflow/flusher.ts:76`** (`contractStatus === "passed"`) is the
  remaining known sibling defect. It is invisible to the scan by construction
  (`status-vocabulary.invariant.test.ts:44-49`) and **out of scope** — `estimatedFiles`
  does not name it. Do not fix it here; nonGoal 1 confines this sprint to which contracts
  are counted.
- **The MCP-tools-return-empty incident** (memory note: filter on `'passed'` against a
  corpus of 237 `completed` / 0 `passed` — I re-counted `.bober/contracts/` today: 237
  completed, 33 proposed, **0 passed**). Same root cause class, **already fixed**:
  `src/mcp/tools/sprint.ts:147` and `src/mcp/tools/eval.ts:140` both use
  `isSettledContractStatus`, pinned by `src/mcp/tools/sprint-corpus.test.ts:73-92`. Not live.

### Recommended Regression Checks
1. `npx vitest run --exclude '**/.claude/worktrees/**' --exclude '**/node_modules/**'` — a bare run picks up nested worktrees.
2. `npx vitest run src/contracts/status-vocabulary.invariant.test.ts` — expect all green, and confirm `ALLOWLIST.length` dropped by exactly 2.
3. `npx vitest run src/pge/runtime src/pge/golden src/orchestrator/workflow/conformance.engines.test.ts`
4. `GOLDEN_CAPTURE=1 npx vitest run src/pge/golden/capture.test.ts` then `git diff --stat .bober/golden/` — **expect empty** (§7). If not, read every hunk and re-derive the prediction before committing.
5. `npm run build && node scripts/run-golden-regression.mjs` — expect 7/7 replay, exit 0.
6. `npm run typecheck && npm run typecheck:tests && npm run lint && npm run build`.
7. **Verify on a clean checkout** (`git stash -u` or a detached worktree at your commit) — this repo has twice been green locally and red in CI on uncommitted state.

---

## 8. Implementation Sequence

1. **`src/contracts/sprint-contract.ts`** — read only, change nothing. Confirm
   `SETTLED_CONTRACT_STATUSES = {"passed","completed"}` (`:69-72`) so you can state in the
   commit that the migration is a **strict widening**: every contract counted before is
   still counted; only `"completed"` is added. It cannot flip a verdict toward severity.
   - Verify: `npx vitest run src/contracts/sprint-contract.test.ts`.
2. **Write the sc-7-2 test FIRST, against unmodified code, and watch it fail.**
   In `src/pge/runtime/__tests__/partial-failure.test.ts`, mirroring `:689-721` with a
   `handlerOverrides[GOLDEN_NODES.sprintOut]` that settles `"completed"`.
   - Verify: it fails with `expected "partial", received "failed"`. Capture that output —
     it is the sc-7-2 evidence. Add the mirrored negative control now too.
3. **`src/pge/runtime/interpreter.ts:728`** — add the value import, migrate the counter.
   - Verify: `npx vitest run src/pge/runtime/interpreter.test.ts src/pge/runtime/__tests__/partial-failure.test.ts` — the new test now passes, all pre-existing ones still do.
4. **`src/pge/runtime/commit.ts:539`** — add the value import next to the existing type
   import, migrate the predicate, and rewrite the `:502-519` rationale block (it currently
   argues at length for NOT doing this — leaving it is a lie in a comment).
   - Verify: `npx vitest run src/pge/runtime/commit.test.ts`.
5. **`src/contracts/status-vocabulary.invariant.test.ts`** — delete the two ALLOWLIST
   entries at `:204-213`; optionally add both files to the migrated-readers list at
   `:286-293` (and rename "six"); correct the §3 prose at `:190-203` and the stale
   `sprint-review.ts:208` / `pipeline.ts:1052` citations at `:50-55` / `:197-203`.
   - Verify: `npx vitest run src/contracts/status-vocabulary.invariant.test.ts` — all nine green.
6. **Re-capture the golden dataset** — `GOLDEN_CAPTURE=1 npx vitest run src/pge/golden/capture.test.ts`, then `git diff .bober/golden/`.
   - Verify: **diff empty** per §7. If non-empty, STOP, read hunks, reconcile with the
     table before proceeding. Then re-run WITHOUT the flag and confirm it is byte-stable
     (the sprint-4/5 commits both asserted this).
7. **Run the conformance harness** — `npx vitest run src/orchestrator/workflow/conformance.engines.test.ts`.
   - Verify: pin still `["audits","pipelineResult"]`, `equivalent: false`. Do not assume — sprint 6's record exists because an assumption was wrong.
8. **Docs** — rewrite `docs/pge-graph.md:1367-1400` and `:1622-1628`; add
   `docs/sprints/sprint-spec-20260814-pge-full-convergence-7.md`; add the README row.
   Coordinate with the concurrent documenter; `docs/` is already dirty.
9. **Full verification** — `npx vitest run --exclude '**/.claude/worktrees/**' --exclude '**/node_modules/**'`, `npm run typecheck`, `npm run typecheck:tests`, `npm run lint`, `npm run build`, `node scripts/run-golden-regression.mjs`.
10. **Clean-checkout re-verify**, then commit as `bober(sprint-7): ...`.

---

## 9. Pitfalls & Warnings

- **The allowlist fails in BOTH directions.** Migrating a site without deleting its entry
  fails `:258-270`; deleting an entry without migrating fails `:272-277`. One change, both edits.
- **Do not migrate `src/pge/nodes/sprint-curate.ts:271`, `sprint-generate.ts:141` or
  `documenter.ts:84`.** They are allowlisted for a different sprint and are not in
  `estimatedFiles`. Touching them shifts lines and widens the blast radius for nothing.
- **Do not touch `src/orchestrator/workflow/flusher.ts:76`.** Known, documented, invisible
  to the scan, out of scope.
- **`isTerminalContractStatus` is the WRONG predicate.** It includes `"failed"`; using it at
  `interpreter.ts:728` would count failed sprints as passed and at `commit.ts:539` would put
  every failed sprint in `completedSprints`. The doc comments at
  `sprint-contract.ts:98-99` and `:111-114` warn about exactly this confusion.
- **`GraphRunResult.verdict` is read by tests and one fixture only** — `PgeEngine.run`
  ignores it (`pge-engine.ts:551-572`). Do not "fix" that here; wiring it into
  `PipelineResult` would change a shared, frozen five-key shape (sc-5-5) and move golden
  cases for real. Out of scope.
- **The golden fixture graph writes the retired word** (`golden-graph.ts:878`) and its
  `finalize` compares against it (`:925`). Both live under `__fixtures__/`, which the scan
  skips (`status-vocabulary.invariant.test.ts:111`). Migrating them is not required and
  would silently change many existing assertions. Leave them; override per-test instead.
- **A new literal in production code will trip the scan.** `OFFENDER_PATTERN` (`:71-72`)
  matches `.status === "passed"|"completed"|"failed"` and the reversed form, on any
  non-comment line of any non-test, non-fixture `src/**/*.ts`.
- **Every `path:line` you write in prose is unvalidated by CI** (`docs/pge-graph.md:1632-1645`).
  Four sprints in a row have shipped a stale one. Grep each citation before committing.
- **Nested worktrees poison a bare `npx vitest run`.** Always pass the two `--exclude` flags.
- **`docs/` is dirty and a documenter is editing it concurrently.** Do not clobber.
- **A verdict moving from `failed` to `partial` is CORRECT, not a regression.** A verdict
  moving toward MORE severity, or `"success"` appearing where a real failure was recorded,
  is the "looks wrong" signal the stop condition names — branch D requires
  `failures.length === 0`, so `"success"` can never be reached while a `TaskFailure` exists.
