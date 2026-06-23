# Sprint Briefing: Scope sprint to the active spec with clarification guard

**Contract:** sprint-spec-20260623-plan-contracts-materialization-3
**Generated:** 2026-06-23T00:00:00.000Z

---

## 0. Sprint Goal (TL;DR)

Three surgical changes to `runSprintCommand` in `src/cli/commands/sprint.ts`, plus a NEW test file `src/cli/commands/sprint.test.ts`:

1. **Filter contracts to the active spec.** After `loadLatestSpec`, keep only contracts whose `c.specId === spec.specId` BEFORE `findNextPendingSprint` runs.
2. **Clarification guard.** If `spec.status === "needs-clarification"`, print the open clarifications (reuse `getOpenClarifications` from `../../contracts/spec.js`) and `return` WITHOUT invoking the generator.
3. **Better empty-contracts message** (sprint.ts:115) — mention re-running plan or running the full pipeline.

Single-spec flow MUST stay byte-identical in behavior (when only one spec's contracts exist, filtering is a no-op and the guard is skipped for `ready`/`draft`/`in-progress` specs).

---

## 1. Target Files

### src/cli/commands/sprint.ts (modify)

This is the only source file to change. Current relevant region (lines 103-129):

```ts
  await ensureBoberDir(projectRoot);

  // Load current spec
  const spec = await loadLatestSpec(projectRoot);        // line 106
  if (!spec) {
    logger.error("No plan found. Run 'npx agent-bober plan' first.");
    return;
  }

  // Load contracts
  const contracts = await listContracts(projectRoot);    // line 113
  if (contracts.length === 0) {                           // line 114
    logger.error("No sprint contracts found. Run 'npx agent-bober plan' first."); // line 115
    return;
  }

  const projectContext = await buildProjectContext(projectRoot, config); // line 119

  let continueLoop = true;

  while (continueLoop) {
    // Find next pending sprint
    const nextSprint = findNextPendingSprint(contracts); // line 125
```

**Exactly where each change goes:**

- **Clarification guard** — insert immediately AFTER the `if (!spec)` block (after line 110) and BEFORE `listContracts` (line 113). Place it here so the command refuses early and never touches contracts/generator. Use the already-imported `logger` plus a NEW import of `getOpenClarifications`:
  ```ts
  if (spec.status === "needs-clarification") {
    const open = getOpenClarifications(spec);
    logger.error(
      `Plan "${spec.title}" needs clarification before sprints can run.`,
    );
    for (const q of open) {
      logger.info(`  [${q.questionId}] ${q.question}`);
    }
    logger.info("Answer with 'npx agent-bober plan-answer <specId> <questionId> <answer>', then re-run.");
    return;
  }
  ```
  (Wording is illustrative — S3-C3 only requires the message names the open clarifications and no generator runs. Match the project's existing message tone.)

- **Filter contracts to active spec** — change line 113 area. After `listContracts`, narrow the array to the active spec BEFORE the empty-check, so the empty-check and `findNextPendingSprint` both see only active-spec contracts:
  ```ts
  // Load contracts, scoped to the active (latest) spec
  const allContracts = await listContracts(projectRoot);
  const contracts = allContracts.filter((c) => c.specId === spec.specId);
  if (contracts.length === 0) {
    logger.error(
      "No sprint contracts found for the active plan. " +
        "Run 'npx agent-bober plan' to (re)materialize contracts, " +
        "or 'npx agent-bober run' to execute the full pipeline.",
    );
    return;
  }
  ```
  NOTE: keep `contracts` mutable as a local array — the existing loop mutates it in place (`contracts[contractIndex] = currentContract` at lines 151 and 296), so declare it `const` array (the array is mutated, not reassigned, exactly as the current `const contracts` is). Do not change the downstream loop.

- **Empty-contracts message** (line 115) — folded into the filter change above. S3-C4 requires it instruct the user to re-plan OR run the full pipeline. Keep both hints.

**Imports this file currently uses** (lines 1-21):
- `loadLatestSpec`, `listContracts`, `updateContract`, `ensureBoberDir`, `appendHistory` from `../../state/index.js`
- `runGenerator` from `../../orchestrator/generator-agent.js`
- `runEvaluatorAgent` from `../../orchestrator/evaluator-agent.js`
- `logger` from `../../utils/logger.js`
- `updateContractStatus` + type `SprintContract` from `../../contracts/sprint-contract.js`

**New import required:**
- `getOpenClarifications` from `../../contracts/spec.js` (function exists — `src/contracts/spec.ts:266`). Add it to a new import line: `import { getOpenClarifications } from "../../contracts/spec.js";`

**Imported by:**
- `src/cli/index.ts:18` imports `runSprintCommand`; called at `src/cli/index.ts:169` as `runSprintCommand(projectRoot, { verbose, continue, provider })`. The signature does NOT change — no CLI wiring edits needed.

**Test file:** `src/cli/commands/sprint.test.ts` — DOES NOT EXIST. The generator MUST create it (it is in `estimatedFiles`).

---

### src/cli/commands/sprint.test.ts (create)

**Directory pattern:** Co-located `*.test.ts` next to the command, e.g. `src/cli/commands/run.test.ts`, `src/cli/commands/plan.test.ts`. Use kebab/lower-case matching the source file name.

**Most similar existing files:**
- `src/cli/commands/run.test.ts` — mocks orchestrator + config, uses `mkdtemp` tmp dirs, asserts on mock call args / `toHaveBeenCalled` / `not.toHaveBeenCalled`. THIS is the template for the "no generator invocation" assertion.
- `src/cli/commands/plan.test.ts` — uses `saveSpec` + `listContracts` against a tmp dir, builds specs via `createSpec`, mocks `loadConfig`. THIS is the template for seeding specs/contracts on disk.

**Structure template** (based on run.test.ts:13-74 and plan.test.ts:1-69):
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { saveSpec, saveContract } from "../../state/index.js";
import { createSpec, type PlanSpec } from "../../contracts/spec.js";

// Mock the two agents so NO real LLM/network call happens and we can assert invocation.
vi.mock("../../orchestrator/generator-agent.js", () => ({
  runGenerator: vi.fn(async () => ({
    success: true,
    notes: "ok",
    filesChanged: [],
  })),
}));
vi.mock("../../orchestrator/evaluator-agent.js", () => ({
  runEvaluatorAgent: vi.fn(async () => ({
    passed: true,
    score: 100,
    results: [],
    summary: "all passed",
    timestamp: new Date().toISOString(),
  })),
}));
// Mock config so config.evaluator.maxIterations / config.generator.autoCommit / config.sprint.requireContracts exist.
vi.mock("../../config/loader.js", () => ({
  loadConfig: vi.fn(async () => ({
    project: { name: "test", mode: "brownfield" },
    planner: { provider: "anthropic" },
    generator: { provider: "anthropic", autoCommit: false },
    evaluator: { provider: "anthropic", maxIterations: 1 },
    sprint: { requireContracts: false },
  })),
}));
// git utils call out to the shell — stub to keep the test hermetic.
vi.mock("../../utils/git.js", () => ({
  getCurrentBranch: vi.fn(async () => "main"),
  getChangedFiles: vi.fn(async () => []),
  commitAll: vi.fn(async () => "deadbeef"),
}));

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "bober-sprint-cmd-"));
  vi.clearAllMocks();
  // Silence console.log noise (the command prints a result block via console.log)
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmpRoot, { recursive: true, force: true });
});
```

**Why mock the agents directly (not the pipeline):** `runSprintCommand` imports `runGenerator` (`generator-agent.js`) and `runEvaluatorAgent` (`evaluator-agent.js`) DIRECTLY — it does NOT go through `runPipeline`. No existing test mocks these two modules, so this is new territory; the GeneratorResult/EvaluationRunResult shapes above are exact (see Section 6).

---

## 2. Patterns to Follow

### Direct-command unit test with mocked orchestrator + asserting NOT called
**Source:** `src/cli/commands/run.test.ts`, lines 192-207
```ts
it("rejects an unknown gate name ... and does not call runPipeline", async () => {
  const { runPipeline } = await import("../../orchestrator/pipeline.js");
  const { runRunCommand } = await import("./run.js");

  const originalExitCode = process.exitCode;
  await runRunCommand("do something", tmpDir, { approveGates: "bogus-gate" });

  expect(process.exitCode).toBe(1);
  expect(runPipeline).not.toHaveBeenCalled();
  process.exitCode = originalExitCode as number | undefined;
});
```
**Rule:** Use `vi.mock(...)` at module top, then `const { fn } = await import(...)` inside the test to grab the mock, and assert `not.toHaveBeenCalled()` for the refusal path. For the needs-clarification test, assert `runGenerator` was NOT called.

### Seeding specs + contracts on a tmp dir and reading them back
**Source:** `src/cli/commands/plan.test.ts`, lines 56-58 + 129-142
```ts
async function seedSpec(spec: PlanSpec): Promise<void> {
  await saveSpec(tmpRoot, spec);
}
// ...
await runPlanCommand("build a thing", tmpRoot, {});
const written = await listContracts(tmpRoot);
expect(written.length).toBe(spec.features.length);
```
**Rule:** Use `saveSpec(tmpRoot, spec)` to seed specs and `saveContract(tmpRoot, contract)` to seed contracts directly to disk; `listContracts`/`loadLatestSpec` read from the same tmp dir.

### Building a ready vs needs-clarification spec via createSpec
**Source:** `src/cli/commands/plan.test.ts`, lines 73-111
```ts
function makeReadySpec(features: number): PlanSpec {
  return createSpec("Test plan", "A test plan ...", [...features...], { status: "ready" as const });
}
function makeNeedsClariSpec(): PlanSpec {
  return createSpec("Needs clarification plan", "A plan that requires clarification ...",
    [ /* one feature */ ],
    { clarificationQuestions: [ { questionId: "Q1", category: "scope", question: "Should this include mobile support?" } ] },
  );
}
```
**Rule:** `createSpec(...)` auto-derives `status: "needs-clarification"` when `clarificationQuestions` are supplied (see `spec.ts:199-209`). Two specs with DIFFERENT `createdAt` will sort so the newest is "latest" — `createSpec` stamps `createdAt = now`, so to make spec B the active one, create/seed it second (or hand-set a later `createdAt`).

### Active-spec resolution by createdAt (verify your "latest" assumption)
**Source:** `src/state/plan-state.ts`, lines 85-101
```ts
export async function loadLatestSpec(projectRoot: string): Promise<PlanSpec | null> {
  const specs = await listSpecs(projectRoot);
  if (specs.length === 0) return null;
  specs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return specs[0]; // newest createdAt
}
```
**Rule:** "Latest" = newest `createdAt`. In tests where both specs are made via `createSpec` in quick succession their timestamps may tie (ms resolution); to be deterministic, explicitly set distinct `createdAt` on the seeded specs (e.g. spread `{ ...spec, createdAt: "2026-01-01T00:00:00.000Z" }` for the OLD one and a later date for the active one).

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `getOpenClarifications` | `src/contracts/spec.ts:266` | `(spec: PlanSpec): ClarificationQuestion[]` | Returns the unresolved clarification questions — REUSE for the guard message. |
| `hasOpenClarifications` | `src/contracts/spec.ts:243` | `(spec: PlanSpec): boolean` | True if any question is unresolved (status-independent). |
| `isPipelineReady` | `src/contracts/spec.ts:256` | `(spec: PlanSpec): boolean` | Combined gate: false for needs-clarification/abandoned/open-questions. (Alternative guard, but contract says use status + getOpenClarifications.) |
| `loadLatestSpec` | `src/state/plan-state.ts:85` | `(projectRoot): Promise<PlanSpec \| null>` | Active spec by newest createdAt. Already imported in sprint.ts. |
| `listContracts` | `src/state/sprint-state.ts:113` | `(projectRoot): Promise<SprintContract[]>` | All contracts (skips malformed). Already imported in sprint.ts. Filter its result. |
| `saveContract` | `src/state/sprint-state.ts:38` | `(projectRoot, contract): Promise<void>` | Validates + precision-gates then writes. Use in test to seed contracts. |
| `saveSpec` | `src/state/plan-state.ts:22` | `(projectRoot, spec): Promise<void>` | Validates + writes a spec. Use in test to seed specs. |
| `createSpec` | `src/contracts/spec.ts:189` | `(title, description, features, options?): PlanSpec` | Build specs in tests; derives needs-clarification status from clarificationQuestions. |
| `createContract` | `src/contracts/sprint-contract.ts:148` | `(title, desc, criteria, options?): SprintContract` | Build contracts in tests; pass `options.specId` to tag the owning spec. |
| `findNextPendingSprint` | `src/cli/commands/sprint.ts:34` (local) | `(contracts): SprintContract \| null` | First contract with status proposed/negotiating/agreed/needs-rework. DO NOT change. |
| `logger` | `src/utils/logger.ts` | `.error/.info/.success/.warn/.phase/.sprint/.progress` | Output. `error`@28, `info`@13, `success`@18, `warn`@23. |

Utilities reviewed in: `src/state/` (index, sprint-state, plan-state), `src/contracts/` (spec, sprint-contract), `src/utils/` (logger, git). No new helper needs to be created — the filter is a one-line `.filter()` and the guard reuses `getOpenClarifications`.

---

## 4. Prior Sprint Output

### Sprint 1 (1a7cd2b): materializeContracts helper + deterministic ids
**Created/changed:** a `materializeContracts` helper + deterministic zero-padded contract ids; pipeline delegates to it. Each materialized contract carries `specId` (schema requires it — `sprint-contract.ts:85` `specId: z.string().min(1)`).
**Connection to this sprint:** This is WHY filtering by `c.specId === spec.specId` is safe (contract assumption #2). Every contract on disk has a real `specId`.

### Sprint 2 (36de025, bef849e): standalone plan→sprint enabled
**Created/changed:** `clearContractsForSpec` (`src/state/sprint-state.ts:166`), plan eager materialization, plan-answer materialize-on-ready, hints corrected to `sprint`.
**Connection to this sprint:** After Sprint 2, `plan` writes contracts for the active spec and prints the `agent-bober sprint` hint. Sprint 3 makes the `sprint` command consume ONLY that active spec's contracts and refuse a still-blocked (needs-clarification) spec. `clearContractsForSpec` already deletes by `specId`, mirroring the filter logic you add.

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` consulted for this sprint (not required for a 1-file scoping change). Convention is enforced by the `*.test.ts` mirrors and the Zod schemas.

### Architecture Decisions
No ADR directly governs the sprint command's spec-scoping. The relevant invariant is schema-level: `SprintContractSchema.specId` is required (`src/contracts/sprint-contract.ts:85`), and `PlanSpecStatusSchema` defines `needs-clarification` (`src/contracts/spec.ts:36-44`) with the documented rule (spec.ts:24-35): "The pipeline will not run sprints from this spec until status flips to `ready`." This sprint enforces that rule in the standalone `sprint` command.

### Other Docs
ESM with `.js` import extensions is mandatory (see every import in sprint.ts, e.g. `../../contracts/spec.js`). Test files use vitest and `await import(...)` for mocked modules.

---

## 6. Testing Patterns

### Unit Test Pattern
**Source:** `src/cli/commands/run.test.ts` (mock + tmp dir + assert NOT called) and `src/cli/commands/plan.test.ts` (seed specs/contracts on disk).
```ts
// Seed two specs' contracts, assert only the active spec's sprint runs.
it("S3-C2: runs only the latest spec's contracts", async () => {
  const old = { ...createSpec("Old", "old plan ...", [oneFeature], { status: "ready" }),
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
  const active = { ...createSpec("Active", "active plan ...", [oneFeature], { status: "ready" }),
    createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z" };
  await saveSpec(tmpRoot, old);
  await saveSpec(tmpRoot, active);
  await saveContract(tmpRoot, createContract("Old sprint", "...", [crit], { specId: old.specId }));
  await saveContract(tmpRoot, createContract("Active sprint", "...", [crit], { specId: active.specId }));

  const { runGenerator } = await import("../../orchestrator/generator-agent.js");
  const { runSprintCommand } = await import("./sprint.js");
  await runSprintCommand(tmpRoot, {});

  // Generator was handed the ACTIVE spec's contract only
  const handoff = (runGenerator as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(handoff.currentContract.specId).toBe(active.specId);
});

// needs-clarification refusal: no generator invocation.
it("S3-C3: refuses needs-clarification spec, no generator call", async () => {
  const spec = createSpec("Blocked", "needs clari ...", [oneFeature],
    { clarificationQuestions: [{ questionId: "Q1", category: "scope", question: "Mobile?" }] });
  await saveSpec(tmpRoot, spec);
  await saveContract(tmpRoot, createContract("S1", "...", [crit], { specId: spec.specId }));

  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const { runGenerator } = await import("../../orchestrator/generator-agent.js");
  const { runSprintCommand } = await import("./sprint.js");
  await runSprintCommand(tmpRoot, {});

  expect(runGenerator).not.toHaveBeenCalled();
  errSpy.mockRestore();
});
```
**Runner:** vitest
**Assertion style:** `expect(...)` with `.toBe`, `.toHaveBeenCalled`, `.not.toHaveBeenCalled`, `.toContain`
**Mock approach:** `vi.mock("...module.js", () => ({...}))` at top of file; grab via `await import(...)` inside tests; `vi.clearAllMocks()` in beforeEach.
**File naming:** `<command>.test.ts` co-located
**Location:** co-located in `src/cli/commands/`

**Exact mock return shapes (must match interfaces or TS will fail S3-C1):**
- `runGenerator` → `GeneratorResult` (`src/orchestrator/generator-agent.ts:16-27`): `{ success: boolean; notes: string; filesChanged: string[]; commitHash?; turnsUsed?; toolsCalled?; usage? }`. Minimum: `{ success: true, notes: "ok", filesChanged: [] }`.
- `runEvaluatorAgent` → `EvaluationRunResult` (`src/evaluators/registry.ts:20-31`): `{ passed: boolean; score: number; results: EvalResult[]; summary: string; timestamp: string }`. Minimum: `{ passed: true, score: 100, results: [], summary: "ok", timestamp: new Date().toISOString() }`.

**Config fields the command reads (your loadConfig mock MUST provide these or it throws):**
- `config.project.name`, `config.project.mode` (sprint.ts:62-63 via buildProjectContext)
- `config.evaluator.maxIterations` (sprint.ts:142)
- `config.generator.autoCommit` (sprint.ts:216)
- `config.sprint.requireContracts` (sprint.ts:315)
- `config.planner/generator/evaluator.provider` only touched when `options.provider` set (sprint.ts:96-98)

**Git stubs:** sprint.ts calls `getCurrentBranch` (sprint.ts:56), `getChangedFiles` (sprint.ts:240), `commitAll` (sprint.ts:218, only if autoCommit true). All three are in `src/utils/git.ts`. `getCurrentBranch` is wrapped in try/catch (falls back to "unknown"), and `getChangedFiles` too — so stubbing is for cleanliness/speed, not strictly required, but recommended to avoid shelling out in CI.

### E2E Test Pattern
Not applicable — this is a CLI/unit sprint. No Playwright run needed for these criteria.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/cli/index.ts:18,169` | imports + calls `runSprintCommand` | low | Signature `(projectRoot, options)` unchanged — no edit needed. |
| `src/cli/commands/sprint.ts` (its own loop) | mutates `contracts[]` at lines 151, 296 | medium | Keep `contracts` a mutable local array (the filtered result). The loop relies on `findNextPendingSprint(contracts)` + index writes. Do not break this. |
| any caller of `loadLatestSpec`/`listContracts` | unchanged functions | none | You are NOT changing these functions, only how sprint.ts filters their output. |

### Existing Tests That Must Still Pass
- `src/cli/commands/plan.test.ts` — tests plan materialization + hints; shares `spec.ts`/`sprint-contract.ts`/`sprint-state.ts` but NOT sprint.ts. Verify still green (no API changes to shared modules).
- `src/cli/commands/run.test.ts` — tests `runRunCommand`/pipeline; independent of sprint.ts. Verify still green.
- Any test importing `src/contracts/spec.ts` or `src/state/*` — you only ADD a new import usage; no signatures change.
- NEW `src/cli/commands/sprint.test.ts` — must cover S3-C2, S3-C3, S3-C4, and a single-spec no-regression case (S3-C5).

### Features That Could Be Affected
- **feat-1/feat-2 (Sprints 1-2 plan materialization)** — share `sprint-contract.ts` `specId` and `clearContractsForSpec`. Verify the filter uses the SAME `specId` field those sprints write. No behavior change to plan/plan-answer.
- **Single-spec flow (S3-C5)** — when only one spec exists, `allContracts.filter(c => c.specId === spec.specId)` returns the full set (since plan tags every contract with that specId). Add a test asserting the same sprint is selected as before.

### Recommended Regression Checks
After implementation, the Generator MUST run:
1. `npm run build` (or the repo's `tsc`/typecheck) — verifies S3-C1, catches mock-shape mismatches.
2. `npx vitest run src/cli/commands/sprint.test.ts` — verifies S3-C2/C3/C4 in isolation first.
3. `npx vitest run` (full suite) — verifies S3-C5 / no regression (especially plan.test.ts, run.test.ts).
4. `npx vitest run src/cli/commands/plan.test.ts src/cli/commands/run.test.ts` — fast targeted regression on the closest siblings.

---

## 8. Implementation Sequence

1. **src/cli/commands/sprint.ts — add import.** Add `import { getOpenClarifications } from "../../contracts/spec.js";` near the other contract imports (after line 5).
   - Verify: import resolves (it is exported at spec.ts:266).
2. **src/cli/commands/sprint.ts — clarification guard.** Insert the `spec.status === "needs-clarification"` block after the `if (!spec)` return (after line 110), before `listContracts`.
   - Verify: guard returns before any `listContracts`/generator call; uses `getOpenClarifications(spec)`.
3. **src/cli/commands/sprint.ts — filter + empty message.** Replace lines 113-117: load into `allContracts`, filter to `c.specId === spec.specId` into `contracts`, then the improved empty-contracts error (mention re-plan AND full pipeline).
   - Verify: `findNextPendingSprint(contracts)` at line 125 now only sees active-spec contracts; downstream loop untouched.
4. **Build/typecheck.** Run the build to confirm zero TS errors (S3-C1).
   - Verify: clean compile.
5. **src/cli/commands/sprint.test.ts — create.** Write the test file using the Section 1/6 template: mock generator-agent.js, evaluator-agent.js, config/loader.js, utils/git.js; tmp dir lifecycle; seed two specs + contracts; cover S3-C2, S3-C3 (assert `runGenerator` not called), S3-C4 (empty message contains re-plan/run hints), S3-C5 (single-spec selects same sprint).
   - Verify: `npx vitest run src/cli/commands/sprint.test.ts` green.
6. **Run full verification** — build + `npx vitest run` (full suite green), confirming no regression to plan.test.ts / run.test.ts.

---

## 9. Pitfalls & Warnings

- **Guard placement matters.** Put the needs-clarification guard BEFORE `listContracts`. If you place it after, the empty-contracts message could fire first for a blocked spec. The contract wants a clarifications message, not an empty-contracts message, for needs-clarification specs.
- **Filter BEFORE the empty-check and BEFORE `findNextPendingSprint`.** S3-C2 requires `findNextPendingSprint` to never see another spec's contract.
- **Keep `contracts` mutable in place.** The existing loop does `contracts[contractIndex] = currentContract` (lines 151, 296). Assign the filtered result to a `const contracts` array (mutated, not reassigned) exactly like the current code — do not switch to a read-only structure or refactor the loop.
- **`createdAt` ties in tests.** `createSpec` stamps `createdAt = new Date().toISOString()`; two specs created in the same millisecond can sort nondeterministically. Override `createdAt` explicitly on seeded specs so "latest" is deterministic (`loadLatestSpec` sorts by `createdAt` desc — plan-state.ts:94).
- **Mock return shapes must be exact.** A wrong `GeneratorResult`/`EvaluationRunResult` shape fails the TS build (S3-C1), not just the test. Use the exact fields from Section 6.
- **loadConfig mock must include all read fields.** Missing `config.evaluator.maxIterations` / `config.sprint.requireContracts` / `config.generator.autoCommit` → runtime TypeError mid-test. See Section 6 config list.
- **`getChangedFiles`/`getCurrentBranch` shell out.** They are wrapped in try/catch in sprint.ts so they won't crash, but stub them in the test to keep it hermetic and fast.
- **Do NOT change generator/evaluator behavior** (nonGoal) and **do NOT implement multi-spec parallel execution** (nonGoal) — filtering to ONE active spec is the entire scope.
- **ESM `.js` extensions** are mandatory on every import, including `../../contracts/spec.js` and `./sprint.js` in the test.
- **`process.exitCode`** — current `runSprintCommand` does NOT set `process.exitCode` on these error paths (it just `logger.error` + `return`). Do not start setting exit codes unless a criterion demands it; the refusal/empty paths simply `return`. (plan.test.ts uses exitCode because plan.ts sets it; sprint.ts does not — assert on the mock not being called / on console.error output instead.)
