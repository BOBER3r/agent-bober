// ── bober_research tool ─────────────────────────────────────────────
//
// Runs the two-phase research process: generates exploration questions
// from the feature description, then explores the codebase using ONLY
// those questions. Produces a fact-only research document.

import { cwd } from "node:process";

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

import { configExists, loadConfig } from "../../config/loader.js";
import { runResearch } from "../../orchestrator/research-agent.js";
import { ensureBoberDir } from "../../state/index.js";
import { registerTool } from "./registry.js";

// ── Registration ─────────────────────────────────────────────────────

export function registerResearchTool(): void {
  registerTool({
    name: "bober_research",
    description:
      "Run the Bober two-phase research process. Phase 1 generates " +
      "exploration questions from the feature description. Phase 2 " +
      "explores the codebase using ONLY those questions (no feature " +
      "knowledge) to produce a fact-only research document. Saves to " +
      ".bober/research/.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Feature description to research the codebase for.",
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
        const result = await runResearch(task, projectRoot, config);

        return JSON.stringify(
          {
            researchId: result.id,
            documentPath: `.bober/research/${result.id}.md`,
            questionCount: result.questions.length,
            questions: result.questions,
            findingsLines: result.findings.split("\n").length,
            filesExplored: result.filesExplored,
            timestamp: result.timestamp,
          },
          null,
          2,
        );
      } catch (err) {
        return JSON.stringify({
          error: `Research failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
  });
}
