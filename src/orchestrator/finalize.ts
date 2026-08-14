// ── finalize.ts ──────────────────────────────────────────────────────
//
// THE SINGLE OWNER OF A RUN'S TERMINAL SIDE-EFFECT SET.
//
// Extracted verbatim from the block that used to live inline at the tail of
// runTsPipeline (pipeline.ts). Every engine — TsPipelineEngine today, the
// RunResultFlusher's workflow path, and any future engine — MUST end a run by
// calling finalizePipelineRun, because two consumers wait on exactly this set:
//
//   1. src/chat/completion-tailer.ts scans .bober/history.jsonl for a line whose
//      `event` equals PIPELINE_COMPLETE_EVENT, then resolves the runId from a
//      .bober/runs/<runId><COMPLETION_MARKER_SUFFIX> marker (the history line
//      itself carries no runId). ChatSession.handleTurn() polls it every turn.
//   2. Anything reading .bober/runs/<runId>.completed.json directly.
//
// A malformed emission does not throw — it silently strands a run as "never
// completed" for those consumers. Hence: one owner, exported constants on both
// sides of the seam (producer AND consumer import the same identifier), and a
// write ORDER that finalize.test.ts pins.
//
// ORDER IS LOAD-BEARING: completion marker → history event → end-of-pipeline
// checkpoint → return. The marker is the DATA and the history line is the
// TRIGGER, so the data must be durable before the trigger becomes visible.
//
// The pre-extraction code emitted the history line FIRST, which was racy: the
// tailer polls from a different process (run-spawner spawns `bober run` as a
// child), it consumes the terminal line unconditionally — advancing its
// persisted byte cursor and recording a synthetic dedupe key — and it only
// then looks for the marker. A poll landing between the two writes therefore
// resolved `runId: undefined` and no later poll could ever recover it, so
// ChatSession's `if (c.runId)` guard skipped cleanupTerminalRun forever. Only
// the marker moved earlier; the history line still precedes the checkpoint
// exactly as before, and the artifact SET and its bytes are unchanged.

import { writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { BoberConfig } from "../config/schema.js";
import type { PlanSpec } from "../contracts/spec.js";
import type { SprintContract } from "../contracts/sprint-contract.js";
import { appendHistory } from "../state/index.js";
import { getCheckpointMechanismFor, resolveCheckpointMechanismName } from "./checkpoints/index.js";
import { runWithAudit, type MechanismName } from "./checkpoints/audit.js";
import { logger } from "../utils/logger.js";
import type { PipelineResult } from "./pipeline.js";

// ── Wire constants (imported by producer AND consumer) ───────────────

/**
 * The `event` value of the terminal history line.
 *
 * src/chat/completion-tailer.ts compares `entry.event` against this same
 * constant. Neither a type error nor any test outside that module would catch a
 * divergence between a literal here and a literal there — which is exactly why
 * this is a shared constant rather than two string literals.
 */
export const PIPELINE_COMPLETE_EVENT = "pipeline-complete" as const;

/**
 * Filename suffix of the per-run completion marker under `.bober/runs/`.
 * The full name is `<runId>${COMPLETION_MARKER_SUFFIX}`.
 */
export const COMPLETION_MARKER_SUFFIX = ".completed.json" as const;

/** Directory holding run markers. */
export function runsDir(projectRoot: string): string {
  return join(projectRoot, ".bober", "runs");
}

/** Absolute path of a run's completion marker. */
export function completionMarkerPath(
  projectRoot: string,
  runId: string,
): string {
  return join(runsDir(projectRoot), `${runId}${COMPLETION_MARKER_SUFFIX}`);
}

// ── Verdict ──────────────────────────────────────────────────────────

/** Coarse run outcome. `success` is the boolean projection of `"success"`. */
export type RunVerdict = "success" | "partial" | "failed";

/**
 * The FROZEN success formula, lifted unchanged from the pre-extraction block:
 *   `failedSprints.length === 0 && completedSprints.length > 0`
 *
 * Both engines derive it from the same function so they cannot disagree.
 */
export function deriveRunSuccess(
  completedCount: number,
  failedCount: number,
): boolean {
  return failedCount === 0 && completedCount > 0;
}

/** Three-valued projection of the same formula. */
export function deriveRunVerdict(
  completedCount: number,
  failedCount: number,
): RunVerdict {
  if (deriveRunSuccess(completedCount, failedCount)) return "success";
  if (completedCount > 0) return "partial";
  return "failed";
}

/**
 * Thrown when a caller asserts a verdict that disagrees with the derived one.
 *
 * `verdict` is an OPTIONAL cross-check, never an input the emission trusts: if
 * it were trusted, two engines could emit different `phase` values for the same
 * facts, which is precisely the divergence this module exists to prevent.
 */
export class FinalizeVerdictMismatchError extends Error {
  constructor(
    readonly runId: string,
    readonly asserted: RunVerdict,
    readonly derived: RunVerdict,
  ) {
    super(
      `finalizePipelineRun(${runId}): caller asserted verdict '${asserted}' but the run facts derive '${derived}'`,
    );
    this.name = "FinalizeVerdictMismatchError";
  }
}

// ── Completion marker ────────────────────────────────────────────────

/**
 * Write `.bober/runs/<runId>.completed.json` atomically (temp file + rename),
 * creating parent directories as needed.
 *
 * Moved here from checkpoints/feedback-router.ts so the marker has exactly one
 * writer. `writeAbortMarker` (`.aborted.json`) stays where it was — it is a
 * different artifact with a different consumer.
 */
export async function writeCompletionMarker(
  projectRoot: string,
  runId: string,
  summary: Record<string, unknown>,
): Promise<void> {
  const dir = runsDir(projectRoot);
  await mkdir(dir, { recursive: true });
  const markerPath = completionMarkerPath(projectRoot, runId);
  const payload = {
    runId,
    completedAt: new Date().toISOString(),
    ...summary,
  };
  const tmpPath = `${markerPath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(payload, null, 2) + "\n", "utf-8");
  await rename(tmpPath, markerPath);
  // The `[feedback-router]` prefix is retained VERBATIM despite the move: this
  // line is the operator-visible signal that a run finished, and changing it
  // would be an observable difference between a run started before this sprint
  // and one started after it. Renaming it is a separate, deliberate change.
  logger.info(`[feedback-router] Completion marker written to ${markerPath}`);
}

// ── finalizePipelineRun ──────────────────────────────────────────────

export interface FinalizePipelineRunArgs {
  projectRoot: string;
  /** Stable run identifier — becomes the marker filename stem. */
  runId: string;
  config: BoberConfig;
  spec: PlanSpec;
  completedSprints: SprintContract[];
  failedSprints: SprintContract[];
  /** `Date.now()` captured when the run started; `duration` is derived from it. */
  startedAtMs: number;
  /**
   * Optional assertion of the expected verdict. When supplied it is CHECKED
   * against the derived verdict and a mismatch throws
   * {@link FinalizeVerdictMismatchError}; it never overrides the derivation.
   */
  verdict?: RunVerdict;
}

/**
 * Emit a run's terminal side-effect set EXACTLY ONCE and return the
 * PipelineResult.
 *
 * Emission order (pinned by finalize.test.ts — do not reorder):
 *   1. `writeCompletionMarker` — `.bober/runs/<runId>.completed.json`. This is
 *      the only place the runId is recorded, so it MUST be on disk before the
 *      line that makes a consumer go looking for it.
 *   2. `appendHistory` — the PIPELINE_COMPLETE_EVENT line. The trigger.
 *   3. `runWithAudit` — the `end-of-pipeline` checkpoint (noop by default).
 *   4. return `{ success, spec, completedSprints, failedSprints, duration }`.
 *
 * Exactly-once is structural, not defensive: this function performs each write
 * once per call, and each engine path calls it once per run. There is no
 * "already emitted" short-circuit on purpose — one would convert a duplicate
 * runId into a *silently missing* completion, which is strictly worse for the
 * tailer than a duplicate line it already dedupes by runId.
 *
 * Filesystem errors propagate: a run that could not record its own completion
 * must not report success.
 */
export async function finalizePipelineRun(
  args: FinalizePipelineRunArgs,
): Promise<PipelineResult> {
  const {
    projectRoot,
    runId,
    config,
    spec,
    completedSprints,
    failedSprints,
    startedAtMs,
  } = args;

  const derived = deriveRunVerdict(completedSprints.length, failedSprints.length);
  if (args.verdict !== undefined && args.verdict !== derived) {
    throw new FinalizeVerdictMismatchError(runId, args.verdict, derived);
  }

  // Resolved through the SAME override-aware expression `interrupt.ts`'s controller uses
  // for this checkpoint (`resolveCheckpointMechanismName(checkpointId, ctx.config)`, at
  // both its hitl-branch and its gated-effect-branch call sites) — not the bare
  // `config.pipeline?.checkpointMechanism` this used to read.
  //
  // That bare read ignored `checkpointOverrides` (tier 2 of `resolveCheckpointMechanismName`,
  // `registry.ts:76-77`) while `getCheckpointMechanismFor` two lines below always honoured
  // it, so the two could name DIFFERENT mechanisms for the identical `end-of-pipeline`
  // call: `checkpointMechanism: "disk"` with `checkpointOverrides: { "end-of-pipeline":
  // "noop" }` (a combination `schema.ts` accepts) resolved the ACTUAL request through
  // `noop` — auto-approved, nobody asked — while this label still read `"disk"`, and
  // `runWithAudit` resolves `approverId` from exactly this label (`audit.ts`'s
  // `resolveApproverId`): `"disk"` shells out to `git config user.name`. The audit record
  // would then credit a named human with an approval autopilot rubber-stamped. Both engines
  // still audit under the same mechanism name for the same config — that guarantee is
  // unchanged — it is now the name the request was actually resolved under.
  const mechanism: MechanismName = resolveCheckpointMechanismName(
    "end-of-pipeline",
    config,
  ) as MechanismName;

  logger.phase("Pipeline Complete");

  const duration = Date.now() - startedAtMs;
  const success = deriveRunSuccess(completedSprints.length, failedSprints.length);

  // The marker carries the runId; the history line does not. Write it FIRST so
  // a tailer woken by the line always finds it — see the ORDER note in the
  // module header and the interleaving test in finalize.test.ts.
  await writeCompletionMarker(projectRoot, runId, {
    success,
    completedSprints: completedSprints.length,
    failedSprints: failedSprints.length,
    duration,
  });

  await appendHistory(projectRoot, {
    timestamp: new Date().toISOString(),
    event: PIPELINE_COMPLETE_EVENT,
    phase: success ? "complete" : "failed",
    details: {
      completed: completedSprints.length,
      failed: failedSprints.length,
      durationMs: duration,
    },
  });

  await runWithAudit({
    projectRoot,
    runId,
    checkpointId: "end-of-pipeline",
    mechanism,
    iteration: 1,
    fn: () =>
      getCheckpointMechanismFor("end-of-pipeline", config, "noop").request(
        "end-of-pipeline",
        { success, completedSprints, failedSprints, duration, spec },
      ),
  });

  return {
    success,
    spec,
    completedSprints,
    failedSprints,
    duration,
  };
}
