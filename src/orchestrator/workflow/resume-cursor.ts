// ── ResumeCursorReconstructor ───────────────────────────────────────

import { listContracts } from "../../state/sprint-state.js";
import { loadHistory } from "../../state/history.js";
import type { ResumeCursor } from "./types.js";

/**
 * Reconstructs a ResumeCursor from durable contract status and history.
 * Contract status is the source of truth — history is corroboration only.
 * When history and contract status conflict, contract status wins.
 */
export class ResumeCursorReconstructor {
  async reconstruct(projectRoot: string, specId: string): Promise<ResumeCursor> {
    const contracts = (await listContracts(projectRoot)).filter(
      (c) => c.specId === specId,
    );

    // Corroborate with history, but contract status WINS on conflict
    await loadHistory(projectRoot);

    const completed = contracts
      .filter((c) => c.status === "passed" || c.status === "completed")
      .map((c) => c.sprintNumber);

    const allNumbers = contracts.map((c) => c.sprintNumber);

    return {
      specId,
      completedSprintNumbers: [...completed].sort((a, b) => a - b),
      lastObservedSprintNumber: allNumbers.length ? Math.max(...allNumbers) : 0,
    };
  }
}
