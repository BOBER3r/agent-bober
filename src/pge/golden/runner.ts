// ── The golden regression runner ────────────────────────────────────

import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

import { canonical } from "../../orchestrator/workflow/conformance.js";
import { CONFORMANCE_FIELDS } from "../../orchestrator/workflow/types.js";
import type { ConformanceField } from "../../orchestrator/workflow/types.js";
import {
  GOLDEN_CASE_FILE_EXTENSION,
  GOLDEN_DATASET_MAX_CASES,
  GOLDEN_DATASET_MIN_CASES,
  GOLDEN_MIN_REPLAY_CASES,
  checkCaseAgainstGraph,
  isReplayCase,
  parseGoldenCase,
} from "./case-schema.js";
import type { GoldenCase, GoldenGraphFacts } from "./case-schema.js";

/**
 * Runs the committed golden dataset and reports an EXIT CODE against a minimum pass rate.
 *
 * ── WHAT A GREEN RUN IS EVIDENCE OF, AND WHAT IT IS NOT ──
 *
 * The RUNTIME and the ARTIFACT SHAPE, and nothing else. Every outward call a case makes is
 * answered from that case's pinned provider responses, so a green run proves that the
 * interpreter, the gates, the loop bounds, the reducers and the `.bober/` writers still
 * turn the SAME provider answers into the SAME artifacts. It proves NOTHING about whether
 * those answers were any good: model output quality is not observable here, and a case that
 * "passes" while pinning a terrible plan is working exactly as designed.
 *
 * A permanently-green golden dataset is therefore NOT evidence of generation quality, and
 * anyone citing it as such — in a review, in a README, in a release note — is citing it for
 * something it cannot say. Measuring generation quality needs human judgement against a
 * benchmark, which is explicitly out of scope for this dataset.
 *
 * ── WHICH CASES ARE EXECUTED, AND WHERE THEIR EXPECTATIONS CAME FROM ──
 *
 * Not all of them, and each case says which in its own file — see `GOLDEN_ENFORCEMENTS`.
 *
 * A `replay` case is CAPTURED: `capture.ts` records a real `PgeEngine` run's every outward
 * call, replays it, and writes the replay's own artifacts back as the expectation. Those
 * cases are executed by {@link runGoldenRegressionFromDir} against the real engine and a
 * divergence fails the blocking CI job. A `integrity` case is HAND-AUTHORED prose plus a
 * partial pin set — a curated description of behaviour the dataset means to pin — and is
 * checked for schema validity and against the committed graph only. Replaying one would
 * throw `MissingRecordingError` at the first call its author did not think to write down,
 * which would say nothing whatsoever about the runtime.
 *
 * Two failure modes were deliberately refused when this split was drawn. An executor that
 * ECHOED each case's own expectation back would make every case pass forever; and running
 * the hand-authored cases against a real engine would make the job permanently red, and a
 * permanently-red required job is waived within a week, taking the enforced half with it.
 * `GOLDEN_MIN_REPLAY_CASES` is the floor that stops the split from eroding into the first
 * of those by relabelling.
 *
 * {@link validateGoldenDataset} enforces the rest for EVERY case: the dataset loads, is
 * sized, is internally consistent, holds its floor of replay cases, and every node id and
 * effect name it pins still exists in the committed topology artifact. That last check
 * fails the moment the graph is renamed underneath the dataset.
 *
 * ── THE THRESHOLD IS AN EXCLUSIVE LOWER BOUND ──
 *
 * A run passes when the pass rate is STRICTLY GREATER than the threshold. 80 percent against
 * a threshold of 80 FAILS. That is deliberate and pinned by unit tests: "minimum 80" read as
 * `>=` lets a suite sit exactly on its floor forever, which is the state a floor exists to
 * push off. The consequence is that a threshold of 100 can never be satisfied, so it is
 * rejected as a usage error rather than silently installed as a gate that always fails.
 *
 * The comparison is integer arithmetic — `passed * 100 > threshold * total` — so the
 * boundary is decided exactly and not by a float division that lands on 79.99999999999999.
 *
 * ── THE RUNNER NEVER BUILDS AN ENGINE ──
 *
 * The caller injects {@link GoldenExecutor}, exactly as `EngineConformanceHarness` takes its
 * runners and `replayRecordedRun` takes its `rerun`. A runner that constructed its own engine
 * would decide which engine it is possible to regression-test, and the point of the seam is
 * that both engines can be driven through the same dataset.
 */

// ── Exit codes ──────────────────────────────────────────────────────

/**
 * What the process exits with. A gate the CI job can branch on without parsing prose.
 *
 * `usage` is separate from `belowThreshold` on purpose: "the dataset is malformed" and "the
 * dataset ran and did not clear the bar" are different failures, and collapsing them would
 * let a dataset that never ran read as a dataset that ran badly. Both are non-zero, so
 * neither can merge.
 */
export const GOLDEN_EXIT = {
  pass: 0,
  belowThreshold: 1,
  usage: 2,
} as const;

export type GoldenExitCode = (typeof GOLDEN_EXIT)[keyof typeof GOLDEN_EXIT];

/** The threshold the blocking CI job uses when it is not told otherwise. */
export const DEFAULT_MIN_PASS_RATE_PERCENT = 80;

// ── Artifacts and comparison ────────────────────────────────────────

/**
 * What one case execution produced, keyed by conformance field.
 *
 * `readonly unknown[]` rather than the parsed `GoldenArtifacts`, because an EXECUTOR hands
 * back what a run actually wrote — timestamps, run ids and all — and normalising it is this
 * module's job, not the executor's.
 */
export type GoldenRunArtifacts = Partial<Record<ConformanceField, readonly unknown[]>>;

/** Runs one case and returns the artifacts it produced. Injected; see the module note. */
export type GoldenExecutor = (
  goldenCase: GoldenCase,
) => Promise<GoldenRunArtifacts> | GoldenRunArtifacts;

/** The multiset of canonical bytes for one field, sorted so element order is tolerated. */
function canonicalMultiset(values: readonly unknown[] | undefined): string[] {
  return (values ?? []).map((value) => canonical(value)).sort();
}

/** Trimmed for a failure message; a whole artifact in a diff line is unreadable. */
function excerpt(bytes: string): string {
  return bytes.length <= 160 ? bytes : `${bytes.slice(0, 157)}...`;
}

/**
 * Every way `actual` differs from `expected`. Empty means the case passed.
 *
 * Compared over the UNION of fields, so an engine that produced an artifact the case does
 * not pin is a failure too. The alternative — comparing only the pinned fields — would let
 * a run write anything it liked anywhere the case happened not to look, which is precisely
 * the regression a golden dataset exists to catch.
 *
 * Order within a field is tolerated (the multiset is sorted) and volatile keys are stripped
 * by {@link canonical}, so two runs that wrote the same three contracts in a different order
 * at different times are equal — the same two tolerances `EngineConformanceHarness` applies,
 * because they come from the same normaliser.
 */
export function compareGoldenArtifacts(
  expected: GoldenRunArtifacts,
  actual: GoldenRunArtifacts,
): string[] {
  const failures: string[] = [];

  for (const field of CONFORMANCE_FIELDS) {
    const expectedBytes = canonicalMultiset(expected[field]);
    const actualBytes = canonicalMultiset(actual[field]);

    if (expectedBytes.length !== actualBytes.length) {
      failures.push(
        `${field}: expected ${String(expectedBytes.length)} element(s), run produced ${String(actualBytes.length)}`,
      );
      continue;
    }

    for (let index = 0; index < expectedBytes.length; index += 1) {
      const want = expectedBytes[index];
      const got = actualBytes[index];
      if (want !== got) {
        failures.push(`${field}[${String(index)}]: expected ${excerpt(want)}, got ${excerpt(got)}`);
      }
    }
  }

  return failures;
}

// ── Report ──────────────────────────────────────────────────────────

export interface GoldenCaseResult {
  readonly caseId: string;
  readonly passed: boolean;
  /** Why it failed. Empty when it passed. */
  readonly failures: readonly string[];
}

export interface GoldenRegressionReport {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  /** For display only — the pass/fail decision is made in integer arithmetic. */
  readonly passRatePercent: number;
  readonly thresholdPercent: number;
  readonly exitCode: GoldenExitCode;
  readonly results: readonly GoldenCaseResult[];
  /** Dataset-level problems: a malformed file, a bad threshold, a case off the graph. */
  readonly errors: readonly string[];
  /**
   * The split the directory held, when the report came from one.
   *
   * Carried so the CI log states how many cases were EXECUTED out of how many exist — a
   * pass rate over the replay half printed without that denominator would read as a pass
   * rate over the whole dataset.
   */
  readonly dataset?: GoldenDatasetSplit;
}

/** How many cases the directory held, and how they are enforced. */
export interface GoldenDatasetSplit {
  readonly total: number;
  readonly replay: number;
  readonly integrity: number;
}

/** Human-readable summary for the CI log. Never used to decide anything. */
export function formatGoldenRegressionReport(report: GoldenRegressionReport): string {
  const lines: string[] = [];
  lines.push(
    `golden: ${String(report.passed)}/${String(report.total)} passed ` +
      `(${report.passRatePercent.toFixed(2)}%, threshold >${String(report.thresholdPercent)}%) ` +
      `exit=${String(report.exitCode)}`,
  );
  if (report.dataset !== undefined) {
    lines.push(
      `  ${String(report.dataset.replay)} of ${String(report.dataset.total)} committed case(s) are ` +
        `enforcement="replay" and were EXECUTED against the engine; ` +
        `${String(report.dataset.integrity)} are enforcement="integrity" and were checked for ` +
        `dataset integrity only — they make no runtime claim.`,
    );
  }
  for (const error of report.errors) lines.push(`  ! ${error}`);
  for (const result of report.results) {
    if (result.passed) continue;
    lines.push(`  FAIL ${result.caseId}`);
    for (const failure of result.failures) lines.push(`       ${failure}`);
  }
  return lines.join("\n");
}

// ── Threshold ───────────────────────────────────────────────────────

/** Why a threshold is unusable, or null when it is fine. */
export function thresholdProblem(threshold: number): string | null {
  if (!Number.isFinite(threshold)) return `threshold ${String(threshold)} is not a finite number`;
  if (threshold < 0) return `threshold ${String(threshold)} is negative`;
  if (threshold >= 100) {
    return `threshold ${String(threshold)} can never be satisfied: the comparison is strictly greater than, so 100 percent passing does not clear a threshold of 100`;
  }
  return null;
}

function usageReport(threshold: number, errors: readonly string[]): GoldenRegressionReport {
  return {
    total: 0,
    passed: 0,
    failed: 0,
    passRatePercent: 0,
    thresholdPercent: threshold,
    exitCode: GOLDEN_EXIT.usage,
    results: [],
    errors,
  };
}

// ── Running ─────────────────────────────────────────────────────────

export interface GoldenRegressionInput {
  readonly cases: readonly GoldenCase[];
  readonly execute: GoldenExecutor;
  /** Exclusive lower bound in percent. Defaults to {@link DEFAULT_MIN_PASS_RATE_PERCENT}. */
  readonly minPassRatePercent?: number;
  /** Carried into the report, e.g. dataset-shape problems found before running. */
  readonly errors?: readonly string[];
}

/**
 * Execute every case and decide the exit code.
 *
 * An executor that THROWS fails its case and the run continues: one case that blew up must
 * not hide the verdict of the other twenty-five, and a thrown error is a failure of the
 * runtime under test, which is exactly what the dataset is here to detect.
 *
 * An EMPTY dataset exits non-zero. A pass rate over no cases is a comparison of nothing with
 * nothing, and returning success for it would turn a deleted dataset into a green gate.
 */
export async function runGoldenRegression(
  input: GoldenRegressionInput,
): Promise<GoldenRegressionReport> {
  const threshold = input.minPassRatePercent ?? DEFAULT_MIN_PASS_RATE_PERCENT;
  const carried = input.errors ?? [];

  const problem = thresholdProblem(threshold);
  if (problem !== null) return usageReport(threshold, [...carried, problem]);

  const results: GoldenCaseResult[] = [];
  for (const goldenCase of input.cases) {
    try {
      const produced = await input.execute(goldenCase);
      const failures = compareGoldenArtifacts(goldenCase.expected.artifacts, produced);
      results.push({ caseId: goldenCase.caseId, passed: failures.length === 0, failures });
    } catch (error) {
      results.push({
        caseId: goldenCase.caseId,
        passed: false,
        failures: [`executor threw: ${error instanceof Error ? error.message : String(error)}`],
      });
    }
  }

  const total = results.length;
  const passed = results.filter((result) => result.passed).length;
  const errors = [...carried];

  if (total === 0) {
    errors.push(
      "the golden dataset is empty; a pass rate over zero cases proves nothing and cannot pass",
    );
  }

  // Integer arithmetic, and STRICTLY greater — see the module note on the boundary.
  const clears = total > 0 && passed * 100 > threshold * total;

  return {
    total,
    passed,
    failed: total - passed,
    passRatePercent: total === 0 ? 0 : (passed * 100) / total,
    thresholdPercent: threshold,
    exitCode: errorExit(errors, clears),
    results,
    errors,
  };
}

/** A dataset problem is a usage failure; a cleared-bar-with-no-problems run passes. */
function errorExit(errors: readonly string[], clears: boolean): GoldenExitCode {
  if (errors.length > 0) return GOLDEN_EXIT.usage;
  return clears ? GOLDEN_EXIT.pass : GOLDEN_EXIT.belowThreshold;
}

// ── Loading the committed dataset ───────────────────────────────────

export interface GoldenDataset {
  readonly dir: string;
  /** Every entry `readdir` returned, in sorted order. Not filtered — see `datasetShapeProblems`. */
  readonly files: readonly string[];
  readonly cases: readonly GoldenCase[];
  /** Unreadable, unparseable or schema-violating files. */
  readonly errors: readonly string[];
}

/**
 * Read every file under `dir` as a golden case.
 *
 * `readdir` rather than a manifest, deliberately: a hardcoded list of cases is a list that
 * drifts from the directory, and the first thing it hides is a case that was deleted.
 */
export async function loadGoldenDataset(dir: string): Promise<GoldenDataset> {
  let entries: string[];
  try {
    entries = (await readdir(dir)).sort();
  } catch (error) {
    return {
      dir,
      files: [],
      cases: [],
      errors: [
        `${dir}: cannot read the golden dataset directory (${error instanceof Error ? error.message : String(error)})`,
      ],
    };
  }

  const cases: GoldenCase[] = [];
  const errors: string[] = [];

  for (const entry of entries) {
    if (!entry.endsWith(GOLDEN_CASE_FILE_EXTENSION)) continue;
    const path = join(dir, entry);

    let text: string;
    try {
      text = await readFile(path, "utf-8");
    } catch (error) {
      errors.push(`${entry}: unreadable (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      errors.push(`${entry}: not JSON (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }

    const result = parseGoldenCase(parsed, entry);
    if (!result.ok) {
      errors.push(...result.errors);
      continue;
    }

    const expectedName = `${result.goldenCase.caseId}${GOLDEN_CASE_FILE_EXTENSION}`;
    if (basename(entry) !== expectedName) {
      errors.push(
        `${entry}: caseId is "${result.goldenCase.caseId}", so the file must be named ${expectedName} — a case whose id and filename disagree cannot be found from a failure message`,
      );
      continue;
    }

    cases.push(result.goldenCase);
  }

  return { dir, files: entries, cases, errors };
}

export interface GoldenDatasetBounds {
  readonly min: number;
  readonly max: number;
  /** The floor on `replay`-enforced cases. See {@link GOLDEN_MIN_REPLAY_CASES}. */
  readonly minReplay: number;
}

export const DEFAULT_DATASET_BOUNDS: GoldenDatasetBounds = {
  min: GOLDEN_DATASET_MIN_CASES,
  max: GOLDEN_DATASET_MAX_CASES,
  minReplay: GOLDEN_MIN_REPLAY_CASES,
};

/**
 * Everything wrong with the dataset as a WHOLE. Empty is good.
 *
 * The count is taken from what `readdir` returned, not from the cases that happened to
 * parse: a directory of fifty files of which thirty are broken is not a dataset of twenty.
 * Stray non-case files are rejected for the same reason — a `README.md` in here makes the
 * file count and the case count disagree, and then neither number means anything.
 */
export function datasetShapeProblems(
  dataset: GoldenDataset,
  bounds: GoldenDatasetBounds = DEFAULT_DATASET_BOUNDS,
): string[] {
  const problems: string[] = [];

  const strays = dataset.files.filter((file) => !file.endsWith(GOLDEN_CASE_FILE_EXTENSION));
  for (const stray of strays) {
    problems.push(
      `${dataset.dir}: "${stray}" is not a golden case; every file in this directory is one case, so the file count and the case count are the same number`,
    );
  }

  const count = dataset.files.length;
  if (count < bounds.min || count > bounds.max) {
    problems.push(
      `${dataset.dir}: holds ${String(count)} file(s); the dataset must hold between ${String(bounds.min)} and ${String(bounds.max)}`,
    );
  }

  const seen = new Set<string>();
  for (const goldenCase of dataset.cases) {
    if (seen.has(goldenCase.caseId)) {
      problems.push(`${dataset.dir}: duplicate caseId "${goldenCase.caseId}"`);
    }
    seen.add(goldenCase.caseId);
  }

  // The floor on the EXECUTED half. Checked here rather than in the runner so it bites on
  // the no-executor path too: a dataset whose replay cases were deleted or relabelled is
  // malformed whether or not anyone is in a position to run it.
  const replayed = dataset.cases.filter(isReplayCase).length;
  if (replayed < bounds.minReplay) {
    problems.push(
      `${dataset.dir}: holds ${String(replayed)} case(s) with enforcement "replay"; at least ${String(bounds.minReplay)} are required, because a case that is not executed makes no claim about the runtime and a dataset of nothing but those is a gate that cannot fail`,
    );
  }

  return problems;
}

// ── One entry point for the CI job ──────────────────────────────────

export interface GoldenDatasetValidation {
  readonly exitCode: GoldenExitCode;
  readonly caseCount: number;
  readonly problems: readonly string[];
}

/**
 * Validate the dataset WITHOUT running it. What CI can enforce with no engine wired.
 *
 * Be precise about what this proves and what it does not. It proves the dataset is
 * loadable, sized, internally consistent and — when `facts` is supplied — that every node
 * id and effect name it pins still exists in the committed topology artifact. That last
 * check is the one with teeth over time: renaming a node or dropping an effect makes this
 * fail until the affected cases are re-pinned, which is precisely the drift a committed
 * dataset is supposed to catch.
 *
 * It proves NOTHING about the runtime, because nothing ran. The pass-rate gate needs a
 * {@link GoldenExecutor} that drives a real engine over each case's pinned responses, and
 * the caller supplies it — see {@link runGoldenRegressionFromDir}.
 */
export async function validateGoldenDataset(options: {
  readonly dir: string;
  readonly bounds?: GoldenDatasetBounds;
  readonly facts?: GoldenGraphFacts;
}): Promise<GoldenDatasetValidation> {
  const dataset = await loadGoldenDataset(options.dir);
  const problems = [...dataset.errors, ...datasetShapeProblems(dataset, options.bounds)];

  if (options.facts !== undefined) {
    for (const goldenCase of dataset.cases) {
      problems.push(...checkCaseAgainstGraph(goldenCase, options.facts));
    }
  }

  return {
    exitCode: problems.length > 0 ? GOLDEN_EXIT.usage : GOLDEN_EXIT.pass,
    caseCount: dataset.cases.length,
    problems,
  };
}

export interface GoldenRegressionRunOptions {
  readonly dir: string;
  readonly execute: GoldenExecutor;
  readonly minPassRatePercent?: number;
  readonly bounds?: GoldenDatasetBounds;
  /**
   * The committed graph, when the caller has read it.
   *
   * Optional because reading the topology artifact is the caller's business; supplied, every
   * case is checked against it, and a case naming a node or effect the graph does not have is
   * a dataset error rather than a silently-passing case.
   */
  readonly facts?: GoldenGraphFacts;
}

/**
 * Load, validate and run the dataset at `dir`. The single call a CI script needs.
 *
 * Any dataset-level problem exits `usage` WITHOUT running, because a run over a dataset that
 * failed its own validation would report a pass rate for a thing whose contents are unknown.
 */
export async function runGoldenRegressionFromDir(
  options: GoldenRegressionRunOptions,
): Promise<GoldenRegressionReport> {
  const dataset = await loadGoldenDataset(options.dir);
  const problems = [...dataset.errors, ...datasetShapeProblems(dataset, options.bounds)];

  if (options.facts !== undefined) {
    for (const goldenCase of dataset.cases) {
      problems.push(...checkCaseAgainstGraph(goldenCase, options.facts));
    }
  }

  const threshold = options.minPassRatePercent ?? DEFAULT_MIN_PASS_RATE_PERCENT;

  // Only the EXECUTED half is run. `datasetShapeProblems` has already refused a dataset
  // whose replay set fell below its floor, so an empty `replay` list here cannot be
  // reached with `problems` empty — the emptiness check in `runGoldenRegression` is the
  // second line of that same defence rather than the first.
  const replay = dataset.cases.filter(isReplayCase);
  const split: GoldenDatasetSplit = {
    total: dataset.cases.length,
    replay: replay.length,
    integrity: dataset.cases.length - replay.length,
  };

  if (problems.length > 0) return { ...usageReport(threshold, problems), dataset: split };

  const report = await runGoldenRegression({
    cases: replay,
    execute: options.execute,
    minPassRatePercent: options.minPassRatePercent,
  });
  return { ...report, dataset: split };
}
