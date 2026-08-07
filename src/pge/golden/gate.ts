// ── The golden gate — what `scripts/run-golden-regression.mjs` actually runs ──

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { TopologySpecSchema } from "../../contracts/topology.js";
import { EFFECTS } from "../nodes/effects.js";
import { CODING_GRAPH_ID } from "../topology/coding.graph.js";
import { topologyArtifactPath } from "../topology/dump.js";
import type { GoldenGraphFacts } from "./case-schema.js";
import { createGoldenExecutor } from "./executor.js";
import {
  DEFAULT_MIN_PASS_RATE_PERCENT,
  GOLDEN_EXIT,
  formatGoldenRegressionReport,
  runGoldenRegressionFromDir,
} from "./runner.js";
import type { GoldenDatasetBounds, GoldenExecutor, GoldenExitCode } from "./runner.js";

/**
 * The single decision the blocking CI step makes, in TypeScript so it can be tested.
 *
 * `scripts/run-golden-regression.mjs` is a shim over {@link runGoldenGate} and decides
 * nothing of its own. That split is not tidiness: a `.mjs` script is invisible to `tsc`,
 * to ESLint and to Vitest, so gate logic living there is gate logic no negative control
 * can reach — and an untested gate is exactly the decorative gate this sprint exists to
 * refuse. Everything below has a test that breaks its precondition and asserts a non-zero
 * exit.
 *
 * ── WHAT THIS GATE ENFORCES, EXACTLY ──
 *
 * Two halves, and BOTH are live. Saying so here rather than in a commit message is the
 * point: a reader must not have to run the job to learn what it checks.
 *
 * **Dataset integrity against the committed graph, for every case.** Every case loads,
 * parses against `GoldenCaseSchema`, the directory holds between 20 and 50 files and
 * nothing else, ids are unique and match filenames, the dataset keeps its floor of
 * executable cases, and — the half with teeth over time — every node id and effect name a
 * case pins still exists in `.bober/topology/coding.json` and in {@link EFFECTS}. Rename a
 * node or drop an effect and this fails until the affected cases are re-pinned.
 *
 * **The runtime pass rate, for every `replay` case.** Each of those is EXECUTED against
 * the shipped `PgeEngine` over the committed artifact, in a throwaway root, with every
 * outward call answered from the case's own pinned responses — see `executor.ts` — and the
 * artifacts the run leaves behind are compared with the expectation. A run that stops
 * producing the same artifacts drops the pass rate below the threshold and the job fails.
 *
 * ── The executor is NOT optional, and that is the fix for a real defect ──
 *
 * An earlier revision of this gate ran the pass-rate half only when a `GoldenExecutor` was
 * INJECTED, and the CI script tried to load one from a module that did not exist. The
 * result behaved exactly like a gate and enforced only half of what it claimed: the
 * pass-rate branch was reachable from unit tests and from nothing else. So the default is
 * now the REAL executor, built here from `projectRoot`; {@link GoldenGateOptions.execute}
 * overrides it for a test that wants a deterministic fake, and there is no spelling of
 * these options that runs the dataset half alone. A caller that genuinely wants validation
 * without execution calls {@link validateGoldenDataset} and says so in its own name.
 *
 * The one alternative worth naming, because it is tempting: an executor that echoes each
 * case's own expectation back would make every case pass for ever — a gate that cannot
 * fail, which is worse than no gate because it reads as coverage.
 *
 * ── FAILS CLOSED ──
 *
 * An unreadable topology artifact, an unreadable dataset directory, a malformed case, an
 * unusable threshold, a dataset with too few executable cases: every one of them exits
 * non-zero. There is no path on which this function returns {@link GOLDEN_EXIT.pass}
 * without having read and checked the dataset AND run every case that claims a runtime.
 */

/** Where the committed dataset lives, relative to the project root. */
export const GOLDEN_DIR = join(".bober", "golden");

// ── The facts a case is checked against ─────────────────────────────

export type GoldenFactsRead =
  | { readonly ok: true; readonly facts: GoldenGraphFacts }
  | { readonly ok: false; readonly problem: string };

/**
 * Read the committed topology artifact and the effect catalog into {@link GoldenGraphFacts}.
 *
 * The artifact is parsed through `TopologySpecSchema` rather than trusted as JSON: a
 * truncated or hand-edited artifact must be a gate failure, not a set of node ids that
 * happens to be short. `pge validate` is the verb that reports WHY it is wrong; this only
 * needs to refuse to proceed.
 */
export async function readGoldenGraphFacts(
  projectRoot: string,
  graphId: string = CODING_GRAPH_ID,
): Promise<GoldenFactsRead> {
  const path = topologyArtifactPath(projectRoot, graphId);

  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch (error) {
    return {
      ok: false,
      problem: `${path}: cannot read the committed topology artifact (${error instanceof Error ? error.message : String(error)}); the dataset cannot be checked against a graph that is not there`,
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      problem: `${path}: not JSON (${error instanceof Error ? error.message : String(error)})`,
    };
  }

  const parsed = TopologySpecSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      problem: `${path}: not a topology artifact (${parsed.error.issues.length} schema issue(s)); run \`bober pge validate\` for the diagnostics`,
    };
  }

  return {
    ok: true,
    facts: {
      graphId: parsed.data.graphId,
      graphVersion: parsed.data.graphVersion,
      nodeIds: new Set(parsed.data.nodes.map((node) => node.id)),
      effectNames: new Set(Object.values(EFFECTS)),
    },
  };
}

// ── The gate ────────────────────────────────────────────────────────

export interface GoldenGateOptions {
  readonly projectRoot: string;
  /** Defaults to `<projectRoot>/.bober/golden`. */
  readonly dir?: string;
  /** Exclusive lower bound in percent, over the cases that were executed. */
  readonly minPassRatePercent?: number;
  /**
   * The engine driver. Defaults to the REAL one — {@link createGoldenExecutor} over
   * `projectRoot`. Supplied only by a test that wants a deterministic fake; see the module
   * note on why omitting it must not turn the runtime half off.
   */
  readonly execute?: GoldenExecutor;
  readonly bounds?: GoldenDatasetBounds;
  /** Overrides the committed artifact. For tests; CI always reads the real one. */
  readonly facts?: GoldenGraphFacts;
}

export interface GoldenGateResult {
  readonly exitCode: GoldenExitCode;
  /** Everything to print, in order. The caller chooses the stream. */
  readonly lines: readonly string[];
  /** Whether any case was actually executed. False only when the dataset never ran. */
  readonly runtimeEnforced: boolean;
}

export async function runGoldenGate(options: GoldenGateOptions): Promise<GoldenGateResult> {
  const dir = options.dir ?? join(options.projectRoot, GOLDEN_DIR);

  let facts = options.facts;
  if (facts === undefined) {
    const read = await readGoldenGraphFacts(options.projectRoot);
    if (!read.ok) {
      return {
        exitCode: GOLDEN_EXIT.usage,
        lines: [`golden: ${read.problem}`],
        runtimeEnforced: false,
      };
    }
    facts = read.facts;
  }

  // The real engine unless a test said otherwise. Building it can fail — an artifact that
  // does not validate — and that failure is the gate's failure, not an excuse to fall back
  // to the dataset half.
  let execute: GoldenExecutor;
  if (options.execute === undefined) {
    try {
      execute = await createGoldenExecutor({ projectRoot: options.projectRoot });
    } catch (error) {
      return {
        exitCode: GOLDEN_EXIT.usage,
        lines: [
          `golden: cannot build the golden executor from ${options.projectRoot}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        ],
        runtimeEnforced: false,
      };
    }
  } else {
    execute = options.execute;
  }

  const report = await runGoldenRegressionFromDir({
    dir,
    execute,
    minPassRatePercent: options.minPassRatePercent ?? DEFAULT_MIN_PASS_RATE_PERCENT,
    bounds: options.bounds,
    facts,
  });

  return {
    exitCode: report.exitCode,
    lines: [formatGoldenRegressionReport(report)],
    runtimeEnforced: report.total > 0,
  };
}
