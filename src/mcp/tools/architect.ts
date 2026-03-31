// ── bober_architect tool ─────────────────────────────────────────────
//
// Runs the 5-checkpoint architect flow in autonomous mode.
// Accepts { task: string }, produces an architecture document + ADRs.

import { cwd } from "node:process";

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

import { configExists, loadConfig } from "../../config/loader.js";
import { runArchitect } from "../../orchestrator/architect-agent.js";
import { ensureBoberDir } from "../../state/index.js";
import { registerTool } from "./registry.js";

// ── Registration ─────────────────────────────────────────────────────

export function registerArchitectTool(): void {
  registerTool({
    name: "bober_architect",
    description:
      "Run the Bober solution architect agent. Produces an architecture " +
      "document with ADRs through a 5-checkpoint flow: problem framing, " +
      "approach selection, component design, integration strategy, and " +
      "final assembly. Saves to .bober/architecture/. Does NOT generate code.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Feature or system description to architect.",
        },
        researchDoc: {
          type: "string",
          description:
            "Optional research findings to provide codebase context. " +
            "If omitted, the architect reads the codebase directly.",
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

      const researchDoc =
        typeof args.researchDoc === "string" && args.researchDoc.trim()
          ? args.researchDoc.trim()
          : undefined;

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

      await ensureBoberDir(projectRoot);

      try {
        const result = await runArchitect(task, projectRoot, config, researchDoc);

        return JSON.stringify(
          {
            architectureId: result.id,
            documentPath: `.bober/architecture/${result.id}-architecture.md`,
            adrCount: result.decisionCount,
            componentCount: result.componentCount,
            documentLines: result.document.split("\n").length,
            timestamp: result.timestamp,
            summary: result.document.slice(0, 500),
          },
          null,
          2,
        );
      } catch (err) {
        return JSON.stringify({
          error: `Architect failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
  });
}
