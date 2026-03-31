// ── bober_react tool ────────────────────────────────────────────────
//
// React web application workflow. Wraps bober_run with react-vite
// or nextjs preset configuration.

import { cwd } from "node:process";

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

import { configExists, loadConfig } from "../../config/loader.js";
import { registerTool } from "./registry.js";
import { runManager } from "../run-manager.js";

// ── Registration ─────────────────────────────────────────────────────

export function registerReactTool(): void {
  registerTool({
    name: "bober_react",
    description:
      "Start a React web application pipeline. Scaffolds, plans, and builds " +
      "React apps with Vite or Next.js, optional backend, and database. " +
      "Asynchronous — poll bober_status.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Description of the React web application to build.",
        },
        framework: {
          type: "string",
          enum: ["vite", "nextjs"],
          description: "React framework to use. Defaults to vite.",
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

      const framework = args.framework === "nextjs" ? "nextjs" : "react-vite";
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
      config.project.preset = framework;

      const runId = runManager.startRun(task, projectRoot, config);

      return JSON.stringify(
        {
          runId,
          status: "running",
          preset: framework,
          message: `React (${framework}) pipeline started. Use bober_status to check progress.`,
        },
        null,
        2,
      );
    },
  });
}
