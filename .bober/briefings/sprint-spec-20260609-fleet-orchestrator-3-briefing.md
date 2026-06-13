# Sprint Briefing: Bounded fan-out coordinator and outcome aggregator

**Contract:** sprint-spec-20260609-fleet-orchestrator-3
**Generated:** 2026-06-09T00:00:00Z

> The critical concurrency + isolation sprint. The load-bearing invariant: the per-child thunk MUST NEVER reject, because `mapBounded` resolves through a single `Promise.all` — one rejection aborts the entire batch.

---

## 1. Target Files

### src/fleet/types.ts (create)

**Directory pattern:** Files in `src/fleet/` are flat kebab/lowercase single-purpose modules (`manifest.ts`, `child-config.ts`, `scaffolder.ts`, `runner.ts`). Types are declared **inline in the module that owns them** (see `ScaffoldResult` in `scaffolder.ts:9-15`, `ChildSpawnResult` in `runner.ts:22-29`). This sprint introduces a **shared** types module because both `coordinator.ts` and `aggregator.ts` need `ChildExecution` / `ChildOutcome`.

**Structure template (based on the inline-interface style used across src/fleet):**
```ts
import type { ScaffoldResult } from "./scaffolder.js";
import type { ChildSpawnResult } from "./runner.js";
import type { RunState } from "../mcp/run-manager.js";

// ── ChildExecution ────────────────────────────────────────────────────

/** Result of fanning one child through scaffold → run. Produced by FleetCoordinator. */
export interface ChildExecution {
  folder: string;
  scaffold: ScaffoldResult;
  spawn?: ChildSpawnResult;
}

// ── ChildOutcome ──────────────────────────────────────────────────────

export type ChildStatus = "completed" | "failed" | "other";
export type OutcomeSource = "disk" | "exit-code";

/** Resolved status for one child, produced by OutcomeAggregator. */
export interface ChildOutcome {
  folder: string;
  status: ChildStatus;
  source: OutcomeSource;
  exitCode?: number;
  runId?: string;
  runState?: RunState;
}
```
**Rule:** `import type` for ALL of these (ESLint `consistent-type-imports`), `.js` extensions on every relative import. Do NOT re-export from any barrel.

---

### src/fleet/coordinator.ts (create)

**Most similar existing file:** `src/fleet/scaffolder.ts` (class with one async method, never-throws contract) and `src/fleet/runner.ts` (constructor DI seam at `runner.ts:73-76`).

**Structure template:**
```ts
import { mapBounded } from "../orchestrator/workflow/scheduler.js";
import { ChildScaffolder } from "./scaffolder.js";
import { ChildRunner } from "./runner.js";
import type { FleetManifest, FleetChild } from "./manifest.js";
import type { ScaffoldResult } from "./scaffolder.js";
import type { ChildExecution } from "./types.js";

// ── Injection seam ────────────────────────────────────────────────────
export interface Scaffolder { scaffold(rootDir: string, child: FleetChild): Promise<ScaffoldResult>; }
export interface Runner { run(spec: { cwd: string; task: string; timeoutMs?: number }): Promise<import("./runner.js").ChildSpawnResult>; }

export class FleetCoordinator {
  private readonly scaffolder: Scaffolder;
  private readonly runner: Runner;
  constructor(deps?: { scaffolder?: Scaffolder; runner?: Runner }) {
    this.scaffolder = deps?.scaffolder ?? new ChildScaffolder();
    this.runner = deps?.runner ?? new ChildRunner();
  }

  async execute(manifest: FleetManifest): Promise<ChildExecution[]> {
    return mapBounded(
      manifest.children,
      manifest.concurrency,
      (child) => this.runChild(manifest.rootDir, child), // returns Promise<ChildExecution>, NEVER rejects
    );
  }

  // The never-reject thunk: EVERYTHING (incl. the awaits) is inside try/catch.
  private async runChild(rootDir: string, child: FleetChild): Promise<ChildExecution> {
    try {
      const scaffold = await this.scaffolder.scaffold(rootDir, child);
      if (scaffold.error) return { folder: child.folder, scaffold, spawn: undefined };
      const spawn = await this.runner.run({ cwd: scaffold.absPath, task: child.task });
      return { folder: child.folder, scaffold, spawn };
    } catch (e) {
      return {
        folder: child.folder,
        scaffold: { folder: child.folder, absPath: "", configWritten: false, gitInitialized: false, error: String(e) },
        spawn: undefined,
      };
    }
  }
}
```
**CRITICAL:** `mapBounded`'s `fn` receives ONLY the item (`fn: (x: T) => Promise<R>`, `scheduler.ts:175-179`) — NOT `(item, index)`. Do not add an index param. Order alignment is guaranteed by `items.map(...)` + `Promise.all` (`scheduler.ts:181-190`).

---

### src/fleet/aggregator.ts (create)

**Most similar existing file:** read-side helpers in `src/state/run-state.ts` (never-throws, disk-primary). Status enum mapping comes from `RunState.status` at `run-manager.ts:38`.

**Structure template:**
```ts
import { readRunStatesFromDisk } from "../state/run-state.js";
import type { RunState } from "../mcp/run-manager.js";
import type { ChildExecution, ChildOutcome, ChildStatus } from "./types.js";

function mapStatus(s: RunState["status"]): ChildStatus {
  if (s === "completed") return "completed";
  if (s === "failed" || s === "aborted") return "failed";
  return "other"; // "running"
}

export class OutcomeAggregator {
  async aggregate(execution: ChildExecution): Promise<ChildOutcome> {
    const { folder, scaffold, spawn } = execution;
    // Scaffold failed and no spawn → failed via exit-code source
    if (scaffold.error && !spawn) {
      return { folder, status: "failed", source: "exit-code", exitCode: spawn?.exitCode ?? -1 };
    }
    try {
      const states: RunState[] = await readRunStatesFromDisk(scaffold.absPath);
      if (states.length > 0) {
        // newest by startedAt — ISO-8601 strings sort lexicographically
        const newest = states.reduce((a, b) => (b.startedAt > a.startedAt ? b : a));
        return { folder, status: mapStatus(newest.status), source: "disk", runId: newest.runId, runState: newest };
      }
    } catch {
      // readRunStatesFromDisk already swallows IO/JSON errors; guard anyway → fall through
    }
    const code = spawn?.exitCode ?? -1;
    return { folder, status: code === 0 ? "completed" : "failed", source: "exit-code", exitCode: code };
  }
}
```

---

## 2. Patterns to Follow

### mapBounded — EXACT signature & calling convention
**Source:** `src/orchestrator/workflow/scheduler.ts`, lines 175-191
```ts
export async function mapBounded<T, R>(
  items: ReadonlyArray<T>,
  cap: number,
  fn: (x: T) => Promise<R>,
): Promise<R[]> {
  const sem = new Semaphore(Math.max(1, cap));
  return Promise.all(
    items.map(async (item) => {
      await sem.acquire();
      try {
        return await fn(item);
      } finally {
        sem.release();
      }
    }),
  );
}
```
**Rule:** Arg order is `(items, cap, fn)`. `fn` receives the **item only** (no index). Result array is **index-aligned to `items`** (input order preserved). The whole thing resolves via **`Promise.all`** (line 181) — so a single rejected `fn` call rejects `Promise.all` and aborts the batch. THIS is why your thunk must never reject. Never modify this function.

### Semaphore — true peak concurrency = cap (no over-acquire)
**Source:** `scheduler.ts`, lines 54-85
```ts
async acquire(): Promise<void> {
  if (this.active < this.cap) { this.active += 1; return; }
  await new Promise<void>((resolve) => this.waiters.push(resolve)); // hand-off, no increment
}
release(): void {
  const next = this.waiters.shift();
  if (next) next(); else this.active -= 1;
}
```
**Rule:** FIFO hand-off semaphore — peak concurrency is exactly the cap. Do NOT reimplement a pool. Never modify.

### Never-throw, errors-as-data (Sprint 2 contract)
**Source:** `scaffolder.ts:44-53` (returns `error` in the result, never throws) and `runner.ts:85-135` (`reject:false`, captures `spawnError`).
**Rule:** Every public coordinator/aggregator method resolves to a data object even on failure. Match this.

### Constructor DI seam for tests
**Source:** `runner.ts:73-76`
```ts
constructor(options?: { cliEntry?: string; nodeBin?: string }) {
  this._cliEntry = options?.cliEntry;
  this._nodeBin = options?.nodeBin;
}
```
**Rule:** `FleetCoordinator` constructor must accept injectable `{ scaffolder?, runner? }` defaulting to real impls, so tests substitute fakes.

### child.config / timeoutMs
**Note:** `FleetChild` (`manifest.ts:6-11`) has `{ folder, task, config? }` — there is **no typed `timeoutMs`** on the child. `ChildRunSpec.timeoutMs` (`runner.ts:18`) is optional and the runner defaults to `DEFAULT_TIMEOUT_MS` (`runner.ts:33`). Keep it simple: call `runner.run({ cwd: scaffold.absPath, task: child.task })` and let the runner default the timeout. Do NOT invent a `child.config.timeoutMs` accessor unless typed.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `mapBounded` | `src/orchestrator/workflow/scheduler.ts:175` | `<T,R>(items: ReadonlyArray<T>, cap: number, fn: (x: T) => Promise<R>): Promise<R[]>` | Bounded-concurrency, order-preserving map. USE THIS — no hand-rolled pool. |
| `Semaphore` | `src/orchestrator/workflow/scheduler.ts:54` | `new Semaphore(cap)` `.acquire()/.release()/.inFlight` | Backs mapBounded. Do not reimplement. |
| `readRunStatesFromDisk` | `src/state/run-state.ts:110` | `(projectRoot: string): Promise<RunState[]>` | Walks `<root>/.bober/runs/*/state.json`, swallows IO/JSON errors → `[]`. Aggregator's disk source. |
| `writeRunState` | `src/state/run-state.ts:41` | `(projectRoot: string, state: RunState): Promise<void>` | Atomic write. USE THIS in tests to seed disk fixtures (no fs mocks). |
| `readRunState` | `src/state/run-state.ts:61` | `(projectRoot, runId): Promise<RunState\|null>` | Single-run read, never throws. |
| `listRunStateFiles` | `src/state/run-state.ts:78` | `(projectRoot): Promise<RunState[]>` | Underlying enumerator (readRunStatesFromDisk delegates to it). |
| `ChildScaffolder` | `src/fleet/scaffolder.ts:19` | `.scaffold(rootDir, child): Promise<ScaffoldResult>` | Default scaffolder; never throws. |
| `ChildRunner` | `src/fleet/runner.ts:57` | `new ChildRunner({cliEntry?,nodeBin?})`, `.run(spec): Promise<ChildSpawnResult>` | Default runner; never throws. |
| `buildChildConfig` | `src/fleet/child-config.ts:21` | `(child): BoberConfig` | Used inside scaffolder — not needed directly here. |

Utilities reviewed: `src/utils/`, `src/state/`, `src/fleet/`, `src/orchestrator/workflow/` — the above are the relevant ones.

---

## 4. Prior Sprint Output

### Sprint 1: manifest & child-config
**Created:** `src/fleet/manifest.ts` — exports `FleetManifestSchema`, `FleetChildSchema`, types `FleetManifest` `{ rootDir, concurrency, children }` (`manifest.ts:13-18`), `FleetChild` `{ folder, task, config? }` (`manifest.ts:6-11`), and `load(path)`. `src/fleet/child-config.ts` — `buildChildConfig`.
**Connection:** `execute(manifest)` reads `manifest.children` (array), `manifest.concurrency` (number ≥ 1, default 3), `manifest.rootDir` (default "."). Each child supplies `folder` + `task`.

### Sprint 2: scaffolder & runner
**Created:**
- `src/fleet/scaffolder.ts` — `ChildScaffolder.scaffold(rootDir, child): Promise<ScaffoldResult>`. `ScaffoldResult = { folder, absPath, configWritten, gitInitialized, error? }` (`scaffolder.ts:9-15`). Never throws; failures set `error`. Note: a non-fatal **git init** failure still returns `configWritten:true` WITH an `error` set (`scaffolder.ts:86-92`) — so do NOT treat `scaffold.error` as "no run". Re-read the generatorNotes guidance: branch on `scaffold.error` to skip spawn. **Decision point for the generator:** the contract's thunk pseudocode skips spawn when `scaffold.error` is truthy. Follow the contract — `if (scaffold.error) return {... spawn: undefined}`.
- `src/fleet/runner.ts` — `ChildRunner` (DI constructor `{cliEntry?,nodeBin?}` at line 73), `.run(spec: ChildRunSpec): Promise<ChildSpawnResult>`. `ChildRunSpec = { cwd, task, timeoutMs? }` (`runner.ts:16-20`). `ChildSpawnResult = { cwd, exitCode: number|null, stdout, stderr, timedOut?, spawnError? }` (`runner.ts:22-29`). Never throws.
**Connection:** Coordinator imports both, accepts injectable replacements, and feeds `scaffold.absPath` as the runner's `cwd`. Aggregator reads `spawn.exitCode` (which is `number | null`).

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM .js extensions** on every relative import (line 27). NodeNext.
- **`import type`** enforced by ESLint `consistent-type-imports` (line 35). Use it for all type-only imports.
- **No `any`** (line 40) — use `unknown` + narrowing. The `catch (e)` blocks: `String(e)` is fine; avoid `(e as Error)` casts unless guarded.
- **No sync fs** (line 42) — only `node:fs/promises`.
- **No fs mocks in tests** (line 44) — create temp dirs (`mkdtemp`) and clean up. Seed RunState fixtures with `writeRunState`, not mocks.
- **Tests collocated** as `*.test.ts` next to source (line 20). Vitest.
- **Section comments** `// ── Name ──` box-drawing headers (line 32).
- **No barrel re-exports for deep internals** (line 43) — import `src/fleet/*` modules directly.
- Errors-as-data / never-throw is the de-facto contract across `src/fleet/` (matches Sprint 2).

### Architecture Decisions
ADR-4 (referenced in `runner.ts:5`): CLI entry resolved relative to module, not a bare PATH lookup. Not directly relevant to this sprint (no spawning logic changes), but explains the runner seam.

### Other Docs
No `CLAUDE.md`/`CONTRIBUTING.md` coding-guideline file in repo root beyond principles.

---

## 6. Testing Patterns

### Unit Test Pattern — mkdtemp fixture + writeRunState seeding (NO fs mocks)
**Source:** `src/state/run-state.test.ts:8-44` and `src/fleet/runner.test.ts:13-19`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeRunState } from "../state/run-state.js";
import type { RunState } from "../mcp/run-manager.js";

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-fleet-coord-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

function makeState(o?: Partial<RunState>): RunState {
  return {
    runId: "r1", task: "t", status: "running",
    startedAt: new Date().toISOString(),
    progress: { completed: 0, total: 0 }, projectRoot: tmpDir, ...o,
  };
}
```
**Runner:** vitest. **Assertion:** `expect(...)`. **Mock approach:** NO fs mocks — temp dirs + `writeRunState`. For coordinator deps, inject **plain fake objects** implementing `.scaffold`/`.run` (no vi.mock). **File naming:** `coordinator.test.ts`, `aggregator.test.ts` collocated in `src/fleet/`.

### Seeding a RunState disk fixture for the aggregator
The aggregator calls `readRunStatesFromDisk(scaffold.absPath)`, which reads `<absPath>/.bober/runs/*/state.json`. So set `scaffold.absPath = tmpDir` and seed with `writeRunState(tmpDir, makeState({ runId, status, startedAt }))`. For newest-by-startedAt, write two states with different ISO `startedAt` values and assert the later one wins.

### Test (a) — deterministic peak-concurrency <= cap (sc-3-5)
Use a fake runner with a shared live counter + observed max, with an `await` tick to force overlap. Use `cap < children.length` (e.g. 6 children, cap 2) and ALSO assert MORE than `cap` ran (not accidentally serialized):
```ts
it("peak concurrency never exceeds cap and more than cap children ran (sc-3-5)", async () => {
  let live = 0, peak = 0, totalRan = 0;
  const tick = () => new Promise<void>((r) => setTimeout(r, 5));
  const fakeRunner = {
    async run(spec: { cwd: string; task: string; timeoutMs?: number }) {
      live++; peak = Math.max(peak, live); totalRan++;
      await tick(); // hold the slot so overlap is observable
      live--;
      return { cwd: spec.cwd, exitCode: 0, stdout: "", stderr: "" };
    },
  };
  const fakeScaffolder = {
    async scaffold(_root: string, child: { folder: string }) {
      return { folder: child.folder, absPath: "/tmp/" + child.folder, configWritten: true, gitInitialized: true };
    },
  };
  const coord = new FleetCoordinator({ scaffolder: fakeScaffolder, runner: fakeRunner });
  const manifest = {
    rootDir: ".", concurrency: 2,
    children: Array.from({ length: 6 }, (_, i) => ({ folder: "c" + i, task: "t" })),
  };
  const results = await coord.execute(manifest as any);
  expect(results).toHaveLength(6);
  expect(peak).toBeLessThanOrEqual(2);
  expect(totalRan).toBe(6);     // all ran
  expect(peak).toBeGreaterThan(1); // proves true overlap, not serialized
});
```

### Test (b) — sibling survival, execute() never rejects (sc-3-6)
```ts
it("one child throwing does not abort the batch; every sibling resolves (sc-3-6)", async () => {
  const fakeScaffolder = {
    async scaffold(_r: string, child: { folder: string }) {
      return { folder: child.folder, absPath: "/tmp/" + child.folder, configWritten: true, gitInitialized: true };
    },
  };
  const fakeRunner = {
    async run(spec: { cwd: string; task: string }) {
      if (spec.task === "BOOM") throw new Error("kaboom"); // forces the thunk's catch
      return { cwd: spec.cwd, exitCode: 0, stdout: "", stderr: "" };
    },
  };
  const coord = new FleetCoordinator({ scaffolder: fakeScaffolder, runner: fakeRunner });
  const manifest = { rootDir: ".", concurrency: 3, children: [
    { folder: "a", task: "ok" }, { folder: "b", task: "BOOM" }, { folder: "c", task: "ok" },
  ]};
  // Must NOT reject:
  const results = await coord.execute(manifest as any);
  expect(results).toHaveLength(3);
  // index alignment preserved
  expect(results.map((r) => r.folder)).toEqual(["a", "b", "c"]);
  // the throwing child still produced a ChildExecution with an error captured
  const b = results[1];
  expect(b.spawn).toBeUndefined();
  expect(b.scaffold.error).toContain("kaboom"); // captured by the thunk catch
});
```
**Note:** also add a sibling-survival variant where the *scaffolder* throws (not the runner) to prove the entire body incl. the first await is wrapped.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
This sprint is purely additive (3 new files + 2 new test files). It IMPORTS from stable modules but modifies none.
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/orchestrator/workflow/scheduler.ts` | (consumed, not modified) | low | Do NOT edit. Confirm `mapBounded` arg order at call site. |
| `src/state/run-state.ts` | (consumed, not modified) | low | Do NOT edit `readRunStatesFromDisk`. |
| `src/mcp/run-manager.ts` | (type `RunState` imported) | low | Status enum is `"running"\|"completed"\|"failed"\|"aborted"` (line 38) — map exactly. |
| `src/fleet/scaffolder.ts` / `runner.ts` | (consumed via DI) | low | Real types must match the DI interfaces; do not edit. |

### Existing Tests That Must Still Pass
- `src/state/run-state.test.ts` — covers `readRunStatesFromDisk`/`writeRunState`; unaffected (no source change) but your aggregator relies on its behavior staying identical.
- `src/fleet/runner.test.ts`, `src/fleet/scaffolder.test.ts`, `src/fleet/manifest.test.ts`, `src/fleet/child-config.test.ts` — Sprint 1/2 suites; must stay green (no source edits).
- `src/orchestrator/workflow/scheduler.test.ts` (if present) — mapBounded/Semaphore tests; must stay green since you don't touch that file.

### Features That Could Be Affected
- **RunState shape** is shared with `mcp/run-manager.ts`, `mcp` discovery tools, and pipeline persistence. You only READ it via `readRunStatesFromDisk` — no shape change, so no cross-feature impact.

### Recommended Regression Checks
1. `npm run build` (tsc) — zero errors (sc-3-1/sc-3-2).
2. `npx eslint src/fleet/coordinator.ts src/fleet/aggregator.ts src/fleet/types.ts src/fleet/coordinator.test.ts src/fleet/aggregator.test.ts` — zero errors (sc-3-3).
3. `npx vitest run src/fleet` — new + existing fleet suites green.
4. `npx vitest run` — full suite green (sc-3-9).

---

## 8. Implementation Sequence

1. **src/fleet/types.ts** — define `ChildExecution`, `ChildOutcome`, `ChildStatus`, `OutcomeSource`. Import `ScaffoldResult`/`ChildSpawnResult`/`RunState` as `import type`.
   - Verify: `tsc` resolves the type imports; no circular import (types.ts imports from scaffolder/runner type-only — fine).
2. **src/fleet/coordinator.ts** — `FleetCoordinator` with DI constructor + `execute` calling `mapBounded(manifest.children, manifest.concurrency, child => this.runChild(...))`; the `runChild` thunk fully wrapped in try/catch.
   - Verify: thunk has NO un-caught await; `mapBounded` arg order `(items, cap, fn)`; `fn` takes item only.
3. **src/fleet/aggregator.ts** — `OutcomeAggregator.aggregate` with scaffold-error short-circuit, disk-primary via `readRunStatesFromDisk` (newest by `startedAt` string compare), exit-code fallback, `mapStatus` enum map. Wrap read in try/catch (belt-and-braces); never throw.
   - Verify: status mapping `completed→completed`, `failed|aborted→failed`, `running→other`.
4. **src/fleet/coordinator.test.ts** — mapBounded-usage (order alignment), peak<=cap (test a), sibling-survival both via runner-throw and scaffolder-throw (test b).
   - Verify: tests deterministic (counter+max, not timing thresholds beyond ordering).
5. **src/fleet/aggregator.test.ts** — disk-primary newest-by-startedAt (seed 2 states via `writeRunState` with different ISO times); exit-code fallback (no states → exit 0 completed / exit 3 failed); scaffold-error path → failed/exit-code; garbage run dir → never throws.
   - Verify: fixtures seeded under `tmpDir/.bober/runs/...` and `scaffold.absPath === tmpDir`.
6. **Run full verification** — `npm run build`, `npx vitest run`, `npx eslint <new files>`.

---

## 9. Pitfalls & Warnings

- **mapBounded `fn` signature is `(x: T)` — item only, NO index** (`scheduler.ts:177`). Adding `(item, index)` will type-error or silently ignore the second arg.
- **mapBounded resolves via `Promise.all` (`scheduler.ts:181`)** — a single rejected `fn` aborts the whole batch. The thunk's try/catch MUST wrap the `await scaffolder.scaffold(...)` AND `await runner.run(...)` AND the return construction. An await outside the catch = sibling-survival test fails.
- **Newest-by-startedAt is an ISO-8601 string compare** — `b.startedAt > a.startedAt` (lexicographic) is correct for ISO timestamps; do NOT `new Date()` parse unless needed. Mirrors `run-manager.ts:98` (`s.startedAt > newest.startedAt`).
- **`spawn.exitCode` is `number | null`** (`runner.ts:24`). Fallback default must handle null: `spawn?.exitCode ?? -1`. `null === 0` is false → correctly maps to "failed".
- **`scaffold.error` can be set even on a "successful" scaffold** (git init non-fatal failure still sets `error`, `scaffolder.ts:86-92`). The contract's thunk treats any `scaffold.error` as skip-spawn — follow the contract pseudocode exactly; don't try to distinguish fatal vs non-fatal.
- **Do NOT modify** `mapBounded`, `Semaphore`, `runPipeline`, `readRunStatesFromDisk`, or the `run` command (contract nonGoals lines 24-27).
- **No fs mocks** (principle line 44) — seed fixtures with `writeRunState` + `mkdtemp`, clean up in `afterEach`.
- **`import type`** for `FleetManifest`, `FleetChild`, `ScaffoldResult`, `ChildSpawnResult`, `RunState`, and all fleet types (ESLint will error otherwise).
- **`.js` extensions** on every relative import including `./types.js`, `../state/run-state.js`, `../orchestrator/workflow/scheduler.js`.
- **No `any` in non-test code.** Tests may need light casts (`manifest as FleetManifest`) — prefer constructing a valid `FleetManifest` object to avoid the cast where practical.
- **types.ts must not introduce a circular import** — it imports type-only from scaffolder/runner (which don't import types.ts), so it's safe. Keep it type-only.
