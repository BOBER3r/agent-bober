# Sprint Briefing: Multi-run RunManager with disk persistence and crash recovery

**Contract:** sprint-spec-20260525-cockpit-integration-1
**Generated:** 2026-05-25T00:00:00Z

---

## 1. Target Files

### `src/mcp/run-manager.ts` (modify — full rewrite, preserve public surface)

**Current full state** (133 lines — small enough to show in full):

```ts
// src/mcp/run-manager.ts (CURRENT — sprint REFACTORS this file)
import { randomUUID } from "node:crypto";

import type { BoberConfig } from "../config/schema.js";
import { runPipeline } from "../orchestrator/pipeline.js";
import type { PipelineResult } from "../orchestrator/pipeline.js";

export interface RunProgress { completed: number; total: number; currentSprint?: string; iteration?: number; }
export interface RunResult   { success: boolean; completedSprints: number; failedSprints: number; duration: number; }
export interface RunState {
  runId: string;
  task: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  progress: RunProgress;
  result?: RunResult;
  error?: string;
}

export class RunManager {
  private activeRun: RunState | null = null;   // ← BECOMES: private runs = new Map<string, RunState>()

  isRunning(): boolean { return this.activeRun !== null && this.activeRun.status === "running"; }
  getStatus(): RunState | null { return this.activeRun; }

  startRun(task, projectRoot, config, pipelineFn = runPipeline): string {
    if (this.isRunning()) throw new Error(`A pipeline is already running...`);  // ← REMOVED in new behavior
    const runId = randomUUID();
    const now = new Date().toISOString();
    this.activeRun = { runId, task, status: "running", startedAt: now, progress: { completed: 0, total: 0 } };

    const promise = pipelineFn(task, projectRoot, config);
    promise.then((result) => { /* mutate activeRun → completed */ })
           .catch((err) => { /* mutate activeRun → failed */ });
    return runId;
  }
}

export const runManager = new RunManager();   // ← KEEP module-scoped singleton (back-compat)
```

**What must change:**
- `private activeRun: RunState | null` → `private runs = new Map<string, RunState>()`
- `RunState` interface extends with **required** `projectRoot: string` and **optional** `specId?: string` (per `generatorNotes`).
- `startRun()` MUST persist `state.json` synchronously (await before return) AND call the persister inside BOTH `.then` and `.catch` callbacks.
- `startRun()` MUST NOT throw on `isRunning()` — back-compat throw lives in the **tool layer** (run.ts/react.ts/etc), NOT here. (The contract says "starting two runs concurrently no longer throws".)
- Add new methods: `getRun(runId)`, `listActiveRuns()`, `abortRun(runId, reason)`, `load(projectRoot)`.
- `isRunning()` returns `true` when ANY run in the map has `status === "running"`.
- `getStatus()` returns the **most-recently-started** run (sort by `startedAt` desc, pick first), or `null`.

**Imports the new version needs:**
- `randomUUID` from `node:crypto` (existing)
- `BoberConfig`, `runPipeline`, `PipelineResult` (existing)
- `writeRunState`, `readRunState`, `listRunStateFiles` from `../state/run-state.js` (NEW module)
- `logger` from `../utils/logger.js` (for warn on load failures)

**Imported by:**
- `src/mcp/tools/run.ts:13` — uses `runManager.isRunning()`, `getStatus()`, `startRun()`
- `src/mcp/tools/status.ts:13` — uses `runManager.getStatus()`
- `src/mcp/tools/anchor.ts:11`
- `src/mcp/tools/solidity.ts:11`
- `src/mcp/tools/brownfield.ts:12`
- `src/mcp/tools/react.ts:12`
- `src/index.ts:190` — re-exports `RunManager` class

**Test file:** `src/mcp/run-manager.test.ts` — EXISTS (275 lines, 17 tests). Must continue passing and be extended with new-method coverage.

---

### `src/state/run-state.ts` (create)

**Directory pattern:** `src/state/*.ts` modules expose `save*/read*/list*` helpers that own disk paths under `.bober/<entity>/`. They consume `projectRoot` as the first arg, return `Promise<T>` or `Promise<void>`, and import `ensureDir` from `./helpers.js`.

**Most similar existing file:** `src/state/approval-state.ts` — closest shape (per-entity directory layout, save/read/list trio). Newer cousin `src/incident/timeline.ts:86-92` owns the **atomic write pattern** required by sc-1-3.

**Structure template (synthesizing approval-state.ts shape + timeline.ts atomic-write):**

```ts
// src/state/run-state.ts (NEW)
import { readFile, writeFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir } from "./helpers.js";
import type { RunState } from "../mcp/run-manager.js";   // import-type only — no runtime coupling

const RUNS_DIR = ".bober/runs";

function runsRoot(projectRoot: string): string {
  return join(projectRoot, RUNS_DIR);
}

function runDir(projectRoot: string, runId: string): string {
  return join(runsRoot(projectRoot), runId);
}

function statePath(projectRoot: string, runId: string): string {
  return join(runDir(projectRoot, runId), "state.json");
}

/**
 * Atomically write a run state.json via temp-file + rename
 * (mirrors src/incident/timeline.ts:86-92 atomicWriteJson).
 */
export async function writeRunState(projectRoot: string, state: RunState): Promise<void> {
  await ensureDir(runDir(projectRoot, state.runId));
  const filePath = statePath(projectRoot, state.runId);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  await rename(tmp, filePath);
}

export async function readRunState(projectRoot: string, runId: string): Promise<RunState | null> {
  try {
    const raw = await readFile(statePath(projectRoot, runId), "utf-8");
    return JSON.parse(raw) as RunState;   // loose parse — RunState may grow over time (assumption #3)
  } catch {
    return null;
  }
}

export async function listRunStateFiles(projectRoot: string): Promise<RunState[]> {
  let entries: string[];
  try { entries = await readdir(runsRoot(projectRoot)); }
  catch { return []; }

  const out: RunState[] = [];
  for (const id of entries) {
    const s = await readRunState(projectRoot, id);
    if (s) out.push(s);
    // malformed/missing state.json → skip silently (logged by RunManager.load if needed)
  }
  return out;
}
```

**Rationale for placement:** `generatorNotes` says: "Place the disk-persistence helpers in a new `src/state/run-state.ts` module (mirrors `src/state/approval-state.ts`) so the persistence logic is testable in isolation."

---

### `src/state/run-state.test.ts` (create)

**Most similar existing test file:** `tests/incident/timeline.test.ts` (uses `mkdtemp` + `afterEach rm`). Same pattern can be co-located in `src/state/run-state.test.ts` because the contract lists it there (Vitest picks up both locations — see vitest.config / `src/mcp/run-manager.test.ts` precedent).

**Required test cases (one-to-one with success criteria):**
1. `writeRunState` creates `.bober/runs/<runId>/state.json` with exact JSON payload.
2. `writeRunState` is atomic — assert no `.tmp` files remain after a successful write.
3. `writeRunState` of 100 concurrent updates to the SAME runId produces a final file that parses as valid JSON (sc-1-3 stress test from `evaluatorNotes`).
4. `readRunState` returns `null` for a non-existent runId (no throw).
5. `readRunState` returns `null` for a corrupt JSON file (no throw).
6. `listRunStateFiles` returns `[]` when the runs/ directory does not exist.
7. `listRunStateFiles` skips malformed `state.json` files but returns valid ones.
8. File mode is `0o600` after write (mirrors mode assertion patterns in timeline.test.ts).

---

### `src/state/index.ts` (modify)

**Relevant section to change (lines 1-95):** the file aggregates state-module re-exports. Append a new export block:

```ts
// ADD near line 79 (after the approval-state re-export block):
export {
  writeRunState,
  readRunState,
  listRunStateFiles,
} from "./run-state.js";
```

**Already correct:** `SUBDIRS` at line 81 already includes `"runs"` — `ensureBoberDir()` already creates `.bober/runs/`. No change needed there.

---

### `src/mcp/server.ts` (modify)

**Relevant section (lines 55-65):**

```ts
export async function createBoberMCPServer(projectRoot: string): Promise<Server> {
  const version = await loadVersion();

  // ── Register all tools before creating the server ────────────────
  registerAllTools();
  // ↑ INSERT runManager.load(projectRoot) HERE per generatorNotes
```

**Required change:** After `registerAllTools()`, call `runManager.load(projectRoot)` and wrap in try/catch that logs to `process.stderr` and continues (per `generatorNotes`: "Failure to load runs (e.g. corrupt state.json) must log to stderr and continue, not abort the server.").

```ts
  registerAllTools();

  // ── Reconcile prior run state from disk (sprint cockpit-integration-1) ───
  try {
    await runManager.load(projectRoot);
  } catch (err) {
    process.stderr.write(
      `[agent-bober mcp] runManager.load failed (continuing): ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  }
```

**Add import at top:** `import { runManager } from "./run-manager.js";`

---

### `src/mcp/run-manager.test.ts` (modify — extend existing 275-line suite)

**Existing tests must remain passing** (back-compat sc-1-5). They construct `new RunManager()` with no args and call `startRun(task, "/tmp", config, mockPipeline)`. The new `startRun` signature **must keep this 4-arg shape** (don't add new required params; if you need projectRoot for persistence, it's already arg #2).

**Critical change to existing tests:** the existing tests pass `"/tmp"` as projectRoot — your persistence layer will now actually write to `/tmp/.bober/runs/<runId>/state.json`. Tests that previously didn't care about disk side-effects WILL start touching the real `/tmp`. Two options:
- **Preferred:** Update every existing test to use `mkdtemp` (mirrors `tests/incident/timeline.test.ts:40-46`).
- **Alternative:** Keep `/tmp` but accept that test runs leave `/tmp/.bober/runs/*` debris (NOT acceptable on CI — go with mkdtemp).

**New test cases to add (one per success criterion):**
- sc-1-1: `getRun(runId)`, `listActiveRuns()`, `abortRun(runId, reason)` exist and return the right shape.
- sc-1-2: After `startRun`, `state.json` is on disk synchronously (assert `await stat(path)` succeeds when `startRun` returns).
- sc-1-3: After `.then()` callback fires (`await new Promise(r => setTimeout(r, 0))`), the on-disk state matches the in-memory state.
- sc-1-4: `load()` reads existing `state.json` files, flips `status === "running"` to `"failed"` with `error === "orchestrator crashed before completion"`.
- sc-1-5: Two concurrent `startRun` calls succeed without throwing (vs. previous singleton behavior — see `evaluatorNotes` negative test); `isRunning()` returns true while either is running; `getStatus()` returns the more recently started.

---

## 2. Patterns to Follow

### Pattern A — Atomic JSON write via temp-file + rename (REQUIRED for sc-1-3)
**Source:** `src/incident/timeline.ts:86-93`

```ts
async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  await rename(tmp, filePath);
}
```
**Rule:** Every state.json write goes through this exact pattern. Use `${process.pid}.${Date.now()}` in the temp name to avoid collisions between concurrent writes to the same runId. POSIX `rename` is atomic on same filesystem.

### Pattern B — Per-entity directory layout under `.bober/<entity>/<id>/`
**Source:** `src/incident/timeline.ts:97-99`

```ts
function incidentDir(projectRoot: string, incidentId: IncidentId): string {
  return join(projectRoot, ".bober", "incidents", incidentId);
}
```
**Rule:** Use `join(projectRoot, ".bober", "runs", runId)` for the run directory; the directory is created by `ensureDir(runDir(...))` from `src/state/helpers.ts`. `SUBDIRS` in `src/state/index.ts:81` already lists `"runs"`.

### Pattern C — `list*` helpers skip malformed files instead of throwing
**Source:** `src/incident/timeline.ts:567-583`, `src/state/sprint-state.ts:130-144`

```ts
for (const entry of entries) {
  try {
    const raw = await readFile(metaPath, "utf-8");
    const meta = IncidentMetadataSchema.parse(JSON.parse(raw));
    summaries.push(...);
  } catch (err: unknown) {
    logger.warn(`[listIncidents] Skipping malformed incident.json at ${metaPath}: ...`);
  }
}
```
**Rule:** `load(projectRoot)` must NOT abort on a single bad `state.json`. Log via `logger.warn` (or `process.stderr.write` from the server-side caller) and continue.

### Pattern D — Schema growth tolerance (assumption #3)
**Source:** This is a NEW convention for run-state. The contract says "consumers must tolerate unknown fields. Use zod with `.passthrough()` or a loose object schema."
**Rule:** If you adopt zod for validation, use `.passthrough()`. Simpler: just `JSON.parse` and cast — the type system already has `RunState`. Don't introduce a zod dependency where the existing pattern (`src/state/approval-state.ts:69`) just JSON.parses and casts.

### Pattern E — Fire-and-forget callbacks that must persist
**Source:** Existing `src/mcp/run-manager.ts:100-124` — `.then`/`.catch` mutate `activeRun` after the promise settles.
**Rule:** In the new version, BOTH callbacks must `await writeRunState(projectRoot, this.runs.get(runId)!)` after mutating the map entry. Wrap each write in its own try/catch that logs and continues — a disk write failure must NOT crash the orchestrator.

### Pattern F — Singleton-with-Map pattern (back-compat shim style)
**Source:** No existing equivalent — this is a NEW pattern. Closest precedent: `src/orchestrator/checkpoints/audit.ts:82` `const writeChains = new Map<string, Promise<void>>()` for per-runId mutex.
**Rule:** The `runManager` export at line 132 stays. Internally it holds a `Map<runId, RunState>`. Shim methods (`isRunning`, `getStatus`) walk the map to compute their answer.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `ensureDir` | `src/state/helpers.ts:6` | `(dirPath: string) => Promise<void>` | `mkdir -p` wrapper used by every `src/state/*` module. Use this instead of calling `mkdir` directly. |
| `ensureBoberDir` | `src/state/index.ts:87` | `(projectRoot: string) => Promise<void>` | Creates `.bober/` plus all known subdirectories. Includes `"runs"` already (line 81). Server may already call this elsewhere; do NOT call it from `RunManager.load`. |
| `randomUUID` | `node:crypto` | `() => string` | Already used in run-manager.ts line 6 — keep it for the runId. |
| `logger` | `src/utils/logger.ts` (`{ logger }`) | `logger.warn(msg)` etc. | Standard logger; use for load() reconciliation warnings. |
| `atomicWriteJson` | `src/incident/timeline.ts:86` (NOT EXPORTED) | private | The pattern is here but the function is private to timeline.ts. **Do NOT export it — copy the 6-line pattern into `src/state/run-state.ts`.** This avoids cross-module coupling. |
| `recordApproval` per-runId mutex | `src/orchestrator/checkpoints/audit.ts:82,141` | `Map<string, Promise<void>>` chain | Pattern reference only. Not needed for run-state because `writeRunState` is invoked from controlled call sites (only the `.then`/`.catch` callbacks per runId) — no cross-call interleaving risk. |
| `process.stderr.write` | (Node built-in) | `(msg: string) => boolean` | Use this in `src/mcp/server.ts` for load() failures. The MCP server uses stderr for diagnostics — line 75, 100, 170 are the precedent. **Never use console.log inside MCP server code — stdout belongs to JSON-RPC.** |

---

## 4. Prior Sprint Output

This is sprint #1 of `spec-20260525-cockpit-integration`. `dependsOn` is empty.

**Relevant prior-spec artifacts (bober-vision, v0.14.0 already shipped):**
- `src/incident/timeline.ts` — atomic-write pattern source (sprint 19 of bober-vision).
- `src/telemetry/emit.ts` — JSONL append + mode 0600 pattern (sprint 28). Not used by this sprint but demonstrates the canonical "mode 0o600 + per-key write chain" idiom.
- `src/orchestrator/checkpoints/audit.ts` — per-runId mutex chain (sprint 13). Pattern reference for future incremental persistence.
- `src/state/index.ts` — already includes `"runs"` in `SUBDIRS`; `ensureBoberDir()` creates `.bober/runs/` already.

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` is required by this sprint; the contract's `assumptions` and `nonGoals` are the contract.

### Architecture Decisions
No relevant ADR. The `generatorNotes` provide the architectural direction in lieu of an ADR. Key calls-out:
- "Single orchestrator-per-project assumption holds" — no file locking, no fcntl.
- "Run state schema can grow over time; consumers must tolerate unknown fields."
- "Atomic temp-file + rename is sufficient."

### MCP server diagnostic convention
**Source:** `src/mcp/server.ts:1-7` (header comment) and lines 75, 100, 170.
> "stdout is reserved for MCP JSON-RPC protocol messages. All diagnostic output must go to process.stderr."

This is **load-bearing**: `runManager.load(projectRoot)` failures and any warnings must NOT use `console.log`.

---

## 6. Testing Patterns

### Unit Test Pattern (vitest, co-located + tests/ split)
**Source:** `src/mcp/run-manager.test.ts:14-15, 72-83`

```ts
import { describe, it, expect, vi } from "vitest";
import { RunManager } from "./run-manager.js";

describe("RunManager", () => {
  describe("initial state", () => {
    it("returns null from getStatus() when no run has started", () => {
      const manager = new RunManager();
      expect(manager.getStatus()).toBeNull();
    });
  });
});
```
**Runner:** vitest
**Assertion style:** `expect(...).toBe(...)`, `.toMatchObject(...)`, `.toBeNull()`
**Mock approach:** `vi.fn().mockReturnValue(neverResolves)` / `.mockResolvedValue(...)` / `.mockRejectedValue(...)` — see lines 89-102, 160-169, 220-227. **Do NOT use `vi.mock` to stub the new `run-state.js` module — instead, pass a real `mkdtemp` projectRoot and let the persistence run end-to-end.** This catches real disk bugs.
**File naming:** `<module>.test.ts` co-located with source (e.g. `src/mcp/run-manager.test.ts`).
**Location:** Both `src/**/*.test.ts` (co-located) AND `tests/**/*.test.ts` (split) are picked up by vitest config — see `tests/incident/timeline.test.ts` for the split convention.

### Async-callback flush pattern
**Source:** `src/mcp/run-manager.test.ts:165`
```ts
manager.startRun("task", "/tmp", makeFakeConfig(), mockPipeline);
await new Promise((resolve) => setTimeout(resolve, 0));   // flush .then/.catch microtask
const state = manager.getStatus();
expect(state!.status).toBe("completed");
```
**Rule:** Use this same flush idiom in new tests that assert post-resolution state OR post-resolution **disk** state.

### Temp-directory fixture pattern (REQUIRED for disk tests)
**Source:** `tests/incident/timeline.test.ts:13-46`

```ts
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-runmanager-test-"));
});
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});
```
**Rule:** EVERY test in the new suite that exercises persistence MUST use this fixture. Do NOT write to `/tmp/.bober/...` or to the repo `.bober/` directory.

### Stress test for sc-1-3 (concurrent writes)
**Source:** No existing direct precedent. Synthesize based on `Promise.all`:
```ts
const promises = Array.from({ length: 100 }, (_, i) =>
  writeRunState(tmpDir, { ...state, progress: { completed: i, total: 100 } })
);
await Promise.all(promises);
const raw = await readFile(statePath, "utf-8");
const parsed = JSON.parse(raw);   // MUST NOT throw — no partial JSON
expect(parsed.runId).toBe(state.runId);
```

### E2E Test Pattern
Not applicable to this sprint. No Playwright/E2E tests touch run-manager.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break

| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/mcp/tools/run.ts:56,57,73` | `runManager.isRunning()`, `getStatus()`, `startRun()` | medium | The `isRunning()` rejection at line 56 currently guards concurrent runs. The contract removes the internal throw from `RunManager.startRun()` but **the tool can keep its own pre-flight `isRunning()` check** to preserve `bober_run`'s "only one at a time" UX. Per `nonGoals`: "Do not change the input/output schema of bober_run or bober_status." So keep `isRunning()`/`getStatus()` calls in tool files exactly as-is. |
| `src/mcp/tools/status.ts:30` | `runManager.getStatus()` | low | Just reads `.getStatus()`. Shim returns the most-recently-started run — old behavior is the same when only one run exists. |
| `src/mcp/tools/anchor.ts:50,51,70` | `runManager.isRunning/getStatus/startRun` | medium | Same as run.ts — pre-flight check stays; startRun signature unchanged. |
| `src/mcp/tools/solidity.ts:50,51,70` | same | medium | same |
| `src/mcp/tools/brownfield.ts:50,51,72` | same | medium | same |
| `src/mcp/tools/react.ts:56,57,76` | same | medium | same |
| `src/index.ts:190` | `export { RunManager }` | low | Just a re-export; class name unchanged. |
| `src/mcp/server.ts:55-58` | server boot | medium | Insert `await runManager.load(projectRoot)` with try/catch — failure must not abort boot. |

### Existing Tests That Must Still Pass

- `src/mcp/run-manager.test.ts` — 17 existing tests. Note that **6 of them call `startRun(task, "/tmp", config, mockPipeline)` and previously had no disk side-effects**. After this sprint they will write to `/tmp/.bober/runs/`. **You MUST update these tests to use `mkdtemp` + `afterEach rm`** OR they will pollute `/tmp` and may flake on CI. The "throws when called while already running" test at line 131-141 needs to be **deleted or rewritten** — the contract removes that throw (see `evaluatorNotes` negative test).
- `src/mcp/tools/tools.test.ts` — verifies 17 tools registered. Unaffected.
- `src/mcp/external-client.test.ts` — unrelated.
- `tests/mcp/external-server-graph.test.ts`, `tests/mcp/graph-tools.test.ts` — unrelated.
- Any test that imports from `src/mcp/server.ts` — verify `createBoberMCPServer` still boots cleanly.

### Features That Could Be Affected

- **bober_run / bober_status MCP surface** — must remain wire-compatible. The JSON output of `bober_status` is `{ runId, status, task, startedAt, progress }` etc. — DO NOT add `projectRoot` or `specId` to those tool responses; they're additions to the internal `RunState` only.
- **bober_brownfield, bober_react, bober_solidity, bober_anchor** — all five tools call `runManager.startRun(...)` with the same 3-arg signature. The new method MUST accept the existing 3-arg call (4-arg with mock for tests) UNCHANGED.
- **`src/index.ts` public API** — `RunManager` class is re-exported. Constructor still takes no args; new instance methods are additive.

### Recommended Regression Checks

After implementation, the Generator MUST run:
1. `npm run typecheck` — passes.
2. `npm run lint` — passes (no `no-restricted-imports` violations; no console.log).
3. `npm run build` — passes.
4. `npm run test` — all 1116 existing tests still green, plus new tests for sc-1-1..sc-1-5.
5. Manual integrity check: `grep -r "runManager.startRun" src/` shows 5 call sites (run/anchor/solidity/brownfield/react) — each with the same 3-arg signature.
6. Manual integrity check: `grep -r "this.activeRun" src/mcp/run-manager.ts` returns NO matches (all replaced by Map operations).

---

## 8. Implementation Sequence

1. **`src/state/run-state.ts`** — create. Implement `writeRunState`, `readRunState`, `listRunStateFiles` using `mkdir` (via `ensureDir`) + `writeFile` (tmp) + `rename`. Import `RunState` type from `../mcp/run-manager.js` with `import type` (no runtime dep — avoids cycle).
   - Verify: file compiles standalone (`npx tsc --noEmit src/state/run-state.ts`).

2. **`src/state/run-state.test.ts`** — create. 8 unit tests covering: atomic write, no .tmp leftovers, 100-concurrent stress, null on missing/corrupt, empty array on no dir, malformed skip, mode 0600. Use `mkdtemp` fixture.
   - Verify: `npm run test -- src/state/run-state` passes in isolation.

3. **`src/state/index.ts`** — modify. Add the `export { writeRunState, readRunState, listRunStateFiles } from "./run-state.js"` block. No other change (subdirs already include "runs").
   - Verify: `npm run typecheck`.

4. **`src/mcp/run-manager.ts`** — refactor.
   - Extend `RunState` interface: add `projectRoot: string` (required), `specId?: string` (optional).
   - Replace `activeRun: RunState | null` with `runs: Map<string, RunState>`.
   - Re-implement `isRunning()`: `Array.from(this.runs.values()).some(s => s.status === "running")`.
   - Re-implement `getStatus()`: return the entry with the lexicographically-largest `startedAt`, or null.
   - Re-implement `startRun()`: REMOVE the `if (this.isRunning()) throw` block; create RunState (including `projectRoot`); `this.runs.set(runId, state)`; **await `writeRunState(projectRoot, state)` BEFORE returning** (sc-1-2); wire `.then`/`.catch` to mutate map entry AND call `writeRunState` again (wrap in try/catch + logger.warn).
   - Add `getRun(runId): RunState | null` — `return this.runs.get(runId) ?? null`.
   - Add `listActiveRuns(): RunState[]` — `Array.from(this.runs.values()).filter(s => s.status === "running")`.
   - Add `abortRun(runId, reason): void` — mutate to `failed` with `error: reason`, set `completedAt`, persist.
   - Add `load(projectRoot): Promise<void>` — `const all = await listRunStateFiles(projectRoot); for each: if status==="running", flip to "failed" with error="orchestrator crashed before completion", set completedAt to now, persist; populate this.runs map`.
   - Keep `export const runManager = new RunManager()` at module scope.
   - Verify: `npm run typecheck`.

5. **`src/mcp/run-manager.test.ts`** — modify.
   - Switch all tests to `mkdtemp` fixture (replace `"/tmp"` with `tmpDir`).
   - DELETE the two "throws when already running" tests (lines 131-153) — behavior removed.
   - ADD new tests for: sc-1-1 (new methods exist), sc-1-2 (state.json synchronously on disk), sc-1-3 (post-resolution disk matches memory + 100-concurrent stress), sc-1-4 (load() flips orphans), sc-1-5 (two concurrent startRuns, getStatus picks newer).
   - Verify: `npm run test -- src/mcp/run-manager` passes.

6. **`src/mcp/server.ts`** — modify. Add `import { runManager } from "./run-manager.js"` and insert the try/catch `await runManager.load(projectRoot)` block right after `registerAllTools()` (line 61).
   - Verify: `npm run typecheck` + `npm run build`.

7. **Full verification** — `npm run typecheck && npm run lint && npm run build && npm run test`. All 1116 prior tests plus the new suite must pass.

---

## 9. Pitfalls & Warnings

- **Do NOT throw from `startRun()`.** Pre-existing tests assert the throw; you must DELETE those tests. The new contract REQUIRES concurrent runs to succeed (see `evaluatorNotes` negative test).
- **Do NOT call `console.log` anywhere in src/mcp/.** stdout is the MCP JSON-RPC transport. Use `process.stderr.write` (server.ts) or `logger` (run-manager.ts).
- **Do NOT swallow disk-write errors silently.** Each persistence call inside `.then`/`.catch` callbacks must `.catch(err => logger.warn(...))` — visible failure, no crash.
- **Do NOT use `fs.appendFile`.** The atomic write here is `writeFile(tmp) + rename`, not append. (For reference, audit.ts:8-12 explains why `appendFile` is banned project-wide for mode-sensitive writes — irrelevant here since you're not appending, but worth knowing.)
- **Do NOT introduce zod for RunState parsing.** The contract's assumption #3 allows it, but no existing state.json file uses zod (see `src/state/approval-state.ts:69`'s plain `JSON.parse`). Stay consistent unless you have a strong reason.
- **Do NOT change the `RunState` JSON shape produced by `bober_status`.** The `nonGoals` are explicit. New fields `projectRoot` and `specId` live in the **persisted** state but `bober_status` tool handler still returns only `{ runId, status, task, startedAt, progress, ...result/error }`.
- **Do NOT touch `src/orchestrator/pipeline.ts`.** `nonGoals`: "Do not touch src/orchestrator/pipeline.ts beyond what's strictly required to thread runId into the pipeline callbacks." For sprint #1, you do NOT need to thread runId — pipeline mutations stay where they are. Progress-callback wiring is feat-3 (later sprint).
- **Beware of `import type` cycles.** `src/state/run-state.ts` imports `RunState` from `../mcp/run-manager.js`; `src/mcp/run-manager.ts` imports the persistence functions from `../state/run-state.js`. Use `import type { RunState }` in `run-state.ts` to break the runtime cycle — TypeScript erases type-only imports.
- **Beware of `.bober/runs/` directory not existing on load.** First-ever `load()` call on a fresh project. `listRunStateFiles` already returns `[]` on ENOENT — verify with a unit test that runs `load()` against a directory with no `.bober/`.
- **Beware test pollution.** Existing tests pass `"/tmp"` as projectRoot. After this sprint, those tests will write actual files there. Convert ALL existing tests to `mkdtemp` BEFORE running the suite, or you'll get phantom failures.
- **The `dist/mcp/` path comment in server.ts:31 is correct** — `__dirname` resolves to `dist/mcp/` at runtime. Don't touch the path math; `runManager.load(projectRoot)` doesn't share that concern (it uses the runtime `projectRoot` arg directly).
