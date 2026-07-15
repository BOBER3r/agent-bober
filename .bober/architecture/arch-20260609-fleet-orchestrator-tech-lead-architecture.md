# Architecture: Fleet Orchestrator (Tech-Lead Orchestrator)

**Architecture ID:** arch-20260609-fleet-orchestrator-tech-lead
**Generated:** 2026-06-09T00:00:00Z
**Status:** draft

---

## Executive Summary

A fleet orchestrator layer sits above `runPipeline` (src/orchestrator/pipeline.ts:929) and builds a portfolio of N independent small projects in bulk by spawning one isolated `agent-bober run` child process per sub-project folder, targeting DeepSeek for cheap bulk work. The selected approach is a manifest-driven fleet that reads an author-supplied JSON manifest of `{folder, task, config?}`, scaffolds each subfolder via `createDefaultConfig()` plus DeepSeek overrides, fans out through the existing `mapBounded()` semaphore scheduler (src/orchestrator/workflow/scheduler.ts), and aggregates each child's outcome disk-primary from `.bober/runs/<runId>/state.json` with an exit-code fallback. The key tradeoff accepted is reusing tested concurrency and disk-state primitives at the cost of requiring an author-written manifest (no LLM decomposition), which keeps the scope minimal and deterministic. The primary risk is that `mapBounded` uses `Promise.all` (scheduler.ts:181), so the per-child thunk MUST capture every error as data and never reject — otherwise one child's failure aborts the entire batch, violating the per-child isolation constraint.

---

## Problem Statement

**Problem:** No layer exists above `runPipeline(task, projectRoot, config)` (src/orchestrator/pipeline.ts:929) to build a portfolio of N independent small projects in bulk; building each subfolder requires hand-authoring its `bober.config.json`, running `git init`, and invoking `agent-bober run` serially with no decomposition, no concurrency cap, and no aggregated report.

**Constraints:**
- Latency: not specified
- Throughput: HARD — bounded concurrency with a configurable cap N (default 3) via existing `mapBounded()` / `Semaphore` (src/orchestrator/workflow/scheduler.ts; true peak in-flight === cap; `defaultConcurrency()` = min(16, cores-2))
- Data volume: N small projects, each its own isolated `.bober/` tree (`RunState` → `.bober/runs/<runId>/state.json`); no database
- Cost ceiling: DeepSeek via openai-compat provider (src/providers/openai-compat.ts, factory.ts), requires `DEEPSEEK_API_KEY`; scaffolded child configs set DeepSeek across per-role provider fields
- Backward compatibility: HARD — `runPipeline` + `PipelineResult` shape, `runRunCommand`, and the `run` CLI contract (positional task plus `--provider`/`--mode`/`--checkpoint`) MUST NOT change; the orchestrator spawns the published `agent-bober` binary

**Consumers:** A developer (and `/bober-run`-style automation) invoking a new top-level `fleet` command; downstream this consumes the `agent-bober` CLI subprocess, each child's `.bober/` state, and one optional decomposition LLM call.

**Success Criteria:**
- brief → N `{folder, task}` entries → scaffold (mkdir + Zod-valid config + git init) → spawn one child per folder at peak concurrency ≤ N → read each child's `.bober/` outcome into one portfolio report
- Per-child failure isolation: one child's crash must not abort siblings
- Async fs + execa throughout; ESM with `.js` extensions, provider-agnostic design, and Zod config validation preserved

**Locked Dependencies:** `runPipeline` signature and `PipelineResult` shape; `runRunCommand` and the `run` CLI contract; the `mapBounded()` / `Semaphore` scheduler; the `RunState` disk layout under `.bober/runs/`; ESM/`.js`-extension imports; Zod config schema; execa for subprocesses; async fs only.

---

## System Overview

The fleet orchestrator is a thin coordination layer that treats the published `agent-bober` binary as a black box and never reaches into pipeline internals, preserving the locked `runPipeline` and `run` CLI contracts. A consumer invokes `agent-bober fleet <manifest.json>`; the entrypoint loads and Zod-validates the manifest, then hands the child list to a coordinator that fans them out through the existing `mapBounded()` semaphore so peak in-flight processes equal the configured cap (default 3). For each child, a scaffolder creates the folder, writes a `createDefaultConfig()`-derived config with DeepSeek overrides, and runs `git init`; a runner then spawns one `agent-bober run` child process in that folder via execa with `reject: false` and a per-child timeout.

Because `mapBounded` is built on `Promise.all` (scheduler.ts:181), isolation is enforced at the per-child thunk boundary — the thunk wraps scaffold-plus-spawn in try/catch and always resolves to a `ChildExecution`, capturing every error as data so a single failure cannot reject the batch. After all children exit, an aggregator reads each child's outcome disk-primary (newest `.bober/runs/<runId>/state.json` by `startedAt`, falling back to exit code when no state file exists), and a reporter writes a single point-in-time `PortfolioReport` to `.bober/fleet-report.json` via atomic temp-plus-rename. The parent process always exits 0; per-child outcomes live in the report, not the parent's exit code.

---

## Component Breakdown

### FleetManifest

**Responsibility:** Define and load the Zod-validated fleet manifest describing the portfolio to build.

**Interface:**
```typescript
interface FleetManifestLoader {
  load(manifestPath: string): Promise<FleetManifest>;
}

type FleetManifest = {
  rootDir: string;        // default "."
  concurrency: number;    // int >= 1, default 3
  children: ChildSpec[];
};

type ChildSpec = {
  folder: string;
  task: string;
  config?: Record<string, unknown>;  // optional per-child config overrides
};
```

**Dependencies:** []

---

### ChildScaffolder

**Responsibility:** Create one child's folder, write a Zod-valid DeepSeek config, and initialize git, capturing all failures as data.

**Interface:**
```typescript
interface ChildScaffolder {
  scaffold(rootDir: string, child: ChildSpec): Promise<ScaffoldResult>;
  buildChildConfig(child: ChildSpec): BoberConfig;  // createDefaultConfig() + DeepSeek overrides
}

type ScaffoldResult = {
  folder: string;
  absPath: string;
  configWritten: boolean;
  gitInitialized: boolean;
  error?: string;  // folder non-empty, EACCES, git init non-zero
};
```

**Dependencies:** [FleetManifest]

---

### ChildRunner

**Responsibility:** Spawn exactly one `agent-bober run` child process for a scaffolded folder and capture its result as data.

**Interface:**
```typescript
interface ChildRunner {
  run(spec: ChildRunSpec): Promise<ChildSpawnResult>;
  // execa(process.execPath, [cliEntry, "run", task], { cwd, reject: false, timeout })
}

type ChildRunSpec = {
  cwd: string;
  task: string;
  timeoutMs?: number;  // default ~10 min (ADR-5)
};

type ChildSpawnResult = {
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  spawnError?: string;
};
```

**Dependencies:** []

---

### FleetCoordinator

**Responsibility:** Fan children out through `mapBounded` at the configured cap, ensuring each per-child thunk always resolves.

**Interface:**
```typescript
interface FleetCoordinator {
  execute(manifest: FleetManifest): Promise<ChildExecution[]>;
  // wraps mapBounded(children, manifest.concurrency, perChildThunk)
}

type ChildExecution = {
  folder: string;
  scaffold: ScaffoldResult;
  spawn?: ChildSpawnResult;  // absent when scaffold.error skipped the spawn
};
```

**Dependencies:** [ChildScaffolder, ChildRunner, FleetManifest]

---

### OutcomeAggregator

**Responsibility:** Resolve each child's final status disk-primary from its newest `RunState`, falling back to exit code.

**Interface:**
```typescript
interface OutcomeAggregator {
  aggregate(execution: ChildExecution): Promise<ChildOutcome>;
  readRunStatesFromDisk(absPath: string): Promise<RunState | undefined>;  // newest by startedAt
}

type ChildOutcome = {
  folder: string;
  status: "completed" | "failed" | "other";
  source: "disk" | "exit-code";
  runId?: string;
  runState?: RunState;
  exitCode: number;
};
```

**Dependencies:** [FleetCoordinator]

---

### PortfolioReporter

**Responsibility:** Build the portfolio summary and atomically write it to `.bober/fleet-report.json`.

**Interface:**
```typescript
interface PortfolioReporter {
  build(outcomes: ChildOutcome[]): PortfolioReport;
  write(rootDir: string, report: PortfolioReport): Promise<string>;  // atomic temp + rename
}

type PortfolioReport = {
  total: number;
  completed: number;
  failed: number;
  other: number;
  children: ChildOutcome[];
  generatedAt: string;  // ISO-8601
};
```

**Dependencies:** [OutcomeAggregator]

---

### FleetEntrypoint

**Responsibility:** Expose `runFleet` and register the `fleet` CLI command, orchestrating the load → execute → aggregate → report flow.

**Interface:**
```typescript
interface FleetEntrypoint {
  runFleet(manifestPath: string, options?: RunFleetOptions): Promise<PortfolioReport>;
  registerFleetCommand(program: Command): void;  // mirrors registerWorktreeCommand in src/cli/index.ts
}

type RunFleetOptions = {
  concurrency?: number;
  rootDir?: string;
};
```

**Dependencies:** [FleetManifest, FleetCoordinator, OutcomeAggregator, PortfolioReporter]

---

## Data Model

Persistence is the filesystem only — no database. The fleet orchestrator writes exactly one new artifact (`PortfolioReport` → `.bober/fleet-report.json`); each child owns its own isolated `.bober/runs/<runId>/state.json` (`RunState`) written by the spawned pipeline.

```typescript
// Written by the fleet orchestrator (new)
type PortfolioReport = {
  total: number;
  completed: number;
  failed: number;
  other: number;
  children: ChildOutcome[];
  generatedAt: string;  // ISO-8601
};

type ChildOutcome = {
  folder: string;
  status: "completed" | "failed" | "other";
  source: "disk" | "exit-code";
  runId?: string;
  runState?: RunState;
  exitCode: number;
};

// Read-only, owned by each child pipeline (existing, unchanged)
type RunState = {
  runId: string;
  status: string;     // RunState.status enum (read, not written by fleet)
  startedAt: string;  // ISO-8601; newest-by-startedAt selects the child's run
  // ...remaining fields owned by the pipeline, not interpreted by the fleet
};
```

---

## API Contracts

| Method | Input | Output | Error Cases |
|--------|-------|--------|-------------|
| `FleetEntrypoint.runFleet` | `manifestPath: string`, `options?` | `Promise<PortfolioReport>` | Throws ONLY on batch-setup failure (manifest unreadable/invalid, report write failure); per-child failures never reject |
| `FleetManifestLoader.load` | `manifestPath: string` | `Promise<FleetManifest>` | Throws on ENOENT, invalid JSON, or Zod validation failure |
| `ChildScaffolder.scaffold` | `rootDir`, `child` | `Promise<ScaffoldResult>` | Never throws — folder non-empty / EACCES / `git init` non-zero captured in `error` |
| `ChildRunner.run` | `ChildRunSpec` | `Promise<ChildSpawnResult>` | Never throws — execa `reject:false`; `exitCode`/`timedOut`/`spawnError` captured as data |
| `FleetCoordinator.execute` | `manifest` | `Promise<ChildExecution[]>` | Never rejects — per-child thunk try/catch always resolves to a `ChildExecution` |
| `OutcomeAggregator.aggregate` | `execution` | `Promise<ChildOutcome>` | Never throws — disk IO errors swallowed; scaffold error + no spawn → `failed` / exit-code / -1 |
| `PortfolioReporter.write` | `rootDir`, `report` | `Promise<string>` | Throws on rename / EACCES — the one per-batch failure `runFleet` propagates |

---

## Integration Strategy

### Data Flow

```
Consumer → FleetEntrypoint.runFleet(manifestPath, options)
  → FleetManifestLoader.load(manifestPath)            // throws on bad manifest
  → FleetCoordinator.execute(manifest)
    → mapBounded(children, concurrency, perChildThunk) // peak in-flight === cap
      → [per child, ≤ cap concurrent, inside thunk try/catch — ALWAYS resolves]
        → ChildScaffolder.scaffold(rootDir, child)
        → (skip spawn if scaffold.error)
        → ChildRunner.run({ cwd: absPath, task, timeoutMs })  // execa reject:false
      → ChildExecution
  → [for each] OutcomeAggregator.aggregate(execution)  // newest RunState by startedAt, else exit-code
  → PortfolioReporter.build(outcomes)
  → PortfolioReporter.write(rootDir, report)           // atomic temp + rename
  → .bober/fleet-report.json
Consumer receives PortfolioReport; parent process always exits 0
```

### Consistency Model

Mixed, but no live contention. Each child writes only to its own isolated `cwd/.bober/runs/` tree; the parent reads child state strictly post-exit, so there is no concurrent reader/writer race. The `PortfolioReport` is a point-in-time snapshot built after all children have terminated. Concurrency is bounded by a single shared `Semaphore` (scheduler.ts:54-85) inside `mapBounded`, giving peak in-flight === cap; children are never pre-spawned in a for-loop.

### External Dependencies

| Service | Used By | Failure Mode | Fallback |
|---------|---------|--------------|----------|
| Published `agent-bober` binary (`node dist/cli/index.js`) | ChildRunner | Binary not found → every child silently fails | Resolve parent's own `dist/cli/index.js` via `fileURLToPath(import.meta.url)`, spawn `process.execPath`, pre-flight `--version` probe (ADR-4) |
| DeepSeek API (`api.deepseek.com`, openai-compat) | Child pipeline | `DEEPSEEK_API_KEY` missing → all children fail with auth errors | Fail-fast before fan-out; prefer writing `providerConfig.apiKey` into each child config |
| Filesystem `.bober/` | All components | EACCES / disk full on report write | `runFleet` propagates the write error (only per-batch failure); scaffold/IO errors captured as per-child data |

### Integration Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Child binary not found → fleet-wide silent failure | critical | Resolve parent's own `dist/cli/index.js` via `import.meta.url`, spawn `process.execPath`, pre-flight `--version` probe (ADR-4) |
| Thunk rejection aborts batch (`mapBounded` uses `Promise.all`, scheduler.ts:181) | critical | Never-reject thunk: capture all errors as data, always resolve to `ChildExecution`; sibling-survival test |
| `DEEPSEEK_API_KEY` missing | high | Fail-fast before fan-out; write `providerConfig.apiKey` into child config |
| runId disk ambiguity (clock skew / reused folder) | high | Scaffold fresh folders only; select newest-by-`startedAt`; record `source` |
| Child hang wedges a semaphore slot forever | high | Default per-child execa timeout, manifest-overridable (ADR-5) |
| Scaffold into pre-existing non-empty folder | high | Skip spawn, report `failed`, never delete user data |
| Child crashes before writing `state.json` | medium | Exit-code fallback; record `source: "exit-code"` |
| Concurrency cap not enforced | medium | Use `mapBounded` exclusively; Zod-clamp `concurrency >= 1`; assert peak in tests |
| Child stdout buffer overflow | low | Bound execa `maxBuffer`; read outcome from disk, not stdout |

---

## Architecture Decision Records

- [ADR-1: Manifest-driven fleet with mapBounded fan-out and disk-primary aggregation](.bober/architecture/arch-20260609-fleet-orchestrator-tech-lead-adr-1.md)
- [ADR-2: Child config built via createDefaultConfig() templating, not hand-written JSON](.bober/architecture/arch-20260609-fleet-orchestrator-tech-lead-adr-2.md)
- [ADR-3: Child runId discovered from disk, not parent-injected](.bober/architecture/arch-20260609-fleet-orchestrator-tech-lead-adr-3.md)
- [ADR-4: Child CLI entry resolved to parent's own dist/cli/index.js, not PATH lookup](.bober/architecture/arch-20260609-fleet-orchestrator-tech-lead-adr-4.md)
- [ADR-5: Enforce a default per-child timeout via execa, manifest-overridable](.bober/architecture/arch-20260609-fleet-orchestrator-tech-lead-adr-5.md)

---

## Risk Assessment

| Risk | Severity | Owner | Mitigation |
|------|----------|-------|------------|
| Child binary not found → fleet-wide silent failure | critical | ChildRunner | Resolve `dist/cli/index.js` via `import.meta.url`, spawn `process.execPath`, pre-flight `--version` probe (ADR-4) |
| Per-child thunk rejection aborts the whole batch | critical | FleetCoordinator | Never-reject thunk capturing errors as data; sibling-survival test |
| `DEEPSEEK_API_KEY` missing | high | FleetEntrypoint | Fail-fast before fan-out; write `providerConfig.apiKey` into child config |
| runId disk ambiguity (clock skew / reused folder) | high | OutcomeAggregator | Fresh folders only; newest-by-`startedAt`; record `source` |
| Child hang wedges a semaphore slot | high | ChildRunner | Default per-child execa timeout, manifest-overridable (ADR-5) |
| Scaffold into pre-existing non-empty folder | high | ChildScaffolder | Skip spawn, report `failed`, never delete user data |
| Child crashes before writing `state.json` | medium | OutcomeAggregator | Exit-code fallback; record `source: "exit-code"` |
| Concurrency cap not enforced | medium | FleetCoordinator | `mapBounded` exclusively; Zod-clamp `concurrency >= 1`; assert peak in tests |
| Child stdout buffer overflow | low | ChildRunner | Bound execa `maxBuffer`; read outcome from disk |

---

## Open Questions

- Per-child config override merge semantics: The manifest allows an optional `config?` per child. It is assumed these are shallow-merged over the `createDefaultConfig()` + DeepSeek base. If deep per-role overrides are required, the merge logic in `ChildScaffolder.buildChildConfig` must become a recursive merge and the manifest schema must document the override shape.
- Report-on-partial-failure semantics: It is assumed `runFleet` returns a `PortfolioReport` even when most children fail, throwing only on report-write failure. If callers need a non-zero process exit on any child failure, a `--strict` flag and exit-code mapping must be added without changing the locked `run` CLI contract.
- Resume / re-run of a partially-built portfolio: Not in scope. It is assumed each `fleet` invocation targets fresh folders (ADR-3 rationale). If re-running into existing folders is needed, scaffold must gain an explicit `--resume` mode that distinguishes a prior fleet's folders from unrelated user data.
