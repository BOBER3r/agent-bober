// ── bober_status tool ────────────────────────────────────────────────
//
// Returns the current pipeline run state.
// - If a run is active: {runId, status: 'running', progress}
// - If a run completed/failed: {runId, status: 'completed'|'failed', result}
// - If no run ever started: {status: 'idle', progress: <progress.md content>}

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cwd } from "node:process";

import { registerTool } from "./registry.js";
import { runManager } from "../run-manager.js";

// ── Registration ─────────────────────────────────────────────────────

export function registerStatusTool(): void {
  registerTool({
    name: "bober_status",
    description:
      "Check the status of the running or most recent Bober pipeline. " +
      "Returns progress when active, or the final result when complete. " +
      "When idle, returns the contents of .bober/progress.md.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: async (_args: Record<string, unknown>): Promise<string> => {
      const state = runManager.getStatus();

      // No run has ever been started
      if (state === null) {
        const projectRoot = cwd();
        const progressPath = join(projectRoot, ".bober", "progress.md");
        let progressContent: string;
        try {
          progressContent = await readFile(progressPath, "utf-8");
        } catch {
          progressContent = "No progress information available yet. Run bober_run to start a pipeline.";
        }

        return JSON.stringify(
          {
            status: "idle",
            progress: progressContent,
          },
          null,
          2,
        );
      }

      // Active run
      if (state.status === "running") {
        return JSON.stringify(
          {
            runId: state.runId,
            status: state.status,
            task: state.task,
            startedAt: state.startedAt,
            progress: state.progress,
          },
          null,
          2,
        );
      }

      // Completed run
      if (state.status === "completed") {
        return JSON.stringify(
          {
            runId: state.runId,
            status: state.status,
            task: state.task,
            startedAt: state.startedAt,
            completedAt: state.completedAt,
            result: state.result,
          },
          null,
          2,
        );
      }

      // Failed run
      return JSON.stringify(
        {
          runId: state.runId,
          status: state.status,
          task: state.task,
          startedAt: state.startedAt,
          completedAt: state.completedAt,
          error: state.error,
          result: state.result,
        },
        null,
        2,
      );
    },
  });
}
