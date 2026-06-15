// ── roster-reader.ts ──────────────────────────────────────────────────
//
// Read-only wrapper over readRunStatesFromDisk for chat context.
// Uses readRunStatesFromDisk (read-only) — never the reconciling load method.

import { readRunStatesFromDisk } from "../state/run-state.js";
import type { RunState } from "../mcp/run-manager.js";

// ── RosterReader ──────────────────────────────────────────────────────

export class RosterReader {
  private readonly projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  /**
   * Read all run states from disk. Delegated entirely to readRunStatesFromDisk
   * which is purely read-only and never mutates disk state.
   */
  async read(): Promise<RunState[]> {
    return readRunStatesFromDisk(this.projectRoot);
  }

  /**
   * Produce a compact human-readable summary of the given run states.
   * Used for /runs slash-command output and as LLM prompt context.
   */
  summarize(states: RunState[]): string {
    if (states.length === 0) {
      return "No runs found.";
    }

    const lines: string[] = [`Runs (${states.length} total):`];
    for (const s of states) {
      const completed = s.completedAt ? ` completed=${s.completedAt}` : "";
      const spec = s.specId ? ` spec=${s.specId}` : "";
      lines.push(
        `  [${s.status.toUpperCase()}] ${s.runId}  task="${s.task}"${spec}  started=${s.startedAt}${completed}`,
      );
    }

    return lines.join("\n");
  }
}
