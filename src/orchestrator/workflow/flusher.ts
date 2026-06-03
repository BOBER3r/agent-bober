// ── RunResultFlusher ─────────────────────────────────────────────────
//
// Host-side flusher: commits a WorkflowRunResult from the JS workflow script
// to durable .bober/ state. This class is the ONLY clock source for the
// workflow engine — new Date() is called here, never in the script.
//
// Flush strategy:
//   - Per-contract: update status + write contract, then updateProgress (crash-safe).
//   - pendingHistory: appended ONCE after all contracts have been flushed
//     (history entries are not per-contract; the list is global to the run).
//     Re-flushing the same result appends the same entries again — callers
//     must ensure idempotency at the orchestration layer (skip-completed cursor).

import type { BoberConfig } from "../../config/schema.js";
import type { SprintContract } from "../../contracts/sprint-contract.js";
import { updateContractStatus } from "../../contracts/sprint-contract.js";
import { updateContract, loadContract, listContracts } from "../../state/sprint-state.js";
import { appendHistory, updateProgress } from "../../state/history.js";
import { ensureBoberDir, saveSpec } from "../../state/index.js";
import type { WorkflowRunResult } from "./types.js";
import type { PipelineResult } from "../pipeline.js";

export class RunResultFlusher {
  /**
   * Commit a WorkflowRunResult to durable .bober/ state.
   *
   * Write sequence (mirrors pipeline.ts:381-394):
   *   1. For each sprint: updateContractStatus → updateContract (crash-safe per-contract).
   *   2. updateProgress after each contract (cumulative list, crash-safe).
   *   3. After all contracts: appendHistory for each pendingHistory entry (stamped).
   *   4. Save the spec.
   *   5. Return PipelineResult.
   */
  async flush(
    projectRoot: string,
    _config: BoberConfig,
    result: WorkflowRunResult,
  ): Promise<PipelineResult> {
    const startTime = Date.now();

    await ensureBoberDir(projectRoot);

    const completedSprints: SprintContract[] = [];
    const failedSprints: SprintContract[] = [];

    // ── Per-contract loop (crash-safe: flush after each) ────────────────

    for (const sprint of result.perSprint) {
      const contractStatus =
        sprint.outcome === "passed"
          ? "passed"
          : sprint.outcome === "needs-rework"
            ? "needs-rework"
            : "failed";

      // Stamp updatedAt / completedAt (host is the only clock)
      const stamped = updateContractStatus(sprint.contract, contractStatus);

      // Persist — atomic per file (updateContract = saveContract with same id)
      await updateContract(projectRoot, stamped);

      // Accumulate before updateProgress so the progress file always reflects
      // all contracts flushed so far
      if (contractStatus === "passed") {
        completedSprints.push(stamped);
      } else {
        failedSprints.push(stamped);
      }

      // updateProgress with cumulative list (crash-safe checkpoint after each contract)
      await updateProgress(
        projectRoot,
        [...completedSprints, ...failedSprints],
        result.spec,
      );
    }

    // ── History: append all pendingHistory entries with stamped timestamps ──
    //
    // Appended once after the per-contract loop. Each entry receives a fresh
    // new Date().toISOString() stamp here — the script passed Omit<HistoryEntry,"timestamp">.

    for (const partial of result.pendingHistory) {
      await appendHistory(projectRoot, {
        ...partial,
        timestamp: new Date().toISOString(),
      });
    }

    // ── Persist the spec ────────────────────────────────────────────────

    await saveSpec(projectRoot, result.spec);

    // ── Return PipelineResult (pipeline.ts:809-810 success formula) ─────

    return {
      success: failedSprints.length === 0 && completedSprints.length > 0,
      spec: result.spec,
      completedSprints,
      failedSprints,
      duration: Date.now() - startTime,
      needsClarification: result.needsClarification,
    };
  }
}

// Re-export for test convenience (allows tests to load contracts back without
// importing sprint-state directly if they already import flusher).
export { loadContract, listContracts };
