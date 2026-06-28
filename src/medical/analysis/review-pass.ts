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
 *
 * Sprint 4 extension: also runs detectTestGaps (cadence.ts) and detectCrossMarkerPatterns
 * (cross-marker.ts) in the same offline pass. All finding ids use DISTINCT ruleKeys so they
 * never collide with trend ids and idempotency (sc-1-4) is preserved.
 *
 * digDeeper: reads an offer finding from disk, recovers its marker pair from frontmatter tags,
 * and delegates the deep analysis to generateRecommendation (the ONLY LLM step in this module).
 */

import { join } from "node:path";
import { readFile } from "node:fs/promises";

import { HealthDataStore } from "../health-store.js";
import { ensureDir } from "../../utils/fs.js";
import type { BoberConfig } from "../../config/schema.js";
import { analyzeTrends } from "./trends.js";
import { detectTestGaps } from "./cadence.js";
import { detectCrossMarkerPatterns } from "./cross-marker.js";
import { writeFinding, writeDashboard } from "./finding-writer.js";
import { parseFrontmatter } from "../../vault/frontmatter.js";
import { generateRecommendation } from "../recommend/recommend.js";
import type { RecommendDeps, RecommendOutcome } from "../recommend/recommend.js";

// -- Types ----------------------------------------------------------------

/** Result returned by runProactiveReview. */
export interface ProactiveReviewResult {
  findingsWritten: number;
  dashboardPath: string;
  findingPaths: string[];
}

/**
 * Injectable dependencies for digDeeper.
 * Production callers pass no deps. Tests inject a generateRecommendation spy
 * to assert delegation without triggering real LLM/network calls (sc-4-6).
 */
export interface DigDeeperDeps {
  /** Injected for sc-4-6 spy — defaults to the real generateRecommendation. */
  generateRecommendation?: typeof generateRecommendation;
  /** Forwarded to generateRecommendation for its own test deps. */
  recommendDeps?: RecommendDeps;
}

// -- Public API -----------------------------------------------------------

/**
 * Run the proactive trend review pass.
 *
 * Opens a HealthDataStore at <projectRoot>/.bober/medical/health.db (always closes in finally
 * unless store was injected). Resolves vaultDir from config.medical.vaultDir or the default
 * <projectRoot>/.bober/medical/vault.
 *
 * Sprint 4: emits trend + gap + cross-marker-offer findings in one deterministic offline pass.
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

    // Sprint 4: gather trend + gap + cross-marker-offer findings in one offline pass.
    // Each analyzer uses a DISTINCT ruleKey so ids never collide and idempotency holds (sc-1-4).
    const findings = [
      ...analyzeTrends(store, biomarkers, { now: opts.now }),
      ...detectTestGaps(store, biomarkers, { now: opts.now }),
      ...detectCrossMarkerPatterns(store, { now: opts.now }),
    ];

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

/**
 * Run deeper cross-marker analysis for a given offer finding id (the ONLY LLM step here).
 *
 * Reads the offer finding note from disk, recovers the marker pair from its frontmatter tags
 * (tags: ["cross-marker", markerA, markerB]), frames a question, and delegates to
 * generateRecommendation (sprint 3). Does NOT re-implement the judge loop.
 *
 * @param projectRoot  Absolute project root path
 * @param config       Loaded BoberConfig
 * @param offerId      Finding id of the cross-marker offer note
 * @param opts         { now: ISO 8601 injected timestamp }
 * @param deps         Optional injectable deps (tests inject a generateRecommendation spy)
 */
export async function digDeeper(
  projectRoot: string,
  config: BoberConfig,
  offerId: string,
  opts: { now: string },
  deps: DigDeeperDeps = {},
): Promise<RecommendOutcome> {
  const vaultDir =
    config.medical?.vaultDir ?? join(projectRoot, ".bober", "medical", "vault");
  const notePath = join(vaultDir, "findings", `${offerId}.md`);
  const raw = await readFile(notePath, "utf-8");
  const { frontmatter } = parseFrontmatter(raw);
  const tags = (frontmatter["tags"] as string[] | undefined) ?? [];
  // Recover marker pair: filter out the "cross-marker" sentinel; remainder is [markerA, markerB]
  const pair = tags.filter((t) => t !== "cross-marker");
  const question =
    `The markers ${pair.join(" and ")} are both out of reference range. ` +
    `Dig deeper into what that combination suggests.`;
  const gen = deps.generateRecommendation ?? generateRecommendation;
  return gen(projectRoot, config, { question, now: opts.now }, deps.recommendDeps);
}
