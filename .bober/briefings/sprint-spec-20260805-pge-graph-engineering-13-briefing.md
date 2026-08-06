# Sprint Briefing: PgeEngine behind the seam, ts-vs-pge artifact equivalence, offline trace replay, off-by-default OTLP exporter

**Contract:** sprint-spec-20260805-pge-graph-engineering-13
**Generated:** 2026-08-06T00:00:00Z
**Repo root:** `/Users/bober4ik/agent-bober-workspace/agent-bober` (branch `bober/pge-graph-engineering`)

> READ SECTION 3 AND SECTION 9 BEFORE WRITING A LINE. This sprint has one large,
> unbudgeted gap (8 node implementations that do not exist) and four instrumentation gaps
> (span.model, span.tokens, span.costUsd, span.toolOutputRef are never written). Both were
> discovered by opening the files, not by reading the contract.

---

## 1. Target Files

### `src/pge/engine/pge-engine.ts` (create)

**The directory does not exist.** `ls src/pge/engine` → `No such file or directory`.
It is nevertheless already known to the lint boundary: `eslint.config.js:127` lists
`"**/pge/engine/**"` among the imports forbidden from `src/pge/topology/**`, and
`src/pge/eslint-boundary.test.ts:57` probes `"../engine/pge-engine.js"` by that exact
path. **Name the file exactly `src/pge/engine/pge-engine.ts`** or that probe stops
describing a real module.

**Naming convention in `src/pge/`:** kebab-case files, one `create*`/class per module,
co-located `*.test.ts`. See `src/pge/runtime/` (`retry-planner.ts`, `graceful-failure.ts`,
`token-estimator.ts`).

**Most similar existing file:** `src/orchestrator/workflow/ts-engine.ts` (24 lines) — the
whole of the seam adapter pattern:

```ts
// src/orchestrator/workflow/ts-engine.ts:13-24
export class TsPipelineEngine implements PipelineEngine {
  readonly name: PipelineEngineName = "ts";

  run(
    userPrompt: string,
    projectRoot: string,
    config: BoberConfig,
    opts?: RunOptions,
  ): Promise<PipelineResult> {
    return runTsPipeline(userPrompt, projectRoot, config, opts);
  }
}
```

**Structure template** (assembled from the real run loop, see §2 "Composing a RunContext"):

```ts
export interface PgeEngineDeps {
  interpreterFactory?: () => GraphInterpreter;   // default createGraphInterpreter
  registries?: (spec: TopologySpec) => Registries; // default: full production composition
  graphId?: string;                               // default CODING_GRAPH_ID
  clock?: Clock;                                  // default createSystemClock()
  fallback?: PipelineEngine;                      // default new TsPipelineEngine()
}
export class PgeEngine implements PipelineEngine {
  readonly name: PipelineEngineName = "pge";
  constructor(private readonly deps: PgeEngineDeps = {}) {}
  async run(userPrompt, projectRoot, config, opts?): Promise<PipelineResult> { /* … */ }
}
```

---

### `src/orchestrator/workflow/selector.ts` (modify)

**Relevant sections (lines 20-28) — the downgrade the contract tells you to MIRROR, and
which must MOVE out of this file:**

```ts
// src/orchestrator/workflow/selector.ts:20-28
function downgradeReservedEngine(
  requested: PipelineEngineName,
): PipelineEngineName | undefined {
  if (requested !== "pge") return undefined;
  logger.info(
    "Engine 'pge' requested but no PgeEngine implementation exists; downgrading to 'ts'.",
  );
  return "ts";
}
```

Called at `selector.ts:48-49` (`resolveEngineName`) and `selector.ts:116-117`
(`resolveEngineNameForTeam`). The two currently-unreachable arms:

```ts
// src/orchestrator/workflow/selector.ts:94-98
    case "pge":
      // UNREACHABLE — resolveEngineName downgrades 'pge' to 'ts' above. Kept so the
      // switch stays exhaustive over PIPELINE_ENGINE_NAMES; a PgeEngine replaces it.
      return new TsPipelineEngine();
```
```ts
// src/orchestrator/workflow/selector.ts:158-161
    case "pge":
      // UNREACHABLE — resolveEngineNameForTeam downgrades 'pge' to 'ts' above.
      return new TsPipelineEngine();
```

**Imports this file uses:** `logger` (`../../utils/logger.js`), `isWorkflowEligible`
(`./eligibility.js`), `TsPipelineEngine` (`./ts-engine.js`), `WorkflowEngine`
(`./workflow-engine.js`), `MedicalSopEngine` (`../../medical/engine.js`).

**Imported by:** `src/orchestrator/pipeline.ts:1092` (`runPipeline` →
`selectPipelineEngineForTeam(team, config).run(...)`). That is the ONLY production call
site of the selector — every consumer (CLI `run`, MCP RunManager, worktree runner, fleet
children, chat-spawned runs) reaches the engine through `runPipeline`.

**Test file:** `src/orchestrator/workflow/selector.test.ts` — EXISTS, 372 lines, and four
of its assertions pin the OLD behaviour. See §7.

---

### `src/orchestrator/workflow/conformance.ts` (modify)

**Relevant sections — the two-field collection that must become eleven:**

```ts
// src/orchestrator/workflow/conformance.ts:18-27
const VOLATILE_KEYS = new Set([
  "createdAt", "updatedAt", "startedAt", "completedAt",
  "timestamp", "duration", "runId", "totalCost",
]);
```
```ts
// src/orchestrator/workflow/conformance.ts:83-89
    const perEngine: Record<string, { contracts: unknown[]; history: unknown[] }> = {};
```
```ts
// src/orchestrator/workflow/conformance.ts:101-107
      const rawContracts = await listContracts(root);
      const rawHistory = await loadHistory(root);
      perEngine[engine] = {
        contracts: normalize(rawContracts) as unknown[],
        history: normalize(rawHistory) as unknown[],
      };
```
```ts
// src/orchestrator/workflow/conformance.ts:122-137 — the "diff" today is a boolean
        if (JSON.stringify(a.contracts) !== JSON.stringify(b.contracts)) {
          diffs.push({ artifact: "contract", path: ".bober/contracts/", engines: [nameA, nameB] });
        }
```

`normalize` (`conformance.ts:34-51`) is a recursive volatile-key stripper that is already
order-preserving-but-not-order-tolerant: it maps arrays elementwise. The **order-tolerant
structured diff** sc-13-2 asks for must sort keyed collections (contracts by
`contractId`, specs by `specId`, history by `event`+ordinal) BEFORE comparison.

**`ConformanceReport` lives in a file NOT in `estimatedFiles`:**

```ts
// src/orchestrator/workflow/types.ts:58-65
export type ConformanceReport = {
  equivalent: boolean;
  diffs: Array<{
    artifact: "spec" | "contract" | "eval-result" | "history";
    path: string;
    engines: PipelineEngineName[];
  }>;
};
```

The `artifact` union has FOUR members and sc-13-2 names ELEVEN. Widening
`src/orchestrator/workflow/types.ts` is unavoidable and in scope.

**Test file:** `src/orchestrator/workflow/conformance.test.ts` — EXISTS, 329 lines,
deterministic stub runners only, real `mkdtemp` roots. All its cases stay valid after
widening (they compare `contract`/`history`), provided the new fields read as empty on
both sides.

---

### `src/pge/runtime/commit.ts` (modify)

`finalize` is already correct and the contract says keep it that way:

```ts
// src/pge/runtime/commit.ts:435-458
    async finalize(state, ctx): Promise<PipelineResult> {
      if (state.spec === null) throw new FinalizeWithoutSpecError(state.runId);
      const completedSprints = state.sprintContracts.filter((c) => c.status === "passed");
      const failedSprints = state.sprintContracts.filter((c) => c.status !== "passed");
      return finalizePipelineRun({
        projectRoot: state.projectRoot, runId: state.runId, config: ctx.config,
        spec: state.spec, completedSprints, failedSprints,
        startedAtMs: ctx.startedAtMs ?? clock.nowMs(),
      });
    },
```

Other exports you will need: `createCommitBoundary` (`commit.ts:298`),
`createSystemClock` (`commit.ts:237`), `createFixedClock(iso)` (`commit.ts:246`),
`createDomainArtifactWriter` (`commit.ts:211`), `CommitContext` (`commit.ts:190-197`).

**Test file:** `src/pge/runtime/commit.test.ts` — EXISTS.

---

### `src/pge/runtime/replay.ts`, `src/pge/runtime/otlp-exporter.ts` (create)

Neither exists. Sibling pattern to copy: `src/pge/runtime/trace.ts` (394 lines) — Zod
schema block → error classes → layout helpers (`traceRoot`, `tracePath`) → `create*`
factory → reader functions. Every store function takes `projectRoot` as its FIRST
REQUIRED argument and no module exports a live instance (`src/pge/runtime/isolation.test.ts:20-31`).

---

### `src/cli/commands/trace.ts` (create) + `src/cli/index.ts` (modify)

`src/cli/commands/trace.ts` does not exist. Registration pattern — copy
`registerPgeCommand` verbatim in shape:

```ts
// src/cli/commands/pge.ts:682-700
export function registerPgeCommand(program: Command): void {
  const pge = program
    .command("pge")
    .description("Prompt Graph Engineering topology artifacts (.bober/topology/)");
  pge
    .command("dump")
    .description("Serialize the authored topology to .bober/topology/<graphId>.json")
    .option("--graph <id>", "Graph id to dump", CODING_GRAPH_ID)
    .action(async (cmdOpts: { graph?: string; check?: boolean }) => {
      const io = processIo();
      process.exitCode = await runPgeDump(await resolveRoot(), { … }, io);
    });
```

Exit-code + injected-IO convention: `EXIT_OK = 0`, `EXIT_FAILED = 1`, `EXIT_USAGE = 2`
(`src/cli/commands/pge.ts:58-64`); `PgeIo` / `processIo()` (`pge.ts:73-82`); **no verb
calls `process.exit`** — each returns a code the Commander action assigns to
`process.exitCode`. `src/cli/index.ts:284` is where `registerPgeCommand(program)` is
called; add `registerTraceCommand(program)` beside it (import at `src/cli/index.ts:23`).

---

## 2. Patterns to Follow

### The PipelineEngine seam — the exact signatures PgeEngine must satisfy
**Source:** `src/orchestrator/workflow/engine.ts`, lines 45-67

```ts
export interface RunOptions {
  runId?: string;
  teamId?: string;
  now?: string;          // Injected ISO-8601 clock. Engines that accept it must not read the wall clock.
  signal?: AbortSignal;
  resume?: boolean;
}

export interface PipelineEngine {
  readonly name: PipelineEngineName;
  run(
    userPrompt: string,
    projectRoot: string,
    config: BoberConfig,
    opts?: RunOptions,
  ): Promise<PipelineResult>;
}
```

**PipelineResult — every field PgeEngine.run must populate** (`src/orchestrator/pipeline.ts:70-84`):

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

`finalizePipelineRun` returns exactly `{ success, spec, completedSprints, failedSprints, duration }`
(`src/orchestrator/finalize.ts:262-268`) — so `totalCost` and `needsClarification` are the
only two PgeEngine may add on top, and `runTsPipeline` does not set `totalCost` either.
**Rule:** return the object `commit.finalize()` gives you; do not synthesise a
`PipelineResult` by hand.

### What `TsPipelineEngine.run` does end to end
`TsPipelineEngine.run` → `runTsPipeline(userPrompt, projectRoot, config, opts)`
(`src/orchestrator/workflow/ts-engine.ts:22`; body at `src/orchestrator/pipeline.ts:744`).
In order: `startTime = Date.now()` (`pipeline.ts:750`) → `setupInterruptHandler()` (751) →
`pipelineRunId = opts?.runId ?? \`run-${Date.now()}\`` (756) → `ensureBoberDir` (765) →
`appendHistory({event:"pipeline-start"})` (767) → research/architect/plan phases →
per-sprint loop writing `updateContract` (179, 377, 391, 428, 495, 538, 563, 690, 715),
`appendHistory` at each transition, `persistEvalResult` (463) → **`finalizePipelineRun`**.

**Rule:** PgeEngine must call `commit.finalize(result.state, ctx)` after the interpreter
loop — exactly as `src/pge/runtime/__fixtures__/run-harness.ts:353-361` does — because
that is the third and only sanctioned caller of `finalizePipelineRun`
(`src/pge/runtime/commit.ts:442-448`).

### The downgrade log line to mirror
**Source:** `src/orchestrator/workflow/selector.ts:24-27` (one `logger.info`, never a
throw). The equivalent belt-and-suspenders precedent inside an engine's own `run` is
`WorkflowEngine` catching `WorkflowUnavailableError` — described at `selector.ts:70-74`.
**Rule:** catch `TopologyCompileError` in `PgeEngine.run`, `logger.info` ONE line, then
`return new TsPipelineEngine().run(userPrompt, projectRoot, config, opts)`.

### Composing a RunContext (the real thing, unadapted)
**Source:** `src/pge/runtime/__fixtures__/run-harness.ts:311-341`

```ts
  const ctx: RunContext = {
    runId, projectRoot, config, clock,
    signal: options.signal ?? new AbortController().signal,
    trace, scheduler,
    ledger: createBudgetLedger(),
    commit,
    planner: createFrontierPlanner(),
    services: {
      effects: createEffectRegistry(),
      scratch: createScratchStore(projectRoot),
      archive: createArchiveWriter(projectRoot),
      cache: createSemanticCache(projectRoot, runId),
      prompts: stubPromptStore(),
      models: createModelBinder({ light: {…}, frontier: {…} }),
    },
    …
  };
  const interpreter = createGraphInterpreter();
  result = await interpreter.run(graph, goldenInitialState(runId, projectRoot), ctx);
```

`RunContext` is declared at `src/pge/runtime/interpreter.ts:248-298`; `NodeServices` at
`interpreter.ts:239-246`; `GraphRunResult` (a 3-arm union: `completed` | `aborted` |
`interrupted`) at `interpreter.ts:319-352`; `GraphInterpreter` at `interpreter.ts:355-370`.
Initial state: `initialOverallState({runId, projectRoot, featureRequest})`
(`src/pge/state/overall.ts:295-313`).

**Rule:** PgeEngine composes these production factories directly. Do NOT import
`run-harness.ts` from production code — it is a fixture.

### Region composition today
**Source:** `src/pge/registry/index.ts:242-294` — four builders, each taking a PROJECTED
region spec:

```ts
export function researchRegistries(spec: TopologySpec, bindings: RegionBindings): Registries {
  return {
    nodes: regionNodeRegistry(spec, RESEARCH_REGION, bindings),
    reducers: createReducerRegistry(),
    effects: createResearchEffectRegistry(bindings),
    schemas: codingSchemaCatalog(),
  };
}
```

---

## 3. THE GAP — what a "full production registries" composition is missing

`sc-13-1` requires `loadCompiledGraph(projectRoot, "coding", fullRegistries)` to throw
neither `UnregisteredNodeImpl` nor `OrphanNodeImpl`. `compile()` is all-or-nothing in BOTH
directions (`src/pge/compile/compiler.ts:35-38`).

**The artifact has 44 nodes** (`.bober/topology/coding.json`, `graphId: "coding"`,
`entry: "research_body"`, 56 edges). **The four region registries collectively register 36.**

| Region | count | registered by |
|---|---|---|
| research | 8 | `registerResearchNodes` — `src/pge/nodes/research.ts:556-564` |
| plan | 6 | `registerPlanNodes` — `src/pge/nodes/plan.ts:470-476` |
| sprint | 17 | `registerSprintNodes` — `src/pge/registry/index.ts:194-216` |
| terminal | 3 | `registerTerminalNodes` — `src/pge/registry/index.ts:219-223` |
| root-shared | 2 | `supervisorNode` + `gracefulFailureNode` — `src/pge/registry/index.ts:181-182` |

### The eight nodes with NO implementation anywhere in the repo

Verified by grepping `src/pge/**` for each id: the only hits are in
`coding.graph.ts` (the authored artifact) and fixtures. **They must be written this sprint.**
Full declarations, read off `.bober/topology/coding.json`:

| id | kind | modelTier | inputPorts | outputPorts | reads | writes | effects | ref |
|---|---|---|---|---|---|---|---|---|
| `gate_eval_in` | gate | — | none | none | branchStatus, evaluations | — | [] | `gate:{check:"all-sprints-settled", onFail:"graceful_failure"}` |
| `evaluate_global` | llm | frontier | none | `verdict: SprintVerdict` (required) | branchStatus, evaluations, spec | evaluations, ledger, messages | [] | `promptRef:"evaluator/global"` |
| `route_after_eval` | router | light | `verdict: SprintVerdict` (required) | none | counters, evaluations | counters | [] | targets: `exhausted→graceful_failure`, `partial→synthesize`, `pass→documenter`, `rework→critique` |
| `critique` | llm | frontier | none | none | evaluations, messages | ledger, messages | [] | `promptRef:"evaluator/critique"` |
| `rework_route` | router | light | none | none | branchStatus, counters | counters | [] | `loop:{counterKey:"reworkRounds", maxIterations:2, onExhausted:"graceful_failure"}`; targets `exhausted→graceful_failure`, `rework→sprint_body` |
| `synthesize` | llm | frontier | none | none | branchStatus, evaluations, messages | ledger, messages | [] | `promptRef:"synthesizer/partial"` |
| `context_compact` | tool | — | none | none | messages, refs | counters, messages, refs | ["fs-write"] | `toolRef:"context.compact"` |
| `finalize` | tool | — | none | none | branchStatus, evaluations, ledger | refs, verdict | ["fs-write"] | `toolRef:"run.finalize"`; doc: "Emits the terminal artifacts, the pipeline-complete history event and the completion marker. Sole writer of the scalar verdict channel." |

**Two of the eight already have a shipped engine to wrap rather than invent:**
- `context_compact` → `compactGraphContext` (`src/pge/runtime/compactor.ts:350`), which
  already stamps `nodeId: "context_compact"` on its summary message
  (`compactor.ts:409`).
- `synthesize` → `synthesizeBranchOutcomes` (`src/pge/runtime/graceful-failure.ts:193`),
  built on the pure `synthesize` from `src/orchestrator/workflow/synthesizer.ts`.

`finalize`'s doc says it emits the pipeline-complete event — but
`CommitBoundary.finalize` is the single owner (`commit.ts:442-448`,
`src/orchestrator/finalize.ts:1-33`). **Do not put `finalizePipelineRun` inside a node
body.** See §9.

### What the composition must supply (`RegionBindings`)

`RegionBindings` (`src/pge/registry/index.ts:102-144`) extends `ResearchBindings`,
`PlanBindings`, `Partial<SprintBindings>`, `TerminalBindings`. The REQUIRED members —
everything else defaults to the shipped agent:

| binding | type | declared at | why required |
|---|---|---|---|
| `reflect` | `Reflector = (req, ctx) => Promise<unknown>` | `src/pge/nodes/effects.ts:164`, iface `:444-451` | nothing in the repo emits a `ProblemReflection` |
| `critique` | `Critic = (req, ctx) => Promise<CritiqueResponse>` | `effects.ts:238` | ditto |
| `explain` | `Explainer = (req, ctx) => Promise<ExplainResponse>` | `effects.ts:618`, `SprintBindings` `:990-1000` | no shipped per-test explainer; `sprintRegistries` throws without it (`registry/index.ts:269-273`) |
| `mocks` | `MockCurator = (req, ctx) => Promise<MocksResponse>` | `effects.ts:667` | no shipped mock manifest producer |
| `runtime` | `SprintRuntime = { sandbox, scratch, trace }` | `src/pge/nodes/verification.ts:63-67` | `requireRuntime` throws without it (`registry/index.ts:225-232`) |

Optional-but-defaulted: `research`→`runResearch`, `planner`→`runPlanner`,
`materialize`→`materializeContracts`, `curator`/`generator`/`security`/`evaluator`/
`reviewer`→the five shipped agents, `documenter`→`runDocumenter`,
`committer`→`commitAll` (`effects.ts:956-959`), `writeContract`, `writeResearch`,
`listResearch`, `writeFailure`.

### Two hard mechanical constraints on a full composition

1. **`createNodeRegistry` throws `DuplicateNodeImplError` on a repeat id**
   (`src/pge/registry/nodes.ts:274`, thrown at `:297`). `regionNodeRegistry` registers
   `supervisorNode` + `gracefulFailureNode` into EVERY region
   (`registry/index.ts:181-182`), so you cannot merge four region registries — build ONE
   registry and register each of the 44 impls exactly once.
2. **`createEffectRegistry.register` throws `DuplicateEffectError`**
   (`src/pge/registry/effects.ts:136`). `gracefulFailureEffect` is registered by all four
   `create*EffectRegistry` builders (`effects.ts:459, 473, 1012, 1026`). Same rule: ONE
   registry, each `*Effect(...)` factory called once. Every factory is individually
   exported from `src/pge/nodes/effects.ts`.

Suggested shape — a new export beside the four builders in `src/pge/registry/index.ts`:

```ts
export function codingRegistries(spec: TopologySpec, bindings: RegionBindings): Registries
```
that registers research + plan + sprint + terminal + supervisor + gracefulFailure + the
eight root nodes, one effect registry, `createReducerRegistry()`, `codingSchemaCatalog()`.
`schemas` (a `SchemaCatalog`) not `schemaModules` — the reasoning is written out at
`src/pge/registry/index.ts:57-77` and still holds.

**`loadCompiledGraph(projectRoot, graphId, reg)`** (`src/pge/compile/compiler.ts:641-675`)
reads `topologyArtifactPath(projectRoot, graphId)` =
`<projectRoot>/.bober/topology/<graphId>.json` (`src/pge/topology/dump.ts:26-28`), runs
`validateTopology(raw, {mode:"structural"})`, then `compile(spec, reg)`.
**A temp project root has no artifact** — a test must copy
`.bober/topology/coding.json` into the temp root first, or `readTopologyArtifact` returns
`{ok:false, reason:"missing"}` and `loadCompiledGraph` throws `TopologyCompileError`
(`compiler.ts:645-657`) — which is a downgrade, not a compile proof.

---

## 4. The eleven conformance artifacts: where they live and who reads them

**This is the highest-value table in the briefing. Six of the eleven have a real reader;
three do not; two are not files at all.**

| # | field | on-disk path | EXISTING reader (verified) | producer in the TS path |
|---|---|---|---|---|
| 1 | `contracts` | `.bober/contracts/*.json` | `listContracts(projectRoot): Promise<SprintContract[]>` — `src/state/sprint-state.ts:113`; re-exported `src/state/index.ts:7` | `updateContract` — `pipeline.ts:179,377,391,428,…` |
| 2 | `history` | `.bober/history.jsonl` | `loadHistory(projectRoot)` — `src/state/history.ts` (re-exported `src/state/index.ts:28`) | `appendHistory` throughout `pipeline.ts` + `finalize.ts:238` |
| 3 | `specs` | `.bober/specs/*.json` | `listSpecs(projectRoot): Promise<PlanSpec[]>` — `src/state/plan-state.ts:106`; re-exported `src/state/index.ts:16` | `saveSpec` |
| 4 | `evalResults` | `.bober/eval-results/eval-<contractId>-<iteration>.json` | **`loadEvalResults(projectRoot)` — `src/orchestrator/memory/eval-source.ts:70`** (only caller today: `src/cli/commands/memory.ts:33,78`). Lenient reader. | `persistEvalResult` — `src/orchestrator/eval-persist.ts:32`, called `pipeline.ts:463` |
| 5 | `briefings` | `.bober/briefings/<contractId>-briefing.md` | `listBriefings(projectRoot): Promise<string[]>` (returns contract IDs, not content) — `src/state/briefing-state.ts:51`; content via `readBriefing` — `:35` | the curator agent — `src/orchestrator/curator-agent.ts:148-153` |
| 6 | `reviews` | `.bober/reviews/…` | `listReviews(projectRoot): Promise<string[]>` — `src/state/review-state.ts:51`; content via `readReview` — `:35` | `saveReview` — `src/orchestrator/code-reviewer-agent.ts:168` |
| 7 | `audits` | `.bober/audits/<runId>.jsonl` | **NO READER EXISTS.** Only a path helper: `getAuditPath(projectRoot, runId)` — `src/orchestrator/checkpoints/audit.ts:74`. You must `readFile` + split lines + parse against `ApprovalRecord` (`audit.ts:54`). | `runWithAudit` — `audit.ts:275`, called from `pipeline.ts:219,346,417,589,670` and `finalize.ts:249` |
| 8 | `progress` | `.bober/progress.md` | **NO READER EXISTS.** Plain `readFile`. | `updateProgress` — `src/state/history.ts:157`. **ONLY caller in the repo is `src/orchestrator/workflow/flusher.ts:83`** — `runTsPipeline` never writes it. |
| 9 | `runState` | `.bober/runs/<runId>/state.json` | `listRunStateFiles(projectRoot): Promise<RunState[]>` — `src/state/run-state.ts:78`; alias `readRunStatesFromDisk` — `:110`; single: `readRunState(projectRoot, runId)` — `:61` | `writeRunState` — only from `src/mcp/run-manager.ts:139,200,221,236,267`, i.e. the MCP path, not `runTsPipeline` |
| 10 | `completionMarker` | `.bober/runs/<runId>.completed.json` | **NO GENERAL READER.** Path: `completionMarkerPath(projectRoot, runId)` — `src/orchestrator/finalize.ts:71`; suffix constant `COMPLETION_MARKER_SUFFIX` — `finalize.ts:63`. The only consumer is the private `findUnseenMarkerRunId` in `src/chat/completion-tailer.ts:62-100`. | `writeCompletionMarker` — `finalize.ts:136` |
| 11 | `pipelineResult` | **not a file** | the value `PipelineEngine.run` returns | `finalizePipelineRun` — `finalize.ts:262-268` |

**Consequences you must design around (evaluatorNotes: "verify the eleven fields are all
populated for both engines rather than empty on both sides, which would make equivalence
vacuous"):**

- `progress` is written by the WORKFLOW flusher only. On a ts-vs-pge comparison it is
  empty on both sides unless one of the engines starts writing it. Either wire
  `updateProgress` into both paths, or record it explicitly as a KNOWN-EMPTY field in the
  report rather than counting it as an equivalence.
- `runState` is MCP-owned; same caveat.
- `.bober/progress.md` is MARKDOWN, so `VOLATILE_KEYS` cannot touch it. It carries
  `Last updated: ${new Date().toISOString()}` at `src/state/history.ts:169` — normalise it
  by dropping that line, **not** by adding a key to `VOLATILE_KEYS`.
- `completionMarker` embeds `completedAt: new Date().toISOString()` and `duration`
  (`finalize.ts:144-148`) — `completedAt` and `duration` are already in `VOLATILE_KEYS`.
  `runId` is too, which is exactly right: the two engines run under different run ids.
- `audits` records carry `durationMs` (`audit.ts:69`) and `approverId` (`:57`).
  `durationMs` is NOT in `VOLATILE_KEYS`. If you add it, name it in the report and justify
  it: elapsed wall time between two runs is genuinely non-deterministic. `approverId` is
  resolved from environment (`resolveApproverId` — `audit.ts:166`) and is genuinely
  machine-dependent; adding it is defensible, hiding an engine-specific approver is not.

---

## 5. The `Span` record, and what a replay actually needs

**Source:** `src/pge/runtime/trace.ts:63-111`

```ts
export const SpanSchema = z.object({
  runId, spanId, parentSpanId: nullable, superstep, nodeId, branchKey,
  kind: NodeKindSchema, phase: PhaseSchema, startedAt, endedAt,
  inputHash: z.string(), outputHash: z.string(),
  model: z.object({ tier: z.enum(["light","frontier"]), provider, modelId }).optional(),
  tokens: z.object({ in: int, out: int }).optional(),
  costUsd: z.number().min(0).optional(),
  cache: SpanCacheSchema.optional(),
  toolOutputRef: ScratchRefSchema.optional(),
  archiveDir: z.string().optional(),
  route: z.object({ label: optional, goto: GotoSchema }).optional(),
  failClosed: boolean.optional(), status: SpanStatusSchema, errorClass: optional,
  serializedReason: optional, blockedBy: array(string).optional(),
  privKeys: array(string).optional(),
});
```
Writer: `createTraceWriter(projectRoot, runId, { now?, newSpanId? })` — `trace.ts:237`
(injectable clock and span-id source). Reader: `readSpans(path)` — `trace.ts:328`.
Path: `tracePath(projectRoot, runId)` = `.bober/traces/<runId>.jsonl` — `trace.ts:198`.
Tree: `buildSpanTree(spans)` — `trace.ts:371`.

### THE REPLAY GAP — read this before designing `replay.ts`

Every one of `trace.begin({...})`'s SEVEN call sites in the interpreter passes only
`nodeId, kind, phase, branchKey, superstep[, inputHash]` — verified at
`src/pge/runtime/interpreter.ts:890, 1016, 1065, 1127, 1165, 1198, 1645`.
**Nothing in the shipped runtime ever sets `model`, `tokens`, `costUsd`,
`toolOutputRef`, `parentSpanId` or a real `outputHash`** — `outputHash` is set to
`task.taskKey` (`interpreter.ts:1175, 1346`), which is a task identity, not a payload
digest.

The archive is lazy and **no production node body writes to it** (grep for `ctx.archive`
across `src/pge/nodes/*.ts` → zero hits; the lazy handle is `interpreter.ts:660-687`), so
`.bober/archive/<runId>/<nodeId>/outputs.json` does not exist after a real run either.

**Therefore: "the recorded provider responses in the span file" do not exist yet.**
sc-13-6 requires you to ADD the recording. The two seams that already exist and cost
nothing structurally:

1. **Wrap `EffectRegistry`.** Every outward call goes through `ctx.effects.invoke(name, req, ctx)`
   (`src/pge/registry/effects.ts:140-157`) — that invariant is the whole point of
   `src/pge/nodes/effects.ts` (see its header at `:41-53`). A recording decorator around
   `invoke` gives you request+response keyed by `(nodeId, branchKey, callIndex)`.
2. **Store the payload in scratch and put the `ScratchRef` on the span.** `Span.toolOutputRef`
   is already `ScratchRefSchema.optional()` and `SpanEnd` already accepts it
   (`trace.ts:119-136`) — you would be filling a field the schema reserved, not widening it.
   `ScratchStore.put/get/text` — `src/pge/runtime/scratch.ts:281,311`.

**generatorNotes are explicit:** the replay's network stub must **throw**, never return a
canned value, so a missed recording surfaces as a failure. `createEffectRegistry()` already
throws `EffectNotRegisteredError` for an unknown name (`effects.ts:145`) — a replay
registry that resolves only recorded `(node, callIndex)` pairs and throws otherwise gets
this for free.

**sc-13-8 (`zero frontier-tier calls from routing/classification/syntax nodes`) has the
same gap**: `span.model` is never written. Fill it at `trace.begin` from
`ctx.services.models.bind(node.spec.modelTier)` (`ModelBinder` — `src/pge/registry/nodes.ts:143-146`).
The artifact's own tiers (evaluatorNotes: map from the artifact, not a hardcoded list):
every `router` is `light` (`supervisor`, `fanout_sprints`, `plan_clarify_check`,
`research_route`, `rework_route`, `route_after_eval`, `sprint_route`); every `gate` and
`tool` declares NO `modelTier` at all — including `gate_syntax`, `gate_mock_coverage`,
`gate_anchor_regression`. Frontier is declared by 13 `llm` nodes only.

---

## 6. Testing Patterns

**Runner:** Vitest. **Assertions:** `expect`. **Mocks:** `vi.mock` / `vi.hoisted`.
**Naming:** co-located `<module>.test.ts`; cross-cutting invariants under
`src/pge/runtime/__tests__/*.invariant.test.ts`. Fixtures under `__fixtures__/`.
**Run only your own files:** `npx vitest run <path> [<path>…]`.

### Temp project root — the house pattern
**Source:** `src/orchestrator/workflow/conformance.test.ts:137-156`

```ts
let tmpRoots: string[] = [];
beforeEach(() => { vi.clearAllMocks(); tmpRoots = []; });
afterEach(async () => {
  await Promise.all(tmpRoots.map((r) => rm(r, { recursive: true, force: true })));
  tmpRoots = [];
});
async function mkTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bober-conformance-test-"));
  tmpRoots.push(dir);
  return dir;
}
```
Same idiom with TWO roots for the isolation claim: `src/pge/runtime/isolation.test.ts:35-47`
(`rootA`/`rootB`, plus `restoreWritableTree(rootA)` before `rm` because the archive seals
files read-only). **That file is the template for sc-13-10** — its `walk(dir)` helper
(`isolation.test.ts:49-60`) enumerates every path under a root, which is how you assert
"zero writes under the original root".

### Fixed / monotonic clock injection
**Source:** `src/pge/runtime/__fixtures__/run-harness.ts:55-67`

```ts
export function createMonotonicClock(startIso = "2026-08-05T00:00:00.000Z", stepMs = 1): Clock {
  let cursor = new Date(startIso).getTime();
  const tick = (): number => { const current = cursor; cursor += stepMs; return current; };
  return { now: () => new Date(tick()), nowMs: () => tick(), nowIso: () => new Date(tick()).toISOString() };
}
```
A truly frozen clock ships in production code: `createFixedClock(iso)` —
`src/pge/runtime/commit.ts:246-253`. The clock reaches the trace writer via
`createTraceWriter(projectRoot, runId, { now: () => clock.now() })`
(`run-harness.ts:305`). **`finalizePipelineRun` calls `new Date()` and `Date.now()`
directly (`finalize.ts:225, 239`) and takes no clock** — its timestamps are volatile by
construction and are already covered by `VOLATILE_KEYS`.

### Real git repo fixture (the terminal region commits)
**Source:** `src/pge/runtime/__fixtures__/temp-repo.ts:30-37` —
`initTempRepo(cwd)` (`git init --initial-branch=main`, identity, one empty root commit),
plus `headSha`, `commitSubjects`, `commitFiles`, `commitCount` (`:40-71`). Every function
takes an explicit `cwd`; there is no default — deliberately, so no test can create a git
object in this checkout (`temp-repo.ts:22-27`).

### Full-region run harnesses (compose the SHIPPED nodes, unadapted)
- `runRegion(options)` — `src/pge/nodes/__fixtures__/region-harness.ts:391-468`
  (research + plan regions of the committed artifact).
- `runSprint(options)` — `src/pge/nodes/__fixtures__/sprint-harness.ts:410`, which builds
  the real `SprintRuntime` at `:421-435` (`createSandboxRunner(projectRoot, runId, trace)`).
- Ready-made binding stubs: `stubSprintBindings` (`sprint-harness.ts:552-572`) and
  `stubTerminalBindings` (`sprint-harness.ts:582-593`). **`stubTerminalBindings` leaves
  `committer` unbound on purpose so it resolves to the shipped `commitAll`**
  (`sprint-harness.ts:574-580`).
- Instruments to reuse rather than re-invent: `countingReducerRegistry`,
  `countingArtifactWriter`, `countingNodeRegistry`, `RecordingScheduler`
  (`run-harness.ts:85-203`); `enteredNodes`, `routesOf`, `registeredIds`
  (`sprint-harness.ts:596-613`).

### How the existing selector tests assert the downgrade line
**Source:** `src/orchestrator/workflow/selector.test.ts:3-5, 120-129`

```ts
vi.mock("../../utils/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));
…
    vi.clearAllMocks();
    resolveEngineName(config);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.info).mock.calls[0]![0]).toContain("'pge'");
```
Copy this exactly for sc-13-4's "exactly one downgrade line" assertion — count the calls,
then assert on `mock.calls[0][0]`.

### Default-config assertion (sc-13-5 — evaluatorNotes: real shipped config, not a fixture)
**Source:** `src/orchestrator/workflow/selector.test.ts:107-110`

```ts
  it("pipeline.engine still defaults to 'ts' (sc-4-2)", () => {
    expect(PipelineSectionSchema.parse({}).engine).toBe("ts");
    expect(createDefaultConfig("test", "brownfield").pipeline.engine).toBe("ts");
  });
```
`createDefaultConfig` is the shipped default; the enum default is
`src/config/schema.ts:365` (`engine: z.enum([...PIPELINE_ENGINE_NAMES]).default("ts")`).
The repo's own `bober.config.json` carries no `pipeline.engine` key at all — the default
is what applies.

### E2E test pattern
There is no Playwright config in this repo. The end-to-end assertion sc-13-3 asks for is a
Vitest test that runs the engine against a temp root and then polls the real tailer:
`new CompletionTailer(projectRoot, sessionId).poll()` —
`src/chat/completion-tailer.ts:104-127`. It resolves the runId from the marker when the
history line omits it (`completion-tailer.ts:62-100`), which is exactly the ordering
`finalizePipelineRun` guarantees (`finalize.ts:21-33`).

---

## 7. Impact Analysis — affected files, features and tests

### Files that may break

| File | depends on | risk | what to check |
|---|---|---|---|
| `src/orchestrator/pipeline.ts:1092` | `selectPipelineEngineForTeam` | **high** | `runPipeline` is the single production selector call site; a new engine class must satisfy the same `PipelineEngine` shape and return a real `PipelineResult` |
| `src/orchestrator/workflow/selector.test.ts` | `selector.ts` | **high** | four assertions pin `'pge' → TsPipelineEngine` — see below |
| `src/config/schema.ts:364` | the reserved-name docstring | low | the comment says "'pge' is reserved and downgrades to 'ts' until a PgeEngine exists" — now false |
| `src/orchestrator/workflow/engine.ts:14-17` | same docstring | low | ditto |
| `src/orchestrator/workflow/types.ts:58-65` | `ConformanceReport.artifact` union | **high** | widening from 4 to 11 artifact names; `conformance.ts` is its only consumer |
| `src/pge/eslint-boundary.test.ts:57` | `"../engine/pge-engine.js"` path probe | medium | file must be created at exactly that path |
| `src/pge/zero-execution.test.ts:100-101` | statically imports `../cli/commands/pge.js` | medium | it does NOT import `src/cli/index.ts`, so registering a `trace` command is safe — but **never** re-point a `bober pge` import at `src/pge/registry/index.js` (that barrel pulls `runResearch`/`runPlanner`; the rule is written at `src/pge/registry/index.ts:45-55`) |
| `src/cli/index.ts` | command registration | low | add one `registerTraceCommand(program)` beside `registerPgeCommand(program)` at `:284` |

### Existing tests that must still pass — and the four that must be RE-POINTED

`src/orchestrator/workflow/selector.test.ts` currently asserts the OLD contract:

- `:131-135` — "never instantiates a PgeEngine — selection lands on TsPipelineEngine":
  `expect(selectPipelineEngine(makeConfig({engine:"pge"}))).toBeInstanceOf(TsPipelineEngine)`.
- `:120-129` — `resolveEngineName(makeConfig({engine:"pge"}))` must be `"ts"` with one log line.
- `:137-143` — a team whose `pipelineShape` is `"pge"` downgrades to `TsPipelineEngine`.
- `:145-149` — the `'pge'` path does not consult `isWorkflowEligible`.

Sprint 13 deliberately MOVES the downgrade from selection time to `PgeEngine.run`
(sc-13-4). **Re-pointing these four to the new contract is a behaviour change, not a
weakening** — the new assertions must be at least as strong: `resolveEngineName` returns
`"pge"`, `selectPipelineEngine` returns a `PgeEngine` whose `.name === "pge"`, and the
single downgrade line now comes out of `PgeEngine.run` on a `TopologyCompileError`.
Keep `:145-149` (still true — the pge path must not consult workflow eligibility).
Do **not** delete `:107-110` (`sc-4-2`, the default is still `'ts'`); it is sc-13-5's oracle.

Other suites that exercise the touched surface and must stay green:
- `src/orchestrator/workflow/conformance.test.ts` (329 lines) — all six cases.
- `src/orchestrator/finalize.test.ts` and `src/orchestrator/finalize.e2e.test.ts` — pin the
  emission ORDER (marker → history → checkpoint), `finalize.ts:184-189`.
- `src/pge/topology-invariants.test.ts` — A1-A4, B1-B3; especially B2
  (`:174-243`), which asserts no non-HITL node throws `UngatedEffectError` and that a
  `git`-effect node is still refused without a recorded approval.
- `src/pge/zero-execution.test.ts`, `src/pge/eslint-boundary.test.ts`,
  `src/pge/lint-boundary.test.ts` — the ADR-2 module boundary.
- `src/pge/runtime/isolation.test.ts` — no module-level singletons (sc-13-10's ancestor).
- `src/pge/runtime/__tests__/*.invariant.test.ts` (10 files) — determinism, exactly-once,
  durability, barrier, admission, cross-process resume, state isolation, engram.
- `src/pge/compile/compiler.test.ts`, `compilerFidelity.test.ts` — both-directions compile.
- `src/chat/completion-tailer` consumers via `ChatSession.handleTurn`.

### Features that could be affected
- **`bober run` / MCP RunManager / worktree runner / fleet children / chat-spawned runs** —
  all funnel through `runPipeline` (`pipeline.ts:1073-1093`). Default stays `'ts'`, so
  they must be byte-identical; assert that by leaving `createDefaultConfig(...).pipeline.engine === "ts"` green.
- **Team routing** — `resolveEngineNameForTeam(team, config)` uses
  `team.pipelineShape`; a team declaring `"pge"` now gets `PgeEngine`.
- **Checkpoint/approval subsystem** — `hitl_commit` declares `checkpointId:"end-of-pipeline"`
  and `plan_clarify` declares `"post-plan"` (both legal; fixed in commit `8cd2066`). That
  commit's own follow-up note is now yours: *"end-of-pipeline now names a moment before
  commit in the graph and after commit in the imperative pipeline… ts-vs-pge conformance in
  sprint 13 will have to reconcile the two."*

### Recommended regression checks
1. `npx vitest run src/orchestrator/workflow/selector.test.ts src/orchestrator/workflow/conformance.test.ts`
2. `npx vitest run src/pge/topology-invariants.test.ts src/pge/zero-execution.test.ts src/pge/eslint-boundary.test.ts src/pge/lint-boundary.test.ts`
3. `npx vitest run src/pge/compile/ src/pge/registry/ src/pge/runtime/__tests__/`
4. `npx vitest run src/orchestrator/finalize.test.ts src/orchestrator/finalize.e2e.test.ts`
5. `npm run typecheck && npm run typecheck:tests && npm run lint && npm run build`
6. `git status --porcelain` must show **no** modification to `.bober/topology/coding.json`
   or `.bober/topology/state-audit.json`.

---

## 8. Implementation Sequence (dependency-ordered) and the four-scope ordering

**Scope A blocks B; B blocks C's real runners and D's recordings. C's harness widening and
D's OTLP converter can start in parallel because they touch no shared symbol.**

1. **`src/pge/nodes/` — the eight missing node implementations** (§3 table).
   Follow `src/pge/nodes/gates.ts` for gates/routers and `src/pge/nodes/plan.ts` for llm/tool
   bodies; bind ports with `portOf(node, "input"|"output")` and `nodeSpecOf(spec, id)` from
   `src/pge/nodes/gates.ts`.
   - Verify: each new `NodeImpl.id`/`kind`/port `schemaRef` matches the artifact row exactly.
2. **`src/pge/registry/index.ts` — `codingRegistries(spec, bindings)`.**
   ONE `NodeRegistry` (44 ids), ONE `EffectRegistry` (each `*Effect` factory once),
   `createReducerRegistry()`, `codingSchemaCatalog()`.
   - Verify: `loadCompiledGraph(tmpRoot, "coding", codingRegistries(...))` resolves with
     **zero** diagnostics — assert `TopologyCompileError.has("UnregisteredNodeImpl") === false`
     and `.has("OrphanNodeImpl") === false` by letting it NOT throw, and cross-check
     `[...graph.nodes.keys()].length === 44`.
3. **`src/pge/engine/pge-engine.ts`.** Compose the RunContext (§2), run the interpreter,
   then `commit.finalize(result.state, {runId, projectRoot, config, superstep, startedAtMs})`.
   Catch `TopologyCompileError` → one `logger.info` → `new TsPipelineEngine().run(...)`.
   Propagate `BudgetExceededError` (`src/orchestrator/workflow/budget.ts:29-38`, re-exported
   `src/pge/runtime/ledger.ts:44`) as a typed abort, not a string.
   - Verify: `PgeEngine.name === "pge"`; a forced compile failure returns a `PipelineResult`
     structurally identical to a direct `TsPipelineEngine().run(...)` for the same input.
4. **`src/orchestrator/workflow/selector.ts`.** Delete `downgradeReservedEngine`
   (`:20-28`) and its two call sites (`:48-49`, `:116-117`); replace both `case "pge"`
   arms (`:94-98`, `:158-161`) with `return new PgeEngine();`. Update the resolution-branch
   docstrings at `:32-44` and `:103-108`.
   - Verify: `resolveEngineName({pipeline:{engine:"pge"}}) === "pge"` and no log line fires
     at selection time.
5. **`src/orchestrator/workflow/types.ts` + `conformance.ts`.** Widen the `artifact` union
   to the eleven names; replace the two-field record with the eleven-field one; add the
   order-tolerant comparator; add a `runnerFor` that returns real engine runners
   (`(root) => { await engine.run(prompt, root, config, {runId: FIXED}) }`) with a
   deterministic client, `createFixedClock`, and a fixed run id.
   - Verify: two engines, two FRESH roots (`projectRootFactory` is called once per engine —
     `conformance.ts:92`), and each of the eleven fields non-empty on both sides or
     explicitly recorded as known-empty.
6. **Trace instrumentation** — `span.model` from the node's declared `modelTier` via
   `ctx.services.models.bind(...)`; recording effect decorator + `toolOutputRef`.
   - Verify: a pge run's spans carry `model.tier` for every `llm`/`router` node and none for
     `gate`/`tool`/`subgraph`; sc-13-8 maps span→node kind from `graph.spec.nodes`.
7. **`src/pge/runtime/replay.ts`.** Read `.bober/traces/<runId>.jsonl` with `readSpans`,
   rebuild an effect registry that resolves ONLY recorded responses and THROWS otherwise,
   re-run the interpreter against a fresh root, then compare with the conformance
   comparator after volatile stripping.
   - Verify: deleting one recorded response makes the replay FAIL rather than degrade.
8. **`src/pge/runtime/otlp-exporter.ts`.** Pure `Span[] → OTLP payload` converter plus a
   guarded emit. **Zero network calls when unconfigured** — assert by stubbing
   `globalThis.fetch` with a throwing spy, exactly as `src/pge/zero-execution.test.ts:154-159`
   does, and asserting `expect(fetchSpy).not.toHaveBeenCalled()`.
9. **`src/cli/commands/trace.ts` + `src/cli/index.ts`.** `bober trace replay <runId>`,
   injected `TraceIo`, exit codes 0/1/2, no `process.exit`.
10. **Full verification** — `npm run typecheck`, `npm run typecheck:tests`,
    `npm run build`, `npm run lint`, then the targeted vitest runs from §7.

---

## 9. Pitfalls & Warnings

- **The supervisor cannot drive the full graph today.** `supervisorNode`
  (`src/pge/nodes/supervisor.ts:75-122`) selects exactly ONE label — `plan` — and otherwise
  returns `endGoto` (`{kind:"node", node:"END"}`). Its guard is
  `needsPlan(state) = state.spec === null || !isPipelineReady(state.spec)`
  (`supervisor.ts:71-73`). The artifact declares four supervisor targets
  (`compact→context_compact`, `evaluate→gate_eval_in`, `plan→gate_plan_in`,
  `sprints→fanout_sprints`). **A full-graph run therefore terminates right after the plan
  region unless the supervisor learns to dispatch `sprints` and `evaluate`.** This is not
  optional for sc-13-2/sc-13-3 — an eleven-field equivalence against a run that never
  produced a sprint is vacuous.
- **`finalize` is unreachable under the default config.** `commit` declares
  `effects:["git"]`, and `src/pge/topology-invariants.test.ts:213-243` proves that under
  autopilot every git-effect node is refused `FAIL_CLOSED` with its body never entered. The
  only edge into `finalize` is `e-commit-finalize` (`commit → finalize`). So PgeEngine must
  call `CommitBoundary.finalize` itself after the loop — as
  `run-harness.ts:353-361` does — and the `finalize` NODE must not duplicate it.
  **Never call `finalizePipelineRun` from a node body**: it is the single owner
  (`src/orchestrator/finalize.ts:1-33`), and a second emitter is exactly the defect the
  ordering comment there describes.
- **`VOLATILE_KEYS` is the sprint's worst failure mode.** Hard rule 5. Every key you add
  must be named and justified in your report. `durationMs` (audits) and `approverId`
  (audits) are the only two with a legitimate case. `phase`, `event`, `status`, `verdict`,
  `success` are engine-observable facts — adding any of them hides a real divergence.
- **`.bober/progress.md` is markdown.** `normalize()` only walks objects
  (`conformance.ts:34-51`). Strip the `Last updated:` line (`src/state/history.ts:169`)
  textually; do not reach for `VOLATILE_KEYS`.
- **A temp project root has no topology artifact.** Copy `.bober/topology/coding.json`
  into the root before calling `loadCompiledGraph`, or you will be testing the missing-file
  branch (`compiler.ts:645-657`) and calling it a downgrade proof.
- **Do not merge region registries.** `DuplicateNodeImplError`
  (`src/pge/registry/nodes.ts:297`) and `DuplicateEffectError`
  (`src/pge/registry/effects.ts:136`) both fire on the shared `supervisor`,
  `graceful_failure` and `gracefulFailureEffect`.
- **`compile()` fails in BOTH directions.** One extra registered impl is `OrphanNodeImpl`,
  exactly as fatal as a missing one (`compiler.ts:35-38`).
- **ESM: every relative import needs the `.js` extension.** TypeScript strict, `tsc` build.
- **`src/pge/topology/**` may not import `src/pge/engine/**`** — `eslint.config.js:124-128`.
  Put nothing engine-shaped under the topology subtree.
- **`src/pge/nodes/**` may not spawn a process** — `eslint.config.js:266-294`; the only
  sanctioned route is `SandboxRunner` (`src/pge/runtime/sandbox.ts`). `execa` in test
  scaffolding lives at `src/pge/runtime/__fixtures__/temp-repo.ts` for exactly this reason.
- **Never touch `.bober/topology/coding.json` or `state-audit.json`.** A compile or
  conformance failure is evidence about the CODE. If the artifact is genuinely wrong, STOP
  and report (this is how commit `8cd2066` happened, and it was a separate, deliberate change).
- **The pre-authorised end state exists.** `stopConditions[4]`: if conformance does not
  converge, pge ships as a permanently opt-in engine, the default stays `'ts'`, nothing is
  deleted, and the divergences are RECORDED. Recording a divergence is a success; widening
  `VOLATILE_KEYS` to make it vanish is the failure.
- **Do not run the full Vitest suite** (hard rule 7) — it is noisy and other agents are
  editing other files concurrently. Run only your own paths.
