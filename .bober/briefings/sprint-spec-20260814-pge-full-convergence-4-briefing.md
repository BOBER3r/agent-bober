# Sprint Briefing: history converges — the missing phase events

**Contract:** sprint-spec-20260814-pge-full-convergence-4
**Generated:** 2026-08-14T00:00:00Z

---

## 0. The gap, verified (do this first — sc-4-1)

The `generatorNotes` claim is CONFIRMED, run against the working tree:

```
$ grep -rn "appendHistory|history.jsonl" src/pge --include="*.ts" | grep -v ".test.ts" | wc -l
0
```

(the real command uses an escaped alternation; the count is what matters)

Zero PGE production files reference `appendHistory` or `history.jsonl`. The graph's ONLY
history line comes from `finalizePipelineRun`, reached through `CommitBoundary.finalize`
(`src/pge/runtime/commit.ts:550`).

**The two lists, pinned today** (`src/orchestrator/workflow/conformance.engines.test.ts:394-409`):

```ts
// -- 1. history: ten imperative phase events versus one shared terminal event --
expect((await loadHistory(tsRoot)).map((entry) => entry.event)).toEqual([
  "pipeline-start", "planning-complete", "curator-start", "curator-complete",
  "generator-start", "evaluator-start", "sprint-passed", "code-review-complete",
  "sprint-docs-complete", PIPELINE_COMPLETE_EVENT,
]);
expect((await loadHistory(pgeRoot)).map((entry) => entry.event)).toEqual([
  PIPELINE_COMPLETE_EVENT,
]);
```

### The ten events, in order, with the EXACT shape each writes

Every entry below was read from `src/orchestrator/pipeline.ts` at the cited line. `phase` and
`details` are **compared** by the harness — only `timestamp` is stripped (section 6). Getting a
`details` key wrong keeps `history` in the divergence set even when the event names match.

| # | event | phase | sprintId | details | imperative site | graph emitter (proposed) |
|---|-------|-------|----------|---------|-----------------|--------------------------|
| 1 | `pipeline-start` | `init` | — | `{ userPrompt: userPrompt.slice(0,200) }` | `pipeline.ts:798` | `research_body` (graph entry) or `PgeEngine.run` |
| 2 | `planning-complete` | `planning` | — | `{ specId, featureCount: spec.features.length }` | `pipeline.ts:996` | `plan_materialize` (end) |
| 3 | `curator-start` | `curating` | contractId | `{ title: contract.title }` | `pipeline.ts:260` | `sprint_curate_explain` (begin) |
| 4 | `curator-complete` | `curating` | contractId | `{ filesAnalyzed: <len>, patternsFound, utilsIdentified }` | `pipeline.ts:281` | `sprint_curate_explain` (after `curator.brief`) |
| 5 | `generator-start` | `generating` | contractId | `{ iteration }` | `pipeline.ts:387` | `sprint_generate` (begin) |
| 6 | `evaluator-start` | `evaluating` | contractId | `{ iteration }` | `pipeline.ts:461` | `sprint_evaluate` (begin) |
| 7 | `sprint-passed` | `complete` | contractId | `{ iteration, feedback: evaluation.summary, costUsd? }` | `pipeline.ts:596` | `sprint_evaluate` on pass — see section 9 |
| 8 | `code-review-complete` | `complete` | contractId | `{ critical: <len>, important: <len>, minor: <len> }` | `pipeline.ts:636` | `sprint_review` (after `reviewer.sprint`) |
| 9 | `sprint-docs-complete` | `complete` | contractId | `{ sprintDocPath, relatedDocsUpdated: <len>, concerns: <len> }` | `pipeline.ts:675` | `documenter` (after `documenter.summary`) |
| 10 | `pipeline-complete` | `complete` or `failed` | — | `{ completed, failed, durationMs }` | `finalize.ts:254` | ALREADY EMITTED — do not touch |

Events the imperative engine can write but which do NOT appear under `conformanceConfig()`
and must therefore NOT be emitted by the graph either (`whole-graph.ts:420-427` sets
`researchPhase: false`, no architect phase, security gate off):
`research-started`, `research-completed`, `architect-started`, `architect-checkpoint`,
`architect-completed`, `planning-needs-clarification`, `design-created`, `outline-created`,
`security-audit-blocked`, `security-audit-clean`, `evaluation-failed`, `code-review-failed`,
`sprint-docs-failed`. See section 11 pitfall 1 — the graph DOES run its research region.

---

## 1. Target Files

### `src/state/history.ts` (read only — do NOT modify; sc-4-4)

**Lines 27-46 — the schema every entry must satisfy:**
```ts
export const PhaseSchema = z.enum([
  "init", "planning", "curating", "generating", "evaluating", "rework", "complete", "failed",
]);
export type Phase = z.infer<typeof PhaseSchema>;

export const HistoryEntrySchema = z.object({
  timestamp: z.string().datetime(),
  event: z.string().min(1),
  phase: PhaseSchema,
  sprintId: z.string().optional(),
  details: z.record(z.string(), z.unknown()),
});
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;
```

**Lines 81-101 — THE existing path sc-4-4 requires:**
```ts
export async function appendHistory(
  projectRoot: string,
  entry: HistoryEntry,
): Promise<void> {
  const boberDir = join(projectRoot, BOBER_DIR);
  await ensureDir(boberDir);
  const validation = HistoryEntrySchema.safeParse(entry);
  if (!validation.success) { /* throws, naming the failing zod paths */ }
  const line = JSON.stringify(entry) + newline;
  await appendFile(historyPath(projectRoot), line, "utf-8");
  await rotateIfNeeded(projectRoot, 2000);   // hardcoded 2000; no loadConfig call
}
```

It is a **plain exported async function** taking `(projectRoot, entry)`. There is no DI, no
context object, no engine coupling — every caller imports it directly
(`pipeline.ts:59`, `finalize.ts:41` via `../state/index.js`, `workflow/flusher.ts:18`,
`evaluator-agent.ts:20`, `graph/preflight-injector.ts:24`). **sc-4-4 is satisfied by
calling THIS function.** Do not add a second writer, a second file, or a `historyEvents`
channel a reader would have to merge.

**Imported by (production call sites):** `src/orchestrator/pipeline.ts` (ten in the fixture
path), `src/orchestrator/finalize.ts:254`, `src/orchestrator/workflow/flusher.ts:96`,
`src/orchestrator/evaluator-agent.ts:187`, `src/cli/commands/sprint.ts:202`,
`src/mcp/tools/sprint.ts:184`, `src/graph/preflight-injector.ts:536`.
**Test file:** `src/state/history.test.ts` (exists).

---

### `src/pge/nodes/` (modify — the emitters)

Node bodies follow one shape. Real example, `src/pge/nodes/documenter.ts:107-146`:

```ts
handler: async (_input, state, ctx) => {
  const documented = documentedContracts(state);
  const contract = documented[documented.length - 1];
  if (contract === undefined) { /* early return; no effect invoked */ }

  const result = (await ctx.effects.invoke(
    EFFECTS.documenterSummary,
    { contract: { ... }, evaluation: provisionalEvaluation(ctx, { ... }), projectRoot: ctx.projectRoot },
    ctx,
  )) as z.infer<typeof DocumentationResultSchema>;

  const ref = await ctx.scratch.put(ctx.runId, "document", JSON.stringify(result));
  return {
    update: { messages: [note(ctx, "documented ...")],
              refs: { [DOCUMENTATION_REF_KEY]: ref }, ledger: [charge(ctx)] },
    phase: "complete",
    goto: { kind: "node", node: next },
    output: result,
  };
},
```

`ctx` (`NodeContext`, `src/pge/registry/nodes.ts:170-191`) carries `runId`, `projectRoot`,
`config`, `nodeId`, `branchKey`, `superstep`, `spanId`, `priv`, `declaredEffects`, `clock`,
`signal`, `effects`, `scratch`, `archive`, `cache`, `trace`, `ledger`, `prompts`, `models`.
**There is no history collaborator today.**

Nodes to touch, with what each already holds:

| node file | node id | already has | needs |
|---|---|---|---|
| `research.ts:181-196` | `research_body` | `state.featureRequest`, `ctx.projectRoot` | emit 1 |
| `plan.ts` (materialize handler; `phase: "planning"` at `:292`) | `plan_materialize` | the `PlanSpec` it persists | emit 2 |
| `sprint-curate.ts:226-271` | `sprint_curate_explain` | `contract`; the `SprintBriefing` from `EFFECTS.curatorBrief` (`:248-259`) | emit 3 before the invoke, 4 after |
| `sprint-generate.ts:195-237` | `sprint_generate` | `contract`, `iterationOf(state, id)` | emit 5 |
| `sprint-evaluate.ts:264-378` | `sprint_evaluate` | `contract`, `iteration`, RAW `result.summary` (`:341`) | emit 6 at entry, 7 on pass |
| `sprint-review.ts:114-147` | `sprint_review` | `review.critical/important/minor` (`:129-131`) | emit 8 |
| `documenter.ts:107-146` | `documenter` | `result.sprintDocPath`, `relatedDocsUpdated`, `concerns` | emit 9 |

---

### `src/pge/runtime/commit.ts` (read — likely NOT modified)

The module header states the design constraint you work against
(`src/pge/runtime/commit.ts:17-27`):

```
 * The commit boundary: the ONE place a superstep's work becomes state, and the ONE place
 * a `.bober/` domain artifact is written.
 * ...
 * Nodes return values; they do not write files, and they do not read a clock.
```

`DomainArtifactWriter` (`:227-238`) is that injected surface (`saveSpec`, `saveContract`),
and `finalize` (`:465-559`) is where `finalizePipelineRun` is called (`:550`). Routing history
here is a REAL option — but it cannot express "start event where the node BEGINS", because a
commit runs after every body in the superstep has already returned. See section 9.

---

### `src/orchestrator/workflow/conformance.engines.test.ts` (modify — sc-4-3)

Three blocks change.

**a. The divergence-set pin, `:366-372`:**
```ts
expect([...new Set(report.diffs.map((diff) => diff.field))].sort()).toEqual([
  "audits", "contracts", "history", "pipelineResult",
]);
expect(report.equivalent).toBe(false);
```
`history` comes OUT of that array. `report.equivalent` stays `false` (three fields remain),
which keeps `oracle-retention.test.ts:162-163` green.

**b. The ordered-list assertion, `:394-409`** — the `pgeRoot` expectation becomes the same ten
elements. The strongest form asserts it against the ts list itself, which is this file's own
idiom (`:512`, `:589`: "asserted against the other engine's own answer rather than against a
literal, so the claim pinned is the CONVERGENCE").

**c. The prose block `:267-333`** describes `history` as open work with a missing writer. It
becomes wrong and must be rewritten in the same commit — and it is checked by tests (section 8).

**Test file:** this IS the test file, and the sprint's primary verification surface.

---

### `.bober/golden/` (re-capture — sc-4-5)

Seven `replay`-enforced cases are EXECUTED by the blocking CI gate. Six pin exactly one
history entry; one pins zero:

| case | enforcement | `expected.artifacts.history` today |
|---|---|---|
| `replay-full-run-commit-approved` | replay | 1 |
| `replay-full-run-evaluation-fails` | replay | 1 |
| `replay-full-run-evaluation-passes` | replay | 1 |
| `replay-plan-clarification-round` | replay | 1 |
| `replay-plan-clarify-rounds-exhausted` | replay | **0** (never reaches `finalizePipelineRun`, `commit.ts:490-500`) |
| `replay-research-reflexions-exhausted` | replay | 1 |
| `replay-research-second-reflexion` | replay | 1 |

All seven will move. Shape of a pinned entry (`replay-full-run-evaluation-passes.json`):
```json
{ "details": { "completed": 1, "failed": 0 }, "event": "pipeline-complete", "phase": "complete" }
```
(no `timestamp`, no `durationMs` — already normalized; see section 6.)

**Re-capture command** (`src/pge/golden/capture.test.ts:27`, `:63`, `:292-295`):
```
GOLDEN_CAPTURE=1 npx vitest run src/pge/golden/capture.test.ts
```
`capture.test.ts:27-30`: "the resulting diff IS the statement 'the artifacts these runs
produce have changed, and here is how'. A recapture pushed without reading the diff defeats
the gate as surely as deleting it." — sc-4-5 says **read the hunks**.

Five INTEGRITY cases also carry a one-entry `history` block
(`commit-approved-writes-commit-object`, `finalize-reports-failed-run`,
`finalize-writes-marker-before-history-line`, `full-run-research-to-commit`,
`progress-document-is-rewritten-not-appended`). They are NOT executed
(`case-schema.ts:95-102`) so they will not fail the gate — but their prose goes stale. Record
which and why rather than silently leaving them; the precedent for that decision is the
sprint-5 entry for `spec-20260812-pge-real-workload-errors` in `docs/sprints/README.md`.

---

## 2. Patterns to Follow

### Pattern A — how the imperative engine writes an event
**Source:** `src/orchestrator/pipeline.ts:280-294`
```ts
      await appendHistory(projectRoot, {
        timestamp: new Date().toISOString(),
        event: "curator-complete",
        phase: "curating",
        sprintId: currentContract.contractId,
        details: {
          filesAnalyzed: briefing.filesAnalyzed.length,
          patternsFound: briefing.patternsFound,
          utilsIdentified: briefing.utilsIdentified,
        },
      });
```
**Rule:** one `await appendHistory(root, { ... })` per event, at the real boundary, with the
`details` keys reproduced EXACTLY.

### Pattern B — a node's clock is `ctx.clock`, never `new Date()`
**Source:** `src/pge/runtime/commit.ts:252-258`
```ts
/**
 * The runtime's clock.
 * This is the ONLY `new Date()` in the modules this boundary owns. Nodes read
 * `NodeContext.clock`, which is this object, so a replayed superstep handed a recorded
 * clock produces the recorded artifact.
 */
```
**Rule:** stamp `timestamp: ctx.clock.nowIso()`. A wall-clock stamp inside a node body breaks
replay determinism and the golden capture.

### Pattern C — a node reaching the outside world goes through `ctx.effects.invoke`
**Source:** `src/pge/nodes/effects.ts:44-52`
```
 * `EffectRegistry.invoke` re-checks the calling node's DECLARED `effects` array against
 * the effect's own tags at call time (`registry/effects.ts:147`), so an `fs-write` a node
 * did not declare in the committed artifact is refused however the node obtained the
 * registry.
```
**Rule and its consequence:** an effect def carrying `effects: ["fs-write"]` FAIL-CLOSES every
effect-free emitter. `research_body` (`coding.graph.ts:286`), `sprint_curate_explain` (`:589`)
and `sprint_review` (`:745`) all declare `effects: []`. **Do not route history through the
effect registry.** See section 11 pitfall 3.

### Pattern D — a node body may import from `src/state/`
**Source:** `src/pge/nodes/effects.ts:32`
```ts
import { listResearch, saveContract, saveResearch } from "../../state/index.js";
```
**Rule:** the `src/pge/nodes/**` ESLint boundary (`eslint.config.js:266-336`) forbids process
spawners, `src/graph/**`, `src/discovery/**`, dynamic `import()`, `require()` and
`createRequire()` — **not** `src/state/`. Importing `appendHistory` from a node body, or from a
small `src/pge/runtime/` wrapper, lints clean today.

### Pattern E — the iteration number
**Source:** `src/pge/nodes/sprint-evaluate.ts:111-113`
```ts
export function iterationOf(state: Readonly<OverallState>, contractId: string): number {
  return state.evaluations.filter((entry) => entry.contractId === contractId).length + 1;
}
```
**Rule:** this is the graph's equivalent of the imperative `iteration`, already used by
`sprint_review` (`sprint-review.ts:119`). Use it for events 5 and 6. Do NOT read
`state.counters["sprintIterations:..."]` — the interpreter folds that increment in at COMMIT
time (`interpreter.ts:1315-1350`), so inside a body it reads one lower.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---|---|---|---|
| `appendHistory` | `src/state/history.ts:81` | `(projectRoot: string, entry: HistoryEntry) => Promise<void>` | THE history writer. Validates, appends one JSONL line, rotates at 2000 lines. |
| `HistoryEntrySchema` / `HistoryEntry` | `src/state/history.ts:39-46` | zod object | The entry shape. `details` required; `sprintId` optional. |
| `PhaseSchema` / `Phase` | `src/state/history.ts:27-37` | zod enum, eight values | Legal `phase` values. Already imported by `commit.ts:9-10` and `registry/nodes.ts:5`. |
| `loadHistory` | `src/state/history.ts:108` | `(projectRoot) => Promise<HistoryEntry[]>` | Archive + active, chronological. What the conformance test and harness read. |
| `loadRecentHistory` | `src/state/history.ts:136` | `(projectRoot, { limit }) => Promise<HistoryEntry[]>` | Active-log tail. |
| `finalizePipelineRun` | `src/orchestrator/finalize.ts:200` | `(args: FinalizePipelineRunArgs) => Promise<PipelineResult>` | Marker first, then `pipeline-complete`. Order pinned at `:183-199`. |
| `PIPELINE_COMPLETE_EVENT` | `src/orchestrator/finalize.ts` (imported at `conformance.engines.test.ts:65`) | `string` | The terminal event name. Never hardcode it. |
| `iterationOf` | `src/pge/nodes/sprint-evaluate.ts:111` | `(state, contractId) => number` | 1-based sprint iteration. |
| `sprintVerdict` | `src/pge/nodes/sprint-evaluate.ts:116` | `({ ctx, contract, iteration, verdict, summary }) => SprintVerdict` | Builds an `evaluations` entry. |
| `provisionalEvaluation` | `src/pge/nodes/sprint-evaluate.ts:166` | `(ctx, generated or null) => EvaluationRunResult` | Stand-in evaluation for downstream effects. |
| `resolveContract` / `requireContract` | `sprint-review.ts:115`, `sprint-generate.ts:203` | `(input, state, ctx) => SprintContract or null` | The branch's contract, from payload or channel. |
| `nodeSpecOf` / `soleSuccessor` / `portOf` / `gatePolicyOf` / `preconditionIssue` / `refuse` | `src/pge/nodes/gates.ts` | see file | Read declarations and routing off the artifact. |
| `note(ctx, text)` | per-file local, e.g. `documenter.ts:49-58` | `(ctx, string) => GraphMessage` | A `messages` channel entry. Each node file keeps its own copy — that is the existing convention. |
| `Clock` (`ctx.clock`) | `src/pge/registry/nodes.ts:38-42` | `{ now(); nowMs(); nowIso() }` | The only legal time source in a node. |
| `canonical` / `normalize` | `src/orchestrator/workflow/conformance.ts:113`, `:85` | `(value) => string` / `unknown` | Volatile-key stripping and key sorting. The golden layer imports these; never re-implement. |
| `collectRunArtifacts` | `src/orchestrator/workflow/conformance.ts:483` | `(projectRoot, pipelineResult?) => Promise<Record<ConformanceField, unknown[]>>` | The ONE artifact reader shared by the harness and the golden executor. |
| `createCommitBoundary` | `src/pge/runtime/commit.ts:328` | `(options) => CommitBoundary` | Per-run boundary. Memoises artifact bytes. |

**Directories reviewed:** `src/state/`, `src/utils/`, `src/pge/nodes/`, `src/pge/runtime/`,
`src/orchestrator/workflow/`. There is **no** existing history-emitting helper anywhere under
`src/pge/` — that absence is the sprint.

---

## 4. Prior Sprint Output

### Sprint 1 — "Checkpoints inside the sprint fan-out — the ADR decision"
**Created:** `.bober/architecture/arch-20260814-pge-full-convergence-adr-1.md`
**Connection:** the five in-fan-out checkpoint ids are permanently undeclarable
(`Checkpoint.interrupt` holds one pending interrupt; `grantScope`/`clearScope` are
branch-blind). **Relevance:** history events are NOT interrupts. Nothing in ADR-1 blocks a
per-branch history WRITE — the bar is about approval state, not about writes.

### Sprint 2 — "Gated effects execute under a durable approval"
**Created:** `withGoldenApproval` / `goldenApprovedConfig` (`src/pge/golden/executor.ts:152-161`,
`:390-412`) and `.bober/golden/replay-full-run-commit-approved.json`.
**Connection:** `commit` and `finalize` now execute. That case is one of the seven you re-capture.

### Sprint 3 — "audits converges — the full checkpoint trail"
**Modified:** `coding.graph.ts:513-526` (declared `post-sprint-contract` on `gate_plan_out`),
`conformance.engines.test.ts:411-500` and `:595-678`, `docs/pge-graph.md`.
**Connection:** `audits` stays pinned as RECOMMENDED FOR PERMANENT ACCEPTANCE. Your edit to
`:366-372` removes only `history`, leaving `["audits","contracts","pipelineResult"]`. Do not
disturb the sc-3-3 describe block at `:595`.

**The correction you must not undo:** the earlier "there is no curator node" ground was FALSE.
Two `role: "curator"` nodes exist — `sprint_curate_explain` (`coding.graph.ts:576`) and
`sprint_curate_mocks` (`:592`). `history` is UNBUILT, not blocked. Your sprint builds it.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- `:27` ESM everywhere, `.js` extensions on relative imports.
- `:31` "All mutable state (specs, contracts, handoffs, eval results, **history**) is stored as JSON files in `.bober/`."
- `:32` Unicode box-drawing section headers.
- `:35` `import type { ... }` is enforced.
- `:42` No sync filesystem ops.
- `:18-21` Zero type errors, zero lint errors, collocated `*.test.ts`.

### Architecture Decisions
- `.bober/architecture/arch-20260814-pge-full-convergence-adr-1.md` (sprint 1) — the fan-out
  interrupt bar. Cited by `docs/pge-graph.md` and pinned by `docs.test.ts:976-978`.
- `.bober/architecture/arch-20260805-pge-graph-engineering-adr-6.md` — the original
  `InterruptInsideFanOut` rule.
- ADR-3 (`arch-20260805-pge-graph-engineering-adr-3.md`) — routing by LABEL, not node id
  (`registry/nodes.ts:196-201`).
- **No ADR governs history emission.** If you add a node-facing collaborator, that is an
  architectural change worth an ADR under the same naming convention.

### `docs/pge-graph.md` — claims that become FALSE and must be rewritten in this commit
- `:1186` — "exactly **four** pinned divergent fields: `history`, `audits`, `contracts`, `pipelineResult`".
- `:1345-1364` — "`history` is therefore **OPEN WORK, not permanently accepted**" and the
  sentence containing "returns ZERO hits: no PGE node body".
- `:1446` — "`history` (point 1, corrected)" in the flip-bar list.
- `:170` — `finalize`'s node row stays true; do not edit it.

The same now-stale prose also lives in
`docs/sprints/sprint-spec-20260812-terminal-vocabulary-6.md` and
`docs/sprints/README.md:2723`, `:2735`.

---

## 6. How `history` is compared — the two DIFFERENT comparisons

You must satisfy both, and they are not the same comparison.

**(a) The harness (`report.diffs`) is ORDER-TOLERANT.**
`src/orchestrator/workflow/conformance.ts:164-176` builds a sort key from
`identity + canonical bytes` and sorts:
```ts
function keyedCollection(values, identityOf): KeyedCollection {
  const entries = values.map((value, index) => {
    const bytes = canonical(value);
    const identity = identityOf(value, index);
    return { key: identity + SEP + bytes, identity, bytes };   // SEP is a NUL in the source
  });
  entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { entries };
}
```
The `history` field's identity is `idIdentity("event")` (`conformance.ts:356-361`), so this is
a **multiset** equality over `{event, phase, sprintId, details}` after normalization.

**(b) The ordered pin is the test at `conformance.engines.test.ts:395-409`** — a positional
`toEqual` over `.map((e) => e.event)`. `evaluatorNotes` demands the ORDERED list; only
assertion (b) sees order.

**What normalization strips** (`conformance.ts:65-76`):
```ts
const VOLATILE_KEYS = new Set([
  "createdAt", "updatedAt", "startedAt", "completedAt", "timestamp",
  "duration", "runId", "totalCost", "durationMs", "approverId",
]);
```
`timestamp` and `durationMs` are free. **`event`, `phase`, `sprintId` and every other
`details` key are compared.** `conformance.ts:79-81` is explicit: "Not added, and named here
so a future reader can see the decision was made: `phase`, `event`, ... stripping it would
hide exactly the divergence this harness exists to find." Do NOT widen `VOLATILE_KEYS`.

Project-root strings inside `details` (for example `sprintDocPath`) are REDACTED, not stripped
(`conformance.ts:117-131`), so matching paths compare equal.

---

## 7. Testing Patterns

### Unit Test Pattern (node-level)
**Source:** `src/pge/nodes/sprint-curate.test.ts:1-31`, `:69-77`
```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CODING_GRAPH } from "../topology/coding.graph.js";
import { runSprint, sprintContractFixture, stubSprintBindings } from "./__fixtures__/sprint-harness.js";

let root = "";
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "bober-pge-curate-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
```
**Runner:** vitest. **Assertions:** `expect(...)`. **Mocks:** `vi.mock` at the module seam
(conformance test) or real bindings via `src/pge/nodes/__fixtures__/sprint-harness.ts`
(node tests) — real temp dirs, real `.bober/` writes, real interpreter.
**File naming:** `<name>.test.ts`. **Location:** collocated.

Structural facts are read off the artifact, never hardcoded — `sprint-curate.test.ts:50-53`:
"Every structural fact — the gate's declared `check`, its `gate.onFail` endpoint, the node
ids — is read off `CODING_GRAPH`, so a test that agreed with the implementation while both
disagreed with the artifact cannot pass."

House style: document the deliberate mutations the suite was run against and what each broke
(`sprint-curate.test.ts:57-64`). sc-4-3's "fails in both directions" is discharged in exactly
that idiom.

### The "fails in both directions" idiom — the template to copy
**Source:** `src/pge/golden/coverage.test.ts:311-354`
```ts
function missingAgainst(declared, spans) {
  const executed = executedNodeIdsFromSpans(spans);
  return declared.filter((id) => !executed.has(id)).sort();
}

it("a covered node losing its only ok span fails the pin unless NEVER_EXECUTED grows to match", () => {
  const declared = ["commit", "documenter"];
  const staleNeverExecuted: string[] = [];
  const before = missingAgainst(declared, [{ nodeId: "commit", status: "ok" }, { nodeId: "documenter", status: "ok" }]);
  expect(before).toEqual(staleNeverExecuted);
  const after = missingAgainst(declared, [{ nodeId: "commit", status: "interrupted" }, { nodeId: "documenter", status: "ok" }]);
  expect(after).not.toEqual(staleNeverExecuted);
  expect(after).toEqual(["commit"]);
});
```
**Rule:** prove both directions against a PURE function over synthetic input, so the claim is
not hostage to whichever statuses the real dataset happens to produce. For sc-4-3: a synthetic
diff list gaining `history` fails the new pin, and one in which a fourth field converged fails
it too.

### Integration Test Pattern (the sprint's main gate)
**Source:** `src/orchestrator/workflow/conformance.engines.test.ts:87-158` — frozen clock
(`vi.useFakeTimers({ toFake: ["Date"] })` with `FROZEN_ISO`), a fixed `RUN_ID`, a FRESH temp
root per engine from `projectRootFactory`, and the SHIPPED engine classes through `runnerFor`.
Per-test timeout `}, 60_000)`.

### Documentation-claim tests (these WILL fail — see section 8)
**Source:** `src/pge/topology/docs.test.ts:1255-1293`
```ts
it("finds ZERO appendHistory callers in src/pge today, and the doc's claim agrees", async () => {
  const files = await collectPgeSourceFiles(join(REPO_ROOT, "src", "pge"), REPO_ROOT);
  expect(files.length).toBeGreaterThan(50);
  expect(findAppendHistoryCallers(files), "src/pge now has an appendHistory call site ...").toEqual([]);
  expect(shippedDoc, "the doc must still state appendHistory returns zero hits under src/pge")
    .toContain("returns ZERO hits: no PGE node body");
});
```
The failure message names its own retirement condition. Rewriting it is the intended act, not
a workaround — but the replacement must stay two-directional (the writers exist AND the doc
says so), and the synthetic mutation control at `:1276-1285` must survive.

---

## 8. Impact Analysis — Affected Features, Files & Tests

### Files That May Break

| File | Depends on | Risk | What to check |
|---|---|---|---|
| `src/pge/topology/docs.test.ts:1256-1274` | zero `appendHistory` callers in `src/pge` | **certain failure** | Scans the real `src/pge` tree every run. ANY writer fails it. Rewrite the claim AND the doc sentence "returns ZERO hits: no PGE node body". |
| `src/pge/topology/docs.test.ts:920-941` | the doc naming four divergent fields | high | Requires the doc to contain `history`, `audits`, `contracts`, `pipelineResult` and to state `equivalent ... false`. Keep `history` mentioned (as CLOSED); `equivalent: false` remains true. |
| `src/pge/topology/docs.test.ts:949-981` and `:1136-1155` | the literals "OPEN WORK, not permanently accepted" and `sprint_curate_explain` | high | Exact-substring pins with negative controls. Editing the doc without editing these fails; editing these without editing the doc fails the negative control. |
| `src/orchestrator/workflow/oracle-retention.test.ts:156-167` | the SOURCE TEXT of the conformance test | medium | Requires `expect(report.equivalent).toBe(false)` and the substrings `history`/`audits`/`contracts`/`pipelineResult` to appear somewhere in the file. Prose mentions suffice; do not delete the word `history` entirely. |
| `.bober/golden/replay-*.json` (7 files) | executed artifacts including history | **certain change** | Re-capture with `GOLDEN_CAPTURE=1`; read every hunk. |
| `src/pge/golden/coverage.test.ts:143`, `:245`, `:259-260` | executed node set from the replay cases | medium | `NEVER_EXECUTED` must stay `["context_compact","critique","rework_route","synthesize"]`, coverage 40/44, ratio > 0.85. Emitting history must not change routing. |
| `src/pge/golden/gate.ts` and `scripts/run-golden-regression.mjs` | pass rate >= `GOLDEN_PASS_THRESHOLD=80` (`.github/workflows/ci.yml:104-106`) | high | Un-recaptured cases give 0/7 and the gate fails. Precedent: the sprint-5 entry for `spec-20260812-pge-real-workload-errors` (golden gate 0/5 until recapture). |
| `src/pge/engine/whole-graph.test.ts`, `src/pge/engine/real-workload.test.ts` | artifacts a whole-graph run leaves | medium | Any assertion counting `.bober/` writes or history lines. |
| `src/chat/completion-tailer.ts` and `completion-tailer.test.ts` | tails `history.jsonl` BY OFFSET | medium-high | The tailer remembers a history offset (`conformance.engines.test.ts:574-577`). Nine extra lines per graph run change what a poll sees. `conformance.engines.test.ts:568-591` (sc-13-3) asserts `seen.pge` equals `seen.ts` — verify it still does. |
| `src/chat/chat-session-completion.test.ts`, `src/mcp/event-stream.test.ts` | history consumers | medium | Same offset/shape concern. |
| `src/state/history-rotation.ts` | 2000-line rotation (`history.ts:100`) | low | Ten lines per run instead of one means rotation arrives roughly ten times sooner. Note it; do not change the constant. |
| `src/pge/runtime/replay.ts` and `replay.test.ts` | replayed runs | medium | History writes are NOT recorded effects, so a replay performs them for real into its throwaway root — which is what makes capture work. Confirm no replay assertion counts files. |
| `src/pge/lint-boundary.test.ts`, `eslint-boundary.test.ts` | the module-graph boundary | low | Scoped to `src/pge/topology/**` and `src/pge/nodes/**` spawner rules; `src/state/` imports are allowed (`nodes/effects.ts:32` proves it). |

### Existing Tests That Must Still Pass
- `src/orchestrator/workflow/conformance.engines.test.ts` — all five `it` blocks including sprint 3's sc-3-3 block at `:595`.
- `src/orchestrator/workflow/oracle-retention.test.ts` — the default engine stays `ts`.
- `src/orchestrator/workflow/conformance.test.ts` — harness unit tests (`normalize`, `keyedCollection`, the vacuity gate).
- `src/state/history.test.ts` — `appendHistory` validation and rotation.
- `src/orchestrator/finalize.test.ts` and `finalize.e2e.test.ts` — the pinned marker-then-history ORDER. Do not touch `finalize.ts`.
- `src/orchestrator/pipeline.test.ts` — the imperative event stream (nonGoal 1: it does not change).
- `src/pge/golden/{dataset,gate,executor,runner,capture,coverage,case-schema,workload}.test.ts`.
- `src/pge/nodes/{commit,plan,sprint-curate,sprint-evaluate,gates,supervisor,research,anchors}.test.ts`.
- `src/pge/{topology-invariants,zero-execution,audit-git-gate}.test.ts`, `src/pge/topology/docs.test.ts`.
- `src/chat/completion-tailer.test.ts`, `src/chat/chat-session-completion.test.ts`, `src/mcp/event-stream.test.ts`.

### Features That Could Be Affected
- **feat-6 "Every node executes"** — shares every node file. Verify `NEVER_EXECUTED` and the coverage ratio are unmoved.
- **feat-5 "contracts and pipelineResult converge"** — will touch `sprint_exit` and `sprint_evaluate`, the same files. Leave `evaluatorFeedback` / `generatorNotes` alone here.
- **feat-7 "The bar is satisfiable, and met"** — reads your divergence-set pin. Keep it an exact `toEqual`, never a `toContain`.
- **The chat completion layer** — `.bober/history.jsonl` is a live product surface, not a test fixture.

### Recommended Regression Checks
1. `npx vitest run --exclude '**/.claude/worktrees/**' --exclude '**/node_modules/**'` — full suite.
2. `npm run typecheck && npm run typecheck:tests && npm run lint && npm run build`.
3. `npx vitest run src/orchestrator/workflow/conformance.engines.test.ts` — if `history` still appears in `report.diffs`, read the printed `detail` string; it names the offending event identity.
4. `GOLDEN_CAPTURE=1 npx vitest run src/pge/golden/capture.test.ts` then `git diff .bober/golden/` — read EVERY hunk (sc-4-5).
5. `npm run build && GOLDEN_PASS_THRESHOLD=80 node scripts/run-golden-regression.mjs` — must report 7/7.
6. `node dist/cli/index.js pge validate --mode full` and `node dist/cli/index.js pge docs --check` — 0 diagnostics, 44 nodes.
7. `node dist/cli/index.js pge diff <base-artifact> .bober/topology/coding.json --require-version-bump` — expected EMPTY. This sprint should need NO topology change; if you are editing `coding.graph.ts`, re-read section 11 pitfall 3.
8. `npx vitest run src/pge/golden/coverage.test.ts` — still 40/44.
9. Re-run 1 and 2 on a CLEAN checkout (`git stash -u` or a fresh clone). This repo has twice been green locally and red in CI because uncommitted state carried the result.

---

## 9. Design Note — where the write goes (read before writing code)

Three candidate seams. All three call `appendHistory`, so all three satisfy sc-4-4. They
differ on the lifecycle question the evaluator will check.

**Option 1 — a thin runtime emitter imported by node bodies (RECOMMENDED).**
A new `src/pge/runtime/history.ts` exporting, for example,
`emitPhaseEvent(ctx: NodeContext, entry: Omit<HistoryEntry, "timestamp">): Promise<void>`,
which stamps `ctx.clock.nowIso()` and delegates to `appendHistory(ctx.projectRoot, ...)`.
- Emits at the TRUE boundary: `curator-start` can be written before `ctx.effects.invoke` runs.
- Lints clean (Pattern D). No topology change, no `NodeServices` change, no new channel, no
  `graphVersion` bump.
- Testable by pointing `ctx.projectRoot` at a temp root — the existing node-test idiom.
- Cost: it is a file write from a node body, which `commit.ts:17-27` says nodes do not do.
  State that in the module doc and explain why a history LOG is not a domain artifact
  reconstructible from state.

**Option 2 — a `history` collaborator on `NodeContext` / `NodeServices`.**
The cleanest injection story, and it mirrors `trace`, `ledger` and `archive`, which already
write files from node context WITHOUT an effect tag. Cost: `NodeServices`
(`src/pge/runtime/interpreter.ts:239-246`) is constructed at SEVEN sites — one production
(`src/pge/engine/pge-engine.ts:472`) and six fixtures
(`src/pge/nodes/__fixtures__/sprint-harness.ts:458`,
`src/pge/nodes/__fixtures__/region-harness.ts:416`, `src/pge/runtime/replay.test.ts:405`,
`src/pge/runtime/__fixtures__/run-harness.ts:322`,
`src/pge/runtime/__fixtures__/engram-graph.ts:594`,
`src/pge/runtime/__fixtures__/hitl-graph.ts:480`). A required field means editing all seven;
an optional one weakens the guarantee.

**Option 3 — a `historyEvents` channel flushed at the commit boundary. REJECTED, with reasons.**
- The commit runs AFTER every body in the superstep returned, so a "start" event would be
  written after the work it announces finished — the misrepresentation `evaluatorNotes` warns
  about, moved from run scope to superstep scope rather than removed.
- It costs a new `OverallState` key (16 to 17 against `OVERALL_STATE_KEY_BUDGET`,
  `src/pge/state/overall.ts:262`), a new channel declaration, a `graphVersion` bump, a
  changelog entry, and a re-capture of all seven cases for the version stamp alone — the
  `1.3.0` / `1.4.0` precedent recorded in `docs/pge-graph.md`.
- `details.feedback` is a free-form string no reducer merges meaningfully.

---

## 10. Implementation Sequence

1. **Record the mapping (sc-4-1) — BEFORE any code.** Run both engines and dump the two
   ordered lists. The table in section 0 is the mapping; commit it as a test-visible constant
   or as the doc block on the new module, so the record is a checked fact rather than a commit
   message. *Verify:* your ts list matches `conformance.engines.test.ts:395-406` exactly; your
   pge list is `[PIPELINE_COMPLETE_EVENT]`.
2. **`src/pge/runtime/history.ts`** (new) — the emitter of section 9 Option 1. Imports
   `appendHistory` and the `HistoryEntry` / `Phase` types from `../../state/history.js`. Export
   the event-name constants so no node hardcodes a string. *Verify:* `npm run typecheck`,
   `npm run lint`; a unit test writes into a temp root and `loadHistory` reads the entry back.
3. **`src/pge/nodes/research.ts`** (`research_body`, `:181-196`) — `pipeline-start`, phase
   `init`, `details: { userPrompt: state.featureRequest.slice(0, 200) }`. *Verify:* a
   whole-graph run's first history line is `pipeline-start`.
4. **`src/pge/nodes/plan.ts`** (`plan_materialize`) — `planning-complete`, phase `planning`,
   `details: { specId, featureCount }`. *Verify:* the ordered list is
   `[pipeline-start, planning-complete, pipeline-complete]`.
5. **`src/pge/nodes/sprint-curate.ts`** (`sprint_curate_explain`, `:226-271`) — `curator-start`
   BEFORE `ctx.effects.invoke(EFFECTS.curatorBrief, ...)` at `:248`, `curator-complete` after,
   from the returned briefing. Handle the cache-hit path (`:245-247`) where no briefing exists.
   *Verify:* both events present, in that order, carrying the three count keys.
6. **`src/pge/nodes/sprint-generate.ts`** (`sprint_generate`, `:195-237`) — `generator-start`,
   phase `generating`, `sprintId`, `details: { iteration: iterationOf(state, contract.contractId) }`.
7. **`src/pge/nodes/sprint-evaluate.ts`** (`sprint_evaluate`) — `evaluator-start` at handler
   entry; `sprint-passed` on the passing return path, using the RAW `result.summary` (`:341`),
   NOT the decorated form.
8. **`src/pge/nodes/sprint-review.ts`** (`sprint_review`, `:114-147`) — `code-review-complete`
   after `EFFECTS.reviewerSprint` returns, from the three finding-array lengths (`:129-131`).
9. **`src/pge/nodes/documenter.ts`** (`documenter`, `:107-146`) — `sprint-docs-complete` after
   `EFFECTS.documenterSummary` returns (`:122-133`). Do NOT emit on the "nothing to document"
   early return (`:110-120`). *Verify after 3-9:* run the conformance test's third `it` and
   read the pge list; it must equal the ts list positionally.
10. **`src/orchestrator/workflow/conformance.engines.test.ts`** — drop `history` from
    `:366-372`; make `:407-409` assert the pge list equals the ts list; rewrite the `history`
    paragraph at `:269-289` to describe the CLOSURE (which node emits which event) with the
    same evidential density as its neighbours. *Verify:* `expect(report.equivalent).toBe(false)`
    still passes.
11. **The both-directions control (sc-4-3)** — a pure-function test in the
    `coverage.test.ts:311-354` idiom: a synthetic diff list gaining `history` fails the new
    pin, and one that also dropped a fourth field fails it too.
12. **`src/pge/topology/docs.test.ts:1255-1293`** — invert the zero-writer scan:
    `findAppendHistoryCallers` must now return a NON-empty, EXACT list of the writer file(s),
    and the doc must state the closure. Keep the mutation control at `:1276-1285`.
13. **`docs/pge-graph.md`** — rewrite `:1345-1364` and `:1446`. If the literal
    "OPEN WORK, not permanently accepted" no longer describes anything true, update
    `docs.test.ts:964-972` and `:1136-1147` in the SAME commit.
14. **Re-capture the golden dataset (sc-4-5)** —
    `GOLDEN_CAPTURE=1 npx vitest run src/pge/golden/capture.test.ts`, then
    `git diff .bober/golden/` and READ every hunk. Expect exactly the new history entries; a
    hunk touching `contracts`, `audits` or `pipelineResult` means you changed behaviour you
    did not intend to.
15. **Sprint doc** — `docs/sprints/sprint-spec-20260814-pge-full-convergence-4.md`, matching
    the depth of `-1.md` and `-2.md`, plus the `docs/sprints/README.md` row.
16. **Run full verification** — the nine checks in section 8, with check 9 on a CLEAN checkout.

---

## 11. Pitfalls & Warnings

1. **The graph runs RESEARCH; the ts fixture does not.** `coding.graph.ts:141` sets
   `entry: "research_body"`, and `conformanceConfig()` sets `researchPhase: false`
   (`whole-graph.ts:424`). Mapping `research-started` / `research-completed` onto
   `research_reflect` / `research_collect` gives the pge list two events the ts list lacks and
   `history` STAYS divergent. This is the sprint's stop condition in the flesh: those two
   events have no honest counterpart under this fixture — record which and why.
2. **`details` is compared.** `VOLATILE_KEYS` (`conformance.ts:65-76`) strips only `timestamp`
   and `durationMs` here. A `details: {}` where the imperative writes `{ iteration: 1 }` is a
   divergence. Do NOT add keys to `VOLATILE_KEYS` — `conformance.ts:79-81` forbids it by name.
3. **Do not route history through `ctx.effects.invoke`.** `registry/effects.ts:147-150`
   re-checks the node's DECLARED `effects` against the effect's tags. `research_body`
   (`coding.graph.ts:286`), `sprint_curate_explain` (`:589`) and `sprint_review` (`:745`) all
   declare `effects: []`. Tagging a history effect `fs-write` fail-closes all three; adding
   `fs-write` to their declarations is a topology change that also trips `CacheOnEffectfulNode`
   on `sprint_curate_explain` (which declares `cache` at `:590`) and forces a `graphVersion`
   bump plus a full re-capture. **This sprint should need no topology change.**
4. **`sprint-passed`'s `feedback` must be the RAW evaluation summary.** The graph decorates it:
   `sprint-evaluate.ts:341-343` writes `result.summary` plus a bracketed suite reason into the
   `evaluations` channel, while `pipeline.ts:600` writes `evaluation.summary` verbatim. Emit
   from inside `sprint_evaluate`, where `result.summary` is in scope — a `sprint_route`-based
   emitter can only see the decorated string.
5. **Order: `sprint-passed` BEFORE `code-review-complete`.** The imperative order is passed,
   review, docs (`pipeline.ts:596`, `:636`, `:675`). The graph routes `sprint_evaluate ->
   gate_anchor_regression -> sprint_route --pass--> sprint_review -> sprint_exit`
   (`coding.graph.ts:697-761`). Emitting `sprint-passed` from `sprint_exit` inverts the pair.
6. **`iteration` is NOT the loop counter.** The interpreter folds `counters` increments in at
   COMMIT time (`interpreter.ts:1315-1350`), so inside a body the committed counter reads one
   lower. Use `iterationOf(state, contractId)` (`sprint-evaluate.ts:111`).
7. **`ctx.clock.nowIso()`, never `new Date()`** (`commit.ts:252-258`). A wall-clock stamp in a
   node body makes the golden capture non-reproducible; `capture.test.ts:47-56` fakes only
   `Date`, and a node reading it directly would still be non-deterministic under replay.
8. **The cache path in `sprint_curate_explain`.** On a cache hit (`sprint-curate.ts:245-247`)
   `curator.brief` is never invoked and there is no `SprintBriefing` to read the three counts
   from. Decide deliberately — emit the pair only on the miss path, or emit with cached values
   — and say which, in a comment.
9. **`docs.test.ts:1256` fails the moment you add the first writer.** By design; its own failure
   message tells you to rewrite it. Do not silence it — replace it with the inverse claim and
   keep the synthetic mutation control.
10. **Do not touch `src/orchestrator/finalize.ts` or the imperative `pipeline.ts` events**
    (nonGoal 1). `finalize.ts:183-199` pins the emission ORDER — marker first, then the history
    line — and `finalize.test.ts` asserts the interleaving. Re-implementing that block, or
    adding a second `pipeline-complete`, strands the chat tailer.
11. **`.bober/golden/` is not hand-editable.** `case-schema.ts:89-93`: pins are CAPTURED from a
    real run, never hand-written; a hand-edited case throws `MissingRecordingError` at replay.
12. **The completion tailer reads by OFFSET.** Nine extra lines per graph run change what a poll
    returns. Re-run `conformance.engines.test.ts:568-591` (sc-13-3) explicitly.
13. **Run the suite with the worktree excludes** — `npx vitest run --exclude
    '**/.claude/worktrees/**' --exclude '**/node_modules/**'`; a bare run picks up nested
    worktrees.
14. **No raw control bytes in source** (`src/pge/registry/source-text.invariant.test.ts`) — spell
    any separator byte as a unicode escape, as `reducers.ts` and `frontier.ts` now do.
15. **`report.equivalent` must remain `false`.** `oracle-retention.test.ts:163` requires it and
    the spec's `outOfScope[0]` keeps the default engine `ts`. Closing `history` leaves three
    divergent fields, so this holds — do not relax the assertion.
16. **`sprint_curate_mocks` is NOT an emitter.** It is the second curator node
    (`coding.graph.ts:592`) and has no imperative counterpart event. The curator pair belongs
    to `sprint_curate_explain`, which is the node that calls `runCurator` via `EFFECTS.curatorBrief`.
