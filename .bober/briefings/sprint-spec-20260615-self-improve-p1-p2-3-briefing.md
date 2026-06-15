# Sprint Briefing: Evaluator anti-degeneration guards (deterministic-first, rubric isolation, cite-artifact) — off-by-default

**Contract:** sprint-spec-20260615-self-improve-p1-p2-3
**Generated:** 2026-06-15T00:00:00Z

> **THIS IS THE RISKIEST SPRINT IN THE PLAN.** It edits two LIVE pipeline files (`evaluator-agent.ts`, `pipeline.ts`). The load-bearing requirement (sc-3-7) is that with all `selfImprove` flags OFF or absent, behavior is **byte-identical** to today. Every new branch MUST be `config.selfImprove?.<flag>` (optional chaining → absent section is falsy). When the flag is falsy the EXISTING code path runs **unchanged** — no re-ordering, no new objects in the off path, no early returns.

---

## 0. The Gating Discipline (read this first)

Three guards, all default OFF (Sprint 1 schema, `src/config/schema.ts:122-128`):

```ts
export const SelfImproveSectionSchema = z.object({
  deterministicGate: z.boolean().default(false),
  rubricIsolation: z.boolean().default(false),
  requireCitedArtifact: z.boolean().default(false),
  replayDir: z.string().default(".bober/replay"),
});
```

And the section itself is OPTIONAL on the root config (`src/config/schema.ts:414`):

```ts
selfImprove: SelfImproveSectionSchema.optional(),
```

**Therefore the off-path check is ALWAYS** `config.selfImprove?.<flag>`:
- If `selfImprove` is absent → `config.selfImprove?.deterministicGate` is `undefined` → falsy → existing path.
- If present but flag false → falsy → existing path.
- ONLY when present AND `=== true` does the new branch run.

`createDefaultConfig("test-project", "brownfield")` (`src/config/schema.ts:439`) produces a config with NO `selfImprove` section — this IS the off-path fixture for the sc-3-7 invariant test.

---

## 1. Target Files

### src/orchestrator/selfimprove/eval-guards.ts (create)

**Directory:** `src/orchestrator/selfimprove/` ALREADY EXISTS — it holds Sprint 1-2's `replay-store.ts`, `replay-harness.ts`, `replay-types.ts` (and their `.test.ts` co-located). DO NOT touch those. Your new files sit beside them.
**Naming:** kebab-case `.ts`, co-located `.test.ts` (verified: `replay-store.ts` + `replay-store.test.ts`).
**Purity template:** model on `src/orchestrator/memory/distill.ts` — file header literally states "PURE — must not import from ../providers; no network, no Date.now(), no side effects, no filesystem access." (`distill.ts:1-7`). Your three exports must be the same: no clock, no fs, no mutation, return NEW objects.

**Three pure exports:**

1. `shouldShortCircuitJudge(programmaticResults: EvalResult[], requiredEvaluators: Set<string>): boolean`
   - Return `true` iff some result has `passed === false` AND `requiredEvaluators.has(result.evaluator)`.
   - **CRITICAL:** `EvalResult` carries `evaluator` (the strategy type name), NOT `required`. See `src/contracts/eval-result.ts:60-79`. The caller builds the `Set<string>` from `config.evaluator.strategies` (each has `.type` and `.required`, `src/config/schema.ts:56-69`).

2. `redactRubric(handoff: ContextHandoff): ContextHandoff`
   - Return a NEW handoff (structuredClone or spread) whose `currentContract` OMITS `successCriteria` + `evaluatorNotes` (and thereby each `successCriteria[].verificationMethod`), while KEEPING `title`, `description`, `definitionOfDone`, `generatorNotes`, `nonGoals`.
   - **CAVEAT — schema vs serialization:** `SprintContractSchema.successCriteria` is `.min(1)` (`src/contracts/sprint-contract.ts:96`), so a fully omitted `successCriteria` would FAIL re-validation. But `redactRubric` returns a plain `ContextHandoff` object that is only `JSON.stringify`'d by `serializeHandoff` (`context-handoff.ts:115-117`) before reaching the generator — it is NOT re-parsed through the schema on the generator path. Simplest safe approach: build a new `currentContract` via spread and delete/omit the rubric fields. If you prefer schema-safety, replace `successCriteria` with a single neutral placeholder criterion (mirror `summarizeOlderSprints`' summary criterion at `context-handoff.ts:182-190`). Either is acceptable; the test (sc-3-4) only asserts `successCriteria`/`evaluatorNotes` are gone and `definitionOfDone` survives.

3. `enforceCitedArtifacts(result: EvalResult): EvalResult`
   - Return a NEW `EvalResult`. For each detail with `passed === false`: treat as CITED iff `detail.file` is a non-empty string OR `detail.message` matches a failing-test/command signal (e.g. contains `.test.`, `FAIL `, `npm run`, `tsc`, `exit code`, or a path-like `:` token). Uncited FAIL → rewrite to `passed:true`, `severity:'info'`, `message + ' [downgraded: no cited artifact]'`. Cited FAIL unchanged.
   - Recompute `passed = details.every(d => d.passed)` on the returned object.

---

### src/orchestrator/selfimprove/eval-guards.test.ts (create)

**Template:** unit-test style from `src/orchestrator/memory/distill.test.ts` (`import { describe, it, expect, vi } from "vitest"`, fixtures = REAL shapes, `expect(...).toEqual([...])` for deep equality at `distill.test.ts:127,262,294`).
- sc-3-6 assertions: `shouldShortCircuitJudge` true on failed required, false on failed optional-only; `redactRubric` drops rubric + keeps `definitionOfDone` + **input unchanged** (assert `original.currentContract.successCriteria` still present after the call); `enforceCitedArtifacts` downgrades uncited FAIL but leaves a `file`-cited FAIL intact.
- sc-3-7 invariant (CRITICAL) — see section 6.

---

### src/orchestrator/evaluator-agent.ts (modify)

**Insertion point: AFTER `runEvaluation` (line 75-81), BEFORE `runAgentEvaluation` (line 90).** `config` is already in scope (param at `:48`). The existing flow:

```ts
// lines 75-95 (current)
  const programmaticEval = await runEvaluation(
    registry, projectRoot, config, contract, changedFiles,
  );

  for (const result of programmaticEval.results) {
    const icon = result.passed ? "PASS" : "FAIL";
    logger.debug(`  [${icon}] ${result.evaluator}: ${result.summary}`);
  }

  // 2. Agent evaluation — qualitative assessment via agentic loop with tools
  logger.info("Running agent evaluation...");
  const agentResult = await runAgentEvaluation(
    handoff, programmaticEval.results, projectRoot, config,
  );
```

The combine logic to PRESERVE (line 115-121):

```ts
  const evaluation: EvaluationRunResult = {
    passed: programmaticEval.passed && agentResult.passed,
    score: avgScore,
    results: allResults,
    summary: summaryParts.join(". "),
    timestamp: new Date().toISOString(),
  };
```

`EvaluationRunResult` shape (`src/evaluators/registry.ts:20-31`): `{ passed: boolean; score: number; results: EvalResult[]; summary: string; timestamp: string }`. Your short-circuit FAIL result MUST mirror this exactly.

**Wiring (deterministic gate) — insert between the for-loop (ends :86) and `runAgentEvaluation` (:90):**

```ts
  // ── Deterministic-first gate (off by default) ──────────────────────
  if (config.selfImprove?.deterministicGate) {
    const requiredSet = new Set(
      config.evaluator.strategies.filter((s) => s.required).map((s) => s.type),
    );
    if (shouldShortCircuitJudge(programmaticEval.results, requiredSet)) {
      const evaluation: EvaluationRunResult = {
        passed: false,
        score: programmaticEval.score,
        results: programmaticEval.results,
        summary: "deterministic gate: required check failed — LLM judge skipped",
        timestamp: new Date().toISOString(),
      };
      logger.sprint(sprintId, "Evaluation FAILED");
      return evaluation;
    }
  }
  // (existing) Agent evaluation runs unchanged when the flag is off or no required failure.
```

**Wiring (cite-artifact) — apply ONLY when `config.selfImprove?.requireCitedArtifact`, to the `agentResult` before the combine.** `agentResult` is the `EvalResult` returned by `runAgentEvaluation` (`:90`). Wrap it:

```ts
  let agentResult = await runAgentEvaluation(handoff, programmaticEval.results, projectRoot, config);
  if (config.selfImprove?.requireCitedArtifact) {
    agentResult = enforceCitedArtifacts(agentResult);
  }
```

(Note: `agentResult` is currently `const` at `:90` — change to `let`, or assign into a new local. Do NOT change anything else on the off path.)

**Imports to add at top of file:** `import { shouldShortCircuitJudge, enforceCitedArtifacts } from "./selfimprove/eval-guards.js";` (note `.js` extension — ESM/NodeNext; all imports in this file use `.js`, e.g. `evaluator-agent.ts:1-23`).

**Imported by (impact):** `src/index.ts:86`, `src/mcp/tools/eval.ts:14,153`, `src/mcp/tools/sprint.ts:19,250`, `src/cli/commands/eval.ts:6,142`, `src/cli/commands/sprint.ts:12,256`, and `src/orchestrator/pipeline.ts:36,415`. All call `runEvaluatorAgent(handoff, projectRoot, config)` — signature is UNCHANGED, so none break.

**Test file:** `src/orchestrator/evaluator-agent.test.ts` EXISTS (panel tests). MUST still pass — it calls `runEvaluatorAgent` with configs from `createDefaultConfig` (no `selfImprove`), so your guards stay off and `loopSpy` call counts are unaffected.

---

### src/orchestrator/pipeline.ts (modify)

**Insertion point: the generator-bound handoff.** The handoff flows: `createHandoff` (`:276`) → `summarizeOlderSprints` → `compactedHandoff` (`:289`) → optional `injectGuidanceIntoHandoff` → `injectedHandoff` (`:295-299`) → `runGenerator(injectedHandoff, ...)` (`:327-331`). `config` is in scope (param of `runSprintCycle`, `:163`).

```ts
// lines 289-299 (current)
    const compactedHandoff = summarizeOlderSprints(completedSummaryHandoff, 3);

    let injectedHandoff = compactedHandoff;
    if (pipelineRunId) {
      const guidance = await drainGuidance(projectRoot, pipelineRunId);
      injectedHandoff = injectGuidanceIntoHandoff(compactedHandoff, guidance);
    }
    // ... then: runGenerator(injectedHandoff, ...)  (:327)
```

**Wiring (rubric isolation) — wrap the generator-bound handoff under the flag, AFTER guidance injection, BEFORE `runGenerator`:**

```ts
    if (config.selfImprove?.rubricIsolation) {
      injectedHandoff = redactRubric(injectedHandoff);
    }
```

**DO NOT redact `evalHandoff`** (`:408-413`) — that one goes to the EVALUATOR (`runEvaluatorAgent`, `:415`) and MUST keep the rubric so the evaluator can verify success criteria. Only the GENERATOR-bound handoff (`injectedHandoff`) is redacted.

**Precedent to mirror:** `injectGuidanceIntoHandoff` (`pipeline.ts:142-154`) is the EXACT pattern — a pure function that returns `{ ...handoff, ... }` and short-circuits to the original when there's nothing to do (`if (guidanceTexts.length === 0) return handoff;`). The Phase-2 sc-4-7 invariant ("byte-for-byte unchanged" — comment at `:294`) is the direct ancestor of your sc-3-7.

**Import to add:** `import { redactRubric } from "./selfimprove/eval-guards.js";`

**Imported by (impact):** `src/index.ts:96`, `src/mcp/run-manager.ts:14`, `src/cli/commands/run.ts:7` import `runPipeline`. The internal `runSprintCycle` signature is unchanged → no breakage.

---

## 2. Patterns to Follow

### Pure additive handoff transform (the gold-standard precedent)
**Source:** `src/orchestrator/pipeline.ts`, lines 142-154
```ts
export function injectGuidanceIntoHandoff(
  handoff: ContextHandoff,
  guidanceTexts: string[],
): ContextHandoff {
  if (guidanceTexts.length === 0) return handoff;
  return {
    ...handoff,
    issues: [...handoff.issues, ...guidanceTexts.map((g) => `Human guidance: ${g}`)],
  };
}
```
**Rule:** Return a NEW object via spread; never mutate the input; have an off-path that returns the original untouched.

### Purity contract (no clock, no fs, no mutation)
**Source:** `src/orchestrator/memory/distill.ts`, lines 1-7 (header) and the body (builds new arrays, never mutates inputs).
**Rule:** `eval-guards.ts` exports must read no clock and mutate no input — exactly like `distill`.

### Non-mutating clone of nested contract (for redactRubric)
**Source:** `src/orchestrator/context-handoff.ts`, lines 205-208 (`summarizeOlderSprints` returns `{ ...handoff, sprintHistory: [...] }`)
```ts
  return {
    ...handoff,
    sprintHistory: [...summarized, ...recentSprints],
  };
```
**Rule:** Spread the handoff, then replace only `currentContract` with a redacted clone. Use `structuredClone(handoff)` if you prefer a deep copy, then delete the rubric fields on the clone's `currentContract`.

### EvalDetail "cited" signal source
**Source:** `src/orchestrator/evaluator-agent.ts`, lines 241-249 (how the pipeline already formats a cited detail)
```ts
        for (const detail of r.details) {
          if (!detail.passed) {
            const loc = detail.file
              ? ` at ${detail.file}${detail.line !== undefined ? `:${detail.line}` : ""}`
              : "";
```
**Rule:** `detail.file` (a non-empty string) is the primary citation signal; absence of `file` AND no command/test substring in `message` ⇒ uncited.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `serializeHandoff` | `src/orchestrator/context-handoff.ts:115` | `(handoff: ContextHandoff): string` | JSON-stringifies the handoff for the agent prompt; this is what carries `redactRubric`'s output to the generator. |
| `summarizeOlderSprints` | `src/orchestrator/context-handoff.ts:153` | `(handoff, keepRecent): ContextHandoff` | Pure non-mutating handoff transform — clone-via-spread precedent. |
| `injectGuidanceIntoHandoff` | `src/orchestrator/pipeline.ts:142` | `(handoff, guidanceTexts[]): ContextHandoff` | The direct precedent for a gated additive handoff wrapper (sc-4-7). |
| `runEvaluation` | `src/evaluators/registry.ts:171` | `(registry, root, config, contract, changedFiles): Promise<EvaluationRunResult>` | Produces `programmaticEval` with `.results` (EvalResult[]) + `.passed` + `.score`. Insert the gate AFTER this. |
| `EvaluationRunResult` (type) | `src/evaluators/registry.ts:20` | `{ passed; score; results; summary; timestamp }` | The shape your short-circuit FAIL result must mirror exactly. |
| `EvalResult` / `EvalDetail` (types) | `src/contracts/eval-result.ts:60 / :10` | EvalResult has `evaluator`, `passed`, `details[]`; EvalDetail has `passed`, `message`, optional `file`/`line`, `severity` | Input shapes for all three guards. `file`/`line` already OPTIONAL (`:14-15`). |
| `aggregateResults` | `src/contracts/eval-result.ts:97` | `(sprintId, round, results): SprintEvaluation` | Existing aggregation — do NOT reuse for the gate; build the `EvaluationRunResult` inline as shown. |
| `createDefaultConfig` | `src/config/schema.ts:439` | `(name, mode): BoberConfig` | Test fixture builder; produces config WITHOUT `selfImprove` (the off-path fixture). |

Directories reviewed: `src/orchestrator/selfimprove/` (replay only — no guard utils yet), `src/orchestrator/memory/` (distill purity model), `src/utils/` (git, logger — not relevant to pure guards), `src/contracts/` (types). No existing `shouldShortCircuitJudge`/`redactRubric`/`enforceCitedArtifacts` — confirmed absent, safe to create.

---

## 4. Prior Sprint Output

### Sprint 1 (ffd6e8a): selfImprove config
**Created/modified:** `src/config/schema.ts` — `SelfImproveSectionSchema` (`:122-128`, all flags `.default(false)`), wired as optional root field `selfImprove` (`:414`).
**Connection:** Every guard reads `config.selfImprove?.<flag>`. The `.optional()` + `?.` chaining is what makes the absent-section off-path work for sc-3-7.

### Sprint 2 (5b804d1): replay-harness + `bober replay run`
**Created:** `src/orchestrator/selfimprove/replay-harness.ts`, `replay-store.ts`, `replay-types.ts`.
**Connection:** NONE for Sprint 3 — the contract's non-goals explicitly forbid touching the replay modules. You only share the `selfimprove/` directory and the co-located `.test.ts` naming convention.

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` consulted for guard logic; the governing discipline is encoded in the contract (`generatorNotes`, `nonGoals`) and in `distill.ts`'s purity header (`:1-24`).

### Architecture Decisions
The `injectGuidanceIntoHandoff` / sc-4-7 "byte-for-byte unchanged" pattern (`pipeline.ts:291-299`) is the established additive-feature ADR-in-practice for this codebase: a gated transform with a no-op off path proven by a deep-equality invariant test. sc-3-7 is the same shape.

### Other Docs
ESM/NodeNext: ALL relative imports use the `.js` extension (e.g. `evaluator-agent.ts:1-23`, `pipeline.ts`). Your new imports MUST too (`./selfimprove/eval-guards.js`).

---

## 6. Testing Patterns

### Unit Test Pattern (for the three pure fns — sc-3-6)
**Source:** `src/orchestrator/memory/distill.test.ts:24-40, 127`
```ts
import { describe, it, expect, vi } from "vitest";
import { distill, type DistillableEval } from "./distill.js";
// ... build REAL-shape fixtures ...
expect(categories(lessons)).toEqual([ /* expected */ ]);  // deep equality
```
**Runner:** vitest. **Assertion:** `expect().toEqual()` for deep equality, `expect().toBe()` for primitives. **Mock:** none needed for pure fns. **File naming:** `eval-guards.test.ts`, co-located. **No-mutation assert:** after calling `redactRubric(original)`, assert `original.currentContract?.successCriteria` is STILL defined (`expect(original.currentContract?.successCriteria).toBeDefined()`).

### Invariant Test Pattern (sc-3-7 — CRITICAL) — proving the judge still runs
**Source:** `src/orchestrator/evaluator-agent.test.ts:31-97` (the mock harness) and `:191-212` (the "exactly one judge call" assertions).

The KEY mechanic: `runAgenticLoop` is mocked as `loopSpy`; counting `loopSpy` calls proves whether `runAgentEvaluation` (→ the LLM judge) was REACHED. Use the EXACT mock block:

```ts
const loopSpy = vi.fn(async () => ({ finalText: JSON.stringify({ /* eval json */ }), turnsUsed: 1, toolsCalled: [], usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "end_turn" as const }));
vi.mock("./agentic-loop.js", () => ({ runAgenticLoop: loopSpy }));
vi.mock("../providers/factory.js", () => ({ createClient: vi.fn(() => ({} as never)) }));
vi.mock("./model-resolver.js", () => ({ resolveModel: () => "claude-test" }));
vi.mock("./agent-loader.js", () => ({ assembleSystemPrompt: vi.fn().mockResolvedValue("SYS") }));
vi.mock("./tools/index.js", () => ({ resolveRoleTools: () => ({ schemas: [], handlers: new Map() }), getGraphState: () => ({ enabled: false, engineHealth: "disabled" }), getGraphDeps: () => undefined }));
vi.mock("../graph/preflight-injector.js", () => ({ PreflightContextInjector: class { async inject(_r, _c, m) { return m; } } }));
vi.mock("../graph/pipeline-lifecycle.js", () => ({ graphPipelineLifecycle: { getGraphClient: () => null, engineHealth: () => "disabled", getGraphDeps: () => null } }));
vi.mock("../telemetry/emit.js", () => ({ emit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../state/history.js", () => ({ appendHistory: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../utils/git.js", () => ({ getChangedFiles: vi.fn().mockResolvedValue([]) }));
// IMPORTANT: mock runEvaluation to return a REQUIRED programmatic FAILURE so the gate has something to act on:
vi.mock("../evaluators/registry.js", () => ({
  createDefaultRegistry: vi.fn().mockResolvedValue({}),
  runEvaluation: vi.fn().mockResolvedValue({
    passed: false,
    score: 0,
    results: [{ evaluator: "build", passed: false, details: [], summary: "build failed", feedback: "", timestamp: new Date().toISOString() }],
  }),
}));
```

**sc-3-7 assertion (off path):** with `createDefaultConfig(...)` (no `selfImprove`), even though the programmatic result is a required FAIL, `runEvaluatorAgent` MUST still reach the judge:
```ts
const config = createDefaultConfig("test-project", "brownfield");
// ensure a required "build" strategy exists so requiredSet would contain "build" IF the gate were on:
config.evaluator.strategies = [{ type: "build", required: true }];
const { runEvaluatorAgent } = await import("./evaluator-agent.js");
await runEvaluatorAgent(handoff, "/tmp/test-proj", config);
expect(loopSpy).toHaveBeenCalledTimes(1);   // judge STILL ran — off path preserved
```

**sc-3-7 assertion (handoff deep-equality):** call `redactRubric` ONLY-via-flag in pipeline; the pure-fn level test asserts that when the flag is off the handoff object passed onward is `toEqual` the un-redacted one. At the unit level: `expect(maybeRedacted).toEqual(original)` when the gate is bypassed. (Simplest: assert `redactRubric` is a no-op-equivalent only under the flag by testing the pipeline branch logic, OR assert at unit level that an un-redacted handoff deep-equals itself — the load-bearing proof is the `loopSpy` count + a handoff `toEqual`.)

**sc-3-3 on-path assertion (gate ON):** set `config.selfImprove = { deterministicGate: true, rubricIsolation: false, requireCitedArtifact: false, replayDir: ".bober/replay" }`, same required-FAIL mock, then:
```ts
const out = await runEvaluatorAgent(handoff, "/tmp/test-proj", config);
expect(loopSpy).toHaveBeenCalledTimes(0);   // judge SKIPPED
expect(out.passed).toBe(false);
```

### E2E Test Pattern
Not applicable — these are pure orchestration units, no Playwright/browser surface.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/orchestrator/pipeline.ts` | `runEvaluatorAgent`, `createHandoff` | high (live loop) | Off path: with no `selfImprove`, `injectedHandoff` unchanged and `runEvaluatorAgent` reaches the judge. |
| `src/orchestrator/evaluator-agent.test.ts` | `runEvaluatorAgent` | medium | Panel tests use `createDefaultConfig` (no selfImprove) → `loopSpy` counts unchanged. MUST still pass. |
| `src/mcp/tools/eval.ts:153`, `src/mcp/tools/sprint.ts:250` | `runEvaluatorAgent(handoff, root, config)` | low | Signature unchanged; guards off unless config opts in. |
| `src/cli/commands/eval.ts:142`, `src/cli/commands/sprint.ts:256` | `runEvaluatorAgent` | low | Same — signature unchanged. |
| `src/index.ts:86,96` | re-exports `runEvaluatorAgent` + pipeline | low | No symbol removed; only internal logic added. |
| `src/mcp/run-manager.ts:14`, `src/cli/commands/run.ts:7` | `runPipeline` | low | `runSprintCycle` internal; signature unchanged. |

### Existing Tests That Must Still Pass
- `src/orchestrator/evaluator-agent.test.ts` — panel C2/C3/C4 tests; verify `loopSpy` call counts are identical because `createDefaultConfig` has no `selfImprove` (off path). PRIMARY regression guard.
- `src/orchestrator/memory/distill.test.ts` — unaffected (different module) but is your purity-style template.
- `src/orchestrator/selfimprove/replay-*.test.ts` — must remain green; you do NOT touch those modules.
- Any pipeline-level test importing `runPipeline` / `runSprintCycle` — verify no behavior change with default config.

### Features That Could Be Affected
- **Evaluator panel (`config.evaluator.panel`)** — shares `runAgentEvaluation`/`evaluateLenses` (`evaluator-agent.ts:152-197`). Cite-artifact wraps the FINAL `agentResult` (post-reconcile when panel on); ensure the wrap only fires under `requireCitedArtifact` and does not alter the panel off path.
- **Phase-2 guidance injection (sc-4-7)** — shares `injectedHandoff` in `pipeline.ts`. `redactRubric` must apply AFTER guidance injection so the human-guidance issues are preserved (rubric redaction strips `currentContract` rubric fields, not `handoff.issues`).

### Recommended Regression Checks
1. `npm run build` (tsc) → exit 0.
2. `npm run typecheck` → zero errors.
3. `npm test -- eval-guards` → new suite green.
4. `npm test -- evaluator-agent` → panel tests STILL green (proves off path for the judge).
5. `git diff --stat agents/` and `git diff --stat src/orchestrator/selfimprove/replay-*` → EMPTY (untouched per non-goals).
6. `grep -n "config.selfImprove" src/orchestrator/evaluator-agent.ts src/orchestrator/pipeline.ts` → every hit uses `?.` optional chaining.

---

## 8. Implementation Sequence

1. **`src/orchestrator/selfimprove/eval-guards.ts`** — write the 3 PURE exports (types from `eval-result.ts`, `context-handoff.ts`). No clock, no fs, no mutation. Use `.js` import extensions.
   - Verify: `npm run typecheck` clean; functions return new objects.
2. **`src/orchestrator/selfimprove/eval-guards.test.ts`** — unit-test all 3 (sc-3-6) including the input-not-mutated assertion for `redactRubric`.
   - Verify: `npm test -- eval-guards` green.
3. **`src/orchestrator/evaluator-agent.ts`** — add imports; insert the `deterministicGate` short-circuit between `:86` and `:90`; wrap `agentResult` with `enforceCitedArtifacts` under `requireCitedArtifact`. Touch NOTHING else on the off path.
   - Verify: `npm run typecheck`; `npm test -- evaluator-agent` (panel tests still green).
4. **`src/orchestrator/pipeline.ts`** — add `redactRubric` import; wrap `injectedHandoff` under `rubricIsolation` AFTER guidance injection, BEFORE `runGenerator`. Do NOT touch `evalHandoff`.
   - Verify: `npm run typecheck`; grep confirms `config.selfImprove?.` on every new branch.
5. **sc-3-7 invariant test** (in `eval-guards.test.ts` or `evaluator-agent.test.ts`) — assert (a) off-path `loopSpy` called once on a required programmatic failure, (b) on-path `loopSpy` called zero times + `passed:false`, (c) handoff `toEqual` un-redacted when flag off.
   - Verify: `npm test -- eval-guards` and `npm test -- evaluator-agent` both green.
6. **Run full verification** — `npm run build`, `npm run typecheck`, `npm test -- eval-guards`, `npm test -- evaluator-agent`, `npm run lint`.

---

## 9. Pitfalls & Warnings

- **MUTATION IS THE #1 RISK.** `redactRubric` and `enforceCitedArtifacts` MUST return NEW objects. `structuredClone(handoff)` then delete on the clone, OR spread `{ ...handoff, currentContract: { ...handoff.currentContract, ... } }`. Never `delete handoff.currentContract.successCriteria` on the input. sc-3-4/sc-3-5 explicitly assert the input is unchanged.
- **`EvalResult` carries `evaluator`, NOT `required`.** Build the `requiredEvaluators: Set<string>` from `config.evaluator.strategies.filter(s => s.required).map(s => s.type)` (`schema.ts:56-69`) and match via `requiredEvaluators.has(result.evaluator)`. Getting this mapping wrong = the gate fires on optional failures or never fires.
- **Don't redact the evaluator handoff.** `evalHandoff` (`pipeline.ts:408-413`) MUST keep the rubric. Only `injectedHandoff` (generator-bound) is redacted.
- **Off-path byte-identity.** Do not introduce new local variables, re-orderings, or `let`-vs-`const` changes that alter the off path's produced objects. The only off-path-visible change permitted is making `agentResult` a `let` so it can be reassigned ONLY under the flag — verify the off path still yields the identical `agentResult`.
- **`successCriteria.min(1)` schema constraint.** A fully-omitted `successCriteria` array would fail `SprintContractSchema` re-validation — but the generator path only `JSON.stringify`s the handoff (`serializeHandoff`), it does NOT re-parse. If any test deserializes the redacted handoff through `deserializeHandoff`/`ContextHandoffSchema`, prefer the placeholder-criterion approach (mirror `context-handoff.ts:182-190`).
- **ESM `.js` extensions** on every relative import (`./selfimprove/eval-guards.js`). Missing extension = NodeNext resolution failure at build.
- **`config` IS in scope** at both insertion points (`runEvaluatorAgent` param `:48`; `runSprintCycle` param `:163`). No threading needed.
- **Do not enable any default.** All flags stay `.default(false)`; do not edit `schema.ts` (Sprint 1 owns it).
- **Do not touch `agents/*.md` or the replay modules** (contract non-goals). Confirm with `git diff --stat`.
