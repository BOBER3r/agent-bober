# Sprint Briefing: Careful-flow MCP wrappers + project/spec discovery MCP

**Contract:** sprint-spec-20260525-cockpit-integration-5
**Generated:** 2026-05-25T18:30:00Z

Six new MCP tools that complete the cockpit sidebar surface:

- **Careful-flow wrappers (a)** — `bober_list_pending_approvals`, `bober_approve_checkpoint`, `bober_reject_checkpoint`. Thin MCP adapters that share state with the existing `bober approve` / `bober reject` / `bober list-approvals` CLI commands by writing the SAME marker file shapes to `.bober/approvals/`.
- **Discovery tools (b)** — `bober_list_projects`, `bober_list_specs`, `bober_get_project_state`. Read-only filesystem walkers. Do NOT instantiate `RunManager`; use a new `readRunStatesFromDisk(projectRoot)` helper added to `src/state/run-state.ts` for cross-project queries.

After this sprint the tool count goes **23 → 29**.

---

## 1. Target Files

### `src/state/approval-state.ts` (modify — ADD `listPendingApprovals`)

**Current state — full file is 156 lines, fully read.** Already exports `pendingExists`, `listPending` (returns `PendingMarker[]` — the FULL marker, not the cockpit-shape), `savePending`, `saveApproved`, `saveRejected`, `readPending`, `deletePending`. Types `PendingMarker`, `ApprovedMarker`, `RejectedMarker` exposed.

**What to add (NEW export, append after `pendingExists`):**

```ts
/**
 * Cockpit-shape pending row — what both the CLI (--json) and the MCP
 * tool bober_list_pending_approvals should return.
 */
export interface PendingApprovalRow {
  checkpointId: string;
  ageMs: number;
  prompt: string;
}

/**
 * List all pending checkpoints in cockpit-row shape.
 *
 * Mirrors the row-builder loop in src/cli/commands/list-approvals.ts
 * (lines 48-80) but lives in state/ so both the CLI and the MCP tool
 * can share it. Reads .bober/approvals/*.pending.json.
 *
 * Behavior:
 * - Missing approvals dir → returns [].
 * - Corrupted JSON files → skipped silently (matches CLI behavior).
 * - ageMs = Date.now() - Date.parse(requestedAt).
 */
export async function listPendingApprovals(
  projectRoot: string,
): Promise<PendingApprovalRow[]> {
  let entries: string[];
  try {
    entries = await readdir(approvalsDir(projectRoot));
  } catch {
    return [];
  }
  const rows: PendingApprovalRow[] = [];
  for (const f of entries.filter((x) => x.endsWith(".pending.json"))) {
    try {
      const raw = await readFile(join(approvalsDir(projectRoot), f), "utf-8");
      const parsed = JSON.parse(raw) as {
        checkpointId: string;
        prompt: string;
        requestedAt: string;
      };
      rows.push({
        checkpointId: parsed.checkpointId,
        ageMs: Date.now() - Date.parse(parsed.requestedAt),
        prompt: parsed.prompt,
      });
    } catch {
      // skip corrupted files
    }
  }
  return rows;
}
```

**Imports already at top of file (re-use, do NOT re-import):** `readFile, writeFile, readdir, unlink, access` from `node:fs/promises`; `constants` from `node:fs`; `join` from `node:path`; `ensureDir` from `./helpers.js`.

**Imported by (after sprint):**
- `src/cli/commands/list-approvals.ts` (REFACTOR — see below)
- `src/mcp/tools/list-pending-approvals.ts` (NEW)
- `src/mcp/tools/get-project-state.ts` (NEW — uses `rows.length` for `pendingApprovalCount`)
- existing: `src/cli/commands/approve.ts:18`, `src/cli/commands/reject.ts:18`, `src/state/index.ts:67-78`

**Also export from `src/state/index.ts`:** Add `listPendingApprovals, type PendingApprovalRow` to the existing approval-state re-export block (lines 67-78).

**Test file:** `src/state/approval-state.test.ts` does NOT exist. The existing `listPending` is tested at `src/cli/commands/list-approvals.test.ts:62-138`. Mirror that pattern in a new `src/state/approval-state.test.ts` for the new helper (or add to the same colocated CLI test — pick the state-side file for clarity).

---

### `src/state/run-state.ts` (modify — ADD `readRunStatesFromDisk`)

**Current full file (94 lines, fully read).** Exports `writeRunState(projectRoot, state)`, `readRunState(projectRoot, runId)`, `listRunStateFiles(projectRoot)`. The last is exactly what the new helper needs — `readRunStatesFromDisk` is a thin alias.

**What to add (append after `listRunStateFiles`):**

```ts
/**
 * Cross-project read-only RunState enumeration for the cockpit
 * discovery tools (get-project-state, list-projects).
 *
 * UNLIKE the RunManager-backed APIs, this helper does NOT use the
 * in-memory singleton — it always walks .bober/runs/<runId>/state.json
 * on the supplied projectRoot. The discovery tools call it with
 * arbitrary projectPath values; we cannot assume RunManager has been
 * load()'d for that root.
 *
 * Implementation: delegates to listRunStateFiles. Provided as a named
 * alias because:
 *   1. It documents the cockpit intent (cross-project, read-only).
 *   2. Future call sites can filter without touching listRunStateFiles.
 */
export async function readRunStatesFromDisk(
  projectRoot: string,
): Promise<RunState[]> {
  return listRunStateFiles(projectRoot);
}
```

**Also export from `src/state/index.ts`:** Add `readRunStatesFromDisk` to the run-state re-export block at lines 80-84.

**Imports already at top:** `readFile, writeFile, readdir, rename` from `node:fs/promises`; `randomBytes` from `node:crypto`; `join` from `node:path`; `ensureDir` from `./helpers.js`; `type RunState` from `../mcp/run-manager.js`. No new imports needed.

**Test file:** `src/state/run-state.test.ts` already exists (fully read, 163 lines). Add a small describe block for `readRunStatesFromDisk` that mirrors the existing `listRunStateFiles` tests at lines 128-162.

---

### `src/mcp/tools/list-pending-approvals.ts` (create)

**Directory pattern:** `src/mcp/tools/<verb-noun>.ts`, one tool per file, exported `registerXTool()` function. Mirror `src/mcp/tools/list-active-runs.ts` (42 lines) for read-only style.

**Structure template:**

```ts
// ── bober_list_pending_approvals tool ────────────────────────────────
//
// Returns all pending checkpoints in cockpit-row shape:
//   [{ checkpointId, ageMs, prompt }]
// Optional projectPath (must be absolute when supplied).

import { cwd } from "node:process";
import { isAbsolute } from "node:path";

import { registerTool } from "./registry.js";
import { listPendingApprovals } from "../../state/approval-state.js";

export function registerListPendingApprovalsTool(): void {
  registerTool({
    name: "bober_list_pending_approvals",
    description:
      "List all pending careful-flow checkpoints awaiting human approval. " +
      "Returns an array of { checkpointId, ageMs, prompt } — the same shape " +
      "as `bober list-approvals --json`. Optional projectPath defaults to cwd; " +
      "when supplied it MUST be absolute.",
    inputSchema: {
      type: "object",
      properties: {
        projectPath: {
          type: "string",
          description:
            "Absolute path to the project root. Defaults to cwd when omitted.",
        },
      },
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>): Promise<string> => {
      const projectPath =
        typeof args.projectPath === "string" ? args.projectPath : cwd();
      if (typeof args.projectPath === "string" && !isAbsolute(args.projectPath)) {
        return JSON.stringify({ error: "projectPath must be absolute" });
      }
      const rows = await listPendingApprovals(projectPath);
      return JSON.stringify(rows, null, 2);
    },
  });
}
```

**Most similar existing file:** `src/mcp/tools/list-active-runs.ts` (read-only, simple list output).

---

### `src/mcp/tools/approve-checkpoint.ts` (create)

**Most similar existing file:** `src/mcp/tools/abort-run.ts` (input-validating, performs a state mutation, returns small shaped JSON).

**Payload shape (MUST match `src/cli/commands/approve.ts:68-72`):**
```ts
const payload = {
  approvedAt: new Date().toISOString(),
  approverId: resolveApprover(),                // process.env.USER ?? USERNAME ?? "unknown"
  ...(editDelta !== undefined ? { editDelta } : {}),
};
```

The CLI guard (`approve.ts:44-52`) calls `pendingExists` before writing — DO the same here. Then write `.bober/approvals/<id>.approved.json` via `saveApproved` (already exported from approval-state.ts at lines 106-117). Return `{ approvedAt, checkpointId }`.

**Critical:** Import `resolveApprover` from `../../cli/commands/approve.js` (it is exported at line 29 specifically for re-use) — do NOT inline a second copy of the `$USER ?? $USERNAME ?? "unknown"` logic, that would diverge over time.

**Structure template:**

```ts
// ── bober_approve_checkpoint tool ────────────────────────────────────

import { cwd } from "node:process";
import { isAbsolute } from "node:path";

import { registerTool } from "./registry.js";
import { pendingExists, saveApproved, type ApprovedMarker } from "../../state/approval-state.js";
import { resolveApprover } from "../../cli/commands/approve.js";

export function registerApproveCheckpointTool(): void {
  registerTool({
    name: "bober_approve_checkpoint",
    description:
      "Approve a pending checkpoint by writing .bober/approvals/<id>.approved.json. " +
      "Shares the marker-file shape with the `bober approve` CLI command.",
    inputSchema: {
      type: "object",
      properties: {
        checkpointId: { type: "string", description: "Checkpoint to approve." },
        projectPath: { type: "string", description: "Absolute project root (defaults to cwd)." },
        editDelta: {
          description: "Optional override payload (any JSON-serializable value).",
        },
      },
      required: ["checkpointId"],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>): Promise<string> => {
      const checkpointId = typeof args.checkpointId === "string" ? args.checkpointId.trim() : "";
      if (!checkpointId) {
        return JSON.stringify({ error: "checkpointId is required and must be a non-empty string." });
      }
      const projectPath = typeof args.projectPath === "string" ? args.projectPath : cwd();
      if (typeof args.projectPath === "string" && !isAbsolute(args.projectPath)) {
        return JSON.stringify({ error: "projectPath must be absolute" });
      }

      const exists = await pendingExists(projectPath, checkpointId);
      if (!exists) {
        return JSON.stringify({ error: `No pending checkpoint found: ${checkpointId}` });
      }

      const approvedAt = new Date().toISOString();
      const marker: ApprovedMarker = {
        approvedAt,
        approverId: resolveApprover(),
        ...(args.editDelta !== undefined ? { editDelta: args.editDelta } : {}),
      };
      await saveApproved(projectPath, checkpointId, marker);

      return JSON.stringify({ approvedAt, checkpointId }, null, 2);
    },
  });
}
```

---

### `src/mcp/tools/reject-checkpoint.ts` (create)

**Most similar:** `approve-checkpoint.ts` (above) + `src/cli/commands/reject.ts`. Payload shape (MUST match `reject.ts:54-58`):

```ts
const payload = {
  rejectedAt: new Date().toISOString(),
  rejecterId: resolveRejecter(),                // same env pattern
  feedback: opts.feedback,                      // required, non-empty
};
```

Import `resolveRejecter` from `../../cli/commands/reject.js` (exported at line 29). Use `saveRejected` from approval-state.ts. Reject empty/whitespace-only feedback with `{ error: "feedback is required and must be a non-empty string." }`. Return `{ rejectedAt, checkpointId }`.

---

### `src/mcp/tools/list-projects.ts` (create)

**Most similar:** none — first cross-project tool. Follow `src/mcp/tools/list-active-runs.ts` registerTool/JSON-stringify shape.

**Discovery algorithm (one level deep under each searchRoot):**

```ts
import { readdir, readFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { join, basename } from "node:path";
import { readRunStatesFromDisk } from "../../state/run-state.js";

interface ProjectRow {
  projectPath: string;
  name: string;
  mode?: string;     // greenfield | brownfield
  hasActiveRuns: boolean;
  lastRunAt?: string;
}

for (const root of searchRoots) {
  let dirEntries;
  try {
    dirEntries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    process.stderr.write(
      `[bober_list_projects] Skipping unreadable searchRoot ${root}: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    continue;  // soft-skip; do NOT throw
  }
  for (const entry of dirEntries) {
    if (!entry.isDirectory()) continue;
    const projectPath = join(root, entry.name);
    const configPath = join(projectPath, "bober.config.json");
    try {
      await access(configPath, constants.R_OK);
    } catch {
      continue;  // silently skip dirs without bober.config.json
    }
    // Parse minimally — only project.name and project.mode are needed.
    let name = basename(projectPath);
    let mode: string | undefined;
    try {
      const raw = await readFile(configPath, "utf-8");
      const parsed = JSON.parse(raw) as { project?: { name?: string; mode?: string } };
      if (parsed.project?.name) name = parsed.project.name;
      if (parsed.project?.mode) mode = parsed.project.mode;
    } catch {
      // keep basename fallback for name
    }
    // Active runs / lastRunAt
    const runs = await readRunStatesFromDisk(projectPath);
    const hasActiveRuns = runs.some((r) => r.status === "running");
    const lastRunAt = runs.length > 0
      ? runs.map((r) => r.startedAt).sort().slice(-1)[0]
      : undefined;
    rows.push({ projectPath, name, ...(mode ? { mode } : {}), hasActiveRuns, ...(lastRunAt ? { lastRunAt } : {}) });
  }
}
return JSON.stringify(rows, null, 2);
```

**Input schema:** `{ searchRoots: string[] }` REQUIRED.

**Critical gotchas:**
- Do NOT call `loadConfig(projectPath)` — it requires the FULL schema; the cockpit may surface in-progress projects with intentionally minimal configs. A bare `readFile + JSON.parse + optional-chained access to .project.name/.project.mode` is sufficient. The `assumption` in the contract is explicit: "fall back to basename(projectPath) if missing."
- Skip dirs without `bober.config.json` silently (sc-5-4, evaluatorNotes).
- An unreadable searchRoot must NOT throw — soft-skip with a stderr warning (evaluatorNotes negative test).
- Do NOT add caching; every call walks fresh (nonGoal #2).

---

### `src/mcp/tools/list-specs.ts` (create)

**Most similar:** `src/mcp/tools/spec.ts` (uses the existing PlanSpec loader, fully read above). But that tool uses `loadLatestSpec` (strict schema). For cockpit, the contract says "loose-parse — tolerate version mismatches" (generatorNotes).

**Reuse:** `listSpecs(projectRoot)` from `src/state/plan-state.ts` (lines 106-140, fully read) already does this — it uses `safeParse` and skips invalid files. PERFECT for this tool. Map the returned `PlanSpec[]` to the cockpit row shape:

```ts
import { listSpecs } from "../../state/plan-state.js";

interface SpecRow {
  specId: string;
  title: string;
  status: string;       // PlanSpecStatus: draft|needs-clarification|ready|in-progress|completed|abandoned
  sprintCount: number;  // spec.sprints?.length ?? 0
  completedAt?: string;
}

const specs = await listSpecs(projectPath);
const rows: SpecRow[] = specs.map((s) => ({
  specId: s.specId,
  title: s.title,
  status: s.status,
  sprintCount: Array.isArray(s.sprints) ? s.sprints.length : 0,
  ...(s.completedAt ? { completedAt: s.completedAt } : {}),
}));
```

**Input schema:** `{ projectPath: string }` REQUIRED + absolute-path validation.

**Caveat — "loose-parse":** `listSpecs` from plan-state.ts already calls `PlanSpecSchema.safeParse` and silently drops invalid files. That is the "loose-parse" the contract asks for. If a future spec contract drift breaks parsing, those specs simply won't appear — acceptable for cockpit listing. Do NOT introduce a second weaker schema.

---

### `src/mcp/tools/get-project-state.ts` (create)

**Most similar:** none — composite. Pulls counts from THREE sources. Imports `readRunStatesFromDisk`, `listIncidents`, `listPendingApprovals`, and (for `mode`) reads `bober.config.json` directly.

```ts
import { cwd } from "node:process";
import { isAbsolute, join } from "node:path";
import { readFile, access } from "node:fs/promises";
import { constants } from "node:fs";

import { registerTool } from "./registry.js";
import { readRunStatesFromDisk } from "../../state/run-state.js";
import { listIncidents } from "../../incident/timeline.js";
import { listPendingApprovals } from "../../state/approval-state.js";
import { listSpecs } from "../../state/plan-state.js";

// Open == NOT one of {'resolved', 'aborted'} — see contract assumption #2.
function isOpen(status: string): boolean {
  return status !== "resolved" && status !== "aborted";
}

// returns:
//   { configExists, activeRunCount, lastRunAt?, openIncidentCount,
//     pendingApprovalCount, specCount, mode? }
```

**Critical:**
- `configExists` — `await access(join(projectPath, 'bober.config.json'), R_OK)` in a try/catch.
- `activeRunCount` — `runs.filter(r => r.status === 'running').length` from `readRunStatesFromDisk(projectPath)`.
- `lastRunAt` — `max(runs.map(r => r.startedAt))` (lexicographic sort works for ISO-8601).
- `openIncidentCount` — `(await listIncidents(projectPath)).filter(i => isOpen(i.status)).length` (contract assumption #2).
- `pendingApprovalCount` — `(await listPendingApprovals(projectPath)).length`.
- `specCount` — `(await listSpecs(projectPath)).length`.
- `mode` — read directly from `bober.config.json` (NOT loadConfig — see list-projects gotcha).

**Input schema:** `{ projectPath: string }` REQUIRED + absolute-path validation.

---

### `src/mcp/tools/index.ts` (modify — register 6 new tools, bump comment count to 29)

**Current full file (102 lines, fully read).** Each register is one import + one call inside `registerAllTools()`.

**Add to imports (after `registerRunInWorktreeTool` at line 28):**
```ts
import { registerListPendingApprovalsTool } from "./list-pending-approvals.js";
import { registerApproveCheckpointTool } from "./approve-checkpoint.js";
import { registerRejectCheckpointTool } from "./reject-checkpoint.js";
import { registerListProjectsTool } from "./list-projects.js";
import { registerListSpecsTool } from "./list-specs.js";
import { registerGetProjectStateTool } from "./get-project-state.js";
```

**Add a new section inside `registerAllTools()` (after the "Event stream tools" block at line 87):**
```ts
  // ── Cockpit careful-flow + discovery tools (cockpit-integration sprint 5) ──
  registerListPendingApprovalsTool();
  registerApproveCheckpointTool();
  registerRejectCheckpointTool();
  registerListProjectsTool();
  registerListSpecsTool();
  registerGetProjectStateTool();
```

**Update the JSDoc header (line 34):** "Registered tools (23 total)" → "Registered tools (29 total)", and append entries 24–29:
```
 24. bober_list_pending_approvals – List pending careful-flow checkpoints
 25. bober_approve_checkpoint     – Approve a pending checkpoint (writes .approved.json)
 26. bober_reject_checkpoint      – Reject a pending checkpoint with feedback
 27. bober_list_projects          – Enumerate projects under one or more search roots
 28. bober_list_specs             – List PlanSpecs in a project
 29. bober_get_project_state      – Aggregate per-project counts for the cockpit sidebar
```

---

### `src/mcp/tools/tools.test.ts` (modify — bump 23 → 29 + add 6 names)

**Current full file (53 lines, fully read).** Change line 12 `expect(tools.length).toBe(23)` → `toBe(29)`. Append the 6 new names to the `expected` array on lines 18-42.

---

### `tests/mcp/external-server-graph.test.ts` (modify — bump baselines)

**Lines 34, 38, 47, 48, 58, 59, 95 ALL hard-code 23.** With sprint 5:
- Line 34 `tools.length` should become 29.
- Line 38 `expect(tools.length).toBe(23)` → 29.
- Line 47 `expect(baseline).toBe(23)` → 29.
- Line 58-59 `expect(after.length).toBe(baseline + 6); expect(after.length).toBe(29);` → `expect(after.length).toBe(35);` (29 + 6 graph tools).
- Line 95 `expect(boberTools.length).toBe(23)` → 29.

**Verify by reading the file end-to-end and updating EVERY literal `23` referencing total tool count and EVERY literal `29` referencing the `+6 graph` sum (which now becomes 35).**

---

### `CHANGELOG.md` (modify — append under [Unreleased] -> Added)

Mirror the prose style from the Sprint 4 entry (CHANGELOG.md:12-33, fully read). One bullet per tool. Mention:
- All six tools accept optional `projectPath` (must be absolute when supplied).
- Discovery tools are READ-ONLY (no `RunManager` instantiation).
- `listPendingApprovals(projectRoot)` and `readRunStatesFromDisk(projectRoot)` helpers extracted/added.
- Tool count: 23 → 29.

---

### `src/cli/commands/list-approvals.ts` (refactor — use new helper)

**Current full file (108 lines, fully read).** The `action` callback at lines 44-107 reads `.pending.json` files and computes `ageMs`. After this sprint, replace lines 47-80 with a single call:

```ts
import { listPendingApprovals } from "../../state/approval-state.js";
// ...
const rows = await listPendingApprovals(projectRoot);
```

Keep the human-readable table rendering (lines 92-106) and `formatAge` (lines 27-37) untouched — that is CLI-specific output formatting and stays in the CLI command file. Keep `--json` output flow (lines 82-85). Keep the colocated test (`list-approvals.test.ts`) — it already tests the shared helper at lines 62-138.

**Why this is allowed despite the nonGoal #1:** The nonGoal says "Do not modify the existing CLI subcommands"; the generatorNotes explicitly carve out an exception: "Refactor the CLI command to use the new helper for consistency." Extract + reuse only.

---

## 2. Patterns to Follow

### Pattern A — Registered tool module skeleton
**Source:** `src/mcp/tools/list-active-runs.ts:1-41` (full file)
```ts
import { registerTool } from "./registry.js";
import { runManager } from "../run-manager.js";

export function registerListActiveRunsTool(): void {
  registerTool({
    name: "bober_list_active_runs",
    description: "...",
    inputSchema: {
      type: "object",
      properties: { status: { type: "string", enum: [...], description: "..." } },
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>): Promise<string> => {
      const statusFilter = typeof args.status === "string" ? args.status : undefined;
      const all = runManager.listAllRuns();
      const filtered = statusFilter ? all.filter(...) : all;
      return JSON.stringify(filtered, null, 2);
    },
  });
}
```
**Rule:** Tool module = file-banner comment + ONE `register…Tool()` export. `additionalProperties: false`. Handler always returns `Promise<string>` containing JSON.

### Pattern B — Soft error vs McpError
**Source:** `src/mcp/tools/get-run-status.ts:33-46`, `src/mcp/tools/abort-run.ts:44-62`, `src/mcp/tools/run-in-worktree.ts:51-91`
```ts
// HARD ERROR (caller-fault, blocking) — throw McpError(InvalidRequest):
if (!runId) {
  throw new McpError(ErrorCode.InvalidRequest, "runId is required ...");
}
// SOFT ERROR (recoverable, surface in UI) — return JSON.stringify:
if (state === null) {
  return JSON.stringify({ error: `Run not found: ${runId}` }, null, 2);
}
```
**Rule for THIS sprint:** Per the contract (sc-5-7 and generatorNotes): the absolute-path check is a SOFT error — `return JSON.stringify({ error: 'projectPath must be absolute' })`. NOT a throw. Missing required `checkpointId` / `searchRoots` MAY also be soft errors for consistency (no thrown McpError). Empty `feedback` for reject is a soft error too.

### Pattern C — Stateless approvals via marker files
**Source:** `src/cli/commands/approve.ts:38-83`
```ts
const projectRoot = await resolveRoot();
const approvedPath = join(projectRoot, ".bober", "approvals", `${checkpointId}.approved.json`);
const exists = await pendingExists(projectRoot, checkpointId);
if (!exists) { /* refuse — never write dangling .approved.json */ }
const payload = { approvedAt, approverId: resolveApprover(), ...(editDelta ? { editDelta } : {}) };
await writeFile(approvedPath, JSON.stringify(payload, null, 2) + "\n", "utf-8");
```
**Rule:** ALWAYS guard with `pendingExists` before writing the resolution marker. The same shape MUST appear in the new MCP tools — use `saveApproved` / `saveRejected` from `approval-state.ts` to enforce it.

### Pattern D — RunManager singleton reset between tests
**Source:** `src/mcp/tools/list-active-runs.test.ts:73-78`, `src/mcp/tools/abort-run.test.ts:75-80`
```ts
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-..."));
  registerXTool();
  (runManager as unknown as { runs: Map<string, unknown> }).runs.clear();
});
```
**Rule:** Tests that touch the singleton must reset its internal `runs` map. (Most of THIS sprint's tools are read-only on disk and don't touch the singleton, but the test fixture for `bober_get_project_state` and `bober_list_projects` should still clear it for hygiene if they happen to call `readRunStatesFromDisk` against the same tmpdir.)

### Pattern E — Read-only loose enumerator (skip-corrupted)
**Source:** `src/state/plan-state.ts:106-140`, `src/state/approval-state.ts:80-101`, `src/state/run-state.ts:78-93`, `src/incident/timeline.ts:547-589`
```ts
let entries: string[];
try { entries = await readdir(dir); } catch { return []; }
const out: T[] = [];
for (const f of entries) {
  try { out.push(JSON.parse(await readFile(...)) as T); } catch { /* skip */ }
}
return out;
```
**Rule:** All cockpit discovery tools follow this pattern. `ENOENT` directory → return `[]`. Corrupted JSON entries → skip silently (or `logger.warn` for incident parity).

### Pattern F — `cwd()` default + projectPath optional override
**No existing example in this exact shape** (all current tools use `cwd()` exclusively). But the cockpit pattern is established by Sprint 4 worktree where the cockpit COULD specify a path. Standardize across all 6 tools:
```ts
import { cwd } from "node:process";
import { isAbsolute } from "node:path";
const projectPath = typeof args.projectPath === "string" ? args.projectPath : cwd();
if (typeof args.projectPath === "string" && !isAbsolute(args.projectPath)) {
  return JSON.stringify({ error: "projectPath must be absolute" });
}
```
**Rule:** Validate the EXPLICIT user input only (not the cwd() default — that is already absolute on every supported OS).

### Pattern G — Atomic / append helpers already shared
**Source:** `src/state/run-state.ts:41-53` (writeRunState — atomic temp+rename), `src/incident/timeline.ts:67-82` (appendOneLine — POSIX-safe append). For THIS sprint, the saveApproved/saveRejected helpers in `approval-state.ts` already do plain `writeFile` (not temp+rename — approvals are single-shot transitions, no contention), so REUSE them — do NOT roll a separate atomic writer.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `pendingExists` | `src/state/approval-state.ts:145-155` | `(projectRoot, id) => Promise<boolean>` | Guard before writing approve/reject markers |
| `listPending` | `src/state/approval-state.ts:80-101` | `(projectRoot) => Promise<PendingMarker[]>` | Read all pending FULL markers (existing — DIFFERENT shape from new helper) |
| `saveApproved` | `src/state/approval-state.ts:106-117` | `(projectRoot, id, ApprovedMarker) => Promise<void>` | Write .approved.json marker file |
| `saveRejected` | `src/state/approval-state.ts:122-133` | `(projectRoot, id, RejectedMarker) => Promise<void>` | Write .rejected.json marker file |
| `readPending` | `src/state/approval-state.ts:64-75` | `(projectRoot, id) => Promise<PendingMarker \| null>` | Read one pending marker |
| `ApprovedMarker / RejectedMarker / PendingMarker` types | `src/state/approval-state.ts:25-44` | type | Use these EXACT shapes |
| `resolveApprover` | `src/cli/commands/approve.ts:29-31` | `() => string` | $USER/$USERNAME/"unknown" — share with MCP tool |
| `resolveRejecter` | `src/cli/commands/reject.ts:29-31` | `() => string` | $USER/$USERNAME/"unknown" — share with MCP tool |
| `formatAge` | `src/cli/commands/list-approvals.ts:27-37` | `(ageMs) => string` | Human-readable duration (CLI-only — not needed by MCP) |
| `listRunStateFiles` | `src/state/run-state.ts:78-93` | `(projectRoot) => Promise<RunState[]>` | Read all .bober/runs/*/state.json — backing for new readRunStatesFromDisk |
| `readRunState` / `writeRunState` | `src/state/run-state.ts:41-68` | atomic R/W | Already used by RunManager |
| `RunState` type | `src/mcp/run-manager.ts:35-55` | interface | The disk shape |
| `runManager` singleton | `src/mcp/run-manager.ts:272` | RunManager | DO NOT use in discovery tools (per generatorNotes) |
| `listSpecs` | `src/state/plan-state.ts:106-140` | `(projectRoot) => Promise<PlanSpec[]>` | Already loose-parses (safeParse + skip) — perfect for list-specs |
| `loadLatestSpec` | `src/state/plan-state.ts:85-101` | `(projectRoot) => Promise<PlanSpec \| null>` | Used by bober_spec — NOT needed here |
| `PlanSpec` / `PlanSpecSchema` | `src/contracts/spec.ts:124-170` | zod + type | Has `specId, title, status, sprints?, completedAt?` |
| `PlanSpecStatusSchema` | `src/contracts/spec.ts:36-44` | zod | The 6 lifecycle states |
| `listIncidents` | `src/incident/timeline.ts:547-589` | `(projectRoot) => Promise<IncidentSummary[]>` | Returns `{ incidentId, symptom, createdAt, status, resolvedAt? }` |
| `IncidentSummary` | `src/incident/types.ts:182-188` | interface | `status` is the 5-value `IncidentStatus` |
| `IncidentStatus` | `src/incident/types.ts:117-124` | enum | `investigating \| remediating \| monitoring \| resolved \| aborted` — open == NOT in {resolved, aborted} |
| `configExists` | `src/config/loader.ts:90-93` | `(projectRoot) => Promise<boolean>` | Looks for `bober.config.json` OR `.bober/config.json`; reuse for `get-project-state.configExists` |
| `loadConfig` | `src/config/loader.ts:141-259` | `(projectRoot) => Promise<BoberConfig>` | DO NOT use in discovery tools — too strict; raw JSON read is preferred |
| `findProjectRoot` | `src/utils/fs.ts:58-79` | `(startDir?) => Promise<string \| null>` | Walks up looking for bober.config.json/package.json — used by CLI; not by MCP discovery |
| `fileExists` | `src/utils/fs.ts:10-17` | `(path) => Promise<boolean>` | access(R_OK) wrapper |
| `ensureDir` | `src/state/helpers.ts:6-8` AND `src/utils/fs.ts:45-47` | `(path) => Promise<void>` | mkdir recursive — use `state/helpers.ts` version from state/ |
| `registerTool` | `src/mcp/tools/registry.ts:45-47` | `(BoberToolDefinition) => void` | Idempotent — `set()` overwrites |
| `getTool` | `src/mcp/tools/registry.ts:59-61` | `(name) => BoberToolDefinition \| undefined` | For tests |
| `McpError, ErrorCode` | `@modelcontextprotocol/sdk/types.js` | sdk | DO NOT use for soft errors per Pattern B |

---

## 4. Prior Sprint Output

### Sprint 1 — Multi-run RunManager
**Created:** `src/state/run-state.ts` — exports `writeRunState`, `readRunState`, `listRunStateFiles`. `src/mcp/run-manager.ts:RunManager` adds `getRun(id)`, `listActiveRuns()`, `listAllRuns()`, `abortRun()`, `load()`.
**Connection:** Sprint 5 ADDS `readRunStatesFromDisk(projectRoot)` to `src/state/run-state.ts` as a named alias for `listRunStateFiles`. Discovery tools call it instead of touching the singleton.

### Sprint 2 — Run-management MCP tools
**Created:** `src/mcp/tools/list-active-runs.ts`, `get-run-status.ts`, `abort-run.ts`.
**Connection:** Sprint 5's new tools mirror these patterns — same `registerTool` shape, same JSON.stringify, same soft-error guards.

### Sprint 3 — Event-stream MCP tool
**Created:** `src/mcp/tools/subscribe-events.ts`, `unsubscribe-events.ts`; `src/mcp/event-stream.ts`; `pipeline.eventQueueBound` config.
**Connection:** Same registerTool pattern. No direct use in sprint 5.

### Sprint 4 — Worktree adapter
**Created:** `src/orchestrator/worktree.ts:runInWorktree()`; `src/mcp/tools/run-in-worktree.ts`; `bober worktree run` CLI; `git.ts:{addWorktree, removeWorktree, isClean}`; `RunState.worktreePath/branch`; config `worktreeRoot`, `cleanupWorktreeOnSuccess`; tool count to 23.
**Connection:** Sprint 4's `run-in-worktree.ts` is the most recent reference for the registerTool pattern (already uses soft-error JSON for `runInWorktree` failures). Sprint 5 bumps the same `tools.test.ts` count (23→29) and the same `external-server-graph.test.ts` baselines.

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` file found in the repo. No project-wide principles file to enforce.

### Architecture Decisions
No `.bober/architecture/` directory found. ADRs (if any) are NOT colocated in `.bober/`.

### Anti-Patterns (FYI — `.bober/anti-patterns/` exists)
Files of note (not necessarily binding on this sprint):
- `condition-based-waiting.md`
- `defense-in-depth.md`
- `root-cause-tracing.md`
- `testing-anti-patterns.md`

The sprint contract itself (generatorNotes + evaluatorNotes) is the binding spec. No additional repo-wide docs override.

### CLAUDE.md / CONTRIBUTING.md
The user-level `/Users/bober4ik/CLAUDE.md` mandates use of the `code-review-graph` MCP for exploration — informational only for the generator (it has full file-system tools and can use either).

### Pipeline mode + checkpoint surface (relevant context)
The careful-flow approval cycle: an agent that needs human OK writes `.bober/approvals/<id>.pending.json` (via `savePending`) and awaits the appearance of `<id>.approved.json` or `<id>.rejected.json` (existing `disk` mechanism). The CLI `bober approve` / `bober reject` / `bober list-approvals` commands AND the new MCP tools all converge on this exact filesystem contract.

---

## 6. Testing Patterns

### Unit Test Pattern (MCP tool)
**Source:** `src/mcp/tools/abort-run.test.ts` (full file, 203 lines, fully read)
```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { registerXTool } from "./X.js";
import { getTool } from "./registry.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-X-test-"));
  registerXTool();
  // (Optional) singleton reset if your tool touches runManager
  (runManager as unknown as { runs: Map<string, unknown> }).runs.clear();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("bober_X", () => {
  it("is registered with the correct name", () => {
    expect(getTool("bober_X")).toBeDefined();
  });

  it("returns soft-error JSON for invalid input", async () => {
    const tool = getTool("bober_X")!;
    const result = JSON.parse(await tool.handler({ projectPath: "./relative" }));
    expect(result.error).toBe("projectPath must be absolute");
  });
});
```

**Runner:** `vitest`
**Assertion style:** `expect(...).toBe(...)` / `.toMatchObject(...)` / `.rejects.toThrow(McpError)`
**Mock approach:** `vi.fn()`, `vi.mock(...)`, `vi.restoreAllMocks()`
**File naming:** `<tool-name>.test.ts` colocated with the source
**Location:** Colocated next to source (`src/mcp/tools/*.test.ts`) per project convention

### Approval-state test pattern (existing)
**Source:** `src/cli/commands/list-approvals.test.ts:62-138` (fully read)
```ts
beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "bober-list-approvals-"));
  approvalsDir = join(tmpRoot, ".bober", "approvals");
  await mkdir(approvalsDir, { recursive: true });
});

it("returns all pending markers", async () => {
  const marker1 = { checkpointId: "post-research", artifact: { type: "research-doc" },
                    prompt: "...", requestedAt: now, timeoutAt: now };
  await writeFile(join(approvalsDir, "post-research.pending.json"),
                  JSON.stringify(marker1) + "\n", "utf-8");
  const result = await listPending(tmpRoot);
  expect(result).toHaveLength(...);
});
```
**Rule:** ALWAYS use `mkdtemp(join(tmpdir(), "bober-..."))` for isolation. NEVER write to repo or static `/tmp/...` paths. Clean up in `afterEach` with `rm(..., { recursive: true, force: true })`.

### RunState test pattern (existing)
**Source:** `src/state/run-state.test.ts:128-162` (fully read) — mirror for `readRunStatesFromDisk` tests.

### E2E / external server pattern
**Source:** `tests/mcp/external-server-graph.test.ts` (read first 100 lines) — does NOT spin up a child process; just calls `registerAllTools()` + `getAllTools()` and asserts counts/names. Sprint 5 must update the literal counts there (see Target Files section).

### Mixed-mode CLI ↔ MCP test (REQUIRED by evaluatorNotes)
The evaluatorNotes mandate:
> exercise a mixed-mode scenario: write a pending approval, list it via `bober_list_pending_approvals`, approve via `bober_approve_checkpoint`, then use the CLI `bober list-approvals` to confirm it's gone.

Suggested approach (in one of the new `.test.ts` files):
1. `mkdtemp` a tmpRoot, create `.bober/approvals/` and write a `pending.json` via `savePending` (the actual state helper).
2. Call `bober_list_pending_approvals` handler with `{ projectPath: tmpRoot }`, assert 1 row.
3. Call `bober_approve_checkpoint` handler with `{ checkpointId: "...", projectPath: tmpRoot }`, assert `{ approvedAt, checkpointId }` returned.
4. Read the file from disk; assert it has `approvedAt`, `approverId` keys (NOT testing the CLI command itself in a subprocess — the CLI uses the SAME helper, which is the contract).

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
Files that import from or depend on the files being changed:

| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/state/index.ts:67-78` | `src/state/approval-state.ts` (adding export) | low | Re-export block must include `listPendingApprovals` and `PendingApprovalRow` |
| `src/state/index.ts:80-84` | `src/state/run-state.ts` (adding export) | low | Re-export block must include `readRunStatesFromDisk` |
| `src/cli/commands/approve.ts:18` | `src/state/approval-state.ts` | low | Still imports `pendingExists`; new exports don't break it |
| `src/cli/commands/reject.ts:18` | `src/state/approval-state.ts` | low | Same — `pendingExists` import unchanged |
| `src/cli/commands/list-approvals.ts` | `src/state/approval-state.ts` (NEW import) | medium | This file is REFACTORED — verify CLI table output unchanged |
| `src/cli/commands/list-approvals.test.ts:62-138` | `listPending` (existing) | low | These tests exercise `listPending` (the FULL-marker helper), not the new `listPendingApprovals` — both should coexist |
| `src/mcp/run-manager.ts:16` | `listRunStateFiles` from `run-state.ts` | low | Adding a new sibling export does not affect existing import |
| `src/mcp/tools/index.ts` | All tool register modules | high | 6 new register imports + calls; if any one is mistyped, server startup throws — CI catches |
| `src/mcp/tools/tools.test.ts` | Tool count | high | The 23 → 29 literal MUST flip in lockstep with `index.ts` |
| `tests/mcp/external-server-graph.test.ts` | Tool count + literal 29 | high | Multiple literals — see Target Files section |
| `src/state/run-state.test.ts` | `listRunStateFiles` | low | Existing tests pass through; add a small `readRunStatesFromDisk` describe block |
| `src/orchestrator/checkpoints/mechanisms/disk.ts` (if it imports approval-state) | `approval-state.ts` | low | Sprint 5 only ADDS exports — existing imports unchanged |

### Existing Tests That Must Still Pass
- `src/cli/commands/approve.test.ts` (exists) — verifies approve.ts payload shape; the MCP tool must NOT change the CLI shape so this test stays green.
- `src/cli/commands/reject.test.ts` (exists) — same for reject.
- `src/cli/commands/list-approvals.test.ts` (exists, 153 lines, fully read) — tests `formatAge` (untouched) AND `listPending` (untouched, still the full-marker helper). Refactoring the action callback should NOT change observed output.
- `src/state/run-state.test.ts` — existing `writeRunState` / `readRunState` / `listRunStateFiles` tests stay green; add a sibling describe for `readRunStatesFromDisk`.
- `src/mcp/tools/list-active-runs.test.ts`, `get-run-status.test.ts`, `abort-run.test.ts`, `run-in-worktree.test.ts`, `subscribe-events.test.ts`, `unsubscribe-events.test.ts` — unchanged, still pass; tool counts increase but those tests assert on specific tool names, not the count.
- `src/mcp/tools/tools.test.ts` — count assertion bumped to 29.
- `tests/mcp/external-server-graph.test.ts` — multiple count literals bumped (see Target Files).
- `tests/mcp/event-stream-smoke.test.ts` — should pass unchanged (no shared state with new tools).

### Features That Could Be Affected
- **Careful-flow checkpoint disk mechanism** — `src/orchestrator/checkpoints/mechanisms/disk.ts` (not modified). The disk mechanism polls `.bober/approvals/` looking for `.approved.json` / `.rejected.json`. The new MCP tools write the SAME shape as the existing CLI, so the disk mechanism should pick them up identically. **Regression check:** after `bober_approve_checkpoint` writes the marker, the disk mechanism (if running) MUST resume the run.
- **`bober list-approvals` CLI command** — refactored to use the new helper. Output format unchanged. **Regression check:** run the CLI command manually against a tmpdir with mixed pending/approved files.
- **`bober_spec` MCP tool** — uses `loadLatestSpec` (strict parsing). `bober_list_specs` uses `listSpecs` (loose). They coexist with NO interference; both read the same `.bober/specs/` directory.

### Recommended Regression Checks
After implementation, the Generator MUST verify:
1. `npm run typecheck` — strict TS, must pass.
2. `npm run lint` — ESLint, must pass.
3. `npm run build` — must produce dist/ without errors.
4. `npm run test` — full vitest suite; particularly:
   - `vitest run src/state/approval-state.test.ts` (if added) and `src/cli/commands/list-approvals.test.ts`.
   - `vitest run src/state/run-state.test.ts`.
   - `vitest run src/mcp/tools/tools.test.ts` (tool count bump).
   - `vitest run tests/mcp/external-server-graph.test.ts` (external-server count bumps).
   - The 6 new tool tests.
5. **Mixed-mode smoke (manual or scripted):**
   ```sh
   mkdir /tmp/cockpit-sprint5-smoke
   cd /tmp/cockpit-sprint5-smoke
   echo '{"project":{"name":"smoke","mode":"brownfield"}}' > bober.config.json
   mkdir -p .bober/approvals
   echo '{"checkpointId":"post-plan","artifact":{},"prompt":"p","requestedAt":"'$(date -u +%FT%TZ)'","timeoutAt":"'$(date -u +%FT%TZ)'"}' \
     > .bober/approvals/post-plan.pending.json
   # Invoke bober_list_pending_approvals → expect 1 row
   # Invoke bober_approve_checkpoint with { checkpointId: "post-plan", projectPath: "/tmp/cockpit-sprint5-smoke" }
   # Verify .bober/approvals/post-plan.approved.json exists with { approvedAt, approverId }
   ```
6. **Cross-tool smoke (per stopConditions):** create a fixture project with 2 specs, 1 active run state file, 0 incidents, 1 pending approval; `bober_get_project_state` returns the right counts.

---

## 8. Implementation Sequence

1. **`src/state/approval-state.ts`** — add `PendingApprovalRow` interface + `listPendingApprovals(projectRoot)` helper after `pendingExists`.
   - Verify: `tsc --noEmit` clean; `import { listPendingApprovals } from '../../state/approval-state.js'` resolves in other files.

2. **`src/state/index.ts`** — re-export `listPendingApprovals` and `PendingApprovalRow` (in the approval-state block, lines 67-78).
   - Verify: project-wide TS still clean.

3. **`src/state/run-state.ts`** — add `readRunStatesFromDisk(projectRoot)` after `listRunStateFiles`.
   - Verify: tsc clean.

4. **`src/state/index.ts`** — re-export `readRunStatesFromDisk` (run-state block lines 80-84).

5. **`src/state/run-state.test.ts`** — add a small describe for `readRunStatesFromDisk` mirroring `listRunStateFiles` tests.
   - Verify: `vitest run src/state/run-state.test.ts`.

6. **`src/cli/commands/list-approvals.ts`** — replace the inline reader (lines 47-80) with a single `await listPendingApprovals(projectRoot)`. Keep table rendering + `formatAge`.
   - Verify: `vitest run src/cli/commands/list-approvals.test.ts`; manual `node dist/cli.js list-approvals --json` in a tmpdir.

7. **`src/mcp/tools/list-pending-approvals.ts`** (+ `.test.ts`).
   - Verify: tool registered, soft-error on relative projectPath, returns rows for tmpdir fixture.

8. **`src/mcp/tools/approve-checkpoint.ts`** (+ `.test.ts`).
   - Verify: payload shape EXACTLY matches CLI (`approvedAt`, `approverId`, optional `editDelta`), `pendingExists` guard, soft-error on missing pending file.

9. **`src/mcp/tools/reject-checkpoint.ts`** (+ `.test.ts`).
   - Verify: payload shape (`rejectedAt`, `rejecterId`, `feedback`), feedback-required soft-error, `pendingExists` guard.

10. **`src/mcp/tools/list-projects.ts`** (+ `.test.ts`).
    - Verify: walks one level deep, skips dirs without `bober.config.json` silently, soft-skips unreadable searchRoot (negative test mandated by evaluatorNotes).

11. **`src/mcp/tools/list-specs.ts`** (+ `.test.ts`).
    - Verify: returns `[{ specId, title, status, sprintCount, completedAt? }]` mapped from `listSpecs`.

12. **`src/mcp/tools/get-project-state.ts`** (+ `.test.ts`).
    - Verify: composite counts match (fixture with 2 specs, 1 running runState, 0 incidents, 1 pending approval).

13. **`src/mcp/tools/index.ts`** — add 6 imports + 6 register calls + update JSDoc count to 29 + extend tool list (24-29).
    - Verify: `tsc --noEmit`.

14. **`src/mcp/tools/tools.test.ts`** — bump count to 29 + add 6 names to `expected`.
    - Verify: `vitest run src/mcp/tools/tools.test.ts`.

15. **`tests/mcp/external-server-graph.test.ts`** — bump all `23` and `29` literals.
    - Verify: `vitest run tests/mcp/external-server-graph.test.ts`.

16. **`CHANGELOG.md`** — append entries under `[Unreleased]` -> `Added`.

17. **Run full verification** — `npm run typecheck && npm run lint && npm run build && npm run test`.

18. **Manual cross-tool smoke (per stopConditions):** invoke `bober_get_project_state` against a fixture with 2 specs, 1 active run, 0 incidents, 1 pending approval; verify the counts in the returned JSON.

---

## 9. Pitfalls & Warnings

- **Do NOT instantiate `RunManager` in discovery tools.** Sprint 1's `runManager` singleton holds an in-memory cache that is only consistent for the project the server was started against. For an arbitrary `projectPath`, READ DISK via `readRunStatesFromDisk`. The cockpit may pass a project the server has never seen.
- **Do NOT use `loadConfig(projectPath)` in `list-projects` / `get-project-state`.** It full-validates against the schema, which is too strict for the cockpit's "show me whatever projects exist" enumeration. Use `readFile + JSON.parse + optional access` to extract just `project.name` and `project.mode`. Default to `basename(projectPath)` if name missing (contract assumption #4).
- **Do NOT throw on unreadable searchRoot** in `list-projects`. The evaluator's negative test explicitly asserts soft-skip with a stderr warning (evaluatorNotes). Use `try/await readdir/catch` per-root.
- **Do NOT duplicate `resolveApprover` / `resolveRejecter`.** Import them from `src/cli/commands/approve.js` / `reject.js`. They are exported specifically for cross-module reuse. Inlining a second `$USER ?? $USERNAME ?? "unknown"` would silently diverge if someone changes one.
- **`projectPath` absolute-path validation is a SOFT error, not a thrown McpError.** sc-5-7 explicitly says `{ error: 'projectPath must be absolute' }` JSON.
- **`feedback` for reject must be required AND non-empty.** Trim and check length > 0. Sprint contract sc-5-3.
- **`saveApproved` / `saveRejected` already exist** — do NOT roll your own `writeFile(approvedPath, ...)`. The state helpers handle `ensureDir` and the trailing newline.
- **Path-suffix counting in `tools.test.ts` is fragile.** When you change line 12 (`toBe(23)` → `toBe(29)`) you MUST also bump every `23` reference in `tests/mcp/external-server-graph.test.ts` (5+ literals). Use grep to find them all: `grep -n "23\b\|baseline\|toBe(29)" tests/mcp/external-server-graph.test.ts`.
- **`PendingMarker` (existing) and `PendingApprovalRow` (new) are DIFFERENT shapes.** The marker is the full disk file; the row is the cockpit-projected `{ checkpointId, ageMs, prompt }`. `listPending(projectRoot)` returns the marker; `listPendingApprovals(projectRoot)` returns the row. Both must coexist — don't replace one with the other.
- **`incident.status` open-set semantics.** Per contract assumption #2, "open" means `status !== 'resolved' && status !== 'aborted'`. The 5 valid statuses are `investigating | remediating | monitoring | resolved | aborted` — the first three are open. Don't accidentally count `aborted` as open.
- **`lastRunAt` ISO sorting.** ISO-8601 timestamps sort lexicographically, so `runs.map(r => r.startedAt).sort().slice(-1)[0]` is correct. Don't `new Date(...).getTime()` round-trip — unnecessary.
- **CHANGELOG.md placement.** New entries go under `## [Unreleased]` -> `### Added`. Do NOT create a new release header for this sprint.
- **The `src/state/index.ts` re-export block matters.** Many test fixtures import from `src/state/index.js`. If you forget to re-export `listPendingApprovals` and `readRunStatesFromDisk` from `src/state/index.ts`, downstream imports via `../../state/index.js` will fail — even though direct imports from the source files work.
- **`writeFile` mode in `saveApproved` / `saveRejected` is default (0o666 & ~umask).** Approval markers are not secret — that's intentional. Don't add a mode override.
- **`PlanSpec.sprints?` is `z.array(z.unknown()).optional()`** — could be undefined or array. Use `Array.isArray(s.sprints) ? s.sprints.length : 0` for `sprintCount`.
- **Don't add `data-testid` / Playwright concerns.** This sprint has no UI; E2E patterns don't apply.
