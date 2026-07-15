# Sprint Briefing: Collapse runSprintCycle's 7 positional params into a single typed options object

**Contract:** sprint-spec-20260621-codebase-health-remediation-2
**Generated:** 2026-06-21T19:05:00Z

> Pure mechanical refactor. Zero behavior change. `runSprintCycle` is internal-only
> (verified absent from `src/index.ts` and `src/mcp/`). The diff is confined to exactly
> three files: `pipeline.ts`, `code-reviewer-agent.test.ts`, `documenter-agent.test.ts`.

---

## 1. Target Files

### src/orchestrator/pipeline.ts (modify)

**Current signature — `runSprintCycle` (lines 158-166):**
```ts
export async function runSprintCycle(
  contract: SprintContract,
  spec: PlanSpec,
  completedContracts: SprintContract[],
  projectRoot: string,
  config: BoberConfig,
  projectContext: ProjectContext,
  pipelineRunId?: string,
): Promise<SprintCycleResult> {
```

**First ~12 lines of the body (lines 167-181) — shows how each param is referenced:**
```ts
  const maxIterations = config.evaluator.maxIterations;
  let currentContract = updateContractStatus(contract, "in-progress");
  await updateContract(projectRoot, currentContract);

  // Audit runId for this sprint cycle: prefer the pipeline-level runId,
  // fall back to a sprint-specific id derived from the contract.
  const sprintRunId = pipelineRunId ?? `sprint-${currentContract.contractId}`;
  // ...
  const curatorEnabled = config.curator?.enabled !== false;
  // body references: spec, completedContracts (e.g. line 196), projectContext (later), etc.
```
The body references `contract`, `spec`, `completedContracts`, `projectRoot`, `config`,
`projectContext`, `pipelineRunId` directly by name. A `const { ... } = params;` destructure
at the top is a **drop-in** — the rest of the body needs zero edits.

**SHADOWING CHECK (done for you):** A strict scan of the body (lines 158-613, the function
ends at 613; `runTsPipeline` starts at 614) for `const|let|var contract|spec|completedContracts|projectRoot|config|projectContext|pipelineRunId`
returned **ZERO matches inside `runSprintCycle`**. Nothing shadows the 7 names — the
destructure is safe. (Hits for `const spec`/`const contract`/`const projectContext` at
lines 721/762/771 etc. are inside `runTsPipeline`, a DIFFERENT function — do NOT touch them.)

**Return type:** `Promise<SprintCycleResult>`. `SprintCycleResult` is a LOCAL interface in
the same file (lines 83-87) — do NOT re-import or re-declare it; keep the return type as-is.
```ts
export interface SprintCycleResult {
  contract: SprintContract;
  evaluation?: EvaluationRunResult;
  generatorResult?: GeneratorResult;
}
```

**All 7 param types are ALREADY imported in pipeline.ts — reuse them, import nothing new:**
| Type | Import site in pipeline.ts |
|------|----------------------------|
| `SprintContract` | `import type { SprintContract } from "../contracts/sprint-contract.js";` (line 16) |
| `PlanSpec` | `import type { PlanSpec } from "../contracts/spec.js";` (line 14) |
| `BoberConfig` | `import type { BoberConfig } from "../config/schema.js";` (line 13) |
| `ProjectContext` | `import type { ContextHandoff, ProjectContext } from "./context-handoff.js";` (line 27) |
| `string` | primitive — for `projectRoot`, `pipelineRunId` |

**Production call site — `pipeline.ts:931-939`** (inside `runTsPipeline`, sprint loop):
```ts
      const result = await runSprintCycle(
        contract,         // arg1 -> field: contract        (local var: contract,  from contracts[i] @928)
        spec,             // arg2 -> field: spec             (local var: spec)
        completedSprints, // arg3 -> field: completedContracts  ⚠ LOCAL NAME DIFFERS
        projectRoot,      // arg4 -> field: projectRoot
        config,           // arg5 -> field: config
        projectContext,   // arg6 -> field: projectContext
        pipelineRunId,    // arg7 -> field: pipelineRunId
      );
```
⚠ **Position-map carefully:** the 3rd local argument is named `completedSprints`, but the
field is `completedContracts`. Object form must be:
```ts
      const result = await runSprintCycle({
        contract,
        spec,
        completedContracts: completedSprints,   // <-- map by position, name differs
        projectRoot,
        config,
        projectContext,
        pipelineRunId,
      });
```

**Imported by:** nothing imports `runSprintCycle` for the production path except its own
file (used at :931). The 5 test invocations obtain it via dynamic
`const { runSprintCycle } = await import("./pipeline.js")` (see section 7).

**Test file for pipeline.ts:** behavior is covered by the two agent test files below
(they directly exercise `runSprintCycle`). There is no `pipeline.test.ts` that calls it.

---

### src/orchestrator/code-reviewer-agent.test.ts (modify)

Two `runSprintCycle` call sites — BOTH use the **6-positional form (NO pipelineRunId)**.

**Call site 1 — line 229-236:**
```ts
    const result = await runSprintCycle(
      testContract,        // -> contract
      testSpec,            // -> spec
      [],                  // -> completedContracts
      tmpRoot,             // -> projectRoot
      minimalConfig,       // -> config
      testProjectContext,  // -> projectContext
    );                     // (no 7th arg; omit pipelineRunId in object form)
```
Object form:
```ts
    const result = await runSprintCycle({
      contract: testContract,
      spec: testSpec,
      completedContracts: [],
      projectRoot: tmpRoot,
      config: minimalConfig,
      projectContext: testProjectContext,
    });
```

**Call site 2 — line 333-340** (inside an IIFE asserting no-throw): identical positional
args (`testContract, testSpec, [], tmpRoot, minimalConfig, testProjectContext`) — convert
to the same object literal as above.

---

### src/orchestrator/documenter-agent.test.ts (modify)

Three `runSprintCycle` call sites — ALL use the **6-positional form (NO pipelineRunId)**.
Note: this file uses `baseConfig` / `disabledConfig` (not `minimalConfig`) for the 5th arg.

**Call site 1 — line 229-236:** `testContract, testSpec, [], tmpRoot, baseConfig, testProjectContext`
**Call site 2 — line 265-272:** `testContract, testSpec, [], tmpRoot, baseConfig, testProjectContext`
**Call site 3 — line 299-306:** `testContract, testSpec, [], tmpRoot, disabledConfig, testProjectContext`

Each becomes (substituting the right config var):
```ts
    const result = await runSprintCycle({
      contract: testContract,
      spec: testSpec,
      completedContracts: [],
      projectRoot: tmpRoot,
      config: baseConfig,           // or disabledConfig for call site 3
      projectContext: testProjectContext,
    });
```

---

## 2. Patterns to Follow

### Exported `*Params` options-object — the EXACT house pattern to copy
**Source:** `src/orchestrator/agentic-loop.ts`, lines 8-45 (interface) + 230-247 (consumer)
```ts
// interface declared adjacent to / above the function:
export interface AgenticLoopParams {
  /** Provider-agnostic LLM client. */
  client: LLMClient;
  /** Model ID (resolved via model-resolver). */
  model: string;
  // ... required fields, then optional fields with `?`:
  maxTokens?: number;
  // ...
}

// the function takes ONE typed object and destructures at the top:
export async function runAgenticLoop(
  params: AgenticLoopParams,
): Promise<AgenticLoopResult> {
  const {
    client,
    model,
    systemPrompt,
    // ...
    maxNudges = 2,
    nudgeMessage,
  } = params;
  // ...body uses the destructured names...
}
```
**Rule:** Declare `export interface RunSprintCycleParams { ... }` adjacent to
`runSprintCycle`; change the signature to `(params: RunSprintCycleParams)`; make the
FIRST body line `const { contract, spec, completedContracts, projectRoot, config, projectContext, pipelineRunId } = params;`. This is exactly how `runAgenticLoop` already works in this codebase.

### `interface` over `type` for object shapes
**Source:** `src/orchestrator/agentic-loop.ts:8` (`export interface AgenticLoopParams`),
`src/orchestrator/agentic-loop.ts:134` (`export interface CoerceJsonParams`),
`src/orchestrator/pipeline.ts:83` (`export interface SprintCycleResult`)
**Rule:** Use `export interface RunSprintCycleParams { ... }` (NOT a `type` alias). All
Params/Options/Result object shapes in this module are declared as `interface`.

### ESM `.js` import suffix
**Source:** `src/orchestrator/pipeline.ts:13-16` (`from "../config/schema.js"` etc.)
**Rule:** All relative imports carry the `.js` extension. Do not add any new import for
this sprint (all types are already present), but if you ever annotate a var with the type
at a call site, use `import type { RunSprintCycleParams } from "./pipeline.js";`.

---

## 3. Existing Utilities — DO NOT Recreate

This is a pure type/signature refactor — no new utility code is created. The relevant
"utilities" are the existing types/functions the body already uses; reuse them as-is.

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `RunSprintCycleParams` (TO CREATE) | `src/orchestrator/pipeline.ts` (adjacent to :158) | `interface { contract; spec; completedContracts; projectRoot; config; projectContext; pipelineRunId? }` | The new options object — the only thing this sprint adds |
| `SprintCycleResult` | `src/orchestrator/pipeline.ts:83` | `interface { contract; evaluation?; generatorResult? }` | Return type — reuse, do not touch |
| `AgenticLoopParams` | `src/orchestrator/agentic-loop.ts:8` | `interface {...}` | Template precedent for the options-object pattern |
| `updateContractStatus` | imported in pipeline.ts (`../contracts/sprint-contract.js`) | `(contract, status) => SprintContract` | Used in body line 168 — unchanged |
| `updateContract` | imported in pipeline.ts (`../state/index.js`) | `(projectRoot, contract) => Promise<void>` | Used in body line 169 — unchanged |

Utilities reviewed: `src/utils/` (git.ts, logger.ts), `src/orchestrator/*` shared modules —
none need to be added or modified for this refactor.

---

## 4. Prior Sprint Output

### Sprint 1: broke the critic-deep ↔ decomposer-deep import cycle (PASSED)
**Files:** `src/fleet/critic-deep.ts`, `src/fleet/decomposer-deep.ts` (dependency injection).
**Connection to this sprint:** NONE. Unrelated files (fleet module), zero overlap with
`src/orchestrator/pipeline.ts`. No imports to carry forward. Sprint 2 has `dependsOn: []`.

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` consulted for this sprint (mechanical refactor). The binding
constraints are the contract's `nonGoals` / `outOfScope`: change ONLY param access; no
logic, control-flow, or ordering edits; keep field names = current param names; keep
`pipelineRunId` optional; do not promote to public API/MCP.

### Architecture Decisions
No ADR governs this internal signature. The contract explicitly states `runSprintCycle` is
internal (not in `src/index.ts`, not in MCP) — keep it that way (sc-2-5).

### Other Docs
House convention precedent is in-code: `agentic-loop.ts` (options-object + destructure)
and the colocated-test convention noted in `code-reviewer-agent.test.ts:13-15`
("Colocated with ... per the project convention").

---

## 6. Testing Patterns

### Unit Test Pattern
**Source:** `src/orchestrator/code-reviewer-agent.test.ts:18-24, 215, 229-236`
```ts
import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";
import type { SprintContract } from "../contracts/sprint-contract.js";
import type { PlanSpec } from "../contracts/spec.js";
import type { ProjectContext } from "./context-handoff.js";
// ...heavy deps vi.mock'd at top...

// runSprintCycle is obtained via DYNAMIC import inside each test:
const { runSprintCycle } = await import("./pipeline.js");
const result = await runSprintCycle(/* args */);
```
**Runner:** vitest
**Assertion style:** `expect(...)` (e.g. `expect(result.contract.status).toBe("passed")`)
**Mock approach:** `vi.mock(...)` for heavy deps; `vi.mocked(fn)` to spy; `mockResolvedValue` / `mockRejectedValueOnce`
**Dynamic import:** `const { runSprintCycle } = await import("./pipeline.js")` — the object-literal
conversion happens at the CALL line, NOT at the import. The destructured `runSprintCycle`
binding is unchanged.
**File naming / location:** `<module>.test.ts`, colocated next to the module
(`src/orchestrator/*.test.ts`).

**No `import type { RunSprintCycleParams }` is needed in the tests.** TypeScript structurally
checks the object literal against the parameter type at the call site — the tests pass a bare
`{ ... }` literal and TS validates it. (Mirrors how `runAgenticLoop` callers pass inline
object literals without importing `AgenticLoopParams`.) Only add an `import type` if you
introduce a separately-typed variable, which is not required here.

### E2E Test Pattern
Not applicable — this is an internal TS refactor with no UI surface.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/orchestrator/pipeline.ts` (self, :931) | `runSprintCycle` | low | Convert the sole prod call to object form; map `completedSprints` -> `completedContracts` |
| `src/orchestrator/code-reviewer-agent.test.ts` | `runSprintCycle` (dyn import) | low | 2 call sites -> object form (6 fields, no pipelineRunId) |
| `src/orchestrator/documenter-agent.test.ts` | `runSprintCycle` (dyn import) | low | 3 call sites -> object form (watch baseConfig vs disabledConfig) |

No other file imports or calls `runSprintCycle` (grep-verified — 6 invocation sites total,
all listed above). It is NOT re-exported anywhere.

### Existing Tests That Must Still Pass
- `src/orchestrator/code-reviewer-agent.test.ts` — directly exercises `runSprintCycle` (cases
  a & c); MUST pass after converting both call sites. Asserts `result.contract.status === "passed"`,
  `runCodeReviewer` spawned with the propagated contract+evaluation, and the no-throw advisory path.
- `src/orchestrator/documenter-agent.test.ts` — directly exercises `runSprintCycle` (cases
  a, b, c); MUST pass after converting all three call sites. Asserts documenter spawn args,
  the no-throw advisory path, and the `documenter.enabled === false` skip.

### Features That Could Be Affected
- **Sprint generate-evaluate-iterate loop** (`runTsPipeline`, pipeline.ts:614) — calls
  `runSprintCycle` at :931. Verify the loop still pushes to `completedSprints` / `failedSprints`
  based on `result.contract.status` (behavior must be byte-identical).

### Recommended Regression Checks
After implementation, the Generator MUST run:
1. `npm run typecheck` — zero errors (catches any mis-mapped field, esp. `completedContracts`).
2. `npm run build` — zero errors.
3. `npx vitest run src/orchestrator/code-reviewer-agent.test.ts src/orchestrator/documenter-agent.test.ts` — all pass.
4. `npm run lint` — zero errors.
5. `grep -rnE 'runSprintCycle\(' src/ | grep -v 'export async function'` — every line is an
   object-form `runSprintCycle({` call; NONE positional (sc-2-3).
6. `grep -rnE 'runSprintCycle' src/index.ts src/mcp/` — ZERO matches (sc-2-5, internal-only).
7. `git diff --stat` — touches ONLY `pipeline.ts`, `code-reviewer-agent.test.ts`,
   `documenter-agent.test.ts` (sc-2-6 / evaluatorNotes).
8. (Optional) Full suite: only the 6 known cockpit-integration failures may remain (sc-2-4).

---

## 8. Implementation Sequence

1. **`src/orchestrator/pipeline.ts` — declare the type.** Add, adjacent to and above
   `runSprintCycle` (e.g. just before line 158, after the `SprintCycleResult` interface or in
   the "Sprint cycle" section), an `export interface RunSprintCycleParams` with the 7 fields,
   `pipelineRunId?: string` optional. Reuse the already-imported types — import nothing new.
   - Verify: `npm run typecheck` shows the interface is recognized (no "cannot find name").
2. **`src/orchestrator/pipeline.ts` — change the signature + add destructure.** Replace the
   7 positional params (lines 158-166) with `(params: RunSprintCycleParams): Promise<SprintCycleResult>`.
   Make line 167 (new first body line) `const { contract, spec, completedContracts, projectRoot, config, projectContext, pipelineRunId } = params;`. Touch nothing else in the body.
   - Verify: `git diff` of the body shows ONLY the signature swap + one added destructure line.
3. **`src/orchestrator/pipeline.ts:931` — convert the prod call.** Object literal; map
   `completedSprints` -> `completedContracts: completedSprints`.
   - Verify: `npm run typecheck` passes (this is where a field typo surfaces).
4. **`src/orchestrator/code-reviewer-agent.test.ts` — convert 2 call sites** (:229, :333) to
   object form (6 fields, no `pipelineRunId`, config = `minimalConfig`).
   - Verify: `npx vitest run src/orchestrator/code-reviewer-agent.test.ts` passes.
5. **`src/orchestrator/documenter-agent.test.ts` — convert 3 call sites** (:229, :265, :299).
   Config = `baseConfig` for :229/:265, `disabledConfig` for :299.
   - Verify: `npx vitest run src/orchestrator/documenter-agent.test.ts` passes.
6. **Run full verification** — `npm run build`, `npm run typecheck`, `npm run lint`, the two
   grep checks (sc-2-3, sc-2-5), and `git diff --stat` (3 files only).

---

## 9. Pitfalls & Warnings

- **`completedSprints` vs `completedContracts`:** the prod call site (:934) passes a local
  named `completedSprints` into the 3rd position. The field is `completedContracts`. Map by
  POSITION: `completedContracts: completedSprints`. This is the single most likely mistake.
- **Do NOT touch `runTsPipeline` (line 614).** It has its own locals named `spec`, `contract`,
  `projectContext`, `config` (lines ~721/762/771). The shadowing grep hit those — they are a
  DIFFERENT function and are out of scope. Only the `:931` call inside it changes.
- **No new imports.** All 7 param types (`SprintContract`, `PlanSpec`, `BoberConfig`,
  `ProjectContext`, `string`) are already imported in pipeline.ts (lines 13-27). `SprintCycleResult`
  is local (line 83). Adding a redundant import will trip the lint/no-duplicate rule.
- **Tests need NO `import type { RunSprintCycleParams }`.** They pass bare object literals;
  TS structurally validates them. sc-2-6's "import type ... where applicable" = only if you
  annotate a variable, which this sprint does not require. Don't add an unused import.
- **`pipelineRunId` stays optional.** Test call sites omit it (6 args today). In object form,
  simply leave the `pipelineRunId` key out — do NOT pass `pipelineRunId: undefined` unless you
  prefer to; either is fine, but omission matches the current 6-arg behavior most cleanly.
- **Keep `interface`, not `type`.** House convention (AgenticLoopParams, SprintCycleResult,
  CoerceJsonParams all `interface`). A `type` alias would be a style regression.
- **Use `export interface`** (the contract requires a *named, exported* type — sc-2-2).
- **Behavior must be byte-identical** (sc-2-4): the ONLY net-new line inside the body is the
  destructure. No reordering of `updateContractStatus` / `updateContract` / audit calls.
