/**
 * runProactiveReview — deterministic proactive review pass over HealthDataStore lab series.
 *
 * NO LLM / NO network. Fully deterministic and offline.
 * Finding ids are stable — re-running over an unchanged store with the same opts.now
 * overwrites the same files without creating duplicates (sc-1-4 idempotency).
 *
 * Mirrors src/cli/commands/medical.ts:155-215 (open-store / try / finally-close / vault-resolve).
 * Health.db path resolution mirrors src/medical/engine.ts:350.
 *
 * Accepts an optional opts.store for testability — if provided the caller owns the lifecycle
 * (this function will NOT close an injected store, mirrors engine.ts:342-347).
 */

import { join } from "node:path";

import { HealthDataStore } from "../health-store.js";
import { ensureDir } from "../../utils/fs.js";
import type { BoberConfig } from "../../config/schema.js";
import { analyzeTrends } from "./trends.js";
import { writeFinding, writeDashboard } from "./finding-writer.js";

// -- Types ----------------------------------------------------------------

/** Result returned by runProactiveReview. */
export interface ProactiveReviewResult {
  findingsWritten: number;
  dashboardPath: string;
  findingPaths: string[];
}

// -- Public API -----------------------------------------------------------

/**
 * Run the proactive trend review pass.
 *
 * Opens a HealthDataStore at <projectRoot>/.bober/medical/health.db (always closes in finally
 * unless store was injected). Resolves vaultDir from config.medical.vaultDir or the default
 * <projectRoot>/.bober/medical/vault.
 *
 * @param projectRoot  Absolute path to the project root
 * @param config       Loaded BoberConfig
 * @param opts         { now: ISO 8601 timestamp; biomarkers?: list; store?: injected store }
 */
export async function runProactiveReview(
  projectRoot: string,
  config: BoberConfig,
  opts: { now: string; biomarkers?: string[]; store?: HealthDataStore },
): Promise<ProactiveReviewResult> {
  // Resolve vault dir: config.medical.vaultDir or default
  const vaultDir =
    config.medical?.vaultDir ?? join(projectRoot, ".bober", "medical", "vault");

  const medicalDir = join(projectRoot, ".bober", "medical");

  // Store lifecycle: injected store (test) → caller owns; else open and own
  const weOpened = opts.store === undefined;
  let store: HealthDataStore | undefined = opts.store;

  try {
    if (weOpened) {
      await ensureDir(medicalDir);
      store = new HealthDataStore(join(medicalDir, "health.db"));
    }

    if (store === undefined) {
      // Defensive guard — unreachable in practice (weOpened=false => opts.store is set)
      throw new Error("[review-pass] HealthDataStore not available");
    }

    // Resolve biomarkers: use provided list or enumerate all from the store
    const biomarkers =
      opts.biomarkers !== undefined && opts.biomarkers.length > 0
        ? opts.biomarkers
        : store.listBiomarkers();

    const findings = analyzeTrends(store, biomarkers, { now: opts.now });

    // Write one finding note per detected condition
    const findingPaths: string[] = [];
    for (const finding of findings) {
      const path = await writeFinding(vaultDir, finding);
      findingPaths.push(path);
    }

    // Always write the dashboard (sc-1-5)
    const dashboardPath = await writeDashboard(vaultDir);

    return {
      findingsWritten: findings.length,
      dashboardPath,
      findingPaths,
    };
  } finally {
    // Only close stores we opened; never close an injected store (sc-1-4 / `:memory:` tests)
    if (weOpened && store !== undefined) {
      store.close();
    }
  }
}
