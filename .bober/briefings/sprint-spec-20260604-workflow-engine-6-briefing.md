# Sprint Briefing: WorkflowEngine assembly, selector integration, and EngineConformanceHarness

**Contract:** sprint-spec-20260604-workflow-engine-6
**Generated:** 2026-06-04T00:30:00Z

---

## 0. The CI Trap — read this first

Two hard constraints govern every test you write:

1. **`runPipeline` / `runTsPipeline` must NEVER run end-to-end in tests.** They spawn real LLM agents (`runPlanner`/`runResearch`/`runGenerator`/`runEvaluatorAgent`). Any test that lets a *real* `TsPipelineEngine.run` execute will hang or hit the network. You MUST inject a fake/stub engine.
2. **The default env is ineligible.** `isWorkflowEligible` returns `false` unconditionally (`src/orchestrator/workflow/eligibility.ts:10-12`), and `resolveEngineName` downgrades `'workflow'→'ts'` (`selector.ts:24-33`). So `selectPipelineEngine(config)` with `engine='workflow'` returns a `TsPipelineEngine` in the default path and `WorkflowEngine` is **never constructed** there. C4 asserts exactly this downgrade — it does NOT run `WorkflowEngine`.

Consequence: `WorkflowEngine` itself is only reachable in tests that **force eligibility** and **inject a fake TS engine** for the re-dispatch path.

---

## 1. Target Files

### src/orchestrator/workflow/workflow-engine.ts (create)

**Directory pattern:** Files in `src/orchestrator/workflow/` are kebab-case `.ts` with a leading `// ── Section ──` unicode header, `import type` for type-only imports, ESM `.js` specifiers. See `ts-engine.ts:1-23`, `flusher.ts:1-21`.

**Most similar existing file:** `src/orchestrator/workflow/ts-engine.ts` (the only other `PipelineEngine` impl) — follow its class+`readonly name` shape.

**Structure template (based on ts-engine.ts + generatorNotes control flow):**
```ts
// ── WorkflowEngine ─────────────────────────────────────────────────

import type { BoberConfig } from "../../config/schema.js";
import type { PipelineResult } from "../pipeline.js";
import { logger } from "../../utils/logger.js";
import type { PipelineEngine, PipelineEngineName } from "./engine.js";
import { isWorkflowEligible } from "./eligibility.js";
import { ResumeCursorReconstructor } from "./resume-cursor.js";
import { ArgsPayloadBuilder } from "./args-builder.js";
import { RunResultFlusher } from "./flusher.js";
import { TsPipelineEngine } from "./ts-engine.js";
import { WorkflowUnavailableError } from "./errors.js";
import type { WorkflowArgs, WorkflowRunResult } from "./types.js";

export class WorkflowEngine implements PipelineEngine {
  readonly name: PipelineEngineName = "workflow";

  // Injection seam — see section 3. Defaults keep production wiring intact.
  constructor(
    private readonly tsEngineFactory: () => PipelineEngine = () => new TsPipelineEngine(),
  ) {}

  async run(userPrompt, projectRoot, config): Promise<PipelineResult> {
    // EARLY RE-DISPATCH (must happen BEFORE building args — see section 2)
    if (!isWorkflowEligible(config)) {
      logger.info("workflow runtime unavailable — re-dispatching TS engine");
      return this.tsEngineFactory().run(userPrompt, projectRoot, config);
    }
    // Eligible path: cursor (read-only) → args (pure) → invoke → flush
    const specId = ??? ;                       // see section 2 note on specId
    const cursor = await new ResumeCursorReconstructor().reconstruct(projectRoot, specId);
    const args = new ArgsPayloadBuilder().build(userPrompt, config, cursor, "");
    try {
      const result: WorkflowRunResult = await this.invoke(args);
      return await new RunResultFlusher().flush(projectRoot, config, result);
    } catch (e) {
      if (e instanceof WorkflowUnavailableError) {
        logger.info("workflow runtime unavailable — re-dispatching TS engine");
        return this.tsEngineFactory().run(userPrompt, projectRoot, config);
      }
      throw e;
    }
  }

  // Dormant this release (non-goal: no live transport). Always throws.
  private async invoke(_args: WorkflowArgs): Promise<WorkflowRunResult> {
    throw new WorkflowUnavailableError(
      "Programmatic workflow invoke is not implemented this release.",
    );
  }
}
```
NOTE on `specId`: `ResumeCursorReconstructor.reconstruct(projectRoot, specId)` needs a specId, but `run()`'s signature is `(userPrompt, projectRoot, config)` with no specId. Since `invoke` is dormant and always throws, the eligible branch is only ever exercised in tests that mock `reconstruct` (see section 3). Pass a derived/placeholder specId (e.g. `config.project?.specId ?? ""`-style or simply `""`); it is never persisted because flush is never reached on the dormant path. Do NOT add a specId param to `run` — the `PipelineEngine` interface signature is frozen (`engine.ts:10-17`).

### src/orchestrator/workflow/selector.ts (modify)

**Relevant section (lines 46-57) — the `selectPipelineEngine` switch:**
```ts
export function selectPipelineEngine(config: BoberConfig): PipelineEngine {
  const name = resolveEngineName(config);
  switch (name) {
    case "ts":
      return new TsPipelineEngine();
    case "skill":
    case "workflow":
      // Sprint 6: real engine implementations go here.
      // For now, fall back to TS engine (unreachable via default-ineligible probe).
      return new TsPipelineEngine();
  }
}
```
**Change:** Split the `case "workflow"` to `return new WorkflowEngine();` and add `import { WorkflowEngine } from "./workflow-engine.js";`. Keep `case "skill"` returning `TsPipelineEngine` (no skill engine this sprint — non-goal). Belt-and-suspenders per ADR-6: `resolveEngineName` (lines 21-36) STILL downgrades `workflow→ts` when ineligible/careful, so in the default env `name` is already `"ts"` and `WorkflowEngine` is never reached — but it is now reachable when eligible. **Do NOT touch `resolveEngineName` or `eligibility.ts`** (out of scope; selector.test.ts asserts current downgrade behaviour at lines 55-72).

**Imported by:** `src/orchestrator/pipeline.ts:852` (`import { selectPipelineEngine }`), used by `runPipeline` at `pipeline.ts:863`.
**Test file:** `src/orchestrator/workflow/selector.test.ts` exists (tests `resolveEngineName` branches only — you will ADD workflow-resolution cases here or in a new file per C2).

### src/orchestrator/workflow/workflow-engine.test.ts (create) — see sections 3, 6
### src/orchestrator/workflow/conformance.ts (create) — see section 1b below
### src/orchestrator/workflow/conformance.test.ts (create) — see section 4

### src/orchestrator/workflow/conformance.ts (create)

**Most similar existing file:** `src/orchestrator/workflow/reconciler.ts` (small pure class in same dir) for structure; `flusher.ts` for the `import { listContracts } from "../../state/sprint-state.js"` read-back pattern.

**Structure template:**
```ts
// ── EngineConformanceHarness ────────────────────────────────────────

import { listContracts } from "../../state/sprint-state.js";
import { loadHistory } from "../../state/history.js";
import { loadSpec } from "../../state/plan-state.js";       // or "../../state/index.js" re-export
import { logger } from "../../utils/logger.js";
import type { PipelineEngineName } from "./engine.js";
import type { ConformanceReport } from "./types.js";

/** Deterministic runner the TEST injects — NOT a real engine. */
export type EngineRunner = (projectRoot: string) => Promise<void>;

export class EngineConformanceHarness {
  async assertEquivalent(
    fixtureSpecId: string,
    engines: PipelineEngineName[],
    projectRootFactory: () => Promise<string>,
    runnerFor: (engine: PipelineEngineName) => EngineRunner,   // pluggable runner per engine
  ): Promise<ConformanceReport> { ... }
}
```
See section 4 for the full normalize+diff algorithm and the `ConformanceReport` shape.

---

## 2. WorkflowEngine.run ORDERING — avoid the sprint-4 MissingKnobError trap

`ArgsPayloadBuilder.build` THROWS `MissingKnobError` if required knobs (incl. `curator.enabled`, `codeReview.enabled`) are absent — `args-builder.ts:52-65`. If you build args on the ineligible default path, a config lacking those sections will throw the wrong error and the re-dispatch never happens.

**Mandatory control flow (eligibility FIRST, args ONLY when eligible):**
```
run():
  1. if (!isWorkflowEligible(config))  → log once + return tsEngine.run(...)   ← NO args built
  2. cursor = reconstruct(...)         ← read-only (listContracts + loadHistory)
  3. args   = build(...)               ← pure; may throw MissingKnobError (acceptable: we are eligible)
  4. try { result = invoke(args); return flush(result) }
     catch WorkflowUnavailableError → log once + return tsEngine.run(...)   ← NO partial flush
     catch other → rethrow
```

Why this guarantees **zero partial flush** (C1):
- `reconstruct` is read-only: `listContracts` (read) + `loadHistory` (read), `resume-cursor.ts:14-19`. Writes nothing.
- `build` is pure (no fs): documented `args-builder.ts:7-11`.
- `flush` (the ONLY writer — `updateContract`/`appendHistory`/`saveSpec`, `flusher.ts:60,84,92`) is reached **only after `invoke` succeeds**. Since `invoke` is dormant and throws, flush never runs on the dormant path, so the temp `.bober/` contains only what the re-dispatched `TsPipelineEngine` wrote (in tests, what the FAKE wrote — nothing).

**Log line discipline (C1/C2):** emit exactly ONE `logger.info` on the re-dispatch (`generatorNotes` text: `'workflow runtime unavailable — re-dispatching TS engine'`). The selector's downgrade log (`selector.ts:28`) is a SEPARATE path — in the default env only the selector logs once; `WorkflowEngine` is not even constructed.

---

## 3. Injection seam + vi.mock pattern (for workflow-engine.test.ts)

**Recommendation: constructor injection of the TS engine factory + `vi.mock` for the logger.** Constructor injection is the cleanest seam because it avoids module-graph mocking of `TsPipelineEngine` (whose `run` would otherwise call the real `runTsPipeline` and spawn agents). The eligible/invoke-failure branch additionally needs `isWorkflowEligible` forced true and `reconstruct` stubbed.

**vi.mock pattern (quote — from `selector.test.ts:1-9`):**
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../utils/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));

import { logger } from "../../utils/logger.js";
```
`vi.mock` is HOISTED — declare it at top, BEFORE importing the unit under test. Assert the single log line with `expect(vi.mocked(logger.info)).toHaveBeenCalledTimes(1)` and `beforeEach(() => vi.clearAllMocks())` (`selector.test.ts:39-41`).

**To force eligibility true** (so the eligible branch + `invoke→WorkflowUnavailableError` runs), mock the eligibility module:
```ts
vi.mock("./eligibility.js", () => ({ isWorkflowEligible: vi.fn(() => true) }));
```
**To keep `reconstruct` from touching fs** in the eligible test, either mock `./resume-cursor.js` similarly OR just point the test at a temp `projectRoot` (reconstruct returns an empty cursor when no contracts exist — `resume-cursor.ts:21-31`, `listContracts` returns `[]` on missing dir, `sprint-state.ts:121-123`). The temp-dir route is simpler and matches house style.

**Inject a FAKE TsPipelineEngine** returning a sentinel `PipelineResult` so no real agents run:
```ts
const sentinel: PipelineResult = {
  success: true, spec: makeSpec(), completedSprints: [], failedSprints: [], duration: 0,
};
const fakeTs: PipelineEngine = { name: "ts", run: vi.fn(async () => sentinel) };
const engine = new WorkflowEngine(() => fakeTs);
const out = await engine.run("prompt", tmpDir, eligibleConfig);
expect(out).toBe(sentinel);
expect(fakeTs.run).toHaveBeenCalledTimes(1);
// zero partial flush: temp .bober has no workflow-written contracts
expect(await listContracts(tmpDir)).toEqual([]);
```
This covers C1's two halves: (a) forced-eligible + `invoke` throws `WorkflowUnavailableError` → TS re-dispatch + zero flush; (b) fake TS engine returns sentinel → no real agents.

Do NOT use `vi.mock("./ts-engine.js", ...)` unless you also need the *default-construction* path; constructor injection is preferred and keeps the test hermetic.

---

## 4. EngineConformanceHarness.assertEquivalent — design

### Algorithm
```
assertEquivalent(fixtureSpecId, engines, projectRootFactory, runnerFor):
  perEngine = {}
  for engine of engines:
    root = await projectRootFactory()           // FRESH temp dir per engine
    await runnerFor(engine)(root)               // INJECTED deterministic runner writes .bober/ artifacts
    perEngine[engine] = await readArtifacts(root) // spec, contracts, history (eval-results live inside)
  // deep-compare normalized artifacts across the engine pair; populate diffs[]
  diffs = compareNormalized(perEngine, engines)
  return { equivalent: diffs.length === 0, diffs }
```

### Artifact readers to REUSE (do NOT recreate)
- `listContracts(projectRoot): Promise<SprintContract[]>` — `src/state/sprint-state.ts:113`
- `loadHistory(projectRoot): Promise<HistoryEntry[]>` — `src/state/history.ts:74`
- `loadSpec(projectRoot, specId): Promise<PlanSpec>` — `src/state/plan-state.ts:44` (re-exported from `state/index.ts:13`)
- There is **no** dedicated eval-result state reader — eval verdicts are not flushed as standalone files by the flusher; treat the `ConformanceReport.diffs[].artifact === "eval-result"` slot as reserved (populate only if the injected runner writes eval artifacts). Confirmed: no `loadEval*`/`saveEval*` in `src/state/`.

### Normalization — strip these VOLATILE fields before deep-compare
Read from the schemas:
- **SprintContract** (`src/contracts/sprint-contract.ts:129-132`): strip `createdAt`, `updatedAt`, `startedAt`, `completedAt`.
- **PlanSpec** (`src/contracts/spec.ts:166-168`): strip `createdAt`, `updatedAt`, `completedAt`.
- **HistoryEntry** (`src/state/history.ts:37-43`): strip `timestamp`; also strip any `details.duration` / `details.runId` if present (`details` is `z.record(string, unknown)`).
- **EvalResult** (`src/contracts/eval-result.ts:67`): strip `timestamp`.
- **PipelineResult** (`src/orchestrator/pipeline.ts:62-76`): strip `duration` (and `totalCost`) if you compare results directly.

Recommended normalizer: a recursive deep-clone that deletes the keyset `{createdAt, updatedAt, startedAt, completedAt, timestamp, duration, runId, totalCost}` at every object depth, then `expect(a).toEqual(b)` (deep). This mirrors the sentinel-timestamp approach already used in `reconcile-conformance.test.ts:8` (`const TS = "..."` fixed timestamp) — but for the harness, strip rather than fix, since the harness reads real flushed artifacts.

### ConformanceReport shape (already defined — `types.ts:58-65`)
```ts
type ConformanceReport = {
  equivalent: boolean;
  diffs: Array<{ artifact: "spec"|"contract"|"eval-result"|"history"; path: string; engines: PipelineEngineName[] }>;
};
```

### conformance.test.ts — inject DETERMINISTIC stub runners (NOT real engines)
```ts
// runnerFor returns a closure that writes a FIXED artifact set to the given root.
const fixedRunner = (root: string): EngineRunner => async (r) => {
  await ensureBoberDir(r);
  await updateContract(r, makeSyntheticContract({ status: "passed" }));
  await saveSpec(r, makeSpec());
};
// equal case → equivalent:true
const eq = await harness.assertEquivalent("spec-x", ["ts","skill"], mkTmp, () => fixedRunner);
expect(eq.equivalent).toBe(true);
// injected divergence → equivalent:false with diffs
const skewed = (engine) => engine === "skill"
  ? writesDifferentContractTitle : fixedRunner;
const ne = await harness.assertEquivalent("spec-x", ["ts","skill"], mkTmp, skewed);
expect(ne.equivalent).toBe(false);
expect(ne.diffs.length).toBeGreaterThan(0);
```
Use `makeSyntheticContract` as a template — it is the precision-clean contract factory at `flusher.test.ts:41-71` that passes `saveContract`'s quality gate (avoids banned vague phrases / min lengths). For C3 "injected divergence", change a NON-volatile field (e.g. contract `title` or a successCriterion description) so normalization does NOT erase the difference.

---

## 5. C4 integration assertion (selector returns TS in default env)

C4 does NOT run `runPipeline` live. Assert the **resolution**, not execution:
```ts
const config = makeConfig({ engine: "workflow", mode: "autopilot" });  // selector.test.ts:13-34 helper
const engine = selectPipelineEngine(config);
expect(engine.name).toBe("ts");                  // introspect via readonly `name`
expect(engine).toBeInstanceOf(TsPipelineEngine);
```
Introspection: every engine exposes `readonly name: PipelineEngineName` (`engine.ts:11`, `ts-engine.ts:14`). In the default ineligible env, `resolveEngineName` returns `"ts"` (`selector.ts:27-32`) so `selectPipelineEngine` constructs `TsPipelineEngine`, never `WorkflowEngine` — hence no orphaned `.bober/` writes. If C4 must exercise `runPipeline` itself, you MUST `vi.mock("./workflow/selector.js", ...)` or mock `runTsPipeline` to a sentinel — but the cleaner, contract-aligned assertion is the `selectPipelineEngine(...).name === "ts"` check above (no agents). Reuse the `makeConfig` helper from `selector.test.ts:13-34`.

---

## 6. Testing Patterns

### Unit test (temp-dir, real fs — house style)
**Source:** `src/orchestrator/workflow/flusher.test.ts:6-33`
```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-wf-engine-test-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });
```
**Runner:** vitest (`package.json:16` `"test": "vitest"`). **Assertion style:** `expect(...).toBe/.toEqual/.toBeInstanceOf`. **Mock approach:** `vi.mock` (hoisted, factory) for modules; constructor injection for engines. **File naming:** co-located `*.test.ts` in the same dir. **No mock-fs** — real `mkdtemp` temp dirs (`flusher.test.ts:4` "no mock fs — house style").

### Conformance/twin test pattern
**Source:** `src/orchestrator/workflow/reconcile-conformance.test.ts:8-22` — fixed sentinel timestamp + `expect(jsOut).toEqual(tsOut)` deep equality across two producers. Mirror this for ts-vs-skill artifact equivalence.

### Config helper to reuse
- `createDefaultConfig("test-project", "brownfield")` — `src/config/schema.ts:350` (used in `args-builder.test.ts:28`). Gives a fully-defaulted `BoberConfig` with `curator`/`codeReview` populated so `ArgsPayloadBuilder.build` does NOT throw `MissingKnobError`.
- For selector tests: the inline `makeConfig(pipeline)` factory at `selector.test.ts:13-34`.

The conformance gate runs as part of `npm run test` because vitest discovers all `*.test.ts` — `conformance.test.ts` is auto-included (C5). No separate CI wiring needed beyond placing it in the dir.

---

## 3b. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---|---|---|---|
| `selectPipelineEngine` | `selector.ts:46` | `(config) => PipelineEngine` | Resolve config → engine instance; you ADD workflow case |
| `resolveEngineName` | `selector.ts:21` | `(config) => PipelineEngineName` | Pure resolver; downgrades workflow→ts (DO NOT modify) |
| `isWorkflowEligible` | `eligibility.ts:10` | `(config) => boolean` | Default-ineligible probe (DO NOT modify; mock in tests) |
| `ResumeCursorReconstructor.reconstruct` | `resume-cursor.ts:13` | `(projectRoot, specId) => Promise<ResumeCursor>` | Read-only cursor from contracts+history |
| `ArgsPayloadBuilder.build` | `args-builder.ts:24` | `(userPrompt, config, cursor, principles?) => WorkflowArgs` | Pure; throws MissingKnob/AgentCap/NonSerializable |
| `RunResultFlusher.flush` | `flusher.ts:34` | `(projectRoot, config, result) => Promise<PipelineResult>` | ONLY writer; reached only post-invoke |
| `TsPipelineEngine` | `ts-engine.ts:13` | `class { name="ts"; run(...) }` | Wraps runTsPipeline (real agents — inject a fake in tests) |
| `WorkflowUnavailableError` | `errors.ts:24` | `new (message)` | Thrown by dormant invoke; caught for re-dispatch |
| `listContracts` | `sprint-state.ts:113` | `(projectRoot) => Promise<SprintContract[]>` | Read back contracts (harness + flush assertions) |
| `loadHistory` | `history.ts:74` | `(projectRoot) => Promise<HistoryEntry[]>` | Read back history (harness) |
| `loadSpec` | `plan-state.ts:44` | `(projectRoot, id) => Promise<PlanSpec>` | Read back spec (harness) |
| `saveSpec` | `plan-state.ts:22` | `(projectRoot, spec) => Promise<void>` | Stub runner writes spec |
| `updateContract` | `sprint-state.ts:152` | `(projectRoot, contract) => Promise<void>` | Stub runner writes contract |
| `ensureBoberDir` | `state/index.ts:96` | `(projectRoot) => Promise<void>` | Stub runner sets up .bober/ |
| `createDefaultConfig` | `config/schema.ts:350` | `(name, mode) => BoberConfig` | Fully-defaulted config for tests |
| `makeSyntheticContract` | `flusher.test.ts:41` | `(overrides?) => SprintContract` | Quality-gate-passing contract factory (copy into tests) |

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|---|---|---|---|
| `src/orchestrator/pipeline.ts:852,863` | `selectPipelineEngine` | low | Adding workflow case is additive; `runPipeline` signature frozen — do NOT change it |
| `src/orchestrator/workflow/selector.test.ts` | `resolveEngineName`, `selector.ts` | medium | Existing downgrade tests (lines 55-72) MUST still pass — do NOT alter `resolveEngineName` |

`selectPipelineEngine` is imported only by `pipeline.ts` (grep `from.*selector` in src). `WorkflowEngine` and `conformance.ts` are new — no inbound dependents.

### Existing Tests That Must Still Pass
- `selector.test.ts` — covers `resolveEngineName` branches incl. workflow→ts downgrade + single log line; unaffected if you only touch the `switch` in `selectPipelineEngine`.
- `args-builder.test.ts`, `flusher.test.ts`, `resume-cursor.test.ts`, `reconciler.test.ts`, `reconcile-conformance.test.ts`, `script-helpers.test.ts` — sprint 1/4/5 suites; verify untouched.
- Full `npm run test` (C5) — tolerate ONLY the documented flaky tool-count baseline.

### Features That Could Be Affected
- **TS pipeline (engine='ts')** — shares `selectPipelineEngine`; verify default path still returns `TsPipelineEngine` and `runPipeline` shape is unchanged.

### Recommended Regression Checks
1. `npm run typecheck` exits 0.
2. `npm run build` exits 0.
3. `npm run lint` exits 0 (`eslint src/`).
4. `npm run test` green (only flaky tool-count baseline tolerated); confirm `conformance.test.ts` ran.
5. `git diff --name-only` confined to: `workflow-engine.ts`, `workflow-engine.test.ts`, `conformance.ts`, `conformance.test.ts`, `selector.ts`. No `agents/*.md`, `contracts/`, `providers/types.ts` changes.

---

## 8. Implementation Sequence

1. **selector.ts** — add `import { WorkflowEngine }` + change `case "workflow": return new WorkflowEngine();` (keep `case "skill"` → TS). Verify: `npm run typecheck` (WorkflowEngine must exist first — create the file in step 2 before typecheck, or stub it).
2. **workflow-engine.ts** — implement `WorkflowEngine` with eligibility-first ordering (section 2) + constructor injection seam (section 3) + dormant `invoke`. Verify: typecheck passes; class `implements PipelineEngine`.
3. **conformance.ts** — `EngineConformanceHarness.assertEquivalent` + `EngineRunner` type + normalizer (section 4). Verify: typecheck; reuses `listContracts`/`loadHistory`/`loadSpec`.
4. **workflow-engine.test.ts** — C1 (forced-eligible invoke→WorkflowUnavailableError → TS re-dispatch via injected fake + zero flush via `listContracts(tmpDir) === []`), single log line; C2/C4 selector resolution (`selectPipelineEngine(...).name === "ts"`). Verify: `npx vitest run src/orchestrator/workflow/workflow-engine.test.ts`.
5. **conformance.test.ts** — C3 equal→equivalent:true, injected-divergence→equivalent:false + diffs, using deterministic stub runners. Verify: `npx vitest run src/orchestrator/workflow/conformance.test.ts`.
6. **Full verification** — `npm run typecheck && npm run build && npm run lint && npm run test`.

---

## 9. Pitfalls & Warnings

- **NEVER let real `TsPipelineEngine.run` execute in a test** — it calls `runTsPipeline` (`ts-engine.ts:21`) which spawns LLM agents. Always inject a fake engine (constructor seam) or assert resolution only.
- **Build args ONLY when eligible.** Building on the ineligible path risks `MissingKnobError` (`args-builder.ts:52-65`) instead of clean re-dispatch. Eligibility check MUST be the first statement in `run`.
- **Flush is the only writer.** Keep it strictly after a successful `invoke`. Reconstruct (read) + build (pure) write nothing — this is what makes "zero partial flush" true.
- **Do NOT modify `resolveEngineName` or `eligibility.ts`** — `selector.test.ts:55-72` asserts current downgrade + single-log behaviour, and they are out of scope.
- **`run` signature is frozen** (`engine.ts:10-17`) — no `specId` param. Pass a placeholder specId to `reconstruct`; it is irrelevant because the dormant path never flushes.
- **Exactly one log line** per re-dispatch (`logger.info`). The selector's downgrade log is a separate path; in the default env only the selector logs and `WorkflowEngine` is never constructed.
- **`vi.mock` is hoisted** — place mocks above imports (`selector.test.ts:3`). Top-level vars are NOT accessible inside the factory (inline literals only — see `agent-loader.test.ts:21`).
- **Conformance divergence must touch a NON-volatile field** — if you diverge only a timestamp/duration, normalization erases it and `equivalent` stays true, failing C3's false-case.
- **Use `makeSyntheticContract`-style precision-clean contracts** (`flusher.test.ts:41`) — `saveContract` has a quality gate that rejects vague/short text; lazy fixtures will throw on write.
- **No skill engine this sprint** — `case "skill"` stays `TsPipelineEngine`; the harness's skill lane uses a deterministic stub runner / recorded fixture, NOT a live skill engine (assumptions, contract:61). Do not silently pass if absent — log a note.
