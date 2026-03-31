// ── bober_anchor tool ───────────────────────────────────────────────
//
// Solana program workflow using Anchor. Wraps bober_run with anchor preset.

import { cwd } from "node:process";

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

import { configExists, loadConfig } from "../../config/loader.js";
import { registerTool } from "./registry.js";
import { runManager } from "../run-manager.js";

// ── Registration ─────────────────────────────────────────────────────

export function registerAnchorTool(): void {
  registerTool({
    name: "bober_anchor",
    description:
      "Start a Solana program pipeline using Anchor. Plans program " +
      "architecture, implements with proper account validation, and " +
      "evaluates with build, test, and security checks. " +
      "Asynchronous — poll bober_status.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Description of the Solana program to build.",
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
          `A pipeline is already running (runId: ${state!.runId}).`,
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

      config.project.mode = "greenfield";
      config.project.preset = "anchor";

      const runId = runManager.startRun(task, projectRoot, config);

      return JSON.stringify(
        {
          runId,
          status: "running",
          preset: "anchor",
          message: "Anchor pipeline started. Use bober_status to check progress.",
        },
        null,
        2,
      );
    },
  });
}
