# Sprint Briefing: Panel config, lens-aware evaluator, and reconcile wiring

**Contract:** sprint-spec-20260604-evaluator-lens-panel-1
**Generated:** 2026-06-04T01:30:00Z

---

## 1. Target Files

### src/config/schema.ts (modify)

**Relevant section — `EvaluatorSectionSchema` (lines 104-113):**
```ts
export const EvaluatorSectionSchema = z.object({
  model: GeneratorModelSchema.default("sonnet"),
  strategies: z.array(EvalStrategySchema),
  maxIterations: z.number().int().min(1).default(3),
  plugins: z.array(z.string()).optional(),
  provider: z.string().optional(),
  endpoint: z.string().nullable().optional(),
  providerConfig: z.record(z.string(), z.unknown()).optional(),
});
export type EvaluatorSection = z.infer<typeof EvaluatorSectionSchema>;
```
**Add** (per generatorNotes STEP 1) a `panel` field to this object:
```ts
  panel: z.object({
    enabled: z.boolean().default(false),
    lenses: z.array(z.string()).default([]),
    maxConcurrent: z.number().int().min(1).default(4),
  }).default({ enabled: false, lenses: [], maxConcurrent: 4 }),
```
The sibling schemas use the same `z.object({...}).default(...)` style; `PipelineSectionSchema` (line 147) is a nested-default precedent. Sub-defaults plus the outer `.default({...})` guarantee criterion C1: a config that omits `panel` still parses and resolves to the default.

**Relevant section — `createDefaultConfig` evaluator block (lines 377-381):**
```ts
    evaluator: {
      model: "sonnet",
      strategies: defaultStrategiesForMode(mode, preset),
      maxIterations: 3,
    },
```
**Mirror** the field here:
```ts
    evaluator: {
      model: "sonnet",
      strategies: defaultStrategiesForMode(mode, preset),
      maxIterations: 3,
      panel: { enabled: false, lenses: [], maxConcurrent: 4 },
    },
```
`createDefaultConfig` is exported at line 350. Note its `base` is typed `BoberConfig` (the parsed type), so once the schema field exists, TypeScript will REQUIRE `panel` here unless the schema `.default()` makes it optional on the input type — it does NOT make it optional on the output `z.infer` type (defaults produce a present, non-optional output key). So `panel` MUST be added to the `evaluator` literal or `tsc` fails. This is the literal the contract's stopCondition references.

**Imported by (EvaluatorSection / EvaluatorSectionSchema consumers — verify these still typecheck):**
- `src/config/index.ts`, `src/index.ts`, `src/mcp/tools/sprint.ts`, `src/mcp/tools/eval.ts`, `src/cli/commands/sprint.ts`, `src/cli/commands/eval.ts`, `src/orchestrator/pipeline.ts`

**Test file:** `src/config/schema.test.ts` (exists — add a panel describe block; see Section 6)

---

### src/config/defaults.ts (modify — ONLY IF its literals need the field)

This file builds `Partial<BoberConfig>` literals (`greenfieldBase` line 176, `brownfieldBase` line 217, and per-preset `presetDefaults` line 60). Each has an `evaluator: { model, strategies, maxIterations }` literal, e.g. lines 187-191:
```ts
  evaluator: {
    model: "sonnet",
    strategies: [buildStrategy, lintOptionalStrategy],
    maxIterations: 3,
  },
```
**These are typed `Partial<BoberConfig>`, and `EvaluatorSection` is NOT itself made partial** — so an `evaluator` object here must satisfy the full `EvaluatorSection` shape. AFTER you add a non-optional `panel` to the schema, ALL six evaluator literals in this file (greenfieldBase:187, brownfieldBase:228, nextjs:62, react-vite:87, solidity:124, anchor:136, api-node:148, python-api:161) will fail `tsc` unless `panel` is added.

DECISION: Run `npx tsc --noEmit` after the schema change. If these literals error, add `panel: { enabled: false, lenses: [], maxConcurrent: 4 }` to EACH evaluator literal in defaults.ts. (Alternatively, but ONLY if it doesn't break callers, keep it minimal — but the safe path is to add the field everywhere `tsc` complains.) Do not guess — let `tsc` tell you which literals need it.

**Test file:** none (no defaults.test.ts)

---

### src/orchestrator/evaluator-agent.ts (modify) — READ FULLY

**`runEvaluatorAgent` combine (lines 41-122)** — DO NOT CHANGE. The combine at line 112 is:
```ts
  const evaluation: EvaluationRunResult = {
    passed: programmaticEval.passed && agentResult.passed,   // line 112
    score: avgScore,
    results: allResults,
    summary: summaryParts.join(". "),
    timestamp: new Date().toISOString(),
  };
```
`agentResult` comes from the call at lines 86-91:
```ts
  const agentResult = await runAgentEvaluation(
    handoff,
    programmaticEval.results,
    projectRoot,
    config,
  );
```
The reconciled panel `EvalResult` must flow OUT of `runAgentEvaluation` unchanged into this combine. C4 depends on this path staying intact.

**`runAgentEvaluation` (lines 134-275)** — this is the function to refactor. Today it is a single function that: builds the prompt (lines 159-222), calls `createClient` once (lines 153-158), runs `runAgenticLoop` (lines 239-253), and returns `parseEvalResult(result.finalText, timestamp)` (line 259). The createClient call:
```ts
    const client = createClient(
      config.evaluator.provider ?? null,
      config.evaluator.endpoint ?? null,
      config.evaluator.providerConfig,
      config.evaluator.model,
    );
```
The prompt assembly (the part to refactor into a lens-aware helper) — `userMessage` is built at lines 182-222 and starts:
```ts
    const userMessage = `# Context Handoff
${handoffJson}

# Project Root
${projectRoot}

# Automated Check Results (already completed)
${programmaticSummary}

# Success Criteria
...
```

**REFACTOR PLAN (generatorNotes STEP 2 + 3):**
1. Extract the ENTIRE current body of `runAgentEvaluation` (the try/catch, lines 140-274) into a new inner helper:
   ```ts
   async function runSingleLensEval(
     handoff: ContextHandoff,
     programmaticResults: EvalResult[],
     projectRoot: string,
     config: BoberConfig,
     lens?: string,
   ): Promise<EvalResult> { /* current body */ }
   ```
2. When `lens` is provided, inject a focus block into the prompt. The cleanest byte-identical-preserving spot: build the `userMessage` exactly as today, then append the lens block ONLY when `lens` is defined, e.g. after line 222:
   ```ts
   const lensBlock = lens
     ? `\n\n## Evaluation Lens: ${lens}\nFocus your judgment specifically on the ${lens} dimension; other concerns are out of scope for this judge.`
     : "";
   // then use `${userMessage}${lensBlock}` where userMessage was previously used
   ```
   CRITICAL for C2: when `lens === undefined`, `lensBlock === ""`, so the prompt is BYTE-IDENTICAL to today. Do not reorder or reformat the existing `userMessage` template literal — only conditionally append.
3. Rewrite `runAgentEvaluation` to dispatch on the panel config:
   ```ts
   async function runAgentEvaluation(handoff, programmaticResults, projectRoot, config): Promise<EvalResult> {
     const panel = config.evaluator.panel;
     if (!panel.enabled || panel.lenses.length < 2) {
       return runSingleLensEval(handoff, programmaticResults, projectRoot, config); // off path — ONE call, no lens
     }
     // on path: bounded-concurrency fan-out
     const lensResults = await mapBounded(panel.lenses, panel.maxConcurrent,
       (lens) => runSingleLensEval(handoff, programmaticResults, projectRoot, config, lens));
     const contractId = handoff.currentContract?.contractId ?? "unknown";
     return reconcile(contractId, 1, lensResults, new Date().toISOString());
   }
   ```
   NOTE: `ContextHandoff` has NO `iteration` field (verified — schema lines 41-53 has only timestamp/from/to/projectContext/spec/currentContract/sprintHistory/instructions/changedFiles/decisions/issues). Per contract assumption #2, reconcile ignores round for output, so pass `1`. Get the contractId from `handoff.currentContract?.contractId` (same pattern `runEvaluatorAgent` uses at line 51: `const sprintId = contract.contractId;`).
4. Add the bounded-concurrency helper (no existing util — see Section 3). Chunk-based is simplest:
   ```ts
   async function mapBounded<T, R>(items: T[], cap: number, fn: (x: T) => Promise<R>): Promise<R[]> {
     const out: R[] = [];
     for (let i = 0; i < items.length; i += cap) {
       const batch = items.slice(i, i + cap);
       out.push(...(await Promise.all(batch.map(fn))));
     }
     return out;
   }
   ```
   This guarantees peak concurrency <= cap (C3). A counter-based pool also works; chunking is the least error-prone.

**New import to add:** `import { reconcile } from "./workflow/reconciler.js";` (note the `.js` specifier — ESM/NodeNext, see principles).

**Imported by (runEvaluatorAgent consumers — verify still pass):**
- `src/orchestrator/pipeline.ts`, `src/cli/commands/eval.ts`, `src/mcp/tools/eval.ts`, `src/index.ts`, `src/cli/commands/sprint.ts`, `src/mcp/tools/sprint.ts`. Also mocked in `src/orchestrator/code-reviewer-agent.test.ts:76`.

**Test file:** `src/orchestrator/evaluator-agent.test.ts` (does NOT exist — create it)

---

### src/orchestrator/evaluator-agent.test.ts (create)

**Directory pattern:** Orchestrator tests are colocated as `*.test.ts` next to the module (`src/orchestrator/agent-loader.test.ts`, `code-reviewer-agent.test.ts`, `model-resolver.test.ts`).
**Most similar existing file:** `src/orchestrator/code-reviewer-agent.test.ts` — follow its `vi.mock(...)` setup style (lines 18-104). See Section 6 for the full template.

---

## 2. Patterns to Follow

### Nested Zod object with full defaults (config schema)
**Source:** `src/config/schema.ts`, lines 147-149 (PipelineSectionSchema precedent) and 104-113 (EvaluatorSectionSchema target)
```ts
export const PipelineSectionSchema = z.object({
  maxIterations: z.number().int().min(1).default(20),
  ...
```
**Rule:** Give every sub-field a `.default()` AND give the wrapping `z.object` a `.default({...})` so an entirely-absent `panel` key still parses to the full default (C1).

### Unicode box-drawing section headers
**Source:** `src/orchestrator/evaluator-agent.ts`, lines 23, 27, 125, 277
```ts
// ── Constants ──────────────────────────────────────────────────────
// ── Main ───────────────────────────────────────────────────────────
// ── Agent evaluation with tools ────────────────────────────────────
```
**Rule:** Organize new helpers with `// ── Section Name ──...` headers (principles: "Section comments").

### ESM `.js` specifiers + `import type`
**Source:** `src/orchestrator/evaluator-agent.ts`, lines 1-19
```ts
import type { BoberConfig } from "../config/schema.js";
import type { EvalResult } from "../contracts/eval-result.js";
import { createClient } from "../providers/factory.js";
```
**Rule:** Type-only imports use `import type` (ESLint `consistent-type-imports` is a hard gate); all relative imports end in `.js`.

### Reuse reconcile() — DO NOT reimplement
**Source:** `src/orchestrator/workflow/reconciler.ts`, lines 17-22
```ts
export function reconcile(
  _sprintId: string,
  _round: number,
  lensVerdicts: EvalResult[],
  timestamp: string,
): EvalResult
```
**Rule:** Call `reconcile(contractId, 1, lensResults, new Date().toISOString())`. It returns `evaluator: "panel"`, strict-majority `passed = passCount > failCount` (fail-closed on tie), and echoes the timestamp verbatim. It THROWS on empty input — the `lenses.length < 2` guard ensures it's only called with >=2 verdicts.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `reconcile` | `src/orchestrator/workflow/reconciler.ts:17` | `(sprintId: string, round: number, lensVerdicts: EvalResult[], timestamp: string): EvalResult` | Pure majority-vote reducer over per-lens EvalResults; `evaluator="panel"`, fail-closed on tie. USE THIS for the on-path. |
| `createClient` | `src/providers/factory.ts:172` | `(provider?, endpoint?, providerConfig?, model?, role?): LLMClient` | Builds the provider-agnostic LLM client; called once per lens. Mock this in tests. |
| `runAgenticLoop` | `src/orchestrator/agentic-loop.ts:62` | `(params: AgenticLoopParams): Promise<AgenticLoopResult>` | Multi-turn loop; returns `{ finalText, turnsUsed, toolsCalled, usage, stopReason }`. Mock this to return per-lens JSON verdict text. |
| `resolveModel` | `src/orchestrator/model-resolver.ts` (imported evaluator-agent.ts:13) | `(model): string` | Resolves model shorthand. Already used inside runSingleLensEval body. |
| `assembleSystemPrompt` | `src/orchestrator/agent-loader.ts` (imported line 14) | `("evaluator", "bober-evaluator", projectRoot, graphState)` | Loads the system prompt; reused unchanged in the helper. |
| `aggregateResults` / `formatFeedback` | `src/contracts/eval-result.ts:94 / :125` | EvalResult helpers | NOT needed this sprint (reconcile handles aggregation) — listed so you don't confuse them with reconcile. |

**Bounded-concurrency helper:** searched `src/utils/`, `src/orchestrator/`, `src/` for `mapBounded`/`pLimit`/`concurrency`/`pool` — NO reusable bounded-concurrency util exists. Write a tiny inline `mapBounded` (or chunk-and-Promise.all) inside evaluator-agent.ts as shown in Section 1. Do not add a dependency.

Utilities reviewed: `src/utils/` (git.ts, logger.ts, fs.ts), `src/orchestrator/`, `src/contracts/eval-result.ts`, `src/orchestrator/workflow/reconciler.ts`.

---

## 4. Prior Sprint Output

No prior sprints completed for THIS plan (`dependsOn: []`). However the reconcile() reducer this sprint wires in was built earlier on this branch:
- **`reconcile()`** — `src/orchestrator/workflow/reconciler.ts` (commit 0e6cb62 "add pure EvaluatorPanelReconciler majority-vote reducer"). Exports `reconcile(sprintId, round, lensVerdicts, timestamp): EvalResult`. This sprint's on-path consumes it as-is; the contract's nonGoals explicitly forbid modifying it.

---

## 5. Relevant Documentation

### Project Principles
From `.bober/principles.md`:
- **ESM everywhere** — all relative imports use `.js` extensions (NodeNext).
- **`import type`** — ESLint `consistent-type-imports` is enforced; type-only imports must use `import type`.
- **Zod for config validation** — config schemas live in `config/schema.ts`; runtime uses `z.parse()`.
- **Unicode section headers** — `// ── Section Name ──...`.
- **Prefix unused params with `_`** — only escape hatch for unused vars (reconcile uses `_sprintId`, `_round`).
- **TypeScript strict** — `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `isolatedModules`; zero type errors is a hard gate.
- **Conventional commit:** `bober(sprint-1): add evaluator.panel config + lens-aware reconcile wiring`.

### Architecture Decisions
reconciler.ts references ADR-4 (pure majority-vote reducer). No additional ADR action needed this sprint.

### Other Docs
None additional required.

---

## 6. Testing Patterns

### Unit Test Pattern (mock createClient + runAgenticLoop)
**Source:** `src/orchestrator/code-reviewer-agent.test.ts`, lines 18-104 (vi.mock setup, top-of-file)
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../graph/pipeline-lifecycle.js", () => ({
  graphPipelineLifecycle: {
    engineHealth: vi.fn().mockReturnValue("disabled"),
    getGraphClient: vi.fn().mockReturnValue(null),
    getGraphDeps: vi.fn().mockReturnValue(null),
  },
}));
```
**Runner:** vitest · **Assertion style:** `expect(...)` · **Mock approach:** `vi.mock(<.js specifier>, factory)` hoisted at top of file · **File naming:** `<module>.test.ts` colocated.

**Recommended mock strategy for THIS sprint.** `runAgentEvaluation` calls `createClient` (factory.js:172) once per lens AND `runAgenticLoop` (agentic-loop.js:62) once per lens. The judge VERDICT text comes from `runAgenticLoop().finalText`, which `parseEvalResult` turns into the EvalResult. To make each lens return a deterministic pass/fail you must control `runAgenticLoop`'s return; to count calls + concurrency you can spy on EITHER (they're 1:1). Mock both:
```ts
import type { EvalResult } from "../contracts/eval-result.js";

// Track concurrency on the LLM call
let active = 0;
let peak = 0;
const verdicts: boolean[] = []; // queue of pass/fail, one per lens, FIFO
const loopSpy = vi.fn(async () => {
  active++; peak = Math.max(peak, active);
  await new Promise((r) => setTimeout(r, 5)); // force overlap so concurrency is observable
  const passed = verdicts.shift() ?? true;
  active--;
  return {
    finalText: JSON.stringify({
      evaluator: "Agent Evaluation", passed, score: passed ? 90 : 10,
      details: [], summary: passed ? "ok" : "bad", feedback: "fb",
      timestamp: new Date().toISOString(),
    }),
    turnsUsed: 1, toolsCalled: [], usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "end_turn",
  };
});
const clientSpy = vi.fn(() => ({ /* unused stub LLMClient */ } as never));

vi.mock("../orchestrator/agentic-loop.js", () => ({ runAgenticLoop: loopSpy }));
// NOTE specifier is relative to THIS test file: "./agentic-loop.js"
vi.mock("./agentic-loop.js", () => ({ runAgenticLoop: loopSpy }));
vi.mock("../providers/factory.js", () => ({ createClient: clientSpy }));
// also mock provider factory via the path evaluator-agent.ts uses: "../providers/factory.js"
// (evaluator-agent.ts is in src/orchestrator, so from there it is "../providers/factory.js")
vi.mock("./model-resolver.js", () => ({ resolveModel: () => "claude-test" }));
vi.mock("./agent-loader.js", () => ({ assembleSystemPrompt: vi.fn().mockResolvedValue("SYS") }));
vi.mock("./tools/index.js", () => ({
  resolveRoleTools: () => ({ schemas: [], handlers: new Map() }),
  getGraphState: () => ({ enabled: false, engineHealth: "disabled" }),
  getGraphDeps: () => undefined,
}));
vi.mock("../graph/preflight-injector.js", () => ({
  PreflightContextInjector: class { async inject(_r: string, _c: unknown, m: string) { return m; } },
}));
vi.mock("../graph/pipeline-lifecycle.js", () => ({
  graphPipelineLifecycle: { getGraphClient: () => null, engineHealth: () => "disabled", getGraphDeps: () => null },
}));
vi.mock("../telemetry/emit.js", () => ({ emit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../evaluators/registry.js", () => ({
  createDefaultRegistry: vi.fn().mockResolvedValue({}),
  runEvaluation: vi.fn().mockResolvedValue({ passed: true, results: [] }), // programmatic passes → panel decides (C4)
}));
vi.mock("../utils/git.js", () => ({ getChangedFiles: vi.fn().mockResolvedValue([]) }));
```
IMPORTANT mock-path note: `vi.mock` paths must match the specifier as the SOURCE module imports it. evaluator-agent.ts lives in `src/orchestrator/`, so it imports `../providers/factory.js`, `./agentic-loop.js`, `../evaluators/registry.js`, etc. The test file is also in `src/orchestrator/`, so use the SAME relative specifiers (e.g. `"./agentic-loop.js"`, `"../providers/factory.js"`). Do not double-mock with two paths — pick the one the source uses.

**Test cases to write (map to criteria):**
```ts
beforeEach(() => { active = 0; peak = 0; verdicts.length = 0; loopSpy.mockClear(); clientSpy.mockClear(); });

it("C2 off path: panel disabled → exactly one judge call", async () => {
  const config = makeConfig({ panel: { enabled: false, lenses: [], maxConcurrent: 4 } });
  await runEvaluatorAgent(handoff, "/tmp/proj", config);
  expect(loopSpy).toHaveBeenCalledTimes(1);
});

it("C3 on path: 3 lenses → 3 calls, peak concurrency <= maxConcurrent", async () => {
  verdicts.push(true, true, true);
  const config = makeConfig({ panel: { enabled: true, lenses: ["a","b","c"], maxConcurrent: 2 } });
  await runEvaluatorAgent(handoff, "/tmp/proj", config);
  expect(loopSpy).toHaveBeenCalledTimes(3);
  expect(peak).toBeLessThanOrEqual(2);
});

it("C4 tie: 2 pass + 2 fail → EvaluationRunResult.passed === false", async () => {
  verdicts.push(true, true, false, false);
  const config = makeConfig({ panel: { enabled: true, lenses: ["a","b","c","d"], maxConcurrent: 4 } });
  const out = await runEvaluatorAgent(handoff, "/tmp/proj", config);
  expect(out.passed).toBe(false);
});
```
Build a `makeConfig` helper that returns a full `BoberConfig` (use `createDefaultConfig("test","greenfield")` then override `evaluator.panel`) and a minimal `handoff` fixture with `currentContract` set (so `runEvaluatorAgent` line 47 guard passes). Look at `code-reviewer-agent.test.ts:108` for a `SprintContract` fixture shape.

### Schema panel test
**Source:** `src/config/schema.test.ts`, lines 1-13 (existing style)
```ts
import { describe, it, expect } from "vitest";
import { EvaluatorSectionSchema } from "./schema.js";

describe("EvaluatorSectionSchema.panel", () => {
  it("defaults panel to disabled/empty/4 when omitted", () => {
    const parsed = EvaluatorSectionSchema.parse({ strategies: [] });
    expect(parsed.panel).toEqual({ enabled: false, lenses: [], maxConcurrent: 4 });
  });
  it("rejects maxConcurrent < 1", () => {
    expect(() => EvaluatorSectionSchema.parse({ strategies: [], panel: { maxConcurrent: 0 } })).toThrow();
  });
});
```
(`strategies` has no default in the schema — line 106 `z.array(EvalStrategySchema)` with no `.default()` — so you MUST pass `strategies: []` for `.parse({...})` to succeed.)

### E2E Test Pattern
Not applicable — this sprint is pure unit-test scoped (no Playwright; contract verificationMethod is unit-test/build).

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/config/defaults.ts` | `EvaluatorSection` shape (schema.ts) | high | Adding non-optional `panel` to the schema forces every `evaluator: {...}` literal (8 of them, lines 62/87/124/136/148/161/189/230) to include `panel`, or `tsc` fails. Add the field where `tsc` reports errors. |
| `src/orchestrator/pipeline.ts` | `runEvaluatorAgent`, `EvaluatorSection` | medium | Consumes the EvaluationRunResult; shape is unchanged so should be safe — confirm via tsc. |
| `src/cli/commands/eval.ts`, `src/mcp/tools/eval.ts` | `runEvaluatorAgent`, config | medium | Build full configs; verify they still satisfy `BoberConfig` after the new required `panel` key. |
| `src/cli/commands/sprint.ts`, `src/mcp/tools/sprint.ts`, `src/index.ts` | `EvaluatorSectionSchema` / config | low | Type-only usage; confirm tsc. |
| `src/orchestrator/code-reviewer-agent.test.ts:76` | mocks `runEvaluatorAgent` | low | Mock returns a literal EvaluationRunResult — unchanged shape, no break. |

### Existing Tests That Must Still Pass
- `src/config/schema.test.ts` — tests `PipelineSectionSchema.engine`; unaffected by the evaluator change, must still pass after your additions.
- `src/orchestrator/code-reviewer-agent.test.ts` — mocks `runEvaluatorAgent` (line 76); verify it still compiles and passes (the real signature is unchanged).
- `src/orchestrator/workflow/conformance.test.ts` and `reconciler` tests — reconcile() is unmodified; confirm green.
- Any test that calls `createDefaultConfig` or builds a `BoberConfig` literal — once `panel` is required on output type, ensure they parse via the schema (which fills the default) rather than hand-building incomplete literals.

### Features That Could Be Affected
- **Single-judge evaluation (existing default behavior)** — shares `runAgentEvaluation`. C2 requires the off-path prompt be BYTE-IDENTICAL. Verify by ensuring the lens-less branch builds `userMessage` with no appended lens block.
- **Sprint 2 of this plan (lens catalog + telemetry)** — out of scope now; keep the lens injection a single inline string so sprint 2 can extend it.

### Recommended Regression Checks
1. `npx tsc --noEmit` (exit 0) — catches the defaults.ts literal-completeness issue first.
2. `npm run build` (exit 0).
3. `npx eslint src/` (exit 0) — verifies `consistent-type-imports` and unused-var rules.
4. `npx vitest run` — full suite green; tolerate only the documented flaky tool-count baseline (per C5).
5. Spot-check: `npx vitest run src/orchestrator/evaluator-agent.test.ts src/config/schema.test.ts`.

---

## 8. Implementation Sequence

1. **src/config/schema.ts** — add the `panel` field to `EvaluatorSectionSchema` (after line 108) and to the `createDefaultConfig` evaluator literal (line 377-381).
   - Verify: `npx vitest run src/config/schema.test.ts` after adding the schema panel test; `EvaluatorSectionSchema.parse({ strategies: [] }).panel` equals the default.
2. **src/config/defaults.ts** — run `npx tsc --noEmit`; add `panel: { enabled: false, lenses: [], maxConcurrent: 4 }` to each evaluator literal that errors.
   - Verify: `npx tsc --noEmit` exits 0.
3. **src/orchestrator/evaluator-agent.ts** — add `import { reconcile } from "./workflow/reconciler.js";`; extract current `runAgentEvaluation` body into `runSingleLensEval(..., lens?)` with the conditional lens block; rewrite `runAgentEvaluation` to dispatch off/on path; add `mapBounded`.
   - Verify: `npx tsc --noEmit` + `npx eslint src/orchestrator/evaluator-agent.ts` exit 0; lens-less prompt unchanged (no lens text when lens undefined).
4. **src/config/schema.test.ts** — add the `EvaluatorSectionSchema.panel` describe block (Section 6).
   - Verify: `npx vitest run src/config/schema.test.ts` green.
5. **src/orchestrator/evaluator-agent.test.ts** — create with the vi.mock harness + C2/C3/C4 tests (Section 6).
   - Verify: `npx vitest run src/orchestrator/evaluator-agent.test.ts` green; loopSpy call-counts and `peak` assertions hold.
6. **Run full verification** — `npx tsc --noEmit`, `npm run build`, `npx eslint src/`, `npx vitest run` (all exit 0 / green per C5).

---

## 9. Pitfalls & Warnings

- **`createClient` may return a stub when `BOBER_TEST_DETERMINISTIC=1` (factory.ts:182).** Don't rely on env stubbing — explicitly `vi.mock` both `factory.js` and `agentic-loop.js` so no real LLM/network call happens (contract nonGoal: "Do not invoke any real LLM in tests").
- **The judge verdict comes from `runAgenticLoop().finalText`, not from the client directly.** Mocking only `createClient` won't control pass/fail — you must mock `runAgenticLoop` to return JSON verdict text that `parseEvalResult` (evaluator-agent.ts:282) can parse.
- **`ContextHandoff` has NO `iteration`/`round` field** (verified schema.ts:41-53). Pass `1` to reconcile's `round` arg (assumption #2: reconcile ignores it for output).
- **`reconcile()` THROWS on empty `lensVerdicts`** (reconciler.ts:23). The `lenses.length < 2` guard prevents this — keep that guard before any reconcile call.
- **Byte-identical off path (C2):** do NOT reformat the existing `userMessage` template literal (lines 182-222). Only conditionally APPEND a lens block when `lens` is defined.
- **defaults.ts literals are the silent tsc trap.** `EvaluatorSection` is not partial-ized inside `Partial<BoberConfig>`, so each `evaluator: {...}` must be complete. Adding `panel` to the schema breaks all 8 literals until you add the field. Let `tsc` enumerate them — don't eyeball.
- **`strategies` has no schema default** (schema.ts:106). In schema tests you must pass `strategies: []` or `.parse()` throws before you can assert on `panel`.
- **`vi.mock` paths must match the source module's import specifier** (relative to evaluator-agent.ts's location in `src/orchestrator/`), not the test's intuition. e.g. `"../providers/factory.js"`, `"./agentic-loop.js"`, `"../evaluators/registry.js"`.
- **Do NOT modify** `src/orchestrator/workflow/reconciler.ts`, the combine at evaluator-agent.ts:112, the retry loop, the programmatic evaluators, or the `EvaluationRunResult` shape (contract nonGoals).
- **Conventional commit** required: `bober(sprint-1): add evaluator.panel config + lens-aware reconcile wiring`.
