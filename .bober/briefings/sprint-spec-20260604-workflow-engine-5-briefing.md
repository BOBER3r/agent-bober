# Sprint Briefing: bober-pipeline.js workflow script and RunResultFlusher

**Contract:** sprint-spec-20260604-workflow-engine-5
**Generated:** 2026-06-04T00:00:00Z

---

## 0. Mission in One Paragraph

Two deliverables. (1) `.claude/workflows/bober-pipeline.js` — a **pure-JS, dormant** Dynamic-Workflows script (outside `src/`, NOT typechecked/linted) that orchestrates plan→curate→generate→panel→reconcile→retry via `agent({agentType})`, owns NO truth, does NO fs/`Date.now`/`Math.random`, skips completed sprints, chunks the panel ≤16, imports `reconcile` from `./lib/reconcile.js`, and returns a `WorkflowRunResult`. (2) `src/orchestrator/workflow/flusher.ts` — a host-side `RunResultFlusher.flush(projectRoot, config, result)` that is the **only clock source**, commits the `WorkflowRunResult` to durable `.bober/` (saveContract/updateContract, appendHistory, updateProgress), stamps ISO timestamps, flushes **after each contract** for crash-safety, and returns a `PipelineResult`. Live invoke is dormant — the script is parse-checked + its pure helpers unit-tested; the flusher is unit-tested with a synthetic `WorkflowRunResult` against a real temp `.bober`.

---

## 1. Target Files

### `.claude/workflows/bober-pipeline.js` (create)

**Directory pattern:** Only one sibling so far — `.claude/workflows/lib/reconcile.js` (pure ESM JS, no fs/clock). The new script lives one level UP at `.claude/workflows/bober-pipeline.js` and imports the port via `./lib/reconcile.js`.

**Scope confirmation (CRITICAL — this file is OUTSIDE the typechecked/linted tree):**
- `tsconfig.json`: `"include": ["src/**/*"]` — the script is not compiled by `tsc`.
- `package.json`: `"lint": "eslint src/"` — the script is not linted.
- So it is plain ESM JS. Verify only via `node --check` and/or a test import.

**Structure template (mirror `reconcile.js` header style + contract `generatorNotes`):**
```js
// ── bober-pipeline.js — Dynamic Workflows script (DORMANT this release) ──
// Pure-JS orchestrator: plan → curate → generate → panel → reconcile → retry.
// Owns NO truth. NO fs / Date.now / new Date / Math.random — host flusher stamps time.
import { reconcile } from "./lib/reconcile.js";

// C1 REQUIREMENT: meta must be a PURE LITERAL (no variables, no interpolation).
export const meta = {
  name: "bober-pipeline",
  description: "Bober plan→curate→generate→panel→reconcile→retry orchestration.",
  phases: [{ title: "Plan" }, { title: "Sprint" }],
};

// Pure, exported helpers (unit-testable without the live agent() runtime):
export function chunk(items, size) { /* split into groups of ≤ size (≤16) */ }
export function skipCompleted(contracts, completedSprintNumbers) { /* filter */ }
export function decideOutcome(reconciled, iteration, maxIterations) {
  // returns "passed" | "needs-rework" | "failed"
}

export async function main(args) {
  // PLAN
  const spec = await agent({ agentType: "bober-planner", model: args.models.planner /*, schema: PlanSpec*/ });
  if (spec.needsClarification) return { spec, perSprint: [], needsClarification: true, pendingHistory: [] };

  const perSprint = [];
  const pendingHistory = [];
  const contracts = skipCompleted(args.preloadedContracts, args.resumeCursor.completedSprintNumbers);

  for (const contract of contracts) {
    await agent({ agentType: "bober-curator", model: args.models.curator });
    let finalVerdict, lensVerdicts = [], iterationsUsed = 0, outcome = "failed";
    for (let iteration = 1; iteration <= args.knobs.maxIterations; iteration++) {
      iterationsUsed = iteration;
      await agent({ agentType: "bober-generator", model: args.models.generator });
      lensVerdicts = [];
      for (const group of chunk(args.evaluatorLenses, 16)) {           // ≤16 fan-out
        const verdicts = await parallel(group.map((lens) =>
          agent({ agentType: "bober-evaluator", model: args.models.evaluator /*, schema: EvalResult*/ })));
        lensVerdicts.push(...verdicts);
      }
      finalVerdict = reconcile(contract.contractId, iteration, lensVerdicts, "");  // "" placeholder — host re-stamps on flush
      if (finalVerdict.passed) { outcome = "passed"; break; }
      outcome = decideOutcome(finalVerdict, iteration, args.knobs.maxIterations);
    }
    perSprint.push({ contract, finalVerdict, iterationsUsed, outcome, lensVerdicts });
  }
  return { spec, perSprint, needsClarification: false, pendingHistory };
}
```
NOTE: `agent`, `parallel`, `pipeline`, `phase`, `log` are Dynamic-Workflows runtime globals — do NOT import them. They are dormant (never executed this release), so the test path must only exercise `meta` + the pure exported helpers (`chunk`, `skipCompleted`, `decideOutcome`).

---

### `src/orchestrator/workflow/flusher.ts` (create)

**Directory pattern:** Files in `src/orchestrator/workflow/` are kebab-case `.ts` with named exports, type-only imports via `import type`, and `.js` extension on all relative imports (ESM). See `args-builder.ts`, `reconciler.ts`, `resume-cursor.ts`.

**Most similar existing file:** `src/orchestrator/workflow/args-builder.ts` (a `class ArgsPayloadBuilder` host helper) for the class shape; `src/orchestrator/pipeline.ts:521-844` for the **exact write sequence** to mirror.

**Structure template:**
```ts
import type { BoberConfig } from "../../config/schema.js";
import type { SprintContract } from "../../contracts/sprint-contract.js";
import { updateContractStatus } from "../../contracts/sprint-contract.js";
import { saveContract, updateContract } from "../../state/sprint-state.js";
import { appendHistory, updateProgress } from "../../state/history.js";
import type { WorkflowRunResult } from "./types.js";
import type { PipelineResult } from "../pipeline.js";

export class RunResultFlusher {
  async flush(
    projectRoot: string,
    config: BoberConfig,
    result: WorkflowRunResult,
  ): Promise<PipelineResult> {
    const completedSprints: SprintContract[] = [];
    const failedSprints: SprintContract[] = [];
    const startTime = Date.now();           // duration only — NOT for stamping contracts

    for (const sprint of result.perSprint) {
      const status = sprint.outcome === "passed" ? "passed"
        : sprint.outcome === "needs-rework" ? "needs-rework" : "failed";
      // updateContractStatus stamps updatedAt + completedAt (host = ONLY clock source)
      const stamped = updateContractStatus(sprint.contract, status);
      await updateContract(projectRoot, stamped);   // saveContract under the hood; atomic per file

      for (const partial of result.pendingHistory) {
        await appendHistory(projectRoot, { ...partial, timestamp: new Date().toISOString() });
      }
      // flush AFTER EACH contract (crash-safety, C4) — updateProgress with cumulative contracts
      await updateProgress(projectRoot, [...completedSprints, ...failedSprints, stamped], result.spec);

      (status === "passed" ? completedSprints : failedSprints).push(stamped);
    }

    return {
      success: failedSprints.length === 0 && completedSprints.length > 0,
      spec: result.spec,
      completedSprints,
      failedSprints,
      duration: Date.now() - startTime,
    };
  }
}
```
WARNING: the template above appends ALL `pendingHistory` once per contract — that duplicates. Decide the partition strategy (e.g. pendingHistory entries carry `sprintId`, so filter per contract, OR append the whole `pendingHistory` ONCE after the loop). The contract requires **per-contract commit** of the CONTRACT write; reconcile the history-append placement so re-flushing does not duplicate beyond documented commit-by-message idempotency (C4). Pick one and document it.

**Imported by:** Nothing yet (sprint 6 wires `WorkflowEngine.run` → this). `PipelineResult` is exported from `src/orchestrator/pipeline.ts:62-76`.

**Test file:** `src/orchestrator/workflow/flusher.test.ts` (create), `script-helpers.test.ts` (create) — neither exists.

---

## 2. Patterns to Follow

### Pattern A — `PipelineResult` shape the flusher must return
**Source:** `src/orchestrator/pipeline.ts`, lines 62-76
```ts
export interface PipelineResult {
  success: boolean;
  spec: PlanSpec;
  completedSprints: SprintContract[];
  failedSprints: SprintContract[];
  totalCost?: number;
  duration: number;
  needsClarification?: boolean;
}
```
**Rule:** `flush` returns exactly this. `success = failedSprints.length === 0 && completedSprints.length > 0` (pipeline.ts:809-810). `duration = Date.now() - startTime` (pipeline.ts:808).

### Pattern B — TS pipeline's pass→commit write sequence (MIRROR THIS)
**Source:** `src/orchestrator/pipeline.ts`, lines 381-394 (the "passed" branch the flusher must reproduce)
```ts
currentContract = updateContractStatus(currentContract, "passed");
currentContract = { ...currentContract, evaluatorFeedback: evaluation.summary };
await updateContract(projectRoot, currentContract);
await appendHistory(projectRoot, {
  timestamp: new Date().toISOString(),
  event: "sprint-passed",
  phase: "complete",
  sprintId: currentContract.contractId,
  details: { iteration, feedback: evaluation.summary },
});
```
**Rule:** For byte-equivalent artifacts, set status via `updateContractStatus` (stamps `completedAt`), persist via `updateContract`, then `appendHistory`. The flusher is the *only* place `new Date().toISOString()` is called for the workflow engine (the script passes `""`).

### Pattern C — `updateContractStatus` stamps `completedAt` (reuse it, do not hand-roll)
**Source:** `src/contracts/sprint-contract.ts`, lines 205-226
```ts
export function updateContractStatus(contract, status) {
  const now = new Date().toISOString();
  const updates = { status, updatedAt: now };
  if (status === "in-progress" && !contract.startedAt) updates.startedAt = now;
  if ((status === "passed" || status === "failed" || status === "completed") && !contract.completedAt)
    updates.completedAt = now;
  return { ...contract, ...updates };
}
```
**Rule:** Stamp via this helper so flusher artifacts are byte-identical to the TS pipeline's. Valid status strings (sprint-contract.ts:38-48): `proposed | negotiating | agreed | in-progress | evaluating | passed | failed | needs-rework | completed`. Map outcome→status: `passed`→`"passed"`, `needs-rework`→`"needs-rework"`, `failed`→`"failed"`. NOTE: `updateContractStatus` only stamps `completedAt` for `passed|failed|completed` — `needs-rework` will NOT get a `completedAt`, matching pipeline.ts:491.

### Pattern D — Cross-boundary import of `.claude/` JS from a `src/` test (already proven)
**Source:** `src/orchestrator/workflow/reconcile-conformance.test.ts`, lines 2-3
```ts
import { reconcile as tsReconcile } from "./reconciler.js";
import { reconcile as jsReconcile } from "../../../.claude/workflows/lib/reconcile.js";
```
**Rule:** `script-helpers.test.ts` (in `src/orchestrator/workflow/`) imports the script with the SAME relative pattern: `import { meta, chunk, skipCompleted, decideOutcome } from "../../../.claude/workflows/bober-pipeline.js";`. This already compiles tsc-clean and lint-clean (the path crosses the boundary but the test file is in `src/`). To keep it clean: the script must export pure helpers + `meta` and must NOT reference runtime globals at module top-level (only inside `main`/helper bodies that the test never calls).

### Pattern E — Pure helper + literal echo (no clock/fs) is the house style for ported logic
**Source:** `.claude/workflows/lib/reconcile.js`, lines 14, 65-73 — `reconcile(...)` takes `timestamp` as an arg and echoes it; "No Date.now / new Date / Math.random / fs" (line 6). Mirror this discipline in `bober-pipeline.js`.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---|---|---|---|
| `saveContract` | `src/state/sprint-state.ts:38` | `(projectRoot, contract): Promise<void>` | Validate (schema + precision gate) and write `.bober/contracts/<id>.json` |
| `updateContract` | `src/state/sprint-state.ts:152` | `(projectRoot, contract): Promise<void>` | Alias of `saveContract` (overwrite same id) — flusher's per-contract write |
| `loadContract` | `src/state/sprint-state.ts:70` | `(projectRoot, id): Promise<SprintContract>` | Read back a contract (use in flusher test to assert stamped fields) |
| `listContracts` | `src/state/sprint-state.ts:113` | `(projectRoot): Promise<SprintContract[]>` | List saved contracts sorted |
| `appendHistory` | `src/state/history.ts:51` | `(projectRoot, entry: HistoryEntry): Promise<void>` | Append one validated JSONL line to `.bober/history.jsonl` |
| `loadHistory` | `src/state/history.ts:74` | `(projectRoot): Promise<HistoryEntry[]>` | Read all history (use in test to count appended lines) |
| `updateProgress` | `src/state/history.ts:108` | `(projectRoot, contracts: SprintContract[], spec: PlanSpec\|null): Promise<void>` | Rewrite `.bober/progress.md` from contracts+spec |
| `updateContractStatus` | `src/contracts/sprint-contract.ts:205` | `(contract, status): SprintContract` | Pure status transition stamping `updatedAt`/`completedAt` — flusher MUST reuse |
| `reconcile` (JS port) | `.claude/workflows/lib/reconcile.js:14` | `(sprintId, round, lensVerdicts, timestamp): EvalResult` | Pure panel majority-vote; script imports this |
| `ensureBoberDir` | `src/state/index.ts:96` | `(projectRoot): Promise<void>` | Create `.bober/` + subdirs (contracts/specs/...) before writes |

**Import-path note:** the TS pipeline imports state helpers via the **barrel** `src/state/index.js` (pipeline.ts:49-56: `saveContract, updateContract, appendHistory, ensureBoberDir`). `updateProgress` is exported from the barrel too (index.ts:28). The flusher MAY import from the barrel (`../../state/index.js`) to match pipeline.ts, OR direct from `sprint-state.js`/`history.js` — both are valid; barrel matches existing house style. `updateContractStatus` comes from `../../contracts/sprint-contract.js` (NOT the state barrel).

**Utilities reviewed:** `src/state/`, `src/contracts/`, `src/orchestrator/workflow/` — the above are all that apply. No generic `utils/`/`lib/` helper is needed (no chunk/group util exists in repo — `chunk` is a NEW pure helper to author inside the script).

---

## 4. Prior Sprint Output

### Sprint 3: JS reconcile port
**Created:** `.claude/workflows/lib/reconcile.js` — exports `reconcile(sprintId, round, lensVerdicts, timestamp)` (pure, no clock/fs).
**Connection:** The script imports it: `import { reconcile } from "./lib/reconcile.js";`. Conformance is gated by `src/orchestrator/workflow/reconcile-conformance.test.ts` (the cross-boundary import template reused in Pattern D).

### Sprint 4: workflow host types + helpers
**Created:** `src/orchestrator/workflow/types.ts` — `WorkflowArgs`, `WorkflowRunResult`, `ResumeCursor`, `ConformanceReport`. `errors.ts` — `WorkflowUnavailableError` (+ `MissingKnobError`, `AgentCapError`, `NonSerializableArgError`). `resume-cursor.ts`, `args-builder.ts` (`ArgsPayloadBuilder.build` derives `evaluatorLenses` from `config.evaluator.strategies`, caps lenses≤16 — args-builder.ts:89-101).
**Connection:** The flusher consumes `WorkflowRunResult` from `types.ts`. The script's `main(args)` consumes `WorkflowArgs` (`args.knobs.maxIterations`, `args.models.{planner,curator,generator,evaluator}`, `args.evaluatorLenses`, `args.resumeCursor.completedSprintNumbers`, `args.preloadedContracts`).

**Exact shapes the flusher consumes** (`src/orchestrator/workflow/types.ts:35-46`):
```ts
export type WorkflowRunResult = {
  spec: PlanSpec;
  perSprint: Array<{
    contract: SprintContract;
    finalVerdict: EvalResult;
    iterationsUsed: number;
    outcome: "passed" | "needs-rework" | "failed";
    lensVerdicts: EvalResult[];
  }>;
  needsClarification: boolean;
  pendingHistory: Array<Omit<HistoryEntry, "timestamp">>;   // host stamps timestamp on flush
};
```

---

## 5. Relevant Documentation

### Project Principles
Hard gates that apply (arch doc line 24): TS strict zero-error, ESLint zero-error, build via `tsc`, ESM `.js` import extensions, Zod config validation, **no synchronous fs**. The flusher (in `src/`) is bound by ALL of these; the script (outside `src/`) is bound only by "no fs/clock/random" (a contract non-goal, not a lint rule) and "parses as ESM".

### Architecture Decisions
**Source:** `.bober/architecture/arch-20260603-adopt-claude-code-dynamic-workflows-architecture.md`

POST-RUN host flush steps (lines 336-339, transcribed verbatim):
```
POST-RUN host flush:
  saveContract/updateContract (sprint-state.ts:38/:152), appendHistory (history.ts:51),
  updateProgress (history.ts:108), writeCompletionMarker, stamp ISO timestamps
  → CLI prints summary (run.ts:149-201)
```
NOTE: `writeCompletionMarker` is listed in the arch flush but is NOT required by this sprint's success criteria (C3 lists spec/contracts/history/progress only). Treat it as optional/deferred — do not block on it.

Script main() stage order (lines 324-334, transcribed):
```
Script main(args):
  PLAN  agent(bober-planner, schema: PlanSpec)        [parity pipeline.ts:626]
        if needsClarification → return early
  PER-CONTRACT (skip resumeCursor.completedSprintNumbers):
    CURATE   agent(bober-curator)                     [parity pipeline.ts:182]
    RETRY 1..maxIterations                            [mirrors pipeline.ts:212]:
      GENERATE agent(bober-generator)                 [parity pipeline.ts:283]
      PANEL    parallel per lens agent(bober-evaluator, schema: EvalResult)
               → EvaluatorPanelReconciler.reconcile
      if passed → break  else → feed feedback         [parity pipeline.ts:496]
  return WorkflowRunResult
```
**Invariant (line 369):** the script never owns truth — if `WorkflowRunResult` omits a fact, it did not happen per `.bober/`; resume re-derives from committed contract status, crash-safe at every flush.
**Crash-safety mitigation (line 376):** "flush after EACH contract, not once at end; idempotent commit-by-message; skip passed contracts."

### Other Docs
`HistoryEntry` schema (`src/state/history.ts:37-44`) — synthetic `pendingHistory` entries in the test must satisfy this AFTER the flusher stamps `timestamp`:
```ts
export const HistoryEntrySchema = z.object({
  timestamp: z.string().datetime(),                 // host adds this in flush
  event: z.string().min(1),
  phase: PhaseSchema,                               // init|planning|curating|generating|evaluating|rework|complete|failed
  sprintId: z.string().optional(),
  details: z.record(z.string(), z.unknown()),       // required (may be {})
});
```
So a `pendingHistory` entry (`Omit<HistoryEntry,"timestamp">`) needs at minimum: `event` (non-empty), `phase` (a valid PhaseSchema value), `details` (object). `appendHistory` re-validates and THROWS on an invalid entry (history.ts:58-64) — synthetic test entries must be valid post-stamp.

---

## 6. Testing Patterns

### Unit Test Pattern — real temp `.bober` dir (flusher.test.ts)
**Source:** `src/state/run-state.test.ts`, lines 8-44
```ts
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-flusher-test-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });
```
**Runner:** vitest. **Assertion style:** `expect(...).toBe / .toEqual / .toBeDefined`. **Mock approach:** none — real fs against the temp dir (preferred house style; see run-state.test.ts header "use a mkdtemp fixture"). **File naming:** co-located `*.test.ts`. **Location:** co-located beside source.

Flusher test must:
1. Build a synthetic `WorkflowRunResult` (use `createDefaultConfig("test","brownfield")` from `../../config/schema.js` for the `config` arg — see args-builder.test.ts:12,28). A valid `SprintContract` is required — note `saveContract` runs the **precision gate** (sprint-state.ts:51-60) and rejects placeholder/vague contracts, so the synthetic contract must have substantive `nonGoals`/`stopConditions`/`definitionOfDone` with NO banned vague phrases (sprint-contract.ts:22-34). Easiest: load this real contract as a template, or hand-build one mirroring it.
2. Call `flush(tmpDir, config, result)`; assert returned `PipelineResult` (`success`, `completedSprints` length, `duration` is a number).
3. `loadContract(tmpDir, id)` → assert `status === "passed"` and `completedAt` is a defined ISO string (C3).
4. `loadHistory(tmpDir)` → assert appended entries match `pendingHistory.length` (or your documented partition).
5. Assert `.bober/progress.md` exists and contains the contract title.
6. **C4 idempotency:** call `flush` AGAIN with the same result; assert `loadContract` still parses (no corruption) and `listContracts` length unchanged.

### Script-helper test (script-helpers.test.ts)
**Source pattern:** reconcile-conformance.test.ts:1-3 (cross-boundary import). Example:
```ts
import { describe, it, expect } from "vitest";
import { meta, chunk, skipCompleted, decideOutcome } from "../../../.claude/workflows/bober-pipeline.js";

it("meta is a pure literal", () => {
  expect(typeof meta).toBe("object");
  expect(meta.name).toBe("bober-pipeline");
  expect(Array.isArray(meta.phases)).toBe(true);
});
it("chunk never exceeds 16 (C2)", () => {
  const groups = chunk(Array.from({ length: 40 }, (_, i) => `lens${i}`), 16);
  for (const g of groups) expect(g.length).toBeLessThanOrEqual(16);
});
it("skipCompleted drops completed sprintNumbers (C2)", () => {
  const cs = [{ sprintNumber: 1 }, { sprintNumber: 2 }];
  expect(skipCompleted(cs, [1]).map((c) => c.sprintNumber)).toEqual([2]);
});
```
Importing the module also satisfies the C1 "parses as an ES module" check (no separate `node --check` needed, though the evaluator may run it).

### E2E Test Pattern
Not applicable — no Playwright surface for this sprint.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|---|---|---|---|
| (none) | `flusher.ts` | low | `flusher.ts` is a NEW file with no importers yet (sprint 6 wires it). Pure addition. |
| (none) | `bober-pipeline.js` | low | New script, dormant, not imported by `src/` runtime. Only the new test imports it. |

This sprint is almost entirely **additive** — no existing `src/` file is modified. `estimatedFiles` are all `create`. `stopConditions` require the diff be confined to the script, `flusher.ts`, and their tests.

### Existing Tests That Must Still Pass
- `src/orchestrator/workflow/reconcile-conformance.test.ts` — proves the cross-boundary `.claude/workflows/lib/reconcile.js` import compiles; your script-helpers test reuses the same pattern; ensure you don't break the `.claude/workflows/` layout.
- `src/orchestrator/workflow/args-builder.test.ts` / `resume-cursor.test.ts` / `selector.test.ts` / `reconciler.test.ts` — consume `types.ts`; you ONLY ADD a consumer (`flusher.ts`), no type change, so these stay green.
- Full suite via `npm run test` — evaluatorNotes tolerate only the "flaky tool-count baseline" (the graph cli tool-count test); everything else must be green.

### Features That Could Be Affected
- **feat-3 (workflow engine, this plan)** — sprint 6 (`WorkflowEngine.run` + eligibility) consumes both deliverables. Keep `flush`'s signature exactly `flush(projectRoot, config, result): Promise<PipelineResult>` (arch doc lines 86, 207-208) so sprint 6 wires cleanly. Do NOT implement `WorkflowEngine.run` here (non-goal).

### Recommended Regression Checks (run after implementation)
1. `node --check .claude/workflows/bober-pipeline.js` → exit 0 (C1 parse).
2. `grep -nE "Date\.now|new Date|Math\.random|require\(|node:fs|fs/promises" .claude/workflows/bober-pipeline.js` → NO matches (non-goal: no fs/clock/random in the script).
3. `npm run typecheck` → exit 0 (C5).
4. `npm run build` → exit 0 (C5).
5. `npm run lint` → exit 0 (C5; only `src/` is linted, so the script can't trip it).
6. `npm run test` → flusher + script-helper suites green; no new failures beyond the known flaky tool-count baseline (C5).
7. `git diff --name-only` → confined to the 4 estimatedFiles (stopCondition).

---

## 8. Implementation Sequence

1. **`.claude/workflows/bober-pipeline.js`** — author `export const meta` (pure literal), pure helpers `chunk(items,size)`, `skipCompleted(contracts,completedNums)`, `decideOutcome(reconciled,iter,max)`, and `async main(args)` using `agent`/`parallel` globals + imported `reconcile`. NO fs/clock/random.
   - Verify: `node --check .claude/workflows/bober-pipeline.js` exits 0; grep finds no `Date.now`/`new Date`/`Math.random`/`fs`.
2. **`src/orchestrator/workflow/flusher.ts`** — `class RunResultFlusher` with `flush`. Reuse `updateContractStatus`, `updateContract`/`saveContract`, `appendHistory`, `updateProgress`. Stamp `new Date().toISOString()` ONLY here. Loop per-contract; document the pendingHistory partition strategy (per-sprintId vs once). Return `PipelineResult`.
   - Verify: `npm run typecheck` + `npm run build` exit 0.
3. **`src/orchestrator/workflow/script-helpers.test.ts`** — import `meta` + pure helpers cross-boundary; assert `meta` literal, `chunk ≤16`, `skipCompleted` filtering, `decideOutcome` mapping.
   - Verify: suite green; cross-boundary import compiles tsc-clean.
4. **`src/orchestrator/workflow/flusher.test.ts`** — mkdtemp `.bober`; synthetic `WorkflowRunResult` (precision-clean contract + valid `pendingHistory`); assert written spec/contracts(+completedAt)/history/progress; re-flush idempotency (C4).
   - Verify: suite green; second flush leaves contract loadable, no duplicate corruption.
5. **Run full verification** — `npm run typecheck`, `npm run build`, `npm run lint`, `npm run test`.

---

## 9. Pitfalls & Warnings

- **meta MUST be a pure literal** (C1): no variables, no template interpolation, no spreads. `export const meta = { name: "...", description: "...", phases: [{title:"Plan"},{title:"Sprint"}] }`. The evaluator inspects this literally.
- **No fs/Date.now/new Date/Math.random in the script** (contract non-goal, evaluatorNotes greps for it). The script passes `""` (or an args sentinel) as the reconcile `timestamp`; the HOST flusher is the only clock. `reconcile.js` echoes the timestamp verbatim (reconcile.js:72), so `""` flows through and the flusher overwrites at flush time.
- **Panel chunk ≤16** (C2): the per-lens fan-out via `parallel` must be chunked so no single group exceeds 16. `args.evaluatorLenses` is already capped ≤16 by ArgsPayloadBuilder (args-builder.ts:99), but the script must STILL chunk defensively — the evaluator reads the loop for the ≤16 guarantee.
- **Skip completed sprints** (C2): filter `args.preloadedContracts` by `args.resumeCursor.completedSprintNumbers` BEFORE the per-contract loop. The evaluator reads the loop to confirm.
- **saveContract precision gate**: `saveContract` (and thus `updateContract`) THROWS on vague/placeholder contracts (sprint-state.ts:44-60, banned phrases sprint-contract.ts:22-34). Your synthetic test contract must be precision-clean or the flusher write throws. Avoid phrases like "works correctly", "looks good", "is correct".
- **`updateProgress` writes its OWN `Last updated:` timestamp** internally (history.ts:120) — that's fine and expected; it is not the contract/history clock and doesn't violate the "host is the only clock" rule (it IS the host).
- **`needs-rework` gets no `completedAt`**: `updateContractStatus` only stamps `completedAt` for `passed|failed|completed` (sprint-contract.ts:216-222). If you assert `completedAt` in tests, use a `passed` outcome.
- **Cross-boundary import path is exactly 3 `../`**: from `src/orchestrator/workflow/*.test.ts` → `../../../.claude/workflows/bober-pipeline.js` (matches reconcile-conformance.test.ts:3). Off-by-one on `../` will fail resolution.
- **Don't implement sprint-6 scope**: no `WorkflowEngine.run`, no eligibility wiring, no careful stage-split, no live `agent` dispatch (outOfScope). Keep diff to the 4 files.
- **`PipelineResult` is imported from `../pipeline.js`** (pipeline.ts:62) — importing it does NOT create a cycle for the flusher (flusher isn't imported by pipeline.ts yet), but `import type` it to be safe.
