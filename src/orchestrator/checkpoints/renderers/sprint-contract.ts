/**
 * Renderer for `sprint-contract` artifacts.
 *
 * Extracts: contractId, feature/title, expectedChanges paths, successCriteria
 * count + first 5, dependsOn, and (at iteration 2+) a "Previous feedback"
 * section listing prior rejections.
 *
 * Pure function — no I/O. Receives the parsed SprintContract object directly.
 *
 * Sprint 11 — colocated in renderers/ per mechanisms/ precedent.
 * Sprint 12 — extended with iterationMeta support (s12-c5).
 */

import { applyLineCap } from "./_util.js";

interface ExpectedChange {
  path?: string;
  action?: string;
  description?: string;
}

interface SuccessCriterionLike {
  criterionId?: string;
  id?: string;
  description?: string;
}

interface IterationMeta {
  /** Current iteration number (1-based). Section shown only when > 1. */
  currentIteration: number;
  maxIterations: number;
  priorRejections: { iteration: number; feedback: string }[];
}

interface SprintContractLike {
  type?: string;
  contractId?: string;
  feature?: string;
  title?: string;
  expectedChanges?: ExpectedChange[];
  successCriteria?: SuccessCriterionLike[];
  dependsOn?: string[];
  /** Attached by runCheckpointWithFeedback at iteration 2+ (s12-c5). */
  iterationMeta?: IterationMeta;
  /** Alternative shape written by the pipeline _iterationMetadata key. */
  _iterationMetadata?: {
    iteration: number;
    maxIterations: number;
    priorFeedback: { iteration: number; feedback: string }[];
  };
}

/**
 * Render a `sprint-contract` artifact as markdown.
 *
 * At iteration 2+, appends a "### Previous feedback" section so reviewers
 * can see what was already asked of the generator (s12-c5).
 */
export function renderSprintContract(artifact: unknown): string {
  const c = (artifact ?? {}) as SprintContractLike;
  const sc = c.successCriteria ?? [];
  const ec = c.expectedChanges ?? [];

  // Resolve iteration metadata from either the explicit `iterationMeta` field
  // or the `_iterationMetadata` field written by runCheckpointWithFeedback.
  const im: IterationMeta | undefined =
    c.iterationMeta ??
    (c._iterationMetadata
      ? {
          currentIteration: c._iterationMetadata.iteration,
          maxIterations: c._iterationMetadata.maxIterations,
          priorRejections: c._iterationMetadata.priorFeedback,
        }
      : undefined);

  const lines: string[] = [
    `## Sprint Contract: \`${c.contractId ?? "unknown"}\``,
    ``,
    `**Feature:** ${c.feature ?? c.title ?? "(untitled)"}`,
    ``,
    `### Expected changes (${ec.length})`,
    ...ec.map((e) => `- \`${e.path ?? "?"}\` (${e.action ?? "?"})`),
    ``,
    `### Success criteria (${sc.length}, first 5 shown)`,
    ...sc.slice(0, 5).map(
      (s) => `- **${s.criterionId ?? s.id ?? "?"}**: ${s.description ?? ""}`,
    ),
    ``,
    `### Depends on`,
    ...(c.dependsOn ?? []).map((d) => `- \`${d}\``),
  ];

  // s12-c5: append prior-feedback section at iteration 2+.
  if (im && im.currentIteration > 1 && im.priorRejections.length > 0) {
    lines.push(
      ``,
      `### Previous feedback (iteration ${im.currentIteration} of ${im.maxIterations})`,
    );
    for (const r of im.priorRejections) {
      lines.push(`- _iteration ${r.iteration}:_ ${r.feedback}`);
    }
  }

  return applyLineCap(lines.join("\n"), 200);
}
