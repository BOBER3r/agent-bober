/**
 * Feedback router (Sprint 12).
 *
 * Maps a CheckpointId to the responsible agent and re-invokes that agent
 * with the prior feedback woven into its prompt. Per-agent adaptation
 * differs by agent role (s12-c6). The 'gate' checkpoints abort
 * the run on rejection — they are not iteration points.
 *
 * Abort token matching is case-SENSITIVE: `feedback.startsWith("!!abort")`.
 * This matches shell convention markers (e.g., `#!`) where case matters.
 * Tests must use the exact prefix "!!abort" (all lowercase).
 *
 * Edit delta application uses full-replacement semantics (no json-patch lib
 * installed). If editDelta is a string, it replaces the file content directly.
 * If it is { after: string }, the `after` property is used. Otherwise the
 * value is JSON.stringify-ed. The original is backed up to
 * `.bober/runs/<runId>/edits/<checkpointId>.original.<ext>` BEFORE overwrite
 * to satisfy evaluatorNotes reversibility requirement.
 *
 * Iteration counters are per-checkpoint-invocation (passed in by the caller),
 * NOT stored in a module-level map. The pipeline wires one counter per
 * checkpoint-invocation site so post-sprint for sprint-1 and post-sprint for
 * sprint-2 are independent.
 *
 * Sprint 12 — colocated in src/orchestrator/checkpoints/ per Sprint 7+8 precedent.
 */

import { writeFile, rename, readFile, mkdir } from "node:fs/promises";
import { join, extname } from "node:path";
import type { CheckpointId, CheckpointOutcome } from "./types.js";
import { logger } from "../../utils/logger.js";
import { runWithAudit, type MechanismName } from "./audit.js";

// ── Responsible-agent mapping ──────────────────────────────────────────────

/**
 * Agent types that can be re-invoked after a checkpoint rejection.
 * 'gate' checkpoints are not re-invoked; rejection always aborts.
 */
export type CheckpointAgent = "researcher" | "planner" | "generator" | "evaluator" | "gate";

/**
 * Per-checkpoint responsibility table. Source-of-truth for s12-c1 + s12-c6.
 * Gate entries abort the run on rejection; they have no agent to re-invoke.
 */
export const CHECKPOINT_TO_AGENT: Record<CheckpointId, CheckpointAgent> = {
  "post-research": "researcher",
  "post-plan": "planner",
  "post-sprint-contract": "planner",
  "pre-curator": "gate",
  "pre-generator": "gate",
  "pre-evaluator": "gate",
  "pre-code-reviewer": "gate",
  "post-sprint": "generator",
  "end-of-pipeline": "gate",
};

// ── Abort token ─────────────────────────────────────────────────────────────

/**
 * Default escape-hatch prefix. Case-SENSITIVE: must be exactly "!!abort"
 * at the start of the feedback string. Documented here and matched in
 * shouldAbort() below.
 */
export const ABORT_TOKEN = "!!abort";

/**
 * Returns true if the feedback triggers an immediate abort.
 *
 * Two sources:
 * 1. Feedback starts with ABORT_TOKEN ("!!abort") — case-sensitive prefix match.
 * 2. envAbortToken is non-empty and appears anywhere in the feedback string.
 */
export function shouldAbort(feedback: string, envAbortToken?: string): boolean {
  if (feedback.startsWith(ABORT_TOKEN)) return true;
  if (envAbortToken && envAbortToken.length > 0 && feedback.includes(envAbortToken)) return true;
  return false;
}

// ── Structured types ─────────────────────────────────────────────────────────

/**
 * A single feedback/rejection event in the iteration history for a checkpoint.
 */
export interface FeedbackHistoryEntry {
  iteration: number;
  feedback: string;
  editDelta?: unknown;
  timestamp: string;
}

/**
 * Structured reason for run abort. Written to .bober/runs/<runId>.aborted.json.
 */
export interface RunAbortedReason {
  reason: "CHECKPOINT_ITERATION_EXHAUSTED" | "GATE_REJECTED" | "USER_ABORT";
  checkpointId: CheckpointId;
  lastFeedback?: string;
  iterationsCompleted: number;
}

/**
 * Discriminated union returned by routeOutcome(). Callers MUST narrow on `kind`.
 */
export type RouterDecision =
  | { kind: "approved" }
  | { kind: "retry"; newPrompt: string; feedbackHistory: FeedbackHistoryEntry[] }
  | { kind: "edit-applied"; updatedArtifact: unknown }
  | { kind: "abort"; reason: RunAbortedReason };

/**
 * Discriminated union returned by runCheckpointWithFeedback().
 */
export type CheckpointResolution =
  | { kind: "approved"; iterations: number; finalArtifact: unknown }
  | { kind: "edited"; iterations: number; finalArtifact: unknown; editDelta: unknown }
  | { kind: "aborted"; reason: RunAbortedReason; lastFeedback: string };

// ── Per-agent prompt-augmentation strategies ────────────────────────────────
// Each function produces a DIFFERENT envelope: different section heading,
// different placement (prepend vs inline-into-generatorNotes vs question-append),
// different framing language. The evaluator checks these are NOT identical.

/**
 * Planner retry prompt: prepend a "## Plan revision request (iteration N of M)" block
 * ABOVE the original prompt. Instructs the planner to update the spec addressing
 * the feedback from a prior checkpoint review.
 */
function buildPlannerRetryPrompt(
  originalPrompt: string,
  feedbackHistory: FeedbackHistoryEntry[],
  iteration: number,
  maxIterations: number,
): string {
  const feedbackBlock = feedbackHistory
    .map(
      (e) =>
        `### Feedback from iteration ${e.iteration}\n${e.feedback}` +
        (e.editDelta ? `\n\n**Edit delta:**\n\`\`\`\n${JSON.stringify(e.editDelta, null, 2)}\n\`\`\`` : ""),
    )
    .join("\n\n");

  return [
    `## Plan revision request (iteration ${iteration} of ${maxIterations})`,
    ``,
    `A checkpoint review returned the following feedback on the plan. ` +
      `Please revise the PlanSpec to address ALL of the concerns below before re-submitting.`,
    ``,
    `## Checkpoint feedback (iteration ${iteration} of ${maxIterations}):`,
    feedbackBlock,
    ``,
    `## Edit delta (if any):`,
    feedbackHistory.at(-1)?.editDelta
      ? `\`\`\`\n${JSON.stringify(feedbackHistory.at(-1)?.editDelta, null, 2)}\n\`\`\``
      : `(none)`,
    ``,
    `---`,
    ``,
    originalPrompt,
  ].join("\n");
}

/**
 * Generator retry prompt: inline feedback into the sprint contract's generatorNotes
 * context as "additional context from human reviewer". The generator reads
 * generatorNotes from its handoff, so this surfaces naturally in its context.
 */
function buildGeneratorRetryPrompt(
  originalPrompt: string,
  feedbackHistory: FeedbackHistoryEntry[],
  iteration: number,
  maxIterations: number,
): string {
  const feedbackLines = feedbackHistory
    .map((e) => `- iteration ${e.iteration}: ${e.feedback}`)
    .join("\n");

  const generatorNotesSection = [
    `## Additional context from human reviewer (checkpoint iteration ${iteration} of ${maxIterations})`,
    ``,
    `The following concerns were raised by a checkpoint reviewer and MUST be addressed ` +
      `in this implementation. This feedback is provided as additional context from the ` +
      `human reviewer via the checkpoint system:`,
    ``,
    feedbackLines,
  ].join("\n");

  // Append the reviewer notes after the original prompt (inline as generatorNotes context).
  return `${originalPrompt}\n\n${generatorNotesSection}`;
}

/**
 * Researcher retry prompt: prepend feedback as additional research questions
 * for Phase 2 exploration. Instructs the researcher to address the concern
 * as a question to answer during re-exploration.
 */
function buildResearcherRetryPrompt(
  originalPrompt: string,
  feedbackHistory: FeedbackHistoryEntry[],
  iteration: number,
  maxIterations: number,
): string {
  const additionalQuestions = feedbackHistory
    .map(
      (e) =>
        `- Address the prior reviewer concern (iteration ${e.iteration}): ${e.feedback}`,
    )
    .join("\n");

  const questionBlock = [
    `## Additional research questions from checkpoint review (iteration ${iteration} of ${maxIterations})`,
    ``,
    `The following concerns were raised during checkpoint review. Please address them ` +
      `as additional questions during Phase 2 re-exploration:`,
    ``,
    additionalQuestions,
    ``,
    `---`,
    ``,
  ].join("\n");

  return `${questionBlock}${originalPrompt}`;
}

/**
 * Evaluator retry prompt: re-frame feedback as a specific concern to investigate.
 * Prepends a "## Concern from prior round" block with a directive to
 * specifically check the flagged issue.
 */
function buildEvaluatorRetryPrompt(
  originalPrompt: string,
  feedbackHistory: FeedbackHistoryEntry[],
  iteration: number,
  maxIterations: number,
): string {
  const concerns = feedbackHistory
    .map(
      (e) =>
        `- (iteration ${e.iteration}) Please specifically check: ${e.feedback}`,
    )
    .join("\n");

  const concernBlock = [
    `## Concern from prior round (checkpoint iteration ${iteration} of ${maxIterations})`,
    ``,
    `The following concerns were flagged during checkpoint review. ` +
      `Your evaluation MUST specifically investigate and report on each:`,
    ``,
    concerns,
    ``,
    `---`,
    ``,
  ].join("\n");

  return `${concernBlock}${originalPrompt}`;
}

/**
 * Get the responsible agent for a checkpoint ID.
 */
export function getResponsibleAgent(checkpointId: CheckpointId): CheckpointAgent {
  return CHECKPOINT_TO_AGENT[checkpointId];
}

/**
 * Build a per-agent augmented prompt for a retry invocation.
 * Each agent type uses a distinct framing strategy (s12-c6).
 *
 * @throws Error if the agent is 'gate' — gate checkpoints must not be re-invoked.
 */
export function buildFeedbackPrompt(
  checkpointId: CheckpointId,
  originalPrompt: string,
  feedbackHistory: FeedbackHistoryEntry[],
  maxIterations: number,
): string {
  const agent = CHECKPOINT_TO_AGENT[checkpointId];
  const iteration = feedbackHistory.length;

  switch (agent) {
    case "planner":
      return buildPlannerRetryPrompt(originalPrompt, feedbackHistory, iteration, maxIterations);
    case "generator":
      return buildGeneratorRetryPrompt(originalPrompt, feedbackHistory, iteration, maxIterations);
    case "researcher":
      return buildResearcherRetryPrompt(originalPrompt, feedbackHistory, iteration, maxIterations);
    case "evaluator":
      return buildEvaluatorRetryPrompt(originalPrompt, feedbackHistory, iteration, maxIterations);
    case "gate":
      // Gate checkpoints must never be re-invoked. Callers must check CHECKPOINT_TO_AGENT
      // and abort before reaching this path.
      throw new Error(
        `buildFeedbackPrompt called for gate checkpoint "${checkpointId}". ` +
          `Gate checkpoints abort on rejection — they do not retry.`,
      );
    default: {
      // Exhaustiveness guard (TypeScript narrows here)
      const _never: never = agent;
      throw new Error(`Unknown agent type: ${String(_never)}`);
    }
  }
}

// ── Edit delta application ──────────────────────────────────────────────────

/**
 * Apply an edit delta to an artifact file on disk.
 *
 * Steps:
 * 1. Read original file content.
 * 2. Write backup to <runsDir>/<runId>/edits/<checkpointId>.original.<ext>
 * 3. Determine new content:
 *    - string editDelta → full replacement
 *    - { after: string } → use `after` property
 *    - anything else → JSON.stringify(editDelta, null, 2)
 * 4. Atomic write: write to <artifactPath>.tmp then fs.rename.
 */
export async function applyEditDelta(
  artifactPath: string,
  editDelta: unknown,
  runsDir: string,
  runId: string,
  checkpointId: string,
): Promise<void> {
  // 1. Read original
  const originalContent = await readFile(artifactPath, "utf-8");

  // 2. Write backup (create parent dirs as needed)
  const ext = extname(artifactPath) || ".txt";
  const backupDir = join(runsDir, runId, "edits");
  await mkdir(backupDir, { recursive: true });
  const backupPath = join(backupDir, `${checkpointId}.original${ext}`);
  await writeFile(backupPath, originalContent, "utf-8");
  logger.debug(`[feedback-router] Backed up original to ${backupPath}`);

  // 3. Determine new content
  let newContent: string;
  if (typeof editDelta === "string") {
    newContent = editDelta;
  } else if (
    editDelta !== null &&
    typeof editDelta === "object" &&
    "after" in editDelta &&
    typeof (editDelta as { after: unknown }).after === "string"
  ) {
    newContent = (editDelta as { after: string }).after;
  } else {
    newContent = JSON.stringify(editDelta, null, 2) + "\n";
  }

  // 4. Atomic write
  const tmpPath = `${artifactPath}.tmp`;
  await writeFile(tmpPath, newContent, "utf-8");
  await rename(tmpPath, artifactPath);
  logger.info(`[feedback-router] Applied edit delta to ${artifactPath}`);
}

// ── Abort / completion markers ──────────────────────────────────────────────

/**
 * Write an abort marker to .bober/runs/<runId>.aborted.json atomically.
 * Creates parent directories as needed.
 */
export async function writeAbortMarker(
  projectRoot: string,
  runId: string,
  reason: RunAbortedReason,
): Promise<void> {
  const runsDir = join(projectRoot, ".bober", "runs");
  await mkdir(runsDir, { recursive: true });
  const markerPath = join(runsDir, `${runId}.aborted.json`);
  const payload = {
    runId,
    abortedAt: new Date().toISOString(),
    ...reason,
  };
  const tmpPath = `${markerPath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(payload, null, 2) + "\n", "utf-8");
  await rename(tmpPath, markerPath);
  logger.info(`[feedback-router] Abort marker written to ${markerPath}`);
}

/**
 * Write a completion marker to .bober/runs/<runId>.completed.json atomically.
 * Creates parent directories as needed.
 */
export async function writeCompletionMarker(
  projectRoot: string,
  runId: string,
  summary: Record<string, unknown>,
): Promise<void> {
  const runsDir = join(projectRoot, ".bober", "runs");
  await mkdir(runsDir, { recursive: true });
  const markerPath = join(runsDir, `${runId}.completed.json`);
  const payload = {
    runId,
    completedAt: new Date().toISOString(),
    ...summary,
  };
  const tmpPath = `${markerPath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(payload, null, 2) + "\n", "utf-8");
  await rename(tmpPath, markerPath);
  logger.info(`[feedback-router] Completion marker written to ${markerPath}`);
}

// ── Route outcome ────────────────────────────────────────────────────────────

/**
 * Route a single CheckpointOutcome to a RouterDecision.
 *
 * This is a pure decision function — callers (pipeline.ts / runCheckpointWithFeedback)
 * are responsible for acting on the returned decision (re-invoking agents, writing
 * abort markers, etc.).
 *
 * @param checkpointId  The checkpoint whose outcome is being routed.
 * @param outcome       The discriminated outcome from the mechanism.
 * @param iteration     Current iteration count (1-based).
 * @param maxIterations Cap from config.pipeline.maxCheckpointIterations.
 * @param feedbackHistory  All prior feedback entries for this checkpoint invocation.
 * @param originalPrompt   The agent's original prompt (for augmentation).
 * @param envAbortToken    Optional env-var abort token (checked in addition to ABORT_TOKEN).
 */
export function routeOutcome(
  checkpointId: CheckpointId,
  outcome: CheckpointOutcome,
  iteration: number,
  maxIterations: number,
  feedbackHistory: FeedbackHistoryEntry[],
  originalPrompt: string,
  envAbortToken?: string,
): RouterDecision {
  // Approved — no action needed.
  if ("approved" in outcome && outcome.approved === true) {
    return { kind: "approved" };
  }

  // Edit applied — caller handles file write via applyEditDelta.
  if ("edit" in outcome && outcome.edit === true) {
    return { kind: "edit-applied", updatedArtifact: outcome.editDelta };
  }

  // Rejection.
  if ("approved" in outcome && outcome.approved === false) {
    const feedback = outcome.feedback;

    // Escape hatch — !!abort prefix or env-var token.
    if (shouldAbort(feedback, envAbortToken)) {
      return {
        kind: "abort",
        reason: {
          reason: "USER_ABORT",
          checkpointId,
          lastFeedback: feedback,
          iterationsCompleted: iteration,
        },
      };
    }

    // Gate checkpoints abort on any rejection.
    if (CHECKPOINT_TO_AGENT[checkpointId] === "gate") {
      return {
        kind: "abort",
        reason: {
          reason: "GATE_REJECTED",
          checkpointId,
          lastFeedback: feedback,
          iterationsCompleted: iteration,
        },
      };
    }

    // Iteration cap exhausted.
    if (iteration >= maxIterations) {
      return {
        kind: "abort",
        reason: {
          reason: "CHECKPOINT_ITERATION_EXHAUSTED",
          checkpointId,
          lastFeedback: feedback,
          iterationsCompleted: iteration,
        },
      };
    }

    // Build per-agent augmented prompt for retry.
    const newHistory: FeedbackHistoryEntry[] = [
      ...feedbackHistory,
      {
        iteration,
        feedback,
        timestamp: new Date().toISOString(),
      },
    ];
    const newPrompt = buildFeedbackPrompt(
      checkpointId,
      originalPrompt,
      newHistory,
      maxIterations,
    );

    return { kind: "retry", newPrompt, feedbackHistory: newHistory };
  }

  // Unreachable given the CheckpointOutcome union, but guard anyway.
  throw new Error(`[feedback-router] Unrecognized outcome shape: ${JSON.stringify(outcome)}`);
}

// ── High-level coordinator ───────────────────────────────────────────────────

/**
 * Options for runCheckpointWithFeedback.
 */
export interface RunCheckpointWithFeedbackOpts {
  /** The checkpoint to invoke. */
  checkpointId: CheckpointId;
  /** The artifact to pass to the mechanism on the first call. */
  artifact: unknown;
  /** The mechanism to use for this checkpoint. */
  mechanism: { request: (id: CheckpointId, artifact: unknown) => Promise<CheckpointOutcome> };
  /** Maximum re-invocations for this checkpoint (from config.pipeline.maxCheckpointIterations). */
  maxIterations: number;
  /** Run identifier used for abort/edit markers on disk. */
  runId: string;
  /** Absolute path to the project root (for .bober/runs/ markers). */
  projectRoot: string;
  /**
   * Mechanism name for audit logging. Defaults to 'noop' when omitted
   * (safe for tests that don't exercise the audit path).
   */
  mechanismName?: MechanismName;
  /**
   * Orchestrator-injected callback to re-run the responsible agent.
   * Returns the new artifact produced by the agent.
   * The callback receives: (agentType, augmentedPrompt) → Promise<unknown>.
   */
  reinvokeAgent: (agentType: CheckpointAgent, augmentedPrompt: string) => Promise<unknown>;
  /** The original prompt that was passed to the responsible agent. */
  originalPrompt: string;
  /**
   * Optional path to the artifact file on disk (needed for edit-delta application).
   * If omitted, edit deltas are returned but not written to disk.
   */
  artifactPath?: string;
  /**
   * Optional env-var abort token (checked alongside ABORT_TOKEN).
   * If omitted, falls back to process.env['BOBER_CHECKPOINT_ABORT_TOKEN'] automatically.
   */
  envAbortToken?: string;
}

/**
 * Run a checkpoint with automatic feedback propagation and iteration cap.
 *
 * Loop semantics:
 * - Start at iteration 1.
 * - Call mechanism.request(checkpointId, artifact).
 * - On approved → resolve { kind: 'approved', iterations: N, finalArtifact }.
 * - On edit → applyEditDelta if artifactPath is set; resolve { kind: 'edited', ... }.
 * - On rejection:
 *   - shouldAbort → write .aborted.json; resolve { kind: 'aborted', reason: 'USER_ABORT' }.
 *   - gate → write .aborted.json; resolve { kind: 'aborted', reason: 'GATE_REJECTED' }.
 *   - iteration >= maxIterations → write .aborted.json; resolve 'CHECKPOINT_ITERATION_EXHAUSTED'.
 *   - else → buildFeedbackPrompt; reinvokeAgent; new artifact; loop with N+1.
 *
 * Iteration counters are per-invocation of this function, not global.
 */
export async function runCheckpointWithFeedback(
  opts: RunCheckpointWithFeedbackOpts,
): Promise<CheckpointResolution> {
  const {
    checkpointId,
    mechanism,
    maxIterations,
    runId,
    projectRoot,
    reinvokeAgent,
    originalPrompt,
    artifactPath,
  } = opts;
  const mechanismName: MechanismName = opts.mechanismName ?? "noop";

  // Default the env-var abort token to BOBER_CHECKPOINT_ABORT_TOKEN when the
  // caller omits it. This ensures the named env var is honored without requiring
  // every call site to thread the value through explicitly.
  const envAbortToken = opts.envAbortToken ?? process.env['BOBER_CHECKPOINT_ABORT_TOKEN'];

  let currentArtifact = opts.artifact;
  let feedbackHistory: FeedbackHistoryEntry[] = [];
  const runsDir = join(projectRoot, ".bober", "runs");

  for (let iteration = 1; ; iteration++) {
    // Attach iteration metadata so renderers can surface prior feedback.
    // At iteration 2+, wrap artifact with _iterationMetadata.
    const artifactWithMeta: unknown =
      iteration > 1
        ? {
            ...(typeof currentArtifact === "object" && currentArtifact !== null
              ? (currentArtifact as object)
              : {}),
            _iterationMetadata: {
              iteration,
              maxIterations,
              priorFeedback: feedbackHistory,
            },
          }
        : currentArtifact;

    const outcome = await runWithAudit({
      projectRoot,
      runId,
      checkpointId,
      mechanism: mechanismName,
      iteration,
      fn: () => mechanism.request(checkpointId, artifactWithMeta),
    });

    const decision = routeOutcome(
      checkpointId,
      outcome,
      iteration,
      maxIterations,
      feedbackHistory,
      originalPrompt,
      envAbortToken,
    );

    if (decision.kind === "approved") {
      return { kind: "approved", iterations: iteration, finalArtifact: currentArtifact };
    }

    if (decision.kind === "edit-applied") {
      if (artifactPath) {
        await applyEditDelta(artifactPath, decision.updatedArtifact, runsDir, runId, checkpointId);
      }
      return {
        kind: "edited",
        iterations: iteration,
        finalArtifact: decision.updatedArtifact,
        editDelta: decision.updatedArtifact,
      };
    }

    if (decision.kind === "abort") {
      await writeAbortMarker(projectRoot, runId, decision.reason);
      const lastFeedback = decision.reason.lastFeedback ?? "";
      return { kind: "aborted", reason: decision.reason, lastFeedback };
    }

    // decision.kind === "retry"
    feedbackHistory = decision.feedbackHistory;
    logger.info(
      `[feedback-router] Checkpoint "${checkpointId}" rejected at iteration ${iteration}/${maxIterations}. ` +
        `Re-invoking ${CHECKPOINT_TO_AGENT[checkpointId]}...`,
    );

    const agentType = CHECKPOINT_TO_AGENT[checkpointId];
    const newArtifact = await reinvokeAgent(agentType, decision.newPrompt);
    currentArtifact = newArtifact;
  }
}
