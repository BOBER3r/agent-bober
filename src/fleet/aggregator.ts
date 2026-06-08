import { readRunStatesFromDisk } from "../state/run-state.js";
import type { RunState } from "../mcp/run-manager.js";
import type { ChildExecution, ChildOutcome, ChildStatus } from "./types.js";

// ── Status mapping ────────────────────────────────────────────────────

function mapStatus(s: RunState["status"]): ChildStatus {
  if (s === "completed") return "completed";
  if (s === "failed" || s === "aborted") return "failed";
  return "other"; // "running"
}

// ── OutcomeAggregator ─────────────────────────────────────────────────

export class OutcomeAggregator {
  async aggregate(execution: ChildExecution): Promise<ChildOutcome> {
    const { folder, scaffold, spawn } = execution;

    // Scaffold failed and no spawn → failed via exit-code source
    if (scaffold.error && !spawn) {
      return { folder, status: "failed", source: "exit-code", exitCode: -1 };
    }

    try {
      const states: RunState[] = await readRunStatesFromDisk(scaffold.absPath);
      if (states.length > 0) {
        // newest by startedAt — ISO-8601 strings sort lexicographically
        const newest = states.reduce((a, b) => (b.startedAt > a.startedAt ? b : a));
        return {
          folder,
          status: mapStatus(newest.status),
          source: "disk",
          runId: newest.runId,
          runState: newest,
        };
      }
    } catch {
      // readRunStatesFromDisk already swallows IO/JSON errors; guard anyway → fall through
    }

    const code = spawn?.exitCode ?? -1;
    return { folder, status: code === 0 ? "completed" : "failed", source: "exit-code", exitCode: code };
  }
}
