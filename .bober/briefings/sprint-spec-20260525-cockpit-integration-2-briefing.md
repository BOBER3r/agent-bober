# Sprint Briefing: Multi-run MCP tools: list, get, and abort by runId

**Contract:** sprint-spec-20260525-cockpit-integration-2
**Generated:** 2026-05-25T00:00:00Z

---

## 0. Critical Tension Between Contract and Existing Code

**You must resolve this before writing code.** The contract success criteria specify:

- sc-2-1: `bober_list_active_runs` accepts an optional filter `{ status?: 'running'|'completed'|'failed'|'aborted' }`.
- sc-2-3: `bober_abort_run` flips state to **`status='aborted'`**, persists `{ reason, abortedAt }`, returns `{ runId, status: 'aborted', abortedAt }`.

But the Sprint 1 `RunState.status` type only allows `"running" | "completed" | "failed"` (no `"aborted"`), and `RunManager.abortRun()` currently sets `status = "failed"` and stores `reason` in `state.error` with no `abortedAt` field:

```ts
// src/mcp/run-manager.ts:35-46
export interface RunState {
  runId: string;
  task: string;
  status: "running" | "completed" | "failed";    // ← no "aborted"
  startedAt: string;
  completedAt?: string;                           // ← no abortedAt
  progress: RunProgress;
  result?: RunResult;
  error?: string;
  projectRoot: string;
  specId?: string;
}

// src/mcp/run-manager.ts:99-112
abortRun(runId: string, reason: string): void {
  const state = this.runs.get(runId);
  if (!state) return;
  state.status = "failed";                        // ← sets "failed" not "aborted"
  state.completedAt = new Date().toISOString();   // ← sets completedAt not abortedAt
  state.error = reason;
  ...
}
```

**Resolution (must follow):**

1. **Extend `RunState.status` union** to `"running" | "completed" | "failed" | "aborted"` in `src/mcp/run-manager.ts:38`. This is a low-risk type widening — all `switch` / `if` chains over `status` already handle the three existing values; the only new value is one your new tool produces.
2. **Add optional `abortedAt?: string` and `abortReason?: string` fields** to `RunState` so persisted state.json can carry them. Do **not** repurpose `error` for the reason — `error` semantically belongs to pipeline crashes.
3. **Update `RunManager.abortRun()`** to set `status = "aborted"`, set `abortedAt = new Date().toISOString()`, and set `abortReason = reason`. Keep `completedAt` undefined for aborted runs (or also set it — but `abortedAt` is what the contract returns).
4. **Update `RunManager.load()`** at `src/mcp/run-manager.ts:213-232` — the orphan-reconciliation path currently flips `running` → `failed`. Leave that alone (a process crash mid-run is still a failure, not a user abort).
5. **Audit existing tests**: `src/mcp/run-manager.test.ts:402-416` ("abortRun sets status to 'failed' with the given reason") currently asserts `status === "failed"` and `error === reason`. You must update those assertions to the new shape, or those tests will break.
6. **Update the existing test list of expected tool names** in `src/mcp/tools/tools.test.ts` from 17 → 20 and add the three new names.

The contract explicitly notes this is an estimatedFiles list, not a complete list — `src/mcp/run-manager.ts` and `src/mcp/run-manager.test.ts` are NOT in `estimatedFiles` but MUST be modified to satisfy sc-2-3. Treat them as required additions.

---

## 1. Target Files

### src/mcp/tools/list-active-runs.ts (create)

**Directory pattern:** Files in `src/mcp/tools/` use **dash-case** (`run.ts`, `status.ts`, `contracts.ts`, `playwright.ts`). Multi-word tool files: `playwright.ts` is single-word but the new tools `list-active-runs.ts`, `get-run-status.ts`, `abort-run.ts` follow the dash-case rule explicitly stated in `estimatedFiles`.

**Most similar existing file:** `src/mcp/tools/status.ts` — read-only, JSON-stringified state from `runManager`, no McpError throws (pure soft-error JSON).

**Structure template:**
```ts
// ── bober_list_active_runs tool ──────────────────────────────────────
//
// Returns all known runs as a JSON array, optionally filtered by status.

import { registerTool } from "./registry.js";
import { runManager } from "../run-manager.js";

export function registerListActiveRunsTool(): void {
  registerTool({
    name: "bober_list_active_runs",
    description:
      "List all runs tracked by the multi-run RunManager. " +
      "Optionally filter by status. Returns an array of RunState objects.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["running", "completed", "failed", "aborted"],
          description: "Optional status filter. Omit to return all runs.",
        },
      },
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>): Promise<string> => {
      // NOTE: RunManager.listActiveRuns() currently returns ONLY runs with
      // status='running'. The contract wants this tool to be filterable across
      // all statuses (sc-2-1), so the handler must enumerate all runs via a
      // new helper or iterate the in-memory map. Two options:
      //   (a) Add `RunManager.listAllRuns(): RunState[]` and filter in the handler.
      //   (b) When `args.status === undefined || args.status === 'running'`, use
      //       listActiveRuns(); for other filters, fall back to (a).
      // Recommendation: add `listAllRuns()` to RunManager — simpler, no special-case.
      ...
    },
  });
}
```

---

### src/mcp/tools/get-run-status.ts (create)

**Most similar existing file:** `src/mcp/tools/status.ts` (singleton lookup) + `src/mcp/tools/contracts.ts` lines 38-54 (lookup-by-id with soft-error JSON when not found).

**inputSchema (from generatorNotes, must match exactly):**
```ts
inputSchema: {
  type: "object",
  properties: {
    runId: { type: "string" },
  },
  required: ["runId"],
  additionalProperties: false,
},
```

**Handler shape:**
```ts
handler: async (args: Record<string, unknown>): Promise<string> => {
  const runId = typeof args.runId === "string" ? args.runId.trim() : "";
  if (!runId) {
    // Negative test from evaluatorNotes: missing runId arg throws McpError InvalidRequest
    throw new McpError(ErrorCode.InvalidRequest, "runId is required and must be a non-empty string.");
  }
  const state = runManager.getRun(runId);
  if (state === null) {
    // Soft error per sc-2-2
    return JSON.stringify({ error: `Run not found: ${runId}` }, null, 2);
  }
  return JSON.stringify(state, null, 2);
},
```

---

### src/mcp/tools/abort-run.ts (create)

**Most similar existing file:** `src/mcp/tools/run.ts` for the action-tool shape; soft-error JSON pattern from `status.ts:33-50`.

**Behavior contract (sc-2-3):**
- If run is `running` → flip to `aborted`, return `{ runId, status: "aborted", abortedAt }`.
- If run does not exist → return `{ error: "Run not found: <runId>" }` (matches sc-2-2 convention — be consistent).
- If run exists but is not currently `running` (already completed/failed/aborted) → return `{ error: "Run is not active" }`.
- Hard config / IO errors → throw `McpError(ErrorCode.InternalError, ...)`.

**Handler shape:**
```ts
handler: async (args: Record<string, unknown>): Promise<string> => {
  const runId = typeof args.runId === "string" ? args.runId.trim() : "";
  if (!runId) {
    throw new McpError(ErrorCode.InvalidRequest, "runId is required and must be a non-empty string.");
  }
  const reason = typeof args.reason === "string" ? args.reason : "Aborted by user";

  const state = runManager.getRun(runId);
  if (state === null) {
    return JSON.stringify({ error: `Run not found: ${runId}` }, null, 2);
  }
  if (state.status !== "running") {
    return JSON.stringify({ error: "Run is not active" }, null, 2);
  }

  runManager.abortRun(runId, reason);
  const updated = runManager.getRun(runId)!; // guaranteed to exist
  return JSON.stringify(
    { runId: updated.runId, status: updated.status, abortedAt: updated.abortedAt },
    null,
    2,
  );
},
```

---

### src/mcp/tools/index.ts (modify)

**Relevant section (lines 1-72):** Add three new imports next to the existing block (lines 6-22), and call the three `register*` functions inside `registerAllTools()`. Bump the JSDoc count from `(17 total)` → `(20 total)` per generatorNotes.

**Specific edits:**
```ts
// Add after line 12 (with the other "core registry" imports):
import { registerListActiveRunsTool } from "./list-active-runs.js";
import { registerGetRunStatusTool } from "./get-run-status.js";
import { registerAbortRunTool } from "./abort-run.js";

// Update JSDoc at lines 28-46: bump "17 total" → "20 total"
// and add lines 18-20:
//  18. bober_list_active_runs – List all runs by status
//  19. bober_get_run_status   – Get one run by runId
//  20. bober_abort_run        – Abort a run by runId

// In registerAllTools(), under "Async pipeline tools" (lines 56-62), add after registerStatusTool():
registerListActiveRunsTool();
registerGetRunStatusTool();
registerAbortRunTool();
```

**Imports this file uses:** `./init.js`, `./plan.js`, …, `./registry.js` (all `.js` ESM extensions — note the `.js` suffix even for `.ts` source; this is the project's ESM convention).

**Imported by:** `src/mcp/server.ts` (and `src/mcp/tools/tools.test.ts` via dynamic `import("./index.js")`).

**Test file:** `src/mcp/tools/tools.test.ts` — exists, MUST be updated (see Section 7 below).

---

### src/mcp/run-manager.ts (modify — REQUIRED, not in estimatedFiles)

**Relevant section (lines 35-46) — extend RunState:**
```ts
// BEFORE
export interface RunState {
  runId: string;
  task: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  progress: RunProgress;
  result?: RunResult;
  error?: string;
  projectRoot: string;
  specId?: string;
}

// AFTER
export interface RunState {
  runId: string;
  task: string;
  status: "running" | "completed" | "failed" | "aborted";  // ← add "aborted"
  startedAt: string;
  completedAt?: string;
  abortedAt?: string;           // ← new
  abortReason?: string;         // ← new
  progress: RunProgress;
  result?: RunResult;
  error?: string;
  projectRoot: string;
  specId?: string;
}
```

**Relevant section (lines 99-112) — rework abortRun:**
```ts
// AFTER
abortRun(runId: string, reason: string): void {
  const state = this.runs.get(runId);
  if (!state) return;
  state.status = "aborted";
  state.abortedAt = new Date().toISOString();
  state.abortReason = reason;
  writeRunState(state.projectRoot, state).catch((err: unknown) => {
    logger.warn(
      `[RunManager.abortRun] Failed to persist aborted state for ${runId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });
}
```

**Add a new method** for the list tool:
```ts
/**
 * Return ALL known runs regardless of status (for bober_list_active_runs filtering).
 */
listAllRuns(): RunState[] {
  return Array.from(this.runs.values());
}
```

**Verify other status-switches still work:** `src/mcp/tools/status.ts:54-97` uses an if/else over `running`/`completed`/`failed`. The `failed` branch is the fallthrough — an `aborted` run rendered through `bober_status` will appear in the fallthrough branch. That branch references `state.error` (which won't be set for aborts). Confirm this with the user / accept it as acceptable degradation, or add an explicit `aborted` branch to `status.ts`.

**Imported by:**
- `src/mcp/tools/run.ts` (singleton + isRunning + getStatus)
- `src/mcp/tools/status.ts` (singleton + getStatus)
- `src/state/run-state.ts` (RunState type only)
- `src/mcp/run-manager.test.ts`
- (new) `src/mcp/tools/list-active-runs.ts`, `get-run-status.ts`, `abort-run.ts`

**Test file:** `src/mcp/run-manager.test.ts` — exists, MUST be updated (assertions at lines 402-415).

---

### CHANGELOG.md (modify)

**Current top section:** `## [0.14.0] — 2026-05-25` (already released).

**Action:** Prepend a new `## [Unreleased]` section above `[0.14.0]` per sc-2-5. Document the three new tools (name, inputSchema summary, return shape) under an `### Added` subheading. Optional but required-by-format.

---

## 2. Patterns to Follow

### Pattern A: MCP tool module file shape
**Source:** `src/mcp/tools/status.ts:1-100` and `src/mcp/tools/run.ts:1-92`

Every tool file follows this layout:
1. `// ── <tool_name> tool ────────────────…` banner comment with 1-paragraph spec.
2. `import` block (node:* first, then SDK, then internal `./` and `../` imports, all with `.js` extension).
3. `export function register<ToolName>Tool(): void { registerTool({ name, description, inputSchema, handler }); }`.
4. No default exports. No top-level side effects (registration happens only when `register*Tool()` is called).

**Rule:** Use a single named export `register<ToolName>Tool()`. The handler is an `async (args: Record<string, unknown>) => Promise<string>` that returns `JSON.stringify(payload, null, 2)`.

### Pattern B: Soft errors return JSON, hard errors throw McpError
**Source:** `src/mcp/tools/run.ts:37-72` (mixed), `src/mcp/tools/status.ts:33-50` (pure soft), `src/mcp/tools/contracts.ts:38-54` (pure soft)

```ts
// HARD error — config missing, concurrency conflict, malformed required field:
throw new McpError(ErrorCode.InvalidRequest, "task is required …");
// src/mcp/tools/run.ts:49-53

// SOFT error — entity not found, validation of optional state:
return JSON.stringify({ error: `Contract "${contractId}" not found.`, details: ... }, null, 2);
// src/mcp/tools/contracts.ts:43-53
```

**Rule applied to this sprint (per generatorNotes):**
- Missing/empty `runId` arg → **hard** McpError(InvalidRequest).
- Unknown runId / run not active → **soft** JSON `{ error: "..." }`.
- IO failure persisting aborted state → swallow + log via `logger.warn` (already handled inside RunManager).

### Pattern C: JSON-stringified return with indent=2
**Source:** Every existing tool: `run.ts:79`, `status.ts:43`, `contracts.ts:42`, `spec.ts:30`.

```ts
return JSON.stringify(payload, null, 2);
```

**Rule:** Always pretty-print with `, null, 2)` for human-readable MCP client output.

### Pattern D: Singleton `runManager` import
**Source:** `src/mcp/tools/run.ts:13`, `src/mcp/tools/status.ts:13`

```ts
import { runManager } from "../run-manager.js";
```

**Rule:** All three new tools import the SAME singleton from `../run-manager.js`. Do NOT instantiate a new `RunManager` — that would create an isolated in-memory map disconnected from the real one.

### Pattern E: Arg-extraction idiom
**Source:** `src/mcp/tools/run.ts:37`, `src/mcp/tools/contracts.ts:33-36`

```ts
const task = String(args.task ?? "").trim();
const contractId = typeof args.contractId === "string" && args.contractId.trim()
  ? args.contractId.trim()
  : undefined;
```

**Rule:** Args come in as `Record<string, unknown>`. Use `typeof === "string"` checks or `String(args.x ?? "").trim()` — never trust the shape.

### Pattern F: ESM `.js` import extension
**Source:** Every file in `src/mcp/tools/`.

```ts
import { registerTool } from "./registry.js";       // ← .js even though source is registry.ts
import { runManager } from "../run-manager.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
```

**Rule:** All relative imports MUST end in `.js`. Project is `"type": "module"` with `tsc` compilation; missing extensions break runtime resolution.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `runManager` (singleton) | `src/mcp/run-manager.ts:237` | `RunManager` instance | The one and only multi-run state container. Always import this — do not `new RunManager()`. |
| `RunManager.getRun` | `src/mcp/run-manager.ts:84-86` | `(runId: string) => RunState \| null` | Lookup by id; returns null if unknown. |
| `RunManager.listActiveRuns` | `src/mcp/run-manager.ts:91-93` | `() => RunState[]` | Returns only `status === 'running'`. Need a sibling `listAllRuns()` for sc-2-1 filtering. |
| `RunManager.abortRun` | `src/mcp/run-manager.ts:99-112` | `(runId, reason) => void` | Best-effort abort + persistence. MUST be reworked to set `status='aborted'` per Section 0. |
| `RunManager.load` | `src/mcp/run-manager.ts:213-232` | `(projectRoot) => Promise<void>` | Crash recovery on startup. Untouched by this sprint. |
| `RunManager.isRunning` | `src/mcp/run-manager.ts:59-61` | `() => boolean` | Back-compat for bober_run concurrency check. |
| `RunManager.getStatus` | `src/mcp/run-manager.ts:70-79` | `() => RunState \| null` | Back-compat for bober_status. Returns newest. |
| `writeRunState` | `src/state/run-state.ts:41-53` | `(projectRoot, state) => Promise<void>` | Atomic temp-file + rename. Already called inside `RunManager.abortRun` — no need to call directly from tools. |
| `readRunState` | `src/state/run-state.ts:61-68` | `(projectRoot, runId) => Promise<RunState \| null>` | Returns null on missing/malformed — never throws. |
| `listRunStateFiles` | `src/state/run-state.ts:78-93` | `(projectRoot) => Promise<RunState[]>` | Enumerate disk state files. Not needed by tools — RunManager already loads them at startup. |
| `registerTool` | `src/mcp/tools/registry.ts:45-47` | `(tool: BoberToolDefinition) => void` | Adds to the global registry Map. Overwrites by name. |
| `getAllTools` | `src/mcp/tools/registry.ts:52-54` | `() => BoberToolDefinition[]` | Used by `tools/list` MCP handler and by tools.test.ts. |
| `getTool` | `src/mcp/tools/registry.ts:59-61` | `(name) => BoberToolDefinition \| undefined` | Lookup by name. Use in tests to invoke a handler directly. |
| `McpError`, `ErrorCode` | `@modelcontextprotocol/sdk/types.js` | constructor + enum | `new McpError(ErrorCode.InvalidRequest, msg)`. The codes used in the project so far are `InvalidRequest` and `InternalError`. |
| `logger.warn` | `src/utils/logger.js` | `(msg: string) => void` | Used by RunManager for best-effort IO warnings; tools rarely log directly. |

---

## 4. Prior Sprint Output

### Sprint 1: Multi-run RunManager with disk persistence and crash recovery
**Created/modified:** `src/mcp/run-manager.ts`, `src/state/run-state.ts`, `src/state/run-state.test.ts`, `src/mcp/run-manager.test.ts`

**Key exports relevant to Sprint 2:**
- `runManager` (singleton instance)
- `RunManager` (class) with methods: `getRun`, `listActiveRuns`, `abortRun`, `load`, `startRun`, `getStatus`, `isRunning`
- `RunState`, `RunProgress`, `RunResult` (types)
- `writeRunState`, `readRunState`, `listRunStateFiles` (disk helpers)

**Connection to Sprint 2:** Sprint 2 wraps each of `getRun`, `listActiveRuns`, `abortRun` in an MCP tool. Sprint 2 also EXTENDS the `RunState` type and the `abortRun` semantics to add the missing `aborted` status that the cockpit UX needs (see Section 0).

**Behavior contract from Sprint 1:**
- `getRun(unknownId)` → returns `null`, never throws.
- `abortRun(unknownId, ...)` → silent no-op, never throws.
- All state mutations are persisted asynchronously inside RunManager (best-effort); tools should NOT call `writeRunState` directly.
- The in-memory map is populated on server startup via `runManager.load(projectRoot)`.

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` file is present in the repo. The de facto principles enforced via existing patterns:
- TypeScript strict, ESM (`type: module`), `.js` extensions in source imports.
- Soft errors (validation, not-found) return JSON; hard errors (config missing, concurrency) throw `McpError`.
- Singleton state lives in module scope (`runManager`, the `registry` Map).
- Tests use Vitest, `describe/it/expect`, and tmpdir fixtures for filesystem state.

### Architecture Decisions
No formal ADR directory in repo. Relevant inline design comments:
- `src/mcp/run-manager.ts:1-9` — RunManager design notes (back-compat goals, disk layout).
- `src/state/run-state.ts:1-9` — atomic-write rationale (mirrors `incident/timeline.ts:86-92`).

### Other Docs
- **CHANGELOG.md** — current top section is `## [0.14.0] — 2026-05-25` (released). sc-2-5 requires prepending a new `## [Unreleased]` section.
- **package.json scripts** (sc-2-6): `npm run typecheck` (`tsc --noEmit`), `npm run lint` (`eslint src/`), `npm run build` (`tsc`), `npm run test` (`vitest`).

---

## 6. Testing Patterns

### Runner / framework
- **Vitest** with default config (no `vitest.config.ts` at repo root). Test files match `**/*.test.ts`.
- Assertion style: `expect(x).toBe(...)`, `.toMatchObject(...)`, `.toBeNull()`, `.toHaveLength(...)`.
- Mocks: `vi.fn().mockResolvedValue(...)`, `vi.fn().mockReturnValue(...)`. Module mocking via `vi.mock(...)` is used elsewhere but not in tool tests.
- File naming: co-located `<name>.test.ts` next to `<name>.ts`.
- Location: per-tool tests will go in `src/mcp/tools/<name>.test.ts`.

### Pattern: Direct handler invocation via `getTool`
The existing `src/mcp/tools/tools.test.ts` only tests REGISTRATION. For per-tool behavior tests there is no current example in `src/mcp/tools/`. Use this template, adapted from how `getTool` is exposed and how `RunManager` is tested:

```ts
// src/mcp/tools/list-active-runs.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerListActiveRunsTool } from "./list-active-runs.js";
import { getTool } from "./registry.js";
import { runManager } from "../run-manager.js";
import type { PipelineResult } from "../../orchestrator/pipeline.js";

describe("bober_list_active_runs", () => {
  beforeEach(() => {
    // Register the tool fresh into the shared registry
    registerListActiveRunsTool();
    // Reset the singleton's internal map — see "Pitfalls" below
    (runManager as unknown as { runs: Map<string, unknown> }).runs.clear();
  });

  it("is registered with name bober_list_active_runs", () => {
    expect(getTool("bober_list_active_runs")).toBeDefined();
  });

  it("returns an empty array when no runs exist", async () => {
    const tool = getTool("bober_list_active_runs")!;
    const result = JSON.parse(await tool.handler({}));
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it("returns running runs when no status filter is given", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "bober-list-test-"));
    try {
      const neverResolves = new Promise<PipelineResult>(() => {});
      const mockPipeline = vi.fn().mockReturnValue(neverResolves);
      // … startRun … then call handler … assert length=1, status='running'
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("filters by status='aborted' after abortRun", async () => {
    // … start a run, abort it, call handler({ status: 'aborted' }), assert length=1
  });
});
```

### Source patterns to reuse in test setup
- **Tmpdir fixture** (`src/mcp/run-manager.test.ts:31-39`):
  ```ts
  let tmpDir: string;
  beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-X-test-")); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });
  ```
- **`makeFakeConfig()`** helper (`src/mcp/run-manager.test.ts:43-70`) — copy into tool tests if you need to call `runManager.startRun()`.
- **`makeFakePipelineResult()`** helper (`src/mcp/run-manager.test.ts:72-91`) — for tests that need a real resolved pipeline.
- **never-resolves pipeline** (`src/mcp/run-manager.test.ts:115-116`):
  ```ts
  const neverResolves = new Promise<PipelineResult>(() => {});
  const mockPipeline = vi.fn().mockReturnValue(neverResolves);
  ```

### E2E Test Pattern
A Playwright config exists for E2E (`tests/e2e/four-modes.test.ts`) but it is not relevant to MCP tool unit tests. No E2E coverage required for this sprint per success criteria.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/mcp/tools/run.ts` | `RunState`/`runManager` | Low | Adds new status value, no breaking removal. Only uses `runManager.isRunning()` and `runManager.getStatus()`. |
| `src/mcp/tools/status.ts` | `RunState`/`runManager` | **Medium** | `status.ts:54-97` uses an if/else chain over `running`/`completed`/`failed`. An `aborted` run will hit the fallthrough `failed` branch — output will mislabel an aborted run as failed. Add an explicit `aborted` branch OR accept the degradation (recommend explicit branch). |
| `src/state/run-state.ts` | `RunState` type | Low | Type widening is forward-compatible. JSON.stringify/parse of new fields is automatic. |
| `src/mcp/run-manager.test.ts` | `RunManager.abortRun` behavior | **High** | Assertions at lines 402-415 hardcoded `status === "failed"` and `error === reason`. MUST be rewritten to `status === "aborted"`, `abortReason === reason`, `abortedAt` truthy. |
| `src/mcp/tools/tools.test.ts` | `getAllTools().length` | **High** | Hardcoded `expect(tools.length).toBe(17)` (line 11) and the expected names array (lines 18-36). Must bump to 20 and append the three new names. |
| `src/state/run-state.test.ts` | `RunState` shape | Low | If it serializes a sample state and round-trips it, the new optional fields will not appear — backward-compatible. Verify. |
| `src/mcp/server.ts` (if exists, tools/list handler) | `getAllTools()` | Low | Already iterates dynamically — new tools surface automatically. |

### Existing Tests That Must Still Pass
- `src/mcp/run-manager.test.ts` (~30 tests covering RunManager) — must pass with updated abortRun assertions.
- `src/mcp/tools/tools.test.ts` (3 tests covering registration count + names) — must pass with bumped count and appended names.
- `src/state/run-state.test.ts` — should pass without change (type widening only).
- The full Sprint 1 suite (1142 tests passing) — none of the other 1100+ tests touch `RunManager.abortRun` directly; risk is contained.

### Features That Could Be Affected
- **`bober_status` (existing feature)** — shares the `RunState.status` union. The `failed` branch fallthrough will incorrectly render aborted runs unless updated. Add an `aborted` branch.
- **`bober_run` concurrency check** — uses `isRunning()`. `isRunning()` is unchanged (still checks for `status === "running"`); aborted runs no longer count as running, which is the correct behavior for "can I start a new run?"
- **Crash recovery in `RunManager.load`** — unchanged; orphan runs still flip to `failed`, not `aborted`. This is correct: a crashed run is not a user-initiated abort.
- **Cockpit (future feature in this spec)** — depends on this sprint's three tools to enumerate and control runs.

### Recommended Regression Checks
After implementation, the Generator MUST verify:
1. `npm run typecheck` — ensures the widened union and new fields type-check across all `status === "..."` consumers.
2. `npm run lint` — ESLint passes on the three new files.
3. `npm run test -- src/mcp/run-manager.test.ts` — passes after updating the abortRun assertions.
4. `npm run test -- src/mcp/tools/tools.test.ts` — passes after bumping count 17→20 and appending names.
5. `npm run test -- src/mcp/tools/list-active-runs.test.ts src/mcp/tools/get-run-status.test.ts src/mcp/tools/abort-run.test.ts` — all three new test files pass.
6. `npm run test` — the entire 1142+-test suite is green.
7. `npm run build` — `tsc` produces `dist/` artifacts.
8. Manual: invoke `bober_list_active_runs` via stdio JSON-RPC and verify it returns the runs created in Sprint 1's persistence layer (stop condition #3).

---

## 8. Implementation Sequence

1. **`src/mcp/run-manager.ts`** — extend `RunState` (add `"aborted"` to union, add `abortedAt?`, `abortReason?`), rework `abortRun()` to set `status="aborted" + abortedAt + abortReason`, add `listAllRuns()` method.
   - Verify: `npm run typecheck` passes.
2. **`src/mcp/run-manager.test.ts`** — update the abortRun assertions (lines 402-415) to expect `status === "aborted"`, `abortReason === reason`, `abortedAt` truthy. Add a new test for `listAllRuns()`.
   - Verify: `npm run test -- src/mcp/run-manager.test.ts` passes.
3. **`src/mcp/tools/status.ts`** — add an explicit `aborted` branch in the if/else chain at lines 54-97 to render the aborted state cleanly (returning `runId, status, task, startedAt, abortedAt, abortReason`).
   - Verify: `npm run typecheck` passes; `bober_status` test (if any) still passes.
4. **`src/mcp/tools/list-active-runs.ts`** — create per Section 1. Uses `runManager.listAllRuns()` for filterable listing.
   - Verify: file compiles; exports `registerListActiveRunsTool`.
5. **`src/mcp/tools/get-run-status.ts`** — create per Section 1. Uses `runManager.getRun(runId)`.
   - Verify: file compiles; exports `registerGetRunStatusTool`.
6. **`src/mcp/tools/abort-run.ts`** — create per Section 1. Uses `runManager.getRun()` + `runManager.abortRun()`.
   - Verify: file compiles; exports `registerAbortRunTool`.
7. **`src/mcp/tools/index.ts`** — import and call the three new register functions; bump JSDoc tool count 17→20; add new bullet lines 18-20 in JSDoc.
   - Verify: `npm run typecheck` passes.
8. **`src/mcp/tools/tools.test.ts`** — bump `expect(tools.length).toBe(17)` → `20`; append `"bober_list_active_runs"`, `"bober_get_run_status"`, `"bober_abort_run"` to the expected names array.
   - Verify: `npm run test -- src/mcp/tools/tools.test.ts` passes.
9. **`src/mcp/tools/list-active-runs.test.ts`** — create per Section 6. Cover: registered with correct name; empty case; running runs returned by default; status filter for each enum value (especially `aborted`); response is JSON-parseable array.
   - Verify: `npm run test -- src/mcp/tools/list-active-runs.test.ts` passes.
10. **`src/mcp/tools/get-run-status.test.ts`** — create. Cover: registered with correct name; known runId returns full RunState; unknown runId returns `{ error: 'Run not found: ...' }`; missing runId arg throws McpError(InvalidRequest) (negative test from evaluatorNotes).
    - Verify: `npm run test -- src/mcp/tools/get-run-status.test.ts` passes.
11. **`src/mcp/tools/abort-run.test.ts`** — create. Cover: registered with correct name; running run flips to aborted and returns `{ runId, status: 'aborted', abortedAt }`; subsequent `getRun` reflects aborted state (atomicity check from DoD); already-completed run returns `{ error: 'Run is not active' }`; unknown runId returns `{ error: 'Run not found: ...' }`; missing runId arg throws McpError.
    - Verify: `npm run test -- src/mcp/tools/abort-run.test.ts` passes.
12. **`CHANGELOG.md`** — prepend `## [Unreleased]` section with `### Added` listing the three tool names, inputSchema summary, and return shape.
    - Verify: file is valid markdown.
13. **Run full verification** — `npm run typecheck && npm run lint && npm run build && npm run test`. Manual sanity: invoke `bober_list_active_runs` via stdio (optional, evaluator-level).

---

## 9. Pitfalls & Warnings

- **Singleton state leak across tests.** `runManager` is a module-scoped singleton (`src/mcp/run-manager.ts:237`). Vitest runs test files in parallel workers by default, but tests in the same file share the singleton. Each new tool test file MUST reset the singleton in `beforeEach` (e.g., `(runManager as unknown as { runs: Map<string, unknown> }).runs.clear()`) to avoid cross-test contamination. Inspect `src/mcp/run-manager.test.ts` — it side-steps this by always using `new RunManager()` directly. Your tool tests cannot — they must use the shared singleton because the tool handler imports it. Reset the internal map between tests.
- **The `registerTool` registry is also module-scoped.** Calling `registerAllTools()` in one test then `register<X>Tool()` in another in the same worker leaves leftover entries. Use `getTool("bober_list_active_runs")` after explicitly calling `registerListActiveRunsTool()` in `beforeEach` — do not depend on whether `registerAllTools()` has run.
- **Do NOT call `writeRunState` from inside the tool handlers.** RunManager already persists internally. Calling it again from the tool would double-write and race against the internal `.catch` chain.
- **The `cwd()` pattern is shared by other tools** (`status.ts:34`, `run.ts:44`, `contracts.ts:32`). Your three new tools do NOT need `projectRoot` — RunManager already has it stored per-run. Do not import `cwd()` unnecessarily.
- **`.js` extension in every relative import.** Forgetting this passes typecheck but breaks at runtime. See Pattern F.
- **`additionalProperties: false`** in every inputSchema — match the existing convention (`run.ts:34`, `status.ts:27`, `contracts.ts:30`). MCP clients rely on this to validate.
- **inputSchema for `bober_get_run_status` must be exactly as generatorNotes specifies:**
  ```ts
  { type: "object", properties: { runId: { type: "string" } }, required: ["runId"], additionalProperties: false }
  ```
  The evaluator will check this verbatim.
- **The `status` enum in `bober_list_active_runs` inputSchema must list all four values:** `"running" | "completed" | "failed" | "aborted"`. Match the new RunState union exactly.
- **Do not introduce new npm dependencies** (nonGoal #4). Use `@modelcontextprotocol/sdk` McpError/ErrorCode, the existing `runManager`, and Vitest. Nothing else.
- **Do not modify `bober_status`'s INPUT or OUTPUT schema** (nonGoal #1). You MAY add an `aborted` branch internally (recommended) since it doesn't change the output shape — it just adds a new case to the existing if/else chain. If unsure, accept the degradation and let aborted runs fall through to the `failed` branch with an undefined `error` field.
- **Sprint 1 noted `RunState.specId` is optional.** It's not used by any of the three new tools. Don't add it to inputSchemas.
- **The `dist/` directory has stale `.d.ts` files.** Grep matches in `dist/` are NOT authoritative — always trust `src/`. Run `npm run build` after changes to regenerate.
- **Tool naming convention is `bober_<noun_verb>` per assumptions.** Use exactly: `bober_list_active_runs`, `bober_get_run_status`, `bober_abort_run`. The evaluator checks tool names verbatim.
- **`logger.warn` exists in `src/utils/logger.ts` (imported as `.js`).** Tools don't typically log; RunManager already handles persistence-failure logging.
- **CHANGELOG must use `## [Unreleased]`** (Keep-a-Changelog convention — the file header references `keepachangelog.com/en/1.1.0/`).
