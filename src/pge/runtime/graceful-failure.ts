import { join } from "node:path";

import { z } from "zod";

import { synthesize } from "../../orchestrator/workflow/synthesizer.js";
import { canonicalJson } from "../registry/reducers.js";
import { BranchStatusSchema } from "../state/overall.js";
import type { BranchState, BranchStatus } from "../state/overall.js";
import { assertSafePathSegment, atomicWriteFile, readIfPresent } from "./scratch.js";

/**
 * What a partially failed run RECORDS: the failure artifact, and the qualified per-branch
 * synthesis that goes with it.
 *
 * ── Why this is a module and not part of the interpreter ──
 *
 * `interpreter.ts` states, in its own header, that it writes no files: every artifact
 * write goes through the commit boundary and its only filesystem contact is the trace. The
 * graceful-failure terminal is a NODE in the topology (`graceful_failure`, declared with
 * `effects: ["fs-write"]` in both the shipped `coding` graph and the golden fixture), so
 * the write belongs to that node's body. This module is what the body calls. It holds no
 * clock, no run state and no reference to the interpreter, so it is exercisable on its own
 * and cannot become a second place where run control flow lives.
 *
 * ── Why the bytes are canonical ──
 *
 * `.bober/failures/` sits INSIDE the byte-comparison surface: `readArtifactTree` walks all
 * of `.bober/` and excludes only `.bober/traces/`. An artifact with unsorted branches or
 * key order that depended on insertion would make any determinism comparison of a failing
 * run flake. So the branch list is sorted by branch key, the bytes come from
 * {@link canonicalJson}, and `createdAt` is supplied by the CALLER from
 * `NodeContext.clock` — there is no `new Date()` in this file, because the commit
 * boundary is the only place a real clock is read.
 */

// ── Failure artifact ────────────────────────────────────────────────

export const FAILURE_ARTIFACT_FORMAT_VERSION = 1;

/**
 * One branch that could not be completed.
 *
 * Carries `branchKey`, `contractId`, `attempts` and `errorClass` — the four facts the
 * synthesis stage needs in order to NAME a failed branch without reading the trace file.
 */
export const BranchFailureSchema = z.object({
  branchKey: z.string().min(1),
  contractId: z.string().min(1).optional(),
  nodeId: z.string().min(1),
  attempts: z.number().int().min(1),
  errorClass: z.string().min(1),
  message: z.string(),
});
export type BranchFailure = z.infer<typeof BranchFailureSchema>;

export const FailureArtifactSchema = z.object({
  formatVersion: z.literal(FAILURE_ARTIFACT_FORMAT_VERSION),
  runId: z.string().min(1),
  /** Why the terminal was reached: an interpreter error class, never free prose. */
  reason: z.string().min(1),
  /** The superstep the terminal executed at. */
  supersteps: z.number().int().min(0),
  createdAt: z.string().min(1),
  branches: z.array(BranchFailureSchema),
});
export type FailureArtifact = z.infer<typeof FailureArtifactSchema>;

/** `<projectRoot>/.bober/failures`. */
export function failuresRoot(projectRoot: string): string {
  return join(projectRoot, ".bober", "failures");
}

/**
 * `<projectRoot>/.bober/failures/<runId>.json`.
 *
 * `runId` reaches this module from a run manager, so it is validated as a single path
 * segment here rather than trusted — the same guard `checkpointDir` applies for the same
 * reason.
 */
export function failureArtifactPath(projectRoot: string, runId: string): string {
  assertSafePathSegment("runId", runId);
  return join(failuresRoot(projectRoot), `${runId}.json`);
}

/** The artifact with its branch list sorted and every field validated. */
export function canonicaliseFailureArtifact(artifact: FailureArtifact): FailureArtifact {
  const parsed = FailureArtifactSchema.parse(artifact);
  return {
    ...parsed,
    branches: [...parsed.branches].sort((a, b) =>
      a.branchKey < b.branchKey ? -1 : a.branchKey > b.branchKey ? 1 : 0,
    ),
  };
}

/**
 * Write the failure artifact, atomically, and return the path it landed at.
 *
 * Temp-file-plus-rename through the runtime's shared {@link atomicWriteFile}, so a crash
 * mid-write leaves no readable partial artifact — the same durability primitive the
 * checkpointer, the archive and the cache use.
 */
export async function writeFailureArtifact(
  projectRoot: string,
  artifact: FailureArtifact,
): Promise<string> {
  const path = failureArtifactPath(projectRoot, artifact.runId);
  await atomicWriteFile(path, `${canonicalJson(canonicaliseFailureArtifact(artifact))}\n`);
  return path;
}

/** The artifact for `runId`, or `undefined` when the run wrote none. */
export async function readFailureArtifact(
  projectRoot: string,
  runId: string,
): Promise<FailureArtifact | undefined> {
  const read = await readIfPresent(failureArtifactPath(projectRoot, runId));
  if (read.kind === "absent") return undefined;
  if (read.kind === "unreadable") {
    throw new Error(`Failure artifact for run "${runId}" is unreadable (${read.code}): ${read.message}.`);
  }
  return FailureArtifactSchema.parse(JSON.parse(read.text) as unknown);
}

// ── Qualified synthesis ─────────────────────────────────────────────

/** One branch as the synthesis stage reports it. */
export interface BranchOutcome {
  readonly branchKey: string;
  readonly status: BranchState;
  readonly attempts: number;
  readonly errorClass?: string;
}

export interface BranchSynthesis {
  /** EVERY branch key present in `branchStatus`, sorted. Never a filtered subset. */
  readonly branches: readonly BranchOutcome[];
  /** The keys whose branch did not succeed, sorted. */
  readonly failed: readonly string[];
  /** The healthiest branch by the ranking below, or `null` when there are no branches. */
  readonly winner: string | null;
  readonly ranking: ReadonlyArray<{
    approach: string;
    perLensScores: Record<string, number>;
    total: number;
  }>;
  /** Lenses whose own best branch is not the overall winner. */
  readonly dissent: readonly string[];
  /**
   * One line naming every branch and its status, with the error class appended for each
   * branch that failed. This is what a terminal commits, so "the synthesis named the
   * failed branch" is checkable against committed state rather than against a return
   * value nobody kept.
   */
  readonly summary: string;
}

/** The lens a branch is scored on when it completed without incident. */
const COMPLETION_LENS = "completion";
/** The lens a branch is scored on when it needed no second attempt. */
const FIRST_PASS_LENS = "firstPass";

function outcomeOf(branchKey: string, status: BranchStatus): BranchOutcome {
  return {
    branchKey,
    status: status.state,
    attempts: status.attempts,
    ...(status.errorClass === undefined ? {} : { errorClass: status.errorClass }),
  };
}

function describe(outcome: BranchOutcome): string {
  const attempts = `${String(outcome.attempts)} attempt${outcome.attempts === 1 ? "" : "s"}`;
  return outcome.errorClass === undefined
    ? `${outcome.branchKey}: ${outcome.status} after ${attempts}`
    : `${outcome.branchKey}: ${outcome.status} after ${attempts} (${outcome.errorClass})`;
}

/**
 * Rank and enumerate every branch of a run.
 *
 * The ranking is `synthesize` from `src/orchestrator/workflow/synthesizer.ts` — the pure,
 * deterministic reducer this repository has shipped with no callers — applied to branch
 * keys as its approaches and two lenses derived from `branchStatus`. It is used rather
 * than re-derived because ADR-8 retains that module permanently and this is the caller it
 * was retained for.
 *
 * The ENUMERATION is the part a partially failed run depends on: `branches` carries every
 * key `branchStatus` holds, in sorted order, with its own state, attempt count and error
 * class. A synthesis that reported only the winner would let a failed branch vanish from
 * the run's own account of itself, which is the failure this exists to make impossible.
 */
export function synthesizeBranchOutcomes(
  branchStatus: Readonly<Record<string, unknown>>,
): BranchSynthesis {
  const keys = Object.keys(branchStatus).sort();
  const branches = keys.map((key) => outcomeOf(key, BranchStatusSchema.parse(branchStatus[key])));
  const failed = branches.filter((b) => b.status !== "succeeded").map((b) => b.branchKey);

  if (branches.length === 0) {
    return {
      branches,
      failed,
      winner: null,
      ranking: [],
      dissent: [],
      summary: "no branches were dispatched",
    };
  }

  const completion: Record<string, number> = {};
  const firstPass: Record<string, number> = {};
  for (const branch of branches) {
    completion[branch.branchKey] = branch.status === "succeeded" ? 1 : 0;
    firstPass[branch.branchKey] =
      branch.status === "succeeded" && branch.attempts <= 1 && branch.errorClass === undefined
        ? 1
        : 0;
  }

  const ranked = synthesize(keys, [
    { lens: COMPLETION_LENS, scores: completion },
    { lens: FIRST_PASS_LENS, scores: firstPass },
  ]);

  const summary =
    failed.length === 0
      ? `all ${String(branches.length)} branches succeeded — ${branches.map(describe).join("; ")}`
      : `${String(failed.length)} of ${String(branches.length)} branches failed — ${branches
          .map(describe)
          .join("; ")}`;

  return {
    branches,
    failed,
    winner: ranked.winner,
    ranking: ranked.ranking,
    dissent: ranked.dissent,
    summary,
  };
}
