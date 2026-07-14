import type { FindingStore } from "./finding-port.js";
import type { PromotionRef } from "./types.js";
import { readRunState } from "../state/run-state.js";
import type { RunState } from "../mcp/run-manager.js";

// ── ReconcileDeps ─────────────────────────────────────────────────────

/**
 * Injected dependencies for reconcilePromotions.
 * Keeps the core pure so tests can inject a run-state fake without a real run.
 */
export interface ReconcileDeps {
  store: FindingStore;
  /**
   * Injected run-state reader.
   * CLI passes `(runId) => readRunState(projectRoot, runId)`.
   * Tests inject a fake that returns a predetermined RunState or null.
   */
  readState: (runId: string) => Promise<RunState | null>;
  /** Clock injection — never call new Date() inside the core. */
  now: () => string;
}

// ── ReconcileSummary ──────────────────────────────────────────────────

/** Counts of findings advanced in a single reconcilePromotions pass. */
export interface ReconcileSummary {
  /** Findings transitioned to 'done' (run completed). */
  completed: number;
  /** Findings returned to 'open' (run aborted or failed). */
  aborted: number;
  /** Findings left unchanged (run still running, missing, or unrecognised). */
  unchanged: number;
}

// ── reconcilePromotions (DI core) ─────────────────────────────────────

/**
 * For each Finding whose promotesTo.status is 'launched', read the linked
 * run's state.json snapshot and advance the Finding to its terminal status.
 *
 * Transition table:
 *   run 'completed'          → finding 'done',  promotesTo.status 'completed'
 *   run 'aborted'|'failed'   → finding 'open',  promotesTo.status 'aborted'
 *   run 'running' (or null)  → finding unchanged (no write)
 *
 * PURE-ish: all I/O is injected. Never throws — per-finding failures are
 * swallowed internally. Reads the current snapshot and returns immediately;
 * does NOT poll or block waiting for an in-flight run to finish.
 */
export async function reconcilePromotions(deps: ReconcileDeps): Promise<ReconcileSummary> {
  const { store, readState, now } = deps;
  const summary: ReconcileSummary = { completed: 0, aborted: 0, unchanged: 0 };

  const promoted = await store.listPromoted();
  const launched = promoted.filter((f) => f.promotesTo?.status === "launched");

  for (const finding of launched) {
    try {
      // promotesTo is guaranteed non-undefined by the filter above
      const ref = finding.promotesTo as PromotionRef;
      const state = await readState(ref.runId);

      if (state === null) {
        // Missing or corrupt run-state file → treat as "still running"
        summary.unchanged++;
        continue;
      }

      if (state.status === "completed") {
        const updatedRef: PromotionRef = { ...ref, status: "completed" };
        await store.applyOutcome(finding.id, "done", updatedRef, { now: now() });
        summary.completed++;
      } else if (state.status === "aborted" || state.status === "failed") {
        const updatedRef: PromotionRef = { ...ref, status: "aborted" };
        await store.applyOutcome(finding.id, "open", updatedRef, { now: now() });
        summary.aborted++;
      } else {
        // 'running', 'input-required', 'paused' — leave unchanged
        summary.unchanged++;
      }
    } catch {
      // Per-finding error: swallow and count as unchanged (belt and suspenders).
      // reconcilePromotions MUST NOT throw.
      summary.unchanged++;
    }
  }

  return summary;
}

// ── reconcilePromotionsForRoot (CLI wrapper) ──────────────────────────

/**
 * Thin wrapper around reconcilePromotions that injects the real readRunState
 * adapter for a given project root. Called by the `bober do` CLI handler.
 *
 * Caller is responsible for wrapping this in try/catch so a reconcile failure
 * can never abort the enclosing command (mirrors seedProjectFacts in
 * src/orchestrator/pipeline.ts:981).
 */
export async function reconcilePromotionsForRoot(
  projectRoot: string,
  store: FindingStore,
  now: () => string,
): Promise<ReconcileSummary> {
  return reconcilePromotions({
    store,
    readState: (runId) => readRunState(projectRoot, runId),
    now,
  });
}
