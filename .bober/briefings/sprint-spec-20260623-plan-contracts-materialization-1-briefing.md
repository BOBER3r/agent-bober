# Sprint Briefing: Extract shared deterministic materializeContracts helper

**Contract:** sprint-spec-20260623-plan-contracts-materialization-1
**Generated:** 2026-06-23T00:00:00.000Z

---

## 0. TL;DR for the Generator

Extract the inline contract-creation loop from `runTsPipeline` (`src/orchestrator/pipeline.ts:856-906`) into a new exported async helper `materializeContracts(spec, projectRoot, config): Promise<SprintContract[]>` in a NEW file `src/orchestrator/contract-materialization.ts`. `runTsPipeline` then calls it in place of the loop. Two things change vs. the original loop:

1. **Contract id becomes deterministic + zero-padded**: `sprint-${spec.specId}-${String(i + 1).padStart(2, "0")}` instead of the `createContract` default `sprint-${Date.now()}-${counter}`.
2. **Nothing else.** Same `createContract` inputs, same criteria mapping (`verificationMethod: "agent-evaluation"`), same `precision` handling, same logging strings, same `saveContract` call, same order.

The two `runWithAudit` checkpoints (`post-plan` at lines 844-851 and `post-sprint-contract` at lines 907-914) **STAY in `pipeline.ts`** — they are pipeline concerns, not helper concerns. The helper returns the `SprintContract[]` so the pipeline can feed it to the `post-sprint-contract` checkpoint exactly as before.

---

## 1. Target Files

### `src/orchestrator/pipeline.ts` (modify)

**The EXACT block to extract — lines 856-906** (the loop, NOT the checkpoints around it):

```ts
    // Create sprint contracts from features.
    // These auto-generated contracts use placeholder precision fields;
    // a planner-authored contract (saved directly by the bober-planner
    // subagent) supersedes them with substantive nonGoals, stopConditions,
    // and definitionOfDone.
    const contracts: SprintContract[] = [];
    for (let i = 0; i < spec.features.length; i++) {
      const feature = spec.features[i];
      // Generate substantive precision fields (nonGoals/stopConditions/
      // definitionOfDone) so the contract passes the generator's BLOCKING
      // precision preflight. Without this the standalone pipeline emits
      // placeholder contracts that every generator (Claude or DeepSeek) refuses.
      const precision = await generateContractPrecision(feature, spec, config);
      if (precision) {
        logger.info(
          `Generated precision fields for sprint ${i + 1} (${precision.nonGoals.length} non-goals, ${precision.stopConditions.length} stop conditions).`,
        );
      } else {
        logger.warn(
          `Could not generate precision fields for sprint ${i + 1}; contract will use placeholders and the generator may block it.`,
        );
      }
      const contract = createContract(
        feature.title,
        feature.description,
        feature.acceptanceCriteria.map((ac, idx) => ({
          criterionId: `${feature.featureId}-criterion-${idx + 1}`,
          description: ac,
          verificationMethod: "agent-evaluation",
        })),
        {
          specId: spec.specId,
          sprintNumber: i + 1,
          features: [feature.featureId],
          ...(precision
            ? {
                nonGoals: precision.nonGoals,
                stopConditions: precision.stopConditions,
                definitionOfDone: precision.definitionOfDone,
              }
            : {}),
        },
      );
      // createContract doesn't take assumptions/outOfScope; set them directly.
      if (precision) {
        contract.assumptions = precision.assumptions;
        contract.outOfScope = precision.outOfScope;
      }
      contracts.push(contract);
      await saveContract(projectRoot, contract);
    }
```

**The id mutation to ADD inside the loop** (the ONLY behavioral change — `createContract` does not accept a `contractId` option, so set it after construction, before push/save):

```ts
      // Deterministic, zero-padded id so listContracts() lexical order == execution order.
      contract.contractId = `sprint-${spec.specId}-${String(i + 1).padStart(2, "0")}`;
```

> NOTE: `createContract` (`src/contracts/sprint-contract.ts:148-198`) hard-codes `contractId = \`sprint-${Date.now()}-${contractCounter}\`` at line 164 with no override option. Overwriting `contract.contractId` after the call is the correct seam — the contract object is a plain mutable object (the code already mutates `contract.assumptions`/`contract.outOfScope` at lines 901-902).

**MUST STAY in `pipeline.ts` — the post-plan checkpoint (lines 844-851), immediately BEFORE the loop:**

```ts
    await runWithAudit({
      projectRoot,
      runId: pipelineRunId,
      checkpointId: "post-plan",
      mechanism: pipelineMechanismName,
      iteration: 1,
      fn: () => getCheckpointMechanismFor("post-plan", config, "noop").request("post-plan", spec),
    });
```

**MUST STAY in `pipeline.ts` — the post-sprint-contract checkpoint (lines 907-914), immediately AFTER the loop. It consumes `contracts`, so the helper must RETURN that array:**

```ts
    await runWithAudit({
      projectRoot,
      runId: pipelineRunId,
      checkpointId: "post-sprint-contract",
      mechanism: pipelineMechanismName,
      iteration: 1,
      fn: () => getCheckpointMechanismFor("post-sprint-contract", config, "noop").request("post-sprint-contract", contracts),
    });
```

**Resulting shape of the modified region in `pipeline.ts` (≈ lines 853-914):**

```ts
    // ── Phase 2: Sprint loop ─────────────────────────────────────
    logger.phase("Sprint Execution");

    const contracts = await materializeContracts(spec, projectRoot, config);

    await runWithAudit({
      projectRoot,
      runId: pipelineRunId,
      checkpointId: "post-sprint-contract",
      mechanism: pipelineMechanismName,
      iteration: 1,
      fn: () => getCheckpointMechanismFor("post-sprint-contract", config, "noop").request("post-sprint-contract", contracts),
    });
```

**Downstream consumer of `contracts` that MUST keep working** (lines 916-939):

```ts
    const completedSprints: SprintContract[] = [];
    const failedSprints: SprintContract[] = [];

    const projectContext = await buildProjectContext(projectRoot, config);
    const maxSprints = Math.min(contracts.length, config.sprint.maxSprints);

    for (let i = 0; i < maxSprints; i++) {
      ...
      const contract = contracts[i];
      ...
    }
```
`contracts` must remain a `const SprintContract[]` (now assigned from the helper). `contracts.length` and `contracts[i]` are used — the helper's return value satisfies both.

**Imports this file currently uses (relevant to the extraction):**
- `createContract`, `updateContractStatus` from `../contracts/sprint-contract.js` (line 17-20)
- `type SprintContract` from `../contracts/sprint-contract.js` (line 16)
- `generateContractPrecision`, `runPlanner` from `./planner-agent.js` (line 28)
- `saveContract`, `updateContract`, `appendHistory`, ... from `../state/index.js` (line 52-59)
- `logger` from `../utils/logger.js` (line 61)
- `type BoberConfig` from `../config/schema.js` (line 13)
- `type PlanSpec` from `../contracts/spec.js` (line 14)

**Import cleanup after extraction:** Once the loop moves out, `pipeline.ts` will no longer call `createContract`, `generateContractPrecision`, or `saveContract` in the extracted region. CHECK whether these symbols are still used ELSEWHERE in `pipeline.ts` before removing them from the import list — `saveContract` is re-exported via `../state/index.js` and may be used elsewhere; `createContract`/`generateContractPrecision` likely become unused. Add `import { materializeContracts } from "./contract-materialization.js";`. Let `npm run build` (tsc with noUnusedLocals if enabled) tell you which imports to drop — do not guess.

**Imported by (`runTsPipeline` / pipeline.ts consumers):**
- `src/index.ts`
- `src/cli/commands/run.ts`
- `src/mcp/run-manager.ts`

**Test file:** `src/cli/commands/run.test.ts` (exists — but it mocks `runPipeline` entirely; it does NOT exercise the loop). No direct unit test currently covers the loop.

---

### `src/orchestrator/contract-materialization.ts` (create)

**Directory pattern:** Files in `src/orchestrator/` use **kebab-case** filenames with a `-agent`/`-resolver`/`-handoff`/`-persist` suffix where they wrap a role or concern (e.g. `planner-agent.ts`, `model-resolver.ts`, `context-handoff.ts`, `eval-persist.ts`). `contract-materialization.ts` fits the noun-concern convention. ESM with `.js` import extensions throughout.

**Most similar existing file:** `src/orchestrator/eval-persist.ts` — a small single-concern helper module imported by `pipeline.ts`. Also mirror the exact loop body from `pipeline.ts:856-906`.

**Structure template:**

```ts
import type { BoberConfig } from "../config/schema.js";
import type { PlanSpec } from "../contracts/spec.js";
import type { SprintContract } from "../contracts/sprint-contract.js";
import { createContract } from "../contracts/sprint-contract.js";
import { generateContractPrecision } from "./planner-agent.js";
import { saveContract } from "../state/index.js";
import { logger } from "../utils/logger.js";

/**
 * Materialize feature-derived sprint contracts for a plan spec and persist them.
 *
 * Extracted verbatim from runTsPipeline's inline loop so that both the run
 * pipeline AND the standalone `plan` command (Sprint 2) share one source of
 * truth. Contract content is feature-derived; ids are deterministic and
 * zero-padded as `sprint-<specId>-NN` so listContracts() lexical ordering
 * matches sprint execution order.
 *
 * Returns the created contracts in feature/sprintNumber order so the caller
 * can pass them to the post-sprint-contract checkpoint and the sprint loop.
 */
export async function materializeContracts(
  spec: PlanSpec,
  projectRoot: string,
  config: BoberConfig,
): Promise<SprintContract[]> {
  const contracts: SprintContract[] = [];
  for (let i = 0; i < spec.features.length; i++) {
    const feature = spec.features[i];
    const precision = await generateContractPrecision(feature, spec, config);
    if (precision) {
      logger.info(
        `Generated precision fields for sprint ${i + 1} (${precision.nonGoals.length} non-goals, ${precision.stopConditions.length} stop conditions).`,
      );
    } else {
      logger.warn(
        `Could not generate precision fields for sprint ${i + 1}; contract will use placeholders and the generator may block it.`,
      );
    }
    const contract = createContract(
      feature.title,
      feature.description,
      feature.acceptanceCriteria.map((ac, idx) => ({
        criterionId: `${feature.featureId}-criterion-${idx + 1}`,
        description: ac,
        verificationMethod: "agent-evaluation",
      })),
      {
        specId: spec.specId,
        sprintNumber: i + 1,
        features: [feature.featureId],
        ...(precision
          ? {
              nonGoals: precision.nonGoals,
              stopConditions: precision.stopConditions,
              definitionOfDone: precision.definitionOfDone,
            }
          : {}),
      },
    );
    if (precision) {
      contract.assumptions = precision.assumptions;
      contract.outOfScope = precision.outOfScope;
    }
    // Deterministic, zero-padded id: lexical order == execution order.
    contract.contractId = `sprint-${spec.specId}-${String(i + 1).padStart(2, "0")}`;
    contracts.push(contract);
    await saveContract(projectRoot, contract);
  }
  return contracts;
}
```

> Keep the leading explanatory comment block (the "These auto-generated contracts use placeholder precision fields..." note from pipeline.ts:856-860) somewhere in the helper or at the loop — it documents intent.

---

### `src/orchestrator/contract-materialization.test.ts` (create)

**Most similar existing test:** `src/orchestrator/documenter-agent.test.ts` (mocks orchestrator deps with `vi.mock`, uses `node:fs/promises` + `node:os` tmp dirs) and `src/contracts/sprint-contract.test.ts` (builds valid contract fixtures). See Section 6 for the full pattern + a ready template.

---

## 2. Patterns to Follow

### Pattern: ESM imports with explicit `.js` extension
**Source:** `src/orchestrator/pipeline.ts`, lines 13-20
```ts
import type { BoberConfig } from "../config/schema.js";
import type { PlanSpec } from "../contracts/spec.js";
import type { SprintContract } from "../contracts/sprint-contract.js";
import {
  createContract,
  updateContractStatus,
} from "../contracts/sprint-contract.js";
```
**Rule:** Every relative import ends in `.js` even though the source is `.ts`. Use `import type { ... }` for type-only imports.

### Pattern: small single-concern helper module imported by pipeline
**Source:** `src/orchestrator/eval-persist.ts` (imported at `pipeline.ts:22`) and `src/orchestrator/planner-agent.ts:422-426`
```ts
export async function generateContractPrecision(
  feature: FeatureSpec,
  spec: Pick<PlanSpec, "title" | "description">,
  config: BoberConfig,
): Promise<ContractPrecision | undefined> {
```
**Rule:** Exported async helpers take explicit typed params, return a typed Promise, and live in a focused file. Match this signature style for `materializeContracts(spec, projectRoot, config)`.

### Pattern: contract object is mutated after createContract
**Source:** `src/orchestrator/pipeline.ts`, lines 899-903
```ts
      // createContract doesn't take assumptions/outOfScope; set them directly.
      if (precision) {
        contract.assumptions = precision.assumptions;
        contract.outOfScope = precision.outOfScope;
      }
```
**Rule:** `createContract` returns a plain mutable `SprintContract`. Setting `contract.contractId = ...` after the call is consistent with how the codebase already mutates `assumptions`/`outOfScope`. Do NOT add a `contractId` option to `createContract` (that is out of scope and changes a shared helper's surface).

### Pattern: zero-padding for stable lexical ordering
**Rule:** `listContracts` (`src/state/sprint-state.ts:113-147`) sorts by FILENAME (`jsonFiles ... .sort()` at line 126-128) and `contractPath` (line 19-23) sanitizes the id to the filename. So the contract id directly drives sort order. `String(i + 1).padStart(2, "0")` yields `01..09, 10, 11, 12` which sorts correctly for up to 99 sprints (covers the "twelve or more" criterion S1-C4). Use width 2.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `createContract` | `src/contracts/sprint-contract.ts:148` | `(title, description, criteria, options) => SprintContract` | Build a proposed contract; defaults precision/id fields. Does NOT accept contractId override. |
| `generateContractPrecision` | `src/orchestrator/planner-agent.ts:422` | `(feature, spec, config) => Promise<ContractPrecision \| undefined>` | LLM call producing nonGoals/stopConditions/definitionOfDone/assumptions/outOfScope. Mock in tests. |
| `saveContract` | `src/state/sprint-state.ts:38` (re-exported `src/state/index.ts:5`) | `(projectRoot, contract) => Promise<void>` | Validate + precision-gate + write `.bober/contracts/<id>.json`. Throws on invalid/vague. |
| `listContracts` | `src/state/sprint-state.ts:113` (re-exported `src/state/index.ts:7`) | `(projectRoot) => Promise<SprintContract[]>` | Read + parse all contract JSON files, sorted by filename (lexical). |
| `loadContract` | `src/state/sprint-state.ts:70` (re-exported `src/state/index.ts:6`) | `(projectRoot, id) => Promise<SprintContract>` | Load one contract by id; throws if missing/invalid. |
| `updateContractStatus` | `src/contracts/sprint-contract.ts:205` | `(contract, status) => SprintContract` | Immutable status transition with timestamps. (Used by pipeline, not the helper.) |
| `findPrecisionIssues` / `isContractPrecise` | `src/contracts/sprint-contract.ts:242 / 282` | `(contract) => Issue[]` / `=> boolean` | Vague-phrase quality gate enforced inside `saveContract`. |
| `createSpec` | `src/contracts/spec.ts:189` | `(title, description, features, options) => PlanSpec` | Build a PlanSpec; auto-assigns `feat-1..N` featureIds. Use to build test fixtures. |
| `type ContractPrecision` | `src/orchestrator/planner-agent.ts:369` | `{ nonGoals, stopConditions, definitionOfDone, assumptions, outOfScope }` | Return shape to mock from `generateContractPrecision`. |
| `type FeatureSpec` | `src/contracts/spec.ts:120` | `{ featureId, title, description, priority, acceptanceCriteria, ... }` | Feature shape consumed by the loop. |

> NOTE: `contractsDir` and `contractPath` in `src/state/sprint-state.ts:15-23` are **private (not exported)**. The instructions mention `contractsDir` — it is NOT importable. Tests verify ordering through `listContracts(projectRoot)`, not by reading the dir path directly. Utilities reviewed: `src/state/`, `src/contracts/`, `src/orchestrator/` (no `utils/`-style misc helper applies beyond `logger`).

---

## 4. Prior Sprint Output

No prior sprints completed for this spec. This is Sprint 1 of 3:
- **Sprint 1 (this one):** extract `materializeContracts`, deterministic ids.
- **Sprint 2 (out of scope here):** wire the standalone `plan` command to call `materializeContracts`; introduce the embedded `spec.sprints` branch.
- **Sprint 3 (out of scope here):** sprint-command contract scoping.

`spec.sprints` exists on the schema (`src/contracts/spec.ts:160`, `z.array(z.unknown()).optional()`) but you MUST NOT branch on it in this sprint (nonGoal #2, outOfScope).

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` content reviewed for this sprint (file may exist project-wide; not load-bearing for this extraction). The binding constraint is the **freeze comment** at `src/orchestrator/pipeline.ts:610-612`:
```ts
 * Internal implementation: the original TypeScript pipeline body.
 * Extracted so TsPipelineEngine can wrap it without an import cycle.
 * Do NOT change the algorithm, phase order, or .bober/ write behaviour here.
```
**Interpretation (per generatorNotes):** Honor the freeze for everything EXCEPT (a) the now-authorized deterministic id scheme, and (b) the extraction of the loop into a helper (the algorithm and `.bober/` write behaviour are preserved — same `saveContract` calls, same order, same content). The phase order and checkpoint sites do not move.

### Architecture Decisions
No new ADR governs this sprint. The import-cycle concern noted in the freeze comment (line 611) is relevant: `contract-materialization.ts` imports from `planner-agent.js` and `state/index.js` — both already imported by `pipeline.ts`, and neither imports `pipeline.ts`, so no new cycle is introduced. `pipeline.ts` importing `contract-materialization.ts` is a one-way edge.

### Other Docs
`run.test.ts` header (lines 1-11) documents the project test convention: `vi.mock` the heavy module, call the command/function directly, no network, no real LLM, temp dirs for FS.

---

## 6. Testing Patterns

### Unit Test Pattern
**Source:** `src/orchestrator/documenter-agent.test.ts:17-69` (mock orchestrator deps + tmp dirs) and `src/cli/commands/run.test.ts:13-74` (vi.mock + temp-dir lifecycle).

**Runner:** vitest (`package.json:16` → `"test": "vitest"`, vitest `^3.0.5`). No `vitest.config.*` file — uses defaults; `*.test.ts` colocated with source is auto-discovered.
**Assertion style:** `expect(...)` (`describe`/`it`/`expect` from `vitest`).
**Mock approach:** `vi.mock("<module.js>", () => ({ ... }))` at top level; `vi.clearAllMocks()` in `beforeEach`.
**File naming:** `<name>.test.ts`, colocated next to the source (`src/orchestrator/contract-materialization.test.ts`).
**Temp dir lifecycle** (from `run.test.ts:59-74` / `documenter-agent.test.ts:18-20`):
```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-materialize-"));
  vi.clearAllMocks();
});
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});
```

**Mock `generateContractPrecision`** (no existing test does this — establish it). It is imported by the helper from `./planner-agent.js`, so mock that module. Mock ONLY what the helper imports to avoid pulling in heavy planner deps:
```ts
vi.mock("./planner-agent.js", () => ({
  generateContractPrecision: vi.fn(async () => ({
    nonGoals: ["Do not implement the settings UI in this sprint"],
    stopConditions: ["npm test passes and the helper exports materializeContracts"],
    definitionOfDone:
      "The helper materializes one contract per feature and persists each to .bober/contracts.",
    assumptions: ["assumption A"],
    outOfScope: ["deferred work B"],
  })),
}));
```
> Use REAL `createContract`, `saveContract`, `listContracts` (do NOT mock them) so the test exercises real disk write + the precision gate + lexical ordering. With the precision mock returning substantive (non-banned) strings, `saveContract`'s precision gate (`src/state/sprint-state.ts:51-60`) will pass.

**Ready-to-adapt test skeleton:**
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpec } from "../contracts/spec.js";
import { listContracts } from "../state/index.js";

vi.mock("./planner-agent.js", () => ({
  generateContractPrecision: vi.fn(async () => ({ /* substantive precision, see above */ })),
}));

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-materialize-")); vi.clearAllMocks(); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

function specWith(n: number) {
  return createSpec(
    "Test plan",
    "A plan with N features for materialization tests.",
    Array.from({ length: n }, (_, i) => ({
      title: `Feature ${i + 1}`,
      description: `Description for feature ${i + 1} that is long enough to be valid.`,
      priority: "medium" as const,
      acceptanceCriteria: [`Acceptance criterion that is sufficiently long for feature ${i + 1}.`],
    })),
    { status: "ready" as const, specId: undefined }, // see note: createSpec auto-generates specId
  );
}

describe("materializeContracts", () => {
  it("S1-C3: feature-derived content parity (3 features)", async () => {
    const { materializeContracts } = await import("./contract-materialization.js");
    const cfg = { planner: { model: "x" } } as never; // mock makes config unused by precision call
    const spec = specWith(3);
    const out = await materializeContracts(spec, tmpDir, cfg);
    expect(out).toHaveLength(3);
    expect(out[0].title).toBe("Feature 1");
    expect(out[0].sprintNumber).toBe(1);
    expect(out[0].features).toEqual([spec.features[0].featureId]);
    expect(out[0].successCriteria[0].verificationMethod).toBe("agent-evaluation");
    expect(out[0].status).toBe("proposed");
    expect(out[0].nonGoals.length).toBeGreaterThan(0); // precision applied, not placeholder
  });

  it("S1-C4: deterministic zero-padded ids; listContracts order == sprintNumber order for 12+ sprints", async () => {
    const { materializeContracts } = await import("./contract-materialization.js");
    const cfg = {} as never;
    const spec = specWith(12);
    await materializeContracts(spec, tmpDir, cfg);
    const listed = await listContracts(tmpDir);
    expect(listed.map((c) => c.contractId)).toEqual(
      Array.from({ length: 12 }, (_, i) => `sprint-${spec.specId}-${String(i + 1).padStart(2, "0")}`),
    );
    expect(listed.map((c) => c.sprintNumber)).toEqual([1,2,3,4,5,6,7,8,9,10,11,12]);
  });
});
```
> IMPORTANT about `createSpec`: it auto-generates `specId` as `spec-${Date.now()}-${counter}` (`src/contracts/spec.ts:197`) and does NOT take a `specId` option in `CreateSpecOptions`. For deterministic id assertions, capture `spec.specId` from the created spec (as shown), OR construct the PlanSpec object literally with a fixed `specId` if you want a hard-coded string. Either works for S1-C4 as long as you assert against `spec.specId`.

> For S1-C2 (delegation + checkpoints remain): a pure unit test of `pipeline.ts`'s `runTsPipeline` would require mocking the entire planner/research/sprint-loop surface (heavy). A lighter, sufficient approach: assert structurally that `pipeline.ts` imports and calls `materializeContracts` (e.g. read the source and assert it contains `materializeContracts(spec, projectRoot, config)` and still contains both `"post-plan"` and `"post-sprint-contract"` checkpoint calls). The `documenter-agent.test.ts` mock surface (lines 27-95) is the template if you choose to run `runTsPipeline` end-to-end with stubs — but that is high-cost; the source-structure assertion satisfies S1-C2's intent more cheaply and reliably.

### E2E Test Pattern
Not applicable — this sprint touches only orchestration/state TypeScript modules. No Playwright config governs this code path.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/cli/commands/run.ts` | `pipeline.ts` (`runPipeline`) | low | Imports `runPipeline`, not the loop internals. Return type `PipelineResult` unchanged. |
| `src/index.ts` | `pipeline.ts` | low | Re-export surface; `runTsPipeline`/`runPipeline` signatures unchanged. |
| `src/mcp/run-manager.ts` | `pipeline.ts` | low | Calls `runPipeline`; unaffected by internal refactor. |
| `src/cli/commands/sprint.ts` | `listContracts`, contract ids | medium | Reads contracts via `listContracts` (line 113) and finds next pending by status (`findNextPendingSprint` line 34). New id format must still be valid filenames — `contractPath` sanitizer (`sprint-state.ts:21`) keeps `a-zA-Z0-9_-`; `sprint-<specId>-NN` is all safe chars. Verify ordering still feeds the loop in execution order. |

### Existing Tests That Must Still Pass
- `src/cli/commands/run.test.ts` — mocks `runPipeline` wholesale (line 42-50); the internal refactor is invisible to it. Must still pass (S1-C5).
- `src/mcp/run-manager.test.ts`, `src/mcp/tools/*.test.ts` — reference `pipeline.js` indirectly; no contract-loop assertions. Verify green.
- `src/orchestrator/documenter-agent.test.ts` — exercises `runSprintCycle` (downstream of the loop) with a mocked `state/index.js` (`saveContract` mocked). The loop change does not touch `runSprintCycle`. Verify green.
- `src/contracts/sprint-contract.test.ts` — tests `createContract` defaults including the `sprint-${Date.now()}-${counter}` id. You are NOT changing `createContract`, so these stay green. Do not modify `createContract`.
- `src/state/*.test.ts` — no test currently exercises `listContracts`; your new test is the first. Adding it must not break existing state tests.

### Features That Could Be Affected
- **Standalone `plan` command (Sprint 2 target)** — shares the to-be-extracted helper. This sprint must leave `materializeContracts` importable and side-effect-clean (no pipeline-only concerns inside it) so Sprint 2 can call it directly. Verify the helper takes ONLY `(spec, projectRoot, config)` and contains no `runWithAudit`/checkpoint/`appendHistory` calls.
- **`run` pipeline** — must produce byte-identical contract CONTENT (only the id string changes) so existing autopilot runs behave the same. Snapshot fields other than `contractId`/`createdAt`/`updatedAt` (per evaluatorNotes).

### Recommended Regression Checks
1. `npm run build` — zero TypeScript errors (S1-C1). Watch for now-unused imports in `pipeline.ts` (`createContract`, `generateContractPrecision`) — remove them if tsc flags them.
2. `npx vitest run src/orchestrator/contract-materialization.test.ts` — new test green (S1-C3, S1-C4).
3. `npx vitest run src/cli/commands/run.test.ts` — green (S1-C5, delegation invisible to it).
4. `npx vitest run` (full suite) — no regressions (S1-C5). Note: per project memory, ~6 pre-existing cockpit-integration E2E MCP failures are KNOWN-UNRELATED; do not attribute them to this sprint.
5. Confirm `pipeline.ts` source still contains both `"post-plan"` and `"post-sprint-contract"` `runWithAudit` calls and the single `materializeContracts(...)` call replacing the loop (S1-C2).

---

## 8. Implementation Sequence

1. **`src/orchestrator/contract-materialization.ts`** (create) — port the loop body verbatim from `pipeline.ts:856-906`, add the deterministic `contract.contractId` assignment, `return contracts`.
   - Verify: file typechecks in isolation; imports `createContract`, `generateContractPrecision`, `saveContract`, `logger`, types `PlanSpec`/`SprintContract`/`BoberConfig`. No checkpoint/audit imports.
2. **`src/orchestrator/pipeline.ts`** (modify) — replace lines 856-906 with `const contracts = await materializeContracts(spec, projectRoot, config);`. Leave the `post-plan` checkpoint (844-851) and `post-sprint-contract` checkpoint (907-914) exactly as-is. Add the `materializeContracts` import. Remove imports that tsc reports as unused.
   - Verify: `npm run build` passes; `contracts` is still `SprintContract[]` and feeds `maxSprints`/`contracts[i]` in the sprint loop (916-939).
3. **`src/orchestrator/contract-materialization.test.ts`** (create) — write S1-C3 (content parity, 3 features) and S1-C4 (zero-padded ids + listContracts ordering, 12 features) using the skeleton in Section 6. Mock `./planner-agent.js`'s `generateContractPrecision`; use real `createContract`/`saveContract`/`listContracts`.
   - Verify: `npx vitest run src/orchestrator/contract-materialization.test.ts` passes.
4. **Run full verification** — `npm run build`, then `npx vitest run` (whole suite). Confirm `run.test.ts` and `documenter-agent.test.ts` still green; ignore the known unrelated cockpit-integration MCP failures.

---

## 9. Pitfalls & Warnings

- **`createContract` has NO `contractId` option.** Do not add one (it is a shared helper with its own test at `sprint-contract.test.ts`; changing its surface is out of scope). Set `contract.contractId` after the call — the codebase already mutates the returned object.
- **`createContract` increments a module-global `contractCounter`** (`sprint-contract.ts:138,163`) and uses `Date.now()` — its default ids are non-deterministic. That is exactly why you OVERWRITE `contractId`. Do not rely on or assert the default id.
- **`contractsDir`/`contractPath` are private.** Do not import them. Verify ordering via `listContracts(projectRoot)` (sorts filenames lexically at `sprint-state.ts:126-128`).
- **`saveContract` is precision-gated** (`sprint-state.ts:51-60`) and Zod-validated (line 44). Your test mock of `generateContractPrecision` MUST return substantive, non-banned strings (no phrases from `BANNED_VAGUE_PHRASES`, `sprint-contract.ts:22-34`), and `definitionOfDone` ≥ 20 chars, or `saveContract` throws. If `precision` is `undefined`, `createContract`'s placeholder `nonGoals[0]` starts with `"Auto-generated contract"` which is NOT a banned phrase, so `saveContract` still succeeds (placeholders pass the save gate; they only fail the generator's separate `isContractPrecise` preflight). Keep this behavior — do not "fix" placeholders.
- **Do NOT move or duplicate the audit checkpoints into the helper.** S1-C2 and the contract's assumptions explicitly require they stay in `pipeline.ts`. The helper has zero `runWithAudit`/`appendHistory`/checkpoint references.
- **Do NOT branch on `spec.sprints`** (nonGoal #2). That embedded-sprints support is Sprint 2.
- **Zero-pad width = 2.** `String(i + 1).padStart(2, "0")` covers 1-99 (S1-C4 needs 12+). Width 1 would break ordering at sprint 10 (`sprint-...-1` < `sprint-...-10` < `sprint-...-2`).
- **Honor ESM `.js` extensions** on every relative import in the new file (build will fail otherwise).
- **Unused-import cleanup in `pipeline.ts`:** after extraction, `createContract` and possibly `generateContractPrecision` become unused there. `saveContract` may still be referenced elsewhere — let `npm run build` (tsc) tell you; do not blindly delete.
- **Known unrelated failures:** the full suite has ~6 pre-existing cockpit-integration E2E MCP failures (per project history). They are NOT a regression from this sprint.
