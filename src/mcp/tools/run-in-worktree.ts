// ── bober_run_in_worktree tool ────────────────────────────────────────
//
// Like bober_run, but creates a git worktree under .bober/worktrees/<runId>
// and runs the pipeline inside it. Returns immediately with
// { runId, branch, worktreePath, status: 'running' }. The pipeline runs
// fire-and-forget; poll bober_get_run_status by runId to track progress.
//
// Unlike bober_run, this tool does NOT reject when another run is in
// progress — the whole point of worktrees is parallel runs.
//
// Sprint 4 (cockpit-integration)

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
        task: {
          type: "string",
          description: "Task description to pass to the planner.",
        },
        allowDirty: {
          type: "boolean",
          description:
            "Allow worktree creation even when the working tree has uncommitted changes. Default false.",
        },
        keepOnSuccess: {
          type: "boolean",
          description: "Retain the worktree after a successful run. Default false.",
        },
      },
      required: ["task"],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>): Promise<string> => {
      const task = String(args.task ?? "").trim();
      if (!task) {
        return JSON.stringify({
          error: "task is required and must be a non-empty string.",
        });
      }

      const allowDirty = args.allowDirty === true;
      const keepOnSuccess = args.keepOnSuccess === true;

      const projectRoot = cwd();

      const hasConfig = await configExists(projectRoot);
      if (!hasConfig) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          "No bober.config.json found. Run bober_init first.",
        );
      }

      let config;
      try {
        config = await loadConfig(projectRoot);
      } catch (err) {
        return JSON.stringify({
          error: `Failed to load config: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      let result;
      try {
        result = await runInWorktree(task, projectRoot, config, {
          allowDirty,
          keepOnSuccess,
        });
      } catch (err) {
        // Dirty-tree errors and addWorktree failures bubble through here.
        // Surface as soft-error JSON so the cockpit can render them.
        return JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        });
      }

      process.stderr.write(
        `[bober_run_in_worktree] Started run ${result.runId} on ${result.branch} at ${result.worktreePath}\n`,
      );

      return JSON.stringify(
        {
          runId: result.runId,
          branch: result.branch,
          worktreePath: result.worktreePath,
          status: "running",
        },
        null,
        2,
      );
    },
  });
}
