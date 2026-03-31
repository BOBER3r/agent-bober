// ── bober_brownfield tool ────────────────────────────────────────────
//
// Brownfield workflow: deep codebase analysis + conservative planning.
// Wraps bober_run with brownfield-specific configuration overrides.

import { cwd } from "node:process";

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

import { configExists, loadConfig } from "../../config/loader.js";
import { registerTool } from "./registry.js";
import { runManager } from "../run-manager.js";

// ── Registration ─────────────────────────────────────────────────────

export function registerBrownfieldTool(): void {
  registerTool({
    name: "bober_brownfield",
    description:
      "Start a brownfield pipeline for adding features to an existing codebase. " +
      "Runs deep codebase analysis, conservative sprint planning, and " +
      "regression-focused evaluation. Asynchronous — poll bober_status.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Feature description to add to the existing codebase.",
        },
      },
      required: ["task"],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>): Promise<string> => {
      const task = String(args.task ?? "").trim();
      if (!task) {
        return JSON.stringify({ error: "task is required and must be a non-empty string." });
      }

      const projectRoot = cwd();

      const hasConfig = await configExists(projectRoot);
      if (!hasConfig) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          "No bober.config.json found. Run bober_init first.",
        );
      }

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

      // Apply brownfield overrides
      config.project.mode = "brownfield";
      config.sprint.sprintSize = "small";
      config.pipeline.researchPhase = true;

      const runId = runManager.startRun(task, projectRoot, config);

      return JSON.stringify(
        {
          runId,
          status: "running",
          mode: "brownfield",
          message: "Brownfield pipeline started. Use bober_status to check progress.",
        },
        null,
        2,
      );
    },
  });
}
