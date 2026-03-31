// ── bober_solidity tool ─────────────────────────────────────────────
//
// EVM smart contract workflow. Wraps bober_run with solidity preset.

import { cwd } from "node:process";

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

import { configExists, loadConfig } from "../../config/loader.js";
import { registerTool } from "./registry.js";
import { runManager } from "../run-manager.js";

// ── Registration ─────────────────────────────────────────────────────

export function registerSolidityTool(): void {
  registerTool({
    name: "bober_solidity",
    description:
      "Start an EVM smart contract pipeline. Scaffolds Hardhat or Foundry " +
      "projects, plans contract architecture, implements with security best " +
      "practices, and evaluates with compilation, linting, and test coverage. " +
      "Asynchronous — poll bober_status.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Description of the smart contracts to build.",
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
      config.project.preset = "solidity";

      const runId = runManager.startRun(task, projectRoot, config);

      return JSON.stringify(
        {
          runId,
          status: "running",
          preset: "solidity",
          message: "Solidity pipeline started. Use bober_status to check progress.",
        },
        null,
        2,
      );
    },
  });
}
