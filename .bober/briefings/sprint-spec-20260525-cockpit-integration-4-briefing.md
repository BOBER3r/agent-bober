# Sprint Briefing: Worktree adapter — bober worktree run + runInWorktree + MCP variant

**Contract:** sprint-spec-20260525-cockpit-integration-4
**Generated:** 2026-05-25T18:00:00Z

---

## 1. Target Files

### `src/utils/git.ts` (modify — extend with three helpers)

**Current full file (110 lines) — extend, do NOT rewrite:**
```ts
// src/utils/git.ts (FULL CURRENT)
import { execa } from "execa";

export async function getCurrentBranch(cwd: string): Promise<string> {
  const { stdout } = await execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
  return stdout.trim();
}

export async function createBranch(cwd: string, name: string): Promise<void> {
  await execa("git", ["checkout", "-b", name], { cwd });
}

export async function commitAll(cwd: string, message: string): Promise<string> { /* ... */ }
export async function getChangedFiles(cwd: string, since?: string): Promise<string[]> { /* ... */ }
export async function getDiff(cwd: string, since?: string): Promise<string> { /* ... */ }

export async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  const { stdout } = await execa("git", ["status", "--porcelain"], { cwd, reject: false });
  return stdout.trim().length > 0;
}

export async function stashAndRestore<T>(cwd: string, fn: () => Promise<T>): Promise<T> { /* ... */ }
```

**What to add (three new exports, append to file):**
- `addWorktree(projectRoot: string, path: string, branch: string, baseBranch?: string): Promise<void>` — shells out `git worktree add <path> -b <branch> [<baseBranch>]`.
- `removeWorktree(projectRoot: string, path: string, force?: boolean): Promise<void>` — shells out `git worktree remove [-f] <path>`. Use `reject: false` because removing a worktree that no longer exists must not crash cleanup paths.
- `isClean(cwd: string): Promise<{ clean: boolean; dirtyFiles: string[] }>` — runs `git status --porcelain`, returns `{ clean: true, dirtyFiles: [] }` when stdout is empty; otherwise parses each non-empty line into a file path (skip the first 3 columns of porcelain: `XY <path>`).

**Convention to mirror:** every existing helper takes `cwd: string` as first arg, awaits `execa("git", [...], { cwd })`, and uses `reject: false` ONLY when stdout is the meaningful signal (status/diff). The new `addWorktree` should NOT use `reject: false` — a failed worktree add must throw.

**Imports this file uses:** `execa` from `execa` (single dep — DO NOT add new ones)

**Imported by (high traffic — every change is widely consumed):**
- `src/orchestrator/pipeline.ts:57` — `commitAll, getCurrentBranch, getChangedFiles`
- `src/graph/preflight-injector.ts`, `src/graph/artifact-store.ts`, `src/orchestrator/checkpoints/audit.ts`, `src/orchestrator/checkpoints/mechanisms/pr.ts`, `src/discovery/scanners/git-conventions.ts`
- New: `src/orchestrator/worktree.ts` (this sprint)

**Test file:** `src/utils/git.test.ts` does NOT exist — co-located test for the three new helpers must be created OR (preferred per contract) tested via `src/orchestrator/worktree.test.ts` using a real fixture git repo.

---

### `src/config/schema.ts` (modify — extend PipelineSectionSchema)

**Relevant section — `PipelineSectionSchema` (lines 147-179):**
```ts
export const PipelineSectionSchema = z.object({
  maxIterations: z.number().int().min(1).default(20),
  maxCheckpointIterations: z.number().int().min(1).max(10).default(3),
  requireApproval: z.boolean().default(false),
  contextReset: ContextResetSchema.default("always"),
  researchPhase: z.boolean().default(true),
  architectPhase: z.boolean().default(false),
  mode: z.enum(["autopilot", "careful"]).default("autopilot"),
  checkpointMechanism: CheckpointMechanismSchema.optional(),
  checkpointOverrides: z.record(z.string(), CheckpointMechanismSchema).default({}),
  approvalTimeoutMs: z.number().int().min(1000).default(86_400_000),
  prPollMs: z.number().int().min(10_000).default(30_000),
  allowAutopilotRiskyActions: z.boolean().default(false),
  eventQueueBound: z.number().int().min(1).default(1000),  // sprint 3 (cockpit-integration)
});
```

**What to add — TWO new optional fields at the END of the object:**
```ts
  /** Sprint 4 (cockpit-integration): root directory (relative to projectRoot) under
   *  which git worktrees are created. Default '.bober/worktrees'. The full worktree
   *  path is <projectRoot>/<worktreeRoot>/<runId>. */
  worktreeRoot: z.string().default(".bober/worktrees"),
  /** Sprint 4 (cockpit-integration): when true (default), the worktree is removed
   *  via `git worktree remove` after a successful pipeline run. On failure the
   *  worktree is ALWAYS retained for debugging regardless of this flag. */
  cleanupWorktreeOnSuccess: z.boolean().default(true),
```

**Also update `createDefaultConfig`** (lines 377-390). Add the same two fields to the `pipeline:` block so the synthesized default config carries them. The test helpers in this codebase build `pipeline: { ...minimal... }` without `eventQueueBound` etc.; do NOT remove backward-compat — both fields are `.default(...)` so they are NEVER required in user configs.

**Defaults factory (line 377):**
```ts
    pipeline: {
      maxIterations: 20,
      maxCheckpointIterations: 3,
      requireApproval: false,
      contextReset: "always",
      researchPhase: true,
      architectPhase: false,
      mode: "autopilot",
      checkpointOverrides: {},
      approvalTimeoutMs: 86_400_000,
      prPollMs: 30_000,
      allowAutopilotRiskyActions: false,
      eventQueueBound: 1000,
      // ADD:
      worktreeRoot: ".bober/worktrees",
      cleanupWorktreeOnSuccess: true,
    },
```

**Test file:** None co-located for schema.ts; defaults are exercised indirectly.

---

### `src/mcp/run-manager.ts` (modify — extend RunState + startRun signature)

**RunState interface (lines 35-48):**
```ts
export interface RunState {
  runId: string;
  task: string;
  status: "running" | "completed" | "failed" | "aborted";
  startedAt: string;
  completedAt?: string;
  abortedAt?: string;
  abortReason?: string;
  progress: RunProgress;
  result?: RunResult;
  error?: string;
  projectRoot: string;
  specId?: string;
}
```

**ADD two optional fields (after `specId?`):**
```ts
  /** Sprint 4: when this run was launched via runInWorktree(), the absolute
   *  path of the git worktree the pipeline executed in. Undefined for in-place
   *  runs (the existing bober_run path). */
  worktreePath?: string;
  /** Sprint 4: the git branch the worktree was created on. Undefined for
   *  in-place runs. */
  branch?: string;
```

**startRun signature (lines 139-148):**
```ts
async startRun(
  task: string,
  projectRoot: string,
  config: BoberConfig,
  pipelineFn: (
    task: string,
    projectRoot: string,
    config: BoberConfig,
  ) => Promise<PipelineResult> = runPipeline,
): Promise<string> {
  const runId = randomUUID();
  const now = new Date().toISOString();
  const state: RunState = { runId, task, status: "running", startedAt: now, progress: { completed: 0, total: 0 }, projectRoot };
  this.runs.set(runId, state);
  await writeRunState(projectRoot, state);
  // ... .then/.catch persistence ...
```

**Extend to accept `opts: { runId?, worktreePath?, branch? }` while preserving back-compat:**
```ts
export interface StartRunOptions {
  /** Pre-computed runId. When omitted, RunManager generates one with randomUUID(). */
  runId?: string;
  /** When the run is executed inside a git worktree, the absolute path of that worktree. */
  worktreePath?: string;
  /** Branch the worktree was created on. */
  branch?: string;
}

async startRun(
  task: string,
  projectRoot: string,
  config: BoberConfig,
  pipelineFn: (...) => Promise<PipelineResult> = runPipeline,
  opts: StartRunOptions = {},
): Promise<string> {
  const runId = opts.runId ?? randomUUID();
  // ... build state, ALSO populate worktreePath/branch when present ...
  const state: RunState = {
    runId, task, status: "running", startedAt: now,
    progress: { completed: 0, total: 0 }, projectRoot,
    ...(opts.worktreePath ? { worktreePath: opts.worktreePath } : {}),
    ...(opts.branch ? { branch: opts.branch } : {}),
  };
  // rest unchanged
}
```

**Why this signature shape:** the contract says callers must be able to pre-compute the runId BEFORE creating the worktree (the worktree path is deterministic: `<worktreeRoot>/<runId>`). All 7 existing call sites pass NO extra args today (e.g. `src/mcp/tools/run.ts:73`, `src/mcp/tools/abort-run.test.ts:120`, etc.) — they keep working because `opts` has a default value.

**Existing callers (must remain green — grep result):**
- `src/mcp/tools/run.ts:73` — `runManager.startRun(task, projectRoot, config)`
- `src/mcp/tools/anchor.ts`, `solidity.ts`, `brownfield.ts`, `react.ts` (all use the same 3-arg form)
- `src/mcp/tools/abort-run.test.ts:120`, `get-run-status.test.ts:76`, `list-active-runs.test.ts`, `run-manager.test.ts` (multiple)

**Test file:** `src/mcp/run-manager.test.ts` (extensive — see Section 6). Add new tests covering `opts.runId`, `opts.worktreePath`, `opts.branch` round-trip in state.json.

---

### `src/orchestrator/worktree.ts` (CREATE — the new helper)

**Most similar existing file:** `src/orchestrator/pipeline.ts` — same directory, same "orchestrator" role, same async exec-around-runPipeline pattern.

**buildProjectContext at pipeline.ts:107-127 shows the existing git import pattern:**
```ts
import { commitAll, getCurrentBranch, getChangedFiles } from "../utils/git.js";
// ...
async function buildProjectContext(projectRoot: string, config: BoberConfig): Promise<ProjectContext> {
  let currentBranch: string;
  try {
    currentBranch = await getCurrentBranch(projectRoot);
  } catch {
    currentBranch = "unknown";
  }
  return { name: config.project.name, type: config.project.mode, techStack: [], entryPoints: [], currentBranch };
}
```

**Structure template (the new file):**
```ts
// src/orchestrator/worktree.ts
//
// runInWorktree(task, projectRoot, config, opts) creates a git worktree
// under <projectRoot>/<pipeline.worktreeRoot>/<runId>, kicks off the
// pipeline INSIDE that worktree (passing worktreePath as the new projectRoot),
// then cleans up per policy on success or retains on failure.

import { randomUUID } from "node:crypto";
import { join, isAbsolute } from "node:path";

import type { BoberConfig } from "../config/schema.js";
import { runPipeline } from "./pipeline.js";
import { runManager } from "../mcp/run-manager.js";
import { addWorktree, removeWorktree, isClean, getCurrentBranch } from "../utils/git.js";
import { logger } from "../utils/logger.js";

// ── Slug derivation (matches generator.branchPattern '{feature-name}') ──
// First 60 chars, lowercase, non-alphanumeric → '-', strip leading/trailing dashes.
// Mirrors src/cli/commands/impact.ts:52 deriveSlug but with a 60-char cap.
export function deriveWorktreeSlug(task: string): string {
  return task
    .slice(0, 60)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface RunInWorktreeOpts {
  /** When true, skip the dirty-tree check and allow worktree creation anyway. Default false. */
  allowDirty?: boolean;
  /** When true, retain the worktree on success (overrides pipeline.cleanupWorktreeOnSuccess). Default false. */
  keepOnSuccess?: boolean;
}

export interface RunInWorktreeResult {
  runId: string;
  branch: string;
  worktreePath: string;
}

export async function runInWorktree(
  task: string,
  projectRoot: string,
  config: BoberConfig,
  opts: RunInWorktreeOpts = {},
): Promise<RunInWorktreeResult> {
  // 1. Dirty-tree guard
  if (!opts.allowDirty) {
    const { clean, dirtyFiles } = await isClean(projectRoot);
    if (!clean) {
      throw new Error(
        `Working tree has uncommitted changes:\n  ${dirtyFiles.join("\n  ")}\n` +
        `Pass --allow-dirty (CLI) or allowDirty=true (MCP) to override.`,
      );
    }
  }

  // 2. Determine baseline branch (current HEAD or 'main' fallback)
  let baseBranch: string;
  try {
    const cur = await getCurrentBranch(projectRoot);
    baseBranch = cur === "HEAD" ? "main" : cur;  // detached HEAD → 'main'
  } catch {
    baseBranch = "main";
  }
  if (baseBranch === "main" && /* detached fallback */) {
    process.stderr.write(`[runInWorktree] Detached HEAD detected — falling back to baseline 'main'.\n`);
  }

  // 3. Derive runId, branch name, worktree path
  const runId = randomUUID();
  const slug = deriveWorktreeSlug(task);
  // Substitute {feature-name} in generator.branchPattern (default 'bober/<slug>')
  const branch = (config.generator.branchPattern ?? "bober/{feature-name}").replace("{feature-name}", slug);
  const worktreeRootRel = config.pipeline.worktreeRoot ?? ".bober/worktrees";
  const worktreeRootAbs = isAbsolute(worktreeRootRel) ? worktreeRootRel : join(projectRoot, worktreeRootRel);
  const worktreePath = join(worktreeRootAbs, runId);

  // 4. Create worktree via git CLI
  await addWorktree(projectRoot, worktreePath, branch, baseBranch);

  // 5. Kick off pipeline INSIDE the worktree (worktreePath becomes the new projectRoot)
  //    Pre-compute runId and pass via opts so RunManager uses our id.
  const cleanupOnSuccess =
    !opts.keepOnSuccess && config.pipeline.cleanupWorktreeOnSuccess !== false;

  // Wrap runPipeline so we can intercept the resolution and run cleanup.
  const wrapped = async (t: string, _root: string, c: BoberConfig) => {
    try {
      const result = await runPipeline(t, worktreePath, c);
      if (result.success && cleanupOnSuccess) {
        try { await removeWorktree(projectRoot, worktreePath); } catch (e) {
          logger.warn(`[runInWorktree] worktree cleanup failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else if (!result.success) {
        process.stderr.write(`[runInWorktree] Pipeline failed — worktree retained for debugging: ${worktreePath}\n`);
      }
      return result;
    } catch (err) {
      // On throw, ALWAYS retain
      process.stderr.write(`[runInWorktree] Pipeline crashed — worktree retained for debugging: ${worktreePath}\n`);
      throw err;
    }
  };

  await runManager.startRun(task, projectRoot, config, wrapped, {
    runId,
    worktreePath,
    branch,
  });

  return { runId, branch, worktreePath };
}
```

**KEY GOTCHA per evaluatorNotes:** `runPipeline` MUST be invoked with `worktreePath` as the projectRoot argument — NOT the original projectRoot. Otherwise commits land on the parent's branch, defeating the point of the worktree.

**Test file:** Create `src/orchestrator/worktree.test.ts` co-located. Use a tmpdir-based git fixture (see Section 6).

---

### `src/cli/commands/worktree.ts` (CREATE)

**Most similar existing file:** `src/cli/commands/incident.ts` (top-level subcommand with sub-subcommands `start/status/end/...`).

**Pattern from incident.ts:200-240:**
```ts
export function registerIncidentCommand(program: Command): void {
  const incCmd = program
    .command("incident")
    .description("Manage production incidents (start, status, end, list, abort)");

  incCmd
    .command("start <symptom>")
    .description("Create a new incident and return its ID")
    .option("--severity <level>", "Severity: S1|S2|S3|S4")
    .action(async (symptom: string, opts: { severity?: string }) => {
      const projectRoot = await resolveRoot();
      try {
        // ... work ...
        process.stdout.write(chalk.green(`Incident created: ${incidentId}\n`));
      } catch (err) {
        process.stderr.write(chalk.red(`Failed to create incident: ${err instanceof Error ? err.message : String(err)}\n`));
        process.exitCode = 1;
      }
    });
}
```

**Template for worktree.ts:**
```ts
/**
 * `bober worktree run <task> [--allow-dirty] [--keep-on-success]` — launch a
 * pipeline run in an isolated git worktree.
 */

import chalk from "chalk";
import type { Command } from "commander";

import { findProjectRoot } from "../../utils/fs.js";
import { loadConfig, configExists } from "../../config/loader.js";
import { runInWorktree } from "../../orchestrator/worktree.js";

async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}

export function registerWorktreeCommand(program: Command): void {
  const wtCmd = program
    .command("worktree")
    .description("Launch and manage worktree-isolated pipeline runs");

  wtCmd
    .command("run <task>")
    .description("Run the full Bober pipeline in an isolated git worktree on a new branch")
    .option("--allow-dirty", "Allow worktree creation even when the working tree has uncommitted changes")
    .option("--keep-on-success", "Retain the worktree after a successful pipeline run (default is to clean up)")
    .action(async (task: string, opts: { allowDirty?: boolean; keepOnSuccess?: boolean }) => {
      const projectRoot = await resolveRoot();
      const hasConfig = await configExists(projectRoot);
      if (!hasConfig) {
        process.stderr.write(chalk.red("No bober.config.json found. Run `bober init` first.\n"));
        process.exitCode = 1;
        return;
      }
      let config;
      try {
        config = await loadConfig(projectRoot);
      } catch (err) {
        process.stderr.write(chalk.red(`Failed to load config: ${err instanceof Error ? err.message : String(err)}\n`));
        process.exitCode = 1;
        return;
      }
      try {
        const result = await runInWorktree(task, projectRoot, config, {
          allowDirty: opts.allowDirty,
          keepOnSuccess: opts.keepOnSuccess,
        });
        process.stdout.write(JSON.stringify({ ...result, projectRoot }, null, 2) + "\n");
      } catch (err) {
        process.stderr.write(chalk.red(`Worktree run failed: ${err instanceof Error ? err.message : String(err)}\n`));
        process.exitCode = 1;
      }
    });
}
```

**Error handling convention (CRITICAL — see incident.ts/playbook.ts header comments):**
> "CLI handlers MUST NOT throw. They set process.exitCode=1 and return on all errors (Pattern C per briefing)."

---

### `src/cli/index.ts` (modify — register new subcommand)

**Current registration block (lines 248-278):**
```ts
  registerApproveCommand(program);
  registerRejectCommand(program);
  registerListApprovalsCommand(program);
  registerAuditCommand(program);
  registerRollbackCommand(program);
  registerPostmortemCommand(program);
  registerIncidentCommand(program);
  registerPlaybookCommand(program);
  registerConfigCommand(program);
  registerTelemetryCommand(program);
```

**Add at top (line ~33):**
```ts
import { registerWorktreeCommand } from "./commands/worktree.js";
```

**Add to registration block (alphabetic / by-feature group):**
```ts
  registerWorktreeCommand(program);
```

---

### `src/mcp/tools/run-in-worktree.ts` (CREATE — model after run.ts)

**Full template (mirrors `src/mcp/tools/run.ts` line-for-line):**
```ts
// ── bober_run_in_worktree tool ───────────────────────────────────────
//
// Like bober_run, but creates a git worktree under .bober/worktrees/<runId>
// and runs the pipeline inside it. Returns immediately with
// { runId, branch, worktreePath, status: 'running' }. The pipeline runs
// fire-and-forget; poll bober_get_run_status by runId to track progress.

import { cwd } from "node:process";

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

import { configExists, loadConfig } from "../../config/loader.js";
import { registerTool } from "./registry.js";
import { runInWorktree } from "../../orchestrator/worktree.js";

export function registerRunInWorktreeTool(): void {
  registerTool({
    name: "bober_run_in_worktree",
    description:
      "Start the full Bober pipeline inside an isolated git worktree on a new branch. " +
      "Returns { runId, branch, worktreePath, status: 'running' } immediately. " +
      "Multiple worktree runs can execute concurrently on the same project. " +
      "Use bober_get_run_status to track progress; bober_abort_run to cancel.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Task description to pass to the planner." },
        allowDirty: { type: "boolean", description: "Allow worktree creation even when the working tree has uncommitted changes. Default false." },
        keepOnSuccess: { type: "boolean", description: "Retain the worktree after a successful run. Default false." },
      },
      required: ["task"],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>): Promise<string> => {
      const task = String(args.task ?? "").trim();
      if (!task) {
        return JSON.stringify({ error: "task is required and must be a non-empty string." });
      }
      const allowDirty = args.allowDirty === true;
      const keepOnSuccess = args.keepOnSuccess === true;

      const projectRoot = cwd();
      const hasConfig = await configExists(projectRoot);
      if (!hasConfig) {
        throw new McpError(ErrorCode.InvalidRequest, "No bober.config.json found. Run bober_init first.");
      }

      let config;
      try {
        config = await loadConfig(projectRoot);
      } catch (err) {
        return JSON.stringify({ error: `Failed to load config: ${err instanceof Error ? err.message : String(err)}` });
      }

      let result;
      try {
        result = await runInWorktree(task, projectRoot, config, { allowDirty, keepOnSuccess });
      } catch (err) {
        // Dirty-tree errors and addWorktree failures bubble through here.
        // Surface as soft-error JSON so the cockpit can render them.
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }

      process.stderr.write(
        `[bober_run_in_worktree] Started run ${result.runId} on ${result.branch} at ${result.worktreePath}\n`,
      );

      return JSON.stringify(
        { runId: result.runId, branch: result.branch, worktreePath: result.worktreePath, status: "running" },
        null, 2,
      );
    },
  });
}
```

**KEY CONVENTION (see run.ts:36-49):** hard errors (no config, missing required arg validation per `inputSchema`) throw `McpError(InvalidRequest)`. Soft errors (config load failure, dirty tree, worktree-add failure) return JSON `{ error: "..." }`. Do NOT mix the two.

**Note:** Unlike `bober_run`, this tool does NOT reject when another run is in progress — the whole point of worktrees is parallel runs.

---

### `src/mcp/tools/index.ts` (modify — register new tool)

**Current (lines 26-27 + 56):**
```ts
import { registerSubscribeEventsTool } from "./subscribe-events.js";
import { registerUnsubscribeEventsTool } from "./unsubscribe-events.js";

// Registered tools (22 total):
```

**ADD:**
```ts
import { registerRunInWorktreeTool } from "./run-in-worktree.js";
```

**In `registerAllTools()` (line 57+), in the Async pipeline tools block (line 66):**
```ts
  // ── Async pipeline tools ────────────────────────────────────────
  registerRunTool();
  registerRunInWorktreeTool();  // ← ADD HERE
  registerBrownfieldTool();
  // ...
```

**Update header doc comment count:**  `// Registered tools (22 total):` → `// Registered tools (23 total):` and add bullet `23. bober_run_in_worktree  – Start the pipeline in an isolated git worktree`.

---

### `src/mcp/tools/tools.test.ts` (modify — bump count + add name)

**Current:**
```ts
it("registers exactly 22 tools", async () => {
  const tools = getAllTools();
  expect(tools.length).toBe(22);
});
```

**Must change to `23` and add `"bober_run_in_worktree"` to the `expected` array.** This file will fail the build otherwise.

---

### `CHANGELOG.md` (modify — append to `## [Unreleased]` block)

The existing `## [Unreleased]` section already has sprint 1-3 entries (see top of file). Append a new bullet group:

```md
- **`bober_run_in_worktree`**: Start a pipeline inside an isolated git worktree on a new branch.
  Input: `{ task: string, allowDirty?: boolean, keepOnSuccess?: boolean }`. Returns
  `{ runId, branch, worktreePath, status: 'running' }` immediately (fire-and-forget like `bober_run`).
  Multiple worktree runs can execute concurrently on the same project. Use `bober_get_run_status`
  to track progress.
- **`bober worktree run <task>`** CLI subcommand mirroring the MCP tool. Flags:
  `--allow-dirty` (skip uncommitted-changes guard), `--keep-on-success` (retain worktree after success).
  Prints `{ runId, branch, worktreePath, projectRoot }` JSON to stdout.
- **`runInWorktree(task, projectRoot, config, opts)`** (`src/orchestrator/worktree.ts`): the shared helper
  the CLI and MCP tool both use. Creates a git worktree under `<pipeline.worktreeRoot>/<runId>` on a
  branch derived from `generator.branchPattern`, runs the pipeline inside it, and on success removes
  the worktree per `pipeline.cleanupWorktreeOnSuccess`. On failure (or if `--keep-on-success`/`keepOnSuccess`)
  the worktree is retained for debugging and its path is printed to stderr.
- **`pipeline.worktreeRoot`** config field: directory (relative to projectRoot) under which
  worktrees are created. Default `.bober/worktrees`.
- **`pipeline.cleanupWorktreeOnSuccess`** config field: when true (default), remove the worktree
  via `git worktree remove` after a successful run. On failure the worktree is always retained.
- **`RunState.worktreePath`** and **`RunState.branch`** optional fields. Populated by `runInWorktree`
  before the pipeline starts; surfaced in `bober_get_run_status` output.
- **`RunManager.startRun(task, projectRoot, config, pipelineFn?, opts?)`** signature extended with
  optional `opts: { runId?, worktreePath?, branch? }`. Existing 3- and 4-arg callers are unchanged.
- **`git.ts`** helpers: `addWorktree`, `removeWorktree`, `isClean` shelling out to git CLI (no new deps).

### Follow-ups (documented, NOT implemented this sprint)

- Garbage collection of orphaned worktrees from prior failed runs (`bober worktree prune`).
- Worktree-aware bober_status (the cockpit uses bober_get_run_status by runId instead).
- Cross-worktree merge automation.
```

---

## 2. Patterns to Follow

### Pattern 1: Extending `src/utils/git.ts` — the execa shell-out convention
**Source:** `src/utils/git.ts:1-110` (entire file)
```ts
import { execa } from "execa";

export async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  const { stdout } = await execa("git", ["status", "--porcelain"], { cwd, reject: false });
  return stdout.trim().length > 0;
}
```
**Rule:** Every git helper takes `cwd: string` as the first parameter, uses `execa("git", [...args], { cwd })`. Use `{ reject: false }` only when stdout is the meaningful signal even on non-zero exit (status, diff). For state-changing commands (`add`, `remove`, `commit`), let `execa` throw on non-zero — that's the error signal.

### Pattern 2: MCP tool registration — fire-and-forget with hard vs soft errors
**Source:** `src/mcp/tools/run.ts:17-91`
```ts
export function registerRunTool(): void {
  registerTool({
    name: "bober_run",
    description: "Start the full Bober pipeline ...",
    inputSchema: { type: "object", properties: { task: { type: "string", description: "..." } },
                   required: ["task"], additionalProperties: false },
    handler: async (args: Record<string, unknown>): Promise<string> => {
      const task = String(args.task ?? "").trim();
      if (!task) return JSON.stringify({ error: "task is required and must be a non-empty string." });

      const hasConfig = await configExists(projectRoot);
      if (!hasConfig) {
        throw new McpError(ErrorCode.InvalidRequest, "No bober.config.json found. Run bober_init first.");
      }
      // ... soft errors return JSON.stringify({ error: "..." }) ...
      // success returns JSON.stringify({ runId, status: "running", ... }, null, 2);
    },
  });
}
```
**Rule:** `throw new McpError(ErrorCode.InvalidRequest, ...)` ONLY for config-missing / structural errors. All other failure modes (bad input, dirty tree, config load failure, business-logic failures) return `JSON.stringify({ error: "..." })` so the cockpit can render them without an MCP transport error.

### Pattern 3: Commander subcommand with sub-subcommands
**Source:** `src/cli/commands/incident.ts:200-241` and `src/cli/commands/playbook.ts:36-84`
```ts
export function registerIncidentCommand(program: Command): void {
  const incCmd = program.command("incident").description("...");
  incCmd
    .command("start <symptom>")
    .description("...")
    .option("--severity <level>", "...")
    .action(async (symptom: string, opts: { severity?: string }) => {
      const projectRoot = await resolveRoot();
      try { /* work */ } catch (err) {
        process.stderr.write(chalk.red(`Failed: ${err instanceof Error ? err.message : String(err)}\n`));
        process.exitCode = 1;
      }
    });
}
```
**Rule:** Build the parent `command("worktree")`, then chain `.command("run <task>")` on it. Action handlers MUST NOT throw — catch errors locally, write `chalk.red(...)` to stderr, set `process.exitCode = 1`, and return. Resolve project root via `await resolveRoot()` helper (always defined at top of file).

### Pattern 4: Slug derivation
**Source:** `src/cli/commands/impact.ts:52-59`
```ts
export function deriveSlug(target: string): string {
  return target
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
```
**Rule:** The contract's assumption block specifies the worktree slug uses the SAME regex but with `slice(0, 60)` BEFORE the lowercasing (first-60-chars-of-task), and only the leading/trailing strip (no consecutive collapse — though both forms produce identical results in practice). Make `deriveWorktreeSlug(task)` an exported function in `worktree.ts` so the test file can verify it directly.

### Pattern 5: Re-using `branchPattern` config
**Source:** `src/config/schema.ts:97`
```ts
branchPattern: z.string().default("bober/{feature-name}"),
```
**Rule:** The token to substitute is literally `{feature-name}`. Replace with the slug via `branchPattern.replace("{feature-name}", slug)`. Do NOT introduce a new templating system — keep it a simple string replace. There is currently NO other consumer of `branchPattern` in the codebase (grep confirms) — this sprint is the first.

### Pattern 6: Pre-computed runId pattern for atomic state persistence
**Source:** `src/mcp/run-manager.ts:139-164`
```ts
async startRun(task, projectRoot, config, pipelineFn = runPipeline): Promise<string> {
  const runId = randomUUID();
  const now = new Date().toISOString();
  const state: RunState = { runId, task, status: "running", startedAt: now,
                            progress: { completed: 0, total: 0 }, projectRoot };
  this.runs.set(runId, state);
  await writeRunState(projectRoot, state);  // SYNCHRONOUS — disk state visible immediately
  // then fire-and-forget the pipelineFn
}
```
**Rule:** State.json MUST be on disk before startRun returns (sc-1-2 from sprint 1). The new `opts.runId` path preserves this — same atomic write, just with a caller-supplied id.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `execa` | `execa` package (dep) | `execa(cmd, args, opts)` | Shell out — use for all `git` invocations. Do not import `child_process` directly. |
| `getCurrentBranch` | `src/utils/git.ts:8` | `(cwd) => Promise<string>` | Returns trimmed `git rev-parse --abbrev-ref HEAD`. Returns literal "HEAD" when detached — your code must detect this. |
| `hasUncommittedChanges` | `src/utils/git.ts:79` | `(cwd) => Promise<boolean>` | Existing dirty-check. DO NOT reuse — the new `isClean()` must return the file list too. Add a new helper, keep this one for back-compat. |
| `createBranch` | `src/utils/git.ts:18` | `(cwd, name) => Promise<void>` | Runs `git checkout -b`. NOT used here (worktree creates branch atomically) but cite for context. |
| `commitAll` | `src/utils/git.ts:27` | `(cwd, message) => Promise<string>` | Used by pipeline.ts — keep working. |
| `deriveSlug` | `src/cli/commands/impact.ts:52` | `(target) => string` | Similar but 40-char cap. The worktree slug needs 60-char cap and a different pre-slice order. Define a new `deriveWorktreeSlug` in `worktree.ts` — do NOT call this one. |
| `randomUUID` | `node:crypto` (stdlib) | `() => string` | Use for the runId. Same convention as `run-manager.ts:149`. |
| `writeRunState` | `src/state/run-state.ts:41` | `(projectRoot, state) => Promise<void>` | Atomic disk write. Already called inside `startRun`. Do NOT call directly from `runInWorktree`. |
| `readRunState` | `src/state/run-state.ts:61` | `(projectRoot, runId) => Promise<RunState \| null>` | Read state.json. Useful for tests. |
| `listRunStateFiles` | `src/state/run-state.ts:78` | `(projectRoot) => Promise<RunState[]>` | Enumerate all runs. |
| `ensureDir` | `src/state/helpers.ts:6` | `(dirPath) => Promise<void>` | Recursive mkdir. `git worktree add` creates the worktree itself, but you may need to pre-create the parent `.bober/worktrees/` dir. |
| `runPipeline` | `src/orchestrator/pipeline.ts` | `(task, projectRoot, config) => Promise<PipelineResult>` | The function `runInWorktree` wraps. CRITICAL: call with `worktreePath` as the projectRoot arg, NOT the original projectRoot (evaluator note). |
| `runManager` (singleton) | `src/mcp/run-manager.ts:247` | exported `RunManager` instance | The shared singleton. `runInWorktree` calls `runManager.startRun(...)` with the new `opts` arg. |
| `logger` | `src/utils/logger.ts` | `{ warn, error, info, success, phase, ... }` | Standard logging. `process.stderr.write(...)` is also used in CLI/MCP tools (mirrors `bober_run`). |
| `findProjectRoot` | `src/utils/fs.ts` | `() => Promise<string \| null>` | Walks upward from cwd looking for `.bober/`. Used by every CLI command. |
| `loadConfig` | `src/config/loader.ts` | `(projectRoot) => Promise<BoberConfig>` | Load + validate config. |
| `configExists` | `src/config/loader.ts` | `(projectRoot) => Promise<boolean>` | Quick existence check before load. |
| `registerTool` | `src/mcp/tools/registry.ts:45` | `(def: BoberToolDefinition) => void` | Add tool to global registry. |
| `getTool` | `src/mcp/tools/registry.ts:59` | `(name) => BoberToolDefinition \| undefined` | Lookup. Used heavily in tests: `getTool("bober_run_in_worktree")!`. |
| `McpError` / `ErrorCode` | `@modelcontextprotocol/sdk/types.js` | constructor | Hard errors only. |

---

## 4. Prior Sprint Output

### Sprint 1 (DEPENDED ON): Multi-run RunManager with disk persistence
**Created/Modified:** `src/mcp/run-manager.ts` (the file you are extending now); `src/state/run-state.ts` (atomic-write helpers).
**Exports:** `RunManager` class, `runManager` singleton, `RunState` interface, `RunProgress`, `RunResult`.
**Connection to this sprint:** You are extending `RunState` with two new optional fields (`worktreePath`, `branch`) AND extending `startRun()` with an `opts` parameter. Sprint 1 already wrote `writeRunState` synchronously inside `startRun` — your changes flow through that same persistence path, no new state code needed.

### Sprint 2: Run-management MCP tools
**Created:** `src/mcp/tools/list-active-runs.ts`, `get-run-status.ts`, `abort-run.ts`.
**Exports:** `registerListActiveRunsTool`, `registerGetRunStatusTool`, `registerAbortRunTool`.
**Connection:** `bober_get_run_status` returns the full `RunState` as JSON (`get-run-status.ts:46`). Once you add `worktreePath` and `branch` to the interface, they will AUTOMATICALLY appear in `bober_get_run_status` output — no change needed there. Verify this works (sc-4-7).

### Sprint 3: Event-stream MCP tool
**Created:** `src/mcp/event-stream.ts`, `src/mcp/tools/subscribe-events.ts`, `unsubscribe-events.ts`. Added `pipeline.eventQueueBound`.
**Connection:** No direct dependency. The cockpit will use `bober_subscribe_events` to follow your worktree-isolated runs — your runId becomes the subscription key. No code changes here.

---

## 5. Relevant Documentation

### Project Principles
`.bober/principles.md` does NOT exist in this repo. No principles file to honour.

### Architecture Decisions
`.bober/architecture/` does NOT exist. No ADRs for the worktree path. The closest design context is the planner's own contract (`generatorNotes`, `evaluatorNotes`) — those ARE the architecture for this sprint.

### Project conventions (from `CHANGELOG.md` and inline comments)
- **Stdio MCP transport caveat (`src/cli/index.ts:236`):** `// stdout is reserved for MCP JSON-RPC — do NOT use logger or console.log` — applies to the MCP server only. The `bober worktree run` CLI subcommand WRITES the result JSON to stdout (sc-4-6 explicitly requires this); that's OK because it's the CLI, not the MCP path.
- **ESM extension requirement:** All relative imports MUST end in `.js` (e.g. `from "../utils/git.js"` even though the source is `.ts`). See every existing import.
- **Module-scoped singletons:** `runManager` (run-manager.ts:247), `EventStreamManager` via `getEventStream()` (event-stream.ts) — your code uses these directly, do not instantiate new ones.

### `.gitignore` (verified)
The repo's own `.gitignore` does NOT list `.bober/`. The contract's assumption block says "If the project does NOT gitignore .bober/, the worktree creation still works but may surprise users — document in stderr." → Print a stderr warning when creating the first worktree if `.bober/` is not gitignored. (Soft check: read `.gitignore`, search for `.bober`; if absent, warn.)

---

## 6. Testing Patterns

### Unit Test Pattern — RunManager / MCP tools (vitest + tmpdir)
**Source:** `src/mcp/tools/abort-run.test.ts:1-100`
```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { registerAbortRunTool } from "./abort-run.js";
import { getTool } from "./registry.js";
import { runManager } from "../run-manager.js";
import type { PipelineResult } from "../../orchestrator/pipeline.js";

function makeFakeConfig(): BoberConfig { /* minimal config with all required fields */ }
function makeFakePipelineResult(overrides?): PipelineResult { /* ... */ }

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-abort-test-"));
  registerAbortRunTool();
  // Reset the singleton's internal run map to isolate tests
  (runManager as unknown as { runs: Map<string, unknown> }).runs.clear();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("bober_abort_run", () => {
  it("flips running run to aborted", async () => {
    const neverResolves = new Promise<PipelineResult>(() => {});
    const mockPipeline = vi.fn().mockReturnValue(neverResolves);
    const runId = await runManager.startRun("task", tmpDir, makeFakeConfig(), mockPipeline);

    const tool = getTool("bober_abort_run")!;
    const result = JSON.parse(await tool.handler({ runId, reason: "test" }));

    expect(result.runId).toBe(runId);
    expect(result.status).toBe("aborted");
  });
});
```
**Runner:** vitest
**Assertion style:** `expect(...).toBe(...)`, `.toMatchObject(...)`, `.toBeNull()`, `.rejects.toThrow(...)`
**Mock approach:** `vi.fn().mockReturnValue(...)` / `.mockResolvedValue(...)` for `pipelineFn`. The "neverResolves" pattern (a Promise that never resolves) keeps a run "running" indefinitely so you can test the running-state branch.
**File naming:** Co-located `*.test.ts` (NOT `*.spec.ts`) next to the source file.
**Singleton reset:** `(runManager as unknown as { runs: Map<string, unknown> }).runs.clear();` — required at the start of every test that uses the singleton.

### Test Pattern for `runInWorktree` — REAL git fixture repo
**Source:** `tests/graph/artifact-store.test.ts:65-72` (the only real-git-fixture example in the codebase)
```ts
import { execa } from "execa";
// ...
await execa("git", ["init", "-q"], { cwd: tmp });
await execa(
  "git",
  ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
  { cwd: tmp },
);
const { stdout: head } = await execa("git", ["rev-parse", "HEAD"], { cwd: tmp });
```
**Rule:** Per `evaluatorNotes`: "Verify runInWorktree actually shells out to git CLI (not a stub). Verify the worktree is created at the expected path, the branch is created with the expected name, and pipeline.runPipeline is invoked with the worktree path as projectRoot."

**Recommended test skeleton for `src/orchestrator/worktree.test.ts`:**
```ts
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { runInWorktree, deriveWorktreeSlug } from "./worktree.js";
import { runManager } from "../mcp/run-manager.js";
import type { PipelineResult } from "./pipeline.js";
import type { BoberConfig } from "../config/schema.js";

let tmpRepo: string;

function makeFakeConfig(overrides: Partial<BoberConfig> = {}): BoberConfig { /* ... */ }
function makeFakePipelineResult(success = true): PipelineResult { /* ... */ }

beforeEach(async () => {
  tmpRepo = await mkdtemp(join(tmpdir(), "bober-worktree-test-"));
  // initialize a real git repo with one commit so worktree commands work
  await execa("git", ["init", "-q", "-b", "main"], { cwd: tmpRepo });
  await execa("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], { cwd: tmpRepo });
  (runManager as unknown as { runs: Map<string, unknown> }).runs.clear();
});

afterEach(async () => { await rm(tmpRepo, { recursive: true, force: true }); });

describe("deriveWorktreeSlug", () => {
  it("lowercases and replaces non-alphanumeric with dash", () => {
    expect(deriveWorktreeSlug("Add OAuth login!")).toBe("add-oauth-login");
  });
  it("truncates to 60 chars before slugifying", () => {
    const long = "x".repeat(100);
    expect(deriveWorktreeSlug(long).length).toBeLessThanOrEqual(60);
  });
});

describe("runInWorktree", () => {
  it("creates a git worktree at .bober/worktrees/<runId> on the configured branch", async () => {
    const mockPipeline = vi.fn().mockResolvedValue(makeFakePipelineResult(true));
    // Stub pipeline import so we don't spawn the real planner. Use vi.mock at top:
    //   vi.mock("./pipeline.js", () => ({ runPipeline: vi.fn().mockResolvedValue(...) }));
    const result = await runInWorktree("trivial task", tmpRepo, makeFakeConfig());
    expect(result.branch).toMatch(/^bober\/trivial-task/);
    expect(result.worktreePath).toContain(join(tmpRepo, ".bober", "worktrees"));
    // verify the worktree dir physically exists
    const info = await stat(result.worktreePath);
    expect(info.isDirectory()).toBe(true);
  });

  it("rejects with dirty-files error when working tree has uncommitted changes", async () => {
    await writeFile(join(tmpRepo, "dirty.txt"), "uncommitted");
    await execa("git", ["add", "dirty.txt"], { cwd: tmpRepo });
    await expect(runInWorktree("x", tmpRepo, makeFakeConfig())).rejects.toThrow(/uncommitted changes/);
  });

  it("allowDirty=true bypasses the dirty-tree check", async () => { /* ... */ });

  it("populates RunState.worktreePath and RunState.branch", async () => {
    const result = await runInWorktree("task", tmpRepo, makeFakeConfig());
    const state = runManager.getRun(result.runId);
    expect(state!.worktreePath).toBe(result.worktreePath);
    expect(state!.branch).toBe(result.branch);
  });

  it("removes the worktree on success when cleanupWorktreeOnSuccess is true (default)", async () => { /* ... */ });
  it("retains the worktree on failure", async () => { /* ... */ });
  it("retains the worktree when keepOnSuccess=true", async () => { /* ... */ });

  it("commits made by the pipeline land on the worktree's branch, not main", async () => {
    // CRITICAL test per evaluatorNotes — exercise with a fake pipelineFn that runs `git commit` in worktreePath
  });

  it("two concurrent worktree runs both succeed on the same repo", async () => {
    const [a, b] = await Promise.all([
      runInWorktree("task one", tmpRepo, makeFakeConfig()),
      runInWorktree("task two", tmpRepo, makeFakeConfig()),
    ]);
    expect(a.worktreePath).not.toBe(b.worktreePath);
    expect(a.branch).not.toBe(b.branch);
  });
});
```

**Mocking `runPipeline`:** Since `runInWorktree` imports `runPipeline` directly, use `vi.mock` at the top of the test file:
```ts
vi.mock("./pipeline.js", () => ({ runPipeline: vi.fn().mockResolvedValue({ success: true, /* ... */ }) }));
```
OR (preferred — matches existing run-manager.test.ts style) inject a stub via the `pipelineFn` parameter of `runManager.startRun` and refactor `runInWorktree` to ALSO accept a `pipelineFn?` for test injection. Either is acceptable.

### CLI subcommand test pattern
**Source:** `src/cli/commands/approve.test.ts:1-50`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveApprover } from "./approve.js";  // ← export pure helpers for direct testing

let tmpRoot: string;
beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "bober-approve-"));
  process.exitCode = undefined;
});
afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe("resolveApprover", () => {
  it("returns process.env.USER when set", () => { /* ... */ });
});
```
**Rule:** Test pure helper functions (e.g. `deriveWorktreeSlug`) directly. For the action handler, stub commander or just unit-test the orchestrator helper — most CLI tests in this codebase don't drive commander.parseAsync; they test the exported helpers.

### Full tool-name registration test (MUST update)
**Source:** `src/mcp/tools/tools.test.ts:8-13`
```ts
it("registers exactly 22 tools", async () => {
  const { registerAllTools, getAllTools } = await import("./index.js");
  registerAllTools();
  expect(getAllTools().length).toBe(22);
});
```
**Rule:** This test WILL fail unless you bump `22` → `23` AND add `"bober_run_in_worktree"` to the `expected` array on line 18.

### E2E Test Pattern
N/A — there is no Playwright/E2E suite for the orchestrator surface. The stop-conditions integration smoke (running `bober worktree run "trivial task"` against the repo) is a MANUAL check, not automated.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break

| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/orchestrator/pipeline.ts` | `getCurrentBranch, commitAll, getChangedFiles` from `git.ts` | low | Only adding new exports to git.ts; existing exports unchanged. |
| `src/mcp/tools/run.ts`, `anchor.ts`, `solidity.ts`, `brownfield.ts`, `react.ts` | `runManager.startRun(task, projectRoot, config)` | medium | startRun signature gains an optional `opts` arg AFTER pipelineFn. All existing 3-arg call sites must keep compiling — default arg covers them. |
| `src/mcp/tools/status.ts` | `runManager.getStatus()` | low | Returning a RunState that now has optional `worktreePath`/`branch` — both optional, no consumers will break. |
| `src/mcp/tools/get-run-status.ts` | full RunState JSON | low (positive impact) | Will automatically surface the new fields. sc-4-7 verifies this. |
| `src/mcp/tools/list-active-runs.ts`, `subscribe-events.ts` | RunState | low | Same — optional fields pass through. |
| `src/state/run-state.ts` | `import type { RunState }` | low | RunState extension is purely additive. |
| `src/mcp/tools/tools.test.ts` | tool count + tool names | **HIGH** | Will FAIL until `22` → `23` and `"bober_run_in_worktree"` added. |
| `src/index.ts:190` | `RunManager` export | low | No change to the class; type widens via optional fields only. |
| All `*.test.ts` files that construct `makeFakeConfig()` | `pipeline` section shape | low | New `worktreeRoot` and `cleanupWorktreeOnSuccess` fields are optional with defaults — old fixtures keep working. Confirmed by examining run-manager.test.ts, abort-run.test.ts, get-run-status.test.ts — all build a partial pipeline config and pass schema validation via defaults. |

### Existing Tests That Must Still Pass

- `src/mcp/run-manager.test.ts` — every test in this file. Especially: "two concurrent startRun calls succeed without throwing" (sc-1-5), "state.json on disk synchronously" (sc-1-2), all the `.then`/`.catch`/`load()` reconciliation tests.
- `src/mcp/tools/abort-run.test.ts` — uses `runManager.startRun(task, tmpDir, makeFakeConfig(), mockPipeline)` (4-arg form) and `(runManager as ...).runs.clear()`.
- `src/mcp/tools/get-run-status.test.ts` — same 4-arg form. The "returns full RunState JSON" test will now include `worktreePath`/`branch` fields when populated.
- `src/mcp/tools/list-active-runs.test.ts` — same.
- `src/mcp/tools/subscribe-events.test.ts` + `event-stream.test.ts` — independent surface; should not be touched by this sprint.
- `src/mcp/tools/tools.test.ts` — MUST be updated as described above (count 22→23, add name).
- `tests/graph/artifact-store.test.ts` — uses real git fixtures; serves as your template for the worktree fixtures.

### Features That Could Be Affected

- **Existing `bober_run` flow** — must continue to work in-place (no worktree), unchanged. Verify by running an in-place `bober run` smoke and confirming the RunState has NO `worktreePath`/`branch` fields.
- **`bober_get_run_status` (Sprint 2)** — automatically gains the new fields when the run was launched in a worktree. This is a feature, not a regression.
- **`bober_subscribe_events` (Sprint 3)** — totally orthogonal. Just ensure that events from a worktree run carry the same runId so subscribers can filter.

### Recommended Regression Checks

After implementation, the Generator MUST verify (in this order):
1. `npm run typecheck` — should pass with zero errors.
2. `npm run lint` — should pass.
3. `npm run build` — should pass.
4. `npm run test -- src/mcp/tools/tools.test.ts` — verify count bumped correctly.
5. `npm run test -- src/mcp/run-manager.test.ts` — verify Sprint 1 still passes (signature change is backwards-compatible).
6. `npm run test -- src/mcp/tools/abort-run.test.ts src/mcp/tools/get-run-status.test.ts src/mcp/tools/list-active-runs.test.ts` — Sprint 2 tools.
7. `npm run test -- src/orchestrator/worktree.test.ts src/cli/commands/worktree.test.ts src/mcp/tools/run-in-worktree.test.ts` — the new tests.
8. `npm run test` — full suite green.
9. Manual integration smoke (per stop-conditions): from repo root, `node dist/cli/index.js worktree run "trivial task"` against agent-bober itself. Confirm:
   - `.bober/worktrees/<runId>/` exists during the run
   - `git branch --list "bober/*"` shows the new branch
   - On success, the worktree directory is removed
   - `.bober/runs/<runId>/state.json` contains `worktreePath` and `branch`
10. Manual dirty-tree test: `echo x > some-tracked-file && node dist/cli/index.js worktree run "x"` → exit code 1, stderr lists `some-tracked-file`.

---

## 8. Implementation Sequence

Build in dependency order. Verify after each step before moving on.

1. **`src/config/schema.ts`** — add `worktreeRoot` and `cleanupWorktreeOnSuccess` to `PipelineSectionSchema` (around line 178) AND to the `createDefaultConfig` factory's `pipeline:` block.
   - Verify: `npm run typecheck` passes; no existing config consumers break (defaults make both optional).

2. **`src/utils/git.ts`** — append `addWorktree`, `removeWorktree`, `isClean` exports.
   - Verify: typecheck; manually invoke from a node REPL or write a smoke test that does `git init` in tmpdir, runs `addWorktree`, checks the dir exists, then `removeWorktree`.

3. **`src/mcp/run-manager.ts`** — extend `RunState` with `worktreePath?` and `branch?` fields; extend `startRun(...)` signature with `opts: StartRunOptions` param; thread `opts.runId / opts.worktreePath / opts.branch` into the constructed state.
   - Verify: typecheck; `npm run test -- src/mcp/run-manager.test.ts` still green (all 4-arg call sites unchanged).

4. **`src/orchestrator/worktree.ts`** — create the file. Export `deriveWorktreeSlug` AND `runInWorktree` AND `RunInWorktreeOpts`/`RunInWorktreeResult` types. Use `runManager.startRun(..., { runId, worktreePath, branch })`.
   - Verify: typecheck. The slug helper is pure — write the 5 fixture tests first to lock the behaviour.

5. **`src/orchestrator/worktree.test.ts`** — co-located tests covering dirty-tree rejection, allowDirty bypass, branch derivation, worktree path, cleanup-on-success, retain-on-failure, retain-on-keepOnSuccess, two-concurrent-runs, RunState population. Use real git fixtures (see Section 6).
   - Verify: `npm run test -- src/orchestrator/worktree.test.ts` passes.

6. **`src/cli/commands/worktree.ts`** — register `bober worktree run <task>` subcommand. Print result JSON to stdout on success; chalk-red stderr + exitCode=1 on failure.
   - Verify: typecheck. `node dist/cli/index.js worktree --help` shows the new command after build.

7. **`src/cli/commands/worktree.test.ts`** — co-located. Test pure helpers if you export any; otherwise smoke-test the orchestrator path indirectly (most CLI tests in this codebase only test pure helpers).
   - Verify: green.

8. **`src/cli/index.ts`** — import + call `registerWorktreeCommand(program)` in the registration block.
   - Verify: typecheck. `npm run build && node dist/cli/index.js worktree --help` lists the `run` subcommand.

9. **`src/mcp/tools/run-in-worktree.ts`** — register `bober_run_in_worktree` tool. Use `await runInWorktree(...)` and return the result JSON. Soft-error on dirty tree, hard-error (McpError) on missing config.
   - Verify: typecheck.

10. **`src/mcp/tools/run-in-worktree.test.ts`** — mirror `abort-run.test.ts` structure. Test: tool registered; throws McpError when task missing; returns runId/branch/worktreePath JSON; soft-error JSON on dirty tree.
    - Verify: passes.

11. **`src/mcp/tools/index.ts`** — import `registerRunInWorktreeTool`; call it inside `registerAllTools()` in the Async pipeline tools block; bump header doc comment to 23.

12. **`src/mcp/tools/tools.test.ts`** — bump count 22→23 and add `"bober_run_in_worktree"` to the expected array.
    - Verify: `npm run test -- src/mcp/tools/tools.test.ts` passes.

13. **`CHANGELOG.md`** — append the bullet group under `## [Unreleased]`.

14. **Run full verification** — `npm run typecheck && npm run lint && npm run build && npm run test`. All must pass per sc-4-8.

15. **Manual smoke** — exercise the stop-condition integration tests by hand (clean tree, dirty tree, concurrent runs).

---

## 9. Pitfalls & Warnings

- **DO NOT pass the original `projectRoot` to `runPipeline` inside `runInWorktree`.** The evaluator explicitly checks this: pipeline must run with `worktreePath` so commits land on the worktree's branch. This is the single most important correctness invariant.
- **DO NOT use `rm -rf` to clean up the worktree.** Use `git worktree remove` (which also cleans up the git metadata in the parent's `.git/worktrees/` directory). The evaluator explicitly checks for this.
- **DO NOT change `bober_run` to use a worktree by default.** `bober_run_in_worktree` is a NEW opt-in tool. The existing `bober_run` continues to run in-place. (Listed in `nonGoals`.)
- **DO NOT add a new git library.** No `simple-git`, no `isomorphic-git`. Shell out via `execa` only — the project already depends on `execa`.
- **`getCurrentBranch` returns the literal string `"HEAD"` when HEAD is detached.** Your fallback logic must detect this (not just catch a throw). Existing `pipeline.ts:113-118` only handles the throw case; you need the additional `=== "HEAD"` check.
- **Worktree slug edge cases:** an all-emoji task description produces an empty slug, which will produce an invalid branch name like `bober/`. Either reject empty slugs upfront or default to e.g. `bober/run-<short-runId>`. The contract does NOT specify behaviour here — pick one and document it in stderr.
- **The `pipeline.runPipeline` call inside `runInWorktree` may be slow (real LLM call).** Tests MUST mock it via `vi.mock("./pipeline.js", ...)` or by parameter-injecting a stub `pipelineFn`. Do NOT let tests spawn real agents.
- **`runManager.startRun` is fire-and-forget.** Its returned promise resolves AS SOON AS state.json is written, NOT when the pipeline completes. So `runInWorktree` should `return` the `{ runId, branch, worktreePath }` immediately after `startRun` resolves — its cleanup logic is wired via the wrapped `pipelineFn`'s `.then` chain, not awaited inline.
- **The default `branchPattern` is `"bober/{feature-name}"`** (literal curly-brace token). If the user has set a custom pattern that does NOT contain `{feature-name}`, the `.replace(...)` call is a no-op and you'll get the literal pattern as the branch name. This is fine but document the convention.
- **`tools.test.ts` will fail loudly** if you forget to bump the count from 22 to 23. This is a feature — the count test is intentional belt-and-suspenders.
- **`(runManager as unknown as { runs: Map<string, unknown> }).runs.clear();`** — required at the start of every test that uses the singleton. Tests share process state.
- **ESM import extensions:** `from "./worktree.js"` even though the file is `worktree.ts`. Same in tests. The build script depends on this.
- **`process.stderr.write(...)` not `console.error(...)`** in MCP tools — the MCP transport reserves stdout for JSON-RPC. The CLI subcommand may use either (it's not running over stdio MCP).
- **Worktree under `.bober/` is git-safe** ONLY when `.bober/` is gitignored. The agent-bober repo itself does NOT gitignore `.bober/` (we checked) — that's actually deliberate because agent-bober dogfoods. For agent-bober itself, the worktree will appear as a tracked directory. The contract's assumption says: "document in stderr" — so emit a one-line warning when `.bober/` is not in `.gitignore`. Soft check, not a hard error.
