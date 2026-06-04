// ── EngineConformanceHarness ────────────────────────────────────────

import { listContracts } from "../../state/sprint-state.js";
import { loadHistory } from "../../state/history.js";
import { logger } from "../../utils/logger.js";
import type { PipelineEngineName } from "./engine.js";
import type { ConformanceReport } from "./types.js";

// ── Types ───────────────────────────────────────────────────────────

/** Deterministic runner the TEST injects — NOT a real engine. */
export type EngineRunner = (projectRoot: string) => Promise<void>;

// ── Normalization ────────────────────────────────────────────────────

// Volatile fields stripped before deep-compare.
// Covers: SprintContract, PlanSpec, HistoryEntry, EvalResult, PipelineResult
const VOLATILE_KEYS = new Set([
  "createdAt",
  "updatedAt",
  "startedAt",
  "completedAt",
  "timestamp",
  "duration",
  "runId",
  "totalCost",
]);

/**
 * Recursively deep-clone an object, stripping all volatile fields at every depth.
 * This lets the harness compare normalized .bober/ artifacts across engines
 * without noise from timestamps, durations, or run IDs.
 */
function normalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(normalize);
  }

  const obj = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!VOLATILE_KEYS.has(k)) {
      result[k] = normalize(v);
    }
  }
  return result;
}

// ── EngineConformanceHarness ─────────────────────────────────────────

/**
 * Asserts that two or more pipeline engines produce equivalent .bober/ artifacts
 * for a given fixture spec, ignoring volatile fields (timestamps, durations, runIds).
 *
 * DESIGN: No real engines run internally. The caller provides `runnerFor` which
 * returns a deterministic EngineRunner per engine name. Each runner writes fixed
 * .bober/ artifacts to a fresh projectRoot supplied by projectRootFactory().
 * The harness reads back, normalizes, and deep-compares.
 */
export class EngineConformanceHarness {
  /**
   * Run each engine's runner against a fresh projectRoot, read back artifacts,
   * normalize (strip volatile fields), and deep-compare across engine pairs.
   *
   * @param fixtureSpecId   The spec ID to pass to runners (informational).
   * @param engines         Names of engines to compare (at least two for a diff).
   * @param projectRootFactory  Returns a FRESH temporary root per engine.
   * @param runnerFor       Returns the deterministic EngineRunner for each engine.
   * @returns ConformanceReport with equivalent:true if all artifacts match.
   */
  async assertEquivalent(
    fixtureSpecId: string,
    engines: PipelineEngineName[],
    projectRootFactory: () => Promise<string>,
    runnerFor: (engine: PipelineEngineName) => EngineRunner,
  ): Promise<ConformanceReport> {
    // ── Collect per-engine normalized artifacts ─────────────────────────────

    const perEngine: Record<
      string,
      {
        contracts: unknown[];
        history: unknown[];
      }
    > = {};

    for (const engine of engines) {
      const root = await projectRootFactory();
      const runner = runnerFor(engine);

      logger.debug(
        `[conformance] running ${engine} runner against ${root} (specId=${fixtureSpecId})`,
      );

      await runner(root);

      const rawContracts = await listContracts(root);
      const rawHistory = await loadHistory(root);

      perEngine[engine] = {
        contracts: normalize(rawContracts) as unknown[],
        history: normalize(rawHistory) as unknown[],
      };
    }

    // ── Deep-compare normalized artifacts across engine pairs ───────────────

    const diffs: ConformanceReport["diffs"] = [];

    for (let i = 0; i < engines.length; i++) {
      for (let j = i + 1; j < engines.length; j++) {
        const nameA = engines[i];
        const nameB = engines[j];
        const a = perEngine[nameA];
        const b = perEngine[nameB];

        // Compare contracts
        if (JSON.stringify(a.contracts) !== JSON.stringify(b.contracts)) {
          diffs.push({
            artifact: "contract",
            path: ".bober/contracts/",
            engines: [nameA, nameB],
          });
        }

        // Compare history
        if (JSON.stringify(a.history) !== JSON.stringify(b.history)) {
          diffs.push({
            artifact: "history",
            path: ".bober/history.jsonl",
            engines: [nameA, nameB],
          });
        }
      }
    }

    const report: ConformanceReport = {
      equivalent: diffs.length === 0,
      diffs,
    };

    if (!report.equivalent) {
      logger.info(
        `[conformance] artifact divergence detected: ${diffs.length} diff(s) across engines [${engines.join(", ")}]`,
      );
    }

    return report;
  }
}
