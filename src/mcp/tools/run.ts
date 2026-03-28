// ── bober_run tool ───────────────────────────────────────────────────
//
// Accepts { task: string }, starts the full pipeline asynchronously,
// and returns immediately with a runId. The pipeline runs in the
// background; poll bober_status to track progress.

import { cwd } from "node:process";

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

import { configExists, loadConfig } from "../../config/loader.js";
import { registerTool } from "./registry.js";
import { runManager } from "../run-manager.js";

// ── Registration ─────────────────────────────────────────────────────

export function registerRunTool(): void {
  registerTool({
    name: "bober_run",
    description:
      "Start the full Bober pipeline (plan + sprint + eval) asynchronously. " +
      "Accepts a task description and returns immediately with a runId. " +
      "Use bober_status to poll progress. Only one pipeline can run at a time.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "Feature or project description to build. Passed to the planner.",
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

      const projectRoot = cwd();

      // Require a bober config before starting
      const hasConfig = await configExists(projectRoot);
      if (!hasConfig) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          "No bober.config.json found. Run bober_init first.",
        );
      }

      // Reject concurrent runs with a clear error
      if (runManager.isRunning()) {
        const state = runManager.getStatus();
        throw new McpError(
          ErrorCode.InvalidRequest,
          `A pipeline is already running (runId: ${state!.runId}). Use bober_status to check progress.`,
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

      const runId = runManager.startRun(task, projectRoot, config);

      process.stderr.write(
        `[bober_run] Started pipeline run ${runId} for task: ${task.slice(0, 100)}\n`,
      );

      return JSON.stringify(
        {
          runId,
          status: "running",
          message:
            "Pipeline started. Use bober_status to check progress.",
        },
        null,
        2,
      );
    },
  });
}
