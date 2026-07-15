# Sprint Briefing: Workflow types, ResumeCursorReconstructor, and ArgsPayloadBuilder

**Contract:** sprint-spec-20260604-workflow-engine-4
**Generated:** 2026-06-04T00:00:00Z

---

## 0. TL;DR for the Generator

Create six new files under `src/orchestrator/workflow/` (no edits to existing files):
1. `errors.ts` — four `extends Error` classes.
2. `types.ts` — `WorkflowArgs`, `WorkflowRunResult`, `ResumeCursor`, `ConformanceReport` (transcribed below, byte-for-byte).
3. `resume-cursor.ts` — `ResumeCursorReconstructor` class.
4. `args-builder.ts` — `ArgsPayloadBuilder` class.
5. `resume-cursor.test.ts` + `args-builder.test.ts` — Vitest, real temp dirs, no fs mocks.

All four frozen contract types already exist and are re-exported. Reuse them; do NOT redefine. ESM `.js` specifiers everywhere. `import type` for type-only imports.

---

## 1. Target Files

All six are **create** actions. Directory: `src/orchestrator/workflow/`. Naming is kebab-case `.ts`; tests are co-located `<name>.test.ts` (see `reconciler.test.ts`, `selector.test.ts`).

### src/orchestrator/workflow/errors.ts (create)

**Most similar pattern:** there is no existing `extends Error` file under `src/orchestrator/`. Use the standard Node pattern (set `this.name`). Define ALL FOUR even though `WorkflowUnavailableError` is unused this sprint (per generatorNotes — sprint 6 uses it):

```typescript
// ── Typed errors (host-side, build-time) ────────────────────────────

export class MissingKnobError extends Error {
  constructor(knob: string) {
    super(`Required workflow knob "${knob}" is unset; refusing to silently default.`);
    this.name = "MissingKnobError";
  }
}

export class AgentCapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentCapError";
  }
}

export class NonSerializableArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonSerializableArgError";
  }
}

export class WorkflowUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowUnavailableError";
  }
}
```

---

### src/orchestrator/workflow/types.ts (create)

Transcribe the architecture Data Model EXACTLY. Import the four frozen types via `import type` with ESM `.js` specifiers. From `src/orchestrator/workflow/`, the relative paths are:
- `PlanSpec` → `../../contracts/spec.js`
- `SprintContract` → `../../contracts/sprint-contract.js`
- `EvalResult` → `../../contracts/eval-result.js`
- `HistoryEntry` → `../../state/history.js` (NOTE: `HistoryEntry` lives in **state**, NOT contracts — generatorNotes hint about `../../contracts/...history` is wrong; the real home is `src/state/history.ts:44`)

```typescript
import type { PlanSpec } from "../../contracts/spec.js";
import type { SprintContract } from "../../contracts/sprint-contract.js";
import type { EvalResult } from "../../contracts/eval-result.js";
import type { HistoryEntry } from "../../state/history.js";

export type PipelineEngineName = "ts" | "skill" | "workflow"; // already in engine.ts:7 — re-export from there instead of redefining (see Pitfalls)

export type WorkflowArgs = {
  userPrompt: string;
  knobs: {
    maxIterations: number;
    maxSprints: number;
    researchPhase: boolean;
    architectPhase: boolean;
    curatorEnabled: boolean;
    codeReviewEnabled: boolean;
    requireContracts: boolean;
  };
  models: { planner: string; curator: string; generator: string; evaluator: string };
  evaluatorLenses: string[];
  principles: string;
  preloadedSpec?: PlanSpec;
  preloadedContracts: SprintContract[];
  resumeCursor: ResumeCursor;
};

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
  pendingHistory: Array<Omit<HistoryEntry, "timestamp">>;
};

export type ResumeCursor = {
  specId: string;
  completedSprintNumbers: number[];
  lastObservedSprintNumber: number;
};

export type ConformanceReport = {
  equivalent: boolean;
  diffs: Array<{
    artifact: "spec" | "contract" | "eval-result" | "history";
    path: string;
    engines: PipelineEngineName[];
  }>;
};
```

**Note:** `outcome` values `"passed" | "needs-rework" | "failed"` are a 3-value literal union local to `WorkflowRunResult` — they are NOT the `ContractStatus` enum. Do not import `ContractStatus` for this.

---

### src/orchestrator/workflow/resume-cursor.ts (create)

**Most similar existing file:** `src/orchestrator/workflow/reconciler.ts` (pure module + section headers). But this one IS allowed fs reads (it is host-side). Use `listContracts` + `loadHistory`.

```typescript
import { listContracts } from "../../state/sprint-state.js";
import { loadHistory } from "../../state/history.js";
import type { ResumeCursor } from "./types.js";

export class ResumeCursorReconstructor {
  async reconstruct(projectRoot: string, specId: string): Promise<ResumeCursor> {
    const contracts = (await listContracts(projectRoot)).filter(
      (c) => c.specId === specId,
    );
    await loadHistory(projectRoot); // corroborate only; contract status WINS on conflict
    const completed = contracts
      .filter((c) => c.status === "passed" || c.status === "completed")
      .map((c) => c.sprintNumber);
    const allNumbers = contracts.map((c) => c.sprintNumber);
    return {
      specId,
      completedSprintNumbers: [...completed].sort((a, b) => a - b),
      lastObservedSprintNumber: allNumbers.length ? Math.max(...allNumbers) : 0,
    };
  }
}
```

**Key facts (verified):**
- `listContracts(projectRoot): Promise<SprintContract[]>` (`sprint-state.ts:113`) returns ALL contracts sorted by filename, skipping invalid ones. There is NO load-by-spec helper — filter by `c.specId` in memory, exactly as `src/cli/commands/sprint.ts:138` filters `c.status === "passed"`.
- "completed" statuses are `"passed"` and `"completed"` — both are valid `ContractStatus` enum members (`sprint-contract.ts:38-48`).
- `loadHistory(projectRoot): Promise<HistoryEntry[]>` (`history.ts:74`) returns `[]` when the file is absent. With no history AND no contracts → `completedSprintNumbers: []`, `lastObservedSprintNumber: 0`.
- Contract status WINS over history on conflict (C2, architecture API row `resume`): derive `completedSprintNumbers` from contract status; history is corroboration only.

---

### src/orchestrator/workflow/args-builder.ts (create)

```typescript
import type { BoberConfig } from "../../config/schema.js";
import { MissingKnobError, AgentCapError, NonSerializableArgError } from "./errors.js";
import type { WorkflowArgs, ResumeCursor } from "./types.js";

export class ArgsPayloadBuilder {
  build(userPrompt: string, config: BoberConfig, resumeCursor: ResumeCursor): WorkflowArgs {
    // 1. pull required knobs; throw MissingKnobError if undefined (NO silent default)
    // 2. resolve models from config sections
    // 3. derive evaluatorLenses
    // 4. cap check (lenses > 16 || maxSprints * maxIterations * lenses.length > 1000)
    // 5. assemble args, then JSON round-trip serializability check
    // ...
  }
}
```

**Principles param:** keep `build` pure — accept `principles` from config or a param; do NOT read fs inside `build` (per generatorNotes & architecture risk row). The `WorkflowArgs.principles` field is a plain string the caller supplies. Simplest: add a 4th param `principles: string = ""` OR pull from config; do not call `readFile` in `build`.

---

## 2. Patterns to Follow

### Pattern: Module section headers (unicode box-drawing)
**Source:** `src/orchestrator/workflow/reconciler.ts:3`, `src/state/history.ts:9`
```typescript
// ── Reconciler ─────────────────────────────────────────────────────
```
**Rule:** Use `// ── Section ──...` headers (generatorNotes explicitly requires "unicode section headers").

### Pattern: ESM `.js` import specifiers + `import type`
**Source:** `src/orchestrator/workflow/selector.ts:1-5`
```typescript
import type { BoberConfig } from "../../config/schema.js";
import { logger } from "../../utils/logger.js";
import type { PipelineEngine, PipelineEngineName } from "./engine.js";
import { isWorkflowEligible } from "./eligibility.js";
```
**Rule:** Every relative import ends in `.js`; type-only imports use `import type`.

### Pattern: Pure reducer / class with no Date/Math/fs in pure modules
**Source:** `src/orchestrator/workflow/reconciler.ts:5-17`
**Rule:** `args-builder.ts` must be deterministic (no `Date.now`/`Math.random`) — it builds a serializable payload. `resume-cursor.ts` MAY do fs reads (host-side) via `listContracts`/`loadHistory`.

### Pattern: In-memory filter of a list helper by status/spec
**Source:** `src/cli/commands/sprint.ts:138-140`
```typescript
const completedContracts = contracts.filter(
  (c) => c.status === "passed",
);
```
**Rule:** There is no per-spec or per-status loader — load all via `listContracts`, then `.filter()`.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `listContracts` | `src/state/sprint-state.ts:113` | `(projectRoot: string): Promise<SprintContract[]>` | List all contracts (sorted, invalid skipped); filter by specId/status in memory. |
| `loadContract` | `src/state/sprint-state.ts:70` | `(projectRoot, id): Promise<SprintContract>` | Load+validate one contract by id (throws if missing). Not needed if using listContracts. |
| `loadHistory` | `src/state/history.ts:74` | `(projectRoot: string): Promise<HistoryEntry[]>` | Load JSONL history; returns `[]` if file absent. Use to corroborate cursor. |
| `appendHistory` | `src/state/history.ts:51` | `(projectRoot, entry): Promise<void>` | Append history (sprint 5 flush, NOT this sprint). |
| `ensureDir` | `src/state/helpers.ts` | `(dir): Promise<void>` | Used by state writers; tests can use it or raw mkdir. |
| `ContractStatus` type | `src/contracts/sprint-contract.ts:49` | enum: proposed/negotiating/agreed/in-progress/evaluating/**passed**/failed/needs-rework/**completed** | Status string source of truth. "Completed" = `passed`/`completed`. |
| `EvalResult` type | `src/contracts/eval-result.ts:76` | frozen Zod type | Reuse in `WorkflowRunResult`; do not redefine. |
| `PlanSpec` type | `src/contracts/spec.ts:170` | frozen Zod type | Reuse in `WorkflowArgs`/`WorkflowRunResult`. |
| `HistoryEntry` type | `src/state/history.ts:44` | `{ timestamp; event; phase; sprintId?; details }` | `pendingHistory` is `Array<Omit<HistoryEntry,"timestamp">>`. Lives in **state**, not contracts. |
| `PipelineEngineName` | `src/orchestrator/workflow/engine.ts:7` | `"ts"\|"skill"\|"workflow"` | Re-export this for `ConformanceReport`; do NOT redefine. |

**Barrels:** `src/contracts/index.ts` re-exports all four contract types/schemas. `src/state/index.ts:18-29` re-exports `loadHistory`, `appendHistory`, `HistoryEntry`, and (lines 4-9) `loadContract`/`listContracts`/`updateContract`/`saveContract`. You may import from the barrels OR the leaf files; existing workflow code (`reconciler.ts:1`, `selector.ts:1`) imports from **leaf files** (`../../contracts/eval-result.js`), so prefer leaf-file imports for consistency.

---

## 4. Prior Sprint Output

### Sprint 1: PipelineEngine seam
**Created:** `src/orchestrator/workflow/engine.ts` — exports `PipelineEngine` interface and `PipelineEngineName` type (`engine.ts:7`).
**Connection:** `ConformanceReport.diffs[].engines` is `PipelineEngineName[]`. Re-export `PipelineEngineName` from `engine.js` in `types.ts` (do not redefine the union).

### Sprint 2/3: selector, eligibility, reconciler
**Created:** `selector.ts` (`resolveEngineName`, `selectPipelineEngine`), `eligibility.ts` (`isWorkflowEligible`), `reconciler.ts` (`reconcile`), `reconcile-conformance.test.ts`.
**Connection:** None of these are imported this sprint, but they set the file/style conventions (section headers, leaf imports, co-located tests, pure modules). The `__fixtures__/` dir exists for conformance fixtures — not needed here.

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` found at repo root. The architecture (`arch-20260603-...md:24,35`) states the hard gates: TS strict zero-error, ESLint zero-error, build via `tsc`, ESM `.js` imports, Zod config validation, **no synchronous fs**, and the Dynamic Workflows runtime contract (pure-JS, no fs / no `Date.now` / no `Math.random` in the SCRIPT). The TS host modules here MAY use fs (async) and clock — but `ArgsPayloadBuilder.build` should stay pure/deterministic.

### Architecture Decisions
Key for this sprint (`arch-20260603-...md`):
- **Data Model section (lines 252-288)** — the canonical type shapes (transcribed in §1).
- **API Contracts table (line 298):** `build` → missing knob → `MissingKnobError` at build (no silent default); non-serializable model → `NonSerializableArgError`. (line 301): `reconstruct` → no history → `completedSprintNumbers: []`; status ≠ history → trust contract status.
- **Risk rows (lines 378, 381):** AgentCap worst-case = `spec × maxIterations × lenses > 16/1000`, computed at build, `AgentCapError` pre-invoke. Every script-read knob is REQUIRED → `MissingKnobError` if unset.

### Caps (16/1000)
Architecture line 21/35: **16 concurrent / 1000 total** agents per run. generatorNotes formula: `const total = maxSprints * maxIterations * evaluatorLenses.length; if (evaluatorLenses.length > 16 || total > 1000) throw new AgentCapError(...)`. The `> 16` check is on lens fan-out (concurrent panel), `> 1000` on total.

---

## 6. Testing Patterns

### Unit Test Pattern (real temp dirs — NO fs mocks)
**Source:** `src/state/run-state.test.ts:8-44`
```typescript
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-resume-cursor-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});
```
**Runner:** vitest. **Assertion style:** `expect`. **Mock approach:** NONE — write real contract JSON to `<tmpDir>/.bober/contracts/<id>.json` and real history to `<tmpDir>/.bober/history.jsonl`. **File naming:** co-located `<name>.test.ts`. **Location:** co-located in `src/orchestrator/workflow/`.

**For resume-cursor.test.ts:** write real contracts to `<tmpDir>/.bober/contracts/`. `saveContract` enforces a precision gate (`sprint-state.ts:51-60`) and full schema validation, so the simplest path is to `mkdir -p <tmpDir>/.bober/contracts` then `writeFile` a minimal VALID `SprintContract` JSON directly (must satisfy `SprintContractSchema`: contractId, specId, sprintNumber≥1, title, description, status, ≥1 successCriteria with description ≥25 chars, ≥1 nonGoals, ≥1 stopConditions, definitionOfDone ≥20 chars). Tip: copy the shape of `.bober/contracts/sprint-spec-20260604-workflow-engine-4.json` as a template. Three cases required (C2): mixed statuses → only passed/completed numbers; empty dir → `[]`; history-vs-status conflict → status wins.

**For args-builder.test.ts (C3/C4):**
```typescript
// round-trip serializability
const args = builder.build("prompt", config, cursor);
expect(JSON.parse(JSON.stringify(args))).toEqual(args);

// MissingKnobError: clone config, delete/undefine a required knob
expect(() => builder.build("p", badConfig, cursor)).toThrow(MissingKnobError);

// AgentCapError: maxSprints*maxIterations*lenses > 1000 OR lenses.length > 16
// NonSerializableArgError: inject a function/BigInt as a model value, e.g.
//   { ...config, planner: { ...config.planner, model: (() => {}) as unknown as string } }
```
Build a base config with `createDefaultConfig("test", "brownfield")` (`schema.ts:350`) and mutate per case.

### E2E Test Pattern
Not applicable — these are pure TS unit-tested modules.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
All six files are NEW; no existing file is modified. Risk to the existing tree is **low**.
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| (none modified) | — | low | New files only; `tsc --noEmit` must stay zero-error. |

The new files IMPORT from `src/state/sprint-state.ts`, `src/state/history.ts`, `src/contracts/*`, `src/config/schema.ts` — all read-only consumption, no signature changes.

### Existing Tests That Must Still Pass
- `src/orchestrator/workflow/reconciler.test.ts`, `selector.test.ts`, `reconcile-conformance.test.ts` — unaffected (no shared mutable code) but run them to confirm the workflow suite stays green.
- `src/state/run-state.test.ts`, `approval-state.test.ts` — confirm state helpers you reuse are still imported correctly.
- Full suite: `npm test` should remain green except the tolerated flaky tool-count baseline (per evaluatorNotes).

### Features That Could Be Affected
- **feat-3 (this sprint)** — `WorkflowEngine` plumbing. Sprints 5 (RunResultFlusher) and 6 (WorkflowEngine.run) will IMPORT `types.ts`/`errors.ts`/`resume-cursor.ts`/`args-builder.ts`. Keep export names exactly as the architecture interfaces name them so sprint 5/6 wire cleanly.

### Recommended Regression Checks
1. `npm run typecheck` exits 0 (C1, C5).
2. `npm run build` exits 0 (C5).
3. `npx vitest run src/orchestrator/workflow/` — new + existing workflow suites green.
4. `npm test` — full suite green (tolerate only the flaky tool-count baseline).

---

## 8. Implementation Sequence

1. **errors.ts** — four `extends Error` classes (no deps). Verify: file compiles standalone.
2. **types.ts** — transcribe the 4 types; `import type` the frozen contract types via `.js` leaf paths; re-export `PipelineEngineName` from `engine.js`. Verify: `npm run typecheck` resolves all imports (especially `HistoryEntry` from `../../state/history.js`).
3. **resume-cursor.ts** — `ResumeCursorReconstructor` using `listContracts` + `loadHistory`; filter by specId; collect passed/completed sprintNumbers; max for lastObserved. Verify: imports resolve, returns `ResumeCursor`.
4. **args-builder.ts** — `ArgsPayloadBuilder.build`: required-knob extraction (throw `MissingKnobError`), models, lenses, cap check (throw `AgentCapError`), JSON round-trip (throw `NonSerializableArgError`). Verify: typecheck.
5. **resume-cursor.test.ts** — mkdtemp fixture; write real contract JSON; 3 cases (mixed/empty/conflict). Verify: `vitest run src/orchestrator/workflow/resume-cursor.test.ts` green.
6. **args-builder.test.ts** — round-trip equality + MissingKnob + AgentCap + NonSerializable cases. Verify: green.
7. **Run full verification** — `npm run typecheck`, `npm run build`, `npx vitest run src/orchestrator/workflow/`, then `npm test`.

---

## 9. Config Knob → WorkflowArgs Mapping (exact paths)

| WorkflowArgs.knobs field | Config path | Optional section? | MissingKnobError when |
|--------------------------|-------------|-------------------|------------------------|
| `maxIterations` | `config.evaluator.maxIterations` (`schema.ts:107`) | no (evaluator required) | undefined |
| `maxSprints` | `config.sprint.maxSprints` (`schema.ts:116`) | no (sprint required) | undefined |
| `researchPhase` | `config.pipeline.researchPhase` (`schema.ts:153`) | no (pipeline required) | undefined |
| `architectPhase` | `config.pipeline.architectPhase` (`schema.ts:154`) | no (pipeline required) | undefined |
| `curatorEnabled` | `config.curator?.enabled` (`schema.ts:124`) | **YES — `curator?` optional** (`schema.ts:312`) | section AND field absent |
| `codeReviewEnabled` | `config.codeReview?.enabled` (`schema.ts:134`) | **YES — `codeReview?` optional** (`schema.ts:319`) | section AND field absent |
| `requireContracts` | `config.sprint.requireContracts` (`schema.ts:117`) | no (sprint required) | undefined |

**Models (all `string`, `schema.ts`):**
- `models.planner` ← `config.planner.model` (`schema.ts:85`)
- `models.curator` ← `config.curator?.model` (`schema.ts:123`) — optional section
- `models.generator` ← `config.generator.model` (`schema.ts:94`)
- `models.evaluator` ← `config.evaluator.model` (`schema.ts:105`)

**MissingKnobError nuance for optional sections:** `curator` and `codeReview` are `.optional()` at the top level (`schema.ts:312,319`). When the section is absent, `config.curator?.enabled` is `undefined`. Per generatorNotes you must NOT silently default — so a `curatorEnabled`/`codeReviewEnabled` of `undefined` should throw `MissingKnobError`. (If the caller wants curator off, the section must be present with `enabled: false`.) Apply the same undefined-check uniformly to all seven knobs. For `curator.model`/`codeReview` model resolution: if the section is absent, you can either treat it as a MissingKnobError or fall back — generatorNotes says "resolve planner/curator/generator/evaluator model strings from config sections"; the safest, contract-aligned choice is to throw `MissingKnobError("curator.model")` when the curator section is absent, keeping the no-silent-default rule consistent. (Note `createDefaultConfig` always populates `curator` with `enabled:true, model:"opus"`, so default configs never hit this path.)

### evaluatorLenses derivation (recommended)
**Source for strategies shape:** `config.evaluator.strategies: EvalStrategy[]` (`schema.ts:108`), each `EvalStrategy` has optional `label` and required `type` (`schema.ts:56-70`, label at line 68: "Human-readable label (defaults to type if not set)").

**Recommendation:** derive one lens per strategy using `label ?? type`, falling back to a single `["default"]` lens when there are no strategies:
```typescript
const lenses = config.evaluator.strategies.length > 0
  ? config.evaluator.strategies.map((s) => s.label ?? s.type)
  : ["default"];
```
This matches the schema doc ("label defaults to type"), the contract assumption ("Lenses default to a single 'default' lens when ... one evaluator pass"), and keeps the cap-check meaningful (one agent per lens). Do the cap check AFTER deriving lenses: `lenses.length > 16 || maxSprints * maxIterations * lenses.length > 1000`.

---

## 10. Pitfalls & Warnings

- **`HistoryEntry` is in `src/state/history.ts:44`, NOT in `src/contracts/`.** generatorNotes mentions `'../../state/history.js'` correctly in one place and `'../../contracts/...history'` confusedly in another — use `../../state/history.js`. Confirmed: `eval-result.ts` does NOT define `HistoryEntry`.
- **Do NOT redefine `PipelineEngineName`.** It already exists at `engine.ts:7`. Re-export it in `types.ts` (`export type { PipelineEngineName } from "./engine.js";`) so `ConformanceReport` references the single source.
- **`outcome` union ≠ `ContractStatus`.** `WorkflowRunResult.perSprint[].outcome` is the literal `"passed" | "needs-rework" | "failed"` (3 values), NOT the 9-value `ContractStatus` enum. Inline it; do not import `ContractStatus`.
- **No load-by-spec helper exists.** Do not invent `loadContractsForSpec`. Use `listContracts(projectRoot)` then `.filter((c) => c.specId === specId)` (pattern: `sprint.ts:138`).
- **Completed = both `"passed"` AND `"completed"`.** C2 says "status passed/completed". Filter on the set `{"passed","completed"}`, not just `"passed"`.
- **Keep `ArgsPayloadBuilder.build` pure** — no `readFile`/`Date.now`/`Math.random`. If you need principles text from disk, do it in a separate host method, not in `build` (per generatorNotes and the architecture pure-script rule).
- **`saveContract` enforces a precision gate** (`sprint-state.ts:51-60`) and full Zod validation — when writing test fixtures, write the JSON directly with `writeFile` to bypass the gate, OR construct contracts that pass it. Minimal valid contract: see `.bober/contracts/sprint-spec-20260604-workflow-engine-4.json` as a template.
- **Cap check operands must be `number`** — extract knobs as numbers BEFORE the cap arithmetic; if `maxSprints`/`maxIterations` are undefined you must have already thrown `MissingKnobError`, so the cap math never sees `NaN`.
- **JSON round-trip check:** `JSON.parse(JSON.stringify(args))` deep-equals `args` (C3). A function/BigInt/`undefined` model breaks this. `JSON.stringify` silently drops functions/undefined and throws on BigInt — so detect both: stringify (catch throw → `NonSerializableArgError`) AND compare round-trip equality (catches silent drops). Throw `NonSerializableArgError` on either failure.
- **ESLint `no-restricted-imports`** applies to `src/telemetry/` (network egress ban) — not relevant here, but keep imports to the listed leaf modules to avoid surprises.
- **Changes must be confined** to the six new files (stopCondition line 54). Do not touch `engine.ts`, `selector.ts`, barrels, or schema.
