/**
 * Renderer for `sprint-summary` artifacts.
 *
 * Shows: contractId, title, evaluation result, passedOnIteration,
 * files-changed count and list, commit. No hard line cap (typically small).
 *
 * Pure function — no I/O. Receives a compound artifact { contract, evaluation, generatorResult }.
 *
 * Sprint 11 — colocated in renderers/ per mechanisms/ precedent.
 */

import { applyLineCap } from "./_util.js";

interface ContractLike {
  contractId?: string;
  title?: string;
  feature?: string;
}

interface EvaluationLike {
  passed?: boolean;
  overallResult?: string;
  passedOnIteration?: number;
}

interface GeneratorResultLike {
  filesChanged?: Array<{ path?: string; action?: string }>;
  commit?: string;
  commits?: string[];
}

interface SprintSummaryArtifact {
  type?: string;
  contract?: ContractLike;
  evaluation?: EvaluationLike;
  generatorResult?: GeneratorResultLike;
}

/**
 * Render a `sprint-summary` artifact as markdown.
 */
export function renderSprintSummary(artifact: unknown): string {
  const a = (artifact ?? {}) as SprintSummaryArtifact;
  const contract = a.contract ?? {};
  const evaluation = a.evaluation ?? {};
  const generatorResult = a.generatorResult ?? {};

  const overall =
    evaluation.overallResult ?? (evaluation.passed === true ? "pass" : evaluation.passed === false ? "fail" : "unknown");
  const filesChanged = generatorResult.filesChanged ?? [];
  const commit = generatorResult.commit ?? (generatorResult.commits?.[0] ?? "none");
  const feature = contract.feature ?? contract.title ?? "(untitled)";

  const lines: string[] = [
    `## Sprint Summary: \`${contract.contractId ?? "unknown"}\``,
    ``,
    `**Feature:** ${feature}`,
    `**Result:** **${overall.toUpperCase()}**`,
    `**Iteration:** ${evaluation.passedOnIteration ?? "n/a"}`,
    `**Commit:** \`${commit}\``,
    ``,
    `### Files changed (${filesChanged.length})`,
    ...filesChanged.map((f) => `- \`${f.path ?? "?"}\` (${f.action ?? "?"})`),
    ``,
  ];

  return applyLineCap(lines.join("\n"), 200);
}
