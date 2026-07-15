# Architecture: Adopt Claude Code Dynamic Workflows as an Interchangeable Orchestration Engine

**Architecture ID:** arch-20260603-adopt-claude-code-dynamic-workflows
**Generated:** 2026-06-03T21:31:32Z
**Status:** draft

---

## Executive Summary

agent-bober's skill-driven orchestrator makes Claude-in-session the orchestrator, degrading over long multi-sprint pipelines through context pollution and offering no background execution or mid-run resume. This architecture adds Claude Code Dynamic Workflows as a third, config-selected orchestration engine (`pipeline.engine: "workflow"`) that drives the existing `bober-*` subagents via `agentType` behind the frozen contracts protocol, with the TS `runPipeline` and the skill orchestrator retained as fallbacks. The key tradeoff accepted is three engines under a single conformance contract in exchange for keeping the CI/headless TS path byte-for-byte intact, since Dynamic Workflows is a research preview that cannot be the sole path. Workflow-unique quality comes from an adversarial/lensed evaluator panel reconciled by a pure shared reducer, and careful-flow gates survive the no-mid-run-input rule via host-side stage-splitting. The primary risk is divergence between the pure-JS reducer port and its TS twin, gated in CI by an engine-conformance harness.

---

## Problem Statement

**Problem:** The skill-driven orchestrator (`skills/bober.run/SKILL.md`, `skills/bober.sprint/SKILL.md`) makes Claude-in-session the orchestrator, which degrades over long multi-sprint pipelines through context pollution, is non-deterministic in turn-by-turn dispatch, cannot run in the background, and cannot be resumed mid-run.

**Constraints:**
- Latency: not specified (no numeric SLA)
- Throughput: structural caps only — 16 concurrent / 1000 total agents per run; `parallel()` blocks on the slowest branch
- Data volume: not specified
- Cost ceiling: not specified
- Backward compatibility: contracts protocol (`PlanSpec`/`SprintContract`/`EvalResult` JSON in `.bober/`), `src/providers/types.ts` (no SDK leakage), the 10 `agents/*.md` subagent defs, the 4 VISION modes (autopilot/careful-flow/diagnose/postmortem), durable `.bober/` state as source of truth (`history.jsonl`, `progress.md`, `specs/`, `contracts/`, `briefings/`), and the principles' hard gates (TS strict zero-error, ESLint zero-error, build via `tsc`, ESM `.js` imports, Zod config validation, no synchronous fs) MUST NOT change.
- Availability gate (HARD): Dynamic Workflows is a research preview, Claude Code v2.1.154+, paid-plans-only → the workflow surface CANNOT be the sole orchestration path; the TS engine (`runPipeline`, `pipeline.ts:516`) must remain for CI/headless, MCP, and non-Anthropic consumers.

**Consumers:** Claude Code interactive (skills/commands plus the new `/bober-audit` and `/bober-migrate`); programmatic TS-API (`runPipeline`/`runSprintCycle`) plus the MCP server; CI/headless `claude -p` (no human present).

**Success Criteria:**
- `.claude/workflows/*.js` drives existing `bober-*` subagents via `agent({agentType})` with zero edits to the 10 agent files and the contracts protocol, verified by identical `.bober/` artifacts.
- Orchestration state lives in script vars / `.bober/` JSON not Claude's context, verified by a ≥10-sprint run with no orchestrator context pollution.
- Replace-vs-complement is resolved so careful-flow's checkpoint gates (disk/PR at `checkpoints/registry.ts:60`) keep working despite the no-mid-run-input rule.
- ≥1 workflow-unique quality pattern (adversarial evaluator panel or multi-angle planner) is wired with a schema and reconciled into a single `EvalResult`/`PlanSpec`.

**Locked Dependencies:** contracts protocol; `providers/types.ts`; the 10 subagent defs; the 4 VISION modes plus entry points; durable `.bober/` state; and the Dynamic Workflows runtime contract (pure-JS, no fs / no `Date.now` / no `Math.random`, no mid-run input, 16/1000 caps, same-session-only resume, forced `acceptEdits` plus inherited allowlist).

---

## System Overview

The design inserts an engine-selection seam exactly at the existing `runPipeline(userPrompt, projectRoot, config) => Promise<PipelineResult>` boundary (`pipeline.ts:516`). A `PipelineEngineSelector` resolves `config.pipeline.engine` to one of three implementations — `"ts"` (the unchanged `runPipeline` body), `"skill"` (the existing skill orchestrator), or `"workflow"` (the new engine) — mirroring the config-driven mechanism resolution at `checkpoints/registry.ts:24`. The contracts protocol, the 10 subagent defs, and the durable `.bober/` state are frozen; engines are interchangeable behind them.

For `engine="workflow"`, the TS host `WorkflowEngine` does all fs and clock work: it reconstructs a resume cursor from durable contract status, marshals config/principles/spec into one JSON-serializable `WorkflowArgs`, invokes the pure-JS `bober-pipeline.js` script, and flushes the returned `WorkflowRunResult` into `.bober/` (stamping ISO timestamps). The script orchestrates `agent({agentType})` calls in parity with the TS pipeline stages (plan → curate → generate → adversarial evaluator panel → reconcile → retry), owning no truth. Careful mode splits the run into host-bounded stages so disk approval gates execute between invokes, never inside the script. An `EngineConformanceHarness` asserts all three engines emit byte-identical `.bober/` artifacts for shared fixtures. The future `/bober-audit` (multi-modal codebase sweep) and `/bober-migrate` (worktree-isolated migration) commands are downstream workflow scripts that reuse this same engine surface; they are out of scope here (see Open Questions).

---

## Component Breakdown

### PipelineEngine

**Responsibility:** Define the engine-selection seam at the frozen `run(userPrompt, projectRoot, config) => Promise<PipelineResult>` signature (`pipeline.ts:516`) and resolve `config.pipeline.engine` to one implementation.

**Interface:**
```typescript
type PipelineEngineName = "workflow" | "ts" | "skill";

interface PipelineEngine {
  readonly name: PipelineEngineName;
  run(userPrompt: string, projectRoot: string, config: BoberConfig): Promise<PipelineResult>;
}

interface PipelineEngineSelector {
  resolveEngineName(config: BoberConfig): PipelineEngineName;
  select(config: BoberConfig): PipelineEngine;
}
// PipelineResult is reused verbatim from pipeline.ts:62
```

**Dependencies:** [WorkflowEngine, WorkflowEligibilityCheck]

---

### WorkflowEngine

**Responsibility:** Implement `PipelineEngine` for `name: "workflow"` by building args, invoking the script, and flushing its result.

**Interface:**
```typescript
interface WorkflowEngine extends PipelineEngine {
  readonly name: "workflow";
}

interface WorkflowLauncher {
  buildArgs(userPrompt: string, config: BoberConfig, resumeCursor: ResumeCursor): WorkflowArgs;
  invoke(args: WorkflowArgs): Promise<WorkflowRunResult>;
  flush(projectRoot: string, config: BoberConfig, result: WorkflowRunResult): Promise<PipelineResult>;
}
```

**Dependencies:** [ArgsPayloadBuilder, WorkflowScript, ResumeCursorReconstructor, RunResultFlusher]

---

### ArgsPayloadBuilder

**Responsibility:** Marshal config, principles, models, lenses, and resume state into one JSON-serializable `WorkflowArgs` payload.

**Interface:**
```typescript
interface ArgsPayloadBuilder {
  build(userPrompt: string, config: BoberConfig, resumeCursor: ResumeCursor): WorkflowArgs;
}

type WorkflowArgs = {
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
```

**Dependencies:** [ResumeCursorReconstructor]

---

### WorkflowScript

**Responsibility:** Orchestrate the pure-JS pipeline (`bober-pipeline.js`), dispatching `bober-*` subagents via `agentType` in parity with the TS pipeline stages.

**Interface:**
```typescript
interface WorkflowScript {
  main(args: WorkflowArgs): Promise<WorkflowRunResult>;
}

type AgentCall = {
  agentType: "bober-planner" | "bober-curator" | "bober-generator" | "bober-evaluator";
  model: string;
  prompt: string;
  schema: unknown;
};

type WorkflowRunResult = {
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
```

**Dependencies:** [EvaluatorPanelReconciler]

---

### EvaluatorPanelReconciler

**Responsibility:** Reduce per-lens `EvalResult[]` into one canonical `EvalResult` by majority vote, fail-closed on tie, unioning failing details.

**Interface:**
```typescript
interface EvaluatorPanelReconciler {
  reconcile(sprintId: string, round: number, lensVerdicts: EvalResult[]): EvalResult;
  // returns EvalResult with evaluator: "panel"; timestamp injected by caller
}
```

**Dependencies:** [] (pure reducer, shared host + script port)

---

### ResumeCursorReconstructor

**Responsibility:** Re-derive completed-sprint state from durable contract status and history so a workflow run resumes crash-safely.

**Interface:**
```typescript
interface ResumeCursorReconstructor {
  reconstruct(projectRoot: string, specId: string): Promise<ResumeCursor>;
}

type ResumeCursor = {
  specId: string;
  completedSprintNumbers: number[];
  lastObservedSprintNumber: number;
};
// host-side fs read: loadHistory (history.ts:74) + contract status
```

**Dependencies:** []

---

### RunResultFlusher

**Responsibility:** Commit a `WorkflowRunResult` to durable `.bober/` state, stamping ISO timestamps as the only clock source on the workflow path.

**Interface:**
```typescript
interface RunResultFlusher {
  flush(projectRoot: string, config: BoberConfig, result: WorkflowRunResult): Promise<PipelineResult>;
  // saveContract/updateContract (sprint-state.ts:38/:152), appendHistory (history.ts:51),
  // updateProgress (history.ts:108); atomic per file
}
```

**Dependencies:** []

---

### EngineConformanceHarness

**Responsibility:** Assert that selected engines emit equivalent `.bober/` artifacts for a shared fixture spec.

**Interface:**
```typescript
interface EngineConformanceHarness {
  assertEquivalent(
    fixtureSpec: PlanSpec,
    engines: PipelineEngineName[],
    projectRootFactory: () => string
  ): Promise<ConformanceReport>;
}

type ConformanceReport = {
  equivalent: boolean;
  diffs: Array<{
    artifact: "spec" | "contract" | "eval-result" | "history";
    path: string;
    engines: PipelineEngineName[];
  }>;
};
```

**Dependencies:** [PipelineEngineSelector]

---

## Data Model

The persistent data model is the FROZEN contracts protocol — referenced by name, not redefined here: `PlanSpec`, `SprintContract`, `EvalResult`, and `HistoryEntry` JSON under `.bober/`, defined in `src/contracts/` (`src/contracts/eval-result.ts:60` for `EvalResult`). Engines read and write these shapes unchanged.

The new TS types this architecture introduces:

```typescript
type PipelineEngineName = "workflow" | "ts" | "skill";

type WorkflowArgs = {
  userPrompt: string;
  knobs: {
    maxIterations: number; maxSprints: number; researchPhase: boolean;
    architectPhase: boolean; curatorEnabled: boolean;
    codeReviewEnabled: boolean; requireContracts: boolean;
  };
  models: { planner: string; curator: string; generator: string; evaluator: string };
  evaluatorLenses: string[];
  principles: string;
  preloadedSpec?: PlanSpec;          // FROZEN type from src/contracts/
  preloadedContracts: SprintContract[]; // FROZEN type from src/contracts/
  resumeCursor: ResumeCursor;
};

type WorkflowRunResult = {
  spec: PlanSpec;
  perSprint: Array<{
    contract: SprintContract; finalVerdict: EvalResult; iterationsUsed: number;
    outcome: "passed" | "needs-rework" | "failed"; lensVerdicts: EvalResult[];
  }>;
  needsClarification: boolean;
  pendingHistory: Array<Omit<HistoryEntry, "timestamp">>; // host stamps timestamp on flush
};

type ResumeCursor = {
  specId: string; completedSprintNumbers: number[]; lastObservedSprintNumber: number;
};

type ConformanceReport = {
  equivalent: boolean;
  diffs: Array<{ artifact: "spec" | "contract" | "eval-result" | "history"; path: string; engines: PipelineEngineName[] }>;
};
```

---

## API Contracts

| Method | Input | Output | Error Cases |
|--------|-------|--------|-------------|
| PipelineEngineSelector.select | engine, config | PipelineEngine | unknown engine → throw (`registry.ts:26`); workflow ineligible → returns TS engine + logs downgrade |
| WorkflowEngine.run | userPrompt, projectRoot, config | Promise\<PipelineResult\> | runtime unavailable → `WorkflowUnavailableError` (selector falls back); cap exceeded → `AgentCapError`; flush fail → propagate, `.bober/` at last consistent contract |
| ArgsPayloadBuilder.build | userPrompt, config, cursor | WorkflowArgs | missing knob → `MissingKnobError` at build (no silent default); non-serializable model → `NonSerializableArgError` |
| agent (runtime) | { agentType, model, prompt, schema } | Promise\<T\> validated | schema fail → runtime rejects; fan-out > 16 → queues/rejects; subagent error → per-iteration retry catches (`pipeline.ts:290`) |
| EvaluatorPanelReconciler.reconcile | EvalResult[] | canonical EvalResult | empty → throw; tie → fail-closed; unions details (parity `pipeline.ts:223-245`) |
| ResumeCursorReconstructor.reconstruct | projectRoot, specId | ResumeCursor | no history → `completedSprintNumbers: []`; status ≠ history → trust contract status |
| RunResultFlusher.flush | projectRoot, config, result | Promise\<PipelineResult\> | partial crash → next reconstruct re-derives from last durable contract; writer throw → propagate, no half-written contract (atomic per file) |

---

## Integration Strategy

### Data Flow (autopilot)

```
runRunCommand (run.ts:41)
  → loadConfig + overrides (run.ts:81-128)
  → ensureBoberDir (run.ts:131)
  → runPipeline (run.ts:146, FROZEN seam)
    → PipelineEngineSelector.select(config.pipeline.engine; default "ts"; mirrors registry.ts:24)
      → if "workflow" && eligible: WorkflowEngine.run   else: TS body (pipeline.ts:533-840)

WorkflowEngine.run:
  1. ResumeCursorReconstructor.reconstruct (loadHistory history.ts:74 + contract status)
  2. ArgsPayloadBuilder.build (models, lenses from config.evaluator.strategies, principles) → WorkflowArgs
  3. invoke(bober-pipeline.js, args)
  4. RunResultFlusher.flush

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

POST-RUN host flush:
  saveContract/updateContract (sprint-state.ts:38/:152), appendHistory (history.ts:51),
  updateProgress (history.ts:108), writeCompletionMarker, stamp ISO timestamps
  → CLI prints summary (run.ts:149-201)
```

### Data Flow (careful-flow stage-split variant)

TS/skill careful runs gate inline via `runWithAudit → getCheckpointMechanismFor("pre-generator", config) → DiskCheckpointMechanism.request`, block-polling `.bober/approvals/<id>.pending.json` until `.approved`/`.rejected` (`disk.ts:63-176`). The workflow script CANNOT block-poll inline, so the run is STAGE-SPLIT:

```
STAGE1  invoke(stopBefore: "pre-generator@sprint=K") → script returns status: "awaiting-gate"
HOST (between same-session stages):
  flush(partial)
  DiskCheckpointMechanism.request (disk.ts:63)
  apply editDelta (disk.ts:123)
STAGE2  reconstruct + invoke(resumeCursor, startAt: "pre-generator@sprint=K")
```

Approval happens at the host-owned same-session boundary, never inside the pure-JS body.

### Consistency Model

Source of truth = durable `.bober/` JSON (strong, host-owned).

| Boundary | Model | Truth Owner |
|----------|-------|-------------|
| Script in-memory vars | ephemeral, discarded on exit | none |
| WorkflowRunResult → `.bober/` | strong; flush is the commit point | RunResultFlusher |
| Resume cursor reconstruction | strong-read | contract status files |
| Careful disk approval marker | eventual → strong | `.bober/approvals/` |
| Subagent working-tree edits | strong (`acceptEdits` forced) | git tree; careful intent gated at stage boundary, not per-edit |

**Invariant:** the script never owns truth — if `WorkflowRunResult` omits a fact, it did not happen per `.bober/`; resume always re-derives from committed contract status, crash-safe at every flush.

### Integration Risks

| Risk | Severity | Owner | Mitigation |
|------|----------|-------|------------|
| Reconciler drift: JS-port vs TS-twin (sprint passes one engine, fails the other) | critical | EngineConformanceHarness | fixture lens-vectors (ties, mixed, empty-detail) assert byte-identical EvalResult; CI gate |
| Same-session resume loses in-flight sprint before flush → duplicate generator work | high | WorkflowEngine / RunResultFlusher | flush after EACH contract, not once at end; idempotent commit-by-message; skip passed contracts |
| Workflow runtime ineligible (preview / paid / version < 2.1.154) | high | PipelineEngineSelector | eligibility probe → downgrade to TS engine + log; CI pins `engine="ts"` |
| Agent caps exceeded (spec × maxIterations × lenses > 16/1000) | high | ArgsPayloadBuilder | compute worst-case count at build; `AgentCapError` pre-invoke; panel chunked ≤ 16 |
| Careful-flow mid-run input collision | high | WorkflowEngine | stage-split; approval in host between invokes (`disk.ts:63`), never in script |
| Forced acceptEdits vs careful gate intent | medium | WorkflowEngine | gate at pre-generator boundary before generator subagent spawns |
| WorkflowArgs omits a knob (no fs fallback) → silent wrong default | medium | ArgsPayloadBuilder | every script-read knob required; `MissingKnobError` if unset; conformance asserts script reads only declared `args.*` keys |
| Skill engine unmaintained → bit-rot | low | EngineConformanceHarness | harness covers all 3 engines on same fixtures |

### External Dependencies

| Service | Used By | Failure Mode | Fallback |
|---------|---------|--------------|----------|
| Dynamic Workflows runtime (research-preview, paid-only, CC ≥ 2.1.154) | WorkflowEngine.invoke + agent() inside script | unavailable / preview-disabled / quota → invoke throws | PipelineEngineSelector downgrades to `engine="ts"` (frozen `runPipeline` `pipeline.ts:516`) |
| Anthropic provider/model (pre-resolved into args.models) | every agent call | API error / rate-limit / deprecated | per-iteration retry in script loop (`pipeline.ts:290-301`); exhausted → contract needs-rework (`pipeline.ts:491`) |
| Claude Code version gate ≥ 2.1.154 | eligibility probe in select | older binary → Workflows API absent | probe ineligible → TS engine, logged once |
| Disk approval markers `.bober/approvals/` (careful) | DiskCheckpointMechanism.request (`disk.ts:63`) host-side | timeout (default 24h, cap 7d, `disk.ts:24-25`) → `{ approved: false, feedback: TIMEOUT }` | treated as rejection; STAGE2 not invoked; contract in-progress, resumable next session |

---

## Architecture Decision Records

- [ADR-1: Adopt Dynamic Workflows as a Config-Selected Interchangeable Engine](.bober/architecture/arch-20260603-adopt-claude-code-dynamic-workflows-adr-1.md)
- [ADR-2: Engine-Selection Seam at the runPipeline Signature Boundary](.bober/architecture/arch-20260603-adopt-claude-code-dynamic-workflows-adr-2.md)
- [ADR-3: Config Reaches the Script via a Typed args Payload, Not a Bootstrap Agent](.bober/architecture/arch-20260603-adopt-claude-code-dynamic-workflows-adr-3.md)
- [ADR-4: Evaluator Panel Reconciliation as a Pure Reducer, Shared Host+Script](.bober/architecture/arch-20260603-adopt-claude-code-dynamic-workflows-adr-4.md)
- [ADR-5: Careful-Flow Stage-Splitting at Out-of-Band Gates](.bober/architecture/arch-20260603-adopt-claude-code-dynamic-workflows-adr-5.md)
- [ADR-6: Workflow Eligibility Probe with Fallback-to-TS Policy](.bober/architecture/arch-20260603-adopt-claude-code-dynamic-workflows-adr-6.md)

---

## Risk Assessment

| Risk | Severity | Owner | Mitigation |
|------|----------|-------|------------|
| Reconciler JS-port vs TS-twin drift | critical | EngineConformanceHarness | fixture lens-vectors assert byte-identical EvalResult; CI gate |
| Resume loses in-flight sprint before flush → duplicate work | high | WorkflowEngine / RunResultFlusher | flush after each contract; idempotent commit; skip passed contracts |
| Workflow runtime ineligible (preview / paid / version) | high | PipelineEngineSelector | eligibility probe → TS downgrade; CI pins `engine="ts"` |
| Agent caps exceeded (spec × iterations × lenses > 16/1000) | high | ArgsPayloadBuilder | worst-case count at build; `AgentCapError` pre-invoke; panel chunked ≤ 16 |
| Careful-flow mid-run input collision | high | WorkflowEngine | stage-split; host-side approval between invokes |
| `PipelineResult` field set by TS only, not workflow → content divergence | medium | EngineConformanceHarness | harness diffs content, not only shape |
| Forced acceptEdits vs careful gate intent | medium | WorkflowEngine | gate at pre-generator boundary before generator spawns |
| WorkflowArgs omits a knob → silent wrong default | medium | ArgsPayloadBuilder | every script-read knob required; `MissingKnobError`; conformance-asserted |
| Stale `.approved.json` auto-passes on resume | medium | WorkflowEngine | stale-marker cleanup (`disk.ts:81`) on resume |
| Skill engine bit-rot | low | EngineConformanceHarness | harness covers all 3 engines on same fixtures |

---

## Open Questions

- **`/bober-audit` and `/bober-migrate` as future workflow scripts:** These codebase-wide commands (multi-modal sweep and worktree-isolated migration) are out of scope for this core engine work. Assumption: they are downstream scripts that reuse this engine surface (`WorkflowArgs`, the `agent({agentType})` dispatch convention, `RunResultFlusher`) rather than new orchestration paths. If wrong — if they need orchestration primitives this engine does not expose — `WorkflowArgs` and the script entry contract would need extension before they ship.
- **Multi-angle planner / judge panel as a second workflow-unique pattern:** Beyond the adversarial evaluator panel, a multi-angle planner reconciled into a single `PlanSpec` is a candidate quality pattern. Assumption: deferred; only the evaluator panel is wired in this architecture. If wrong — if a planner panel is required for the first release — a `PlanSpec` reconciler analogous to `EvaluatorPanelReconciler` (pure reducer, shared host+script) must be added and conformance-covered.
- **Retirement of the skill engine at Workflows GA:** Per ADR-1 the skill engine is retained as a config-selectable fallback. Assumption: it is kept until Dynamic Workflows reaches general availability (no longer preview/paid-gated). If wrong — if the skill engine is retired early — the `WorkflowUnavailableError` fallback chain must route to the TS engine only, and the conformance harness must drop the `"skill"` fixture lane.
