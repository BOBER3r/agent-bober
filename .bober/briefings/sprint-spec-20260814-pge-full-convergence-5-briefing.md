# Sprint Briefing: PGE writes evaluatorFeedback and generatorNotes

**Contract:** sprint-spec-20260814-pge-full-convergence-5
**Generated:** 2026-08-14T00:00:00Z
**Branch state:** sprint 4 landed today (`072f814..cf7595d`). Every line number below was read
from the CURRENT working tree, after that commit range.

---

## 0. The stopCondition, answered first

The contract's stop condition asks whether the graph genuinely has each field's information.
The honest answer, per field:

| Field | Does PGE have it? | Where it lives today | Verdict |
|---|---|---|---|
| `generatorNotes` | **YES** | `sprint_generate` offloads the WHOLE `GeneratorResult` (`{success, notes, filesChanged}`) to the scratch store and puts its `ScratchRef` in the `refs` channel under `generatorResultRefKey(contractId)` — `src/pge/nodes/sprint-generate.ts:236,245`. `sprint_evaluate` already reads it back (`readGeneratorResult`, `sprint-evaluate.ts:143-164`). | Reachable. No placeholder needed. |
| `evaluatorFeedback` | **YES, but NOT at `sprint_exit` as the code stands.** | The RAW `EvaluationRunResult.summary` exists only inside `sprint_evaluate`'s handler as `result.summary` (`sprint-evaluate.ts:345`). What reaches the `evaluations` channel is **decorated**: `` `${result.summary} [${decision.reason}]` `` (`sprint-evaluate.ts:375-378`). `sprint_exit`'s `branchOutcome` reads that decorated string (`sprint-review.ts:186-190`). | The VALUE is produced; it is not currently CARRIED to the settle node. A carrier must be added. |

**This is the sprint's whole technical problem.** Writing
`evaluatorFeedback = branchOutcome(...).summary` compiles, is non-empty, and is **WRONG** —
the imperative engine writes `evaluation.summary` verbatim (`pipeline.ts:592`), so pge would
write `all criteria met [low-risk-and-passing]` where ts writes `all criteria met`. The
evaluatorNotes call this out explicitly: *"a non-empty string that says something different is
still a divergence"*. Do not ship the decorated string.

The decoration is also **not reversible by stripping a suffix**: on the regression path the same
field carries `encodeAnchorRegression(...)` (`sprint-evaluate.ts:375-376`, `anchors.ts:209-212`)
and on the suite-failure path it carries the sandbox critique (`sprint-evaluate.ts:362`). Any
"strip the trailing ` [...]`" heuristic is the plausible-looking placeholder the contract forbids.

---

## 1. Target Files

### `src/orchestrator/pipeline.ts` (read-only reference — the source of truth)

**Do not change this file.** It is in `estimatedFiles` because the graph side must copy its
source expressions exactly. The four writes, all verified:

```ts
// pipeline.ts:395-400 — where the generator result is produced
const generatorResult = await runGenerator(injectedHandoff, projectRoot, config);
lastGeneratorResult = generatorResult;

// pipeline.ts:402-408 — generator FAILED: notes written, contract persisted, round retried
if (!generatorResult.success) {
  currentContract = { ...currentContract, generatorNotes: generatorResult.notes };
  await updateContract(projectRoot, currentContract);

// pipeline.ts:418-421 — generator failed at maxIterations (a LITERAL, not an evaluation)
  currentContract = { ...currentContract,
    evaluatorFeedback: "Generator failed to complete the implementation." };

// pipeline.ts:426-429 — generator SUCCEEDED: the only generatorNotes write on the happy path
currentContract = { ...currentContract, generatorNotes: generatorResult.notes };
```

```ts
// pipeline.ts:484-489 — where the evaluation is produced
const evaluation = await runEvaluatorAgent(evalHandoff, projectRoot, config);
lastEvaluation = evaluation;

// pipeline.ts:589-594 — PASS: status then feedback, then persisted
currentContract = updateContractStatus(currentContract, "completed");
currentContract = { ...currentContract, evaluatorFeedback: evaluation.summary };
await updateContract(projectRoot, currentContract);

// pipeline.ts:717-721 — FAIL: the SAME expression, rewritten every failing round
currentContract = { ...currentContract, evaluatorFeedback: evaluation.summary };
await updateContract(projectRoot, currentContract);
```

Also present, and deliberately **out of scope** (no graph analogue exists — see §9):
`pipeline.ts:520-525` writes `evaluatorFeedback` from `renderSecurityFeedback(...)` when the
security gate blocks.

**The exact expressions the graph must reproduce:**
- `evaluatorFeedback` := `evaluation.summary` — the RAW `EvaluationRunResult.summary`, undecorated.
- `generatorNotes` := `generatorResult.notes` — the RAW `GeneratorResult.notes`.

---

### `src/pge/nodes/sprint-review.ts` (modify) — the settle site

The contract says "lines 203-223". After sprint 4 the node is at **202-265**; the settled object
is built at **232-242**.

```ts
// sprint-review.ts:214-248 (current)
handler: async (input, state, ctx) => {
  const contract = resolveContract(input, state, ctx);          // reads state.sprintContracts
  if (contract === null) { throw new Error(/* ... */); }
  const refused = isNodeRefusal(input);
  const outcome = refused
    ? { settled: "failed" as const, summary: `admission refused: ${input.check}` }
    : branchOutcome(state, contract.contractId);                // <- DECORATED summary

  const attempts = Math.max(1, state.evaluations.filter(
    (entry) => entry.contractId === contract.contractId && entry.verdict !== "skipped").length);
  const settled: SprintContract = {
    ...contract,                                                // <- the SEEDED contract
    status: outcome.settled === "succeeded" ? "completed" : "failed",
    updatedAt: ctx.clock.nowIso(),
    version: attempts,
  };

  await ctx.effects.invoke(EFFECTS.sprintExit, { projectRoot: ctx.projectRoot, contract: settled }, ctx);
```

```ts
// sprint-review.ts:179-191 — what branchOutcome returns, and where its summary comes from
export function branchOutcome(state, contractId): { settled: BranchStatus["state"]; summary: string } {
  const decisive = state.evaluations.filter(
    (entry) => entry.contractId === contractId && entry.verdict !== "skipped");
  const last = decisive[decisive.length - 1];
  if (last === undefined) return { settled: "failed", summary: "the branch recorded no decisive verdict" };
  return { settled: last.verdict === "pass" ? "succeeded" : "failed", summary: last.summary };
}
```

**Imports this file uses:** `SprintContract` (`../../contracts/sprint-contract.js`),
`BranchStatus`/`GraphMessage`/`LedgerEntry`/`OverallState` (`../state/overall.js`),
`HISTORY_EVENT`/`emitPhaseEvent` (`../runtime/history.js`, new at sprint 4), `EFFECTS`
(`./effects.js`), `branchRecord`/`isNodeRefusal`/`nodeSpecOf`/`portOf`/`resolveContract`/
`soleSuccessor` (`./gates.js`), `iterationOf`/`provisionalEvaluation`/`sprintVerdict`
(`./sprint-evaluate.js`).

**Imported by:** `src/pge/registry/index.ts:56` (`sprintExitNode`, `sprintReviewNode`) — nothing else.

**Test file:** none co-located. `sprint_exit` is covered by
`src/pge/nodes/sprint-evaluate.test.ts:735-800` (see §6) and by
`src/orchestrator/workflow/conformance.engines.test.ts`.

---

### `src/pge/nodes/sprint-evaluate.ts` (modify) — the node that OWNS the evaluation

Not in `estimatedFiles`, but sc-5-3 forces it into scope: this is the only place the raw summary
exists.

```ts
// sprint-evaluate.ts:345-378 (current)
const result = evaluation.result;                                  // <- the EvaluationRunResult
const decision = selectVerification({ /* ... */ });
const suite = await runSelectedSuite(runtime, ctx, decision);
const trade = detectAnchorTrade(state.testAnchors, result);
const passed = result.passed && !trade.regressed && (suite?.passed ?? true);
const summary = trade.regressed
  ? encodeAnchorRegression(trade.broken, describeAnchorTrade(trade))
  : `${result.summary} [${decision.reason}]`;                      // <- DECORATION
```

```ts
// sprint-evaluate.ts:379-392 — sprint 4 already faced this exact problem and solved it by
// carrying the RAW value, with a comment saying why:
if (passed) {
  // The RAW `result.summary` — not the `summary` local above, which is decorated for
  // the `evaluations` channel. `pipeline.ts:600` writes `evaluation.summary` verbatim.
  await emitPhaseEvent(ctx, { event: HISTORY_EVENT.SPRINT_PASSED, /* ... */
    details: { iteration: generateAttemptsSoFar(state, ctx.branchKey), feedback: result.summary } });
}
```

```ts
// sprint-evaluate.ts:143-164 — reads a branch's generator result back. NOT EXPORTED today.
async function readGeneratorResult(state, ctx, contractId) {
  const ref = state.refs[generatorResultRefKey(contractId)];
  if (ref === undefined) return null;
  try { /* z.object({success, notes, filesChanged}).passthrough().safeParse(JSON.parse(await ctx.scratch.text(ref))) */ }
  catch { return null; }
}
```

`sprintVerdict(...)` — the single constructor for every `evaluations` entry — is at
`sprint-evaluate.ts:123-141` and parses through `SprintVerdictSchema`.

---

### `src/pge/state/overall.ts` (likely modify) — the carrier

```ts
// overall.ts:123-133
export const SprintVerdictSchema = z.object({
  id: z.string().min(1),
  seq: z.number().int().min(0),
  contractId: z.string().min(1),
  sprintNumber: z.number().int().min(1),
  iteration: z.number().int().min(1),
  verdict: SprintVerdictOutcomeSchema,
  summary: z.string(),
  evalId: z.string().nullable().default(null),
});
```

No `Exact<>` guard pins this shape (`overall.ts:287-299` guards `sprintContracts`, `spec`,
`specDraft` and the key set only), and `totalSchema` is a cast, not a strictness wrapper
(`src/contracts/problem-reflection.ts:105-107`) — so an OPTIONAL added field breaks neither
`tsc` nor `root.ts:342`'s `outputSchema`.

---

### `src/orchestrator/workflow/conformance.engines.test.ts` (modify) — sprint 4 just edited this

Lines **553-575** are the block sc-5-1/sc-5-2/sc-5-4 live in. The four lines that MUST flip:

```ts
// conformance.engines.test.ts:565-568 (current — these encode the gap this sprint closes)
expect(tsContract.evaluatorFeedback).toBeDefined();
expect(pgeContract.evaluatorFeedback).toBeUndefined();
expect(tsContract.generatorNotes).toBeDefined();
expect(pgeContract.generatorNotes).toBeUndefined();
```

The field-level divergence pin at **377-381** (`["audits","contracts","pipelineResult"]`) and its
both-directions control at **394-417** do **NOT** change: `version` still diverges, so
`contracts` stays in the set. Say so in the comment rather than leaving a reader to wonder.

---

### `.bober/golden/` (re-capture) — SIX of seven replay cases move

| Case | contracts | Moves? |
|---|---|---|
| `replay-full-run-evaluation-passes` | 1, `completed`, v1 | YES |
| `replay-full-run-evaluation-fails` | 1, `failed`, v2 | YES (multi-round — read this hunk hardest) |
| `replay-full-run-commit-approved` | 1, `completed`, v1 | YES |
| `replay-plan-clarification-round` | 1, `completed`, v1 | YES |
| `replay-research-second-reflexion` | 1, `completed`, v1 | YES |
| `replay-research-reflexions-exhausted` | 1, `completed`, v1 | YES |
| `replay-plan-clarify-rounds-exhausted` | **0** | **NO** — its `pinnedResponses` are `research.*`/`planner.draft`/`run.gracefulFailure` only; the sprint region never runs |

Each moving case changes in **three** places, not one:
`expected.artifacts.contracts[0]`, `expected.artifacts.pipelineResult[0].completedSprints[0]`
(or `.failedSprints[0]`), and the `pinnedResponses` entries whose `request` embeds the settled
contract — `sprint.exit` and `documenter.summary` (the documenter node runs AFTER `sprint_exit`).
`reviewer.sprint`'s pinned request must NOT move: `sprint_review` runs BEFORE the settle node.
That asymmetry is a useful correctness check on the diff.

The 37 `enforcement: "integrity"` cases are not executed by the gate
(`src/pge/golden/case-schema.ts:96-101`) and are not re-captured.

---

## 2. Patterns to Follow

### Pattern A — a node body may only touch its DECLARED channels

**Source:** `src/pge/nodes/sprint-correct.ts:28-40`
```ts
// `gate_syntax` declares `writes: ["branchStatus"]` and no output ports at all ...
// There is no runtime enforcement of a node's declared `writes` — writing `refs` from the
// syntax gate would WORK — but the artifact's channel writers are DERIVED from
// `nodes[].writes` (`topology/audit.ts:12,73`), so a node that wrote an undeclared channel
// would silently contradict the artifact that documents it. That is exactly the drift ADR-2
// exists to prevent.
```
Confirmed at `src/pge/topology/audit.ts:68-92` (`generateStateAudit` derives writers AND readers
from the artifact). The declarations that bind this sprint:

| Node | `reads` | `writes` | Source |
|---|---|---|---|
| `sprint_generate` | `spec, sprintContracts, messages, refs` | `messages, refs, branchStatus, ledger` | `coding.graph.ts:634-635` |
| `sprint_evaluate` | `sprintContracts, refs, messages` | `evaluations, messages, testAnchors, ledger` | `coding.graph.ts:678-679` |
| `sprint_review` | `refs, messages` | `messages, evaluations, ledger` | `coding.graph.ts:743-744` |
| `sprint_exit` | **`evaluations`** | `branchStatus, sprintContracts` | `coding.graph.ts:756-757` |

**Rule:** `sprint_evaluate` may read `refs` and write `evaluations`; `sprint_exit` may read
`evaluations` and write `sprintContracts`. That pair of facts is exactly enough to route both
values without touching the topology.

### Pattern B — carry the RAW value, and say in a comment that it is raw

**Source:** `src/pge/nodes/sprint-evaluate.ts:379-392` (quoted in §1). Sprint 4 hit the identical
decorated-vs-raw fork and resolved it by reading `result.summary` directly with a comment citing
the imperative line number. Do the same here; cite `pipeline.ts:592`.

### Pattern C — a widened `SprintVerdict` was considered before, and rejected on PROPORTIONALITY

**Source:** `src/pge/nodes/anchors.ts:179-196`
```
 * So the broken-anchor list rides in `summary`, in a shape the gate can decode. The
 * alternative — widening `SprintVerdictSchema`, or adding a channel — would change the
 * `evaluations` channel shape and the fifteen-key state budget for a fact that is local to
 * one edge. This is a finding about the artifact, not a design preference; it is written
 * down here so the next artifact revision can give the edge a port that says it.
```
**Rule:** engage with this note in the new code's doc comment. Its objection is that the anchor
fact is *local to one edge*; this sprint's fact must cross `sprint_evaluate` -> `gate_anchor_regression`
-> `sprint_route` -> `sprint_review` -> `sprint_exit`, which is what a channel is for. Widening
`SprintVerdictSchema` with an OPTIONAL field adds **no channel** and does not touch the fifteen-key
state budget (`overall.ts:26,299`), so the note's cost does not apply — but the reader must be
told that, not left to infer it.

### Pattern D — assert an engine's answer against the OTHER engine's answer, not a literal
**Source:** `src/orchestrator/workflow/conformance.engines.test.ts:558-564` — *"Asserted against
the OTHER engine's own answer, not a literal, so the claim pinned is the CONVERGENCE itself,
not merely that today's literal happens to be `completed`"*; the assertion itself is
`expect(tsContract.status).toBe(pgeContract.status)` (`:564`).
**Rule:** write `expect(pgeContract.evaluatorFeedback).toBe(tsContract.evaluatorFeedback)`, not
`expect(pgeContract.evaluatorFeedback).toBe("all criteria met")`.

### Pattern E — a pin must fail in BOTH directions, proved on synthetic input
**Source:** `src/pge/golden/coverage.test.ts:311-355`, reused at
`conformance.engines.test.ts:394-417`: a pure helper re-run over hand-built inputs, so the
control does not depend on what the real dataset happens to produce today.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---|---|---|---|
| `generatorResultRefKey` | `src/pge/nodes/sprint-generate.ts:66-68` | `(contractId: string): string` | The `refs` key a branch's generator result is offloaded under. **Exported.** |
| `readGeneratorResult` | `src/pge/nodes/sprint-evaluate.ts:143-164` | `(state, ctx, contractId) => Promise<GeneratorResult \| null>` | Reads that ref back through `ctx.scratch.text`, schema-checked, `null` on any failure. **NOT exported — export it rather than writing a second copy.** |
| `sprintVerdict` | `src/pge/nodes/sprint-evaluate.ts:123-141` | `({ctx, contract, iteration, verdict, summary, evalId?}) => SprintVerdict` | The ONE constructor for every `evaluations` entry; parses through `SprintVerdictSchema`. Extend here, not at call sites. |
| `branchOutcome` | `src/pge/nodes/sprint-review.ts:179-191` | `(state, contractId) => {settled, summary}` | Last non-`skipped` verdict for a branch. Already the right *selector*; its `summary` is the wrong *value*. |
| `resolveContract` | `src/pge/nodes/gates.ts:760-768` | `(input, state, ctx) => SprintContract \| null` | The contract this branch is about, from payload/state/branchKey. |
| `generateAttemptsSoFar` | `src/pge/nodes/gates.ts:252-260` | `(state, branchKey) => number` | Sprint 4's round counter. Not needed here, but read its doc comment before inventing any "iteration" number. |
| `emitPhaseEvent`, `HISTORY_EVENT` | `src/pge/runtime/history.ts:199,64` | `(ctx, entry) => Promise<void>` | Sprint 4's history emitter. **This sprint adds no history event** — `pipeline.ts` writes no history line for either field. |
| `canonical` | `src/orchestrator/workflow/conformance.ts:113-115` | `(value: unknown) => string` | Canonical bytes after volatile-key stripping + key sort. **Exported** — the right tool for sc-5-4's "version alone" assertion. |
| `normalize` / `VOLATILE_KEYS` | `src/orchestrator/workflow/conformance.ts:85-102, 65-76` | — | `createdAt`/`updatedAt`/`timestamp`/... are stripped before compare; `version` is deliberately NOT volatile. |
| `saveContract` | `src/state/sprint-state.ts:38-58` | `(projectRoot, contract) => Promise<void>` | The shipped writer both engines use; `DEFAULT_CONTRACT_WRITER` at `src/pge/nodes/effects.ts:878`. Runs a precision gate — see §9. |
| `stubGenerator` / `stubEvaluation` | `src/pge/nodes/__fixtures__/sprint-harness.ts:178-187, 196-225` | — | Notes are `` `generated ${contractId}` ``; `summary` is `"all criteria met"` / `"criteria failed"` (`:222`). |
| `stubSprintBindings` | `src/pge/nodes/__fixtures__/sprint-harness.ts:552-572` | `(overrides) => RegionBindings` | Accepts a `writeContract` override — the hook that captures the settled contract in a node test. |

Directories reviewed for this table: `src/pge/nodes/`, `src/pge/runtime/`, `src/pge/state/`,
`src/pge/registry/`, `src/orchestrator/workflow/`, `src/state/`, `src/contracts/`, `src/utils/`.

---

## 4. Prior Sprint Output

### Sprints 1-3 (brief)
**1** — `.bober/architecture/arch-20260814-pge-full-convergence-adr-1.md`: the precedent for
*recording* an unreachable convergence rather than faking one. **2** — `goldenApprovedConfig` /
`withGoldenApproval` (`src/pge/golden/executor.ts:152-161,390-412`) and
`replay-full-run-commit-approved.json`, one of the six cases to re-capture. **3** —
`post-sprint-contract` on `gate_plan_out`; `audits` stays pinned. None of the three is touched here.

### Sprint 4 — `history` converges (commits `072f814..cf7595d`)
**Created:** `src/pge/runtime/history.ts` (`emitPhaseEvent`, `HISTORY_EVENT`,
`HISTORY_EVENT_NODE_MAP`), `src/pge/runtime/history.test.ts`; `generateAttemptsSoFar` in
`gates.ts:252-260`; nine emitters in node bodies; `conformance.engines.test.ts` rewritten
(pin dropped to three fields, both-directions control added at `:394-417`); all seven golden
cases re-captured.
**Connection:** (1) `sprint-evaluate.ts:379-392` is the raw-vs-decorated precedent this sprint
follows; (2) sprint 4's commit sequence — *map first, wire second, flip the pin third,
re-capture fourth, docs fifth* — is the sequence to imitate (`39a2cbe`'s message is a model
re-capture commit message); (3) `docs/pge-graph.md`'s disposition and `docs.test.ts`'s
`assertFlipPrerequisitesStated` (`:950-1003`) were rewritten for `history` and are where the
`contracts` prose now needs the same treatment.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
ESM with `.js` extensions on every relative import (`:27`); `import type` enforced by
`consistent-type-imports` (`:35`); zero type errors and zero lint errors are hard gates
(`:18-19`); tests co-located as `*.test.ts` (`:20`); `// ── Section ──` headers (`:32`);
commits `bober(sprint-N): description` (`:34`).

### Architecture Decisions
- `.bober/architecture/arch-20260814-pge-full-convergence-adr-1.md` — sprint 1; explains why
  `audits` cannot converge. Not touched by this sprint; do not re-open.
- `arch-20260805-pge-graph-engineering-adr-2` — cited by `sprint-correct.ts:34` as the reason a
  node must not write an undeclared channel.
- No ADR is required by this sprint: the recommended design needs no topology change, hence no
  `graphVersion` bump and no changelog entry.

### Other docs that carry claims this sprint falsifies
- `docs/pge-graph.md:1224, 1232, 1238-1239, 1254-1256, 1334, 1466-1467` — every one of these says
  "the graph populates neither" / "PGE has no writer anywhere in `src/pge/`". All must be rewritten.
- `docs/sprints/README.md` — needs a row 5 (row 4 is the model for length and specificity).
- `docs/sprints/sprint-spec-20260814-pge-full-convergence-5.md` — new sprint record.
- `src/pge/topology/docs.test.ts:920-1003` — `assertDispositionCitesEvidence` and
  `assertFlipPrerequisitesStated` read `docs/pge-graph.md` from disk. They do **not** currently
  assert a zero-writer claim for these two fields (the only zero-writer scanner, `:1262-1281`, is
  about `appendHistory` and is unaffected) — so the docs edit will not break them, but a new
  doc claim must gain a test that fails when the claim stops being true (DoD).

---

## 6. Testing Patterns

**Runner:** vitest. **Assertions:** `expect`. **Mocks:** `vi.mock` (hoisted) + `vi.mocked(...)`.
**Naming:** `*.test.ts` co-located. **Run command (from generatorNotes — use it verbatim):**
`npx vitest run --exclude '**/.claude/worktrees/**' --exclude '**/node_modules/**'`

### Unit test pattern — node level, captures the settled contract
**Source:** `src/pge/nodes/sprint-evaluate.test.ts:735-800`
```ts
const contract = sprintContractFixture();
const persisted: string[] = [];
const versions: (number | undefined)[] = [];
const run = await runSprint({
  projectRoot: root,
  bindings: stubSprintBindings({
    writeContract: async (_projectRoot, written) => {
      persisted.push(`${written.contractId}:${written.status}`);
      versions.push(written.version);
    },
  }),
  contracts: [contract],
});
expect(run.result.status).toBe("completed");
expect(persisted).toEqual([`${contract.contractId}:completed`]);
expect(versions).toEqual([1]);
```
This is the template for **sc-5-1 / sc-5-2 / sc-5-3 at the node level**: capture the whole
`written` contract and assert
`written.generatorNotes === "generated " + contract.contractId` (the stub's own output,
`sprint-harness.ts:184`) and `written.evaluatorFeedback === "all criteria met"` (the stub's raw
summary, `sprint-harness.ts:222`) — **not** `"all criteria met [low-risk-and-passing]"`.

**sc-5-3's negative control belongs here too:** run with
`bindings: stubSprintBindings({ generator: stubGenerator([...], /* notes differ */) })` or with a
`contracts: [sprintContractFixture({ generatorNotes: "SEEDED — must not survive" })]` seed and
assert the written value is the PRODUCING NODE's, not the seed's. A seeded contract flows in
through `runSprint({ contracts })` -> the `sprintContracts` channel -> `resolveContract`
(`gates.ts:760-768`) -> `{ ...contract }` at `sprint-review.ts:233` — so an "echo" is exactly
what the spread already does, and only a differing seed can tell the two apart.

### Integration test pattern — two real engines, one fixture
**Source:** `src/orchestrator/workflow/conformance.engines.test.ts:433-436, 553-575`
```ts
const tsRoot = await projectRootFactory();
const tsResult = await runnerFor("ts")(tsRoot);
const pgeRoot = await projectRootFactory();
const pgeResult = await runnerFor("pge")(pgeRoot);
const tsContract = (await listContracts(tsRoot))[0];
const pgeContract = (await listContracts(pgeRoot))[0];
```
**sc-5-1/sc-5-2 here:** `expect(pgeContract.evaluatorFeedback).toBe(tsContract.evaluatorFeedback)`
plus `expect(tsContract.evaluatorFeedback).toBeDefined()` (so two `undefined`s cannot pass).

**sc-5-4, in this file's idiom** — a whole-object claim, so a delta nobody anticipated also fails:
```ts
const { version: _tsVersion, ...tsRest } = tsContract;
const { version: _pgeVersion, ...pgeRest } = pgeContract;
expect(canonical(pgeRest)).toBe(canonical(tsRest));   // canonical: conformance.ts:113
expect(tsContract.version).toBeUndefined();
expect(pgeContract.version).toBeDefined();
```
`canonical` already strips `createdAt`/`updatedAt` (`conformance.ts:65-76`), which is why this is
safe to compare byte-for-byte. Add the both-directions control in the `:394-417` idiom.

### Golden capture
**Source:** `src/pge/golden/capture.test.ts:27-30, 63`
```
GOLDEN_CAPTURE=1 npx vitest run src/pge/golden/capture.test.ts
```
> "the resulting diff IS the statement 'the artifacts these runs produce have changed, and here
> is how'. A recapture pushed without reading the diff defeats the gate as surely as deleting it."

Replay never compares recorded REQUESTS (`src/pge/runtime/replay.ts:363-366`), so the gate will
not fail on stale pinned requests — but `capture.test.ts` compares committed BYTES, so it will.
Re-capture is mandatory, and the commit message must read the hunks (sc-5-5). Floor:
`GOLDEN_MIN_REPLAY_CASES = 5` (`src/pge/golden/case-schema.ts:113-127`); the set is 7 and must stay 7.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files that may break
| File | Depends on | Risk | What to check |
|---|---|---|---|
| `src/pge/registry/index.ts:53,56` | `sprintExitNode`, `sprintEvaluateNode` | low | Signatures unchanged. |
| `src/pge/nodes/documenter.ts:10` | `provisionalEvaluation` from `sprint-evaluate.js` | low | Only if you move symbols between files. Its effect request embeds the contract, so its GOLDEN pinned request moves. |
| `src/pge/nodes/root.ts:342,373,440,487` | `SprintVerdictSchema` | medium | `totalSchema` is a cast (`problem-reflection.ts:105-107`); an OPTIONAL field is safe. A REQUIRED one breaks `safeParse` at `:440,:487` and `gates.ts:813,894`. |
| `src/pge/nodes/gates.ts:813,894` | `SprintVerdictSchema.safeParse(input)` | medium | Same: keep the new field optional. |
| `src/pge/runtime/commit.ts:450-457` | `state.sprintContracts` flush | medium | The commit boundary ALSO writes `.bober/contracts/`. Both writers must see the same object, i.e. the fields must be on the CHANNEL copy, not only in the effect request. |
| `src/pge/runtime/commit.ts:540-541` | `completedSprints`/`failedSprints` | medium | `pipelineResult` inherits the fields automatically. This is what makes sc-5-4 also reduce `pipelineResult`. |
| `.bober/golden/*.json` (6 replay cases) | captured artifacts | **high** | Re-capture; read every hunk. |

### Existing tests that must still pass
- `src/orchestrator/workflow/conformance.engines.test.ts` — **will fail at `:565-568` by design.**
  Everything else in it (the `:377-381` pin, the audits block, `pipelineResult`, the sc-3-3
  approved-run test) must stay green unchanged.
- `src/pge/nodes/sprint-evaluate.test.ts:735-800` (settled status/version) and `:802+`
  (replay-stable version) — must stay green; `version` semantics are sprint 6's business.
- `src/pge/nodes/sprint-evaluate.test.ts:338-341, 404-409` — assert the ANCHOR-REGRESSION encoding
  survives in `verdict.summary`. Do not change what `summary` carries.
- `src/pge/state/overall.test.ts:208-220` — `SprintVerdictSchema` round-trip; an optional field
  keeps it green (`expect(verdict.evalId).toBeNull()` still holds).
- `src/pge/golden/capture.test.ts` — fails until re-capture. `gate.test.ts`, `dataset.test.ts`,
  `coverage.test.ts` must stay green (no node's executed set changes).
- `src/pge/topology/docs.test.ts` — the artifact is unchanged under the recommended design, so
  every table test stays green; only the disposition prose moves.
- `src/orchestrator/pipeline.test.ts:406` — asserts the imperative `evaluatorFeedback`. It must
  stay green, which is the proof `pipeline.ts` was not edited.
- `src/pge/nodes/commit.test.ts`, `src/pge/runtime/interpreter.test.ts` — unaffected, but they
  execute whole runs; a StateBloatError regression would surface here.

### Features that could be affected
- **`pipelineResult` divergence (feat-6/sprint 6)** — shares `commit.ts:540-541`. After this
  sprint it reduces to `version` alone; do not claim it is CLOSED (it is not, until sprint 6).
- **Terminal vocabulary / `version` ranking** — shares `sprint-review.ts:232-242` and
  `registry/reducers.ts` `versionRank`. Do not touch `version`; sprint 5's nonGoal 1 forbids it.
- **Anchor regression gate** — shares `evaluations`/`SprintVerdict`. Its `summary` protocol
  (`anchors.ts:197-212`) must be left byte-identical.

### Recommended regression checks
1. `npx vitest run --exclude '**/.claude/worktrees/**' --exclude '**/node_modules/**'` — full suite.
2. `npm run typecheck && npm run typecheck:tests && npm run lint && npm run build`.
3. `GOLDEN_CAPTURE=1 npx vitest run src/pge/golden/capture.test.ts`, then
   `git diff .bober/golden/` — read every hunk; then re-run WITHOUT the flag and confirm the diff
   is empty (byte-stable capture).
4. `npx vitest run src/pge/golden/` — gate at 7/7, at or above the floor of 5.
5. `npx tsx src/cli/index.ts pge validate --mode full` and `pge docs --check` — must stay `ok`
   (44 nodes); `pge diff` against the pre-sprint artifact must be **empty** under the recommended
   design. A non-empty `pge diff` means you changed the topology and owe a `graphVersion` bump,
   a changelog entry and a docs-table update.
6. Verify on a **clean checkout / detached worktree**, not the working tree (generatorNotes:
   this repo has twice been green locally and red in CI because uncommitted state carried the result).

---

## 8. Implementation Sequence

1. **`src/pge/state/overall.ts`** — widen `SprintVerdictSchema` (`:123-133`) with ONE optional
   field carrying the raw evaluator summary (e.g. `feedback: z.string().optional()`), and a doc
   comment that engages with `anchors.ts:179-196` (why this is not that case).
   *Verify:* `npm run typecheck` and `npx vitest run src/pge/state/overall.test.ts` green.
2. **`src/pge/nodes/sprint-evaluate.ts`** — export `readGeneratorResult` (`:143-164`); extend
   `sprintVerdict` (`:123-141`) to accept the raw fields; at `:394-425` pass `result.summary`
   (RAW, per `:379-392`'s precedent) and the generator's `notes` (from the already-loaded
   `generated` at `:317`) onto the verdict this node emits. Leave the DECORATED `summary`
   (`:375-378`) exactly as it is.
   *Verify:* `npx vitest run src/pge/nodes/sprint-evaluate.test.ts` green, including the two
   anchor-regression assertions at `:338-341` and `:404-409`.
3. **`src/pge/nodes/sprint-review.ts`** — in `sprintExitNode` (`:214-248`), take the decisive
   verdict (the same filter `branchOutcome` at `:179-191` already uses) and write
   `evaluatorFeedback` / `generatorNotes` onto `settled` (`:232-242`) ONLY when the producing node
   supplied them. **No fallback string, no seeded echo, no decorated summary.** Update the file's
   header doc comment, which currently says nothing about these fields.
   *Verify:* new node-level tests (§6) pass; `persisted`/`written` carries both values.
4. **`src/orchestrator/workflow/conformance.engines.test.ts`** — flip `:565-568` to
   ts-vs-pge equality; add sc-5-4's `canonical`-based "version alone" assertion plus its
   both-directions control (`:394-417` idiom); rewrite the `contracts` and `pipelineResult`
   paragraphs at `:345-372`. Leave the field-level pin at `:377-381` UNCHANGED and say why.
   *Verify:* `npx vitest run src/orchestrator/workflow/conformance.engines.test.ts` green.
5. **Golden re-capture** — `GOLDEN_CAPTURE=1 npx vitest run src/pge/golden/capture.test.ts`;
   read the diff; commit it ALONE with a message that names what moved in each of the six cases
   and confirms `replay-plan-clarify-rounds-exhausted` did not (model: commit `39a2cbe`).
   *Verify:* re-run without the flag — clean; `npx vitest run src/pge/golden/` 7/7.
6. **Docs** — `docs/pge-graph.md` (`:1224,1232,1238-1239,1254-1256,1334,1466-1467`),
   `docs/sprints/README.md` row 5, and the new sprint record. Every added claim needs a test that
   fails when it stops being true (DoD) — extend `docs.test.ts`'s disposition assertions in the
   `:920-1003` idiom.
   *Verify:* `npx vitest run src/pge/topology/docs.test.ts` green.
7. **Full verification** — the six checks in §7.

---

## 9. Pitfalls & Warnings

1. **The decorated summary is the trap.** `branchOutcome(...).summary` is
   `` `${result.summary} [${decision.reason}]` `` (`sprint-evaluate.ts:375-378`), the
   anchor-regression encoding, or a sandbox critique. Using it satisfies "non-empty" and fails
   "matches". `pipeline.ts:592` writes `evaluation.summary` VERBATIM.
2. **Do not edit `pipeline.ts`.** It is the reference. `src/orchestrator/pipeline.test.ts:406`
   is the tripwire.
3. **Do not touch the topology.** `sprint_exit` declares `reads: ["evaluations"]`
   (`coding.graph.ts:756`). Reading `refs` there would work at runtime (there is no enforcement —
   `sprint-correct.ts:31`) but contradicts the derived state audit (`audit.ts:68-92`), and
   *changing* the declaration costs a `graphVersion` bump, a changelog entry, a docs-table update
   and a full golden re-capture for the version stamp alone — the exact cost sprint 4's
   `history.ts` doc comment (option 3) rejected. Route through `evaluations` instead.
4. **Keep the new verdict field OPTIONAL.** `gates.ts:813,894` and `root.ts:440,487` `safeParse`
   a `SprintVerdict` off a node INPUT; a required field would reject verdicts built elsewhere.
5. **Two writers persist the contract.** `sprint_exit`'s `sprint.exit` effect
   (`effects.ts:880-893` -> `saveContract`) and the commit boundary flushing the channel
   (`commit.ts:450-457`). Put the fields on the `settled` object that goes to BOTH
   (`sprint-review.ts:232-242, 258`), or the two copies will disagree.
6. **`saveContract` runs a precision gate that THROWS** (`sprint-state.ts:44-58`). It inspects
   `description`, `definitionOfDone`, `successCriteria`, `nonGoals`, `stopConditions`
   (`sprint-contract.ts:342-356`) — **not** these two fields. Safe, but do not route feedback into
   any of those fields.
7. **4096-byte channel budget.** Every update value is measured against its channel's
   `maxInlineBytes` at the commit boundary and REJECTED with `StateBloatError`
   (`commit.ts:388-400`); `evaluations` is 4096 (`coding.graph.ts:164-168`). A verdict already
   carries one copy of the summary; a second copy roughly doubles it. On the fixture this is
   tens of bytes, on a real evaluator it may not be — say so in a comment, and consider whether
   the raw copy should be the ONLY copy of that text on the fail path.
8. **The fail path has no imperative twin for two of `pipeline.ts`'s writes.**
   `pipeline.ts:418-421` ("Generator failed to complete the implementation.") and `:520-525`
   (security feedback) have no graph analogue — `sprint_generate` does not branch on
   `result.success`, and the security block routes to `sprint_correct`
   (`sprint-evaluate.ts:246-254`). Do NOT synthesise those strings. If the decisive verdict
   carries no raw feedback (fail-closed evaluator, `sprint-evaluate.ts:321-343`; refusal,
   `sprint-review.ts:221-224`), leave the field ABSENT — that is the honest answer and matches
   the contract's stop condition.
9. **`replay-full-run-evaluation-fails` is the hunk to read hardest.** It is the only multi-round
   case; it settles `failed` with `version: 2`, and it is the case that caught sprint 4's
   iteration defect. Whatever the fail path writes shows up there first.
10. **`sprint_review` runs BEFORE `sprint_exit`**, so the contract in `reviewer.sprint`'s pinned
    request must NOT gain the fields, while `documenter.summary`'s (after the settle) must. If
    both move, the fields are being written too early.
11. **Sprint 4's files changed TODAY.** Re-read `sprint-evaluate.ts`, `sprint-review.ts`,
    `gates.ts` and `conformance.engines.test.ts` before editing — every line number in the
    contract's `generatorNotes` predates that commit range.
