# Research: Refactor agent-bober's execution layer into a Prompt Graph Engineering (PGE) pipeline

**Research ID:** research-20260805-pge-langgraph-refactor
**Generated:** 2026-08-05
**Source documents:** `~/Downloads/agent-bober-pge-masterplan.md`, `~/Downloads/agent-bober-architecture.md`
**Questions Explored:** 10
**Method:** tokensave code graph + direct reads (no explore agents, per project rule)

---

## Architecture Overview

agent-bober is a **TypeScript/ESM** CLI (1,293 TS source files, 2,060 indexed files, 20,420 graph
nodes), built with `tsc` to `dist/`, tested with Vitest (~5,083 tests), and distributed by symlink
into other projects. There is no Python in the orchestration path.

The execution layer is already **two-engine**, not single-path:

- `runPipeline` (`src/orchestrator/pipeline.ts:1073`) is the public entry. It delegates through an
  engine-selection seam (`pipeline.ts:1060`) to `selectPipelineEngine(config)`
  (`src/orchestrator/workflow/selector.ts:52`).
- `TsPipelineEngine` → `runTsPipeline` (`pipeline.ts:720`) is the live, imperative path.
- `WorkflowEngine` (`src/orchestrator/workflow/workflow-engine.ts:32`) is a **dormant** graph-shaped
  path with a full supporting runtime already written and tested.

`config.pipeline.engine` is a validated enum `["ts","skill","workflow","medical-sop"]`
(`src/config/schema.ts:360`), default `"ts"`.

## Existing Patterns

**The PGE-shaped runtime already exists in `src/orchestrator/workflow/` (34 files).**

| PGE requirement from the docs | Already implemented here |
|---|---|
| Send-API dynamic fan-out / map-reduce | `Scheduler.parallel(thunks)` and `Scheduler.pipeline(items, ...stages)` — `scheduler.ts:139,149`. Hand-off `Semaphore` (`scheduler.ts:54`) gives true bounded concurrency, not chunk-batching. |
| Concurrency cap | `defaultConcurrency() = max(1, min(16, cores-2))` — `scheduler.ts:42`. Explicitly documented as mirroring the Claude Code dynamic-workflow runtime. |
| Loop-counter / runaway-budget mitigation | `Scheduler.maxAgents` default 1000 → `AgentCapError` (`scheduler.ts:23,118`); `runPureSprint` `maxIterations` loop (`pure-sprint.ts:106`); `Budget` with token/agent/USD ceilings → `BudgetExceededError` (`budget.ts:29,119`). |
| Exponential backoff on transient failure | `withRetry` + `classifyTransient` — `retry.ts:61,103` (HTTP 408/429/5xx, transient net codes, jittered decorrelated backoff). |
| Private node state / no scratchpad in global state | `runWorkflow` (`interpreter.ts:55`) and `runPureSprint` (`pure-sprint.ts:93`) are **pure — they write nothing**. `RunResultFlusher.flush` (`flusher.ts:34`) is the *sole* commit point *and* the sole `new Date()` clock source. |
| Checkpointer / resume | `ResumeCursor` (`types.ts:50`), `ResumeCursorReconstructor`, skip-completed filtering **before** dispatch (`interpreter.ts:102-103`) so re-runs never double-write history. |
| Human-in-the-loop `interrupt()` | `src/orchestrator/checkpoints/` — `registry.ts`, `feedback-router.ts`, `audit.ts`, and three mechanisms (`cli.ts`, `disk.ts`, `pr.ts`). |
| Structural diffing / CI equivalence gate | `EngineConformanceHarness.assertEquivalent` (`conformance.ts:75`) — strips volatile keys (`createdAt`, `runId`, `duration`, …) and deep-compares `.bober/` artifacts across engines. |
| Context compression at threshold | `src/orchestrator/compaction.ts` — one extra `client.chat` summarization call replacing head messages; **fails open** (returns `undefined`, never throws). |
| Engram-style structured handoff | `src/orchestrator/context-handoff.ts` — Zod-typed `ProjectContext` / `Decision` (`description` + `rationale` + `madeBy`) carried between roles. Plus two-phase researcher isolation (question generation blind to exploration), `.bober/research/` archive, bounded `.bober/memory/` with deterministic distill. |
| Hybrid model routing (size-matching) | `src/orchestrator/model-resolver.ts` (`resolveProviderModel`, `resolveModel`) + per-role model map `{planner, curator, generator, evaluator}` in `WorkflowArgs.models` (`types.ts:25`). |
| Verification gates between stages | Zod schemas on every artifact (`SprintContractSchema`, `PlanSpecSchema`, `EvalResult`), plus `ContractPrecisionIssue` checks (`sprint-contract.ts:229`) and a fail-closed security gate (`security-gate.ts`). |

**Structure/content separation (G2)** is partially satisfied already: prompts live as markdown agent
definitions in `agents/*.md`, assembled at runtime by `assembleSystemPrompt`
(`src/orchestrator/agent-loader.ts:192`), separate from the orchestration code.

## Key Files

- `src/orchestrator/pipeline.ts` (1,094 lines) — `runPipeline:1073`, `runTsPipeline:720`,
  `runSprintCycle:167`, engine seam at `:1060`.
- `src/orchestrator/workflow/eligibility.ts:10-12` — `isWorkflowEligible()` **hardcodes `return false`**
  with a `TODO(sprint-6)`.
- `src/orchestrator/workflow/workflow-engine.ts:90-94` — `invoke()` **unconditionally throws**
  `WorkflowUnavailableError`; comment: *"DORMANT this release."*
- `src/orchestrator/workflow/interpreter.ts:61` — `opts.scheduler ?? new Scheduler({ maxConcurrent: 1 })`,
  i.e. sequential by default; comment: *"Sprint 5 raises the cap and adds dependsOn-aware ordering."*
- `src/orchestrator/workflow/scheduler.ts` — concurrency primitives.
- `src/orchestrator/workflow/flusher.ts` — sole commit/clock boundary.
- `src/contracts/sprint-contract.ts:92` — `dependsOn: z.array(z.string()).default([])`.
- `src/config/schema.ts:360` — `pipeline.engine` enum.

## Integration Points

1. **Engine seam** — `selectPipelineEngine` / `selectPipelineEngineForTeam` (`selector.ts:52,110`).
   Both apply the same downgrade rules; a team's `pipelineShape` feeds the same resolver.
2. **Two dormancy gates** — `isWorkflowEligible()` and `WorkflowEngine.invoke()`. Flipping these is
   the entire difference between "dormant" and "live" for the graph path.
3. **Interpreter deps injection** — `WorkflowDeps { plan, buildContracts, runSprint }`
   (`interpreter.ts:33`) and `PureSprintDeps { curate, generate, evaluate, reconcile }`
   (`pure-sprint.ts:59`) are the seams where real agent wiring attaches. Currently only fakes are wired.
4. **Flusher** — the single write boundary; any parallel execution merges here, so fan-in is already
   race-free by construction.
5. **Config** — `pipeline.engine`, `pipeline.mode` (`careful` forces downgrade to `ts`),
   `maxIterations` (default 20), `maxSprints`.

## Test Coverage

Every workflow module has a paired `.test.ts`: `scheduler.test.ts` (229 lines, includes a
`concurrencyTracker` helper asserting peak concurrency), `interpreter.test.ts`,
`workflow-engine.test.ts` (282 lines), `pure-sprint.test.ts`, `retry.test.ts`, `budget.test.ts`,
`flusher.test.ts` (400+ lines), `conformance.test.ts`, `reconcile-conformance.test.ts`,
`reconciler.test.ts`, `resume-cursor.test.ts`, `selector.test.ts` (265 lines), `synthesizer.test.ts`,
`args-builder.test.ts`, `script-helpers.test.ts`. Full suite ≈5,083 tests (Vitest 3.2.6).

The eligible/live path is only reachable in tests via an injection seam
(`WorkflowEngine` constructor `tsEngineFactory` + `vi.mock` of eligibility).

## Risk Areas

1. **Live sprint execution is strictly sequential.** `runTsPipeline` runs
   `for (let i = 0; i < maxSprints; i++) { await runSprintCycle(...) }` (`pipeline.ts:978-987`).
   The latency complaint in the source documents is accurate *for the live path*.
2. **`dependsOn` is declared but never read.** It exists on `SprintContractSchema:92` and nothing in
   `pipeline.ts` or `interpreter.ts` consumes it. Any fan-out today would be all-or-nothing and could
   run a dependent sprint before its dependency.
3. **`Scheduler.parallel` uses `Promise.all`** (`scheduler.ts:140`) — one rejecting thunk rejects the
   whole batch. `pipeline()` degrades an item to `null` instead, but `parallel()` has no
   partial-failure recovery. The masterplan's §8.2 pattern is genuinely absent.
4. **No inspectable/serializable topology (G1).** The graph shape is implicit in `runWorkflow`'s
   control flow. Nothing can dump, validate, or visualize the topology without executing it.
5. **No per-node caching** (no `CachePolicy` / semantic cache equivalent).
6. **No test-anchor registry.** AlphaCodium's regression guard — verifying a self-healing edit does not
   break already-passed criteria — has no counterpart; `runPureSprint` re-evaluates from scratch each
   iteration and `priorPassed` (`pure-sprint.ts:32`) is passed but only as generator context.
7. **Tracing is emit-only.** `src/telemetry/emit.ts` and `src/orchestrator/observability/` exist; there
   is no span/trace tree of intermediate state transitions.
8. **Language boundary.** The source documents prescribe Python + LangGraph. There is no Python in the
   orchestration path, and the surrounding investment (providers, MCP client, graph backends, CLI,
   ~5,083 tests, npm distribution) is TypeScript.
9. **In-flight plan overlap.** `.bober/specs/spec-20260804-opus5-adaptation.json` (8 contracts, all
   `proposed`, none executed) already includes Sprint 8 *"Run the post-evaluator review chain
   concurrently"*, which touches the same concurrency surface.
10. **Working tree is dirty and the branch is unmerged.** Branch `bober/graph-backend-choice` has
    modified `bober.config.json`, `model-resolver.ts`, and untracked spec/contract files.

---

*Generated by the bober.research two-phase discipline — factual findings only, no implementation
recommendations.*
